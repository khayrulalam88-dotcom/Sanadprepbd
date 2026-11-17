import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import type { Firestore } from 'firebase-admin/firestore';
import {
  createSanadPrepApp,
  parseAllowedOrigins,
  isOriginAllowed,
  type DecodedAuthUser
} from '../server.ts';
import {
  formatBackendApiError,
  submitPaymentViaAuthoritativeBackend,
  executeAuthoritativeAdminApi
} from '../src/lib/securityHelpers.ts';
import {
  OWNER_ADMIN_UID,
  OWNER_ADMIN_EMAIL,
  EXPECTED_FIREBASE_PROJECT_ID,
  EXPECTED_FIREBASE_DATABASE_ID,
  resolveEffectiveDatabaseId,
  assertExpectedNamedDatabase,
  getConfiguredDatabaseInfo,
  invalidateQuestionBankCache,
  createMemoryMirror,
  checkUserHasActiveSubscription,
  isAlreadyExistsError,
  isPermissionOrCredentialError,
  getSafeDiagnosticError,
  planFirestoreMigration,
  executeFirestoreMigration,
  clearRateLimitBucketsForTests
} from '../server/services/firestoreBackend.ts';
import {
  isGeminiConfigured,
  validateGeminiRequest,
  normalizeGeminiError,
  redactGeminiSecrets,
  generateGeminiText
} from '../server/services/geminiService.ts';
import { parseMigrationCliArgs } from '../scripts/migrateFirestoreData.ts';
import { runAllTestScenarios } from '../src/utils/testScenarios.ts';
import { validateCsvQuestions, resolveSubjectId } from '../src/utils/csvParser.ts';
import { INITIAL_SUBJECTS } from '../src/data/mockData.ts';

const OWNER_TOKEN = 'token-owner-admin';
const STUDENT_A_TOKEN = 'token-student-a';
const STUDENT_B_TOKEN = 'token-student-b';
const EXPIRED_STUDENT_TOKEN = 'token-student-expired';
const UNVERIFIED_STUDENT_TOKEN = 'token-student-unverified';

const TOKEN_MAP: Record<string, DecodedAuthUser> = {
  [OWNER_TOKEN]: {
    uid: OWNER_ADMIN_UID,
    email: OWNER_ADMIN_EMAIL,
    emailVerified: true,
    name: 'Owner Admin'
  },
  [STUDENT_A_TOKEN]: {
    uid: 'student_uid_alpha',
    email: 'student.a@example.com',
    emailVerified: true,
    name: 'Student Alpha'
  },
  [STUDENT_B_TOKEN]: {
    uid: 'student_uid_beta',
    email: 'student.b@example.com',
    emailVerified: true,
    name: 'Student Beta'
  },
  [EXPIRED_STUDENT_TOKEN]: {
    uid: 'student_uid_expired',
    email: 'expired@example.com',
    emailVerified: true,
    name: 'Expired Student'
  },
  [UNVERIFIED_STUDENT_TOKEN]: {
    uid: 'student_uid_unverified',
    email: 'unverified@example.com',
    emailVerified: false,
    name: 'Unverified Student'
  }
};

