import type { Exam, Question } from '../types/index.ts';

/**
 * Standard Bangladesh Bar Council Syllabus Subject Mark Weights (Total: 100)
 */
export const BAR_COUNCIL_SYLLABUS_QUOTAS = {
  sub_cpc: 20,         // Code of Civil Procedure, 1908
  sub_crpc: 20,        // Code of Criminal Procedure, 1898
  sub_penal: 20,       // Penal Code, 1860
  sub_evidence: 15,    // Evidence Act, 1872
  sub_sra: 10,         // Specific Relief Act, 1877
  sub_limitation: 10,  // Limitation Act, 1908
  sub_bar_ethics: 5    // Legal Practitioners & Bar Council Rules / Ethics
};

export const MODEL_TEST_THEMES = [
  { bn: 'অফিসিয়াল সিলেবাস সিমুলেশন (Official Syllabus Simulation)', en: 'Official Syllabus Simulation' },
  { bn: 'স্পেশাল মডেল টেস্ট - উচ্চ ফলনশীল ধারা (High-Yield Sections)', en: 'High-Yield Statutory Sections' },
  { bn: 'দেওয়ানী ও তামাদি আইন সমন্বিত প্রস্তুতি', en: 'Civil Procedure & Limitation Intensive' },
  { bn: 'ফৌজদারী ও দণ্ডবিধি অপরাধ বিশ্লেষণ', en: 'CrPC & Penal Code Crimes Mastery' },
  { bn: 'সাক্ষ্য আইন ও প্রমাণ তত্ত্ব স্পেশাল', en: 'Evidence Act & Burden of Proof Special' },
  { bn: 'সুনির্দিষ্ট প্রতিকার ও চুক্তি বলবৎকরণ', en: 'Specific Relief & Injunctions Core' },
  { bn: 'বার কাউন্সিল অর্ডার ও পেশাগত এথিক্স নিবিড় অনুশীলন', en: 'Bar Council Order & Legal Ethics Focus' },
  { bn: 'আইনগত সংজ্ঞা ও বিচারিক সিদ্ধান্ত স্পেশাল', en: 'Statutory Definitions & Precedents' },
  { bn: 'প্রক্রিয়াগত আইন ও আদালতের কার্যপদ্ধতি', en: 'Procedural Codes & Trial Practice' },
  { bn: 'মৌলিক অপরাধ ও দণ্ড নিরূপণ মডেল টেস্ট', en: 'Offences & Punishments Determination' },
  { bn: 'আপিল, রিভিউ ও রিভিশন বিশেষ পরীক্ষা', en: 'Appeals, Reviews & Revisions Special' },
  { bn: 'জামিন ও তদন্ত প্রক্রিয়া সংক্রান্ত প্রশ্নব্যাংক', en: 'Bail & Investigation Procedure' },
  { bn: 'ডিক্রি জারি ও রিসিভার নিয়োগ মডেল টেস্ট', en: 'Execution of Decrees & Receivers' },
  { bn: 'মৃত্যুকালীন ঘোষণা ও বিশেষজ্ঞ মতামত স্পেশাল', en: 'Dying Declaration & Expert Testimony' },
  { bn: 'বিলম্ব মওকুফ ও দখল পুনরুদ্ধার স্পেশাল', en: 'Condonation of Delay & Possession' },
  { bn: 'আত্মরক্ষার ব্যক্তিগত অধিকার ও ব্যতিক্রমি ধারা', en: 'Right of Private Defence & Exceptions' },
  { bn: 'আরজি খারিজ ও একতরফা ডিক্রি রদ', en: 'Rejection of Plaint & Setting Aside Ex-parte' },
  { bn: 'তল্লাশি, হুলিয়া ও ক্রোক পরোয়ানা মডেল টেস্ট', en: 'Search, Proclamation & Attachment' },
  { bn: 'দলিল বাতিল ও চুক্তি রদ সমন্বিত প্রস্তুতি', en: 'Cancellation of Instruments & Rescission' },
  { bn: 'অস্থায়ী ও চিরতরে স্থায়ী নিষেধাজ্ঞা স্পেশাল', en: 'Temporary & Perpetual Injunctions Mastery' },
  { bn: 'খুন, নরহত্যা ও গুরুতর আঘাত বিশ্লেষণ', en: 'Homicide, Murder & Grievous Hurt' },
  { bn: 'চুরি, চাঁদাবাজি ও ডাকাতি অপরাধ নিবিড় প্রস্তুতি', en: 'Theft, Extortion & Dacoity Practice' },
  { bn: 'প্রাথমিক ও মাধ্যমিক সাক্ষ্য মূল্যায়ন', en: 'Primary & Secondary Evidence Assessment' },
  { bn: 'জেরা ও সাক্ষীর বিশ্বাসযোগ্যতা ক্ষুণ্নকরণ', en: 'Cross-Examination & Witness Credibility' },
  { bn: 'আইনগত অক্ষমতা ও তামাদির অবিরাম প্রবাহ', en: 'Legal Disability & Running of Time' },
  { bn: 'ব্যবহারজনিত স্বত্ব ও সুখাাধিকার বিশেষ টেস্ট', en: 'Prescription & Easement Rights' },
  { bn: 'ডিসিপ্লিনারি ট্রাইব্যুনাল ও সনদ বাতিল বিধি', en: 'Disciplinary Tribunal & Misconduct Rules' },
  { bn: 'বার কাউন্সিল চূড়ান্ত রিভিশন মডেল টেস্ট - ০১', en: 'Bar Council Grand Final Revision - 01' },
  { bn: 'বার কাউন্সিল চূড়ান্ত রিভিশন মডেল টেস্ট - ০২', en: 'Bar Council Grand Final Revision - 02' },
  { bn: 'বার কাউন্সিল গ্র্যান্ড মাস্টার টেস্ট - ৩০ (পূর্ণাঙ্গ ফাইনাল)', en: 'Bar Council Grand Master Test - 30 (Ultimate Final)' }
];

