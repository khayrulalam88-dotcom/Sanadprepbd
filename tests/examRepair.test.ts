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
import { upsertExamsBatchD1, getExamFromCacheD1, listExamsFromCacheD1, listAuditLogsD1 } from '../worker/d1Store.ts';
import {
  CANONICAL_LEGACY_QUESTION_IDS,
  TARGET_MODEL_TEST_2_EXAM_ID
} from '../worker/examRepair.ts';
import {
  DEFAULT_PROPOSED_REPLACEMENTS,
  parseRepairCliArgs,
  runRepairOwnerModelTest2
} from '../scripts/repairOwnerModelTest2.mjs';
import type { Exam, ServerQuestion } from '../src/types/index.ts';

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

function createRepairFirestoreStub(options?: {
  mutateExamOnCommitCall?: { callNumber: number; nextQuestionIds: string[]; nextUpdateTime: string };
}) {
  const expectedPrefix = `https://firestore.googleapis.com/v1/projects/${EXPECTED_FIREBASE_PROJECT_ID}/databases/${EXPECTED_FIREBASE_DATABASE_ID}/documents`;
  const collections = new Map<string, Map<string, Record<string, unknown>>>();
  const docTimestamps = new Map<string, { createTime: string; updateTime: string }>();
  const commitLog: Array<{ writes: unknown[] }> = [];
  let commitCalls = 0;
  let tsSeq = 0;

  const nextUpdateTimestamp = () => {
    tsSeq += 1;
    return `2026-11-27T01:00:${String(tsSeq).padStart(2, '0')}.000000Z`;
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

  const getDoc = (col: string, id: string) => getCol(col).get(id) || null;
  const getDocMeta = (col: string, id: string) => docTimestamps.get(`${col}/${id}`);

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method || 'GET').toUpperCase();

    assert.ok(url.startsWith(expectedPrefix), `Unexpected Firestore URL: ${url}`);
    const restPath = url.slice(expectedPrefix.length);

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

      // Atomic precondition check
      for (const w of parsed.writes || []) {
        assert.equal(w.delete, undefined, 'Repair commits must never delete documents');
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

      // Apply atomic writes
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

    // Single document GET /documents/{col}/{id}
    const clean = restPath.split('?')[0].replace(/^\/+/, '');
    const parts = clean.split('/');
    if (method === 'GET' && parts.length === 2) {
      const [col, rawId] = parts;
      const docId = decodeURIComponent(rawId);
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

  return { fetchImpl, setDoc, getDoc, getDocMeta, commitLog, getCol };
}

const LIVE_MODEL_TEST_2_SNAPSHOT: Exam & { updatedAt: string } = {
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
  isActive: true,
  published: true,
  releaseExplanationsImmediately: true,
  negativeMarkRatio: 0.25,
  positiveMarkRatio: 1,
  createdAt: '2026-11-26T05:44:42.276Z',
  updatedAt: '2026-11-26T05:44:42.741Z'
};

const VALID_CORRECTED_CRPC_144_QUESTION: ServerQuestion = {
  id: 'q_bank_0609_sec144_corrected',
  subjectId: 'sub_crpc',
  questionBn:
    'ফৌজদারী কার্যবিধির কোন ধারা অনুসারে তাৎক্ষণিক শান্তি ভঙ্গ বা জননিরাপত্তা বিঘ্নিত হওয়ার আশঙ্কায় ম্যাজিস্ট্রেট ১৪৪ ধারা সাময়িক নিষেধাজ্ঞা জারি করেন?',
  questionEn:
    'Under which section of the Code of Criminal Procedure, 1898 is a temporary prohibitory order issued to prevent urgent cases of nuisance or apprehended danger?',
  optionsBn: ['ধারা ১৩৩ (Section 133)', 'ধারা ১৪৪ (Section 144)', 'ধারা ১৪৫ (Section 145)', 'ধারা ১০৭ (Section 107)'],
  optionsEn: ['Section 133', 'Section 144', 'Section 145', 'Section 107'],
  correctOptionIndex: 1,
  explanationBn: 'ধারা ১৪৪ (ফৌজদারী কার্যবিধি, ১৮৯৮): জননিরাপত্তা বিঘ্নিত হওয়ার আশঙ্কায় ম্যাজিস্ট্রেট কর্তৃক সাময়িক নিষেধাজ্ঞা।',
  explanationEn: 'Section 144 CrPC, 1898: Urgent temporary prohibitory order in cases of nuisance or apprehended danger.',
  legalReference: 'The Code of Criminal Procedure, 1898 - ধারা ১৪৪',
  difficulty: 'easy',
  status: 'published',
  isDemoSample: false,
  createdAt: '2026-11-27T00:00:00.000Z',
  updatedAt: '2026-11-27T00:00:00.000Z'
};

const VALID_7_REPLACEMENTS = [
  'q_bank_2648',
  'q_bank_2269',
  'q_bank_2851',
  'q_bank_0609_sec144_corrected',
  'q_bank_1292',
  'q_bank_1874',
  'q_bank_0043'
];

function loadSourceQuestionsSubset(ids: string[]): ServerQuestion[] {
  const all = JSON.parse(fs.readFileSync(path.resolve('server/data/questionBankFull.json'), 'utf-8')) as ServerQuestion[];
  const byId = new Map(all.map(q => [q.id, q]));
  return ids.map(id => {
    const found = byId.get(id);
    assert.ok(found, `Expected ${id} in server/data/questionBankFull.json`);
    return found;
  });
}

function loadCanonical33Exams(): Exam[] {
  const meta = JSON.parse(fs.readFileSync(path.resolve('src/data/initialExamsMeta.json'), 'utf-8')) as {
    modelTests30: Exam[];
    subjectPracticeTests: Exam[];
  };
  return [...meta.modelTests30, ...meta.subjectPracticeTests];
}

async function seedD1QuestionsAndKeys(
  db: D1Database,
  questions: ServerQuestion[],
  options?: { omitKeyIds?: Set<string> }
) {
  await db
    .prepare(
      `INSERT INTO question_bank_meta (id, version, version_token, synced_at, question_count)
       VALUES ('questionBankVersion', 1, 'test_v1', '2026-11-27T00:55:00.000Z', ?1)
       ON CONFLICT(id) DO UPDATE SET question_count = excluded.question_count`
    )
    .bind(questions.length)
    .run();

  for (const q of questions) {
    await db
      .prepare(
        `INSERT INTO question_bank_cache (
           id, subject_id, topic_id, question_bn, question_en,
           options_bn_json, options_en_json, legal_reference, difficulty,
           status, is_demo_sample, created_at, updated_at, synced_version
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'test_v1')
         ON CONFLICT(id) DO UPDATE SET subject_id = excluded.subject_id`
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

    if (!options?.omitKeyIds?.has(q.id)) {
      await db
        .prepare(
          `INSERT INTO question_keys_cache (
             question_id, correct_option_index, explanation_bn, explanation_en,
             legal_reference, updated_at, synced_version
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'test_v1')
           ON CONFLICT(question_id) DO UPDATE SET correct_option_index = excluded.correct_option_index`
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

async function setupHarness(options?: {
  omitKeyIds?: Set<string>;
  extraQuestions?: ServerQuestion[];
  mutateExamOnCommitCall?: { callNumber: number; nextQuestionIds: string[]; nextUpdateTime: string };
}) {
  clearFirebaseJwksCacheForTests();
  const db = await createMigratedTestD1();
  const nowMs = Date.UTC(2026, 10, 27, 1, 0, 0);
  const keypair = await generateRs256Keypair('kid_repair_1');
  const fsStub = createRepairFirestoreStub({
    mutateExamOnCommitCall: options?.mutateExamOnCommitCall
  });

  const canonical33 = loadCanonical33Exams();
  for (const ex of canonical33) {
    fsStub.setDoc('exams', ex.id, ex as unknown as Record<string, unknown>, '2026-11-26T00:00:00.000000Z');
  }
  const initialUpdateTime = '2026-11-26T05:44:42.741000Z';
  fsStub.setDoc(
    'exams',
    TARGET_MODEL_TEST_2_EXAM_ID,
    LIVE_MODEL_TEST_2_SNAPSHOT as unknown as Record<string, unknown>,
    initialUpdateTime
  );
  await upsertExamsBatchD1(
    db,
    [...canonical33, LIVE_MODEL_TEST_2_SNAPSHOT],
    '2026-11-26T05:44:42.741Z'
  );

  // Seed real candidate questions from questionBankFull.json + corrected Sec 144 + extra test fixtures
  const realCandidates = loadSourceQuestionsSubset([
    'q_bank_2648',
    'q_bank_2269',
    'q_bank_2851',
    'q_bank_0609',
    'q_bank_1292',
    'q_bank_1874',
    'q_bank_0043',
    'q_bank_0001'
  ]);
  fsStub.setDoc(
    'config',
    'questionBankVersion',
    { version: 1, versionToken: 'test_v1', updatedAt: '2026-11-27T00:55:00.000Z' },
    '2026-11-27T00:55:00.000000Z'
  );
  await seedD1QuestionsAndKeys(
    db,
    [...realCandidates, VALID_CORRECTED_CRPC_144_QUESTION, ...(options?.extraQuestions || [])],
    { omitKeyIds: options?.omitKeyIds }
  );

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
    initialUpdateTime,
    signOwnerToken,
    signStudentToken
  };
}

describe('Owner-only CAS Repair for exam_1795671882276_o1zj5', () => {
  test('1. Valid mapping test: repairs exam atomically and allows Pro student exam start & submit', async () => {
    const h = await setupHarness();
    const ownerToken = await h.signOwnerToken();

    // Dry-run first
    const dryRes = await h.handler(
      new Request('https://worker.example/api/admin/exams/repair-model-test-2', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`
        },
        body: JSON.stringify({
          dryRun: true,
          replacementQuestionIds: VALID_7_REPLACEMENTS
        })
      }),
      h.env
    );
    assert.equal(dryRes.status, 200);
    const dryBody = (await dryRes.json()) as any;
    assert.equal(dryBody.safeToExecute, true);
    assert.equal(dryBody.executed, false);
    assert.equal(h.fsStub.commitLog.length, 0);

    // Execute repair with CAS updateTime
    const execRes = await h.handler(
      new Request('https://worker.example/api/admin/exams/repair-model-test-2', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`
        },
        body: JSON.stringify({
          dryRun: false,
          expectedUpdateTime: dryBody.currentUpdateTime,
          expectedQuestionIds: [...CANONICAL_LEGACY_QUESTION_IDS],
          replacementQuestionIds: VALID_7_REPLACEMENTS
        })
      }),
      h.env
    );
    assert.equal(execRes.status, 200);
    const execBody = (await execRes.json()) as any;
    assert.equal(execBody.success, true);
    assert.equal(execBody.report.executed, true);
    assert.deepEqual(execBody.exam.questionIds, VALID_7_REPLACEMENTS);
    assert.equal(h.fsStub.commitLog.length, 1);

    // Verify D1 cache & audit log updated
    const d1Exam = await getExamFromCacheD1(h.db, TARGET_MODEL_TEST_2_EXAM_ID);
    assert.ok(d1Exam);
    assert.deepEqual(d1Exam.questionIds, VALID_7_REPLACEMENTS);
    const audits = await listAuditLogsD1(h.db, 10);
    assert.ok(audits.some(a => a.action === 'REPAIR_OWNER_EXAM_QUESTIONS'));

    // Verify a Pro student can start & submit the repaired Model Test 2 end-to-end
    const studentUid = 'student_pro_repair_1';
    h.fsStub.setDoc('users', studentUid, {
      uid: studentUid,
      name: 'Pro Student',
      email: 'student@example.com',
      role: 'student',
      subscriptionStatus: 'pro',
      subscriptionExpiresAt: '2027-01-01T00:00:00.000Z'
    });
    const studentToken = await h.signStudentToken(studentUid, 'student@example.com');

    // Create active session
    const sessRes = await h.handler(
      new Request('https://worker.example/api/auth/session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${studentToken}`
        },
        body: JSON.stringify({ deviceInfo: 'TestBrowser' })
      }),
      h.env
    );
    assert.equal(sessRes.status, 200);
    const sessBody = (await sessRes.json()) as any;

    const startRes = await h.handler(
      new Request('https://worker.example/api/exams/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${studentToken}`,
          'x-session-id': sessBody.sessionId
        },
        body: JSON.stringify({ examId: TARGET_MODEL_TEST_2_EXAM_ID })
      }),
      h.env
    );
    assert.equal(startRes.status, 200);
    const startBody = (await startRes.json()) as any;
    assert.equal(startBody.questions.length, 7);
    assert.deepEqual(
      startBody.questions.map((q: any) => q.id),
      VALID_7_REPLACEMENTS
    );

    const submitRes = await h.handler(
      new Request('https://worker.example/api/exams/submit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${studentToken}`,
          'x-session-id': sessBody.sessionId
        },
        body: JSON.stringify({
          attemptId: startBody.attempt.id,
          answers: {
            q_bank_2648: 1,
            q_bank_2269: 0,
            q_bank_2851: 0,
            q_bank_0609_sec144_corrected: 1,
            q_bank_1292: 1,
            q_bank_1874: 1,
            q_bank_0043: 0
          }
        })
      }),
      h.env
    );
    assert.equal(submitRes.status, 200);
    const submitBody = (await submitRes.json()) as any;
    assert.equal(submitBody.result.correctAnswersCount, 7);
    assert.equal(submitBody.result.finalScore, 7);
    assert.equal(submitBody.result.passed, true);
  });

  test('2. Invalid question ID test: nonexistent replacement ID is rejected with zero writes', async () => {
    const h = await setupHarness();
    const ownerToken = await h.signOwnerToken();
    const badIds = [...VALID_7_REPLACEMENTS];
    badIds[6] = 'q_bank_999999_nonexistent';

    const res = await h.handler(
      new Request('https://worker.example/api/admin/exams/repair-model-test-2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({
          dryRun: false,
          expectedUpdateTime: h.initialUpdateTime,
          replacementQuestionIds: badIds
        })
      }),
      h.env
    );
    assert.equal(res.status, 422);
    const body = (await res.json()) as any;
    assert.equal(body.report.slotValidations[6].status, 'MISSING_QUESTION');
    assert.equal(h.fsStub.commitLog.length, 0);
    const d1Exam = await getExamFromCacheD1(h.db, TARGET_MODEL_TEST_2_EXAM_ID);
    assert.deepEqual(d1Exam?.questionIds, [...CANONICAL_LEGACY_QUESTION_IDS]);
  });

  test('3. Missing answer-key test: missing or corrupt D1 question_keys_cache entry is rejected', async () => {
    const h = await setupHarness({ omitKeyIds: new Set(['q_bank_2648']) });
    const ownerToken = await h.signOwnerToken();

    const res = await h.handler(
      new Request('https://worker.example/api/admin/exams/repair-model-test-2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({
          dryRun: false,
          expectedUpdateTime: h.initialUpdateTime,
          replacementQuestionIds: VALID_7_REPLACEMENTS
        })
      }),
      h.env
    );
    assert.equal(res.status, 422);
    const body = (await res.json()) as any;
    assert.equal(body.report.slotValidations[0].status, 'MISSING_ANSWER_KEY');
    assert.equal(body.report.slotValidations[0].answerKeyFoundInD1, false);
    assert.equal(h.fsStub.commitLog.length, 0);
  });

  test('4. Subject mismatch test: valid question from wrong subject is rejected', async () => {
    const h = await setupHarness();
    const ownerToken = await h.signOwnerToken();
    const wrongSubjectIds = [...VALID_7_REPLACEMENTS];
    wrongSubjectIds[0] = 'q_bank_0001'; // sub_cpc placed in slot #1 (expected sub_limitation)

    const res = await h.handler(
      new Request('https://worker.example/api/admin/exams/repair-model-test-2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({
          dryRun: false,
          expectedUpdateTime: h.initialUpdateTime,
          replacementQuestionIds: wrongSubjectIds
        })
      }),
      h.env
    );
    assert.equal(res.status, 422);
    const body = (await res.json()) as any;
    assert.equal(body.report.slotValidations[0].status, 'SUBJECT_MISMATCH');
    assert.equal(body.report.slotValidations[0].subjectMatch, false);
    assert.equal(h.fsStub.commitLog.length, 0);
  });

  test('5. Semantic mapping rejection test: q_bank_0609 (#4 CrPC Sec 144) is flagged NEEDS_CORRECTION_AND_OWNER_APPROVAL and rejected', async () => {
    const limSec3WrongIntent: ServerQuestion = {
      id: 'q_bank_lim_sec3_wrong',
      subjectId: 'sub_limitation',
      questionBn: 'তামাদি আইনের ৩ ধারা অনুসারে তামাদির মেয়াদ উত্তীর্ণ মোকদ্দমা আদালত কী করবেন?',
      questionEn: 'Under Section 3 of the Limitation Act, what must the court do with a time-barred suit?',
      optionsBn: ['খারিজ করবেন', 'মঞ্জুর করবেন', 'স্থগিত করবেন', 'ফেরত দেবেন'],
      optionsEn: ['Dismiss it', 'Allow it', 'Stay it', 'Return it'],
      correctOptionIndex: 0,
      explanationBn: 'ধারা ৩ (তামাদি আইন, ১৯০৮): তামাদি বারিত হলে আদালত খারিজ করবেন।',
      explanationEn: 'Section 3 Limitation Act: Dismissal of time-barred suit.',
      legalReference: 'The Limitation Act, 1908 - ধারা ৩',
      difficulty: 'easy',
      status: 'published',
      isDemoSample: false,
      createdAt: '2026-11-27T00:00:00.000Z',
      updatedAt: '2026-11-27T00:00:00.000Z'
    };

    const h = await setupHarness({ extraQuestions: [limSec3WrongIntent] });
    const ownerToken = await h.signOwnerToken();

    // 5a: Default proposed list (with q_bank_0609 in slot #4) in dry-run
    const dryRes = await h.handler(
      new Request('https://worker.example/api/admin/exams/repair-model-test-2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({
          dryRun: true,
          replacementQuestionIds: DEFAULT_PROPOSED_REPLACEMENTS
        })
      }),
      h.env
    );
    assert.equal(dryRes.status, 200);
    const dryBody = (await dryRes.json()) as any;
    assert.equal(dryBody.safeToExecute, false);
    assert.equal(dryBody.slotValidations[3].replacementQuestionId, 'q_bank_0609');
    assert.equal(dryBody.slotValidations[3].status, 'NEEDS_CORRECTION_AND_OWNER_APPROVAL');
    assert.equal(dryBody.slotValidations[3].requiresCorrectionAndOwnerApproval, true);
    assert.equal(dryBody.slotValidations[3].semanticMatch, false);

    // 5b: Attempting to execute with q_bank_0609 MUST be rejected (no silent approval!)
    const execRes = await h.handler(
      new Request('https://worker.example/api/admin/exams/repair-model-test-2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({
          dryRun: false,
          expectedUpdateTime: h.initialUpdateTime,
          replacementQuestionIds: DEFAULT_PROPOSED_REPLACEMENTS,
          approveMismatch: true,
          force: true
        })
      }),
      h.env
    );
    assert.equal(execRes.status, 422);
    const execBody = (await execRes.json()) as any;
    assert.equal(execBody.error, 'SEMANTIC_MISMATCH_REQUIRES_CORRECTION');
    assert.equal(execBody.report.slotValidations[3].status, 'NEEDS_CORRECTION_AND_OWNER_APPROVAL');
    assert.equal(h.fsStub.commitLog.length, 0);

    // 5c: Semantic mismatch on another slot (Limitation Sec 3 instead of Sec 5) also rejected
    const sec3MismatchIds = [...VALID_7_REPLACEMENTS];
    sec3MismatchIds[0] = 'q_bank_lim_sec3_wrong';
    const resSec3 = await h.handler(
      new Request('https://worker.example/api/admin/exams/repair-model-test-2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({
          dryRun: false,
          expectedUpdateTime: h.initialUpdateTime,
          replacementQuestionIds: sec3MismatchIds
        })
      }),
      h.env
    );
    assert.equal(resSec3.status, 422);
    const bodySec3 = (await resSec3.json()) as any;
    assert.equal(bodySec3.report.slotValidations[0].status, 'SEMANTIC_MISMATCH');
    assert.equal(h.fsStub.commitLog.length, 0);
  });

  test('6. Unauthorized user rejection test: missing, malformed, or expired token returns 401', async () => {
    const h = await setupHarness();

    const noAuthRes = await h.handler(
      new Request('https://worker.example/api/admin/exams/repair-model-test-2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: true, replacementQuestionIds: VALID_7_REPLACEMENTS })
      }),
      h.env
    );
    assert.equal(noAuthRes.status, 401);

    const badTokenRes = await h.handler(
      new Request('https://worker.example/api/admin/exams/repair-model-test-2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer not-a-jwt' },
        body: JSON.stringify({ dryRun: false, replacementQuestionIds: VALID_7_REPLACEMENTS })
      }),
      h.env
    );
    assert.equal(badTokenRes.status, 401);

    const expiredOwnerToken = await h.signOwnerToken({ exp: Math.floor(h.nowMs / 1000) - 600 });
    const expRes = await h.handler(
      new Request('https://worker.example/api/admin/exams/repair-model-test-2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${expiredOwnerToken}` },
        body: JSON.stringify({ dryRun: false, replacementQuestionIds: VALID_7_REPLACEMENTS })
      }),
      h.env
    );
    assert.equal(expRes.status, 401);
    assert.equal(h.fsStub.commitLog.length, 0);
  });

  test('7. Non-owner admin rejection test: student/non-owner JWT with spoofed admin claims returns 403', async () => {
    const h = await setupHarness();
    const spoofedToken = await h.signStudentToken('attacker_uid_123', 'attacker@example.com', {
      role: 'admin',
      isAdmin: true,
      admin: true
    });

    const res = await h.handler(
      new Request('https://worker.example/api/admin/exams/repair-model-test-2', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${spoofedToken}`
        },
        body: JSON.stringify({
          dryRun: false,
          isAdmin: true,
          role: 'admin',
          expectedUpdateTime: h.initialUpdateTime,
          replacementQuestionIds: VALID_7_REPLACEMENTS
        })
      }),
      h.env
    );
    assert.equal(res.status, 403);
    const body = (await res.json()) as any;
    assert.equal(body.error, 'FORBIDDEN');
    assert.equal(h.fsStub.commitLog.length, 0);
  });

  test('8. CAS conflict test: stale updateTime and concurrent modification both return 409 with zero D1 drift', async () => {
    // 8a: Stale expectedUpdateTime
    const h1 = await setupHarness();
    const owner1 = await h1.signOwnerToken();
    const staleRes = await h1.handler(
      new Request('https://worker.example/api/admin/exams/repair-model-test-2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner1}` },
        body: JSON.stringify({
          dryRun: false,
          expectedUpdateTime: '2026-01-01T00:00:00.000000Z',
          replacementQuestionIds: VALID_7_REPLACEMENTS
        })
      }),
      h1.env
    );
    assert.equal(staleRes.status, 409);
    const staleBody = (await staleRes.json()) as any;
    assert.equal(staleBody.error, 'CAS_CONFLICT');
    assert.equal(h1.fsStub.commitLog.length, 0);

    // 8b: Concurrent modification race right as Firestore :commit executes
    const h2 = await setupHarness({
      mutateExamOnCommitCall: {
        callNumber: 1,
        nextQuestionIds: ['q_lim_1', 'q_sra_1', 'q_bco_1', 'q_crpc_1', 'q_penal_1', 'q_evi_1', 'q_cpc_1'],
        nextUpdateTime: '2026-11-27T01:00:59.999999Z'
      }
    });
    const owner2 = await h2.signOwnerToken();
    const raceRes = await h2.handler(
      new Request('https://worker.example/api/admin/exams/repair-model-test-2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner2}` },
        body: JSON.stringify({
          dryRun: false,
          expectedUpdateTime: h2.initialUpdateTime,
          replacementQuestionIds: VALID_7_REPLACEMENTS
        })
      }),
      h2.env
    );
    assert.equal(raceRes.status, 409);
    // D1 must NOT be modified when Firestore CAS commit rejects!
    const d1AfterRace = await getExamFromCacheD1(h2.db, TARGET_MODEL_TEST_2_EXAM_ID);
    assert.deepEqual(d1AfterRace?.questionIds, [...CANONICAL_LEGACY_QUESTION_IDS]);
  });

  test('9. Duplicate execution test: second repair attempt is rejected with 409 ALREADY_REPAIRED', async () => {
    const h = await setupHarness();
    const ownerToken = await h.signOwnerToken();

    const firstRes = await h.handler(
      new Request('https://worker.example/api/admin/exams/repair-model-test-2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({
          dryRun: false,
          expectedUpdateTime: h.initialUpdateTime,
          replacementQuestionIds: VALID_7_REPLACEMENTS
        })
      }),
      h.env
    );
    assert.equal(firstRes.status, 200);
    assert.equal(h.fsStub.commitLog.length, 1);

    const newMeta = h.fsStub.getDocMeta('exams', TARGET_MODEL_TEST_2_EXAM_ID);
    const secondRes = await h.handler(
      new Request('https://worker.example/api/admin/exams/repair-model-test-2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({
          dryRun: false,
          expectedUpdateTime: newMeta?.updateTime || h.initialUpdateTime,
          replacementQuestionIds: VALID_7_REPLACEMENTS
        })
      }),
      h.env
    );
    assert.equal(secondRes.status, 409);
    const secondBody = (await secondRes.json()) as any;
    assert.equal(secondBody.error, 'ALREADY_REPAIRED');
    assert.equal(h.fsStub.commitLog.length, 1);
  });

  test('10. Snapshot preservation test: Model Test 2 metadata & all 33 canonical exams stay intact', async () => {
    const h = await setupHarness();
    const ownerToken = await h.signOwnerToken();

    const beforeCanonicalFs = h.canonical33.map(ex => structuredClone(h.fsStub.getDoc('exams', ex.id)));
    const beforeCanonicalD1 = (await listExamsFromCacheD1(h.db)).filter(
      ex => ex.id !== TARGET_MODEL_TEST_2_EXAM_ID
    );

    const res = await h.handler(
      new Request('https://worker.example/api/admin/exams/repair-model-test-2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({
          dryRun: false,
          expectedUpdateTime: h.initialUpdateTime,
          replacementQuestionIds: VALID_7_REPLACEMENTS
        })
      }),
      h.env
    );
    assert.equal(res.status, 200);

    // Check Model Test 2 preserved fields in BOTH Firestore and D1
    const afterFs = h.fsStub.getDoc('exams', TARGET_MODEL_TEST_2_EXAM_ID)!;
    const afterD1 = (await getExamFromCacheD1(h.db, TARGET_MODEL_TEST_2_EXAM_ID))!;

    const preservedKeys: Array<keyof Exam> = [
      'id',
      'titleBn',
      'titleEn',
      'descriptionBn',
      'descriptionEn',
      'type',
      'durationMinutes',
      'totalMarks',
      'passThresholdPercentage',
      'isPaid',
      'isActive',
      'published',
      'releaseExplanationsImmediately',
      'negativeMarkRatio',
      'positiveMarkRatio',
      'createdAt'
    ];
    for (const k of preservedKeys) {
      assert.deepEqual(afterFs[k], LIVE_MODEL_TEST_2_SNAPSHOT[k], `Firestore field ${k} drifted`);
      assert.deepEqual(afterD1[k], LIVE_MODEL_TEST_2_SNAPSHOT[k], `D1 field ${k} drifted`);
    }
    assert.deepEqual(afterFs.questionIds, VALID_7_REPLACEMENTS);
    assert.deepEqual(afterD1.questionIds, VALID_7_REPLACEMENTS);
    assert.notEqual(afterFs.updatedAt, LIVE_MODEL_TEST_2_SNAPSHOT.updatedAt);

    // Check all 33 canonical exams remained untouched in Firestore and D1
    const afterCanonicalFs = h.canonical33.map(ex => h.fsStub.getDoc('exams', ex.id));
    const afterCanonicalD1 = (await listExamsFromCacheD1(h.db)).filter(
      ex => ex.id !== TARGET_MODEL_TEST_2_EXAM_ID
    );
    assert.equal(afterCanonicalD1.length, 33);
    assert.deepEqual(afterCanonicalFs, beforeCanonicalFs);
    assert.deepEqual(afterCanonicalD1, beforeCanonicalD1);
  });

  test('11. Production-write prevention test: dryRun default & CLI script perform zero writes', async () => {
    const h = await setupHarness();
    const ownerToken = await h.signOwnerToken();

    // 11a: Omitting dryRun defaults to safe dry-run with zero writes
    const defaultRes = await h.handler(
      new Request('https://worker.example/api/admin/exams/repair-model-test-2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({
          replacementQuestionIds: VALID_7_REPLACEMENTS
        })
      }),
      h.env
    );
    assert.equal(defaultRes.status, 200);
    const defaultBody = (await defaultRes.json()) as any;
    assert.equal(defaultBody.dryRun, true);
    assert.equal(defaultBody.executed, false);
    assert.equal(h.fsStub.commitLog.length, 0);
    assert.equal((await listAuditLogsD1(h.db, 10)).length, 0);

    // 11b: CLI arg parser defaults to dryRun: true
    const cliDefault = parseRepairCliArgs([]);
    assert.equal(cliDefault.valid, true);
    assert.equal(cliDefault.dryRun, true);
    assert.equal(cliDefault.execute, false);

    // 11c: CLI script runRepairOwnerModelTest2 against local Worker fetch wrapper performs 0 writes in dry-run
    const workerFetch: typeof fetch = async (input, init) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      return h.handler(req, h.env);
    };

    const scriptDryResult = await runRepairOwnerModelTest2({
      workerUrl: 'https://local-test-worker.example',
      idToken: ownerToken,
      nowMs: h.nowMs,
      fetchImpl: workerFetch
    });
    assert.equal(scriptDryResult.dryRun, true);
    assert.equal(scriptDryResult.executed, false);
    assert.equal(scriptDryResult.safeToExecute, false);
    assert.equal(scriptDryResult.report.slotValidations[3].status, 'NEEDS_CORRECTION_AND_OWNER_APPROVAL');
    assert.equal(h.fsStub.commitLog.length, 0);

    // 11d: CLI script with --execute MUST abort in preflight when #4 q_bank_0609 is present (0 writes)
    await assert.rejects(
      () =>
        runRepairOwnerModelTest2({
          execute: true,
          workerUrl: 'https://local-test-worker.example',
          idToken: ownerToken,
          nowMs: h.nowMs,
          fetchImpl: workerFetch
        }),
      (err: any) => err?.code === 'PREFLIGHT_BLOCKED'
    );
    assert.equal(h.fsStub.commitLog.length, 0);
    const d1AfterScript = await getExamFromCacheD1(h.db, TARGET_MODEL_TEST_2_EXAM_ID);
    assert.deepEqual(d1AfterScript?.questionIds, [...CANONICAL_LEGACY_QUESTION_IDS]);
  });
});
