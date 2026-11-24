import test, { describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { buildExamResultsCsv, escapeCsvCell } from '../src/utils/csvExport.ts';
import type { ExamResult } from '../src/types/index.ts';
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
  encodeDocumentFields,
  FirestoreRestClient
} from '../worker/firestoreRest.ts';
import {
  checkUserHasActiveSubscriptionKeyless,
  insertExamAttemptD1,
  upsertSubscriptionD1
} from '../worker/d1Store.ts';
import { ensureSanitizedQuestionsSyncedD1 } from '../worker/questionCache.ts';
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
  return {
    kid,
    privateKey: pair.privateKey,
    jwk: { ...exportedPub, kid, alg: 'RS256', use: 'sig' },
    pkcs8Pem: `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----`
  };
}

async function signJwt(
  privateKey: CryptoKey,
  kid: string,
  claims: Record<string, unknown>
): Promise<string> {
  const encoder = new TextEncoder();
  const headerSeg = base64UrlEncodeBytes(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })));
  const payloadSeg = base64UrlEncodeBytes(encoder.encode(JSON.stringify(claims)));
  const input = encoder.encode(`${headerSeg}.${payloadSeg}`);
  const buf = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer;
  const sig = await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, privateKey, buf);
  return `${headerSeg}.${payloadSeg}.${base64UrlEncodeBytes(new Uint8Array(sig))}`;
}

