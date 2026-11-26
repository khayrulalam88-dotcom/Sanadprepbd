import { INITIAL_SUBJECTS } from '../src/data/mockData.ts';
import {
  assertOwnerAdmin,
  authenticateFirebaseRequest,
  type JwksFetcher
} from './firebaseAuth.ts';
import {
  FirestoreRestClient,
  type FirestoreWriteOp
} from './firestoreRest.ts';
import { writeAuditLogD1 } from './d1Store.ts';
import { createQuestionBankVersionPayload } from './questionCache.ts';
import {
  WorkerHttpError,
  type AuditLog,
  type DecodedAuthUser,
  type WorkerEnv
} from './types.ts';

export const MAX_SEED_BODY_BYTES = 524_288;
export const MAX_SEED_QUESTIONS_PER_BATCH = 100;
export const MAX_SEED_EXAMS_PER_BATCH = 50;
export const MAX_SEED_WRITES_PER_BATCH = 200;

export interface SeedRouteContext {
  request: Request;
  pathname: string;
  method: string;
  env: WorkerEnv;
  projectId: string;
  nowMs: number;
  firestoreClient: FirestoreRestClient;
  jwksFetcher?: JwksFetcher;
  tokenVerifier?: (idToken: string) => Promise<DecodedAuthUser>;
}

export interface SeedRouteResult {
  status: number;
  payload: unknown;
  headers?: Record<string, string>;
}

export interface SeedConflict {
  collection: 'questions' | 'questionKeys' | 'exams' | 'config';
  docId: string;
  reason: string;
}

const VALID_SUBJECT_IDS = new Set(INITIAL_SUBJECTS.map(s => s.id));

async function parseSeedJsonObjectBody(request: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get('content-length') || '0');
  if (Number.isFinite(contentLength) && contentLength > MAX_SEED_BODY_BYTES) {
    throw new WorkerHttpError(
      413,
      'PAYLOAD_TOO_LARGE',
      `Seed batch payload exceeds ${MAX_SEED_BODY_BYTES} byte limit.`
    );
  }
  const raw = await request.text();
  if (!raw || !raw.trim()) {
    return {};
  }
  if (raw.length > MAX_SEED_BODY_BYTES) {
    throw new WorkerHttpError(
      413,
      'PAYLOAD_TOO_LARGE',
      `Seed batch payload exceeds ${MAX_SEED_BODY_BYTES} byte limit.`
    );
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

function cleanSeedDocId(raw: unknown, label: string): string {
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!id || id.length > 128 || id.includes('/') || id.includes('..')) {
    throw new WorkerHttpError(400, 'INVALID_SEED_PAYLOAD', `Invalid ${label} document id.`);
  }
  return id;
}

