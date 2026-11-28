import type { Exam } from '../src/types/index.ts';
import { assertOwnerAdmin, authenticateFirebaseRequest, type JwksFetcher } from './firebaseAuth.ts';
import { getExamFromCacheD1 } from './d1Store.ts';
import { timestampToIso, type FirestoreRestClient } from './firestoreRest.ts';
import {
  getAuthoritativeQuestionKeys,
  querySanitizedQuestionsByIdsFromD1
} from './questionCache.ts';
import {
  WorkerHttpError,
  type AuditLog,
  type D1Database,
  type DecodedAuthUser,
  type QuestionKeyRecord,
  type SanitizedQuestion,
  type WorkerEnv
} from './types.ts';

export const TARGET_MODEL_TEST_2_EXAM_ID = 'exam_1795671882276_o1zj5';

export interface RepairSlotSpec {
  slotIndex: number;
  slotNumber: number;
  legacyQuestionId: string;
  expectedSubjectId: string;
  legalTopic: string;
  originalSummaryEn: string;
}

export const MODEL_TEST_2_REPAIR_SLOTS: readonly RepairSlotSpec[] = [
  {
    slotIndex: 0,
    slotNumber: 1,
    legacyQuestionId: 'q_lim_1',
    expectedSubjectId: 'sub_limitation',
    legalTopic: 'Limitation Act, 1908 — Section 5 (Condonation of Delay)',
    originalSummaryEn: 'Under which section of the Limitation Act, 1908 can condonation of delay be applied for?'
  },
  {
    slotIndex: 1,
    slotNumber: 2,
    legacyQuestionId: 'q_sra_1',
    expectedSubjectId: 'sub_sra',
    legalTopic: 'Specific Relief Act, 1877 — Section 9 (6-month possession recovery)',
    originalSummaryEn: 'Under Section 9 of the Specific Relief Act, 1877, within what period (6 months) must a dispossessed person sue for recovery?'
  },
  {
    slotIndex: 2,
    slotNumber: 3,
    legacyQuestionId: 'q_bco_1',
    expectedSubjectId: 'sub_bar_ethics',
    legalTopic: 'Bangladesh Bar Council Order, 1972 — Ex-officio Chairman (Attorney General)',
    originalSummaryEn: 'Who serves as ex-officio Chairman of the Bangladesh Bar Council (Attorney General for Bangladesh)?'
  },
  {
    slotIndex: 3,
    slotNumber: 4,
    legacyQuestionId: 'q_crpc_1',
    expectedSubjectId: 'sub_crpc',
    legalTopic: 'Code of Criminal Procedure, 1898 — Section 144 (Urgent orders for nuisance / apprehended danger)',
    originalSummaryEn: 'Substantive authority/section under CrPC 1898 Section 144 to issue urgent prohibitory order preventing nuisance or apprehended danger'
  },
  {
    slotIndex: 4,
    slotNumber: 5,
    legacyQuestionId: 'q_penal_1',
    expectedSubjectId: 'sub_penal',
    legalTopic: 'Penal Code, 1860 — Section 299 (Culpable Homicide)',
    originalSummaryEn: 'In which section of the Penal Code, 1860 is Culpable Homicide defined?'
  },
  {
    slotIndex: 5,
    slotNumber: 6,
    legacyQuestionId: 'q_evi_1',
    expectedSubjectId: 'sub_evidence',
    legalTopic: 'Evidence Act, 1872 — Section 32(1) (Dying Declaration)',
    originalSummaryEn: 'Under which section of the Evidence Act, 1872 is a Dying Declaration admissible?'
  },
  {
    slotIndex: 6,
    slotNumber: 7,
    legacyQuestionId: 'q_cpc_1',
    expectedSubjectId: 'sub_cpc',
    legalTopic: 'Code of Civil Procedure, 1908 — Section 9 (Civil Courts Jurisdiction)',
    originalSummaryEn: 'Under Section 9 of CPC 1908, civil courts have general jurisdiction to try all civil suits unless barred'
  }
] as const;

export const CANONICAL_LEGACY_QUESTION_IDS: readonly string[] = MODEL_TEST_2_REPAIR_SLOTS.map(
  s => s.legacyQuestionId
);

export type SlotValidationStatus =
  | 'VALID'
  | 'INVALID_QUESTION_ID'
  | 'MISSING_QUESTION'
  | 'MISSING_ANSWER_KEY'
  | 'CORRUPT_ANSWER_KEY'
  | 'SUBJECT_MISMATCH'
  | 'SEMANTIC_MISMATCH'
  | 'NEEDS_CORRECTION_AND_OWNER_APPROVAL';

export interface SlotValidationResult {
  slotNumber: number;
  legacyQuestionId: string;
  replacementQuestionId: string;
  expectedSubjectId: string;
  actualSubjectId: string | null;
  legalTopic: string;
  questionFoundInD1: boolean;
  answerKeyFoundInD1: boolean;
  answerKeyValid: boolean;
  subjectMatch: boolean;
  semanticMatch: boolean;
  requiresCorrectionAndOwnerApproval: boolean;
  status: SlotValidationStatus;
  reason: string;
}

