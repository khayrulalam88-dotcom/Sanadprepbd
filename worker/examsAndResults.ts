import { INITIAL_SUBJECTS } from '../src/data/mockData.ts';
import type {
  Exam,
  ExamAttempt,
  ExamResult,
  LeaderboardEntry,
  Question
} from '../src/types/index.ts';
import { getQuestionsForExam } from '../src/utils/modelTestGenerator.ts';
import { calculateExamScore } from '../src/utils/scoring.ts';
import {
  authenticateFirebaseRequest,
  isOwnerUser
} from './firebaseAuth.ts';
import {
  checkUserHasActiveSubscriptionKeyless,
  commitExamSubmissionD1,
  consumeRateLimitD1,
  getExamAttemptD1,
  insertExamAttemptD1,
  isUniqueConstraintError,
  listExamResultsByUserD1,
  listLeaderboardEntriesD1,
  updateExamAttemptProgressD1,
  validateAndTouchSessionD1,
  type RateLimitResult,
  type StoredExamAttempt
} from './d1Store.ts';
import {
  ensureSanitizedQuestionsSyncedD1,
  getAuthoritativeQuestionKeys,
  parseQuestionBankCacheTtlMs,
  querySanitizedQuestionsByIdsFromD1,
  querySanitizedQuestionsFromD1,
  sanitizeQuestion
} from './questionCache.ts';
import { resolveExamByIdKeyless } from './catalogAndPractice.ts';
import {
  parsePhase3JsonBody,
  type Phase3RouteContext,
  type Phase3RouteResult
} from './paymentsAndAdmin.ts';
import {
  WorkerHttpError,
  type AuditLog,
  type SanitizedQuestion,
  type ServerQuestion
} from './types.ts';

function makeId(prefix: string, nowMs: number): string {
  const rand =
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 6)
      : Math.random().toString(36).slice(2, 8);
  return `${prefix}_${nowMs}_${rand}`;
}

function hydrateQuestionDoc(
  qId: string,
  qDoc: Record<string, unknown> | SanitizedQuestion,
  kDoc?: {
    correctOptionIndex?: unknown;
    explanationBn?: unknown;
    explanationEn?: unknown;
    legalReference?: unknown;
  }
): ServerQuestion {
  const raw = qDoc as Record<string, unknown>;
  const optionsBn = Array.isArray(raw.optionsBn) ? raw.optionsBn.map(o => String(o ?? '')) : [];
  const optionsEn = Array.isArray(raw.optionsEn)
    ? raw.optionsEn.map(o => String(o ?? ''))
    : optionsBn;

  const rawCorrectIdx = kDoc?.correctOptionIndex ?? raw.correctOptionIndex;
  if (
    typeof rawCorrectIdx !== 'number' ||
    !Number.isInteger(rawCorrectIdx) ||
    rawCorrectIdx < 0 ||
    rawCorrectIdx > 3
  ) {
    throw new WorkerHttpError(
      503,
      'QUESTION_KEYS_UNAVAILABLE',
      'Authoritative exam answer keys are unavailable in edge cache. Please ask admin to sync cache and retry.'
    );
  }

  return {
    id: qId,
    subjectId: String(raw.subjectId ?? ''),
    ...(typeof raw.topicId === 'string' && raw.topicId.trim()
      ? { topicId: raw.topicId.trim() }
      : {}),
    questionBn: String(raw.questionBn ?? ''),
    questionEn: String(raw.questionEn ?? raw.questionBn ?? ''),
    optionsBn,
    optionsEn,
    legalReference: String(kDoc?.legalReference ?? raw.legalReference ?? ''),
    difficulty:
      raw.difficulty === 'easy' || raw.difficulty === 'hard' ? raw.difficulty : 'medium',
    status: raw.status === 'draft' || raw.status === 'reviewed' ? raw.status : 'published',
    isDemoSample: Boolean(raw.isDemoSample),
    createdAt: String(raw.createdAt ?? ''),
    updatedAt: String(raw.updatedAt ?? ''),
    ...(typeof raw.createdBy === 'string' && raw.createdBy.trim()
      ? { createdBy: raw.createdBy.trim() }
      : {}),
    correctOptionIndex: rawCorrectIdx,
    explanationBn: String(kDoc?.explanationBn ?? raw.explanationBn ?? ''),
    explanationEn: String(kDoc?.explanationEn ?? raw.explanationEn ?? '')
  };
}

