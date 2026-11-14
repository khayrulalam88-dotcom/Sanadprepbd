import type { Exam } from '../types/index.ts';
import { INITIAL_QUESTIONS } from './mockData.ts';
import { generate30ModelTests } from '../utils/modelTestGenerator.ts';

// 30 Full 60-Minute Bar Council Model Tests (মডেল টেস্ট ০১ থেকে ৩০)
export const MODEL_TESTS_30: Exam[] = generate30ModelTests(INITIAL_QUESTIONS);

// Subject tests & practice quizzes
export const SUBJECT_PRACTICE_TESTS: Exam[] = [
  {
    id: 'exam_sub_cpc',
    titleBn: 'দেওয়ানী কার্যবিধি ও তামাদি আইন সমন্বিত পরীক্ষা',
    titleEn: 'Civil Procedure Code & Limitation Act Subject Test',
    descriptionBn: 'দেওয়ানী মোকদ্দমা, ডিক্রি, আপিল, রিভিউ এবং তামাদির সময় গণনা সংক্রান্ত বিষয়ভিত্তিক পরীক্ষা।',
    descriptionEn: 'Subject test focusing on jurisdiction, suits, decrees, temporary injunctions, and condonation of delay.',
    type: 'subject_test',
    durationMinutes: 20,
    totalMarks: 20,
    passThresholdPercentage: 50,
    questionIds: INITIAL_QUESTIONS.filter(q => q.subjectId === 'sub_cpc' || q.subjectId === 'sub_limitation').map(q => q.id),
    isPaid: false,
    published: true,
    releaseExplanationsImmediately: true,
    subjectId: 'sub_cpc',
    negativeMarkRatio: 0.25,
    positiveMarkRatio: 1.0,
    createdAt: '2026-02-10T00:00:00Z'
  },
  {
    id: 'exam_sub_crpc_penal',
    titleBn: 'ফৌজদারী কার্যবিধি ও দণ্ডবিধি বিষয়ভিত্তিক পরীক্ষা',
    titleEn: 'Criminal Procedure & Penal Code Subject Test',
    descriptionBn: 'এফআইআর, গ্রেপ্তার, রিমান্ড, চার্জ গঠন, অপরাধমূলক নরহত্যা, খুন এবং আত্মরক্ষা সংক্রান্ত প্রশ্ন।',
    descriptionEn: 'Subject test covering FIR, arrests, bail provisions, homicide, murder, and private defence.',
    type: 'subject_test',
    durationMinutes: 25,
    totalMarks: 25,
    passThresholdPercentage: 50,
    questionIds: INITIAL_QUESTIONS.filter(q => q.subjectId === 'sub_crpc' || q.subjectId === 'sub_penal').map(q => q.id),
    isPaid: false,
    published: true,
    releaseExplanationsImmediately: true,
    subjectId: 'sub_crpc',
    negativeMarkRatio: 0.25,
    positiveMarkRatio: 1.0,
    createdAt: '2026-02-12T00:00:00Z'
  },
  {
    id: 'exam_quick_demo',
    titleBn: 'দ্রুত প্রস্তুতি কুইজ (ডেমো প্র্যাকটিস টেস্ট)',
    titleEn: 'Speed Assessment Quiz (Demo Practice Test)',
    descriptionBn: 'সকল বিষয়ের মূল ধারাসমূহ নিয়ে দ্রুত যাচাইমূলক পরীক্ষা।',
    descriptionEn: 'Fast-paced assessment across all Bar Council syllabus subjects.',
    type: 'practice_quiz',
    durationMinutes: 10,
    totalMarks: 10,
    passThresholdPercentage: 50,
    questionIds: INITIAL_QUESTIONS.slice(0, 10).map(q => q.id),
    isPaid: false,
    published: true,
    releaseExplanationsImmediately: true,
    negativeMarkRatio: 0.25,
    positiveMarkRatio: 1.0,
    createdAt: '2026-02-15T00:00:00Z'
  }
];

export const INITIAL_EXAMS: Exam[] = [
  ...MODEL_TESTS_30,
  ...SUBJECT_PRACTICE_TESTS
];
