import type { Exam } from '../src/types/index.ts';
import { assertOwnerAdmin, authenticateFirebaseRequest, type JwksFetcher } from './firebaseAuth.ts';
import { getExamFromCacheD1 } from './d1Store.ts';
import { timestampToIso, type FirestoreRestClient } from './firestoreRest.ts';
import {
  getAuthoritativeQuestionKeys,
  querySanitizedQuestionsByIdsFromD1
} from './questionCache.ts';
import {
  CANONICAL_LEGACY_QUESTION_IDS,
  MODEL_TEST_2_REPAIR_SLOTS,
  TARGET_MODEL_TEST_2_EXAM_ID,
  validateLegalQuestionIntent
} from './examRepair.ts';
import {
  WorkerHttpError,
  type AuditLog,
  type D1Database,
  type DecodedAuthUser,
  type QuestionKeyRecord,
  type SanitizedQuestion,
  type WorkerEnv
} from './types.ts';

export { TARGET_MODEL_TEST_2_EXAM_ID };

export const CONVERSION_OPERATION_ID = 'convert_model_test_2_100_v1';
export const CONVERSION_AUDIT_LOG_ID = 'log_convert_model_test_2_100_v1';

export const REQUIRED_SUBJECT_DISTRIBUTION = {
  sub_cpc: 20,
  sub_crpc: 20,
  sub_penal: 20,
  sub_evidence: 15,
  sub_sra: 10,
  sub_limitation: 10,
  sub_bar_ethics: 5
} as const;

export const APPROVED_100_QUESTION_IDS: readonly string[] = [
  // CPC (20)
  'q_bank_0043', 'q_bank_0001', 'q_bank_0002', 'q_bank_0005', 'q_bank_0006',
  'q_bank_0007', 'q_bank_0008', 'q_bank_0010', 'q_bank_0011', 'q_bank_0012',
  'q_bank_0013', 'q_bank_0014', 'q_bank_0016', 'q_bank_0017', 'q_bank_0018',
  'q_bank_0019', 'q_bank_0020', 'q_bank_0022', 'q_bank_0023', 'q_bank_0024',
  // CrPC (20)
  'q_bank_3001', 'q_bank_0601', 'q_bank_0602', 'q_bank_0604', 'q_bank_0605',
  'q_bank_0606', 'q_bank_0607', 'q_bank_0608', 'q_bank_0610', 'q_bank_0611',
  'q_bank_0612', 'q_bank_0613', 'q_bank_0614', 'q_bank_0616', 'q_bank_0617',
  'q_bank_0618', 'q_bank_0619', 'q_bank_0620', 'q_bank_0622', 'q_bank_0623',
  // Penal Code (20)
  'q_bank_1292', 'q_bank_1201', 'q_bank_1202', 'q_bank_1204', 'q_bank_1205',
  'q_bank_1206', 'q_bank_1207', 'q_bank_1208', 'q_bank_1210', 'q_bank_1211',
  'q_bank_1212', 'q_bank_1213', 'q_bank_1214', 'q_bank_1216', 'q_bank_1217',
  'q_bank_1219', 'q_bank_1220', 'q_bank_1222', 'q_bank_1223', 'q_bank_1224',
  // Evidence Act (15)
  'q_bank_1874', 'q_bank_1801', 'q_bank_1802', 'q_bank_1804', 'q_bank_1805',
  'q_bank_1806', 'q_bank_1807', 'q_bank_1808', 'q_bank_1810', 'q_bank_1811',
  'q_bank_1813', 'q_bank_1814', 'q_bank_1816', 'q_bank_1817', 'q_bank_1818',
  // Specific Relief Act (10)
  'q_bank_2269', 'q_bank_2251', 'q_bank_2254', 'q_bank_2255', 'q_bank_2256',
  'q_bank_2257', 'q_bank_2258', 'q_bank_2260', 'q_bank_2261', 'q_bank_2262',
  // Limitation Act (10)
  'q_bank_2648', 'q_bank_2551', 'q_bank_2552', 'q_bank_2554', 'q_bank_2555',
  'q_bank_2556', 'q_bank_2557', 'q_bank_2558', 'q_bank_2560', 'q_bank_2561',
  // Bar Council & Ethics (5)
  'q_bank_2851', 'q_bank_2852', 'q_bank_2854', 'q_bank_2855', 'q_bank_2856'
] as const;

export const APPROVED_7_REPLACEMENTS_ORDERED: readonly string[] = [
  'q_bank_2648',
  'q_bank_2269',
  'q_bank_2851',
  'q_bank_3001',
  'q_bank_1292',
  'q_bank_1874',
  'q_bank_0043'
] as const;

const APPROVED_7_SLOT_INDEX_IN_100: Record<string, number> = {
  q_cpc_1: 0,
  q_crpc_1: 20,
  q_penal_1: 40,
  q_evi_1: 60,
  q_sra_1: 75,
  q_lim_1: 85,
  q_bco_1: 95
};

const APPROVED_7_EXPECTED_ID_BY_LEGACY: Record<string, string> = {
  q_lim_1: 'q_bank_2648',
  q_sra_1: 'q_bank_2269',
  q_bco_1: 'q_bank_2851',
  q_crpc_1: 'q_bank_3001',
  q_penal_1: 'q_bank_1292',
  q_evi_1: 'q_bank_1874',
  q_cpc_1: 'q_bank_0043'
};

export const CONVERTED_DESCRIPTION_BN =
  'অ্যাডমিন কর্তৃক প্রশ্ন সম্ভার থেকে তৈরিকৃত অফিসিয়াল মডেল টেস্ট। প্রশ্ন সংখ্যা: 100টি, সময়: 60 মিনিট। নেগেটিভ মার্কিং: 0.25।';
export const CONVERTED_DESCRIPTION_EN =
  'Curated model test conducted by Admin. Questions: 100, Duration: 60 mins. Negative marking: 0.25.';

export interface ExamConversionStateRecord {
  operationId: string;
  status: 'pending' | 'completed';
  targetQuestionCount: number;
  previousTotalMarks: number;
  startedAt: string;
  startedBy: string;
  completedAt?: string;
  completedBy?: string;
  auditLogId: string;
}

export interface ExamStateSnapshot {
  id: string;
  titleBn: string;
  titleEn: string;
  descriptionBn: string;
  descriptionEn: string;
  type: string;
  durationMinutes: number;
  totalMarks: number;
  passThresholdPercentage: number;
  isPaid: boolean;
  isActive: boolean;
  published: boolean;
  releaseExplanationsImmediately: boolean;
  negativeMarkRatio: number;
  positiveMarkRatio: number;
  questionCount: number;
  questionIds: string[];
  createdAt: string;
  updatedAt?: string;
  scheduledDate?: string;
  conversionState?: ExamConversionStateRecord;
}

export interface QuestionValidationFailure {
  questionId: string;
  code: string;
  reason: string;
}

export interface ApprovedMappingValidation {
  legacyQuestionId: string;
  expectedReplacementId: string;
  actualIdAtPosition: string | null;
  status: string;
  valid: boolean;
  reason: string;
}

