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
  assertOwnerAdmin,
  authenticateFirebaseRequest,
  base64UrlEncodeBytes,
  clearFirebaseJwksCacheForTests,
  isOwnerUser,
  verifyFirebaseIdToken,
  type FirebaseJwk,
  type JwksFetcher
} from '../worker/firebaseAuth.ts';
import {
  assertExpectedNamedDatabase,
  checkUserHasActiveSubscriptionRest,
  clearServiceAccountTokenCacheForTests,
  decodeDocumentFields,
  encodeDocumentFields,
  FirestoreRestClient,
  FirestoreTimestampValue,
  getGoogleAccessToken,
  getSafeDiagnosticError,
  parseServiceAccountJson,
  resolveEffectiveDatabaseId
} from '../worker/firestoreRest.ts';
import {
  consumeRateLimitD1,
  createOrReplaceSessionD1,
  revokeSessionOnLogoutD1,
  validateAndTouchSessionD1
} from '../worker/d1Store.ts';
import {
  checkD1QuestionCacheFreshness,
  getAuthoritativeQuestionKeys,
  readSanitizedQuestionsFromD1,
  upsertSingleQuestionCacheD1
} from '../worker/questionCache.ts';
import { createWorkerHandler, isOriginAllowed, parseAllowedOrigins } from '../worker/index.ts';

// ---------------------------------------------------------------------------
// Real SQLite-backed D1 Adapter (executes actual D1 SQL migration files!)
// ---------------------------------------------------------------------------
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
        if (colName) {
          return (row[colName] as T) ?? null;
        }
        return row as T;
      },
      async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        const prepared = sqlite.prepare(query);
        const hasReturning = /\bRETURNING\b/i.test(query);
        if (hasReturning) {
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
  const mig1 = fs.readFileSync(path.resolve('worker/migrations/0001_initial_edge_state.sql'), 'utf-8');
  const mig2 = fs.readFileSync(path.resolve('worker/migrations/0002_question_bank_cache.sql'), 'utf-8');
  await db.exec(mig1);
  await db.exec(mig2);
  return db;
}

// ---------------------------------------------------------------------------
// Real WebCrypto RSA-2048 Helpers for Firebase JWTs & Service Account Keys
// ---------------------------------------------------------------------------
async function generateRs256Keypair(kid: string): Promise<{
  kid: string;
  privateKey: CryptoKey;
  jwk: FirebaseJwk;
  pkcs8Pem: string;
}> {
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
    jwk: {
      ...exportedPub,
      kid,
      alg: 'RS256',
      use: 'sig'
    },
    pkcs8Pem
  };
}

async function signJwt(
  privateKey: CryptoKey,
  kid: string,
  claims: Record<string, unknown>,
  algOverride?: string
): Promise<string> {
  const encoder = new TextEncoder();
  const headerSeg = base64UrlEncodeBytes(encoder.encode(JSON.stringify({ alg: algOverride || 'RS256', typ: 'JWT', kid })));
  const payloadSeg = base64UrlEncodeBytes(encoder.encode(JSON.stringify(claims)));
  const input = encoder.encode(`${headerSeg}.${payloadSeg}`);
  const buf = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer;
  const sig = await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, privateKey, buf);
  return `${headerSeg}.${payloadSeg}.${base64UrlEncodeBytes(new Uint8Array(sig))}`;
}

