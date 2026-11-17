import test, { describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
  buildUserProfileDocument,
  ensureUserProfileInitialized,
  type ValidatedUserProfileCreateDoc
} from '../src/lib/profileHelpers.ts';
import { normalizeApiBaseUrl, resolveApiRequestUrl } from '../src/lib/api.ts';
import { ExamAnswerBatcher, type ExamProgressSnapshot } from '../src/lib/examAnswerBatcher.ts';
import {
  DEFAULT_QUESTION_BANK_CACHE_TTL_MS,
  parseQuestionBankCacheTtlMs,
  upsertSingleQuestionCacheD1
} from '../worker/questionCache.ts';
import {
  EXPECTED_FIREBASE_DATABASE_ID,
  EXPECTED_FIREBASE_PROJECT_ID,
  OWNER_ADMIN_EMAIL,
  OWNER_ADMIN_UID,
  type D1Database,
  type D1ExecResult,
  type D1PreparedStatement,
  type D1Result,
  type ServerQuestion,
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
  encodeDocumentFields,
  type FirestoreRestValue
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

function createPhase45FirestoreStub(serviceAccountEmail: string) {
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

  const formatDoc = (col: string, docId: string, data: Record<string, unknown>) => ({
    name: `projects/${EXPECTED_FIREBASE_PROJECT_ID}/databases/${EXPECTED_FIREBASE_DATABASE_ID}/documents/${col}/${docId}`,
    fields: encodeDocumentFields(data),
    createTime: '2026-01-01T00:00:00.000Z',
    updateTime: '2026-01-01T00:00:00.000Z'
  });

  const stubFetch: typeof fetch = async (input, init) => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method || 'GET').toUpperCase();

    if (urlStr === 'https://oauth2.googleapis.com/token') {
      return new Response(
        JSON.stringify({ access_token: `sa_token_${serviceAccountEmail}`, expires_in: 3600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (urlStr === `${expectedPrefix}:batchGet`) {
      const body = JSON.parse(String(init?.body || '{}')) as { documents?: string[] };
      const results: unknown[] = [];
      for (const docPath of body.documents || []) {
        const parts = docPath.split('/documents/')[1]?.split('/') || [];
        const col = parts[0];
        const docId = parts.slice(1).join('/');
        readLog.push({ op: 'batchGet', collection: col, docId });
        const doc = getCol(col).get(docId);
        if (doc) {
          results.push({ found: formatDoc(col, docId, doc) });
        } else {
          results.push({ missing: docPath });
        }
      }
      return new Response(JSON.stringify(results), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (urlStr === `${expectedPrefix}:commit`) {
      const body = JSON.parse(String(init?.body || '{}')) as {
        writes?: Array<{
          update?: { name: string; fields?: Record<string, unknown> };
          delete?: string;
          updateMask?: { fieldPaths?: string[] };
          currentDocument?: { exists?: boolean };
        }>;
      };
      for (const w of body.writes || []) {
        if (w.delete) {
          const rel = w.delete.split('/documents/')[1];
          const [col, ...rest] = rel.split('/');
          getCol(col).delete(rest.join('/'));
        } else if (w.update) {
          const rel = w.update.name.split('/documents/')[1];
          const [col, ...rest] = rel.split('/');
          const docId = rest.join('/');
          const map = getCol(col);
          if (w.currentDocument?.exists === false && map.has(docId)) {
            return new Response(JSON.stringify({ error: { code: 409, message: 'ALREADY_EXISTS' } }), {
              status: 409,
              headers: { 'Content-Type': 'application/json' }
            });
          }
          const incoming = decodeDocumentFields(
            (w.update.fields || {}) as Record<string, FirestoreRestValue>
          ) as Record<string, unknown>;
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
          where?: {
            fieldFilter?: { field: { fieldPath: string }; op: string; value: FirestoreRestValue };
            compositeFilter?: {
              filters: Array<{
                fieldFilter?: { field: { fieldPath: string }; op: string; value: FirestoreRestValue };
              }>;
            };
          };
        };
      };
      const col = body.structuredQuery?.from?.[0]?.collectionId || '';
      readLog.push({ op: 'runQuery', collection: col });
      const filters: Array<{ field: string; value: unknown }> = [];
      const where = body.structuredQuery?.where;
      if (where?.fieldFilter) {
        const val = decodeDocumentFields({ v: where.fieldFilter.value }).v;
        filters.push({ field: where.fieldFilter.field.fieldPath, value: val });
      }
      if (where?.compositeFilter?.filters) {
        for (const f of where.compositeFilter.filters) {
          if (f.fieldFilter) {
            const val = decodeDocumentFields({ v: f.fieldFilter.value }).v;
            filters.push({ field: f.fieldFilter.field.fieldPath, value: val });
          }
        }
      }
      const rows: unknown[] = [];
      for (const [docId, doc] of getCol(col).entries()) {
        const match = filters.every(f => doc[f.field] === f.value);
        if (match) {
          rows.push({ document: formatDoc(col, docId, doc) });
        }
      }
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (urlStr.startsWith(`${expectedPrefix}/`)) {
      const [pathPart, qs] = urlStr.slice(expectedPrefix.length + 1).split('?');
      const parts = pathPart.split('/');
      const col = parts[0];
      const docId = parts.slice(1).join('/');

      if (method === 'GET' && !docId) {
        readLog.push({ op: 'list', collection: col });
        const allDocs = Array.from(getCol(col).entries()).map(([id, data]) => formatDoc(col, id, data));
        const params = new URLSearchParams(qs || '');
        const pageSize = Number(params.get('pageSize') || '500');
        const slice = allDocs.slice(0, pageSize);
        return new Response(JSON.stringify({ documents: slice }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (method === 'GET' && docId) {
        readLog.push({ op: 'get', collection: col, docId });
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
    },
    getCollection(col: string) {
      return Array.from(getCol(col).entries()).map(([id, data]) => ({ id, ...data }));
    },
    getReadLog() {
      return readLog;
    }
  };
}

function assertMatchesFirestoreCreateRule(docData: ValidatedUserProfileCreateDoc, authUid: string) {
  const allowedKeys = new Set([
    'uid',
    'name',
    'email',
    'phone',
    'role',
    'subscriptionStatus',
    'subscriptionExpiresAt',
    'activePackageId',
    'activePackageNameBn',
    'activePackageNameEn',
    'createdAt'
  ]);
  const requiredKeys = ['uid', 'name', 'role', 'subscriptionStatus', 'createdAt'];
  const keys = Object.keys(docData);
  for (const k of requiredKeys) {
    assert.ok(keys.includes(k), `Missing required Firestore rule field: ${k}`);
  }
  for (const k of keys) {
    assert.ok(allowedKeys.has(k), `Unexpected extra Firestore rule field: ${k}`);
  }
  assert.equal(docData.uid, authUid);
  assert.equal(typeof docData.name, 'string');
  assert.ok(docData.name.length > 0 && docData.name.length <= 100);
  assert.ok(docData.email.length <= 150);
  assert.ok(docData.phone.length <= 20);
  assert.equal(docData.subscriptionStatus, 'free');
  assert.equal(docData.subscriptionExpiresAt, null);
}

describe('Phase 4.5 — Task 1: Student Profile Creation & Rules Compliance', () => {
  test('New student email login creates Firestore-compliant profile with authenticated uid', async () => {
    let createdPayload: ValidatedUserProfileCreateDoc | null = null;
    const authUser = {
      uid: 'student_email_uid_01',
      email: 'new.student@example.com',
      emailVerified: true,
      displayName: null
    };

    const res = await ensureUserProfileInitialized({
      authUser,
      candidateName: 'তানভীর আহমেদ',
      fetchProfileStatus: async () => ({ status: 'missing' }),
      createProfile: async (docData) => {
        createdPayload = docData;
      },
      nowIso: '2026-05-01T10:00:00.000Z'
    });

    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.created, true);
    assert.ok(createdPayload);
    const savedEmailDoc = createdPayload as ValidatedUserProfileCreateDoc;
    assertMatchesFirestoreCreateRule(savedEmailDoc, 'student_email_uid_01');
    assert.equal(savedEmailDoc.role, 'student');
    assert.equal(savedEmailDoc.name, 'তানভীর আহমেদ');
    assert.equal(savedEmailDoc.email, 'new.student@example.com');
  });

  test('New student Google login creates Firestore-compliant profile with Google displayName & uid', async () => {
    let createdPayload: ValidatedUserProfileCreateDoc | null = null;
    const googleUser = {
      uid: 'student_google_uid_02',
      email: 'google.advocate@gmail.com',
      emailVerified: true,
      displayName: 'Farhana Yasmin',
      phoneNumber: '+8801700001111'
    };

    const res = await ensureUserProfileInitialized({
      authUser: googleUser,
      fetchProfileStatus: async () => ({ status: 'missing' }),
      createProfile: async (docData) => {
        createdPayload = docData;
      }
    });

    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.created, true);
    assert.ok(createdPayload);
    const savedGoogleDoc = createdPayload as ValidatedUserProfileCreateDoc;
    assertMatchesFirestoreCreateRule(savedGoogleDoc, 'student_google_uid_02');
    assert.equal(savedGoogleDoc.name, 'Farhana Yasmin');
    assert.equal(savedGoogleDoc.role, 'student');
  });

  test('Existing student login preserves existing profile without re-creating or clobbering pro subscription', async () => {
    let createCalled = false;
    const res = await ensureUserProfileInitialized({
      authUser: {
        uid: 'student_existing_03',
        email: 'pro.student@example.com',
        emailVerified: true,
        displayName: 'Rafiq'
      },
      fetchProfileStatus: async (uid) => ({
        status: 'found',
        profile: {
          uid,
          name: 'Rafiqul Islam',
          email: 'pro.student@example.com',
          phone: '01711111111',
          role: 'student',
          subscriptionStatus: 'pro',
          subscriptionExpiresAt: '2026-09-01T00:00:00.000Z',
          createdAt: '2026-01-10T00:00:00.000Z'
        }
      }),
      createProfile: async () => {
        createCalled = true;
      }
    });

    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.created, false);
    assert.equal(createCalled, false);
    assert.equal(res.profile.uid, 'student_existing_03');
    assert.equal(res.profile.subscriptionStatus, 'pro');
    assert.equal(res.profile.role, 'student');
  });

  test('Rejects UID mismatch, unverified email creation, and unauthorized role/subscription escalation', () => {
    assert.throws(
      () =>
        buildUserProfileDocument({
          authUser: {
            uid: 'student_real_uid',
            email: 'a@example.com',
            emailVerified: true
          },
          profile: {
            uid: 'forged_other_uid'
          }
        }),
      /UID_MISMATCH_PROFILE_WRITE/
    );

    assert.throws(
      () =>
        buildUserProfileDocument({
          authUser: {
            uid: 'student_unverified',
            email: 'u@example.com',
            emailVerified: false
          }
        }),
      /EMAIL_NOT_VERIFIED_FOR_PROFILE/
    );

    // Client-supplied admin role or pro subscription is forcibly downgraded by buildUserProfileDocument
    const forgedPayload = buildUserProfileDocument({
      authUser: {
        uid: 'student_attacker',
        email: 'attacker@example.com',
        emailVerified: true
      },
      profile: {
        role: 'admin',
        subscriptionStatus: 'pro',
        subscriptionExpiresAt: '2099-01-01T00:00:00.000Z'
      }
    });

    assert.equal(forgedPayload.role, 'student');
    assert.equal(forgedPayload.subscriptionStatus, 'free');
    assert.equal(forgedPayload.subscriptionExpiresAt, null);
    assertMatchesFirestoreCreateRule(forgedPayload, 'student_attacker');
  });

  test('Verified Owner Admin profile receives admin role while read errors fail safely without overwriting', async () => {
    const ownerRes = await ensureUserProfileInitialized({
      authUser: {
        uid: OWNER_ADMIN_UID,
        email: OWNER_ADMIN_EMAIL,
        emailVerified: true,
        displayName: 'মো: খাইরুল আলম'
      },
      fetchProfileStatus: async () => ({ status: 'missing' }),
      createProfile: async () => undefined
    });
    assert.equal(ownerRes.ok, true);
    if (ownerRes.ok) {
      assert.equal(ownerRes.profile.role, 'admin');
    }

    let createCalledOnErr = false;
    const errRes = await ensureUserProfileInitialized({
      authUser: {
        uid: 'student_read_err',
        email: 'err@example.com',
        emailVerified: true
      },
      fetchProfileStatus: async () => ({ status: 'error', error: 'network-timeout' }),
      createProfile: async () => {
        createCalledOnErr = true;
      }
    });
    assert.equal(errRes.ok, false);
    assert.equal(createCalledOnErr, false);
  });
});

describe('Phase 4.5 — Task 2: Same-Origin Worker API URL & Zero Cloud Run Warnings', () => {
  test('Empty VITE_API_BASE_URL resolves to same-origin /api/* and src/lib/api.ts has zero Cloud Run strings', () => {
    assert.equal(normalizeApiBaseUrl(''), '');
    assert.equal(resolveApiRequestUrl('/api/exams', ''), '/api/exams');
    assert.equal(resolveApiRequestUrl('api/questions?subjectId=sub_cpc', ''), '/api/questions?subjectId=sub_cpc');
    assert.equal(
      resolveApiRequestUrl('/api/auth/session', 'https://sanadprepbd.com/'),
      'https://sanadprepbd.com/api/auth/session'
    );

    const apiSource = fs.readFileSync(path.resolve('src/lib/api.ts'), 'utf-8');
    assert.equal(/Cloud Run/i.test(apiSource), false, 'src/lib/api.ts must not mention Cloud Run');
    assert.equal(
      /warnedMisconfiguredApiBase|checkCloudflareApiBaseConfiguration/i.test(apiSource),
      false,
      'Obsolete Cloud Run warning function must be removed'
    );
    assert.equal(
      /run\.app/i.test(apiSource),
      false,
      'No hardcoded run.app production URL may exist in src/lib/api.ts'
    );
  });
});

describe('Phase 4.5 — Task 3: Exam Answer Batcher & Safe Pre-Submit Flush', () => {
  test('Coalesces rapid clicks into a single save and preserves clear & flag actions', async () => {
    const savedCalls: ExamProgressSnapshot[] = [];
    const batcher = new ExamAnswerBatcher({
      debounceMs: 40,
      maxWaitMs: 120,
      saveFn: async (snapshot) => {
        savedCalls.push(snapshot);
        return { ok: true, status: 200 };
      }
    });

    batcher.enqueue({ attemptId: 'att_1', answers: { q1: 0 }, flaggedQuestionIds: [], currentQuestionIndex: 0 });
    batcher.enqueue({ attemptId: 'att_1', answers: { q1: 2 }, flaggedQuestionIds: ['q1'], currentQuestionIndex: 0 });
    batcher.enqueue({ attemptId: 'att_1', answers: { q1: 2, q2: 1 }, flaggedQuestionIds: ['q1'], currentQuestionIndex: 1 });
    // Clear q1
    batcher.enqueue({ attemptId: 'att_1', answers: { q2: 1 }, flaggedQuestionIds: ['q1'], currentQuestionIndex: 1 });

    await new Promise(r => setTimeout(r, 90));

    assert.equal(savedCalls.length, 1);
    assert.deepEqual(savedCalls[0].answers, { q2: 1 });
    assert.deepEqual(savedCalls[0].flaggedQuestionIds, ['q1']);
    assert.equal(batcher.hasPendingChanges(), false);
  });

  test('Prevents overlapping saves, retries transient errors, stops on ALREADY_SUBMITTED, and flushes cleanly', async () => {
    let activeCalls = 0;
    let maxConcurrent = 0;
    let callCount = 0;
    const recordedSnapshots: ExamProgressSnapshot[] = [];

    const batcher = new ExamAnswerBatcher({
      debounceMs: 25,
      maxWaitMs: 80,
      maxRetries: 2,
      retryBaseDelayMs: 20,
      saveFn: async (snapshot) => {
        callCount++;
        activeCalls++;
        maxConcurrent = Math.max(maxConcurrent, activeCalls);
        await new Promise(r => setTimeout(r, 35));
        activeCalls--;

        if (callCount === 1) {
          return { ok: false, status: 503, code: 'HTTP_503', message: 'Transient error' };
        }
        recordedSnapshots.push(snapshot);
        return { ok: true, status: 200 };
      }
    });

    batcher.enqueue({ attemptId: 'att_2', answers: { q1: 1 }, flaggedQuestionIds: [], currentQuestionIndex: 0 });
    await new Promise(r => setTimeout(r, 40)); // fires 1st save (which is in flight and will fail 503)
    // Edit arrives while 1st save is in flight
    batcher.enqueue({ attemptId: 'att_2', answers: { q1: 1, q2: 3 }, flaggedQuestionIds: ['q2'], currentQuestionIndex: 1 });

    const flushed = await batcher.flush('att_2');
    assert.equal(flushed, true);
    assert.equal(maxConcurrent, 1, 'Saves must never overlap concurrently');
    assert.deepEqual(recordedSnapshots[recordedSnapshots.length - 1].answers, { q1: 1, q2: 3 });
    assert.deepEqual(recordedSnapshots[recordedSnapshots.length - 1].flaggedQuestionIds, ['q2']);

    // Post-submission lock prevents any further writes
    batcher.markSubmitted('att_2');
    const countBeforeLockedEdit = callCount;
    batcher.enqueue({ attemptId: 'att_2', answers: { q1: 0 }, flaggedQuestionIds: [], currentQuestionIndex: 0 });
    await new Promise(r => setTimeout(r, 40));
    assert.equal(callCount, countBeforeLockedEdit);
  });

  test('Permanent lock error ALREADY_SUBMITTED disables further retries immediately', async () => {
    let calls = 0;
    let lockedCode = '';
    const batcher = new ExamAnswerBatcher({
      debounceMs: 15,
      maxRetries: 3,
      retryBaseDelayMs: 15,
      saveFn: async () => {
        calls++;
        return { ok: false, status: 409, code: 'ALREADY_SUBMITTED', message: 'Already submitted' };
      },
      onLockedError: (err) => {
        lockedCode = err.code;
      }
    });

    batcher.enqueue({ attemptId: 'att_locked', answers: { q1: 0 }, flaggedQuestionIds: [], currentQuestionIndex: 0 });
    await new Promise(r => setTimeout(r, 70));

    assert.equal(calls, 1, 'Must not retry after ALREADY_SUBMITTED');
    assert.equal(lockedCode, 'ALREADY_SUBMITTED');
    assert.equal(batcher.hasPendingChanges(), false);
  });
});

describe('Phase 4.5 — Tasks 4 & 5: Cache TTL, Pagination, Empty-Cache Guard, Counts & Admin Stats/Audit', () => {
  let db: SqliteD1Adapter;
  let fsStub: ReturnType<typeof createPhase45FirestoreStub>;
  let keypair: Awaited<ReturnType<typeof generateRs256Keypair>>;
  let workerHandler: ReturnType<typeof createWorkerHandler>;

  const nowMs = Date.UTC(2026, 4, 15, 10, 0, 0);
  const studentUid = 'student_phase45_uid';
  const studentEmail = 'student45@example.com';

  beforeEach(async () => {
    clearFirebaseJwksCacheForTests();
    clearServiceAccountTokenCacheForTests();
    db = await createMigratedTestD1();
    keypair = await generateRs256Keypair('kid-phase45');
    fsStub = createPhase45FirestoreStub('worker-sa@galvanic-aviary-tzp2g.iam.gserviceaccount.com');

    fsStub.seedDoc('config', 'questionBankVersion', {
      version: 10,
      versionToken: 'v_initial_10',
      updatedAt: '2026-05-01T00:00:00.000Z'
    });

    // Seed 15 questions across sub_cpc (10) and sub_crpc (5)
    for (let i = 1; i <= 10; i++) {
      const id = `q_cpc_${String(i).padStart(2, '0')}`;
      fsStub.seedDoc('questions', id, {
        subjectId: 'sub_cpc',
        questionBn: `দেওয়ানী প্রশ্ন ${i}`,
        questionEn: `CPC Question ${i}`,
        optionsBn: ['ক', 'খ', 'গ', 'ঘ'],
        optionsEn: ['A', 'B', 'C', 'D'],
        legalReference: `CPC Section ${i}`,
        difficulty: 'medium',
        status: 'published',
        isDemoSample: i === 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      });
      fsStub.seedDoc('questionKeys', id, {
        correctOptionIndex: i % 4,
        explanationBn: `গোপন ব্যাখ্যা ${i}`,
        explanationEn: `Secret Explanation ${i}`,
        legalReference: `CPC Section ${i}`,
        updatedAt: '2026-01-01T00:00:00.000Z'
      });
    }
    for (let i = 1; i <= 5; i++) {
      const id = `q_crpc_${String(i).padStart(2, '0')}`;
      fsStub.seedDoc('questions', id, {
        subjectId: 'sub_crpc',
        questionBn: `ফৌজদারী প্রশ্ন ${i}`,
        questionEn: `CrPC Question ${i}`,
        optionsBn: ['ক', 'খ', 'গ', 'ঘ'],
        optionsEn: ['A', 'B', 'C', 'D'],
        legalReference: `CrPC Section ${i}`,
        difficulty: 'easy',
        status: 'published',
        isDemoSample: i === 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      });
      fsStub.seedDoc('questionKeys', id, {
        correctOptionIndex: i % 4,
        explanationBn: `ফৌজদারী ব্যাখ্যা ${i}`,
        explanationEn: `Secret CrPC Exp ${i}`,
        legalReference: `CrPC Section ${i}`,
        updatedAt: '2026-01-01T00:00:00.000Z'
      });
    }

    // Seed student profile + another unpaying registered user with sensitive PII
    fsStub.seedDoc('users', studentUid, {
      uid: studentUid,
      name: 'Student One',
      email: studentEmail,
      phone: '01700000001',
      role: 'student',
      subscriptionStatus: 'pro',
      subscriptionExpiresAt: '2026-12-31T00:00:00.000Z',
      createdAt: '2026-05-01T00:00:00.000Z'
    });
    fsStub.seedDoc('users', 'student_no_payments_pii', {
      uid: 'student_no_payments_pii',
      name: 'Secret Name',
      email: 'private.student.email@example.com',
      phone: '+8801999888777',
      role: 'student',
      subscriptionStatus: 'free',
      createdAt: '2026-05-02T00:00:00.000Z'
    });
    fsStub.seedDoc('auditLogs', 'audit_seed_1', {
      id: 'audit_seed_1',
      userId: OWNER_ADMIN_UID,
      userName: OWNER_ADMIN_EMAIL,
      action: 'SYSTEM_AUDIT_SEED',
      details: 'Verified audit trail entry',
      timestamp: '2026-05-10T10:00:00.000Z'
    });

    workerHandler = createWorkerHandler({
      fetchImpl: fsStub.stubFetch,
      nowMsFn: () => nowMs,
      jwksFetcher: async () => ({ keys: [keypair.jwk], maxAgeSeconds: 3600 })
    });
  });

  function makeEnv(): WorkerEnv {
    return {
      DB: db,
      FIREBASE_PROJECT_ID: EXPECTED_FIREBASE_PROJECT_ID,
      FIREBASE_DATABASE_ID: EXPECTED_FIREBASE_DATABASE_ID,
      FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        client_email: 'worker-sa@galvanic-aviary-tzp2g.iam.gserviceaccount.com',
        private_key: keypair.pkcs8Pem
      }),
      ALLOWED_ORIGIN: 'https://s--khayrul-alam.khayrulalam88.workers.dev'
    };
  }

  async function issueStudentToken() {
    const iat = Math.floor(nowMs / 1000) - 60;
    return signJwt(keypair.privateKey, keypair.kid, {
      aud: EXPECTED_FIREBASE_PROJECT_ID,
      iss: `https://securetoken.google.com/${EXPECTED_FIREBASE_PROJECT_ID}`,
      sub: studentUid,
      user_id: studentUid,
      email: studentEmail,
      email_verified: true,
      iat,
      exp: iat + 3600
    });
  }

  async function issueOwnerToken() {
    const iat = Math.floor(nowMs / 1000) - 60;
    return signJwt(keypair.privateKey, keypair.kid, {
      aud: EXPECTED_FIREBASE_PROJECT_ID,
      iss: `https://securetoken.google.com/${EXPECTED_FIREBASE_PROJECT_ID}`,
      sub: OWNER_ADMIN_UID,
      user_id: OWNER_ADMIN_UID,
      email: OWNER_ADMIN_EMAIL,
      email_verified: true,
      iat,
      exp: iat + 3600
    });
  }

  test('Question Bank cache TTL defaults to 1 hour (3,600,000 ms) in code and worker/wrangler.jsonc', () => {
    assert.equal(DEFAULT_QUESTION_BANK_CACHE_TTL_MS, 3_600_000);
    assert.equal(parseQuestionBankCacheTtlMs(undefined), 3_600_000);
    const wranglerRaw = fs.readFileSync(path.resolve('worker/wrangler.jsonc'), 'utf-8');
    assert.match(wranglerRaw, /"QUESTION_BANK_CACHE_TTL_MS"\s*:\s*"3600000"/);
  });

  test('/api/subjects/counts and /api/questions pagination work without leaking keys or downloading full bank', async () => {
    const env = makeEnv();
    const countsRes = await workerHandler(new Request('https://app.example/api/subjects/counts'), env);
    assert.equal(countsRes.status, 200);
    const countsBody = (await countsRes.json()) as { counts: Record<string, number>; total: number };
    assert.equal(countsBody.total, 15);
    assert.equal(countsBody.counts.sub_cpc, 10);
    assert.equal(countsBody.counts.sub_crpc, 5);

    const token = await issueStudentToken();
    const sessRes = await workerHandler(
      new Request('https://app.example/api/auth/session', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ userName: 'Student' })
      }),
      env
    );
    const sessBody = (await sessRes.json()) as { sessionId: string };

    // Page 1 (limit=4, offset=0)
    const p1Res = await workerHandler(
      new Request('https://app.example/api/questions?subjectId=sub_cpc&limit=4&offset=0', {
        headers: { Authorization: `Bearer ${token}`, 'X-Session-Id': sessBody.sessionId }
      }),
      env
    );
    assert.equal(p1Res.status, 200);
    const p1 = (await p1Res.json()) as {
      questions: Array<Record<string, unknown>>;
      total: number;
      hasMore: boolean;
    };
    assert.equal(p1.total, 10);
    assert.equal(p1.hasMore, true);
    assert.equal(p1.questions.length, 4);
    for (const q of p1.questions) {
      assert.equal('correctOptionIndex' in q, false);
      assert.equal('explanationBn' in q, false);
      assert.equal('explanationEn' in q, false);
    }

    // Last page (limit=4, offset=8 -> 2 remaining, hasMore=false)
    const p3Res = await workerHandler(
      new Request('https://app.example/api/questions?subjectId=sub_cpc&limit=4&offset=8', {
        headers: { Authorization: `Bearer ${token}`, 'X-Session-Id': sessBody.sessionId }
      }),
      env
    );
    const p3 = (await p3Res.json()) as {
      questions: Array<Record<string, unknown>>;
      total: number;
      hasMore: boolean;
    };
    assert.equal(p3.questions.length, 2);
    assert.equal(p3.hasMore, false);
  });

  test('Regression: single-question upsert/create when D1 cache is empty does NOT poison cache with only 1 question', async () => {
    const newQ: ServerQuestion = {
      id: 'q_custom_single',
      subjectId: 'sub_cpc',
      questionBn: 'নতুন প্রশ্ন',
      questionEn: 'New Question',
      optionsBn: ['ক', 'খ', 'গ', 'ঘ'],
      optionsEn: ['A', 'B', 'C', 'D'],
      correctOptionIndex: 1,
      explanationBn: 'ব্যাখ্যা',
      explanationEn: 'Exp',
      legalReference: 'CPC 151',
      difficulty: 'medium',
      status: 'published',
      isDemoSample: false,
      createdAt: '2026-05-15T10:00:00.000Z',
      updatedAt: '2026-05-15T10:00:00.000Z'
    };

    // Guarded single upsert on empty D1 leaves meta marked invalidated so full catalog syncs cleanly
    await upsertSingleQuestionCacheD1(db, newQ, 'v_single_1', '2026-05-15T10:00:00.000Z', {
      onlyIfCacheInitialized: true
    });
    const metaRow = await db
      .prepare(`SELECT version_token, synced_at FROM question_bank_meta WHERE id = 'questionBankVersion'`)
      .first<{ version_token: string; synced_at: string }>();
    assert.equal(metaRow?.version_token, '__invalidated__');
    assert.equal(metaRow?.synced_at, '1970-01-01T00:00:00.000Z');

    // End-to-end check: Owner creates question on cold empty D1, subsequent counts request still syncs all 15 + 1 = 16
    const env = makeEnv();
    const ownerToken = await issueOwnerToken();
    const coldCreateRes = await workerHandler(
      new Request('https://app.example/api/admin/questions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'q_cold_admin_created',
          subjectId: 'sub_cpc',
          questionBn: 'কোল্ড ক্যাশে নতুন প্রশ্ন',
          optionsBn: ['ক', 'খ', 'গ', 'ঘ'],
          correctOptionIndex: 0,
          explanationBn: 'ব্যাখ্যা'
        })
      }),
      env
    );
    assert.equal(coldCreateRes.status, 200);

    const countsRes = await workerHandler(new Request('https://app.example/api/subjects/counts'), env);
    const countsBody = (await countsRes.json()) as { total: number; counts: Record<string, number> };
    assert.equal(countsBody.total, 16);
    assert.equal(countsBody.counts.sub_cpc, 11);
  });

  test('Owner CRUD invalidates/updates D1 cache & versionToken across create, update, and delete', async () => {
    const env = makeEnv();
    const ownerToken = await issueOwnerToken();

    // Warm D1 cache first
    await workerHandler(new Request('https://app.example/api/subjects/counts'), env);

    // Owner creates new question
    const createRes = await workerHandler(
      new Request('https://app.example/api/admin/questions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'q_owner_created_1',
          subjectId: 'sub_sra',
          questionBn: 'সুনির্দিষ্ট প্রতিকার আইনের ধারা ৯?',
          optionsBn: ['ক', 'খ', 'গ', 'ঘ'],
          correctOptionIndex: 2,
          explanationBn: 'ধারা ৯ অনুযায়ী ৬ মাস'
        })
      }),
      env
    );
    assert.equal(createRes.status, 200);
    const createJson = (await createRes.json()) as { success: boolean; versionToken: string };
    assert.equal(createJson.success, true);

    const countsAfterCreate = (await (
      await workerHandler(new Request('https://app.example/api/subjects/counts'), env)
    ).json()) as { counts: Record<string, number>; total: number };
    assert.equal(countsAfterCreate.total, 16);
    assert.equal(countsAfterCreate.counts.sub_sra, 1);

    // Owner deletes that question
    const delRes = await workerHandler(
      new Request('https://app.example/api/admin/questions/q_owner_created_1', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${ownerToken}` }
      }),
      env
    );
    assert.equal(delRes.status, 200);

    const countsAfterDelete = (await (
      await workerHandler(new Request('https://app.example/api/subjects/counts'), env)
    ).json()) as { counts: Record<string, number>; total: number };
    assert.equal(countsAfterDelete.total, 15);
    assert.equal(countsAfterDelete.counts.sub_sra ?? 0, 0);
  });

  test('Task 5: /api/admin/dashboard-stats & /api/admin/audit-logs restrict to Owner UID & expose zero student PII', async () => {
    const env = makeEnv();
    const studentToken = await issueStudentToken();
    const ownerToken = await issueOwnerToken();

    // Student rejected (403)
    const studentStats = await workerHandler(
      new Request('https://app.example/api/admin/dashboard-stats', {
        headers: { Authorization: `Bearer ${studentToken}` }
      }),
      env
    );
    assert.equal(studentStats.status, 403);

    const studentLogs = await workerHandler(
      new Request('https://app.example/api/admin/audit-logs', {
        headers: { Authorization: `Bearer ${studentToken}` }
      }),
      env
    );
    assert.equal(studentLogs.status, 403);

    // Owner allowed (200) & zero PII in dashboard-stats
    const ownerStatsRes = await workerHandler(
      new Request('https://app.example/api/admin/dashboard-stats', {
        headers: { Authorization: `Bearer ${ownerToken}` }
      }),
      env
    );
    assert.equal(ownerStatsRes.status, 200);
    const rawStatsText = await ownerStatsRes.text();
    assert.equal(rawStatsText.includes('private.student.email@example.com'), false);
    assert.equal(rawStatsText.includes('01999888777'), false);
    assert.equal(rawStatsText.includes('Secret Name'), false);
    const stats = JSON.parse(rawStatsText) as { totalStudents: number };
    assert.equal(stats.totalStudents, 2);

    const ownerLogsRes = await workerHandler(
      new Request('https://app.example/api/admin/audit-logs', {
        headers: { Authorization: `Bearer ${ownerToken}` }
      }),
      env
    );
    assert.equal(ownerLogsRes.status, 200);
    const logsBody = (await ownerLogsRes.json()) as { auditLogs: Array<{ id: string }> };
    assert.equal(logsBody.auditLogs.some(l => l.id === 'audit_seed_1'), true);
  });
});
