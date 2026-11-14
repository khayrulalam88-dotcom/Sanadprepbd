import type { Subject, Question } from '../types/index.ts';

export const INITIAL_SUBJECTS: Subject[] = [
  {
    id: 'sub_cpc',
    code: 'CPC',
    nameBn: 'দেওয়ানী কার্যবিধি, ১৯০৮',
    nameEn: 'The Code of Civil Procedure, 1908',
    marksWeight: 20,
    totalQuestions: 20,
    iconName: 'Scale',
    color: 'from-blue-600 to-indigo-700',
    actTitle: 'Act No. V of 1908'
  },
  {
    id: 'sub_sra',
    code: 'SRA',
    nameBn: 'সুনির্দিষ্ট প্রতিকার আইন, ১৮৭৭',
    nameEn: 'The Specific Relief Act, 1877',
    marksWeight: 10,
    totalQuestions: 10,
    iconName: 'ShieldCheck',
    color: 'from-emerald-600 to-teal-700',
    actTitle: 'Act No. I of 1877'
  },
  {
    id: 'sub_crpc',
    code: 'CrPC',
    nameBn: 'ফৌজদারী কার্যবিধি, ১৮৯৮',
    nameEn: 'The Code of Criminal Procedure, 1898',
    marksWeight: 20,
    totalQuestions: 20,
    iconName: 'Gavel',
    color: 'from-rose-600 to-red-700',
    actTitle: 'Act No. V of 1898'
  },
  {
    id: 'sub_penal',
    code: 'PC',
    nameBn: 'দণ্ডবিধি, ১৮৬০',
    nameEn: 'The Penal Code, 1860',
    marksWeight: 20,
    totalQuestions: 20,
    iconName: 'AlertOctagon',
    color: 'from-amber-600 to-orange-700',
    actTitle: 'Act No. XLV of 1860'
  },
  {
    id: 'sub_evidence',
    code: 'EA',
    nameBn: 'সাক্ষ্য আইন, ১৮৭২',
    nameEn: 'The Evidence Act, 1872',
    marksWeight: 15,
    totalQuestions: 15,
    iconName: 'FileText',
    color: 'from-purple-600 to-violet-700',
    actTitle: 'Act No. I of 1872'
  },
  {
    id: 'sub_limitation',
    code: 'LA',
    nameBn: 'তামাদি আইন, ১৯০৮',
    nameEn: 'The Limitation Act, 1908',
    marksWeight: 10,
    totalQuestions: 10,
    iconName: 'Clock',
    color: 'from-cyan-600 to-sky-700',
    actTitle: 'Act No. IX of 1908'
  },
  {
    id: 'sub_bar_ethics',
    code: 'BCO',
    nameBn: 'বার কাউন্সিল অর্ডার ও পেশাগত শিষ্টাচার',
    nameEn: 'Legal Practitioners & Bar Council Rules & Ethics',
    marksWeight: 5,
    totalQuestions: 5,
    iconName: 'Award',
    color: 'from-emerald-700 to-green-900',
    actTitle: 'President’s Order No. 46 of 1972'
  }
];

