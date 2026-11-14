import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import {
  createSanadPrepApp,
  type DecodedAuthUser
} from '../server.ts';
import {
  OWNER_ADMIN_UID,
  OWNER_ADMIN_EMAIL,
  createMemoryMirror,
  checkUserHasActiveSubscription,
  isAlreadyExistsError,
  isPermissionOrCredentialError
} from '../server/services/firestoreBackend.ts';
import { runAllTestScenarios } from '../src/utils/testScenarios.ts';

const OWNER_TOKEN = 'token-owner-admin';
const STUDENT_A_TOKEN = 'token-student-a';
const STUDENT_B_TOKEN = 'token-student-b';
const EXPIRED_STUDENT_TOKEN = 'token-student-expired';

const TOKEN_MAP: Record<string, DecodedAuthUser> = {
  [OWNER_TOKEN]: {
    uid: OWNER_ADMIN_UID,
    email: OWNER_ADMIN_EMAIL,
    name: 'Owner Admin'
  },
  [STUDENT_A_TOKEN]: {
    uid: 'student_uid_alpha',
    email: 'student.a@example.com',
    name: 'Student Alpha'
  },
  [STUDENT_B_TOKEN]: {
    uid: 'student_uid_beta',
    email: 'student.b@example.com',
    name: 'Student Beta'
  },
  [EXPIRED_STUDENT_TOKEN]: {
    uid: 'student_uid_expired',
    email: 'expired@example.com',
    name: 'Expired Student'
  }
};

