import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIRESTORE_DOCUMENTS_ROOT,
  FIRESTORE_REST_BASE_URL,
  OWNER_ADMIN_EMAIL,
  OWNER_ADMIN_UID,
  FIREBASE_PROJECT_ID,
  decodeDocumentFields,
  encodeDocumentFields,
  parseCliArgs,
  runSeedFirestoreKeyless,
  validateOwnerIdToken
} from '../scripts/seedFirestoreKeyless.mjs';

function makeOwnerJwt(overrides = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      aud: FIREBASE_PROJECT_ID,
      sub: OWNER_ADMIN_UID,
      user_id: OWNER_ADMIN_UID,
      email: OWNER_ADMIN_EMAIL,
      email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...overrides
    })
  ).toString('base64url');
  return `${header}.${payload}.mocksignature`;
}

function makeSampleQuestions(count = 5) {
  const out = [];
  for (let i = 1; i <= count; i++) {
    out.push({
      id: `q_test_${String(i).padStart(3, '0')}`,
      subjectId: 'sub_cpc',
      questionBn: `প্রশ্ন ${i}?`,
      questionEn: `Question ${i}?`,
      optionsBn: ['ক', 'খ', 'গ', 'ঘ'],
      optionsEn: ['A', 'B', 'C', 'D'],
      correctOptionIndex: i % 4,
      explanationBn: `ব্যাখ্যা ${i}`,
      explanationEn: `Explanation ${i}`,
      legalReference: `Section ${i}`,
      difficulty: 'easy',
      status: 'published',
      year: '2026',
      isDemoSample: i === 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'Test Board'
    });
  }
  return out;
}

function makeSampleExams(questionIds) {
  return [
    {
      id: 'exam_model_test_01',
      titleBn: 'ডেমো টেস্ট',
      titleEn: 'Demo Test',
      descriptionBn: 'বিবরণ',
      descriptionEn: 'Description',
      type: 'full_mock',
      durationMinutes: 60,
      totalMarks: questionIds.length,
      passThresholdPercentage: 50,
      questionIds,
      isPaid: false,
      isActive: true,
      published: true,
      releaseExplanationsImmediately: true,
      negativeMarkRatio: 0.25,
      positiveMarkRatio: 1,
      createdAt: '2026-02-01T00:00:00.000Z'
    }
  ];
}