function arraysEqual(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function buildSeedSanitizedQuestionDoc(
  q: Record<string, unknown>,
  fallbackIso: string
): Record<string, unknown> {
  const id = cleanSeedDocId(q.id, 'question');
  const subjectId = typeof q.subjectId === 'string' ? q.subjectId.trim() : '';
  if (!subjectId || !VALID_SUBJECT_IDS.has(subjectId)) {
    throw new WorkerHttpError(400, 'INVALID_SEED_PAYLOAD', `Question "${id}" has invalid subjectId.`);
  }

  const questionBn = typeof q.questionBn === 'string' ? q.questionBn.trim() : '';
  if (!questionBn || questionBn.length > 2000) {
    throw new WorkerHttpError(400, 'INVALID_SEED_PAYLOAD', `Question "${id}" has invalid questionBn.`);
  }

  const optionsBn = Array.isArray(q.optionsBn)
    ? q.optionsBn.map(o => (typeof o === 'string' ? o.trim() : String(o ?? '').trim()))
    : [];
  if (optionsBn.length !== 4 || optionsBn.some(o => !o)) {
    throw new WorkerHttpError(
      400,
      'INVALID_SEED_PAYLOAD',
      `Question "${id}" must have 4 non-empty optionsBn.`
    );
  }

  const optionsEn =
    Array.isArray(q.optionsEn) &&
    q.optionsEn.length === 4 &&
    q.optionsEn.every(o => String(o ?? '').trim())
      ? q.optionsEn.map(o => String(o ?? '').trim())
      : [...optionsBn];

  const difficulty = q.difficulty === 'easy' || q.difficulty === 'hard' ? q.difficulty : 'medium';
  const status = q.status === 'draft' || q.status === 'reviewed' ? q.status : 'published';
  const topicId = typeof q.topicId === 'string' && q.topicId.trim() ? q.topicId.trim() : undefined;
  const createdBy = typeof q.createdBy === 'string' && q.createdBy.trim() ? q.createdBy.trim() : undefined;

  return {
    id,
    subjectId,
    ...(topicId ? { topicId } : {}),
    questionBn,
    questionEn: typeof q.questionEn === 'string' && q.questionEn.trim() ? q.questionEn.trim() : questionBn,
    optionsBn,
    optionsEn,
    legalReference: typeof q.legalReference === 'string' ? q.legalReference : '',
    difficulty,
    status,
    isDemoSample: Boolean(q.isDemoSample),
    createdAt: typeof q.createdAt === 'string' && q.createdAt ? q.createdAt : fallbackIso,
    updatedAt: typeof q.updatedAt === 'string' && q.updatedAt ? q.updatedAt : fallbackIso,
    ...(createdBy ? { createdBy } : {})
  };
}

export function buildSeedQuestionKeyDoc(
  q: Record<string, unknown>,
  fallbackIso: string
): Record<string, unknown> {
  const id = cleanSeedDocId(q.id, 'questionKey');
  const correctIdx = q.correctOptionIndex;
  if (
    typeof correctIdx !== 'number' ||
    !Number.isInteger(correctIdx) ||
    correctIdx < 0 ||
    correctIdx > 3
  ) {
    throw new WorkerHttpError(
      400,
      'INVALID_SEED_PAYLOAD',
      `Question "${id}" must have integer correctOptionIndex (0-3).`
    );
  }
  return {
    correctOptionIndex: correctIdx,
    explanationBn: typeof q.explanationBn === 'string' ? q.explanationBn : '',
    explanationEn: typeof q.explanationEn === 'string' ? q.explanationEn : '',
    legalReference: typeof q.legalReference === 'string' ? q.legalReference : '',
    updatedAt: typeof q.updatedAt === 'string' && q.updatedAt ? q.updatedAt : fallbackIso
  };
}

export function buildSeedExamDoc(
  exam: Record<string, unknown>,
  fallbackIso: string
): Record<string, unknown> {
  const id = cleanSeedDocId(exam.id, 'exam');
  const titleBn = typeof exam.titleBn === 'string' ? exam.titleBn.trim() : '';
  if (!titleBn) {
    throw new WorkerHttpError(400, 'INVALID_SEED_PAYLOAD', `Exam "${id}" is missing titleBn.`);
  }
  const questionIds = Array.isArray(exam.questionIds)
    ? exam.questionIds.map(qId => String(qId ?? '').trim()).filter(Boolean)
    : [];
  if (questionIds.length === 0) {
    throw new WorkerHttpError(400, 'INVALID_SEED_PAYLOAD', `Exam "${id}" has empty questionIds.`);
  }

  const durationMinutes = Number(exam.durationMinutes ?? 60);
  const totalMarks = Number(exam.totalMarks ?? questionIds.length);
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    throw new WorkerHttpError(400, 'INVALID_SEED_PAYLOAD', `Exam "${id}" has invalid durationMinutes.`);
  }
  if (!Number.isFinite(totalMarks) || totalMarks <= 0) {
    throw new WorkerHttpError(400, 'INVALID_SEED_PAYLOAD', `Exam "${id}" has invalid totalMarks.`);
  }

  return {
    id,
    titleBn,
    titleEn: typeof exam.titleEn === 'string' && exam.titleEn.trim() ? exam.titleEn.trim() : titleBn,
    descriptionBn: typeof exam.descriptionBn === 'string' ? exam.descriptionBn : '',
    descriptionEn: typeof exam.descriptionEn === 'string' ? exam.descriptionEn : '',
    type: typeof exam.type === 'string' && exam.type.trim() ? exam.type.trim() : 'full_mock',
    durationMinutes,
    totalMarks,
    passThresholdPercentage: Number(exam.passThresholdPercentage ?? 50),
    questionIds,
    isPaid: Boolean(exam.isPaid),
    isActive:
      exam.isActive !== undefined
        ? Boolean(exam.isActive)
        : !exam.isPaid || id === 'exam_model_test_01',
    published: Boolean(exam.published),
    releaseExplanationsImmediately: exam.releaseExplanationsImmediately ?? true,
    subjectId: exam.subjectId ?? null,
    negativeMarkRatio: Number(exam.negativeMarkRatio ?? 0.25),
    positiveMarkRatio: Number(exam.positiveMarkRatio ?? 1.0),
    createdAt: typeof exam.createdAt === 'string' && exam.createdAt ? exam.createdAt : fallbackIso,
    updatedAt: typeof exam.updatedAt === 'string' && exam.updatedAt ? exam.updatedAt : fallbackIso,
    scheduledDate: exam.scheduledDate ?? null
  };
}