export interface ExamConversionReport {
  examId: string;
  operationId: string;
  mode: 'dry_run' | 'executed' | 'recovered' | 'partial_failure';
  dryRun: boolean;
  safeToExecute: boolean;
  executed: boolean;
  recovered: boolean;
  alreadyConverted: boolean;
  recoveryRequired: boolean;
  conversionStatus: 'not_started' | 'pending' | 'completed';
  casConflict: boolean;
  currentUpdateTime: string | null;
  expectedUpdateTime: string | null;
  currentExamState: ExamStateSnapshot | null;
  proposedExamState: ExamStateSnapshot | null;
  subjectDistribution: {
    required: typeof REQUIRED_SUBJECT_DISTRIBUTION;
    actual: Record<string, number>;
    matched: boolean;
  };
  missingQuestionIds: {
    firestoreQuestions: string[];
    firestoreKeys: string[];
    d1Questions: string[];
    d1Keys: string[];
    allUniqueMissing: string[];
  };
  firestoreD1Parity: {
    ok: boolean;
    examMatches: boolean;
    questionCountMatched: number;
    keyCountMatched: number;
    mismatches: Array<{ questionId: string; reason: string }>;
  };
  keyIntegrity: {
    ok: boolean;
    totalChecked: number;
    validCount: number;
    invalidQuestions: QuestionValidationFailure[];
  };
  remedyTemplateViolations: Array<{ questionId: string; reason: string }>;
  approvedMappingsValidation: ApprovedMappingValidation[];
  matchesApprovedList: boolean;
  blockedReasons: string[];
  auditLogId?: string;
  convertedAt?: string;
}

export interface ExamConversionContext {
  request: Request;
  env: WorkerEnv;
  projectId: string;
  nowMs: number;
  firestoreClient: FirestoreRestClient;
  jwksFetcher?: JwksFetcher;
  tokenVerifier?: (idToken: string) => Promise<DecodedAuthUser>;
}

const LEGACY_ID_SET = new Set(CANONICAL_LEGACY_QUESTION_IDS);
const VALID_SUBJECT_KEYS = Object.keys(REQUIRED_SUBJECT_DISTRIBUTION) as Array<
  keyof typeof REQUIRED_SUBJECT_DISTRIBUTION
>;

