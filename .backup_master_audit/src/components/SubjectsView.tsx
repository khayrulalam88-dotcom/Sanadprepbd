import React from 'react';
import { useApp } from '../context/AppContext';
import { 
  BookOpen, 
  Scale, 
  Clock, 
  Play, 
  ArrowRight, 
  CheckCircle,
  HelpCircle,
  FileText,
  TrendingUp,
  Award,
  Sparkles,
  Lock
} from 'lucide-react';

export const SubjectsView: React.FC = () => {
  const { 
    language, 
    t, 
    subjects, 
    questions, 
    startSubjectPractice, 
    exams, 
    startExam,
    getSubjectProgress,
    answeredQuestions,
    openSubscriptionModal,
    isProSubscribed
  } = useApp();

  // Calculate Overall Syllabus Completion Across All 7 Legal Subjects
  const totalQuestionsAllSubjects = questions.length;
  const answeredQuestionIds = Object.keys(answeredQuestions);
  const totalAnsweredAllSubjects = answeredQuestionIds.length;
  const overallPercentage = totalQuestionsAllSubjects > 0 
    ? Math.min(100, Math.round((totalAnsweredAllSubjects / totalQuestionsAllSubjects) * 100))
    : 0;

  let totalCorrectAll = 0;
  answeredQuestionIds.forEach(id => {
    if (answeredQuestions[id]?.isCorrect) {
      totalCorrectAll++;
    }
  });
  const overallAccuracy = totalAnsweredAllSubjects > 0 
    ? Math.round((totalCorrectAll / totalAnsweredAllSubjects) * 100) 
    : 0;

  return (
    <div className="space-y-8 pb-16 max-w-7xl mx-auto">
      
      {/* Title */}
      <div>
        <span className="text-xs font-bold text-[#D4AF37] uppercase tracking-wider bg-[#102A43] px-3 py-1 rounded-full">
          Sanad Prep BD • {t('সিলেবাস কাঠামো ও অগ্রগতি', 'Syllabus Framework & Progress')}
        </span>
        <h1 className="text-2xl sm:text-3xl font-black text-[#102A43] tracking-tight mt-3">
          {t('বার কাউন্সিল নির্ধারিত বিষয়ভিত্তিক আইন ও সমাপ্তি অগ্রগতি', 'Bar Council Statutory Subjects & Completion Progress')}
        </h1>
        <p className="text-xs sm:text-sm text-slate-500 mt-1">
          {t('সিলেবাসের ৭টি মূল আইনের প্রতিটি প্রশ্নের অনুশীলন স্থিতি ও প্রগ্রেস বার পর্যবেক্ষণ করুন', 'Track your question-by-question completion status and accuracy across all 7 Bar Council subjects')}
        </p>
      </div>

      {/* Pro Subscription Requirement Banner */}
      {!isProSubscribed && (
        <div className="bg-gradient-to-r from-amber-500/10 via-[#102A43]/5 to-transparent rounded-3xl p-6 border-2 border-[#D4AF37] shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-start gap-3.5">
            <div className="w-12 h-12 rounded-2xl bg-[#102A43] text-[#D4AF37] flex items-center justify-center shrink-0 shadow-sm mt-0.5">
              <Lock className="w-6 h-6 text-[#D4AF37]" />
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="px-2.5 py-0.5 rounded-full text-xs font-black bg-[#102A43] text-[#D4AF37]">
                  PRO FEATURE
                </span>
                <span className="text-xs font-bold text-amber-900">
                  {t('পেইড সাবস্ক্রিপশন প্রয়োজন', 'Subscription Required')}
                </span>
              </div>
              <h3 className="text-base sm:text-lg font-black text-[#102A43]">
                {t('সিলেবাস কাঠামো: ৭টি মূল আইনের বিষয়ভিত্তিক অনুশীলন', 'Syllabus Framework: 7 Core Statutory Subjects Practice')}
              </h3>
              <p className="text-xs sm:text-sm text-slate-600">
                {t('অফিসিয়াল নম্বর বিন্যাস অনুযায়ী প্রতিটি কোড অধ্যয়ন করুন। এটাও পেইড করার পর অনুশীলন করতে পারবে।', 'Study each statutory code according to the official marks distribution. Unlocked for practice after activating a paid subscription.')}
              </p>
            </div>
          </div>

          <button
            onClick={() => openSubscriptionModal()}
            className="px-5 py-2.5 rounded-xl bg-[#D4AF37] hover:bg-[#b89528] text-[#102A43] font-black text-xs shrink-0 transition flex items-center justify-center gap-2 shadow-sm cursor-pointer"
          >
            <Sparkles className="w-4 h-4 text-[#102A43]" />
            <span>{t('সাবস্ক্রিপশন আনলক করুন', 'Unlock Pro Access')}</span>
          </button>
        </div>
      )}

      {/* Overall Syllabus Practice Completion Card */}
      <div className="bg-gradient-to-br from-[#102A43] via-[#1E3A5F] to-[#0D1F30] rounded-3xl p-6 sm:p-8 text-white shadow-lg relative overflow-hidden border border-slate-700">
        <div className="absolute top-0 right-0 w-72 h-72 bg-[#D4AF37]/10 rounded-full blur-3xl pointer-events-none" />
        
        <div className="relative z-10 space-y-5">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-[#D4AF37] text-[#102A43] flex items-center gap-1">
                  <Sparkles className="w-3.5 h-3.5" />
                  {t('সিলেবাস সমাপ্তি ট্র্যাক', 'Syllabus Tracker')}
                </span>
                <span className="text-xs text-slate-300">
                  {t('৭টি অফিসিয়াল আইনের সার্বিক অগ্রগতি', 'Combined 7 Statutory Codes Progress')}
                </span>
              </div>
              <h2 className="text-xl sm:text-2xl font-black text-white">
                {t('সামগ্রিক সিলেবাস প্রস্তুতি সমাপ্তি স্থিতি', 'Overall Syllabus Practice Completion')}
              </h2>
            </div>

            <div className="flex items-center gap-4 bg-white/10 backdrop-blur-md px-5 py-3 rounded-2xl border border-white/15">
              <div className="text-right">
                <div className="text-xs text-slate-300 font-medium">{t('মোট সমাপ্তি হার', 'Completion Rate')}</div>
                <div className="text-2xl sm:text-3xl font-black text-[#D4AF37]">
                  {overallPercentage}%
                </div>
              </div>
              <div className="h-10 w-px bg-white/20" />
              <div>
                <div className="text-xs text-slate-300 font-medium">{t('গড় নির্ভুলতা', 'Accuracy')}</div>
                <div className="text-2xl sm:text-3xl font-black text-emerald-400">
                  {overallAccuracy}%
                </div>
              </div>
            </div>
          </div>

          {/* Visual Progress Bar Track */}
          <div className="space-y-2">
            <div className="flex justify-between text-xs text-slate-300 font-semibold">
              <span>{t('অনুশীলন সম্পন্ন প্রশ্ন:', 'Answered Questions:')} <strong className="text-white">{totalAnsweredAllSubjects}</strong> / {totalQuestionsAllSubjects}</span>
              <span>{overallPercentage}% {t('সিলেবাস সমাপ্ত', 'Completed')}</span>
            </div>
            <div className="h-4 w-full bg-slate-900/60 rounded-full overflow-hidden p-0.5 border border-white/10 shadow-inner">
              <div 
                className="h-full rounded-full bg-gradient-to-r from-emerald-500 via-teal-400 to-[#D4AF37] transition-all duration-700"
                style={{ width: `${Math.max(overallPercentage, 3)}%` }}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 text-xs">
            <div className="bg-white/5 rounded-xl p-3 border border-white/10">
              <span className="text-slate-400 block">{t('মোট আইন বিষয়', 'Statutory Codes')}</span>
              <strong className="text-white text-sm sm:text-base">৭ টি বিষয়</strong>
            </div>
            <div className="bg-white/5 rounded-xl p-3 border border-white/10">
              <span className="text-slate-400 block">{t('মোট প্রশ্ন সম্ভার', 'Total Question Pool')}</span>
              <strong className="text-white text-sm sm:text-base">{totalQuestionsAllSubjects} টি</strong>
            </div>
            <div className="bg-white/5 rounded-xl p-3 border border-white/10">
              <span className="text-slate-400 block">{t('সঠিক উত্তর দিয়েছেন', 'Correct Answers')}</span>
              <strong className="text-emerald-400 text-sm sm:text-base">{totalCorrectAll} টি</strong>
            </div>
            <div className="bg-white/5 rounded-xl p-3 border border-white/10">
              <span className="text-slate-400 block">{t('ভুল উত্তর দিয়েছেন', 'Incorrect Answers')}</span>
              <strong className="text-rose-400 text-sm sm:text-base">{totalAnsweredAllSubjects - totalCorrectAll} টি</strong>
            </div>
          </div>
        </div>
      </div>

      {/* Bar Council Marks Allocation Guide */}
      <div className="bg-white p-5 rounded-3xl border border-slate-200 shadow-xs flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-2xl bg-[#102A43] text-[#D4AF37] flex items-center justify-center font-black text-lg">
            100
          </div>
          <div>
            <span className="text-xs text-slate-500 uppercase font-semibold block">{t('মোট পূর্ণমান', 'Total Bar Council Marks')}</span>
            <span className="text-sm sm:text-base font-bold text-[#102A43]">{t('১০০ টি নৈর্ব্যক্তিক প্রশ্ন (এমসিকিউ)', '100 Multiple Choice Questions')}</span>
          </div>
        </div>

        <div className="flex items-center gap-3 text-xs text-slate-600">
          <span className="px-3 py-1.5 bg-slate-100 rounded-lg font-semibold text-slate-800">
            <strong>+১.০০</strong> {t('সঠিক উত্তর', 'per correct')}
          </span>
          <span className="px-3 py-1.5 bg-rose-50 text-rose-700 rounded-lg font-semibold border border-rose-200">
            <strong>-০.২৫</strong> {t('ভুল উত্তর কর্তন', 'per wrong answer')}
          </span>
          <span className="px-3 py-1.5 bg-emerald-50 text-emerald-800 rounded-lg font-semibold border border-emerald-200">
            <strong>৫০%</strong> {t('পাস মার্ক', 'pass threshold')}
          </span>
        </div>
      </div>

      {/* 7 Subjects Cards with Visual Progress Bar */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {subjects.map((sub) => {
          const progress = getSubjectProgress(sub.id);
          const relatedExam = exams.find(e => e.subjectId === sub.id);

          return (
            <div 
              key={sub.id}
              className="bg-white rounded-3xl border border-slate-200 p-6 shadow-xs hover:border-[#102A43] hover:shadow-md transition-all flex flex-col justify-between"
            >
              <div>
                {/* Header Row: Subject Code, Marks, Status Badge */}
                <div className="flex items-center justify-between gap-2 mb-3">
                  <div className="flex items-center gap-2">
                    <span className="px-2.5 py-1 rounded-md text-xs font-mono font-bold bg-slate-100 text-[#102A43]">
                      {sub.code}
                    </span>
                    {!isProSubscribed && (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-900 border border-amber-300 flex items-center gap-1">
                        <Lock className="w-2.5 h-2.5" />
                        <span>PRO</span>
                      </span>
                    )}
                    <span className="px-3 py-1 rounded-full text-xs font-bold bg-[#102A43] text-[#D4AF37]">
                      {sub.marksWeight} {t('নম্বর (Marks)', 'Marks')}
                    </span>
                  </div>
                  
                  {/* Subject Completion Status Badge */}
                  {progress.percentage === 100 ? (
                    <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800 flex items-center gap-1">
                      <CheckCircle className="w-3.5 h-3.5" />
                      {t('সম্পূর্ণ সম্পন্ন', '100% Completed')}
                    </span>
                  ) : progress.percentage > 0 ? (
                    <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-blue-50 text-blue-700 border border-blue-200 flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5" />
                      {progress.percentage}% {t('সম্পন্ন', 'Done')}
                    </span>
                  ) : (
                    <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-100 text-slate-500">
                      {t('শুরু হয়নি', 'Not Started')}
                    </span>
                  )}
                </div>

                <h3 className="text-lg font-bold text-[#102A43] mb-1">
                  {language === 'bn' ? sub.nameBn : sub.nameEn}
                </h3>
                <p className="text-xs font-mono text-slate-500 mb-4">
                  {sub.actTitle}
                </p>

                {/* Visual Progress Bar Section */}
                <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200/80 mb-5 space-y-3">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-bold text-[#102A43] flex items-center gap-1.5">
                      <TrendingUp className="w-3.5 h-3.5 text-emerald-600" />
                      {t('প্রশ্ন সমাপ্তি অগ্রগতি:', 'Question Completion:')}
                    </span>
                    <span className="font-extrabold text-[#102A43]">
                      {progress.answeredCount} / {progress.totalQuestions} {t('টি প্রশ্ন', 'Questions')} ({progress.percentage}%)
                    </span>
                  </div>

                  {/* The Visual Progress Bar Track */}
                  <div className="w-full h-3 bg-slate-200/80 rounded-full overflow-hidden p-0.5 shadow-inner">
                    <div 
                      className={`h-full rounded-full transition-all duration-700 ${
                        progress.percentage === 100 
                          ? 'bg-emerald-600' 
                          : 'bg-gradient-to-r from-emerald-500 to-teal-500'
                      }`}
                      style={{ width: `${Math.max(progress.percentage, progress.answeredCount > 0 ? 4 : 0)}%` }}
                    />
                  </div>

                  {/* Accuracy & Correct/Incorrect Count */}
                  <div className="flex items-center justify-between text-xs pt-1 border-t border-slate-200/60">
                    <div className="flex items-center gap-2">
                      <span className="text-slate-500">{t('নির্ভুলতা:', 'Accuracy:')}</span>
                      <strong className={`font-bold px-2 py-0.5 rounded ${
                        progress.accuracy >= 70 
                          ? 'bg-emerald-100 text-emerald-800' 
                          : progress.accuracy >= 50 
                            ? 'bg-amber-100 text-amber-800' 
                            : 'bg-slate-200 text-slate-700'
                      }`}>
                        {progress.accuracy}%
                      </strong>
                    </div>

                    <div className="flex items-center gap-2 text-slate-600 text-[11px]">
                      <span className="text-emerald-700 font-semibold">{t('সঠিক:', 'Correct:')} {progress.correctCount}</span>
                      <span>•</span>
                      <span className="text-rose-600 font-semibold">{t('ভুল:', 'Wrong:')} {progress.incorrectCount}</span>
                    </div>
                  </div>
                </div>

                <div className="px-3.5 py-2.5 rounded-xl bg-white border border-slate-100 text-xs text-slate-600 mb-5 space-y-1">
                  <div className="flex justify-between">
                    <span>{t('প্রতি মডেল টেস্টে প্রশ্নের সংখ্যা:', 'MCQs per Model Test:')}</span>
                    <strong className="text-slate-900">{sub.marksWeight} {t('টি প্রশ্ন', 'MCQs')}</strong>
                  </div>
                  <div className="flex justify-between">
                    <span>{t('বার কাউন্সিল সিলেবাস মান:', 'Bar Council Syllabus Weight:')}</span>
                    <strong className="text-[#102A43]">{sub.marksWeight}% ({sub.marksWeight} {t('নম্বর', 'Marks')})</strong>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-3 pt-4 border-t border-slate-100">
                <button
                  onClick={() => {
                    if (!isProSubscribed) {
                      openSubscriptionModal();
                    } else {
                      startSubjectPractice(sub.id);
                    }
                  }}
                  className={`w-1/2 py-2.5 px-3 rounded-xl font-bold text-xs transition flex items-center justify-center gap-1.5 cursor-pointer ${
                    !isProSubscribed 
                      ? 'bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-300' 
                      : 'bg-slate-100 hover:bg-[#102A43] hover:text-white text-[#102A43]'
                  }`}
                >
                  {!isProSubscribed ? (
                    <>
                      <Lock className="w-3.5 h-3.5 text-amber-700" />
                      <span>{t('অনুশীলন (পেইড)', 'Practice (Pro)')}</span>
                    </>
                  ) : (
                    <>
                      <BookOpen className="w-3.5 h-3.5" />
                      <span>{t('অনুশীলন (Practice)', 'Practice Mode')}</span>
                    </>
                  )}
                </button>

                {relatedExam ? (
                  <button
                    onClick={() => {
                      if (!isProSubscribed && relatedExam.isPaid) {
                        openSubscriptionModal();
                      } else {
                        startExam(relatedExam.id);
                      }
                    }}
                    className="w-1/2 py-2.5 px-3 rounded-xl bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] border border-[#D4AF37] font-bold text-xs transition flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    {!isProSubscribed && relatedExam.isPaid ? (
                      <Lock className="w-3.5 h-3.5 text-[#D4AF37]" />
                    ) : (
                      <Play className="w-3.5 h-3.5 fill-current" />
                    )}
                    <span>{t('টাইমড পরীক্ষা', 'Timed Quiz')}</span>
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      if (!isProSubscribed) {
                        openSubscriptionModal();
                      } else {
                        startSubjectPractice(sub.id);
                      }
                    }}
                    className="w-1/2 py-2.5 px-3 rounded-xl border border-slate-200 hover:bg-slate-50 text-slate-700 font-bold text-xs transition flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    {!isProSubscribed && <Lock className="w-3.5 h-3.5 text-amber-700" />}
                    <span>{t('ব্যাখ্যাসহ দেখুন', 'View Questions')}</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

    </div>
  );
};
