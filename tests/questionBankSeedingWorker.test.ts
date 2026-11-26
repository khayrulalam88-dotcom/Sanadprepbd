import test, { describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
  EXPECTED_FIREBASE_DATABASE_ID,
  EXPECTED_FIREBASE_PROJECT_ID,
  OWNER_ADMIN_EMAIL,
  OWNER_ADMIN_UID,
  type D1Database,
  type D1ExecResult,
  type D1PreparedStatement,
  type D1Result,
  type WorkerEnv
} from '../worker/types.ts';
import {
  base64UrlEncodeBytes,
  clearFirebaseJwksCacheForTests,
  type FirebaseJwk
} from '../worker/firebaseAuth.ts';
import {
  decodeDocumentFields,
  encodeDocumentFields
} from '../worker/firestoreRest.ts';
import { createWorkerHandler } from '../worker/index.ts';
import { runSeedFirestoreKeyless } from '../scripts/seedFirestoreKeyless.mjs';
import { resolveAdminQuestionBankFetchOutcome } from '../src/lib/adminQuestionHelpers.ts';

class SqliteD1Adapter implements D1Database {
  readonly sqlite: DatabaseSync;

  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
  }

  private normalizeValues(values: unknown[]): SQLInputValue[] {
    return values.map(v => {
      if (v === undefined || v === null) return null;
      if (typeof v === 'boolean') return v ? 1 : 0;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') return v;
      if (v instanceof Uint8Array) return v;
      return String(v);
    });
  }

  prepare(query: string): D1PreparedStatement {
    const sqlite = this.sqlite;
    const normalize = this.normalizeValues.bind(this);
    let boundParams: SQLInputValue[] = [];

    const stmtObj: D1PreparedStatement = {
      bind(...values: unknown[]) {
        boundParams = normalize(values);
        return stmtObj;
      },
      async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
        const prepared = sqlite.prepare(query);
        const row = prepared.get(...boundParams) as Record<string, unknown> | undefined;
        if (!row) return null;
        if (colName) return (row[colName] as T) ?? null;
        return row as T;
      },
      async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        const prepared = sqlite.prepare(query);
        if (/\bRETURNING\b/i.test(query)) {
          const rows = prepared.all(...boundParams) as T[];
          return { results: rows, success: true, meta: { changes: rows.length } };
        }
        const info = prepared.run(...boundParams);
        return {
          results: [],
          success: true,
          meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) }
        };
      },
      async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        const prepared = sqlite.prepare(query);
        const rows = prepared.all(...boundParams) as T[];
        return { results: rows, success: true, meta: { rows_read: rows.length } };
      },
      async raw<T = unknown[]>(): Promise<T[]> {
        const prepared = sqlite.prepare(query);
        const rows = prepared.all(...boundParams) as Record<string, unknown>[];
        return rows.map(r => Object.values(r)) as unknown as T[];
      }
    };
    return stmtObj;
  }

  async batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results: D1Result<T>[] = [];
      for (const s of statements) {
        results.push(await s.all<T>().catch(async () => s.run<T>()));
      }
      this.sqlite.exec('COMMIT');
      return results;
    } catch (err) {
      this.sqlite.exec('ROLLBACK');
      throw err;
    }
  }

  async exec(query: string): Promise<D1ExecResult> {
    const start = Date.now();
    this.sqlite.exec(query);
    return { count: 1, duration: Date.now() - start };
  }
}

async function createMigratedTestD1(): Promise<SqliteD1Adapter> {
  const db = new SqliteD1Adapter();
  await db.exec(fs.readFileSync(path.resolve('worker/migrations/0001_initial_edge_state.sql'), 'utf-8'));
  await db.exec(fs.readFileSync(path.resolve('worker/migrations/0002_question_bank_cache.sql'), 'utf-8'));
  await db.exec(fs.readFileSync(path.resolve('worker/migrations/0003_keyless_edge_collections.sql'), 'utf-8'));
  return db;
}

async function generateRs256Keypair(kid: string) {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256'
    },
    true,
    ['sign', 'verify']
  );
  const exportedPub = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as FirebaseJwk;
  return {
    kid,
    privateKey: pair.privateKey,
    jwk: { ...exportedPub, kid, alg: 'RS256', use: 'sig' }
  };
}

