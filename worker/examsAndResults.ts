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
import { checkUserHasActiveSubscriptionRest } from './firestoreRest.ts';
import { consumeRateLimitD1, validateAndTouchSessionD1, type RateLimitResult } from './d1Store.ts';
import {
  ensureSanitizedQuestionsSyncedD1,
  getAuthoritativeQuestionKeys,
  parseQuestionBankCacheTtlMs,
  querySanitizedQuestionsFromD1,
  sanitizeQuestion
} from './questionCache.ts';
import {
  parsePhase3JsonBody,
  type Phase3RouteContext,
  type Phase3RouteResult
} from './paymentsAndAdmin.ts';
import {
  WorkerHttpError,
  type AuditLog,
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
  qDoc: Record<string, unknown>,
  kDoc?: Record<string, unknown>
): ServerQuestion {
  const optionsBn = Array.isArray(qDoc.optionsBn) ? qDoc.optionsBn.map(o => String(o ?? '')) : [];
  const optionsEn = Array.isArray(qDoc.optionsEn)
    ? qDoc.optionsEn.map(o => String(o ?? ''))
    : optionsBn;

  return {
    id: qId,
    subjectId: String(qDoc.subjectId ?? ''),
    ...(typeof qDoc.topicId === 'string' && qDoc.topicId.trim()
      ? { topicId: qDoc.topicId.trim() }
      : {}),
    questionBn: String(qDoc.questionBn ?? ''),
    questionEn: String(qDoc.questionEn ?? qDoc.questionBn ?? ''),
    optionsBn,
    optionsEn,
    legalReference: String(kDoc?.legalReference ?? qDoc.legalReference ?? ''),
    difficulty:
      qDoc.difficulty === 'easy' || qDoc.difficulty === 'hard' ? qDoc.difficulty : 'medium',
    status: qDoc.status === 'draft' || qDoc.status === 'reviewed' ? qDoc.status : 'published',
    isDemoSample: Boolean(qDoc.isDemoSample),
    createdAt: String(qDoc.createdAt ?? ''),
    updatedAt: String(qDoc.updatedAt ?? ''),
    ...(typeof qDoc.createdBy === 'string' && qDoc.createdBy.trim()
      ? { createdBy: qDoc.createdBy.trim() }
      : {}),
    correctOptionIndex: Number(kDoc?.correctOptionIndex ?? qDoc.correctOptionIndex ?? 0),
    explanationBn: String(kDoc?.explanationBn ?? qDoc.explanationBn ?? ''),
    explanationEn: String(kDoc?.explanationEn ?? qDoc.explanationEn ?? '')
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
  // 1. PUBLIC LEADERBOARD (Top 50 merit ranking)
  // ---------------------------------------------------------
  if (pathname === '/api/leaderboard' && method === 'GET') {
    const examId = url.searchParams.get('examId')?.trim();
    const docs =
      examId && examId !== 'all'
        ? await firestoreClient.runQuery<Record<string, unknown>>({
            collection: 'leaderboard',
            where: [{ field: 'examId', op: 'EQUAL', value: examId }]
          })
        : await firestoreClient.listDocuments<Record<string, unknown>>('leaderboard', {
            pageSize: 500,
            maxPages: 5
          });

    const entries = docs.map(d => d as unknown as LeaderboardEntry);
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

    const examDoc = await firestoreClient.getDocument<Record<string, unknown>>('exams', examId);
    if (!examDoc) {
      throw new WorkerHttpError(404, 'EXAM_NOT_FOUND', 'Exam not found.');
    }

    const exam: Exam = {
      ...(examDoc as unknown as Omit<Exam, 'id'>),
      id: examDoc.id,
      isActive:
        examDoc.isActive !== undefined
          ? Boolean(examDoc.isActive)
          : !examDoc.isPaid || examDoc.id === 'exam_model_test_01',
      scheduledDate:
        typeof examDoc.scheduledDate === 'string' && examDoc.scheduledDate
          ? examDoc.scheduledDate
          : undefined
    };

    const isOwner = isOwnerUser(authUser, env);
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
      const subCheck = await checkUserHasActiveSubscriptionRest(firestoreClient, authUser.uid, nowMs);
      if (!subCheck.active) {
        throw new WorkerHttpError(
          403,
          'SUBSCRIPTION_REQUIRED',
          'এই ৬০ মিনিটের স্পেশাল মডেল টেস্টটি আনলক করতে সক্রিয় প্রো সাবস্ক্রিপশন প্রয়োজন।'
        );
      }
    }

    await ensureSanitizedQuestionsSyncedD1(db, firestoreClient, { ttlMs, nowMs });
    const { questions: allSanitized } = await querySanitizedQuestionsFromD1(db);
    const examQuestions = getQuestionsForExam(exam, allSanitized as unknown as Question[])
      .map(q => sanitizeQuestion(q as unknown as ServerQuestion));
    const resolvedQuestionIds = examQuestions.map(q => q.id);

    const durationMinutes = Number(exam.durationMinutes) || 60;
    const deadlineIso = new Date(nowMs + durationMinutes * 60 * 1000).toISOString();

    const attempt: ExamAttempt = {
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
      lastSavedAt: nowIso
    };

    const auditEntry: AuditLog = {
      id: makeId('log', nowMs),
      userId: authUser.uid,
      userName: attempt.studentName,
      action: 'START_EXAM',
      details: `Started authoritative exam "${exam.titleEn}" (${attempt.id})`,
      timestamp: nowIso
    };

    await firestoreClient.commitWrites([
      {
        type: 'set',
        collection: 'examAttempts',
        docId: attempt.id,
        data: {
          ...attempt,
          sessionId: attempt.sessionId || null,
          resolvedQuestionIds
        }
      },
      {
        type: 'set',
        collection: 'auditLogs',
        docId: auditEntry.id,
        data: { ...auditEntry }
      }
    ]);

    return {
      status: 200,
      payload: {
        success: true,
        attempt,
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
  // 3. SAVE IN-PROGRESS ANSWERS
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

    await firestoreClient.runTransaction(async tx => {
      const attemptDoc = await tx.get<Record<string, unknown>>('examAttempts', attemptId);
      if (!attemptDoc) {
        throw new WorkerHttpError(404, 'ATTEMPT_NOT_FOUND', 'Exam attempt not found.');
      }
      if (attemptDoc.userId !== authUser.uid) {
        throw new WorkerHttpError(403, 'FORBIDDEN', 'Cannot modify another user exam attempt.');
      }
      if (attemptDoc.status !== 'in_progress') {
        throw new WorkerHttpError(400, 'ALREADY_SUBMITTED', 'Attempt has already been submitted.');
      }

      tx.update('examAttempts', attemptId, {
        ...(cleanedAnswers !== undefined ? { answers: cleanedAnswers } : {}),
        ...(cleanedFlagged !== undefined ? { flaggedQuestionIds: cleanedFlagged } : {}),
        ...(cleanedIndex !== undefined ? { currentQuestionIndex: cleanedIndex } : {}),
        lastSavedAt: nowIso
      });
    });

    return { status: 200, payload: { success: true } };
  }

  // ---------------------------------------------------------
  // 4. AUTHORITATIVE SERVER-SIDE EXAM GRADING & SUBMISSION
  //    Uses batched reads inside transaction (stays <= 10 HTTP subrequests!)
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
    const txOutcome = await firestoreClient.runTransaction(async tx => {
      const attemptDoc = await tx.get<Record<string, unknown>>('examAttempts', attemptId);
      if (!attemptDoc) {
        throw new WorkerHttpError(404, 'ATTEMPT_NOT_FOUND', 'Exam attempt not found.');
      }

      const rawAttempt = attemptDoc as unknown as ExamAttempt & { resolvedQuestionIds?: string[] };
      if (rawAttempt.userId !== uid) {
        throw new WorkerHttpError(403, 'FORBIDDEN', 'Cannot submit another user exam attempt.');
      }
      if (rawAttempt.status !== 'in_progress') {
        throw new WorkerHttpError(400, 'ALREADY_SUBMITTED', 'Attempt has already been submitted.');
      }

      const examDoc = await tx.get<Record<string, unknown>>('exams', rawAttempt.examId);
      if (!examDoc) {
        throw new WorkerHttpError(404, 'EXAM_NOT_FOUND', 'Exam not found.');
      }
      const exam: Exam = {
        ...(examDoc as unknown as Omit<Exam, 'id'>),
        id: examDoc.id,
        isActive:
          examDoc.isActive !== undefined
            ? Boolean(examDoc.isActive)
            : !examDoc.isPaid || examDoc.id === 'exam_model_test_01'
      };

      const resolvedIds =
        Array.isArray(rawAttempt.resolvedQuestionIds) && rawAttempt.resolvedQuestionIds.length > 0
          ? rawAttempt.resolvedQuestionIds
          : exam.questionIds || [];

      let authoritativeQuestions: ServerQuestion[] = [];
      if (resolvedIds.length > 0 && resolvedIds.length <= 200) {
        // Batched snapshot reads inside transaction: max 2 subrequests per 100 questions!
        const [qMap, kMap] = await Promise.all([
          firestoreClient.batchGetDocuments<Record<string, unknown>>(
            resolvedIds.map(qId => ({ collection: 'questions', docId: qId })),
            { transactionId: tx.transactionId }
          ),
          firestoreClient.batchGetDocuments<Record<string, unknown>>(
            resolvedIds.map(qId => ({ collection: 'questionKeys', docId: qId })),
            { transactionId: tx.transactionId }
          )
        ]);
        for (const qId of resolvedIds) {
          const qDoc = qMap.get(qId);
          if (!qDoc) continue;
          const kDoc = kMap.get(qId);
          authoritativeQuestions.push(hydrateQuestionDoc(qId, qDoc, kDoc));
        }
      } else {
        await ensureSanitizedQuestionsSyncedD1(db, firestoreClient, { ttlMs, nowMs });
        const { questions: allSanitized } = await querySanitizedQuestionsFromD1(db);
        const examMetaWithIds = resolvedIds.length > 0 ? { ...exam, questionIds: resolvedIds } : exam;
        const selectedSanitized = getQuestionsForExam(
          examMetaWithIds,
          allSanitized as unknown as Question[]
        );
        const keyMap = await getAuthoritativeQuestionKeys(
          db,
          firestoreClient,
          selectedSanitized.map(q => q.id),
          { ttlMs, nowMs }
        );
        authoritativeQuestions = selectedSanitized.map(q => {
          const k = keyMap.get(q.id);
          return {
            ...(q as unknown as ServerQuestion),
            correctOptionIndex: k?.correctOptionIndex ?? 0,
            explanationBn: k?.explanationBn ?? '',
            explanationEn: k?.explanationEn ?? '',
            legalReference: k?.legalReference || q.legalReference || ''
          };
        });
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

      const { questions: _omittedQuestions, ...firestoreResultPayload } = newResult;
      const auditId = makeId('log', nowMs);

      tx.update('examAttempts', attemptId, {
        status: nextAttemptStatus,
        submittedTime: nowIso,
        answers: sanitizedAnswers
      });

      tx.set('examResults', newResult.id, {
        ...firestoreResultPayload,
        score: newResult.finalScore
      });

      tx.set(
        'leaderboard',
        leaderboardEntry.id,
        leaderboardEntry as unknown as Record<string, unknown>,
        { merge: true }
      );

      tx.set('auditLogs', auditId, {
        id: auditId,
        userId: uid,
        userName: rawAttempt.studentName,
        action: nextAttemptStatus === 'timed_out' ? 'EXAM_TIMED_OUT' : 'SUBMIT_EXAM',
        details: `Server graded "${exam.titleEn}": ${newResult.finalScore}/${newResult.totalQuestions} (${newResult.percentage}%)`,
        timestamp: nowIso
      });

      return { newResult, leaderboardEntry };
    });

    return {
      status: 200,
      payload: {
        success: true,
        result: txOutcome.newResult,
        leaderboardEntry: txOutcome.leaderboardEntry
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

    const docs = await firestoreClient.runQuery<Record<string, unknown>>({
      collection: 'examResults',
      where: [{ field: 'userId', op: 'EQUAL', value: authUser.uid }]
    });
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

    const docs = await firestoreClient.runQuery<Record<string, unknown>>({
      collection: 'examResults',
      where: [{ field: 'userId', op: 'EQUAL', value: requestedUid }]
    });
    docs.sort(
      (a, b) =>
        new Date(String(b.submittedAt || 0)).getTime() - new Date(String(a.submittedAt || 0)).getTime()
    );
    return { status: 200, payload: { results: docs } };
  }

  return null;
}