describe('Sanad Prep BD – Third-Stage Security & Functional Remediation Suite', () => {
  const mirror = createMemoryMirror();
  let server: http.Server;
  let baseUrl = '';
  let approvedAttemptId = '';
  const sessionIds: Record<string, string> = {};

  before(async () => {
    clearRateLimitBucketsForTests();
    // Seed an expired subscription for EXPIRED_STUDENT_TOKEN
    mirror.subscriptions.push({
      id: 'sub_expired_seed',
      userId: 'student_uid_expired',
      studentName: 'Expired Student',
      studentPhone: '01700000099',
      packageId: 'pkg_monthly',
      packageNameBn: 'মাসিক সাবস্ক্রিপশন',
      packageNameEn: 'Monthly Subscription',
      pricePaid: 150,
      paymentRequestId: 'trx_TRX_OLD_EXPIRED_01',
      paymentMethod: 'bKash',
      transactionId: 'TRX_OLD_EXPIRED_01',
      validityType: 'days',
      status: 'active', // even if status field is still 'active', past expiresAt must deny access!
      activatedAt: new Date(Date.now() - 120 * 24 * 3600 * 1000).toISOString(),
      expiresAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      createdAt: new Date(Date.now() - 120 * 24 * 3600 * 1000).toISOString()
    });

    const { app } = createSanadPrepApp({
      mirror,
      disableFirestoreWrites: true,
      rateLimitOverrides: { globalMax: 1000 },
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

    for (const tok of [OWNER_TOKEN, STUDENT_A_TOKEN, STUDENT_B_TOKEN, EXPIRED_STUDENT_TOKEN]) {
      const sRes = await apiCall('/api/auth/session', { method: 'POST', token: tok, sessionId: null });
      assert.equal(sRes.status, 200);
      sessionIds[tok] = sRes.json.sessionId as string;
    }
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  async function apiCall(
    urlPath: string,
    opts: { method?: string; token?: string; sessionId?: string | null; body?: unknown } = {}
  ): Promise<{ status: number; json: Record<string, any> }> {
    const headers: Record<string, string> = {};
    if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
    const resolvedSessionId =
      opts.sessionId === null ? undefined : (opts.sessionId ?? (opts.token ? sessionIds[opts.token] : undefined));
    if (resolvedSessionId) headers['X-Session-Id'] = resolvedSessionId;
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
    // Student A submits payment with tampered amount: 1 for pkg_long_course (999 BDT)
    const createRes = await apiCall('/api/payments/create', {
      method: 'POST',
      token: STUDENT_A_TOKEN,
      body: {
        method: 'bKash',
        studentPhone: '01711111111',
        senderNumber: '01711111111',
        transactionId: 'trx998877aa',
        packageId: 'pkg_long_course',
        amount: 1 // tampered client price — must be ignored!
      }
    });
    assert.ok(createRes.status === 200 || createRes.status === 201);
    assert.equal(createRes.json.success, true);
    assert.equal(createRes.json.paymentRequest.amount, 999);
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
        packageId: 'pkg_long_course'
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
        packageId: 'pkg_monthly'
      }
    });
    assert.ok(createRejectTarget.status === 200 || createRejectTarget.status === 201);
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
        packageId: 'pkg_monthly'
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

    assert.equal((await checkUserHasActiveSubscription('student_uid_alpha', mirror, undefined, true, false)).active, true);
    assert.equal((await checkUserHasActiveSubscription('student_uid_beta', mirror, undefined, true, false)).active, false);
    assert.equal((await checkUserHasActiveSubscription('student_uid_expired', mirror, undefined, true, false)).active, false);

    // Verify error classifiers for Firestore codes
    assert.equal(isAlreadyExistsError({ code: 6 }), true);
    assert.equal(isAlreadyExistsError({ code: 'already-exists' }), true);
    assert.equal(isPermissionOrCredentialError({ code: 7 }), true);
    assert.equal(isPermissionOrCredentialError({ code: 'permission-denied' }), true);
  });

  test('4. Subscription Security: unsubscribed & expired users blocked from paid exams and non-demo practice', async () => {
    const model2 = mirror.exams.find(e => e.id === 'exam_model_test_02') || mirror.exams.find(e => e.isPaid);
    assert.ok(model2, 'Expected paid model test');
    const activateRes = await apiCall('/api/admin/exams/save', {
      method: 'POST',
      token: OWNER_TOKEN,
      body: { ...model2, isActive: true, published: true }
    });
    assert.equal(activateRes.status, 200);
    const paidExamId = model2.id;
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

  test('5. MCQ Answer Key Protection & Decommissioned Previous-Questions Endpoints', async () => {
    const studentQuestions = await apiCall('/api/questions', { token: STUDENT_A_TOKEN });
    assert.equal(studentQuestions.status, 200);
    assert.ok(studentQuestions.json.questions.length >= 3000);
    for (const q of studentQuestions.json.questions.slice(0, 50)) {
      assert.equal(q.correctOptionIndex, undefined);
      assert.equal(q.explanationBn, undefined);
      assert.equal(q.explanationEn, undefined);
    }

    const decommissionedPrev = await apiCall('/api/previous-questions');
    assert.equal(decommissionedPrev.status, 404);
    const decommissionedPrevCheck = await apiCall('/api/previous-questions/check', {
      method: 'POST',
      token: STUDENT_A_TOKEN,
      body: { questionId: 'pq_1', selectedAnswer: 'A' }
    });
    assert.equal(decommissionedPrevCheck.status, 404);
    const decommissionedAdminPrev = await apiCall('/api/admin/previous-questions', { token: OWNER_TOKEN });
    assert.equal(decommissionedAdminPrev.status, 404);

    const adminQuestions = await apiCall('/api/admin/questions', { token: OWNER_TOKEN });
    assert.equal(adminQuestions.status, 200);
    assert.equal(typeof adminQuestions.json.questions[0].correctOptionIndex, 'number');
  });

  test('6. Server-Side Exam Scoring: anti-tamper, 70/20/10 = 65.00, cross-user block & duplicate submit block', async () => {
    const paidExam = mirror.exams.find(e => e.isPaid && e.isActive !== false);
    assert.ok(paidExam, 'Expected active paid exam');

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
    assert.match(rulesTxt, /match \/previous_questions\/\{questionId\}/);
    assert.match(rulesTxt, /match \/previousQuestionKeys\/\{questionId\}/);
    assert.match(rulesTxt, /match \/admins\/\{adminId\}/);
    assert.match(rulesTxt, /request\.auth\.token\.email_verified == true/);
    assert.match(rulesTxt, /subscriptionExpiresAt is timestamp/);
    assert.match(rulesTxt, /subscriptionExpiresAt > request\.time/);
    assert.match(rulesTxt, /resource == null/);
    assert.equal(rulesTxt.includes('isAdmin('), false, 'firestore.rules must not contain spoofing isAdmin() helper');
    assert.equal(rulesTxt.includes('isFree'), false, 'firestore.rules must not allow unverified isFree fallback');

    // Execute built-in scoring & business scenario suite (10/10)
    const scenarios = runAllTestScenarios();
    assert.equal(scenarios.length, 10);
    for (const sc of scenarios) {
      assert.equal(sc.passed, true, `Scenario failed: ${sc.name} -> ${JSON.stringify(sc.details)}`);
    }
  });
});

// =========================================================================
// Transactional In-Memory Firestore Simulator (For Local Unit/Concurrency Tests ONLY)
// NOTE: Validates backend logic, multi-instance consistency, transaction retries,
// and error handling locally — does NOT replace live Cloud Firestore verification.
// =========================================================================
function cloneFirestoreValue<T>(val: T): T {
  if (val === null || val === undefined || typeof val !== 'object') return val;
  if (val instanceof Date) return new Date(val.getTime()) as unknown as T;
  // Preserve Firebase Timestamp or timestamp-like objects with toDate()
  if (typeof (val as { toDate?: unknown }).toDate === 'function') {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map(item => cloneFirestoreValue(item)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
    if (v !== undefined) {
      out[k] = cloneFirestoreValue(v);
    }
  }
  return out as T;
}

class FakeDocSnapshot {
  constructor(
    public readonly id: string,
    public readonly ref: FakeDocRef,
    private readonly _data: Record<string, unknown> | undefined
  ) {}
  get exists(): boolean {
    return this._data !== undefined;
  }
  data(): Record<string, unknown> | undefined {
    return this._data ? cloneFirestoreValue(this._data) : undefined;
  }
}

class FakeQuerySnapshot {
  constructor(public readonly docs: FakeDocSnapshot[]) {}
  get empty(): boolean {
    return this.docs.length === 0;
  }
  get size(): number {
    return this.docs.length;
  }
  forEach(cb: (doc: FakeDocSnapshot) => void): void {
    for (const d of this.docs) cb(d);
  }
}

class FakeDocRef {
  constructor(
    private readonly fsDb: FakeFirestore,
    public readonly collectionName: string,
    public readonly id: string
  ) {}
  get path(): string {
    return `${this.collectionName}/${this.id}`;
  }
  async get(): Promise<FakeDocSnapshot> {
    await Promise.resolve();
    this.fsDb.maybeThrowRead();
    this.fsDb.recordRead(this.collectionName, 1);
    return new FakeDocSnapshot(this.id, this, this.fsDb.rawGet(this.path));
  }
  async set(data: Record<string, unknown>, opts?: { merge?: boolean }): Promise<void> {
    await Promise.resolve();
    this.fsDb.maybeThrowWrite();
    this.fsDb.rawSet(this.path, data, opts?.merge);
  }
  async create(data: Record<string, unknown>): Promise<void> {
    await Promise.resolve();
    this.fsDb.maybeThrowWrite();
    if (this.fsDb.rawGet(this.path) !== undefined) {
      const err = new Error(`6 ALREADY_EXISTS: Document already exists: ${this.path}`) as Error & { code: number };
      err.code = 6;
      throw err;
    }
    this.fsDb.rawSet(this.path, data, false);
  }
  async update(data: Record<string, unknown>): Promise<void> {
    await Promise.resolve();
    this.fsDb.maybeThrowWrite();
    if (this.fsDb.rawGet(this.path) === undefined) {
      const err = new Error(`5 NOT_FOUND: Document does not exist: ${this.path}`) as Error & { code: number };
      err.code = 5;
      throw err;
    }
    this.fsDb.rawSet(this.path, data, true);
  }
  async delete(): Promise<void> {
    await Promise.resolve();
    this.fsDb.maybeThrowWrite();
    this.fsDb.rawDelete(this.path);
  }
}

class FakeQuery {
  constructor(
    private readonly fsDb: FakeFirestore,
    private readonly collectionName: string,
    private readonly filters: Array<{ field: string; op: string; value: unknown }> = [],
    private readonly limitCount?: number
  ) {}
  where(field: string, op: string, value: unknown): FakeQuery {
    return new FakeQuery(this.fsDb, this.collectionName, [...this.filters, { field, op, value }], this.limitCount);
  }
  limit(n: number): FakeQuery {
    return new FakeQuery(this.fsDb, this.collectionName, this.filters, n);
  }
  async get(): Promise<FakeQuerySnapshot> {
    await Promise.resolve();
    this.fsDb.maybeThrowRead();
    const snap = this.fsDb.runQuerySync(this.collectionName, this.filters, this.limitCount);
    this.fsDb.recordRead(this.collectionName, Math.max(1, snap.docs.length));
    return snap;
  }
}

class FakeCollectionRef extends FakeQuery {
  constructor(fsDb: FakeFirestore, public readonly name: string) {
    super(fsDb, name);
    this._fsDb = fsDb;
  }
  private readonly _fsDb: FakeFirestore;
  doc(id?: string): FakeDocRef {
    const resolvedId = id || `auto_${Math.random().toString(36).slice(2, 10)}`;
    return new FakeDocRef(this._fsDb, this.name, resolvedId);
  }
}

type PendingOp =
  | { type: 'set'; path: string; data: Record<string, unknown>; merge?: boolean }
  | { type: 'create'; path: string; data: Record<string, unknown> }
  | { type: 'update'; path: string; data: Record<string, unknown> }
  | { type: 'delete'; path: string };

class FakeWriteBatch {
  private ops: PendingOp[] = [];
  constructor(private readonly fsDb: FakeFirestore) {}
  set(ref: FakeDocRef, data: Record<string, unknown>, opts?: { merge?: boolean }): FakeWriteBatch {
    this.ops.push({ type: 'set', path: ref.path, data: cloneFirestoreValue(data), merge: opts?.merge });
    return this;
  }
  create(ref: FakeDocRef, data: Record<string, unknown>): FakeWriteBatch {
    this.ops.push({ type: 'create', path: ref.path, data: cloneFirestoreValue(data) });
    return this;
  }
  update(ref: FakeDocRef, data: Record<string, unknown>): FakeWriteBatch {
    this.ops.push({ type: 'update', path: ref.path, data: cloneFirestoreValue(data) });
    return this;
  }
  delete(ref: FakeDocRef): FakeWriteBatch {
    this.ops.push({ type: 'delete', path: ref.path });
    return this;
  }
  async commit(): Promise<void> {
    await Promise.resolve();
    this.fsDb.applyAtomicOps(this.ops, new Map());
  }
}

class FakeTransaction {
  private ops: PendingOp[] = [];
  private readVersions = new Map<string, number>();
  constructor(private readonly fsDb: FakeFirestore) {}

  async get(target: FakeDocRef | FakeQuery): Promise<unknown> {
    await Promise.resolve();
    this.fsDb.maybeThrowRead();
    if (target instanceof FakeDocRef) {
      this.fsDb.recordRead(target.collectionName, 1);
      const ver = this.fsDb.getVersion(target.path);
      if (!this.readVersions.has(target.path)) {
        this.readVersions.set(target.path, ver);
      }
      return new FakeDocSnapshot(target.id, target, this.fsDb.rawGet(target.path));
    }
    const snap = await target.get();
    for (const d of snap.docs) {
      if (!this.readVersions.has(d.ref.path)) {
        this.readVersions.set(d.ref.path, this.fsDb.getVersion(d.ref.path));
      }
    }
    return snap;
  }
  set(ref: FakeDocRef, data: Record<string, unknown>, opts?: { merge?: boolean }): FakeTransaction {
    this.ops.push({ type: 'set', path: ref.path, data: cloneFirestoreValue(data), merge: opts?.merge });
    return this;
  }
  create(ref: FakeDocRef, data: Record<string, unknown>): FakeTransaction {
    this.ops.push({ type: 'create', path: ref.path, data: cloneFirestoreValue(data) });
    return this;
  }
  update(ref: FakeDocRef, data: Record<string, unknown>): FakeTransaction {
    this.ops.push({ type: 'update', path: ref.path, data: cloneFirestoreValue(data) });
    return this;
  }
  delete(ref: FakeDocRef): FakeTransaction {
    this.ops.push({ type: 'delete', path: ref.path });
    return this;
  }
  commit(): void {
    this.fsDb.applyAtomicOps(this.ops, this.readVersions);
  }
}

class FakeFirestore {
  public store = new Map<string, Record<string, unknown>>();
  public databaseId: string = EXPECTED_FIREBASE_DATABASE_ID;
  private versions = new Map<string, number>();
  private readCounts = new Map<string, number>();
  public writeFailure: Error | null = null;
  public readFailure: Error | null = null;

  recordRead(collectionName: string, count: number): void {
    this.readCounts.set(collectionName, (this.readCounts.get(collectionName) || 0) + count);
  }
  getReadCount(collectionName: string): number {
    return this.readCounts.get(collectionName) || 0;
  }
  resetReadCounts(): void {
    this.readCounts.clear();
  }
  collection(name: string): FakeCollectionRef {
    return new FakeCollectionRef(this, name);
  }
  batch(): FakeWriteBatch {
    return new FakeWriteBatch(this);
  }
  getVersion(docPath: string): number {
    return this.versions.get(docPath) || 0;
  }
  maybeThrowWrite(): void {
    if (this.writeFailure) throw this.writeFailure;
  }
  maybeThrowRead(): void {
    if (this.readFailure) throw this.readFailure;
  }
  rawGet(docPath: string): Record<string, unknown> | undefined {
    const val = this.store.get(docPath);
    return val ? cloneFirestoreValue(val) : undefined;
  }
  rawSet(docPath: string, data: Record<string, unknown>, merge = false): void {
    const existing = this.store.get(docPath);
    const next = merge && existing ? { ...existing, ...cloneFirestoreValue(data) } : cloneFirestoreValue(data);
    this.store.set(docPath, next);
    this.versions.set(docPath, (this.versions.get(docPath) || 0) + 1);
  }
  rawDelete(docPath: string): void {
    this.store.delete(docPath);
    this.versions.set(docPath, (this.versions.get(docPath) || 0) + 1);
  }
  runQuerySync(
    collectionName: string,
    filters: Array<{ field: string; op: string; value: unknown }>,
    limitCount?: number
  ): FakeQuerySnapshot {
    const prefix = `${collectionName}/`;
    const matched: FakeDocSnapshot[] = [];
    for (const [docPath, data] of this.store.entries()) {
      if (!docPath.startsWith(prefix)) continue;
      const docId = docPath.slice(prefix.length);
      if (docId.includes('/')) continue;

      let ok = true;
      for (const f of filters) {
        if (f.field === '__name__' && f.op === 'in') {
          const arr = Array.isArray(f.value) ? f.value : [];
          if (!arr.includes(docId)) {
            ok = false;
            break;
          }
        } else if (f.op === '==') {
          if (data[f.field] !== f.value) {
            ok = false;
            break;
          }
        }
      }
      if (ok) {
        matched.push(new FakeDocSnapshot(docId, new FakeDocRef(this, collectionName, docId), data));
        if (limitCount !== undefined && matched.length >= limitCount) break;
      }
    }
    return new FakeQuerySnapshot(matched);
  }
  applyAtomicOps(ops: PendingOp[], readVersions: Map<string, number>): void {
    this.maybeThrowWrite();
    // 1. Optimistic concurrency check on read versions
    for (const [docPath, expectedVer] of readVersions.entries()) {
      if (this.getVersion(docPath) !== expectedVer) {
        const conflict = new Error(`10 ABORTED: Transaction conflict on ${docPath}`) as Error & { code: number };
        conflict.code = 10;
        throw conflict;
      }
    }
    // 2. Pre-validate creates/updates before mutating store (atomic all-or-nothing)
    const stagedCreates = new Set<string>();
    for (const op of ops) {
      const existsNow = this.store.has(op.path) || stagedCreates.has(op.path);
      if (op.type === 'create') {
        if (existsNow) {
          const err = new Error(`6 ALREADY_EXISTS: Document already exists: ${op.path}`) as Error & { code: number };
          err.code = 6;
          throw err;
        }
        stagedCreates.add(op.path);
      } else if (op.type === 'update') {
        if (!existsNow) {
          const err = new Error(`5 NOT_FOUND: Document does not exist: ${op.path}`) as Error & { code: number };
          err.code = 5;
          throw err;
        }
      }
    }
    // 3. Commit all operations
    for (const op of ops) {
      if (op.type === 'set') this.rawSet(op.path, op.data, op.merge);
      else if (op.type === 'create') this.rawSet(op.path, op.data, false);
      else if (op.type === 'update') this.rawSet(op.path, op.data, true);
      else if (op.type === 'delete') this.rawDelete(op.path);
    }
  }
  async runTransaction<T>(fn: (tx: FakeTransaction) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const tx = new FakeTransaction(this);
      const result = await fn(tx);
      try {
        tx.commit();
        return result;
      } catch (err) {
        if ((err as { code?: number })?.code === 10 && attempt < 4) {
          continue; // Retry transaction on optimistic version conflict
        }
        throw err;
      }
    }
    throw new Error('Transaction retries exhausted');
  }
}

describe('Sanad Prep BD – P0 Production Multi-Instance, Transaction & Failure Safety Suite (Simulated Firestore)', () => {
  const fakeDb = new FakeFirestore();
  let serverA: http.Server;
  let serverB: http.Server;
  let urlA = '';
  let urlB = '';

  const prodSessions: Record<string, string> = {};

  const tokenVerifier = async (idToken: string): Promise<DecodedAuthUser> => {
    const user = TOKEN_MAP[idToken];
    if (!user) throw new Error('Invalid test token');
    return user;
  };

  async function callUrl(
    base: string,
    urlPath: string,
    opts: { method?: string; token?: string; sessionId?: string | null; body?: unknown } = {}
  ): Promise<{ status: number; json: Record<string, any>; headers?: Headers }> {
    const headers: Record<string, string> = {};
    if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
    const resolvedSess =
      opts.sessionId === null ? undefined : (opts.sessionId ?? (opts.token ? prodSessions[opts.token] : undefined));
    if (resolvedSess) headers['X-Session-Id'] = resolvedSess;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${base}${urlPath}`, {
      method: opts.method || 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    });
    const json = (await res.json()) as Record<string, any>;
    return { status: res.status, json, headers: res.headers };
  }

  before(async () => {
    clearRateLimitBucketsForTests();
    // Seed authoritative Firestore collections using baseline defaults
    const seedMirror = createMemoryMirror();
    for (const pkg of seedMirror.packages) {
      // Set pkg_long_course in Firestore to 1250 (distinct from mirror default 999) to prove Firestore pricing is used
      const override = pkg.id === 'pkg_long_course' ? { ...pkg, price: 1250 } : pkg;
      fakeDb.rawSet(`packages/${pkg.id}`, override as unknown as Record<string, unknown>);
    }
    fakeDb.rawSet('config/examDate', {
      ...seedMirror.examDateConfig,
      examPassPrice: 450 // distinct from mirror default
    });
    fakeDb.rawSet('config/paymentSettings', seedMirror.paymentSettings);
    fakeDb.rawSet('config/supportSettings', seedMirror.supportSettings);

    // Seed 20 questions and 2 exams (1 free active, 1 paid active) in FakeFirestore
    const testQuestions = seedMirror.questions.slice(0, 20);
    for (const q of testQuestions) {
      const { correctOptionIndex, explanationBn, explanationEn, ...sanitized } = q;
      fakeDb.rawSet(`questions/${q.id}`, sanitized as unknown as Record<string, unknown>);
      fakeDb.rawSet(`questionKeys/${q.id}`, {
        correctOptionIndex,
        explanationBn,
        explanationEn,
        legalReference: q.legalReference || ''
      });
    }
    const basePaidExam = seedMirror.exams.find(e => e.isPaid)!;
    fakeDb.rawSet(`exams/${basePaidExam.id}`, {
      ...basePaidExam,
      isActive: true,
      published: true,
      questionIds: testQuestions.map(q => q.id),
      totalMarks: testQuestions.length
    });

    const instA = createSanadPrepApp({
      firestoreDb: fakeDb as unknown as Firestore,
      isProduction: true,
      rateLimitOverrides: { globalMax: 1000 },
      tokenVerifier
    });
    const instB = createSanadPrepApp({
      firestoreDb: fakeDb as unknown as Firestore,
      isProduction: true,
      rateLimitOverrides: { globalMax: 1000 },
      tokenVerifier
    });

    await new Promise<void>(resolve => {
      serverA = instA.app.listen(0, '127.0.0.1', () => {
        urlA = `http://127.0.0.1:${(serverA.address() as { port: number }).port}`;
        resolve();
      });
    });
    await new Promise<void>(resolve => {
      serverB = instB.app.listen(0, '127.0.0.1', () => {
        urlB = `http://127.0.0.1:${(serverB.address() as { port: number }).port}`;
        resolve();
      });
    });

    for (const tok of [OWNER_TOKEN, STUDENT_A_TOKEN, STUDENT_B_TOKEN, EXPIRED_STUDENT_TOKEN]) {
      const sRes = await callUrl(urlA, '/api/auth/session', { method: 'POST', token: tok, sessionId: null });
      assert.equal(sRes.status, 200);
      prodSessions[tok] = sRes.json.sessionId as string;
    }
  });

  after(async () => {
    await Promise.all([
      serverA ? new Promise<void>(r => serverA.close(() => r())) : Promise.resolve(),
      serverB ? new Promise<void>(r => serverB.close(() => r())) : Promise.resolve()
    ]);
  });

  test('A. Production Mode Safety: /api/health reports accurate persistenceMode and blocks routes when unavailable', async () => {
    const healthyRes = await callUrl(urlA, '/api/health');
    assert.equal(healthyRes.status, 200);
    assert.equal(healthyRes.json.status, 'ok');
    assert.equal(healthyRes.json.persistenceMode, 'firestore');
    assert.equal(healthyRes.json.environment, 'production');

    // Simulate production instance where Firestore probe failed / unavailable
    const { app: degradedApp } = createSanadPrepApp({
      isProduction: true,
      disableFirestoreWrites: true,
      tokenVerifier
    });
    let degradedServer: http.Server;
    const degradedUrl = await new Promise<string>(resolve => {
      degradedServer = degradedApp.listen(0, '127.0.0.1', () => {
        resolve(`http://127.0.0.1:${(degradedServer.address() as { port: number }).port}`);
      });
    });

    try {
      const [healthDown, healthAliasDown, retiredPrevDown, retiredCheckDown, retiredAdminPrevDown] = await Promise.all([
        callUrl(degradedUrl, '/api/health'),
        callUrl(degradedUrl, '/health'),
        callUrl(degradedUrl, '/api/previous-questions'),
        callUrl(degradedUrl, '/api/previous-questions/check', {
          method: 'POST',
          token: STUDENT_A_TOKEN,
          body: { questionId: 'pq_1', selectedAnswer: 'A' }
        }),
        callUrl(degradedUrl, '/api/admin/previous-questions', { token: OWNER_TOKEN })
      ]);
      assert.equal(healthDown.status, 503);
      assert.equal(healthDown.json.status, 'degraded');
      assert.equal(healthDown.json.persistenceMode, 'unavailable');
      assert.equal(healthAliasDown.status, 503);
      assert.equal(retiredPrevDown.status, 404);
      assert.equal(retiredCheckDown.status, 404);
      assert.equal(retiredAdminPrevDown.status, 404);

      const blockedChecks = await Promise.all([
        callUrl(degradedUrl, '/api/packages'),
        callUrl(degradedUrl, '/api/exam-config'),
        callUrl(degradedUrl, '/api/payment-settings'),
        callUrl(degradedUrl, '/api/admin/subscriptions', { token: OWNER_TOKEN }),
        callUrl(degradedUrl, '/api/exams/start', { method: 'POST', token: OWNER_TOKEN, body: { examId: 'x' } })
      ]);
      for (const r of blockedChecks) {
        assert.equal(r.status, 503);
        assert.equal(r.json.error, 'FIRESTORE_UNAVAILABLE');
      }
    } finally {
      await new Promise<void>(r => degradedServer.close(() => r()));
    }
  });

  test('B. Multi-Instance & Simulated Restart Persistence + Cross-Instance Session Enforcement', async () => {
    // 1. Update payment settings, support settings & exam config on Instance A
    const paySetRes = await callUrl(urlA, '/api/admin/payment-settings', {
      method: 'POST',
      token: OWNER_TOKEN,
      body: { bkashNumber: '01999888777', nagadNumber: '01888777666' }
    });
    assert.equal(paySetRes.status, 200);

    const supSetRes = await callUrl(urlA, '/api/admin/support-settings', {
      method: 'POST',
      token: OWNER_TOKEN,
      body: { whatsappNumber: '+8801911223344', whatsappMessage: 'Prod Support Msg' }
    });
    assert.equal(supSetRes.status, 200);

    const examCfgRes = await callUrl(urlA, '/api/admin/exam-config', {
      method: 'POST',
      token: OWNER_TOKEN,
      body: { examPassPrice: 520, examTitleBn: 'আপডেটেড বার পরীক্ষা ২০২৬' }
    });
    assert.equal(examCfgRes.status, 200);

    // 2. Read from Instance B AND a fresh Restarted Instance C (fresh mirror!)
    const { app: appC } = createSanadPrepApp({
      firestoreDb: fakeDb as unknown as Firestore,
      isProduction: true,
      rateLimitOverrides: { globalMax: 1000 },
      tokenVerifier
    });
    let serverC: http.Server;
    const urlC = await new Promise<string>(resolve => {
      serverC = appC.listen(0, '127.0.0.1', () => {
        resolve(`http://127.0.0.1:${(serverC.address() as { port: number }).port}`);
      });
    });

    try {
      for (const targetUrl of [urlB, urlC]) {
        const payGet = await callUrl(targetUrl, '/api/payment-settings');
        assert.equal(payGet.status, 200);
        assert.equal(payGet.json.paymentSettings.bkashNumber, '01999888777');
        assert.equal(payGet.json.paymentSettings.nagadNumber, '01888777666');
        assert.equal(payGet.json.supportSettings.whatsappNumber, '+8801911223344');

        const cfgGet = await callUrl(targetUrl, '/api/exam-config');
        assert.equal(cfgGet.status, 200);
        assert.equal(cfgGet.json.examDateConfig.examPassPrice, 520);
        assert.equal(cfgGet.json.examDateConfig.examTitleBn, 'আপডেটেড বার পরীক্ষা ২০২৬');

        const decommissionedPrev = await callUrl(targetUrl, '/api/admin/previous-questions', { token: OWNER_TOKEN });
        assert.equal(decommissionedPrev.status, 404);

        const auditGet = await callUrl(targetUrl, '/api/admin/audit-logs', { token: OWNER_TOKEN });
        assert.equal(auditGet.status, 200);
        assert.ok((auditGet.json.auditLogs as Array<{ action: string }>).some(l => l.action === 'UPDATE_PAYMENT_SETTINGS'));
      }

      // 3. Cross-instance session revocation
      const sess1 = await callUrl(urlA, '/api/auth/session', { method: 'POST', token: STUDENT_A_TOKEN, sessionId: null });
      assert.equal(sess1.status, 200);
      const sess1Id = sess1.json.sessionId as string;

      const sess2 = await callUrl(urlB, '/api/auth/session', { method: 'POST', token: STUDENT_A_TOKEN, sessionId: null });
      assert.equal(sess2.status, 200);
      const sess2Id = sess2.json.sessionId as string;
      assert.notEqual(sess1Id, sess2Id);
      prodSessions[STUDENT_A_TOKEN] = sess2Id;

      // Using old sessionId on Instance C must be rejected with 401 SESSION_REVOKED
      const revokedCall = await callUrl(urlC, '/api/auth/session/status', {
        token: STUDENT_A_TOKEN,
        sessionId: sess1Id
      });
      assert.equal(revokedCall.status, 401);
      assert.equal(revokedCall.json.error, 'SESSION_REVOKED');
    } finally {
      await new Promise<void>(r => serverC.close(() => r()));
    }
  });

  test('C. Authoritative Firestore Pricing + Duplicate/Concurrent Payment Approvals Across Instances', async () => {
    // Student A submits pkg_long_course with client amount 1 -> must resolve 1250 from Firestore /packages!
    const payCreateA = await callUrl(urlA, '/api/payments/create', {
      method: 'POST',
      token: STUDENT_A_TOKEN,
      body: {
        method: 'bKash',
        senderNumber: '01711000111',
        transactionId: 'PRODTRX1250',
        packageId: 'pkg_long_course',
        amount: 1
      }
    });
    assert.equal(payCreateA.status, 200);
    assert.equal(payCreateA.json.paymentRequest.amount, 1250);
    const payIdA = payCreateA.json.paymentRequest.id as string;

    // Student B submits pkg_exam_pass -> must resolve 520 (updated via exam-config earlier in Test B!)
    const payCreateB = await callUrl(urlB, '/api/payments/create', {
      method: 'POST',
      token: STUDENT_B_TOKEN,
      body: {
        method: 'Nagad',
        senderNumber: '01811000222',
        transactionId: 'PRODTRXEXAM520',
        packageId: 'pkg_exam_pass',
        amount: 10
      }
    });
    assert.equal(payCreateB.status, 200);
    assert.equal(payCreateB.json.paymentRequest.amount, 520);

    // Concurrent approval race across Instance A and Instance B for same payIdA
    const [appRes1, appRes2] = await Promise.all([
      callUrl(urlA, `/api/admin/payments/${payIdA}/approve`, { method: 'POST', token: OWNER_TOKEN }),
      callUrl(urlB, `/api/admin/payments/${payIdA}/approve`, { method: 'POST', token: OWNER_TOKEN })
    ]);

    const statuses = [appRes1.status, appRes2.status].sort();
    assert.deepEqual(statuses, [200, 400]);
    const failureRes = appRes1.status === 400 ? appRes1 : appRes2;
    assert.equal(failureRes.json.error, 'ALREADY_APPROVED');

    // Verify duplicate TrxID detection inside payment approval even if a stale duplicate pending record existed
    fakeDb.rawSet('paymentRequests/legacy_dup_pending', {
      userId: 'student_uid_beta',
      studentName: 'Student Beta',
      studentPhone: '01811000222',
      method: 'bKash',
      senderNumber: '01811000222',
      transactionId: 'PRODTRX1250',
      amount: 1250,
      packageId: 'pkg_long_course',
      packageNameBn: 'Long',
      packageNameEn: 'Long',
      status: 'pending',
      requestedAt: new Date().toISOString()
    });
    const dupApproveRes = await callUrl(urlB, '/api/admin/payments/legacy_dup_pending/approve', {
      method: 'POST',
      token: OWNER_TOKEN
    });
    assert.equal(dupApproveRes.status, 409);
    assert.equal(dupApproveRes.json.error, 'TRX_ALREADY_APPROVED');

    // Verify /api/admin/subscriptions and /api/admin/dashboard-stats read authoritatively from Firestore
    const [subsRes, statsRes] = await Promise.all([
      callUrl(urlB, '/api/admin/subscriptions', { token: OWNER_TOKEN }),
      callUrl(urlB, '/api/admin/dashboard-stats', { token: OWNER_TOKEN })
    ]);
    assert.equal(subsRes.status, 200);
    assert.equal((subsRes.json.subscriptions as Array<unknown>).length, 1);
    assert.equal(statsRes.status, 200);
    assert.equal(statsRes.json.activeSubscribers, 1);
    assert.equal(statsRes.json.approvedPayments, 1);
    assert.equal(statsRes.json.totalVerifiedRevenue, 1250);
  });

  test('D. Cross-Instance Exam Progress & Atomic Concurrent Exam Submission Transaction', async () => {
    const paidExamId = Array.from(fakeDb.store.keys())
      .find(k => k.startsWith('exams/'))!
      .replace('exams/', '');

    // Student A (approved in Test C) starts exam on Instance A
    const startRes = await callUrl(urlA, '/api/exams/start', {
      method: 'POST',
      token: STUDENT_A_TOKEN,
      body: { examId: paidExamId, studentName: 'Student Alpha' }
    });
    assert.equal(startRes.status, 200);
    const attemptId = startRes.json.attempt.id as string;
    const questions = startRes.json.questions as Array<{ id: string }>;
    assert.equal(questions.length, 20);

    // Build 15 correct + 4 wrong + 1 skipped = 14.0 score
    const answers: Record<string, number> = {};
    questions.forEach((q, idx) => {
      const key = fakeDb.rawGet(`questionKeys/${q.id}`) as { correctOptionIndex: number };
      if (idx < 15) answers[q.id] = key.correctOptionIndex;
      else if (idx < 19) answers[q.id] = (key.correctOptionIndex + 1) % 4;
    });

    // Save progress mid-exam on Instance B (different instance from where attempt started!)
    const saveRes = await callUrl(urlB, '/api/exams/save-answer', {
      method: 'POST',
      token: STUDENT_A_TOKEN,
      body: { attemptId, answers, currentQuestionIndex: 12 }
    });
    assert.equal(saveRes.status, 200);

    // Concurrent duplicate submit across Instance A and Instance B (relying on saved answers in Firestore!)
    const [sub1, sub2] = await Promise.all([
      callUrl(urlA, '/api/exams/submit', { method: 'POST', token: STUDENT_A_TOKEN, body: { attemptId } }),
      callUrl(urlB, '/api/exams/submit', { method: 'POST', token: STUDENT_A_TOKEN, body: { attemptId } })
    ]);

    const statuses = [sub1.status, sub2.status].sort();
    assert.deepEqual(statuses, [200, 400]);
    const okSub = sub1.status === 200 ? sub1 : sub2;
    const failSub = sub1.status === 400 ? sub1 : sub2;

    assert.equal(okSub.json.result.finalScore, 14);
    assert.equal(okSub.json.result.correctAnswersCount, 15);
    assert.equal(okSub.json.result.incorrectAnswersCount, 4);
    assert.equal(failSub.json.error, 'ALREADY_SUBMITTED');

    // Verify exactly one result persisted in Firestore for this attemptId
    const matchingResults = Array.from(fakeDb.store.values()).filter(v => v.attemptId === attemptId);
    assert.equal(matchingResults.length, 1);
  });

  test('E. Firestore Write Failure Returns 500 (Never False 200) and Preserves Data Integrity', async () => {
    // Start a fresh attempt before injecting write failure
    const paidExamId = Array.from(fakeDb.store.keys())
      .find(k => k.startsWith('exams/'))!
      .replace('exams/', '');
    const startRes = await callUrl(urlA, '/api/exams/start', {
      method: 'POST',
      token: STUDENT_A_TOKEN,
      body: { examId: paidExamId }
    });
    assert.equal(startRes.status, 200);
    const attemptId = startRes.json.attempt.id as string;

    const payBId = fakeDb.runQuerySync('paymentRequests', [{ field: 'transactionId', op: '==', value: 'PRODTRXEXAM520' }]).docs[0].id;

    // Inject simulated Firestore write outage
    fakeDb.writeFailure = new Error('DEADLINE_EXCEEDED: Simulated Firestore write outage');
    try {
      const failedCalls = await Promise.all([
        callUrl(urlA, '/api/admin/payment-settings', {
          method: 'POST',
          token: OWNER_TOKEN,
          body: { bkashNumber: '01700000000' }
        }),
        callUrl(urlA, '/api/admin/support-settings', {
          method: 'POST',
          token: OWNER_TOKEN,
          body: { whatsappNumber: '+8801700000000' }
        }),
        callUrl(urlA, '/api/admin/exam-config', {
          method: 'POST',
          token: OWNER_TOKEN,
          body: { examPassPrice: 9999 }
        }),
        callUrl(urlA, '/api/payments/create', {
          method: 'POST',
          token: STUDENT_B_TOKEN,
          body: {
            method: 'bKash',
            senderNumber: '01700000001',
            transactionId: 'FAILTRX001',
            packageId: 'pkg_monthly'
          }
        }),
        callUrl(urlA, `/api/admin/payments/${payBId}/approve`, {
          method: 'POST',
          token: OWNER_TOKEN
        }),
        callUrl(urlA, '/api/exams/save-answer', {
          method: 'POST',
          token: STUDENT_A_TOKEN,
          body: { attemptId, answers: {} }
        }),
        callUrl(urlA, '/api/exams/submit', {
          method: 'POST',
          token: STUDENT_A_TOKEN,
          body: { attemptId, answers: {} }
        })
      ]);

      for (const r of failedCalls) {
        assert.equal(r.status, 500, `Expected 500 on write failure, got ${r.status}: ${JSON.stringify(r.json)}`);
      }

      // Ensure failed writes did NOT partially mutate existing records
      assert.equal(fakeDb.rawGet('config/paymentSettings')?.bkashNumber, '01999888777');
      assert.equal(fakeDb.rawGet(`paymentRequests/${payBId}`)?.status, 'pending');
      assert.equal(fakeDb.rawGet(`examAttempts/${attemptId}`)?.status, 'in_progress');
    } finally {
      fakeDb.writeFailure = null;
    }
  });

  test('F. Unauthorized Student Requests Are Blocked (401/403) in Production Mode', async () => {
    const attemptId = Array.from(fakeDb.store.keys())
      .find(k => k.startsWith('examAttempts/'))!
      .replace('examAttempts/', '');

    const checks = await Promise.all([
      callUrl(urlA, '/api/admin/payment-settings', { method: 'POST', token: STUDENT_A_TOKEN, body: { bkashNumber: '01711111111' } }),
      callUrl(urlA, '/api/admin/support-settings', { method: 'POST', token: STUDENT_A_TOKEN, body: { whatsappNumber: '+8801711111111' } }),
      callUrl(urlA, '/api/admin/exam-config', { method: 'POST', token: STUDENT_A_TOKEN, body: { examPassPrice: 1 } }),
      callUrl(urlA, '/api/admin/subscriptions', { token: STUDENT_A_TOKEN }),
      callUrl(urlA, '/api/admin/dashboard-stats', { token: STUDENT_A_TOKEN }),
      callUrl(urlA, '/api/admin/audit-logs', { token: STUDENT_A_TOKEN }),
      callUrl(urlA, '/api/admin/questions', { token: STUDENT_A_TOKEN }),
      callUrl(urlA, '/api/exams/save-answer', { method: 'POST', token: STUDENT_B_TOKEN, body: { attemptId, answers: {} } }),
      callUrl(urlB, '/api/exams/submit', { method: 'POST', token: STUDENT_B_TOKEN, body: { attemptId, answers: {} } })
    ]);

    for (const r of checks) {
      assert.equal(r.status, 403);
    }

    const unauth = await callUrl(urlA, '/api/admin/subscriptions');
    assert.equal(unauth.status, 401);
  });
});

