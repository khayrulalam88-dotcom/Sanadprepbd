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
  const exportedPriv = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const b64Priv = Buffer.from(exportedPriv).toString('base64');
  const wrapped = b64Priv.match(/.{1,64}/g)?.join('\n') || b64Priv;
  const pkcs8Pem = `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----`;
  return {
    kid,
    privateKey: pair.privateKey,
    jwk: { ...exportedPub, kid, alg: 'RS256', use: 'sig' },
    pkcs8Pem
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

function createPhase2FirestoreStub(options?: { ownerOnlyQuestionReads?: boolean }) {
  const expectedPrefix = `https://firestore.googleapis.com/v1/projects/${EXPECTED_FIREBASE_PROJECT_ID}/databases/${EXPECTED_FIREBASE_DATABASE_ID}/documents`;
  const collections = new Map<string, Map<string, Record<string, unknown>>>();
  const readLog: Array<{ op: string; collection: string; docId?: string }> = [];

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

  const resetReadLog = () => {
    readLog.length = 0;
  };

  const isOwnerBearer = (init?: RequestInit) => {
    const auth = new Headers(init?.headers).get('authorization') || '';
    if (!auth.startsWith('Bearer ')) return false;
    const token = auth.slice(7);
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    try {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as Record<string, unknown>;
      return payload.sub === OWNER_ADMIN_UID;
    } catch {
      return false;
    }
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method || 'GET').toUpperCase();

    assert.equal(url.startsWith('https://oauth2.googleapis.com'), false, 'Keyless Worker must never call oauth2 token API');

    assert.ok(url.startsWith(expectedPrefix), `Invalid Firestore REST database target: ${url}`);
    const restPath = url.slice(expectedPrefix.length);

    if (restPath === ':commit' && method === 'POST') {
      const parsed = JSON.parse(String(init?.body || '{}')) as {
        writes?: Array<{
          update?: { name: string; fields?: Record<string, any> };
          delete?: string;
        }>;
      };
      for (const w of parsed.writes || []) {
        if (w.delete) {
          const [col, rawId] = w.delete.split('/documents/')[1].split('/');
          getCol(col).delete(decodeURIComponent(rawId));
          continue;
        }
        if (w.update) {
          const [col, rawId] = w.update.name.split('/documents/')[1].split('/');
          getCol(col).set(decodeURIComponent(rawId), decodeDocumentFields(w.update.fields));
        }
      }
      return new Response(JSON.stringify({ writeResults: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (restPath === ':batchGet' && method === 'POST') {
      const parsed = JSON.parse(String(init?.body || '{}')) as { documents?: string[] };
      const items = (parsed.documents || []).map(fullName => {
        const [col, rawId] = fullName.split('/documents/')[1].split('/');
        const docId = decodeURIComponent(rawId);
        readLog.push({ op: 'batchGet', collection: col, docId });
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
      const parsed = JSON.parse(String(init?.body || '{}')) as {
        structuredQuery?: {
          from?: Array<{ collectionId: string }>;
          where?: { fieldFilter?: { field: { fieldPath: string }; op: string; value: any } };
          limit?: number;
        };
      };
      const col = parsed.structuredQuery?.from?.[0]?.collectionId || '';
      readLog.push({ op: 'runQuery', collection: col });
      let rows = Array.from(getCol(col).entries()).map(([id, data]) => ({ id, data }));
      const ff = parsed.structuredQuery?.where?.fieldFilter;
      if (ff && ff.op === 'EQUAL') {
        const targetVal = decodeDocumentFields({ v: ff.value }).v;
        rows = rows.filter(r => r.data[ff.field.fieldPath] === targetVal);
      }
      if (parsed.structuredQuery?.limit !== undefined) {
        rows = rows.slice(0, parsed.structuredQuery.limit);
      }
      return new Response(
        JSON.stringify(
          rows.map(r => ({
            document: {
              name: `${expectedPrefix}/${col}/${r.id}`,
              fields: encodeDocumentFields(r.data)
            }
          }))
        ),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (method === 'GET' && restPath.startsWith('/')) {
      const [pathPart, queryPart] = restPath.slice(1).split('?');
      const segments = pathPart.split('/').filter(Boolean);

      // listDocuments: GET /documents/{collection}?pageSize=...&pageToken=...
      if (segments.length === 1) {
        const col = segments[0];
        if (options?.ownerOnlyQuestionReads && (col === 'questions' || col === 'questionKeys') && !isOwnerBearer(init)) {
          return new Response(JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'Missing or insufficient permissions.' } }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        readLog.push({ op: 'listDocuments', collection: col });
        const qs = new URLSearchParams(queryPart || '');
        const pageSize = Number(qs.get('pageSize') || '500');
        const offset = Number(qs.get('pageToken') || '0');
        const entries = Array.from(getCol(col).entries()).sort(([a], [b]) => a.localeCompare(b));
        const slice = entries.slice(offset, offset + pageSize);
        const nextPageToken = offset + slice.length < entries.length ? String(offset + slice.length) : undefined;
        return new Response(
          JSON.stringify({
            documents: slice.map(([id, data]) => ({
              name: `${expectedPrefix}/${col}/${encodeURIComponent(id)}`,
              fields: encodeDocumentFields(data)
            })),
            ...(nextPageToken ? { nextPageToken } : {})
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // getDocument: GET /documents/{collection}/{docId}
      if (segments.length === 2) {
        const [col, rawDocId] = segments;
        const docId = decodeURIComponent(rawDocId);
        readLog.push({ op: 'getDocument', collection: col, docId });
        const found = getCol(col).get(docId);
        if (!found) {
          return new Response(JSON.stringify({ error: { code: 404, status: 'NOT_FOUND' } }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        return new Response(
          JSON.stringify({
            name: `${expectedPrefix}/${col}/${rawDocId}`,
            fields: encodeDocumentFields(found)
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    throw new Error(`Unhandled Phase 2 mock Firestore call: ${method} ${url}`);
  };

  return { fetchImpl, setDoc, getCol, readLog, resetReadLog };
}

describe('Sanad Prep BD — Cloudflare Worker Phase 2 (Catalog, Question Bank & Practice APIs)', async () => {
  const keyPair = await generateRs256Keypair('phase2_kid_1');

  let nowSec = Math.floor(Date.now() / 1000);
  let virtualNowMs = nowSec * 1000;

  async function issueToken(claims: Record<string, unknown>) {
    return signJwt(keyPair.privateKey, keyPair.kid, {
      aud: EXPECTED_FIREBASE_PROJECT_ID,
      iss: `https://securetoken.google.com/${EXPECTED_FIREBASE_PROJECT_ID}`,
      iat: nowSec - 30,
      exp: nowSec + 3600,
      ...claims
    });
  }

  let ownerToken = '';
  let freeStudentToken = '';
  let proStudentToken = '';
  let expiredStudentToken = '';
  let unverifiedToken = '';

  beforeEach(async () => {
    clearFirebaseJwksCacheForTests();
    nowSec = Math.floor(Date.now() / 1000);
    virtualNowMs = nowSec * 1000;
    ownerToken = await issueToken({
      sub: OWNER_ADMIN_UID,
      email: OWNER_ADMIN_EMAIL,
      email_verified: true,
      name: 'Khayrul Alam'
    });
    freeStudentToken = await issueToken({
      sub: 'uid_free_student',
      email: 'free@example.com',
      email_verified: true,
      name: 'Free Student'
    });
    proStudentToken = await issueToken({
      sub: 'uid_pro_student',
      email: 'pro@example.com',
      email_verified: true,
      name: 'Pro Student'
    });
    expiredStudentToken = await issueToken({
      sub: 'uid_expired_student',
      email: 'expired@example.com',
      email_verified: true,
      name: 'Expired Student'
    });
    unverifiedToken = await issueToken({
      sub: 'uid_unverified_student',
      email: 'unverified@example.com',
      email_verified: false,
      name: 'Unverified'
    });
  });

  function seedAuthoritativeFixtureData(stub: ReturnType<typeof createPhase2FirestoreStub>) {
    stub.setDoc('config', 'questionBankVersion', {
      version: 100,
      versionToken: 'v_initial_100',
      updatedAt: '2026-11-01T00:00:00.000Z'
    });
    stub.setDoc('config', 'examDate', {
      examPassPrice: 650,
      targetExamDate: '2026-11-28T09:00:00+06:00'
    });

    // Seed 15 questions across subjects (5 demo samples + 10 paid questions, some with topicId)
    for (let i = 1; i <= 15; i++) {
      const id = `q_${String(i).padStart(2, '0')}`;
      const isDemoSample = i <= 5;
      const subjectId = i <= 10 ? 'sub_cpc' : 'sub_penal';
      const topicId = i % 2 === 0 ? 'chap_jurisdiction' : 'chap_decrees';
      // Deliberately inject legacy key on one doc in /questions to prove Worker strips it unconditionally!
      stub.setDoc('questions', id, {
        subjectId,
        topicId,
        questionBn: `প্রশ্ন ${i}: আইনগত বিধান উল্লেখ করুন`,
        questionEn: `Question ${i}: Identify the statutory provision`,
        optionsBn: ['বিকল্প ক', 'বিকল্প খ', 'বিকল্প গ', 'বিকল্প ঘ'],
        optionsEn: ['Option A', 'Option B', 'Option C', 'Option D'],
        ...(i === 1 ? { correctOptionIndex: 1, explanationBn: 'LEGACY LEAK', explanationEn: 'LEGACY LEAK' } : {}),
        legalReference: `Section ${i * 2}, CPC 1908`,
        difficulty: i % 3 === 0 ? 'hard' : i % 2 === 0 ? 'medium' : 'easy',
        status: 'published',
        isDemoSample,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z'
      });
      stub.setDoc('questionKeys', id, {
        correctOptionIndex: i % 4,
        explanationBn: `প্রশ্ন ${i} এর সঠিক আইনি ব্যাখ্যা`,
        explanationEn: `Official legal explanation for question ${i}`,
        legalReference: `Section ${i * 2}, CPC 1908`,
        updatedAt: '2026-10-01T00:00:00.000Z'
      });
    }

    // Seed free & paid exam
    stub.setDoc('exams', 'exam_model_test_01', {
      titleBn: 'ফ্রি মডেল টেস্ট ১',
      titleEn: 'Free Model Test 01',
      type: 'full_mock',
      durationMinutes: 60,
      totalMarks: 5,
      isPaid: false,
      questionIds: ['q_01', 'q_02', 'q_03', 'q_04', 'q_05']
    });
    stub.setDoc('exams', 'exam_model_test_02', {
      titleBn: 'পেইড মডেল টেস্ট ২',
      titleEn: 'Paid Model Test 02',
      type: 'full_mock',
      durationMinutes: 60,
      totalMarks: 5,
      isPaid: true,
      questionIds: ['q_06', 'q_07', 'q_08', 'q_09', 'q_10']
    });

    // Seed Pro and Expired subscriptions
    stub.setDoc('subscriptions', 'sub_active_pro', {
      userId: 'uid_pro_student',
      status: 'active',
      packageId: 'pkg_long_course',
      activatedAt: new Date(virtualNowMs - 86400 * 1000).toISOString(),
      expiresAt: new Date(virtualNowMs + 30 * 86400 * 1000).toISOString(),
      createdAt: new Date(virtualNowMs - 86400 * 1000).toISOString()
    });
    stub.setDoc('subscriptions', 'sub_past_expired', {
      userId: 'uid_expired_student',
      status: 'active',
      packageId: 'pkg_monthly',
      activatedAt: new Date(virtualNowMs - 60 * 86400 * 1000).toISOString(),
      expiresAt: new Date(virtualNowMs - 1000).toISOString(),
      createdAt: new Date(virtualNowMs - 60 * 86400 * 1000).toISOString()
    });
  }

  async function buildTestHarness(options?: { cacheTtlMs?: number; practiceLimit?: number; ownerOnlyQuestionReads?: boolean }) {
    const db = await createMigratedTestD1();
    const stub = createPhase2FirestoreStub({ ownerOnlyQuestionReads: options?.ownerOnlyQuestionReads });
    seedAuthoritativeFixtureData(stub);

    const handler = createWorkerHandler({
      jwksFetcher: async () => ({ keys: [keyPair.jwk], maxAgeSeconds: 3600 }),
      fetchImpl: stub.fetchImpl,
      nowMsFn: () => virtualNowMs,
      questionBankCacheTtlMs: options?.cacheTtlMs ?? 300_000,
      rateLimitOverrides: {
        windowMs: 60_000,
        globalMax: 500,
        routeMax: { practice_check: options?.practiceLimit ?? 30 }
      }
    });

    const env: WorkerEnv = {
      DB: db,
      ENVIRONMENT: 'staging',
      FIREBASE_PROJECT_ID: EXPECTED_FIREBASE_PROJECT_ID,
      FIREBASE_DATABASE_ID: EXPECTED_FIREBASE_DATABASE_ID,
      ALLOWED_ORIGIN: 'https://s--khayrul-alam.khayrulalam88.workers.dev'
    };

    const establishSession = async (token: string) => {
      const res = await handler(
        new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/auth/session', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` }
        }),
        env
      );
      assert.equal(res.status, 200);
      const data = (await res.json()) as { sessionId: string };
      return data.sessionId;
    };

    return { db, stub, handler, env, establishSession };
  }

  test('1. Public subject, chapter, package, settings, and exam catalog APIs return canonical data without keys', async () => {
    const { handler, env } = await buildTestHarness();

    const subjectsRes = await handler(new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/subjects'), env);
    assert.equal(subjectsRes.status, 200);
    const subjectsJson = (await subjectsRes.json()) as { subjects: Array<{ id: string }> };
    assert.equal(subjectsJson.subjects.length, 7);

    const chapRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/subjects/sub_cpc/chapters'),
      env
    );
    assert.equal(chapRes.status, 200);
    const chapJson = (await chapRes.json()) as {
      subject: { id: string };
      chapters: Array<{ id: string; questionCount: number }>;
    };
    assert.equal(chapJson.subject.id, 'sub_cpc');
    assert.deepEqual(chapJson.chapters, [
      { id: 'chap_decrees', subjectId: 'sub_cpc', questionCount: 5 },
      { id: 'chap_jurisdiction', subjectId: 'sub_cpc', questionCount: 5 }
    ]);

    const pkgRes = await handler(new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/packages'), env);
    assert.equal(pkgRes.status, 200);
    const pkgJson = (await pkgRes.json()) as { packages: Array<{ id: string; price: number }> };
    const examPass = pkgJson.packages.find(p => p.id === 'pkg_exam_pass');
    assert.equal(examPass?.price, 650);

    const payRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/payment-settings'),
      env
    );
    assert.equal(payRes.status, 200);
    const payJson = (await payRes.json()) as { paymentSettings: { bkashNumber: string; nagadNumber: string } };
    assert.equal(payJson.paymentSettings.bkashNumber, '01712607777');
    assert.equal(payJson.paymentSettings.nagadNumber, '01712607777');

    const examsRes = await handler(new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/exams'), env);
    assert.equal(examsRes.status, 200);
    const examsJson = (await examsRes.json()) as { exams: Array<{ id: string }> };
    assert.equal(examsJson.exams.length, 2);
  });

  test('2. Authorized vs unauthorized access & named DB validation', async () => {
    const { handler, env, establishSession } = await buildTestHarness();
    const sessFree = await establishSession(freeStudentToken);

    // Unauthenticated rejected 401
    for (const p of ['/api/questions', '/api/practice/questions', '/api/practice/check']) {
      const r = await handler(
        new Request(`https://s--khayrul-alam.khayrulalam88.workers.dev${p}`, {
          method: p === '/api/practice/check' ? 'POST' : 'GET'
        }),
        env
      );
      assert.equal(r.status, 401);
    }

    // Unverified email rejected 403 EMAIL_NOT_VERIFIED
    const unverRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/questions', {
        headers: { Authorization: `Bearer ${unverifiedToken}`, 'X-Session-Id': sessFree }
      }),
      env
    );
    assert.equal(unverRes.status, 403);
    assert.equal(((await unverRes.json()) as { error: string }).error, 'EMAIL_NOT_VERIFIED');

    // Missing X-Session-Id rejected 401 SESSION_REQUIRED
    const noSessRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/questions', {
        headers: { Authorization: `Bearer ${freeStudentToken}` }
      }),
      env
    );
    assert.equal(noSessRes.status, 401);
    assert.equal(((await noSessRes.json()) as { error: string }).error, 'SESSION_REQUIRED');

    // Default or wrong database ID fails closed 503
    const badDbRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/questions', {
        headers: { Authorization: `Bearer ${freeStudentToken}`, 'X-Session-Id': sessFree }
      }),
      { ...env, FIREBASE_DATABASE_ID: '(default)' }
    );
    assert.equal(badDbRes.status, 503);
  });

  test('3. Question pagination, filtering, validation, and zero answer-key leakage', async () => {
    const { handler, env, establishSession } = await buildTestHarness();
    const sessPro = await establishSession(proStudentToken);

    // Page 1 of sub_cpc
    const p1Res = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/questions?subjectId=sub_cpc&limit=4&offset=0', {
        headers: { Authorization: `Bearer ${proStudentToken}`, 'X-Session-Id': sessPro }
      }),
      env
    );
    assert.equal(p1Res.status, 200);
    const p1Json = (await p1Res.json()) as {
      questions: Array<Record<string, unknown>>;
      total: number;
      limit: number;
      offset: number;
      hasMore: boolean;
    };
    assert.equal(p1Json.total, 10);
    assert.equal(p1Json.questions.length, 4);
    assert.equal(p1Json.hasMore, true);
    assert.equal(p1Json.questions[0].id, 'q_01');

    // Verify q_01 had legacy correctOptionIndex/explanation stripped completely!
    for (const q of p1Json.questions) {
      assert.equal('correctOptionIndex' in q, false);
      assert.equal('explanationBn' in q, false);
      assert.equal('explanationEn' in q, false);
    }

    // Invalid pagination or difficulty -> 400 INVALID_REQUEST
    const badLimit = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/questions?limit=-5', {
        headers: { Authorization: `Bearer ${proStudentToken}`, 'X-Session-Id': sessPro }
      }),
      env
    );
    assert.equal(badLimit.status, 400);

    const badOffset = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/questions?offset=-1', {
        headers: { Authorization: `Bearer ${proStudentToken}`, 'X-Session-Id': sessPro }
      }),
      env
    );
    assert.equal(badOffset.status, 400);

    const badDiff = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/questions?difficulty=impossible', {
        headers: { Authorization: `Bearer ${proStudentToken}`, 'X-Session-Id': sessPro }
      }),
      env
    );
    assert.equal(badDiff.status, 400);
  });

  test('4. Subscription gating on /api/questions?examId=..., /api/practice/questions, and /api/practice/check', async () => {
    const { handler, env, establishSession } = await buildTestHarness();
    const sessFree = await establishSession(freeStudentToken);
    const sessExpired = await establishSession(expiredStudentToken);
    const sessPro = await establishSession(proStudentToken);

    // Free student blocked from paid exam questions (403)
    const paidExamFree = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/questions?examId=exam_model_test_02', {
        headers: { Authorization: `Bearer ${freeStudentToken}`, 'X-Session-Id': sessFree }
      }),
      env
    );
    assert.equal(paidExamFree.status, 403);
    assert.equal(((await paidExamFree.json()) as { error: string }).error, 'SUBSCRIPTION_REQUIRED');

    // Expired student blocked from paid exam questions (403)
    const paidExamExp = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/questions?examId=exam_model_test_02', {
        headers: { Authorization: `Bearer ${expiredStudentToken}`, 'X-Session-Id': sessExpired }
      }),
      env
    );
    assert.equal(paidExamExp.status, 403);

    // Active Pro student allowed paid exam questions (still sanitized!)
    const paidExamPro = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/questions?examId=exam_model_test_02', {
        headers: { Authorization: `Bearer ${proStudentToken}`, 'X-Session-Id': sessPro }
      }),
      env
    );
    assert.equal(paidExamPro.status, 200);
    const paidExamProJson = (await paidExamPro.json()) as { questions: Array<Record<string, unknown>> };
    assert.equal(paidExamProJson.questions.length, 5);
    assert.equal('correctOptionIndex' in paidExamProJson.questions[0], false);

    // Practice question retrieval: free student gets ONLY demo samples, blocked if paidOnly=true
    const pracFree = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/practice/questions?subjectId=sub_cpc', {
        headers: { Authorization: `Bearer ${freeStudentToken}`, 'X-Session-Id': sessFree }
      }),
      env
    );
    assert.equal(pracFree.status, 200);
    const pracFreeJson = (await pracFree.json()) as {
      questions: Array<Record<string, unknown>>;
      subscriptionActive: boolean;
      demoOnlyApplied: boolean;
    };
    assert.equal(pracFreeJson.subscriptionActive, false);
    assert.equal(pracFreeJson.demoOnlyApplied, true);
    assert.equal(pracFreeJson.questions.length, 5);
    assert.ok(pracFreeJson.questions.every(q => q.isDemoSample === true));
    assert.ok(pracFreeJson.questions.every(q => !('correctOptionIndex' in q) && !('explanationBn' in q)));

    const pracFreePaidOnly = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/practice/questions?paidOnly=true', {
        headers: { Authorization: `Bearer ${freeStudentToken}`, 'X-Session-Id': sessFree }
      }),
      env
    );
    assert.equal(pracFreePaidOnly.status, 403);

    // Practice check on paid question blocked for free & expired student, allowed for demo question
    const checkPaidFree = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/practice/check', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${freeStudentToken}`,
          'X-Session-Id': sessFree,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ questionId: 'q_06', selectedOption: 2 })
      }),
      env
    );
    assert.equal(checkPaidFree.status, 403);

    const checkDemoFree = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/practice/check', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${freeStudentToken}`,
          'X-Session-Id': sessFree,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ questionId: 'q_01', selectedOption: 1 })
      }),
      env
    );
    assert.equal(checkDemoFree.status, 200);
  });

  test('5. Server-side answer verification: correct vs incorrect & explanation revealed ONLY after submission', async () => {
    const { handler, env, establishSession } = await buildTestHarness();
    const sessPro = await establishSession(proStudentToken);

    // First retrieve practice questions — NO explanations or answers yet
    const listRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/practice/questions?subjectId=sub_cpc', {
        headers: { Authorization: `Bearer ${proStudentToken}`, 'X-Session-Id': sessPro }
      }),
      env
    );
    const listJson = (await listRes.json()) as { questions: Array<Record<string, unknown>> };
    assert.equal(listJson.questions.length, 10);
    for (const q of listJson.questions) {
      assert.equal('correctOptionIndex' in q, false);
      assert.equal('explanationBn' in q, false);
      assert.equal('explanationEn' in q, false);
    }

    // Check q_06: key in seed is 6 % 4 = 2
    const correctRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/practice/check', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${proStudentToken}`,
          'X-Session-Id': sessPro,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ questionId: 'q_06', selectedOption: 2 })
      }),
      env
    );
    assert.equal(correctRes.status, 200);
    const correctJson = (await correctRes.json()) as {
      isCorrect: boolean;
      correctOptionIndex: number;
      explanationBn: string;
      explanationEn: string;
    };
    assert.equal(correctJson.isCorrect, true);
    assert.equal(correctJson.correctOptionIndex, 2);
    assert.ok(correctJson.explanationBn.includes('প্রশ্ন 6'));
    assert.ok(correctJson.explanationEn.includes('question 6'));

    // Incorrect option (0 != 2)
    const wrongRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/practice/check', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${proStudentToken}`,
          'X-Session-Id': sessPro,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ questionId: 'q_06', selectedOption: 0 })
      }),
      env
    );
    assert.equal(wrongRes.status, 200);
    const wrongJson = (await wrongRes.json()) as { isCorrect: boolean; correctOptionIndex: number };
    assert.equal(wrongJson.isCorrect, false);
    assert.equal(wrongJson.correctOptionIndex, 2);

    // Out-of-range selectedOption rejected 400
    const badOpt = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/practice/check', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${proStudentToken}`,
          'X-Session-Id': sessPro,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ questionId: 'q_06', selectedOption: 4 })
      }),
      env
    );
    assert.equal(badOpt.status, 400);
  });

  test('6. Question bank D1 cache freshness, TTL revalidation, zero /questionKeys reads in student paths & Owner cache invalidation', async () => {
    const { stub, handler, env, establishSession } = await buildTestHarness({ cacheTtlMs: 60_000 });
    const sessPro = await establishSession(proStudentToken);
    stub.resetReadLog();

    // First student /api/questions request warms D1 cache from Firestore /questions (NEVER /questionKeys)
    const r1 = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/questions?limit=5&offset=0', {
        headers: { Authorization: `Bearer ${proStudentToken}`, 'X-Session-Id': sessPro }
      }),
      env
    );
    assert.equal(r1.status, 200);
    assert.equal(stub.readLog.some(l => l.collection === 'questions'), true);
    assert.equal(stub.readLog.some(l => l.collection === 'questionKeys'), false);

    // Second request within TTL makes ZERO Firestore question reads
    stub.resetReadLog();
    virtualNowMs += 10_000;
    const r2 = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/questions?limit=5&offset=5', {
        headers: { Authorization: `Bearer ${proStudentToken}`, 'X-Session-Id': sessPro }
      }),
      env
    );
    assert.equal(r2.status, 200);
    assert.equal(stub.readLog.length, 0);

    // After TTL expires, worker checks ONLY config/questionBankVersion (1 read) when unchanged
    virtualNowMs += 70_000;
    stub.resetReadLog();
    const r3 = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/questions?limit=5&offset=0', {
        headers: { Authorization: `Bearer ${proStudentToken}`, 'X-Session-Id': sessPro }
      }),
      env
    );
    assert.equal(r3.status, 200);
    assert.equal(stub.readLog.length, 1);
    assert.equal(stub.readLog[0].collection, 'config');
    assert.equal(stub.readLog[0].docId, 'questionBankVersion');

    // Non-owner blocked from all Owner Question Admin endpoints (403)
    const studentAdminGet = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/admin/questions', {
        headers: { Authorization: `Bearer ${proStudentToken}`, 'X-Session-Id': sessPro }
      }),
      env
    );
    assert.equal(studentAdminGet.status, 403);

    const studentInvalidate = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/admin/questions/invalidate-cache', {
        method: 'POST',
        headers: { Authorization: `Bearer ${proStudentToken}`, 'X-Session-Id': sessPro }
      }),
      env
    );
    assert.equal(studentInvalidate.status, 403);

    // Owner Admin saves a question -> atomically updates Firestore + versionToken + auditLogs + D1 cache
    const saveRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/admin/questions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'q_new_owner_01',
          subjectId: 'sub_sra',
          questionBn: 'নতুন প্রশ্ন: সুনির্দিষ্ট প্রতিকার আইন',
          optionsBn: ['ক', 'খ', 'গ', 'ঘ'],
          correctOptionIndex: 3,
          explanationBn: 'ব্যাখ্যা ৩',
          isDemoSample: false
        })
      }),
      env
    );
    assert.equal(saveRes.status, 200);

    // Check practice answer immediately picks up new key without stale cache!
    const checkNewRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/practice/check', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${proStudentToken}`,
          'X-Session-Id': sessPro,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ questionId: 'q_new_owner_01', selectedOption: 3 })
      }),
      env
    );
    assert.equal(checkNewRes.status, 200);
    assert.equal(((await checkNewRes.json()) as { isCorrect: boolean }).isCorrect, true);

    // Owner invalidates cache manually -> next student read re-syncs from Firestore
    const invRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/admin/questions/invalidate-cache', {
        method: 'POST',
        headers: { Authorization: `Bearer ${ownerToken}` }
      }),
      env
    );
    assert.equal(invRes.status, 200);

    stub.resetReadLog();
    const afterInvRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/questions?subjectId=sub_sra', {
        headers: { Authorization: `Bearer ${proStudentToken}`, 'X-Session-Id': sessPro }
      }),
      env
    );
    assert.equal(afterInvRes.status, 200);
    assert.equal(stub.readLog.some(l => l.collection === 'questions'), true);
    const afterInvJson = (await afterInvRes.json()) as { questions: Array<{ id: string }> };
    assert.equal(afterInvJson.questions.some(q => q.id === 'q_new_owner_01'), true);

    // Owner deletes question
    const delRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/admin/questions/q_new_owner_01', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${ownerToken}` }
      }),
      env
    );
    assert.equal(delRes.status, 200);
    assert.equal(stub.getCol('questions').has('q_new_owner_01'), false);
    assert.equal(stub.getCol('questionKeys').has('q_new_owner_01'), false);
  });

  test('7. Rate limiting on POST /api/practice/check returns 429 + Retry-After', async () => {
    const { handler, env, establishSession } = await buildTestHarness({ practiceLimit: 2 });
    const sessPro = await establishSession(proStudentToken);

    for (let i = 0; i < 2; i++) {
      const r = await handler(
        new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/practice/check', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${proStudentToken}`,
            'X-Session-Id': sessPro,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ questionId: 'q_01', selectedOption: 1 })
        }),
        env
      );
      assert.equal(r.status, 200);
    }

    const limited = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/practice/check', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${proStudentToken}`,
          'X-Session-Id': sessPro,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ questionId: 'q_01', selectedOption: 1 })
      }),
      env
    );
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('Retry-After')) >= 1);
    assert.equal(((await limited.json()) as { error: string }).error, 'RATE_LIMITED');
  });

  test('8. Keyless Firestore-rules mode: student 403 on /questions & /questionKeys succeeds after Owner /sync-cache warms D1', async () => {
    const { handler, env, establishSession } = await buildTestHarness({
      cacheTtlMs: 1_000,
      ownerOnlyQuestionReads: true
    });
    const sessPro = await establishSession(proStudentToken);

    // Owner syncs D1 question & key cache using their Firebase ID token
    const syncRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/admin/questions/sync-cache', {
        method: 'POST',
        headers: { Authorization: `Bearer ${ownerToken}` }
      }),
      env
    );
    assert.equal(syncRes.status, 200);
    const syncJson = (await syncRes.json()) as { success: boolean; questionCount: number; keyCount: number };
    assert.equal(syncJson.success, true);
    assert.equal(syncJson.questionCount, 15);
    assert.equal(syncJson.keyCount, 15);

    // Advance past TTL so Worker checks Firestore; student gets 403 from Firestore rules and falls back cleanly to warmed D1!
    virtualNowMs += 5_000;
    const qRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/questions?subjectId=sub_cpc', {
        headers: { Authorization: `Bearer ${proStudentToken}`, 'X-Session-Id': sessPro }
      }),
      env
    );
    assert.equal(qRes.status, 200);
    const qJson = (await qRes.json()) as { questions: Array<Record<string, unknown>> };
    assert.equal(qJson.questions.length, 10);
    assert.equal('correctOptionIndex' in qJson.questions[0], false);

    const pracRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/practice/check', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${proStudentToken}`,
          'X-Session-Id': sessPro,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ questionId: 'q_06', selectedOption: 2 })
      }),
      env
    );
    assert.equal(pracRes.status, 200);
    assert.equal(((await pracRes.json()) as { isCorrect: boolean }).isCorrect, true);
  });
});
