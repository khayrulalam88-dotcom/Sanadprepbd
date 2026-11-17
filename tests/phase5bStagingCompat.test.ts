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
  WorkerHttpError,
  type D1Database,
  type D1ExecResult,
  type D1PreparedStatement,
  type D1Result,
  type WorkerEnv
} from '../worker/types.ts';
import {
  assertOwnerAdmin,
  base64UrlEncodeBytes,
  clearFirebaseJwksCacheForTests,
  isOwnerUser,
  resolveEffectiveOwnerAdmin,
  resolveFirebaseProjectId,
  verifyFirebaseIdToken,
  type FirebaseJwk
} from '../worker/firebaseAuth.ts';
import {
  assertExpectedNamedDatabase,
  clearServiceAccountTokenCacheForTests,
  decodeDocumentFields,
  encodeDocumentFields,
  FirestoreRestClient,
  parseServiceAccountJson,
  type FirestoreRestValue
} from '../worker/firestoreRest.ts';
import { createWorkerHandler } from '../worker/index.ts';
import {
  isFrontendStagingEnvironment,
  isVerifiedOwnerAccount,
  PRODUCTION_FIREBASE_DATABASE_ID,
  PRODUCTION_FIREBASE_PROJECT_ID,
  resolveFrontendFirebaseConfig,
  resolveFrontendOwnerAdminUid
} from '../src/lib/firebase.ts';

const STAGING_PROJECT_ID = 'sanad-prep-bd-staging';
const STAGING_OWNER_UID = 'staging_owner_uid_001';

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