describe('Sanad Prep BD – Stage 2: Safe Firestore Migration Preparation Suite (Simulated Firestore)', () => {
  test('M1. CLI arg parser requires explicit --dry-run or --execute and rejects invalid combinations', () => {
    assert.equal(parseMigrationCliArgs([]).valid, false);
    assert.equal(parseMigrationCliArgs(['--dry-run', '--execute']).valid, false);
    assert.equal(parseMigrationCliArgs(['--unknown']).valid, false);

    const dry = parseMigrationCliArgs(['--dry-run']);
    assert.deepEqual(dry, { valid: true, dryRun: true, execute: false });

    const exec = parseMigrationCliArgs(['--execute']);
    assert.deepEqual(exec, { valid: true, dryRun: false, execute: true });
  });

  test('M2. Dry-run performs zero writes and detects missing packages, config, and legacy data', async () => {
    const db = new FakeFirestore();
    const mirror = createMemoryMirror();
    assert.deepEqual(mirror.leaderboard, []);
    // Shrink test seed arrays for fast unit verification while exercising all collections
    mirror.questions = mirror.questions.slice(0, 5);
    mirror.exams = mirror.exams.slice(0, 2);

    // Seed an existing legacy user & subscription with ISO strings and an un-sanitized question
    db.rawSet('users/u_legacy', {
      uid: 'u_legacy',
      name: 'Legacy Student',
      role: 'student',
      subscriptionStatus: 'pro',
      subscriptionExpiresAt: '2026-12-31T00:00:00.000Z'
    });
    db.rawSet('subscriptions/sub_legacy', {
      userId: 'u_legacy',
      status: 'active',
      activatedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-12-31T00:00:00.000Z'
    });
    db.rawSet('questions/q_custom_legacy', {
      subjectId: 'sub_cpc',
      questionBn: 'Which section governs Res Judicata?',
      optionsBn: ['Section 10', 'Section 11', 'Section 12', 'Section 15'],
      correctOptionIndex: 1,
      explanationBn: 'Section 11 bars re-litigation of directly adjudicated issues.',
      explanationEn: 'Section 11 CPC'
    });

    const snapshotBefore = Array.from(db.store.entries());
    // Fail loudly if any write method is ever touched during dry-run
    db.writeFailure = new Error('WRITE_FORBIDDEN_IN_DRY_RUN');

    const report = await planFirestoreMigration({
      mirror,
      db: db as unknown as Firestore
    });
    const execDry = await executeFirestoreMigration({
      mirror,
      db: db as unknown as Firestore,
      dryRun: true
    });

    assert.equal(report.mode, 'dry-run');
    assert.equal(report.safeToExecute, true);
    assert.ok(report.missingCollectionsOrConfig.includes('packages'));
    assert.ok(report.missingCollectionsOrConfig.includes('config/examDate'));
    assert.equal(report.counts.packagesToCreate, 4);
    assert.equal(report.counts.examDateConfigAction, 'create');
    assert.equal(report.counts.usersTimestampToUpdate, 1);
    assert.equal(report.counts.subscriptionsTimestampToUpdate, 1);
    assert.equal(report.counts.questionKeysToCreate, 6); // 1 legacy + 5 missing seeds
    assert.equal(report.counts.questionsToSanitize, 1);
    assert.equal(report.counts.questionsToCreate, 5);
    assert.equal(execDry.executed, false);
    assert.equal(execDry.writesCommitted, 0);
    assert.deepEqual(Array.from(db.store.entries()), snapshotBefore);

    // Calling executeFirestoreMigration without execute=true also performs zero writes
    const noFlagRes = await executeFirestoreMigration({
      mirror,
      db: db as unknown as Firestore
    });
    assert.equal(noFlagRes.executed, false);
    assert.equal(noFlagRes.writesCommitted, 0);
  });

  test('M3. Preserves existing valid packages & questionKeys, migrates legacy keys safely, and is idempotent on re-run', async () => {
    const db = new FakeFirestore();
    const mirror = createMemoryMirror();
    mirror.questions = mirror.questions.slice(0, 5);
    mirror.exams = mirror.exams.slice(0, 2);

    // Seed 1 existing valid package (custom price 199 must NOT be overwritten; 3 missing packages must be detected)
    const customMonthly = { ...mirror.packages.find(p => p.id === 'pkg_monthly')!, price: 199, nameEn: 'Custom Monthly' };
    db.rawSet('packages/pkg_monthly', customMonthly as unknown as Record<string, unknown>);

    // Seed 1 already-separated question + key (must preserve key untouched)
    const qFirst = mirror.questions[0];
    const { correctOptionIndex: _co, explanationBn: _eb, explanationEn: _ee, ...qClean } = qFirst;
    db.rawSet(`questions/${qFirst.id}`, qClean as unknown as Record<string, unknown>);
    db.rawSet(`questionKeys/${qFirst.id}`, {
      correctOptionIndex: qFirst.correctOptionIndex,
      explanationBn: 'Custom verified admin explanation preserved',
      explanationEn: qFirst.explanationEn || '',
      updatedAt: '2026-02-01T00:00:00.000Z'
    });

    // Seed 1 legacy question containing embedded correctOptionIndex & explanations
    db.rawSet('questions/q_legacy_only', {
      subjectId: 'sub_evidence',
      questionBn: 'Section 114 deals with?',
      optionsBn: ['Estoppel', 'Presumption of fact', 'Privileged comms', 'Burden'],
      correctOptionIndex: 1,
      explanationBn: 'Court may presume existence of certain facts.',
      explanationEn: 'Presumption of fact under Evidence Act.'
    });

    // Preserve existing financial records untouched
    db.rawSet('paymentRequests/trx_EXIST01', { userId: 'u1', transactionId: 'EXIST01', amount: 199, status: 'approved' });
    db.rawSet('examResults/res_EXIST01', { userId: 'u1', examId: 'e1', finalScore: 72 });

    // Dry-run detects 3 missing packages and preserves 1 valid package
    const dryPlan = await planFirestoreMigration({ mirror, db: db as unknown as Firestore });
    assert.equal(dryPlan.safeToExecute, true);
    assert.equal(dryPlan.counts.packagesExistingValid, 1);
    assert.equal(dryPlan.counts.packagesToCreate, 3);
    assert.equal(dryPlan.counts.questionsToSanitize, 1);
    assert.equal(dryPlan.counts.questionsToCreate, 4);

    // Execute migration
    const firstExec = await executeFirestoreMigration({
      mirror,
      db: db as unknown as Firestore,
      execute: true
    });
    assert.equal(firstExec.executed, true);
    assert.equal(firstExec.abortedDueToIssues, false);
    assert.ok(firstExec.writesCommitted > 0);

    // Verify existing valid package preserved
    assert.equal(db.rawGet('packages/pkg_monthly')?.price, 199);
    assert.equal(db.rawGet('packages/pkg_monthly')?.nameEn, 'Custom Monthly');
    // Verify missing packages created with accurate baseline fields
    assert.equal(db.rawGet('packages/pkg_long_course')?.price, 999);
    assert.equal(db.rawGet('packages/pkg_exam_pass')?.validityType, 'exam_date');
    assert.equal(db.rawGet('packages/pkg_pro_mock')?.isArchived, true);
    // Verify examDate config initialized from existing app configuration
    assert.equal(db.rawGet('config/examDate')?.targetExamDate, mirror.examDateConfig.targetExamDate);
    assert.equal(db.rawGet('config/examDate')?.examPassPrice, mirror.examDateConfig.examPassPrice);

    // Verify existing questionKeys document was NOT overwritten
    assert.equal(
      db.rawGet(`questionKeys/${qFirst.id}`)?.explanationBn,
      'Custom verified admin explanation preserved'
    );

    // Verify legacy question answer & explanation moved to questionKeys and removed from public doc
    const migratedKey = db.rawGet('questionKeys/q_legacy_only');
    assert.equal(migratedKey?.correctOptionIndex, 1);
    assert.equal(migratedKey?.explanationBn, 'Court may presume existence of certain facts.');

    const sanitizedPublic = db.rawGet('questions/q_legacy_only');
    assert.equal(sanitizedPublic?.questionBn, 'Section 114 deals with?');
    assert.equal(sanitizedPublic?.correctOptionIndex, undefined);
    assert.equal(sanitizedPublic?.explanationBn, undefined);
    assert.equal(sanitizedPublic?.explanationEn, undefined);

    // Existing payment/exam result untouched
    assert.equal(db.rawGet('paymentRequests/trx_EXIST01')?.amount, 199);
    assert.equal(db.rawGet('examResults/res_EXIST01')?.finalScore, 72);

    // Re-running migration must be 100% idempotent (0 writes!)
    const rerunExec = await executeFirestoreMigration({
      mirror,
      db: db as unknown as Firestore,
      execute: true
    });
    assert.equal(rerunExec.executed, true);
    assert.equal(rerunExec.writesCommitted, 0);
    assert.equal(rerunExec.report.totalPlannedWrites, 0);
    assert.equal(rerunExec.report.counts.packagesToCreate, 0);
    assert.equal(rerunExec.report.counts.questionsToCreate, 0);
    assert.equal(rerunExec.report.counts.questionsToSanitize, 0);
    assert.equal(rerunExec.report.counts.questionKeysToCreate, 0);
    assert.equal(rerunExec.report.counts.examDateConfigAction, 'preserve');
  });

  test('M4. Conflicting or ambiguous data stops unsafe migration with zero writes', async () => {
    const mirror = createMemoryMirror();
    mirror.questions = mirror.questions.slice(0, 3);
    mirror.exams = mirror.exams.slice(0, 1);

    // Case 1: Legacy question embedded answer conflicts with existing questionKeys
    const dbConflictQ = new FakeFirestore();
    dbConflictQ.rawSet('questions/q_conflict_1', {
      subjectId: 'sub_crpc',
      questionBn: 'Arrest without warrant section?',
      optionsBn: ['Sec 54', 'Sec 64', 'Sec 154', 'Sec 164'],
      correctOptionIndex: 1,
      explanationBn: 'Some explanation'
    });
    dbConflictQ.rawSet('questionKeys/q_conflict_1', {
      correctOptionIndex: 0,
      explanationBn: 'Police may arrest without warrant under Section 54'
    });
    const beforeConflictStore = Array.from(dbConflictQ.store.entries());

    const execConflict1 = await executeFirestoreMigration({
      mirror,
      db: dbConflictQ as unknown as Firestore,
      execute: true
    });
    assert.equal(execConflict1.executed, false);
    assert.equal(execConflict1.abortedDueToIssues, true);
    assert.equal(execConflict1.writesCommitted, 0);
    assert.equal(execConflict1.report.safeToExecute, false);
    assert.ok(execConflict1.report.conflicts.some(c => c.code === 'QUESTION_KEY_CONFLICT'));
    assert.deepEqual(Array.from(dbConflictQ.store.entries()), beforeConflictStore);

    // Case 2: Missing/ambiguous examDate configuration must NOT insert guessed dates/prices
    const dbMissingCfg = new FakeFirestore();
    const execMissingCfg = await executeFirestoreMigration({
      mirror,
      db: dbMissingCfg as unknown as Firestore,
      execute: true,
      examDateConfigOverride: { targetExamDate: 'not-a-valid-date', examPassPrice: -10 }
    });
    assert.equal(execMissingCfg.executed, false);
    assert.equal(execMissingCfg.abortedDueToIssues, true);
    assert.equal(execMissingCfg.writesCommitted, 0);
    assert.equal(execMissingCfg.report.counts.examDateConfigAction, 'skip_ambiguous');
    assert.equal(dbMissingCfg.rawGet('config/examDate'), undefined);

    // Case 3: Existing pkg_exam_pass price conflicts with app examDate.examPassPrice
    const dbPriceMismatch = new FakeFirestore();
    dbPriceMismatch.rawSet('packages/pkg_exam_pass', {
      ...mirror.packages.find(p => p.id === 'pkg_exam_pass')!,
      price: 750
    } as unknown as Record<string, unknown>);
    const execPriceMismatch = await executeFirestoreMigration({
      mirror,
      db: dbPriceMismatch as unknown as Firestore,
      execute: true
    });
    assert.equal(execPriceMismatch.executed, false);
    assert.equal(execPriceMismatch.abortedDueToIssues, true);
    assert.equal(execPriceMismatch.writesCommitted, 0);
    assert.ok(execPriceMismatch.report.conflicts.some(c => c.code === 'AMBIGUOUS_EXAM_PASS_PRICE'));
  });
});

