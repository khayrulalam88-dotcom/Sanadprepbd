import type { Exam } from '../types/index.ts';
import examsMeta from './initialExamsMeta.json' with { type: 'json' };

// 30 Full 60-Minute Bar Council Model Tests (মডেল টেস্ট ০১ থেকে ৩০)
export const MODEL_TESTS_30: Exam[] = examsMeta.modelTests30 as Exam[];

// Subject tests & practice quizzes
export const SUBJECT_PRACTICE_TESTS: Exam[] = examsMeta.subjectPracticeTests as Exam[];

export const INITIAL_EXAMS: Exam[] = [
  ...MODEL_TESTS_30,
  ...SUBJECT_PRACTICE_TESTS
];
