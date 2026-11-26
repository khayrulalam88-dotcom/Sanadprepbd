import type { Question, QuestionDifficulty, QuestionStatus } from '../types';
import { formatBackendApiError, isBackendUnavailableResponse, type BackendApiResult } from './securityHelpers';

export type AdminQuestionBankErrorCategory = 'auth' | 'forbidden' | 'quota' | 'unavailable' | 'other';

export interface AdminQuestionBankLoadState {
  status: 'idle' | 'loading' | 'loaded' | 'error';
  questionCount: number;
  totalCount?: number;
  source?: 'd1' | 'firestore';
  httpStatus?: number;
  errorCode?: string;
  errorCategory?: AdminQuestionBankErrorCategory;
  errorMessage?: string;
}

export function classifyAdminQuestionBankError(params: {
  status: number;
  code?: string;
}): AdminQuestionBankErrorCategory {
  if (
    params.status === 401 ||
    params.code === 'UNAUTHORIZED' ||
    params.code === 'INVALID_TOKEN' ||
    params.code === 'SESSION_REVOKED' ||
    params.code === 'SESSION_REQUIRED' ||
    params.code === 'SESSION_MISMATCH' ||
    params.code === 'EMAIL_NOT_VERIFIED'
  ) {
    return 'auth';
  }
  if (params.status === 403 || params.code === 'FORBIDDEN' || params.code === 'PERMISSION_DENIED') {
    return 'forbidden';
  }
  if (
    params.code === 'RESOURCE_EXHAUSTED' ||
    params.code === 'FIRESTORE_QUOTA_EXHAUSTED' ||
    (params.status === 429 && params.code !== 'RATE_LIMITED')
  ) {
    return 'quota';
  }
  if (isBackendUnavailableResponse({ ok: false, status: params.status, code: params.code })) {
    return 'unavailable';
  }
  return 'other';
}

export function resolveAdminQuestionBankFetchOutcome(
  res: BackendApiResult<{
    questions: Question[];
    total?: number;
    source?: 'd1' | 'firestore';
  }>,
  options?: { previousQuestionCount?: number }
): {
  ok: boolean;
  questions: Question[];
  total: number;
  state: AdminQuestionBankLoadState;
} {
  if (res.ok && res.data && Array.isArray(res.data.questions)) {
    const resolvedTotal =
      typeof res.data.total === 'number' ? res.data.total : res.data.questions.length;
    return {
      ok: true,
      questions: res.data.questions,
      total: resolvedTotal,
      state: {
        status: 'loaded',
        questionCount: resolvedTotal,
        totalCount: resolvedTotal,
        source: res.data.source || 'd1'
      }
    };
  }

  const errorCategory = classifyAdminQuestionBankError({
    status: res.status,
    code: res.code
  });
  const errorMessage = formatBackendApiError({
    status: res.status,
    code: res.code,
    serverMessage: res.message,
    isJson: res.code !== 'NON_JSON_RESPONSE'
  });

  const preservedCount = Math.max(0, options?.previousQuestionCount ?? 0);

  return {
    ok: false,
    questions: [],
    total: preservedCount,
    state: {
      status: 'error',
      questionCount: preservedCount,
      totalCount: preservedCount,
      httpStatus: res.status,
      errorCode: res.code,
      errorCategory,
      errorMessage
    }
  };
}

export interface ManualQuestionFormInput {
  subjectId: string;
  topicId?: string;
  questionBn: string;
  questionEn?: string;
  optionsBn: string[];
  optionsEn?: string[];
  correctOptionIndex: number;
  explanationBn?: string;
  explanationEn?: string;
  legalReference?: string;
  difficulty: QuestionDifficulty;
  status: QuestionStatus;
  isDemoSample?: boolean;
}

/**
 * Builds the payload for manual Owner Admin question creation.
 * Defaults strictly to `isDemoSample: false` so newly authored questions
 * enter the paid question bank unless intentionally checked as a free demo sample.
 */
export function buildManualQuestionInput(
  input: ManualQuestionFormInput
): Omit<Question, 'id' | 'createdAt' | 'updatedAt'> {
  const cleanOptionsBn = input.optionsBn.map(o => o.trim());
  const hasEnglishOptions = Boolean(input.optionsEn && input.optionsEn[0]?.trim());

  return {
    subjectId: input.subjectId,
    ...(input.topicId ? { topicId: input.topicId } : {}),
    questionBn: input.questionBn.trim(),
    questionEn: input.questionEn?.trim() ? input.questionEn.trim() : input.questionBn.trim(),
    optionsBn: cleanOptionsBn,
    optionsEn: hasEnglishOptions ? input.optionsEn!.map(o => o.trim()) : cleanOptionsBn,
    correctOptionIndex: input.correctOptionIndex,
    explanationBn: (input.explanationBn || '').trim(),
    explanationEn: (input.explanationEn || '').trim() || (input.explanationBn || '').trim(),
    legalReference: (input.legalReference || '').trim(),
    difficulty: input.difficulty,
    status: input.status,
    isDemoSample: input.isDemoSample === true
  };
}
