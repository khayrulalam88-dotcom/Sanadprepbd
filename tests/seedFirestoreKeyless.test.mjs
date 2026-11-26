import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_WORKER_BASE_URL,
  FIREBASE_PROJECT_ID,
  FIRESTORE_DATABASE_ID,
  OWNER_ADMIN_EMAIL,
  OWNER_ADMIN_UID,
  buildBoundedPayloadChunks,
  normalizeWorkerBaseUrl,
  parseCliArgs,
  runSeedFirestoreKeyless,
  validateOwnerIdToken
} from '../scripts/seedFirestoreKeyless.mjs';

function makeOwnerJwt(overrides = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      aud: FIREBASE_PROJECT_ID,
      iss: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
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
      isDemoSample: i === 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
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

function createMockWorkerFetch(initialStore = {}, options = {}) {
  const store = {
    questions: new Map(Object.entries(initialStore.questions || {})),
    questionKeys: new Map(Object.entries(initialStore.questionKeys || {})),
    exams: new Map(Object.entries(initialStore.exams || {})),
    config: new Map(Object.entries(initialStore.config || {}))
  };
  const requests = [];
  let batchCallCount = 0;

  const fetchImpl = async (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    const bodyObj = init.body ? JSON.parse(init.body) : {};
    const authHeader = new Headers(init.headers).get('Authorization') || '';
    requests.push({ url, method, body: bodyObj, authHeader });

    if (options.rejectAuthStatus) {
      return new Response(
        JSON.stringify({
          error: options.rejectAuthStatus === 401 ? 'UNAUTHORIZED' : 'PERMISSION_DENIED',
          message: 'Forbidden'
        }),
        { status: options.rejectAuthStatus, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const parsedUrl = new URL(url);
    if (parsedUrl.pathname === '/api/admin/seed/question-bank/preflight' && method === 'POST') {
      const existingVersion = store.config.get('questionBankVersion');
      if (!existingVersion) {
        return new Response(
          JSON.stringify({
            success: true,
            safeToExecute: true,
            versionExists: false,
            compatible: true,
            versionDocumentStatus: 'missing (will create at finalize)',
            existingVersionToken: null,
            expectedUpdateTime: null,
            conflicts: []
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (existingVersion.locked === true) {
        return new Response(
          JSON.stringify({
            success: false,
            safeToExecute: false,
            versionExists: true,
            compatible: false,
            versionDocumentStatus: 'incompatible (locked)',
            conflicts: [{ collection: 'config', docId: 'questionBankVersion', reason: 'Marker is locked.' }]
          }),
          { status: bodyObj.dryRun === false ? 409 : 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          success: true,
          safeToExecute: true,
          versionExists: true,
          compatible: true,
          versionDocumentStatus: 'will be conditionally updated at finalize',
          existingVersionToken: existingVersion.versionToken,
          expectedUpdateTime: existingVersion._updateTime || '2026-01-01T00:00:00.000Z',
          conflicts: []
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (parsedUrl.pathname === '/api/admin/seed/question-bank/batch' && method === 'POST') {
      batchCallCount += 1;
      if (options.rateLimitOnCall === batchCallCount) {
        options.rateLimitOnCall = -1; // Once
        return new Response(JSON.stringify({ error: 'RATE_LIMITED', retryAfterSeconds: 1 }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '1' }
        });
      }
      if (options.failBatchOnCall === batchCallCount) {
        return new Response(
          JSON.stringify({ error: 'FIRESTORE_COMMIT_FAILED', message: 'Simulated Worker batch failure' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const dryRun = bodyObj.dryRun !== false;
      const qs = Array.isArray(bodyObj.questions) ? bodyObj.questions : [];
      const exs = Array.isArray(bodyObj.exams) ? bodyObj.exams : [];
      const conflicts = [];
      const existing = { questions: 0, questionKeys: 0, exams: 0 };
      const matching = { questions: 0, questionKeys: 0, exams: 0 };
      const wouldCreate = { questions: 0, questionKeys: 0, exams: 0, total: 0 };
      const writes = [];

      for (const q of qs) {
        const exQ = store.questions.get(q.id);
        if (exQ) {
          existing.questions += 1;
          if (exQ.questionBn !== q.questionBn) {
            conflicts.push({ collection: 'questions', docId: q.id, reason: 'questionBn mismatch' });
          } else {
            matching.questions += 1;
          }
        } else {
          wouldCreate.questions += 1;
          writes.push({ col: 'questions', id: q.id, data: { id: q.id, subjectId: q.subjectId, questionBn: q.questionBn } });
        }

        const exK = store.questionKeys.get(q.id);
        if (exK) {
          existing.questionKeys += 1;
          if (exK.correctOptionIndex !== q.correctOptionIndex) {
            conflicts.push({ collection: 'questionKeys', docId: q.id, reason: 'correctOptionIndex mismatch' });
          } else {
            matching.questionKeys += 1;
          }
        } else {
          wouldCreate.questionKeys += 1;
          writes.push({ col: 'questionKeys', id: q.id, data: { correctOptionIndex: q.correctOptionIndex, explanationBn: q.explanationBn || '' } });
        }
      }

      for (const ex of exs) {
        const exDoc = store.exams.get(ex.id);
        if (exDoc) {
          existing.exams += 1;
          if (exDoc.totalMarks !== ex.totalMarks) {
            conflicts.push({ collection: 'exams', docId: ex.id, reason: 'totalMarks mismatch' });
          } else {
            matching.exams += 1;
          }
        } else {
          wouldCreate.exams += 1;
          writes.push({ col: 'exams', id: ex.id, data: ex });
        }
      }

      wouldCreate.total = writes.length;
      if (conflicts.length > 0 && !dryRun) {
        return new Response(
          JSON.stringify({
            error: 'CONFLICT_DETECTED',
            message: 'Conflict detected',
            dryRun: false,
            safeToExecute: false,
            conflicts
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (!dryRun) {
        for (const w of writes) {
          store[w.col].set(w.id, w.data);
        }
      }

      return new Response(
        JSON.stringify({
          success: conflicts.length === 0,
          dryRun,
          executed: !dryRun,
          safeToExecute: conflicts.length === 0,
          existing,
          matching,
          wouldCreate,
          writesCommitted: dryRun ? 0 : writes.length,
          conflicts
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (parsedUrl.pathname === '/api/admin/seed/question-bank/finalize' && method === 'POST') {
      const dryRun = bodyObj.dryRun !== false;
      const pending = Number(bodyObj.pendingDataWrites || 0);
      if (options.simulateConcurrentVersionChangeOnFinalize && !dryRun) {
        return new Response(
          JSON.stringify({
            error: 'CONFLICT_DETECTED',
            message: 'Concurrent modification detected on config/questionBankVersion.',
            success: false,
            safeToExecute: false,
            conflicts: [{ collection: 'config', docId: 'questionBankVersion', reason: 'updateTime mismatch' }]
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const existingVersion = store.config.get('questionBankVersion');
      if (existingVersion) {
        if (existingVersion.locked === true) {
          return new Response(
            JSON.stringify({
              error: 'CONFLICT_DETECTED',
              message: 'Marker is locked.',
              success: false,
              dryRun,
              safeToExecute: false,
              versionExists: true,
              compatible: false,
              versionDocumentStatus: 'incompatible (Marker is locked.)',
              conflicts: [{ collection: 'config', docId: 'questionBankVersion', reason: 'Marker is locked.' }]
            }),
            { status: dryRun ? 200 : 409, headers: { 'Content-Type': 'application/json' } }
          );
        }
        const currentUpdateTime = existingVersion._updateTime || '2026-01-01T00:00:00.000Z';
        if (bodyObj.expectedUpdateTime && bodyObj.expectedUpdateTime !== currentUpdateTime) {
          return new Response(
            JSON.stringify({
              error: 'CONFLICT_DETECTED',
              message: 'config/questionBankVersion changed since preflight.',
              success: false,
              safeToExecute: false,
              conflicts: [{ collection: 'config', docId: 'questionBankVersion', reason: 'updateTime mismatch' }]
            }),
            { status: dryRun ? 200 : 409, headers: { 'Content-Type': 'application/json' } }
          );
        }
        const tokenVal = '1700000000001_2_mock';
        if (!dryRun && pending > 0) {
          store.config.set('questionBankVersion', {
            ...existingVersion,
            version: 1700000000001002,
            versionToken: tokenVal,
            _updateTime: '2026-01-02T00:00:00.000Z'
          });
        }
        return new Response(
          JSON.stringify({
            success: true,
            dryRun,
            executed: !dryRun,
            safeToExecute: true,
            versionExists: true,
            compatible: true,
            versionDocumentStatus:
              pending > 0
                ? dryRun
                  ? 'will be conditionally updated at finalize'
                  : 'conditionally updated'
                : 'exists (up-to-date)',
            wouldUpdateVersionDocument: pending > 0 ? 1 : 0,
            versionToken: !dryRun && pending > 0 ? tokenVal : existingVersion.versionToken,
            writesCommitted: !dryRun && pending > 0 ? 1 : 0,
            conflicts: []
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const tokenVal = '1700000000000_1_mock';
      if (!dryRun) {
        store.config.set('questionBankVersion', {
          version: 1700000000000001,
          versionToken: tokenVal,
          _updateTime: '2026-01-01T00:00:00.000Z'
        });
      }
      return new Response(
        JSON.stringify({
          success: true,
          dryRun,
          executed: !dryRun,
          safeToExecute: true,
          versionExists: false,
          compatible: true,
          versionDocumentStatus: dryRun ? 'missing (will create at finalize)' : 'created',
          plannedVersionToken: tokenVal,
          versionToken: dryRun ? undefined : tokenVal,
          writesCommitted: dryRun ? 0 : 1,
          conflicts: []
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (parsedUrl.pathname === '/api/admin/questions/sync-cache' && method === 'POST') {
      return new Response(
        JSON.stringify({
          success: true,
          questionCount: store.questions.size,
          keyCount: store.questionKeys.size,
          examsCount: store.exams.size
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    throw new Error(`Unhandled mock request: ${method} ${url}`);
  };

  return { fetchImpl, store, requests };
}

describe('Worker-Mediated Keyless Firestore Seeder CLI', () => {
  test('CLI defaults to dry-run and parses --worker-url, --batch-size, --skip-d1-sync', () => {
    assert.deepEqual(parseCliArgs([]), { valid: true, help: false, dryRun: true, execute: false, skipD1Sync: false });
    assert.deepEqual(parseCliArgs(['--dry-run']), { valid: true, help: false, dryRun: true, execute: false, skipD1Sync: false });
    assert.deepEqual(
      parseCliArgs(['--execute', '--worker-url', 'https://example.workers.dev', '--batch-size', '50', '--skip-d1-sync']),
      {
        valid: true,
        help: false,
        dryRun: false,
        execute: true,
        skipD1Sync: true,
        workerUrl: 'https://example.workers.dev',
        batchSize: 50
      }
    );
    assert.equal(parseCliArgs(['--dry-run', '--execute']).valid, false);
    assert.equal(parseCliArgs(['--unknown']).valid, false);
    assert.equal(normalizeWorkerBaseUrl('https://s--khayrul-alam.khayrulalam88.workers.dev/'), DEFAULT_WORKER_BASE_URL);
    assert.throws(
      () => normalizeWorkerBaseUrl('http://insecure.example.com'),
      err => err.code === 'INVALID_WORKER_URL'
    );
  });

  test('validates OWNER_FIREBASE_ID_TOKEN and rejects Bearer prefix, quotes, non-owner, unverified, or expired', async () => {
    const valid = makeOwnerJwt();
    assert.equal(validateOwnerIdToken(valid).uid, OWNER_ADMIN_UID);
    assert.throws(() => validateOwnerIdToken(''), /MISSING_TOKEN|OWNER_FIREBASE_ID_TOKEN/);
    assert.throws(() => validateOwnerIdToken(`Bearer ${valid}`), /Bearer/);
    assert.throws(() => validateOwnerIdToken(`"${valid}"`), /quotes/);
    assert.throws(() => validateOwnerIdToken(makeOwnerJwt({ sub: 'student_uid', user_id: 'student_uid' })), /Owner UID/);
    assert.throws(() => validateOwnerIdToken(makeOwnerJwt({ email: 'other@example.com' })), /Owner email/);
    assert.throws(() => validateOwnerIdToken(makeOwnerJwt({ email_verified: false })), /email_verified/);
    assert.throws(() => validateOwnerIdToken(makeOwnerJwt({ exp: 1000 }), 2_000_000), /expired/);

    await assert.rejects(
      () => runSeedFirestoreKeyless({ token: '', questions: makeSampleQuestions(1), exams: makeSampleExams(['q_test_001']) }),
      err => err.code === 'MISSING_TOKEN'
    );
  });

  test('buildBoundedPayloadChunks respects both item count and JSON byte limits', () => {
    const qs = makeSampleQuestions(10);
    const chunks = buildBoundedPayloadChunks(qs, 'questions', true, 4, 50_000);
    assert.deepEqual(
      chunks.map(c => c.length),
      [4, 4, 2]
    );
    const byteChunks = buildBoundedPayloadChunks(qs, 'questions', true, 50, 900);
    assert.ok(byteChunks.length > 2);
  });

  test('dry-run targets Worker endpoints with dryRun=true and writes zero documents', async () => {
    const questions = makeSampleQuestions(5);
    const exams = makeSampleExams(questions.map(q => q.id));
    const { fetchImpl, requests, store } = createMockWorkerFetch();

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
    assert.equal(report.projectId, FIREBASE_PROJECT_ID);
    assert.equal(report.databaseId, FIRESTORE_DATABASE_ID);
    assert.equal(report.safeToExecute, true);
    assert.equal(report.executed, false);
    assert.equal(report.writesCommitted, 0);
    assert.deepEqual(report.wouldCreate, {
      questions: 5,
      questionKeys: 5,
      exams: 1,
      versionDocument: 1,
      total: 12
    });
    assert.ok(requests.every(r => !r.url.endsWith('/sync-cache')), 'Dry-run must not call sync-cache');
    assert.ok(
      requests.filter(r => r.url.includes('/seed/')).every(r => r.body.dryRun === true),
      'Every seed request in dry-run must send dryRun: true'
    );
    assert.equal(store.questions.size, 0);
    assert.equal(store.config.size, 0);
  });

  test('execute commits batches, writes version doc last, and triggers /sync-cache', async () => {
    const questions = makeSampleQuestions(3);
    const exams = makeSampleExams(questions.map(q => q.id));
    const { fetchImpl, requests, store } = createMockWorkerFetch();

    const report = await runSeedFirestoreKeyless({
      execute: true,
      token: makeOwnerJwt(),
      fetchImpl,
      questions,
      exams,
      batchSize: 2,
      nowMs: 1700000000000
    });

    assert.equal(report.executed, true);
    assert.equal(report.writesCommitted, 8);
    assert.equal(report.batchesSucceeded, 4); // 2 question batches + 1 exam batch + 1 finalize
    assert.equal(store.questions.size, 3);
    assert.equal(store.questionKeys.size, 3);
    assert.equal(store.exams.size, 1);
    assert.equal(store.config.has('questionBankVersion'), true);
    assert.equal(report.d1SyncResult.success, true);
    assert.equal(report.d1SyncResult.questionCount, 3);

    const pathOrder = requests.map(r => new URL(r.url).pathname);
    assert.equal(pathOrder[pathOrder.length - 2], '/api/admin/seed/question-bank/finalize');
    assert.equal(pathOrder[pathOrder.length - 1], '/api/admin/questions/sync-cache');
  });

  test('handles 429 rate-limit response with bounded retry', async () => {
    const questions = makeSampleQuestions(2);
    const exams = makeSampleExams(questions.map(q => q.id));
    let sleptMs = 0;
    const { fetchImpl, store } = createMockWorkerFetch({}, { rateLimitOnCall: 1 });

    const report = await runSeedFirestoreKeyless({
      execute: true,
      token: makeOwnerJwt(),
      fetchImpl,
      questions,
      exams,
      sleepFn: async ms => {
        sleptMs += ms;
      }
    });

    assert.equal(report.executed, true);
    assert.ok(sleptMs >= 1000);
    assert.equal(store.questions.size, 2);
  });

  test('aborts immediately on batch failure and never calls /finalize or /sync-cache', async () => {
    const questions = makeSampleQuestions(3);
    const exams = makeSampleExams(questions.map(q => q.id));
    const { fetchImpl, requests, store } = createMockWorkerFetch({}, { failBatchOnCall: 2 });

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

    assert.equal(store.config.has('questionBankVersion'), false);
    assert.equal(
      requests.some(r => r.url.includes('/finalize') || r.url.includes('/sync-cache')),
      false
    );
  });

  test('fails cleanly when Worker rejects authorization with 403', async () => {
    const questions = makeSampleQuestions(1);
    const exams = makeSampleExams(['q_test_001']);
    const { fetchImpl } = createMockWorkerFetch({}, { rejectAuthStatus: 403 });

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
    const { fetchImpl, requests } = createMockWorkerFetch();

    const report = await runSeedFirestoreKeyless({
      execute: false,
      token: makeOwnerJwt(),
      fetchImpl,
      nowMs: 1700000000000
    });

    assert.equal(report.mode, 'dry-run');
    assert.equal(report.safeToExecute, true);
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
    assert.equal(report.conflicts.length, 0);
    assert.ok(requests.length >= 42);
  });

  test('CLI handles existing compatible version marker safely and blocks on concurrent 409 without D1 sync', async () => {
    const questions = makeSampleQuestions(3);
    const exams = makeSampleExams(questions.map(q => q.id));

    const { fetchImpl: compatibleFetch, store } = createMockWorkerFetch({
      config: {
        questionBankVersion: {
          version: 1795617149157001,
          versionToken: '1795617149157_1_80125c',
          _updateTime: '2026-11-26T00:00:00.000Z'
        }
      },
      exams: {
        exam_model_test_01: exams[0]
      }
    });

    const dryReport = await runSeedFirestoreKeyless({
      execute: false,
      token: makeOwnerJwt(),
      fetchImpl: compatibleFetch,
      questions,
      exams
    });
    assert.equal(dryReport.safeToExecute, true);
    assert.equal(dryReport.conflicts.length, 0);
    assert.equal(dryReport.versionDocumentStatus, 'will be conditionally updated at finalize');
    assert.equal(dryReport.existingFirestoreCounts.questionBankVersionExists, true);
    assert.equal(dryReport.matchingCounts.exams, 1);
    assert.equal(dryReport.wouldCreate.questions, 3);
    assert.equal(dryReport.wouldCreate.questionKeys, 3);
    assert.equal(dryReport.wouldCreate.exams, 0);
    assert.equal(dryReport.wouldUpdateVersionDocument, 1);
    assert.equal(store.config.get('questionBankVersion').versionToken, '1795617149157_1_80125c');

    const { fetchImpl: conflictFetch, requests: conflictRequests } = createMockWorkerFetch(
      {
        config: {
          questionBankVersion: {
            version: 1795617149157001,
            versionToken: '1795617149157_1_80125c',
            _updateTime: '2026-11-26T00:00:00.000Z'
          }
        }
      },
      { simulateConcurrentVersionChangeOnFinalize: true }
    );

    await assert.rejects(
      () =>
        runSeedFirestoreKeyless({
          execute: true,
          token: makeOwnerJwt(),
          fetchImpl: conflictFetch,
          questions,
          exams
        }),
      err => err.code === 'CONFLICT_DETECTED'
    );
    assert.equal(
      conflictRequests.some(r => r.url.includes('/sync-cache')),
      false,
      'D1 sync must NOT execute when finalize returns 409 CONFLICT_DETECTED'
    );
  });
});