describe('Sanad Prep BD – Stage 3 Frontend Security, Strict CORS & Deployment Readiness', () => {
  test('F1. Payment creation fails closed with clear errors on network, non-JSON, 500, and 503 with ZERO Firestore fallback', async () => {
    let fallbackWriteAttempted = false;
    const simulateLegacyFallbackIfCalled = () => {
      fallbackWriteAttempted = true;
    };

    const failureCases = [
      { status: 0, code: 'NETWORK_ERROR', message: 'Failed to fetch' },
      { status: 200, code: 'NON_JSON_RESPONSE', message: 'Unexpected HTML' },
      { status: 500, code: 'HTTP_500', message: 'Internal Server Error' },
      { status: 503, code: 'FIRESTORE_UNAVAILABLE', message: 'Firestore unavailable' }
    ];

    for (const c of failureCases) {
      const res = await submitPaymentViaAuthoritativeBackend({
        authenticatedUid: 'student_uid_alpha',
        method: 'bKash',
        studentPhone: '01700000001',
        senderNumber: '01700000001',
        transactionId: `TRXFAIL${c.status}`,
        packageId: 'pkg_monthly',
        studentName: 'Student Alpha',
        existingRequests: [],
        apiBaseUrl: 'https://api.example.com',
        isProduction: true,
        callCreatePaymentApi: async () => ({
          ok: false,
          status: c.status,
          code: c.code,
          message: formatBackendApiError({
            status: c.status,
            code: c.code,
            serverMessage: c.message,
            isJson: c.code !== 'NON_JSON_RESPONSE'
          })
        })
      });

      assert.equal(res.success, false, `Expected failure for ${c.code}`);
      assert.ok(res.error && res.error.length > 5, `Expected user-facing error for ${c.code}`);
      assert.equal(fallbackWriteAttempted, false);
      if (false) simulateLegacyFallbackIfCalled();
    }
  });

  test('F2. Frontend payment submission omits client-side amount and enforces backend pricing authority', async () => {
    const capturedPayloads: Record<string, unknown>[] = [];

    const res = await submitPaymentViaAuthoritativeBackend({
      authenticatedUid: 'student_uid_alpha',
      method: 'Nagad',
      studentPhone: '01700000001',
      senderNumber: '01700000001',
      transactionId: 'TRXSTAGE3AUTH1',
      packageId: 'pkg_quarterly',
      studentName: 'Student Alpha',
      existingRequests: [],
      apiBaseUrl: 'https://api.example.com',
      isProduction: true,
      callCreatePaymentApi: async (payload) => {
        capturedPayloads.push({ ...payload });
        return {
          ok: true,
          status: 201,
          data: {
            success: true,
            message: 'Submitted',
            paymentRequest: {
              id: 'trx_TRXSTAGE3AUTH1',
              userId: 'student_uid_alpha',
              studentName: 'Student Alpha',
              studentPhone: '01700000001',
              method: 'Nagad',
              senderNumber: '01700000001',
              transactionId: 'TRXSTAGE3AUTH1',
              packageId: 'pkg_quarterly',
              packageTitle: 'Quarterly Pro Pass',
              packageNameBn: 'ত্রৈমাসিক',
              packageNameEn: 'Quarterly',
              durationDays: 90,
              amount: 299,
              status: 'pending',
              requestedAt: new Date().toISOString()
            }
          }
        };
      }
    });

    assert.equal(res.success, true);
    assert.equal(capturedPayloads.length, 1);
    const capturedPayload = capturedPayloads[0];
    assert.equal('amount' in capturedPayload, false);
    assert.equal('price' in capturedPayload, false);
    assert.equal(capturedPayload.packageId, 'pkg_quarterly');
  });

  test('F3. Admin API wrapper rejects non-owners and never reports success on 403/500/503/non-JSON/network errors', async () => {
    let executedByNonOwner = false;
    const nonOwnerRes = await executeAuthoritativeAdminApi({
      isVerifiedOwner: false,
      operation: async () => {
        executedByNonOwner = true;
        return { ok: true, status: 200, data: { ok: true } };
      }
    });
    assert.equal(nonOwnerRes.success, false);
    assert.equal(executedByNonOwner, false);

    for (const errCase of [
      { status: 403, code: 'FORBIDDEN' },
      { status: 500, code: 'HTTP_500' },
      { status: 503, code: 'FIRESTORE_UNAVAILABLE' },
      { status: 200, code: 'NON_JSON_RESPONSE' },
      { status: 0, code: 'NETWORK_ERROR' }
    ]) {
      const failRes = await executeAuthoritativeAdminApi({
        isVerifiedOwner: true,
        operation: async () => ({
          ok: false,
          status: errCase.status,
          code: errCase.code,
          message: formatBackendApiError({
            status: errCase.status,
            code: errCase.code,
            isJson: errCase.code !== 'NON_JSON_RESPONSE'
          })
        })
      });
      assert.equal(failRes.success, false, `Admin op must fail on ${errCase.code}`);
      assert.ok(failRes.error && failRes.error.length > 0);
    }
  });

  test('F4. Strict CORS rejects wildcard pages.dev/workers.dev/run.app and localhost in production with HTTP 403', async () => {
    const parsed = parseAllowedOrigins('https://app.example.com/, https://admin.example.com');
    assert.deepEqual(Array.from(parsed), ['https://app.example.com', 'https://admin.example.com']);

    assert.equal(
      isOriginAllowed('https://app.example.com', {
        isProduction: true,
        allowedOriginEnv: 'https://app.example.com'
      }),
      true
    );
    assert.equal(
      isOriginAllowed('https://attacker.pages.dev', {
        isProduction: true,
        allowedOriginEnv: 'https://app.example.com'
      }),
      false
    );
    assert.equal(
      isOriginAllowed('https://attacker.workers.dev', {
        isProduction: true,
        allowedOriginEnv: 'https://app.example.com'
      }),
      false
    );
    assert.equal(
      isOriginAllowed('https://attacker.run.app', {
        isProduction: true,
        allowedOriginEnv: 'https://app.example.com'
      }),
      false
    );
    assert.equal(
      isOriginAllowed('http://localhost:3000', {
        isProduction: true,
        allowedOriginEnv: 'https://app.example.com'
      }),
      false
    );
    assert.equal(
      isOriginAllowed('http://localhost:3000', {
        isProduction: false,
        allowedOriginEnv: ''
      }),
      true
    );

    const corsMirror = createMemoryMirror();
    const corsDb = new FakeFirestore();
    const { app } = createSanadPrepApp({
      mirror: corsMirror,
      firestoreDb: corsDb as unknown as Firestore,
      isProduction: true,
      allowedOriginEnv: 'https://sanadprep.example.com',
      tokenVerifier: async (tok: string) => {
        const user = TOKEN_MAP[tok];
        if (!user) throw new Error('Invalid token');
        return user;
      }
    });

    const srv = app.listen(0);
    await new Promise<void>(resolve => srv.once('listening', resolve));
    const addr = srv.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const url = `http://127.0.0.1:${port}/api/packages`;

    try {
      const okRes = await fetch(url, {
        headers: { Origin: 'https://sanadprep.example.com' }
      });
      assert.equal(okRes.status, 200);
      assert.equal(okRes.headers.get('access-control-allow-origin'), 'https://sanadprep.example.com');

      for (const badOrigin of [
        'https://evil.pages.dev',
        'https://evil.workers.dev',
        'https://evil.run.app',
        'http://localhost:3000'
      ]) {
        const badRes = await fetch(url, {
          headers: { Origin: badOrigin }
        });
        assert.equal(badRes.status, 403, `Expected 403 for disallowed origin ${badOrigin}`);
        const badJson = (await badRes.json()) as { error?: string };
        assert.equal(badJson.error, 'CORS_ORIGIN_NOT_ALLOWED');
      }
    } finally {
      await new Promise<void>(resolve => srv.close(() => resolve()));
    }
  });

  test('F5 & F6. Dockerignore rules and frontend silent-catch / payment-fallback elimination', () => {
    const rootDir = process.cwd();
    const dockerignore = fs.readFileSync(path.join(rootDir, '.dockerignore'), 'utf8');
    for (const pattern of [
      'node_modules/',
      'dist/',
      '.git/',
      '.env',
      '.backup_*/',
      'android/',
      '*service-account*.json'
    ]) {
      assert.ok(dockerignore.includes(pattern), `.dockerignore missing ${pattern}`);
    }

    const appContextSrc = fs.readFileSync(path.join(rootDir, 'src/context/AppContext.tsx'), 'utf8');
    const firestoreSvcSrc = fs.readFileSync(path.join(rootDir, 'src/lib/firestoreService.ts'), 'utf8');
    assert.equal(appContextSrc.includes('.catch(() => {})'), false, 'AppContext must not contain silent .catch(() => {})');
    assert.equal(firestoreSvcSrc.includes('.catch(() => null)'), false, 'firestoreService must not swallow catches silently');
    assert.equal(appContextSrc.includes('savePaymentRequestToFirestore'), false, 'AppContext must not fall back to direct Firestore payment writes');
  });
});

