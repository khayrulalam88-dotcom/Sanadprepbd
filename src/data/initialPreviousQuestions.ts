import type { PreviousQuestion } from '../types/index.ts';
import sanitizedPreviousQuestions from './sanitizedPreviousQuestions.json' with { type: 'json' };

export const INITIAL_PREVIOUS_QUESTIONS: PreviousQuestion[] =
  sanitizedPreviousQuestions as PreviousQuestion[];
