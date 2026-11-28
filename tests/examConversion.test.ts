import test, { describe } from 'node:test';
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
import {
  getExamFromCacheD1,
  insertExamAttemptD1,
  listAuditLogsD1,
  listExamsFromCacheD1,
  upsertExamsBatchD1
} from '../worker/d1Store.ts';
import { CANONICAL_LEGACY_QUESTION_IDS } from '../worker/examRepair.ts';
import {
  APPROVED_100_QUESTION_IDS,
  APPROVED_7_REPLACEMENTS_ORDERED,
  CONVERSION_AUDIT_LOG_ID,
  CONVERSION_OPERATION_ID,
  CONVERTED_DESCRIPTION_BN,
  CONVERTED_DESCRIPTION_EN,
  REQUIRED_SUBJECT_DISTRIBUTION,
  TARGET_MODEL_TEST_2_EXAM_ID
} from '../worker/examConversion.ts';
import {
  APPROVED_100_QUESTION_IDS as CLI_APPROVED_100_IDS,
  parseConversionCliArgs,
  runConvertOwnerModelTest2To100
} from '../scripts/convertOwnerModelTest2To100.mjs';
import type { Exam, ServerQuestion } from '../src/types/index.ts';

class SqliteD1Adapter implements D1Database {
  readonly sqlite: DatabaseSync;
  failBatchOnMatch?: (sqlStatements: string[]) => Error | null;

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