function createMockFirestoreFetch(initialStore = {}, options = {}) {
  const store = {
    questions: new Map(Object.entries(initialStore.questions || {})),
    questionKeys: new Map(Object.entries(initialStore.questionKeys || {})),
    exams: new Map(Object.entries(initialStore.exams || {})),
    config: new Map(Object.entries(initialStore.config || {}))
  };
  const requests = [];
  let commitCallCount = 0;

  const fetchImpl = async (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    const bodyObj = init.body ? JSON.parse(init.body) : null;
    requests.push({ url, method, body: bodyObj });

    if (options.rejectAuthStatus) {
      return new Response(
        JSON.stringify({ error: { code: options.rejectAuthStatus, status: 'PERMISSION_DENIED', message: 'Forbidden' } }),
        { status: options.rejectAuthStatus, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url.startsWith(`${FIRESTORE_REST_BASE_URL}:commit`) && method === 'POST') {
      commitCallCount += 1;
      if (options.failCommitOnCall === commitCallCount) {
        return new Response(
          JSON.stringify({ error: { code: 500, status: 'INTERNAL', message: 'Simulated commit failure' } }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const writes = bodyObj?.writes || [];
      for (const w of writes) {
        assert.equal(w.delete, undefined, 'Never use delete operations');
        const prefix = `${FIRESTORE_DOCUMENTS_ROOT}/`;
        assert.ok(w.update?.name?.startsWith(prefix));
        const rel = w.update.name.slice(prefix.length);
        const [col, encodedId] = rel.split('/');
        const docId = decodeURIComponent(encodedId);
        const targetMap = store[col];
        assert.ok(targetMap, `Unexpected collection ${col}`);

        if (w.currentDocument?.exists === false && targetMap.has(docId)) {
          return new Response(
            JSON.stringify({ error: { code: 409, status: 'ALREADY_EXISTS', message: `${col}/${docId} already exists` } }),
            { status: 409, headers: { 'Content-Type': 'application/json' } }
          );
        }
        targetMap.set(docId, decodeDocumentFields(w.update.fields));
      }
      return new Response(JSON.stringify({ writeResults: writes.map(() => ({})) }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const parsed = new URL(url);
    const relPath = parsed.pathname.split('/documents/')[1] || '';
    const segments = relPath.split('/').filter(Boolean);

    if (segments.length === 2 && method === 'GET') {
      const [col, rawId] = segments;
      const docId = decodeURIComponent(rawId);
      const doc = store[col]?.get(docId);
      if (!doc) {
        return new Response(JSON.stringify({ error: { code: 404, status: 'NOT_FOUND', message: 'Not found' } }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(
        JSON.stringify({
          name: `${FIRESTORE_DOCUMENTS_ROOT}/${col}/${encodeURIComponent(docId)}`,
          fields: encodeDocumentFields(doc)
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (segments.length === 1 && method === 'GET') {
      const col = segments[0];
      const allEntries = Array.from((store[col] || new Map()).entries());
      const pageSize = Number(parsed.searchParams.get('pageSize') || '500');
      const offset = Number(parsed.searchParams.get('pageToken') || '0');
      const slice = allEntries.slice(offset, offset + pageSize);
      const nextOffset = offset + slice.length;
      return new Response(
        JSON.stringify({
          documents: slice.map(([docId, data]) => ({
            name: `${FIRESTORE_DOCUMENTS_ROOT}/${col}/${encodeURIComponent(docId)}`,
            fields: encodeDocumentFields(data)
          })),
          ...(nextOffset < allEntries.length ? { nextPageToken: String(nextOffset) } : {})
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    throw new Error(`Unhandled mock request: ${method} ${url}`);
  };

  return { fetchImpl, store, requests };
}

describe('Keyless Firestore REST Seeder', () => {
  test('CLI defaults to dry-run and rejects conflicting flags', () => {
    assert.deepEqual(parseCliArgs([]), { valid: true, help: false, dryRun: true, execute: false });
    assert.deepEqual(parseCliArgs(['--dry-run']), { valid: true, help: false, dryRun: true, execute: false });
    assert.deepEqual(parseCliArgs(['--execute']), { valid: true, help: false, dryRun: false, execute: true });
    assert.equal(parseCliArgs(['--dry-run', '--execute']).valid, false);
    assert.equal(parseCliArgs(['--unknown']).valid, false);
  });

  test('fails safely when OWNER_FIREBASE_ID_TOKEN is missing, non-owner, unverified, or expired', async () => {
    assert.throws(() => validateOwnerIdToken(''), /MISSING_TOKEN|OWNER_FIREBASE_ID_TOKEN/);
    assert.throws(() => validateOwnerIdToken(makeOwnerJwt({ sub: 'student_uid', user_id: 'student_uid' })), /Owner UID/);
    assert.throws(() => validateOwnerIdToken(makeOwnerJwt({ email: 'other@example.com' })), /Owner email/);
    assert.throws(() => validateOwnerIdToken(makeOwnerJwt({ email_verified: false })), /email_verified/);
    assert.throws(() => validateOwnerIdToken(makeOwnerJwt({ exp: 1000 }), 2_000_000), /expired/);

    await assert.rejects(
      () => runSeedFirestoreKeyless({ token: '', questions: makeSampleQuestions(1), exams: makeSampleExams(['q_test_001']) }),
      err => err.code === 'MISSING_TOKEN'
    );
  });

  test('dry-run sends zero write requests and reports accurate counts and batches', async () => {
    const questions = makeSampleQuestions(5);
    const exams = makeSampleExams(questions.map(q => q.id));
    const { fetchImpl, requests, store } = createMockFirestoreFetch();

    const report = await runSeedFirestoreKeyless({
      execute: false,
      token: makeOwnerJwt(),
      fetchImpl,
      questions,
      exams,
      batchSize: 2,
      nowMs: 1700000000000
    });

    assert.equal(report.mode, 'dry-run');
    assert.equal(report.safeToExecute, true);
    assert.equal(report.executed, false);
    assert.deepEqual(report.sourceCounts, { questions: 5, questionKeys: 5, exams: 1 });
    assert.deepEqual(report.wouldCreate, {
      questions: 5,
      questionKeys: 5,
      exams: 1,
      versionDocument: 1,
      total: 12
    });
    assert.deepEqual(report.plannedCommitBatches, {
      questions: 3,
      questionKeys: 3,
      exams: 1,
      versionDocument: 1,
      total: 8,
      maxBatchSize: 2
    });
    assert.equal(report.conflicts.length, 0);
    assert.ok(requests.every(r => r.method === 'GET'), 'Dry-run must send only GET requests');
    assert.equal(store.questions.size, 0);
    assert.equal(store.questionKeys.size, 0);
    assert.equal(store.exams.size, 0);
    assert.equal(store.config.size, 0);
  });

  test('execute uses create-only preconditions, strips answers from /questions, puts keys in /questionKeys, and writes version doc last', async () => {
    const questions = makeSampleQuestions(3);
    const exams = makeSampleExams(questions.map(q => q.id));
    const { fetchImpl, requests, store } = createMockFirestoreFetch();

    const result = await runSeedFirestoreKeyless({
      execute: true,
      token: makeOwnerJwt(),
      fetchImpl,
      questions,
      exams,
      batchSize: 2,
      nowMs: 1700000000000
    });

    assert.equal(result.executed, true);
    assert.equal(result.writesCommitted, 8);
    assert.equal(result.batchesSucceeded, 6);

    const commits = requests.filter(r => r.method === 'POST');
    assert.equal(commits.length, 6);

    for (const commitReq of commits) {
      for (const write of commitReq.body.writes) {
        assert.deepEqual(write.currentDocument, { exists: false });
        assert.equal(write.delete, undefined);
      }
    }

    // Final commit must contain ONLY config/questionBankVersion
    const lastCommitWrites = commits[commits.length - 1].body.writes;
    assert.equal(lastCommitWrites.length, 1);
    assert.ok(lastCommitWrites[0].update.name.endsWith('/documents/config/questionBankVersion'));

    // Verify sanitized /questions vs /questionKeys separation
    assert.equal(store.questions.size, 3);
    assert.equal(store.questionKeys.size, 3);
    for (const q of questions) {
      const savedQ = store.questions.get(q.id);
      assert.equal('correctOptionIndex' in savedQ, false);
      assert.equal('explanationBn' in savedQ, false);
      assert.equal('explanationEn' in savedQ, false);
      assert.equal(savedQ.questionBn, q.questionBn);

      const savedKey = store.questionKeys.get(q.id);
      assert.equal(savedKey.correctOptionIndex, q.correctOptionIndex);
      assert.equal(savedKey.explanationBn, q.explanationBn);
      assert.equal(savedKey.explanationEn, q.explanationEn);
    }

    const versionDoc = store.config.get('questionBankVersion');
    assert.equal(typeof versionDoc.version, 'number');
    assert.equal(versionDoc.versionToken, result.plannedVersionToken);
    assert.equal(typeof versionDoc.updatedAt, 'string');
  });

  test('pagination works across multi-page collections and preserves matching existing docs without overwriting', async () => {
    const questions = makeSampleQuestions(5);
    const exams = makeSampleExams(questions.map(q => q.id));

    // Pre-populate 3 matching questions + 1 custom-configured existing exam (isActive toggled)
    const { fetchImpl, requests, store } = createMockFirestoreFetch({
      questions: {
        q_test_001: {
          id: 'q_test_001',
          subjectId: 'sub_cpc',
          questionBn: 'প্রশ্ন 1?',
          questionEn: 'Question 1?',
          optionsBn: ['ক', 'খ', 'গ', 'ঘ'],
          optionsEn: ['A', 'B', 'C', 'D'],
          legalReference: 'Section 1',
          difficulty: 'easy',
          status: 'published',
          isDemoSample: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        },
        q_test_002: {
          id: 'q_test_002',
          subjectId: 'sub_cpc',
          questionBn: 'প্রশ্ন 2?',
          questionEn: 'Question 2?',
          optionsBn: ['ক', 'খ', 'গ', 'ঘ'],
          optionsEn: ['A', 'B', 'C', 'D'],
          legalReference: 'Section 2',
          difficulty: 'easy',
          status: 'published',
          isDemoSample: false,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        },
        q_test_003: {
          id: 'q_test_003',
          subjectId: 'sub_cpc',
          questionBn: 'প্রশ্ন 3?',
          questionEn: 'Question 3?',
          optionsBn: ['ক', 'খ', 'গ', 'ঘ'],
          optionsEn: ['A', 'B', 'C', 'D'],
          legalReference: 'Section 3',
          difficulty: 'easy',
          status: 'published',
          isDemoSample: false,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        }
      },
      exams: {
        exam_model_test_01: {
          ...exams[0],
          isActive: false,
          scheduledDate: '2026-12-15'
        }
      }
    });

    const result = await runSeedFirestoreKeyless({
      execute: true,
      token: makeOwnerJwt(),
      fetchImpl,
      questions,
      exams,
      pageSize: 2, // Force multi-page pagination
      nowMs: 1700000000000
    });

    assert.equal(result.paginationPagesRead.questions, 2);
    assert.equal(result.matchingCounts.questions, 3);
    assert.equal(result.matchingCounts.exams, 1);
    assert.equal(result.wouldCreate.questions, 2);
    assert.equal(result.wouldCreate.questionKeys, 5);
    assert.equal(result.wouldCreate.exams, 0);

    // Custom admin configuration on existing exam must be preserved untouched
    assert.equal(store.exams.get('exam_model_test_01').isActive, false);
    assert.equal(store.exams.get('exam_model_test_01').scheduledDate, '2026-12-15');
    assert.equal(requests.filter(r => r.method === 'POST').every(c => c.body.writes.every(w => !w.update.name.includes('/exams/'))), true);
  });

  test('conflicting existing documents prevent execution and send zero writes', async () => {
    const questions = makeSampleQuestions(2);
    const exams = makeSampleExams(questions.map(q => q.id));
    const { fetchImpl, requests } = createMockFirestoreFetch({
      questions: {
        q_test_001: {
          id: 'q_test_001',
          subjectId: 'sub_cpc',
          questionBn: 'Different question text',
          questionEn: 'Question 1?',
          optionsBn: ['ক', 'খ', 'গ', 'ঘ'],
          optionsEn: ['A', 'B', 'C', 'D'],
          legalReference: 'Section 1',
          difficulty: 'easy',
          status: 'published',
          isDemoSample: true
        }
      },
      questionKeys: {
        q_test_002: {
          correctOptionIndex: 3, // source has 2
          explanationBn: 'ব্যাখ্যা 2',
          explanationEn: 'Explanation 2',
          legalReference: 'Section 2'
        }
      }
    });

    await assert.rejects(
      () =>
        runSeedFirestoreKeyless({
          execute: true,
          token: makeOwnerJwt(),
          fetchImpl,
          questions,
          exams
        }),
      err =>
        err.code === 'CONFLICT_DETECTED' &&
        err.details.conflicts.length === 2 &&
        err.details.safeToExecute === false
    );

    assert.equal(requests.filter(r => r.method === 'POST').length, 0);
  });

  test('aborts immediately on batch commit failure and never writes version document', async () => {
    const questions = makeSampleQuestions(3);
    const exams = makeSampleExams(questions.map(q => q.id));
    const { fetchImpl, store } = createMockFirestoreFetch({}, { failCommitOnCall: 2 });

    await assert.rejects(
      () =>
        runSeedFirestoreKeyless({
          execute: true,
          token: makeOwnerJwt(),
          fetchImpl,
          questions,
          exams,
          batchSize: 2
        }),
      err =>
        err.code === 'FIRESTORE_COMMIT_FAILED' &&
        err.details.partialExecution === true &&
        err.details.batchesSucceeded === 1 &&
        err.details.failedBatch.batchNumber === 2
    );

    assert.equal(store.config.has('questionBankVersion'), false, 'Version doc must NOT be created after partial failure');
  });

  test('fails safely when Firestore rejects Owner authorization with 403', async () => {
    const questions = makeSampleQuestions(1);
    const exams = makeSampleExams(['q_test_001']);
    const { fetchImpl } = createMockFirestoreFetch({}, { rejectAuthStatus: 403 });

    await assert.rejects(
      () =>
        runSeedFirestoreKeyless({
          execute: false,
          token: makeOwnerJwt(),
          fetchImpl,
          questions,
          exams
        }),
      err => err.code === 'OWNER_AUTH_REJECTED'
    );
  });

  test('validates real local questionBankFull.json and initialExamsMeta.json in offline dry-run', async () => {
    const { fetchImpl, requests } = createMockFirestoreFetch();

    const report = await runSeedFirestoreKeyless({
      execute: false,
      token: makeOwnerJwt(),
      fetchImpl,
      nowMs: 1700000000000
    });

    assert.equal(report.mode, 'dry-run');
    assert.equal(report.safeToExecute, true);
    assert.equal(report.executed, false);
    assert.deepEqual(report.sourceCounts, {
      questions: 3000,
      questionKeys: 3000,
      exams: 33
    });
    assert.deepEqual(report.wouldCreate, {
      questions: 3000,
      questionKeys: 3000,
      exams: 33,
      versionDocument: 1,
      total: 6034
    });
    assert.deepEqual(report.plannedCommitBatches, {
      questions: 15,
      questionKeys: 15,
      exams: 1,
      versionDocument: 1,
      total: 32,
      maxBatchSize: 200
    });
    assert.equal(report.conflicts.length, 0);
    assert.ok(requests.every(r => r.method === 'GET'));
  });
});

