import { Question, QuestionDifficulty, QuestionStatus, Subject, PreviousQuestion } from '../types/index.ts';

export interface ParsedCsvQuestion {
  rowNumber: number;
  subjectCode: string;
  subjectId: string;
  topic?: string;
  question: string;
  options: [string, string, string, string]; // [A, B, C, D]
  correctAnswer: 'A' | 'B' | 'C' | 'D';
  correctOptionIndex: number; // 0, 1, 2, 3
  explanation: string;
  difficulty: QuestionDifficulty;
  isValid: boolean;
  isDuplicate: boolean;
  errors: string[];
  warnings: string[];
}

export interface CsvValidationResult {
  totalRows: number;
  validCount: number;
  invalidCount: number;
  duplicateCount: number;
  parsedQuestions: ParsedCsvQuestion[];
}

// Subject Code / Name Resolver for Bangladesh Bar Council syllabus
export function resolveSubjectId(rawSubject: string, subjects: Subject[]): { subjectId: string; subjectCode: string } {
  const clean = (rawSubject || '').trim().toLowerCase();
  
  // Direct match by ID
  const directId = subjects.find(s => s.id.toLowerCase() === clean);
  if (directId) return { subjectId: directId.id, subjectCode: directId.code };

  // Direct match by Code
  const directCode = subjects.find(s => s.code.toLowerCase() === clean);
  if (directCode) return { subjectId: directCode.id, subjectCode: directCode.code };

  // Common synonyms and aliases for Bangladesh Bar Council syllabus
  if (clean.includes('cpc') || clean.includes('civil procedure') || clean.includes('দেওয়ানী')) {
    return { subjectId: 'sub_cpc', subjectCode: 'CPC' };
  }
  if (clean.includes('crpc') || clean.includes('criminal procedure') || clean.includes('ফৌজদারী') || clean.includes('ফৌজদারি')) {
    return { subjectId: 'sub_crpc', subjectCode: 'CrPC' };
  }
  if (clean.includes('penal') || clean.includes('dandabidhi') || clean.includes('দণ্ডবিধি') || clean.includes('দন্ডবিধি') || clean.includes('302')) {
    return { subjectId: 'sub_penal_code', subjectCode: 'PENAL CODE' };
  }
  if (clean.includes('evidence') || clean.includes('sakkho') || clean.includes('সাক্ষ্য')) {
    return { subjectId: 'sub_evidence', subjectCode: 'EVIDENCE' };
  }
  if (clean.includes('specific relief') || clean.includes('sra') || clean.includes('সুনির্দিষ্ট প্রতিকার')) {
    return { subjectId: 'sub_specific_relief', subjectCode: 'SR ACT' };
  }
  if (clean.includes('limitation') || clean.includes('tamadi') || clean.includes('তামাদি')) {
    return { subjectId: 'sub_limitation', subjectCode: 'LIMITATION' };
  }
  if (clean.includes('ethics') || clean.includes('bar council order') || clean.includes('পেশাগত আচরণ') || clean.includes('নৈতিকতা')) {
    return { subjectId: 'sub_legal_ethics', subjectCode: 'LEGAL ETHICS' };
  }

  // Fallback to CPC
  return { subjectId: 'sub_cpc', subjectCode: 'CPC' };
}

// Parse CSV text respecting quoted fields, commas inside quotes, and line breaks
export function parseCsvRows(text: string): string[][] {
  // Remove UTF-8 BOM if present
  let content = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let insideQuotes = false;
  let i = 0;

  while (i < content.length) {
    const char = content[i];
    const nextChar = content[i + 1];

    if (char === '"') {
      if (insideQuotes && nextChar === '"') {
        // Escaped quote ("")
        currentField += '"';
        i += 2;
        continue;
      } else {
        // Toggle quote state
        insideQuotes = !insideQuotes;
        i++;
        continue;
      }
    }

    if (char === ',' && !insideQuotes) {
      currentRow.push(currentField.trim());
      currentField = '';
      i++;
      continue;
    }

    if ((char === '\r' || char === '\n') && !insideQuotes) {
      currentRow.push(currentField.trim());
      currentField = '';
      if (currentRow.some(field => field.length > 0)) {
        rows.push(currentRow);
      }
      currentRow = [];

      // Skip \r\n pair
      if (char === '\r' && nextChar === '\n') {
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    currentField += char;
    i++;
  }

  // Push final field/row if any
  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField.trim());
    if (currentRow.some(field => field.length > 0)) {
      rows.push(currentRow);
    }
  }

  return rows;
}

