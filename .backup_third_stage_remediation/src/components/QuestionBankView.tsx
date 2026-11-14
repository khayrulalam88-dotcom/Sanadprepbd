import React, { useState, useMemo } from 'react';
import { useApp } from '../context/AppContext';
import { auth, isVerifiedOwnerAccount } from '../lib/firebase';
import { CustomTestModal } from './CustomTestModal';
import { 
  BookOpen, 
  Search, 
  Filter, 
  Sparkles, 
  Play, 
  Clock, 
  CheckCircle2, 
  Layers, 
  Scale, 
  HelpCircle, 
  ChevronDown, 
  ChevronUp, 
  RotateCcw, 
  Sliders, 
  CheckSquare, 
  Square, 
  ArrowRight,
  Award,
  FileText,
  Calendar,
  Check,
  X,
  ShieldAlert
} from 'lucide-react';
import { Question } from '../types';

export const QuestionBankView: React.FC = () => {
  const { 
    language, 
    t, 
    currentUser,
    questions, 
    subjects, 
    exams, 
    examResults, 
    startExam, 
    createAndStartCustomExam,
    setActiveScreen 
  } = useApp();

  const isAdmin = isVerifiedOwnerAccount(auth?.currentUser) && currentUser.role === 'admin';

  const [activeTab, setActiveTab] = useState<'browse' | 'generator' | 'my_tests'>('browse');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedSubjectId, setSelectedSubjectId] = useState<string>('all');
  const [selectedDifficulty, setSelectedDifficulty] = useState<string>('all');
  const [expandedExplanations, setExpandedExplanations] = useState<Record<string, boolean>>({});
  
  // Selected question IDs for custom test
  const [selectedQuestionIds, setSelectedQuestionIds] = useState<Set<string>>(new Set());
  
  // Custom Test Modal State
  const [showCustomModal, setShowCustomModal] = useState<boolean>(false);
  const [modalPreSelectedIds, setModalPreSelectedIds] = useState<string[]>([]);

  // Generator Tab State
  const [genSubjectIds, setGenSubjectIds] = useState<string[]>([]);
  const [genCount, setGenCount] = useState<number>(25);
  const [genDuration, setGenDuration] = useState<number>(30);
  const [genNegativeMark, setGenNegativeMark] = useState<number>(0.25);
  const [genTitle, setGenTitle] = useState<string>('');
  const [genDifficulty, setGenDifficulty] = useState<'all' | 'easy' | 'medium' | 'hard'>('all');

  // Pagination for fast rendering of 3,000+ questions
  const [currentPage, setCurrentPage] = useState<number>(1);
  const pageSize = 20;

  // Filtered Questions
  const filteredQuestions = useMemo(() => {
    return questions.filter(q => {
      // Subject filter
      if (selectedSubjectId !== 'all' && q.subjectId !== selectedSubjectId) {
        return false;
      }
      // Difficulty filter
      if (selectedDifficulty !== 'all' && q.difficulty !== selectedDifficulty) {
        return false;
      }
      // Search query filter (matches Bengali text, English text, Legal reference, or explanation)
      if (searchQuery.trim().length > 0) {
        const query = searchQuery.toLowerCase().trim();
        const inBn = q.questionBn.toLowerCase().includes(query);
        const inEn = (q.questionEn || '').toLowerCase().includes(query);
        const inRef = (q.legalReference || '').toLowerCase().includes(query);
        const inExp = (q.explanationBn || '').toLowerCase().includes(query);
        const inOptions = q.optionsBn.some(opt => opt.toLowerCase().includes(query));
        if (!inBn && !inEn && !inRef && !inExp && !inOptions) {
          return false;
        }
      }
      return true;
    });
  }, [questions, selectedSubjectId, selectedDifficulty, searchQuery]);

  // Paginated Questions
  const totalPages = Math.max(1, Math.ceil(filteredQuestions.length / pageSize));
  const paginatedQuestions = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredQuestions.slice(start, start + pageSize);
  }, [filteredQuestions, currentPage, pageSize]);

  // Subject map for fast lookup
  const subjectMap = useMemo(() => {
    const map = new Map<string, typeof subjects[0]>();
    subjects.forEach(s => map.set(s.id, s));
    return map;
  }, [subjects]);

  // Toggle selection for a single question
  const toggleQuestionSelection = (id: string) => {
    setSelectedQuestionIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // Quick select helper
  const handleQuickSelect = (count: number) => {
    const next = new Set(selectedQuestionIds);
    const pool = filteredQuestions.slice(0, count);
    pool.forEach(q => next.add(q.id));
    setSelectedQuestionIds(next);
  };

  // Deselect all
  const handleClearSelection = () => {
    setSelectedQuestionIds(new Set());
  };

  // Open modal with currently selected questions
  const handleLaunchTestWithSelected = () => {
    if (selectedQuestionIds.size === 0) {
      alert(t('অনুগ্রহ করে অন্তত ১টি প্রশ্ন নির্বাচন করুন', 'Please select at least 1 question.'));
      return;
    }
    setModalPreSelectedIds(Array.from(selectedQuestionIds));
    setShowCustomModal(true);
  };

  // Launch test from Generator Tab
  const handleStartGeneratorTest = () => {
    let pool = questions.filter(q => {
      if (genSubjectIds.length > 0 && !genSubjectIds.includes(q.subjectId)) {
        return false;
      }
      if (genDifficulty !== 'all' && q.difficulty !== genDifficulty) {
        return false;
      }
      return true;
    });

    if (pool.length === 0) pool = questions;

    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    const chosen = shuffled.slice(0, Math.min(genCount, shuffled.length)).map(q => q.id);

    const titleBn = genTitle.trim() || `কাস্টম মডেল টেস্ট (${chosen.length} টি প্রশ্ন)`;
    const titleEn = genTitle.trim() || `Custom Model Test (${chosen.length} MCQs)`;

    const res = createAndStartCustomExam({
      titleBn,
      titleEn,
      durationMinutes: genDuration,
      questionIds: chosen,
      negativeMarkRatio: genNegativeMark
    });

    if (!res.success && res.reason) {
      alert(res.reason);
    }
  };

  // Previous custom exams
  const customExams = useMemo(() => {
    return exams.filter(e => e.type === 'custom_test');
  }, [exams]);

  const optionPrefixesBn = ['ক', 'খ', 'গ', 'ঘ'];

  if (!isAdmin) {
    return (
      <div className="max-w-2xl mx-auto my-12 p-8 bg-white rounded-3xl border border-slate-200 shadow-sm text-center space-y-4">
        <div className="w-16 h-16 rounded-2xl bg-amber-50 text-amber-700 mx-auto flex items-center justify-center">
          <ShieldAlert className="w-8 h-8 text-[#D4AF37]" />
        </div>
        <h2 className="text-xl font-black text-[#102A43]">
          {t('শুধুমাত্র অ্যাডমিনের জন্য সংরক্ষিত', 'Admin Access Only')}
        </h2>
        <p className="text-xs sm:text-sm text-slate-600 leading-relaxed max-w-md mx-auto">
          {t(
            'অ্যাডমিন ছাড়া কেউ কাস্টম টেস্ট তৈরি বা পরিচালনা করতে পারবে না। শিক্ষার্থীরা শুধুমাত্র অ্যাডমিন কর্তৃক পরিচালিত অফিসিয়াল মডেল টেস্টসমূহে অংশ নিতে পারবে।',
            'Custom tests can only be curated and conducted by the Admin. Students can participate in official mock tests published by the Admin.'
          )}
        </p>
        <div className="pt-2">
          <button
            onClick={() => setActiveScreen('dashboard')}
            className="px-6 py-2.5 rounded-xl bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] border border-[#D4AF37] font-bold text-xs transition cursor-pointer shadow-xs"
          >
            {t('ড্যাশবোর্ডে ফিরে যান', 'Back to Dashboard')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-20 max-w-7xl mx-auto">
      
      {/* Top Hero Banner */}
      <div className="bg-gradient-to-r from-[#102A43] via-[#1A365D] to-[#0D1F30] rounded-3xl p-6 sm:p-8 text-white shadow-xl relative overflow-hidden border border-slate-700">
        <div className="absolute top-0 right-0 w-80 h-80 bg-[#D4AF37]/10 rounded-full blur-3xl pointer-events-none" />
        
        <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#D4AF37]/20 border border-[#D4AF37]/40 text-xs font-bold text-[#D4AF37]">
              <Sparkles className="w-3.5 h-3.5" />
              <span>{t('প্রশ্ন সম্ভার ও কাস্টম মডেল টেস্ট', 'Question Repository & Custom Mock Tests')}</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-black text-white tracking-tight">
              {t('প্রশ্ন সম্ভার থেকে মডেল টেস্ট তৈরি ও পরীক্ষা পরিচালনা', 'Curate Model Tests from Question Bank & Conduct Exams')}
            </h1>
            <p className="text-xs sm:text-sm text-slate-300 max-w-2xl leading-relaxed">
              {t(
                '৩,০০০+ অফিসিয়াল ও প্রমিত প্রশ্নের সংগ্রহশালা থেকে ইচ্ছামতো প্রশ্ন বেছে নিয়ে মডেল টেস্ট তৈরি করুন এবং শিক্ষার্থীদের জন্য পরীক্ষা চালু ও পরিচালনা করুন।',
                'Curate mock tests using 3,000+ official questions from the repository and launch timed exams for students.'
              )}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => {
                setModalPreSelectedIds([]);
                setShowCustomModal(true);
              }}
              className="px-5 py-3 rounded-xl bg-[#D4AF37] hover:bg-[#b89528] text-[#102A43] font-black text-xs sm:text-sm shadow-md transition flex items-center gap-2 cursor-pointer"
            >
              <Sparkles className="w-4 h-4 text-[#102A43]" />
              <span>{t('কুইক কাস্টম টেস্ট তৈরি করুন', 'Quick Test Builder')}</span>
            </button>

            {selectedQuestionIds.size > 0 && (
              <button
                onClick={handleLaunchTestWithSelected}
                className="px-5 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-black text-xs sm:text-sm shadow-md transition flex items-center gap-2 cursor-pointer animate-pulse"
              >
                <Play className="w-4 h-4 fill-current" />
                <span>{t(`নির্বাচিত (${selectedQuestionIds.size}) প্রশ্ন দিয়ে পরীক্ষা`, `Take Test with (${selectedQuestionIds.size}) Questions`)}</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="flex border-b border-slate-200 gap-2 sm:gap-6 text-xs sm:text-sm font-bold overflow-x-auto pb-px">
        <button
          onClick={() => setActiveTab('browse')}
          className={`pb-3.5 px-2 flex items-center gap-2 border-b-2 transition whitespace-nowrap cursor-pointer ${
            activeTab === 'browse'
              ? 'border-[#102A43] text-[#102A43]'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <BookOpen className="w-4 h-4" />
          <span>{t('প্রশ্ন সম্ভার ও নির্বাচন', 'Question Bank & Selector')}</span>
          <span className="px-2 py-0.5 rounded-full bg-slate-200 text-slate-700 text-xs">
            {questions.length}
          </span>
        </button>

        <button
          onClick={() => setActiveTab('generator')}
          className={`pb-3.5 px-2 flex items-center gap-2 border-b-2 transition whitespace-nowrap cursor-pointer ${
            activeTab === 'generator'
              ? 'border-[#102A43] text-[#102A43]'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <Sliders className="w-4 h-4 text-[#D4AF37]" />
          <span>{t('অটো কাস্টম টেস্ট জেনারেটর', 'Auto Custom Test Generator')}</span>
        </button>

        <button
          onClick={() => setActiveTab('my_tests')}
          className={`pb-3.5 px-2 flex items-center gap-2 border-b-2 transition whitespace-nowrap cursor-pointer ${
            activeTab === 'my_tests'
              ? 'border-[#102A43] text-[#102A43]'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <Award className="w-4 h-4" />
          <span>{t('আমার কাস্টম টেস্টসমূহ', 'My Custom Tests')}</span>
          {customExams.length > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-xs">
              {customExams.length}
            </span>
          )}
        </button>
      </div>

      {/* TAB 1: BROWSE & SELECT QUESTIONS */}
      {activeTab === 'browse' && (
        <div className="space-y-6">
          
          {/* Search & Filter Bar */}
          <div className="bg-white p-4 sm:p-5 rounded-2xl border border-slate-200 shadow-xs space-y-4">
            
            {/* Search Input */}
            <div className="flex items-center gap-3 bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 focus-within:border-[#102A43] focus-within:bg-white transition">
              <Search className="w-4 h-4 text-slate-400 shrink-0" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setCurrentPage(1);
                }}
                placeholder={t('ধারা, বিষয়, অপরাধ বা প্রশ্ন লিখে অনুসন্ধান করুন (যেমন: Section 151, জামিন, আপিল, ইত্যাদি)...', 'Search sections, acts, topics or questions...')}
                className="w-full text-xs sm:text-sm text-slate-900 bg-transparent outline-none"
              />
              {searchQuery && (
                <button 
                  onClick={() => setSearchQuery('')}
                  className="text-slate-400 hover:text-slate-600 cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* Subject Filter Pills */}
            <div className="space-y-2">
              <span className="text-[11px] font-bold text-slate-500 block uppercase tracking-wider">
                {t('আইন অনুযায়ী ফিল্টার:', 'Filter by Law:')}
              </span>
              <div className="flex items-center gap-2 overflow-x-auto pb-1 text-xs">
                <button
                  onClick={() => {
                    setSelectedSubjectId('all');
                    setCurrentPage(1);
                  }}
                  className={`px-3 py-1.5 rounded-xl font-bold transition whitespace-nowrap cursor-pointer ${
                    selectedSubjectId === 'all'
                      ? 'bg-[#102A43] text-white shadow-xs'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  {t('সকল বিষয় (৩,০৫৮)', 'All Subjects')}
                </button>

                {subjects.map(s => {
                  const isSelected = selectedSubjectId === s.id;
                  const count = questions.filter(q => q.subjectId === s.id).length;
                  return (
                    <button
                      key={s.id}
                      onClick={() => {
                        setSelectedSubjectId(s.id);
                        setCurrentPage(1);
                      }}
                      className={`px-3 py-1.5 rounded-xl font-bold transition whitespace-nowrap cursor-pointer flex items-center gap-1.5 ${
                        isSelected
                          ? 'bg-[#102A43] text-[#D4AF37] border border-[#D4AF37] shadow-xs'
                          : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                      }`}
                    >
                      <span>{s.nameBn}</span>
                      <span className="text-[10px] opacity-75">({count})</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Difficulty & Quick Select Row */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2 border-t border-slate-100 text-xs">
              <div className="flex items-center gap-2">
                <span className="text-slate-500 font-bold">{t('কঠিনতা:', 'Difficulty:')}</span>
                {['all', 'easy', 'medium', 'hard'].map(diff => (
                  <button
                    key={diff}
                    onClick={() => {
                      setSelectedDifficulty(diff);
                      setCurrentPage(1);
                    }}
                    className={`px-2.5 py-1 rounded-lg font-bold transition cursor-pointer capitalize ${
                      selectedDifficulty === diff 
                        ? 'bg-amber-100 text-amber-900 border border-[#D4AF37]' 
                        : 'bg-slate-50 text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    {diff === 'all' ? t('সকল', 'All') : diff === 'easy' ? t('সহজ', 'Easy') : diff === 'medium' ? t('মাঝারি', 'Medium') : t('কঠিন', 'Hard')}
                  </button>
                ))}
              </div>

              {/* Quick Select Actions */}
              <div className="flex items-center gap-2">
                <span className="text-slate-500 font-bold">{t('এক ক্লিকে নির্বাচন:', 'Quick Pick:')}</span>
                {[10, 25, 50, 100].map(cnt => (
                  <button
                    key={cnt}
                    onClick={() => handleQuickSelect(cnt)}
                    className="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold text-[11px] transition cursor-pointer"
                    title={t(`প্রথম ${cnt}টি প্রশ্ন নির্বাচন করুন`, `Select first ${cnt} questions`)}
                  >
                    +{cnt}
                  </button>
                ))}
                {selectedQuestionIds.size > 0 && (
                  <button
                    onClick={handleClearSelection}
                    className="px-2.5 py-1 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 font-bold text-[11px] transition cursor-pointer"
                  >
                    {t('খালি করুন', 'Clear')}
                  </button>
                )}
              </div>
            </div>

          </div>

          {/* Sticky Floating Selection Banner if user selected questions */}
          {selectedQuestionIds.size > 0 && (
            <div className="sticky top-20 z-30 bg-[#102A43] text-white p-4 rounded-2xl shadow-xl border border-[#D4AF37] flex flex-col sm:flex-row sm:items-center justify-between gap-4 animate-in slide-in-from-top-2">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-[#D4AF37] text-[#102A43] flex items-center justify-center font-black text-sm shrink-0">
                  {selectedQuestionIds.size}
                </div>
                <div>
                  <p className="font-bold text-sm text-white">
                    {t(`${selectedQuestionIds.size} টি প্রশ্ন নির্বাচন করা হয়েছে`, `${selectedQuestionIds.size} Questions Selected`)}
                  </p>
                  <p className="text-xs text-slate-300">
                    {t('এই প্রশ্নগুলো দিয়ে নিজস্ব মডেল টেস্ট নিতে নিচের বাটনে ক্লিক করুন', 'Click the button to configure and start your custom examination')}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={handleClearSelection}
                  className="px-3.5 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-bold transition cursor-pointer"
                >
                  {t('নির্বাচন বাতিল', 'Clear All')}
                </button>

                <button
                  onClick={handleLaunchTestWithSelected}
                  className="px-5 py-2.5 rounded-xl bg-[#D4AF37] hover:bg-[#b89528] text-[#102A43] font-black text-xs sm:text-sm shadow-md transition flex items-center gap-2 cursor-pointer"
                >
                  <Play className="w-4 h-4 fill-current text-[#102A43]" />
                  <span>{t('এই প্রশ্নগুলো দিয়ে মডেল টেস্ট দিন', 'Start Test with Selected')}</span>
                </button>
              </div>
            </div>
          )}

          {/* Questions List Header */}
          <div className="flex items-center justify-between text-xs text-slate-500 px-1">
            <span>
              {t(`মোট ${filteredQuestions.length} টি প্রশ্ন পাওয়া গেছে`, `Found ${filteredQuestions.length} questions`)}
              {filteredQuestions.length > pageSize && ` (পৃষ্ঠা ${currentPage} / ${totalPages})`}
            </span>
            <span>
              {selectedQuestionIds.size > 0 
                ? t(`${selectedQuestionIds.size} টি নির্বাচিত`, `${selectedQuestionIds.size} selected`)
                : t('বক্সে টিকচিহ্ন দিয়ে প্রশ্ন নির্বাচন করুন', 'Check box to select for test')}
            </span>
          </div>

          {/* Questions Cards */}
          <div className="space-y-4">
            {paginatedQuestions.map((q, idx) => {
              const isSelected = selectedQuestionIds.has(q.id);
              const isExpOpen = expandedExplanations[q.id];
              const sub = subjectMap.get(q.subjectId);
              const globalIdx = (currentPage - 1) * pageSize + idx + 1;

              return (
                <div 
                  key={q.id}
                  className={`p-5 rounded-2xl border transition relative ${
                    isSelected 
                      ? 'bg-amber-50/40 border-[#D4AF37] ring-1 ring-[#D4AF37]/50 shadow-xs' 
                      : 'bg-white border-slate-200 shadow-xs hover:border-slate-300'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3 mb-2.5">
                    
                    {/* Left: Checkbox & Serial */}
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => toggleQuestionSelection(q.id)}
                        className={`w-6 h-6 rounded-lg flex items-center justify-center transition cursor-pointer ${
                          isSelected 
                            ? 'bg-[#102A43] text-[#D4AF37]' 
                            : 'bg-slate-100 hover:bg-slate-200 text-slate-400 border border-slate-300'
                        }`}
                        title={isSelected ? 'পরীক্ষা থেকে বাদ দিন' : 'পরীক্ষায় অন্তর্ভুক্ত করুন'}
                      >
                        {isSelected ? <Check className="w-4 h-4 stroke-[3]" /> : null}
                      </button>

                      <span className="font-mono text-xs font-bold text-slate-400">
                        #{globalIdx}
                      </span>

                      {/* Subject Badge */}
                      <span className="px-2.5 py-0.5 rounded-md bg-slate-100 text-[#102A43] font-bold text-[10px]">
                        {sub?.nameBn || q.subjectId}
                      </span>

                      {/* Legal Reference Badge */}
                      {q.legalReference && (
                        <span className="px-2 py-0.5 rounded-md bg-amber-50 border border-amber-200 text-amber-900 font-bold text-[10px] hidden sm:inline-block">
                          {q.legalReference}
                        </span>
                      )}
                    </div>

                    {/* Right: Quick Actions */}
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => toggleQuestionSelection(q.id)}
                        className={`px-3 py-1 rounded-lg text-xs font-bold transition cursor-pointer ${
                          isSelected 
                            ? 'bg-[#102A43] text-[#D4AF37]' 
                            : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
                        }`}
                      >
                        {isSelected ? t('✓ নির্বাচিত', '✓ Selected') : t('+ নির্বাচন করুন', '+ Select')}
                      </button>
                    </div>

                  </div>

                  {/* Question Title */}
                  <h3 className="font-bold text-slate-900 text-sm sm:text-base leading-relaxed mb-3 pl-9">
                    {q.questionBn}
                  </h3>

                  {/* Options Grid */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pl-9 mb-3">
                    {q.optionsBn.map((opt, optIdx) => {
                      const isCorrect = optIdx === q.correctOptionIndex;
                      return (
                        <div
                          key={optIdx}
                          className={`p-2.5 rounded-xl border text-xs flex items-center gap-2.5 ${
                            isExpOpen && isCorrect 
                              ? 'bg-emerald-50 border-emerald-300 text-emerald-900 font-bold' 
                              : 'bg-slate-50 border-slate-200 text-slate-700'
                          }`}
                        >
                          <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
                            isExpOpen && isCorrect 
                              ? 'bg-emerald-600 text-white' 
                              : 'bg-white border border-slate-300 text-slate-600'
                          }`}>
                            {optionPrefixesBn[optIdx]}
                          </span>
                          <span className="flex-1">{opt}</span>
                          {isExpOpen && isCorrect && (
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* Toggle Explanation & Solution */}
                  <div className="pl-9 pt-1 flex items-center justify-between">
                    <button
                      type="button"
                      onClick={() => setExpandedExplanations(prev => ({ ...prev, [q.id]: !prev[q.id] }))}
                      className="text-xs font-bold text-[#102A43] hover:text-[#243B53] flex items-center gap-1 cursor-pointer"
                    >
                      <HelpCircle className="w-3.5 h-3.5 text-[#D4AF37]" />
                      <span>{isExpOpen ? t('ব্যাখ্যা বন্ধ করুন', 'Hide Explanation') : t('সঠিক উত্তর ও আইনি ধারা দেখুন', 'View Correct Answer & Section')}</span>
                      {isExpOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        // Quick 1-question model test
                        createAndStartCustomExam({
                          titleBn: `দ্রুত টেস্ট - ${sub?.nameBn || 'আইন'}`,
                          titleEn: `Quick Test - ${sub?.nameEn || 'Law'}`,
                          durationMinutes: 5,
                          questionIds: [q.id],
                          negativeMarkRatio: 0.25
                        });
                      }}
                      className="text-xs text-slate-500 hover:text-[#102A43] font-bold flex items-center gap-1 cursor-pointer"
                    >
                      <Play className="w-3 h-3 fill-current text-[#D4AF37]" />
                      <span>{t('এই প্রশ্নে পরীক্ষা দিন', 'Test This Question')}</span>
                    </button>
                  </div>

                  {/* Expanded Explanation Card */}
                  {isExpOpen && (
                    <div className="mt-3 ml-9 p-3.5 rounded-xl bg-slate-50 border border-slate-200 text-xs space-y-2 animate-in fade-in">
                      <div className="flex items-center justify-between text-emerald-800 font-bold">
                        <span>সঠিক উত্তর: {optionPrefixesBn[q.correctOptionIndex]} ({q.optionsBn[q.correctOptionIndex]})</span>
                        {q.legalReference && (
                          <span className="px-2 py-0.5 bg-white border border-slate-200 rounded text-slate-700 font-mono text-[11px]">
                            {q.legalReference}
                          </span>
                        )}
                      </div>
                      {q.explanationBn && (
                        <p className="text-slate-600 leading-relaxed">
                          <strong>আইনি ভিত্তি ও ব্যাখ্যা:</strong> {q.explanationBn}
                        </p>
                      )}
                    </div>
                  )}

                </div>
              );
            })}
          </div>

          {/* Pagination Controls */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 pt-4">
              <button
                disabled={currentPage === 1}
                onClick={() => {
                  setCurrentPage(prev => Math.max(1, prev - 1));
                  window.scrollTo({ top: 350, behavior: 'smooth' });
                }}
                className="px-4 py-2 rounded-xl border border-slate-200 bg-white text-xs font-bold disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50 cursor-pointer"
              >
                {t('পূর্ববর্তী পৃষ্ঠা', 'Previous Page')}
              </button>

              <span className="text-xs font-bold text-slate-600 px-3">
                {currentPage} / {totalPages}
              </span>

              <button
                disabled={currentPage === totalPages}
                onClick={() => {
                  setCurrentPage(prev => Math.min(totalPages, prev + 1));
                  window.scrollTo({ top: 350, behavior: 'smooth' });
                }}
                className="px-4 py-2 rounded-xl border border-slate-200 bg-white text-xs font-bold disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50 cursor-pointer"
              >
                {t('পরবর্তী পৃষ্ঠা', 'Next Page')}
              </button>
            </div>
          )}

        </div>
      )}

      {/* TAB 2: AUTOMATIC CUSTOM TEST GENERATOR */}
      {activeTab === 'generator' && (
        <div className="max-w-2xl mx-auto bg-white rounded-3xl border border-slate-200 p-6 sm:p-8 shadow-xs space-y-6">
          <div className="border-b border-slate-100 pb-4">
            <h2 className="text-xl font-black text-[#102A43] flex items-center gap-2">
              <Sliders className="w-5 h-5 text-[#D4AF37]" />
              <span>{t('স্বয়ংক্রিয় কাস্টম মডেল টেস্ট জেনারেটর', 'Auto Custom Test Generator')}</span>
            </h2>
            <p className="text-xs text-slate-500 mt-1">
              {t('আপনার পছন্দমতো আইন, প্রশ্নের সংখ্যা ও সময় নির্বাচন করুন। সিস্টেম রেন্ডমভাবে ৩,০০০ প্রশ্ন থেকে একটি মানসম্মত মডেল টেস্ট তৈরি করে দেবে।', 'Select legal codes, question quota, and time limit to instantly generate and take a randomized mock exam.')}
            </p>
          </div>

          {/* Test Title */}
          <div className="space-y-1.5">
            <label className="font-bold text-slate-800 block text-xs">
              {t('মডেল টেস্টের নাম (ঐচ্ছিক):', 'Test Title (Optional):')}
            </label>
            <input
              type="text"
              value={genTitle}
              onChange={(e) => setGenTitle(e.target.value)}
              placeholder="যেমন: দেওয়ানী ও ফৌজদারী স্পেশাল রিভিশন টেস্ট"
              className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 focus:border-[#102A43] text-xs text-slate-900 outline-none"
            />
          </div>

          {/* Subjects Selection */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="font-bold text-slate-800 block text-xs">
                {t('আইনসমূহ নির্বাচন করুন:', 'Select Subjects:')}
              </label>
              <button
                type="button"
                onClick={() => {
                  if (genSubjectIds.length === subjects.length) setGenSubjectIds([]);
                  else setGenSubjectIds(subjects.map(s => s.id));
                }}
                className="text-xs font-bold text-[#102A43] hover:underline cursor-pointer"
              >
                {genSubjectIds.length === subjects.length ? t('সব বাদ দিন', 'Deselect All') : t('৭টি আইনই নির্বাচন করুন', 'Select All 7')}
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              {subjects.map(s => {
                const isChecked = genSubjectIds.includes(s.id);
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => {
                      if (isChecked) setGenSubjectIds(prev => prev.filter(id => id !== s.id));
                      else setGenSubjectIds(prev => [...prev, s.id]);
                    }}
                    className={`p-2.5 rounded-xl border text-left text-xs font-bold flex items-center justify-between transition cursor-pointer ${
                      isChecked 
                        ? 'bg-amber-50 border-[#D4AF37] text-[#102A43]' 
                        : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    <span className="truncate">{s.nameBn}</span>
                    {isChecked && <CheckCircle2 className="w-3.5 h-3.5 text-[#D4AF37] shrink-0" />}
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-slate-400">
              {genSubjectIds.length === 0 
                ? t('কোনো বিষয় নির্বাচন না করলে বার কাউন্সিল সিলেবাসের অনুপাত অনুযায়ী সব আইন থেকেই প্রশ্ন সংকলন হবে।', 'If none checked, questions will be drawn equally across all statutory subjects.')
                : t(`${genSubjectIds.length} টি আইন নির্বাচিত`, `${genSubjectIds.length} subjects selected`)}
            </p>
          </div>

          {/* Question Count Selection */}
          <div className="space-y-2">
            <label className="font-bold text-slate-800 block text-xs">
              {t('প্রশ্নের সংখ্যা:', 'Number of Questions:')}
            </label>
            <div className="grid grid-cols-5 gap-2">
              {[10, 20, 25, 50, 100].map(cnt => (
                <button
                  key={cnt}
                  type="button"
                  onClick={() => setGenCount(cnt)}
                  className={`py-2 rounded-xl border text-center font-bold text-xs transition cursor-pointer ${
                    genCount === cnt 
                      ? 'bg-[#102A43] text-white border-[#102A43]' 
                      : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  {cnt} {t('টি', '')}
                </button>
              ))}
            </div>
          </div>

          {/* Duration Selection */}
          <div className="space-y-2">
            <label className="font-bold text-slate-800 block text-xs">
              {t('পরীক্ষার সময়সীমা:', 'Exam Duration:')}
            </label>
            <div className="grid grid-cols-4 gap-2">
              {[15, 30, 45, 60].map(mins => (
                <button
                  key={mins}
                  type="button"
                  onClick={() => setGenDuration(mins)}
                  className={`py-2 rounded-xl border text-center font-bold text-xs transition cursor-pointer flex items-center justify-center gap-1.5 ${
                    genDuration === mins 
                      ? 'bg-[#102A43] text-[#D4AF37] border-[#102A43]' 
                      : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <Clock className="w-3.5 h-3.5 text-[#D4AF37]" />
                  <span>{mins} {t('মিনিট', 'mins')}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Negative Marking */}
          <div className="space-y-2">
            <label className="font-bold text-slate-800 block text-xs">
              {t('নেগেটিভ মার্কিং পদ্ধতি:', 'Negative Marking Scheme:')}
            </label>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <button
                type="button"
                onClick={() => setGenNegativeMark(0.25)}
                className={`p-3 rounded-xl border text-left font-bold transition cursor-pointer flex items-center justify-between ${
                  genNegativeMark === 0.25 
                    ? 'bg-amber-50 border-[#D4AF37] text-[#102A43]' 
                    : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                <div>
                  <p className="font-bold text-xs">{t('অফিসিয়াল (-০.২৫)', 'Official Bar Council (-0.25)')}</p>
                  <p className="text-[11px] font-normal text-slate-500 mt-0.5">ভুল উত্তরের জন্য ০.২৫ নম্বর কাটা যাবে</p>
                </div>
                {genNegativeMark === 0.25 && <CheckCircle2 className="w-4 h-4 text-[#D4AF37]" />}
              </button>

              <button
                type="button"
                onClick={() => setGenNegativeMark(0)}
                className={`p-3 rounded-xl border text-left font-bold transition cursor-pointer flex items-center justify-between ${
                  genNegativeMark === 0 
                    ? 'bg-amber-50 border-[#D4AF37] text-[#102A43]' 
                    : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                <div>
                  <p className="font-bold text-xs">{t('নো নেগেটিভ (০.০০)', 'No Negative Marking (0.00)')}</p>
                  <p className="text-[11px] font-normal text-slate-500 mt-0.5">অনুশীলনের জন্য কোনো মার্ক কাটা যাবে না</p>
                </div>
                {genNegativeMark === 0 && <CheckCircle2 className="w-4 h-4 text-[#D4AF37]" />}
              </button>
            </div>
          </div>

          {/* Launch Action */}
          <button
            type="button"
            onClick={handleStartGeneratorTest}
            className="w-full py-3.5 rounded-xl bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] border border-[#D4AF37] font-black text-sm transition flex items-center justify-center gap-2 shadow-lg cursor-pointer"
          >
            <Play className="w-4 h-4 fill-current text-[#D4AF37]" />
            <span>{t('কাস্টম মডেল টেস্ট তৈরি করে এখনই শুরু করুন', 'Generate & Start Model Test Now')}</span>
          </button>
        </div>
      )}

      {/* TAB 3: MY CUSTOM TESTS */}
      {activeTab === 'my_tests' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-bold text-[#102A43]">
              {t('আমার তৈরিকৃত কাস্টম মডেল টেস্টসমূহ', 'My Custom Model Tests')}
            </h2>
            <button
              onClick={() => setActiveTab('generator')}
              className="px-4 py-2 rounded-xl bg-[#102A43] text-[#D4AF37] text-xs font-bold transition cursor-pointer flex items-center gap-1.5"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>{t('নতুন কাস্টম টেস্ট তৈরি করুন', 'Create New Test')}</span>
            </button>
          </div>

          {customExams.length === 0 ? (
            <div className="bg-white rounded-3xl border border-slate-200 p-12 text-center shadow-xs">
              <div className="w-16 h-16 rounded-2xl bg-slate-100 text-[#102A43] flex items-center justify-center mx-auto mb-4">
                <FileText className="w-8 h-8" />
              </div>
              <h3 className="text-lg font-bold text-[#102A43] mb-1">
                {t('এখনো কোনো কাস্টম মডেল টেস্ট তৈরি করা হয়নি', 'No Custom Tests Created Yet')}
              </h3>
              <p className="text-xs text-slate-500 max-w-md mx-auto mb-6">
                {t('প্রশ্ন সম্ভার থেকে প্রশ্ন বাছাই করে অথবা অটো জেনারেটর ব্যবহার করে যেকোনো সময় নিজস্ব মডেল টেস্ট তৈরি করতে পারেন।', 'Select questions from the repository or use the auto generator to take custom tests.')}
              </p>
              <button
                onClick={() => setActiveTab('browse')}
                className="px-6 py-2.5 rounded-xl bg-[#102A43] text-[#D4AF37] font-bold text-xs cursor-pointer shadow-xs"
              >
                {t('প্রশ্ন সম্ভার থেকে প্রশ্ন বাছুন', 'Browse Question Bank')}
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {customExams.map(ex => {
                const pastResult = examResults.find(r => r.examId === ex.id);

                return (
                  <div key={ex.id} className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs flex flex-col justify-between">
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <span className="px-2 py-0.5 rounded-md bg-amber-100 text-amber-900 text-[10px] font-bold">
                          CUSTOM TEST
                        </span>
                        <span className="text-xs font-mono font-bold text-slate-500 flex items-center gap-1">
                          <Clock className="w-3.5 h-3.5 text-[#D4AF37]" />
                          <span>{ex.durationMinutes} {t('মিনিট', 'mins')}</span>
                        </span>
                      </div>

                      <h3 className="font-bold text-slate-900 text-sm mb-1">
                        {language === 'bn' ? ex.titleBn : ex.titleEn}
                      </h3>
                      <p className="text-xs text-slate-500 line-clamp-2 mb-3">
                        {language === 'bn' ? ex.descriptionBn : ex.descriptionEn}
                      </p>

                      {pastResult && (
                        <div className="p-2.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs mb-3 flex items-center justify-between">
                          <span className="text-emerald-900 font-bold">স্কোর: {pastResult.finalScore} / {pastResult.totalQuestions} ({pastResult.percentage}%)</span>
                          <span className="text-slate-400 text-[10px]">{new Date(pastResult.submittedAt).toLocaleDateString()}</span>
                        </div>
                      )}
                    </div>

                    <div className="pt-3 border-t border-slate-100 flex items-center justify-between">
                      <span className="text-xs text-slate-500">
                        {ex.questionIds.length} {t('প্রশ্ন', 'MCQs')} • {ex.negativeMarkRatio > 0 ? `-${ex.negativeMarkRatio}` : t('নো নেগেটিভ', 'No Neg')}
                      </span>

                      <button
                        onClick={() => startExam(ex.id)}
                        className="px-4 py-2 rounded-xl bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] font-bold text-xs transition flex items-center gap-1.5 cursor-pointer"
                      >
                        <Play className="w-3 h-3 fill-current" />
                        <span>{pastResult ? t('পুনরায় দিন', 'Retake') : t('পরীক্ষা দিন', 'Start Exam')}</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Global Custom Test Configuration Modal */}
      <CustomTestModal
        isOpen={showCustomModal}
        onClose={() => setShowCustomModal(false)}
        preSelectedQuestionIds={modalPreSelectedIds}
      />

    </div>
  );
};
