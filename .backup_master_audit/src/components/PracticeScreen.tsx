import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { 
  BookOpen, 
  CheckCircle2, 
  XCircle, 
  ArrowLeft, 
  ChevronRight, 
  ChevronLeft, 
  HelpCircle,
  Lightbulb,
  Check,
  X,
  RotateCcw,
  Lock,
  Crown,
  Sparkles,
  AlertTriangle
} from 'lucide-react';
import { Question } from '../types';

export const PracticeScreen: React.FC = () => {
  const { 
    language, 
    t, 
    selectedSubjectForPractice, 
    questions, 
    subjects, 
    setActiveScreen, 
    startSubjectPractice,
    answeredQuestions,
    recordQuestionAnswer,
    getSubjectProgress,
    activeSubscription,
    calculateDaysRemaining,
    currentUser,
    openSubscriptionModal,
    isProSubscribed
  } = useApp();

  const daysRemaining = activeSubscription ? calculateDaysRemaining(activeSubscription.expiresAt) : 0;
  const isSubscriptionActive = isProSubscribed || (!!activeSubscription && daysRemaining > 0);

  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [selectedAnswers, setSelectedAnswers] = useState<Record<string, number>>({});
  const [showExplanation, setShowExplanation] = useState<Record<string, boolean>>({});

  // Filter practice questions for selected subject
  const practiceQuestions = questions.filter(
    q => !selectedSubjectForPractice || q.subjectId === selectedSubjectForPractice.id
  );

  const currentQ = practiceQuestions[currentIndex] || practiceQuestions[0];
  const previousRecord = currentQ ? answeredQuestions[currentQ.id] : undefined;
  const answeredIdx = currentQ ? (selectedAnswers[currentQ.id] ?? previousRecord?.selectedOption) : undefined;
  const isAnswered = answeredIdx !== undefined;

  const currentSubject = selectedSubjectForPractice || (currentQ ? subjects.find(s => s.id === currentQ.subjectId) || null : null);
  const currentSubjectProgress = currentSubject ? getSubjectProgress(currentSubject.id) : null;

  const handleSelectOption = (idx: number) => {
    if (!currentQ || isAnswered) return;
    const isCorrect = idx === currentQ.correctOptionIndex;
    recordQuestionAnswer(currentQ.id, currentQ.subjectId, idx, isCorrect);
    setSelectedAnswers(prev => ({
      ...prev,
      [currentQ.id]: idx
    }));
    setShowExplanation(prev => ({
      ...prev,
      [currentQ.id]: true
    }));
  };

  const handleNext = () => {
    if (currentIndex < practiceQuestions.length - 1) {
      setCurrentIndex(prev => prev + 1);
    }
  };

  const handlePrev = () => {
    if (currentIndex > 0) {
      setCurrentIndex(prev => prev - 1);
    }
  };

  const optionPrefixesBn = ['ক', 'খ', 'গ', 'ঘ'];
  const optionPrefixesEn = ['A', 'B', 'C', 'D'];

  // Gate: Paid subscription requirement for Subject Practice
  if (!isSubscriptionActive && currentUser.role !== 'admin') {
    return (
      <div className="max-w-2xl mx-auto py-12 px-4">
        <div className="bg-white rounded-3xl p-8 border-2 border-[#D4AF37] shadow-lg text-center space-y-6">
          <div className="w-16 h-16 rounded-2xl bg-[#102A43] text-[#D4AF37] flex items-center justify-center mx-auto shadow-md">
            <Lock className="w-8 h-8 text-[#D4AF37]" />
          </div>
          
          <div className="space-y-2">
            <span className="px-3 py-1 rounded-full text-xs font-black bg-[#102A43] text-[#D4AF37] uppercase">
              PRO ACCESS REQUIRED
            </span>
            <h2 className="text-2xl font-black text-[#102A43]">
              {t('৭টি মূল আইনের বিষয়ভিত্তিক অনুশীলন পেইড সাবস্ক্রিপশন ফিচার', 'Subject-wise Practice Requires Pro Subscription')}
            </h2>
            <p className="text-xs sm:text-sm text-slate-600 max-w-lg mx-auto">
              {t(
                'সিলেবাস কাঠামো: ৭টি মূল আইনের বিষয়ভিত্তিক অনুশীলন। অফিসিয়াল নম্বর বিন্যাস অনুযায়ী প্রতিটি কোড অধ্যয়ন করুন। এটাও পেইড করার পর অনুশীলন করতে পারবে।',
                'Syllabus Framework: 7 Core Statutory Subjects Practice. Study each code according to the official marks distribution. Unlocked for practice after activating a paid subscription.'
              )}
            </p>
          </div>

          <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200 text-xs text-slate-700 max-w-md mx-auto space-y-2 text-left">
            <div className="font-bold text-[#102A43] flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-[#D4AF37]" />
              <span>{t('পেইড সাবস্ক্রিপশনে যা যা অন্তর্ভুক্ত:', 'Included with Pro Subscription:')}</span>
            </div>
            <ul className="space-y-1 text-slate-600 pl-4 list-disc">
              <li>{t('৭টি মূল আইনের প্রতিটি অধ্যায় ও ধারা অনুযায়ী অনুশীলন', 'Chapter and section-by-section practice of all 7 legal subjects')}</li>
              <li>{t('আইনি রেফারেন্স ও বিস্তারিত ব্যাখ্যা সম্বলিত সমাধান', 'Detailed legal references & explanations')}</li>
              <li>{t('৩০টি পূর্ণাঙ্গ ৬০ মিনিটের লাইভ মডেল টেস্ট ও মেধা তালিকা', '30 Full 60-Minute Live Model Tests and Merit Leaderboard')}</li>
            </ul>
          </div>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
            <button
              onClick={() => openSubscriptionModal()}
              className="w-full sm:w-auto px-6 py-3 rounded-xl bg-[#D4AF37] hover:bg-[#b89528] text-[#102A43] font-black text-sm shadow-md transition flex items-center justify-center gap-2 cursor-pointer"
            >
              <Sparkles className="w-4 h-4 text-[#102A43]" />
              <span>{t('পেইড সাবস্ক্রিপশন প্যাকেজ দেখুন', 'View Subscription Plans')}</span>
            </button>
            <button
              onClick={() => setActiveScreen('subjects')}
              className="w-full sm:w-auto px-5 py-3 rounded-xl border border-slate-200 text-slate-700 font-bold text-sm hover:bg-slate-50 transition cursor-pointer"
            >
              {t('সিলেবাসে ফিরে যান', 'Back to Subjects')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!currentQ) {
    return (
      <div className="text-center py-20">
        <p className="text-slate-600 mb-4">{t('এই বিষয়ে এখনো কোনো প্রশ্ন পাওয়া যায়নি।', 'No questions available for this subject.')}</p>
        <button
          onClick={() => setActiveScreen('dashboard')}
          className="px-4 py-2 bg-emerald-600 text-white rounded-xl font-bold cursor-pointer"
        >
          {t('ফিরে যান', 'Return')}
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-16">
      
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <button
            onClick={() => setActiveScreen('dashboard')}
            className="inline-flex items-center gap-1.5 text-xs sm:text-sm font-semibold text-slate-600 hover:text-emerald-700 transition mb-2"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>{t('ড্যাশবোর্ডে ফিরে যান', 'Back to Dashboard')}</span>
          </button>

          <div className="flex items-center gap-2">
            <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-100 text-amber-900 border border-amber-200">
              {t('সময়হীন অনুশীলন মোড (Untimed Practice)', 'Untimed Practice Mode')}
            </span>
            <span className="text-xs text-slate-500 font-medium">
              {t('তাৎক্ষণিক উত্তর ও ব্যাখ্যা যাচাই', 'Instant Answer & Explanation')}
            </span>
          </div>

          <h1 className="text-xl sm:text-2xl font-extrabold text-slate-900 mt-1">
            {selectedSubjectForPractice 
              ? (language === 'bn' ? selectedSubjectForPractice.nameBn : selectedSubjectForPractice.nameEn)
              : t('সার্বিক অনুশীলন', 'General Practice')}
          </h1>
        </div>

        {/* Subject Filter Dropdown */}
        <div className="flex items-center gap-2">
          <select
            value={selectedSubjectForPractice?.id || ''}
            onChange={(e) => startSubjectPractice(e.target.value)}
            className="text-xs sm:text-sm rounded-xl border border-slate-300 bg-white px-3 py-2 text-slate-800 font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500"
          >
            {subjects.map(s => (
              <option key={s.id} value={s.id}>
                {language === 'bn' ? s.nameBn : s.nameEn} ({s.code})
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Subject Practice Completion Progress Bar */}
      {currentSubjectProgress && (
        <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-[#102A43]">
                {t('বিষয়ভিত্তিক সমাপ্তি অগ্রগতি:', 'Subject Completion Status:')}
              </span>
              <span className="text-xs font-extrabold text-emerald-700 bg-emerald-50 px-2.5 py-0.5 rounded-full border border-emerald-200">
                {currentSubjectProgress.percentage}% {t('সম্পন্ন', 'Done')}
              </span>
            </div>
            <div className="flex items-center gap-3 text-xs text-slate-500 font-medium">
              <span>
                <strong className="text-slate-800">{currentSubjectProgress.answeredCount}</strong> / {currentSubjectProgress.totalQuestions} {t('টি প্রশ্ন', 'Questions')}
              </span>
              {currentSubjectProgress.answeredCount > 0 && (
                <span className="text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded font-bold">
                  {t('নির্ভুলতা:', 'Accuracy:')} {currentSubjectProgress.accuracy}%
                </span>
              )}
            </div>
          </div>
          <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
            <div 
              className="h-full bg-gradient-to-r from-emerald-500 to-teal-600 rounded-full transition-all duration-500"
              style={{ width: `${currentSubjectProgress.percentage}%` }}
            />
          </div>
        </div>
      )}

      {/* Free Demo Preview Notice for Unsubscribed / Expired Users */}
      {!isSubscriptionActive && (
        <div className="p-3.5 rounded-2xl bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200 text-amber-900 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-xs">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-[#102A43] text-[#D4AF37] flex items-center justify-center shrink-0">
              <Crown className="w-4 h-4" />
            </div>
            <div>
              <span className="font-bold text-xs sm:text-sm block text-[#102A43]">
                {currentUser.subscriptionStatus === 'expired'
                  ? t('সাবস্ক্রিপশনের মেয়াদ শেষ হয়েছে (Expired)', 'Subscription Expired')
                  : t('ফ্রি প্রিভিউ মোড (১০টি ডেমো প্রশ্ন)', 'Free Preview Mode (10 Demo Questions)')}
              </span>
              <span className="text-[11px] text-amber-900">
                {currentUser.subscriptionStatus === 'expired'
                  ? t('পেইড MCQ ও লাইভ মডেল টেস্ট পুনরায় চালু করতে অনুগ্রহ করে সাবস্ক্রিপশন রিনিউ করুন।', 'Please renew your subscription to access all 3,000+ MCQs and model tests.')
                  : t('আপনি এই বিষয়ের ১০টি ফ্রি ডেমো প্রশ্ন অনুশীলন করতে পারবেন। সম্পূর্ণ ৩,০০০+ পেইড MCQ আনলক করতে সাবস্ক্রাইব করুন।', 'You can practice 10 sample questions. Subscribe to unlock all 3,000+ statutory questions.')}
              </span>
            </div>
          </div>
          <button
            onClick={() => openSubscriptionModal()}
            className="px-4 py-2 rounded-xl bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] border border-[#D4AF37] text-xs font-bold transition flex items-center justify-center gap-1.5 shrink-0 cursor-pointer shadow-xs"
          >
            <Crown className="w-3.5 h-3.5 text-[#D4AF37]" />
            <span>{currentUser.subscriptionStatus === 'expired' ? t('পুনরায় রিনিউ করুন', 'Renew Now') : t('প্রো আনলক করুন', 'Unlock Pro')}</span>
          </button>
        </div>
      )}

      {/* Question Card OR Premium Subscription Lock Screen */}
      {(!isSubscriptionActive && currentIndex >= 10) ? (
        <div className="bg-white rounded-3xl border-2 border-amber-300 shadow-md p-8 sm:p-12 text-center max-w-2xl mx-auto space-y-5 animate-in fade-in">
          <div className="w-16 h-16 rounded-3xl bg-amber-50 border-2 border-amber-300 text-amber-600 flex items-center justify-center mx-auto">
            <Lock className="w-8 h-8" />
          </div>

          <div className="space-y-2">
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#102A43] text-[#D4AF37] text-xs font-bold border border-[#D4AF37]/30">
              <Crown className="w-3.5 h-3.5 text-[#D4AF37]" />
              <span>{t('প্রিমিয়াম পেইড প্রশ্নাবলী', 'Premium Statutory Question')}</span>
            </div>
            <h2 className="text-xl sm:text-2xl font-black text-[#102A43]">
              {currentUser.subscriptionStatus === 'expired'
                ? t('সাবস্ক্রিপশনের মেয়াদ শেষ হয়েছে', 'Your Subscription Has Expired')
                : t('এই পেইড প্রশ্ন ও বিস্তারিত ব্যাখ্যা দেখতে সাবস্ক্রিপশন প্রয়োজন', 'Subscribe to Access This Paid Question & Analysis')}
            </h2>
            <p className="text-xs sm:text-sm text-slate-600 max-w-md mx-auto leading-relaxed">
              {currentUser.subscriptionStatus === 'expired'
                ? t(
                    'আপনার পূর্ববর্তী সাবস্ক্রিপশনের মেয়াদ উত্তীর্ণ হয়েছে। ৩,০০০+ পেইড MCQ ও ৬০ মিনিটের লাইভ মডেল টেস্ট পুনরায় আনলক করতে বিকাশ বা নগদে ফি পরিশোধ করে সাবস্ক্রিপশন রিনিউ করুন।',
                    'Your previous pass has expired. Please renew your subscription to access all statutory questions and live mock tests.'
                  )
                : t(
                    `আপনি ১০টি ফ্রি ডেমো প্রশ্ন সম্পন্ন করেছেন। এই বিষয়ের বাকি ${practiceQuestions.length - 10}টি পেইড প্রশ্ন, বিস্তারিত আইনি ব্যাখ্যা ও গেজেট রেফারেন্স আনলক করতে মাসিক সাবস্ক্রিপশন বা এককালীন প্যাকেজ বেছে নিন।`,
                    `You have completed 10 free demo questions. Select a monthly or one-time pass to unlock all remaining questions and statutory references.`
                  )}
            </p>
          </div>

          {/* Quick Pricing Preview Pill */}
          <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200 text-xs text-slate-700 flex flex-wrap items-center justify-around gap-2 max-w-md mx-auto">
            <div>
              <span className="text-slate-400 block text-[10px] uppercase font-bold">{t('মাসিক সাবস্ক্রিপশন', 'Monthly')}</span>
              <strong className="text-[#102A43] text-sm">৳১৫০ / ৩০ দিন</strong>
            </div>
            <div className="h-6 w-px bg-slate-200" />
            <div>
              <span className="text-slate-400 block text-[10px] uppercase font-bold">{t('প্রো মডেল টেস্ট পাস', 'Pro Pass')}</span>
              <strong className="text-[#102A43] text-sm">৳৩০০ / ৯০ দিন</strong>
            </div>
            <div className="h-6 w-px bg-slate-200" />
            <div>
              <span className="text-slate-400 block text-[10px] uppercase font-bold">{t('এক্সাম পাস', 'Exam Pass')}</span>
              <strong className="text-[#102A43] text-sm">৳৬৫০ / পরীক্ষার দিন</strong>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
            <button
              onClick={() => openSubscriptionModal()}
              className="w-full sm:w-auto px-6 py-3 rounded-2xl bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] border border-[#D4AF37] font-bold text-xs sm:text-sm transition flex items-center justify-center gap-2 cursor-pointer shadow-md"
            >
              <Crown className="w-4 h-4 text-[#D4AF37]" />
              <span>{currentUser.subscriptionStatus === 'expired' ? t('এখনই রিনিউ করুন (bKash/Nagad)', 'Renew Now (bKash/Nagad)') : t('প্যাকেজ বেছে নিন ও আনলক করুন', 'Select Package & Unlock')}</span>
            </button>

            <button
              onClick={() => setCurrentIndex(0)}
              className="w-full sm:w-auto px-5 py-3 rounded-2xl border border-slate-300 text-slate-700 hover:bg-slate-50 font-bold text-xs sm:text-sm transition cursor-pointer"
            >
              {t('ফ্রি ডেমো প্রশ্নে ফিরে যান', 'Back to Free Questions')}
            </button>
          </div>
        </div>
      ) : (
        /* Regular Question Card */
        <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-6 sm:p-8">
          
          {/* Top Info */}
          <div className="flex items-center justify-between pb-4 border-b border-slate-100 mb-6">
            <div className="flex items-center gap-2">
              <span className="w-8 h-8 rounded-lg bg-emerald-100 text-emerald-900 font-bold flex items-center justify-center text-sm">
                {currentIndex + 1}
              </span>
              <span className="text-xs text-slate-500 font-semibold">
                {currentIndex + 1} / {practiceQuestions.length}
              </span>
              {currentQ.isDemoSample && (
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-900">
                  DEMO
                </span>
              )}
            </div>

            {currentQ.legalReference && (
              <span className="text-xs font-mono font-medium text-slate-600 bg-slate-50 border border-slate-200 px-2 py-0.5 rounded">
                {currentQ.legalReference}
              </span>
            )}
          </div>

          {/* Question Text */}
          <h2 className="text-lg sm:text-xl font-bold text-slate-900 leading-relaxed mb-6">
            {language === 'bn' ? currentQ.questionBn : currentQ.questionEn}
          </h2>

          {/* Options */}
          <div className="space-y-3 mb-6">
            {(language === 'bn' ? currentQ.optionsBn : currentQ.optionsEn).map((optText, optIdx) => {
              const isSelected = answeredIdx === optIdx;
              const isTheCorrectOption = currentQ.correctOptionIndex === optIdx;
              const prefix = language === 'bn' ? optionPrefixesBn[optIdx] : optionPrefixesEn[optIdx];

              let optionStyle = 'border-slate-200 hover:border-slate-300 hover:bg-slate-50 bg-white text-slate-800';
              if (isAnswered) {
                if (isTheCorrectOption) {
                  optionStyle = 'border-emerald-500 bg-emerald-100/60 text-emerald-950 font-bold ring-2 ring-emerald-500';
                } else if (isSelected && !isTheCorrectOption) {
                  optionStyle = 'border-rose-400 bg-rose-100/60 text-rose-950 font-semibold';
                } else {
                  optionStyle = 'border-slate-100 bg-slate-50 text-slate-400 opacity-60';
                }
              }

              return (
                <button
                  key={optIdx}
                  disabled={isAnswered}
                  onClick={() => handleSelectOption(optIdx)}
                  className={`w-full p-4 rounded-xl text-left border-2 transition-all flex items-start gap-4 ${optionStyle}`}
                >
                  <span className={`w-6 h-6 rounded-full flex items-center justify-center font-bold text-xs shrink-0 mt-0.5 ${
                    isAnswered && isTheCorrectOption
                      ? 'bg-emerald-600 text-white'
                      : (isAnswered && isSelected ? 'bg-rose-600 text-white' : 'bg-slate-100 text-slate-700')
                  }`}>
                    {prefix}
                  </span>

                  <div className="flex-1 text-sm sm:text-base leading-relaxed flex items-center justify-between">
                    <span>{optText}</span>
                    {isAnswered && isTheCorrectOption && (
                      <span className="text-xs font-bold text-emerald-800 flex items-center gap-1 shrink-0 ml-2">
                        <Check className="w-4 h-4" />
                        <span>{t('সঠিক', 'Correct')}</span>
                      </span>
                    )}
                    {isAnswered && isSelected && !isTheCorrectOption && (
                      <span className="text-xs font-bold text-rose-700 flex items-center gap-1 shrink-0 ml-2">
                        <X className="w-4 h-4" />
                        <span>{t('ভুল', 'Wrong')}</span>
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Immediate Explanation Card */}
          {isAnswered && (
            <div className="p-5 rounded-2xl bg-slate-50 border border-[#D4AF37]/60 text-slate-800 space-y-2 mb-6 animate-in fade-in">
              <div className="flex items-center gap-2 font-bold text-[#102A43] text-sm">
                <Lightbulb className="w-4 h-4 text-[#D4AF37]" />
                <span>{t('আইনগত সমাধান ও প্রাসঙ্গিক ব্যাখ্যা', 'Legal Analysis & Statutory Explanation')}</span>
              </div>

              <p className="text-xs sm:text-sm leading-relaxed text-slate-700">
                {language === 'bn' ? currentQ.explanationBn : currentQ.explanationEn}
              </p>

              {currentQ.legalReference && (
                <p className="text-xs text-slate-500 font-mono pt-2 border-t border-slate-200">
                  <strong>{t('রেফারেন্স:', 'Reference:')}</strong> {currentQ.legalReference}
                </p>
              )}
            </div>
          )}

          {/* Nav Buttons */}
          <div className="flex items-center justify-between pt-4 border-t border-slate-100">
            <button
              onClick={handlePrev}
              disabled={currentIndex === 0}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold border border-slate-200 text-slate-700 hover:bg-slate-50 transition disabled:opacity-40 cursor-pointer"
            >
              <ChevronLeft className="w-4 h-4" />
              <span>{t('পূর্ববর্তী', 'Previous')}</span>
            </button>

            <span className="text-xs text-slate-400 font-medium">
              {currentIndex + 1} / {practiceQuestions.length}
            </span>

            <button
              onClick={handleNext}
              disabled={currentIndex === practiceQuestions.length - 1}
              className="flex items-center gap-1.5 px-5 py-2 rounded-xl text-sm font-bold bg-[#102A43] text-[#D4AF37] border border-[#D4AF37] hover:bg-[#243B53] transition disabled:opacity-40 cursor-pointer"
            >
              <span>{t('পরবর্তী', 'Next')}</span>
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

        </div>
      )}

    </div>
  );
};
