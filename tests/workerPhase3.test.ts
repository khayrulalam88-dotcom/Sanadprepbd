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
  clearServiceAccountTokenCacheForTests,
  decodeDocumentFields,
  encodeDocumentFields
} from '../worker/firestoreRest.ts';
import { createWorkerHandler } from '../worker/index.ts';
import { INITIAL_PACKAGES, INITIAL_EXAM_DATE_CONFIG } from '../src/data/initialPackages.ts';

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
          meta: {
            changes: Number(info.changes),
            last_row_id: Number(info.lastInsertRowid)
          }
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

function createPhase3FirestoreStub(serviceAccountEmail: string) {
  const expectedPrefix = `https://firestore.googleapis.com/v1/projects/${EXPECTED_FIREBASE_PROJECT_ID}/databases/${EXPECTED_FIREBASE_DATABASE_ID}/documents`;
  const collections = new Map<string, Map<string, Record<string, unknown>>>();
  const rawEncodedFields = new Map<string, Map<string, Record<string, unknown>>>();
  let txCounter = 0;
  let firestoreHttpCalls = 0;

  const getCol = (col: string) => {
    let map = collections.get(col);
    if (!map) {
      map = new Map();
      collections.set(col, map);
    }
    return map;
  };

  const getRawCol = (col: string) => {
    let map = rawEncodedFields.get(col);
    if (!map) {
      map = new Map();
      rawEncodedFields.set(col, map);
    }
    return map;
  };

  const setDoc = (col: string, id: string, data: Record<string, unknown>) => {
    getCol(col).set(id, { ...data });
    getRawCol(col).set(id, encodeDocumentFields(data) as Record<string, unknown>);
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method || 'GET').toUpperCase();

    if (url === 'https://oauth2.googleapis.com/token') {
      return new Response(
        JSON.stringify({ access_token: 'mock_phase3_access_token', expires_in: 3600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    assert.ok(url.startsWith(expectedPrefix), `Unexpected Firestore URL: ${url}`);
    firestoreHttpCalls++;
    const authHeader = new Headers(init?.headers).get('authorization');
    assert.equal(authHeader, 'Bearer mock_phase3_access_token');

    const restPath = url.slice(expectedPrefix.length);

    if (restPath === ':beginTransaction' && method === 'POST') {
      txCounter++;
      return new Response(JSON.stringify({ transaction: `tx_${txCounter}` }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (restPath === ':rollback' && method === 'POST') {
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (restPath === ':commit' && method === 'POST') {
      const parsed = JSON.parse(String(init?.body || '{}')) as {
        writes?: Array<{
          update?: { name: string; fields?: Record<string, any> };
          delete?: string;
          updateMask?: { fieldPaths?: string[] };
          currentDocument?: { exists?: boolean };
        }>;
      };

      for (const write of parsed.writes || []) {
        if (write.delete) {
          const [col, rawId] = write.delete.split('/documents/')[1].split('/');
          const id = decodeURIComponent(rawId);
          getCol(col).delete(id);
          getRawCol(col).delete(id);
          continue;
        }
        if (write.update) {
          const [col, rawId] = write.update.name.split('/documents/')[1].split('/');
          const docId = decodeURIComponent(rawId);
          const colMap = getCol(col);
          const rawMap = getRawCol(col);
          const existing = colMap.get(docId);
          const existingRaw = rawMap.get(docId);

          if (write.currentDocument?.exists === false && existing) {
            return new Response(
              JSON.stringify({ error: { code: 409, status: 'ALREADY_EXISTS', message: 'Doc already exists' } }),
              { status: 409, headers: { 'Content-Type': 'application/json' } }
            );
          }
          if (write.currentDocument?.exists === true && !existing) {
            return new Response(
              JSON.stringify({ error: { code: 404, status: 'NOT_FOUND', message: 'Doc not found' } }),
              { status: 404, headers: { 'Content-Type': 'application/json' } }
            );
          }

          const rawFields = write.update.fields || {};
          const decoded = decodeDocumentFields(rawFields);
          if (write.updateMask?.fieldPaths && existing) {
            const merged = { ...existing };
            const mergedRaw = { ...(existingRaw || {}) };
            for (const fp of write.updateMask.fieldPaths) {
              merged[fp] = decoded[fp];
              mergedRaw[fp] = rawFields[fp];
            }
            colMap.set(docId, merged);
            rawMap.set(docId, mergedRaw);
          } else {
            colMap.set(docId, decoded);
            rawMap.set(docId, rawFields);
          }
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
        const [, rel] = fullName.split('/documents/');
        const [col, rawId] = rel.split('/');
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
      const parsed = JSON.parse(String(init?.body || '{}')) as {
        structuredQuery?: {
          from?: Array<{ collectionId: string }>;
          where?: {
            fieldFilter?: { field: { fieldPath: string }; op: string; value: any };
            compositeFilter?: {
              filters: Array<{ fieldFilter: { field: { fieldPath: string }; op: string; value: any } }>;
            };
          };
          limit?: number;
        };
      };
      const col = parsed.structuredQuery?.from?.[0]?.collectionId || '';
      let rows = Array.from(getCol(col).entries()).map(([id, data]) => ({ id, data }));

      const filterList = parsed.structuredQuery?.where?.compositeFilter
        ? parsed.structuredQuery.where.compositeFilter.filters.map(f => f.fieldFilter)
        : parsed.structuredQuery?.where?.fieldFilter
        ? [parsed.structuredQuery.where.fieldFilter]
        : [];

      for (const ff of filterList) {
        const decodedVal = decodeDocumentFields({ v: ff.value }).v;
        if (ff.op === 'EQUAL') {
          rows = rows.filter(r => r.data[ff.field.fieldPath] === decodedVal);
        }
      }

      if (parsed.structuredQuery?.limit !== undefined) {
        rows = rows.slice(0, parsed.structuredQuery.limit);
      }

      const payload = rows.map(r => ({
        document: {
          name: `projects/${EXPECTED_FIREBASE_PROJECT_ID}/databases/${EXPECTED_FIREBASE_DATABASE_ID}/documents/${col}/${r.id}`,
          fields: encodeDocumentFields(r.data)
        }
      }));
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (method === 'GET' && restPath.startsWith('/')) {
      const [pathWithoutQuery, qs] = restPath.split('?');
      const segments = pathWithoutQuery.slice(1).split('/').filter(Boolean);

      if (segments.length === 1) {
        const col = segments[0];
        const params = new URLSearchParams(qs || '');
        const pageSize = Number(params.get('pageSize') || '500');
        const startOffset = Number(params.get('pageToken') || '0');
        const all = Array.from(getCol(col).entries());
        const slice = all.slice(startOffset, startOffset + pageSize);
        const nextOffset = startOffset + slice.length;
        return new Response(
          JSON.stringify({
            documents: slice.map(([id, data]) => ({
              name: `projects/${EXPECTED_FIREBASE_PROJECT_ID}/databases/${EXPECTED_FIREBASE_DATABASE_ID}/documents/${col}/${id}`,
              fields: encodeDocumentFields(data)
            })),
            ...(nextOffset < all.length ? { nextPageToken: String(nextOffset) } : {})
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (segments.length === 2) {
        const [col, rawDocId] = segments;
        const docId = decodeURIComponent(rawDocId);
        const found = getCol(col).get(docId);
        if (!found) {
          return new Response(JSON.stringify({ error: { code: 404, status: 'NOT_FOUND' } }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        return new Response(
          JSON.stringify({
            name: `projects/${EXPECTED_FIREBASE_PROJECT_ID}/databases/${EXPECTED_FIREBASE_DATABASE_ID}/documents/${col}/${docId}`,
            fields: encodeDocumentFields(found)
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    throw new Error(`Unhandled mock Firestore call (${serviceAccountEmail}): ${method} ${url}`);
  };

  return {
    fetchImpl,
    setDoc,
    getCol,
    getRawCol,
    getCallCount: () => firestoreHttpCalls
  };
}

function seedPackagesAndConfig(stub: ReturnType<typeof createPhase3FirestoreStub>) {
  for (const pkg of INITIAL_PACKAGES) {
    stub.setDoc('packages', pkg.id, { ...pkg });
  }
  stub.setDoc('config', 'examDate', { ...INITIAL_EXAM_DATE_CONFIG });
  stub.setDoc('config', 'questionBankVersion', {
    version: 1,
    versionToken: 'v_phase3_1',
    updatedAt: '2026-11-01T00:00:00.000Z'
  });
}

function seedQuestions100(stub: ReturnType<typeof createPhase3FirestoreStub>): string[] {
  const subjects = ['sub_cpc', 'sub_crpc', 'sub_penal', 'sub_evidence', 'sub_sra', 'sub_limitation', 'sub_bar_ethics'];
  const qIds: string[] = [];
  for (let i = 1; i <= 100; i++) {
    const qId = `q_mock_${String(i).padStart(3, '0')}`;
    const subjectId = subjects[(i - 1) % subjects.length];
    qIds.push(qId);
    stub.setDoc('questions', qId, {
      id: qId,
      subjectId,
      topicId: `topic_${subjectId}_1`,
      questionBn: `প্রশ্ন নম্বর ${i}`,
      questionEn: `Sample Bar Council Question ${i}`,
      optionsBn: ['ক', 'খ', 'গ', 'ঘ'],
      optionsEn: ['A', 'B', 'C', 'D'],
      legalReference: `Sec ${i}`,
      difficulty: 'medium',
      status: 'published',
      isDemoSample: i <= 5,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z'
    });
    stub.setDoc('questionKeys', qId, {
      correctOptionIndex: i % 4,
      explanationBn: `ব্যাখ্যা ${i}`,
      explanationEn: `Explanation ${i}`,
      legalReference: `Sec ${i}`,
      updatedAt: '2026-10-01T00:00:00.000Z'
    });
  }
  return qIds;
}

describe('Sanad Prep BD — Cloudflare Worker Phase 3 Test Suite', async () => {
  const keyPair = await generateRs256Keypair('kid_phase3_v1');
  const saKey = await generateRs256Keypair('sa_phase3_1');
  const saJson = JSON.stringify({
    type: 'service_account',
    project_id: EXPECTED_FIREBASE_PROJECT_ID,
    client_email: 'sanad-worker-sa@galvanic-aviary-tzp2g.iam.gserviceaccount.com',
    private_key: saKey.pkcs8Pem
  });

  const baseNowMs = new Date('2026-11-16T10:00:00.000Z').getTime();
  const baseNowSec = Math.floor(baseNowMs / 1000);

  const makeToken = (
    uid: string,
    email: string,
    name: string,
    emailVerified = true,
    atMs: number = baseNowMs
  ) => {
    const atSec = Math.floor(atMs / 1000);
    return signJwt(keyPair.privateKey, keyPair.kid, {
      aud: EXPECTED_FIREBASE_PROJECT_ID,
      iss: `https://securetoken.google.com/${EXPECTED_FIREBASE_PROJECT_ID}`,
      sub: uid,
      email,
      email_verified: emailVerified,
      name,
      iat: atSec - 30,
      exp: atSec + 7200
    });
  };

  beforeEach(() => {
    clearFirebaseJwksCacheForTests();
    clearServiceAccountTokenCacheForTests();
  });

  async function loginStudent(
    handler: ReturnType<typeof createWorkerHandler>,
    env: WorkerEnv,
    token: string,
    name: string
  ): Promise<string> {
    const res = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/auth/session', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ userName: name, deviceInfo: 'Chrome Test' })
      }),
      env
    );
    assert.equal(res.status, 200);
    return ((await res.json()) as { sessionId: string }).sessionId;
  }

  test('1. Payment creation: authoritative pricing, tampered amount ignored, duplicate TrxID 409, /api/payments/my isolation, rate limit', async () => {
    const db = await createMigratedTestD1();
    const stub = createPhase3FirestoreStub('sanad-worker-sa@galvanic-aviary-tzp2g.iam.gserviceaccount.com');
    seedPackagesAndConfig(stub);

    const s1Token = await makeToken('student_1', 's1@example.com', 'Student One');
    const s2Token = await makeToken('student_2', 's2@example.com', 'Student Two');

    const handler = createWorkerHandler({
      jwksFetcher: async () => ({ keys: [keyPair.jwk], maxAgeSeconds: 3600 }),
      fetchImpl: stub.fetchImpl,
      nowMsFn: () => baseNowMs,
      rateLimitOverrides: { windowMs: 60_000, globalMax: 200, routeMax: { payments_create: 3 } }
    });
    const env: WorkerEnv = {
      DB: db,
      ENVIRONMENT: 'production',
      FIREBASE_PROJECT_ID: EXPECTED_FIREBASE_PROJECT_ID,
      FIREBASE_DATABASE_ID: EXPECTED_FIREBASE_DATABASE_ID,
      FIREBASE_SERVICE_ACCOUNT_JSON: saJson
    };

    const s1Sess = await loginStudent(handler, env, s1Token, 'Student One');
    const s2Sess = await loginStudent(handler, env, s2Token, 'Student Two');

    // Attempt to tamper price=1, userId='student_2', status='approved' -> Worker MUST force ৳999 & uid='student_1' & 'pending'
    const createRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/payments/create', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${s1Token}`,
          'X-Session-Id': s1Sess,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          method: 'bKash',
          senderNumber: '01711112222',
          transactionId: ' bkash-trx-999a ',
          packageId: 'pkg_long_course',
          amount: 1,
          price: 1,
          userId: 'student_2',
          status: 'approved'
        })
      }),
      env
    );
    assert.equal(createRes.status, 200);
    const createdJson = (await createRes.json()) as {
      success: boolean;
      paymentRequest: { id: string; userId: string; amount: number; status: string; transactionId: string };
    };
    assert.equal(createdJson.paymentRequest.id, 'trx_BKASHTRX999A');
    assert.equal(createdJson.paymentRequest.userId, 'student_1');
    assert.equal(createdJson.paymentRequest.amount, 999);
    assert.equal(createdJson.paymentRequest.status, 'pending');

    // Duplicate TrxID from another student blocked atomically with 409 DUPLICATE_TRX_ID
    const dupRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/payments/create', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${s2Token}`,
          'X-Session-Id': s2Sess,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          method: 'Nagad',
          senderNumber: '01811112222',
          transactionId: 'BKASHTRX999A',
          packageId: 'pkg_monthly'
        })
      }),
      env
    );
    assert.equal(dupRes.status, 409);
    assert.equal(((await dupRes.json()) as { error: string }).error, 'DUPLICATE_TRX_ID');

    // Exam Pass uses authoritative examDate config price (650)
    const examPassRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/payments/create', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${s1Token}`,
          'X-Session-Id': s1Sess,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          method: 'Nagad',
          senderNumber: '01711112222',
          transactionId: 'EXAMPASS888',
          packageId: 'pkg_exam_pass'
        })
      }),
      env
    );
    assert.equal(examPassRes.status, 200);
    assert.equal(((await examPassRes.json()) as { paymentRequest: { amount: number } }).paymentRequest.amount, 650);

    // /api/payments/my isolates strictly to caller UID
    const myS1 = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/payments/my', {
        headers: { Authorization: `Bearer ${s1Token}`, 'X-Session-Id': s1Sess }
      }),
      env
    );
    assert.equal(myS1.status, 200);
    assert.equal(((await myS1.json()) as { paymentRequests: unknown[] }).paymentRequests.length, 2);

    const myS2 = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/payments/my', {
        headers: { Authorization: `Bearer ${s2Token}`, 'X-Session-Id': s2Sess }
      }),
      env
    );
    assert.equal(((await myS2.json()) as { paymentRequests: unknown[] }).paymentRequests.length, 0);

    // Per-UID rate limit triggers 429 on 4th request for student_1 (limit=3 above)
    await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/payments/create', {
        method: 'POST',
        headers: { Authorization: `Bearer ${s1Token}`, 'X-Session-Id': s1Sess, 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'bKash', senderNumber: '01711112222', transactionId: 'MONTHLY333', packageId: 'pkg_monthly' })
      }),
      env
    );
    const rateLimited = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/payments/create', {
        method: 'POST',
        headers: { Authorization: `Bearer ${s1Token}`, 'X-Session-Id': s1Sess, 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'bKash', senderNumber: '01711112222', transactionId: 'MONTHLY444', packageId: 'pkg_monthly' })
      }),
      env
    );
    assert.equal(rateLimited.status, 429);
  });

  test('2. Owner-only payment approval/rejection, atomic subscription Timestamps, Pro 90d & Exam Pass rules, replay blocked', async () => {
    const db = await createMigratedTestD1();
    const stub = createPhase3FirestoreStub('sanad-worker-sa@galvanic-aviary-tzp2g.iam.gserviceaccount.com');
    seedPackagesAndConfig(stub);

    stub.setDoc('users', 'student_1', {
      uid: 'student_1',
      name: 'Student One',
      email: 's1@example.com',
      role: 'student',
      subscriptionStatus: 'free',
      createdAt: '2026-10-01T00:00:00.000Z'
    });
    // Secondary account claiming admin role in Firestore DB MUST still be rejected by Owner-only gate
    stub.setDoc('users', 'fake_admin_uid', {
      uid: 'fake_admin_uid',
      name: 'Fake Admin',
      email: 'fake@example.com',
      role: 'admin',
      subscriptionStatus: 'free',
      createdAt: '2026-10-01T00:00:00.000Z'
    });

    // Seed pending legacy Pro Model Test Pass (90 days) + pending Exam Pass + pending Monthly
    stub.setDoc('paymentRequests', 'trx_PROLEGACY90', {
      userId: 'student_1',
      studentName: 'Student One',
      studentPhone: '01711112222',
      method: 'bKash',
      senderNumber: '01711112222',
      transactionId: 'PROLEGACY90',
      amount: 300,
      packageId: 'pkg_pro_mock',
      packageNameBn: 'প্রো মডেল টেস্ট পাস',
      packageNameEn: 'Pro Model Test Pass (Legacy 90 Days)',
      validityType: 'days',
      durationDays: 90,
      status: 'pending',
      requestedAt: '2026-11-16T09:00:00.000Z'
    });
    stub.setDoc('paymentRequests', 'trx_REJECTME01', {
      userId: 'student_1',
      studentName: 'Student One',
      studentPhone: '01711112222',
      method: 'Nagad',
      senderNumber: '01711112222',
      transactionId: 'REJECTME01',
      amount: 150,
      packageId: 'pkg_monthly',
      packageNameBn: 'মাসিক',
      packageNameEn: 'Monthly',
      validityType: 'days',
      durationDays: 30,
      status: 'pending',
      requestedAt: '2026-11-16T09:05:00.000Z'
    });

    const studentToken = await makeToken('student_1', 's1@example.com', 'Student One');
    const fakeAdminToken = await makeToken('fake_admin_uid', 'fake@example.com', 'Fake Admin');
    const ownerToken = await makeToken(OWNER_ADMIN_UID, OWNER_ADMIN_EMAIL, 'Khayrul Alam');

    let mockNow = baseNowMs;
    const handler = createWorkerHandler({
      jwksFetcher: async () => ({ keys: [keyPair.jwk], maxAgeSeconds: 3600 }),
      fetchImpl: stub.fetchImpl,
      nowMsFn: () => mockNow
    });
    const env: WorkerEnv = {
      DB: db,
      ENVIRONMENT: 'production',
      FIREBASE_PROJECT_ID: EXPECTED_FIREBASE_PROJECT_ID,
      FIREBASE_DATABASE_ID: EXPECTED_FIREBASE_DATABASE_ID,
      FIREBASE_SERVICE_ACCOUNT_JSON: saJson
    };

    const s1Sess = await loginStudent(handler, env, studentToken, 'Student One');

    // Student & secondary admin CANNOT list admin payments or approve/reject
    const studentApproveRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/admin/payments/trx_PROLEGACY90/approve', {
        method: 'POST',
        headers: { Authorization: `Bearer ${studentToken}` }
      }),
      env
    );
    assert.equal(studentApproveRes.status, 403);

    const fakeAdminListRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/admin/payments', {
        headers: { Authorization: `Bearer ${fakeAdminToken}` }
      }),
      env
    );
    assert.equal(fakeAdminListRes.status, 403);

    // Owner approves legacy 90-day Pro Pass atomically
    const approveRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/admin/payments/trx_PROLEGACY90/approve', {
        method: 'POST',
        headers: { Authorization: `Bearer ${ownerToken}` }
      }),
      env
    );
    assert.equal(approveRes.status, 200);
    const approveJson = (await approveRes.json()) as {
      success: boolean;
      paymentRequest: { status: string; subscriptionId: string };
      subscription: { id: string; expiresAt: string; activatedAt: string; status: string };
    };
    assert.equal(approveJson.paymentRequest.status, 'approved');
    assert.equal(approveJson.subscription.status, 'active');

    // Verify 90-day duration exactly preserved
    const expMs = new Date(approveJson.subscription.expiresAt).getTime();
    const actMs = new Date(approveJson.subscription.activatedAt).getTime();
    assert.equal(Math.round((expMs - actMs) / (86400 * 1000)), 90);

    // Verify Firestore Timestamp encoding was written to subscriptions.expiresAt & users.subscriptionExpiresAt,
    // AND users merge kept email/name/createdAt intact!
    const rawUserFields = stub.getRawCol('users').get('student_1') as Record<string, Record<string, unknown>>;
    assert.ok('timestampValue' in rawUserFields.subscriptionExpiresAt, 'users.subscriptionExpiresAt must be Firestore timestamp');
    assert.equal(stub.getCol('users').get('student_1')?.email, 's1@example.com');
    assert.equal(stub.getCol('users').get('student_1')?.subscriptionStatus, 'pro');
    const rawSubFields = stub.getRawCol('subscriptions').get(approveJson.subscription.id) as Record<string, Record<string, unknown>>;
    assert.ok('timestampValue' in rawSubFields.expiresAt, 'subscriptions.expiresAt must be Firestore timestamp');

    // Replay/double-approval blocked
    const replayRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/admin/payments/trx_PROLEGACY90/approve', {
        method: 'POST',
        headers: { Authorization: `Bearer ${ownerToken}` }
      }),
      env
    );
    assert.equal(replayRes.status, 409);

    // Rejecting already approved payment blocked
    const rejectApprovedRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/admin/payments/trx_PROLEGACY90/reject', {
        method: 'POST',
        headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Test' })
      }),
      env
    );
    assert.equal(rejectApprovedRes.status, 400);

    // Reject trx_REJECTME01 -> replay reject blocked
    const rejectOk = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/admin/payments/trx_REJECTME01/reject', {
        method: 'POST',
        headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Invalid TrxID' })
      }),
      env
    );
    assert.equal(rejectOk.status, 200);
    const approveRejectedRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/admin/payments/trx_REJECTME01/approve', {
        method: 'POST',
        headers: { Authorization: `Bearer ${ownerToken}` }
      }),
      env
    );
    assert.equal(approveRejectedRes.status, 400);

    // Active subscription endpoint works for self, blocks cross-user, and expires cleanly at trusted server time
    const subActiveRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/subscriptions/active/student_1', {
        headers: { Authorization: `Bearer ${studentToken}`, 'X-Session-Id': s1Sess }
      }),
      env
    );
    assert.equal(subActiveRes.status, 200);
    const subActiveJson = (await subActiveRes.json()) as { hasActiveSubscription: boolean; daysRemaining: number };
    assert.equal(subActiveJson.hasActiveSubscription, true);
    assert.equal(subActiveJson.daysRemaining, 90);

    const otherSess = await loginStudent(handler, env, fakeAdminToken, 'Fake Admin');
    const crossUserSubRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/subscriptions/active/student_1', {
        headers: { Authorization: `Bearer ${fakeAdminToken}`, 'X-Session-Id': otherSess }
      }),
      env
    );
    assert.equal(crossUserSubRes.status, 403);

    // Advance server time 91 days -> subscription automatically reports inactive / expired!
    mockNow = baseNowMs + 91 * 86400 * 1000;
    const freshStudentToken = await makeToken('student_1', 's1@example.com', 'Student One', true, mockNow);
    const freshOwnerToken = await makeToken(OWNER_ADMIN_UID, OWNER_ADMIN_EMAIL, 'Khayrul Alam', true, mockNow);
    const subExpiredRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/subscriptions/active/student_1', {
        headers: { Authorization: `Bearer ${freshStudentToken}`, 'X-Session-Id': s1Sess }
      }),
      env
    );
    assert.equal(subExpiredRes.status, 200);
    assert.equal(((await subExpiredRes.json()) as { hasActiveSubscription: boolean }).hasActiveSubscription, false);

    const adminSubsRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/admin/subscriptions', {
        headers: { Authorization: `Bearer ${freshOwnerToken}` }
      }),
      env
    );
    assert.equal(adminSubsRes.status, 200);
    const adminSubs = ((await adminSubsRes.json()) as { subscriptions: Array<{ status: string; daysRemaining: number }> }).subscriptions;
    assert.equal(adminSubs[0].status, 'expired');
    assert.equal(adminSubs[0].daysRemaining, 0);
  });

  test('3. Mock exam engine: free vs paid gating, sanitized /start, /save-answer, /submit (+1/-0.25/0 + negative preserved + batched subrequests <= 15), double submit 400, results isolation, leaderboard', async () => {
    const db = await createMigratedTestD1();
    const stub = createPhase3FirestoreStub('sanad-worker-sa@galvanic-aviary-tzp2g.iam.gserviceaccount.com');
    seedPackagesAndConfig(stub);
    const qIds100 = seedQuestions100(stub);

    stub.setDoc('exams', 'exam_free_01', {
      titleBn: 'ফ্রি মডেল টেস্ট ১',
      titleEn: 'Free Model Test 01',
      type: 'full_mock',
      durationMinutes: 60,
      totalMarks: 100,
      passThresholdPercentage: 50,
      questionIds: qIds100,
      isPaid: false,
      isActive: true,
      negativeMarkRatio: 0.25,
      positiveMarkRatio: 1.0
    });
    stub.setDoc('exams', 'exam_paid_02', {
      titleBn: 'পেইড মডেল টেস্ট ২',
      titleEn: 'Paid Model Test 02',
      type: 'full_mock',
      durationMinutes: 60,
      totalMarks: 100,
      passThresholdPercentage: 50,
      questionIds: qIds100,
      isPaid: true,
      isActive: true,
      negativeMarkRatio: 0.25,
      positiveMarkRatio: 1.0
    });
    stub.setDoc('exams', 'exam_inactive_03', {
      titleBn: 'বন্ধ পরীক্ষা',
      titleEn: 'Inactive Test 03',
      type: 'full_mock',
      durationMinutes: 60,
      totalMarks: 100,
      questionIds: qIds100,
      isPaid: false,
      isActive: false
    });

    const freeStudentToken = await makeToken('student_free', 'free@example.com', 'Free Student');
    const proStudentToken = await makeToken('student_pro', 'pro@example.com', 'Pro Student');
    stub.setDoc('subscriptions', 'sub_pro_1', {
      userId: 'student_pro',
      packageId: 'pkg_long_course',
      status: 'active',
      activatedAt: new Date(baseNowMs - 86400 * 1000).toISOString(),
      expiresAt: new Date(baseNowMs + 300 * 86400 * 1000).toISOString(),
      createdAt: new Date(baseNowMs - 86400 * 1000).toISOString()
    });

    let currentNow = baseNowMs;
    const handler = createWorkerHandler({
      jwksFetcher: async () => ({ keys: [keyPair.jwk], maxAgeSeconds: 3600 }),
      fetchImpl: stub.fetchImpl,
      nowMsFn: () => currentNow,
      rateLimitOverrides: { windowMs: 60_000, globalMax: 500, routeMax: { exams_start: 10, exams_submit: 10 } }
    });
    const env: WorkerEnv = {
      DB: db,
      ENVIRONMENT: 'production',
      FIREBASE_PROJECT_ID: EXPECTED_FIREBASE_PROJECT_ID,
      FIREBASE_DATABASE_ID: EXPECTED_FIREBASE_DATABASE_ID,
      FIREBASE_SERVICE_ACCOUNT_JSON: saJson
    };

    const freeSess = await loginStudent(handler, env, freeStudentToken, 'Free Student');
    const proSess = await loginStudent(handler, env, proStudentToken, 'Pro Student');

    // Paid exam blocked for free student; inactive exam blocked for students
    const paidBlockedRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/exams/start', {
        method: 'POST',
        headers: { Authorization: `Bearer ${freeStudentToken}`, 'X-Session-Id': freeSess, 'Content-Type': 'application/json' },
        body: JSON.stringify({ examId: 'exam_paid_02' })
      }),
      env
    );
    assert.equal(paidBlockedRes.status, 403);
    assert.equal(((await paidBlockedRes.json()) as { error: string }).error, 'SUBSCRIPTION_REQUIRED');

    const inactiveRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/exams/start', {
        method: 'POST',
        headers: { Authorization: `Bearer ${proStudentToken}`, 'X-Session-Id': proSess, 'Content-Type': 'application/json' },
        body: JSON.stringify({ examId: 'exam_inactive_03' })
      }),
      env
    );
    assert.equal(inactiveRes.status, 403);

    // Start 100-question paid mock exam for Pro student -> verify NO answer keys leaked & 60m deadline
    const startProRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/exams/start', {
        method: 'POST',
        headers: { Authorization: `Bearer ${proStudentToken}`, 'X-Session-Id': proSess, 'Content-Type': 'application/json' },
        body: JSON.stringify({ examId: 'exam_paid_02' })
      }),
      env
    );
    assert.equal(startProRes.status, 200);
    const startProJson = (await startProRes.json()) as {
      attempt: { id: string; deadlineTime: string; startTime: string };
      questions: Array<Record<string, unknown>>;
      durationMinutes: number;
    };
    assert.equal(startProJson.durationMinutes, 60);
    assert.equal(startProJson.questions.length, 100);
    for (const q of startProJson.questions) {
      assert.equal('correctOptionIndex' in q, false, 'Must NEVER expose correctOptionIndex at exam start');
      assert.equal('explanationBn' in q, false, 'Must NEVER expose explanationBn at exam start');
      assert.equal('explanationEn' in q, false, 'Must NEVER expose explanationEn at exam start');
    }

    // Save progress -> verify other student cannot tamper save-answer
    const hijackSaveRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/exams/save-answer', {
        method: 'POST',
        headers: { Authorization: `Bearer ${freeStudentToken}`, 'X-Session-Id': freeSess, 'Content-Type': 'application/json' },
        body: JSON.stringify({ attemptId: startProJson.attempt.id, answers: { q_mock_001: 1 } })
      }),
      env
    );
    assert.equal(hijackSaveRes.status, 403);

    const saveOkRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/exams/save-answer', {
        method: 'POST',
        headers: { Authorization: `Bearer ${proStudentToken}`, 'X-Session-Id': proSess, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          attemptId: startProJson.attempt.id,
          answers: { q_mock_001: 1, q_mock_002: 2 },
          flaggedQuestionIds: ['q_mock_003'],
          currentQuestionIndex: 5
        })
      }),
      env
    );
    assert.equal(saveOkRes.status, 200);

    // Advance 10 minutes & submit Pro student with 10 correct, 4 wrong, 86 unanswered (10 - 1 = 9.0)
    // Plus attempt client-tampered finalScore=100 -> Worker MUST ignore client score!
    currentNow = baseNowMs + 600_000;
    const proAnswers: Record<string, number> = {};
    for (let i = 1; i <= 10; i++) {
      proAnswers[`q_mock_${String(i).padStart(3, '0')}`] = i % 4; // correct
    }
    for (let i = 11; i <= 14; i++) {
      proAnswers[`q_mock_${String(i).padStart(3, '0')}`] = (i + 1) % 4; // wrong
    }

    const callsBeforeSubmit = stub.getCallCount();
    const submitProRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/exams/submit', {
        method: 'POST',
        headers: { Authorization: `Bearer ${proStudentToken}`, 'X-Session-Id': proSess, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          attemptId: startProJson.attempt.id,
          answers: proAnswers,
          finalScore: 100,
          passed: true
        })
      }),
      env
    );
    const submitSubrequests = stub.getCallCount() - callsBeforeSubmit;
    assert.ok(
      submitSubrequests <= 15,
      `100-question /api/exams/submit must stay well under Cloudflare 50 subrequest limit (used ${submitSubrequests})`
    );
    assert.equal(submitProRes.status, 200);

    const submitProJson = (await submitProRes.json()) as {
      result: {
        finalScore: number;
        correctAnswersCount: number;
        incorrectAnswersCount: number;
        unansweredCount: number;
        timeSpentSeconds: number;
        questions: Array<{ correctOptionIndex?: number; explanationBn?: string }>;
      };
      leaderboardEntry: { score: number; userId: string };
    };
    assert.equal(submitProJson.result.correctAnswersCount, 10);
    assert.equal(submitProJson.result.incorrectAnswersCount, 4);
    assert.equal(submitProJson.result.unansweredCount, 86);
    assert.equal(submitProJson.result.finalScore, 9);
    assert.equal(submitProJson.result.timeSpentSeconds, 600);
    // Keys & explanations revealed ONLY post-submission
    assert.equal(submitProJson.result.questions[0].correctOptionIndex, 1);
    assert.equal(submitProJson.result.questions[0].explanationBn, 'ব্যাখ্যা 1');

    // Double submission blocked (400 ALREADY_SUBMITTED)
    const doubleSubmitRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/exams/submit', {
        method: 'POST',
        headers: { Authorization: `Bearer ${proStudentToken}`, 'X-Session-Id': proSess, 'Content-Type': 'application/json' },
        body: JSON.stringify({ attemptId: startProJson.attempt.id, answers: proAnswers })
      }),
      env
    );
    assert.equal(doubleSubmitRes.status, 400);

    // Free student takes exam_free_01 and gets 0 correct, 5 wrong -> preserves negative score (-1.25)!
    const startFreeRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/exams/start', {
        method: 'POST',
        headers: { Authorization: `Bearer ${freeStudentToken}`, 'X-Session-Id': freeSess, 'Content-Type': 'application/json' },
        body: JSON.stringify({ examId: 'exam_free_01' })
      }),
      env
    );
    const startFreeJson = (await startFreeRes.json()) as { attempt: { id: string } };
    const freeWrongAnswers: Record<string, number> = {};
    for (let i = 1; i <= 5; i++) {
      freeWrongAnswers[`q_mock_${String(i).padStart(3, '0')}`] = (i + 2) % 4;
    }
    const submitFreeRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/exams/submit', {
        method: 'POST',
        headers: { Authorization: `Bearer ${freeStudentToken}`, 'X-Session-Id': freeSess, 'Content-Type': 'application/json' },
        body: JSON.stringify({ attemptId: startFreeJson.attempt.id, answers: freeWrongAnswers })
      }),
      env
    );
    assert.equal(submitFreeRes.status, 200);
    const submitFreeJson = (await submitFreeRes.json()) as { result: { finalScore: number } };
    assert.equal(submitFreeJson.result.finalScore, -1.25);

    // Leaderboard ranked highest score first
    const lbRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/leaderboard'),
      env
    );
    assert.equal(lbRes.status, 200);
    const lbJson = (await lbRes.json()) as { leaderboard: Array<{ userId: string; score: number; rank: number }> };
    assert.equal(lbJson.leaderboard.length, 2);
    assert.equal(lbJson.leaderboard[0].userId, 'student_pro');
    assert.equal(lbJson.leaderboard[0].score, 9);
    assert.equal(lbJson.leaderboard[0].rank, 1);
    assert.equal(lbJson.leaderboard[1].score, -1.25);

    // Exam results cross-user isolation
    const myRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/exams/results', {
        headers: { Authorization: `Bearer ${proStudentToken}`, 'X-Session-Id': proSess }
      }),
      env
    );
    assert.equal(((await myRes.json()) as { results: unknown[] }).results.length, 1);

    const hijackResultsRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/exams/results/student_pro', {
        headers: { Authorization: `Bearer ${freeStudentToken}`, 'X-Session-Id': freeSess }
      }),
      env
    );
    assert.equal(hijackResultsRes.status, 403);
  });

  test('4. Owner Admin config/settings/stats/audit, Exam Pass extend_all policy, no secondary admin privilege escalation, & D1 session revocation', async () => {
    const db = await createMigratedTestD1();
    const stub = createPhase3FirestoreStub('sanad-worker-sa@galvanic-aviary-tzp2g.iam.gserviceaccount.com');
    seedPackagesAndConfig(stub);

    stub.setDoc('users', 'student_ep', {
      uid: 'student_ep',
      name: 'Exam Pass Student',
      email: 'ep@example.com',
      role: 'student',
      subscriptionStatus: 'pro',
      subscriptionExpiresAt: '2026-11-28T09:00:00+06:00',
      createdAt: '2026-10-01T00:00:00.000Z'
    });
    stub.setDoc('subscriptions', 'sub_ep_1', {
      userId: 'student_ep',
      packageId: 'pkg_exam_pass',
      status: 'active',
      activatedAt: '2026-10-01T00:00:00.000Z',
      expiresAt: '2026-11-28T09:00:00+06:00',
      createdAt: '2026-10-01T00:00:00.000Z'
    });

    const ownerToken = await makeToken(OWNER_ADMIN_UID, OWNER_ADMIN_EMAIL, 'Khayrul Alam');
    const studentToken = await makeToken('student_ep', 'ep@example.com', 'Exam Pass Student');

    const handler = createWorkerHandler({
      jwksFetcher: async () => ({ keys: [keyPair.jwk], maxAgeSeconds: 3600 }),
      fetchImpl: stub.fetchImpl,
      nowMsFn: () => baseNowMs
    });
    const env: WorkerEnv = {
      DB: db,
      ENVIRONMENT: 'production',
      FIREBASE_PROJECT_ID: EXPECTED_FIREBASE_PROJECT_ID,
      FIREBASE_DATABASE_ID: EXPECTED_FIREBASE_DATABASE_ID,
      FIREBASE_SERVICE_ACCOUNT_JSON: saJson
    };

    const studentSess = await loginStudent(handler, env, studentToken, 'Exam Pass Student');

    // Non-owner blocked from every admin configuration endpoint
    const nonOwnerConfig = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/admin/exam-config', {
        method: 'POST',
        headers: { Authorization: `Bearer ${studentToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ examPassPrice: 1 })
      }),
      env
    );
    assert.equal(nonOwnerConfig.status, 403);

    // Owner updates exam-config with extend_all -> shifts both config and active pkg_exam_pass subscribers!
    const extendRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/admin/exam-config', {
        method: 'POST',
        headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetExamDate: '2026-12-19T09:00:00+06:00',
          examDatePolicy: 'extend_all',
          examPassPrice: 700
        })
      }),
      env
    );
    assert.equal(extendRes.status, 200);
    const extendJson = (await extendRes.json()) as {
      affectedSubscribers: number;
      examDateConfig: { examPassPrice: number };
    };
    assert.equal(extendJson.affectedSubscribers, 1);
    assert.equal(extendJson.examDateConfig.examPassPrice, 700);
    assert.equal(
      stub.getCol('subscriptions').get('sub_ep_1')?.targetExamDateSnapshot,
      '2026-12-19T09:00:00+06:00'
    );

    // Payment settings preserves default bKash/Nagad 01712607777 and rejects invalid numbers
    const badPayNumRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/admin/payment-settings', {
        method: 'POST',
        headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ bkashNumber: '12345' })
      }),
      env
    );
    assert.equal(badPayNumRes.status, 400);

    const goodPaySettingsRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/admin/payment-settings', {
        method: 'POST',
        headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ bkashNumber: '01712607777', nagadNumber: '01712607777' })
      }),
      env
    );
    assert.equal(goodPaySettingsRes.status, 200);
    const paySettingsJson = (await goodPaySettingsRes.json()) as {
      paymentSettings: { bkashNumber: string; nagadNumber: string; whatsappNumber: string };
    };
    assert.equal(paySettingsJson.paymentSettings.bkashNumber, '01712607777');
    assert.equal(paySettingsJson.paymentSettings.whatsappNumber, '+8801671819027');

    // Admin updates user: refuses promoting non-Owner UID to 'admin' AND revokes active D1 session
    const userUpdateRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/admin/users/update', {
        method: 'POST',
        headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: 'student_ep',
          name: 'Exam Pass Student',
          email: 'ep@example.com',
          phone: '01700000000',
          role: 'admin',
          subscriptionStatus: 'pro',
          isSessionRevoked: true
        })
      }),
      env
    );
    assert.equal(userUpdateRes.status, 200);
    const updatedUserJson = (await userUpdateRes.json()) as { user: { role: string } };
    assert.equal(updatedUserJson.user.role, 'student', 'Secondary accounts must NEVER receive admin role');

    // Revoked student's D1 session now immediately returns 401 SESSION_REVOKED
    const revokedSessCheck = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/auth/session/status', {
        headers: { Authorization: `Bearer ${studentToken}`, 'X-Session-Id': studentSess }
      }),
      env
    );
    assert.equal(revokedSessCheck.status, 401);
    assert.equal(((await revokedSessCheck.json()) as { error: string }).error, 'SESSION_REVOKED');

    // Dashboard stats & audit logs return cleanly
    const [statsRes, auditRes] = await Promise.all([
      handler(
        new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/admin/dashboard-stats', {
          headers: { Authorization: `Bearer ${ownerToken}` }
        }),
        env
      ),
      handler(
        new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/admin/audit-logs', {
          headers: { Authorization: `Bearer ${ownerToken}` }
        }),
        env
      )
    ]);
    assert.equal(statsRes.status, 200);
    assert.equal(auditRes.status, 200);
    const statsJson = (await statsRes.json()) as { activeSubscribers: number; totalStudents: number };
    assert.equal(statsJson.totalStudents, 1);
    assert.equal(statsJson.activeSubscribers, 1);
    const auditLogsJson = (await auditRes.json()) as { auditLogs: Array<{ action: string }> };
    assert.ok(auditLogsJson.auditLogs.some(l => l.action === 'USER_EDITED_BY_ADMIN'));
  });
});