// Normalize question text for duplicate detection
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '') // Keep only letters and digits (supports Bengali and English)
    .trim();
}

// Map correct answer representation to 0-3 index
export function parseCorrectOption(raw: string, options: [string, string, string, string]): { index: number; letter: 'A' | 'B' | 'C' | 'D' } | null {
  const clean = raw.trim().toUpperCase();
  
  if (clean === 'A' || clean === '1' || clean === 'ক') return { index: 0, letter: 'A' };
  if (clean === 'B' || clean === '2' || clean === 'খ') return { index: 1, letter: 'B' };
  if (clean === 'C' || clean === '3' || clean === 'গ') return { index: 2, letter: 'C' };
  if (clean === 'D' || clean === '4' || clean === 'ঘ') return { index: 3, letter: 'D' };

  // Check if the answer matches the exact text of one of the options
  const rawLower = raw.trim().toLowerCase();
  for (let i = 0; i < options.length; i++) {
    if (options[i].trim().toLowerCase() === rawLower) {
      const letters: ('A' | 'B' | 'C' | 'D')[] = ['A', 'B', 'C', 'D'];
      return { index: i, letter: letters[i] };
    }
  }

  return null;
}

// Validate and parse all rows
export function validateCsvQuestions(
  csvText: string, 
  existingQuestions: Question[], 
  subjects: Subject[]
): CsvValidationResult {
  const rawRows = parseCsvRows(csvText);

  if (rawRows.length === 0) {
    return {
      totalRows: 0,
      validCount: 0,
      invalidCount: 0,
      duplicateCount: 0,
      parsedQuestions: []
    };
  }

  // Extract header row
  const header = rawRows[0].map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
  
  // Find column indices
  const subjectIdx = header.findIndex(h => h.includes('subject') || h === 'sub' || h === 'আইন');
  const topicIdx = header.findIndex(h => h.includes('topic') || h.includes('অধ্যায়') || h.includes('section'));
  const questionIdx = header.findIndex(h => h.includes('question') || h.includes('প্রশ্ন') || h === 'q');
  const optAIdx = header.findIndex(h => h === 'optiona' || h === 'opta' || h === 'a' || h === 'option1');
  const optBIdx = header.findIndex(h => h === 'optionb' || h === 'optb' || h === 'b' || h === 'option2');
  const optCIdx = header.findIndex(h => h === 'optionc' || h === 'optc' || h === 'c' || h === 'option3');
  const optDIdx = header.findIndex(h => h === 'optiond' || h === 'optd' || h === 'd' || h === 'option4');
  const correctIdx = header.findIndex(h => h.includes('correct') || h.includes('answer') || h.includes('ans') || h === 'উত্তর');
  const explanationIdx = header.findIndex(h => h.includes('explanation') || h.includes('ব্যাখ্যা') || h.includes('reference'));

  // Existing normalized question texts for fast duplicate detection
  const existingNormalizedSet = new Set(existingQuestions.map(q => normalizeText(q.questionBn)));
  const currentBatchNormalizedSet = new Set<string>();

  const parsedQuestions: ParsedCsvQuestion[] = [];
  let validCount = 0;
  let invalidCount = 0;
  let duplicateCount = 0;

  // Process rows from index 1 (skipping header)
  for (let r = 1; r < rawRows.length; r++) {
    const row = rawRows[r];
    const rowNumber = r + 1; // 1-indexed for display

    // Skip empty lines
    if (!row.some(cell => cell.trim().length > 0)) continue;

    const rawSubject = subjectIdx >= 0 ? row[subjectIdx] || '' : '';
    const rawTopic = topicIdx >= 0 ? row[topicIdx] || '' : '';
    const rawQuestion = questionIdx >= 0 ? row[questionIdx] || '' : row[2] || '';
    const rawOptA = optAIdx >= 0 ? row[optAIdx] || '' : row[3] || '';
    const rawOptB = optBIdx >= 0 ? row[optBIdx] || '' : row[4] || '';
    const rawOptC = optCIdx >= 0 ? row[optCIdx] || '' : row[5] || '';
    const rawOptD = optDIdx >= 0 ? row[optDIdx] || '' : row[6] || '';
    const rawCorrect = correctIdx >= 0 ? row[correctIdx] || '' : row[7] || '';
    const rawExplanation = explanationIdx >= 0 ? row[explanationIdx] || '' : row[8] || '';

    const errors: string[] = [];
    const warnings: string[] = [];

    // Validation 1: Question text
    if (!rawQuestion || rawQuestion.trim().length < 5) {
      errors.push('প্রশ্নের বিবরণ অনুপস্থিত বা অত্যন্ত সংক্ষিপ্ত (Question text is missing or too short).');
    }

    // Validation 2: Options
    const options: [string, string, string, string] = [
      rawOptA.trim(),
      rawOptB.trim(),
      rawOptC.trim(),
      rawOptD.trim()
    ];

    if (!options[0]) errors.push('অপশন ক/A খালি রাখা যাবে না (Option A is missing).');
    if (!options[1]) errors.push('অপশন খ/B খালি রাখা যাবে না (Option B is missing).');
    if (!options[2]) errors.push('অপশন গ/C খালি রাখা যাবে না (Option C is missing).');
    if (!options[3]) errors.push('অপশন ঘ/D খালি রাখা যাবে না (Option D is missing).');

    // Validation 3: Correct answer
    const resolvedCorrect = parseCorrectOption(rawCorrect, options);
    if (!resolvedCorrect) {
      errors.push(`সঠিক উত্তর "${rawCorrect}" গ্রহণযোগ্য নয়। A, B, C অথবা D উল্লেখ করুন (Correct answer must be A, B, C, or D).`);
    }

    // Resolve subject
    const { subjectId, subjectCode } = resolveSubjectId(rawSubject, subjects);
    if (!rawSubject.trim()) {
      warnings.push(`বিষয় উল্লেখ নেই, ডিফল্ট হিসেবে ${subjectCode} নির্ধারণ করা হয়েছে (Defaulted to ${subjectCode}).`);
    }

    // Duplicate Check
    const norm = normalizeText(rawQuestion);
    let isDuplicate = false;
    if (norm.length > 5) {
      if (existingNormalizedSet.has(norm)) {
        isDuplicate = true;
        warnings.push('সতর্কতা: এই প্রশ্নটি ইতিপূর্বে ডাটাবেজে সংরক্ষিত রয়েছে (Duplicate: already exists in question bank).');
      } else if (currentBatchNormalizedSet.has(norm)) {
        isDuplicate = true;
        warnings.push('সতর্কতা: একই ফাইলে এই প্রশ্নটির পুনরাবৃত্তি রয়েছে (Duplicate: repeated inside this file).');
      }
      currentBatchNormalizedSet.add(norm);
    }

    const isValid = errors.length === 0;
    if (isValid) {
      validCount++;
    } else {
      invalidCount++;
    }
    if (isDuplicate) {
      duplicateCount++;
    }

    parsedQuestions.push({
      rowNumber,
      subjectCode,
      subjectId,
      topic: rawTopic.trim() || undefined,
      question: rawQuestion.trim(),
      options,
      correctAnswer: resolvedCorrect ? resolvedCorrect.letter : 'A',
      correctOptionIndex: resolvedCorrect ? resolvedCorrect.index : 0,
      explanation: rawExplanation.trim(),
      difficulty: 'medium',
      isValid,
      isDuplicate,
      errors,
      warnings
    });
  }

  return {
    totalRows: parsedQuestions.length,
    validCount,
    invalidCount,
    duplicateCount,
    parsedQuestions
  };
}

