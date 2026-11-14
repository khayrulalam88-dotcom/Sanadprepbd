import type { Question } from '../types/index.ts';

export interface ScoreCalculationResult {
  totalQuestions: number;
  correctAnswersCount: number;
  incorrectAnswersCount: number;
  unansweredCount: number;
  positiveMarks: number;
  negativeMarks: number;
  finalScore: number;
  percentage: number;
  passed?: boolean;
}

/**
 * Server-authoritative calculation of exam score.
 * Formula: Final Score = (Number of Correct Answers × 1) − (Number of Incorrect Answers × 0.25)
 * Unanswered questions: 0 marks
 * No silent zero floor: negative scores are preserved unless explicitly configured otherwise.
 */
export function calculateExamScore(
  answers: Record<string, number>,
  questions: Question[],
  options?: {
    positiveMarkRatio?: number;
    negativeMarkRatio?: number;
    passThresholdPercentage?: number;
  }
): ScoreCalculationResult {
  const positiveRatio = options?.positiveMarkRatio ?? 1.0;
  const negativeRatio = options?.negativeMarkRatio ?? 0.25;
  const passThreshold = options?.passThresholdPercentage;

  let correctCount = 0;
  let incorrectCount = 0;
  let unansweredCount = 0;

  for (const question of questions) {
    const selectedAnswer = answers[question.id];
    if (selectedAnswer === undefined || selectedAnswer === null || selectedAnswer === -1) {
      unansweredCount++;
    } else if (question.correctOptionIndex !== undefined && selectedAnswer === question.correctOptionIndex) {
      correctCount++;
    } else {
      incorrectCount++;
    }
  }

  const positiveMarks = correctCount * positiveRatio;
  const negativeMarks = incorrectCount * negativeRatio;
  const rawFinalScore = positiveMarks - negativeMarks;

  // Round display score to 2 decimal places to avoid floating point artifacts (e.g. 65.00)
  const finalScore = Math.round(rawFinalScore * 100) / 100;
  const totalQuestions = questions.length;
  
  // Percentage based on max possible marks
  const percentage = totalQuestions > 0 
    ? Math.round((finalScore / totalQuestions) * 1000) / 10 
    : 0;

  const passed = passThreshold !== undefined ? percentage >= passThreshold : undefined;

  return {
    totalQuestions,
    correctAnswersCount: correctCount,
    incorrectAnswersCount: incorrectCount,
    unansweredCount,
    positiveMarks,
    negativeMarks,
    finalScore,
    percentage,
    passed
  };
}

/**
 * Format time in MM:SS
 */
export function formatSecondsToTime(seconds: number): string {
  if (seconds < 0) seconds = 0;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Format English digits to Bengali digits if needed
 */
export function toBengaliNumerals(number: string | number): string {
  const bengaliDigits = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];
  return String(number).replace(/[0-9]/g, (match) => bengaliDigits[parseInt(match, 10)]);
}