export interface PreservedExamSnapshot {
  id: string;
  titleBn: string;
  titleEn: string;
  type: string;
  isPaid: boolean;
  isActive: boolean;
  published: boolean;
  durationMinutes: number;
  totalMarks: number;
  passThresholdPercentage?: number;
  releaseExplanationsImmediately: boolean;
  negativeMarkRatio: number;
  positiveMarkRatio: number;
  createdAt: string;
  scheduledDate?: string;
}

export interface ExamRepairReport {
  examId: string;
  mode: 'dry_run' | 'executed';
  dryRun: boolean;
  safeToExecute: boolean;
  executed: boolean;
  alreadyRepaired: boolean;
  casConflict: boolean;
  currentUpdateTime: string | null;
  expectedUpdateTime: string | null;
  currentQuestionIds: string[];
  replacementQuestionIds: string[];
  preservedSettings: PreservedExamSnapshot | null;
  slotValidations: SlotValidationResult[];
  blockedReasons: string[];
  auditLogId?: string;
  repairedAt?: string;
}

export interface ExamRepairContext {
  request: Request;
  env: WorkerEnv;
  projectId: string;
  nowMs: number;
  firestoreClient: FirestoreRestClient;
  jwksFetcher?: JwksFetcher;
  tokenVerifier?: (idToken: string) => Promise<DecodedAuthUser>;
}

const LEGACY_ID_SET = new Set(CANONICAL_LEGACY_QUESTION_IDS);

function makeRepairAuditId(nowMs: number): string {
  const rand =
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `log_repair_${nowMs}_${rand}`;
}

