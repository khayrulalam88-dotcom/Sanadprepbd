import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { apiCheckPreviousQuestion, apiGradePreviousQuestions } from '../lib/api';
import { PreviousQuestion, PreviousYear } from '../types';
import { 
  History, 
  BookOpen, 
  CheckCircle2, 
  XCircle, 
  HelpCircle, 
  ArrowLeft, 
  Play, 
  RotateCcw, 
  Search, 
  Award, 
  Clock, 
  AlertCircle, 
  Filter, 
  Scale, 
  Bookmark, 
  ChevronRight,
  Eye,
  FileCheck
} from 'lucide-react';

interface PreviousQuestionSolution {
  isCorrect?: boolean;
  correctAnswer: string;
  explanation: string;
  legalSection?: string;
  source?: string;
}

interface PreviousExamEvaluation {
  totalQuestions: number;
  correctCount: number;
  incorrectCount: number;
  unansweredCount: number;
  positiveMarks: number;
  negativeMarks: number;
  finalScore: number;
  percentage: number;
  isPassed: boolean;
  incorrectList: { question: PreviousQuestion; selectedAnswer?: string }[];
}

export const PreviousQuestionsView: React.FC = () => {
  const { 
    previousQuestions, 
    setActiveScreen, 
    t, 
    selectedPreviousYear, 
    setSelectedPreviousYear,
    subjects,
    isLoggedIn,
    setShowLoginModal
  } = useApp();

  // Mode: 'practice' | 'exam' | 'exam_result'
  const [activeMode, setActiveMode] = useState<'practice' | 'exam' | 'exam_result'>('practice');
  const [selectedSubject, setSelectedSubject] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Practice Mode state
  const [practiceAnswers, setPracticeAnswers] = useState<Record<string, string>>({});
  const [showExplanationIds, setShowExplanationIds] = useState<Set<string>>(new Set());
  const [checkedSolutions, setCheckedSolutions] = useState<Record<string, PreviousQuestionSolution>>({});
  const [loadingSolutionIds, setLoadingSolutionIds] = useState<Set<string>>(new Set());
  const [practiceNotice, setPracticeNotice] = useState<string | null>(null);

  // Exam Mode state
  const [examAnswers, setExamAnswers] = useState<Record<string, string>>({});
  const [examTimeRemaining, setExamTimeRemaining] = useState<number>(30 * 60); // 30 minutes
  const [examStartedAt, setExamStartedAt] = useState<number>(0);
  const [isExamActive, setIsExamActive] = useState<boolean>(false);
  const [examEvaluation, setExamEvaluation] = useState<PreviousExamEvaluation | null>(null);
  const [isGradingExam, setIsGradingExam] = useState<boolean>(false);
  const [examError, setExamError] = useState<string | null>(null);

  // Available Years
  const availableYears: PreviousYear[] = [2025, 2023, 2022, 2020];

  // Filtered Questions
  const filteredQuestions = useMemo(() => {
    return previousQuestions.filter(q => {
      // Year filter
      if (selectedPreviousYear !== 'all' && q.year !== selectedPreviousYear) {
        return false;
      }
      // Subject filter
      if (selectedSubject !== 'all') {
        const subLower = selectedSubject.toLowerCase();
        const qSubLower = (q.subject || '').toLowerCase();
        if (!qSubLower.includes(subLower) && !subLower.includes(qSubLower)) {
          return false;
        }
      }
      // Search filter
      if (searchQuery.trim()) {
        const qText = (q.question + ' ' + (q.explanation || '') + ' ' + (q.legalSection || '')).toLowerCase();
        if (!qText.includes(searchQuery.toLowerCase())) {
          return false;
        }
      }
      return true;
    });
  }, [previousQuestions, selectedPreviousYear, selectedSubject, searchQuery]);

  // Keep refs updated so timer auto-submit reads latest answers & questions
  const examAnswersRef = useRef<Record<string, string>>(examAnswers);
  examAnswersRef.current = examAnswers;
  const filteredQuestionsRef = useRef<PreviousQuestion[]>(filteredQuestions);
  filteredQuestionsRef.current = filteredQuestions;

  // Finish / Submit Exam via Backend Grading API
  const finishExam = async () => {
    setIsExamActive(false);
    setIsGradingExam(true);
    setExamError(null);
    try {
      const qIds = filteredQuestionsRef.current.map(q => q.id);
      const res = await apiGradePreviousQuestions(qIds, examAnswersRef.current);
      if (res.ok && res.data?.success && res.data.evaluation) {
        setExamEvaluation(res.data.evaluation);
        setActiveMode('exam_result');
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        setExamError(res.message || t('ফলাফল মূল্যায়ন করা যায়নি।', 'Failed to grade previous-year exam.'));
      }
    } finally {
      setIsGradingExam(false);
    }
  };

  // Exam Timer
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    if (isExamActive && examTimeRemaining > 0) {
      interval = setInterval(() => {
        setExamTimeRemaining(prev => {
          if (prev <= 1) {
            if (interval) clearInterval(interval);
            void finishExam();
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isExamActive, examTimeRemaining]);

  // Start Exam
  const startExamMode = () => {
    if (filteredQuestions.length === 0) return;
    setExamAnswers({});
    setExamEvaluation(null);
    setExamError(null);
    const duration = Math.max(10, Math.min(60, filteredQuestions.length)) * 60; // 1 min per question
    setExamTimeRemaining(duration);
    setExamStartedAt(Date.now());
    setIsExamActive(true);
    setActiveMode('exam');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Reset Practice
  const resetPractice = () => {
    setPracticeAnswers({});
    setShowExplanationIds(new Set());
    setCheckedSolutions({});
    setPracticeNotice(null);
  };

  // Handle Practice Answer Selection via Server Check
  const handlePracticeSelect = async (questionId: string, option: string) => {
    setPracticeNotice(null);
    setPracticeAnswers(prev => ({ ...prev, [questionId]: option }));
    setShowExplanationIds(prev => new Set(prev).add(questionId));

    const existingQ = previousQuestions.find(item => item.id === questionId);
    if (existingQ?.correctAnswer && existingQ.explanation) {
      setCheckedSolutions(prev => ({
        ...prev,
        [questionId]: {
          isCorrect: option.trim() === existingQ.correctAnswer!.trim(),
          correctAnswer: existingQ.correctAnswer!,
          explanation: existingQ.explanation!,
          legalSection: existingQ.legalSection,
          source: existingQ.source
        }
      }));
      return;
    }

    setLoadingSolutionIds(prev => new Set(prev).add(questionId));
    try {
      const res = await apiCheckPreviousQuestion(questionId, option);
      if (res.ok && res.data?.success) {
        setCheckedSolutions(prev => ({
          ...prev,
          [questionId]: {
            isCorrect: res.data!.isCorrect,
            correctAnswer: res.data!.correctAnswer,
            explanation: res.data!.explanation,
            legalSection: res.data!.legalSection,
            source: res.data!.source
          }
        }));
      } else {
        setPracticeNotice(res.message || t('সার্ভার থেকে উত্তর যাচাই করা যায়নি।', 'Could not verify answer from server.'));
      }
    } finally {
      setLoadingSolutionIds(prev => {
        const next = new Set(prev);
        next.delete(questionId);
        return next;
      });
    }
  };

  // Toggle Single Explanation Visibility (fetches key on-demand if needed)
  const toggleExplanation = async (questionId: string) => {
    const isCurrentlyOpen = showExplanationIds.has(questionId);
    if (isCurrentlyOpen) {
      setShowExplanationIds(prev => {
        const next = new Set(prev);
        next.delete(questionId);
        return next;
      });
      return;
    }

    setShowExplanationIds(prev => new Set(prev).add(questionId));
    const existingQ = previousQuestions.find(item => item.id === questionId);
    if (checkedSolutions[questionId] || (existingQ?.correctAnswer && existingQ.explanation)) {
      return;
    }

    setLoadingSolutionIds(prev => new Set(prev).add(questionId));
    try {
      const chosen = practiceAnswers[questionId];
      const res = await apiCheckPreviousQuestion(questionId, chosen);
      if (res.ok && res.data?.success) {
        setCheckedSolutions(prev => ({
          ...prev,
          [questionId]: {
            isCorrect: res.data!.isCorrect,
            correctAnswer: res.data!.correctAnswer,
            explanation: res.data!.explanation,
            legalSection: res.data!.legalSection,
            source: res.data!.source
          }
        }));
      } else {
        setPracticeNotice(res.message || t('সার্ভার থেকে সমাধান পাওয়া যায়নি।', 'Could not load explanation from server.'));
      }
    } finally {
      setLoadingSolutionIds(prev => {
        const next = new Set(prev);
        next.delete(questionId);
        return next;
      });
    }
  };

  // Format seconds to mm:ss
  const formatTimer = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="min-h-screen bg-slate-50 py-8 px-4 sm:px-6 lg:px-8">
      <div className="max-w-6xl mx-auto space-y-6">

        {/* 1. Header & Navigation */}
        <div className="bg-white rounded-2xl shadow-xs border border-slate-200 p-6 sm:p-8">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <button 
                onClick={() => setActiveScreen('dashboard')}
                className="inline-flex items-center gap-2 text-sm font-medium text-slate-500 hover:text-slate-800 transition-colors mb-2 cursor-pointer"
              >
                <ArrowLeft className="w-4 h-4" />
                {t('ড্যাশবোর্ডে ফিরুন', 'Back to Dashboard')}
              </button>
              <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 flex items-center gap-3">
                <span className="p-2.5 rounded-xl bg-amber-500 text-slate-950 inline-flex items-center justify-center shadow-xs">
                  <History className="w-6 h-6" />
                </span>
                {t('বিগত সালের প্রশ্ন ও সমাধান', 'Previous Year Questions & Solutions')}
              </h1>
              <p className="mt-1 text-slate-600 text-sm sm:text-base">
                {t(
                  'বাংলাদেশ বার কাউন্সিল অ্যাডভোকেটশিপ পরীক্ষার বিগত সালের (২০২০, ২০২২, ২০২৩ ও ২০২৫) অফিসিয়াল প্রশ্ন, নির্ভুল উত্তর ও আইনি ব্যাখ্যা।',
                  'Official past exam questions (2020, 2022, 2023, 2025) of Bangladesh Bar Council with statutory explanations and sections.'
                )}
              </p>
            </div>

            {/* Mode Switcher Buttons */}
            <div className="flex items-center gap-2 bg-slate-100 p-1.5 rounded-xl self-start md:self-center border border-slate-200">
              <button
                onClick={() => {
                  setActiveMode('practice');
                  setIsExamActive(false);
                }}
                className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all flex items-center gap-2 cursor-pointer ${
                  activeMode === 'practice'
                    ? 'bg-slate-900 text-white shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <BookOpen className="w-4 h-4" />
                {t('অনুশীলন মোড', 'Practice Mode')}
              </button>

              <button
                onClick={() => {
                  if (activeMode !== 'exam' && activeMode !== 'exam_result') {
                    startExamMode();
                  }
                }}
                className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all flex items-center gap-2 cursor-pointer ${
                  activeMode === 'exam' || activeMode === 'exam_result'
                    ? 'bg-amber-600 text-white shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Play className="w-4 h-4" />
                {t('মডেল টেস্ট মোড', 'Exam Mode')}
              </button>
            </div>
          </div>

          {/* Year Selector Pills */}
          <div className="mt-6 pt-6 border-t border-slate-100 flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400 mr-2 flex items-center gap-1.5">
              <Scale className="w-4 h-4 text-amber-500" />
              {t('সাল নির্বাচন:', 'Select Year:')}
            </span>

            <button
              onClick={() => setSelectedPreviousYear('all')}
              className={`px-3.5 py-1.5 rounded-full text-xs font-bold transition-all cursor-pointer ${
                selectedPreviousYear === 'all'
                  ? 'bg-slate-900 text-amber-400 shadow-xs'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {t('সকল সাল (All Years)', 'All Years')}
            </button>

            {availableYears.map(yr => (
              <button
                key={yr}
                onClick={() => setSelectedPreviousYear(yr)}
                className={`px-4 py-1.5 rounded-full text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 ${
                  selectedPreviousYear === yr
                    ? 'bg-amber-500 text-slate-950 font-extrabold shadow-xs'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                }`}
              >
                <span>{yr}</span>
                <span className="text-[10px] opacity-75 font-normal">
                  ({previousQuestions.filter(q => q.year === yr).length} {t('টি', 'Q')})
                </span>
              </button>
            ))}
          </div>

          {/* Subject Filter & Search Bar */}
          <div className="mt-4 flex flex-col sm:flex-row items-center gap-3">
            {/* Subject Dropdown */}
            <div className="w-full sm:w-72 relative">
              <select
                value={selectedSubject}
                onChange={(e) => setSelectedSubject(e.target.value)}
                className="w-full pl-3 pr-8 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-amber-500 font-medium"
              >
                <option value="all">{t('সকল মূল আইন (All 7 Codes)', 'All 7 Legal Codes')}</option>
                <option value="Civil Procedure">দেওয়ানী কার্যবিধি, ১৯০৮ (CPC)</option>
                <option value="Specific Relief">সুনির্দিষ্ট প্রতিকার আইন, ১৮৭৭ (SR Act)</option>
                <option value="Criminal Procedure">ফৌজদারী কার্যবিধি, ১৮৯৮ (CrPC)</option>
                <option value="Penal Code">দণ্ডবিধি, ১৮৬০ (Penal Code)</option>
                <option value="Evidence">সাক্ষ্য আইন, ১৮৭২ (Evidence Act)</option>
                <option value="Limitation">তামাদি আইন, ১৯০৮ (Limitation Act)</option>
                <option value="Bar Council">বার কাউন্সিল ও পেশাগত আচরণবিধি</option>
              </select>
            </div>

            {/* Keyword Search */}
            <div className="w-full flex-1 relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                placeholder={t('ধারা, টপিক বা প্রশ্নের কী-ওয়ার্ড দিয়ে খুঁজুন...', 'Search by section, keyword or topic...')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-amber-500"
              />
            </div>

            {activeMode === 'practice' && (
              <button
                onClick={resetPractice}
                title={t('অনুশীলনের উত্তর রিসেট করুন', 'Reset Practice')}
                className="px-3 py-2 text-xs font-semibold text-slate-500 hover:text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-xl flex items-center gap-1.5 transition-colors cursor-pointer shrink-0"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                {t('রিসেট', 'Reset')}
              </button>
            )}
          </div>
        </div>

        {/* ------------------------------------------------------------- */}
        {/* 2. MODE: PRACTICE MODE                                        */}
        {/* ------------------------------------------------------------- */}
        {activeMode === 'practice' && (
          <div className="space-y-4">
            {/* Meta indicator */}
            <div className="flex items-center justify-between px-2 text-xs font-medium text-slate-500">
              <div>
                {t('মোট প্রাপ্ত প্রশ্ন:', 'Total Questions Found:')}{' '}
                <span className="font-bold text-slate-800">{filteredQuestions.length}</span> টি
                {selectedPreviousYear !== 'all' && (
                  <span className="ml-2 font-semibold text-amber-600 bg-amber-50 px-2 py-0.5 rounded-md">
                    {selectedPreviousYear} সালের প্রশ্ন
                  </span>
                )}
              </div>
              <div>
                {t('অনুশীলন সম্পন্ন:', 'Answered:')}{' '}
                <span className="font-bold text-emerald-600">
                  {Object.keys(practiceAnswers).filter(id => filteredQuestions.some(q => q.id === id)).length}
                </span>{' '}
                / {filteredQuestions.length}
              </div>
            </div>

            {practiceNotice && (
              <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs sm:text-sm font-semibold">
                {practiceNotice}
              </div>
            )}

            {filteredQuestions.length === 0 ? (
              <div className="bg-white rounded-2xl p-12 text-center border border-slate-200">
                <AlertCircle className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                <p className="text-slate-600 font-medium">
                  {t('কোনো প্রশ্ন খুঁজে পাওয়া যায়নি। ফিল্টার পরিবর্তন করে দেখুন।', 'No questions found for the selected criteria.')}
                </p>
              </div>
            ) : (
              filteredQuestions.map((q, idx) => {
                const userChoice = practiceAnswers[q.id];
                const solution = checkedSolutions[q.id];
                const resolvedCorrectAnswer = solution?.correctAnswer ?? q.correctAnswer;
                const resolvedExplanation = solution?.explanation ?? q.explanation;
                const resolvedLegalSection = solution?.legalSection ?? q.legalSection;
                const resolvedSource = solution?.source ?? q.source;
                const isAnswered = Boolean(userChoice) && resolvedCorrectAnswer !== undefined;
                const isCorrect =
                  solution?.isCorrect !== undefined
                    ? solution.isCorrect
                    : Boolean(userChoice && resolvedCorrectAnswer && userChoice.trim() === resolvedCorrectAnswer.trim());
                const showExplanation = showExplanationIds.has(q.id);
                const isLoadingSol = loadingSolutionIds.has(q.id);

                return (
                  <div 
                    key={q.id}
                    className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs hover:border-slate-300 transition-all"
                  >
                    {/* Question Header */}
                    <div className="p-5 sm:p-6 border-b border-slate-100 bg-slate-50/50">
                      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                        <div className="flex items-center gap-2">
                          <span className="px-2.5 py-0.5 rounded-md text-xs font-bold bg-slate-900 text-amber-400">
                            #{idx + 1}
                          </span>
                          <span className="px-2.5 py-0.5 rounded-md text-xs font-bold bg-amber-100 text-amber-800">
                            বার কাউন্সিল {q.year}
                          </span>
                          <span className="text-xs font-semibold text-slate-600 truncate max-w-[200px] sm:max-w-none">
                            {q.subject}
                          </span>
                        </div>

                        {resolvedLegalSection && (
                          <span className="text-xs font-medium text-slate-500 bg-white border border-slate-200 px-2 py-0.5 rounded-md flex items-center gap-1">
                            <Scale className="w-3 h-3 text-amber-500" />
                            {resolvedLegalSection}
                          </span>
                        )}
                      </div>

                      <h3 className="text-base sm:text-lg font-semibold text-slate-900 leading-relaxed">
                        {q.question}
                      </h3>
                    </div>

                    {/* Options List */}
                    <div className="p-5 sm:p-6 space-y-2.5">
                      {q.options.map((opt: string, optIdx: number) => {
                        const optLetter = ['ক', 'খ', 'গ', 'ঘ'][optIdx] || (optIdx + 1);
                        const isThisSelected = userChoice === opt;
                        const isThisCorrect = resolvedCorrectAnswer ? resolvedCorrectAnswer.trim() === opt.trim() : false;

                        // Style determination
                        let containerStyle = 'bg-white border-slate-200 hover:border-slate-300 hover:bg-slate-50/70 text-slate-800';
                        let badgeStyle = 'bg-slate-100 text-slate-600';

                        if (isAnswered) {
                          if (isThisCorrect) {
                            containerStyle = 'bg-emerald-50 border-emerald-400 text-emerald-950 font-semibold shadow-xs';
                            badgeStyle = 'bg-emerald-600 text-white font-bold';
                          } else if (isThisSelected) {
                            containerStyle = 'bg-rose-50 border-rose-300 text-rose-950';
                            badgeStyle = 'bg-rose-500 text-white font-bold';
                          } else {
                            containerStyle = 'opacity-60 bg-slate-50/50 border-slate-100 text-slate-500';
                          }
                        }

                        return (
                          <div
                            key={optIdx}
                            onClick={() => void handlePracticeSelect(q.id, opt)}
                            className={`p-3.5 sm:p-4 rounded-xl border flex items-center justify-between transition-all cursor-pointer ${containerStyle}`}
                          >
                            <div className="flex items-center gap-3">
                              <span className={`w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold shrink-0 ${badgeStyle}`}>
                                {optLetter}
                              </span>
                              <span className="text-sm sm:text-base leading-snug">
                                {opt}
                              </span>
                            </div>

                            {isAnswered && isThisCorrect && (
                              <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
                            )}
                            {isAnswered && isThisSelected && !isThisCorrect && (
                              <XCircle className="w-5 h-5 text-rose-500 shrink-0" />
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {/* Explanation Toggle & Content */}
                    <div className="px-5 sm:px-6 pb-5 pt-1">
                      <div className="flex items-center justify-between">
                        <button
                          onClick={() => void toggleExplanation(q.id)}
                          className="text-xs sm:text-sm font-semibold text-slate-600 hover:text-slate-900 flex items-center gap-1.5 cursor-pointer"
                        >
                          <Eye className="w-4 h-4 text-amber-600" />
                          {showExplanation ? t('ব্যাখ্যা লুকান', 'Hide Solution') : t('সঠিক উত্তর ও বিস্তারিত ব্যাখ্যা দেখুন', 'View Answer & Legal Solution')}
                        </button>

                        {isAnswered && (
                          <span className={`text-xs font-bold px-2 py-0.5 rounded-md ${
                            isCorrect ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'
                          }`}>
                            {isCorrect ? t('আপনার উত্তর সঠিক হয়েছে ✓', 'Correct Answer ✓') : t('ভুল উত্তর ✗', 'Incorrect Answer ✗')}
                          </span>
                        )}
                      </div>

                      {showExplanation && (
                        <div className="mt-4 p-4 rounded-xl bg-amber-50/70 border border-amber-200 space-y-2 text-sm text-slate-800 animate-fadeIn">
                          {isLoadingSol ? (
                            <p className="text-xs text-slate-600">{t('সমাধান লোড হচ্ছে...', 'Loading statutory solution...')}</p>
                          ) : (
                            <>
                              <div className="flex items-center gap-2 text-amber-900 font-bold">
                                <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                                <span>{t('সঠিক উত্তর:', 'Correct Answer:')} {resolvedCorrectAnswer || '—'}</span>
                              </div>

                              {resolvedLegalSection && (
                                <div className="flex items-center gap-2 text-xs font-semibold text-slate-700 bg-white/80 p-2 rounded-lg border border-amber-100">
                                  <Scale className="w-3.5 h-3.5 text-amber-600" />
                                  <span>{t('আইনি ধারা / বিধিমালা:', 'Statutory Reference:')} {resolvedLegalSection}</span>
                                </div>
                              )}

                              {resolvedExplanation && (
                                <div className="text-slate-700 leading-relaxed pt-1 border-t border-amber-100/60">
                                  <span className="font-semibold text-slate-900">{t('ব্যাখ্যা ও আইনি যুক্তি:', 'Explanation & Legal Basis:')}</span>{' '}
                                  {resolvedExplanation}
                                </div>
                              )}

                              {resolvedSource && (
                                <div className="text-[11px] text-slate-500 pt-1">
                                  {t('উৎস:', 'Source:')} {resolvedSource}
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* ------------------------------------------------------------- */}
        {/* 3. MODE: TIMED EXAM MODE                                      */}
        {/* ------------------------------------------------------------- */}
        {activeMode === 'exam' && (
          <div className="space-y-6">
            {/* Exam Floating Sticky Status Bar */}
            <div className="sticky top-18 z-30 bg-slate-900 text-white rounded-2xl p-4 shadow-lg border border-slate-800 flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-3">
                <span className="p-2 rounded-lg bg-amber-500 text-slate-950 font-bold">
                  <Clock className="w-5 h-5 animate-pulse" />
                </span>
                <div>
                  <div className="text-xs text-slate-400 font-medium">
                    {t('অবশিষ্ট সময়', 'Time Remaining')}
                  </div>
                  <div className="text-xl sm:text-2xl font-mono font-bold text-amber-400">
                    {formatTimer(examTimeRemaining)}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-4">
                <div className="text-right hidden sm:block">
                  <div className="text-xs text-slate-400">
                    {t('উত্তর সম্পন্ন', 'Answered')}
                  </div>
                  <div className="text-sm font-bold text-slate-200">
                    {Object.keys(examAnswers).length} / {filteredQuestions.length}
                  </div>
                </div>

                <button
                  disabled={isGradingExam}
                  onClick={() => void finishExam()}
                  className="px-5 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-slate-950 font-bold text-sm shadow-md transition-all cursor-pointer flex items-center gap-2"
                >
                  <FileCheck className="w-4 h-4" />
                  {isGradingExam ? t('মূল্যায়ন হচ্ছে...', 'Grading...') : t('পরীক্ষা জমা দিন', 'Submit Exam')}
                </button>
              </div>
            </div>

            {examError && (
              <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs sm:text-sm font-semibold">
                {examError}
              </div>
            )}

            {/* Questions for Exam */}
            <div className="space-y-4">
              {filteredQuestions.map((q, idx) => {
                const userChoice = examAnswers[q.id];

                return (
                  <div 
                    key={q.id}
                    className="bg-white rounded-2xl border border-slate-200 p-5 sm:p-6 shadow-xs"
                  >
                    <div className="flex items-center justify-between gap-2 mb-3">
                      <span className="px-2.5 py-0.5 rounded-md text-xs font-bold bg-slate-900 text-amber-400">
                        প্রশ্ন #{idx + 1}
                      </span>
                      <span className="text-xs font-medium text-slate-500">
                        বার কাউন্সিল {q.year} • {q.subject}
                      </span>
                    </div>

                    <h3 className="text-base sm:text-lg font-semibold text-slate-900 mb-4 leading-relaxed">
                      {q.question}
                    </h3>

                    <div className="space-y-2.5">
                      {q.options.map((opt: string, optIdx: number) => {
                        const optLetter = ['ক', 'খ', 'গ', 'ঘ'][optIdx] || (optIdx + 1);
                        const isChosen = userChoice === opt;

                        return (
                          <div
                            key={optIdx}
                            onClick={() => setExamAnswers(prev => ({ ...prev, [q.id]: opt }))}
                            className={`p-3.5 sm:p-4 rounded-xl border flex items-center justify-between transition-all cursor-pointer ${
                              isChosen
                                ? 'bg-amber-500/15 border-amber-500 text-slate-950 font-semibold'
                                : 'bg-white border-slate-200 hover:border-slate-300 text-slate-700'
                            }`}
                          >
                            <div className="flex items-center gap-3">
                              <span className={`w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold shrink-0 ${
                                isChosen ? 'bg-amber-500 text-slate-950 font-bold' : 'bg-slate-100 text-slate-600'
                              }`}>
                                {optLetter}
                              </span>
                              <span className="text-sm sm:text-base">{opt}</span>
                            </div>

                            {isChosen && (
                              <CheckCircle2 className="w-4 h-4 text-amber-600 shrink-0" />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Bottom Submit Banner */}
            <div className="p-6 bg-white rounded-2xl border border-slate-200 flex flex-col sm:flex-row items-center justify-between gap-4">
              <div>
                <h4 className="font-bold text-slate-900">{t('পরীক্ষা শেষ করতে চান?', 'Ready to submit?')}</h4>
                <p className="text-xs text-slate-500">
                  {t('জমা দেওয়ার পর তাৎক্ষণিক ফলাফল এবং ভুল উত্তরের বিস্তারিত রিপোর্ট দেখানো হবে।', 'You will immediately see your score and detailed report of wrong answers.')}
                </p>
              </div>
              <button
                disabled={isGradingExam}
                onClick={() => void finishExam()}
                className="w-full sm:w-auto px-6 py-3 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-slate-950 font-bold text-sm shadow-md transition-all cursor-pointer flex items-center justify-center gap-2"
              >
                <FileCheck className="w-4 h-4" />
                {isGradingExam ? t('মূল্যায়ন হচ্ছে...', 'Grading...') : t('ফলাফল প্রকাশ করুন', 'Submit & View Report')}
              </button>
            </div>
          </div>
        )}

        {/* ------------------------------------------------------------- */}
        {/* 4. MODE: EXAM RESULT & SUMMARY REPORT                         */}
        {/* ------------------------------------------------------------- */}
        {activeMode === 'exam_result' && examEvaluation && (
          <div className="space-y-6">
            {/* Scorecard Summary */}
            <div className="bg-white rounded-3xl border border-slate-200 overflow-hidden shadow-sm">
              <div className={`p-6 sm:p-8 text-center ${
                examEvaluation.isPassed 
                  ? 'bg-gradient-to-b from-emerald-500/10 via-emerald-500/5 to-white' 
                  : 'bg-gradient-to-b from-rose-500/10 via-rose-500/5 to-white'
              }`}>
                <div className={`w-16 h-16 rounded-2xl mx-auto mb-4 flex items-center justify-center shadow-md ${
                  examEvaluation.isPassed ? 'bg-emerald-600 text-white' : 'bg-rose-600 text-white'
                }`}>
                  <Award className="w-8 h-8" />
                </div>

                <span className={`inline-block px-3.5 py-1 rounded-full text-xs font-bold uppercase tracking-wider mb-2 ${
                  examEvaluation.isPassed ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'
                }`}>
                  {examEvaluation.isPassed ? t('পাস করেছেন (PASSED)', 'PASSED') : t('অনুত্তীর্ণ (FAILED)', 'FAILED')}
                </span>

                <h2 className="text-3xl sm:text-4xl font-extrabold text-slate-900">
                  {examEvaluation.finalScore} <span className="text-lg font-normal text-slate-500">/ {examEvaluation.totalQuestions}</span>
                </h2>
                <p className="mt-1 text-sm font-semibold text-slate-600">
                  {t('প্রাপ্ত নম্বর:', 'Marks Obtained:')} {examEvaluation.percentage}%
                </p>
                <p className="text-xs text-slate-400 mt-0.5">
                  (বার কাউন্সিল স্ট্যান্ডার্ড: ৫০% পাসের মানদণ্ড)
                </p>

                {/* Score breakdown metrics */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-6 pt-6 border-t border-slate-100 max-w-2xl mx-auto">
                  <div className="bg-slate-50 p-3 rounded-xl border border-slate-100">
                    <div className="text-xs text-slate-500 font-medium">{t('সঠিক উত্তর', 'Correct')}</div>
                    <div className="text-lg font-bold text-emerald-600">+{examEvaluation.correctCount}</div>
                    <div className="text-[10px] text-slate-400">+{examEvaluation.positiveMarks} নম্বর</div>
                  </div>

                  <div className="bg-slate-50 p-3 rounded-xl border border-slate-100">
                    <div className="text-xs text-slate-500 font-medium">{t('ভুল উত্তর', 'Incorrect')}</div>
                    <div className="text-lg font-bold text-rose-500">-{examEvaluation.incorrectCount}</div>
                    <div className="text-[10px] text-slate-400">-{examEvaluation.negativeMarks} কর্তন</div>
                  </div>

                  <div className="bg-slate-50 p-3 rounded-xl border border-slate-100">
                    <div className="text-xs text-slate-500 font-medium">{t('উত্তর দেননি', 'Unanswered')}</div>
                    <div className="text-lg font-bold text-slate-600">{examEvaluation.unansweredCount}</div>
                    <div className="text-[10px] text-slate-400">০ নম্বর</div>
                  </div>

                  <div className="bg-slate-50 p-3 rounded-xl border border-slate-100">
                    <div className="text-xs text-slate-500 font-medium">{t('মোট প্রশ্ন', 'Total Qs')}</div>
                    <div className="text-lg font-bold text-slate-900">{examEvaluation.totalQuestions}</div>
                    <div className="text-[10px] text-slate-400">১ নম্বর করে</div>
                  </div>
                </div>

                {/* Action Buttons */}
                <div className="flex flex-wrap items-center justify-center gap-3 mt-6">
                  <button
                    onClick={startExamMode}
                    className="px-5 py-2.5 rounded-xl bg-slate-900 text-white font-semibold text-sm hover:bg-slate-800 transition-colors flex items-center gap-2 cursor-pointer"
                  >
                    <RotateCcw className="w-4 h-4" />
                    {t('পুনরায় পরীক্ষা দিন', 'Retake Exam')}
                  </button>

                  <button
                    onClick={() => setActiveMode('practice')}
                    className="px-5 py-2.5 rounded-xl bg-amber-500 text-slate-950 font-bold text-sm hover:bg-amber-400 transition-colors flex items-center gap-2 cursor-pointer"
                  >
                    <BookOpen className="w-4 h-4" />
                    {t('অনুশীলন মোডে সমাধান দেখুন', 'Open in Practice Mode')}
                  </button>
                </div>
              </div>
            </div>

            {/* Detailed Summary Report of Incorrect Questions */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                  <AlertCircle className="w-5 h-5 text-rose-500" />
                  {t('ভুল উত্তরের পূর্ণাঙ্গ তালিকা ও সমাধান রিপোর্ট', 'Summary Report of Incorrect Answers')}
                </h3>
                <span className="text-xs font-semibold text-slate-500 bg-white border border-slate-200 px-3 py-1 rounded-full">
                  {examEvaluation.incorrectList.length} টি ভুল উত্তর
                </span>
              </div>

              {examEvaluation.incorrectList.length === 0 ? (
                <div className="p-8 bg-emerald-50 rounded-2xl border border-emerald-200 text-center">
                  <CheckCircle2 className="w-12 h-12 text-emerald-600 mx-auto mb-2" />
                  <h4 className="font-bold text-emerald-900 text-lg">
                    {t('অসাধারণ! আপনার কোনো উত্তর ভুল হয়নি!', 'Outstanding! No incorrect answers!')}
                  </h4>
                  <p className="text-sm text-emerald-700 mt-1">
                    {t('আপনি পরীক্ষার সবকটি উত্তর শতভাগ নির্ভুলভাবে সম্পন্ন করেছেন।', 'You answered every question with 100% accuracy.')}
                  </p>
                </div>
              ) : (
                examEvaluation.incorrectList.map((item, idx) => {
                  const { question: q, selectedAnswer } = item;
                  return (
                    <div 
                      key={q.id}
                      className="bg-white rounded-2xl border border-rose-200 p-5 sm:p-6 shadow-xs"
                    >
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <span className="px-2 py-0.5 rounded-md text-xs font-bold bg-rose-100 text-rose-800">
                          ভুল #{idx + 1}
                        </span>
                        <span className="text-xs font-medium text-slate-500">
                          বার কাউন্সিল {q.year} • {q.subject}
                        </span>
                      </div>

                      <h4 className="text-base font-semibold text-slate-900 mb-3 leading-relaxed">
                        {q.question}
                      </h4>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
                        <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs">
                          <span className="font-bold text-rose-800 block mb-1">
                            {t('আপনার প্রদত্ত উত্তর (ভুল):', 'Your Answer (Wrong):')}
                          </span>
                          <span className="text-rose-950 font-medium">{selectedAnswer || t('(উত্তর দেননি)', '(Not answered)')}</span>
                        </div>

                        <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-xs">
                          <span className="font-bold text-emerald-800 block mb-1">
                            {t('সঠিক উত্তর:', 'Correct Answer:')}
                          </span>
                          <span className="text-emerald-950 font-bold">{q.correctAnswer}</span>
                        </div>
                      </div>

                      {/* Statutory Legal Explanation */}
                      <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2 text-xs sm:text-sm">
                        {q.legalSection && (
                          <div className="font-semibold text-amber-800 flex items-center gap-1.5">
                            <Scale className="w-3.5 h-3.5" />
                            <span>{t('আইনি রেফারেন্স:', 'Statutory Section:')} {q.legalSection}</span>
                          </div>
                        )}
                        <p className="text-slate-700 leading-relaxed">
                          <span className="font-bold text-slate-900">{t('ব্যাখ্যা:', 'Explanation:')}</span>{' '}
                          {q.explanation}
                        </p>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

      </div>
    </div>
  );
};
