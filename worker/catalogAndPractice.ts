import { INITIAL_SUBJECTS } from '../src/data/mockData.ts';
import { INITIAL_EXAM_DATE_CONFIG, INITIAL_PACKAGES } from '../src/data/initialPackages.ts';
import { getQuestionsForExam } from '../src/utils/modelTestGenerator.ts';
import type { Exam, Question, SubscriptionPackage } from '../src/types/index.ts';
import {
  assertOwnerAdmin,
  authenticateFirebaseRequest,
  isOwnerUser,
  type JwksFetcher
} from './firebaseAuth.ts';
import {
  checkUserHasActiveSubscriptionRest,
  FirestoreRestClient
} from './firestoreRest.ts';
import { consumeRateLimitD1, validateAndTouchSessionD1, type RateLimitResult } from './d1Store.ts';
import {
  createQuestionBankVersionPayload,
  deleteQuestionFromCacheD1,
  ensureSanitizedQuestionsSyncedD1,
  fetchAllQuestionsWithKeysAuthoritative,
  getAuthoritativeQuestionKeys,
  getRemoteQuestionBankVersion,
  getSanitizedQuestionMeta,
  getSubjectQuestionCountsFromD1,
  invalidateLocalD1QuestionCache,
  parseQuestionBankCacheTtlMs,
  querySanitizedQuestionsFromD1,
  sanitizeQuestion,
  upsertSingleQuestionCacheD1
} from './questionCache.ts';
import {
  WorkerHttpError,
  type AuditLog,
  type DecodedAuthUser,
  type SanitizedQuestion,
  type ServerQuestion,
  type WorkerEnv
} from './types.ts';

const DEFAULT_PAYMENT_SETTINGS = {
  bkashNumber: '01712607777',
  nagadNumber: '01712607777',
  packagePrice: 300,
  instructionsBn: 'বিকাশ বা নগদ সেন্ড মানি (Personal) করে ট্রানজেকশন আইডি দিন।',
  instructionsEn: 'Send Money to the bKash or Nagad Personal number above and submit your TrxID.',
  whatsappNumber: '+8801671819027',
  whatsappMessage: 'Hello Sanad Prep BD Support, I need help with my account or subscription.'
};

const DEFAULT_SUPPORT_SETTINGS = {
  whatsappNumber: '+8801671819027',
  whatsappMessage: 'Hello Sanad Prep BD Support, I need help with my account or subscription.'
};

export interface Phase2RouteContext {
  request: Request;
  url: URL;
  pathname: string;
  method: string;
  env: WorkerEnv;
  projectId: string;
  nowMs: number;
  firestoreClient: FirestoreRestClient;
  jwksFetcher?: JwksFetcher;
  tokenVerifier?: (idToken: string) => Promise<DecodedAuthUser>;
  questionBankCacheTtlMsOverride?: number;
  rateLimitOverrides?: {
    windowMs?: number;
    routeMax?: Record<string, number>;
  };
}

export interface Phase2RouteResult {
  status: number;
  payload: unknown;
  headers?: Record<string, string>;
}

function parseOptionalIntParam(
  raw: string | null,
  name: string,
  min: number,
  max?: number
): number | undefined {
  if (raw === null || raw === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min) {
    throw new WorkerHttpError(
      400,
      'INVALID_REQUEST',
      `Invalid query parameter "${name}": must be an integer >= ${min}.`
    );
  }
  return max !== undefined ? Math.min(max, parsed) : parsed;
}

async function parseJsonObjectBody(request: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get('content-length') || '0');
  if (Number.isFinite(contentLength) && contentLength > 131_072) {
    throw new WorkerHttpError(413, 'PAYLOAD_TOO_LARGE', 'Request payload too large.');
  }
  const raw = await request.text();
  if (!raw || !raw.trim()) {
    return {};
  }
  if (raw.length > 131_072) {
    throw new WorkerHttpError(413, 'PAYLOAD_TOO_LARGE', 'Request payload too large.');
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new WorkerHttpError(400, 'INVALID_REQUEST', 'Request body must be a JSON object.');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof WorkerHttpError) throw err;
    throw new WorkerHttpError(400, 'INVALID_JSON', 'Invalid JSON request body.');
  }
}

