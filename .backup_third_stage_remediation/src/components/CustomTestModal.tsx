import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { auth, isVerifiedOwnerAccount } from '../lib/firebase';
import { 
  X, 
  Sparkles, 
  Play, 
  Clock, 
  HelpCircle, 
  Sliders, 
  BookOpen, 
  CheckCircle2, 
  Scale, 
  Layers,
  ArrowRight
} from 'lucide-react';
import { Question } from '../types';

interface CustomTestModalProps {
  isOpen: boolean;
  onClose: () => void;
  preSelectedQuestionIds?: string[];
}

export const CustomTestModal: React.FC<CustomTestModalProps> = ({
  isOpen,
  onClose,
  preSelectedQuestionIds = []
}) => {
  const { 
    language, 
    t, 
    currentUser,
    subjects, 
    questions, 
    createAndStartCustomExam, 
    setActiveScreen 
  } = useApp();

  const isAdmin = isVerifiedOwnerAccount(auth?.currentUser) && currentUser.role === 'admin';

  // Mode: 'auto_mix' (All 7 subjects), 'select_subjects' (Custom subjects), or 'pre_selected' (if user selected in bank)
  const [selectedSubjectIds, setSelectedSubjectIds] = useState<string[]>([]);
  const [questionCount, setQuestionCount] = useState<number>(preSelectedQuestionIds.length > 0 ? preSelectedQuestionIds.length : 25);
  const [durationMinutes, setDurationMinutes] = useState<number>(30);
  const [negativeMarkRatio, setNegativeMarkRatio] = useState<number>(0.25);
  const [testTitle, setTestTitle] = useState<string>('');
  const [difficultyFilter, setDifficultyFilter] = useState<'all' | 'easy' | 'medium' | 'hard'>('all');

  if (!isOpen || !isAdmin) return null;

  const hasPreSelected = preSelectedQuestionIds.length > 0;

  const toggleSubject = (subId: string) => {
    if (selectedSubjectIds.includes(subId)) {
      setSelectedSubjectIds(prev => prev.filter(id => id !== subId));
    } else {
      setSelectedSubjectIds(prev => [...prev, subId]);
    }
  };

  const handleSelectAllSubjects = () => {
    if (selectedSubjectIds.length === subjects.length) {
      setSelectedSubjectIds([]);
    } else {
      setSelectedSubjectIds(subjects.map(s => s.id));
    }
  };

  const handleStartExam = () => {
    let chosenIds: string[] = [];

    if (hasPreSelected) {
      chosenIds = [...preSelectedQuestionIds];
    } else {
      // Filter candidate questions by subject
      let candidates = questions.filter(q => {
        if (selectedSubjectIds.length > 0 && !selectedSubjectIds.includes(q.subjectId)) {
          return false;
        }
        if (difficultyFilter !== 'all' && q.difficulty !== difficultyFilter) {
          return false;
        }
        return true;
      });

      if (candidates.length === 0) {
        candidates = questions;
      }

      // Shuffle candidate questions randomly
      const shuffled = [...candidates].sort(() => Math.random() - 0.5);
      chosenIds = shuffled.slice(0, Math.min(questionCount, shuffled.length)).map(q => q.id);
    }

    if (chosenIds.length === 0) {
      alert(t('অনুগ্রহ করে অন্তত ১টি প্রশ্ন নির্বাচন করুন', 'Please select at least 1 question.'));
      return;
    }

    const titleBn = testTitle.trim() || `কাস্টম মডেল টেস্ট (${chosenIds.length} টি প্রশ্ন)`;
    const titleEn = testTitle.trim() || `Custom Model Test (${chosenIds.length} MCQs)`;

    const res = createAndStartCustomExam({
      titleBn,
      titleEn,
      durationMinutes,
      questionIds: chosenIds,
      negativeMarkRatio
    });

    if (res.success) {
      onClose();
    } else if (res.reason) {
      alert(res.reason);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/65 backdrop-blur-xs animate-in fade-in overflow-y-auto">
      <div 
        className="bg-white rounded-3xl max-w-xl w-full shadow-2xl border border-slate-200 overflow-hidden my-8"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-6 bg-gradient-to-r from-[#102A43] to-[#243B53] text-white flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-[#D4AF37]/20 border border-[#D4AF37]/40 flex items-center justify-center text-[#D4AF37]">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-lg font-black tracking-tight">
                {hasPreSelected 
                  ? t(`নির্বাচিত ${preSelectedQuestionIds.length}টি প্রশ্ন দিয়ে মডেল টেস্ট`, `Model Test with ${preSelectedQuestionIds.length} Selected Questions`)
                  : t('নিজস্ব কাস্টম মডেল টেস্ট তৈরি করুন', 'Create Custom Model Test')}
              </h3>
              <p className="text-xs text-slate-300">
                {t('প্রশ্ন সম্ভার থেকে আপনার সুবিধাজনক সময় ও প্রশ্ন সংখ্যা নির্ধারণ করুন', 'Configure test parameters from the Bar Council question bank')}
              </p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 space-y-6 max-h-[75vh] overflow-y-auto text-xs sm:text-sm">
          
          {/* Custom Test Name */}
          <div className="space-y-1.5">
            <label className="font-bold text-slate-800 block text-xs">
              {t('মডেল টেস্টের নাম / শিরোনাম (ঐচ্ছিক):', 'Model Test Title (Optional):')}
            </label>
            <input 
              type="text"
              value={testTitle}
              onChange={(e) => setTestTitle(e.target.value)}
              placeholder={hasPreSelected 
                ? `কাস্টম মডেল টেস্ট (${preSelectedQuestionIds.length} টি প্রশ্ন)` 
                : 'যেমন: দেওয়ানী ও ফৌজদারী কুইক টেস্ট - ১'}
              className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 focus:border-[#102A43] focus:ring-1 focus:ring-[#102A43] outline-none text-xs text-slate-900"
            />
          </div>

          {/* If NOT pre-selected, show Subject & Question filters */}
          {!hasPreSelected ? (
            <>
              {/* Subject Selection */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="font-bold text-slate-800 block text-xs">
                    {t('আইন বা বিষয় নির্বাচন করুন:', 'Select Subjects:')}
                  </label>
                  <button
                    type="button"
                    onClick={handleSelectAllSubjects}
                    className="text-[11px] font-bold text-[#102A43] hover:underline cursor-pointer"
                  >
                    {selectedSubjectIds.length === subjects.length 
                      ? t('সব বাদ দিন', 'Deselect All') 
                      : t('সকল ৭টি আইন নির্বাচন করুন', 'Select All 7 Codes')}
                  </button>
                </div>
                
                <div className="grid grid-cols-2 gap-2 max-h-36 overflow-y-auto p-1">
                  {subjects.map(s => {
                    const isSelected = selectedSubjectIds.includes(s.id);
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => toggleSubject(s.id)}
                        className={`p-2.5 rounded-xl border text-left transition flex items-center justify-between gap-2 cursor-pointer ${
                          isSelected 
                            ? 'bg-amber-50 border-[#D4AF37] text-[#102A43] font-bold' 
                            : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100'
                        }`}
                      >
                        <span className="text-xs truncate">{s.nameBn}</span>
                        {isSelected && <CheckCircle2 className="w-3.5 h-3.5 text-[#D4AF37] shrink-0" />}
                      </button>
                    );
                  })}
                </div>
                <p className="text-[11px] text-slate-400">
                  {selectedSubjectIds.length === 0 
                    ? t('কোনো বিষয় নির্বাচন না করলে ৭টি মূল আইন থেকেই সমহারে প্রশ্ন নেওয়া হবে।', 'If none selected, questions will be drawn from all 7 codes.')
                    : t(`${selectedSubjectIds.length} টি আইন নির্বাচিত`, `${selectedSubjectIds.length} subjects selected`)}
                </p>
              </div>

              {/* Question Count */}
              <div className="space-y-2">
                <label className="font-bold text-slate-800 block text-xs">
                  {t('প্রশ্ন সংখ্যা নির্বাচন করুন:', 'Number of Questions:')}
                </label>
                <div className="grid grid-cols-5 gap-2">
                  {[10, 20, 25, 50, 100].map(cnt => (
                    <button
                      key={cnt}
                      type="button"
                      onClick={() => setQuestionCount(cnt)}
                      className={`py-2 rounded-xl border text-center font-bold text-xs transition cursor-pointer ${
                        questionCount === cnt 
                          ? 'bg-[#102A43] text-white border-[#102A43]' 
                          : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      {cnt} {t('টি', '')}
                    </button>
                  ))}
                </div>
              </div>

              {/* Difficulty Level */}
              <div className="space-y-2">
                <label className="font-bold text-slate-800 block text-xs">
                  {t('কঠিনতার মাত্রা (Difficulty):', 'Difficulty Level:')}
                </label>
                <div className="grid grid-cols-4 gap-2 text-xs">
                  {[
                    { id: 'all', labelBn: 'মিশ্রিত (সকল)', labelEn: 'Mixed' },
                    { id: 'easy', labelBn: 'সহজ', labelEn: 'Easy' },
                    { id: 'medium', labelBn: 'মাঝারি', labelEn: 'Medium' },
                    { id: 'hard', labelBn: 'চ্যালেঞ্জিং', labelEn: 'Hard' }
                  ].map(diff => (
                    <button
                      key={diff.id}
                      type="button"
                      onClick={() => setDifficultyFilter(diff.id as any)}
                      className={`py-2 rounded-xl border text-center font-bold text-xs transition cursor-pointer ${
                        difficultyFilter === diff.id 
                          ? 'bg-amber-100 text-amber-900 border-[#D4AF37]' 
                          : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      {language === 'bn' ? diff.labelBn : diff.labelEn}
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div className="p-4 rounded-2xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 flex items-center justify-between">
              <div>
                <p className="font-bold">{t('প্রশ্ন সম্ভার থেকে সরাসরি নির্বাচিত', 'Directly Selected from Repository')}</p>
                <p className="text-[11px] text-emerald-700 mt-0.5">
                  {t(`আপনি প্রশ্ন সম্ভার থেকে ${preSelectedQuestionIds.length}টি প্রশ্ন বাছাই করেছেন।`, `You have chosen ${preSelectedQuestionIds.length} specific questions.`)}
                </p>
              </div>
              <span className="px-3 py-1 bg-emerald-600 text-white rounded-xl font-mono font-bold text-xs">
                {preSelectedQuestionIds.length} MCQs
              </span>
            </div>
          )}

          {/* Exam Duration */}
          <div className="space-y-2">
            <label className="font-bold text-slate-800 block text-xs">
              {t('পরীক্ষার সময়সীমা (মিনিট):', 'Exam Duration (Minutes):')}
            </label>
            <div className="grid grid-cols-4 gap-2">
              {[15, 30, 45, 60].map(mins => (
                <button
                  key={mins}
                  type="button"
                  onClick={() => setDurationMinutes(mins)}
                  className={`py-2 rounded-xl border text-center font-bold text-xs transition cursor-pointer flex items-center justify-center gap-1.5 ${
                    durationMinutes === mins 
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

          {/* Negative Marking Configuration */}
          <div className="space-y-2">
            <label className="font-bold text-slate-800 block text-xs">
              {t('নেগেটিভ মার্কিং পদ্ধতি:', 'Negative Marking Scheme:')}
            </label>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <button
                type="button"
                onClick={() => setNegativeMarkRatio(0.25)}
                className={`p-3 rounded-xl border text-left font-bold transition cursor-pointer flex items-center justify-between ${
                  negativeMarkRatio === 0.25 
                    ? 'bg-amber-50 border-[#D4AF37] text-[#102A43]' 
                    : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                <div>
                  <p className="font-bold text-xs">{t('অফিসিয়াল বার কাউন্সিল (-০.২৫)', 'Official Bar Council (-0.25)')}</p>
                  <p className="text-[11px] font-normal text-slate-500 mt-0.5">ভুল উত্তরের জন্য ০.২৫ নম্বর কাটা যাবে</p>
                </div>
                {negativeMarkRatio === 0.25 && <CheckCircle2 className="w-4 h-4 text-[#D4AF37]" />}
              </button>

              <button
                type="button"
                onClick={() => setNegativeMarkRatio(0)}
                className={`p-3 rounded-xl border text-left font-bold transition cursor-pointer flex items-center justify-between ${
                  negativeMarkRatio === 0 
                    ? 'bg-amber-50 border-[#D4AF37] text-[#102A43]' 
                    : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                <div>
                  <p className="font-bold text-xs">{t('নো নেগেটিভ মার্কিং (০.০০)', 'No Negative Marking (0.00)')}</p>
                  <p className="text-[11px] font-normal text-slate-500 mt-0.5">অনুশীলনের জন্য কোনো মার্ক কাটা যাবে না</p>
                </div>
                {negativeMarkRatio === 0 && <CheckCircle2 className="w-4 h-4 text-[#D4AF37]" />}
              </button>
            </div>
          </div>

          {/* Link to manual Question Bank if they want to cherry pick */}
          {!hasPreSelected && (
            <div className="p-3 rounded-2xl bg-slate-50 border border-slate-200 flex items-center justify-between">
              <div className="text-xs text-slate-600">
                <span className="font-bold text-[#102A43] block">{t('নির্দিষ্ট প্রশ্ন বাছাই করতে চান?', 'Want to choose individual questions?')}</span>
                <span>{t('প্রশ্ন সম্ভার থেকে টিকচিহ্ন দিয়ে নিজের মতো করে মডেল টেস্ট তৈরি করুন।', 'Browse the Question Bank and select questions manually.')}</span>
              </div>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  setActiveScreen('question_bank');
                }}
                className="px-3 py-1.5 rounded-lg bg-white border border-slate-300 text-[#102A43] font-bold text-xs hover:bg-slate-100 transition shrink-0 cursor-pointer flex items-center gap-1"
              >
                <span>{t('প্রশ্ন সম্ভার খুলুন', 'Open Bank')}</span>
                <ArrowRight className="w-3 h-3" />
              </button>
            </div>
          )}

        </div>

        {/* Footer Actions */}
        <div className="p-5 bg-slate-50 border-t border-slate-200 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2.5 rounded-xl border border-slate-300 text-slate-700 font-bold text-xs hover:bg-white transition cursor-pointer"
          >
            {t('বাতিল', 'Cancel')}
          </button>

          <button
            type="button"
            onClick={handleStartExam}
            className="px-6 py-2.5 rounded-xl bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] border border-[#D4AF37] font-black text-xs sm:text-sm transition flex items-center gap-2 shadow-md cursor-pointer"
          >
            <Play className="w-4 h-4 fill-current text-[#D4AF37]" />
            <span>{t('মডেল টেস্ট শুরু করুন', 'Start Model Test Now')}</span>
          </button>
        </div>

      </div>
    </div>
  );
};
