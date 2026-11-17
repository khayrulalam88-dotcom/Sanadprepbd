import type { Question, QuestionDifficulty, QuestionStatus } from '../types';

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