/**
 * Generate 30 Bar Council Full Mock Tests with 100 questions each,
 * balanced across the 7 statutory subjects.
 */
export function generate30ModelTests(allQuestions: Question[]): Exam[] {
  // Group questions by subject
  const cpcQuestions = allQuestions.filter(q => q.subjectId === 'sub_cpc');
  const sraQuestions = allQuestions.filter(q => q.subjectId === 'sub_sra');
  const crpcQuestions = allQuestions.filter(q => q.subjectId === 'sub_crpc');
  const penalQuestions = allQuestions.filter(q => q.subjectId === 'sub_penal');
  const evidenceQuestions = allQuestions.filter(q => q.subjectId === 'sub_evidence');
  const limitationQuestions = allQuestions.filter(q => q.subjectId === 'sub_limitation');
  const ethicsQuestions = allQuestions.filter(q => q.subjectId === 'sub_bar_ethics');

  const modelTests: Exam[] = [];

  for (let i = 0; i < 30; i++) {
    const testNum = i + 1;
    const testNumPadded = String(testNum).padStart(2, '0');
    const theme = MODEL_TEST_THEMES[i] || { 
      bn: `বার কাউন্সিল স্পেশাল মডেল টেস্ট - ${testNumPadded}`, 
      en: `Bar Council Special Model Test - ${testNumPadded}` 
    };

    const selectedQuestionIds: string[] = [];

    // Helper to select questions for test i with precise syllabus quotas
    const pickSyllabusQuestions = (pool: Question[], neededCount: number) => {
      if (pool.length === 0) return;
      if (pool.length >= neededCount * 30) {
        // Exact partitioning across 30 tests
        const start = i * neededCount;
        for (let k = 0; k < neededCount && (start + k) < pool.length; k++) {
          selectedQuestionIds.push(pool[start + k].id);
        }
      } else {
        // Fallback for smaller pools with wrap-around
        const startIndex = (i * neededCount) % pool.length;
        for (let k = 0; k < neededCount; k++) {
          const idx = (startIndex + k) % pool.length;
          const qId = pool[idx]?.id;
          if (qId && !selectedQuestionIds.includes(qId)) {
            selectedQuestionIds.push(qId);
          }
        }
      }
    };

    // Pick according to official Bangladesh Bar Council syllabus ratios (100 total):
    pickSyllabusQuestions(cpcQuestions, BAR_COUNCIL_SYLLABUS_QUOTAS.sub_cpc);           // 20 questions
    pickSyllabusQuestions(crpcQuestions, BAR_COUNCIL_SYLLABUS_QUOTAS.sub_crpc);         // 20 questions
    pickSyllabusQuestions(penalQuestions, BAR_COUNCIL_SYLLABUS_QUOTAS.sub_penal);       // 20 questions
    pickSyllabusQuestions(evidenceQuestions, BAR_COUNCIL_SYLLABUS_QUOTAS.sub_evidence); // 15 questions
    pickSyllabusQuestions(sraQuestions, BAR_COUNCIL_SYLLABUS_QUOTAS.sub_sra);           // 10 questions
    pickSyllabusQuestions(limitationQuestions, BAR_COUNCIL_SYLLABUS_QUOTAS.sub_limitation); // 10 questions
    pickSyllabusQuestions(ethicsQuestions, BAR_COUNCIL_SYLLABUS_QUOTAS.sub_bar_ethics); // 5 questions

    // Safety fallback to ensure exact 100 questions
    if (selectedQuestionIds.length < 100 && allQuestions.length > selectedQuestionIds.length) {
      let candidateIdx = (i * 33) % allQuestions.length;
      let safetyCounter = 0;
      while (selectedQuestionIds.length < 100 && safetyCounter < allQuestions.length) {
        const qId = allQuestions[candidateIdx % allQuestions.length]?.id;
        if (qId && !selectedQuestionIds.includes(qId)) {
          selectedQuestionIds.push(qId);
        }
        candidateIdx++;
        safetyCounter++;
      }
    }

    const isFirstDemo = testNum === 1;

    modelTests.push({
      id: `exam_model_test_${testNumPadded}`,
      titleBn: `বার কাউন্সিল পূর্ণাঙ্গ মডেল টেস্ট - ${testNumPadded} ${isFirstDemo ? '(ফ্রি ডেমো)' : ''}`,
      titleEn: `Bar Council Full Mock Test - ${testNumPadded} ${isFirstDemo ? '(Free Demo)' : ''}`,
      descriptionBn: `১০০ টি বহুনিবার্চনী প্রশ্ন, সময় ৬০ মিনিট। বিষয়বস্তু: ${theme.bn}। সঠিক উত্তরের জন্য +১ মার্ক এবং ভুল উত্তরের জন্য -০.২৫ মার্ক কর্তন। পাস মার্ক ৫০%।`,
      descriptionEn: `100 MCQs, duration 60 minutes. Focus: ${theme.en}. +1 mark for correct and -0.25 negative mark for incorrect answers. Pass threshold: 50%.`,
      type: 'full_mock',
      durationMinutes: 60,
      totalMarks: 100,
      passThresholdPercentage: 50,
      questionIds: selectedQuestionIds,
      isPaid: !isFirstDemo, // Model Test 1 is Free; Tests 2 to 30 require Pro subscription
      isActive: isFirstDemo, // Test 1 is live; Tests 2 to 30 are pre-created and activated by admin on desired dates
      published: true,
      releaseExplanationsImmediately: true,
      negativeMarkRatio: 0.25,
      positiveMarkRatio: 1.0,
      createdAt: new Date('2026-02-01T00:00:00Z').toISOString(),
      scheduledDate: isFirstDemo ? '2026-02-01' : undefined
    });
  }

  return modelTests;
}