async function signJwt(privateKey: CryptoKey, kid: string, claims: Record<string, unknown>): Promise<string> {
  const encoder = new TextEncoder();
  const headerSeg = base64UrlEncodeBytes(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })));
  const payloadSeg = base64UrlEncodeBytes(encoder.encode(JSON.stringify(claims)));
  const input = encoder.encode(`${headerSeg}.${payloadSeg}`);
  const buf = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer;
  const sig = await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, privateKey, buf);
  return `${headerSeg}.${payloadSeg}.${base64UrlEncodeBytes(new Uint8Array(sig))}`;
}

/**
 * Simulates Enterprise Named Firestore REST behavior:
 * - Rejects collection-level GET /documents/{collection} (documents.list) with 403 PERMISSION_DENIED
 *   when `rejectCollectionListRest` is true, while allowing :batchGet, GET /documents/{col}/{id},
 *   :runQuery (with startAt cursor pagination), and :commit (enforcing currentDocument.exists === false).
 */
function createEnterpriseFirestoreStub(options?: {
  rejectCollectionListRest?: boolean;
  failCommitOnCall?: number;
}) {
  const expectedPrefix = `https://firestore.googleapis.com/v1/projects/${EXPECTED_FIREBASE_PROJECT_ID}/databases/${EXPECTED_FIREBASE_DATABASE_ID}/documents`;
  const collections = new Map<string, Map<string, Record<string, unknown>>>();
  const opLog: Array<{ op: string; url: string }> = [];
  let commitCalls = 0;

  const getCol = (col: string) => {
    let map = collections.get(col);
    if (!map) {
      map = new Map();
      collections.set(col, map);
    }
    return map;
  };

  const setDoc = (col: string, id: string, data: Record<string, unknown>) => {
    getCol(col).set(id, { ...data });
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method || 'GET').toUpperCase();

    assert.ok(url.startsWith(expectedPrefix), `Unexpected Firestore target URL: ${url}`);
    const restPath = url.slice(expectedPrefix.length);

    if (restPath === ':commit' && method === 'POST') {
      opLog.push({ op: 'commit', url });
      commitCalls += 1;
      if (options?.failCommitOnCall === commitCalls) {
        return new Response(
          JSON.stringify({ error: { code: 500, status: 'INTERNAL', message: 'Simulated commit error' } }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const parsed = JSON.parse(String(init?.body || '{}')) as {
        writes?: Array<{
          update?: { name: string; fields?: Record<string, any> };
          currentDocument?: { exists?: boolean };
          delete?: string;
        }>;
      };

      for (const w of parsed.writes || []) {
        assert.equal(w.delete, undefined, 'Seed writes must never delete');
        if (w.update) {
          const [col, rawId] = w.update.name.split('/documents/')[1].split('/');
          const docId = decodeURIComponent(rawId);
          const colMap = getCol(col);
          if (w.currentDocument?.exists === false && colMap.has(docId)) {
            return new Response(
              JSON.stringify({
                error: { code: 409, status: 'ALREADY_EXISTS', message: `${col}/${docId} already exists` }
              }),
              { status: 409, headers: { 'Content-Type': 'application/json' } }
            );
          }
          colMap.set(docId, decodeDocumentFields(w.update.fields));
        }
      }
      return new Response(JSON.stringify({ writeResults: (parsed.writes || []).map(() => ({})) }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (restPath === ':batchGet' && method === 'POST') {
      opLog.push({ op: 'batchGet', url });
      const parsed = JSON.parse(String(init?.body || '{}')) as { documents?: string[] };
      const items = (parsed.documents || []).map(fullName => {
        const [col, rawId] = fullName.split('/documents/')[1].split('/');
        const docId = decodeURIComponent(rawId);
        const found = getCol(col).get(docId);
        if (!found) return { missing: fullName };
        return { found: { name: fullName, fields: encodeDocumentFields(found) } };
      });
      return new Response(JSON.stringify(items), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (restPath === ':runQuery' && method === 'POST') {
      opLog.push({ op: 'runQuery', url });
      const parsed = JSON.parse(String(init?.body || '{}')) as {
        structuredQuery?: {
          from?: Array<{ collectionId: string }>;
          orderBy?: Array<{ field: { fieldPath: string } }>;
          startAt?: { values?: Array<{ referenceValue?: string }>; before?: boolean };
          limit?: number;
        };
      };
      const col = parsed.structuredQuery?.from?.[0]?.collectionId || '';
      let rows = Array.from(getCol(col).entries())
        .map(([id, data]) => ({
          id,
          resourceName: `${expectedPrefix}/${col}/${encodeURIComponent(id)}`,
          data
        }))
        .sort((a, b) => a.resourceName.localeCompare(b.resourceName));

      const cursorRef = parsed.structuredQuery?.startAt?.values?.[0]?.referenceValue;
      if (cursorRef) {
        const idx = rows.findIndex(r => r.resourceName === cursorRef);
        if (idx >= 0) {
          rows = rows.slice(parsed.structuredQuery?.startAt?.before === false ? idx + 1 : idx);
        }
      }
      if (parsed.structuredQuery?.limit !== undefined) {
        rows = rows.slice(0, parsed.structuredQuery.limit);
      }

      return new Response(
        JSON.stringify(
          rows.map(r => ({
            document: {
              name: r.resourceName,
              fields: encodeDocumentFields(r.data)
            }
          }))
        ),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (method === 'GET' && restPath.startsWith('/')) {
      const [pathPart] = restPath.slice(1).split('?');
      const segments = pathPart.split('/').filter(Boolean);
      if (segments.length === 1) {
        opLog.push({ op: 'listDocuments', url });
        if (options?.rejectCollectionListRest) {
          return new Response(
            JSON.stringify({
              error: { code: 403, status: 'PERMISSION_DENIED', message: 'Missing or insufficient permissions.' }
            }),
            { status: 403, headers: { 'Content-Type': 'application/json' } }
          );
        }
        const col = segments[0];
        const entries = Array.from(getCol(col).entries());
        return new Response(
          JSON.stringify({
            documents: entries.map(([id, data]) => ({
              name: `${expectedPrefix}/${col}/${encodeURIComponent(id)}`,
              fields: encodeDocumentFields(data)
            }))
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (segments.length === 2) {
        opLog.push({ op: 'getDocument', url });
        const [col, rawId] = segments;
        const found = getCol(col).get(decodeURIComponent(rawId));
        if (!found) {
          return new Response(JSON.stringify({ error: { code: 404, status: 'NOT_FOUND' } }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        return new Response(
          JSON.stringify({
            name: `${expectedPrefix}/${col}/${rawId}`,
            fields: encodeDocumentFields(found)
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    throw new Error(`Unhandled Firestore mock call: ${method} ${url}`);
  };

  return { fetchImpl, getCol, setDoc, opLog };
}

function makeSampleQuestions(count = 6) {
  const out = [];
  for (let i = 1; i <= count; i++) {
    out.push({
      id: `q_seed_${String(i).padStart(4, '0')}`,
      subjectId: 'sub_cpc',
      questionBn: `দেওয়ানী প্রশ্ন ${i}?`,
      questionEn: `Civil question ${i}?`,
      optionsBn: ['ক', 'খ', 'গ', 'ঘ'],
      optionsEn: ['A', 'B', 'C', 'D'],
      correctOptionIndex: i % 4,
      explanationBn: `ব্যাখ্যা ${i}`,
      explanationEn: `Explanation ${i}`,
      legalReference: `Section ${i}`,
      difficulty: 'medium',
      status: 'published',
      isDemoSample: i === 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    });
  }
  return out;
}

function makeSampleExams(questionIds: string[]) {
  return [
    {
      id: 'exam_model_test_01',
      titleBn: 'মডেল টেস্ট ০১',
      titleEn: 'Model Test 01',
      descriptionBn: 'ফ্রি ডেমো',
      descriptionEn: 'Free Demo',
      type: 'full_mock',
      durationMinutes: 60,
      totalMarks: questionIds.length,
      passThresholdPercentage: 50,
      questionIds,
      isPaid: false,
      isActive: true,
      published: true,
      releaseExplanationsImmediately: true,
      negativeMarkRatio: 0.25,
      positiveMarkRatio: 1,
      createdAt: '2026-01-01T00:00:00.000Z'
    }
  ];
}

describe('Worker-Mediated Question Bank Seeding, Sync Fallback & Admin Error Visibility', async () => {
  const fixedNowMs = Date.UTC(2026, 10, 26, 10, 0, 0);
  const authKeys = await generateRs256Keypair('seed-test-kid');

  const ownerToken = await signJwt(authKeys.privateKey, authKeys.kid, {
    aud: EXPECTED_FIREBASE_PROJECT_ID,
    iss: `https://securetoken.google.com/${EXPECTED_FIREBASE_PROJECT_ID}`,
    sub: OWNER_ADMIN_UID,
    user_id: OWNER_ADMIN_UID,
    email: OWNER_ADMIN_EMAIL,
    email_verified: true,
    iat: Math.floor(fixedNowMs / 1000) - 30,
    exp: Math.floor(fixedNowMs / 1000) + 3600
  });

  const studentToken = await signJwt(authKeys.privateKey, authKeys.kid, {
    aud: EXPECTED_FIREBASE_PROJECT_ID,
    iss: `https://securetoken.google.com/${EXPECTED_FIREBASE_PROJECT_ID}`,
    sub: 'student_uid_123',
    user_id: 'student_uid_123',
    email: 'student@example.com',
    email_verified: true,
    iat: Math.floor(fixedNowMs / 1000) - 30,
    exp: Math.floor(fixedNowMs / 1000) + 3600
  });

  beforeEach(() => {
    clearFirebaseJwksCacheForTests();
  });

  test('1. Auth enforcement: unauthenticated returns 401 and non-owner student returns 403', async () => {
    const db = await createMigratedTestD1();
    const stub = createEnterpriseFirestoreStub({ rejectCollectionListRest: true });
    const env: WorkerEnv = {
      DB: db,
      FIREBASE_PROJECT_ID: EXPECTED_FIREBASE_PROJECT_ID,
      FIREBASE_DATABASE_ID: EXPECTED_FIREBASE_DATABASE_ID,
      ENVIRONMENT: 'production'
    };
    const handler = createWorkerHandler({
      fetchImpl: stub.fetchImpl,
      jwksFetcher: async () => ({ keys: [authKeys.jwk], maxAgeSeconds: 300 }),
      nowMsFn: () => fixedNowMs
    });

    const unauthBatch = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/admin/seed/question-bank/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: true, questions: makeSampleQuestions(1) })
      }),
      env
    );
    assert.equal(unauthBatch.status, 401);

    const studentBatch = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/admin/seed/question-bank/batch', {
        method: 'POST',
        headers: { Authorization: `Bearer ${studentToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: true, questions: makeSampleQuestions(1) })
      }),
      env
    );
    assert.equal(studentBatch.status, 403);

    const studentFinalize = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/admin/seed/question-bank/finalize', {
        method: 'POST',
        headers: { Authorization: `Bearer ${studentToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: true })
      }),
      env
    );
    assert.equal(studentFinalize.status, 403);
  });

  test('2. Full E2E: CLI -> Worker -> Enterprise Firestore (:batchGet/:commit) -> /sync-cache & /api/admin/questions work even when collection documents.list returns 403', async () => {
    const db = await createMigratedTestD1();
    const stub = createEnterpriseFirestoreStub({ rejectCollectionListRest: true });
    const env: WorkerEnv = {
      DB: db,
      FIREBASE_PROJECT_ID: EXPECTED_FIREBASE_PROJECT_ID,
      FIREBASE_DATABASE_ID: EXPECTED_FIREBASE_DATABASE_ID,
      ENVIRONMENT: 'production'
    };
    const handler = createWorkerHandler({
      fetchImpl: stub.fetchImpl,
      jwksFetcher: async () => ({ keys: [authKeys.jwk], maxAgeSeconds: 300 }),
      nowMsFn: () => fixedNowMs
    });

    const workerFetchAdapter: typeof fetch = async (input, init) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return handler(new Request(urlStr, init), env);
    };

    const questions = makeSampleQuestions(6);
    const exams = makeSampleExams(questions.map(q => q.id));

    // Dry run first: zero writes committed, zero listDocuments calls during seeding
    const dryReport = await runSeedFirestoreKeyless({
      execute: false,
      token: ownerToken,
      fetchImpl: workerFetchAdapter,
      questions,
      exams,
      batchSize: 3,
      nowMs: fixedNowMs
    });
    assert.equal(dryReport.safeToExecute, true);
    assert.equal(dryReport.wouldCreate.total, 14);
    assert.equal(stub.getCol('questions').size, 0);
    assert.equal(stub.opLog.some(o => o.op === 'listDocuments'), false);
    assert.equal(stub.opLog.some(o => o.op === 'commit'), false);

    // Execute: commits sanitized questions, separate questionKeys, exams, version doc last, then /sync-cache
    const execReport = await runSeedFirestoreKeyless({
      execute: true,
      token: ownerToken,
      fetchImpl: workerFetchAdapter,
      questions,
      exams,
      batchSize: 3,
      nowMs: fixedNowMs
    });

    assert.equal(execReport.executed, true);
    assert.equal(execReport.writesCommitted, 14);
    assert.equal(stub.getCol('questions').size, 6);
    assert.equal(stub.getCol('questionKeys').size, 6);
    assert.equal(stub.getCol('exams').size, 1);
    assert.equal(stub.getCol('config').has('questionBankVersion'), true);
    const d1Sync = execReport.d1SyncResult as {
      success?: boolean;
      questionCount?: number;
      keyCount?: number;
    };
    assert.equal(d1Sync?.success, true);
    assert.equal(d1Sync?.questionCount, 6);
    assert.equal(d1Sync?.keyCount, 6);

    // Verify strict answer-key separation
    for (const q of questions) {
      const savedQ = stub.getCol('questions').get(q.id)!;
      assert.equal('correctOptionIndex' in savedQ, false);
      assert.equal('explanationBn' in savedQ, false);
      assert.equal('explanationEn' in savedQ, false);
      const savedKey = stub.getCol('questionKeys').get(q.id)!;
      assert.equal(savedKey.correctOptionIndex, q.correctOptionIndex);
    }

    // Verify Admin Panel GET /api/admin/questions works seamlessly via runQuery fallback even with listDocuments=403
    const adminQRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/admin/questions', {
        headers: { Authorization: `Bearer ${ownerToken}` }
      }),
      env
    );
    assert.equal(adminQRes.status, 200);
    const adminQJson = (await adminQRes.json()) as { questions: Array<{ id: string; correctOptionIndex: number }> };
    assert.equal(adminQJson.questions.length, 6);
    assert.equal(typeof adminQJson.questions[0].correctOptionIndex, 'number');

    // Verify multi-page cursor pagination via listDocumentsViaQuery fallback (pageSize=2 across 6 docs = 4 pages)
    const { FirestoreRestClient } = await import('../worker/firestoreRest.ts');
    const directOwnerClient = new FirestoreRestClient({
      projectId: EXPECTED_FIREBASE_PROJECT_ID,
      databaseId: EXPECTED_FIREBASE_DATABASE_ID,
      environment: 'production',
      bearerToken: ownerToken,
      fetchImpl: stub.fetchImpl
    });
    const pagedDocs = await directOwnerClient.listDocuments('questions', {
      pageSize: 2,
      maxPages: 10,
      fallbackToRunQueryOn403: true
    });
    assert.equal(pagedDocs.length, 6);

    // Verify D1 counts reflect seeded questions
    const countsRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/subjects/counts'),
      env
    );
    assert.equal(countsRes.status, 200);
    const countsJson = (await countsRes.json()) as { total: number };
    assert.equal(countsJson.total, 6);
  });

  test('3. Conflict preservation & protection: preserves existing Admin exam config and aborts on conflicting question/key', async () => {
    const db = await createMigratedTestD1();
    const questions = makeSampleQuestions(3);
    const exams = makeSampleExams(questions.map(q => q.id));

    const stub = createEnterpriseFirestoreStub({ rejectCollectionListRest: true });
    // Pre-seed custom Admin-configured exam (toggled isActive=false, custom scheduledDate) + 1 matching question
    stub.setDoc('exams', 'exam_model_test_01', {
      ...exams[0],
      isActive: false,
      scheduledDate: '2026-12-30'
    });
    stub.setDoc('questions', 'q_seed_0001', {
      id: 'q_seed_0001',
      subjectId: 'sub_cpc',
      questionBn: questions[0].questionBn,
      questionEn: questions[0].questionEn,
      optionsBn: questions[0].optionsBn,
      optionsEn: questions[0].optionsEn,
      legalReference: questions[0].legalReference,
      difficulty: questions[0].difficulty,
      status: questions[0].status,
      isDemoSample: true
    });

    const env: WorkerEnv = {
      DB: db,
      FIREBASE_PROJECT_ID: EXPECTED_FIREBASE_PROJECT_ID,
      FIREBASE_DATABASE_ID: EXPECTED_FIREBASE_DATABASE_ID,
      ENVIRONMENT: 'production'
    };
    const handler = createWorkerHandler({
      fetchImpl: stub.fetchImpl,
      jwksFetcher: async () => ({ keys: [authKeys.jwk], maxAgeSeconds: 300 }),
      nowMsFn: () => fixedNowMs
    });

    const batchRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/admin/seed/question-bank/batch', {
        method: 'POST',
        headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: false, questions, exams })
      }),
      env
    );
    assert.equal(batchRes.status, 200);
    const batchJson = (await batchRes.json()) as {
      created: { questions: number; questionKeys: number; exams: number };
      matching: { questions: number; exams: number };
    };
    assert.equal(batchJson.matching.questions, 1);
    assert.equal(batchJson.matching.exams, 1);
    assert.equal(batchJson.created.questions, 2);
    assert.equal(batchJson.created.questionKeys, 3);
    assert.equal(batchJson.created.exams, 0);

    // Admin exam settings MUST remain untouched
    assert.equal(stub.getCol('exams').get('exam_model_test_01')?.isActive, false);
    assert.equal(stub.getCol('exams').get('exam_model_test_01')?.scheduledDate, '2026-12-30');

    // Now test conflict rejection (embedded/different answer key on q_seed_0002)
    stub.setDoc('questionKeys', 'q_seed_0002', {
      correctOptionIndex: 3, // mismatch
      explanationBn: 'Other',
      explanationEn: 'Other',
      legalReference: 'Section 2'
    });
    const conflictBatch = makeSampleQuestions(4);
    const conflictRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/admin/seed/question-bank/batch', {
        method: 'POST',
        headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: false, questions: conflictBatch })
      }),
      env
    );
    assert.equal(conflictRes.status, 409);
    assert.equal(stub.getCol('questions').has('q_seed_0004'), false, '409 abort must not write any docs in that batch');
  });

  test('4. Failed batch leaves version document unwritten', async () => {
    const db = await createMigratedTestD1();
    const stub = createEnterpriseFirestoreStub({ rejectCollectionListRest: true, failCommitOnCall: 2 });
    const env: WorkerEnv = {
      DB: db,
      FIREBASE_PROJECT_ID: EXPECTED_FIREBASE_PROJECT_ID,
      FIREBASE_DATABASE_ID: EXPECTED_FIREBASE_DATABASE_ID,
      ENVIRONMENT: 'production'
    };
    const handler = createWorkerHandler({
      fetchImpl: stub.fetchImpl,
      jwksFetcher: async () => ({ keys: [authKeys.jwk], maxAgeSeconds: 300 }),
      nowMsFn: () => fixedNowMs
    });

    const workerFetchAdapter: typeof fetch = async (input, init) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return handler(new Request(urlStr, init), env);
    };

    const questions = makeSampleQuestions(4);
    const exams = makeSampleExams(questions.map(q => q.id));

    await assert.rejects(
      () =>
        runSeedFirestoreKeyless({
          execute: true,
          token: ownerToken,
          fetchImpl: workerFetchAdapter,
          questions,
          exams,
          batchSize: 2,
          nowMs: fixedNowMs
        }),
      (err: { code?: string; details?: { partialExecution?: boolean } }) =>
        err.code === 'FIRESTORE_CREATE_500' ||
        err.code === 'BATCH_COMMIT_FAILED' ||
        err.details?.partialExecution === true
    );

    assert.equal(stub.getCol('config').has('questionBankVersion'), false);
  });

  test('5. Admin Question Bank UI helper distinguishes loading/loaded/empty vs 401/403/503 errors cleanly', () => {
    const emptyOk = resolveAdminQuestionBankFetchOutcome({
      ok: true,
      status: 200,
      data: { questions: [] }
    });
    assert.equal(emptyOk.ok, true);
    assert.equal(emptyOk.state.status, 'loaded');
    assert.equal(emptyOk.state.questionCount, 0);
    assert.equal(emptyOk.questions.length, 0);

    const authErr = resolveAdminQuestionBankFetchOutcome({
      ok: false,
      status: 401,
      code: 'UNAUTHORIZED',
      message: 'Token expired'
    });
    assert.equal(authErr.ok, false);
    assert.equal(authErr.state.status, 'error');
    assert.equal(authErr.state.errorCategory, 'auth');
    assert.equal(authErr.state.httpStatus, 401);

    const forbiddenErr = resolveAdminQuestionBankFetchOutcome({
      ok: false,
      status: 403,
      code: 'PERMISSION_DENIED',
      message: 'Missing permissions'
    });
    assert.equal(forbiddenErr.ok, false);
    assert.equal(forbiddenErr.state.status, 'error');
    assert.equal(forbiddenErr.state.errorCategory, 'forbidden');

    const unavailableErr = resolveAdminQuestionBankFetchOutcome({
      ok: false,
      status: 503,
      code: 'FIRESTORE_UNAVAILABLE'
    });
    assert.equal(unavailableErr.ok, false);
    assert.equal(unavailableErr.state.status, 'error');
    assert.equal(unavailableErr.state.errorCategory, 'unavailable');
  });
});
