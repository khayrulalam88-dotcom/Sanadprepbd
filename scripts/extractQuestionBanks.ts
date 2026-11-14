import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Question, Exam, PreviousQuestion } from '../src/types/index.ts';
import { generate30ModelTests } from '../src/utils/modelTestGenerator.ts';
import { INITIAL_PREVIOUS_QUESTIONS } from '../src/data/initialPreviousQuestions.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const qbPath = path.resolve(rootDir, 'src/data/questionBank3000.json');
const rawQuestions: Question[] = JSON.parse(fs.readFileSync(qbPath, 'utf-8'));

// Deduplicate just in case
const questionMap = new Map<string, Question>();
for (const q of rawQuestions) {
  questionMap.set(q.id, q);
}
const allFullQuestions = Array.from(questionMap.values());

const serverDataDir = path.resolve(rootDir, 'server/data');
fs.mkdirSync(serverDataDir, { recursive: true });

// 1. Write full authoritative MCQ bank (ONLY on server)
const serverQbPath = path.resolve(serverDataDir, 'questionBankFull.json');
fs.writeFileSync(serverQbPath, JSON.stringify(allFullQuestions, null, 2), 'utf-8');

// 2. Write full authoritative Previous Questions bank (ONLY on server)
const serverPqPath = path.resolve(serverDataDir, 'previousQuestionsFull.json');
fs.writeFileSync(serverPqPath, JSON.stringify(INITIAL_PREVIOUS_QUESTIONS, null, 2), 'utf-8');

// 3. Write compact Exam Metadata (IDs + titles + questionIds, NO question text or answers!)
const modelTests30: Exam[] = generate30ModelTests(allFullQuestions);
const subjectPracticeTests: Exam[] = [
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
    questionIds: allFullQuestions
      .filter(q => q.subjectId === 'sub_cpc' || q.subjectId === 'sub_limitation')
      .map(q => q.id),
    isPaid: false,
    isActive: true,
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
    questionIds: allFullQuestions
      .filter(q => q.subjectId === 'sub_crpc' || q.subjectId === 'sub_penal')
      .map(q => q.id),
    isPaid: false,
    isActive: true,
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
    questionIds: allFullQuestions.slice(0, 10).map(q => q.id),
    isPaid: false,
    isActive: true,
    published: true,
    releaseExplanationsImmediately: true,
    negativeMarkRatio: 0.25,
    positiveMarkRatio: 1.0,
    createdAt: '2026-02-15T00:00:00Z'
  }
];

const examsMetaPath = path.resolve(rootDir, 'src/data/initialExamsMeta.json');
fs.writeFileSync(
  examsMetaPath,
  JSON.stringify({ modelTests30, subjectPracticeTests }, null, 2),
  'utf-8'
);

// 4. Write sanitized Previous Questions list (NO correctAnswer, NO explanation)
const sanitizedPrevious: PreviousQuestion[] = INITIAL_PREVIOUS_QUESTIONS.map(pq => ({
  id: pq.id,
  year: pq.year,
  subject: pq.subject,
  question: pq.question,
  options: pq.options,
  legalSection: pq.legalSection,
  source: pq.source
}));
const sanitizedPqPath = path.resolve(rootDir, 'src/data/sanitizedPreviousQuestions.json');
fs.writeFileSync(sanitizedPqPath, JSON.stringify(sanitizedPrevious, null, 2), 'utf-8');

console.log(`Extracted ${allFullQuestions.length} full MCQs -> ${serverQbPath}`);
console.log(`Extracted ${INITIAL_PREVIOUS_QUESTIONS.length} previous questions -> ${serverPqPath}`);
console.log(`Wrote exam metadata (${modelTests30.length} model + ${subjectPracticeTests.length} subject) -> ${examsMetaPath}`);
console.log(`Wrote sanitized previous questions -> ${sanitizedPqPath}`);