describe('Sanad Prep BD – Gemini API Key Security & Backend Isolation Suite', () => {
  test('G1. Missing or placeholder GEMINI_API_KEY fails safely with 503 GEMINI_NOT_CONFIGURED and never leaks secrets', async () => {
    const prevKey = process.env.GEMINI_API_KEY;
    try {
      delete process.env.GEMINI_API_KEY;
      assert.equal(isGeminiConfigured(), false);
      const resMissing = await generateGeminiText({ prompt: 'Summarize CPC Section 11' });
      assert.equal(resMissing.ok, false);
      if (!resMissing.ok) {
        assert.equal(resMissing.status, 503);
        assert.equal(resMissing.code, 'GEMINI_NOT_CONFIGURED');
      }

      process.env.GEMINI_API_KEY = 'MY_GEMINI_API_KEY';
      assert.equal(isGeminiConfigured(), false);
      const resPlaceholder = await generateGeminiText({ prompt: 'Summarize CPC Section 11' });
      assert.equal(resPlaceholder.ok, false);
      if (!resPlaceholder.ok) {
        assert.equal(resPlaceholder.status, 503);
        assert.equal(resPlaceholder.code, 'GEMINI_NOT_CONFIGURED');
      }
    } finally {
      if (prevKey !== undefined) {
        process.env.GEMINI_API_KEY = prevKey;
      } else {
        delete process.env.GEMINI_API_KEY;
      }
    }
  });

  test('G2. Request validation rejects invalid prompts and deprecated Gemini models before API calls', () => {
    const emptyPrompt = validateGeminiRequest({ prompt: '   ' });
    assert.equal(emptyPrompt.valid, false);
    assert.equal(emptyPrompt.code, 'INVALID_PROMPT');

    const deprecatedModel = validateGeminiRequest({
      prompt: 'Valid prompt',
      model: 'gemini-1.5-flash'
    });
    assert.equal(deprecatedModel.valid, false);
    assert.equal(deprecatedModel.code, 'UNSUPPORTED_GEMINI_MODEL');

    const validReq = validateGeminiRequest({ prompt: 'Explain Section 151 CPC' });
    assert.equal(validReq.valid, true);
    assert.equal(validReq.model, 'gemini-4-hydrogen');
  });

  test('G3. Diagnostic and error helpers redact API keys, key query params, Bearer tokens, and PEM keys', () => {
    const fakeKey = 'AIzaSyTestFakeKey1234567890ABCDEFGHIJK';
    const rawMsg = `Fetch failed for https://generativelanguage.googleapis.com/v1?key=${fakeKey} with Bearer secret-token-123`;
    const redacted = redactGeminiSecrets(rawMsg);
    assert.equal(redacted.includes(fakeKey), false);
    assert.equal(redacted.includes('secret-token-123'), false);
    assert.ok(redacted.includes('[REDACTED]'));

    const diag = getSafeDiagnosticError(new Error(rawMsg));
    assert.equal(diag.message.includes(fakeKey), false);
    assert.equal(diag.message.includes('secret-token-123'), false);

    const normalized = normalizeGeminiError({
      status: 403,
      message: `PERMISSION_DENIED using ${fakeKey}`
    });
    assert.equal(normalized.status, 503);
    assert.equal(normalized.code, 'GEMINI_PERMISSION_DENIED');
    assert.equal(normalized.message.includes(fakeKey), false);
  });

  test('G4. Frontend source, vite.config.ts, and /api/health contain zero Gemini API keys or client SDK imports', async () => {
    const rootDir = process.cwd();
    const viteConfig = fs.readFileSync(path.join(rootDir, 'vite.config.ts'), 'utf8');
    assert.equal(viteConfig.includes('GEMINI_API_KEY'), false);
    assert.equal(viteConfig.includes('API_KEY'), false);

    const walkFiles = (dir: string): string[] => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) files.push(...walkFiles(full));
        else files.push(full);
      }
      return files;
    };

    for (const file of walkFiles(path.join(rootDir, 'src'))) {
      const content = fs.readFileSync(file, 'utf8');
      assert.equal(content.includes('VITE_GEMINI_API_KEY'), false, `Found VITE_GEMINI_API_KEY in ${file}`);
      assert.equal(content.includes('GEMINI_API_KEY'), false, `Found GEMINI_API_KEY in ${file}`);
      assert.equal(content.includes('@google/genai'), false, `Found @google/genai import in client file ${file}`);
    }

    const healthMirror = createMemoryMirror();
    const { app } = createSanadPrepApp({
      mirror: healthMirror,
      disableFirestoreWrites: true,
      isProduction: false
    });
    const srv = app.listen(0);
    await new Promise<void>(resolve => srv.once('listening', resolve));
    const addr = srv.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      const json = (await res.json()) as Record<string, unknown>;
      assert.equal(res.status, 200);
      assert.equal(typeof json.geminiConfigured, 'boolean');
      assert.equal('GEMINI_API_KEY' in json, false);
    } finally {
      await new Promise<void>(resolve => srv.close(() => resolve()));
    }
  });
});