async function parseConversionJsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get('content-length') || '0');
  if (Number.isFinite(contentLength) && contentLength > 65_536) {
    throw new WorkerHttpError(413, 'PAYLOAD_TOO_LARGE', 'Request payload too large.');
  }
  const raw = await request.text();
  if (!raw || !raw.trim()) {
    return {};
  }
  if (raw.length > 65_536) {
    throw new WorkerHttpError(413, 'PAYLOAD_TOO_LARGE', 'Request payload too large.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WorkerHttpError(400, 'INVALID_JSON', 'Invalid JSON request body.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WorkerHttpError(400, 'INVALID_REQUEST', 'Request body must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

function normalizeStringArrayStrict(val: unknown): string[] | null {
  if (!Array.isArray(val)) return null;
  const out: string[] = [];
  for (const item of val) {
    if (typeof item !== 'string' || !item.trim()) {
      return null;
    }
    out.push(item.trim());
  }
  return out;
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function hasRemedyForumTemplate(
  q: SanitizedQuestion | Record<string, unknown>,
  key?: QuestionKeyRecord | Record<string, unknown>
): boolean {
  const qObj = q as Record<string, unknown>;
  const kObj = key as Record<string, unknown> | undefined;
  const parts = [
    String(qObj.questionBn ?? ''),
    String(qObj.questionEn ?? ''),
    ...(Array.isArray(qObj.optionsBn) ? qObj.optionsBn.map(o => String(o ?? '')) : []),
    ...(Array.isArray(qObj.optionsEn) ? qObj.optionsEn.map(o => String(o ?? '')) : []),
    String(kObj?.explanationBn ?? ''),
    String(kObj?.explanationEn ?? '')
  ];
  const combined = parts.join('\n');
  return (
    /প্রতিকারের\s*সঠিক\s*ফোরাম/i.test(combined) ||
    /legal\s*recourse\s*or\s*remedy\s*against\s*a\s*judicial\s*decision/i.test(combined) ||
    /আপিল\s*\/\s*রিভিশন\s*বিধিমোতাবেক\s*উচ্চ\s*আদালতে\s*প্রতিকার/i.test(combined) ||
    /statutory\s*appeal\s*or\s*revision\s*before\s*the\s*appropriate\s*higher\s*forum/i.test(combined)
  );
}

function buildExamStateSnapshot(raw: Record<string, unknown>, examId: string): ExamStateSnapshot {
  const questionIds = Array.isArray(raw.questionIds)
    ? raw.questionIds.map(id => String(id).trim()).filter(Boolean)
    : [];
  const scheduledDate =
    typeof raw.scheduledDate === 'string' && raw.scheduledDate.trim()
      ? raw.scheduledDate.trim()
      : undefined;
  const conversionStateRaw = raw.conversionState;
  const conversionState =
    conversionStateRaw && typeof conversionStateRaw === 'object' && !Array.isArray(conversionStateRaw)
      ? (conversionStateRaw as ExamConversionStateRecord)
      : undefined;

  return {
    id: examId,
    titleBn: String(raw.titleBn ?? ''),
    titleEn: String(raw.titleEn ?? ''),
    descriptionBn: String(raw.descriptionBn ?? ''),
    descriptionEn: String(raw.descriptionEn ?? ''),
    type: String(raw.type ?? ''),
    durationMinutes: Number(raw.durationMinutes ?? 0),
    totalMarks: Number(raw.totalMarks ?? 0),
    passThresholdPercentage:
      raw.passThresholdPercentage !== undefined ? Number(raw.passThresholdPercentage) : 50,
    isPaid: Boolean(raw.isPaid),
    isActive: raw.isActive !== undefined ? Boolean(raw.isActive) : !raw.isPaid,
    published: Boolean(raw.published),
    releaseExplanationsImmediately: Boolean(raw.releaseExplanationsImmediately),
    negativeMarkRatio: Number(raw.negativeMarkRatio ?? 0.25),
    positiveMarkRatio: Number(raw.positiveMarkRatio ?? 1),
    questionCount: questionIds.length,
    questionIds,
    createdAt: timestampToIso(raw.createdAt) || String(raw.createdAt ?? ''),
    ...(raw.updatedAt !== undefined
      ? { updatedAt: timestampToIso(raw.updatedAt) || String(raw.updatedAt ?? '') }
      : {}),
    ...(scheduledDate ? { scheduledDate } : {}),
    ...(conversionState ? { conversionState } : {})
  };
}

function validatePreConversionSnapshot(snapshot: ExamStateSnapshot): string[] {
  const issues: string[] = [];
  if (snapshot.id !== TARGET_MODEL_TEST_2_EXAM_ID) {
    issues.push(`Unexpected exam id: ${snapshot.id}`);
  }
  if (snapshot.type !== 'full_mock') {
    issues.push(`Expected type="full_mock", found "${snapshot.type}".`);
  }
  if (snapshot.isPaid !== true) {
    issues.push('Expected isPaid=true to be preserved.');
  }
  if (snapshot.published !== true) {
    issues.push('Expected published=true to be preserved.');
  }
  if (snapshot.durationMinutes !== 60) {
    issues.push(`Expected durationMinutes=60, found ${snapshot.durationMinutes}.`);
  }
  if (snapshot.positiveMarkRatio !== 1) {
    issues.push(`Expected positiveMarkRatio=1, found ${snapshot.positiveMarkRatio}.`);
  }
  if (snapshot.negativeMarkRatio !== 0.25) {
    issues.push(`Expected negativeMarkRatio=0.25, found ${snapshot.negativeMarkRatio}.`);
  }
  if (snapshot.passThresholdPercentage !== 50) {
    issues.push(`Expected passThresholdPercentage=50, found ${snapshot.passThresholdPercentage}.`);
  }
  if (snapshot.totalMarks !== 7) {
    issues.push(`Expected pre-conversion totalMarks=7, found ${snapshot.totalMarks}.`);
  }
  const matchesLegacy7 = arraysEqual(snapshot.questionIds, CANONICAL_LEGACY_QUESTION_IDS);
  const matchesRepaired7 = arraysEqual(snapshot.questionIds, APPROVED_7_REPLACEMENTS_ORDERED);
  if (!matchesLegacy7 && !matchesRepaired7) {
    issues.push(
      `Firestore exam questionIds do not match expected 7-question pre-conversion snapshot (${CANONICAL_LEGACY_QUESTION_IDS.join(', ')}).`
    );
  }
  return issues;
}

async function upsertExamCacheOnlyD1(
  db: D1Database,
  examRecord: Exam & { updatedAt: string; conversionState?: ExamConversionStateRecord },
  updatedAtIso: string
): Promise<void> {
  const isActive = examRecord.isActive !== undefined ? Boolean(examRecord.isActive) : !examRecord.isPaid;
  const normalized = {
    ...examRecord,
    isActive
  };
  await db.batch([
    db
      .prepare(
        `INSERT INTO edge_exams_cache (id, is_paid, is_active, payload_json, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET
           is_paid = excluded.is_paid,
           is_active = excluded.is_active,
           payload_json = excluded.payload_json,
           updated_at = excluded.updated_at`
      )
      .bind(normalized.id, normalized.isPaid ? 1 : 0, isActive ? 1 : 0, JSON.stringify(normalized), updatedAtIso)
  ]);
}

async function commitExamConversionCompleteD1(
  db: D1Database,
  convertedExam: Exam & { updatedAt: string; conversionState?: ExamConversionStateRecord },
  auditEntry: AuditLog,
  updatedAtIso: string
): Promise<void> {
  const isActive = convertedExam.isActive !== undefined ? Boolean(convertedExam.isActive) : !convertedExam.isPaid;
  const normalized = {
    ...convertedExam,
    isActive
  };

  await db.batch([
    db
      .prepare(
        `INSERT INTO edge_exams_cache (id, is_paid, is_active, payload_json, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET
           is_paid = excluded.is_paid,
           is_active = excluded.is_active,
           payload_json = excluded.payload_json,
           updated_at = excluded.updated_at`
      )
      .bind(normalized.id, normalized.isPaid ? 1 : 0, isActive ? 1 : 0, JSON.stringify(normalized), updatedAtIso),
    db
      .prepare(
        `INSERT INTO edge_audit_logs (id, user_id, action, timestamp, payload_json, synced_to_firestore)
         VALUES (?1, ?2, ?3, ?4, ?5, 1)
         ON CONFLICT(id) DO UPDATE SET
           payload_json = excluded.payload_json,
           synced_to_firestore = 1`
      )
      .bind(auditEntry.id, auditEntry.userId, auditEntry.action, auditEntry.timestamp, JSON.stringify(auditEntry))
  ]);
}

function isFirestoreCasConflictError(err: unknown): boolean {
  return (
    err instanceof WorkerHttpError &&
    (err.status === 409 || err.code === 'FAILED_PRECONDITION' || err.code === 'ABORTED')
  );
}

async function readConversionAuditLogAuthoritative(
  ownerClient: FirestoreRestClient
): Promise<(Record<string, unknown> & { id: string }) | null> {
  try {
    return await ownerClient.getDocument<Record<string, unknown>>('auditLogs', CONVERSION_AUDIT_LOG_ID);
  } catch (err) {
    if (err instanceof WorkerHttpError && (err.status === 401 || err.status === 403 || err.status === 429)) {
      throw err;
    }
    throw new WorkerHttpError(
      503,
      'AUDIT_LOG_READ_FAILED',
      `Failed to verify existing Firestore audit log (${CONVERSION_AUDIT_LOG_ID}): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

async function getConversionAuditLogD1(
  db: D1Database
): Promise<{ id: string; action: string; synced_to_firestore: number } | null> {
  return db
    .prepare(
      `SELECT id, action, synced_to_firestore
       FROM edge_audit_logs
       WHERE id = ?1
       LIMIT 1`
    )
    .bind(CONVERSION_AUDIT_LOG_ID)
    .first<{ id: string; action: string; synced_to_firestore: number }>();
}

function hasRequiredCompletedConversionMetadata(
  conv: ExamConversionStateRecord | undefined
): conv is ExamConversionStateRecord {
  return Boolean(
    conv &&
      conv.operationId === CONVERSION_OPERATION_ID &&
      conv.status === 'completed' &&
      Number(conv.targetQuestionCount) === 100 &&
      conv.auditLogId === CONVERSION_AUDIT_LOG_ID &&
      typeof conv.completedAt === 'string' &&
      conv.completedAt.trim().length > 0 &&
      typeof conv.completedBy === 'string' &&
      conv.completedBy.trim().length > 0
  );
}

export async function handleOwnerExamConversionRoute(ctx: ExamConversionContext): Promise<{
  status: number;
  payload: unknown;
}> {
  const { request, env, projectId, nowMs, firestoreClient } = ctx;
  const nowIso = new Date(nowMs).toISOString();

  // 1. Strict Owner Authentication & Authorization (server-verified JWT only; ignores client role claims)
  const authUser = await authenticateFirebaseRequest(request, {
    projectId,
    environment: env.ENVIRONMENT,
    jwksFetcher: ctx.jwksFetcher,
    tokenVerifier: ctx.tokenVerifier,
    nowMs
  });
  assertOwnerAdmin(authUser, env);

  if (!env.DB) {
    throw new WorkerHttpError(503, 'D1_NOT_CONFIGURED', 'Cloudflare D1 binding (DB) is not configured.');
  }
  const db = env.DB;

  // 2. Parse & validate request body
  const body = await parseConversionJsonBody(request);
  if (body.examId !== undefined && String(body.examId).trim() !== TARGET_MODEL_TEST_2_EXAM_ID) {
    throw new WorkerHttpError(
      400,
      'INVALID_EXAM_ID',
      `This conversion endpoint is strictly scoped to ${TARGET_MODEL_TEST_2_EXAM_ID}.`
    );
  }

  if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') {
    throw new WorkerHttpError(400, 'INVALID_DRY_RUN_FLAG', 'dryRun must be a boolean if provided.');
  }
  const dryRun = body.dryRun !== false;

  const expectedUpdateTime =
    typeof body.expectedUpdateTime === 'string' && body.expectedUpdateTime.trim()
      ? body.expectedUpdateTime.trim()
      : null;

  const expectedQuestionIdsInput =
    body.expectedQuestionIds !== undefined ? normalizeStringArrayStrict(body.expectedQuestionIds) : null;
  if (body.expectedQuestionIds !== undefined && !expectedQuestionIdsInput) {
    throw new WorkerHttpError(400, 'INVALID_EXPECTED_QUESTION_IDS', 'expectedQuestionIds must be a non-empty string array.');
  }

  let targetQuestionIds: string[];
  if (body.questionIds === undefined) {
    targetQuestionIds = [...APPROVED_100_QUESTION_IDS];
  } else {
    const parsedIds = normalizeStringArrayStrict(body.questionIds);
    if (!parsedIds) {
      throw new WorkerHttpError(400, 'INVALID_QUESTION_IDS', 'questionIds must be an array of non-empty strings.');
    }
    if (parsedIds.length !== 100) {
      throw new WorkerHttpError(
        400,
        'INVALID_QUESTION_COUNT',
        `questionIds must contain exactly 100 question IDs (received ${parsedIds.length}).`
      );
    }
    const seen = new Set<string>();
    for (const qId of parsedIds) {
      if (LEGACY_ID_SET.has(qId)) {
        throw new WorkerHttpError(
          400,
          'INVALID_QUESTION_ID',
          `Legacy placeholder ID "${qId}" cannot be used in the 100-question exam.`
        );
      }
      if (seen.has(qId)) {
        throw new WorkerHttpError(
          400,
          'DUPLICATE_QUESTION_ID',
          `Duplicate question ID "${qId}" is not permitted.`
        );
      }
      seen.add(qId);
    }
    targetQuestionIds = parsedIds;
  }

  // 3. Read authoritative Firestore exam + audit log + D1 cached exam/audit log
  const ownerClient = firestoreClient.withToken(authUser.idToken);
  const [fsExamMeta, existingFsAudit, d1Exam, d1AuditRow] = await Promise.all([
    ownerClient.getDocumentWithMetadata<Record<string, unknown>>('exams', TARGET_MODEL_TEST_2_EXAM_ID),
    readConversionAuditLogAuthoritative(ownerClient),
    getExamFromCacheD1(db, TARGET_MODEL_TEST_2_EXAM_ID),
    getConversionAuditLogD1(db)
  ]);

  if (!fsExamMeta.data) {
    throw new WorkerHttpError(
      404,
      'EXAM_NOT_FOUND',
      `Authoritative Firestore exam ${TARGET_MODEL_TEST_2_EXAM_ID} was not found.`
    );
  }

  const currentUpdateTime = fsExamMeta.updateTime || null;
  const currentExamState = buildExamStateSnapshot(fsExamMeta.data, TARGET_MODEL_TEST_2_EXAM_ID);

  const fsConv = currentExamState.conversionState;
  const fsConvStatus = fsConv?.status;
  const hasValidCompletedMeta = hasRequiredCompletedConversionMetadata(fsConv);
  const hasCompletedExamPayload =
    currentExamState.questionIds.length === 100 &&
    currentExamState.totalMarks === 100 &&
    currentExamState.isActive === true &&
    arraysEqual(currentExamState.questionIds, APPROVED_100_QUESTION_IDS);
  const hasValidFsAuditLog = Boolean(
    existingFsAudit &&
      String(existingFsAudit.id ?? CONVERSION_AUDIT_LOG_ID) === CONVERSION_AUDIT_LOG_ID &&
      String(existingFsAudit.action ?? '') === 'CONVERT_MODEL_TEST_2_TO_100'
  );
  const hasCorruptFsAuditDoc = Boolean(existingFsAudit && !hasValidFsAuditLog);
  const hasPartialCompletedMetaWithoutValidAudit =
    hasValidCompletedMeta && hasCompletedExamPayload && !existingFsAudit;
  const hasInvalidCompletedMeta =
    fsConvStatus === 'completed' && (!hasValidCompletedMeta || !hasCompletedExamPayload);

  // Completion requires BOTH valid conversion metadata AND audit consistency in Firestore
  const isCompletedInFirestore =
    hasValidCompletedMeta && hasCompletedExamPayload && hasValidFsAuditLog;
  const isPendingInFirestore =
    fsConvStatus === 'pending' || hasPartialCompletedMetaWithoutValidAudit;
  const conversionStatus: 'not_started' | 'pending' | 'completed' = isCompletedInFirestore
    ? 'completed'
    : isPendingInFirestore
    ? 'pending'
    : 'not_started';

  const d1Conv = (d1Exam as (Exam & { conversionState?: ExamConversionStateRecord }) | null)?.conversionState;
  const d1MatchesCompleted = Boolean(
    d1Exam &&
      Array.isArray(d1Exam.questionIds) &&
      d1Exam.questionIds.length === 100 &&
      Number(d1Exam.totalMarks) === 100 &&
      d1Exam.isActive === true &&
      hasRequiredCompletedConversionMetadata(d1Conv) &&
      arraysEqual(d1Exam.questionIds, currentExamState.questionIds) &&
      d1AuditRow &&
      d1AuditRow.action === 'CONVERT_MODEL_TEST_2_TO_100' &&
      Number(d1AuditRow.synced_to_firestore) === 1
  );

  const alreadyConverted = isCompletedInFirestore && d1MatchesCompleted;
  const needsD1ReconciliationAfterFsComplete = isCompletedInFirestore && !d1MatchesCompleted;
  const recoveryRequired = isPendingInFirestore || needsD1ReconciliationAfterFsComplete;

  const proposedExamState: ExamStateSnapshot = {
    id: TARGET_MODEL_TEST_2_EXAM_ID,
    titleBn: currentExamState.titleBn,
    titleEn: currentExamState.titleEn,
    descriptionBn: CONVERTED_DESCRIPTION_BN,
    descriptionEn: CONVERTED_DESCRIPTION_EN,
    type: currentExamState.type,
    durationMinutes: 60,
    totalMarks: 100,
    passThresholdPercentage: 50,
    isPaid: true,
    isActive: true,
    published: true,
    releaseExplanationsImmediately: currentExamState.releaseExplanationsImmediately,
    negativeMarkRatio: 0.25,
    positiveMarkRatio: 1,
    questionCount: 100,
    questionIds: [...targetQuestionIds],
    createdAt: currentExamState.createdAt,
    updatedAt: nowIso,
    ...(currentExamState.scheduledDate ? { scheduledDate: currentExamState.scheduledDate } : {})
  };

  // Batch fetch all 100 questions & keys from Firestore (100 docs per batch) and D1 (90 IDs per chunk)
  const [fsQuestionMap, fsKeyMap, d1QuestionMap, d1KeyMap] = await Promise.all([
    ownerClient.batchGetDocuments<Record<string, unknown>>(
      targetQuestionIds.map(docId => ({ collection: 'questions', docId }))
    ),
    ownerClient.batchGetDocuments<Record<string, unknown>>(
      targetQuestionIds.map(docId => ({ collection: 'questionKeys', docId }))
    ),
    querySanitizedQuestionsByIdsFromD1(db, targetQuestionIds),
    getAuthoritativeQuestionKeys(db, ownerClient, targetQuestionIds, { allowRemoteFetch: false })
  ]);

  // 4. Strict validation across all 100 questions and keys in Firestore and D1
  const missingFsQuestions: string[] = [];
  const missingFsKeys: string[] = [];
  const missingD1Questions: string[] = [];
  const missingD1Keys: string[] = [];
  const allMissingSet = new Set<string>();
  const parityMismatches: Array<{ questionId: string; reason: string }> = [];
  const invalidQuestions: QuestionValidationFailure[] = [];
  const remedyTemplateViolations: Array<{ questionId: string; reason: string }> = [];
  const actualSubjectCounts: Record<string, number> = {
    sub_cpc: 0,
    sub_crpc: 0,
    sub_penal: 0,
    sub_evidence: 0,
    sub_sra: 0,
    sub_limitation: 0,
    sub_bar_ethics: 0
  };
  let validKeysCount = 0;

  for (const qId of targetQuestionIds) {
    const fsQ = fsQuestionMap.get(qId);
    const fsK = fsKeyMap.get(qId);
    const d1Q = d1QuestionMap.get(qId);
    const d1K = d1KeyMap.get(qId);

    if (!fsQ) {
      missingFsQuestions.push(qId);
      allMissingSet.add(qId);
    }
    if (!fsK) {
      missingFsKeys.push(qId);
      allMissingSet.add(qId);
    }
    if (!d1Q) {
      missingD1Questions.push(qId);
      allMissingSet.add(qId);
    }
    if (!d1K) {
      missingD1Keys.push(qId);
      allMissingSet.add(qId);
    }

    const subjSource = d1Q?.subjectId || (fsQ ? String(fsQ.subjectId ?? '') : '');
    if (subjSource) {
      actualSubjectCounts[subjSource] = (actualSubjectCounts[subjSource] || 0) + 1;
    }

    if (!fsQ || !fsK || !d1Q || !d1K) {
      invalidQuestions.push({
        questionId: qId,
        code: !fsQ
          ? 'MISSING_FIRESTORE_QUESTION'
          : !d1Q
          ? 'MISSING_D1_QUESTION'
          : !fsK
          ? 'MISSING_FIRESTORE_KEY'
          : 'MISSING_D1_KEY',
        reason: `Question "${qId}" is missing from ${[
          !fsQ ? 'Firestore questions' : '',
          !fsK ? 'Firestore questionKeys' : '',
          !d1Q ? 'D1 question_bank_cache' : '',
          !d1K ? 'D1 question_keys_cache' : ''
        ]
          .filter(Boolean)
          .join(', ')}.`
      });
      continue;
    }

    // Firestore <-> D1 Parity Check (content, metadata & answer keys)
    const fsOptionsBn = Array.isArray(fsQ.optionsBn) ? fsQ.optionsBn.map(o => String(o ?? '').trim()) : [];
    const fsOptionsEn = Array.isArray(fsQ.optionsEn) ? fsQ.optionsEn.map(o => String(o ?? '').trim()) : [];
    const d1OptionsBn = Array.isArray(d1Q.optionsBn) ? d1Q.optionsBn.map(o => String(o ?? '').trim()) : [];
    const d1OptionsEn = Array.isArray(d1Q.optionsEn) ? d1Q.optionsEn.map(o => String(o ?? '').trim()) : [];

    const fsQuestionBn = String(fsQ.questionBn ?? '').trim();
    const fsQuestionEn = String(fsQ.questionEn ?? '').trim();
    const fsStatus = String(fsQ.status ?? '');
    const fsDifficulty = fsQ.difficulty === 'easy' || fsQ.difficulty === 'hard' ? fsQ.difficulty : 'medium';
    const d1Difficulty = d1Q.difficulty === 'easy' || d1Q.difficulty === 'hard' ? d1Q.difficulty : 'medium';
    const fsTopicId = typeof fsQ.topicId === 'string' ? fsQ.topicId.trim() : '';
    const d1TopicId = typeof d1Q.topicId === 'string' ? d1Q.topicId.trim() : '';
    const fsCorrectIdx = fsK.correctOptionIndex;
    const fsExpBn = String(fsK.explanationBn ?? '').trim();
    const fsExpEn = String(fsK.explanationEn ?? '').trim();
    const fsKeyRef = String(fsK.legalReference ?? '').trim();
    const fsQRef = String(fsQ.legalReference ?? '').trim();
    const d1KeyRef = (d1K.legalReference ?? '').trim();
    const d1QRef = (d1Q.legalReference ?? '').trim();

    if (
      d1Q.subjectId !== String(fsQ.subjectId ?? '') ||
      d1TopicId !== fsTopicId ||
      d1Difficulty !== fsDifficulty ||
      d1Q.status !== fsStatus ||
      d1Q.questionBn.trim() !== fsQuestionBn ||
      d1Q.questionEn.trim() !== fsQuestionEn ||
      d1QRef !== fsQRef ||
      !arraysEqual(d1OptionsBn, fsOptionsBn) ||
      !arraysEqual(d1OptionsEn, fsOptionsEn)
    ) {
      parityMismatches.push({
        questionId: qId,
        reason: `D1 question_bank_cache record for "${qId}" diverges from authoritative Firestore /questions/${qId}.`
      });
    }

    if (
      d1K.correctOptionIndex !== fsCorrectIdx ||
      d1K.explanationBn.trim() !== fsExpBn ||
      d1K.explanationEn.trim() !== fsExpEn ||
      d1KeyRef !== fsKeyRef
    ) {
      parityMismatches.push({
        questionId: qId,
        reason: `D1 question_keys_cache record for "${qId}" diverges from authoritative Firestore /questionKeys/${qId}.`
      });
    }

    // Content & Integrity Checks
    let questionIntegrityOk = true;
    if (fsStatus !== 'published' || d1Q.status !== 'published') {
      questionIntegrityOk = false;
      invalidQuestions.push({
        questionId: qId,
        code: 'UNPUBLISHED_QUESTION',
        reason: `Question "${qId}" status must be "published" (found Firestore="${fsStatus}", D1="${d1Q.status}").`
      });
    } else if (!fsQuestionBn || !fsQuestionEn || !d1Q.questionBn.trim() || !d1Q.questionEn.trim()) {
      questionIntegrityOk = false;
      invalidQuestions.push({
        questionId: qId,
        code: 'MISSING_QUESTION_TEXT',
        reason: `Question "${qId}" must have non-empty Bengali and English question prompts.`
      });
    } else if (fsOptionsBn.length !== 4 || fsOptionsBn.some(o => !o) || d1OptionsBn.length !== 4 || d1OptionsBn.some(o => !o)) {
      questionIntegrityOk = false;
      invalidQuestions.push({
        questionId: qId,
        code: 'INVALID_OPTIONS_BN',
        reason: `Question "${qId}" must have exactly 4 non-empty Bengali options.`
      });
    } else if (fsOptionsEn.length !== 4 || fsOptionsEn.some(o => !o) || d1OptionsEn.length !== 4 || d1OptionsEn.some(o => !o)) {
      questionIntegrityOk = false;
      invalidQuestions.push({
        questionId: qId,
        code: 'INVALID_OPTIONS_EN',
        reason: `Question "${qId}" must have exactly 4 non-empty English options.`
      });
    } else if (
      typeof fsCorrectIdx !== 'number' ||
      !Number.isInteger(fsCorrectIdx) ||
      fsCorrectIdx < 0 ||
      fsCorrectIdx > 3 ||
      typeof d1K.correctOptionIndex !== 'number' ||
      !Number.isInteger(d1K.correctOptionIndex) ||
      d1K.correctOptionIndex < 0 ||
      d1K.correctOptionIndex > 3
    ) {
      questionIntegrityOk = false;
      invalidQuestions.push({
        questionId: qId,
        code: 'INVALID_CORRECT_OPTION_INDEX',
        reason: `Question "${qId}" has invalid correctOptionIndex (Firestore=${String(fsCorrectIdx)}, D1=${String(d1K.correctOptionIndex)}).`
      });
    } else if (!fsExpBn || !d1K.explanationBn.trim()) {
      questionIntegrityOk = false;
      invalidQuestions.push({
        questionId: qId,
        code: 'MISSING_EXPLANATION_BN',
        reason: `Question "${qId}" is missing a Bengali explanation.`
      });
    } else if (!fsExpEn || !d1K.explanationEn.trim()) {
      questionIntegrityOk = false;
      invalidQuestions.push({
        questionId: qId,
        code: 'MISSING_EXPLANATION_EN',
        reason: `Question "${qId}" is missing an English explanation.`
      });
    } else if (!(fsQRef || fsKeyRef) || !(d1QRef || d1KeyRef)) {
      questionIntegrityOk = false;
      invalidQuestions.push({
        questionId: qId,
        code: 'MISSING_LEGAL_REFERENCE',
        reason: `Question "${qId}" is missing legalReference.`
      });
    }

    if (questionIntegrityOk) {
      validKeysCount += 1;
    }

    if (hasRemedyForumTemplate(d1Q, d1K) || hasRemedyForumTemplate(fsQ, fsK)) {
      remedyTemplateViolations.push({
        questionId: qId,
        reason: `Question "${qId}" matches prohibited appellate/revisional remedy-forum template.`
      });
    }
  }

  // Check subject distribution
  const subjectDistributionMatched =
    VALID_SUBJECT_KEYS.every(sub => actualSubjectCounts[sub] === REQUIRED_SUBJECT_DISTRIBUTION[sub]) &&
    Object.keys(actualSubjectCounts).every(k => k in REQUIRED_SUBJECT_DISTRIBUTION);

  // Check the 7 approved replacement slots
  const approvedMappingsValidation: ApprovedMappingValidation[] = [];
  for (const slot of MODEL_TEST_2_REPAIR_SLOTS) {
    const expectedId = APPROVED_7_EXPECTED_ID_BY_LEGACY[slot.legacyQuestionId];
    const posIdx = APPROVED_7_SLOT_INDEX_IN_100[slot.legacyQuestionId];
    const actualId = targetQuestionIds[posIdx] ?? null;

    if (actualId !== expectedId) {
      const candidateQ = actualId ? d1QuestionMap.get(actualId) : undefined;
      const candidateK = actualId ? d1KeyMap.get(actualId) : undefined;
      const intentRes = candidateQ
        ? validateLegalQuestionIntent(slot, candidateQ, candidateK)
        : null;
      approvedMappingsValidation.push({
        legacyQuestionId: slot.legacyQuestionId,
        expectedReplacementId: expectedId,
        actualIdAtPosition: actualId,
        status: intentRes?.status || 'INVALID_APPROVED_MAPPING',
        valid: false,
        reason:
          intentRes && !intentRes.semanticMatch
            ? intentRes.reason
            : `Approved slot ${slot.legacyQuestionId} at position ${posIdx} must be "${expectedId}", found "${actualId ?? 'none'}".`
      });
      continue;
    }

    const q = d1QuestionMap.get(expectedId);
    const k = d1KeyMap.get(expectedId);
    if (!q || !k) {
      approvedMappingsValidation.push({
        legacyQuestionId: slot.legacyQuestionId,
        expectedReplacementId: expectedId,
        actualIdAtPosition: actualId,
        status: !q ? 'MISSING_QUESTION' : 'MISSING_ANSWER_KEY',
        valid: false,
        reason: `Approved replacement "${expectedId}" for ${slot.legacyQuestionId} is missing question or key record.`
      });
      continue;
    }

    if (q.subjectId !== slot.expectedSubjectId) {
      approvedMappingsValidation.push({
        legacyQuestionId: slot.legacyQuestionId,
        expectedReplacementId: expectedId,
        actualIdAtPosition: actualId,
        status: 'SUBJECT_MISMATCH',
        valid: false,
        reason: `Approved replacement "${expectedId}" has subjectId "${q.subjectId}", expected "${slot.expectedSubjectId}".`
      });
      continue;
    }

    const intent = validateLegalQuestionIntent(slot, q, k);
    approvedMappingsValidation.push({
      legacyQuestionId: slot.legacyQuestionId,
      expectedReplacementId: expectedId,
      actualIdAtPosition: actualId,
      status: intent.status,
      valid: intent.semanticMatch,
      reason: intent.reason
    });
  }

  const matchesApprovedList = arraysEqual(targetQuestionIds, APPROVED_100_QUESTION_IDS);

  // Check exam-level parity & snapshot invariants
  let examParityOk = true;
  const blockedReasons: string[] = [];

  if (hasInvalidCompletedMeta) {
    blockedReasons.push(
      `Existing Firestore conversionState metadata is incomplete or inconsistent with 100-question completion for ${CONVERSION_OPERATION_ID}.`
    );
  }
  if (hasCorruptFsAuditDoc) {
    blockedReasons.push(
      `Existing Firestore audit document ${CONVERSION_AUDIT_LOG_ID} has unexpected action "${String(existingFsAudit?.action ?? '')}".`
    );
  }

  if (conversionStatus === 'not_started') {
    const invariantIssues = validatePreConversionSnapshot(currentExamState);
    blockedReasons.push(...invariantIssues);

    if (d1Exam) {
      const d1QIds = Array.isArray(d1Exam.questionIds) ? d1Exam.questionIds : [];
      if (!arraysEqual(d1QIds, currentExamState.questionIds) || Number(d1Exam.totalMarks) !== currentExamState.totalMarks) {
        examParityOk = false;
        blockedReasons.push(
          'D1 edge_exams_cache exam snapshot diverges from authoritative Firestore exam snapshot.'
        );
      }
    }
  } else if (conversionStatus === 'pending') {
    examParityOk = false;
    // Pending state is allowed for recovery, but ensure the pending Firestore payload already targets the approved 100 list
    if (!arraysEqual(currentExamState.questionIds, targetQuestionIds) || currentExamState.totalMarks !== 100) {
      blockedReasons.push(
        'Existing pending conversion state in Firestore does not match the approved 100-question target.'
      );
    }
  } else if (alreadyConverted) {
    blockedReasons.push(`Exam ${TARGET_MODEL_TEST_2_EXAM_ID} has already been converted to 100 questions.`);
  } else if (needsD1ReconciliationAfterFsComplete) {
    examParityOk = false;
    if (!arraysEqual(currentExamState.questionIds, targetQuestionIds) || currentExamState.totalMarks !== 100) {
      blockedReasons.push(
        'Completed Firestore exam questionIds do not match the requested 100-question list.'
      );
    }
  }

  // CAS Checks
  let casConflict = false;
  if (expectedUpdateTime && (!currentUpdateTime || expectedUpdateTime !== currentUpdateTime)) {
    casConflict = true;
    blockedReasons.push(
      `CAS updateTime mismatch: expected "${expectedUpdateTime}", actual "${currentUpdateTime ?? 'none'}".`
    );
  }
  if (expectedQuestionIdsInput && !arraysEqual(expectedQuestionIdsInput, currentExamState.questionIds)) {
    casConflict = true;
    blockedReasons.push('CAS expectedQuestionIds snapshot mismatch against live Firestore exam questionIds.');
  }

  if (allMissingSet.size > 0) {
    blockedReasons.push(
      `Missing records in Firestore/D1 for ${allMissingSet.size} question(s): ${Array.from(allMissingSet).slice(0, 10).join(', ')}.`
    );
  }
  if (parityMismatches.length > 0) {
    blockedReasons.push(parityMismatches[0].reason);
  }
  if (invalidQuestions.length > 0) {
    blockedReasons.push(invalidQuestions[0].reason);
  }
  if (remedyTemplateViolations.length > 0) {
    blockedReasons.push(remedyTemplateViolations[0].reason);
  }
  if (!subjectDistributionMatched) {
    blockedReasons.push(
      `Subject distribution mismatch: expected CPC=20, CrPC=20, Penal=20, Evidence=15, SRA=10, Limitation=10, BarEthics=5; got ${JSON.stringify(actualSubjectCounts)}.`
    );
  }
  for (const m of approvedMappingsValidation) {
    if (!m.valid) {
      blockedReasons.push(m.reason);
    }
  }
  if (!matchesApprovedList) {
    blockedReasons.push(
      'Provided questionIds list does not match the exact approved 100-question ordered list.'
    );
  }

  const questionValidationPassed =
    allMissingSet.size === 0 &&
    parityMismatches.length === 0 &&
    invalidQuestions.length === 0 &&
    remedyTemplateViolations.length === 0 &&
    subjectDistributionMatched &&
    approvedMappingsValidation.every(m => m.valid) &&
    matchesApprovedList;

  const preConversionBlockers =
    conversionStatus === 'not_started' ? validatePreConversionSnapshot(currentExamState) : [];
  const d1PreConversionDivergence =
    conversionStatus === 'not_started' &&
    Boolean(
      d1Exam &&
        (!arraysEqual(Array.isArray(d1Exam.questionIds) ? d1Exam.questionIds : [], currentExamState.questionIds) ||
          Number(d1Exam.totalMarks) !== currentExamState.totalMarks)
    );

  const safeToExecute =
    questionValidationPassed &&
    !casConflict &&
    !alreadyConverted &&
    !hasInvalidCompletedMeta &&
    !hasCorruptFsAuditDoc &&
    preConversionBlockers.length === 0 &&
    !d1PreConversionDivergence &&
    (conversionStatus !== 'pending' ||
      (arraysEqual(currentExamState.questionIds, targetQuestionIds) && currentExamState.totalMarks === 100)) &&
    (!needsD1ReconciliationAfterFsComplete ||
      (arraysEqual(currentExamState.questionIds, targetQuestionIds) && currentExamState.totalMarks === 100));

  const baseReport: ExamConversionReport = {
    examId: TARGET_MODEL_TEST_2_EXAM_ID,
    operationId: CONVERSION_OPERATION_ID,
    mode: 'dry_run',
    dryRun,
    safeToExecute,
    executed: false,
    recovered: false,
    alreadyConverted,
    recoveryRequired,
    conversionStatus,
    casConflict,
    currentUpdateTime,
    expectedUpdateTime,
    currentExamState,
    proposedExamState,
    subjectDistribution: {
      required: REQUIRED_SUBJECT_DISTRIBUTION,
      actual: actualSubjectCounts,
      matched: subjectDistributionMatched
    },
    missingQuestionIds: {
      firestoreQuestions: missingFsQuestions,
      firestoreKeys: missingFsKeys,
      d1Questions: missingD1Questions,
      d1Keys: missingD1Keys,
      allUniqueMissing: Array.from(allMissingSet)
    },
    firestoreD1Parity: {
      ok: allMissingSet.size === 0 && parityMismatches.length === 0 && examParityOk,
      examMatches: examParityOk,
      questionCountMatched: targetQuestionIds.filter(id => fsQuestionMap.has(id) && d1QuestionMap.has(id)).length,
      keyCountMatched: targetQuestionIds.filter(id => fsKeyMap.has(id) && d1KeyMap.has(id)).length,
      mismatches: parityMismatches
    },
    keyIntegrity: {
      ok: invalidQuestions.length === 0 && validKeysCount === 100,
      totalChecked: targetQuestionIds.length,
      validCount: validKeysCount,
      invalidQuestions
    },
    remedyTemplateViolations,
    approvedMappingsValidation,
    matchesApprovedList,
    blockedReasons
  };

  // 5. Dry-run returns diagnostic report immediately with ZERO writes
  if (dryRun) {
    return {
      status: 200,
      payload: baseReport
    };
  }

  // 6. Execute-mode strict preconditions (ZERO writes on any failure)
  if (!expectedUpdateTime) {
    throw new WorkerHttpError(
      400,
      'CAS_PRECONDITION_REQUIRED',
      'expectedUpdateTime (Firestore document updateTime from dry-run) is required when dryRun=false.'
    );
  }

  if (alreadyConverted) {
    return {
      status: 409,
      payload: {
        error: 'ALREADY_CONVERTED',
        message: `Exam ${TARGET_MODEL_TEST_2_EXAM_ID} has already been converted to 100 questions.`,
        report: baseReport
      }
    };
  }

  if (casConflict) {
    return {
      status: 409,
      payload: {
        error: 'CAS_CONFLICT',
        message: blockedReasons[0] || 'Exam CAS snapshot precondition failed.',
        report: baseReport
      }
    };
  }

  if (
    !questionValidationPassed ||
    preConversionBlockers.length > 0 ||
    d1PreConversionDivergence ||
    hasInvalidCompletedMeta ||
    hasCorruptFsAuditDoc
  ) {
    let errorCode = 'CONVERSION_VALIDATION_FAILED';
    if (hasInvalidCompletedMeta || hasCorruptFsAuditDoc) {
      errorCode = 'CONVERSION_METADATA_INCONSISTENT';
    } else if (remedyTemplateViolations.length > 0) {
      errorCode = 'REMEDY_TEMPLATE_REJECTED';
    } else if (approvedMappingsValidation.some(m => !m.valid)) {
      errorCode = 'APPROVED_MAPPING_INVALID';
    } else if (!subjectDistributionMatched) {
      errorCode = 'SUBJECT_DISTRIBUTION_MISMATCH';
    } else if (allMissingSet.size > 0 || invalidQuestions.length > 0 || parityMismatches.length > 0) {
      errorCode = 'QUESTION_VALIDATION_FAILED';
    } else if (!matchesApprovedList) {
      errorCode = 'UNAPPROVED_QUESTION_LIST';
    } else if (preConversionBlockers.length > 0 || d1PreConversionDivergence) {
      errorCode = 'CAS_CONFLICT';
    }

    return {
      status: errorCode === 'CAS_CONFLICT' ? 409 : 422,
      payload: {
        error: errorCode,
        message: blockedReasons[0] || 'Exam conversion preflight validation failed.',
        report: baseReport
      }
    };
  }

  // 7. Recoverable 2-phase Firestore CAS + Idempotent D1 Sync + Finalization
  const pendingConversionState: ExamConversionStateRecord = currentExamState.conversionState?.status === 'pending'
    ? currentExamState.conversionState
    : {
        operationId: CONVERSION_OPERATION_ID,
        status: 'pending',
        targetQuestionCount: 100,
        previousTotalMarks: 7,
        startedAt: nowIso,
        startedBy: authUser.uid,
        auditLogId: CONVERSION_AUDIT_LOG_ID
      };

  let activeCasUpdateTime = expectedUpdateTime;
  let postPhaseAMetaReadError: string | null = null;

  // Phase A: Transition Firestore from not_started -> pending (isActive=false) using CAS
  if (conversionStatus === 'not_started') {
    try {
      await ownerClient.commitWrites([
        {
          type: 'update',
          collection: 'exams',
          docId: TARGET_MODEL_TEST_2_EXAM_ID,
          patch: {
            questionIds: [...targetQuestionIds],
            totalMarks: 100,
            durationMinutes: 60,
            positiveMarkRatio: 1,
            negativeMarkRatio: 0.25,
            passThresholdPercentage: 50,
            isPaid: true,
            published: true,
            isActive: false,
            descriptionBn: CONVERTED_DESCRIPTION_BN,
            descriptionEn: CONVERTED_DESCRIPTION_EN,
            conversionState: pendingConversionState,
            updatedAt: nowIso
          },
          currentDocument: {
            updateTime: activeCasUpdateTime
          }
        }
      ]);
    } catch (err) {
      if (isFirestoreCasConflictError(err)) {
        return {
          status: 409,
          payload: {
            error: 'CAS_CONFLICT',
            message: 'Concurrent modification detected during Firestore CAS commit.',
            report: { ...baseReport, casConflict: true, safeToExecute: false }
          }
        };
      }
      throw err;
    }

    try {
      const pendingFsMeta = await ownerClient.getDocumentWithMetadata<Record<string, unknown>>(
        'exams',
        TARGET_MODEL_TEST_2_EXAM_ID
      );
      if (pendingFsMeta.updateTime) {
        activeCasUpdateTime = pendingFsMeta.updateTime;
      } else {
        postPhaseAMetaReadError = 'Firestore did not return updateTime after Phase A commit.';
      }
    } catch (err) {
      postPhaseAMetaReadError = err instanceof Error ? err.message : String(err);
    }
  }

  const baseRawExam = {
    ...(fsExamMeta.data || {}),
    id: TARGET_MODEL_TEST_2_EXAM_ID,
    questionIds: [...targetQuestionIds],
    totalMarks: 100,
    durationMinutes: 60,
    positiveMarkRatio: 1,
    negativeMarkRatio: 0.25,
    passThresholdPercentage: 50,
    isPaid: true,
    published: true,
    descriptionBn: CONVERTED_DESCRIPTION_BN,
    descriptionEn: CONVERTED_DESCRIPTION_EN
  } as unknown as Exam & { updatedAt: string; conversionState?: ExamConversionStateRecord };

  // Phase B: Idempotent D1 pending sync (while isActive=false) if Firestore is not already completed
  if (!needsD1ReconciliationAfterFsComplete) {
    try {
      await upsertExamCacheOnlyD1(
        db,
        {
          ...baseRawExam,
          isActive: false,
          conversionState: pendingConversionState,
          updatedAt: nowIso
        },
        nowIso
      );
    } catch (err) {
      return {
        status: 503,
        payload: {
          success: false,
          error: 'D1_SYNC_FAILED_RECOVERY_REQUIRED',
          message:
            `Firestore updated to pending conversion state, but D1 synchronization failed: ${
              err instanceof Error ? err.message : String(err)
            }. Re-run conversion recovery with currentUpdateTime.`,
          firestoreCommitted: true,
          d1Synced: false,
          recoveryRequired: true,
          conversionStatus: 'pending',
          currentUpdateTime: activeCasUpdateTime,
          ...(postPhaseAMetaReadError ? { metadataReadError: postPhaseAMetaReadError } : {}),
          report: {
            ...baseReport,
            mode: 'partial_failure',
            recoveryRequired: true,
            conversionStatus: 'pending',
            currentUpdateTime: activeCasUpdateTime
          }
        }
      };
    }

    if (postPhaseAMetaReadError) {
      return {
        status: 503,
        payload: {
          success: false,
          error: 'D1_SYNC_FAILED_RECOVERY_REQUIRED',
          message:
            `Firestore and D1 transitioned to pending conversion state (isActive=false), but post-Phase-A Firestore metadata read failed: ${postPhaseAMetaReadError}. Run dry-run to refresh currentUpdateTime and complete recovery.`,
          firestoreCommitted: true,
          d1Synced: true,
          recoveryRequired: true,
          conversionStatus: 'pending',
          currentUpdateTime: activeCasUpdateTime,
          metadataReadError: postPhaseAMetaReadError,
          report: {
            ...baseReport,
            mode: 'partial_failure',
            recoveryRequired: true,
            conversionStatus: 'pending',
            currentUpdateTime: activeCasUpdateTime
          }
        }
      };
    }
  }

  const completedConversionState: ExamConversionStateRecord =
    hasValidCompletedMeta && fsConv
      ? fsConv
      : {
          ...pendingConversionState,
          status: 'completed',
          completedAt: nowIso,
          completedBy: authUser.uid
        };

  const deterministicAuditEntry: AuditLog = {
    id: CONVERSION_AUDIT_LOG_ID,
    userId: authUser.uid,
    userName: authUser.email || 'Owner Admin',
    action: 'CONVERT_MODEL_TEST_2_TO_100',
    details: `Converted ${TARGET_MODEL_TEST_2_EXAM_ID} from 7 to 100 questions (totalMarks=100, durationMinutes=60, -0.25 negative marking, isPaid=true, published=true, isActive=true).`,
    timestamp: completedConversionState.completedAt || nowIso
  };

  let postPhaseCMetaReadError: string | null = null;

  // Phase C: Finalize Firestore CAS (completed + isActive=true) + idempotent audit log create
  if (!needsD1ReconciliationAfterFsComplete) {
    let auditForPhaseC = existingFsAudit;
    if (conversionStatus === 'not_started') {
      try {
        auditForPhaseC = await readConversionAuditLogAuthoritative(ownerClient);
      } catch (err) {
        return {
          status: 503,
          payload: {
            success: false,
            error: 'D1_SYNC_FAILED_RECOVERY_REQUIRED',
            message:
              `Conversion is safely in pending state (isActive=false), but Firestore audit log verification failed before finalization: ${
                err instanceof Error ? err.message : String(err)
              }. Re-run conversion recovery with currentUpdateTime.`,
            firestoreCommitted: true,
            d1Synced: true,
            recoveryRequired: true,
            conversionStatus: 'pending',
            currentUpdateTime: activeCasUpdateTime,
            report: {
              ...baseReport,
              mode: 'partial_failure',
              recoveryRequired: true,
              conversionStatus: 'pending',
              currentUpdateTime: activeCasUpdateTime
            }
          }
        };
      }
    }

    if (auditForPhaseC && String(auditForPhaseC.action ?? '') !== 'CONVERT_MODEL_TEST_2_TO_100') {
      return {
        status: 422,
        payload: {
          error: 'CONVERSION_METADATA_INCONSISTENT',
          message: `Existing Firestore audit log ${CONVERSION_AUDIT_LOG_ID} has unexpected action "${String(auditForPhaseC.action ?? '')}".`,
          report: { ...baseReport, mode: 'partial_failure', recoveryRequired: true, currentUpdateTime: activeCasUpdateTime }
        }
      };
    }

    const finalizeWrites = [
      {
        type: 'update' as const,
        collection: 'exams',
        docId: TARGET_MODEL_TEST_2_EXAM_ID,
        patch: {
          isActive: true,
          conversionState: completedConversionState,
          updatedAt: nowIso
        },
        currentDocument: {
          updateTime: activeCasUpdateTime
        }
      },
      ...(auditForPhaseC
        ? []
        : [
            {
              type: 'create' as const,
              collection: 'auditLogs',
              docId: CONVERSION_AUDIT_LOG_ID,
              data: { ...deterministicAuditEntry }
            }
          ])
    ];

    try {
      await ownerClient.commitWrites(finalizeWrites);
    } catch (err) {
      if (isFirestoreCasConflictError(err)) {
        return {
          status: 409,
          payload: {
            error: 'CAS_CONFLICT',
            message: 'Concurrent modification detected during Firestore finalization CAS commit.',
            report: { ...baseReport, casConflict: true, safeToExecute: false }
          }
        };
      }
      throw err;
    }

    try {
      const completedFsMeta = await ownerClient.getDocumentWithMetadata<Record<string, unknown>>(
        'exams',
        TARGET_MODEL_TEST_2_EXAM_ID
      );
      if (completedFsMeta.updateTime) {
        activeCasUpdateTime = completedFsMeta.updateTime;
      } else {
        postPhaseCMetaReadError = 'Firestore did not return updateTime after Phase C commit.';
      }
    } catch (err) {
      postPhaseCMetaReadError = err instanceof Error ? err.message : String(err);
    }
  }

  // Phase D: Atomic & idempotent D1 completion sync (edge_exams_cache + edge_audit_logs)
  const completedExam: Exam & { updatedAt: string; conversionState: ExamConversionStateRecord } = {
    ...baseRawExam,
    isActive: true,
    conversionState: completedConversionState,
    updatedAt: nowIso
  };

  try {
    await commitExamConversionCompleteD1(db, completedExam, deterministicAuditEntry, nowIso);
  } catch (err) {
    return {
      status: 503,
      payload: {
        success: false,
        error: 'D1_SYNC_FAILED_RECOVERY_REQUIRED',
        message:
          `Firestore conversion finalized, but D1 completion sync failed: ${
            err instanceof Error ? err.message : String(err)
          }. Re-run conversion recovery with currentUpdateTime.`,
        firestoreCommitted: true,
        d1Synced: false,
        recoveryRequired: true,
        conversionStatus: 'completed',
        currentUpdateTime: activeCasUpdateTime,
        ...(postPhaseCMetaReadError ? { metadataReadError: postPhaseCMetaReadError } : {}),
        report: {
          ...baseReport,
          mode: 'partial_failure',
          recoveryRequired: true,
          conversionStatus: 'completed',
          currentUpdateTime: activeCasUpdateTime
        }
      }
    };
  }

  const wasRecovery = isPendingInFirestore || needsD1ReconciliationAfterFsComplete;
  const finalReport: ExamConversionReport = {
    ...baseReport,
    mode: wasRecovery ? 'recovered' : 'executed',
    dryRun: false,
    safeToExecute: true,
    executed: true,
    recovered: wasRecovery,
    alreadyConverted: false,
    recoveryRequired: false,
    conversionStatus: 'completed',
    currentUpdateTime: activeCasUpdateTime,
    firestoreD1Parity: {
      ...baseReport.firestoreD1Parity,
      ok: true,
      examMatches: true
    },
    blockedReasons: [],
    auditLogId: CONVERSION_AUDIT_LOG_ID,
    convertedAt: completedConversionState.completedAt || nowIso
  };

  return {
    status: 200,
    payload: {
      success: true,
      recovered: wasRecovery,
      exam: completedExam,
      report: finalReport
    }
  };
}
