import React, { useState, useEffect, useMemo } from 'react';
import { useApp } from '../context/AppContext';
import { formatSecondsToTime } from '../utils/scoring';
import { 
  Clock, 
  Flag, 
  CheckCircle, 
  ChevronLeft, 
  ChevronRight, 
  AlertCircle, 
  Send, 
  Eraser, 
  AlertTriangle,
  Menu,
  X,
  HelpCircle,
  ShieldCheck,
  Check
} from 'lucide-react';
import { Question } from '../types';

import { getQuestionsForExam } from '../utils/modelTestGenerator';

export const ExamScreen: React.FC = () => {
  const { 
    language, 
    t, 
    activeAttempt, 
    currentExamForAttempt, 
    questions, 
    saveActiveAnswer, 
    clearActiveAnswer, 
    toggleFlagQuestion, 
    submitExamAttempt, 
    setActiveScreen,
    isSubmittingExam
  } = useApp();

  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [showSubmitModal, setShowSubmitModal] = useState<boolean>(false);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState<boolean>(false);
  const [warning5MinDismissed, setWarning5MinDismissed] = useState<boolean>(false);
  const [warning1MinDismissed, setWarning1MinDismissed] = useState<boolean>(false);

  // If no active attempt, redirect to dashboard
  useEffect(() => {
    if (!activeAttempt || activeAttempt.status !== 'in_progress') {
      setActiveScreen('dashboard');
    }
  }, [activeAttempt, setActiveScreen]);

  // Exam questions
  const examQuestions = useMemo(() => {
    if (!currentExamForAttempt) return [];
    return getQuestionsForExam(currentExamForAttempt, questions);
  }, [currentExamForAttempt, questions]);

  // Calculate server-authoritative remaining time using deadlineTime
  const [remainingSeconds, setRemainingSeconds] = useState<number>(() => {
    if (!activeAttempt) return 3600;
    const deadlineMs = new Date(activeAttempt.deadlineTime).getTime();
    const diff = Math.max(0, Math.floor((deadlineMs - Date.now()) / 1000));
    return diff;
  });

  // Countdown timer effect
  useEffect(() => {
    if (!activeAttempt || activeAttempt.status !== 'in_progress') return;

    const timer = setInterval(() => {
      const deadlineMs = new Date(activeAttempt.deadlineTime).getTime();
      const diff = Math.max(0, Math.floor((deadlineMs - Date.now()) / 1000));
      setRemainingSeconds(diff);

      // Auto-submit when time expires (Requirement 6 & Test E)
      if (diff <= 0) {
        clearInterval(timer);
        submitExamAttempt(true);
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [activeAttempt, submitExamAttempt]);

  if (!activeAttempt || !currentExamForAttempt || examQuestions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center p-6">
        <AlertCircle className="w-12 h-12 text-slate-400 mb-3 animate-spin" />
        <p className="text-slate-600 font-medium">{t('পরীক্ষা লোড হচ্ছে...', 'Loading examination environment...')}</p>
      </div>
    );
  }

  const currentQ = examQuestions[currentIndex] || examQuestions[0];
  const selectedOptionIndex = activeAttempt.answers[currentQ.id];
  const isFlagged = activeAttempt.flaggedQuestionIds.includes(currentQ.id);

  // Summary counts
  const answeredCount = Object.keys(activeAttempt.answers).length;
  const unansweredCount = examQuestions.length - answeredCount;
  const flaggedCount = activeAttempt.flaggedQuestionIds.length;

  const handleNext = () => {
    if (currentIndex < examQuestions.length - 1) {
      setCurrentIndex(prev => prev + 1);
    }
  };

  const handlePrev = () => {
    if (currentIndex > 0) {
      setCurrentIndex(prev => prev - 1);
    }
  };

  const handleSelectOption = (idx: number) => {
    saveActiveAnswer(currentQ.id, idx);
  };

  const handleClearAnswer = () => {
    clearActiveAnswer(currentQ.id);
  };

  const handleToggleFlag = () => {
    toggleFlagQuestion(currentQ.id);
  };

  const confirmSubmit = () => {
    setShowSubmitModal(false);
    submitExamAttempt(false);
  };

  // Warning thresholds
  const is5MinWarning = remainingSeconds <= 300 && remainingSeconds > 60 && !warning5MinDismissed;
  const is1MinWarning = remainingSeconds <= 60 && remainingSeconds > 0 && !warning1MinDismissed;
  const isCriticalTime = remainingSeconds <= 300;

  const optionPrefixesBn = ['ক', 'খ', 'গ', 'ঘ'];
  const optionPrefixesEn = ['A', 'B', 'C', 'D'];

  return (
    <div className="max-w-7xl mx-auto pb-12">
      
      {/* 5-minute Warning Banner */}
      {is5MinWarning && (
        <div className="mb-4 bg-amber-50 border border-amber-300 rounded-xl p-3.5 flex items-center justify-between text-amber-900 shadow-sm animate-bounce">
          <div className="flex items-center gap-2.5">
            <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
            <span className="text-xs sm:text-sm font-semibold">
              {t('সতর্কতা: পরীক্ষার সময় বাকি মাত্র ৫ মিনিট! দ্রুত উত্তরপত্র পর্যালোচনা করুন।', 'Warning: Only 5 minutes remaining! Review your answers.')}
            </span>
          </div>
          <button 
            onClick={() => setWarning5MinDismissed(true)} 
            className="text-xs bg-amber-200 hover:bg-amber-300 px-2 py-1 rounded text-amber-900 font-bold"
          >
            {t('ঠিক আছে', 'OK')}
          </button>
        </div>
      )}

      {/* 1-minute Warning Banner */}
      {is1MinWarning && (
        <div className="mb-4 bg-rose-600 border border-rose-700 text-white rounded-xl p-3.5 flex items-center justify-between shadow-md animate-pulse">
          <div className="flex items-center gap-2.5">
            <AlertCircle className="w-5 h-5 text-white shrink-0" />
            <span className="text-xs sm:text-sm font-bold">
              {t('জরুরি সতর্কতা: সময় শেষ হতে ১ মিনিটেরও কম বাকি! স্বয়ংক্রিয়ভাবে জমা হবে।', 'CRITICAL: Less than 1 minute remaining! Examination will auto-submit.')}
            </span>
          </div>
          <button 
            onClick={() => setWarning1MinDismissed(true)} 
            className="text-xs bg-white text-rose-700 px-2.5 py-1 rounded font-bold"
          >
            {t('বুঝেছি', 'Got it')}
          </button>
        </div>
      )}

      {/* Sticky Exam Control Header */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 mb-6 sticky top-20 z-30">
        <div className="flex items-center justify-between gap-4">
          
          {/* Title & Progress */}
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-bold px-2 py-0.5 rounded bg-[#102A43] text-[#D4AF37] uppercase">
                {currentExamForAttempt.type === 'full_mock' ? t('পূর্ণাঙ্গ ৬০ মিনিট মক', '60-Min Mock') : t('প্র্যাকটিস কুইজ', 'Practice Quiz')}
              </span>
              <span className="text-xs text-slate-600 font-semibold truncate hidden sm:inline">
                {language === 'bn' ? currentExamForAttempt.titleBn : currentExamForAttempt.titleEn}
              </span>
            </div>
            
            <div className="flex items-center gap-3 text-xs text-slate-600">
              <span>{t('প্রশ্ন:', 'Question:')} <strong className="text-[#102A43]">{currentIndex + 1}</strong> / {examQuestions.length}</span>
              <span className="hidden sm:inline">•</span>
              <span className="hidden sm:inline text-emerald-700">{t('উত্তর দেওয়া হয়েছে:', 'Answered:')} <strong>{answeredCount}</strong></span>
              <span className="hidden sm:inline text-amber-700">{t('পর্যালোচনায় চিহ্নিত:', 'Flagged:')} <strong>{flaggedCount}</strong></span>
            </div>
          </div>

          {/* Central Countdown Timer */}
          <div className="flex items-center gap-3">
            <div className={`flex items-center gap-2 px-4 py-2 rounded-xl font-bold font-mono-numbers text-base sm:text-lg border transition ${
              isCriticalTime 
                ? 'bg-rose-50 text-rose-700 border-rose-300 animate-pulse' 
                : 'bg-[#102A43] text-white border-[#243B53] shadow-inner'
            }`}>
              <Clock className={`w-4 h-4 ${isCriticalTime ? 'text-rose-600' : 'text-[#D4AF37]'}`} />
              <span>{formatSecondsToTime(remainingSeconds)}</span>
            </div>

            {/* Mobile Navigation Drawer Toggle */}
            <button
              onClick={() => setMobileDrawerOpen(true)}
              className="lg:hidden p-2.5 rounded-xl border border-slate-200 text-slate-700 hover:bg-slate-100"
              title="Question Palette"
            >
              <Menu className="w-5 h-5" />
            </button>

            {/* Submit Button */}
            <button
              onClick={() => setShowSubmitModal(true)}
              disabled={isSubmittingExam}
              className="px-4 py-2 rounded-xl bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] border border-[#D4AF37] font-bold text-xs sm:text-sm flex items-center gap-1.5 shadow-sm transition disabled:opacity-50 cursor-pointer"
            >
              <Send className="w-3.5 h-3.5" />
              <span>{t('জমা দিন (Submit)', 'Submit Exam')}</span>
            </button>
          </div>

        </div>
      </div>

      {/* Main Examination Layout: Question Card (Left) + Question Palette (Right) */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 items-start">
        
        {/* Question Area (3 Cols) */}
        <div className="lg:col-span-3 space-y-4">
          
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 sm:p-8">
            
            {/* Question Header Bar */}
            <div className="flex items-center justify-between border-b border-slate-100 pb-4 mb-6">
              <div className="flex items-center gap-2">
                <span className="w-8 h-8 rounded-lg bg-emerald-100 text-emerald-900 font-bold flex items-center justify-center text-sm">
                  {currentIndex + 1}
                </span>
                <span className="text-xs text-slate-500 font-semibold uppercase tracking-wider">
                  {currentQ.difficulty.toUpperCase()} • 1.0 {t('নম্বর', 'Mark')}
                </span>
                {currentQ.isDemoSample && (
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-900 border border-amber-200">
                    DEMO
                  </span>
                )}
              </div>

              {/* Action Buttons: Mark for Review & Clear */}
              <div className="flex items-center gap-2">
                <button
                  onClick={handleToggleFlag}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition border ${
                    isFlagged 
                      ? 'bg-amber-100 text-amber-900 border-amber-300' 
                      : 'text-slate-600 border-slate-200 hover:bg-slate-50'
                  }`}
                  title="Mark this question to review later"
                >
                  <Flag className={`w-3.5 h-3.5 ${isFlagged ? 'fill-amber-600 text-amber-600' : 'text-slate-400'}`} />
                  <span>{isFlagged ? t('চিহ্নিত (Flagged)', 'Flagged') : t('পর্যালোচনায় রাখুন', 'Mark for Review')}</span>
                </button>

                {selectedOptionIndex !== undefined && (
                  <button
                    onClick={handleClearAnswer}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-rose-600 hover:bg-rose-50 border border-rose-200 transition"
                    title="Clear selected option"
                  >
                    <Eraser className="w-3.5 h-3.5" />
                    <span>{t('মুছে ফেলুন', 'Clear')}</span>
                  </button>
                )}
              </div>
            </div>

            {/* Question Text */}
            <div className="mb-8">
              <h2 className="text-lg sm:text-xl font-bold text-slate-900 leading-relaxed">
                {language === 'bn' ? currentQ.questionBn : currentQ.questionEn}
              </h2>
              {/* Optional secondary language translation for absolute clarity */}
              <p className="text-xs text-slate-500 mt-2 font-serif italic border-l-2 border-slate-200 pl-3">
                {language === 'bn' ? currentQ.questionEn : currentQ.questionBn}
              </p>
            </div>

            {/* Options List */}
            <div className="space-y-3 mb-8">
              {(language === 'bn' ? currentQ.optionsBn : currentQ.optionsEn).map((optText, optIdx) => {
                const isSelected = selectedOptionIndex === optIdx;
                const prefix = language === 'bn' ? optionPrefixesBn[optIdx] : optionPrefixesEn[optIdx];

                return (
                  <button
                    key={optIdx}
                    onClick={() => handleSelectOption(optIdx)}
                    className={`w-full p-4 rounded-xl text-left border-2 transition-all flex items-start gap-4 group cursor-pointer ${
                      isSelected
                        ? 'border-[#102A43] bg-slate-50/90 shadow-sm ring-1 ring-[#D4AF37]'
                        : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50/60 bg-white'
                    }`}
                  >
                    <span className={`w-7 h-7 rounded-full flex items-center justify-center font-bold text-xs shrink-0 mt-0.5 transition ${
                      isSelected
                        ? 'bg-[#102A43] text-[#D4AF37]'
                        : 'bg-slate-100 text-slate-700 group-hover:bg-slate-200'
                    }`}>
                      {prefix}
                    </span>

                    <span className={`text-sm sm:text-base leading-relaxed ${
                      isSelected ? 'font-bold text-[#102A43]' : 'text-slate-800'
                    }`}>
                      {optText}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Bottom Nav Controls */}
            <div className="flex items-center justify-between border-t border-slate-100 pt-5">
              <button
                onClick={handlePrev}
                disabled={currentIndex === 0}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold border border-slate-200 text-slate-700 hover:bg-slate-50 transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              >
                <ChevronLeft className="w-4 h-4" />
                <span>{t('পূর্ববর্তী', 'Previous')}</span>
              </button>

              <span className="text-xs font-semibold text-slate-400">
                {currentIndex + 1} / {examQuestions.length}
              </span>

              {currentIndex < examQuestions.length - 1 ? (
                <button
                  onClick={handleNext}
                  className="flex items-center gap-1.5 px-5 py-2 rounded-xl text-sm font-bold bg-[#102A43] text-white hover:bg-[#243B53] transition cursor-pointer"
                >
                  <span>{t('পরবর্তী', 'Next')}</span>
                  <ChevronRight className="w-4 h-4" />
                </button>
              ) : (
                <button
                  onClick={() => setShowSubmitModal(true)}
                  className="flex items-center gap-1.5 px-5 py-2 rounded-xl text-sm font-bold bg-[#102A43] text-[#D4AF37] border border-[#D4AF37] hover:bg-[#243B53] transition shadow-sm cursor-pointer"
                >
                  <span>{t('ফলাফল জমা দিন', 'Submit Exam')}</span>
                  <Send className="w-4 h-4" />
                </button>
              )}
            </div>

          </div>

          {/* Anti-Cheating & Exam Integrity Notice */}
          <div className="rounded-xl bg-slate-50 border border-slate-200 p-4 text-xs text-slate-500 flex items-start gap-3">
            <ShieldCheck className="w-4 h-4 text-[#D4AF37] shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold text-slate-700 block mb-0.5">
                {t('পরীক্ষার নিয়ম ও সার্ভার অখণ্ডতা (Exam Rules & Timing Authority)', 'Exam Rules & Timing Authority')}
              </span>
              <span>
                {t(
                  'সার্ভার নিয়ন্ত্রিত সময়সীমা অপরিবর্তনীয়। ব্রাউজার রিফ্রেশ করলেও মূল শেষ সময় বজায় থাকবে এবং উত্তর স্বয়ংক্রিয়ভাবে প্রতি ৫ সেকেন্ড পর সংরক্ষিত হচ্ছে।',
                  'Server-authoritative timer cannot be extended by reloading. Answers are autosaved periodically and preserved upon connection restore.'
                )}
              </span>
            </div>
          </div>

        </div>

        {/* Right Palette (Question Navigation Grid - Desktop) */}
        <div className="hidden lg:block lg:col-span-1">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 sticky top-40">
            <h3 className="font-bold text-[#102A43] text-sm mb-3">
              {t('প্রশ্ন সূচি ও অবস্থা', 'Question Palette')}
            </h3>

            {/* Legend */}
            <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-600 mb-4 pb-3 border-b border-slate-100">
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-sm bg-[#102A43]"></span>
                <span>{t('উত্তর সম্পন্ন', 'Answered')}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-sm bg-slate-100 border border-slate-300"></span>
                <span>{t('অনুত্তর', 'Unanswered')}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-sm bg-[#D4AF37]"></span>
                <span>{t('পর্যালোচনা', 'Review')}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-sm ring-2 ring-[#102A43] bg-white"></span>
                <span>{t('বর্তমান', 'Current')}</span>
              </div>
            </div>

            {/* Numbers Grid */}
            <div className="grid grid-cols-5 gap-2 max-h-[380px] overflow-y-auto pr-1">
              {examQuestions.map((q, idx) => {
                const isAns = activeAttempt.answers[q.id] !== undefined;
                const isFlg = activeAttempt.flaggedQuestionIds.includes(q.id);
                const isCurr = idx === currentIndex;

                return (
                  <button
                    key={q.id}
                    onClick={() => setCurrentIndex(idx)}
                    className={`h-9 rounded-lg font-bold text-xs font-mono-numbers transition flex items-center justify-center relative cursor-pointer ${
                      isCurr ? 'ring-2 ring-[#D4AF37] ring-offset-1 font-extrabold' : ''
                    } ${
                      isFlg
                        ? 'bg-amber-100 text-amber-900 border border-[#D4AF37]'
                        : isAns
                        ? 'bg-[#102A43] text-white'
                        : 'bg-slate-100 text-slate-700 hover:bg-slate-200 border border-slate-200'
                    }`}
                  >
                    {idx + 1}
                    {isFlg && (
                      <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-[#D4AF37]"></span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Submit Action in Sidebar */}
            <div className="mt-5 pt-4 border-t border-slate-100">
              <button
                onClick={() => setShowSubmitModal(true)}
                className="w-full py-2.5 rounded-xl bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] border border-[#D4AF37] font-bold text-xs flex items-center justify-center gap-2 transition cursor-pointer"
              >
                <Send className="w-3.5 h-3.5" />
                <span>{t('চূড়ান্ত জমা দিন', 'Final Submit')}</span>
              </button>
            </div>

          </div>
        </div>

      </div>

      {/* Mobile Question Palette Drawer */}
      {mobileDrawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs" onClick={() => setMobileDrawerOpen(false)} />
          <div className="relative ml-auto w-80 max-w-full bg-white h-full shadow-2xl p-5 flex flex-col z-10">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <h3 className="font-bold text-slate-900">{t('প্রশ্ন সূচি', 'Question Palette')}</h3>
              <button onClick={() => setMobileDrawerOpen(false)} className="p-1 rounded-lg text-slate-400 hover:text-slate-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="py-4 grid grid-cols-5 gap-2 overflow-y-auto flex-1">
              {examQuestions.map((q, idx) => {
                const isAns = activeAttempt.answers[q.id] !== undefined;
                const isFlg = activeAttempt.flaggedQuestionIds.includes(q.id);
                const isCurr = idx === currentIndex;

                return (
                  <button
                    key={q.id}
                    onClick={() => {
                      setCurrentIndex(idx);
                      setMobileDrawerOpen(false);
                    }}
                    className={`h-10 rounded-lg font-bold text-xs font-mono-numbers flex items-center justify-center ${
                      isCurr ? 'ring-2 ring-emerald-600 ring-offset-1' : ''
                    } ${
                      isFlg
                        ? 'bg-amber-100 text-amber-900 border border-amber-300'
                        : isAns
                        ? 'bg-emerald-600 text-white'
                        : 'bg-slate-100 text-slate-700'
                    }`}
                  >
                    {idx + 1}
                  </button>
                );
              })}
            </div>

            <div className="pt-3 border-t border-slate-100">
              <button
                onClick={() => {
                  setMobileDrawerOpen(false);
                  setShowSubmitModal(true);
                }}
                className="w-full py-2.5 rounded-xl bg-emerald-600 text-white font-bold text-sm"
              >
                {t('পরীক্ষা জমা দিন', 'Submit Exam')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Manual Submission Confirmation Modal (Requirement 6) */}
      {showSubmitModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-100 animate-in fade-in zoom-in-95 duration-150">
            
            <div className="w-12 h-12 rounded-xl bg-emerald-100 text-emerald-800 flex items-center justify-center mb-4">
              <Send className="w-6 h-6" />
            </div>

            <h3 className="text-xl font-bold text-slate-900 mb-2">
              {t('পরীক্ষা কি নিশ্চিতভাবে জমা দিতে চান?', 'Confirm Exam Submission')}
            </h3>

            <p className="text-xs sm:text-sm text-slate-600 mb-6 leading-relaxed">
              {t(
                'জমা দেওয়ার পর আর উত্তর পরিবর্তন করা সম্ভব হবে না। আপনার ফলাফল তাৎক্ষণিকভাবে নেগেটিভ মার্কিংসহ স্বয়ংক্রিয়ভাবে হিসাব করা হবে।',
                'Once submitted, answers cannot be modified. Your score will be calculated immediately according to official marking rules.'
              )}
            </p>

            {/* Submission Status Summary */}
            <div className="bg-slate-50 rounded-xl p-4 border border-slate-200 mb-6 space-y-2 text-xs sm:text-sm">
              <div className="flex items-center justify-between">
                <span className="text-slate-500">{t('মোট প্রশ্ন:', 'Total Questions:')}</span>
                <strong className="text-slate-900">{examQuestions.length}</strong>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500">{t('উত্তর দেওয়া সম্পন্ন:', 'Answered:')}</span>
                <strong className="text-emerald-700 font-bold">{answeredCount}</strong>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500">{t('অনুত্তর অবশিষ্ট:', 'Unanswered:')}</span>
                <strong className="text-rose-600 font-bold">{unansweredCount}</strong>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500">{t('পর্যালোচনায় চিহ্নিত:', 'Marked for Review:')}</span>
                <strong className="text-amber-600 font-bold">{flaggedCount}</strong>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={() => setShowSubmitModal(false)}
                className="w-1/2 py-2.5 rounded-xl border border-slate-200 text-slate-700 font-bold text-xs sm:text-sm hover:bg-slate-50 transition"
              >
                {t('ফিরে যান (Cancel)', 'Return to Exam')}
              </button>
              <button
                onClick={confirmSubmit}
                className="w-1/2 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs sm:text-sm transition shadow-sm"
              >
                {t('হ্যাঁ, জমা দিন', 'Yes, Finalize')}
              </button>
            </div>

          </div>
        </div>
      )}

    </div>
  );
};
