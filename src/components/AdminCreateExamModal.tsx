import React, { useState, useMemo } from 'react';
import { useApp } from '../context/AppContext';
import { 
  X, 
  Sparkles, 
  Play, 
  Clock, 
  Layers, 
  Scale, 
  BookOpen, 
  CheckCircle2, 
  Sliders, 
  Search, 
  Calendar, 
  Lock, 
  Gift, 
  AlertCircle,
  HelpCircle,
  Check,
  ShieldCheck,
  Save
} from 'lucide-react';
import { Exam, QuestionDifficulty } from '../types';

interface AdminCreateExamModalProps {
  isOpen: boolean;
  onClose: () => void;
  preSelectedQuestionIds?: string[];
}

export const AdminCreateExamModal: React.FC<AdminCreateExamModalProps> = ({
  isOpen,
  onClose,
  preSelectedQuestionIds = []
}) => {
  const { 
    language, 
    t, 
    subjects, 
    questions, 
    exams, 
    addExam, 
    startExam, 
    setActiveScreen 
  } = useApp();

  // Mode: 'auto' (pick by subjects and quota) or 'manual' (pick specific questions from bank)
  const [selectionMode, setSelectionMode] = useState<'auto' | 'manual'>(
    preSelectedQuestionIds.length > 0 ? 'manual' : 'auto'
  );

  // Form State
  const defaultExamNumber = exams.filter(e => e.type === 'full_mock').length + 1;
  const [examTitleBn, setExamTitleBn] = useState<string>(`মডেল টেস্ট ${defaultExamNumber < 10 ? '০' + defaultExamNumber : defaultExamNumber}: সমন্বিত প্রস্তুতি পরীক্ষা`);
  const [examTitleEn, setExamTitleEn] = useState<string>(`Model Test ${defaultExamNumber}: Comprehensive Prep Exam`);
  
  // Selection criteria for Auto Mode
  const [selectedSubjectIds, setSelectedSubjectIds] = useState<string[]>(subjects.map(s => s.id));
  const [questionCount, setQuestionCount] = useState<number>(100);
  const [difficultyFilter, setDifficultyFilter] = useState<'all' | QuestionDifficulty>('all');
  
  // Selection for Manual Mode
  const [manualSelectedIds, setManualSelectedIds] = useState<Set<string>>(
    new Set(preSelectedQuestionIds)
  );
  const [manualSearch, setManualSearch] = useState<string>('');
  const [manualSubjectFilter, setManualSubjectFilter] = useState<string>('all');

  // Exam Settings
  const [durationMinutes, setDurationMinutes] = useState<number>(60);
  const [negativeMarkRatio, setNegativeMarkRatio] = useState<number>(0.25);
  const [isPaid, setIsPaid] = useState<boolean>(true);
  const [launchStatus, setLaunchStatus] = useState<'live_now' | 'scheduled'>('live_now');
  const [scheduledDate, setScheduledDate] = useState<string>(
    new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 16)
  );
  const [createdSuccessMsg, setCreatedSuccessMsg] = useState<string | null>(null);

  if (!isOpen) return null;

  // Toggle subject in auto mode
  const toggleSubject = (subId: string) => {
    setSelectedSubjectIds(prev => {
      if (prev.includes(subId)) {
        if (prev.length === 1) return prev; // Keep at least one
        return prev.filter(id => id !== subId);
      } else {
        return [...prev, subId];
      }
    });
  };

  const handleSelectAllSubjects = () => {
    if (selectedSubjectIds.length === subjects.length) {
      setSelectedSubjectIds([subjects[0].id]);
    } else {
      setSelectedSubjectIds(subjects.map(s => s.id));
    }
  };

  // Toggle manual question selection
  const toggleManualQuestion = (qId: string) => {
    setManualSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(qId)) {
        next.delete(qId);
      } else {
        next.add(qId);
      }
      return next;
    });
  };

  // Manual list filtered questions
  const manualFilteredQuestions = questions.filter(q => {
    if (manualSubjectFilter !== 'all' && q.subjectId !== manualSubjectFilter) {
      return false;
    }
    if (manualSearch.trim().length > 0) {
      const query = manualSearch.toLowerCase();
      const inBn = q.questionBn.toLowerCase().includes(query);
      const inEn = (q.questionEn || '').toLowerCase().includes(query);
      const inRef = (q.legalReference || '').toLowerCase().includes(query);
      if (!inBn && !inEn && !inRef) return false;
    }
    return true;
  });

  // Calculate chosen question IDs based on mode
  const resolveQuestionIds = (): string[] => {
    if (selectionMode === 'manual') {
      return Array.from(manualSelectedIds);
    }

    // Auto Mode: sample questions from selected subjects
    let candidatePool = questions.filter(q => {
      if (selectedSubjectIds.length > 0 && !selectedSubjectIds.includes(q.subjectId)) {
        return false;
      }
      if (difficultyFilter !== 'all' && q.difficulty !== difficultyFilter) {
        return false;
      }
      return true;
    });

    if (candidatePool.length === 0) candidatePool = questions;

    // Shuffle and pick
    const shuffled = [...candidatePool].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(questionCount, shuffled.length)).map(q => q.id);
  };

  const handleCreateExam = (andStartNow: boolean = false) => {
    const finalQuestionIds = resolveQuestionIds();

    if (finalQuestionIds.length === 0) {
      alert(t('অনুগ্রহ করে অন্তত ১টি প্রশ্ন নির্বাচন করুন বা সিলেবাসের বিষয় নির্বাচন করুন।', 'Please select at least 1 question.'));
      return;
    }

    const titleBn = examTitleBn.trim() || `মডেল টেস্ট: কাস্টম পরীক্ষা (${finalQuestionIds.length} টি প্রশ্ন)`;
    const titleEn = examTitleEn.trim() || `Model Test (${finalQuestionIds.length} MCQs)`;

    const newExam: Omit<Exam, 'id' | 'createdAt'> = {
      titleBn,
      titleEn,
      descriptionBn: `অ্যাডমিন কর্তৃক প্রশ্ন সম্ভার থেকে তৈরিকৃত অফিসিয়াল মডেল টেস্ট। প্রশ্ন সংখ্যা: ${finalQuestionIds.length}টি, সময়: ${durationMinutes} মিনিট। নেগেটিভ মার্কিং: ${negativeMarkRatio}।`,
      descriptionEn: `Curated model test conducted by Admin. Questions: ${finalQuestionIds.length}, Duration: ${durationMinutes} mins. Negative marking: ${negativeMarkRatio}.`,
      type: 'full_mock',
      durationMinutes,
      totalMarks: finalQuestionIds.length,
      passThresholdPercentage: 50,
      questionIds: finalQuestionIds,
      isPaid,
      isActive: launchStatus === 'live_now',
      published: true,
      scheduledDate: launchStatus === 'scheduled' ? new Date(scheduledDate).toISOString() : undefined,
      releaseExplanationsImmediately: true,
      negativeMarkRatio,
      positiveMarkRatio: 1.0
    };

    addExam(newExam);

    setCreatedSuccessMsg(
      t(
        `"${titleBn}" সফলভাবে তৈরি হয়েছে! পরীক্ষাটি ${launchStatus === 'live_now' ? 'লাইভ চালু রয়েছে' : 'শিডিউল করা হয়েছে'}।`,
        `"${titleEn}" has been successfully published!`
      )
    );

    setTimeout(() => {
      onClose();
      if (andStartNow) {
        // Find latest exam or start by id
        alert(t('পরীক্ষা স্ক্রিনে নিয়ে যাওয়া হচ্ছে...', 'Redirecting to exam room...'));
      }
    }, 1200);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-slate-950/70 backdrop-blur-xs animate-in fade-in overflow-y-auto">
      <div 
        className="bg-white rounded-3xl max-w-3xl w-full shadow-2xl border border-slate-200 overflow-hidden my-6 flex flex-col max-h-[92vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-5 sm:p-6 bg-[#102A43] text-white flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3.5">
            <div className="w-11 h-11 rounded-2xl bg-[#D4AF37]/20 border border-[#D4AF37]/40 flex items-center justify-center text-[#D4AF37] shrink-0">
              <Sparkles className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-[#D4AF37] text-[#102A43] uppercase tracking-wider">
                  ADMIN ONLY
                </span>
                <span className="text-xs text-[#D4AF37] font-bold">
                  {t('প্রশ্ন সম্ভার মডেল টেস্ট নির্মাতা', 'Question Bank Test Curater')}
                </span>
              </div>
              <h3 className="text-base sm:text-xl font-black tracking-tight text-white mt-0.5">
                {t('প্রশ্ন সম্ভার থেকে মডেল টেস্ট তৈরি ও পরীক্ষা আয়োজন', 'Create Model Test from Bank & Conduct Exam')}
              </h3>
            </div>
          </div>

          <button 
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable Form Body */}
        <div className="p-5 sm:p-6 overflow-y-auto space-y-6 flex-1 text-slate-800 text-xs sm:text-sm">
          
          {createdSuccessMsg && (
            <div className="p-4 rounded-2xl bg-emerald-50 border-2 border-emerald-500 text-emerald-900 font-bold flex items-center gap-2.5 animate-in fade-in">
              <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
              <span>{createdSuccessMsg}</span>
            </div>
          )}

          {/* Section 1: Exam Titles */}
          <div className="space-y-3 bg-slate-50 p-4 rounded-2xl border border-slate-200">
            <h4 className="font-bold text-[#102A43] flex items-center gap-2 text-sm">
              <BookOpen className="w-4 h-4 text-[#D4AF37]" />
              <span>{t('১. মডেল টেস্টের শিরোনাম ও বিবরণ', '1. Exam Title & Description')}</span>
            </h4>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-bold uppercase text-slate-500 mb-1">
                  {t('বাংলা শিরোনাম (Title Bn)', 'Bangla Title')}
                </label>
                <input
                  type="text"
                  value={examTitleBn}
                  onChange={(e) => setExamTitleBn(e.target.value)}
                  placeholder="যেমন: মডেল টেস্ট ৩১: স্পেশাল সমন্বিত পরীক্ষা"
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs focus:ring-2 focus:ring-[#102A43] bg-white font-semibold"
                />
              </div>

              <div>
                <label className="block text-[11px] font-bold uppercase text-slate-500 mb-1">
                  {t('ইংরেজি শিরোনাম (Title En)', 'English Title')}
                </label>
                <input
                  type="text"
                  value={examTitleEn}
                  onChange={(e) => setExamTitleEn(e.target.value)}
                  placeholder="e.g. Model Test 31: Special Combined Mock"
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-xs focus:ring-2 focus:ring-[#102A43] bg-white font-semibold"
                />
              </div>
            </div>
          </div>

          {/* Section 2: Question Selection Mode */}
          <div className="space-y-4 bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <h4 className="font-bold text-[#102A43] flex items-center gap-2 text-sm">
                <Sliders className="w-4 h-4 text-[#D4AF37]" />
                <span>{t('২. প্রশ্ন নির্বাচনের পদ্ধতি', '2. Question Selection Mode')}</span>
              </h4>

              <div className="inline-flex p-1 rounded-xl bg-slate-100 border border-slate-200 text-xs">
                <button
                  type="button"
                  onClick={() => setSelectionMode('auto')}
                  className={`px-3 py-1.5 rounded-lg font-bold transition cursor-pointer ${
                    selectionMode === 'auto'
                      ? 'bg-[#102A43] text-white shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {t('আইনভিত্তিক স্বয়ংক্রিয় মিশ্রণ', 'Auto Subject Mix')}
                </button>
                <button
                  type="button"
                  onClick={() => setSelectionMode('manual')}
                  className={`px-3 py-1.5 rounded-lg font-bold transition cursor-pointer flex items-center gap-1.5 ${
                    selectionMode === 'manual'
                      ? 'bg-[#102A43] text-white shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <span>{t('নির্দিষ্ট প্রশ্ন বাছাই', 'Pick Exact MCQs')}</span>
                  {manualSelectedIds.size > 0 && (
                    <span className="px-1.5 py-0.2 rounded-full bg-[#D4AF37] text-[#102A43] text-[10px] font-black">
                      {manualSelectedIds.size}
                    </span>
                  )}
                </button>
              </div>
            </div>

            {/* AUTO SELECTION MODE */}
            {selectionMode === 'auto' && (
              <div className="space-y-4 pt-2">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-[11px] font-bold uppercase text-slate-500">
                      {t('সিলেবাসের আইনসমূহ নির্বাচন করুন (অন্তত ১টি)', 'Select Legal Subjects')}
                    </label>
                    <button
                      type="button"
                      onClick={handleSelectAllSubjects}
                      className="text-xs text-[#102A43] font-bold hover:underline"
                    >
                      {selectedSubjectIds.length === subjects.length ? t('রিসেট', 'Reset') : t('সব আইন নির্বাচন করুন', 'Select All')}
                    </button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {subjects.map(s => {
                      const isSelected = selectedSubjectIds.includes(s.id);
                      const subQuestionCount = questions.filter(q => q.subjectId === s.id).length;
                      return (
                        <div
                          key={s.id}
                          onClick={() => toggleSubject(s.id)}
                          className={`p-3 rounded-xl border flex items-center justify-between cursor-pointer transition ${
                            isSelected 
                              ? 'bg-amber-50/50 border-[#D4AF37] shadow-xs' 
                              : 'bg-slate-50 border-slate-200 opacity-60 hover:opacity-100'
                          }`}
                        >
                          <div className="flex items-center gap-2.5">
                            <div className={`w-5 h-5 rounded flex items-center justify-center text-white ${
                              isSelected ? 'bg-[#102A43]' : 'bg-slate-300'
                            }`}>
                              {isSelected && <Check className="w-3.5 h-3.5" />}
                            </div>
                            <div>
                              <p className="font-bold text-slate-900 text-xs">{language === 'bn' ? s.nameBn : s.nameEn}</p>
                              <span className="text-[10px] font-mono text-slate-500">{s.code}</span>
                            </div>
                          </div>
                          <span className="text-[11px] font-mono font-bold text-slate-600 bg-white px-2 py-0.5 rounded border border-slate-200">
                            {subQuestionCount} {t('প্রশ্ন', 'Q')}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Question Quota Choice */}
                <div>
                  <label className="block text-[11px] font-bold uppercase text-slate-500 mb-1.5">
                    {t('প্রশ্নের সংখ্যা (Question Quota)', 'Question Quota')}
                  </label>
                  <div className="grid grid-cols-4 gap-2">
                    {[10, 25, 50, 100].map(cnt => (
                      <button
                        key={cnt}
                        type="button"
                        onClick={() => setQuestionCount(cnt)}
                        className={`py-2.5 rounded-xl font-black text-xs transition border cursor-pointer ${
                          questionCount === cnt
                            ? 'bg-[#102A43] text-[#D4AF37] border-[#102A43] shadow-xs'
                            : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                        }`}
                      >
                        {cnt} {t('টি MCQ', 'MCQs')}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* MANUAL SELECTION MODE */}
            {selectionMode === 'manual' && (
              <div className="space-y-3 pt-2">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 bg-slate-50 p-3 rounded-xl border border-slate-200">
                  <div className="flex items-center gap-2 flex-1">
                    <div className="relative flex-1">
                      <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-3" />
                      <input
                        type="text"
                        placeholder="প্রশ্ন বা ধারায় খুঁজুন..."
                        value={manualSearch}
                        onChange={(e) => setManualSearch(e.target.value)}
                        className="w-full pl-8 pr-3 py-1.5 rounded-lg border border-slate-300 text-xs bg-white"
                      />
                    </div>
                    <select
                      value={manualSubjectFilter}
                      onChange={(e) => setManualSubjectFilter(e.target.value)}
                      className="py-1.5 px-2 rounded-lg border border-slate-300 text-xs bg-white font-semibold"
                    >
                      <option value="all">সকল আইন</option>
                      {subjects.map(s => (
                        <option key={s.id} value={s.id}>{s.code}</option>
                      ))}
                    </select>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs font-bold text-[#102A43]">
                      বাছাইকৃত: <strong>{manualSelectedIds.size}</strong> টি
                    </span>
                    <button
                      type="button"
                      onClick={() => setManualSelectedIds(new Set())}
                      className="text-xs text-rose-600 hover:underline font-bold"
                    >
                      ক্লিয়ার
                    </button>
                  </div>
                </div>

                <div className="max-h-60 overflow-y-auto space-y-1.5 border border-slate-200 rounded-xl p-2 divide-y divide-slate-100">
                  {manualFilteredQuestions.slice(0, 50).map(q => {
                    const isChecked = manualSelectedIds.has(q.id);
                    const sub = subjects.find(s => s.id === q.subjectId);
                    return (
                      <div
                        key={q.id}
                        onClick={() => toggleManualQuestion(q.id)}
                        className={`p-2 rounded-lg flex items-start gap-2.5 cursor-pointer transition ${
                          isChecked ? 'bg-amber-50/80 border border-amber-300' : 'hover:bg-slate-50'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => {}}
                          className="mt-1 rounded text-[#102A43] focus:ring-[#102A43]"
                        />
                        <div className="space-y-0.5 flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-[10px] font-bold text-slate-700 bg-slate-100 px-1.5 py-0.2 rounded">
                              {sub?.code || 'LAW'}
                            </span>
                            {q.legalReference && (
                              <span className="text-[10px] text-amber-800 bg-amber-50 px-1.5 py-0.2 rounded">
                                {q.legalReference}
                              </span>
                            )}
                          </div>
                          <p className="text-xs font-semibold text-slate-900 truncate">
                            {q.questionBn}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                  {manualFilteredQuestions.length > 50 && (
                    <p className="text-center text-[11px] text-slate-400 py-2">
                      আরও {manualFilteredQuestions.length - 50}টি প্রশ্ন রয়েছে। সুনির্দিষ্ট করতে সার্চ ফিল্টার ব্যবহার করুন।
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Section 3: Time & Scoring Rules */}
          <div className="space-y-3 bg-slate-50 p-4 rounded-2xl border border-slate-200">
            <h4 className="font-bold text-[#102A43] flex items-center gap-2 text-sm">
              <Clock className="w-4 h-4 text-[#D4AF37]" />
              <span>{t('৩. পরীক্ষার সময়সীমা ও স্কোরিং বিধি', '3. Duration & Scoring Rules')}</span>
            </h4>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-bold uppercase text-slate-500 mb-1">
                  {t('পরীক্ষার সময়সীমা (মিনিট)', 'Duration (Minutes)')}
                </label>
                <div className="grid grid-cols-4 gap-1.5">
                  {[15, 30, 45, 60].map(mins => (
                    <button
                      key={mins}
                      type="button"
                      onClick={() => setDurationMinutes(mins)}
                      className={`py-2 rounded-xl text-xs font-black transition border cursor-pointer ${
                        durationMinutes === mins
                          ? 'bg-[#102A43] text-white border-[#102A43]'
                          : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
                      }`}
                    >
                      {mins} মি.
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-bold uppercase text-slate-500 mb-1">
                  {t('নেগেটিভ মার্কিং অনুপাত', 'Negative Mark Ratio')}
                </label>
                <div className="grid grid-cols-3 gap-1.5">
                  {[
                    { label: '১:০.২৫ (অফিসিয়াল)', val: 0.25 },
                    { label: '১:০.৫০', val: 0.50 },
                    { label: 'নেই (০.০০)', val: 0.00 }
                  ].map(neg => (
                    <button
                      key={neg.val}
                      type="button"
                      onClick={() => setNegativeMarkRatio(neg.val)}
                      className={`py-2 rounded-xl text-xs font-bold transition border cursor-pointer ${
                        negativeMarkRatio === neg.val
                          ? 'bg-[#102A43] text-white border-[#102A43]'
                          : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
                      }`}
                    >
                      {neg.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Section 4: Access Tier & Launch Schedule */}
          <div className="space-y-3 bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
            <h4 className="font-bold text-[#102A43] flex items-center gap-2 text-sm">
              <ShieldCheck className="w-4 h-4 text-[#D4AF37]" />
              <span>{t('৪. সাবস্ক্রিপশন এক্সেস ও পরীক্ষা শুরুর তারিখ', '4. Access Tier & Schedule')}</span>
            </h4>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Access Tier */}
              <div>
                <label className="block text-[11px] font-bold uppercase text-slate-500 mb-1">
                  {t('শিক্ষার্থীদের এক্সেস ক্যাটাগরি', 'Access Tier')}
                </label>
                <div className="space-y-2">
                  <div
                    onClick={() => setIsPaid(true)}
                    className={`p-3 rounded-xl border flex items-center justify-between cursor-pointer transition ${
                      isPaid 
                        ? 'bg-amber-50 border-[#D4AF37]' 
                        : 'bg-slate-50 border-slate-200'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <Lock className="w-4 h-4 text-[#102A43]" />
                      <div>
                        <p className="font-bold text-slate-900 text-xs">{t('পেইড মডেল টেস্ট (Pro Pass)', 'Paid Pro Test')}</p>
                        <p className="text-[10px] text-slate-500">{t('শুধুমাত্র প্রো সাবস্ক্রাইবাররা দিতে পারবে', 'Active subscribers only')}</p>
                      </div>
                    </div>
                    <input type="radio" checked={isPaid} onChange={() => {}} className="text-[#102A43]" />
                  </div>

                  <div
                    onClick={() => setIsPaid(false)}
                    className={`p-3 rounded-xl border flex items-center justify-between cursor-pointer transition ${
                      !isPaid 
                        ? 'bg-emerald-50 border-emerald-500' 
                        : 'bg-slate-50 border-slate-200'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <Gift className="w-4 h-4 text-emerald-700" />
                      <div>
                        <p className="font-bold text-slate-900 text-xs">{t('ফ্রি ডেমো টেস্ট (Free for All)', 'Free for All')}</p>
                        <p className="text-[10px] text-slate-500">{t('সকল সাধারণ শিক্ষার্থী ফ্রিতে দিতে পারবে', 'Open to all students')}</p>
                      </div>
                    </div>
                    <input type="radio" checked={!isPaid} onChange={() => {}} className="text-emerald-600" />
                  </div>
                </div>
              </div>

              {/* Launch Schedule */}
              <div>
                <label className="block text-[11px] font-bold uppercase text-slate-500 mb-1">
                  {t('পরীক্ষা চালু করার নিয়ম', 'Launch Policy')}
                </label>
                <div className="space-y-2">
                  <div
                    onClick={() => setLaunchStatus('live_now')}
                    className={`p-3 rounded-xl border flex items-center justify-between cursor-pointer transition ${
                      launchStatus === 'live_now' 
                        ? 'bg-emerald-50 border-emerald-500' 
                        : 'bg-slate-50 border-slate-200'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <Play className="w-4 h-4 text-emerald-700 fill-current" />
                      <div>
                        <p className="font-bold text-slate-900 text-xs">{t('তৎক্ষণাৎ লাইভ চালু করুন', 'Launch Immediately')}</p>
                        <p className="text-[10px] text-slate-500">{t('ড্যাশবোর্ডে সাথে সাথে পরীক্ষাটি দৃশ্যমান হবে', 'Available right away')}</p>
                      </div>
                    </div>
                    <input type="radio" checked={launchStatus === 'live_now'} onChange={() => {}} className="text-emerald-600" />
                  </div>

                  <div
                    onClick={() => setLaunchStatus('scheduled')}
                    className={`p-3 rounded-xl border space-y-2 cursor-pointer transition ${
                      launchStatus === 'scheduled' 
                        ? 'bg-amber-50 border-[#D4AF37]' 
                        : 'bg-slate-50 border-slate-200'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Calendar className="w-4 h-4 text-[#102A43]" />
                        <div>
                          <p className="font-bold text-slate-900 text-xs">{t('ভবিষ্যতের তারিখে শিডিউল করুন', 'Schedule for Future Date')}</p>
                          <p className="text-[10px] text-slate-500">{t('নির্ধারিত তারিখ অনুযায়ী পরীক্ষা অনুষ্ঠিত হবে', 'Held on scheduled date')}</p>
                        </div>
                      </div>
                      <input type="radio" checked={launchStatus === 'scheduled'} onChange={() => {}} className="text-[#102A43]" />
                    </div>

                    {launchStatus === 'scheduled' && (
                      <input
                        type="datetime-local"
                        value={scheduledDate}
                        onChange={(e) => setScheduledDate(e.target.value)}
                        className="w-full px-3 py-1.5 rounded-lg border border-slate-300 text-xs bg-white font-mono"
                      />
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>

        </div>

        {/* Footer Actions */}
        <div className="p-4 sm:p-5 bg-slate-50 border-t border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2.5 rounded-xl border border-slate-300 text-slate-700 hover:bg-slate-100 font-bold text-xs transition cursor-pointer text-center"
          >
            {t('বাতিল করুন', 'Cancel')}
          </button>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => handleCreateExam(false)}
              className="flex-1 sm:flex-none px-6 py-2.5 rounded-xl bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] border border-[#D4AF37] font-black text-xs sm:text-sm transition flex items-center justify-center gap-2 shadow-sm cursor-pointer"
            >
              <Save className="w-4 h-4 text-[#D4AF37]" />
              <span>{t('মডেল টেস্ট তৈরি ও পরীক্ষা চালু করুন', 'Publish & Host Exam')}</span>
            </button>
          </div>
        </div>

      </div>
    </div>
  );
};
