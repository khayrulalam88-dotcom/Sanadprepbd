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
import { upsertExamsBatchD1 } from '../worker/d1Store.ts';
import {
  resolveAdminQuestionBankFetchOutcome,
  classifyAdminQuestionBankError
} from '../src/lib/adminQuestionHelpers.ts';
import { formatBackendApiError } from '../src/lib/securityHelpers.ts';

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

function createQuotaAwareFirestoreStub() {
  const expectedPrefix = `https://firestore.googleapis.com/v1/projects/${EXPECTED_FIREBASE_PROJECT_ID}/databases/${EXPECTED_FIREBASE_DATABASE_ID}/documents`;
  const collections = new Map<string, Map<string, Record<string, unknown>>>();
  const readLog: Array<{ op: string; collection: string; docId?: string }> = [];
  let forceQuotaExhausted = false;

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

  const setForceQuotaExhausted = (val: boolean) => {
    forceQuotaExhausted = val;
  };

  const quotaResponse = () =>
    new Response(
      JSON.stringify({
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          message: 'Quota exceeded for quota metric Read requests and limit Read requests per day.'
        }
      }),
      { status: 429, headers: { 'Content-Type': 'application/json' } }
    );

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method || 'GET').toUpperCase();

    assert.ok(url.startsWith(expectedPrefix), `Invalid Firestore REST database target: ${url}`);
    const restPath = url.slice(expectedPrefix.length);

    if (forceQuotaExhausted && (method === 'GET' || restPath === ':batchGet' || restPath === ':runQuery')) {
      readLog.push({ op: `429_${method}`, collection: restPath });
      return quotaResponse();
    }

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

      if (segments.length === 1) {
        const col = segments[0];
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
              name: `${expectedPrefix}/${col}/${id}`,
              fields: encodeDocumentFields(data)
            })),
            ...(nextPageToken ? { nextPageToken } : {})
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (segments.length === 2) {
        const [col, docId] = segments.map(decodeURIComponent);
        readLog.push({ op: 'getDocument', collection: col, docId });
        const doc = getCol(col).get(docId);
        if (!doc) {
          return new Response(JSON.stringify({ error: { code: 404, status: 'NOT_FOUND', message: 'Not found' } }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        return new Response(
          JSON.stringify({
            name: `${expectedPrefix}/${col}/${docId}`,
            fields: encodeDocumentFields(doc)
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    return new Response(JSON.stringify({ error: { code: 404, message: 'Unhandled stub path' } }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  return { fetchImpl, setDoc, getCol, readLog, resetReadLog, setForceQuotaExhausted };
}

async function seedD1QuestionsDirectly(
  db: D1Database,
  count: number,
  options?: { versionToken?: string; syncedIso?: string }
) {
  const versionToken = options?.versionToken || 'v_3000_seeded';
  const syncedIso = options?.syncedIso || new Date(1_775_000_000_000).toISOString();
  const subjects = ['sub_cpc', 'sub_sra', 'sub_crpc', 'sub_penal', 'sub_evidence', 'sub_limitation', 'sub_ethics'];

  const qStmts: D1PreparedStatement[] = [];
  const kStmts: D1PreparedStatement[] = [];
  const chunkRows = 25;

  for (let i = 1; i <= count; i += chunkRows) {
    const end = Math.min(count, i + chunkRows - 1);
    const qPlaceholders: string[] = [];
    const qValues: unknown[] = [];
    const kPlaceholders: string[] = [];
    const kValues: unknown[] = [];

    for (let idx = i; idx <= end; idx++) {
      const localIdx = idx - i;
      const qb = localIdx * 14;
      qPlaceholders.push(
        `(?${qb + 1}, ?${qb + 2}, ?${qb + 3}, ?${qb + 4}, ?${qb + 5}, ?${qb + 6}, ?${qb + 7}, ?${qb + 8}, ?${qb + 9}, ?${qb + 10}, ?${qb + 11}, ?${qb + 12}, ?${qb + 13}, ?${qb + 14})`
      );
      const id = `q_${String(idx).padStart(4, '0')}`;
      const subjectId = subjects[(idx - 1) % subjects.length];
      const isDemo = idx <= 20 ? 1 : 0;
      const correctIdx = idx % 4;
      qValues.push(
        id,
        subjectId,
        'topic_1',
        `প্রশ্ন নম্বর ${idx}: দেওয়ানী কার্যবিধি ধারা ${idx}`,
        `Question number ${idx}: Civil Procedure Section ${idx}`,
        JSON.stringify([`ক-${idx}`, `খ-${idx}`, `গ-${idx}`, `ঘ-${idx}`]),
        JSON.stringify([`A-${idx}`, `B-${idx}`, `C-${idx}`, `D-${idx}`]),
        `Sec ${idx}`,
        idx % 3 === 0 ? 'hard' : idx % 2 === 0 ? 'easy' : 'medium',
        'published',
        isDemo,
        syncedIso,
        syncedIso,
        versionToken
      );

      const kb = localIdx * 7;
      kPlaceholders.push(
        `(?${kb + 1}, ?${kb + 2}, ?${kb + 3}, ?${kb + 4}, ?${kb + 5}, ?${kb + 6}, ?${kb + 7})`
      );
      kValues.push(
        id,
        correctIdx,
        `ব্যাখ্যা নম্বর ${idx}`,
        `Explanation number ${idx}`,
        `Sec ${idx}`,
        syncedIso,
        versionToken
      );
    }

    qStmts.push(
      db
        .prepare(
          `INSERT INTO question_bank_cache (
             id, subject_id, topic_id, question_bn, question_en,
             options_bn_json, options_en_json, legal_reference,
             difficulty, status, is_demo_sample, created_at, updated_at, synced_version
           ) VALUES ${qPlaceholders.join(', ')}`
        )
        .bind(...qValues)
    );

    kStmts.push(
      db
        .prepare(
          `INSERT INTO question_keys_cache (
             question_id, correct_option_index, explanation_bn, explanation_en,
             legal_reference, updated_at, synced_version
           ) VALUES ${kPlaceholders.join(', ')}`
        )
        .bind(...kValues)
    );
  }

  for (let j = 0; j < qStmts.length; j += 40) {
    await db.batch(qStmts.slice(j, j + 40));
  }
  for (let j = 0; j < kStmts.length; j += 40) {
    await db.batch(kStmts.slice(j, j + 40));
  }

  await db
    .prepare(
      `INSERT INTO question_bank_meta (id, version, version_token, synced_at, question_count)
       VALUES ('questionBankVersion', 1, ?1, ?2, ?3)
       ON CONFLICT(id) DO UPDATE SET
         version = excluded.version,
         version_token = excluded.version_token,
         synced_at = excluded.synced_at,
         question_count = excluded.question_count`
    )
    .bind(versionToken, syncedIso, count)
    .run();
}

describe('Firestore 429 Quota Protection & D1-First Question Bank', () => {
  let keypair: Awaited<ReturnType<typeof generateRs256Keypair>>;
  let ownerToken: string;
  let studentToken: string;
  let virtualNowMs = 1_775_000_000_000;

  beforeEach(async () => {
    clearFirebaseJwksCacheForTests();
    virtualNowMs = 1_775_000_000_000;
    keypair = await generateRs256Keypair('kid-quota-test');
    const exp = Math.floor((virtualNowMs + 3_600_000) / 1000);
    const iat = Math.floor(virtualNowMs / 1000) - 60;

    ownerToken = await signJwt(keypair.privateKey, keypair.kid, {
      iss: `https://securetoken.google.com/${EXPECTED_FIREBASE_PROJECT_ID}`,
      aud: EXPECTED_FIREBASE_PROJECT_ID,
      sub: OWNER_ADMIN_UID,
      user_id: OWNER_ADMIN_UID,
      email: OWNER_ADMIN_EMAIL,
      email_verified: true,
      name: 'Owner Admin',
      iat,
      exp
    });

    studentToken = await signJwt(keypair.privateKey, keypair.kid, {
      iss: `https://securetoken.google.com/${EXPECTED_FIREBASE_PROJECT_ID}`,
      aud: EXPECTED_FIREBASE_PROJECT_ID,
      sub: 'student_d1_quota_1',
      user_id: 'student_d1_quota_1',
      email: 'student.d1@example.com',
      email_verified: true,
      name: 'Student D1',
      iat,
      exp
    });
  });

  async function buildHarness(options?: { cacheTtlMs?: number; preSeedCount?: number }) {
    const db = await createMigratedTestD1();
    const stub = createQuotaAwareFirestoreStub();
    stub.setDoc('config', 'questionBankVersion', {
      version: 1,
      versionToken: 'v_3000_seeded',
      updatedAt: new Date(virtualNowMs).toISOString()
    });
    stub.setDoc('exams', 'exam_model_test_01', {
      id: 'exam_model_test_01',
      titleBn: 'ফ্রি ডেমো মডেল টেস্ট ০১',
      titleEn: 'Free Demo Model Test 01',
      type: 'free_demo',
      isPaid: false,
      isActive: true,
      durationMinutes: 60,
      totalMarks: 100,
      negativeMarkRatio: 0.25,
      passThresholdPercentage: 50,
      questionIds: ['q_0001', 'q_0002', 'q_0003', 'q_0004', 'q_0005']
    });

    const count = options?.preSeedCount ?? 60;
    await seedD1QuestionsDirectly(db, count, {
      syncedIso: new Date(virtualNowMs).toISOString()
    });

    // Also pre-warm edge_exams_cache for exam_model_test_01
    await upsertExamsBatchD1(
      db,
      [
        {
          id: 'exam_model_test_01',
          titleBn: 'ফ্রি ডেমো মডেল টেস্ট ০১',
          titleEn: 'Free Demo Model Test 01',
          descriptionBn: 'ফ্রি ডেমো টেস্ট',
          descriptionEn: 'Free Demo Test',
          type: 'full_mock',
          isPaid: false,
          isActive: true,
          published: true,
          releaseExplanationsImmediately: true,
          durationMinutes: 60,
          totalMarks: 100,
          negativeMarkRatio: 0.25,
          positiveMarkRatio: 1,
          passThresholdPercentage: 50,
          questionIds: ['q_0001', 'q_0002', 'q_0003', 'q_0004', 'q_0005'],
          createdAt: new Date(virtualNowMs).toISOString()
        }
      ],
      new Date(virtualNowMs).toISOString()
    );

    const env: WorkerEnv = {
      ENVIRONMENT: 'production',
      ALLOWED_ORIGIN: 'https://sanadprepbd.pages.dev',
      FIREBASE_PROJECT_ID: EXPECTED_FIREBASE_PROJECT_ID,
      FIREBASE_DATABASE_ID: EXPECTED_FIREBASE_DATABASE_ID,
      QUESTION_BANK_CACHE_TTL_MS: String(options?.cacheTtlMs ?? 3_600_000),
      DB: db
    };

    const handler = createWorkerHandler({
      fetchImpl: stub.fetchImpl,
      jwksFetcher: async () => ({ keys: [keypair.jwk], maxAgeSeconds: 3600 }),
      nowMsFn: () => virtualNowMs,
      questionBankCacheTtlMs: options?.cacheTtlMs ?? 3_600_000
    });

    const establishSession = async (token: string) => {
      const res = await handler(
        new Request('https://sanadprepbd.pages.dev/api/auth/session', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceInfo: 'TestBrowser' })
        }),
        env
      );
      assert.equal(res.status, 200);
      return ((await res.json()) as { sessionId: string }).sessionId;
    };

    return { db, stub, env, handler, establishSession };
  }

  test('1 & 2 & 3. Admin Question Bank load/refresh, /api/questions/version, and Owner login warmup make ZERO Firestore reads and return D1 questions + keys even when Firestore is 429', async () => {
    const { stub, env, handler, establishSession } = await buildHarness({ preSeedCount: 60 });

    stub.setForceQuotaExhausted(true);
    stub.resetReadLog();

    // Owner login session warmup skips Firestore when D1 already has cached questions
    const ownerSess = await establishSession(ownerToken);
    assert.equal(
      stub.readLog.some(r => r.collection.includes('questionBankVersion') || r.collection.includes('questions')),
      false
    );

    stub.resetReadLog();

    // GET /api/questions/version reads D1 only (0 Firestore reads)
    const verRes = await handler(
      new Request('https://sanadprepbd.pages.dev/api/questions/version', {
        headers: { Authorization: `Bearer ${ownerToken}`, 'X-Session-Id': ownerSess }
      }),
      env
    );
    assert.equal(verRes.status, 200);
    const verJson = (await verRes.json()) as { versionToken: string; questionCount: number; source: string };
    assert.equal(verJson.source, 'd1');
    assert.equal(verJson.questionCount, 60);
    assert.equal(verJson.versionToken, 'v_3000_seeded');
    assert.equal(stub.readLog.length, 0);

    // Initial load + repeated refreshes of Admin Question Bank succeed with 0 Firestore calls
    for (let refresh = 0; refresh < 3; refresh++) {
      const adminRes = await handler(
        new Request('https://sanadprepbd.pages.dev/api/admin/questions?limit=50&offset=0', {
          headers: { Authorization: `Bearer ${ownerToken}`, 'X-Session-Id': ownerSess }
        }),
        env
      );
      assert.equal(adminRes.status, 200);
      const adminJson = (await adminRes.json()) as {
        questions: Array<Record<string, unknown>>;
        total: number;
        limit: number;
        offset: number;
        hasMore: boolean;
        source: string;
      };
      assert.equal(adminJson.source, 'd1');
      assert.equal(adminJson.total, 60);
      assert.equal(adminJson.questions.length, 50);
      assert.equal(adminJson.hasMore, true);
      // Owner receives authoritative answer keys & explanations from D1 question_keys_cache
      assert.equal(adminJson.questions[0].id, 'q_0001');
      assert.equal(adminJson.questions[0].correctOptionIndex, 1);
      assert.equal(adminJson.questions[0].explanationBn, 'ব্যাখ্যা নম্বর 1');
      assert.equal(adminJson.questions[0].explanationEn, 'Explanation number 1');
    }

    assert.equal(stub.readLog.length, 0, 'Normal Admin load/refresh must perform ZERO Firestore reads');
  });

  test('4. Non-owner students are blocked (403) from /api/admin/questions and student routes strip answer keys', async () => {
    const { stub, env, handler, establishSession } = await buildHarness({ preSeedCount: 60 });
    const stuSess = await establishSession(studentToken);
    stub.setForceQuotaExhausted(true);
    stub.resetReadLog();

    const adminBlocked = await handler(
      new Request('https://sanadprepbd.pages.dev/api/admin/questions', {
        headers: { Authorization: `Bearer ${studentToken}`, 'X-Session-Id': stuSess }
      }),
      env
    );
    assert.equal(adminBlocked.status, 403);

    const pracRes = await handler(
      new Request('https://sanadprepbd.pages.dev/api/practice/questions?limit=10&offset=0', {
        headers: { Authorization: `Bearer ${studentToken}`, 'X-Session-Id': stuSess }
      }),
      env
    );
    assert.equal(pracRes.status, 200);
    const pracJson = (await pracRes.json()) as { questions: Array<Record<string, unknown>> };
    assert.ok(pracJson.questions.length > 0);
    for (const q of pracJson.questions) {
      assert.equal('correctOptionIndex' in q, false);
      assert.equal('explanationBn' in q, false);
      assert.equal('explanationEn' in q, false);
    }
  });

  test('5. Student exam start/submit, practice check, counts, and catalog succeed during Firestore 429 quota exhaustion (even after TTL expires)', async () => {
    const { stub, env, handler, establishSession } = await buildHarness({
      cacheTtlMs: 1_000,
      preSeedCount: 60
    });
    const stuSess = await establishSession(studentToken);

    // Advance past D1 freshness TTL AND simulate full Firestore 429 quota exhaustion
    virtualNowMs += 10_000;
    stub.setForceQuotaExhausted(true);
    stub.resetReadLog();

    // Counts succeed
    const countsRes = await handler(
      new Request('https://sanadprepbd.pages.dev/api/subjects/counts'),
      env
    );
    assert.equal(countsRes.status, 200);
    const countsJson = (await countsRes.json()) as { total: number };
    assert.equal(countsJson.total, 60);

    // Exams list succeeds via D1 edge_exams_cache
    const examsRes = await handler(
      new Request('https://sanadprepbd.pages.dev/api/exams'),
      env
    );
    assert.equal(examsRes.status, 200);
    const examsJson = (await examsRes.json()) as { exams: Array<{ id: string }> };
    assert.ok(examsJson.exams.some(e => e.id === 'exam_model_test_01'));

    // Practice check answers via D1 question_keys_cache (q_0002 -> 2 % 4 = 2)
    const checkRes = await handler(
      new Request('https://sanadprepbd.pages.dev/api/practice/check', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${studentToken}`,
          'X-Session-Id': stuSess,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ questionId: 'q_0002', selectedOption: 2 })
      }),
      env
    );
    assert.equal(checkRes.status, 200);
    const checkJson = (await checkRes.json()) as { isCorrect: boolean; correctOptionIndex: number };
    assert.equal(checkJson.isCorrect, true);
    assert.equal(checkJson.correctOptionIndex, 2);

    // Free Demo Test start + submit succeed via D1 during Firestore 429!
    const startRes = await handler(
      new Request('https://sanadprepbd.pages.dev/api/exams/start', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${studentToken}`,
          'X-Session-Id': stuSess,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ examId: 'exam_model_test_01' })
      }),
      env
    );
    assert.equal(startRes.status, 200);
    const startJson = (await startRes.json()) as {
      attempt: { id: string };
      questions: Array<Record<string, unknown>>;
    };
    assert.equal(startJson.questions.length, 5);
    assert.equal('correctOptionIndex' in startJson.questions[0], false);

    const submitRes = await handler(
      new Request('https://sanadprepbd.pages.dev/api/exams/submit', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${studentToken}`,
          'X-Session-Id': stuSess,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          attemptId: startJson.attempt.id,
          answers: { q_0001: 1, q_0002: 2, q_0003: 3, q_0004: 0, q_0005: 0 }
        })
      }),
      env
    );
    assert.equal(submitRes.status, 200);
    const submitJson = (await submitRes.json()) as {
      result: { correctAnswersCount: number; incorrectAnswersCount: number; finalScore: number };
    };
    assert.equal(submitJson.result.correctAnswersCount, 4);
    assert.equal(submitJson.result.incorrectAnswersCount, 1);
  });

  test('6. 3,000-question D1 cache pagination & filters work accurately, and UI helpers classify 429 quota while preserving cached counts', async () => {
    const { stub, env, handler, establishSession } = await buildHarness({ preSeedCount: 3000 });
    stub.setForceQuotaExhausted(true);
    const ownerSess = await establishSession(ownerToken);
    stub.resetReadLog();

    // Page 1 (limit=50, offset=0)
    const p1Res = await handler(
      new Request('https://sanadprepbd.pages.dev/api/admin/questions?limit=50&offset=0', {
        headers: { Authorization: `Bearer ${ownerToken}`, 'X-Session-Id': ownerSess }
      }),
      env
    );
    assert.equal(p1Res.status, 200);
    const p1 = (await p1Res.json()) as { total: number; hasMore: boolean; questions: Array<{ id: string }> };
    assert.equal(p1.total, 3000);
    assert.equal(p1.questions.length, 50);
    assert.equal(p1.questions[0].id, 'q_0001');
    assert.equal(p1.hasMore, true);

    // Last page (limit=50, offset=2950)
    const pLastRes = await handler(
      new Request('https://sanadprepbd.pages.dev/api/admin/questions?limit=50&offset=2950', {
        headers: { Authorization: `Bearer ${ownerToken}`, 'X-Session-Id': ownerSess }
      }),
      env
    );
    assert.equal(pLastRes.status, 200);
    const pLast = (await pLastRes.json()) as { total: number; hasMore: boolean; questions: Array<{ id: string }> };
    assert.equal(pLast.total, 3000);
    assert.equal(pLast.questions.length, 50);
    assert.equal(pLast.questions[49].id, 'q_3000');
    assert.equal(pLast.hasMore, false);

    // Subject + Search filter against 3,000 D1 rows
    const filterRes = await handler(
      new Request(
        'https://sanadprepbd.pages.dev/api/admin/questions?subjectId=sub_cpc&search=' +
          encodeURIComponent('ধারা 2997') +
          '&limit=50&offset=0',
        {
          headers: { Authorization: `Bearer ${ownerToken}`, 'X-Session-Id': ownerSess }
        }
      ),
      env
    );
    assert.equal(filterRes.status, 200);
    const filtered = (await filterRes.json()) as { total: number; questions: Array<{ id: string }> };
    assert.equal(filtered.total, 1);
    assert.equal(filtered.questions[0].id, 'q_2997');
    assert.equal(stub.readLog.length, 0);

    // Frontend helpers distinguish 429 RESOURCE_EXHAUSTED vs RATE_LIMITED and preserve prior count
    assert.equal(classifyAdminQuestionBankError({ status: 429, code: 'RESOURCE_EXHAUSTED' }), 'quota');
    assert.equal(classifyAdminQuestionBankError({ status: 429, code: 'RATE_LIMITED' }), 'other');

    const quotaMsg = formatBackendApiError({ status: 429, code: 'RESOURCE_EXHAUSTED' });
    assert.ok(quotaMsg.includes('RESOURCE_EXHAUSTED') || quotaMsg.includes('কোটা'));

    const outcome = resolveAdminQuestionBankFetchOutcome(
      { ok: false, status: 429, code: 'RESOURCE_EXHAUSTED', message: quotaMsg },
      { previousQuestionCount: 3000 }
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.state.errorCategory, 'quota');
    assert.equal(outcome.state.questionCount, 3000);
  });

  test('7. Failed explicit Firestore sync returning 429 RESOURCE_EXHAUSTED makes zero retries and preserves existing D1 cache intact', async () => {
    const { db, stub, env, handler, establishSession } = await buildHarness({ preSeedCount: 60 });
    const ownerSess = await establishSession(ownerToken);

    stub.setForceQuotaExhausted(true);
    stub.resetReadLog();

    const syncRes = await handler(
      new Request('https://sanadprepbd.pages.dev/api/admin/questions/sync-cache', {
        method: 'POST',
        headers: { Authorization: `Bearer ${ownerToken}`, 'X-Session-Id': ownerSess }
      }),
      env
    );
    assert.equal(syncRes.status, 429);
    const syncJson = (await syncRes.json()) as { error: string };
    assert.equal(syncJson.error, 'RESOURCE_EXHAUSTED');

    // No retry loop: Promise.all fires at most 1 batch of initial calls (version, questions, questionKeys)
    assert.ok(stub.readLog.length <= 3, `Expected zero retries, saw ${stub.readLog.length} calls`);

    // Existing D1 cache remains 100% intact
    const qCnt = await db.prepare(`SELECT COUNT(*) AS cnt FROM question_bank_cache`).first<{ cnt: number }>();
    const kCnt = await db.prepare(`SELECT COUNT(*) AS cnt FROM question_keys_cache`).first<{ cnt: number }>();
    const meta = await db
      .prepare(`SELECT question_count, version_token FROM question_bank_meta WHERE id = 'questionBankVersion'`)
      .first<{ question_count: number; version_token: string }>();

    assert.equal(Number(qCnt?.cnt), 60);
    assert.equal(Number(kCnt?.cnt), 60);
    assert.equal(Number(meta?.question_count), 60);
    assert.equal(meta?.version_token, 'v_3000_seeded');
  });
});