export function findSeedQuestionConflictReason(
  existing: Record<string, unknown>,
  expected: Record<string, unknown>
): string | null {
  if (
    'correctOptionIndex' in existing ||
    'explanationBn' in existing ||
    'explanationEn' in existing
  ) {
    return 'Existing /questions doc contains embedded answer key or explanation fields.';
  }
  if (String(existing.subjectId ?? '') !== expected.subjectId) return 'subjectId mismatch';
  if (String(existing.questionBn ?? '').trim() !== expected.questionBn) return 'questionBn mismatch';
  if (String(existing.questionEn ?? '').trim() !== expected.questionEn) return 'questionEn mismatch';
  if (!arraysEqual(existing.optionsBn, expected.optionsBn)) return 'optionsBn mismatch';
  if (!arraysEqual(existing.optionsEn, expected.optionsEn)) return 'optionsEn mismatch';
  if (String(existing.legalReference ?? '') !== expected.legalReference) return 'legalReference mismatch';
  if (String(existing.difficulty ?? 'medium') !== expected.difficulty) return 'difficulty mismatch';
  if (String(existing.status ?? 'published') !== expected.status) return 'status mismatch';
  if (Boolean(existing.isDemoSample) !== expected.isDemoSample) return 'isDemoSample mismatch';
  if ((existing.topicId ?? null) !== (expected.topicId ?? null)) return 'topicId mismatch';
  return null;
}

export function findSeedQuestionKeyConflictReason(
  existing: Record<string, unknown>,
  expected: Record<string, unknown>
): string | null {
  if (Number(existing.correctOptionIndex) !== expected.correctOptionIndex) {
    return 'correctOptionIndex mismatch';
  }
  if (String(existing.explanationBn ?? '') !== expected.explanationBn) {
    return 'explanationBn mismatch';
  }
  if (String(existing.explanationEn ?? '') !== expected.explanationEn) {
    return 'explanationEn mismatch';
  }
  if (String(existing.legalReference ?? '') !== expected.legalReference) {
    return 'legalReference mismatch';
  }
  return null;
}

export function findSeedExamConflictReason(
  existing: Record<string, unknown>,
  expected: Record<string, unknown>
): string | null {
  // Preserve Admin-customizable exam settings (isActive, scheduledDate, isPaid, published, passThresholdPercentage)
  if (String(existing.type ?? 'full_mock') !== expected.type) return 'type mismatch';
  if (Number(existing.durationMinutes) !== expected.durationMinutes) return 'durationMinutes mismatch';
  if (Number(existing.totalMarks) !== expected.totalMarks) return 'totalMarks mismatch';
  if ((existing.subjectId ?? null) !== (expected.subjectId ?? null)) return 'subjectId mismatch';
  if (!arraysEqual(existing.questionIds, expected.questionIds)) return 'questionIds mismatch';
  return null;
}