// Generate Downloadable Sample CSV Template
export function generateSampleCsvTemplate(): string {
  const headers = ['subject', 'topic', 'question', 'optionA', 'optionB', 'optionC', 'optionD', 'correctAnswer', 'explanation'];
  
  const sampleRows = [
    [
      'CPC',
      'Section 9 Jurisdiction',
      'দেওয়ানী কার্যবিধির কত ধারানুযায়ী দেওয়ানী আদালতসমূহ সকল দেওয়ানী প্রকৃতির মোকাদ্দমা বিচার করার এখতিয়ার রাখে যদি না তা স্পষ্টভাবে বা পরোক্ষভাবে বারিত হয়?',
      'ধারা ৯',
      'ধারা ১০',
      'ধারা ১১',
      'ধারা ১২',
      'A',
      'দেওয়ানী কার্যবিধি ১৯০৮ এর ৯ ধারানুযায়ী দেওয়ানী আদালত সকল দেওয়ানী প্রকৃতির মোকদ্দমা বিচার করতে পারে।'
    ],
    [
      'CrPC',
      'Section 144 Executive Magistrate',
      'ফৌজদারী কার্যবিধির ১৪৪ ধারার আদেশ সর্বোচ্চ কতদিন পর্যন্ত কার্যকর থাকে, যদি না সরকার সরকারি গেজেট প্রজ্ঞাপন দ্বারা অন্যরূপ নির্দেশ প্রদান করেন?',
      '৩০ দিন',
      '৬০ দিন',
      '২ মাস',
      '৬ মাস',
      'C',
      'ফৌজদারী কার্যবিধির ১৪৪(৬) উপ-ধারানুযায়ী ম্যাজিস্ট্রেটের প্রদত্ত আদেশ অনধিক ২ মাস (Two Months) পর্যন্ত বলবৎ থাকে।'
    ],
    [
      'Penal Code',
      'Section 300 Murder Exceptions',
      'দণ্ডবিধির ৩০০ ধারায় খুনের কয়টি ব্যতিক্রম (Exceptions to Murder) উল্লেখ করা হয়েছে?',
      '৩ টি',
      '৪ টি',
      '৫ টি',
      '৬ টি',
      'C',
      'দণ্ডবিধি ১৮৬০ এর ৩০০ ধারায় নরহত্যার ৫টি ব্যতিক্রম উল্লেখ রয়েছে যা খুন বলে গণ্য হবে না।'
    ],
    [
      'Evidence',
      'Section 114 Presumptions',
      'সাক্ষ্য আইনের কত ধারানুযায়ী আদালত কতিপয় বিষয়ের অস্তিত্ব বা ঘটনা অনুমান (Court may presume existence of certain facts) করতে পারেন?',
      'ধারা ১০৫',
      'ধারা ১১১',
      'ধারা ১১৪',
      'ধারা ১১৫',
      'C',
      'সাক্ষ্য আইন ১৮৭২ এর ১১৪ ধারায় আদালত সাধারণ মানব চরিত্র ও ঘটনাবলীর স্বাভাবিক গতি বিবেচনা করে অনুমান গ্রহণ করতে পারেন।'
    ],
    [
      'Specific Relief',
      'Section 42 Declaratory Decrees',
      'সুনির্দিষ্ট প্রতিকার আইনের ৪২ ধারার অধীনে ঘোষণামূলক মোকদ্দমায় বাদীর অবশ্যই কিসের অধিকার থাকতে হবে?',
      'শুধুমাত্র আর্থিক অধিকার',
      'যেকোনো আইনগত চরিত্র বা কোনো সম্পত্তিতে স্বত্ব',
      'শুধুমাত্র দখলি স্বত্ব',
      'কোনো অধিকার না থাকলেও চলে',
      'B',
      'সুনির্দিষ্ট প্রতিকার আইন ১৮৭৭ এর ৪২ ধারায় কোনো ব্যক্তির কোনো আইনগত চরিত্র (Legal Character) বা সম্পত্তিতে স্বত্ব অস্বীকার করা হলে ঘোষণার মামলা করা যায়।'
    ]
  ];

  const escapeCsv = (val: string) => {
    if (val.includes(',') || val.includes('"') || val.includes('\n')) {
      return `"${val.replace(/"/g, '""')}"`;
    }
    return val;
  };

  const lines = [
    headers.join(','),
    ...sampleRows.map(row => row.map(escapeCsv).join(','))
  ];

  return lines.join('\n');
}

