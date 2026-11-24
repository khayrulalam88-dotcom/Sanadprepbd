import test, { describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
  buildEditUserSubmitPayload,
  formatDateToLocalDateTimeInput,
  parseLocalDateTimeInputToIso,
  parseLocalDateTimeInputToMs
} from '../src/lib/dateHelpers.ts';
import { buildManualQuestionInput } from '../src/lib/adminQuestionHelpers.ts';
import {
  escapeSqliteLikePattern,
  querySanitizedQuestionsFromD1,
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

function createPhase46FirestoreStub() {
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

    if (urlStr === `${expectedPrefix}:batchGet`) {
      const body = JSON.parse(String(init?.body || '{}')) as { documents?: string[] };
      const results: unknown[] = [];
      for (const docPath of body.documents || []) {
        const parts = docPath.split('/documents/')[1]?.split('/') || [];
        const col = parts[0];
        const docId = parts.slice(1).join('/');
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
          limit?: number;
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
      let rows: unknown[] = [];
      for (const [docId, doc] of getCol(col).entries()) {
        if (filters.every(f => doc[f.field] === f.value)) {
          rows.push({ document: formatDoc(col, docId, doc) });
        }
      }
      if (body.structuredQuery?.limit) {
        rows = rows.slice(0, body.structuredQuery.limit);
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
      const docId = decodeURIComponent(parts.slice(1).join('/'));

      if (method === 'GET' && !docId) {
        const allDocs = Array.from(getCol(col).entries()).map(([id, data]) => formatDoc(col, id, data));
        const params = new URLSearchParams(qs || '');
        const pageSize = Number(params.get('pageSize') || '500');
        return new Response(JSON.stringify({ documents: allDocs.slice(0, pageSize) }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      if (method === 'GET' && docId) {
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
    getCollection(col: string): Array<Record<string, unknown> & { id: string }> {
      return Array.from(getCol(col).entries()).map(([id, data]) => ({ ...data, id }));
    }
  };
}

function makeSampleServerQuestion(overrides: Partial<ServerQuestion> & { id: string }): ServerQuestion {
  return {
    subjectId: 'sub_cpc',
    questionBn: `প্রশ্ন ${overrides.id}`,
    questionEn: `Question ${overrides.id}`,
    optionsBn: ['ক', 'খ', 'গ', 'ঘ'],
    optionsEn: ['A', 'B', 'C', 'D'],
    correctOptionIndex: 1,
    explanationBn: `ব্যাখ্যা ${overrides.id}`,
    explanationEn: `Explanation ${overrides.id}`,
    legalReference: 'CPC Section 9',
    difficulty: 'medium',
    status: 'published',
    isDemoSample: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

describe('Phase 4.6 Targeted Bug Fixes & Regression Suite', () => {
  beforeEach(() => {
    clearFirebaseJwksCacheForTests();
  });

  // =========================================================================
  // TASK 1 — FIX STUDENT EMAIL ERASURE (CRITICAL)
  // =========================================================================
  test('Task 1: GET /api/admin/subscriptions returns studentEmail and POST /api/admin/users/update never erases email', async () => {
    const db = await createMigratedTestD1();
    const authKeys = await generateRs256Keypair('kid_p46_t1');
    const stub = createPhase46FirestoreStub();
    const fixedNowMs = Date.UTC(2026, 10, 17, 10, 0, 0);

    const existingEmail = 'rahim.advocate@example.com';
    const expiresAt = '2027-02-15T12:00:00.000Z';

    stub.seedDoc('users', 'student_email_safe', {
      uid: 'student_email_safe',
      name: 'Rahim Uddin',
      email: existingEmail,
      phone: '01711112222',
      role: 'student',
      subscriptionStatus: 'pro',
      subscriptionExpiresAt: expiresAt,
      activePackageId: 'pkg_pro_mock',
      activePackageNameBn: 'প্রো মডেল টেস্ট পাস',
      activePackageNameEn: 'Pro Model Test Pass',
      createdAt: '2026-01-10T00:00:00.000Z',
      avatarUrl: 'https://example.com/avatar.png'
    });
    stub.seedDoc('subscriptions', 'sub_rahim_1', {
      id: 'sub_rahim_1',
      userId: 'student_email_safe',
      studentName: 'Rahim Uddin',
      studentPhone: '01711112222',
      packageId: 'pkg_pro_mock',
      packageNameBn: 'প্রো মডেল টেস্ট পাস',
      packageNameEn: 'Pro Model Test Pass',
      pricePaid: 300,
      paymentRequestId: 'trx_RAHIM123',
      paymentMethod: 'bKash',
      transactionId: 'RAHIM123',
      validityType: 'days',
      status: 'active',
      activatedAt: '2026-11-01T00:00:00.000Z',
      expiresAt,
      createdAt: '2026-11-01T00:00:00.000Z'
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

    // 1. Verify GET /api/admin/subscriptions populates studentEmail from users collection
    const subsRes = await handler(
      new Request('https://worker.test/api/admin/subscriptions', {
        headers: { Authorization: `Bearer ${ownerToken}` }
      }),
      env
    );
    assert.equal(subsRes.status, 200);
    const subsBody = (await subsRes.json()) as {
      subscriptions: Array<{ id: string; studentEmail?: string }>;
    };
    assert.equal(subsBody.subscriptions[0]?.studentEmail, existingEmail);

    // 2. Client EditUserModal payload helper never submits empty email if cleared
    const payloadCleared = buildEditUserSubmitPayload({
      userId: 'student_email_safe',
      subscriptionId: 'sub_rahim_1',
      name: 'Rahim Uddin Updated',
      email: '   ',
      initialEmail: existingEmail,
      phone: '01799998888',
      role: 'student',
      subscriptionStatus: 'pro',
      packageId: 'pkg_pro_mock',
      expiryDateInput: formatDateToLocalDateTimeInput(expiresAt),
      initialDateInput: formatDateToLocalDateTimeInput(expiresAt),
      originalExpiresAtIso: expiresAt
    });
    assert.equal('email' in payloadCleared, false);
    assert.equal(payloadCleared.expiresAt, expiresAt);

    // 3. Editing name & phone with empty email `""` preserves existingUserDoc.email and unrelated fields
    const updateEmptyEmailRes = await handler(
      new Request('https://worker.test/api/admin/users/update', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          userId: 'student_email_safe',
          subscriptionId: 'sub_rahim_1',
          name: 'Rahim Uddin Updated',
          email: '',
          phone: '01799998888',
          role: 'student',
          subscriptionStatus: 'pro',
          expiresAt: '2027-03-15T12:00:00.000Z'
        })
      }),
      env
    );
    assert.equal(updateEmptyEmailRes.status, 200);
    const updateEmptyBody = (await updateEmptyEmailRes.json()) as {
      user: { email: string; name: string; activePackageId: string };
    };
    assert.equal(updateEmptyBody.user.email, existingEmail);
    assert.equal(updateEmptyBody.user.name, 'Rahim Uddin Updated');
    assert.equal(updateEmptyBody.user.activePackageId, 'pkg_pro_mock');

    const storedUserAfterEmpty = stub.getDoc('users', 'student_email_safe');
    assert.equal(storedUserAfterEmpty?.email, existingEmail);
    assert.equal(storedUserAfterEmpty?.avatarUrl, 'https://example.com/avatar.png');
    assert.equal(storedUserAfterEmpty?.createdAt, '2026-01-10T00:00:00.000Z');

    // 4. Editing with omitted email preserves existingUserDoc.email
    const updateOmittedEmailRes = await handler(
      new Request('https://worker.test/api/admin/users/update', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          userId: 'student_email_safe',
          name: 'Rahim Second Edit',
          phone: '01711112222',
          role: 'student',
          subscriptionStatus: 'pro'
        })
      }),
      env
    );
    assert.equal(updateOmittedEmailRes.status, 200);
    assert.equal(stub.getDoc('users', 'student_email_safe')?.email, existingEmail);

    // 5. Invalid intentional email returns 400 INVALID_EMAIL and preserves stored email
    const badEmailRes = await handler(
      new Request('https://worker.test/api/admin/users/update', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          userId: 'student_email_safe',
          name: 'Rahim',
          email: 'not-a-valid-email',
          phone: '01711112222',
          role: 'student',
          subscriptionStatus: 'pro'
        })
      }),
      env
    );
    assert.equal(badEmailRes.status, 400);
    assert.equal(stub.getDoc('users', 'student_email_safe')?.email, existingEmail);

    // 6. Valid intentional email change validates & normalizes (trimmed + lowercased)
    const intentionalEmailRes = await handler(
      new Request('https://worker.test/api/admin/users/update', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          userId: 'student_email_safe',
          name: 'Rahim',
          email: '  Rahim.New@BarCouncil.ORG  ',
          phone: '01711112222',
          role: 'student',
          subscriptionStatus: 'pro'
        })
      }),
      env
    );
    assert.equal(intentionalEmailRes.status, 200);
    assert.equal(stub.getDoc('users', 'student_email_safe')?.email, 'rahim.new@barcouncil.org');
  });

  // =========================================================================
  // TASK 2 — FIX BANGLADESH TIMEZONE EXPIRY BUG (UTC+6 Asia/Dhaka)
  // =========================================================================
  test('Task 2: EditUserModal datetime-local conversion preserves unchanged timestamps in UTC+6 (Asia/Dhaka)', () => {
    const script = `
      import assert from 'node:assert/strict';
      import {
        formatDateToLocalDateTimeInput,
        parseLocalDateTimeInputToIso,
        parseLocalDateTimeInputToMs,
        buildEditUserSubmitPayload
      } from './src/lib/dateHelpers.ts';

      // Verify runtime timezone is indeed Asia/Dhaka (UTC+6)
      assert.equal(new Date('2026-11-28T03:00:00.000Z').getTimezoneOffset(), -360);

      // 03:00 UTC is 09:00 BDT (UTC+6)
      const iso1 = '2026-11-28T03:00:00.000Z';
      const localInput1 = formatDateToLocalDateTimeInput(iso1);
      assert.equal(localInput1, '2026-11-28T09:00');
      assert.equal(parseLocalDateTimeInputToIso(localInput1), iso1);

      // Crossing UTC midnight: 20:30 UTC on June 15 is 02:30 BDT on June 16
      const isoMidnight = '2026-06-15T20:30:00.000Z';
      const localMidnight = formatDateToLocalDateTimeInput(isoMidnight);
      assert.equal(localMidnight, '2026-06-16T02:30');
      assert.equal(parseLocalDateTimeInputToIso(localMidnight), isoMidnight);

      // Unchanged sub-minute precision stays 100% identical
      const isoPrecise = '2026-11-28T03:00:45.123Z';
      const localPrecise = formatDateToLocalDateTimeInput(isoPrecise);
      assert.equal(localPrecise, '2026-11-28T09:00');
      const payload = buildEditUserSubmitPayload({
        userId: 'u_bd',
        name: 'BD Student',
        email: 'BD.Student@Example.com',
        initialEmail: 'bd.student@example.com',
        phone: '01712345678',
        role: 'student',
        subscriptionStatus: 'pro',
        expiryDateInput: localPrecise,
        initialDateInput: localPrecise,
        originalExpiresAtIso: isoPrecise
      });
      assert.equal(payload.expiresAt, isoPrecise);
      assert.equal(payload.email, 'bd.student@example.com');

      // Quick Extend (+30 days) adds exactly 30 * 24h without a 6h offset drift
      const baseMs = parseLocalDateTimeInputToMs(localInput1);
      const extendedLocal = formatDateToLocalDateTimeInput(new Date(baseMs + 30 * 24 * 3600 * 1000));
      assert.equal(extendedLocal, '2026-12-28T09:00');
      assert.equal(parseLocalDateTimeInputToIso(extendedLocal), '2026-12-28T03:00:00.000Z');
      console.log('UTC_PLUS_6_VERIFIED');
    `;

    const out = execFileSync(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '-e', script],
      {
        cwd: process.cwd(),
        env: { ...process.env, TZ: 'Asia/Dhaka' },
        encoding: 'utf-8'
      }
    );
    assert.match(out, /UTC_PLUS_6_VERIFIED/);
  });

  // =========================================================================
  // TASK 3 — FIX MANUAL QUESTION CREATION
  // =========================================================================
  test('Task 3: Manual question creation defaults isDemoSample to false and stays excluded from demo pool', async () => {
    // 1. Verify AdminPanel payload helper default vs explicit demo selection
    const paidInput = buildManualQuestionInput({
      subjectId: 'sub_cpc',
      questionBn: 'পেইড প্রশ্ন ১',
      optionsBn: ['ক', 'খ', 'গ', 'ঘ'],
      correctOptionIndex: 1,
      explanationBn: 'ব্যাখ্যা',
      legalReference: 'CPC Sec 151',
      difficulty: 'medium',
      status: 'published'
    });
    assert.equal(paidInput.isDemoSample, false);

    const demoInput = buildManualQuestionInput({
      subjectId: 'sub_cpc',
      questionBn: 'ডেমো প্রশ্ন ১',
      optionsBn: ['ক', 'খ', 'গ', 'ঘ'],
      correctOptionIndex: 0,
      difficulty: 'easy',
      status: 'published',
      isDemoSample: true
    });
    assert.equal(demoInput.isDemoSample, true);

    // 2. Verify end-to-end Worker API behavior
    const db = await createMigratedTestD1();
    const authKeys = await generateRs256Keypair('kid_p46_t3');
    const stub = createPhase46FirestoreStub();
    const fixedNowMs = Date.UTC(2026, 10, 17, 10, 0, 0);

    stub.seedDoc('config', 'questionBankVersion', {
      version: 1,
      versionToken: 'v_init',
      updatedAt: '2026-11-01T00:00:00.000Z'
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

    const studentToken = await signJwt(authKeys.privateKey, authKeys.kid, {
      aud: EXPECTED_FIREBASE_PROJECT_ID,
      iss: `https://securetoken.google.com/${EXPECTED_FIREBASE_PROJECT_ID}`,
      sub: 'free_student_t3',
      user_id: 'free_student_t3',
      email: 'free@example.com',
      email_verified: true,
      iat: Math.floor(fixedNowMs / 1000) - 10,
      exp: Math.floor(fixedNowMs / 1000) + 3600
    });

    // Save paid manual question (default isDemoSample: false) and explicit demo question
    const savePaidRes = await handler(
      new Request('https://worker.test/api/admin/questions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ id: 'q_manual_paid', ...paidInput })
      }),
      env
    );
    assert.equal(savePaidRes.status, 200);
    const savePaidBody = (await savePaidRes.json()) as { question: { isDemoSample: boolean } };
    assert.equal(savePaidBody.question.isDemoSample, false);

    const saveDemoRes = await handler(
      new Request('https://worker.test/api/admin/questions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ id: 'q_manual_demo', ...demoInput })
      }),
      env
    );
    assert.equal(saveDemoRes.status, 200);

    // Create student session
    const sessRes = await handler(
      new Request('https://worker.test/api/auth/session', {
        method: 'POST',
        headers: { Authorization: `Bearer ${studentToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ userName: 'Free Student' })
      }),
      env
    );
    const { sessionId } = (await sessRes.json()) as { sessionId: string };

    // Demo endpoint must return ONLY demo question (not manual paid question)
    const demoPoolRes = await handler(
      new Request('https://worker.test/api/questions?demoOnly=true', {
        headers: { Authorization: `Bearer ${studentToken}`, 'X-Session-Id': sessionId }
      }),
      env
    );
    assert.equal(demoPoolRes.status, 200);
    const demoPoolBody = (await demoPoolRes.json()) as { questions: Array<{ id: string }> };
    assert.deepEqual(
      demoPoolBody.questions.map(q => q.id),
      ['q_manual_demo']
    );

    // Free student cannot practice paid manual question, CAN practice explicit demo question
    const paidPracticeRes = await handler(
      new Request('https://worker.test/api/practice/check', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${studentToken}`,
          'X-Session-Id': sessionId,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ questionId: 'q_manual_paid', selectedOption: 1 })
      }),
      env
    );
    assert.equal(paidPracticeRes.status, 403);

    const demoPracticeRes = await handler(
      new Request('https://worker.test/api/practice/check', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${studentToken}`,
          'X-Session-Id': sessionId,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ questionId: 'q_manual_demo', selectedOption: 0 })
      }),
      env
    );
    assert.equal(demoPracticeRes.status, 200);
    const demoPracticeBody = (await demoPracticeRes.json()) as { isCorrect?: boolean };
    assert.equal(demoPracticeBody.isCorrect, true);
  });

  // =========================================================================
  // TASK 4 — FIX SUBSCRIPTION REVOCATION (MULTI-SUBSCRIPTION SAFETY)
  // =========================================================================
  test('Task 4: Changing student to free/expired revokes ALL active subscriptions while preserving history & other users', async () => {
    const db = await createMigratedTestD1();
    const authKeys = await generateRs256Keypair('kid_p46_t4');
    const stub = createPhase46FirestoreStub();
    const fixedNowMs = Date.UTC(2026, 10, 17, 10, 0, 0);

    stub.seedDoc('users', 'student_multi', {
      uid: 'student_multi',
      name: 'Multi Sub Student',
      email: 'multi@example.com',
      phone: '01755556666',
      role: 'student',
      subscriptionStatus: 'pro',
      subscriptionExpiresAt: '2027-06-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z'
    });

    // Historical already-expired sub + two overlapping active subs for student_multi
    stub.seedDoc('subscriptions', 'sub_hist_expired', {
      id: 'sub_hist_expired',
      userId: 'student_multi',
      studentName: 'Multi Sub Student',
      studentPhone: '01755556666',
      packageId: 'pkg_monthly',
      packageNameBn: 'মাসিক',
      packageNameEn: 'Monthly Pass',
      pricePaid: 150,
      paymentRequestId: 'trx_OLD1',
      paymentMethod: 'bKash',
      transactionId: 'OLD1',
      validityType: 'days',
      status: 'expired',
      activatedAt: '2025-12-01T00:00:00.000Z',
      expiresAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2025-12-01T00:00:00.000Z'
    });
    stub.seedDoc('subscriptions', 'sub_active_1', {
      id: 'sub_active_1',
      userId: 'student_multi',
      studentName: 'Multi Sub Student',
      studentPhone: '01755556666',
      packageId: 'pkg_pro_mock',
      packageNameBn: 'প্রো মডেল টেস্ট পাস',
      packageNameEn: 'Pro Model Test Pass',
      pricePaid: 300,
      paymentRequestId: 'trx_ACT1',
      paymentMethod: 'bKash',
      transactionId: 'ACT1',
      validityType: 'days',
      status: 'active',
      activatedAt: '2026-10-01T00:00:00.000Z',
      expiresAt: '2027-04-01T00:00:00.000Z',
      createdAt: '2026-10-01T00:00:00.000Z'
    });
    stub.seedDoc('subscriptions', 'sub_active_2', {
      id: 'sub_active_2',
      userId: 'student_multi',
      studentName: 'Multi Sub Student',
      studentPhone: '01755556666',
      packageId: 'pkg_long_course',
      packageNameBn: 'লং কোর্স',
      packageNameEn: 'Long Course Pass',
      pricePaid: 1200,
      paymentRequestId: 'trx_ACT2',
      paymentMethod: 'Nagad',
      transactionId: 'ACT2',
      validityType: 'days',
      status: 'active',
      activatedAt: '2026-11-01T00:00:00.000Z',
      expiresAt: '2027-06-01T00:00:00.000Z',
      createdAt: '2026-11-01T00:00:00.000Z'
    });

    // Historical payment request & audit log must remain untouched
    stub.seedDoc('paymentRequests', 'trx_ACT1', {
      id: 'trx_ACT1',
      userId: 'student_multi',
      transactionId: 'ACT1',
      amount: 300,
      status: 'approved'
    });

    // Unrelated student active subscription must NEVER be modified
    stub.seedDoc('subscriptions', 'sub_other_user', {
      id: 'sub_other_user',
      userId: 'student_bystander',
      studentName: 'Bystander',
      studentPhone: '01800000000',
      packageId: 'pkg_pro_mock',
      packageNameBn: 'প্রো',
      packageNameEn: 'Pro',
      pricePaid: 300,
      paymentRequestId: 'trx_OTHER',
      paymentMethod: 'bKash',
      transactionId: 'OTHER1',
      validityType: 'days',
      status: 'active',
      activatedAt: '2026-11-01T00:00:00.000Z',
      expiresAt: '2027-05-01T00:00:00.000Z',
      createdAt: '2026-11-01T00:00:00.000Z'
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

    const studentToken = await signJwt(authKeys.privateKey, authKeys.kid, {
      aud: EXPECTED_FIREBASE_PROJECT_ID,
      iss: `https://securetoken.google.com/${EXPECTED_FIREBASE_PROJECT_ID}`,
      sub: 'student_multi',
      user_id: 'student_multi',
      email: 'multi@example.com',
      email_verified: true,
      iat: Math.floor(fixedNowMs / 1000) - 10,
      exp: Math.floor(fixedNowMs / 1000) + 3600
    });

    // Reject cross-user subscriptionId mismatch
    const mismatchRes = await handler(
      new Request('https://worker.test/api/admin/users/update', {
        method: 'POST',
        headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: 'student_multi',
          subscriptionId: 'sub_other_user',
          name: 'Multi Sub Student',
          phone: '01755556666',
          role: 'student',
          subscriptionStatus: 'free'
        })
      }),
      env
    );
    assert.equal(mismatchRes.status, 403);
    assert.equal(stub.getDoc('subscriptions', 'sub_other_user')?.status, 'active');

    // Revoke student_multi to FREE (even when editing from sub_active_2 specifically!)
    const revokeFreeRes = await handler(
      new Request('https://worker.test/api/admin/users/update', {
        method: 'POST',
        headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: 'student_multi',
          subscriptionId: 'sub_active_2',
          name: 'Multi Sub Student',
          phone: '01755556666',
          role: 'student',
          subscriptionStatus: 'free'
        })
      }),
      env
    );
    assert.equal(revokeFreeRes.status, 200);
    const revokeBody = (await revokeFreeRes.json()) as {
      revokedSubscriptionCount: number;
      updatedSubscriptions: Array<{ id: string; status: string }>;
    };
    assert.equal(revokeBody.revokedSubscriptionCount, 2);

    // ALL active subscriptions of student_multi must now be cancelled
    assert.equal(stub.getDoc('subscriptions', 'sub_active_1')?.status, 'cancelled');
    assert.equal(stub.getDoc('subscriptions', 'sub_active_2')?.status, 'cancelled');
    // Historical expired record, payment history, email, and bystander user must remain intact
    assert.equal(stub.getDoc('subscriptions', 'sub_hist_expired')?.status, 'expired');
    assert.equal(stub.getDoc('paymentRequests', 'trx_ACT1')?.status, 'approved');
    assert.equal(stub.getDoc('users', 'student_multi')?.email, 'multi@example.com');
    assert.equal(stub.getDoc('subscriptions', 'sub_other_user')?.status, 'active');
    assert.ok(stub.getCollection('auditLogs').some(l => l.action === 'USER_EDITED_BY_ADMIN'));

    // Student active subscription check now returns false!
    const sessRes = await handler(
      new Request('https://worker.test/api/auth/session', {
        method: 'POST',
        headers: { Authorization: `Bearer ${studentToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ userName: 'Multi' })
      }),
      env
    );
    const { sessionId } = (await sessRes.json()) as { sessionId: string };
    const activeCheckRes = await handler(
      new Request('https://worker.test/api/subscriptions/active/student_multi', {
        headers: { Authorization: `Bearer ${studentToken}`, 'X-Session-Id': sessionId }
      }),
      env
    );
    const activeCheckBody = (await activeCheckRes.json()) as { hasActiveSubscription: boolean };
    assert.equal(activeCheckBody.hasActiveSubscription, false);

    // Re-seed two active subscriptions and verify setting status = 'expired' expires BOTH
    stub.seedDoc('subscriptions', 'sub_active_1', {
      ...stub.getDoc('subscriptions', 'sub_active_1')!,
      status: 'active'
    });
    stub.seedDoc('subscriptions', 'sub_active_2', {
      ...stub.getDoc('subscriptions', 'sub_active_2')!,
      status: 'active'
    });
    const expireAllRes = await handler(
      new Request('https://worker.test/api/admin/users/update', {
        method: 'POST',
        headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: 'student_multi',
          name: 'Multi Sub Student',
          phone: '01755556666',
          role: 'student',
          subscriptionStatus: 'expired'
        })
      }),
      env
    );
    assert.equal(expireAllRes.status, 200);
    assert.equal(stub.getDoc('subscriptions', 'sub_active_1')?.status, 'expired');
    assert.equal(stub.getDoc('subscriptions', 'sub_active_2')?.status, 'expired');
    assert.equal(stub.getDoc('subscriptions', 'sub_other_user')?.status, 'active');
  });

  // =========================================================================
  // TASK 5 — FIX SQLITE SEARCH WILDCARDS
  // =========================================================================
  test('Task 5: SQLite D1 LIKE search escapes %, _, and backslashes safely while preserving normal search', async () => {
    const db = await createMigratedTestD1();

    assert.equal(escapeSqliteLikePattern('100%_a\\b'), '100\\%\\_a\\\\b');

    const seeds: ServerQuestion[] = [
      makeSampleServerQuestion({
        id: 'q_pct_literal',
        questionEn: 'Penalty rate is 100% under this clause',
        legalReference: 'Penal Code Sec 50'
      }),
      makeSampleServerQuestion({
        id: 'q_pct_decoy',
        questionEn: 'Penalty rate is 1000 taka fine under this clause',
        legalReference: 'Penal Code Sec 51'
      }),
      makeSampleServerQuestion({
        id: 'q_under_literal',
        questionEn: 'Refer to identifier sec_9 in pleadings',
        legalReference: 'CPC sec_9'
      }),
      makeSampleServerQuestion({
        id: 'q_under_decoy',
        questionEn: 'Refer to identifier secX9 in pleadings',
        legalReference: 'CPC secX9'
      }),
      makeSampleServerQuestion({
        id: 'q_backslash_literal',
        questionEn: 'Path record contains C:\\law\\section9 entry',
        legalReference: 'Evidence Act Section 9'
      })
    ];

    for (const q of seeds) {
      await upsertSingleQuestionCacheD1(db, q, 'v_test', '2026-11-17T00:00:00.000Z');
    }

    // Search literal "100%" -> matches ONLY q_pct_literal, NOT q_pct_decoy ("1000...")
    const pctRes = await querySanitizedQuestionsFromD1(db, { search: '100%' });
    assert.deepEqual(
      pctRes.questions.map(q => q.id),
      ['q_pct_literal']
    );

    // Search literal "sec_9" -> matches ONLY q_under_literal, NOT q_under_decoy ("secX9")
    const underRes = await querySanitizedQuestionsFromD1(db, { search: 'sec_9' });
    assert.deepEqual(
      underRes.questions.map(q => q.id),
      ['q_under_literal']
    );

    // Search literal "\\law\\" -> matches ONLY q_backslash_literal
    const bsRes = await querySanitizedQuestionsFromD1(db, { search: '\\law\\' });
    assert.deepEqual(
      bsRes.questions.map(q => q.id),
      ['q_backslash_literal']
    );

    // Normal search continues to work case-insensitively
    const normalRes = await querySanitizedQuestionsFromD1(db, { search: 'section 9' });
    assert.deepEqual(
      normalRes.questions.map(q => q.id),
      ['q_backslash_literal']
    );

    // SQL injection payload does not break query or mutate table
    const sqliRes = await querySanitizedQuestionsFromD1(db, {
      search: "'; DROP TABLE question_bank_cache; --"
    });
    assert.equal(sqliRes.total, 0);
    assert.equal(sqliRes.questions.length, 0);

    const allAfterSqli = await querySanitizedQuestionsFromD1(db);
    assert.equal(allAfterSqli.total, seeds.length);
  });

  // =========================================================================
  // TASK 6 — ADMIN SESSION SECURITY REVIEW
  // =========================================================================
  test('Task 6: All /api/admin/* endpoints enforce strict Owner Auth while remaining compatible with Owner session flows', async () => {
    const db = await createMigratedTestD1();
    const authKeys = await generateRs256Keypair('kid_p46_t6');
    const stub = createPhase46FirestoreStub();
    const fixedNowMs = Date.UTC(2026, 10, 17, 10, 0, 0);

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

    const studentToken = await signJwt(authKeys.privateKey, authKeys.kid, {
      aud: EXPECTED_FIREBASE_PROJECT_ID,
      iss: `https://securetoken.google.com/${EXPECTED_FIREBASE_PROJECT_ID}`,
      sub: 'student_attacker',
      user_id: 'student_attacker',
      email: 'attacker@example.com',
      email_verified: true,
      iat: Math.floor(fixedNowMs / 1000) - 10,
      exp: Math.floor(fixedNowMs / 1000) + 3600
    });

    const spoofedOwnerEmailToken = await signJwt(authKeys.privateKey, authKeys.kid, {
      aud: EXPECTED_FIREBASE_PROJECT_ID,
      iss: `https://securetoken.google.com/${EXPECTED_FIREBASE_PROJECT_ID}`,
      sub: OWNER_ADMIN_UID,
      user_id: OWNER_ADMIN_UID,
      email: 'fake-admin@example.com',
      email_verified: true,
      iat: Math.floor(fixedNowMs / 1000) - 10,
      exp: Math.floor(fixedNowMs / 1000) + 3600
    });

    const unverifiedOwnerToken = await signJwt(authKeys.privateKey, authKeys.kid, {
      aud: EXPECTED_FIREBASE_PROJECT_ID,
      iss: `https://securetoken.google.com/${EXPECTED_FIREBASE_PROJECT_ID}`,
      sub: OWNER_ADMIN_UID,
      user_id: OWNER_ADMIN_UID,
      email: OWNER_ADMIN_EMAIL,
      email_verified: false,
      iat: Math.floor(fixedNowMs / 1000) - 10,
      exp: Math.floor(fixedNowMs / 1000) + 3600
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

    const adminRoutes: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [
      { method: 'GET', path: '/api/admin/questions' },
      { method: 'POST', path: '/api/admin/questions', body: {} },
      { method: 'POST', path: '/api/admin/questions/invalidate-cache', body: {} },
      { method: 'DELETE', path: '/api/admin/questions/q1' },
      { method: 'GET', path: '/api/admin/payments' },
      { method: 'POST', path: '/api/admin/payments/p1/approve', body: {} },
      { method: 'POST', path: '/api/admin/payments/p1/reject', body: {} },
      { method: 'GET', path: '/api/admin/subscriptions' },
      { method: 'GET', path: '/api/admin/packages' },
      { method: 'POST', path: '/api/admin/packages/update', body: {} },
      { method: 'POST', path: '/api/admin/exam-config', body: {} },
      { method: 'POST', path: '/api/admin/payment-settings', body: {} },
      { method: 'POST', path: '/api/admin/support-settings', body: {} },
      { method: 'POST', path: '/api/admin/users/update', body: {} },
      { method: 'POST', path: '/api/admin/exams/save', body: {} },
      { method: 'GET', path: '/api/admin/dashboard-stats' },
      { method: 'GET', path: '/api/admin/audit-logs' },
      { method: 'POST', path: '/api/admin/migrate-timestamps', body: {} },
      { method: 'POST', path: '/api/admin/import-questions-to-firestore', body: {} }
    ];

    for (const r of adminRoutes) {
      // Unauthenticated -> 401
      const unauthRes = await handler(
        new Request(`https://worker.test${r.path}`, {
          method: r.method,
          ...(r.body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r.body) } : {})
        }),
        env
      );
      assert.equal(unauthRes.status, 401, `Expected 401 for unauthenticated ${r.method} ${r.path}`);

      // Verified Student -> 403
      const studentRes = await handler(
        new Request(`https://worker.test${r.path}`, {
          method: r.method,
          headers: {
            Authorization: `Bearer ${studentToken}`,
            ...(r.body ? { 'Content-Type': 'application/json' } : {})
          },
          ...(r.body ? { body: JSON.stringify(r.body) } : {})
        }),
        env
      );
      assert.equal(studentRes.status, 403, `Expected 403 for student ${r.method} ${r.path}`);

      // Spoofed email on Owner UID -> 403
      const spoofRes = await handler(
        new Request(`https://worker.test${r.path}`, {
          method: r.method,
          headers: {
            Authorization: `Bearer ${spoofedOwnerEmailToken}`,
            ...(r.body ? { 'Content-Type': 'application/json' } : {})
          },
          ...(r.body ? { body: JSON.stringify(r.body) } : {})
        }),
        env
      );
      assert.equal(spoofRes.status, 403, `Expected 403 for spoofed email ${r.method} ${r.path}`);

      // Unverified Owner token -> 403
      const unverifiedRes = await handler(
        new Request(`https://worker.test${r.path}`, {
          method: r.method,
          headers: {
            Authorization: `Bearer ${unverifiedOwnerToken}`,
            ...(r.body ? { 'Content-Type': 'application/json' } : {})
          },
          ...(r.body ? { body: JSON.stringify(r.body) } : {})
        }),
        env
      );
      assert.equal(unverifiedRes.status, 403, `Expected 403 for unverified owner ${r.method} ${r.path}`);
    }

    // Compatibility check: Owner Admin endpoints still work even if Owner's D1 session was revoked/superseded
    // (preserving Owner Admin recovery and multi-device administration while Firebase RS256 ID token is valid)
    const ownerSess1 = await handler(
      new Request('https://worker.test/api/auth/session', {
        method: 'POST',
        headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ userName: 'Owner Desktop' })
      }),
      env
    );
    const { sessionId: ownerSessId1 } = (await ownerSess1.json()) as { sessionId: string };

    // Simulate concurrent login revoking ownerSessId1
    await handler(
      new Request('https://worker.test/api/auth/session', {
        method: 'POST',
        headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ userName: 'Owner Phone' })
      }),
      env
    );

    const ownerAdminCheck = await handler(
      new Request('https://worker.test/api/admin/dashboard-stats', {
        headers: { Authorization: `Bearer ${ownerToken}`, 'X-Session-Id': ownerSessId1 }
      }),
      env
    );
    assert.equal(ownerAdminCheck.status, 200);
  });
});