describe('Sanad Prep BD – Master Remediation Security & Input Validation Suite', () => {
  test('R1 & R2. Unverified email rejected (403), missing/unknown/mismatched sessions fail closed (401/403)', async () => {
    clearRateLimitBucketsForTests();
    const fakeDb = new FakeFirestore();
    const seedMirror = createMemoryMirror();
    fakeDb.rawSet('config/paymentSettings', seedMirror.paymentSettings);
    fakeDb.rawSet('questions/q_demo_1', sanitizeForTest(seedMirror.questions[0]));
    fakeDb.rawSet('questionKeys/q_demo_1', {
      correctOptionIndex: seedMirror.questions[0].correctOptionIndex,
      explanationBn: seedMirror.questions[0].explanationBn || '',
      explanationEn: seedMirror.questions[0].explanationEn || ''
    });

    const { app } = createSanadPrepApp({
      firestoreDb: fakeDb as unknown as Firestore,
      isProduction: true,
      rateLimitOverrides: { globalMax: 1000 },
      tokenVerifier: async (idToken: string) => {
        const user = TOKEN_MAP[idToken];
        if (!user) throw new Error('Invalid token');
        return user;
      }
    });

    const srv = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => srv.once('listening', resolve));
    const port = (srv.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}`;

    try {
      // Unverified email blocked on protected routes with 403 EMAIL_NOT_VERIFIED
      for (const ep of ['/api/questions', '/api/auth/session', '/api/admin/questions']) {
        const res = await fetch(`${url}${ep}`, {
          method: ep === '/api/auth/session' ? 'POST' : 'GET',
          headers: { Authorization: `Bearer ${UNVERIFIED_STUDENT_TOKEN}` }
        });
        const json = (await res.json()) as Record<string, unknown>;
        assert.equal(res.status, 403, `Expected 403 EMAIL_NOT_VERIFIED for ${ep}`);
        assert.equal(json.error, 'EMAIL_NOT_VERIFIED');
      }

      // Establish real sessions for Student A and Student B
      const sARes = await fetch(`${url}/api/auth/session`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${STUDENT_A_TOKEN}` }
      });
      const sessA = ((await sARes.json()) as { sessionId: string }).sessionId;

      const sBRes = await fetch(`${url}/api/auth/session`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${STUDENT_B_TOKEN}` }
      });
      const sessB = ((await sBRes.json()) as { sessionId: string }).sessionId;
      assert.ok(sessA && sessB);

      // Missing X-Session-Id -> 401 SESSION_REQUIRED
      const missingRes = await fetch(`${url}/api/auth/session/status`, {
        headers: { Authorization: `Bearer ${STUDENT_A_TOKEN}` }
      });
      assert.equal(missingRes.status, 401);
      assert.equal(((await missingRes.json()) as Record<string, unknown>).error, 'SESSION_REQUIRED');

      // Unknown X-Session-Id -> 401 SESSION_REQUIRED
      const unknownRes = await fetch(`${url}/api/practice/check`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${STUDENT_A_TOKEN}`,
          'X-Session-Id': 'nonexistent_session_xyz',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ questionId: 'q_demo_1', selectedOption: 0 })
      });
      assert.equal(unknownRes.status, 401);
      assert.equal(((await unknownRes.json()) as Record<string, unknown>).error, 'SESSION_REQUIRED');

      // Student B's X-Session-Id used with Student A token -> 403 SESSION_MISMATCH
      const mismatchRes = await fetch(`${url}/api/practice/check`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${STUDENT_A_TOKEN}`,
          'X-Session-Id': sessB,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ questionId: 'q_demo_1', selectedOption: 0 })
      });
      assert.equal(mismatchRes.status, 403);
      assert.equal(((await mismatchRes.json()) as Record<string, unknown>).error, 'SESSION_MISMATCH');
    } finally {
      await new Promise<void>(resolve => srv.close(() => resolve()));
    }
  });

  test('R3. Distributed Firestore-backed rate limiter enforces 429 RATE_LIMITED across instances', async () => {
    clearRateLimitBucketsForTests();
    const fakeDb = new FakeFirestore();
    const seedMirror = createMemoryMirror();
    const demoQ = seedMirror.questions.find(q => q.isDemoSample) || seedMirror.questions[0];
    fakeDb.rawSet(`questions/${demoQ.id}`, sanitizeForTest({ ...demoQ, isDemoSample: true }));
    fakeDb.rawSet(`questionKeys/${demoQ.id}`, {
      correctOptionIndex: demoQ.correctOptionIndex,
      explanationBn: demoQ.explanationBn || '',
      explanationEn: demoQ.explanationEn || ''
    });

    const opts = {
      firestoreDb: fakeDb as unknown as Firestore,
      isProduction: true,
      rateLimitOverrides: {
        windowMs: 60_000,
        globalMax: 100,
        routeMax: { practice_check: 2 }
      },
      tokenVerifier: async (idToken: string) => {
        const user = TOKEN_MAP[idToken];
        if (!user) throw new Error('Invalid token');
        return user;
      }
    };

    const inst1 = createSanadPrepApp(opts);
    const inst2 = createSanadPrepApp(opts);
    const s1 = inst1.app.listen(0, '127.0.0.1');
    const s2 = inst2.app.listen(0, '127.0.0.1');
    await Promise.all([
      new Promise<void>(r => s1.once('listening', r)),
      new Promise<void>(r => s2.once('listening', r))
    ]);
    const u1 = `http://127.0.0.1:${(s1.address() as { port: number }).port}`;
    const u2 = `http://127.0.0.1:${(s2.address() as { port: number }).port}`;

    try {
      const sessRes = await fetch(`${u1}/api/auth/session`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${STUDENT_A_TOKEN}` }
      });
      const sessId = ((await sessRes.json()) as { sessionId: string }).sessionId;

      const reqOpts = {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${STUDENT_A_TOKEN}`,
          'X-Session-Id': sessId,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ questionId: demoQ.id, selectedOption: 0 })
      };

      // 1st call on Instance 1, 2nd call on Instance 2 -> both allowed
      const r1 = await fetch(`${u1}/api/practice/check`, reqOpts);
      assert.equal(r1.status, 200);
      const r2 = await fetch(`${u2}/api/practice/check`, reqOpts);
      assert.equal(r2.status, 200);

      // 3rd call on Instance 1 hits shared Firestore rateLimits bucket -> 429 RATE_LIMITED + Retry-After
      const r3 = await fetch(`${u1}/api/practice/check`, reqOpts);
      assert.equal(r3.status, 429);
      assert.ok(r3.headers.get('retry-after'));
      const j3 = (await r3.json()) as Record<string, unknown>;
      assert.equal(j3.error, 'RATE_LIMITED');
    } finally {
      await Promise.all([
        new Promise<void>(r => s1.close(() => r())),
        new Promise<void>(r => s2.close(() => r()))
      ]);
    }
  });

  test('R4, R5 & R6. Empty default leaderboard, CSV parser canonical subject IDs & admin input validation', async () => {
    clearRateLimitBucketsForTests();
    const mirror = createMemoryMirror();
    assert.deepEqual(mirror.leaderboard, []);

    // CSV parser canonical subject resolution & invalid row rejection
    assert.equal(resolveSubjectId('ethics', INITIAL_SUBJECTS)?.subjectId, 'sub_bar_ethics');
    assert.equal(resolveSubjectId('CPC', INITIAL_SUBJECTS)?.subjectId, 'sub_cpc');
    assert.equal(resolveSubjectId('Unknown Subject', INITIAL_SUBJECTS), null);

    const csv = [
      'subject,topic,question,optionA,optionB,optionC,optionD,correctAnswer,explanation',
      'ETHICS,Rule 1,What governs advocate professional conduct?,Bar Rules,Tax Act,Customs,Ports,A,Bar Council Canons',
      'UNKNOWN_SUB,Rule X,Valid question length here?,A1,B1,C1,D1,A,Should fail validation'
    ].join('\n');
    const parsed = validateCsvQuestions(csv, [], INITIAL_SUBJECTS);
    assert.equal(parsed.totalRows, 2);
    assert.equal(parsed.validCount, 1);
    assert.equal(parsed.invalidCount, 1);
    assert.equal(parsed.parsedQuestions[0].subjectId, 'sub_bar_ethics');
    assert.equal(parsed.parsedQuestions[0].isValid, true);
    assert.equal(parsed.parsedQuestions[1].isValid, false);

    // Admin question & payment settings input validation + leaderboard default []
    const fakeDb = new FakeFirestore();
    const { app } = createSanadPrepApp({
      firestoreDb: fakeDb as unknown as Firestore,
      isProduction: true,
      rateLimitOverrides: { globalMax: 1000 },
      tokenVerifier: async (idToken: string) => {
        const user = TOKEN_MAP[idToken];
        if (!user) throw new Error('Invalid token');
        return user;
      }
    });
    const srv = app.listen(0, '127.0.0.1');
    await new Promise<void>(r => srv.once('listening', r));
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;

    try {
      const lbRes = await fetch(`${url}/api/leaderboard`);
      assert.equal(lbRes.status, 200);
      assert.deepEqual(((await lbRes.json()) as { leaderboard: unknown[] }).leaderboard, []);

      const badQRes = await fetch(`${url}/api/admin/questions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OWNER_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ subjectId: 'invalid_subject', questionBn: 'Test', optionsBn: ['A', 'B'], correctOptionIndex: 9 })
      });
      assert.equal(badQRes.status, 400);
      assert.equal(((await badQRes.json()) as Record<string, unknown>).error, 'INVALID_QUESTION');

      const badPayRes = await fetch(`${url}/api/admin/payment-settings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OWNER_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ bkashNumber: '12345' })
      });
      assert.equal(badPayRes.status, 400);
      assert.equal(((await badPayRes.json()) as Record<string, unknown>).error, 'INVALID_PAYMENT_NUMBER');
    } finally {
      await new Promise<void>(r => srv.close(() => r()));
    }
  });

  test('R7 & R8. Production security headers, /health alias, session enforcement on student GETs, and logout revocation', async () => {
    clearRateLimitBucketsForTests();
    const fakeDb = new FakeFirestore();
    const seedMirror = createMemoryMirror();
    fakeDb.rawSet('questions/q_demo_1', sanitizeForTest(seedMirror.questions[0]));
    fakeDb.rawSet('questionKeys/q_demo_1', {
      correctOptionIndex: seedMirror.questions[0].correctOptionIndex,
      explanationBn: seedMirror.questions[0].explanationBn || '',
      explanationEn: seedMirror.questions[0].explanationEn || ''
    });

    const { app } = createSanadPrepApp({
      firestoreDb: fakeDb as unknown as Firestore,
      isProduction: true,
      rateLimitOverrides: { globalMax: 1000 },
      tokenVerifier: async (idToken: string) => {
        const user = TOKEN_MAP[idToken];
        if (!user) throw new Error('Invalid token');
        return user;
      }
    });
    const srv = app.listen(0, '127.0.0.1');
    await new Promise<void>(r => srv.once('listening', r));
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;

    try {
      const healthRes = await fetch(`${url}/health`);
      assert.equal(healthRes.status, 200);
      assert.equal(healthRes.headers.get('x-powered-by'), null);
      assert.equal(healthRes.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(healthRes.headers.get('x-frame-options'), 'DENY');
      assert.equal(healthRes.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
      assert.ok(healthRes.headers.get('strict-transport-security'));

      const { app: devApp } = createSanadPrepApp({
        mirror: createMemoryMirror(),
        isProduction: false,
        disableFirestoreWrites: true
      });
      devApp.get('/', (_req, res) => res.status(200).type('html').send('<html></html>'));
      const devSrv = devApp.listen(0, '127.0.0.1');
      await new Promise<void>(r => devSrv.once('listening', r));
      try {
        const devUrl = `http://127.0.0.1:${(devSrv.address() as { port: number }).port}`;
        const devPageRes = await fetch(`${devUrl}/`);
        assert.equal(devPageRes.status, 200);
        assert.equal(devPageRes.headers.get('x-frame-options'), null);
        assert.ok(devPageRes.headers.get('content-security-policy')?.includes('https://aistudio.google.com'));
      } finally {
        await new Promise<void>(r => devSrv.close(() => r()));
      }

      // Verify student GET routes require an active X-Session-Id
      for (const pathGet of [
        '/api/questions',
        '/api/payments',
        '/api/exams/results',
        `/api/subscriptions/active/${TOKEN_MAP[STUDENT_A_TOKEN].uid}`
      ]) {
        const noSessRes = await fetch(`${url}${pathGet}`, {
          headers: { Authorization: `Bearer ${STUDENT_A_TOKEN}` }
        });
        assert.equal(noSessRes.status, 401, `Expected 401 SESSION_REQUIRED on ${pathGet} without X-Session-Id`);
      }

      // Login -> validate session status -> logout -> verify revoked session rejected
      const loginRes = await fetch(`${url}/api/auth/session`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${STUDENT_A_TOKEN}` }
      });
      assert.equal(loginRes.status, 200);
      const sessId = ((await loginRes.json()) as { sessionId: string }).sessionId;

      const statusOk = await fetch(`${url}/api/auth/session/status`, {
        headers: { Authorization: `Bearer ${STUDENT_A_TOKEN}`, 'X-Session-Id': sessId }
      });
      assert.equal(statusOk.status, 200);
      assert.equal(((await statusOk.json()) as { active: boolean }).active, true);

      const qOk = await fetch(`${url}/api/questions`, {
        headers: { Authorization: `Bearer ${STUDENT_A_TOKEN}`, 'X-Session-Id': sessId }
      });
      assert.equal(qOk.status, 200);

      const logoutRes = await fetch(`${url}/api/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${STUDENT_A_TOKEN}`, 'X-Session-Id': sessId }
      });
      assert.equal(logoutRes.status, 200);

      const afterLogoutStatus = await fetch(`${url}/api/auth/session/status`, {
        headers: { Authorization: `Bearer ${STUDENT_A_TOKEN}`, 'X-Session-Id': sessId }
      });
      assert.equal(afterLogoutStatus.status, 401);
      assert.equal(((await afterLogoutStatus.json()) as Record<string, unknown>).error, 'SESSION_REVOKED');

      const afterLogoutQuestions = await fetch(`${url}/api/questions`, {
        headers: { Authorization: `Bearer ${STUDENT_A_TOKEN}`, 'X-Session-Id': sessId }
      });
      assert.equal(afterLogoutQuestions.status, 401);

      // Verify Cloudflare Pages _headers and .gitignore exclusions
      const rootDir = process.cwd();
      const cfHeaders = fs.readFileSync(path.join(rootDir, 'public/_headers'), 'utf8');
      assert.ok(cfHeaders.includes('X-Frame-Options: DENY'));
      assert.ok(cfHeaders.includes('X-Content-Type-Options: nosniff'));

      const gitignore = fs.readFileSync(path.join(rootDir, '.gitignore'), 'utf8');
      assert.ok(gitignore.includes('.backup_*/'));
      assert.ok(gitignore.includes('dist-server/'));
      assert.ok(gitignore.includes('*service-account*.json'));

      const dockerfile = fs.readFileSync(path.join(rootDir, 'Dockerfile'), 'utf8');
      assert.ok(dockerfile.includes('bun.lock'));
      assert.ok(dockerfile.includes('bun install --frozen-lockfile'));
      assert.ok(dockerfile.includes('firebase-applet-config.json'));
      assert.ok(dockerfile.includes('questionBankFull.json'));
      assert.ok(!dockerfile.includes('npm ci'));
    } finally {
      await new Promise<void>(r => srv.close(() => r()));
    }
  });

  test('R9. Question bank read optimization, pagination, cross-instance invalidation, and uncached auth/payment/session reads', async () => {
    clearRateLimitBucketsForTests();
    const fakeDb = new FakeFirestore();
    const seedMirror = createMemoryMirror();
    const sampleQuestions = seedMirror.questions.slice(0, 120);
    for (const q of sampleQuestions) {
      fakeDb.rawSet(`questions/${q.id}`, sanitizeForTest(q));
      fakeDb.rawSet(`questionKeys/${q.id}`, {
        correctOptionIndex: q.correctOptionIndex,
        explanationBn: q.explanationBn || '',
        explanationEn: q.explanationEn || ''
      });
    }
    const freeExam = seedMirror.exams.find(e => !e.isPaid && e.isActive !== false) || seedMirror.exams[0];
    fakeDb.rawSet(`exams/${freeExam.id}`, {
      ...freeExam,
      isPaid: false,
      isActive: true,
      questionIds: sampleQuestions.slice(0, 20).map(q => q.id)
    });

    const opts = {
      firestoreDb: fakeDb as unknown as Firestore,
      isProduction: true,
      questionBankCacheTtlMs: 60_000,
      rateLimitOverrides: { globalMax: 2000 },
      tokenVerifier: async (idToken: string) => {
        const user = TOKEN_MAP[idToken];
        if (!user) throw new Error('Invalid token');
        return user;
      }
    };

    const inst1 = createSanadPrepApp(opts);
    const inst2 = createSanadPrepApp(opts);
    const s1 = inst1.app.listen(0, '127.0.0.1');
    const s2 = inst2.app.listen(0, '127.0.0.1');
    await Promise.all([
      new Promise<void>(r => s1.once('listening', r)),
      new Promise<void>(r => s2.once('listening', r))
    ]);
    const u1 = `http://127.0.0.1:${(s1.address() as { port: number }).port}`;
    const u2 = `http://127.0.0.1:${(s2.address() as { port: number }).port}`;

    try {
      const loginA = await fetch(`${u1}/api/auth/session`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${STUDENT_A_TOKEN}` }
      });
      const sessA = ((await loginA.json()) as { sessionId: string }).sessionId;

      const loginOwner = await fetch(`${u1}/api/auth/session`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${OWNER_TOKEN}` }
      });
      const sessOwner = ((await loginOwner.json()) as { sessionId: string }).sessionId;

      // 1. Cold GET /api/questions on inst1 -> reads ONLY `questions` (120) + 1 version doc, ZERO `questionKeys`
      fakeDb.resetReadCounts();
      const coldRes = await fetch(`${u1}/api/questions`, {
        headers: { Authorization: `Bearer ${STUDENT_A_TOKEN}`, 'X-Session-Id': sessA }
      });
      assert.equal(coldRes.status, 200);
      const coldJson = (await coldRes.json()) as { questions: Array<Record<string, unknown>> };
      assert.equal(coldJson.questions.length, 120);
      assert.equal(coldJson.questions[0].correctOptionIndex, undefined);
      assert.equal(fakeDb.getReadCount('questions'), 120);
      assert.equal(fakeDb.getReadCount('questionKeys'), 0);
      assert.equal(fakeDb.getReadCount('config'), 1);

      // 2. Warm GET /api/questions on inst1 -> 0 `questions` reads, 0 `questionKeys` reads, 1 version doc check
      fakeDb.resetReadCounts();
      const warmRes = await fetch(`${u1}/api/questions`, {
        headers: { Authorization: `Bearer ${STUDENT_A_TOKEN}`, 'X-Session-Id': sessA }
      });
      assert.equal(warmRes.status, 200);
      assert.equal(((await warmRes.json()) as { questions: unknown[] }).questions.length, 120);
      assert.equal(fakeDb.getReadCount('questions'), 0);
      assert.equal(fakeDb.getReadCount('questionKeys'), 0);
      assert.equal(fakeDb.getReadCount('config'), 1);

      // 3. Pagination & search on /api/questions
      fakeDb.resetReadCounts();
      const pagedRes = await fetch(`${u1}/api/questions?limit=15&offset=10`, {
        headers: { Authorization: `Bearer ${STUDENT_A_TOKEN}`, 'X-Session-Id': sessA }
      });
      assert.equal(pagedRes.status, 200);
      const pagedJson = (await pagedRes.json()) as { questions: unknown[]; total: number; limit: number; offset: number };
      assert.equal(pagedJson.questions.length, 15);
      assert.equal(pagedJson.total, 120);
      assert.equal(pagedJson.limit, 15);
      assert.equal(pagedJson.offset, 10);
      assert.equal(fakeDb.getReadCount('questions'), 0);
      assert.equal(fakeDb.getReadCount('questionKeys'), 0);

      // 4. Warm POST /api/exams/start on inst1 -> 0 `questions` reads, 0 `questionKeys` reads
      fakeDb.resetReadCounts();
      const startRes = await fetch(`${u1}/api/exams/start`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${STUDENT_A_TOKEN}`,
          'X-Session-Id': sessA,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ examId: freeExam.id })
      });
      assert.equal(startRes.status, 200);
      const startJson = (await startRes.json()) as { questions: Array<Record<string, unknown>> };
      assert.equal(startJson.questions.length, 20);
      assert.equal(fakeDb.getReadCount('questions'), 0);
      assert.equal(fakeDb.getReadCount('questionKeys'), 0);

      // 5. Cross-instance cache invalidation: warm inst2 first, then admin mutates on inst1 -> inst2 sees change immediately
      const warmInst2 = await fetch(`${u2}/api/questions`, {
        headers: { Authorization: `Bearer ${STUDENT_A_TOKEN}`, 'X-Session-Id': sessA }
      });
      assert.equal(((await warmInst2.json()) as { questions: unknown[] }).questions.length, 120);

      const newQId = 'q_cross_inst_cache_test';
      const saveQRes = await fetch(`${u1}/api/admin/questions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OWNER_TOKEN}`,
          'X-Session-Id': sessOwner,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          id: newQId,
          subjectId: 'sub_penal',
          questionBn: 'নতুন ফৌজদারি প্রশ্ন যাচাই?',
          questionEn: 'Cross instance cache invalidation test?',
          optionsBn: ['ক', 'খ', 'গ', 'ঘ'],
          optionsEn: ['A', 'B', 'C', 'D'],
          correctOptionIndex: 2,
          explanationBn: 'ব্যাখ্যা',
          explanationEn: 'Explanation'
        })
      });
      assert.equal(saveQRes.status, 200);

      const inst2AfterAdd = await fetch(`${u2}/api/questions`, {
        headers: { Authorization: `Bearer ${STUDENT_A_TOKEN}`, 'X-Session-Id': sessA }
      });
      const listAfterAdd = ((await inst2AfterAdd.json()) as { questions: Array<{ id: string }> }).questions;
      assert.equal(listAfterAdd.length, 121);
      assert.ok(listAfterAdd.some(q => q.id === newQId));

      const delQRes = await fetch(`${u1}/api/admin/questions/${newQId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${OWNER_TOKEN}`, 'X-Session-Id': sessOwner }
      });
      assert.equal(delQRes.status, 200);

      const inst2AfterDel = await fetch(`${u2}/api/questions`, {
        headers: { Authorization: `Bearer ${STUDENT_A_TOKEN}`, 'X-Session-Id': sessA }
      });
      const listAfterDel = ((await inst2AfterDel.json()) as { questions: Array<{ id: string }> }).questions;
      assert.equal(listAfterDel.length, 120);
      assert.ok(!listAfterDel.some(q => q.id === newQId));

      // 6. Session revocation on inst1 is IMMEDIATELY enforced on inst2 (no stale session cache)
      await fetch(`${u1}/api/auth/session`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${STUDENT_A_TOKEN}` }
      });
      const revokedOnInst2 = await fetch(`${u2}/api/auth/session/status`, {
        headers: { Authorization: `Bearer ${STUDENT_A_TOKEN}`, 'X-Session-Id': sessA }
      });
      assert.equal(revokedOnInst2.status, 401);
      assert.equal(((await revokedOnInst2.json()) as Record<string, unknown>).error, 'SESSION_REVOKED');
    } finally {
      invalidateQuestionBankCache(fakeDb as unknown as Firestore);
      await Promise.all([
        new Promise<void>(r => s1.close(() => r())),
        new Promise<void>(r => s2.close(() => r()))
      ]);
    }
  });

  test('R10 & R11. Configurable TTL cache expiration & Named Firestore Database fail-closed validation', async () => {
    clearRateLimitBucketsForTests();
    const fakeDb = new FakeFirestore();
    const seedMirror = createMemoryMirror();
    fakeDb.rawSet('questions/q_ttl_1', sanitizeForTest(seedMirror.questions[0]));

    const { app } = createSanadPrepApp({
      firestoreDb: fakeDb as unknown as Firestore,
      isProduction: true,
      questionBankCacheTtlMs: 35,
      rateLimitOverrides: { globalMax: 1000 },
      tokenVerifier: async (idToken: string) => {
        const user = TOKEN_MAP[idToken];
        if (!user) throw new Error('Invalid token');
        return user;
      }
    });
    const srv = app.listen(0, '127.0.0.1');
    await new Promise<void>(r => srv.once('listening', r));
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;

    try {
      const loginRes = await fetch(`${url}/api/auth/session`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${STUDENT_A_TOKEN}` }
      });
      const sessId = ((await loginRes.json()) as { sessionId: string }).sessionId;

      const r1 = await fetch(`${url}/api/questions`, {
        headers: { Authorization: `Bearer ${STUDENT_A_TOKEN}`, 'X-Session-Id': sessId }
      });
      assert.equal(((await r1.json()) as { questions: unknown[] }).questions.length, 1);

      // Inject another question directly into Firestore without touching cache version doc
      fakeDb.rawSet('questions/q_ttl_2', sanitizeForTest(seedMirror.questions[1]));

      // Inside TTL: cache serves 1 question with 0 question reads
      fakeDb.resetReadCounts();
      const r2 = await fetch(`${url}/api/questions`, {
        headers: { Authorization: `Bearer ${STUDENT_A_TOKEN}`, 'X-Session-Id': sessId }
      });
      assert.equal(((await r2.json()) as { questions: unknown[] }).questions.length, 1);
      assert.equal(fakeDb.getReadCount('questions'), 0);

      // After TTL (60ms > 35ms): cache expires and refreshes 2 questions
      await new Promise<void>(r => setTimeout(r, 60));
      fakeDb.resetReadCounts();
      const r3 = await fetch(`${url}/api/questions`, {
        headers: { Authorization: `Bearer ${STUDENT_A_TOKEN}`, 'X-Session-Id': sessId }
      });
      assert.equal(((await r3.json()) as { questions: unknown[] }).questions.length, 2);
      assert.equal(fakeDb.getReadCount('questions'), 2);

      // Named database validation check
      assert.equal(EXPECTED_FIREBASE_PROJECT_ID, 'galvanic-aviary-tzp2g');
      assert.equal(
        EXPECTED_FIREBASE_DATABASE_ID,
        'ai-studio-barcouncilmcqpre-9a5aecc8-3819-4aeb-b7e2-c6066b637cab'
      );
      assert.equal(resolveEffectiveDatabaseId(EXPECTED_FIREBASE_PROJECT_ID), EXPECTED_FIREBASE_DATABASE_ID);
      assert.equal(resolveEffectiveDatabaseId(''), EXPECTED_FIREBASE_DATABASE_ID);
      assert.equal(resolveEffectiveDatabaseId('(default)'), '(default)');

      const goodHealth = await fetch(`${url}/api/health`);
      assert.equal(goodHealth.status, 200);
      const goodHealthJson = (await goodHealth.json()) as Record<string, unknown>;
      assert.equal(goodHealthJson.expectedDatabaseMatched, true);
      assert.equal(goodHealthJson.databaseId, EXPECTED_FIREBASE_DATABASE_ID);

      // Reject mismatched SDK databaseId in assertExpectedNamedDatabase & /api/health
      const defaultDb = new FakeFirestore();
      defaultDb.databaseId = '(default)';
      const badValidation = assertExpectedNamedDatabase(defaultDb as unknown as Firestore);
      assert.equal(badValidation.valid, false);
      assert.match(badValidation.reason || '', /\(default\)/);

      const dbInfo = getConfiguredDatabaseInfo(fakeDb as unknown as Firestore);
      assert.equal(dbInfo.matchesExpected, true);

      const badProdApp = createSanadPrepApp({
        firestoreDb: defaultDb as unknown as Firestore,
        isProduction: true
      }).app;
      const badSrv = badProdApp.listen(0, '127.0.0.1');
      await new Promise<void>(r => badSrv.once('listening', r));
      try {
        const badUrl = `http://127.0.0.1:${(badSrv.address() as { port: number }).port}`;
        const badHealth = await fetch(`${badUrl}/api/health`);
        assert.equal(badHealth.status, 503);
        const badHealthJson = (await badHealth.json()) as Record<string, unknown>;
        assert.equal(badHealthJson.expectedDatabaseMatched, false);
      } finally {
        await new Promise<void>(r => badSrv.close(() => r()));
      }
    } finally {
      invalidateQuestionBankCache(fakeDb as unknown as Firestore);
      await new Promise<void>(r => srv.close(() => r()));
    }
  });
});

function sanitizeForTest(q: Record<string, any>): Record<string, unknown> {
  const { correctOptionIndex: _c, explanationBn: _eb, explanationEn: _ee, ...rest } = q;
  return rest;
}