// =======================================================================
// PREVIOUS YEAR QUESTIONS CSV PARSER & VALIDATOR
// =======================================================================

export interface ParsedPreviousQuestionRow {
  rowNumber: number;
  year: number;
  subject: string;
  question: string;
  options: [string, string, string, string];
  correctAnswer: string;
  correctAnswerIndex: number;
  explanation: string;
  legalSection: string;
  source: string;
  isValid: boolean;
  isDuplicate: boolean;
  errors: string[];
  warnings: string[];
}

export interface PreviousQuestionCsvValidationResult {
  totalRows: number;
  validCount: number;
  invalidCount: number;
  duplicateCount: number;
  rows: ParsedPreviousQuestionRow[];
  questionsToSave: PreviousQuestion[];
}

export function parsePreviousQuestionsCsv(
  csvText: string,
  existingQuestions: PreviousQuestion[] = []
): PreviousQuestionCsvValidationResult {
  const rawRows = parseCsvRows(csvText);

  if (rawRows.length === 0) {
    return {
      totalRows: 0,
      validCount: 0,
      invalidCount: 0,
      duplicateCount: 0,
      rows: [],
      questionsToSave: []
    };
  }

  // Header row normalization
  const header = rawRows[0].map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ''));

  // Column matching
  const yearIdx = header.findIndex(h => h.includes('year') || h === 'বছর' || h === 'yr');
  const subjectIdx = header.findIndex(h => h.includes('subject') || h === 'আইন' || h === 'sub');
  const questionIdx = header.findIndex(h => h.includes('question') || h.includes('প্রশ্ন') || h === 'q');
  
  // Options: individual or single pipe/comma column
  const optAIdx = header.findIndex(h => h === 'optiona' || h === 'opta' || h === 'a' || h === 'option1' || h === 'ক');
  const optBIdx = header.findIndex(h => h === 'optionb' || h === 'optb' || h === 'b' || h === 'option2' || h === 'খ');
  const optCIdx = header.findIndex(h => h === 'optionc' || h === 'optc' || h === 'c' || h === 'option3' || h === 'গ');
  const optDIdx = header.findIndex(h => h === 'optiond' || h === 'optd' || h === 'd' || h === 'option4' || h === 'ঘ');
  const optionsCombinedIdx = header.findIndex(h => h === 'options' || h === 'অপশন');

  const correctIdx = header.findIndex(h => h.includes('correct') || h.includes('answer') || h.includes('ans') || h === 'উত্তর');
  const explanationIdx = header.findIndex(h => h.includes('explanation') || h.includes('ব্যাখ্যা'));
  const legalSectionIdx = header.findIndex(h => h.includes('section') || h.includes('legal') || h.includes('ধারা') || h.includes('law'));
  const sourceIdx = header.findIndex(h => h.includes('source') || h.includes('উৎস') || h.includes('exam'));

  const existingNormalizedSet = new Set(existingQuestions.map(q => normalizeText(q.question)));
  const batchNormalizedSet = new Set<string>();

  const rows: ParsedPreviousQuestionRow[] = [];
  const questionsToSave: PreviousQuestion[] = [];
  let validCount = 0;
  let invalidCount = 0;
  let duplicateCount = 0;

  for (let r = 1; r < rawRows.length; r++) {
    const row = rawRows[r];
    const rowNumber = r + 1;

    if (!row.some(cell => cell.trim().length > 0)) continue;

    const rawYearStr = yearIdx >= 0 ? row[yearIdx] || '' : '';
    const rawSubject = subjectIdx >= 0 ? row[subjectIdx] || '' : '';
    const rawQuestion = questionIdx >= 0 ? row[questionIdx] || '' : row[2] || '';
    
    // Resolve Options
    let optA = optAIdx >= 0 ? row[optAIdx] || '' : '';
    let optB = optBIdx >= 0 ? row[optBIdx] || '' : '';
    let optC = optCIdx >= 0 ? row[optCIdx] || '' : '';
    let optD = optDIdx >= 0 ? row[optDIdx] || '' : '';

    if (optionsCombinedIdx >= 0 && (!optA || !optB)) {
      const combined = row[optionsCombinedIdx] || '';
      const splitOpts = combined.split('|').map(s => s.trim()).filter(Boolean);
      if (splitOpts.length >= 4) {
        optA = splitOpts[0];
        optB = splitOpts[1];
        optC = splitOpts[2];
        optD = splitOpts[3];
      }
    }

    const rawCorrect = correctIdx >= 0 ? row[correctIdx] || '' : '';
    const rawExplanation = explanationIdx >= 0 ? row[explanationIdx] || '' : '';
    const rawLegalSection = legalSectionIdx >= 0 ? row[legalSectionIdx] || '' : '';
    const rawSource = sourceIdx >= 0 ? row[sourceIdx] || '' : '';

    const errors: string[] = [];
    const warnings: string[] = [];

    // Parse Year
    let parsedYear = parseInt(rawYearStr.replace(/[^0-9]/g, ''), 10);
    if (!parsedYear || isNaN(parsedYear) || parsedYear < 2000 || parsedYear > 2030) {
      // Default to 2025 or flag error
      if (!rawYearStr.trim()) {
        errors.push('পরীক্ষার সাল (Year) উল্লেখ নেই। (যেমন: 2020, 2022, 2023, 2025)');
        parsedYear = 2025;
      } else {
        warnings.push(`সাল "${rawYearStr}" স্বীকৃতিযোগ্য নয়, ডিফল্ট হিসেবে ২০২৫ নির্ধারণ করা হয়েছে।`);
        parsedYear = 2025;
      }
    }

    // Subject
    const subject = rawSubject.trim() || 'Bangladesh Bar Council Law';

    // Question
    const questionText = rawQuestion.trim();
    if (questionText.length < 5) {
      errors.push('প্রশ্নের বিবরণ অনুপস্থিত বা অত্যন্ত সংক্ষিপ্ত (Question text missing).');
    }

    // Options
    const options: [string, string, string, string] = [
      optA.trim(),
      optB.trim(),
      optC.trim(),
      optD.trim()
    ];
    if (!options[0]) errors.push('অপশন ক/A খালি (Option A missing).');
    if (!options[1]) errors.push('অপশন খ/B খালি (Option B missing).');
    if (!options[2]) errors.push('অপশন গ/C খালি (Option C missing).');
    if (!options[3]) errors.push('অপশন ঘ/D খালি (Option D missing).');

    // Correct Answer determination
    const cleanCorrect = rawCorrect.trim();
    let correctAnswerResolved = cleanCorrect;
    let correctAnswerIndex = 0;

    const optResolver = parseCorrectOption(cleanCorrect, options);
    if (optResolver) {
      correctAnswerIndex = optResolver.index;
      correctAnswerResolved = options[optResolver.index] || cleanCorrect;
    } else if (cleanCorrect) {
      // check if it matches option text
      const matchIdx = options.findIndex(o => o.toLowerCase() === cleanCorrect.toLowerCase());
      if (matchIdx >= 0) {
        correctAnswerIndex = matchIdx;
        correctAnswerResolved = options[matchIdx];
      } else {
        errors.push(`সঠিক উত্তর "${cleanCorrect}" অপশনসমূহের (A, B, C, D) সাথে মিলছে না।`);
      }
    } else {
      errors.push('সঠিক উত্তর (correctAnswer) উল্লেখ করা হয়নি।');
    }

    // Explanation & Legal Section
    const explanation = rawExplanation.trim();
    const legalSection = rawLegalSection.trim() || 'Bar Council Act/Rules';
    const source = rawSource.trim() || `Bangladesh Bar Council MCQ Exam ${parsedYear}`;

    // Duplicate Check
    const norm = normalizeText(questionText);
    let isDuplicate = false;
    if (norm.length > 5) {
      if (existingNormalizedSet.has(norm)) {
        isDuplicate = true;
        warnings.push('সতর্কতা: এই প্রশ্নটি ইতিমধ্যে ডাটাবেজে রয়েছে।');
      } else if (batchNormalizedSet.has(norm)) {
        isDuplicate = true;
        warnings.push('সতর্কতা: একই ফাইলে এই প্রশ্নটি একাধিকবার রয়েছে।');
      }
      batchNormalizedSet.add(norm);
    }

    const isValid = errors.length === 0;
    if (isValid) {
      validCount++;
    } else {
      invalidCount++;
    }
    if (isDuplicate) {
      duplicateCount++;
    }

    const rowObj: ParsedPreviousQuestionRow = {
      rowNumber,
      year: parsedYear,
      subject,
      question: questionText,
      options,
      correctAnswer: correctAnswerResolved,
      correctAnswerIndex,
      explanation,
      legalSection,
      source,
      isValid,
      isDuplicate,
      errors,
      warnings
    };

    rows.push(rowObj);

    if (isValid) {
      questionsToSave.push({
        id: `pq_${parsedYear}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        year: parsedYear,
        subject,
        question: questionText,
        options,
        correctAnswer: correctAnswerResolved,
        explanation,
        legalSection,
        source,
        createdAt: new Date().toISOString()
      });
    }
  }

  return {
    totalRows: rows.length,
    validCount,
    invalidCount,
    duplicateCount,
    rows,
    questionsToSave
  };
}

export function generateSamplePreviousQuestionsCsv(): string {
  const headers = [
    'year',
    'subject',
    'question',
    'optionA',
    'optionB',
    'optionC',
    'optionD',
    'correctAnswer',
    'explanation',
    'legalSection',
    'source'
  ];

  const sampleRows = [
    [
      '2025',
      'The Code of Civil Procedure, 1908',
      'দেওয়ানী কার্যবিধির কোন ধারা অনুযায়ী "রেস জুডিকাটা" (Res Judicata) নীতি কার্যকর হয়?',
      'ধারা ৯',
      'ধারা ১০',
      'ধারা ১১',
      'ধারা ১২',
      'ধারা ১১',
      'দেওয়ানী কার্যবিধির ১১ ধারায় দোবারা দোষ বা রেস জুডিকাটার মূল নীতি লিপিবদ্ধ রয়েছে।',
      'Section 11, CPC 1908',
      'Bar Council MCQ Exam 2025'
    ],
    [
      '2023',
      'The Code of Criminal Procedure, 1898',
      'ফৌজদারী কার্যবিধির ১৬৪ ধারায় কার নিকট দোষ স্বীকারোক্তিমূলক জবানবন্দি রেকর্ড করা হয়?',
      'পুলিশ কর্মকর্তা',
      '১ম শ্রেণীর ম্যাজিস্ট্রেট',
      'পাবলিক প্রসিকিউটর',
      'নির্বাহী ম্যাজিস্ট্রেট',
      '১ম শ্রেণীর ম্যাজিস্ট্রেট',
      '১৬৪ ধারা অনুসারে ১ম শ্রেণীর ম্যাজিস্ট্রেট বা মেট্রোপলিটন ম্যাজিস্ট্রেট স্বীকারোক্তি রেকর্ড করেন।',
      'Section 164, CrPC 1898',
      'Bar Council MCQ Exam 2023'
    ],
    [
      '2022',
      'The Penal Code, 1860',
      'দণ্ডবিধির ৩৪ ধারায় উল্লিখিত নীতির মূল ভিত্তি কী?',
      'অভিন্ন অভিপ্রায় (Common Intention)',
      'একই উদ্দেশ্য',
      'সাধারণ জ্ঞান',
      'পূর্বশত্রুতা',
      'অভিন্ন অভিপ্রায় (Common Intention)',
      '৩৪ ধারা একাধিক ব্যক্তির সাধারণ বা অভিন্ন অভিপ্রায় কার্যকর করার যৌথ দায় প্রতিষ্ঠা করে।',
      'Section 34, Penal Code 1860',
      'Bar Council MCQ Exam 2022'
    ],
    [
      '2020',
      'The Limitation Act, 1908',
      'তামাদি আইনের ৫ ধারা (বিলম্ব মওকুফ) নিচের কোনটিতে প্রযোজ্য নয়?',
      'আপিল',
      'রিভিউ',
      'রিভিশন',
      'মূল মোকদ্দমা বা মামলার আরজি',
      'মূল মোকদ্দমা বা মামলার আরজি',
      'তামাদি আইনের ৫ ধারা মূল মামলা দায়েরের ক্ষেত্রে প্রযোজ্য নয়।',
      'Section 5, Limitation Act 1908',
      'Bar Council MCQ Exam 2020'
    ]
  ];

  const escapeCsv = (val: string) => {
    if (val.includes(',') || val.includes('"') || val.includes('\n')) {
      return `"${val.replace(/"/g, '""')}"`;
    }
    return val;
  };

  const lines = [
    headers.join(','),
    ...sampleRows.map(row => row.map(escapeCsv).join(','))
  ];

  return lines.join('\n');
}