// Sanitized demo preview items ONLY (all answer keys & explanations live on the backend / questionKeys collection)
const SAMPLE_QUESTIONS: Question[] = [
  {
    id: 'q_cpc_1',
    subjectId: 'sub_cpc',
    questionBn: 'দেওয়ানী আদালতসমূহের দেওয়ানী প্রকৃতির যাবতীয় মোকদ্দমা বিচার করার এখতিয়ার দেওয়ানী কার্যবিধির কোন ধারায় উল্লেখ আছে?',
    questionEn: 'Under which section of the Code of Civil Procedure, 1908, do civil courts have jurisdiction to try all civil suits unless barred?',
    optionsBn: ['ধারা ৬ (Section 6)', 'ধারা ৯ (Section 9)', 'ধারা ১০ (Section 10)', 'ধারা ১১ (Section 11)'],
    optionsEn: ['Section 6', 'Section 9', 'Section 10', 'Section 11'],
    legalReference: 'The Code of Civil Procedure, 1908 - Section 9',
    difficulty: 'easy',
    status: 'published',
    isDemoSample: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z'
  },
  {
    id: 'q_sra_1',
    subjectId: 'sub_sra',
    questionBn: 'সুনির্দিষ্ট প্রতিকার আইনের ৯ ধারা মতে দখলচ্যুত ব্যক্তি কত সময়ের মধ্যে দখল পুনরুদ্ধারের মোকদ্দমা দায়ের করতে পারেন?',
    questionEn: 'Under Section 9 of the Specific Relief Act, 1877, within what period must a dispossessed person file a suit for recovery of possession?',
    optionsBn: ['৩ মাস (3 months)', '৬ মাস (6 months)', '১ বছর (1 year)', '৩ বছর (3 years)'],
    optionsEn: ['3 months', '6 months', '1 year', '3 years'],
    legalReference: 'The Specific Relief Act, 1877 - Section 9',
    difficulty: 'easy',
    status: 'published',
    isDemoSample: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z'
  },
  {
    id: 'q_crpc_1',
    subjectId: 'sub_crpc',
    questionBn: 'ফৌজদারী কার্যবিধির কোন ধারা অনুসারে তাৎক্ষণিক শান্তি ভঙ্গের আশঙ্কায় ১৪৪ ধারা জারির ক্ষমতা প্রয়োগ করা হয়?',
    questionEn: 'Under which section of the Code of Criminal Procedure, 1898, is an order issued to prevent urgent cases of nuisance or apprehended danger?',
    optionsBn: ['ধারা ১৩৩ (Section 133)', 'ধারা ১৪৪ (Section 144)', 'ধারা ১৪৫ (Section 145)', 'ধারা ১০৭ (Section 107)'],
    optionsEn: ['Section 133', 'Section 144', 'Section 145', 'Section 107'],
    legalReference: 'The Code of Criminal Procedure, 1898 - Section 144',
    difficulty: 'easy',
    status: 'published',
    isDemoSample: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z'
  },
  {
    id: 'q_penal_1',
    subjectId: 'sub_penal',
    questionBn: 'দণ্ডবিধির কোন ধারায় অপরাধমূলক নরহত্যা (Culpable Homicide) সংজ্ঞায়িত করা হয়েছে?',
    questionEn: 'In which section of the Penal Code, 1860, is Culpable Homicide defined?',
    optionsBn: ['ধারা ২৯৯ (Section 299)', 'ধারা ৩০০ (Section 300)', 'ধারা ৩০২ (Section 302)', 'ধারা ৩০৪ (Section 304)'],
    optionsEn: ['Section 299', 'Section 300', 'Section 302', 'Section 304'],
    legalReference: 'The Penal Code, 1860 - Section 299',
    difficulty: 'easy',
    status: 'published',
    isDemoSample: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z'
  },
  {
    id: 'q_evi_1',
    subjectId: 'sub_evidence',
    questionBn: 'মৃত্যুকালীন ঘোষণা (Dying Declaration) সাক্ষ্য আইনের কোন ধারায় গ্রহণযোগ্য করা হয়েছে?',
    questionEn: 'Under which section of the Evidence Act, 1872, is a Dying Declaration admissible in evidence?',
    optionsBn: ['ধারা ২৫ (Section 25)', 'ধারা ২৭ (Section 27)', 'ধারা ৩২(১) (Section 32(1))', 'ধারা ৩৪ (Section 34)'],
    optionsEn: ['Section 25', 'Section 27', 'Section 32(1)', 'Section 34'],
    legalReference: 'The Evidence Act, 1872 - Section 32(1)',
    difficulty: 'easy',
    status: 'published',
    isDemoSample: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z'
  },
  {
    id: 'q_lim_1',
    subjectId: 'sub_limitation',
    questionBn: 'বিলম্ব মওকুফ (Condonation of Delay) তামাদি আইনের কোন ধারার অধীনে আবেদন করা হয়?',
    questionEn: 'Under which section of the Limitation Act, 1908, can an application for condonation of delay be made?',
    optionsBn: ['ধারা ৩ (Section 3)', 'ধারা ৫ (Section 5)', 'ধারা ১২ (Section 12)', 'ধারা ১৪ (Section 14)'],
    optionsEn: ['Section 3', 'Section 5', 'Section 12', 'Section 14'],
    legalReference: 'The Limitation Act, 1908 - Section 5',
    difficulty: 'easy',
    status: 'published',
    isDemoSample: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z'
  },
  {
    id: 'q_bco_1',
    subjectId: 'sub_bar_ethics',
    questionBn: 'বাংলাদেশ বার কাউন্সিলের চেয়ারম্যান হিসেবে পদাধিকার বলে কে দায়িত্ব পালন করেন?',
    questionEn: 'Who serves as the Chairman of the Bangladesh Bar Council by virtue of his office (ex-officio)?',
    optionsBn: ['প্রধান বিচারপতি (Chief Justice)', 'অ্যাটর্নি জেনারেল (Attorney General for Bangladesh)', 'আইন মন্ত্রী (Minister for Law)', 'বার কাউন্সিলের নির্বাচিত জ্যেষ্ঠ সদস্য'],
    optionsEn: ['Chief Justice of Bangladesh', 'Attorney General for Bangladesh', 'Law Minister', 'Senior Elected Member of Bar Council'],
    legalReference: 'Legal Practitioners and Bar Council Order, 1972 - Article 6(1)',
    difficulty: 'easy',
    status: 'published',
    isDemoSample: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z'
  }
];

export const INITIAL_QUESTIONS: Question[] = SAMPLE_QUESTIONS;