describe('Sanad Prep BD – Third-Stage Security & Functional Remediation Suite', () => {
  const mirror = createMemoryMirror();
  let server: http.Server;
  let baseUrl = '';
  let approvedAttemptId = '';

  before(async () => {
    // Seed an expired subscription for EXPIRED_STUDENT_TOKEN
    mirror.subscriptions.push({
      id: 'sub_expired_seed',
      userId: 'student_uid_expired',
      studentName: 'Expired Student',
      studentPhone: '01700000099',
      packageId: 'pkg_pro_mock',
      packageNameBn: 'প্রো মডেল টেস্ট পাস',
      packageNameEn: 'Pro Model Test Pass',
      status: 'active', // even if status field is still 'active', past expiresAt must deny access!
      amountPaid: 300,
      paymentMethod: 'bKash',
      transactionId: 'TRX_OLD_EXPIRED_01',
      startDate: new Date(Date.now() - 120 * 24 * 3600 * 1000).toISOString(),
      expiresAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      approvedBy: OWNER_ADMIN_UID,
      approvedAt: new Date(Date.now() - 120 * 24 * 3600 * 1000).toISOString()
    });

    const { app } = createSanadPrepApp({
      mirror,
      disableFirestoreWrites: true,
      tokenVerifier: async (idToken: string) => {
        const user = TOKEN_MAP[idToken];
        if (!user) throw new Error('Invalid test token');
        return user;
      }
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  async function apiCall(
    urlPath: string,
    opts: { method?: string; token?: string; body?: unknown } = {}
  ): Promise<{ status: number; json: Record<string, any> }> {
    const headers: Record<string, string> = {};
    if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetch(`${baseUrl}${urlPath}`, {
      method: opts.method || 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    });
    const json = (await res.json()) as Record<string, any>;
    return { status: res.status, json };
  }

  test('1. Unauthenticated access is blocked (401) on all protected routes', async () => {
    const checks = await Promise.all([
      apiCall('/api/questions'),
      apiCall('/api/exams/start', { method: 'POST', body: { examId: 'exam_model_test_1' } }),
      apiCall('/api/exams/submit', { method: 'POST', body: { attemptId: 'x', answers: {} } }),
      apiCall('/api/payments/create', {
        method: 'POST',
        body: { method: 'bKash', transactionId: 'UNAUTH123', packageId: 'pkg_pro_mock' }
      }),
      apiCall('/api/admin/questions')
    ]);

    for (const r of checks) {
      assert.equal(r.status, 401);
    }
  });

  test('2. Ordinary student is blocked (403) from all admin routes and cross-user results', async () => {
    const checks = await Promise.all([
      apiCall('/api/admin/questions', { token: STUDENT_A_TOKEN }),
      apiCall('/api/admin/payments/fake_id/approve', { method: 'POST', token: STUDENT_A_TOKEN }),
      apiCall('/api/admin/users/update', {
        method: 'POST',
        token: STUDENT_A_TOKEN,
        body: { userId: 'student_uid_alpha', role: 'admin' }
      }),
      apiCall('/api/admin/exams/save', {
        method: 'POST',
        token: STUDENT_A_TOKEN,
        body: { id: 'evil_exam', titleEn: 'Evil' }
      }),
      apiCall(`/api/exams/results/${OWNER_ADMIN_UID}`, { token: STUDENT_A_TOKEN })
    ]);

    for (const r of checks) {
      assert.equal(r.status, 403);
    }
  });

  test('3. Payment Security: server pricing, duplicate TrxID, rejected TrxID block, and scoped approval', async () => {
    // Student A submits payment with tampered amount: 1 for pkg_pro_mock (300 BDT)
    const createRes = await apiCall('/api/payments/create', {
      method: 'POST',
      token: STUDENT_A_TOKEN,
      body: {
        method: 'bKash',
        studentPhone: '01711111111',
        senderNumber: '01711111111',
        transactionId: 'trx998877aa',
        packageId: 'pkg_pro_mock',
        amount: 1 // tampered client price — must be ignored!
      }
    });
    assert.equal(createRes.status, 201);
    assert.equal(createRes.json.success, true);
    assert.equal(createRes.json.paymentRequest.amount, 300);
    assert.equal(createRes.json.paymentRequest.status, 'pending');
    assert.equal(createRes.json.paymentRequest.userId, 'student_uid_alpha');
    assert.equal(createRes.json.paymentRequest.transactionId, 'TRX998877AA');
    const payIdA = createRes.json.paymentRequest.id;

    // Duplicate TrxID submitted by different student (Student B) -> 409 DUPLICATE_TRX_ID
    const dupRes = await apiCall('/api/payments/create', {
      method: 'POST',
      token: STUDENT_B_TOKEN,
      body: {
        method: 'Nagad',
        senderNumber: '01822222222',
        transactionId: 'trx-9988-77aa',
        packageId: 'pkg_pro_mock'
      }
    });
    assert.equal(dupRes.status, 409);
    assert.equal(dupRes.json.error, 'DUPLICATE_TRX_ID');

    // Submit another payment to test rejection locking out TrxID reuse
    const createRejectTarget = await apiCall('/api/payments/create', {
      method: 'POST',
      token: STUDENT_B_TOKEN,
      body: {
        method: 'Nagad',
        senderNumber: '01822222222',
        transactionId: 'TRXREJECTED01',
        packageId: 'pkg_monthly_sub'
      }
    });
    assert.equal(createRejectTarget.status, 201);
    assert.equal(createRejectTarget.json.paymentRequest.amount, 150);

    const rejectRes = await apiCall(`/api/admin/payments/${createRejectTarget.json.paymentRequest.id}/reject`, {
      method: 'POST',
      token: OWNER_TOKEN,
      body: { reason: 'Fake TrxID' }
    });
    assert.equal(rejectRes.status, 200);
    assert.equal(rejectRes.json.paymentRequest.status, 'rejected');

    // Resubmitting previously rejected TrxID must remain blocked!
    const resubmitRejected = await apiCall('/api/payments/create', {
      method: 'POST',
      token: STUDENT_B_TOKEN,
      body: {
        method: 'Nagad',
        senderNumber: '01822222222',
        transactionId: 'TRXREJECTED01',
        packageId: 'pkg_monthly_sub'
      }
    });
    assert.equal(resubmitRejected.status, 409);
    assert.equal(resubmitRejected.json.error, 'DUPLICATE_TRX_ID');

    // Owner approves Student A's payment -> activates ONLY Student A
    const approveRes = await apiCall(`/api/admin/payments/${payIdA}/approve`, {
      method: 'POST',
      token: OWNER_TOKEN,
      body: {}
    });
    assert.equal(approveRes.status, 200);
    assert.equal(approveRes.json.paymentRequest.status, 'approved');
    assert.equal(approveRes.json.subscription.userId, 'student_uid_alpha');
    assert.equal(approveRes.json.subscription.status, 'active');

    assert.equal(await checkUserHasActiveSubscription('student_uid_alpha', mirror), true);
    assert.equal(await checkUserHasActiveSubscription('student_uid_beta', mirror), false);
    assert.equal(await checkUserHasActiveSubscription('student_uid_expired', mirror), false);

    // Verify error classifiers for Firestore codes
    assert.equal(isAlreadyExistsError({ code: 6 }), true);
    assert.equal(isAlreadyExistsError({ code: 'already-exists' }), true);
    assert.equal(isPermissionOrCredentialError({ code: 7 }), true);
    assert.equal(isPermissionOrCredentialError({ code: 'permission-denied' }), true);
  });

  test('4. Subscription Security: unsubscribed & expired users blocked from paid exams and non-demo practice', async () => {
    const paidExamId = mirror.exams.find(e => e.isPaid)?.id || 'exam_model_test_2';
    const nonDemoQ = mirror.questions.find(q => !q.isDemoSample);
    assert.ok(nonDemoQ, 'Expected non-demo question in server bank');

    const betaStart = await apiCall('/api/exams/start', {
      method: 'POST',
      token: STUDENT_B_TOKEN,
      body: { examId: paidExamId }
    });
    assert.equal(betaStart.status, 403);
    assert.equal(betaStart.json.error, 'SUBSCRIPTION_REQUIRED');

    const expiredStart = await apiCall('/api/exams/start', {
      method: 'POST',
      token: EXPIRED_STUDENT_TOKEN,
      body: { examId: paidExamId }
    });
    assert.equal(expiredStart.status, 403);
    assert.equal(expiredStart.json.error, 'SUBSCRIPTION_REQUIRED');

    const expiredPractice = await apiCall('/api/practice/check', {
      method: 'POST',
      token: EXPIRED_STUDENT_TOKEN,
      body: { questionId: nonDemoQ.id, selectedOption: 0 }
    });
    assert.equal(expiredPractice.status, 403);
    assert.equal(expiredPractice.json.error, 'SUBSCRIPTION_REQUIRED');
  });

  test('5. MCQ Answer Key Protection: sanitized payloads for students, full keys only for Owner Admin', async () => {
    const studentQuestions = await apiCall('/api/questions', { token: STUDENT_A_TOKEN });
    assert.equal(studentQuestions.status, 200);
    assert.ok(studentQuestions.json.questions.length >= 3000);
    for (const q of studentQuestions.json.questions.slice(0, 50)) {
      assert.equal(q.correctOptionIndex, undefined);
      assert.equal(q.explanationBn, undefined);
      assert.equal(q.explanationEn, undefined);
    }

    const publicPrevious = await apiCall('/api/previous-questions');
    assert.equal(publicPrevious.status, 200);
    assert.ok(publicPrevious.json.previousQuestions.length > 0);
    for (const pq of publicPrevious.json.previousQuestions) {
      assert.equal(pq.correctAnswer, undefined);
      assert.equal(pq.explanation, undefined);
      assert.equal(pq.correctOptionIndex, undefined);
    }

    const adminQuestions = await apiCall('/api/admin/questions', { token: OWNER_TOKEN });
    assert.equal(adminQuestions.status, 200);
    assert.equal(typeof adminQuestions.json.questions[0].correctOptionIndex, 'number');

    // On-demand server check for previous question & grading
    const firstPrev = mirror.previousQuestions[0];
    const checkPrev = await apiCall('/api/previous-questions/check', {
      method: 'POST',
      body: { questionId: firstPrev.id, selectedAnswer: firstPrev.correctAnswer }
    });
    assert.equal(checkPrev.status, 200);
    assert.equal(checkPrev.json.isCorrect, true);
    assert.equal(checkPrev.json.correctAnswer, firstPrev.correctAnswer);

    const gradePrev = await apiCall('/api/previous-questions/grade', {
      method: 'POST',
      body: {
        questionIds: [mirror.previousQuestions[0].id, mirror.previousQuestions[1].id],
        answers: {
          [mirror.previousQuestions[0].id]: mirror.previousQuestions[0].correctAnswer,
          [mirror.previousQuestions[1].id]: 'WRONG_CHOICE'
        }
      }
    });
    assert.equal(gradePrev.status, 200);
    assert.equal(gradePrev.json.evaluation.finalScore, 0.75);
  });

  test('6. Server-Side Exam Scoring: anti-tamper, 70/20/10 = 65.00, cross-user block & duplicate submit block', async () => {
    const paidExam = mirror.exams.find(e => e.isPaid);
    assert.ok(paidExam, 'Expected paid exam');

    // Student A (now subscribed) starts paid exam
    const startRes = await apiCall('/api/exams/start', {
      method: 'POST',
      token: STUDENT_A_TOKEN,
      body: { examId: paidExam.id, studentName: 'Student Alpha' }
    });
    assert.equal(startRes.status, 200);
    assert.equal(startRes.json.success, true);
    approvedAttemptId = startRes.json.attempt.id;

    // Verify exam questions returned by start do NOT leak correctOptionIndex
    const startedQuestions = startRes.json.questions as Array<{ id: string; correctOptionIndex?: number }>;
    assert.equal(startedQuestions.length, 100);
    for (const q of startedQuestions) {
      assert.equal(q.correctOptionIndex, undefined);
    }

    // Build exact 70 right, 20 wrong, 10 skipped using server mirror keys
    const answers: Record<string, number> = {};
    const qMap = new Map(mirror.questions.map(q => [q.id, q]));
    startedQuestions.forEach((sq, idx) => {
      const truth = qMap.get(sq.id)!;
      if (idx < 70) {
        answers[sq.id] = truth.correctOptionIndex;
      } else if (idx < 90) {
        answers[sq.id] = (truth.correctOptionIndex + 1) % 4;
      }
    });

    // Save progress mid-exam
    const saveProgressRes = await apiCall('/api/exams/save-answer', {
      method: 'POST',
      token: STUDENT_A_TOKEN,
      body: {
        attemptId: approvedAttemptId,
        answers,
        flaggedQuestionIds: [startedQuestions[0].id],
        currentQuestionIndex: 5
      }
    });
    assert.equal(saveProgressRes.status, 200);

    // Cross-user submit by Student B -> 403
    const crossSubmit = await apiCall('/api/exams/submit', {
      method: 'POST',
      token: STUDENT_B_TOKEN,
      body: { attemptId: approvedAttemptId, answers }
    });
    assert.equal(crossSubmit.status, 403);

    // Student A submits WITH tampered score fields -> server ignores fake client totals and grades authoritatively
    const submitRes = await apiCall('/api/exams/submit', {
      method: 'POST',
      token: STUDENT_A_TOKEN,
      body: {
        attemptId: approvedAttemptId,
        answers,
        userId: 'hacker_uid',
        finalScore: 100,
        passed: true
      }
    });
    assert.equal(submitRes.status, 200);
    assert.equal(submitRes.json.success, true);
    const result = submitRes.json.result;
    assert.equal(result.userId, 'student_uid_alpha');
    assert.equal(result.correctAnswersCount, 70);
    assert.equal(result.incorrectAnswersCount, 20);
    assert.equal(result.unansweredCount, 10);
    assert.equal(result.positiveMarks, 70);
    assert.equal(result.negativeMarks, 5);
    assert.equal(result.finalScore, 65);
    assert.equal(result.percentage, 65);
    assert.equal(result.passed, true);

    // Duplicate submission of same attempt -> 400 ALREADY_SUBMITTED
    const dupSubmit = await apiCall('/api/exams/submit', {
      method: 'POST',
      token: STUDENT_A_TOKEN,
      body: { attemptId: approvedAttemptId, answers }
    });
    assert.equal(dupSubmit.status, 400);
    assert.equal(dupSubmit.json.error, 'ALREADY_SUBMITTED');
  });

  test('7. Exam Data Integrity, Firestore Rules Hardening & Existing Scoring Scenarios (10/10)', async () => {
    const inactiveExamRes = await apiCall('/api/admin/exams/save', {
      method: 'POST',
      token: OWNER_TOKEN,
      body: {
        id: 'exam_inactive_check',
        titleBn: 'আসন্ন পরীক্ষা',
        titleEn: 'Upcoming Inactive Exam',
        type: 'full_mock',
        durationMinutes: 60,
        totalMarks: 100,
        passThresholdPercentage: 50,
        questionIds: mirror.questions.slice(0, 10).map(q => q.id),
        isPaid: false,
        isActive: false,
        scheduledDate: '2026-12-01T10:00:00.000Z',
        releaseExplanationsImmediately: true,
        negativeMarkRatio: 0.25,
        positiveMarkRatio: 1.0,
        createdAt: new Date().toISOString()
      }
    });
    assert.equal(inactiveExamRes.status, 200);
    assert.equal(inactiveExamRes.json.exam.isActive, false);

    const studentStartInactive = await apiCall('/api/exams/start', {
      method: 'POST',
      token: STUDENT_A_TOKEN,
      body: { examId: 'exam_inactive_check' }
    });
    assert.equal(studentStartInactive.status, 403);
    assert.equal(studentStartInactive.json.error, 'EXAM_INACTIVE');

    // Owner Admin can preview inactive exam
    const ownerStartInactive = await apiCall('/api/exams/start', {
      method: 'POST',
      token: OWNER_TOKEN,
      body: { examId: 'exam_inactive_check' }
    });
    assert.equal(ownerStartInactive.status, 200);

    // Verify firestore.rules contains all required security clauses
    const rulesTxt = fs.readFileSync(path.resolve(process.cwd(), 'firestore.rules'), 'utf8');
    assert.match(rulesTxt, /match \/questionKeys\/\{questionId\}/);
    assert.match(rulesTxt, /match \/previousQuestionKeys\/\{questionId\}/);
    assert.match(rulesTxt, /expiresAt is timestamp && sub\.expiresAt > request\.time/);
    assert.match(rulesTxt, /resource == null/);
    assert.match(rulesTxt, /request\.resource\.data\.amount >= 100/);
    assert.match(rulesTxt, /request\.resource\.data\.transactionId is string/);

    // Execute built-in scoring & business scenario suite (10/10)
    const scenarios = runAllTestScenarios();
    assert.equal(scenarios.length, 10);
    for (const sc of scenarios) {
      assert.equal(sc.passed, true, `Scenario failed: ${sc.titleEn} -> ${sc.details}`);
    }
  });
});