export async function handlePhase2Routes(
  ctx: Phase2RouteContext
): Promise<Phase2RouteResult | null> {
  const { pathname, method, url, env, projectId, nowMs, firestoreClient } = ctx;
  const db = env.DB!;
  const ttlMs = parseQuestionBankCacheTtlMs(
    env.QUESTION_BANK_CACHE_TTL_MS,
    ctx.questionBankCacheTtlMsOverride
  );
  const windowMs = ctx.rateLimitOverrides?.windowMs ?? 60_000;

  // ---------------------------------------------------------
  // 1. PUBLIC CATALOG ENDPOINTS (No keys/explanations exposed)
  // ---------------------------------------------------------
  if (pathname === '/api/subjects' && method === 'GET') {
    const subjectDocs = await firestoreClient.listDocuments<Record<string, unknown>>('subjects', {
      pageSize: 100,
      maxPages: 2
    });
    const subjects = subjectDocs.length > 0 ? subjectDocs : INITIAL_SUBJECTS;
    return { status: 200, payload: { subjects } };
  }

  if (pathname === '/api/subjects/counts' && method === 'GET') {
    await ensureSanitizedQuestionsSyncedD1(db, firestoreClient, { ttlMs, nowMs });
    const { counts, total } = await getSubjectQuestionCountsFromD1(db);
    return { status: 200, payload: { counts, total } };
  }

  const subjectChaptersMatch = pathname.match(/^\/api\/subjects\/([^/]+)\/chapters$/);
  if (subjectChaptersMatch && method === 'GET') {
    const subjectId = decodeURIComponent(subjectChaptersMatch[1]).trim();
    const subjectDocs = await firestoreClient.listDocuments<Record<string, unknown>>('subjects', {
      pageSize: 100,
      maxPages: 2
    });
    const catalog = subjectDocs.length > 0 ? subjectDocs : INITIAL_SUBJECTS;
    const subject = catalog.find(s => String(s.id) === subjectId);
    if (!subject) {
      throw new WorkerHttpError(404, 'SUBJECT_NOT_FOUND', 'Subject not found.');
    }

    await ensureSanitizedQuestionsSyncedD1(db, firestoreClient, { ttlMs, nowMs });

    // Derive sanitized chapter/topic counts from D1 cache (only non-sensitive fields)
    const topicRows = await db
      .prepare(
        `SELECT COALESCE(NULLIF(topic_id, ''), 'general') AS chapter_id,
                COUNT(*) AS question_count
         FROM question_bank_cache
         WHERE subject_id = ?1
         GROUP BY COALESCE(NULLIF(topic_id, ''), 'general')
         ORDER BY chapter_id ASC`
      )
      .bind(subjectId)
      .all<{ chapter_id: string; question_count: number }>();

    return {
      status: 200,
      payload: {
        subject,
        chapters: topicRows.results.map(r => ({
          id: r.chapter_id,
          subjectId,
          questionCount: Number(r.question_count ?? 0)
        }))
      }
    };
  }

  if (pathname === '/api/packages' && method === 'GET') {
    const [pkgDocs, configDoc] = await Promise.all([
      firestoreClient.listDocuments<Record<string, unknown>>('packages', { pageSize: 50, maxPages: 2 }),
      firestoreClient.getDocument<Record<string, unknown>>('config', 'examDate')
    ]);

    const sourceList = (pkgDocs.length > 0 ? pkgDocs : INITIAL_PACKAGES) as unknown as SubscriptionPackage[];
    const examPassPrice =
      configDoc && typeof configDoc.examPassPrice === 'number'
        ? configDoc.examPassPrice
        : INITIAL_EXAM_DATE_CONFIG.examPassPrice;

    const mapped = sourceList
      .filter(p => p.isActive && !p.isArchived)
      .map(p => (p.id === 'pkg_exam_pass' ? { ...p, price: examPassPrice } : p));

    return { status: 200, payload: { packages: mapped } };
  }

  if (pathname === '/api/exam-config' && method === 'GET') {
    const configDoc = await firestoreClient.getDocument<Record<string, unknown>>('config', 'examDate');
    const examDateConfig = configDoc
      ? { ...INITIAL_EXAM_DATE_CONFIG, ...configDoc }
      : INITIAL_EXAM_DATE_CONFIG;
    return { status: 200, payload: { examDateConfig } };
  }

  if (pathname === '/api/payment-settings' && method === 'GET') {
    const [payDoc, supDoc] = await Promise.all([
      firestoreClient.getDocument<Record<string, unknown>>('config', 'paymentSettings'),
      firestoreClient.getDocument<Record<string, unknown>>('config', 'supportSettings')
    ]);
    const paymentSettings = {
      ...DEFAULT_PAYMENT_SETTINGS,
      ...(payDoc || {})
    };
    const supportSettings = {
      ...DEFAULT_SUPPORT_SETTINGS,
      ...(supDoc || {})
    };
    if (supDoc) {
      paymentSettings.whatsappNumber = supportSettings.whatsappNumber;
      paymentSettings.whatsappMessage = supportSettings.whatsappMessage;
    }
    return { status: 200, payload: { paymentSettings, supportSettings } };
  }

  if (pathname === '/api/support-settings' && method === 'GET') {
    const supDoc = await firestoreClient.getDocument<Record<string, unknown>>('config', 'supportSettings');
    const supportSettings = {
      ...DEFAULT_SUPPORT_SETTINGS,
      ...(supDoc || {})
    };
    return { status: 200, payload: { supportSettings } };
  }

  if (pathname === '/api/exams' && method === 'GET') {
    const examDocs = await firestoreClient.listDocuments<Record<string, unknown>>('exams', {
      pageSize: 200,
      maxPages: 5
    });
    const examList = examDocs.map(d => ({
      ...d,
      isActive: d.isActive !== undefined ? d.isActive : (!d.isPaid || d.id === 'exam_model_test_01'),
      scheduledDate: typeof d.scheduledDate === 'string' && d.scheduledDate ? d.scheduledDate : undefined
    }));
    return { status: 200, payload: { exams: examList } };
  }

  // ---------------------------------------------------------
  // 2. QUESTION BANK VERSION, SANITIZED RETRIEVAL & PRACTICE
  //    (NEVER exposes answer keys or explanations pre-submission!)
  // ---------------------------------------------------------
  if (pathname === '/api/questions/version' && method === 'GET') {
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
      nowIso: new Date(nowMs).toISOString()
    });

    const remote = await getRemoteQuestionBankVersion(firestoreClient);
    return { status: 200, payload: remote };
  }

  if (pathname === '/api/questions' && method === 'GET') {
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
      nowIso: new Date(nowMs).toISOString()
    });

    const subjectId = url.searchParams.get('subjectId')?.trim() || undefined;
    const topicId = url.searchParams.get('topicId')?.trim() || undefined;
    const examId = url.searchParams.get('examId')?.trim() || undefined;
    const search = url.searchParams.get('search')?.trim() || undefined;
    const demoOnly = url.searchParams.get('demoOnly') === 'true' || url.searchParams.get('demoOnly') === '1';
    const rawDifficulty = url.searchParams.get('difficulty')?.trim();
    if (rawDifficulty && rawDifficulty !== 'easy' && rawDifficulty !== 'medium' && rawDifficulty !== 'hard') {
      throw new WorkerHttpError(400, 'INVALID_REQUEST', 'Invalid difficulty filter.');
    }
    const difficulty = rawDifficulty as 'easy' | 'medium' | 'hard' | undefined;

    const safeLimit = parseOptionalIntParam(url.searchParams.get('limit'), 'limit', 1, 500);
    const safeOffset = parseOptionalIntParam(url.searchParams.get('offset'), 'offset', 0) ?? 0;

    await ensureSanitizedQuestionsSyncedD1(db, firestoreClient, { ttlMs, nowMs });

    if (examId) {
      const targetExamDoc = await firestoreClient.getDocument<Record<string, unknown>>('exams', examId);
      if (targetExamDoc) {
        const targetExam = targetExamDoc as unknown as Exam;
        if (targetExam.isPaid && !isOwnerUser(authUser, env)) {
          const subCheck = await checkUserHasActiveSubscriptionRest(firestoreClient, authUser.uid, nowMs);
          if (!subCheck.active) {
            throw new WorkerHttpError(
              403,
              'SUBSCRIPTION_REQUIRED',
              'Pro subscription required to access paid exam questions.'
            );
          }
        }

        const { questions: allMatching } = await querySanitizedQuestionsFromD1(db, {
          subjectId,
          topicId,
          difficulty,
          search,
          demoOnly
        });
        const examQuestions = getQuestionsForExam(targetExam, allMatching as unknown as Question[])
          .map(q => sanitizeQuestion(q as unknown as SanitizedQuestion));
        const total = examQuestions.length;

        if (safeLimit !== undefined) {
          const sliced = examQuestions.slice(safeOffset, safeOffset + safeLimit);
          return {
            status: 200,
            payload: {
              questions: sliced,
              total,
              limit: safeLimit,
              offset: safeOffset,
              hasMore: safeOffset + sliced.length < total
            }
          };
        }
        return { status: 200, payload: { questions: examQuestions, total } };
      }
    }

    const { questions, total } = await querySanitizedQuestionsFromD1(db, {
      subjectId,
      topicId,
      difficulty,
      search,
      demoOnly,
      limit: safeLimit,
      offset: safeOffset
    });

    const sanitized = questions.map(sanitizeQuestion);
    if (safeLimit !== undefined) {
      return {
        status: 200,
        payload: {
          questions: sanitized,
          total,
          limit: safeLimit,
          offset: safeOffset,
          hasMore: safeOffset + sanitized.length < total
        }
      };
    }

    return {
      status: 200,
      payload: {
        questions: sanitized,
        total
      }
    };
  }

  if (pathname === '/api/practice/questions' && method === 'GET') {
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
      nowIso: new Date(nowMs).toISOString()
    });

    const subjectId = url.searchParams.get('subjectId')?.trim() || undefined;
    const topicId = url.searchParams.get('topicId')?.trim() || undefined;
    const search = url.searchParams.get('search')?.trim() || undefined;
    const paidOnly = url.searchParams.get('paidOnly') === 'true' || url.searchParams.get('paidOnly') === '1';
    const rawDifficulty = url.searchParams.get('difficulty')?.trim();
    if (rawDifficulty && rawDifficulty !== 'easy' && rawDifficulty !== 'medium' && rawDifficulty !== 'hard') {
      throw new WorkerHttpError(400, 'INVALID_REQUEST', 'Invalid difficulty filter.');
    }
    const difficulty = rawDifficulty as 'easy' | 'medium' | 'hard' | undefined;

    const requestedLimit = parseOptionalIntParam(url.searchParams.get('limit'), 'limit', 1, 100) ?? 20;
    const safeOffset = parseOptionalIntParam(url.searchParams.get('offset'), 'offset', 0) ?? 0;

    const isOwner = isOwnerUser(authUser, env);
    const subActive = isOwner
      ? true
      : (await checkUserHasActiveSubscriptionRest(firestoreClient, authUser.uid, nowMs)).active;

    if (paidOnly && !subActive) {
      throw new WorkerHttpError(
        403,
        'SUBSCRIPTION_REQUIRED',
        'বিষয়ভিত্তিক পূর্ণাঙ্গ প্রশ্ন ও উত্তর যাচাইয়ের জন্য সক্রিয় প্রো সাবস্ক্রিপশন প্রয়োজন।'
      );
    }

    await ensureSanitizedQuestionsSyncedD1(db, firestoreClient, { ttlMs, nowMs });

    const effectiveLimit = subActive ? requestedLimit : Math.min(10, requestedLimit);
    const { questions, total } = await querySanitizedQuestionsFromD1(db, {
      subjectId,
      topicId,
      difficulty,
      search,
      demoOnly: !subActive,
      limit: effectiveLimit,
      offset: subActive ? safeOffset : 0
    });

    const sanitized = questions.map(sanitizeQuestion);
    const appliedOffset = subActive ? safeOffset : 0;

    return {
      status: 200,
      payload: {
        questions: sanitized,
        total,
        limit: effectiveLimit,
        offset: appliedOffset,
        hasMore: appliedOffset + sanitized.length < total,
        subscriptionActive: subActive,
        demoOnlyApplied: !subActive
      }
    };
  }

  if (pathname === '/api/practice/check' && method === 'POST') {
    const authUser = await authenticateFirebaseRequest(ctx.request, {
      projectId,
      environment: env.ENVIRONMENT,
      jwksFetcher: ctx.jwksFetcher,
      tokenVerifier: ctx.tokenVerifier,
      nowMs
    });

    const practiceCheckMax = ctx.rateLimitOverrides?.routeMax?.practice_check ?? 30;
    const rateResult: RateLimitResult = await consumeRateLimitD1(db, {
      key: `practice_check:uid_${authUser.uid}`,
      windowMs,
      maxRequests: practiceCheckMax,
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
          message: `অতিরিক্ত অনুরোধ পাঠানো হয়েছে। অনুগ্রহ করে ${rateResult.retryAfterSeconds} সেকেন্ড পর আবার চেষ্টা করুন।`
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
      nowIso: new Date(nowMs).toISOString()
    });

    const body = await parseJsonObjectBody(ctx.request);
    const questionId = typeof body.questionId === 'string' ? body.questionId.trim() : '';
    const selectedOption = body.selectedOption;

    if (
      !questionId ||
      questionId.length > 128 ||
      typeof selectedOption !== 'number' ||
      !Number.isInteger(selectedOption) ||
      selectedOption < 0 ||
      selectedOption > 3
    ) {
      throw new WorkerHttpError(
        400,
        'INVALID_REQUEST',
        'Valid questionId and integer selectedOption (0-3) are required.'
      );
    }

    const qMeta = await getSanitizedQuestionMeta(db, firestoreClient, questionId);
    if (!qMeta) {
      throw new WorkerHttpError(404, 'QUESTION_NOT_FOUND', 'Question not found.');
    }

    if (!qMeta.isDemoSample && !isOwnerUser(authUser, env)) {
      const subCheck = await checkUserHasActiveSubscriptionRest(firestoreClient, authUser.uid, nowMs);
      if (!subCheck.active) {
        throw new WorkerHttpError(
          403,
          'SUBSCRIPTION_REQUIRED',
          'বিষয়ভিত্তিক অনুশীলন ও উত্তর যাচাইয়ের জন্য সক্রিয় প্রো সাবস্ক্রিপশন প্রয়োজন।'
        );
      }
    }

    const keyMap = await getAuthoritativeQuestionKeys(db, firestoreClient, [questionId], { ttlMs, nowMs });
    const qKey = keyMap.get(questionId);
    if (!qKey) {
      throw new WorkerHttpError(404, 'QUESTION_NOT_FOUND', 'Question answer key not found.');
    }

    const isCorrect = selectedOption === qKey.correctOptionIndex;
    return {
      status: 200,
      payload: {
        success: true,
        questionId: qMeta.id,
        isCorrect,
        correctOptionIndex: qKey.correctOptionIndex,
        explanationBn: qKey.explanationBn || '',
        explanationEn: qKey.explanationEn || '',
        legalReference: qKey.legalReference || qMeta.legalReference || ''
      },
      headers: rlHeaders
    };
  }

  // ---------------------------------------------------------
  // 3. OWNER ADMIN QUESTION BANK CRUD & CACHE INVALIDATION
  //    (Explicit Owner UID + Verified Email gate required — Service Account
  //     bypasses Firestore rules, so Worker MUST enforce strict authorization!)
  // ---------------------------------------------------------
  if (pathname === '/api/admin/questions' && method === 'GET') {
    const authUser = await authenticateFirebaseRequest(ctx.request, {
      projectId,
      environment: env.ENVIRONMENT,
      jwksFetcher: ctx.jwksFetcher,
      tokenVerifier: ctx.tokenVerifier,
      nowMs
    });
    assertOwnerAdmin(authUser, env);

    const list = await fetchAllQuestionsWithKeysAuthoritative(firestoreClient);
    return { status: 200, payload: { questions: list } };
  }

  if (pathname === '/api/admin/questions' && method === 'POST') {
    const authUser = await authenticateFirebaseRequest(ctx.request, {
      projectId,
      environment: env.ENVIRONMENT,
      jwksFetcher: ctx.jwksFetcher,
      tokenVerifier: ctx.tokenVerifier,
      nowMs
    });
    assertOwnerAdmin(authUser, env);

    const q = await parseJsonObjectBody(ctx.request);
    const validSubjectIds = new Set(INITIAL_SUBJECTS.map(s => s.id));
    const cleanQuestionBn = typeof q.questionBn === 'string' ? q.questionBn.trim() : '';
    const cleanOptionsBn = Array.isArray(q.optionsBn)
      ? q.optionsBn.map(opt => (typeof opt === 'string' ? opt.trim() : ''))
      : [];
    const correctIdx = q.correctOptionIndex;

    if (
      !cleanQuestionBn ||
      cleanQuestionBn.length > 1000 ||
      typeof q.subjectId !== 'string' ||
      !validSubjectIds.has(q.subjectId) ||
      cleanOptionsBn.length !== 4 ||
      cleanOptionsBn.some(opt => !opt) ||
      typeof correctIdx !== 'number' ||
      !Number.isInteger(correctIdx) ||
      correctIdx < 0 ||
      correctIdx > 3
    ) {
      throw new WorkerHttpError(
        400,
        'INVALID_QUESTION',
        'Valid subjectId, questionBn (<= 1000 chars), 4 non-empty optionsBn, and integer correctOptionIndex (0-3) are required.'
      );
    }

    const cleanOptionsEn =
      Array.isArray(q.optionsEn) &&
      q.optionsEn.length === 4 &&
      q.optionsEn.every(opt => typeof opt === 'string' && opt.trim())
        ? (q.optionsEn as string[]).map(opt => opt.trim())
        : cleanOptionsBn;

    const nowIso = new Date(nowMs).toISOString();
    const qId =
      typeof q.id === 'string' && q.id.trim()
        ? q.id.trim().slice(0, 128)
        : `q_custom_${nowMs}_${Math.random().toString(36).slice(2, 7)}`;

    const fullQ: ServerQuestion = {
      id: qId,
      subjectId: q.subjectId,
      ...(typeof q.topicId === 'string' && q.topicId.trim()
        ? { topicId: q.topicId.trim().slice(0, 64) }
        : {}),
      questionBn: cleanQuestionBn,
      questionEn:
        typeof q.questionEn === 'string' && q.questionEn.trim()
          ? q.questionEn.trim().slice(0, 1000)
          : cleanQuestionBn,
      optionsBn: cleanOptionsBn,
      optionsEn: cleanOptionsEn,
      correctOptionIndex: correctIdx,
      explanationBn: typeof q.explanationBn === 'string' ? q.explanationBn.trim().slice(0, 2000) : '',
      explanationEn: typeof q.explanationEn === 'string' ? q.explanationEn.trim().slice(0, 2000) : '',
      legalReference: typeof q.legalReference === 'string' ? q.legalReference.trim().slice(0, 200) : '',
      difficulty: q.difficulty === 'easy' || q.difficulty === 'hard' ? q.difficulty : 'medium',
      status: q.status === 'draft' || q.status === 'reviewed' ? q.status : 'published',
      isDemoSample: Boolean(q.isDemoSample),
      createdAt: typeof q.createdAt === 'string' && q.createdAt.trim() ? q.createdAt.trim() : nowIso,
      updatedAt: nowIso,
      createdBy:
        typeof q.createdBy === 'string' && q.createdBy.trim() ? q.createdBy.trim().slice(0, 100) : 'Owner Admin'
    };

    const versionPayload = createQuestionBankVersionPayload(nowIso, nowMs);
    const auditEntry: AuditLog = {
      id: `log_${nowMs}_${Math.random().toString(36).slice(2, 6)}`,
      userId: authUser.uid,
      userName: authUser.email || 'Owner Admin',
      action: 'SAVE_QUESTION',
      details: `Saved question ${fullQ.id} (${fullQ.subjectId})`,
      timestamp: nowIso
    };

    await firestoreClient.commitWrites([
      {
        type: 'set',
        collection: 'questions',
        docId: fullQ.id,
        data: sanitizeQuestion(fullQ) as unknown as Record<string, unknown>
      },
      {
        type: 'set',
        collection: 'questionKeys',
        docId: fullQ.id,
        data: {
          correctOptionIndex: fullQ.correctOptionIndex,
          explanationBn: fullQ.explanationBn,
          explanationEn: fullQ.explanationEn,
          legalReference: fullQ.legalReference || '',
          updatedAt: nowIso
        }
      },
      {
        type: 'set',
        collection: 'config',
        docId: 'questionBankVersion',
        data: versionPayload
      },
      {
        type: 'set',
        collection: 'auditLogs',
        docId: auditEntry.id,
        data: { ...auditEntry }
      }
    ]);

    await upsertSingleQuestionCacheD1(db, fullQ, versionPayload.versionToken, nowIso, {
      onlyIfCacheInitialized: true
    });
    return {
      status: 200,
      payload: {
        success: true,
        question: fullQ,
        versionToken: versionPayload.versionToken
      }
    };
  }

  if (pathname === '/api/admin/questions/invalidate-cache' && method === 'POST') {
    const authUser = await authenticateFirebaseRequest(ctx.request, {
      projectId,
      environment: env.ENVIRONMENT,
      jwksFetcher: ctx.jwksFetcher,
      tokenVerifier: ctx.tokenVerifier,
      nowMs
    });
    assertOwnerAdmin(authUser, env);

    const nowIso = new Date(nowMs).toISOString();
    const versionPayload = createQuestionBankVersionPayload(nowIso, nowMs);
    const auditEntry: AuditLog = {
      id: `log_${nowMs}_${Math.random().toString(36).slice(2, 6)}`,
      userId: authUser.uid,
      userName: authUser.email || 'Owner Admin',
      action: 'INVALIDATE_QUESTION_CACHE',
      details: `Owner invalidated question bank cache (token: ${versionPayload.versionToken})`,
      timestamp: nowIso
    };

    await firestoreClient.commitWrites([
      {
        type: 'set',
        collection: 'config',
        docId: 'questionBankVersion',
        data: versionPayload
      },
      {
        type: 'set',
        collection: 'auditLogs',
        docId: auditEntry.id,
        data: { ...auditEntry }
      }
    ]);

    await invalidateLocalD1QuestionCache(db);
    return {
      status: 200,
      payload: {
        success: true,
        version: versionPayload
      }
    };
  }

  const deleteMatch = pathname.match(/^\/api\/admin\/questions\/([^/]+)$/);
  if (deleteMatch && method === 'DELETE') {
    const authUser = await authenticateFirebaseRequest(ctx.request, {
      projectId,
      environment: env.ENVIRONMENT,
      jwksFetcher: ctx.jwksFetcher,
      tokenVerifier: ctx.tokenVerifier,
      nowMs
    });
    assertOwnerAdmin(authUser, env);

    const questionId = decodeURIComponent(deleteMatch[1]).trim();
    if (!questionId || questionId.length > 128) {
      throw new WorkerHttpError(400, 'INVALID_REQUEST', 'Valid questionId is required.');
    }

    const nowIso = new Date(nowMs).toISOString();
    const versionPayload = createQuestionBankVersionPayload(nowIso, nowMs);
    const auditEntry: AuditLog = {
      id: `log_${nowMs}_${Math.random().toString(36).slice(2, 6)}`,
      userId: authUser.uid,
      userName: authUser.email || 'Owner Admin',
      action: 'DELETE_QUESTION',
      details: `Deleted question ${questionId}`,
      timestamp: nowIso
    };

    await firestoreClient.commitWrites([
      { type: 'delete', collection: 'questions', docId: questionId },
      { type: 'delete', collection: 'questionKeys', docId: questionId },
      { type: 'set', collection: 'config', docId: 'questionBankVersion', data: versionPayload },
      { type: 'set', collection: 'auditLogs', docId: auditEntry.id, data: { ...auditEntry } }
    ]);

    await deleteQuestionFromCacheD1(db, questionId, versionPayload.versionToken, nowIso);
    return {
      status: 200,
      payload: {
        success: true,
        versionToken: versionPayload.versionToken
      }
    };
  }

  return null;
}