export async function handleQuestionBankSeedRoutes(
  ctx: SeedRouteContext
): Promise<SeedRouteResult | null> {
  const { pathname, method, env, projectId, nowMs, firestoreClient } = ctx;
  const db = env.DB!;
  const nowIso = new Date(nowMs).toISOString();

  if (pathname === '/api/admin/seed/question-bank/batch' && method === 'POST') {
    const authUser = await authenticateFirebaseRequest(ctx.request, {
      projectId,
      environment: env.ENVIRONMENT,
      jwksFetcher: ctx.jwksFetcher,
      tokenVerifier: ctx.tokenVerifier,
      nowMs
    });
    assertOwnerAdmin(authUser, env);

    const body = await parseSeedJsonObjectBody(ctx.request);
    if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') {
      throw new WorkerHttpError(400, 'INVALID_SEED_PAYLOAD', 'dryRun must be a boolean.');
    }
    const dryRun = body.dryRun !== false;

    const rawQuestions = body.questions === undefined ? [] : body.questions;
    const rawExams = body.exams === undefined ? [] : body.exams;
    if (!Array.isArray(rawQuestions) || !Array.isArray(rawExams)) {
      throw new WorkerHttpError(400, 'INVALID_SEED_PAYLOAD', 'questions and exams must be arrays.');
    }
    if (rawQuestions.length === 0 && rawExams.length === 0) {
      throw new WorkerHttpError(
        400,
        'INVALID_SEED_PAYLOAD',
        'Batch must contain at least one question or exam.'
      );
    }
    if (rawQuestions.length > MAX_SEED_QUESTIONS_PER_BATCH) {
      throw new WorkerHttpError(
        400,
        'BATCH_TOO_LARGE',
        `At most ${MAX_SEED_QUESTIONS_PER_BATCH} questions per seed batch are allowed.`
      );
    }
    if (rawExams.length > MAX_SEED_EXAMS_PER_BATCH) {
      throw new WorkerHttpError(
        400,
        'BATCH_TOO_LARGE',
        `At most ${MAX_SEED_EXAMS_PER_BATCH} exams per seed batch are allowed.`
      );
    }
    if (rawQuestions.length * 2 + rawExams.length > MAX_SEED_WRITES_PER_BATCH) {
      throw new WorkerHttpError(
        400,
        'BATCH_TOO_LARGE',
        `Total planned writes per batch must not exceed ${MAX_SEED_WRITES_PER_BATCH}.`
      );
    }

    const normalizedQuestions = rawQuestions.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new WorkerHttpError(400, 'INVALID_SEED_PAYLOAD', 'Each question must be an object.');
      }
      const qObj = item as Record<string, unknown>;
      const sanitized = buildSeedSanitizedQuestionDoc(qObj, nowIso);
      const key = buildSeedQuestionKeyDoc(qObj, nowIso);
      return {
        id: String(sanitized.id),
        sanitized,
        key
      };
    });

    const normalizedExams = rawExams.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new WorkerHttpError(400, 'INVALID_SEED_PAYLOAD', 'Each exam must be an object.');
      }
      const exam = buildSeedExamDoc(item as Record<string, unknown>, nowIso);
      return {
        id: String(exam.id),
        exam
      };
    });

    const seenQIds = new Set<string>();
    for (const q of normalizedQuestions) {
      if (seenQIds.has(q.id)) {
        throw new WorkerHttpError(400, 'DUPLICATE_IN_BATCH', `Duplicate question id "${q.id}" in batch.`);
      }
      seenQIds.add(q.id);
    }
    const seenExIds = new Set<string>();
    for (const ex of normalizedExams) {
      if (seenExIds.has(ex.id)) {
        throw new WorkerHttpError(400, 'DUPLICATE_IN_BATCH', `Duplicate exam id "${ex.id}" in batch.`);
      }
      seenExIds.add(ex.id);
    }

    // Use Owner's Firebase ID token with :batchGet (separate per collection to avoid docId collisions)
    const ownerClient = firestoreClient.withToken(authUser.idToken);
    const [existingQuestionsMap, existingKeysMap, existingExamsMap] = await Promise.all([
      normalizedQuestions.length > 0
        ? ownerClient.batchGetDocuments<Record<string, unknown>>(
            normalizedQuestions.map(q => ({ collection: 'questions', docId: q.id }))
          )
        : Promise.resolve(new Map<string, Record<string, unknown> & { id: string }>()),
      normalizedQuestions.length > 0
        ? ownerClient.batchGetDocuments<Record<string, unknown>>(
            normalizedQuestions.map(q => ({ collection: 'questionKeys', docId: q.id }))
          )
        : Promise.resolve(new Map<string, Record<string, unknown> & { id: string }>()),
      normalizedExams.length > 0
        ? ownerClient.batchGetDocuments<Record<string, unknown>>(
            normalizedExams.map(ex => ({ collection: 'exams', docId: ex.id }))
          )
        : Promise.resolve(new Map<string, Record<string, unknown> & { id: string }>())
    ]);

    const conflicts: SeedConflict[] = [];
    const matching = { questions: 0, questionKeys: 0, exams: 0 };
    const missingOps: FirestoreWriteOp[] = [];
    const wouldCreate = { questions: 0, questionKeys: 0, exams: 0, total: 0 };

    for (const item of normalizedQuestions) {
      const existingQ = existingQuestionsMap.get(item.id);
      if (!existingQ) {
        missingOps.push({
          type: 'create',
          collection: 'questions',
          docId: item.id,
          data: item.sanitized
        });
        wouldCreate.questions += 1;
      } else {
        const reason = findSeedQuestionConflictReason(existingQ, item.sanitized);
        if (reason) {
          conflicts.push({ collection: 'questions', docId: item.id, reason });
        } else {
          matching.questions += 1;
        }
      }

      const existingKey = existingKeysMap.get(item.id);
      if (!existingKey) {
        missingOps.push({
          type: 'create',
          collection: 'questionKeys',
          docId: item.id,
          data: item.key
        });
        wouldCreate.questionKeys += 1;
      } else {
        const reason = findSeedQuestionKeyConflictReason(existingKey, item.key);
        if (reason) {
          conflicts.push({ collection: 'questionKeys', docId: item.id, reason });
        } else {
          matching.questionKeys += 1;
        }
      }
    }

    for (const item of normalizedExams) {
      const existingExam = existingExamsMap.get(item.id);
      if (!existingExam) {
        missingOps.push({
          type: 'create',
          collection: 'exams',
          docId: item.id,
          data: item.exam
        });
        wouldCreate.exams += 1;
      } else {
        const reason = findSeedExamConflictReason(existingExam, item.exam);
        if (reason) {
          conflicts.push({ collection: 'exams', docId: item.id, reason });
        } else {
          matching.exams += 1;
        }
      }
    }

    wouldCreate.total = missingOps.length;
    const existingCounts = {
      questions: existingQuestionsMap.size,
      questionKeys: existingKeysMap.size,
      exams: existingExamsMap.size
    };

    if (conflicts.length > 0 && !dryRun) {
      return {
        status: 409,
        payload: {
          error: 'CONFLICT_DETECTED',
          message: `Aborting batch write: ${conflicts.length} conflict(s) detected. Zero writes committed.`,
          success: false,
          dryRun: false,
          executed: false,
          safeToExecute: false,
          existing: existingCounts,
          matching,
          wouldCreate,
          writesCommitted: 0,
          conflicts
        }
      };
    }

    if (dryRun) {
      return {
        status: 200,
        payload: {
          success: conflicts.length === 0,
          dryRun: true,
          executed: false,
          safeToExecute: conflicts.length === 0,
          existing: existingCounts,
          matching,
          wouldCreate,
          writesCommitted: 0,
          conflicts
        }
      };
    }

    if (missingOps.length > 0) {
      await ownerClient.commitWrites(missingOps);
    }

    return {
      status: 200,
      payload: {
        success: true,
        dryRun: false,
        executed: true,
        safeToExecute: true,
        existing: existingCounts,
        matching,
        wouldCreate,
        created: {
          questions: wouldCreate.questions,
          questionKeys: wouldCreate.questionKeys,
          exams: wouldCreate.exams,
          total: missingOps.length
        },
        writesCommitted: missingOps.length,
        conflicts: []
      }
    };
  }

  if (pathname === '/api/admin/seed/question-bank/finalize' && method === 'POST') {
    const authUser = await authenticateFirebaseRequest(ctx.request, {
      projectId,
      environment: env.ENVIRONMENT,
      jwksFetcher: ctx.jwksFetcher,
      tokenVerifier: ctx.tokenVerifier,
      nowMs
    });
    assertOwnerAdmin(authUser, env);

    const body = await parseSeedJsonObjectBody(ctx.request);
    if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') {
      throw new WorkerHttpError(400, 'INVALID_SEED_PAYLOAD', 'dryRun must be a boolean.');
    }
    const dryRun = body.dryRun !== false;
    const pendingDataWrites = Number(body.pendingDataWrites ?? 0);
    if (!Number.isFinite(pendingDataWrites) || pendingDataWrites < 0) {
      throw new WorkerHttpError(400, 'INVALID_SEED_PAYLOAD', 'pendingDataWrites must be >= 0.');
    }
    const totalQuestionsCommitted = Number(body.questionsCreated ?? 0);
    const totalKeysCommitted = Number(body.questionKeysCreated ?? 0);
    const totalExamsCommitted = Number(body.examsCreated ?? 0);

    const ownerClient = firestoreClient.withToken(authUser.idToken);
    const versionDoc = await ownerClient.getDocument<Record<string, unknown>>(
      'config',
      'questionBankVersion'
    );

    if (!versionDoc) {
      const versionPayload = createQuestionBankVersionPayload(nowIso, nowMs);
      if (dryRun) {
        return {
          status: 200,
          payload: {
            success: true,
            dryRun: true,
            executed: false,
            safeToExecute: true,
            versionExists: false,
            versionDocumentStatus: 'missing (will create last)',
            plannedVersionToken: versionPayload.versionToken,
            wouldCreateVersionDocument: 1,
            writesCommitted: 0,
            conflicts: []
          }
        };
      }

      const auditEntry: AuditLog = {
        id: `log_${nowMs}_${Math.random().toString(36).slice(2, 6)}`,
        userId: authUser.uid,
        userName: authUser.email || 'Owner Admin',
        action: 'SEED_QUESTION_BANK_WORKER',
        details: `Owner seeded question bank via Worker (created questions=${totalQuestionsCommitted}, keys=${totalKeysCommitted}, exams=${totalExamsCommitted}, versionToken=${versionPayload.versionToken}).`,
        timestamp: nowIso
      };

      await ownerClient.commitWrites([
        {
          type: 'create',
          collection: 'config',
          docId: 'questionBankVersion',
          data: { ...versionPayload }
        },
        {
          type: 'set',
          collection: 'auditLogs',
          docId: auditEntry.id,
          data: { ...auditEntry }
        }
      ]);
      await writeAuditLogD1(db, auditEntry, true).catch(() => undefined);

      return {
        status: 200,
        payload: {
          success: true,
          dryRun: false,
          executed: true,
          safeToExecute: true,
          versionExists: false,
          versionDocumentStatus: 'created',
          versionToken: versionPayload.versionToken,
          versionPayload,
          writesCommitted: 1,
          conflicts: []
        }
      };
    }

    const existingToken = String(versionDoc.versionToken || versionDoc.version || 'unknown');
    if (pendingDataWrites > 0) {
      const conflict: SeedConflict = {
        collection: 'config',
        docId: 'questionBankVersion',
        reason:
          'config/questionBankVersion already exists while missing documents remain; create-only seeder will not overwrite existing version document.'
      };
      if (!dryRun) {
        return {
          status: 409,
          payload: {
            error: 'CONFLICT_DETECTED',
            message: conflict.reason,
            success: false,
            dryRun: false,
            executed: false,
            safeToExecute: false,
            versionExists: true,
            versionDocumentStatus: `exists (versionToken=${existingToken})`,
            writesCommitted: 0,
            conflicts: [conflict]
          }
        };
      }
      return {
        status: 200,
        payload: {
          success: false,
          dryRun: true,
          executed: false,
          safeToExecute: false,
          versionExists: true,
          versionDocumentStatus: `exists (versionToken=${existingToken})`,
          wouldCreateVersionDocument: 0,
          writesCommitted: 0,
          conflicts: [conflict]
        }
      };
    }

    return {
      status: 200,
      payload: {
        success: true,
        dryRun,
        executed: !dryRun,
        safeToExecute: true,
        versionExists: true,
        versionDocumentStatus: `exists (versionToken=${existingToken}, up-to-date)`,
        existingVersionToken: existingToken,
        wouldCreateVersionDocument: 0,
        writesCommitted: 0,
        conflicts: []
      }
    };
  }

  return null;
}