async function parseRepairJsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get('content-length') || '0');
  if (Number.isFinite(contentLength) && contentLength > 32_768) {
    throw new WorkerHttpError(413, 'PAYLOAD_TOO_LARGE', 'Request payload too large.');
  }
  const raw = await request.text();
  if (!raw || !raw.trim()) {
    return {};
  }
  if (raw.length > 32_768) {
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

function normalizeStringArray(val: unknown): string[] | null {
  if (!Array.isArray(val)) return null;
  return val.map(v => (typeof v === 'string' ? v.trim() : '')).filter(Boolean);
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function validateAnswerKeyIntegrity(
  question: SanitizedQuestion,
  key: QuestionKeyRecord | undefined
): { found: boolean; valid: boolean; reason?: string } {
  if (!key) {
    return { found: false, valid: false, reason: 'Missing row in D1 question_keys_cache.' };
  }
  if (!Array.isArray(question.optionsBn) || question.optionsBn.length < 2) {
    return { found: true, valid: false, reason: 'Question has invalid or incomplete optionsBn.' };
  }
  if (
    typeof key.correctOptionIndex !== 'number' ||
    !Number.isInteger(key.correctOptionIndex) ||
    key.correctOptionIndex < 0 ||
    key.correctOptionIndex >= question.optionsBn.length
  ) {
    return {
      found: true,
      valid: false,
      reason: `Invalid correctOptionIndex (${String(key.correctOptionIndex)}) for options length ${question.optionsBn.length}.`
    };
  }
  const correctOptBn = String(question.optionsBn[key.correctOptionIndex] ?? '').trim();
  if (!correctOptBn) {
    return { found: true, valid: false, reason: 'Correct option text at correctOptionIndex is empty.' };
  }
  if (question.status === 'draft') {
    return { found: true, valid: false, reason: 'Draft questions cannot be published into a live exam.' };
  }
  return { found: true, valid: true };
}

function combineQuestionSearchText(q: SanitizedQuestion, key?: QuestionKeyRecord): string {
  const correctBn = key ? q.optionsBn[key.correctOptionIndex] ?? '' : '';
  const correctEn = key ? q.optionsEn[key.correctOptionIndex] ?? '' : '';
  return [
    q.questionBn,
    q.questionEn,
    q.legalReference || '',
    correctBn,
    correctEn,
    key?.explanationBn || '',
    key?.explanationEn || '',
    key?.legalReference || ''
  ]
    .join('\n')
    .toLowerCase();
}

function hasSection5Limitation(text: string): boolean {
  return /(?:^|[^\d০-৯])(?:ধারা\s*৫|section\s*5|sec\.?\s*5)(?![\d০-৯])/i.test(text);
}

function hasSection9(text: string): boolean {
  return /(?:^|[^\d০-৯])(?:ধারা\s*৯|section\s*9|sec\.?\s*9)(?![\d০-৯])/i.test(text);
}

function hasSection144(text: string): boolean {
  return /(?:^|[^\d০-৯])(?:ধারা\s*১৪৪|section\s*144|sec\.?\s*144)(?![\d০-৯])/i.test(text);
}

function hasSection299(text: string): boolean {
  return /(?:^|[^\d০-৯])(?:ধারা\s*২৯৯|section\s*299|sec\.?\s*299)(?![\d০-৯])/i.test(text);
}

function hasSection32_1(text: string): boolean {
  return /(?:ধারা\s*৩২\s*\(\s*১\s*\)|section\s*32\s*\(\s*1\s*\)|sec\.?\s*32\s*\(\s*1\s*\))/i.test(text);
}

function hasForumOrRemedyTemplateMismatch(q: SanitizedQuestion, key?: QuestionKeyRecord): boolean {
  const qText = `${q.questionBn}\n${q.questionEn}\n${key ? q.optionsBn[key.correctOptionIndex] ?? '' : ''}\n${
    key ? q.optionsEn[key.correctOptionIndex] ?? '' : ''
  }`;
  return (
    /প্রতিকারের\s*সঠিক\s*ফোরাম/i.test(qText) ||
    /legal\s*recourse\s*or\s*remedy\s*against\s*a\s*judicial\s*decision/i.test(qText) ||
    /আপিল\s*\/\s*রিভিশন\s*বিধিমোতাবেক\s*উচ্চ\s*আদালতে\s*প্রতিকার/i.test(qText) ||
    /statutory\s*appeal\s*or\s*revision\s*before\s*the\s*appropriate\s*higher\s*forum/i.test(qText)
  );
}

export function validateLegalQuestionIntent(
  slot: RepairSlotSpec,
  question: SanitizedQuestion,
  key?: QuestionKeyRecord
): {
  semanticMatch: boolean;
  requiresCorrectionAndOwnerApproval: boolean;
  status: 'VALID' | 'SEMANTIC_MISMATCH' | 'NEEDS_CORRECTION_AND_OWNER_APPROVAL';
  reason: string;
} {
  const combined = combineQuestionSearchText(question, key);
  const promptText = `${question.questionBn}\n${question.questionEn}`.toLowerCase();

  switch (slot.legacyQuestionId) {
    case 'q_lim_1': {
      const hasConcept =
        /বিলম্ব\s*মওকুফ|condonation\s*of\s*delay|sufficient\s*cause|যুক্তিসঙ্গত\s*কারণ/.test(combined);
      if (hasSection5Limitation(combined) && hasConcept && !hasForumOrRemedyTemplateMismatch(question, key)) {
        return {
          semanticMatch: true,
          requiresCorrectionAndOwnerApproval: false,
          status: 'VALID',
          reason: 'Matches Limitation Act, 1908 Section 5 (Condonation of Delay).'
        };
      }
      return {
        semanticMatch: false,
        requiresCorrectionAndOwnerApproval: false,
        status: 'SEMANTIC_MISMATCH',
        reason: `Question ${question.id} does not match original q_lim_1 intent (Limitation Act Section 5 — Condonation of Delay).`
      };
    }

    case 'q_sra_1': {
      const hasPossession = /দখল|possession/.test(combined);
      const hasSixMonths = /৬\s*মাস|6\s*months/.test(combined);
      if (hasSection9(combined) && hasPossession && hasSixMonths && !hasForumOrRemedyTemplateMismatch(question, key)) {
        return {
          semanticMatch: true,
          requiresCorrectionAndOwnerApproval: false,
          status: 'VALID',
          reason: 'Matches Specific Relief Act, 1877 Section 9 (6-month possession recovery).'
        };
      }
      return {
        semanticMatch: false,
        requiresCorrectionAndOwnerApproval: false,
        status: 'SEMANTIC_MISMATCH',
        reason: `Question ${question.id} does not match original q_sra_1 intent (Specific Relief Act Section 9 — 6-month recovery of possession).`
      };
    }

    case 'q_bco_1': {
      const hasBarCouncil = /বার\s*কাউন্সিল|bar\s*council/.test(combined);
      const hasAgChairman =
        (/অ্যাটর্নি\s*জেনারেল|attorney\s*general/.test(combined) &&
          /চেয়ারম্যান|chairman|পদাধিকার/.test(combined));
      if (hasBarCouncil && hasAgChairman && !hasForumOrRemedyTemplateMismatch(question, key)) {
        return {
          semanticMatch: true,
          requiresCorrectionAndOwnerApproval: false,
          status: 'VALID',
          reason: 'Matches Bangladesh Bar Council Order, 1972 (Attorney General as ex-officio Chairman).'
        };
      }
      return {
        semanticMatch: false,
        requiresCorrectionAndOwnerApproval: false,
        status: 'SEMANTIC_MISMATCH',
        reason: `Question ${question.id} does not match original q_bco_1 intent (Bar Council ex-officio Chairman — Attorney General).`
      };
    }

    case 'q_crpc_1': {
      if (hasForumOrRemedyTemplateMismatch(question, key)) {
        return {
          semanticMatch: false,
          requiresCorrectionAndOwnerApproval: true,
          status: 'NEEDS_CORRECTION_AND_OWNER_APPROVAL',
          reason:
            `Replacement #4 (${question.id}) tests appellate/revisional remedy forum ("প্রতিকারের সঠিক ফোরাম" / ` +
            `"recourse or remedy against a judicial decision") instead of original q_crpc_1 intent ` +
            `(CrPC Section 144 power/order to prevent urgent nuisance or apprehended danger). ` +
            `Flagged as NEEDS_CORRECTION_AND_OWNER_APPROVAL and rejected.`
        };
      }
      const hasUrgentOrderCue =
        /তাৎক্ষণিক\s*শান্তি\s*ভঙ্গ|জননিরাপত্তা|সাময়িক\s*নিষেধাজ্ঞা|নিষেধাজ্ঞা\s*জারি|urgent\s*cases\s*of\s*nuisance|apprehended\s*danger|temporary\s*injunction|prohibitory\s*order/.test(
          combined
        );
      const testsSec144Authority =
        hasSection144(combined) &&
        hasUrgentOrderCue &&
        (/কোন\s*ধারা|under\s*which\s*section|আইনি\s*ভিত্তি|legal\s*rule|নিম্নের\s*কোনটি|যথাযথভাবে\s*প্রযোজ্য/.test(
          promptText
        ));

      if (testsSec144Authority) {
        return {
          semanticMatch: true,
          requiresCorrectionAndOwnerApproval: false,
          status: 'VALID',
          reason: 'Matches CrPC, 1898 Section 144 (urgent prohibitory order preventing nuisance/apprehended danger).'
        };
      }

      if (hasSection144(combined)) {
        return {
          semanticMatch: false,
          requiresCorrectionAndOwnerApproval: true,
          status: 'NEEDS_CORRECTION_AND_OWNER_APPROVAL',
          reason:
            `Replacement #4 (${question.id}) references Section 144 but does not accurately test the ` +
            `original q_crpc_1 Section 144 urgent prohibitory order intent. Flagged as NEEDS_CORRECTION_AND_OWNER_APPROVAL.`
        };
      }

      return {
        semanticMatch: false,
        requiresCorrectionAndOwnerApproval: true,
        status: 'NEEDS_CORRECTION_AND_OWNER_APPROVAL',
        reason:
          `Replacement #4 (${question.id}) does not match original q_crpc_1 intent (CrPC Section 144 urgent prohibitory order). ` +
          `Flagged as NEEDS_CORRECTION_AND_OWNER_APPROVAL.`
      };
    }

    case 'q_penal_1': {
      const hasConcept = /অপরাধজনক\s*নরহত্যা|অপরাধমূলক\s*নরহত্যা|culpable\s*homicide/.test(combined);
      if (hasSection299(combined) && hasConcept && !hasForumOrRemedyTemplateMismatch(question, key)) {
        return {
          semanticMatch: true,
          requiresCorrectionAndOwnerApproval: false,
          status: 'VALID',
          reason: 'Matches Penal Code, 1860 Section 299 (Culpable Homicide).'
        };
      }
      return {
        semanticMatch: false,
        requiresCorrectionAndOwnerApproval: false,
        status: 'SEMANTIC_MISMATCH',
        reason: `Question ${question.id} does not match original q_penal_1 intent (Penal Code Section 299 — Culpable Homicide).`
      };
    }

    case 'q_evi_1': {
      const hasConcept = /মৃত্যুকালীন\s*ঘোষণা|dying\s*declaration/.test(combined);
      if (hasSection32_1(combined) && hasConcept && !hasForumOrRemedyTemplateMismatch(question, key)) {
        return {
          semanticMatch: true,
          requiresCorrectionAndOwnerApproval: false,
          status: 'VALID',
          reason: 'Matches Evidence Act, 1872 Section 32(1) (Dying Declaration).'
        };
      }
      return {
        semanticMatch: false,
        requiresCorrectionAndOwnerApproval: false,
        status: 'SEMANTIC_MISMATCH',
        reason: `Question ${question.id} does not match original q_evi_1 intent (Evidence Act Section 32(1) — Dying Declaration).`
      };
    }

    case 'q_cpc_1': {
      const hasCivilJurisdiction =
        /দেওয়ানী\s*আদালত|দেওয়ানী\s*প্রকৃতির\s*মোকদ্দমা|civil\s*courts?|civil\s*suits?/.test(combined) &&
        /এখতিয়ার|বিচার|jurisdiction|try/.test(combined);
      if (hasSection9(combined) && hasCivilJurisdiction && !hasForumOrRemedyTemplateMismatch(question, key)) {
        return {
          semanticMatch: true,
          requiresCorrectionAndOwnerApproval: false,
          status: 'VALID',
          reason: 'Matches CPC, 1908 Section 9 (Civil Courts Jurisdiction).'
        };
      }
      return {
        semanticMatch: false,
        requiresCorrectionAndOwnerApproval: false,
        status: 'SEMANTIC_MISMATCH',
        reason: `Question ${question.id} does not match original q_cpc_1 intent (CPC Section 9 — Civil Courts Jurisdiction).`
      };
    }

    default:
      return {
        semanticMatch: false,
        requiresCorrectionAndOwnerApproval: false,
        status: 'SEMANTIC_MISMATCH',
        reason: `Unknown slot ${slot.legacyQuestionId}.`
      };
  }
}

function buildPreservedSnapshot(raw: Record<string, unknown>, examId: string): PreservedExamSnapshot {
  const scheduledDate =
    typeof raw.scheduledDate === 'string' && raw.scheduledDate.trim()
      ? raw.scheduledDate.trim()
      : undefined;
  return {
    id: examId,
    titleBn: String(raw.titleBn ?? ''),
    titleEn: String(raw.titleEn ?? ''),
    type: String(raw.type ?? ''),
    isPaid: Boolean(raw.isPaid),
    isActive: raw.isActive !== undefined ? Boolean(raw.isActive) : !raw.isPaid,
    published: Boolean(raw.published),
    durationMinutes: Number(raw.durationMinutes ?? 0),
    totalMarks: Number(raw.totalMarks ?? 0),
    ...(raw.passThresholdPercentage !== undefined
      ? { passThresholdPercentage: Number(raw.passThresholdPercentage) }
      : {}),
    releaseExplanationsImmediately: Boolean(raw.releaseExplanationsImmediately),
    negativeMarkRatio: Number(raw.negativeMarkRatio ?? 0.25),
    positiveMarkRatio: Number(raw.positiveMarkRatio ?? 1),
    createdAt: timestampToIso(raw.createdAt) || String(raw.createdAt ?? ''),
    ...(scheduledDate ? { scheduledDate } : {})
  };
}

function validatePreservedInvariants(snapshot: PreservedExamSnapshot): string[] {
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
  if (snapshot.isActive !== true) {
    issues.push('Expected isActive=true to be preserved.');
  }
  if (snapshot.published !== true) {
    issues.push('Expected published=true to be preserved.');
  }
  if (snapshot.durationMinutes !== 60) {
    issues.push(`Expected durationMinutes=60, found ${snapshot.durationMinutes}.`);
  }
  if (snapshot.totalMarks !== 7) {
    issues.push(`Expected totalMarks=7, found ${snapshot.totalMarks}.`);
  }
  return issues;
}

async function commitExamRepairAtomicD1(
  db: D1Database,
  repairedExam: Exam,
  auditEntry: AuditLog,
  updatedAtIso: string
): Promise<void> {
  const isActive = repairedExam.isActive !== undefined ? Boolean(repairedExam.isActive) : !repairedExam.isPaid;
  const normalized: Exam = {
    ...repairedExam,
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

export async function handleOwnerExamRepairRoute(ctx: ExamRepairContext): Promise<{
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
  const body = await parseRepairJsonBody(request);
  if (body.examId !== undefined && String(body.examId).trim() !== TARGET_MODEL_TEST_2_EXAM_ID) {
    throw new WorkerHttpError(
      400,
      'INVALID_EXAM_ID',
      `This repair endpoint is strictly scoped to ${TARGET_MODEL_TEST_2_EXAM_ID}.`
    );
  }

  // Default to dry-run unless dryRun is explicitly set to boolean false
  if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') {
    throw new WorkerHttpError(400, 'INVALID_DRY_RUN_FLAG', 'dryRun must be a boolean if provided.');
  }
  const dryRun = body.dryRun !== false;

  const expectedUpdateTime =
    typeof body.expectedUpdateTime === 'string' && body.expectedUpdateTime.trim()
      ? body.expectedUpdateTime.trim()
      : null;

  const expectedQuestionIdsInput =
    body.expectedQuestionIds !== undefined ? normalizeStringArray(body.expectedQuestionIds) : null;
  if (body.expectedQuestionIds !== undefined && !expectedQuestionIdsInput) {
    throw new WorkerHttpError(400, 'INVALID_EXPECTED_QUESTION_IDS', 'expectedQuestionIds must be a string array.');
  }

  const replacementQuestionIdsInput = normalizeStringArray(body.replacementQuestionIds);
  if (!replacementQuestionIdsInput || replacementQuestionIdsInput.length !== MODEL_TEST_2_REPAIR_SLOTS.length) {
    throw new WorkerHttpError(
      400,
      'INVALID_REPLACEMENT_IDS',
      `replacementQuestionIds must contain exactly ${MODEL_TEST_2_REPAIR_SLOTS.length} ordered question IDs.`
    );
  }

  // Reject duplicates or legacy placeholder IDs immediately
  const seenReplacementIds = new Set<string>();
  for (const qId of replacementQuestionIdsInput) {
    if (seenReplacementIds.has(qId)) {
      throw new WorkerHttpError(
        400,
        'DUPLICATE_REPLACEMENT_ID',
        `Duplicate replacement question ID "${qId}" is not permitted.`
      );
    }
    seenReplacementIds.add(qId);
  }

  // 3. Read authoritative Firestore exam document with CAS metadata + D1 cached snapshot
  const ownerClient = firestoreClient.withToken(authUser.idToken);
  const [fsExamMeta, d1Exam] = await Promise.all([
    ownerClient.getDocumentWithMetadata<Record<string, unknown>>('exams', TARGET_MODEL_TEST_2_EXAM_ID),
    getExamFromCacheD1(db, TARGET_MODEL_TEST_2_EXAM_ID)
  ]);

  if (!fsExamMeta.data) {
    throw new WorkerHttpError(
      404,
      'EXAM_NOT_FOUND',
      `Authoritative Firestore exam ${TARGET_MODEL_TEST_2_EXAM_ID} was not found.`
    );
  }

  const currentUpdateTime = fsExamMeta.updateTime || null;
  const currentQuestionIds = Array.isArray(fsExamMeta.data.questionIds)
    ? fsExamMeta.data.questionIds.map(id => String(id).trim()).filter(Boolean)
    : [];

  const preservedSettings = buildPreservedSnapshot(fsExamMeta.data, TARGET_MODEL_TEST_2_EXAM_ID);
  const invariantIssues = validatePreservedInvariants(preservedSettings);

  // 4. CAS & Duplicate-Repair checks
  const blockedReasons: string[] = [...invariantIssues];

  const hasAnyLegacyId = currentQuestionIds.some(id => LEGACY_ID_SET.has(id));
  const matchesCanonicalLegacyOrder = arraysEqual(currentQuestionIds, CANONICAL_LEGACY_QUESTION_IDS);
  const alreadyRepaired =
    currentQuestionIds.length === MODEL_TEST_2_REPAIR_SLOTS.length && !hasAnyLegacyId;

  if (alreadyRepaired) {
    blockedReasons.push(
      `Exam ${TARGET_MODEL_TEST_2_EXAM_ID} has already been repaired (duplicate repair blocked).`
    );
  } else if (!matchesCanonicalLegacyOrder) {
    blockedReasons.push(
      `Firestore exam questionIds do not match the expected 7-question legacy snapshot (${CANONICAL_LEGACY_QUESTION_IDS.join(', ')}).`
    );
  }

  if (d1Exam) {
    const d1QIds = Array.isArray(d1Exam.questionIds) ? d1Exam.questionIds : [];
    if (!alreadyRepaired && !arraysEqual(d1QIds, currentQuestionIds)) {
      blockedReasons.push(
        'D1 edge_exams_cache questionIds diverge from authoritative Firestore exam snapshot.'
      );
    }
  }

  let casConflict = false;
  if (expectedUpdateTime && (!currentUpdateTime || expectedUpdateTime !== currentUpdateTime)) {
    casConflict = true;
    blockedReasons.push(
      `CAS updateTime mismatch: expected "${expectedUpdateTime}", actual "${currentUpdateTime ?? 'none'}".`
    );
  }
  if (expectedQuestionIdsInput && !arraysEqual(expectedQuestionIdsInput, currentQuestionIds)) {
    casConflict = true;
    blockedReasons.push(
      'CAS expectedQuestionIds snapshot mismatch against live Firestore exam questionIds.'
    );
  }

  // 5. Validate all 7 replacement questions against D1 question_bank_cache & question_keys_cache
  // allowRemoteFetch: false enforces strict D1 question_keys_cache presence verification
  const [questionMap, keyMap] = await Promise.all([
    querySanitizedQuestionsByIdsFromD1(db, replacementQuestionIdsInput),
    getAuthoritativeQuestionKeys(db, ownerClient, replacementQuestionIdsInput, {
      allowRemoteFetch: false
    })
  ]);

  const slotValidations: SlotValidationResult[] = [];
  let hasSlotRejection = false;
  let hasSemanticApprovalBlocker = false;

  for (const slot of MODEL_TEST_2_REPAIR_SLOTS) {
    const repId = replacementQuestionIdsInput[slot.slotIndex];

    if (LEGACY_ID_SET.has(repId)) {
      hasSlotRejection = true;
      const reason = `Slot #${slot.slotNumber}: replacement "${repId}" is a legacy static placeholder ID.`;
      blockedReasons.push(reason);
      slotValidations.push({
        slotNumber: slot.slotNumber,
        legacyQuestionId: slot.legacyQuestionId,
        replacementQuestionId: repId,
        expectedSubjectId: slot.expectedSubjectId,
        actualSubjectId: null,
        legalTopic: slot.legalTopic,
        questionFoundInD1: false,
        answerKeyFoundInD1: false,
        answerKeyValid: false,
        subjectMatch: false,
        semanticMatch: false,
        requiresCorrectionAndOwnerApproval: false,
        status: 'INVALID_QUESTION_ID',
        reason
      });
      continue;
    }

    const q = questionMap.get(repId);
    if (!q) {
      hasSlotRejection = true;
      const reason = `Slot #${slot.slotNumber}: question "${repId}" does not exist in D1 question_bank_cache.`;
      blockedReasons.push(reason);
      slotValidations.push({
        slotNumber: slot.slotNumber,
        legacyQuestionId: slot.legacyQuestionId,
        replacementQuestionId: repId,
        expectedSubjectId: slot.expectedSubjectId,
        actualSubjectId: null,
        legalTopic: slot.legalTopic,
        questionFoundInD1: false,
        answerKeyFoundInD1: false,
        answerKeyValid: false,
        subjectMatch: false,
        semanticMatch: false,
        requiresCorrectionAndOwnerApproval: false,
        status: 'MISSING_QUESTION',
        reason
      });
      continue;
    }

    const keyRec = keyMap.get(repId);
    const keyCheck = validateAnswerKeyIntegrity(q, keyRec);
    if (!keyCheck.found || !keyCheck.valid) {
      hasSlotRejection = true;
      const status: SlotValidationStatus = !keyCheck.found ? 'MISSING_ANSWER_KEY' : 'CORRUPT_ANSWER_KEY';
      const reason = `Slot #${slot.slotNumber} (${repId}): ${keyCheck.reason}`;
      blockedReasons.push(reason);
      slotValidations.push({
        slotNumber: slot.slotNumber,
        legacyQuestionId: slot.legacyQuestionId,
        replacementQuestionId: repId,
        expectedSubjectId: slot.expectedSubjectId,
        actualSubjectId: q.subjectId,
        legalTopic: slot.legalTopic,
        questionFoundInD1: true,
        answerKeyFoundInD1: keyCheck.found,
        answerKeyValid: keyCheck.valid,
        subjectMatch: q.subjectId === slot.expectedSubjectId,
        semanticMatch: false,
        requiresCorrectionAndOwnerApproval: false,
        status,
        reason
      });
      continue;
    }

    const subjectMatch = q.subjectId === slot.expectedSubjectId;
    if (!subjectMatch) {
      hasSlotRejection = true;
      const reason =
        `Slot #${slot.slotNumber} (${repId}): subject mismatch ` +
        `(expected "${slot.expectedSubjectId}", found "${q.subjectId}").`;
      blockedReasons.push(reason);
      slotValidations.push({
        slotNumber: slot.slotNumber,
        legacyQuestionId: slot.legacyQuestionId,
        replacementQuestionId: repId,
        expectedSubjectId: slot.expectedSubjectId,
        actualSubjectId: q.subjectId,
        legalTopic: slot.legalTopic,
        questionFoundInD1: true,
        answerKeyFoundInD1: true,
        answerKeyValid: true,
        subjectMatch: false,
        semanticMatch: false,
        requiresCorrectionAndOwnerApproval: false,
        status: 'SUBJECT_MISMATCH',
        reason
      });
      continue;
    }

    const semanticCheck = validateLegalQuestionIntent(slot, q, keyRec);
    if (!semanticCheck.semanticMatch) {
      hasSlotRejection = true;
      if (semanticCheck.requiresCorrectionAndOwnerApproval) {
        hasSemanticApprovalBlocker = true;
      }
      blockedReasons.push(semanticCheck.reason);
      slotValidations.push({
        slotNumber: slot.slotNumber,
        legacyQuestionId: slot.legacyQuestionId,
        replacementQuestionId: repId,
        expectedSubjectId: slot.expectedSubjectId,
        actualSubjectId: q.subjectId,
        legalTopic: slot.legalTopic,
        questionFoundInD1: true,
        answerKeyFoundInD1: true,
        answerKeyValid: true,
        subjectMatch: true,
        semanticMatch: false,
        requiresCorrectionAndOwnerApproval: semanticCheck.requiresCorrectionAndOwnerApproval,
        status: semanticCheck.status,
        reason: semanticCheck.reason
      });
      continue;
    }

    slotValidations.push({
      slotNumber: slot.slotNumber,
      legacyQuestionId: slot.legacyQuestionId,
      replacementQuestionId: repId,
      expectedSubjectId: slot.expectedSubjectId,
      actualSubjectId: q.subjectId,
      legalTopic: slot.legalTopic,
      questionFoundInD1: true,
      answerKeyFoundInD1: true,
      answerKeyValid: true,
      subjectMatch: true,
      semanticMatch: true,
      requiresCorrectionAndOwnerApproval: false,
      status: 'VALID',
      reason: semanticCheck.reason
    });
  }

  const safeToExecute = blockedReasons.length === 0 && !hasSlotRejection && !alreadyRepaired && !casConflict;

  // 6. Dry-run returns diagnostic report immediately with ZERO writes
  if (dryRun) {
    const report: ExamRepairReport = {
      examId: TARGET_MODEL_TEST_2_EXAM_ID,
      mode: 'dry_run',
      dryRun: true,
      safeToExecute,
      executed: false,
      alreadyRepaired,
      casConflict,
      currentUpdateTime,
      expectedUpdateTime,
      currentQuestionIds,
      replacementQuestionIds: replacementQuestionIdsInput,
      preservedSettings,
      slotValidations,
      blockedReasons
    };
    return {
      status: 200,
      payload: report
    };
  }

  // 7. Execute-mode strict gates (ZERO writes on any failure)
  if (!expectedUpdateTime) {
    throw new WorkerHttpError(
      400,
      'CAS_PRECONDITION_REQUIRED',
      'expectedUpdateTime (Firestore document updateTime from dry-run) is required when dryRun=false.'
    );
  }

  if (alreadyRepaired) {
    return {
      status: 409,
      payload: {
        error: 'ALREADY_REPAIRED',
        message: `Exam ${TARGET_MODEL_TEST_2_EXAM_ID} has already been repaired.`,
        report: {
          examId: TARGET_MODEL_TEST_2_EXAM_ID,
          mode: 'dry_run',
          dryRun: false,
          safeToExecute: false,
          executed: false,
          alreadyRepaired: true,
          casConflict,
          currentUpdateTime,
          expectedUpdateTime,
          currentQuestionIds,
          replacementQuestionIds: replacementQuestionIdsInput,
          preservedSettings,
          slotValidations,
          blockedReasons
        }
      }
    };
  }

  if (casConflict || !matchesCanonicalLegacyOrder || invariantIssues.length > 0) {
    return {
      status: 409,
      payload: {
        error: 'CAS_CONFLICT',
        message: blockedReasons[0] || 'Exam CAS snapshot precondition failed.',
        report: {
          examId: TARGET_MODEL_TEST_2_EXAM_ID,
          mode: 'dry_run',
          dryRun: false,
          safeToExecute: false,
          executed: false,
          alreadyRepaired: false,
          casConflict: true,
          currentUpdateTime,
          expectedUpdateTime,
          currentQuestionIds,
          replacementQuestionIds: replacementQuestionIdsInput,
          preservedSettings,
          slotValidations,
          blockedReasons
        }
      }
    };
  }

  if (hasSlotRejection || !safeToExecute) {
    const errorCode = hasSemanticApprovalBlocker
      ? 'SEMANTIC_MISMATCH_REQUIRES_CORRECTION'
      : 'REPAIR_VALIDATION_FAILED';
    return {
      status: 422,
      payload: {
        error: errorCode,
        message: blockedReasons[0] || 'One or more replacement questions failed validation.',
        report: {
          examId: TARGET_MODEL_TEST_2_EXAM_ID,
          mode: 'dry_run',
          dryRun: false,
          safeToExecute: false,
          executed: false,
          alreadyRepaired: false,
          casConflict: false,
          currentUpdateTime,
          expectedUpdateTime,
          currentQuestionIds,
          replacementQuestionIds: replacementQuestionIdsInput,
          preservedSettings,
          slotValidations,
          blockedReasons
        }
      }
    };
  }

  // 8. Atomic Firestore CAS update (patches ONLY questionIds + updatedAt) + Audit Log
  const auditEntry: AuditLog = {
    id: makeRepairAuditId(nowMs),
    userId: authUser.uid,
    userName: authUser.email || 'Owner Admin',
    action: 'REPAIR_OWNER_EXAM_QUESTIONS',
    details: `CAS-repaired ${TARGET_MODEL_TEST_2_EXAM_ID} questionIds [${CANONICAL_LEGACY_QUESTION_IDS.join(',')}] -> [${replacementQuestionIdsInput.join(',')}]`,
    timestamp: nowIso
  };

  await ownerClient.commitWrites([
    {
      type: 'update',
      collection: 'exams',
      docId: TARGET_MODEL_TEST_2_EXAM_ID,
      patch: {
        questionIds: replacementQuestionIdsInput,
        updatedAt: nowIso
      },
      currentDocument: {
        updateTime: expectedUpdateTime
      }
    },
    {
      type: 'set',
      collection: 'auditLogs',
      docId: auditEntry.id,
      data: { ...auditEntry }
    }
  ]);

  // 9. Sync D1 edge_exams_cache + edge_audit_logs atomically ONLY AFTER Firestore CAS commit succeeds
  const baseExam = (d1Exam || fsExamMeta.data) as unknown as Exam & { updatedAt?: string };
  const repairedExam: Exam & { updatedAt: string } = {
    ...baseExam,
    id: TARGET_MODEL_TEST_2_EXAM_ID,
    questionIds: [...replacementQuestionIdsInput],
    updatedAt: nowIso
  };

  await commitExamRepairAtomicD1(db, repairedExam, auditEntry, nowIso);

  const executedReport: ExamRepairReport = {
    examId: TARGET_MODEL_TEST_2_EXAM_ID,
    mode: 'executed',
    dryRun: false,
    safeToExecute: true,
    executed: true,
    alreadyRepaired: false,
    casConflict: false,
    currentUpdateTime,
    expectedUpdateTime,
    currentQuestionIds,
    replacementQuestionIds: replacementQuestionIdsInput,
    preservedSettings,
    slotValidations,
    blockedReasons: [],
    auditLogId: auditEntry.id,
    repairedAt: nowIso
  };

  return {
    status: 200,
    payload: {
      success: true,
      exam: repairedExam,
      report: executedReport
    }
  };
}