    const stmtObj: D1PreparedStatement & { __query?: string } = {
      __query: query,
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
    if (this.failBatchOnMatch) {
      const sqls = statements.map(s => String((s as { __query?: string }).__query || ''));
      const injectedErr = this.failBatchOnMatch(sqls);
      if (injectedErr) {
        throw injectedErr;
      }
    }

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

function createConversionFirestoreStub(options?: {
  mutateExamOnCommitCall?: { callNumber: number; nextQuestionIds: string[]; nextUpdateTime: string };
  onGetDoc?: (col: string, id: string, callIndex: number) => Response | null;
}) {
  const expectedPrefix = `https://firestore.googleapis.com/v1/projects/${EXPECTED_FIREBASE_PROJECT_ID}/databases/${EXPECTED_FIREBASE_DATABASE_ID}/documents`;
  const expectedResourceRoot = `projects/${EXPECTED_FIREBASE_PROJECT_ID}/databases/${EXPECTED_FIREBASE_DATABASE_ID}/documents/`;
  const collections = new Map<string, Map<string, Record<string, unknown>>>();
  const docTimestamps = new Map<string, { createTime: string; updateTime: string }>();
  const getCallCounts = new Map<string, number>();
  const commitLog: Array<{ writes: unknown[] }> = [];
  let commitCalls = 0;
  let tsSeq = 0;

  const nextUpdateTimestamp = () => {
    tsSeq += 1;
    return `2026-11-28T02:00:${String(tsSeq).padStart(2, '0')}.000000Z`;
  };

  const getCol = (col: string) => {
    let map = collections.get(col);
    if (!map) {
      map = new Map();
      collections.set(col, map);
    }
    return map;
  };

  const setDoc = (col: string, id: string, data: Record<string, unknown>, customUpdateTime?: string) => {
    getCol(col).set(id, structuredClone(data));
    const key = `${col}/${id}`;
    const existingMeta = docTimestamps.get(key);
    const updateTime = customUpdateTime || nextUpdateTimestamp();
    docTimestamps.set(key, {
      createTime: existingMeta?.createTime || updateTime,
      updateTime
    });
  };

  const deleteDoc = (col: string, id: string) => {
    getCol(col).delete(id);
    docTimestamps.delete(`${col}/${id}`);
  };

  const getDoc = (col: string, id: string) => getCol(col).get(id) || null;
  const getDocMeta = (col: string, id: string) => docTimestamps.get(`${col}/${id}`);

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method || 'GET').toUpperCase();

    assert.ok(url.startsWith(expectedPrefix), `Unexpected Firestore URL: ${url}`);
    const restPath = url.slice(expectedPrefix.length);

    if (restPath === ':batchGet' && method === 'POST') {
      const parsed = JSON.parse(String(init?.body || '{}')) as { documents?: string[] };
      const docs = parsed.documents || [];
      const responseItems = docs.map(fullName => {
        const rel = fullName.startsWith(expectedResourceRoot)
          ? fullName.slice(expectedResourceRoot.length)
          : fullName.split('/documents/')[1] || '';
        const slashIdx = rel.indexOf('/');
        const col = rel.slice(0, slashIdx);
        const docId = decodeURIComponent(rel.slice(slashIdx + 1));
        const found = getCol(col).get(docId);
        if (!found) {
          return { missing: fullName };
        }
        const meta = getDocMeta(col, docId);
        return {
          found: {
            name: fullName,
            fields: encodeDocumentFields(found),
            createTime: meta?.createTime,
            updateTime: meta?.updateTime
          }
        };
      });
      return new Response(JSON.stringify(responseItems), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (restPath === ':commit' && method === 'POST') {
      commitCalls += 1;
      const parsed = JSON.parse(String(init?.body || '{}')) as {
        writes?: Array<{
          update?: { name: string; fields?: Record<string, any> };
          updateMask?: { fieldPaths?: string[] };
          currentDocument?: { exists?: boolean; updateTime?: string };
          delete?: string;
        }>;
      };
      commitLog.push({ writes: parsed.writes || [] });

      if (
        options?.mutateExamOnCommitCall &&
        options.mutateExamOnCommitCall.callNumber === commitCalls
      ) {
        const existingExam = getCol('exams').get(TARGET_MODEL_TEST_2_EXAM_ID);
        if (existingExam) {
          setDoc(
            'exams',
            TARGET_MODEL_TEST_2_EXAM_ID,
            {
              ...existingExam,
              questionIds: options.mutateExamOnCommitCall.nextQuestionIds
            },
            options.mutateExamOnCommitCall.nextUpdateTime
          );
        }
      }

      for (const w of parsed.writes || []) {
        assert.equal(w.delete, undefined, 'Conversion commits must never delete documents');
        if (w.update) {
          const [col, rawId] = w.update.name.split('/documents/')[1].split('/');
          const docId = decodeURIComponent(rawId);
          const colMap = getCol(col);
          const exists = colMap.has(docId);
          const meta = getDocMeta(col, docId);
          if (w.currentDocument?.exists === false && exists) {
            return new Response(
              JSON.stringify({ error: { code: 409, status: 'ALREADY_EXISTS', message: `${col}/${docId} exists` } }),
              { status: 409, headers: { 'Content-Type': 'application/json' } }
            );
          }
          if (w.currentDocument?.exists === true && !exists) {
            return new Response(
              JSON.stringify({ error: { code: 404, status: 'NOT_FOUND', message: `${col}/${docId} missing` } }),
              { status: 404, headers: { 'Content-Type': 'application/json' } }
            );
          }
          if (w.currentDocument?.updateTime) {
            if (!exists || meta?.updateTime !== w.currentDocument.updateTime) {
              return new Response(
                JSON.stringify({
                  error: {
                    code: 409,
                    status: 'FAILED_PRECONDITION',
                    message: `${col}/${docId} updateTime CAS precondition failed`
                  }
                }),
                { status: 409, headers: { 'Content-Type': 'application/json' } }
              );
            }
          }
        }
      }

      for (const w of parsed.writes || []) {
        if (w.update) {
          const [col, rawId] = w.update.name.split('/documents/')[1].split('/');
          const docId = decodeURIComponent(rawId);
          const decoded = decodeDocumentFields(w.update.fields);
          if (w.updateMask?.fieldPaths && w.updateMask.fieldPaths.length > 0) {
            const prev = { ...(getCol(col).get(docId) || {}) };
            for (const fp of w.updateMask.fieldPaths) {
              if (fp in decoded) {
                prev[fp] = decoded[fp];
              }
            }
            setDoc(col, docId, prev);
          } else {
            setDoc(col, docId, decoded);
          }
        }
      }

      return new Response(JSON.stringify({ writeResults: (parsed.writes || []).map(() => ({})) }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (restPath === ':runQuery' && method === 'POST') {
      const parsed = JSON.parse(String(init?.body || '{}')) as {
        structuredQuery?: {
          from?: Array<{ collectionId: string }>;
          where?: { fieldFilter?: { field: { fieldPath: string }; op: string; value: any } };
        };
      };
      const col = parsed.structuredQuery?.from?.[0]?.collectionId || '';
      const filter = parsed.structuredQuery?.where?.fieldFilter;
      let rows = Array.from(getCol(col).entries()).map(([id, data]) => ({ id, data }));
      if (filter && filter.op === 'EQUAL') {
        const expectedVal =
          filter.value.stringValue ?? filter.value.integerValue ?? filter.value.booleanValue ?? null;
        rows = rows.filter(r => String(r.data[filter.field.fieldPath] ?? '') === String(expectedVal));
      }
      return new Response(
        JSON.stringify(
          rows.map(r => ({
            document: {
              name: `${expectedPrefix}/${col}/${encodeURIComponent(r.id)}`,
              fields: encodeDocumentFields(r.data),
              createTime: getDocMeta(col, r.id)?.createTime,
              updateTime: getDocMeta(col, r.id)?.updateTime
            }
          }))
        ),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const clean = restPath.split('?')[0].replace(/^\/+/, '');
    const parts = clean.split('/');
    if (method === 'GET' && parts.length === 2) {
      const [col, rawId] = parts;
      const docId = decodeURIComponent(rawId);
      const docKey = `${col}/${docId}`;
      const callNum = (getCallCounts.get(docKey) || 0) + 1;
      getCallCounts.set(docKey, callNum);
      if (options?.onGetDoc) {
        const injected = options.onGetDoc(col, docId, callNum);
        if (injected) return injected;
      }
      const doc = getCol(col).get(docId);
      if (!doc) {
        return new Response(JSON.stringify({ error: { code: 404, status: 'NOT_FOUND', message: 'Not found' } }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      const meta = getDocMeta(col, docId);
      return new Response(
        JSON.stringify({
          name: `${expectedPrefix}/${col}/${encodeURIComponent(docId)}`,
          fields: encodeDocumentFields(doc),
          createTime: meta?.createTime,
          updateTime: meta?.updateTime
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    throw new Error(`Unhandled Firestore stub request: ${method} ${url}`);
  };

  return { fetchImpl, setDoc, deleteDoc, getDoc, getDocMeta, commitLog, getCol };
}

const LIVE_MODEL_TEST_2_INACTIVE_7: Exam & { updatedAt: string } = {
  id: TARGET_MODEL_TEST_2_EXAM_ID,
  titleBn: 'মডেল টেস্ট ০2: সমন্বিত প্রস্তুতি পরীক্ষা',
  titleEn: 'Model Test 2: Comprehensive Prep Exam',
  descriptionBn:
    'অ্যাডমিন কর্তৃক প্রশ্ন সম্ভার থেকে তৈরিকৃত অফিসিয়াল মডেল টেস্ট। প্রশ্ন সংখ্যা: 7টি, সময়: 60 মিনিট। নেগেটিভ মার্কিং: 0.25।',
  descriptionEn:
    'Curated model test conducted by Admin. Questions: 7, Duration: 60 mins. Negative marking: 0.25.',
  type: 'full_mock',
  durationMinutes: 60,
  totalMarks: 7,
  passThresholdPercentage: 50,
  questionIds: [...CANONICAL_LEGACY_QUESTION_IDS],
  isPaid: true,
  isActive: false,
  published: true,
  releaseExplanationsImmediately: true,
  negativeMarkRatio: 0.25,
  positiveMarkRatio: 1,
  createdAt: '2026-11-26T05:44:42.276Z',
  updatedAt: '2026-11-26T05:44:42.741Z'
};

let cachedSourceQuestions: ServerQuestion[] | null = null;
function loadAllSourceQuestions(): ServerQuestion[] {
  if (!cachedSourceQuestions) {
    cachedSourceQuestions = JSON.parse(
      fs.readFileSync(path.resolve('server/data/questionBankFull.json'), 'utf-8')
    ) as ServerQuestion[];
  }
  return cachedSourceQuestions;
}

function loadSourceQuestionsSubset(ids: readonly string[]): ServerQuestion[] {
  const byId = new Map(loadAllSourceQuestions().map(q => [q.id, q]));
  return ids.map(id => {
    const found = byId.get(id);
    assert.ok(found, `Expected ${id} in server/data/questionBankFull.json`);
    return structuredClone(found);
  });
}

function loadCanonical33Exams(): Exam[] {
  const meta = JSON.parse(fs.readFileSync(path.resolve('src/data/initialExamsMeta.json'), 'utf-8')) as {
    modelTests30: Exam[];
    subjectPracticeTests: Exam[];
  };
  return [...meta.modelTests30, ...meta.subjectPracticeTests];
}

function stripKey(q: ServerQuestion): Record<string, unknown> {
  const { correctOptionIndex: _c, explanationBn: _eb, explanationEn: _ee, ...rest } = q;
  return { ...rest };
}

function extractKeyDoc(q: ServerQuestion): Record<string, unknown> {
  return {
    questionId: q.id,
    correctOptionIndex: q.correctOptionIndex,
    explanationBn: q.explanationBn,
    explanationEn: q.explanationEn,
    legalReference: q.legalReference || '',
    updatedAt: q.updatedAt
  };
}

async function seedD1QuestionsAndKeys(
  db: D1Database,
  questions: ServerQuestion[],
  options?: { omitQuestionIds?: Set<string>; omitKeyIds?: Set<string> }
) {
  await db
    .prepare(
      `INSERT INTO question_bank_meta (id, version, version_token, synced_at, question_count)
       VALUES ('questionBankVersion', 1, 'test_conv_v1', '2026-11-28T00:55:00.000Z', ?1)
       ON CONFLICT(id) DO UPDATE SET question_count = excluded.question_count`
    )
    .bind(questions.length)
    .run();

  for (const q of questions) {
    if (!options?.omitQuestionIds?.has(q.id)) {
      await db
        .prepare(
          `INSERT INTO question_bank_cache (
             id, subject_id, topic_id, question_bn, question_en,
             options_bn_json, options_en_json, legal_reference, difficulty,
             status, is_demo_sample, created_at, updated_at, synced_version
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'test_conv_v1')
           ON CONFLICT(id) DO UPDATE SET
             subject_id = excluded.subject_id,
             status = excluded.status,
             options_bn_json = excluded.options_bn_json,
             options_en_json = excluded.options_en_json`
        )
        .bind(
          q.id,
          q.subjectId,
          q.topicId ?? null,
          q.questionBn,
          q.questionEn,
          JSON.stringify(q.optionsBn),
          JSON.stringify(q.optionsEn),
          q.legalReference || '',
          q.difficulty,
          q.status,
          q.isDemoSample ? 1 : 0,
          q.createdAt,
          q.updatedAt
        )
        .run();
    }

    if (!options?.omitKeyIds?.has(q.id)) {
      await db
        .prepare(
          `INSERT INTO question_keys_cache (
             question_id, correct_option_index, explanation_bn, explanation_en,
             legal_reference, updated_at, synced_version
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'test_conv_v1')
           ON CONFLICT(question_id) DO UPDATE SET
             correct_option_index = excluded.correct_option_index,
             explanation_bn = excluded.explanation_bn,
             explanation_en = excluded.explanation_en`
        )
        .bind(
          q.id,
          q.correctOptionIndex,
          q.explanationBn,
          q.explanationEn,
          q.legalReference || '',
          q.updatedAt
        )
        .run();
    }
  }
}

async function setupConversionHarness(options?: {
  initialExam?: Exam & { updatedAt: string };
  omitFsQuestionIds?: Set<string>;
  omitFsKeyIds?: Set<string>;
  omitD1QuestionIds?: Set<string>;
  omitD1KeyIds?: Set<string>;
  mutateQuestions?: (q: ServerQuestion) => ServerQuestion;
  extraQuestions?: ServerQuestion[];
  mutateExamOnCommitCall?: { callNumber: number; nextQuestionIds: string[]; nextUpdateTime: string };
  onGetDoc?: (col: string, id: string, callIndex: number) => Response | null;
}) {
  clearFirebaseJwksCacheForTests();
  const db = await createMigratedTestD1();
  const nowMs = Date.UTC(2026, 10, 28, 2, 0, 0);
  const keypair = await generateRs256Keypair('kid_conv_1');
  const fsStub = createConversionFirestoreStub({
    mutateExamOnCommitCall: options?.mutateExamOnCommitCall,
    onGetDoc: options?.onGetDoc
  });

  const canonical33 = loadCanonical33Exams();
  for (const ex of canonical33) {
    fsStub.setDoc('exams', ex.id, ex as unknown as Record<string, unknown>, '2026-11-26T00:00:00.000000Z');
  }

  const startExam = structuredClone(options?.initialExam || LIVE_MODEL_TEST_2_INACTIVE_7);
  const initialUpdateTime = '2026-11-26T05:44:42.741000Z';
  fsStub.setDoc(
    'exams',
    TARGET_MODEL_TEST_2_EXAM_ID,
    startExam as unknown as Record<string, unknown>,
    initialUpdateTime
  );
  await upsertExamsBatchD1(db, [...canonical33, startExam], '2026-11-26T05:44:42.741Z');

  // Seed all 100 approved questions + q_bank_0609 (remedy-forum control) + any extra fixtures
  const baseIds = [...APPROVED_100_QUESTION_IDS, 'q_bank_0609'];
  const baseQuestions = loadSourceQuestionsSubset(baseIds).map(q =>
    options?.mutateQuestions ? options.mutateQuestions(q) : q
  );
  const allSeedQuestions = [...baseQuestions, ...(options?.extraQuestions || [])];

  fsStub.setDoc(
    'config',
    'questionBankVersion',
    { version: 1, versionToken: 'test_conv_v1', updatedAt: '2026-11-28T00:55:00.000Z' },
    '2026-11-28T00:55:00.000000Z'
  );

  for (const q of allSeedQuestions) {
    if (!options?.omitFsQuestionIds?.has(q.id)) {
      fsStub.setDoc('questions', q.id, stripKey(q), '2026-11-28T00:55:00.000000Z');
    }
    if (!options?.omitFsKeyIds?.has(q.id)) {
      fsStub.setDoc('questionKeys', q.id, extractKeyDoc(q), '2026-11-28T00:55:00.000000Z');
    }
  }

  await seedD1QuestionsAndKeys(db, allSeedQuestions, {
    omitQuestionIds: options?.omitD1QuestionIds,
    omitKeyIds: options?.omitD1KeyIds
  });

  const env: WorkerEnv = {
    DB: db,
    FIREBASE_PROJECT_ID: EXPECTED_FIREBASE_PROJECT_ID,
    FIREBASE_DATABASE_ID: EXPECTED_FIREBASE_DATABASE_ID,
    ENVIRONMENT: 'production'
  };

  const handler = createWorkerHandler({
    fetchImpl: fsStub.fetchImpl,
    nowMsFn: () => nowMs,
    jwksFetcher: async () => ({ keys: [keypair.jwk], maxAgeSeconds: 3600 })
  });

  const signOwnerToken = (overrides?: Record<string, unknown>) =>
    signJwt(keypair.privateKey, keypair.kid, {
      aud: EXPECTED_FIREBASE_PROJECT_ID,
      iss: `https://securetoken.google.com/${EXPECTED_FIREBASE_PROJECT_ID}`,
      sub: OWNER_ADMIN_UID,
      user_id: OWNER_ADMIN_UID,
      email: OWNER_ADMIN_EMAIL,
      email_verified: true,
      iat: Math.floor(nowMs / 1000) - 60,
      exp: Math.floor(nowMs / 1000) + 3600,
      ...overrides
    });

  const signStudentToken = (uid: string, email: string, overrides?: Record<string, unknown>) =>
    signJwt(keypair.privateKey, keypair.kid, {
      aud: EXPECTED_FIREBASE_PROJECT_ID,
      iss: `https://securetoken.google.com/${EXPECTED_FIREBASE_PROJECT_ID}`,
      sub: uid,
      user_id: uid,
      email,
      email_verified: true,
      iat: Math.floor(nowMs / 1000) - 60,
      exp: Math.floor(nowMs / 1000) + 3600,
      ...overrides
    });

  return {
    db,
    env,
    handler,
    fsStub,
    nowMs,
    canonical33,
    allSeedQuestions,
    initialUpdateTime,
    signOwnerToken,
    signStudentToken
  };
}

function makeConvReq(token?: string, body: unknown = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return new Request('https://worker.example/api/admin/exams/convert-model-test-2', {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
}

describe('Owner-only Recoverable CAS Conversion (Model Test 2 -> 100 MCQs)', () => {
  test('1. Valid owner authentication: dry-run defaults cleanly with zero writes and full diagnostic report', async () => {
    const h = await setupConversionHarness();
    const ownerToken = await h.signOwnerToken();

    const res = await h.handler(makeConvReq(ownerToken, {}), h.env);
    assert.equal(res.status, 200);
    const report = (await res.json()) as any;
    assert.equal(report.examId, TARGET_MODEL_TEST_2_EXAM_ID);
    assert.equal(report.dryRun, true);
    assert.equal(report.executed, false);
    assert.equal(report.safeToExecute, true);
    assert.equal(report.subjectDistribution.matched, true);
    assert.deepEqual(report.subjectDistribution.actual, REQUIRED_SUBJECT_DISTRIBUTION);
    assert.equal(report.firestoreD1Parity.ok, true);
    assert.equal(report.firestoreD1Parity.questionCountMatched, 100);
    assert.equal(report.firestoreD1Parity.keyCountMatched, 100);
    assert.equal(report.keyIntegrity.validCount, 100);
    assert.equal(report.matchesApprovedList, true);
    assert.equal(h.fsStub.commitLog.length, 0);
  });

  test('2. Missing, malformed, or expired token returns 401 with zero writes', async () => {
    const h = await setupConversionHarness();

    const noAuth = await h.handler(makeConvReq(undefined, { dryRun: true }), h.env);
    assert.equal(noAuth.status, 401);

    const malformed = await h.handler(makeConvReq('not-a-valid-jwt', { dryRun: false }), h.env);
    assert.equal(malformed.status, 401);

    const expiredOwner = await h.signOwnerToken({ exp: Math.floor(h.nowMs / 1000) - 300 });
    const expired = await h.handler(makeConvReq(expiredOwner, { dryRun: false }), h.env);
    assert.equal(expired.status, 401);
    assert.equal(h.fsStub.commitLog.length, 0);
  });

  test('3. Non-owner rejected with 403 even with spoofed admin/owner claims in JWT & body', async () => {
    const h = await setupConversionHarness();
    const spoofed = await h.signStudentToken('attacker_uid', 'attacker@example.com', {
      role: 'owner',
      isAdmin: true,
      admin: true
    });

    const res = await h.handler(
      makeConvReq(spoofed, {
        dryRun: false,
        role: 'owner',
        isAdmin: true,
        expectedUpdateTime: h.initialUpdateTime
      }),
      h.env
    );
    assert.equal(res.status, 403);
    const body = (await res.json()) as any;
    assert.equal(body.error, 'FORBIDDEN');
    assert.equal(h.fsStub.commitLog.length, 0);
  });

  test('4. Unverified owner email (email_verified: false) rejected with 403 EMAIL_NOT_VERIFIED', async () => {
    const h = await setupConversionHarness();
    const unverifiedOwner = await h.signOwnerToken({ email_verified: false });

    const res = await h.handler(
      makeConvReq(unverifiedOwner, {
        dryRun: false,
        expectedUpdateTime: h.initialUpdateTime
      }),
      h.env
    );
    assert.equal(res.status, 403);
    const body = (await res.json()) as any;
    assert.equal(body.error, 'EMAIL_NOT_VERIFIED');
    assert.equal(h.fsStub.commitLog.length, 0);
  });

  test('5. Wrong exam ID rejected with 400 INVALID_EXAM_ID', async () => {
    const h = await setupConversionHarness();
    const ownerToken = await h.signOwnerToken();

    const res = await h.handler(
      makeConvReq(ownerToken, {
        examId: 'exam_model_test_1',
        dryRun: false,
        expectedUpdateTime: h.initialUpdateTime
      }),
      h.env
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as any;
    assert.equal(body.error, 'INVALID_EXAM_ID');
    assert.equal(h.fsStub.commitLog.length, 0);
  });

  test('6. Exactly 100 unique approved questions accepted and committed cleanly', async () => {
    const h = await setupConversionHarness();
    const ownerToken = await h.signOwnerToken();

    const res = await h.handler(
      makeConvReq(ownerToken, {
        dryRun: false,
        expectedUpdateTime: h.initialUpdateTime,
        expectedQuestionIds: [...CANONICAL_LEGACY_QUESTION_IDS],
        questionIds: [...APPROVED_100_QUESTION_IDS]
      }),
      h.env
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.success, true);
    assert.equal(body.exam.questionIds.length, 100);
    assert.deepEqual(body.exam.questionIds, [...APPROVED_100_QUESTION_IDS]);
  });

  test('7. Fewer than 100 questions rejected with 400 INVALID_QUESTION_COUNT', async () => {
    const h = await setupConversionHarness();
    const ownerToken = await h.signOwnerToken();

    const res = await h.handler(
      makeConvReq(ownerToken, {
        dryRun: false,
        expectedUpdateTime: h.initialUpdateTime,
        questionIds: APPROVED_100_QUESTION_IDS.slice(0, 99)
      }),
      h.env
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as any;
    assert.equal(body.error, 'INVALID_QUESTION_COUNT');
    assert.equal(h.fsStub.commitLog.length, 0);
  });

  test('8. More than 100 questions rejected with 400 INVALID_QUESTION_COUNT', async () => {
    const h = await setupConversionHarness();
    const ownerToken = await h.signOwnerToken();

    const res = await h.handler(
      makeConvReq(ownerToken, {
        dryRun: false,
        expectedUpdateTime: h.initialUpdateTime,
        questionIds: [...APPROVED_100_QUESTION_IDS, 'q_bank_0003']
      }),
      h.env
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as any;
    assert.equal(body.error, 'INVALID_QUESTION_COUNT');
    assert.equal(h.fsStub.commitLog.length, 0);
  });

  test('9. Duplicate question IDs rejected with 400 DUPLICATE_QUESTION_ID', async () => {
    const h = await setupConversionHarness();
    const ownerToken = await h.signOwnerToken();
    const dupIds = [...APPROVED_100_QUESTION_IDS];
    dupIds[1] = dupIds[0];

    const res = await h.handler(
      makeConvReq(ownerToken, {
        dryRun: false,
        expectedUpdateTime: h.initialUpdateTime,
        questionIds: dupIds
      }),
      h.env
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as any;
    assert.equal(body.error, 'DUPLICATE_QUESTION_ID');
    assert.equal(h.fsStub.commitLog.length, 0);
  });

  test('10. Incorrect subject distribution rejected with 422 SUBJECT_DISTRIBUTION_MISMATCH', async () => {
    // Extra CPC question swapped into a Bar Ethics slot (slot 99)
    const extraCpc = loadSourceQuestionsSubset(['q_bank_0025'])[0];
    const h = await setupConversionHarness({ extraQuestions: [extraCpc] });
    const ownerToken = await h.signOwnerToken();

    const skewedIds = [...APPROVED_100_QUESTION_IDS];
    skewedIds[99] = 'q_bank_0025'; // CPC=21, BarEthics=4

    const res = await h.handler(
      makeConvReq(ownerToken, {
        dryRun: false,
        expectedUpdateTime: h.initialUpdateTime,
        questionIds: skewedIds
      }),
      h.env
    );
    assert.equal(res.status, 422);
    const body = (await res.json()) as any;
    assert.equal(body.error, 'SUBJECT_DISTRIBUTION_MISMATCH');
    assert.equal(body.report.subjectDistribution.matched, false);
    assert.equal(body.report.subjectDistribution.actual.sub_cpc, 21);
    assert.equal(body.report.subjectDistribution.actual.sub_bar_ethics, 4);
    assert.equal(h.fsStub.commitLog.length, 0);
  });

  test('11. Missing Firestore question (e.g. q_bank_3001 unsynced) blocks conversion with zero writes', async () => {
    const h = await setupConversionHarness({ omitFsQuestionIds: new Set(['q_bank_3001']) });
    const ownerToken = await h.signOwnerToken();

    const dryRes = await h.handler(makeConvReq(ownerToken, { dryRun: true }), h.env);
    assert.equal(dryRes.status, 200);
    const dryBody = (await dryRes.json()) as any;
    assert.equal(dryBody.safeToExecute, false);
    assert.deepEqual(dryBody.missingQuestionIds.firestoreQuestions, ['q_bank_3001']);

    const execRes = await h.handler(
      makeConvReq(ownerToken, { dryRun: false, expectedUpdateTime: h.initialUpdateTime }),
      h.env
    );
    assert.equal(execRes.status, 422);
    const execBody = (await execRes.json()) as any;
    assert.equal(execBody.error, 'QUESTION_VALIDATION_FAILED');
    assert.equal(h.fsStub.commitLog.length, 0);
  });

  test('12. Missing D1 question (e.g. q_bank_3001 missing from D1 cache) blocks conversion with zero writes', async () => {
    const h = await setupConversionHarness({ omitD1QuestionIds: new Set(['q_bank_3001']) });
    const ownerToken = await h.signOwnerToken();

    const dryRes = await h.handler(makeConvReq(ownerToken, { dryRun: true }), h.env);
    assert.equal(dryRes.status, 200);
    const dryBody = (await dryRes.json()) as any;
    assert.equal(dryBody.safeToExecute, false);
    assert.deepEqual(dryBody.missingQuestionIds.d1Questions, ['q_bank_3001']);

    const execRes = await h.handler(
      makeConvReq(ownerToken, { dryRun: false, expectedUpdateTime: h.initialUpdateTime }),
      h.env
    );
    assert.equal(execRes.status, 422);
    assert.equal(h.fsStub.commitLog.length, 0);
  });

  test('13. Missing question key in Firestore or D1 blocks conversion with zero writes', async () => {
    const hFsKey = await setupConversionHarness({ omitFsKeyIds: new Set(['q_bank_2269']) });
    const ownerFs = await hFsKey.signOwnerToken();
    const resFs = await hFsKey.handler(
      makeConvReq(ownerFs, { dryRun: false, expectedUpdateTime: hFsKey.initialUpdateTime }),
      hFsKey.env
    );
    assert.equal(resFs.status, 422);
    const bodyFs = (await resFs.json()) as any;
    assert.deepEqual(bodyFs.report.missingQuestionIds.firestoreKeys, ['q_bank_2269']);
    assert.equal(hFsKey.fsStub.commitLog.length, 0);

    const hD1Key = await setupConversionHarness({ omitD1KeyIds: new Set(['q_bank_1874']) });
    const ownerD1 = await hD1Key.signOwnerToken();
    const resD1 = await hD1Key.handler(
      makeConvReq(ownerD1, { dryRun: false, expectedUpdateTime: hD1Key.initialUpdateTime }),
      hD1Key.env
    );
    assert.equal(resD1.status, 422);
    const bodyD1 = (await resD1.json()) as any;
    assert.deepEqual(bodyD1.report.missingQuestionIds.d1Keys, ['q_bank_1874']);
    assert.equal(hD1Key.fsStub.commitLog.length, 0);
  });

  test('14. Invalid correctOptionIndex rejected with zero writes', async () => {
    const h = await setupConversionHarness({
      mutateQuestions: q => (q.id === 'q_bank_0001' ? { ...q, correctOptionIndex: 4 } : q)
    });
    const ownerToken = await h.signOwnerToken();

    const res = await h.handler(
      makeConvReq(ownerToken, { dryRun: false, expectedUpdateTime: h.initialUpdateTime }),
      h.env
    );
    assert.equal(res.status, 422);
    const body = (await res.json()) as any;
    assert.equal(body.error, 'QUESTION_VALIDATION_FAILED');
    assert.equal(body.report.keyIntegrity.invalidQuestions[0].code, 'INVALID_CORRECT_OPTION_INDEX');
    assert.equal(h.fsStub.commitLog.length, 0);
  });

  test('15. Missing Bengali or English option (or fewer than 4 options) rejected', async () => {
    const h = await setupConversionHarness({
      mutateQuestions: q => (q.id === 'q_bank_0601' ? { ...q, optionsEn: ['A', 'B', '', 'D'] } : q)
    });
    const ownerToken = await h.signOwnerToken();

    const res = await h.handler(
      makeConvReq(ownerToken, { dryRun: false, expectedUpdateTime: h.initialUpdateTime }),
      h.env
    );
    assert.equal(res.status, 422);
    const body = (await res.json()) as any;
    assert.equal(body.report.keyIntegrity.invalidQuestions[0].code, 'INVALID_OPTIONS_EN');
    assert.equal(h.fsStub.commitLog.length, 0);
  });

  test('16. Missing Bengali or English explanation rejected', async () => {
    const h = await setupConversionHarness({
      mutateQuestions: q => (q.id === 'q_bank_1201' ? { ...q, explanationBn: '   ' } : q)
    });
    const ownerToken = await h.signOwnerToken();

    const res = await h.handler(
      makeConvReq(ownerToken, { dryRun: false, expectedUpdateTime: h.initialUpdateTime }),
      h.env
    );
    assert.equal(res.status, 422);
    const body = (await res.json()) as any;
    assert.equal(body.report.keyIntegrity.invalidQuestions[0].code, 'MISSING_EXPLANATION_BN');
    assert.equal(h.fsStub.commitLog.length, 0);
  });

  test('17. Remedy-forum template rejected (q_bank_0609 / generic judicial remedy template)', async () => {
    const h = await setupConversionHarness();
    const ownerToken = await h.signOwnerToken();
    const badIds = [...APPROVED_100_QUESTION_IDS];
    badIds[20] = 'q_bank_0609'; // Swap CrPC Sec 144 slot with corrupted appellate remedy template

    const res = await h.handler(
      makeConvReq(ownerToken, {
        dryRun: false,
        expectedUpdateTime: h.initialUpdateTime,
        questionIds: badIds
      }),
      h.env
    );
    assert.equal(res.status, 422);
    const body = (await res.json()) as any;
    assert.equal(body.error, 'REMEDY_TEMPLATE_REJECTED');
    assert.equal(body.report.remedyTemplateViolations[0].questionId, 'q_bank_0609');
    assert.equal(h.fsStub.commitLog.length, 0);
  });

  test('18. Invalid approved replacement mapping rejected with 422 APPROVED_MAPPING_INVALID', async () => {
    const extraCrpc = loadSourceQuestionsSubset(['q_bank_0624'])[0];
    const h = await setupConversionHarness({ extraQuestions: [extraCrpc] });
    const ownerToken = await h.signOwnerToken();
    const wrongCoreIds = [...APPROVED_100_QUESTION_IDS];
    wrongCoreIds[20] = 'q_bank_0624'; // Wrong CrPC question at approved q_crpc_1 slot (must be q_bank_3001)

    const res = await h.handler(
      makeConvReq(ownerToken, {
        dryRun: false,
        expectedUpdateTime: h.initialUpdateTime,
        questionIds: wrongCoreIds
      }),
      h.env
    );
    assert.equal(res.status, 422);
    const body = (await res.json()) as any;
    assert.equal(body.error, 'APPROVED_MAPPING_INVALID');
    assert.equal(body.report.approvedMappingsValidation[3].legacyQuestionId, 'q_crpc_1');
    assert.equal(body.report.approvedMappingsValidation[3].valid, false);
    assert.equal(h.fsStub.commitLog.length, 0);
  });

  test('19. Paid status (isPaid = true) preserved across Firestore and D1', async () => {
    const h = await setupConversionHarness();
    const ownerToken = await h.signOwnerToken();
    const res = await h.handler(
      makeConvReq(ownerToken, { dryRun: false, expectedUpdateTime: h.initialUpdateTime }),
      h.env
    );
    assert.equal(res.status, 200);
    const fsExam = h.fsStub.getDoc('exams', TARGET_MODEL_TEST_2_EXAM_ID)!;
    const d1Exam = (await getExamFromCacheD1(h.db, TARGET_MODEL_TEST_2_EXAM_ID))!;
    assert.equal(fsExam.isPaid, true);
    assert.equal(d1Exam.isPaid, true);
  });

  test('20. Published status, titles, type, explanations policy & updated 100-MCQ descriptions preserved/set', async () => {
    const h = await setupConversionHarness();
    const ownerToken = await h.signOwnerToken();
    const res = await h.handler(
      makeConvReq(ownerToken, { dryRun: false, expectedUpdateTime: h.initialUpdateTime }),
      h.env
    );
    assert.equal(res.status, 200);
    const fsExam = h.fsStub.getDoc('exams', TARGET_MODEL_TEST_2_EXAM_ID)!;
    const d1Exam = (await getExamFromCacheD1(h.db, TARGET_MODEL_TEST_2_EXAM_ID))!;

    for (const target of [fsExam, d1Exam]) {
      assert.equal(target.id, TARGET_MODEL_TEST_2_EXAM_ID);
      assert.equal(target.published, true);
      assert.equal(target.titleBn, LIVE_MODEL_TEST_2_INACTIVE_7.titleBn);
      assert.equal(target.titleEn, LIVE_MODEL_TEST_2_INACTIVE_7.titleEn);
      assert.equal(target.type, 'full_mock');
      assert.equal(target.releaseExplanationsImmediately, true);
      assert.equal(target.createdAt, LIVE_MODEL_TEST_2_INACTIVE_7.createdAt);
      assert.equal(target.descriptionBn, CONVERTED_DESCRIPTION_BN);
      assert.equal(target.descriptionEn, CONVERTED_DESCRIPTION_EN);
    }
  });

  test('21. isActive stays false during pending conversion and becomes true ONLY after completion', async () => {
    const h = await setupConversionHarness();
    const ownerToken = await h.signOwnerToken();

    assert.equal(h.fsStub.getDoc('exams', TARGET_MODEL_TEST_2_EXAM_ID)?.isActive, false);

    // Intercept Phase B to observe Firestore state mid-conversion (pending -> isActive must still be false)
    let observedPendingFsIsActive: unknown = 'not-observed';
    let observedPendingD1Status: string | undefined;
    h.db.failBatchOnMatch = sqls => {
      if (sqls.some(s => s.includes('edge_exams_cache')) && !sqls.some(s => s.includes('edge_audit_logs'))) {
        const fsDoc = h.fsStub.getDoc('exams', TARGET_MODEL_TEST_2_EXAM_ID);
        observedPendingFsIsActive = fsDoc?.isActive;
        observedPendingD1Status = (fsDoc?.conversionState as { status?: string } | undefined)?.status;
        return new Error('Simulated Phase B D1 failure');
      }
      return null;
    };

    const failRes = await h.handler(
      makeConvReq(ownerToken, { dryRun: false, expectedUpdateTime: h.initialUpdateTime }),
      h.env
    );
    assert.equal(failRes.status, 503);
    assert.equal(observedPendingD1Status, 'pending');
    assert.equal(observedPendingFsIsActive, false);

    // Clear fault and complete recovery -> now isActive becomes true
    h.db.failBatchOnMatch = undefined;
    const failBody = (await failRes.json()) as any;
    const recoverRes = await h.handler(
      makeConvReq(ownerToken, { dryRun: false, expectedUpdateTime: failBody.currentUpdateTime }),
      h.env
    );
    assert.equal(recoverRes.status, 200);
    assert.equal(h.fsStub.getDoc('exams', TARGET_MODEL_TEST_2_EXAM_ID)?.isActive, true);
    assert.equal((await getExamFromCacheD1(h.db, TARGET_MODEL_TEST_2_EXAM_ID))?.isActive, true);
  });

  test('22. totalMarks becomes 100 in both Firestore and D1', async () => {
    const h = await setupConversionHarness();
    const ownerToken = await h.signOwnerToken();
    const res = await h.handler(
      makeConvReq(ownerToken, { dryRun: false, expectedUpdateTime: h.initialUpdateTime }),
      h.env
    );
    assert.equal(res.status, 200);
    assert.equal(h.fsStub.getDoc('exams', TARGET_MODEL_TEST_2_EXAM_ID)?.totalMarks, 100);
    assert.equal((await getExamFromCacheD1(h.db, TARGET_MODEL_TEST_2_EXAM_ID))?.totalMarks, 100);
  });

  test('23. durationMinutes remains 60', async () => {
    const h = await setupConversionHarness();
    const ownerToken = await h.signOwnerToken();
    await h.handler(
      makeConvReq(ownerToken, { dryRun: false, expectedUpdateTime: h.initialUpdateTime }),
      h.env
    );
    assert.equal(h.fsStub.getDoc('exams', TARGET_MODEL_TEST_2_EXAM_ID)?.durationMinutes, 60);
    assert.equal((await getExamFromCacheD1(h.db, TARGET_MODEL_TEST_2_EXAM_ID))?.durationMinutes, 60);
  });

  test('24. negativeMarkRatio remains 0.25 and positiveMarkRatio remains 1', async () => {
    const h = await setupConversionHarness();
    const ownerToken = await h.signOwnerToken();
    await h.handler(
      makeConvReq(ownerToken, { dryRun: false, expectedUpdateTime: h.initialUpdateTime }),
      h.env
    );
    const fsExam = h.fsStub.getDoc('exams', TARGET_MODEL_TEST_2_EXAM_ID)!;
    const d1Exam = (await getExamFromCacheD1(h.db, TARGET_MODEL_TEST_2_EXAM_ID))!;
    assert.equal(fsExam.negativeMarkRatio, 0.25);
    assert.equal(fsExam.positiveMarkRatio, 1);
    assert.equal(d1Exam.negativeMarkRatio, 0.25);
    assert.equal(d1Exam.positiveMarkRatio, 1);
  });

  test('25. passThresholdPercentage remains 50', async () => {
    const h = await setupConversionHarness();
    const ownerToken = await h.signOwnerToken();
    await h.handler(
      makeConvReq(ownerToken, { dryRun: false, expectedUpdateTime: h.initialUpdateTime }),
      h.env
    );
    assert.equal(h.fsStub.getDoc('exams', TARGET_MODEL_TEST_2_EXAM_ID)?.passThresholdPercentage, 50);
    assert.equal((await getExamFromCacheD1(h.db, TARGET_MODEL_TEST_2_EXAM_ID))?.passThresholdPercentage, 50);
  });

  test('26. Stale CAS updateTime, missing expectedUpdateTime, and concurrent commit race rejected safely', async () => {
    // 26a: Missing expectedUpdateTime when dryRun=false
    const h0 = await setupConversionHarness();
    const owner0 = await h0.signOwnerToken();
    const missingCasRes = await h0.handler(makeConvReq(owner0, { dryRun: false }), h0.env);
    assert.equal(missingCasRes.status, 400);
    assert.equal(((await missingCasRes.json()) as any).error, 'CAS_PRECONDITION_REQUIRED');
    assert.equal(h0.fsStub.commitLog.length, 0);

    // 26b: Stale expectedUpdateTime
    const staleRes = await h0.handler(
      makeConvReq(owner0, { dryRun: false, expectedUpdateTime: '2026-01-01T00:00:00.000000Z' }),
      h0.env
    );
    assert.equal(staleRes.status, 409);
    assert.equal(((await staleRes.json()) as any).error, 'CAS_CONFLICT');
    assert.equal(h0.fsStub.commitLog.length, 0);

    // 26c: Concurrent commit race during Phase A CAS write
    const hRace = await setupConversionHarness({
      mutateExamOnCommitCall: {
        callNumber: 1,
        nextQuestionIds: [...CANONICAL_LEGACY_QUESTION_IDS],
        nextUpdateTime: '2026-11-28T02:00:59.999999Z'
      }
    });
    const ownerRace = await hRace.signOwnerToken();
    const raceRes = await hRace.handler(
      makeConvReq(ownerRace, { dryRun: false, expectedUpdateTime: hRace.initialUpdateTime }),
      hRace.env
    );
    assert.equal(raceRes.status, 409);
    assert.equal(((await raceRes.json()) as any).error, 'CAS_CONFLICT');
    // D1 must remain untouched when Firestore CAS rejects
    const d1AfterRace = await getExamFromCacheD1(hRace.db, TARGET_MODEL_TEST_2_EXAM_ID);
    assert.equal(d1AfterRace?.totalMarks, 7);
    assert.deepEqual(d1AfterRace?.questionIds, [...CANONICAL_LEGACY_QUESTION_IDS]);
  });

  test('27. Duplicate execution after completed conversion rejected with 409 ALREADY_CONVERTED', async () => {
    const h = await setupConversionHarness();
    const ownerToken = await h.signOwnerToken();

    const first = await h.handler(
      makeConvReq(ownerToken, { dryRun: false, expectedUpdateTime: h.initialUpdateTime }),
      h.env
    );
    assert.equal(first.status, 200);
    const commitsAfterFirst = h.fsStub.commitLog.length;

    const latestUpdateTime = h.fsStub.getDocMeta('exams', TARGET_MODEL_TEST_2_EXAM_ID)!.updateTime;
    const second = await h.handler(
      makeConvReq(ownerToken, { dryRun: false, expectedUpdateTime: latestUpdateTime }),
      h.env
    );
    assert.equal(second.status, 409);
    const secondBody = (await second.json()) as any;
    assert.equal(secondBody.error, 'ALREADY_CONVERTED');
    assert.equal(h.fsStub.commitLog.length, commitsAfterFirst);
  });

  test('28. D1 failure recovery works across both Phase B (pending) and Phase D (completed)', async () => {
    // 28a: Phase B D1 failure -> returns 503 with pending status -> recovery finishes
    const h1 = await setupConversionHarness();
    const owner1 = await h1.signOwnerToken();
    h1.db.failBatchOnMatch = sqls =>
      sqls.some(s => s.includes('edge_exams_cache')) && !sqls.some(s => s.includes('edge_audit_logs'))
        ? new Error('D1 transient write error (Phase B)')
        : null;

    const failB = await h1.handler(
      makeConvReq(owner1, { dryRun: false, expectedUpdateTime: h1.initialUpdateTime }),
      h1.env
    );
    assert.equal(failB.status, 503);
    const failBBody = (await failB.json()) as any;
    assert.equal(failBBody.error, 'D1_SYNC_FAILED_RECOVERY_REQUIRED');
    assert.equal(failBBody.firestoreCommitted, true);
    assert.equal(failBBody.d1Synced, false);
    assert.equal(failBBody.recoveryRequired, true);
    assert.equal(failBBody.conversionStatus, 'pending');

    h1.db.failBatchOnMatch = undefined;
    const recoverB = await h1.handler(
      makeConvReq(owner1, { dryRun: false, expectedUpdateTime: failBBody.currentUpdateTime }),
      h1.env
    );
    assert.equal(recoverB.status, 200);
    const recoverBBody = (await recoverB.json()) as any;
    assert.equal(recoverBBody.success, true);
    assert.equal(recoverBBody.recovered, true);
    assert.equal(recoverBBody.exam.isActive, true);
    assert.equal(recoverBBody.exam.totalMarks, 100);

    // 28b: Phase D D1 completion failure -> Firestore is already completed -> D1 recovery reconciles cleanly
    const h2 = await setupConversionHarness();
    const owner2 = await h2.signOwnerToken();
    h2.db.failBatchOnMatch = sqls =>
      sqls.some(s => s.includes('edge_audit_logs')) ? new Error('D1 transient write error (Phase D)') : null;

    const failD = await h2.handler(
      makeConvReq(owner2, { dryRun: false, expectedUpdateTime: h2.initialUpdateTime }),
      h2.env
    );
    assert.equal(failD.status, 503);
    const failDBody = (await failD.json()) as any;
    assert.equal(failDBody.error, 'D1_SYNC_FAILED_RECOVERY_REQUIRED');
    assert.equal(failDBody.conversionStatus, 'completed');

    h2.db.failBatchOnMatch = undefined;
    const recoverD = await h2.handler(
      makeConvReq(owner2, { dryRun: false, expectedUpdateTime: failDBody.currentUpdateTime }),
      h2.env
    );
    assert.equal(recoverD.status, 200);
    const recoverDBody = (await recoverD.json()) as any;
    assert.equal(recoverDBody.success, true);
    assert.equal(recoverDBody.recovered, true);
    assert.equal((await getExamFromCacheD1(h2.db, TARGET_MODEL_TEST_2_EXAM_ID))?.questionIds?.length, 100);
    assert.equal((await getExamFromCacheD1(h2.db, TARGET_MODEL_TEST_2_EXAM_ID))?.isActive, true);
  });

  test('29. Recovery is idempotent: re-running after recovery returns 409 ALREADY_CONVERTED', async () => {
    const h = await setupConversionHarness();
    const ownerToken = await h.signOwnerToken();

    h.db.failBatchOnMatch = sqls => (sqls.some(s => s.includes('edge_audit_logs')) ? new Error('Phase D failure') : null);
    const failRes = await h.handler(
      makeConvReq(ownerToken, { dryRun: false, expectedUpdateTime: h.initialUpdateTime }),
      h.env
    );
    const failBody = (await failRes.json()) as any;

    h.db.failBatchOnMatch = undefined;
    const recRes = await h.handler(
      makeConvReq(ownerToken, { dryRun: false, expectedUpdateTime: failBody.currentUpdateTime }),
      h.env
    );
    assert.equal(recRes.status, 200);
    const recBody = (await recRes.json()) as any;

    const retryAfterRecovery = await h.handler(
      makeConvReq(ownerToken, { dryRun: false, expectedUpdateTime: recBody.report.currentUpdateTime }),
      h.env
    );
    assert.equal(retryAfterRecovery.status, 409);
    assert.equal(((await retryAfterRecovery.json()) as any).error, 'ALREADY_CONVERTED');
  });

  test('30. Audit logging is idempotent: exactly 1 Firestore audit log and 1 D1 audit log row across failure & recovery', async () => {
    const h = await setupConversionHarness();
    const ownerToken = await h.signOwnerToken();

    // Simulate Phase D failure AFTER Firestore created auditLogs/CONVERSION_AUDIT_LOG_ID
    h.db.failBatchOnMatch = sqls => (sqls.some(s => s.includes('edge_audit_logs')) ? new Error('Phase D fault') : null);
    const failRes = await h.handler(
      makeConvReq(ownerToken, { dryRun: false, expectedUpdateTime: h.initialUpdateTime }),
      h.env
    );
    assert.equal(failRes.status, 503);
    assert.ok(h.fsStub.getDoc('auditLogs', CONVERSION_AUDIT_LOG_ID));

    h.db.failBatchOnMatch = undefined;
    const failBody = (await failRes.json()) as any;
    const recoverRes = await h.handler(
      makeConvReq(ownerToken, { dryRun: false, expectedUpdateTime: failBody.currentUpdateTime }),
      h.env
    );
    assert.equal(recoverRes.status, 200);

    assert.equal(h.fsStub.getCol('auditLogs').size, 1);
    assert.ok(h.fsStub.getDoc('auditLogs', CONVERSION_AUDIT_LOG_ID));

    const d1Audits = await listAuditLogsD1(h.db, 20);
    const convLogs = d1Audits.filter(a => a.id === CONVERSION_AUDIT_LOG_ID);
    assert.equal(convLogs.length, 1);
    assert.equal(convLogs[0].action, 'CONVERT_MODEL_TEST_2_TO_100');
  });

  test('31. Student exam start & question reads blocked with 409 EXAM_CONVERSION_PENDING while pending', async () => {
    const h = await setupConversionHarness();
    const ownerToken = await h.signOwnerToken();

    // Inject Phase B failure so exam enters pending state
    h.db.failBatchOnMatch = sqls =>
      sqls.some(s => s.includes('edge_exams_cache')) && !sqls.some(s => s.includes('edge_audit_logs'))
        ? new Error('Phase B fault')
        : null;
    await h.handler(
      makeConvReq(ownerToken, { dryRun: false, expectedUpdateTime: h.initialUpdateTime }),
      h.env
    );
    h.db.failBatchOnMatch = undefined;

    const studentUid = 'student_pro_pending';
    h.fsStub.setDoc('users', studentUid, {
      uid: studentUid,
      name: 'Pro Student',
      email: 'student.pending@example.com',
      role: 'student',
      subscriptionStatus: 'pro',
      subscriptionExpiresAt: '2027-01-01T00:00:00.000Z'
    });
    const studentToken = await h.signStudentToken(studentUid, 'student.pending@example.com');
    const sessRes = await h.handler(
      new Request('https://worker.example/api/auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${studentToken}` },
        body: JSON.stringify({ deviceInfo: 'TestBrowser' })
      }),
      h.env
    );
    const { sessionId } = (await sessRes.json()) as any;

    const startRes = await h.handler(
      new Request('https://worker.example/api/exams/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${studentToken}`,
          'x-session-id': sessionId
        },
        body: JSON.stringify({ examId: TARGET_MODEL_TEST_2_EXAM_ID })
      }),
      h.env
    );
    assert.equal(startRes.status, 409);
    assert.equal(((await startRes.json()) as any).error, 'EXAM_CONVERSION_PENDING');

    const qFetchRes = await h.handler(
      new Request(`https://worker.example/api/questions?examId=${TARGET_MODEL_TEST_2_EXAM_ID}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${studentToken}`, 'x-session-id': sessionId }
      }),
      h.env
    );
    assert.equal(qFetchRes.status, 409);
    assert.equal(((await qFetchRes.json()) as any).error, 'EXAM_CONVERSION_PENDING');
  });

  test('32. Post-conversion student exam flow enforces paid subscription & grades 100 questions at +1/-0.25', async () => {
    const h = await setupConversionHarness();
    const ownerToken = await h.signOwnerToken();

    const convRes = await h.handler(
      makeConvReq(ownerToken, { dryRun: false, expectedUpdateTime: h.initialUpdateTime }),
      h.env
    );
    assert.equal(convRes.status, 200);

    // 32a: Free student gets 403 SUBSCRIPTION_REQUIRED
    const freeUid = 'student_free_100';
    h.fsStub.setDoc('users', freeUid, {
      uid: freeUid,
      name: 'Free Student',
      email: 'free100@example.com',
      role: 'student',
      subscriptionStatus: 'free'
    });
    const freeToken = await h.signStudentToken(freeUid, 'free100@example.com');
    const freeSess = (await (
      await h.handler(
        new Request('https://worker.example/api/auth/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${freeToken}` },
          body: JSON.stringify({ deviceInfo: 'Browser' })
        }),
        h.env
      )
    ).json()) as any;

    const freeStart = await h.handler(
      new Request('https://worker.example/api/exams/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${freeToken}`,
          'x-session-id': freeSess.sessionId
        },
        body: JSON.stringify({ examId: TARGET_MODEL_TEST_2_EXAM_ID })
      }),
      h.env
    );
    assert.equal(freeStart.status, 403);
    assert.equal(((await freeStart.json()) as any).error, 'SUBSCRIPTION_REQUIRED');

    // 32b: Pro student receives 100 sanitized questions & gets +1/-0.25 graded out of 100
    const proUid = 'student_pro_100';
    h.fsStub.setDoc('users', proUid, {
      uid: proUid,
      name: 'Pro Student',
      email: 'pro100@example.com',
      role: 'student',
      subscriptionStatus: 'pro',
      subscriptionExpiresAt: '2027-01-01T00:00:00.000Z'
    });
    const proToken = await h.signStudentToken(proUid, 'pro100@example.com');
    const proSess = (await (
      await h.handler(
        new Request('https://worker.example/api/auth/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${proToken}` },
          body: JSON.stringify({ deviceInfo: 'Browser' })
        }),
        h.env
      )
    ).json()) as any;

    const proStart = await h.handler(
      new Request('https://worker.example/api/exams/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${proToken}`,
          'x-session-id': proSess.sessionId
        },
        body: JSON.stringify({ examId: TARGET_MODEL_TEST_2_EXAM_ID })
      }),
      h.env
    );
    assert.equal(proStart.status, 200);
    const proStartBody = (await proStart.json()) as any;
    assert.equal(proStartBody.questions.length, 100);
    assert.equal(proStartBody.questions[0].correctOptionIndex, undefined);

    const byId = new Map(h.allSeedQuestions.map(q => [q.id, q]));
    const answers: Record<string, number> = {};
    // Answer 60 correctly, 4 incorrectly, leave 36 unanswered -> score = 60 - 1 = 59 (>= 50 pass)
    APPROVED_100_QUESTION_IDS.forEach((qId, idx) => {
      const q = byId.get(qId)!;
      if (idx < 60) {
        answers[qId] = q.correctOptionIndex;
      } else if (idx < 64) {
        answers[qId] = (q.correctOptionIndex + 1) % 4;
      }
    });

    const submitRes = await h.handler(
      new Request('https://worker.example/api/exams/submit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${proToken}`,
          'x-session-id': proSess.sessionId
        },
        body: JSON.stringify({
          attemptId: proStartBody.attempt.id,
          answers
        })
      }),
      h.env
    );
    assert.equal(submitRes.status, 200);
    const submitBody = (await submitRes.json()) as any;
    assert.equal(submitBody.result.totalQuestions, 100);
    assert.equal(submitBody.result.correctAnswersCount, 60);
    assert.equal(submitBody.result.incorrectAnswersCount, 4);
    assert.equal(submitBody.result.unansweredCount, 36);
    assert.equal(submitBody.result.positiveMarks, 60);
    assert.equal(submitBody.result.negativeMarks, 1);
    assert.equal(submitBody.result.finalScore, 59);
    assert.equal(submitBody.result.percentage, 59);
    assert.equal(submitBody.result.passed, true);
  });

  test('33. Conversion starting from post-repair 7-question snapshot, canonical 33 exam isolation, and CLI safety defaults', async () => {
    // 33a: Also verify conversion works when Model Test 2 already contains the 7 repaired IDs with totalMarks=7
    const repaired7Exam: Exam & { updatedAt: string } = {
      ...LIVE_MODEL_TEST_2_INACTIVE_7,
      questionIds: [...APPROVED_7_REPLACEMENTS_ORDERED],
      totalMarks: 7
    };
    const h = await setupConversionHarness({ initialExam: repaired7Exam });
    const ownerToken = await h.signOwnerToken();

    const beforeCanonicalFs = h.canonical33.map(ex => structuredClone(h.fsStub.getDoc('exams', ex.id)));
    const beforeCanonicalD1 = (await listExamsFromCacheD1(h.db)).filter(
      ex => ex.id !== TARGET_MODEL_TEST_2_EXAM_ID
    );

    // CLI defaults strictly to dryRun=true
    assert.deepEqual(CLI_APPROVED_100_IDS, [...APPROVED_100_QUESTION_IDS]);
    const cliDefault = parseConversionCliArgs([]);
    assert.equal(cliDefault.valid, true);
    assert.equal(cliDefault.dryRun, true);
    assert.equal(cliDefault.execute, false);
    const cliConflict = parseConversionCliArgs(['--dry-run', '--execute']);
    assert.equal(cliConflict.valid, false);

    const workerFetch: typeof fetch = async (input, init) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      return h.handler(req, h.env);
    };

    // CLI dry-run writes 0 commits
    const dryRes = await runConvertOwnerModelTest2To100({
      workerUrl: 'https://local-test-worker.example',
      idToken: ownerToken,
      nowMs: h.nowMs,
      fetchImpl: workerFetch
    });
    assert.equal(dryRes.dryRun, true);
    assert.equal(dryRes.executed, false);
    assert.equal(dryRes.safeToExecute, true);
    assert.equal(h.fsStub.commitLog.length, 0);

    // CLI --execute runs preflight + 2-phase CAS + D1 sync cleanly
    const execRes = await runConvertOwnerModelTest2To100({
      execute: true,
      workerUrl: 'https://local-test-worker.example',
      idToken: ownerToken,
      nowMs: h.nowMs,
      fetchImpl: workerFetch
    });
    assert.equal(execRes.executed, true);
    assert.equal(execRes.exam.questionIds.length, 100);
    assert.equal(execRes.exam.isActive, true);

    // Canonical 33 exams completely untouched in Firestore & D1
    const afterCanonicalFs = h.canonical33.map(ex => h.fsStub.getDoc('exams', ex.id));
    const afterCanonicalD1 = (await listExamsFromCacheD1(h.db)).filter(
      ex => ex.id !== TARGET_MODEL_TEST_2_EXAM_ID
    );
    assert.deepEqual(afterCanonicalFs, beforeCanonicalFs);
    assert.deepEqual(afterCanonicalD1, beforeCanonicalD1);
  });

  test('34. Post-Phase-A Firestore metadata read failure returns 503 D1_SYNC_FAILED_RECOVERY_REQUIRED and recovers cleanly', async () => {
    let injectPhaseAMetaFault = true;
    const h = await setupConversionHarness({
      onGetDoc: (col, id, callIdx) => {
        // Call 1 = Step 3 preflight read, Call 2 = post-Phase-A metadata read
        if (injectPhaseAMetaFault && col === 'exams' && id === TARGET_MODEL_TEST_2_EXAM_ID && callIdx === 2) {
          return new Response(
            JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'Transient Phase A read outage' } }),
            { status: 503, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return null;
      }
    });
    const ownerToken = await h.signOwnerToken();

    const failRes = await h.handler(
      makeConvReq(ownerToken, { dryRun: false, expectedUpdateTime: h.initialUpdateTime }),
      h.env
    );
    assert.equal(failRes.status, 503);
    const failBody = (await failRes.json()) as any;
    assert.equal(failBody.error, 'D1_SYNC_FAILED_RECOVERY_REQUIRED');
    assert.equal(failBody.firestoreCommitted, true);
    assert.equal(failBody.d1Synced, true);
    assert.equal(failBody.recoveryRequired, true);
    assert.equal(failBody.conversionStatus, 'pending');
    assert.equal(failBody.currentUpdateTime, h.initialUpdateTime);
    assert.ok(String(failBody.metadataReadError || '').includes('Transient Phase A read outage'));
    assert.equal(h.fsStub.getDoc('exams', TARGET_MODEL_TEST_2_EXAM_ID)?.isActive, false);
    assert.equal((await getExamFromCacheD1(h.db, TARGET_MODEL_TEST_2_EXAM_ID))?.isActive, false);

    // Clear fault -> dry-run discovers actual post-Phase-A updateTime -> recovery completes with 1 audit log
    injectPhaseAMetaFault = false;
    const dryRes = await h.handler(makeConvReq(ownerToken, { dryRun: true }), h.env);
    assert.equal(dryRes.status, 200);
    const dryBody = (await dryRes.json()) as any;
    assert.equal(dryBody.conversionStatus, 'pending');
    assert.equal(dryBody.recoveryRequired, true);
    assert.equal(dryBody.safeToExecute, true);

    const recRes = await h.handler(
      makeConvReq(ownerToken, { dryRun: false, expectedUpdateTime: dryBody.currentUpdateTime }),
      h.env
    );
    assert.equal(recRes.status, 200);
    const recBody = (await recRes.json()) as any;
    assert.equal(recBody.success, true);
    assert.equal(recBody.recovered, true);
    assert.equal(recBody.exam.isActive, true);
    assert.equal(h.fsStub.getCol('auditLogs').size, 1);
    assert.equal((await listAuditLogsD1(h.db, 20)).filter(a => a.id === CONVERSION_AUDIT_LOG_ID).length, 1);
  });

  test('35. Post-Phase-C Firestore metadata read failure preserves currentUpdateTime and returns D1_SYNC_FAILED_RECOVERY_REQUIRED on D1 failure', async () => {
    let injectPhaseCMetaFault = true;
    const h = await setupConversionHarness({
      onGetDoc: (col, id, callIdx) => {
        // Call 1 = Step 3, Call 2 = post-Phase-A, Call 3 = post-Phase-C metadata read
        if (injectPhaseCMetaFault && col === 'exams' && id === TARGET_MODEL_TEST_2_EXAM_ID && callIdx === 3) {
          return new Response(
            JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'Transient Phase C read outage' } }),
            { status: 503, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return null;
      }
    });
    const ownerToken = await h.signOwnerToken();

    // Also fail Phase D D1 write on first run to verify currentUpdateTime (post-Phase-A) is preserved
    h.db.failBatchOnMatch = sqls => (sqls.some(s => s.includes('edge_audit_logs')) ? new Error('Phase D write failure') : null);
    const failRes = await h.handler(
      makeConvReq(ownerToken, { dryRun: false, expectedUpdateTime: h.initialUpdateTime }),
      h.env
    );
    assert.equal(failRes.status, 503);
    const failBody = (await failRes.json()) as any;
    assert.equal(failBody.error, 'D1_SYNC_FAILED_RECOVERY_REQUIRED');
    assert.equal(failBody.firestoreCommitted, true);
    assert.equal(failBody.d1Synced, false);
    assert.equal(failBody.conversionStatus, 'completed');
    assert.ok(failBody.currentUpdateTime, 'currentUpdateTime must be preserved when post-Phase-C metadata read fails');
    assert.ok(String(failBody.metadataReadError || '').includes('Transient Phase C read outage'));

    // Recover Phase D cleanly without duplicating audit log
    h.db.failBatchOnMatch = undefined;
    injectPhaseCMetaFault = false;
    const dryRes = await h.handler(makeConvReq(ownerToken, { dryRun: true }), h.env);
    const dryBody = (await dryRes.json()) as any;
    assert.equal(dryBody.conversionStatus, 'completed');
    assert.equal(dryBody.recoveryRequired, true);
    assert.equal(dryBody.alreadyConverted, false);

    const recRes = await h.handler(
      makeConvReq(ownerToken, { dryRun: false, expectedUpdateTime: dryBody.currentUpdateTime }),
      h.env
    );
    assert.equal(recRes.status, 200);
    const recBody = (await recRes.json()) as any;
    assert.equal(recBody.recovered, true);
    assert.equal(h.fsStub.getCol('auditLogs').size, 1);
    assert.equal((await listAuditLogsD1(h.db, 20)).filter(a => a.id === CONVERSION_AUDIT_LOG_ID).length, 1);
  });

  test('36. Hardened Firestore audit-log lookup rejects transient read errors and avoids duplicate audit creation', async () => {
    // 36a: Transient 503 on Step 3 audit log lookup fails with 503 AUDIT_LOG_READ_FAILED and 0 writes
    const hUpfront = await setupConversionHarness({
      onGetDoc: (col, id) => {
        if (col === 'auditLogs' && id === CONVERSION_AUDIT_LOG_ID) {
          return new Response(
            JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'Audit lookup failed' } }),
            { status: 503, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return null;
      }
    });
    const ownerUpfront = await hUpfront.signOwnerToken();
    const errRes = await hUpfront.handler(
      makeConvReq(ownerUpfront, { dryRun: false, expectedUpdateTime: hUpfront.initialUpdateTime }),
      hUpfront.env
    );
    assert.equal(errRes.status, 503);
    assert.equal(((await errRes.json()) as any).error, 'AUDIT_LOG_READ_FAILED');
    assert.equal(hUpfront.fsStub.commitLog.length, 0);

    // 36b: Transient 503 on Phase C audit verification (after Phase A+B committed) returns 503 D1_SYNC_FAILED_RECOVERY_REQUIRED
    let failSecondAuditRead = true;
    const hPhaseC = await setupConversionHarness({
      onGetDoc: (col, id, callIdx) => {
        if (failSecondAuditRead && col === 'auditLogs' && id === CONVERSION_AUDIT_LOG_ID && callIdx === 2) {
          return new Response(
            JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'Phase C audit read transient error' } }),
            { status: 503, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return null;
      }
    });
    const ownerPhaseC = await hPhaseC.signOwnerToken();
    const partialRes = await hPhaseC.handler(
      makeConvReq(ownerPhaseC, { dryRun: false, expectedUpdateTime: hPhaseC.initialUpdateTime }),
      hPhaseC.env
    );
    assert.equal(partialRes.status, 503);
    const partialBody = (await partialRes.json()) as any;
    assert.equal(partialBody.error, 'D1_SYNC_FAILED_RECOVERY_REQUIRED');
    assert.equal(partialBody.conversionStatus, 'pending');
    assert.ok(partialBody.currentUpdateTime);

    failSecondAuditRead = false;
    const recRes = await hPhaseC.handler(
      makeConvReq(ownerPhaseC, { dryRun: false, expectedUpdateTime: partialBody.currentUpdateTime }),
      hPhaseC.env
    );
    assert.equal(recRes.status, 200);
    assert.equal(((await recRes.json()) as any).recovered, true);
    assert.equal(hPhaseC.fsStub.getCol('auditLogs').size, 1);
  });

  test('37. Completion cannot be inferred without required conversion metadata and Firestore/D1 audit consistency', async () => {
    // 37a: 100 questions + totalMarks=100 + isActive=true WITHOUT conversionState -> NOT inferred completed
    const examWithoutConvState: Exam & { updatedAt: string } = {
      ...LIVE_MODEL_TEST_2_INACTIVE_7,
      questionIds: [...APPROVED_100_QUESTION_IDS],
      totalMarks: 100,
      isActive: true
    };
    const hNoMeta = await setupConversionHarness({ initialExam: examWithoutConvState });
    const ownerNoMeta = await hNoMeta.signOwnerToken();
    const dryNoMeta = await (await hNoMeta.handler(makeConvReq(ownerNoMeta, { dryRun: true }), hNoMeta.env)).json() as any;
    assert.equal(dryNoMeta.alreadyConverted, false);
    assert.equal(dryNoMeta.conversionStatus, 'not_started');
    assert.equal(dryNoMeta.safeToExecute, false);

    // 37b: conversionState status=completed with incomplete metadata (missing auditLogId/completedBy) -> blocked with 422
    const examIncompleteMeta = {
      ...examWithoutConvState,
      conversionState: {
        operationId: CONVERSION_OPERATION_ID,
        status: 'completed',
        targetQuestionCount: 100
      }
    } as unknown as Exam & { updatedAt: string };
    const hBadMeta = await setupConversionHarness({ initialExam: examIncompleteMeta });
    const ownerBadMeta = await hBadMeta.signOwnerToken();
    const execBadMeta = await hBadMeta.handler(
      makeConvReq(ownerBadMeta, { dryRun: false, expectedUpdateTime: hBadMeta.initialUpdateTime }),
      hBadMeta.env
    );
    assert.equal(execBadMeta.status, 422);
    assert.equal(((await execBadMeta.json()) as any).error, 'CONVERSION_METADATA_INCONSISTENT');

    // 37c: Valid completed conversionState metadata on exam WITHOUT Firestore audit log -> NOT alreadyConverted; recovery creates single audit log
    const examMissingAudit = {
      ...examWithoutConvState,
      conversionState: {
        operationId: CONVERSION_OPERATION_ID,
        status: 'completed',
        targetQuestionCount: 100,
        previousTotalMarks: 7,
        startedAt: '2026-11-28T01:59:00.000Z',
        startedBy: OWNER_ADMIN_UID,
        completedAt: '2026-11-28T02:00:00.000Z',
        completedBy: OWNER_ADMIN_UID,
        auditLogId: CONVERSION_AUDIT_LOG_ID
      }
    } as unknown as Exam & { updatedAt: string };
    const hMissingAudit = await setupConversionHarness({ initialExam: examMissingAudit });
    const ownerMissingAudit = await hMissingAudit.signOwnerToken();
    const dryMissingAudit = (await (await hMissingAudit.handler(makeConvReq(ownerMissingAudit, { dryRun: true }), hMissingAudit.env)).json()) as any;
    assert.equal(dryMissingAudit.alreadyConverted, false);
    assert.equal(dryMissingAudit.conversionStatus, 'pending');
    assert.equal(dryMissingAudit.recoveryRequired, true);
    assert.equal(dryMissingAudit.safeToExecute, true);

    const recMissingAudit = await hMissingAudit.handler(
      makeConvReq(ownerMissingAudit, { dryRun: false, expectedUpdateTime: dryMissingAudit.currentUpdateTime }),
      hMissingAudit.env
    );
    assert.equal(recMissingAudit.status, 200);
    assert.equal(hMissingAudit.fsStub.getCol('auditLogs').size, 1);

    // 37d: If D1 edge_audit_logs row is missing while exam cache is complete, recovery reconciles D1 with 0 Firestore writes
    await hMissingAudit.db.prepare(`DELETE FROM edge_audit_logs WHERE id = ?1`).bind(CONVERSION_AUDIT_LOG_ID).run();
    const commitsBeforeD1OnlyRec = hMissingAudit.fsStub.commitLog.length;
    const dryD1Audit = (await (await hMissingAudit.handler(makeConvReq(ownerMissingAudit, { dryRun: true }), hMissingAudit.env)).json()) as any;
    assert.equal(dryD1Audit.alreadyConverted, false);
    assert.equal(dryD1Audit.conversionStatus, 'completed');
    assert.equal(dryD1Audit.recoveryRequired, true);

    const recD1Audit = await hMissingAudit.handler(
      makeConvReq(ownerMissingAudit, { dryRun: false, expectedUpdateTime: dryD1Audit.currentUpdateTime }),
      hMissingAudit.env
    );
    assert.equal(recD1Audit.status, 200);
    assert.equal(hMissingAudit.fsStub.commitLog.length, commitsBeforeD1OnlyRec);
    assert.equal((await listAuditLogsD1(hMissingAudit.db, 20)).filter(a => a.id === CONVERSION_AUDIT_LOG_ID).length, 1);
  });

  test('38. Firestore/D1 question content and answer-key parity mismatches block conversion with zero writes', async () => {
    // 38a: D1 question_bank_cache content/legalReference diverges from Firestore while ID exists in both
    const hQ = await setupConversionHarness();
    const ownerQ = await hQ.signOwnerToken();
    await hQ.db
      .prepare(`UPDATE question_bank_cache SET legal_reference = 'Tampered Section 999' WHERE id = 'q_bank_0001'`)
      .run();

    const qRes = await hQ.handler(
      makeConvReq(ownerQ, { dryRun: false, expectedUpdateTime: hQ.initialUpdateTime }),
      hQ.env
    );
    assert.equal(qRes.status, 422);
    const qBody = (await qRes.json()) as any;
    assert.equal(qBody.error, 'QUESTION_VALIDATION_FAILED');
    assert.equal(qBody.report.firestoreD1Parity.ok, false);
    assert.ok(qBody.report.firestoreD1Parity.mismatches.some((m: { questionId: string }) => m.questionId === 'q_bank_0001'));
    assert.equal(hQ.fsStub.commitLog.length, 0);

    // 38b: D1 question_keys_cache correctOptionIndex diverges from Firestore questionKeys
    const hK = await setupConversionHarness();
    const ownerK = await hK.signOwnerToken();
    const originalIdx = Number(hK.fsStub.getDoc('questionKeys', 'q_bank_3001')?.correctOptionIndex ?? 0);
    await hK.db
      .prepare(`UPDATE question_keys_cache SET correct_option_index = ?1 WHERE question_id = 'q_bank_3001'`)
      .bind((originalIdx + 1) % 4)
      .run();

    const kRes = await hK.handler(
      makeConvReq(ownerK, { dryRun: false, expectedUpdateTime: hK.initialUpdateTime }),
      hK.env
    );
    assert.equal(kRes.status, 422);
    const kBody = (await kRes.json()) as any;
    assert.equal(kBody.error, 'QUESTION_VALIDATION_FAILED');
    assert.equal(kBody.report.firestoreD1Parity.ok, false);
    assert.ok(kBody.report.firestoreD1Parity.mismatches.some((m: { questionId: string }) => m.questionId === 'q_bank_3001'));
    assert.equal(hK.fsStub.commitLog.length, 0);
  });

  test('39. POST /api/exams/submit pending conversion guard allows historical snapshotted attempts and blocks unsafe ones', async () => {
    const h = await setupConversionHarness();
    const ownerToken = await h.signOwnerToken();

    // Seed all canonical bank questions used by pre-conversion Model Test 2 (CANONICAL_LEGACY_QUESTION_IDS) in D1 for grading historical attempt
    const preConvQuestions = loadSourceQuestionsSubset(APPROVED_7_REPLACEMENTS_ORDERED);
    const legacyTestQuestions: ServerQuestion[] = CANONICAL_LEGACY_QUESTION_IDS.map((legacyId, idx) => ({
      ...preConvQuestions[idx],
      id: legacyId
    }));
    await seedD1QuestionsAndKeys(h.db, legacyTestQuestions);

    // Create pro student session
    const studentUid = 'student_submit_guard';
    h.fsStub.setDoc('users', studentUid, {
      uid: studentUid,
      name: 'Submit Guard Student',
      email: 'submit.guard@example.com',
      role: 'student',
      subscriptionStatus: 'pro',
      subscriptionExpiresAt: '2027-01-01T00:00:00.000Z'
    });
    const studentToken = await h.signStudentToken(studentUid, 'submit.guard@example.com');
    const sessRes = await h.handler(
      new Request('https://worker.example/api/auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${studentToken}` },
        body: JSON.stringify({ deviceInfo: 'TestBrowser' })
      }),
      h.env
    );
    const { sessionId } = (await sessRes.json()) as any;

    // Transition Model Test 2 into pending conversion state via Phase B fault
    h.db.failBatchOnMatch = sqls =>
      sqls.some(s => s.includes('edge_exams_cache')) && !sqls.some(s => s.includes('edge_audit_logs'))
        ? new Error('Phase B fault for submit guard test')
        : null;
    await h.handler(
      makeConvReq(ownerToken, { dryRun: false, expectedUpdateTime: h.initialUpdateTime }),
      h.env
    );
    h.db.failBatchOnMatch = undefined;

    const pendingConvStartedAt = h.fsStub.getDoc('exams', TARGET_MODEL_TEST_2_EXAM_ID)?.conversionState as {
      startedAt: string;
    };
    const startedBeforeMs = Date.parse(pendingConvStartedAt.startedAt) - 120_000;
    const beforeIso = new Date(startedBeforeMs).toISOString();
    const deadlineIso = new Date(startedBeforeMs + 3_600_000).toISOString();

    // 39a: Legitimate historical attempt started BEFORE conversion with frozen resolvedQuestionIds -> SUCCEEDS (200)
    await insertExamAttemptD1(h.db, {
      id: 'attempt_hist_valid_7',
      examId: TARGET_MODEL_TEST_2_EXAM_ID,
      userId: studentUid,
      sessionId,
      studentName: 'Submit Guard Student',
      startTime: beforeIso,
      deadlineTime: deadlineIso,
      status: 'in_progress',
      answers: {},
      flaggedQuestionIds: [],
      currentQuestionIndex: 0,
      lastSavedAt: beforeIso,
      resolvedQuestionIds: [...CANONICAL_LEGACY_QUESTION_IDS]
    });

    const histAnswers: Record<string, number> = {};
    legacyTestQuestions.forEach(q => {
      histAnswers[q.id] = q.correctOptionIndex;
    });
    const histSubmitRes = await h.handler(
      new Request('https://worker.example/api/exams/submit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${studentToken}`,
          'x-session-id': sessionId
        },
        body: JSON.stringify({ attemptId: 'attempt_hist_valid_7', answers: histAnswers })
      }),
      h.env
    );
    assert.equal(histSubmitRes.status, 200);
    const histSubmitBody = (await histSubmitRes.json()) as any;
    assert.equal(histSubmitBody.result.totalQuestions, 7);
    assert.equal(histSubmitBody.result.correctAnswersCount, 7);

    // 39b: Attempt WITHOUT frozen resolvedQuestionIds during pending -> BLOCKED (409 EXAM_CONVERSION_PENDING)
    await insertExamAttemptD1(h.db, {
      id: 'attempt_missing_frozen_ids',
      examId: TARGET_MODEL_TEST_2_EXAM_ID,
      userId: studentUid,
      sessionId,
      studentName: 'Submit Guard Student',
      startTime: beforeIso,
      deadlineTime: deadlineIso,
      status: 'in_progress',
      answers: {},
      flaggedQuestionIds: [],
      currentQuestionIndex: 0,
      lastSavedAt: beforeIso
    });

    const unsafeSubmitRes = await h.handler(
      new Request('https://worker.example/api/exams/submit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${studentToken}`,
          'x-session-id': sessionId
        },
        body: JSON.stringify({ attemptId: 'attempt_missing_frozen_ids', answers: {} })
      }),
      h.env
    );
    assert.equal(unsafeSubmitRes.status, 409);
    assert.equal(((await unsafeSubmitRes.json()) as any).error, 'EXAM_CONVERSION_PENDING');

    // 39c: Attempt started AFTER conversionState.startedAt during pending -> BLOCKED (409 EXAM_CONVERSION_PENDING)
    const afterIso = new Date(Date.parse(pendingConvStartedAt.startedAt) + 5_000).toISOString();
    await insertExamAttemptD1(h.db, {
      id: 'attempt_started_during_pending',
      examId: TARGET_MODEL_TEST_2_EXAM_ID,
      userId: studentUid,
      sessionId,
      studentName: 'Submit Guard Student',
      startTime: afterIso,
      deadlineTime: deadlineIso,
      status: 'in_progress',
      answers: {},
      flaggedQuestionIds: [],
      currentQuestionIndex: 0,
      lastSavedAt: afterIso,
      resolvedQuestionIds: [...CANONICAL_LEGACY_QUESTION_IDS]
    });

    const duringSubmitRes = await h.handler(
      new Request('https://worker.example/api/exams/submit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${studentToken}`,
          'x-session-id': sessionId
        },
        body: JSON.stringify({ attemptId: 'attempt_started_during_pending', answers: {} })
      }),
      h.env
    );
    assert.equal(duringSubmitRes.status, 409);
    assert.equal(((await duringSubmitRes.json()) as any).error, 'EXAM_CONVERSION_PENDING');
  });
});