function createPackageLookupStub() {
  const expectedPrefix = `https://firestore.googleapis.com/v1/projects/${EXPECTED_FIREBASE_PROJECT_ID}/databases/${EXPECTED_FIREBASE_DATABASE_ID}/documents`;
  const collections = new Map<string, Map<string, Record<string, unknown>>>();

  const getCol = (col: string) => {
    let map = collections.get(col);
    if (!map) {
      map = new Map();
      collections.set(col, map);
    }
    return map;
  };

  const formatDoc = (col: string, docId: string, data: Record<string, unknown>) => ({
    name: `projects/${EXPECTED_FIREBASE_PROJECT_ID}/databases/${EXPECTED_FIREBASE_DATABASE_ID}/documents/${col}/${docId}`,
    fields: encodeDocumentFields(data),
    createTime: '2026-01-01T00:00:00.000Z',
    updateTime: '2026-01-01T00:00:00.000Z'
  });

  const stubFetch: typeof fetch = async (input, init) => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method || 'GET').toUpperCase();

    assert.equal(urlStr.startsWith('https://oauth2.googleapis.com'), false, 'Keyless Worker must never call oauth2 token API');

    if (urlStr === `${expectedPrefix}:commit`) {
      const body = JSON.parse(String(init?.body || '{}')) as {
        writes?: Array<{
          update?: { name: string; fields?: Record<string, unknown> };
          updateMask?: { fieldPaths?: string[] };
        }>;
      };
      for (const w of body.writes || []) {
        if (w.update) {
          const rel = w.update.name.split('/documents/')[1];
          const [col, ...rest] = rel.split('/');
          const docId = rest.join('/');
          const map = getCol(col);
          const incoming = decodeDocumentFields(w.update.fields as Record<string, any>) as Record<string, unknown>;
          if (w.updateMask?.fieldPaths?.length) {
            const existing = { ...(map.get(docId) || {}) };
            for (const fp of w.updateMask.fieldPaths) {
              if (fp in incoming) existing[fp] = incoming[fp];
            }
            map.set(docId, existing);
          } else {
            map.set(docId, incoming);
          }
        }
      }
      return new Response(JSON.stringify({ writeResults: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (urlStr === `${expectedPrefix}:runQuery`) {
      const body = JSON.parse(String(init?.body || '{}')) as {
        structuredQuery?: {
          from?: Array<{ collectionId: string }>;
          where?: { fieldFilter?: { field: { fieldPath: string }; op: string; value: any } };
        };
      };
      const col = body.structuredQuery?.from?.[0]?.collectionId || '';
      const ff = body.structuredQuery?.where?.fieldFilter;
      const targetVal = ff ? decodeDocumentFields({ v: ff.value }).v : undefined;
      const rows: unknown[] = [];
      for (const [docId, doc] of getCol(col).entries()) {
        if (!ff || doc[ff.field.fieldPath] === targetVal) {
          rows.push({ document: formatDoc(col, docId, doc) });
        }
      }
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (urlStr.startsWith(`${expectedPrefix}/`) && method === 'GET') {
      const rel = urlStr.slice(expectedPrefix.length + 1).split('?')[0];
      const [col, ...rest] = rel.split('/');
      if (rest.length === 0) {
        const documents = Array.from(getCol(col).entries()).map(([id, doc]) => formatDoc(col, id, doc));
        return new Response(JSON.stringify({ documents }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      const docId = decodeURIComponent(rest.join('/'));
      const doc = getCol(col).get(docId);
      if (!doc) {
        return new Response(JSON.stringify({ error: { code: 404, message: 'NOT_FOUND' } }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify(formatDoc(col, docId, doc)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    throw new Error(`Unexpected stubFetch call: ${method} ${urlStr}`);
  };

  return {
    stubFetch,
    seedDoc(col: string, docId: string, data: Record<string, unknown>) {
      getCol(col).set(docId, { ...data });
    },
    getDoc(col: string, docId: string) {
      return getCol(col).get(docId);
    }
  };
}

describe('Sanad Prep BD — Final Production Readiness & Publish Verification Suite', () => {
  beforeEach(() => {
    clearFirebaseJwksCacheForTests();
  });

  test('1. CSV export escapes RFC-4180 quotes and neutralizes spreadsheet formula injection', () => {
    assert.equal(escapeCsvCell('=HYPERLINK("http://evil.example","Click")'), `"'=HYPERLINK(""http://evil.example"",""Click"")"`);
    assert.equal(escapeCsvCell('   +SUM(A1:A10)'), `"'   +SUM(A1:A10)"`);
    assert.equal(escapeCsvCell('-1+1'), `"'-1+1"`);
    assert.equal(escapeCsvCell('@IMPORTXML()'), `"'@IMPORTXML()"`);
    assert.equal(escapeCsvCell('\tcmd|calc'), `"'\tcmd|calc"`);
    assert.equal(escapeCsvCell('Advocate "Rahim" Mia'), `"Advocate ""Rahim"" Mia"`);

    const mockResults: ExamResult[] = [
      {
        id: 'res_1',
        attemptId: 'att_1',
        examId: 'exam_1',
        examTitleBn: 'মডেল টেস্ট',
        examTitleEn: '=CMD("calc"), Model Test "01"',
        examType: 'full_mock',
        userId: 'u_1',
        studentName: '=1+1',
        totalQuestions: 100,
        correctAnswersCount: 80,
        incorrectAnswersCount: 10,
        unansweredCount: 10,
        positiveMarks: 80,
        negativeMarks: 2.5,
        finalScore: 77.5,
        percentage: 77.5,
        passed: true,
        timeSpentSeconds: 2400,
        submittedAt: '2026-11-20T10:00:00.000Z',
        subjectWiseScores: {},
        answers: {},
        questions: []
      }
    ];

    const csv = buildExamResultsCsv(mockResults);
    const lines = csv.split('\n');
    assert.equal(lines.length, 2);
    assert.ok(lines[1].includes(`"'=1+1"`));
    assert.ok(lines[1].includes(`"'=CMD(""calc""), Model Test ""01"""`));
  });

  test('2. Worker /api/admin/users/update honors authoritative Firestore package pricing & metadata', async () => {
    const db = new SqliteD1Adapter();
    await db.exec(fs.readFileSync(path.resolve('worker/migrations/0001_initial_edge_state.sql'), 'utf-8'));
    await db.exec(fs.readFileSync(path.resolve('worker/migrations/0002_question_bank_cache.sql'), 'utf-8'));
    await db.exec(fs.readFileSync(path.resolve('worker/migrations/0003_keyless_edge_collections.sql'), 'utf-8'));

    const authKeys = await generateRs256Keypair('kid_prod_ready');
    const stub = createPackageLookupStub();
    const fixedNowMs = Date.UTC(2026, 10, 22, 12, 0, 0);

    stub.seedDoc('users', 'student_custom_price', {
      uid: 'student_custom_price',
      name: 'Karim Hasan',
      email: 'karim@example.com',
      phone: '01700001111',
      role: 'student',
      subscriptionStatus: 'free',
      createdAt: '2026-10-01T00:00:00.000Z'
    });

    // Simulate Owner having updated pkg_monthly price & localized title in Firestore
    stub.seedDoc('packages', 'pkg_monthly', {
      id: 'pkg_monthly',
      nameBn: 'মাসিক প্রিমিয়াম প্যাক (আপডেটেড)',
      nameEn: 'Monthly Premium Pass (Live Price)',
      price: 199,
      validityType: 'days',
      durationDays: 30,
      isActive: true
    });

    const env: WorkerEnv = {
      DB: db,
      FIREBASE_PROJECT_ID: EXPECTED_FIREBASE_PROJECT_ID,
      FIREBASE_DATABASE_ID: EXPECTED_FIREBASE_DATABASE_ID,
      ENVIRONMENT: 'production'
    };

    const handler = createWorkerHandler({
      fetchImpl: stub.stubFetch,
      jwksFetcher: async () => ({ keys: [authKeys.jwk], maxAgeSeconds: 300 }),
      nowMsFn: () => fixedNowMs
    });

    const ownerToken = await signJwt(authKeys.privateKey, authKeys.kid, {
      aud: EXPECTED_FIREBASE_PROJECT_ID,
      iss: `https://securetoken.google.com/${EXPECTED_FIREBASE_PROJECT_ID}`,
      sub: OWNER_ADMIN_UID,
      user_id: OWNER_ADMIN_UID,
      email: OWNER_ADMIN_EMAIL,
      email_verified: true,
      iat: Math.floor(fixedNowMs / 1000) - 10,
      exp: Math.floor(fixedNowMs / 1000) + 3600
    });

    const updateRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/admin/users/update', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          userId: 'student_custom_price',
          name: 'Karim Hasan',
          phone: '01700001111',
          role: 'student',
          subscriptionStatus: 'pro',
          packageId: 'pkg_monthly',
          expiresAt: '2026-12-25T18:00:00.000Z'
        })
      }),
      env
    );

    assert.equal(updateRes.status, 200);
    const updateBody = (await updateRes.json()) as {
      success: boolean;
      subscription: { pricePaid: number; packageNameEn: string; packageNameBn: string };
    };
    assert.equal(updateBody.success, true);
    assert.equal(updateBody.subscription.pricePaid, 199);
    assert.equal(updateBody.subscription.packageNameEn, 'Monthly Premium Pass (Live Price)');
    assert.equal(updateBody.subscription.packageNameBn, 'মাসিক প্রিমিয়াম প্যাক (আপডেটেড)');
  });

  test('3. Cloudflare production config, D1 migrations, dynamic settings, logout hygiene & zero active Gemini calls', () => {
    const prodConfigRaw = fs.readFileSync(path.resolve('wrangler.production.jsonc'), 'utf-8');
    const prodConfig = JSON.parse(prodConfigRaw) as {
      name: string;
      main: string;
      assets: { directory: string; binding: string; not_found_handling: string; run_worker_first: string[] };
      d1_databases: Array<{ binding: string; database_name: string; database_id: string; migrations_dir: string }>;
      vars: Record<string, string>;
    };

    assert.equal(prodConfig.name, 's--khayrul-alam');
    assert.equal(prodConfig.main, './worker/index.ts');
    assert.equal(prodConfig.assets.directory, './dist');
    assert.equal(prodConfig.assets.binding, 'ASSETS');
    assert.equal(prodConfig.assets.not_found_handling, 'single-page-application');
    assert.deepEqual(prodConfig.assets.run_worker_first, ['/api/*', '/health']);
    assert.equal(prodConfig.d1_databases[0].binding, 'DB');
    assert.equal(prodConfig.d1_databases[0].database_name, 'sanad-prep-edge-db-production');
    assert.equal(prodConfig.d1_databases[0].database_id, '81bce5d2-fb29-4d2a-9542-cc3b7465fa39');
    assert.equal(prodConfig.vars.ENVIRONMENT, 'production');
    assert.equal(prodConfig.vars.FIREBASE_PROJECT_ID, EXPECTED_FIREBASE_PROJECT_ID);
    assert.equal(prodConfig.vars.FIREBASE_DATABASE_ID, EXPECTED_FIREBASE_DATABASE_ID);
    assert.equal(prodConfigRaw.includes('PRIVATE KEY'), false);
    assert.equal(prodConfigRaw.includes('FIREBASE_SERVICE_ACCOUNT_JSON'), false);

    // Frontend hygiene & UI checks
    const adminPanelSrc = fs.readFileSync(path.resolve('src/components/AdminPanel.tsx'), 'utf-8');
    assert.equal(adminPanelSrc.includes('buildExamResultsCsv'), true);
    assert.equal(adminPanelSrc.includes('simulateConcurrentLogin'), false);

    const plansSrc = fs.readFileSync(path.resolve('src/components/SubscriptionPlansSection.tsx'), 'utf-8');
    assert.equal(plansSrc.includes('Support: 01712607777'), false);
    assert.equal(plansSrc.includes('paymentSettings.bkashNumber'), true);

    const appCtxSrc = fs.readFileSync(path.resolve('src/context/AppContext.tsx'), 'utf-8');
    const removeAnsweredMatches = appCtxSrc.match(/localStorage\.removeItem\(LOCAL_STORAGE_KEY_ANSWERED_QUESTIONS\)/g) || [];
    assert.equal(removeAnsweredMatches.length >= 2, true);

    // Verify Gemini AI calls stay completely disabled in production code
    const geminiServiceSrc = fs.readFileSync(path.resolve('server/services/geminiService.ts'), 'utf-8');
    assert.equal(geminiServiceSrc.includes('GEMINI_DISABLED'), true);
    assert.equal(geminiServiceSrc.includes('@google/genai'), false);
  });

  test('4. ensureSanitizedQuestionsSyncedD1 preserves question_keys_cache across sanitized question refreshes', async () => {
    const db = new SqliteD1Adapter();
    await db.exec(fs.readFileSync(path.resolve('worker/migrations/0001_initial_edge_state.sql'), 'utf-8'));
    await db.exec(fs.readFileSync(path.resolve('worker/migrations/0002_question_bank_cache.sql'), 'utf-8'));
    await db.exec(fs.readFileSync(path.resolve('worker/migrations/0003_keyless_edge_collections.sql'), 'utf-8'));

    const fixedNowMs = Date.UTC(2026, 10, 23, 8, 0, 0);
    const stub = createPackageLookupStub();
    stub.seedDoc('config', 'questionBankMeta', {
      version: 2,
      updatedAt: '2026-11-23T08:00:00.000Z'
    });
    stub.seedDoc('questions', 'q_preserve_key_1', {
      subjectId: 'cpc',
      questionBn: 'সংরক্ষিত প্রশ্ন ১',
      questionEn: 'Preserved Question 1',
      optionsBn: ['ক', 'খ', 'গ', 'ঘ'],
      optionsEn: ['A', 'B', 'C', 'D'],
      legalReference: 'CPC s. 9',
      difficulty: 'medium',
      status: 'published',
      isDemoSample: true,
      createdAt: '2026-11-23T07:00:00.000Z',
      updatedAt: '2026-11-23T08:00:00.000Z'
    });

    // Pre-warm authoritative grading key in D1
    await db
      .prepare(
        `INSERT INTO question_keys_cache (
           question_id, correct_option_index, explanation_bn, explanation_en,
           legal_reference, updated_at, synced_version
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
      )
      .bind('q_preserve_key_1', 2, 'ব্যাখ্যা', 'Explanation', 'CPC s. 9', '2026-11-23T08:00:00.000Z', '2')
      .run();

    const ownerClient = new FirestoreRestClient({
      projectId: EXPECTED_FIREBASE_PROJECT_ID,
      databaseId: EXPECTED_FIREBASE_DATABASE_ID,
      environment: 'production',
      bearerToken: 'fake-owner-id-token',
      fetchImpl: stub.stubFetch,
      nowMsFn: () => fixedNowMs
    });

    const syncResult = await ensureSanitizedQuestionsSyncedD1(db, ownerClient, {
      ttlMs: 60_000,
      nowMs: fixedNowMs,
      isOwner: true
    });
    assert.equal(syncResult.fromCache, false);

    const bankRow = await db
      .prepare(`SELECT id FROM question_bank_cache WHERE id = ?1`)
      .bind('q_preserve_key_1')
      .first<{ id: string }>();
    assert.equal(bankRow?.id, 'q_preserve_key_1');

    const keyRow = await db
      .prepare(`SELECT question_id, correct_option_index FROM question_keys_cache WHERE question_id = ?1`)
      .bind('q_preserve_key_1')
      .first<{ question_id: string; correct_option_index: number }>();
    assert.equal(keyRow?.question_id, 'q_preserve_key_1');
    assert.equal(keyRow?.correct_option_index, 2);
  });

  test('5. Worker /api/exams/submit fails closed (503 QUESTION_KEYS_UNAVAILABLE) if answer keys are missing/unreadable', async () => {
    const db = new SqliteD1Adapter();
    await db.exec(fs.readFileSync(path.resolve('worker/migrations/0001_initial_edge_state.sql'), 'utf-8'));
    await db.exec(fs.readFileSync(path.resolve('worker/migrations/0002_question_bank_cache.sql'), 'utf-8'));
    await db.exec(fs.readFileSync(path.resolve('worker/migrations/0003_keyless_edge_collections.sql'), 'utf-8'));

    const authKeys = await generateRs256Keypair('kid_fail_closed_submit');
    const stub = createPackageLookupStub();
    const fixedNowMs = Date.UTC(2026, 10, 23, 9, 0, 0);

    stub.seedDoc('users', 'student_key_missing', {
      uid: 'student_key_missing',
      name: 'Farhana Akter',
      email: 'farhana@example.com',
      role: 'student',
      subscriptionStatus: 'free',
      createdAt: '2026-10-01T00:00:00.000Z'
    });
    stub.seedDoc('exams', 'exam_free_fail_closed', {
      titleBn: 'ফ্রি টেস্ট',
      titleEn: 'Free Fail-Closed Test',
      type: 'free_demo',
      isPaid: false,
      isActive: true,
      durationMinutes: 15,
      totalQuestions: 1,
      questionIds: ['q_missing_key_1'],
      passMarkPercentage: 50,
      positiveMarkRatio: 1,
      negativeMarkRatio: 0.25
    });

    // Sanitized question cached in D1 WITHOUT any answer key in question_keys_cache
    await db
      .prepare(
        `INSERT INTO question_bank_cache (
           id, subject_id, topic_id, question_bn, question_en,
           options_bn_json, options_en_json, legal_reference, difficulty,
           status, is_demo_sample, created_at, updated_at, synced_version
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`
      )
      .bind(
        'q_missing_key_1',
        'cpc',
        '',
        'নমুনা প্রশ্ন',
        'Sample Question',
        JSON.stringify(['ক', 'খ', 'গ', 'ঘ']),
        JSON.stringify(['A', 'B', 'C', 'D']),
        'CPC',
        'medium',
        'published',
        1,
        '2026-11-23T08:00:00.000Z',
        '2026-11-23T08:00:00.000Z',
        '1'
      )
      .run();

    await insertExamAttemptD1(db, {
      id: 'att_missing_key_1',
      examId: 'exam_free_fail_closed',
      userId: 'student_key_missing',
      studentName: 'Farhana Akter',
      startTime: new Date(fixedNowMs - 60_000).toISOString(),
      deadlineTime: new Date(fixedNowMs + 840_000).toISOString(),
      lastSavedAt: new Date(fixedNowMs - 10_000).toISOString(),
      status: 'in_progress',
      answers: {},
      flaggedQuestionIds: [],
      currentQuestionIndex: 0,
      resolvedQuestionIds: ['q_missing_key_1']
    });

    const wrappedFetch: typeof fetch = async (input, init) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (urlStr.endsWith(':batchGet')) {
        return new Response(
          JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'Missing permissions.' } }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return stub.stubFetch(input, init);
    };

    const env: WorkerEnv = {
      DB: db,
      FIREBASE_PROJECT_ID: EXPECTED_FIREBASE_PROJECT_ID,
      FIREBASE_DATABASE_ID: EXPECTED_FIREBASE_DATABASE_ID,
      ENVIRONMENT: 'production'
    };
    const handler = createWorkerHandler({
      fetchImpl: wrappedFetch,
      jwksFetcher: async () => ({ keys: [authKeys.jwk], maxAgeSeconds: 300 }),
      nowMsFn: () => fixedNowMs
    });

    const studentToken = await signJwt(authKeys.privateKey, authKeys.kid, {
      aud: EXPECTED_FIREBASE_PROJECT_ID,
      iss: `https://securetoken.google.com/${EXPECTED_FIREBASE_PROJECT_ID}`,
      sub: 'student_key_missing',
      user_id: 'student_key_missing',
      email: 'farhana@example.com',
      email_verified: true,
      iat: Math.floor(fixedNowMs / 1000) - 10,
      exp: Math.floor(fixedNowMs / 1000) + 3600
    });

    const sessRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/auth/session', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${studentToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ deviceInfo: 'TestBrowser/1.0' })
      }),
      env
    );
    assert.equal(sessRes.status, 200);
    const { sessionId } = (await sessRes.json()) as { sessionId: string };

    const submitRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/exams/submit', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${studentToken}`,
          'x-session-id': sessionId,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          attemptId: 'att_missing_key_1',
          answers: { q_missing_key_1: 0 }
        })
      }),
      env
    );

    assert.equal(submitRes.status, 503);
    const submitBody = (await submitRes.json()) as { error: string };
    assert.equal(submitBody.error, 'QUESTION_KEYS_UNAVAILABLE');
  });

  test('6. checkUserHasActiveSubscriptionKeyless denies & reconciles stale D1 on Firestore revocation while preserving outage fallback', async () => {
    const db = new SqliteD1Adapter();
    await db.exec(fs.readFileSync(path.resolve('worker/migrations/0001_initial_edge_state.sql'), 'utf-8'));
    await db.exec(fs.readFileSync(path.resolve('worker/migrations/0002_question_bank_cache.sql'), 'utf-8'));
    await db.exec(fs.readFileSync(path.resolve('worker/migrations/0003_keyless_edge_collections.sql'), 'utf-8'));

    const fixedNowMs = Date.UTC(2026, 10, 23, 10, 0, 0);
    const futureIso = new Date(fixedNowMs + 10 * 86_400_000).toISOString();

    await upsertSubscriptionD1(
      db,
      {
        id: 'sub_revoked_1',
        userId: 'uid_revoked_user',
        studentName: 'Revoked User',
        studentPhone: '01700000001',
        packageId: 'pkg_monthly',
        packageNameBn: 'মাসিক',
        packageNameEn: 'Monthly',
        pricePaid: 199,
        paymentRequestId: 'pay_revoked_1',
        paymentMethod: 'bKash',
        transactionId: 'TRX_REVOKED_1',
        activatedAt: new Date(fixedNowMs - 86_400_000).toISOString(),
        expiresAt: futureIso,
        validityType: 'days',
        status: 'active',
        createdAt: new Date(fixedNowMs - 86_400_000).toISOString()
      },
      true
    );

    // Scenario A: Firestore is healthy and reports free user / no active subscription -> must revoke D1 and deny
    const healthyStub = createPackageLookupStub();
    healthyStub.seedDoc('users', 'uid_revoked_user', {
      uid: 'uid_revoked_user',
      name: 'Revoked User',
      role: 'student',
      subscriptionStatus: 'free',
      createdAt: '2026-10-01T00:00:00.000Z'
    });
    const healthyClient = new FirestoreRestClient({
      projectId: EXPECTED_FIREBASE_PROJECT_ID,
      databaseId: EXPECTED_FIREBASE_DATABASE_ID,
      environment: 'production',
      bearerToken: 'fake-student-token',
      fetchImpl: healthyStub.stubFetch,
      nowMsFn: () => fixedNowMs
    });

    const revokedResult = await checkUserHasActiveSubscriptionKeyless(
      db,
      healthyClient,
      'uid_revoked_user',
      fixedNowMs
    );
    assert.equal(revokedResult.active, false);

    const reconciledRow = await db
      .prepare(`SELECT status FROM edge_subscriptions WHERE id = ?1`)
      .bind('sub_revoked_1')
      .first<{ status: string }>();
    assert.equal(reconciledRow?.status, 'cancelled');

    // Scenario B: Genuine Firestore 503 outage -> D1 active edge subscription fallback still works
    await upsertSubscriptionD1(
      db,
      {
        id: 'sub_outage_1',
        userId: 'uid_outage_user',
        studentName: 'Outage User',
        studentPhone: '01700000002',
        packageId: 'pkg_monthly',
        packageNameBn: 'মাসিক',
        packageNameEn: 'Monthly',
        pricePaid: 199,
        paymentRequestId: 'pay_outage_1',
        paymentMethod: 'Nagad',
        transactionId: 'TRX_OUTAGE_1',
        activatedAt: new Date(fixedNowMs - 86_400_000).toISOString(),
        expiresAt: futureIso,
        validityType: 'days',
        status: 'active',
        createdAt: new Date(fixedNowMs - 86_400_000).toISOString()
      },
      true
    );

    const outageClient = new FirestoreRestClient({
      projectId: EXPECTED_FIREBASE_PROJECT_ID,
      databaseId: EXPECTED_FIREBASE_DATABASE_ID,
      environment: 'production',
      bearerToken: 'fake-student-token',
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { code: 503, message: 'UNAVAILABLE' } }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        }),
      nowMsFn: () => fixedNowMs
    });

    const outageResult = await checkUserHasActiveSubscriptionKeyless(
      db,
      outageClient,
      'uid_outage_user',
      fixedNowMs
    );
    assert.equal(outageResult.active, true);
    assert.equal(outageResult.reason, 'D1_EDGE_FALLBACK');
    assert.equal(outageResult.activeSubscription?.id, 'sub_outage_1');
  });
});