function createScopedFirestoreStub(targetProjectId: string, targetDatabaseId: string) {
  const expectedPrefix = `https://firestore.googleapis.com/v1/projects/${targetProjectId}/databases/${targetDatabaseId}/documents`;
  const collections = new Map<string, Map<string, Record<string, unknown>>>();
  const requestedUrls: string[] = [];

  const getCol = (col: string) => {
    let map = collections.get(col);
    if (!map) {
      map = new Map();
      collections.set(col, map);
    }
    return map;
  };

  const formatDoc = (col: string, docId: string, data: Record<string, unknown>) => ({
    name: `projects/${targetProjectId}/databases/${targetDatabaseId}/documents/${col}/${docId}`,
    fields: encodeDocumentFields(data),
    createTime: '2026-01-01T00:00:00.000Z',
    updateTime: '2026-01-01T00:00:00.000Z'
  });

  const stubFetch: typeof fetch = async (input, init) => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method || 'GET').toUpperCase();
    requestedUrls.push(`${method} ${urlStr}`);

    if (urlStr === 'https://oauth2.googleapis.com/token') {
      return new Response(
        JSON.stringify({ access_token: `sa_token_${targetProjectId}`, expires_in: 3600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (!urlStr.startsWith(expectedPrefix)) {
      return new Response(
        JSON.stringify({ error: { code: 403, message: `Cross-project access denied: ${urlStr}` } }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (urlStr === `${expectedPrefix}:batchGet`) {
      const body = JSON.parse(String(init?.body || '{}')) as { documents?: string[] };
      const results = (body.documents || []).map(docPath => {
        const rel = docPath.split('/documents/')[1] || '';
        const [col, ...rest] = rel.split('/');
        const docId = rest.join('/');
        const found = getCol(col).get(docId);
        return found ? { found: formatDoc(col, docId, found) } : { missing: docPath };
      });
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
          const incoming = decodeDocumentFields(
            (w.update.fields || {}) as Record<string, FirestoreRestValue>
          ) as Record<string, unknown>;
          const map = getCol(col);
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
            fieldFilter?: { field?: { fieldPath?: string }; op?: string; value?: FirestoreRestValue };
          };
        };
      };
      const col = body.structuredQuery?.from?.[0]?.collectionId || '';
      const filter = body.structuredQuery?.where?.fieldFilter;
      const docs = Array.from(getCol(col).entries())
        .filter(([, data]) => {
          if (!filter?.field?.fieldPath) return true;
          const expected = decodeDocumentFields({ v: filter.value! }).v;
          return data[filter.field.fieldPath] === expected;
        })
        .map(([docId, data]) => ({ document: formatDoc(col, docId, data) }));
      return new Response(JSON.stringify(docs), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const rel = urlStr.slice(expectedPrefix.length + 1).split('?')[0];
    const parts = rel.split('/').filter(Boolean);
    if (parts.length === 1 && method === 'GET') {
      const col = parts[0];
      const documents = Array.from(getCol(col).entries()).map(([docId, data]) =>
        formatDoc(col, docId, data)
      );
      return new Response(JSON.stringify({ documents }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (parts.length >= 2 && method === 'GET') {
      const col = parts[0];
      const docId = decodeURIComponent(parts.slice(1).join('/'));
      const data = getCol(col).get(docId);
      if (!data) {
        return new Response(JSON.stringify({ error: { code: 404, message: 'NOT_FOUND' } }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify(formatDoc(col, docId, data)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ error: { code: 404, message: 'UNHANDLED' } }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  return {
    stubFetch,
    requestedUrls,
    seed(col: string, docId: string, data: Record<string, unknown>) {
      getCol(col).set(docId, data);
    },
    get(col: string, docId: string) {
      return getCol(col).get(docId);
    }
  };
}

describe('Phase 5B — Firebase Staging Compatibility & Isolation', () => {
  beforeEach(() => {
    clearFirebaseJwksCacheForTests();
    clearServiceAccountTokenCacheForTests();
  });

  test('1. Staging configuration accepts separate staging Firebase project, (default) or named DB, and matching service account', () => {
    assert.equal(resolveFirebaseProjectId(STAGING_PROJECT_ID, 'staging'), STAGING_PROJECT_ID);
    assert.equal(resolveFirebaseProjectId(STAGING_PROJECT_ID, ' STAGING '), STAGING_PROJECT_ID);

    const defaultDbCheck = assertExpectedNamedDatabase({
      projectId: STAGING_PROJECT_ID,
      databaseId: '(default)',
      environment: 'staging'
    });
    assert.equal(defaultDbCheck.valid, true);
    assert.equal(defaultDbCheck.projectId, STAGING_PROJECT_ID);
    assert.equal(defaultDbCheck.databaseId, '(default)');

    const namedStagingDbCheck = assertExpectedNamedDatabase({
      projectId: STAGING_PROJECT_ID,
      databaseId: 'sanad-prep-staging-db',
      environment: 'staging'
    });
    assert.equal(namedStagingDbCheck.valid, true);
    assert.equal(namedStagingDbCheck.databaseId, 'sanad-prep-staging-db');

    const parsedSa = parseServiceAccountJson(
      JSON.stringify({
        project_id: STAGING_PROJECT_ID,
        client_email: 'sa@sanad-prep-bd-staging.iam.gserviceaccount.com',
        private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----'
      }),
      STAGING_PROJECT_ID
    );
    assert.equal(parsedSa.project_id, STAGING_PROJECT_ID);
  });

  test('2. Staging rejects production service account, cross-project named DB pairing, and missing/invalid staging IDs', () => {
    assert.throws(
      () => resolveFirebaseProjectId('', 'staging'),
      (err: unknown) => err instanceof WorkerHttpError && err.code === 'FIREBASE_PROJECT_MISMATCH'
    );
    assert.throws(
      () => resolveFirebaseProjectId('INVALID_PROJECT', 'staging'),
      (err: unknown) => err instanceof WorkerHttpError && err.code === 'FIREBASE_PROJECT_MISMATCH'
    );

    const crossDbCheck = assertExpectedNamedDatabase({
      projectId: STAGING_PROJECT_ID,
      databaseId: EXPECTED_FIREBASE_DATABASE_ID,
      environment: 'staging'
    });
    assert.equal(crossDbCheck.valid, false);
    assert.match(crossDbCheck.reason || '', /cannot use production named Firestore database/i);

    const missingDbCheck = assertExpectedNamedDatabase({
      projectId: STAGING_PROJECT_ID,
      databaseId: '',
      environment: 'staging'
    });
    assert.equal(missingDbCheck.valid, false);

    assert.throws(
      () =>
        parseServiceAccountJson(
          JSON.stringify({
            project_id: EXPECTED_FIREBASE_PROJECT_ID,
            client_email: 'sa@galvanic-aviary-tzp2g.iam.gserviceaccount.com',
            private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----'
          }),
          STAGING_PROJECT_ID
        ),
      (err: unknown) => err instanceof WorkerHttpError && err.code === 'FIREBASE_PROJECT_MISMATCH'
    );

    assert.throws(
      () =>
        parseServiceAccountJson(
          JSON.stringify({
            client_email: 'sa@sanad-prep-bd-staging.iam.gserviceaccount.com',
            private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----'
          }),
          STAGING_PROJECT_ID
        ),
      (err: unknown) => err instanceof WorkerHttpError && err.code === 'FIREBASE_PROJECT_MISMATCH'
    );

    assert.throws(
      () =>
        new FirestoreRestClient({
          environment: 'staging',
          projectId: STAGING_PROJECT_ID,
          databaseId: '(default)',
          serviceAccountJson: JSON.stringify({
            project_id: EXPECTED_FIREBASE_PROJECT_ID,
            client_email: 'prod@galvanic-aviary-tzp2g.iam.gserviceaccount.com',
            private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----'
          })
        }),
      (err: unknown) => err instanceof WorkerHttpError && err.code === 'FIREBASE_PROJECT_MISMATCH'
    );
  });

  test('3. Production remains strictly hard-locked when ENVIRONMENT is unset, production, or development', () => {
    for (const envMode of [undefined, '', 'production', 'PRODUCTION', 'development']) {
      assert.equal(resolveFirebaseProjectId(undefined, envMode), EXPECTED_FIREBASE_PROJECT_ID);
      assert.equal(resolveFirebaseProjectId(EXPECTED_FIREBASE_PROJECT_ID, envMode), EXPECTED_FIREBASE_PROJECT_ID);

      assert.throws(
        () => resolveFirebaseProjectId(STAGING_PROJECT_ID, envMode),
        (err: unknown) => err instanceof WorkerHttpError && err.code === 'FIREBASE_PROJECT_MISMATCH'
      );

      assert.equal(
        assertExpectedNamedDatabase({
          projectId: STAGING_PROJECT_ID,
          databaseId: '(default)',
          environment: envMode
        }).valid,
        false
      );

      assert.equal(
        assertExpectedNamedDatabase({
          projectId: EXPECTED_FIREBASE_PROJECT_ID,
          databaseId: '(default)',
          environment: envMode
        }).valid,
        false
      );

      const prodValid = assertExpectedNamedDatabase({
        projectId: EXPECTED_FIREBASE_PROJECT_ID,
        databaseId: EXPECTED_FIREBASE_DATABASE_ID,
        environment: envMode
      });
      assert.equal(prodValid.valid, true);
      assert.equal(prodValid.projectId, EXPECTED_FIREBASE_PROJECT_ID);
      assert.equal(prodValid.databaseId, EXPECTED_FIREBASE_DATABASE_ID);
    }

    assert.throws(
      () =>
        parseServiceAccountJson(
          JSON.stringify({
            project_id: STAGING_PROJECT_ID,
            client_email: 'sa@sanad-prep-bd-staging.iam.gserviceaccount.com',
            private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----'
          })
        ),
      (err: unknown) => err instanceof WorkerHttpError && err.code === 'FIREBASE_PROJECT_MISMATCH'
    );
  });

  test('4. ID token verification enforces project isolation between staging and production', async () => {
    const nowMs = Date.UTC(2026, 5, 1, 10, 0, 0);
    const nowSec = Math.floor(nowMs / 1000);
    const kp = await generateRs256Keypair('kid_5b_1');
    const jwksFetcher = async () => ({ keys: [kp.jwk], maxAgeSeconds: 3600 });

    const stagingToken = await signJwt(kp.privateKey, kp.kid, {
      aud: STAGING_PROJECT_ID,
      iss: `https://securetoken.google.com/${STAGING_PROJECT_ID}`,
      sub: STAGING_OWNER_UID,
      user_id: STAGING_OWNER_UID,
      email: OWNER_ADMIN_EMAIL,
      email_verified: true,
      iat: nowSec - 30,
      exp: nowSec + 3600
    });

    const prodToken = await signJwt(kp.privateKey, kp.kid, {
      aud: EXPECTED_FIREBASE_PROJECT_ID,
      iss: `https://securetoken.google.com/${EXPECTED_FIREBASE_PROJECT_ID}`,
      sub: OWNER_ADMIN_UID,
      user_id: OWNER_ADMIN_UID,
      email: OWNER_ADMIN_EMAIL,
      email_verified: true,
      iat: nowSec - 30,
      exp: nowSec + 3600
    });

    // Staging accepts staging token
    const verifiedStaging = await verifyFirebaseIdToken(stagingToken, {
      projectId: STAGING_PROJECT_ID,
      environment: 'staging',
      jwksFetcher,
      nowMs
    });
    assert.equal(verifiedStaging.uid, STAGING_OWNER_UID);

    // Staging rejects production token
    await assert.rejects(
      () =>
        verifyFirebaseIdToken(prodToken, {
          projectId: STAGING_PROJECT_ID,
          environment: 'staging',
          jwksFetcher,
          nowMs
        }),
      (err: unknown) => err instanceof WorkerHttpError && err.status === 401
    );

    // Production (and unset ENVIRONMENT) rejects staging token
    for (const envMode of [undefined, 'production']) {
      await assert.rejects(
        () =>
          verifyFirebaseIdToken(stagingToken, {
            projectId: EXPECTED_FIREBASE_PROJECT_ID,
            environment: envMode,
            jwksFetcher,
            nowMs
          }),
        (err: unknown) => err instanceof WorkerHttpError && err.status === 401
      );
    }
  });

  test('5. Single-owner authorization isolates staging owner UID from production owner UID and rejects multi-admin configs', () => {
    const stagingOptions = {
      ENVIRONMENT: 'staging',
      STAGING_OWNER_ADMIN_UID: STAGING_OWNER_UID
    };

    assert.deepEqual(resolveEffectiveOwnerAdmin(stagingOptions), {
      uid: STAGING_OWNER_UID,
      email: OWNER_ADMIN_EMAIL
    });

    // Staging owner succeeds
    assert.equal(
      isOwnerUser(
        { uid: STAGING_OWNER_UID, email: OWNER_ADMIN_EMAIL, emailVerified: true },
        stagingOptions
      ),
      true
    );

    // Production owner UID is rejected on staging when distinct staging owner UID is configured
    assert.equal(
      isOwnerUser(
        { uid: OWNER_ADMIN_UID, email: OWNER_ADMIN_EMAIL, emailVerified: true },
        stagingOptions
      ),
      false
    );
    assert.throws(
      () =>
        assertOwnerAdmin(
          { uid: OWNER_ADMIN_UID, email: OWNER_ADMIN_EMAIL, emailVerified: true },
          stagingOptions
        ),
      (err: unknown) => err instanceof WorkerHttpError && err.status === 403 && err.code === 'FORBIDDEN'
    );

    // Unverified email or alternate email cannot become owner
    assert.equal(
      isOwnerUser(
        { uid: STAGING_OWNER_UID, email: OWNER_ADMIN_EMAIL, emailVerified: false },
        stagingOptions
      ),
      false
    );
    assert.equal(
      isOwnerUser(
        { uid: STAGING_OWNER_UID, email: 'other@example.com', emailVerified: true },
        stagingOptions
      ),
      false
    );

    // Multi-admin strings fail closed
    for (const multi of [`${STAGING_OWNER_UID},${OWNER_ADMIN_UID}`, `${STAGING_OWNER_UID} ${OWNER_ADMIN_UID}`, `${STAGING_OWNER_UID};uid2`]) {
      const badOpts = { ENVIRONMENT: 'staging', STAGING_OWNER_ADMIN_UID: multi };
      assert.equal(resolveEffectiveOwnerAdmin(badOpts), null);
      assert.equal(
        isOwnerUser({ uid: STAGING_OWNER_UID, email: OWNER_ADMIN_EMAIL, emailVerified: true }, badOpts),
        false
      );
    }

    // Production / unset ENVIRONMENT completely ignores STAGING_OWNER_ADMIN_UID
    for (const envMode of [undefined, '', 'production', 'development']) {
      const prodOpts = { ENVIRONMENT: envMode, STAGING_OWNER_ADMIN_UID: STAGING_OWNER_UID };
      assert.deepEqual(resolveEffectiveOwnerAdmin(prodOpts), {
        uid: OWNER_ADMIN_UID,
        email: OWNER_ADMIN_EMAIL
      });
      assert.equal(
        isOwnerUser({ uid: STAGING_OWNER_UID, email: OWNER_ADMIN_EMAIL, emailVerified: true }, prodOpts),
        false
      );
      assert.equal(
        isOwnerUser({ uid: OWNER_ADMIN_UID, email: OWNER_ADMIN_EMAIL, emailVerified: true }, prodOpts),
        true
      );
    }
  });

  test('6. Worker HTTP handler enforces staging/prod project isolation and single-owner authorization end-to-end', async () => {
    const nowMs = Date.UTC(2026, 5, 1, 12, 0, 0);
    const nowSec = Math.floor(nowMs / 1000);
    const kp = await generateRs256Keypair('kid_http_5b');
    const jwksFetcher = async () => ({ keys: [kp.jwk], maxAgeSeconds: 3600 });

    const d1 = await createMigratedTestD1();
    const stagingStub = createScopedFirestoreStub(STAGING_PROJECT_ID, '(default)');
    stagingStub.seed('subjects', 'sub_cpc', {
      id: 'sub_cpc',
      nameBn: 'দেওয়ানি কার্যবিধি',
      nameEn: 'Code of Civil Procedure'
    });
    stagingStub.seed('users', 'student_1', {
      uid: 'student_1',
      name: 'Staging Student',
      email: 'student1@example.com',
      role: 'student',
      subscriptionStatus: 'free'
    });

    const stagingSaJson = JSON.stringify({
      project_id: STAGING_PROJECT_ID,
      client_email: 'sa@sanad-prep-bd-staging.iam.gserviceaccount.com',
      private_key: kp.pkcs8Pem
    });

    const stagingEnv: WorkerEnv = {
      DB: d1,
      ENVIRONMENT: 'staging',
      FIREBASE_PROJECT_ID: STAGING_PROJECT_ID,
      FIREBASE_DATABASE_ID: '(default)',
      FIREBASE_SERVICE_ACCOUNT_JSON: stagingSaJson,
      STAGING_OWNER_ADMIN_UID: STAGING_OWNER_UID,
      ALLOWED_ORIGIN: 'https://staging.example.com'
    };

    const handler = createWorkerHandler({
      jwksFetcher,
      fetchImpl: stagingStub.stubFetch,
      nowMsFn: () => nowMs
    });

    // Health check in staging confirms staging project & (default) DB
    const healthRes = await handler(new Request('https://staging.example.com/health'), stagingEnv);
    assert.equal(healthRes.status, 200);
    const healthBody = (await healthRes.json()) as Record<string, unknown>;
    assert.equal(healthBody.environment, 'staging');
    assert.equal(healthBody.projectId, STAGING_PROJECT_ID);
    assert.equal(healthBody.databaseId, '(default)');
    assert.equal(healthBody.expectedDatabaseMatched, true);

    // Public API uses staging Firestore URLs exclusively
    const subjectsRes = await handler(new Request('https://staging.example.com/api/subjects'), stagingEnv);
    assert.equal(subjectsRes.status, 200);
    assert.ok(
      stagingStub.requestedUrls.some(u =>
        u.includes(`projects/${STAGING_PROJECT_ID}/databases/(default)/documents/subjects`)
      )
    );

    const stagingOwnerJwt = await signJwt(kp.privateKey, kp.kid, {
      aud: STAGING_PROJECT_ID,
      iss: `https://securetoken.google.com/${STAGING_PROJECT_ID}`,
      sub: STAGING_OWNER_UID,
      user_id: STAGING_OWNER_UID,
      email: OWNER_ADMIN_EMAIL,
      email_verified: true,
      iat: nowSec - 10,
      exp: nowSec + 3600
    });
    const prodOwnerOnStagingJwt = await signJwt(kp.privateKey, kp.kid, {
      aud: STAGING_PROJECT_ID,
      iss: `https://securetoken.google.com/${STAGING_PROJECT_ID}`,
      sub: OWNER_ADMIN_UID,
      user_id: OWNER_ADMIN_UID,
      email: OWNER_ADMIN_EMAIL,
      email_verified: true,
      iat: nowSec - 10,
      exp: nowSec + 3600
    });
    const forgedProdAudJwt = await signJwt(kp.privateKey, kp.kid, {
      aud: EXPECTED_FIREBASE_PROJECT_ID,
      iss: `https://securetoken.google.com/${EXPECTED_FIREBASE_PROJECT_ID}`,
      sub: STAGING_OWNER_UID,
      user_id: STAGING_OWNER_UID,
      email: OWNER_ADMIN_EMAIL,
      email_verified: true,
      iat: nowSec - 10,
      exp: nowSec + 3600
    });

    // Staging Owner UID allowed on staging admin endpoint
    const adminOk = await handler(
      new Request('https://staging.example.com/api/admin/dashboard-stats', {
        headers: { Authorization: `Bearer ${stagingOwnerJwt}` }
      }),
      stagingEnv
    );
    assert.equal(adminOk.status, 200);

    // Staging Owner cannot promote a student to admin
    const promoteRes = await handler(
      new Request('https://staging.example.com/api/admin/users/update', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${stagingOwnerJwt}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          userId: 'student_1',
          name: 'Staging Student',
          email: 'student1@example.com',
          role: 'admin',
          subscriptionStatus: 'free'
        })
      }),
      stagingEnv
    );
    assert.equal(promoteRes.status, 200);
    assert.equal(stagingStub.get('users', 'student_1')?.role, 'student');

    // Production Owner UID blocked on staging when STAGING_OWNER_ADMIN_UID is distinct
    const prodOwnerBlocked = await handler(
      new Request('https://staging.example.com/api/admin/dashboard-stats', {
        headers: { Authorization: `Bearer ${prodOwnerOnStagingJwt}` }
      }),
      stagingEnv
    );
    assert.equal(prodOwnerBlocked.status, 403);

    // Production-audience token blocked on staging
    const wrongAudBlocked = await handler(
      new Request('https://staging.example.com/api/admin/dashboard-stats', {
        headers: { Authorization: `Bearer ${forgedProdAudJwt}` }
      }),
      stagingEnv
    );
    assert.equal(wrongAudBlocked.status, 401);

    // If ENVIRONMENT is unset or 'production', staging project/DB vars fail closed at HTTP layer
    for (const lockedEnvMode of [undefined, 'production']) {
      const misconfiguredProdEnv: WorkerEnv = {
        ...stagingEnv,
        ENVIRONMENT: lockedEnvMode
      };
      const badHealth = await handler(new Request('https://example.com/health'), misconfiguredProdEnv);
      assert.equal(badHealth.status, 503);
      const badApi = await handler(new Request('https://example.com/api/subjects'), misconfiguredProdEnv);
      assert.equal(badApi.status, 503);
      const badBody = (await badApi.json()) as { error: string };
      assert.equal(badBody.error, 'NAMED_DATABASE_MISMATCH');
    }

    // Production env ignores STAGING_OWNER_ADMIN_UID completely
    const prodStub = createScopedFirestoreStub(EXPECTED_FIREBASE_PROJECT_ID, EXPECTED_FIREBASE_DATABASE_ID);
    const prodSaJson = JSON.stringify({
      project_id: EXPECTED_FIREBASE_PROJECT_ID,
      client_email: 'sa@galvanic-aviary-tzp2g.iam.gserviceaccount.com',
      private_key: kp.pkcs8Pem
    });
    const prodEnv: WorkerEnv = {
      DB: d1,
      ENVIRONMENT: 'production',
      FIREBASE_PROJECT_ID: EXPECTED_FIREBASE_PROJECT_ID,
      FIREBASE_DATABASE_ID: EXPECTED_FIREBASE_DATABASE_ID,
      FIREBASE_SERVICE_ACCOUNT_JSON: prodSaJson,
      STAGING_OWNER_ADMIN_UID: STAGING_OWNER_UID,
      ALLOWED_ORIGIN: 'https://sanad-prep.example.com'
    };
    const prodHandler = createWorkerHandler({
      jwksFetcher,
      fetchImpl: prodStub.stubFetch,
      nowMsFn: () => nowMs
    });

    const stagingUidInProdToken = await signJwt(kp.privateKey, kp.kid, {
      aud: EXPECTED_FIREBASE_PROJECT_ID,
      iss: `https://securetoken.google.com/${EXPECTED_FIREBASE_PROJECT_ID}`,
      sub: STAGING_OWNER_UID,
      user_id: STAGING_OWNER_UID,
      email: OWNER_ADMIN_EMAIL,
      email_verified: true,
      iat: nowSec - 10,
      exp: nowSec + 3600
    });
    const prodOwnerToken = await signJwt(kp.privateKey, kp.kid, {
      aud: EXPECTED_FIREBASE_PROJECT_ID,
      iss: `https://securetoken.google.com/${EXPECTED_FIREBASE_PROJECT_ID}`,
      sub: OWNER_ADMIN_UID,
      user_id: OWNER_ADMIN_UID,
      email: OWNER_ADMIN_EMAIL,
      email_verified: true,
      iat: nowSec - 10,
      exp: nowSec + 3600
    });

    const stagingUidRejectedInProd = await prodHandler(
      new Request('https://sanad-prep.example.com/api/admin/dashboard-stats', {
        headers: { Authorization: `Bearer ${stagingUidInProdToken}` }
      }),
      prodEnv
    );
    assert.equal(stagingUidRejectedInProd.status, 403);

    const realOwnerAllowedInProd = await prodHandler(
      new Request('https://sanad-prep.example.com/api/admin/dashboard-stats', {
        headers: { Authorization: `Bearer ${prodOwnerToken}` }
      }),
      prodEnv
    );
    assert.equal(realOwnerAllowedInProd.status, 200);
  });

  test('7. Frontend Firebase config resolver strictly isolates staging from production database and keys', () => {
    const prodFallback = {
      projectId: PRODUCTION_FIREBASE_PROJECT_ID,
      appId: '1:111:web:prod',
      apiKey: 'AIzaProdDummyKeyForTests00000000000',
      authDomain: `${PRODUCTION_FIREBASE_PROJECT_ID}.firebaseapp.com`,
      firestoreDatabaseId: PRODUCTION_FIREBASE_DATABASE_ID,
      storageBucket: `${PRODUCTION_FIREBASE_PROJECT_ID}.firebasestorage.app`,
      messagingSenderId: '111',
      measurementId: 'G-PROD',
      oAuthClientId: 'prod-oauth',
      recaptchaSiteKey: ''
    };

    // Unset or production env locks strictly to production project and named DB
    assert.equal(isFrontendStagingEnvironment({}), false);
    assert.equal(isFrontendStagingEnvironment({ VITE_ENVIRONMENT: 'production' }), false);

    const resolvedProd = resolveFrontendFirebaseConfig({}, prodFallback);
    assert.equal(resolvedProd.projectId, PRODUCTION_FIREBASE_PROJECT_ID);
    assert.equal(resolvedProd.firestoreDatabaseId, PRODUCTION_FIREBASE_DATABASE_ID);
    assert.equal(resolvedProd.apiKey, prodFallback.apiKey);

    // Production mode rejects staging project or foreign database ID
    assert.throws(() =>
      resolveFrontendFirebaseConfig({ VITE_FIREBASE_PROJECT_ID: STAGING_PROJECT_ID }, prodFallback)
    );
    assert.throws(() =>
      resolveFrontendFirebaseConfig(
        { VITE_ENVIRONMENT: 'production', VITE_FIREBASE_DATABASE_ID: '(default)' },
        prodFallback
      )
    );

    // Staging mode resolves staging project + (default) and NEVER falls back to production keys or named DB
    const stagingEnv = {
      VITE_ENVIRONMENT: 'staging',
      VITE_FIREBASE_PROJECT_ID: STAGING_PROJECT_ID,
      VITE_FIREBASE_API_KEY: 'staging-api-key',
      VITE_FIREBASE_APP_ID: '1:222:web:staging'
    };
    assert.equal(isFrontendStagingEnvironment(stagingEnv), true);

    const resolvedStaging = resolveFrontendFirebaseConfig(stagingEnv, prodFallback);
    assert.equal(resolvedStaging.projectId, STAGING_PROJECT_ID);
    assert.equal(resolvedStaging.firestoreDatabaseId, '(default)');
    assert.equal(resolvedStaging.apiKey, 'staging-api-key');
    assert.equal(resolvedStaging.appId, '1:222:web:staging');
    assert.notEqual(resolvedStaging.firestoreDatabaseId, PRODUCTION_FIREBASE_DATABASE_ID);
    assert.notEqual(resolvedStaging.messagingSenderId, prodFallback.messagingSenderId);

    // Staging explicitly rejects missing projectId, production projectId, or production named databaseId
    assert.throws(() => resolveFrontendFirebaseConfig({ VITE_ENVIRONMENT: 'staging' }, prodFallback));
    assert.throws(() =>
      resolveFrontendFirebaseConfig(
        { VITE_ENVIRONMENT: 'staging', VITE_FIREBASE_PROJECT_ID: PRODUCTION_FIREBASE_PROJECT_ID },
        prodFallback
      )
    );
    assert.throws(() =>
      resolveFrontendFirebaseConfig(
        {
          VITE_ENVIRONMENT: 'staging',
          VITE_FIREBASE_PROJECT_ID: STAGING_PROJECT_ID,
          VITE_FIREBASE_DATABASE_ID: PRODUCTION_FIREBASE_DATABASE_ID
        },
        prodFallback
      )
    );

    // Frontend owner verification isolation
    const stagingFrontendEnv = {
      VITE_ENVIRONMENT: 'staging',
      VITE_STAGING_OWNER_ADMIN_UID: STAGING_OWNER_UID
    };
    assert.equal(resolveFrontendOwnerAdminUid(stagingFrontendEnv), STAGING_OWNER_UID);
    assert.equal(
      isVerifiedOwnerAccount(
        { uid: STAGING_OWNER_UID, email: OWNER_ADMIN_EMAIL, emailVerified: true },
        stagingFrontendEnv
      ),
      true
    );
    assert.equal(
      isVerifiedOwnerAccount(
        { uid: OWNER_ADMIN_UID, email: OWNER_ADMIN_EMAIL, emailVerified: true },
        stagingFrontendEnv
      ),
      false
    );

    // Production ignores VITE_STAGING_OWNER_ADMIN_UID
    const prodWithInjectedStagingUid = {
      VITE_ENVIRONMENT: 'production',
      VITE_STAGING_OWNER_ADMIN_UID: STAGING_OWNER_UID
    };
    assert.equal(resolveFrontendOwnerAdminUid(prodWithInjectedStagingUid), OWNER_ADMIN_UID);
    assert.equal(
      isVerifiedOwnerAccount(
        { uid: STAGING_OWNER_UID, email: OWNER_ADMIN_EMAIL, emailVerified: true },
        prodWithInjectedStagingUid
      ),
      false
    );
    assert.equal(
      isVerifiedOwnerAccount(
        { uid: OWNER_ADMIN_UID, email: OWNER_ADMIN_EMAIL, emailVerified: true },
        prodWithInjectedStagingUid
      ),
      true
    );
  });
});