/**
 * Robust question getter for any exam attempt.
 * Ensures an exam ALWAYS receives the required questions (up to totalMarks / 100)
 * even if question IDs shifted or custom questions were loaded.
 */
export function getQuestionsForExam(exam: Exam, allQuestions: Question[]): Question[] {
  if (!exam || !allQuestions || allQuestions.length === 0) return [];

  const targetCount = exam.totalMarks || (exam.type === 'full_mock' ? 100 : 20);

  // 1. If subject test, filter by subject
  if (exam.type === 'subject_test' && exam.subjectId) {
    const subList = allQuestions.filter(q => q.subjectId === exam.subjectId);
    if (subList.length > 0) return subList.slice(0, targetCount);
  }

  // 2. Check explicitly assigned questionIds
  if (exam.questionIds && exam.questionIds.length > 0) {
    const qMap = new Map(allQuestions.map(q => [q.id, q]));
    const matched: Question[] = [];
    for (const qId of exam.questionIds) {
      const found = qMap.get(qId);
      if (found) matched.push(found);
    }
    if (matched.length > 0) {
      return matched.slice(0, targetCount || matched.length);
    }
  }

  // 3. Fallback: derive index from exam.id (e.g. exam_model_test_05 -> 5)
  const match = exam.id.match(/\d+/);
  const testIndex = match ? parseInt(match[0], 10) - 1 : 0;
  const startIndex = Math.max(0, (testIndex * 66) % allQuestions.length);

  const result: Question[] = [];
  for (let k = 0; k < targetCount && k < allQuestions.length; k++) {
    const q = allQuestions[(startIndex + k) % allQuestions.length];
    if (q && !result.some(r => r.id === q.id)) {
      result.push(q);
    }
  }

  return result.length > 0 ? result : allQuestions.slice(0, targetCount);
}