export async function handleExamsAndResultsRoutes(
  ctx: Phase3RouteContext
): Promise<Phase3RouteResult | null> {
  const { pathname, method, url, env, projectId, nowMs, firestoreClient } = ctx;
  const db = env.DB!;
  const ttlMs = parseQuestionBankCacheTtlMs(
    env.QUESTION_BANK_CACHE_TTL_MS,
    ctx.questionBankCacheTtlMsOverride
  );
  const windowMs = ctx.rateLimitOverrides?.windowMs ?? 60_000;
  const nowIso = new Date(nowMs).toISOString();

  // ---------------------------------------------------------
  // 1. PUBLIC LEADERBOARD (Top 50 merit ranking, merged Firestore + D1)
  // ---------------------------------------------------------
  if (pathname === '/api/leaderboard' && method === 'GET') {
    const examId = url.searchParams.get('examId')?.trim();
    const [fsDocs, d1Entries] = await Promise.all([
      (examId && examId !== 'all'
        ? firestoreClient.runQuery<Record<string, unknown>>({
            collection: 'leaderboard',
            where: [{ field: 'examId', op: 'EQUAL', value: examId }]
          })
        : firestoreClient.listDocuments<Record<string, unknown>>('leaderboard', {
            pageSize: 500,
            maxPages: 5
          })
      ).catch(() => [] as Array<Record<string, unknown> & { id: string }>),
      listLeaderboardEntriesD1(db, examId)
    ]);

    const mergedMap = new Map<string, LeaderboardEntry>();
    for (const d of fsDocs) {
      const entry = d as unknown as LeaderboardEntry;
      if (entry?.id) mergedMap.set(entry.id, entry);
    }
    for (const d1Entry of d1Entries) {
      const existing = mergedMap.get(d1Entry.id);
      if (
        !existing ||
        new Date(String(d1Entry.completedAt || 0)).getTime() >=
          new Date(String(existing.completedAt || 0)).getTime()
      ) {
        mergedMap.set(d1Entry.id, d1Entry);
      }
    }

    const entries = Array.from(mergedMap.values());
    entries.sort(
      (a, b) =>
        Number(b.score ?? 0) - Number(a.score ?? 0) ||
        Number(a.timeSpentSeconds ?? 0) - Number(b.timeSpentSeconds ?? 0)
    );
    const top50 = entries.slice(0, 50).map((e, i) => ({ ...e, rank: i + 1 }));
    return { status: 200, payload: { leaderboard: top50 } };
  }

  // ---------------------------------------------------------
  // 2. START AUTHORITATIVE MOCK EXAM (Never leaks answer keys)
  // ---------------------------------------------------------
  if (pathname === '/api/exams/start' && method === 'POST') {
    const authUser = await authenticateFirebaseRequest(ctx.request, {
      projectId,
      environment: env.ENVIRONMENT,
      jwksFetcher: ctx.jwksFetcher,
      tokenVerifier: ctx.tokenVerifier,
      nowMs
    });

    const examsStartMax = ctx.rateLimitOverrides?.routeMax?.exams_start ?? 15;
    const rateResult: RateLimitResult = await consumeRateLimitD1(db, {
      key: `exams_start:uid_${authUser.uid}`,
      windowMs,
      maxRequests: examsStartMax,
      nowMs
    });
    const rlHeaders = {
      'X-RateLimit-Limit': String(rateResult.limit),
      'X-RateLimit-Remaining': String(rateResult.remaining)
    };
    if (!rateResult.allowed) {
      return {
        status: 429,
        payload: {
          error: 'RATE_LIMITED',
          retryAfterSeconds: rateResult.retryAfterSeconds,
          message: `অতিরিক্ত পরীক্ষা শুরুর অনুরোধ পাঠানো হয়েছে। অনুগ্রহ করে ${rateResult.retryAfterSeconds} সেকেন্ড পর আবার চেষ্টা করুন।`
        },
        headers: {
          ...rlHeaders,
          'Retry-After': String(rateResult.retryAfterSeconds)
        }
      };
    }

    const session = await validateAndTouchSessionD1(db, {
      sessionId: ctx.request.headers.get('x-session-id') || '',
      uid: authUser.uid,
      nowIso
    });

    const body = await parsePhase3JsonBody(ctx.request);
    const examId = typeof body.examId === 'string' ? body.examId.trim() : '';
    const studentNameInput = typeof body.studentName === 'string' ? body.studentName.trim() : '';

    if (!examId) {
      throw new WorkerHttpError(400, 'INVALID_EXAM_ID', 'Valid examId is required.');
    }

    const isOwner = isOwnerUser(authUser, env);
    const userClient = firestoreClient.withToken(authUser.idToken);

    const exam = await resolveExamByIdKeyless(db, userClient, examId);
    if (!exam) {
      throw new WorkerHttpError(404, 'EXAM_NOT_FOUND', 'Exam not found.');
    }

    const pendingConversion =
      (exam as unknown as { conversionState?: { status?: string } }).conversionState?.status === 'pending';
    if (pendingConversion) {
      throw new WorkerHttpError(
        409,
        'EXAM_CONVERSION_PENDING',
        'এই পরীক্ষাটির প্রশ্নসমূহ বর্তমানে আপগ্রেড হচ্ছে। অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন।'
      );
    }

    if (exam.isActive === false && !isOwner) {
      throw new WorkerHttpError(
        403,
        'EXAM_INACTIVE',
        'এই পরীক্ষাটি এখনো অ্যাডমিন কর্তৃক চালু করা হয়নি।'
      );
    }
    if (exam.type === 'custom_test' && !isOwner) {
      throw new WorkerHttpError(
        403,
        'FORBIDDEN',
        'অননুমোদিত: অ্যাডমিন ছাড়া কেউ কাস্টম টেস্ট নিতে পারবেন না।'
      );
    }
    if (exam.isPaid && !isOwner) {
      const subCheck = await checkUserHasActiveSubscriptionKeyless(db, userClient, authUser.uid, nowMs);
      if (!subCheck.active) {
        throw new WorkerHttpError(
          403,
          'SUBSCRIPTION_REQUIRED',
          'এই ৬০ মিনিটের স্পেশাল মডেল টেস্টটি আনলক করতে সক্রিয় প্রো সাবস্ক্রিপশন প্রয়োজন।'
        );
      }
    }

    await ensureSanitizedQuestionsSyncedD1(db, userClient, { ttlMs, nowMs, isOwner });
    const { questions: allSanitized } = await querySanitizedQuestionsFromD1(db);
    const examQuestions = getQuestionsForExam(exam, allSanitized as unknown as Question[])
      .map(q => sanitizeQuestion(q as unknown as ServerQuestion));
    const resolvedQuestionIds = examQuestions.map(q => q.id);

    const durationMinutes = Number(exam.durationMinutes) || 60;
    const deadlineIso = new Date(nowMs + durationMinutes * 60 * 1000).toISOString();

    const attempt: StoredExamAttempt = {
      id: makeId('attempt', nowMs),
      examId: exam.id,
      userId: authUser.uid,
      sessionId: session.sessionId,
      studentName: (studentNameInput || authUser.name || 'Student').slice(0, 100),
      startTime: nowIso,
      deadlineTime: deadlineIso,
      status: 'in_progress',
      answers: {},
      flaggedQuestionIds: [],
      currentQuestionIndex: 0,
      lastSavedAt: nowIso,
      resolvedQuestionIds
    };

    const auditEntry: AuditLog = {
      id: makeId('log', nowMs),
      userId: authUser.uid,
      userName: attempt.studentName,
      action: 'START_EXAM',
      details: `Started authoritative exam "${exam.titleEn}" (${attempt.id})`,
      timestamp: nowIso
    };

    await insertExamAttemptD1(db, attempt, auditEntry);

    const { resolvedQuestionIds: _internalIds, ...publicAttempt } = attempt;

    return {
      status: 200,
      payload: {
        success: true,
        attempt: publicAttempt,
        exam: {
          ...exam,
          questionIds: resolvedQuestionIds
        },
        questions: examQuestions,
        durationMinutes,
        deadlineTime: attempt.deadlineTime
      },
      headers: rlHeaders
    };
  }

  // ---------------------------------------------------------
  // 3. SAVE IN-PROGRESS ANSWERS (Keyless D1 atomic progress)
  // ---------------------------------------------------------
  if (pathname === '/api/exams/save-answer' && method === 'POST') {
    const authUser = await authenticateFirebaseRequest(ctx.request, {
      projectId,
      environment: env.ENVIRONMENT,
      jwksFetcher: ctx.jwksFetcher,
      tokenVerifier: ctx.tokenVerifier,
      nowMs
    });
    await validateAndTouchSessionD1(db, {
      sessionId: ctx.request.headers.get('x-session-id') || '',
      uid: authUser.uid,
      nowIso
    });

    const body = await parsePhase3JsonBody(ctx.request);
    const attemptId = typeof body.attemptId === 'string' ? body.attemptId.trim() : '';
    if (!attemptId) {
      throw new WorkerHttpError(400, 'INVALID_REQUEST', 'Valid attemptId is required.');
    }

    const rawAnswers = body.answers;
    const cleanedAnswers: Record<string, number> | undefined =
      rawAnswers && typeof rawAnswers === 'object' && !Array.isArray(rawAnswers)
        ? Object.entries(rawAnswers as Record<string, unknown>).reduce<Record<string, number>>(
            (acc, [k, v]) => {
              if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 3) {
                acc[k] = v;
              }
              return acc;
            },
            {}
          )
        : undefined;

    const cleanedFlagged = Array.isArray(body.flaggedQuestionIds)
      ? body.flaggedQuestionIds.map(String).slice(0, 200)
      : undefined;
    const cleanedIndex =
      typeof body.currentQuestionIndex === 'number' &&
      Number.isInteger(body.currentQuestionIndex) &&
      body.currentQuestionIndex >= 0
        ? body.currentQuestionIndex
        : undefined;

    const attemptDoc = await getExamAttemptD1(db, attemptId);
    if (!attemptDoc) {
      throw new WorkerHttpError(404, 'ATTEMPT_NOT_FOUND', 'Exam attempt not found.');
    }
    if (attemptDoc.userId !== authUser.uid) {
      throw new WorkerHttpError(403, 'FORBIDDEN', 'Cannot modify another user exam attempt.');
    }
    if (attemptDoc.status !== 'in_progress') {
      throw new WorkerHttpError(400, 'ALREADY_SUBMITTED', 'Attempt has already been submitted.');
    }

    const updatedAttempt: StoredExamAttempt = {
      ...attemptDoc,
      ...(cleanedAnswers !== undefined ? { answers: cleanedAnswers } : {}),
      ...(cleanedFlagged !== undefined ? { flaggedQuestionIds: cleanedFlagged } : {}),
      ...(cleanedIndex !== undefined ? { currentQuestionIndex: cleanedIndex } : {}),
      lastSavedAt: nowIso
    };
    await updateExamAttemptProgressD1(db, updatedAttempt);

    return { status: 200, payload: { success: true } };
  }

  // ---------------------------------------------------------
  // 4. AUTHORITATIVE SERVER-SIDE EXAM GRADING & SUBMISSION
  //    (Evaluates against D1 authoritative question + key store)
  // ---------------------------------------------------------
  if (pathname === '/api/exams/submit' && method === 'POST') {
    const authUser = await authenticateFirebaseRequest(ctx.request, {
      projectId,
      environment: env.ENVIRONMENT,
      jwksFetcher: ctx.jwksFetcher,
      tokenVerifier: ctx.tokenVerifier,
      nowMs
    });

    const examsSubmitMax = ctx.rateLimitOverrides?.routeMax?.exams_submit ?? 15;
    const rateResult: RateLimitResult = await consumeRateLimitD1(db, {
      key: `exams_submit:uid_${authUser.uid}`,
      windowMs,
      maxRequests: examsSubmitMax,
      nowMs
    });
    const rlHeaders = {
      'X-RateLimit-Limit': String(rateResult.limit),
      'X-RateLimit-Remaining': String(rateResult.remaining)
    };
    if (!rateResult.allowed) {
      return {
        status: 429,
        payload: {
          error: 'RATE_LIMITED',
          retryAfterSeconds: rateResult.retryAfterSeconds,
          message: `অতিরিক্ত সাবমিশন অনুরোধ পাঠানো হয়েছে। অনুগ্রহ করে ${rateResult.retryAfterSeconds} সেকেন্ড পর আবার চেষ্টা করুন।`
        },
        headers: {
          ...rlHeaders,
          'Retry-After': String(rateResult.retryAfterSeconds)
        }
      };
    }

    await validateAndTouchSessionD1(db, {
      sessionId: ctx.request.headers.get('x-session-id') || '',
      uid: authUser.uid,
      nowIso
    });

    const body = await parsePhase3JsonBody(ctx.request);
    const attemptId = typeof body.attemptId === 'string' ? body.attemptId.trim() : '';
    const isAutoTimeout = Boolean(body.isAutoTimeout);
    const clientAnswers = body.answers;

    if (!attemptId) {
      throw new WorkerHttpError(400, 'INVALID_ATTEMPT_ID', 'Valid attemptId is required.');
    }

    const uid = authUser.uid;
    const isOwner = isOwnerUser(authUser, env);
    const userClient = firestoreClient.withToken(authUser.idToken);

    const rawAttempt = await getExamAttemptD1(db, attemptId);
    if (!rawAttempt) {
      throw new WorkerHttpError(404, 'ATTEMPT_NOT_FOUND', 'Exam attempt not found.');
    }
    if (rawAttempt.userId !== uid) {
      throw new WorkerHttpError(403, 'FORBIDDEN', 'Cannot submit another user exam attempt.');
    }
    if (rawAttempt.status !== 'in_progress') {
      throw new WorkerHttpError(400, 'ALREADY_SUBMITTED', 'Attempt has already been submitted.');
    }

    const exam = await resolveExamByIdKeyless(db, userClient, rawAttempt.examId);
    if (!exam) {
      throw new WorkerHttpError(404, 'EXAM_NOT_FOUND', 'Exam not found.');
    }

    const conversionState = (
      exam as unknown as { conversionState?: { status?: string; startedAt?: string } }
    ).conversionState;
    const hasFrozenQuestionIds =
      Array.isArray(rawAttempt.resolvedQuestionIds) && rawAttempt.resolvedQuestionIds.length > 0;
    if (conversionState?.status === 'pending') {
      const attemptStartMs = Date.parse(String(rawAttempt.startTime || ''));
      const conversionStartedMs = Date.parse(String(conversionState.startedAt || ''));
      const startedAfterConversionStarted =
        Number.isFinite(attemptStartMs) &&
        Number.isFinite(conversionStartedMs) &&
        attemptStartMs >= conversionStartedMs;
      if (!hasFrozenQuestionIds || startedAfterConversionStarted) {
        throw new WorkerHttpError(
          409,
          'EXAM_CONVERSION_PENDING',
          'এই পরীক্ষাটির প্রশ্নসমূহ বর্তমানে আপগ্রেড হচ্ছে। অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন।'
        );
      }
    }

    const resolvedIds = hasFrozenQuestionIds
      ? rawAttempt.resolvedQuestionIds!
      : exam.questionIds || [];

    let authoritativeQuestions: ServerQuestion[] = [];
    if (resolvedIds.length > 0 && resolvedIds.length <= 200) {
      const [d1QuestionMap, keyMap] = await Promise.all([
        querySanitizedQuestionsByIdsFromD1(db, resolvedIds),
        getAuthoritativeQuestionKeys(db, userClient, resolvedIds, { ttlMs, nowMs })
      ]);

      const missingQuestionIds = resolvedIds.filter(qId => !d1QuestionMap.has(qId));
      const fsQuestionMap =
        missingQuestionIds.length > 0
          ? await userClient
              .batchGetDocuments<Record<string, unknown>>(
                missingQuestionIds.map(qId => ({ collection: 'questions', docId: qId }))
              )
              .catch(() => new Map<string, Record<string, unknown> & { id: string }>())
          : new Map<string, Record<string, unknown> & { id: string }>();

      for (const qId of resolvedIds) {
        const qBase = d1QuestionMap.get(qId) || fsQuestionMap.get(qId);
        if (!qBase) continue;
        const kRec = keyMap.get(qId);
        authoritativeQuestions.push(hydrateQuestionDoc(qId, qBase, kRec));
      }
    } else {
      await ensureSanitizedQuestionsSyncedD1(db, userClient, { ttlMs, nowMs, isOwner });
      const { questions: allSanitized } = await querySanitizedQuestionsFromD1(db);
      const examMetaWithIds = resolvedIds.length > 0 ? { ...exam, questionIds: resolvedIds } : exam;
      const selectedSanitized = getQuestionsForExam(
        examMetaWithIds,
        allSanitized as unknown as Question[]
      );
      const keyMap = await getAuthoritativeQuestionKeys(
        db,
        userClient,
        selectedSanitized.map(q => q.id),
        { ttlMs, nowMs }
      );
      authoritativeQuestions = selectedSanitized.map(q =>
        hydrateQuestionDoc(q.id, q as unknown as SanitizedQuestion, keyMap.get(q.id))
      );
    }

    if (authoritativeQuestions.length === 0) {
      throw new WorkerHttpError(
        500,
        'QUESTIONS_UNAVAILABLE',
        'Authoritative exam questions could not be loaded.'
      );
    }

    const validQIdSet = new Set(authoritativeQuestions.map(q => q.id));
    const rawAnswersSource: Record<string, unknown> =
      clientAnswers && typeof clientAnswers === 'object' && !Array.isArray(clientAnswers)
        ? (clientAnswers as Record<string, unknown>)
        : rawAttempt.answers || {};

    const sanitizedAnswers: Record<string, number> = {};
    for (const [qId, optVal] of Object.entries(rawAnswersSource)) {
      if (
        validQIdSet.has(qId) &&
        typeof optVal === 'number' &&
        Number.isInteger(optVal) &&
        optVal >= 0 &&
        optVal <= 3
      ) {
        sanitizedAnswers[qId] = optVal;
      }
    }

    const positiveRatio = exam.positiveMarkRatio ?? 1.0;
    const negativeRatio = exam.negativeMarkRatio ?? 0.25;
    const scoreResult = calculateExamScore(
      sanitizedAnswers,
      authoritativeQuestions as unknown as Question[],
      {
        positiveMarkRatio: positiveRatio,
        negativeMarkRatio: negativeRatio,
        passThresholdPercentage: exam.passThresholdPercentage
      }
    );

    const startTimeMs = new Date(rawAttempt.startTime).getTime();
    const deadlineMs = new Date(rawAttempt.deadlineTime).getTime();
    const submissionTimeMs = Math.min(nowMs, isNaN(deadlineMs) ? nowMs : deadlineMs + 15_000);
    const timeSpentSeconds = Math.max(
      1,
      Math.round((submissionTimeMs - (isNaN(startTimeMs) ? nowMs : startTimeMs)) / 1000)
    );

    const subjectScores: ExamResult['subjectWiseScores'] = {};
    for (const sub of INITIAL_SUBJECTS) {
      const subQuestions = authoritativeQuestions.filter(q => q.subjectId === sub.id);
      if (subQuestions.length > 0) {
        let correct = 0;
        let incorrect = 0;
        let unanswered = 0;
        for (const q of subQuestions) {
          const ans = sanitizedAnswers[q.id];
          if (ans === undefined || ans === null) unanswered++;
          else if (ans === q.correctOptionIndex) correct++;
          else incorrect++;
        }
        const score =
          Math.round((correct * positiveRatio - incorrect * negativeRatio) * 100) / 100;
        subjectScores[sub.id] = {
          subjectNameBn: sub.nameBn,
          subjectNameEn: sub.nameEn,
          total: subQuestions.length,
          correct,
          incorrect,
          unanswered,
          score
        };
      }
    }

    const nextAttemptStatus: ExamAttempt['status'] =
      isAutoTimeout || (!isNaN(deadlineMs) && nowMs > deadlineMs + 15_000)
        ? 'timed_out'
        : 'submitted';

    const newResult: ExamResult = {
      id: `res_${rawAttempt.id}`,
      attemptId: rawAttempt.id,
      examId: exam.id,
      examTitleBn: exam.titleBn,
      examTitleEn: exam.titleEn,
      examType: exam.type,
      userId: uid,
      studentName: rawAttempt.studentName,
      submittedAt: nowIso,
      timeSpentSeconds,
      totalQuestions: scoreResult.totalQuestions,
      correctAnswersCount: scoreResult.correctAnswersCount,
      incorrectAnswersCount: scoreResult.incorrectAnswersCount,
      unansweredCount: scoreResult.unansweredCount,
      positiveMarks: scoreResult.positiveMarks,
      negativeMarks: scoreResult.negativeMarks,
      finalScore: scoreResult.finalScore,
      percentage: scoreResult.percentage,
      passed: scoreResult.passed,
      passThresholdPercentage: exam.passThresholdPercentage,
      subjectWiseScores: subjectScores,
      answers: sanitizedAnswers,
      questions: authoritativeQuestions as unknown as Question[]
    };

    const leaderboardEntry: LeaderboardEntry = {
      id: `lead_${uid}_${exam.id}`,
      userId: uid,
      studentName: rawAttempt.studentName,
      examId: exam.id,
      examTitleBn: exam.titleBn,
      examTitleEn: exam.titleEn,
      score: newResult.finalScore,
      totalMarks: newResult.totalQuestions,
      percentage: newResult.percentage,
      correctAnswersCount: newResult.correctAnswersCount,
      incorrectAnswersCount: newResult.incorrectAnswersCount,
      unansweredCount: newResult.unansweredCount,
      timeSpentSeconds,
      completedAt: nowIso
    };

    const auditEntry: AuditLog = {
      id: makeId('log', nowMs),
      userId: uid,
      userName: rawAttempt.studentName,
      action: nextAttemptStatus === 'timed_out' ? 'EXAM_TIMED_OUT' : 'SUBMIT_EXAM',
      details: `Server graded "${exam.titleEn}": ${newResult.finalScore}/${newResult.totalQuestions} (${newResult.percentage}%)`,
      timestamp: nowIso
    };

    const updatedAttempt: StoredExamAttempt = {
      ...rawAttempt,
      status: nextAttemptStatus,
      submittedTime: nowIso,
      lastSavedAt: nowIso,
      answers: sanitizedAnswers
    };

    try {
      await commitExamSubmissionD1(db, {
        attempt: updatedAttempt,
        result: newResult,
        leaderboardEntry,
        auditEntry
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw new WorkerHttpError(400, 'ALREADY_SUBMITTED', 'Attempt has already been submitted.');
      }
      throw err;
    }

    return {
      status: 200,
      payload: {
        success: true,
        result: newResult,
        leaderboardEntry
      },
      headers: rlHeaders
    };
  }

  // ---------------------------------------------------------
  // 5. EXAM RESULTS HISTORY (Self or Verified Owner Admin ONLY)
  // ---------------------------------------------------------
  if (pathname === '/api/exams/results' && method === 'GET') {
    const authUser = await authenticateFirebaseRequest(ctx.request, {
      projectId,
      environment: env.ENVIRONMENT,
      jwksFetcher: ctx.jwksFetcher,
      tokenVerifier: ctx.tokenVerifier,
      nowMs
    });
    await validateAndTouchSessionD1(db, {
      sessionId: ctx.request.headers.get('x-session-id') || '',
      uid: authUser.uid,
      nowIso
    });

    const userClient = firestoreClient.withToken(authUser.idToken);
    const [d1Results, fsDocs] = await Promise.all([
      listExamResultsByUserD1(db, authUser.uid),
      userClient
        .runQuery<Record<string, unknown>>({
          collection: 'examResults',
          where: [{ field: 'userId', op: 'EQUAL', value: authUser.uid }]
        })
        .catch(() => [] as Array<Record<string, unknown> & { id: string }>)
    ]);

    const mergedMap = new Map<string, Record<string, unknown>>();
    for (const d of fsDocs) {
      if (d?.id) mergedMap.set(d.id, d);
    }
    for (const r of d1Results) {
      if (r?.id) mergedMap.set(r.id, r as unknown as Record<string, unknown>);
    }

    const docs = Array.from(mergedMap.values());
    docs.sort(
      (a, b) =>
        new Date(String(b.submittedAt || 0)).getTime() - new Date(String(a.submittedAt || 0)).getTime()
    );
    return { status: 200, payload: { results: docs } };
  }

  const resultsByUserMatch = pathname.match(/^\/api\/exams\/results\/([^/]+)$/);
  if (resultsByUserMatch && method === 'GET') {
    const authUser = await authenticateFirebaseRequest(ctx.request, {
      projectId,
      environment: env.ENVIRONMENT,
      jwksFetcher: ctx.jwksFetcher,
      tokenVerifier: ctx.tokenVerifier,
      nowMs
    });
    await validateAndTouchSessionD1(db, {
      sessionId: ctx.request.headers.get('x-session-id') || '',
      uid: authUser.uid,
      nowIso
    });

    const requestedUid = decodeURIComponent(resultsByUserMatch[1]).trim();
    if (requestedUid !== authUser.uid && !isOwnerUser(authUser, env)) {
      throw new WorkerHttpError(403, 'FORBIDDEN', 'Cannot read another user exam results.');
    }

    const userClient = firestoreClient.withToken(authUser.idToken);
    const [d1Results, fsDocs] = await Promise.all([
      listExamResultsByUserD1(db, requestedUid),
      userClient
        .runQuery<Record<string, unknown>>({
          collection: 'examResults',
          where: [{ field: 'userId', op: 'EQUAL', value: requestedUid }]
        })
        .catch(() => [] as Array<Record<string, unknown> & { id: string }>)
    ]);

    const mergedMap = new Map<string, Record<string, unknown>>();
    for (const d of fsDocs) {
      if (d?.id) mergedMap.set(d.id, d);
    }
    for (const r of d1Results) {
      if (r?.id) mergedMap.set(r.id, r as unknown as Record<string, unknown>);
    }

    const docs = Array.from(mergedMap.values());
    docs.sort(
      (a, b) =>
        new Date(String(b.submittedAt || 0)).getTime() - new Date(String(a.submittedAt || 0)).getTime()
    );
    return { status: 200, payload: { results: docs } };
  }

  return null;
}