// ---------------------------------------------------------------------------
// In-Memory Firestore REST API Stub (Verifies exact REST URLs + Transactions)
// ---------------------------------------------------------------------------
function createFirestoreRestStub(serviceAccountEmail: string) {
  const expectedPrefix = `https://firestore.googleapis.com/v1/projects/${EXPECTED_FIREBASE_PROJECT_ID}/databases/${EXPECTED_FIREBASE_DATABASE_ID}/documents`;
  const collections = new Map<string, Map<string, Record<string, unknown>>>();
  const activeTransactions = new Map<string, boolean>();
  let txCounter = 0;
  let oauthCalls = 0;
  let firestoreHttpCalls = 0;
  let failNextCommitWithAborted = false;

  const setDoc = (col: string, id: string, data: Record<string, unknown>) => {
    let map = collections.get(col);
    if (!map) {
      map = new Map();
      collections.set(col, map);
    }
    map.set(id, { ...data });
  };

  const getCol = (col: string) => {
    let map = collections.get(col);
    if (!map) {
      map = new Map();
      collections.set(col, map);
    }
    return map;
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method || 'GET').toUpperCase();

    if (url === 'https://oauth2.googleapis.com/token') {
      oauthCalls++;
      const bodyStr = String(init?.body || '');
      const params = new URLSearchParams(bodyStr);
      const assertion = params.get('assertion') || '';
      const [, payloadSeg] = assertion.split('.');
      const claims = JSON.parse(Buffer.from(payloadSeg, 'base64url').toString('utf-8')) as Record<string, unknown>;
      assert.equal(claims.iss, serviceAccountEmail);
      assert.equal(claims.scope, 'https://www.googleapis.com/auth/datastore');
      return new Response(
        JSON.stringify({ access_token: `mock_access_token_${oauthCalls}`, expires_in: 3600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    assert.ok(
      url.startsWith(expectedPrefix),
      `Unexpected Firestore URL (named database violation!): ${url}`
    );
    firestoreHttpCalls++;

    const authHeader = new Headers(init?.headers).get('authorization');
    assert.ok(authHeader && authHeader.startsWith('Bearer mock_access_token_'), 'Missing OAuth2 Bearer token');

    const restPath = url.slice(expectedPrefix.length);

    if (restPath === ':beginTransaction' && method === 'POST') {
      txCounter++;
      const txId = `tx_${txCounter}`;
      activeTransactions.set(txId, true);
      return new Response(JSON.stringify({ transaction: txId }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (restPath === ':rollback' && method === 'POST') {
      const parsed = JSON.parse(String(init?.body || '{}')) as { transaction?: string };
      if (parsed.transaction) activeTransactions.delete(parsed.transaction);
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (restPath === ':commit' && method === 'POST') {
      const parsed = JSON.parse(String(init?.body || '{}')) as {
        transaction?: string;
        writes?: Array<{
          update?: { name: string; fields?: Record<string, any> };
          delete?: string;
          updateMask?: { fieldPaths?: string[] };
          currentDocument?: { exists?: boolean };
        }>;
      };

      if (failNextCommitWithAborted) {
        failNextCommitWithAborted = false;
        return new Response(
          JSON.stringify({ error: { code: 409, status: 'ABORTED', message: 'Simulated contention abort' } }),
          { status: 409, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (parsed.transaction) {
        activeTransactions.delete(parsed.transaction);
      }

      for (const write of parsed.writes || []) {
        if (write.delete) {
          const parts = write.delete.split('/documents/')[1].split('/');
          const [col, docId] = parts;
          getCol(col).delete(decodeURIComponent(docId));
          continue;
        }
        if (write.update) {
          const parts = write.update.name.split('/documents/')[1].split('/');
          const [col, rawDocId] = parts;
          const docId = decodeURIComponent(rawDocId);
          const colMap = getCol(col);
          const existing = colMap.get(docId);

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

          const decoded = decodeDocumentFields(write.update.fields);
          if (write.updateMask?.fieldPaths && existing) {
            const merged = { ...existing };
            for (const fp of write.updateMask.fieldPaths) {
              merged[fp] = decoded[fp];
            }
            colMap.set(docId, merged);
          } else {
            colMap.set(docId, decoded);
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
        return {
          found: {
            name: fullName,
            fields: encodeDocumentFields(found)
          }
        };
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
            compositeFilter?: { filters: Array<{ fieldFilter: { field: { fieldPath: string }; op: string; value: any } }> };
          };
          limit?: number;
        };
      };
      const col = parsed.structuredQuery?.from?.[0]?.collectionId || '';
      const colMap = getCol(col);
      let rows = Array.from(colMap.entries()).map(([id, data]) => ({ id, data }));

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
      const cleanPath = restPath.split('?')[0].slice(1);
      const [col, rawDocId] = cleanPath.split('/');
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
          name: `projects/${EXPECTED_FIREBASE_PROJECT_ID}/databases/${EXPECTED_FIREBASE_DATABASE_ID}/documents/${col}/${rawDocId}`,
          fields: encodeDocumentFields(found)
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    throw new Error(`Unhandled mock Firestore REST call: ${method} ${url}`);
  };

  return {
    fetchImpl,
    collections,
    setDoc,
    getCol,
    setFailNextCommitWithAborted: () => {
      failNextCommitWithAborted = true;
    },
    getMetrics: () => ({ oauthCalls, firestoreHttpCalls })
  };
}

// ---------------------------------------------------------------------------
// PHASE 1 TEST SUITES
// ---------------------------------------------------------------------------
describe('Sanad Prep BD — Cloudflare Worker Phase 1 Test Suite', async () => {
  const keyPrimary = await generateRs256Keypair('kid_primary_v1');
  const keyRotated = await generateRs256Keypair('kid_rotated_v2');
  const saKey = await generateRs256Keypair('sa_key_1');

  const saJsonString = JSON.stringify({
    type: 'service_account',
    project_id: EXPECTED_FIREBASE_PROJECT_ID,
    client_email: 'sanad-worker-sa@galvanic-aviary-tzp2g.iam.gserviceaccount.com',
    private_key: saKey.pkcs8Pem
  });

  beforeEach(() => {
    clearFirebaseJwksCacheForTests();
    clearServiceAccountTokenCacheForTests();
  });

  test('1. D1 Migrations 0001 & 0002 execute cleanly and keep question keys strictly separated', async () => {
    const db = await createMigratedTestD1();
    const tablesRes = await db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all<{ name: string }>();
    const names = tablesRes.results.map(r => r.name);

    assert.ok(names.includes('sessions'));
    assert.ok(names.includes('user_sessions'));
    assert.ok(names.includes('rate_limits'));
    assert.ok(names.includes('question_bank_meta'));
    assert.ok(names.includes('question_bank_cache'));
    assert.ok(names.includes('question_keys_cache'));

    // Ensure sanitized cache table has NO answer key or explanation columns
    const colsRes = await db.prepare(`PRAGMA table_info(question_bank_cache)`).all<{ name: string }>();
    const colNames = colsRes.results.map(c => c.name);
    assert.equal(colNames.includes('correct_option_index'), false);
    assert.equal(colNames.includes('explanation_bn'), false);
    assert.equal(colNames.includes('explanation_en'), false);
  });

  test('2. WebCrypto Firebase ID token verification: RS256, audience, issuer, exp, email_verified, key rotation', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    let currentKeys: FirebaseJwk[] = [keyPrimary.jwk];
    let jwksFetchCount = 0;
    const jwksFetcher: JwksFetcher = async () => {
      jwksFetchCount++;
      return { keys: currentKeys, maxAgeSeconds: 3600 };
    };

    const validClaims = {
      aud: EXPECTED_FIREBASE_PROJECT_ID,
      iss: `https://securetoken.google.com/${EXPECTED_FIREBASE_PROJECT_ID}`,
      sub: 'student_uid_001',
      user_id: 'student_uid_001',
      email: 'student001@example.com',
      email_verified: true,
      name: 'Rahim Uddin',
      iat: nowSec - 60,
      auth_time: nowSec - 60,
      exp: nowSec + 3600
    };

    const validToken = await signJwt(keyPrimary.privateKey, keyPrimary.kid, validClaims);
    const decoded = await verifyFirebaseIdToken(validToken, {
      projectId: EXPECTED_FIREBASE_PROJECT_ID,
      jwksFetcher,
      nowMs: nowSec * 1000
    });
    assert.equal(decoded.uid, 'student_uid_001');
    assert.equal(decoded.email, 'student001@example.com');
    assert.equal(decoded.emailVerified, true);
    assert.equal(decoded.name, 'Rahim Uddin');

    // Second call uses cached JWKS (1 fetch total)
    await verifyFirebaseIdToken(validToken, {
      projectId: EXPECTED_FIREBASE_PROJECT_ID,
      jwksFetcher,
      nowMs: nowSec * 1000
    });
    assert.equal(jwksFetchCount, 1);

    // Tampered payload rejected
    const parts = validToken.split('.');
    const tamperedPayload = base64UrlEncodeBytes(
      new TextEncoder().encode(JSON.stringify({ ...validClaims, sub: OWNER_ADMIN_UID }))
    );
    await assert.rejects(
      () =>
        verifyFirebaseIdToken(`${parts[0]}.${tamperedPayload}.${parts[2]}`, {
          jwksFetcher,
          nowMs: nowSec * 1000
        }),
      /Invalid JWT signature/
    );

    // Wrong alg rejected
    const wrongAlgToken = await signJwt(keyPrimary.privateKey, keyPrimary.kid, validClaims, 'HS256');
    await assert.rejects(
      () => verifyFirebaseIdToken(wrongAlgToken, { jwksFetcher, nowMs: nowSec * 1000 }),
      /Unsupported JWT algorithm/
    );

    // Wrong audience rejected
    const badAudToken = await signJwt(keyPrimary.privateKey, keyPrimary.kid, {
      ...validClaims,
      aud: 'other-firebase-project'
    });
    await assert.rejects(
      () => verifyFirebaseIdToken(badAudToken, { jwksFetcher, nowMs: nowSec * 1000 }),
      /audience/
    );

    // Wrong issuer rejected
    const badIssToken = await signJwt(keyPrimary.privateKey, keyPrimary.kid, {
      ...validClaims,
      iss: 'https://securetoken.google.com/other-firebase-project'
    });
    await assert.rejects(
      () => verifyFirebaseIdToken(badIssToken, { jwksFetcher, nowMs: nowSec * 1000 }),
      /issuer/
    );

    // Expired token rejected
    const expiredToken = await signJwt(keyPrimary.privateKey, keyPrimary.kid, {
      ...validClaims,
      exp: nowSec - 10
    });
    await assert.rejects(
      () => verifyFirebaseIdToken(expiredToken, { jwksFetcher, nowMs: nowSec * 1000 }),
      /expired/
    );

    // Unverified email rejected with 403 EMAIL_NOT_VERIFIED
    const unverifiedToken = await signJwt(keyPrimary.privateKey, keyPrimary.kid, {
      ...validClaims,
      email_verified: false
    });
    const req = new Request('https://example.com/api/auth/session', {
      headers: { Authorization: `Bearer ${unverifiedToken}` }
    });
    await assert.rejects(
      () => authenticateFirebaseRequest(req, { jwksFetcher, nowMs: nowSec * 1000 }),
      (err: any) => err.status === 403 && err.code === 'EMAIL_NOT_VERIFIED'
    );

    // Key rotation test (simulate >30s elapsed, rotated kid)
    currentKeys = [keyRotated.jwk];
    clearFirebaseJwksCacheForTests();
    const rotatedToken = await signJwt(keyRotated.privateKey, keyRotated.kid, validClaims);
    const decodedRotated = await verifyFirebaseIdToken(rotatedToken, {
      jwksFetcher,
      nowMs: nowSec * 1000
    });
    assert.equal(decodedRotated.uid, 'student_uid_001');
  });

  test('3. Strict Owner Admin UID + verified email gate', () => {
    assert.equal(
      isOwnerUser({
        uid: OWNER_ADMIN_UID,
        email: OWNER_ADMIN_EMAIL,
        emailVerified: true
      }),
      true
    );
    // Spoofed email on Owner UID -> reject
    assert.equal(
      isOwnerUser({
        uid: OWNER_ADMIN_UID,
        email: 'attacker@gmail.com',
        emailVerified: true
      }),
      false
    );
    // Unverified owner email -> reject
    assert.equal(
      isOwnerUser({
        uid: OWNER_ADMIN_UID,
        email: OWNER_ADMIN_EMAIL,
        emailVerified: false
      }),
      false
    );
    // Different UID even with owner email -> reject
    assert.equal(
      isOwnerUser({
        uid: 'other_uid',
        email: OWNER_ADMIN_EMAIL,
        emailVerified: true
      }),
      false
    );
    assert.throws(
      () => assertOwnerAdmin({ uid: 'student_uid', email: OWNER_ADMIN_EMAIL, emailVerified: true }),
      (err: any) => err.status === 403 && err.code === 'FORBIDDEN'
    );
  });

  test('4. Named database guards & Service Account OAuth2 + Firestore REST transactions', async () => {
    // Database naming safeguards
    assert.equal(resolveEffectiveDatabaseId(''), EXPECTED_FIREBASE_DATABASE_ID);
    assert.equal(resolveEffectiveDatabaseId(EXPECTED_FIREBASE_PROJECT_ID), EXPECTED_FIREBASE_DATABASE_ID);
    assert.equal(assertExpectedNamedDatabase({ databaseId: '(default)' }).valid, false);
    assert.equal(assertExpectedNamedDatabase({ databaseId: 'wrong-db' }).valid, false);
    assert.equal(assertExpectedNamedDatabase({ projectId: 'wrong-proj' }).valid, false);
    assert.equal(assertExpectedNamedDatabase().valid, true);

    assert.throws(
      () => parseServiceAccountJson(JSON.stringify({ project_id: 'evil-proj', client_email: 'a', private_key: 'b' })),
      /does not match expected/
    );

    const stub = createFirestoreRestStub('sanad-worker-sa@galvanic-aviary-tzp2g.iam.gserviceaccount.com');
    const client = new FirestoreRestClient({
      serviceAccountJson: saJsonString,
      fetchImpl: stub.fetchImpl
    });

    // Access token caching test
    const creds = parseServiceAccountJson(saJsonString);
    const t1 = await getGoogleAccessToken(creds, { fetchImpl: stub.fetchImpl });
    const t2 = await getGoogleAccessToken(creds, { fetchImpl: stub.fetchImpl });
    assert.equal(t1, t2);
    assert.equal(stub.getMetrics().oauthCalls, 1);

    // Encode/Decode REST values including FirestoreTimestampValue & nested maps/arrays
    const encoded = encodeDocumentFields({
      title: 'Test',
      score: 65.25,
      count: 100,
      active: true,
      note: null,
      tags: ['cpc', 'crpc'],
      expiresAt: new FirestoreTimestampValue('2026-12-31T00:00:00.000Z')
    });
    const decoded = decodeDocumentFields(encoded);
    assert.deepEqual(decoded, {
      title: 'Test',
      score: 65.25,
      count: 100,
      active: true,
      note: null,
      tags: ['cpc', 'crpc'],
      expiresAt: '2026-12-31T00:00:00.000Z'
    });

    // Transaction test with simulated 409 ABORTED retry
    stub.setDoc('packages', 'pkg_long_course', { price: 999, isActive: true });
    stub.setFailNextCommitWithAborted();
    let txAttempts = 0;
    const txOut = await client.runTransaction(async tx => {
      txAttempts++;
      const pkg = await tx.get<{ price: number }>('packages', 'pkg_long_course');
      assert.equal(pkg?.price, 999);
      tx.create('paymentRequests', 'trx_TXN12345', {
        transactionId: 'TXN12345',
        amount: pkg!.price,
        status: 'pending'
      });
      return 'ok';
    });
    assert.equal(txOut, 'ok');
    assert.equal(txAttempts, 2);
    assert.equal(stub.getCol('paymentRequests').get('trx_TXN12345')?.amount, 999);

    // Duplicate createDocument returns 409 ALREADY_EXISTS
    await assert.rejects(
      () => client.createDocument('paymentRequests', 'trx_TXN12345', { transactionId: 'TXN12345' }),
      (err: any) => err.status === 409 && err.code === 'ALREADY_EXISTS'
    );

    // Subscription check (expired vs active)
    const futureIso = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
    const pastIso = new Date(Date.now() - 86400 * 1000).toISOString();
    stub.setDoc('subscriptions', 'sub_expired', {
      userId: 'uid_sub_test',
      status: 'active',
      expiresAt: pastIso
    });
    const expCheck = await checkUserHasActiveSubscriptionRest(client, 'uid_sub_test');
    assert.equal(expCheck.active, false);

    stub.setDoc('subscriptions', 'sub_valid', {
      userId: 'uid_sub_test',
      packageId: 'pkg_monthly',
      status: 'active',
      expiresAt: futureIso
    });
    const okCheck = await checkUserHasActiveSubscriptionRest(client, 'uid_sub_test');
    assert.equal(okCheck.active, true);
    assert.equal(okCheck.activeSubscription?.id, 'sub_valid');

    // Secret redaction
    const redacted = getSafeDiagnosticError(
      new Error(`Failed Bearer eyJabc.def.ghi and -----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY----- AIzaSyFakeKey123456789012345`)
    );
    assert.ok(!redacted.message.includes('SECRET'));
    assert.ok(!redacted.message.includes('eyJabc'));
    assert.ok(!redacted.message.includes('AIzaSyFakeKey'));
  });

  test('5. D1 rate limiter & safe question bank cache (no key leakage)', async () => {
    const db = await createMigratedTestD1();
    const nowMs = 1_700_000_040_000;

    // Rate limit 3 reqs/min -> 4th rejected, next window resets
    for (let i = 1; i <= 3; i++) {
      const r = await consumeRateLimitD1(db, {
        key: 'global:ip_1.2.3.4',
        windowMs: 60_000,
        maxRequests: 3,
        nowMs
      });
      assert.equal(r.allowed, true);
      assert.equal(r.remaining, 3 - i);
    }
    const blocked = await consumeRateLimitD1(db, {
      key: 'global:ip_1.2.3.4',
      windowMs: 60_000,
      maxRequests: 3,
      nowMs
    });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.remaining, 0);

    const nextWindow = await consumeRateLimitD1(db, {
      key: 'global:ip_1.2.3.4',
      windowMs: 60_000,
      maxRequests: 3,
      nowMs: nowMs + 60_000
    });
    assert.equal(nextWindow.allowed, true);
    assert.equal(nextWindow.remaining, 2);

    // Safe Question Bank D1 cache
    const stub = createFirestoreRestStub('sanad-worker-sa@galvanic-aviary-tzp2g.iam.gserviceaccount.com');
    const client = new FirestoreRestClient({
      serviceAccountJson: saJsonString,
      fetchImpl: stub.fetchImpl
    });

    await upsertSingleQuestionCacheD1(
      db,
      {
        id: 'q_cpc_001',
        subjectId: 'sub_cpc',
        questionBn: 'দেওয়ানী কার্যবিধির কত ধারায় রেস জুডিকাটা বর্ণিত?',
        questionEn: 'Which section of CPC deals with Res Judicata?',
        optionsBn: ['ধারা ৯', 'ধারা ১০', 'ধারা ১১', 'ধারা ১২'],
        optionsEn: ['Sec 9', 'Sec 10', 'Sec 11', 'Sec 12'],
        correctOptionIndex: 2,
        explanationBn: 'ধারা ১১-এ Res Judicata আলোচিত হয়েছে।',
        explanationEn: 'Section 11 covers Res Judicata.',
        legalReference: 'Section 11, CPC 1908',
        difficulty: 'medium',
        status: 'published',
        isDemoSample: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      },
      'ver_1'
    );

    const sanitizedList = await readSanitizedQuestionsFromD1(db, { subjectId: 'sub_cpc' });
    assert.equal(sanitizedList.length, 1);
    const leakedFields = sanitizedList[0] as unknown as Record<string, unknown>;
    assert.equal('correctOptionIndex' in leakedFields, false);
    assert.equal('explanationBn' in leakedFields, false);
    assert.equal('explanationEn' in leakedFields, false);

    // Server-side scoring key lookup works cleanly without hitting Firestore when D1 is warm
    const beforeCalls = stub.getMetrics().firestoreHttpCalls;
    const keys = await getAuthoritativeQuestionKeys(db, client, ['q_cpc_001']);
    assert.equal(keys.get('q_cpc_001')?.correctOptionIndex, 2);
    assert.equal(stub.getMetrics().firestoreHttpCalls, beforeCalls);

    // Freshness check within TTL uses 0 Firestore reads
    const freshCheck = await checkD1QuestionCacheFreshness(db, client, { ttlMs: 300_000 });
    assert.equal(freshCheck.fresh, true);
    assert.equal(stub.getMetrics().firestoreHttpCalls, beforeCalls);
  });

  test('6. Worker HTTP endpoints: /health, CORS, /api/auth/session single-device revocation & /api/auth/logout', async () => {
    const db = await createMigratedTestD1();
    const stub = createFirestoreRestStub('sanad-worker-sa@galvanic-aviary-tzp2g.iam.gserviceaccount.com');
    const futureExp = new Date(Date.now() + 30 * 86400 * 1000).toISOString();
    stub.setDoc('subscriptions', 'sub_alpha', {
      userId: 'student_uid_alpha',
      packageId: 'pkg_pro_mock',
      packageNameBn: 'প্রো মক প্যাক',
      packageNameEn: 'Pro Mock Pack',
      pricePaid: 300,
      paymentRequestId: 'trx_ABC',
      paymentMethod: 'bKash',
      transactionId: 'ABC',
      validityType: 'days',
      status: 'active',
      activatedAt: new Date().toISOString(),
      expiresAt: futureExp,
      createdAt: new Date().toISOString()
    });

    const nowSec = Math.floor(Date.now() / 1000);
    const studentToken = await signJwt(keyPrimary.privateKey, keyPrimary.kid, {
      aud: EXPECTED_FIREBASE_PROJECT_ID,
      iss: `https://securetoken.google.com/${EXPECTED_FIREBASE_PROJECT_ID}`,
      sub: 'student_uid_alpha',
      email: 'alpha@example.com',
      email_verified: true,
      name: 'Alpha Student',
      iat: nowSec - 10,
      exp: nowSec + 3600
    });

    const handler = createWorkerHandler({
      jwksFetcher: async () => ({ keys: [keyPrimary.jwk], maxAgeSeconds: 3600 }),
      fetchImpl: stub.fetchImpl,
      rateLimitOverrides: { windowMs: 60_000, globalMax: 100, routeMax: { auth_session: 3 } }
    });

    const env: WorkerEnv = {
      DB: db,
      ENVIRONMENT: 'staging',
      FIREBASE_PROJECT_ID: EXPECTED_FIREBASE_PROJECT_ID,
      FIREBASE_DATABASE_ID: EXPECTED_FIREBASE_DATABASE_ID,
      FIREBASE_SERVICE_ACCOUNT_JSON: saJsonString,
      ALLOWED_ORIGIN: 'https://s--khayrul-alam.khayrulalam88.workers.dev'
    };

    // 6a. /health returns 200 without auth & omits secrets
    const healthRes = await handler(new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/health'), env);
    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.headers.get('X-Frame-Options'), 'DENY');
    const healthText = await healthRes.text();
    assert.ok(!healthText.includes('PRIVATE KEY'));
    const healthJson = JSON.parse(healthText) as Record<string, unknown>;
    assert.equal(healthJson.status, 'ok');
    assert.equal(healthJson.runtime, 'cloudflare-worker');
    assert.equal(healthJson.persistenceMode, 'firestore-rest');
    assert.equal(healthJson.projectId, EXPECTED_FIREBASE_PROJECT_ID);
    assert.equal(healthJson.databaseId, EXPECTED_FIREBASE_DATABASE_ID);
    assert.equal(healthJson.expectedDatabaseMatched, true);

    // 6b. Misconfigured DB fails closed 503 on /health and /api/auth/session
    const badDbRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/health'),
      { ...env, FIREBASE_DATABASE_ID: '(default)' }
    );
    assert.equal(badDbRes.status, 503);

    // 6c. CORS rejection & allowed preflight
    assert.equal(parseAllowedOrigins(env.ALLOWED_ORIGIN).has('https://s--khayrul-alam.khayrulalam88.workers.dev'), true);
    assert.equal(isOriginAllowed('https://evil.example', { isProduction: true, allowedOriginEnv: env.ALLOWED_ORIGIN }), false);

    const evilCorsRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/health', {
        headers: { Origin: 'https://evil.example' }
      }),
      env
    );
    assert.equal(evilCorsRes.status, 403);

    const preflightRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/auth/session', {
        method: 'OPTIONS',
        headers: { Origin: 'https://s--khayrul-alam.khayrulalam88.workers.dev' }
      }),
      env
    );
    assert.equal(preflightRes.status, 204);
    assert.equal(
      preflightRes.headers.get('Access-Control-Allow-Origin'),
      'https://s--khayrul-alam.khayrulalam88.workers.dev'
    );

    // 6d. Unauthenticated /api/auth/session rejected 401
    const unauthRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/auth/session', { method: 'POST' }),
      env
    );
    assert.equal(unauthRes.status, 401);

    // 6e. Device 1 login -> receives sessionId #1 + activeSubscription from Firestore
    const login1Res = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/auth/session', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${studentToken}`,
          'Content-Type': 'application/json',
          'CF-Connecting-IP': '103.10.20.30'
        },
        body: JSON.stringify({ userName: 'Alpha Student', deviceInfo: 'Chrome Desktop' })
      }),
      env
    );
    assert.equal(login1Res.status, 200);
    const login1Json = (await login1Res.json()) as {
      success: boolean;
      sessionId: string;
      session: { userId: string; status: string };
      activeSubscription: { id: string } | null;
    };
    assert.equal(login1Json.success, true);
    assert.equal(login1Json.session.userId, 'student_uid_alpha');
    assert.equal(login1Json.activeSubscription?.id, 'sub_alpha');
    const sess1 = login1Json.sessionId;

    // 6f. Device 2 login -> revokes Device 1 in D1 + writes SESSION_REVOKED_CONCURRENT auditLog in Firestore
    const login2Res = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/auth/session', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${studentToken}`,
          'Content-Type': 'application/json',
          'CF-Connecting-IP': '103.10.20.30'
        },
        body: JSON.stringify({ deviceInfo: 'Android Mobile' })
      }),
      env
    );
    assert.equal(login2Res.status, 200);
    const sess2 = ((await login2Res.json()) as { sessionId: string }).sessionId;
    assert.notEqual(sess1, sess2);

    const auditDocs = Array.from(stub.getCol('auditLogs').values());
    assert.equal(auditDocs.some(a => a.action === 'SESSION_REVOKED_CONCURRENT' && a.userId === 'student_uid_alpha'), true);

    // Device 1 status check -> 401 SESSION_REVOKED
    const status1Res = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/auth/session/status', {
        headers: { Authorization: `Bearer ${studentToken}`, 'X-Session-Id': sess1 }
      }),
      env
    );
    assert.equal(status1Res.status, 401);
    assert.equal(((await status1Res.json()) as { error: string }).error, 'SESSION_REVOKED');

    // Device 2 status check -> 200 active: true
    const status2Res = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/auth/session/status', {
        headers: { Authorization: `Bearer ${studentToken}`, 'X-Session-Id': sess2 }
      }),
      env
    );
    assert.equal(status2Res.status, 200);
    assert.equal(((await status2Res.json()) as { active: boolean }).active, true);

    // 6g. Logout revokes Device 2 cleanly
    const logoutRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${studentToken}`, 'X-Session-Id': sess2 }
      }),
      env
    );
    assert.equal(logoutRes.status, 200);

    const status2AfterLogout = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/auth/session/status', {
        headers: { Authorization: `Bearer ${studentToken}`, 'X-Session-Id': sess2 }
      }),
      env
    );
    assert.equal(status2AfterLogout.status, 401);

    // 6h. Auth session per-UID rate limit triggers 429 on 4th login in same minute
    await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/auth/session', {
        method: 'POST',
        headers: { Authorization: `Bearer ${studentToken}` }
      }),
      env
    );
    const rateLimitedLogin = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/auth/session', {
        method: 'POST',
        headers: { Authorization: `Bearer ${studentToken}` }
      }),
      env
    );
    assert.equal(rateLimitedLogin.status, 429);
    assert.ok(Number(rateLimitedLogin.headers.get('Retry-After')) >= 1);

    // 6i. Retired endpoints and unknown API routes stay 404 JSON (never SPA HTML)
    const retiredRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/previous-questions'),
      env
    );
    assert.equal(retiredRes.status, 404);

    const unknownApiRes = await handler(
      new Request('https://s--khayrul-alam.khayrulalam88.workers.dev/api/nonexistent-edge-route', { method: 'POST' }),
      env
    );
    assert.equal(unknownApiRes.status, 404);
    assert.equal(((await unknownApiRes.json()) as { error: string }).error, 'NOT_FOUND');
  });

  test('7. Direct D1 helper session lifecycle sanity', async () => {
    const db = await createMigratedTestD1();
    const t0 = new Date().toISOString();
    await createOrReplaceSessionD1(db, {
      sessionId: 'sess_a',
      userId: 'u_1',
      userEmail: 'u1@example.com',
      userName: 'User 1',
      deviceInfo: 'Browser A',
      createdAt: t0,
      lastActiveAt: t0,
      status: 'active'
    });
    const activeA = await validateAndTouchSessionD1(db, { sessionId: 'sess_a', uid: 'u_1' });
    assert.equal(activeA.status, 'active');

    const { previousSessionId } = await createOrReplaceSessionD1(db, {
      sessionId: 'sess_b',
      userId: 'u_1',
      userEmail: 'u1@example.com',
      userName: 'User 1',
      deviceInfo: 'Browser B',
      createdAt: t0,
      lastActiveAt: t0,
      status: 'active'
    });
    assert.equal(previousSessionId, 'sess_a');
    await assert.rejects(
      () => validateAndTouchSessionD1(db, { sessionId: 'sess_a', uid: 'u_1' }),
      (err: any) => err.code === 'SESSION_REVOKED'
    );
    await revokeSessionOnLogoutD1(db, { sessionId: 'sess_b', uid: 'u_1' });
    await assert.rejects(
      () => validateAndTouchSessionD1(db, { sessionId: 'sess_b', uid: 'u_1' }),
      (err: any) => err.code === 'SESSION_REVOKED'
    );
  });

  test('8. Architecture boundary checks: no firebase-admin/gRPC in worker/, no embedded private keys, root config & rules preserved', () => {
    const embeddedPrivateKeyPattern = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{40,}-----END [A-Z ]*PRIVATE KEY-----/;
    const workerFiles = fs
      .readdirSync(path.resolve('worker'))
      .filter(f => f.endsWith('.ts') || f.endsWith('.jsonc'))
      .map(f => ({ name: f, content: fs.readFileSync(path.resolve('worker', f), 'utf-8') }));

    for (const { name, content } of workerFiles) {
      assert.equal(content.includes('firebase-admin'), false, `${name} must NEVER import firebase-admin`);
      assert.equal(content.includes('@grpc/grpc-js'), false, `${name} must NEVER import gRPC`);
      assert.equal(embeddedPrivateKeyPattern.test(content), false, `${name} must NEVER hardcode private keys`);
    }

    assert.equal(fs.existsSync(path.resolve('server.ts')), true);
    assert.equal(fs.existsSync(path.resolve('firestore.rules')), true);
    assert.equal(fs.existsSync(path.resolve('wrangler.jsonc')), true);
  });
});
