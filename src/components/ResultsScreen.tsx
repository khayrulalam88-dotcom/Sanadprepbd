import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { 
  CheckCircle2, 
  XCircle, 
  AlertCircle, 
  HelpCircle, 
  RotateCcw, 
  Award, 
  Clock, 
  BookOpen, 
  ChevronDown, 
  ChevronUp, 
  ArrowLeft,
  Check,
  X,
  Minus,
  Sparkles,
  Share2
} from 'lucide-react';
import { formatSecondsToTime } from '../utils/scoring';

export const ResultsScreen: React.FC = () => {
  const { 
    language, 
    t, 
    activeResult, 
    setActiveScreen, 
    startExam, 
    subjects 
  } = useApp();

  const [filter, setFilter] = useState<'all' | 'correct' | 'incorrect' | 'unanswered'>('all');
  const [expandedExplanations, setExpandedExplanations] = useState<Record<string, boolean>>({});

  if (!activeResult) {
    return (
      <div className="text-center py-20">
        <p className="text-slate-600 mb-4">{t('কোনো পরীক্ষার ফলাফল পাওয়া যায়নি।', 'No result found.')}</p>
        <button
          onClick={() => setActiveScreen('dashboard')}
          className="px-4 py-2 bg-emerald-600 text-white rounded-xl font-bold"
        >
          {t('ড্যাশবোর্ডে ফিরে যান', 'Back to Dashboard')}
        </button>
      </div>
    );
  }

  const toggleExplanation = (qid: string) => {
    setExpandedExplanations(prev => ({
      ...prev,
      [qid]: !prev[qid]
    }));
  };

  // Filter questions safely
  const resultQuestions = activeResult.questions || [];
  const filteredQuestions = resultQuestions.filter(q => {
    const studentAns = activeResult.answers[q.id];
    if (filter === 'all') return true;
    if (filter === 'correct') return q.correctOptionIndex !== undefined && studentAns === q.correctOptionIndex;
    if (filter === 'incorrect') return studentAns !== undefined && q.correctOptionIndex !== undefined && studentAns !== q.correctOptionIndex;
    if (filter === 'unanswered') return studentAns === undefined;
    return true;
  });

  const optionPrefixesBn = ['ক', 'খ', 'গ', 'ঘ'];
  const optionPrefixesEn = ['A', 'B', 'C', 'D'];

  const timeMinutes = Math.floor(activeResult.timeSpentSeconds / 60);
  const timeSeconds = activeResult.timeSpentSeconds % 60;

  return (
    <div className="max-w-5xl mx-auto space-y-8 pb-16">
      
      {/* Back button */}
      <div className="flex items-center justify-between">
        <button
          onClick={() => setActiveScreen('dashboard')}
          className="inline-flex items-center gap-2 text-xs sm:text-sm font-bold text-slate-600 hover:text-[#102A43] transition cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>{t('ড্যাশবোর্ডে ফিরে যান', 'Back to Dashboard')}</span>
        </button>

        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-[#D4AF37] uppercase bg-[#102A43] px-2.5 py-0.5 rounded-full">
            Sanad Prep BD Official Evaluation
          </span>
        </div>
      </div>

      {/* Main Score Hero Card */}
      <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
        
        {/* Banner Top */}
        <div className="p-6 sm:p-8 text-white bg-[#102A43] border-b border-[#243B53]">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#243B53] text-[#D4AF37] border border-[#D4AF37]/30 text-xs font-semibold mb-2">
                <Award className="w-3.5 h-3.5" />
                <span>Sanad Prep BD • {t('পরীক্ষার ফলাফল ও মূল্যায়ন পত্র', 'Official Evaluation Sheet')}</span>
              </div>
              <h1 className="text-xl sm:text-2xl font-black tracking-tight text-white">
                {language === 'bn' ? activeResult.examTitleBn : activeResult.examTitleEn}
              </h1>
              <p className="text-xs sm:text-sm text-slate-300 mt-1">
                {t('পরীক্ষার্থী:', 'Candidate:')} <strong className="text-white">{activeResult.studentName}</strong> • {new Date(activeResult.submittedAt).toLocaleString()}
              </p>
            </div>

            {/* Pass / Fail Badge */}
            {activeResult.passed !== undefined && (
              <div className={`px-5 py-2.5 rounded-2xl text-center border font-bold text-sm sm:text-base shrink-0 ${
                activeResult.passed 
                  ? 'bg-emerald-600/30 border-emerald-400 text-emerald-200' 
                  : 'bg-rose-600/30 border-rose-400 text-rose-200'
              }`}>
                <span className="block text-xs font-normal uppercase tracking-wider opacity-90">{t('ফলাফল', 'Result')}</span>
                <span>{activeResult.passed ? t('উত্তীর্ণ (PASSED)', 'PASSED') : t('অনুত্তীর্ণ (FAILED)', 'FAILED')}</span>
              </div>
            )}
          </div>
        </div>

        {/* Score Breakdown Metrics Grid */}
        <div className="p-6 sm:p-8 bg-slate-50/50">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            
            {/* Final Score */}
            <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs">
              <span className="text-xs font-semibold text-slate-500 block uppercase tracking-wider">{t('চূড়ান্ত প্রাপ্ত স্কোর', 'Final Score')}</span>
              <div className="flex items-baseline gap-1 mt-1">
                <span className={`text-3xl font-extrabold font-mono-numbers ${activeResult.finalScore >= 0 ? 'text-slate-900' : 'text-rose-600'}`}>
                  {activeResult.finalScore}
                </span>
                <span className="text-xs text-slate-400 font-medium">/ {activeResult.totalQuestions}</span>
              </div>
              <span className="text-xs font-bold text-emerald-600 mt-1 block">
                {activeResult.percentage}% {t('নম্বর', 'marks')}
              </span>
            </div>

            {/* Correct Answers */}
            <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs">
              <span className="text-xs font-semibold text-slate-500 block uppercase tracking-wider">{t('সঠিক উত্তর (+১.০০)', 'Correct (+1.00)')}</span>
              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-3xl font-extrabold text-emerald-600 font-mono-numbers">
                  {activeResult.correctAnswersCount}
                </span>
                <CheckCircle2 className="w-5 h-5 text-emerald-500" />
              </div>
              <span className="text-xs text-slate-400 mt-1 block">
                +{activeResult.positiveMarks.toFixed(2)} {t('মার্ক যোগ', 'positive marks')}
              </span>
            </div>

            {/* Incorrect Answers */}
            <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs">
              <span className="text-xs font-semibold text-slate-500 block uppercase tracking-wider">{t('ভুল উত্তর (-০.২৫)', 'Incorrect (-0.25)')}</span>
              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-3xl font-extrabold text-rose-600 font-mono-numbers">
                  {activeResult.incorrectAnswersCount}
                </span>
                <XCircle className="w-5 h-5 text-rose-500" />
              </div>
              <span className="text-xs text-rose-600 font-semibold mt-1 block">
                -{activeResult.negativeMarks.toFixed(2)} {t('মার্ক কর্তন', 'negative deduction')}
              </span>
            </div>

            {/* Unanswered & Time */}
            <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs">
              <span className="text-xs font-semibold text-slate-500 block uppercase tracking-wider">{t('অনুত্তর ও সময়', 'Unanswered & Time')}</span>
              <div className="flex items-baseline gap-1 mt-1">
                <span className="text-3xl font-extrabold text-slate-700 font-mono-numbers">
                  {activeResult.unansweredCount}
                </span>
                <span className="text-xs text-slate-400 font-medium">{t('টি প্রশ্ন', 'items')}</span>
              </div>
              <span className="text-xs text-slate-500 mt-1 block flex items-center gap-1">
                <Clock className="w-3.5 h-3.5 text-slate-400" />
                <span>{timeMinutes} {t('মি.', 'm')} {timeSeconds} {t('সে.', 's')}</span>
              </span>
            </div>

          </div>

          {/* Negative Marking Formula Callout */}
          <div className="mt-4 p-3.5 rounded-xl bg-slate-100 border border-slate-200 text-xs text-slate-700 flex items-center justify-between">
            <span className="font-mono">
              <strong>{t('স্কোরিং সূত্র:', 'Formula:')}</strong> ({activeResult.correctAnswersCount} × 1.0) − ({activeResult.incorrectAnswersCount} × 0.25) = <strong>{activeResult.finalScore}</strong>
            </span>
            {activeResult.passThresholdPercentage && (
              <span className="text-slate-500">
                {t('পাস মার্ক ন্যূনতম:', 'Pass Criteria:')} {activeResult.passThresholdPercentage}%
              </span>
            )}
          </div>
        </div>

      </div>

      {/* Subject-Wise Performance Breakdown */}
      {Object.keys(activeResult.subjectWiseScores).length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs">
          <h3 className="font-bold text-slate-900 text-base mb-4 flex items-center gap-2">
            <BookOpen className="w-5 h-5 text-emerald-600" />
            <span>{t('আইনভিত্তিক ফলাফল বিশ্লেষণ (Subject-Wise Analysis)', 'Subject-Wise Performance Breakdown')}</span>
          </h3>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {Object.entries(activeResult.subjectWiseScores).map(([subId, stat]) => (
              <div key={subId} className="p-4 rounded-xl border border-slate-200 bg-slate-50/60">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="font-bold text-xs sm:text-sm text-slate-800 line-clamp-1">
                    {language === 'bn' ? stat.subjectNameBn : stat.subjectNameEn}
                  </h4>
                  <span className="text-xs font-mono font-bold text-slate-900 bg-white px-2 py-0.5 rounded border border-slate-200">
                    {stat.score} / {stat.total}
                  </span>
                </div>

                <div className="flex items-center gap-3 text-xs text-slate-500">
                  <span className="text-emerald-700 font-semibold">{t('সঠিক:', 'Correct:')} {stat.correct}</span>
                  <span className="text-rose-600 font-semibold">{t('ভুল:', 'Incorrect:')} {stat.incorrect}</span>
                  <span>{t('বাদ:', 'Skipped:')} {stat.unanswered}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Question-Wise Review Section */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-xs p-6 space-y-6">
        
        {/* Review Header & Filters */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-100 pb-4">
          <div>
            <h3 className="text-lg font-bold text-slate-900">
              {t('প্রশ্নোত্তর বিশদ পর্যালোচনা (Question-by-Question Review)', 'Question-by-Question Review')}
            </h3>
            <p className="text-xs text-slate-500">
              {t('প্রতিটি প্রশ্নের সঠিক উত্তর ও আইনগত ধারা বিশ্লেষণ করুন', 'Review your answers alongside statutory sections and explanations')}
            </p>
          </div>

          {/* Filter Pills */}
          <div className="flex items-center gap-1.5 p-1 bg-slate-100 rounded-xl text-xs font-bold">
            <button
              onClick={() => setFilter('all')}
              className={`px-3 py-1.5 rounded-lg transition ${
                filter === 'all' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {t('সকল', 'All')} ({resultQuestions.length})
            </button>
            <button
              onClick={() => setFilter('correct')}
              className={`px-3 py-1.5 rounded-lg transition ${
                filter === 'correct' ? 'bg-white text-emerald-700 shadow-xs' : 'text-slate-600 hover:text-emerald-700'
              }`}
            >
              {t('সঠিক', 'Correct')} ({activeResult.correctAnswersCount})
            </button>
            <button
              onClick={() => setFilter('incorrect')}
              className={`px-3 py-1.5 rounded-lg transition ${
                filter === 'incorrect' ? 'bg-white text-rose-700 shadow-xs' : 'text-slate-600 hover:text-rose-700'
              }`}
            >
              {t('ভুল', 'Incorrect')} ({activeResult.incorrectAnswersCount})
            </button>
            <button
              onClick={() => setFilter('unanswered')}
              className={`px-3 py-1.5 rounded-lg transition ${
                filter === 'unanswered' ? 'bg-white text-slate-700 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {t('অনুত্তর', 'Skipped')} ({activeResult.unansweredCount})
            </button>
          </div>
        </div>

        {/* Questions List */}
        <div className="space-y-6">
          {filteredQuestions.map((q, idx) => {
            const studentAns = activeResult.answers[q.id];
            const isCorrect = q.correctOptionIndex !== undefined && studentAns === q.correctOptionIndex;
            const isUnanswered = studentAns === undefined;
            const isExpanded = expandedExplanations[q.id] ?? true; // expanded by default

            return (
              <div 
                key={q.id}
                className={`rounded-2xl border p-5 transition ${
                  isCorrect 
                    ? 'border-emerald-200 bg-emerald-50/20' 
                    : isUnanswered 
                    ? 'border-slate-200 bg-slate-50/40' 
                    : 'border-rose-200 bg-rose-50/20'
                }`}
              >
                {/* Question Item Header */}
                <div className="flex items-start justify-between gap-3 mb-4">
                  <div className="flex items-center gap-2">
                    <span className="w-7 h-7 rounded-lg bg-slate-200 text-slate-800 font-bold text-xs flex items-center justify-center shrink-0">
                      {idx + 1}
                    </span>

                    <span className={`px-2 py-0.5 rounded text-[11px] font-bold flex items-center gap-1 ${
                      isCorrect 
                        ? 'bg-emerald-100 text-emerald-800' 
                        : isUnanswered 
                        ? 'bg-slate-200 text-slate-700' 
                        : 'bg-rose-100 text-rose-800'
                    }`}>
                      {isCorrect && <Check className="w-3 h-3 text-emerald-700" />}
                      {!isCorrect && !isUnanswered && <X className="w-3 h-3 text-rose-700" />}
                      {isUnanswered && <Minus className="w-3 h-3 text-slate-600" />}
                      <span>
                        {isCorrect ? t('সঠিক (+১.০০)', 'Correct (+1.00)') : isUnanswered ? t('অনুত্তর (০.০০)', 'Skipped (0.00)') : t('ভুল (-০.২৫)', 'Incorrect (-0.25)')}
                      </span>
                    </span>

                    {q.legalReference && (
                      <span className="text-[10px] font-mono font-medium text-slate-500 bg-white border border-slate-200 px-2 py-0.5 rounded hidden sm:inline">
                        {q.legalReference}
                      </span>
                    )}
                  </div>

                  <button
                    onClick={() => toggleExplanation(q.id)}
                    className="text-xs font-semibold text-emerald-700 hover:text-emerald-800 flex items-center gap-1"
                  >
                    <span>{isExpanded ? t('ব্যাখ্যা লুকান', 'Hide explanation') : t('ব্যাখ্যা দেখুন', 'Show explanation')}</span>
                    {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                  </button>
                </div>

                {/* Question Text */}
                <h4 className="text-base font-bold text-slate-900 mb-4 leading-relaxed">
                  {language === 'bn' ? q.questionBn : q.questionEn}
                </h4>

                {/* Options List */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-4">
                  {(language === 'bn' ? q.optionsBn : q.optionsEn).map((optText, optIdx) => {
                    const isStudentChoice = studentAns === optIdx;
                    const isTheCorrectOption = q.correctOptionIndex === optIdx;
                    const prefix = language === 'bn' ? optionPrefixesBn[optIdx] : optionPrefixesEn[optIdx];

                    let optionStyle = 'border-slate-200 bg-white text-slate-700';
                    if (isTheCorrectOption) {
                      optionStyle = 'border-emerald-500 bg-emerald-100/60 text-emerald-950 font-bold ring-1 ring-emerald-500';
                    } else if (isStudentChoice && !isCorrect) {
                      optionStyle = 'border-rose-400 bg-rose-100/60 text-rose-950 font-medium';
                    }

                    return (
                      <div
                        key={optIdx}
                        className={`p-3 rounded-xl border text-xs sm:text-sm flex items-start gap-2.5 ${optionStyle}`}
                      >
                        <span className={`w-5 h-5 rounded-full flex items-center justify-center font-bold text-xs shrink-0 mt-0.5 ${
                          isTheCorrectOption 
                            ? 'bg-emerald-600 text-white' 
                            : (isStudentChoice ? 'bg-rose-600 text-white' : 'bg-slate-100 text-slate-600')
                        }`}>
                          {prefix}
                        </span>

                        <div className="flex-1">
                          <span>{optText}</span>
                          {isTheCorrectOption && (
                            <span className="ml-2 text-[10px] font-bold text-emerald-800 uppercase bg-emerald-200/80 px-1.5 py-0.5 rounded">
                              {t('সঠিক উত্তর', 'Correct Answer')}
                            </span>
                          )}
                          {isStudentChoice && !isTheCorrectOption && (
                            <span className="ml-2 text-[10px] font-bold text-rose-800 uppercase bg-rose-200/80 px-1.5 py-0.5 rounded">
                              {t('আপনার ভুল উত্তর', 'Your Choice')}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Statutory Explanation Card */}
                {isExpanded && (
                  <div className="p-4 rounded-xl bg-white border border-slate-200 text-xs sm:text-sm space-y-2">
                    <div className="flex items-center gap-1.5 font-bold text-emerald-800">
                      <BookOpen className="w-4 h-4" />
                      <span>{t('আইনগত ব্যাখ্যা ও রেফারেন্স:', 'Statutory Explanation & Legal Reference:')}</span>
                    </div>

                    <p className="text-slate-700 leading-relaxed">
                      {language === 'bn' ? q.explanationBn : q.explanationEn}
                    </p>

                    {q.legalReference && (
                      <p className="text-xs text-slate-500 font-mono pt-1 border-t border-slate-100">
                        {t('আইনগত সূত্র:', 'Reference:')} {q.legalReference}
                      </p>
                    )}
                  </div>
                )}

              </div>
            );
          })}
        </div>

      </div>

      {/* Retake or Back Actions */}
      <div className="flex items-center justify-center gap-4 pt-4">
        <button
          onClick={() => setActiveScreen('dashboard')}
          className="px-6 py-3 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 font-bold text-sm transition shadow-xs cursor-pointer"
        >
          {t('ড্যাশবোর্ডে ফিরে যান', 'Return to Dashboard')}
        </button>

        <button
          onClick={() => startExam(activeResult.examId)}
          className="px-6 py-3 rounded-xl bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] border border-[#D4AF37] font-bold text-sm transition shadow-sm flex items-center gap-2 cursor-pointer"
        >
          <RotateCcw className="w-4 h-4" />
          <span>{t('পুনরায় পরীক্ষা দিন', 'Retake Examination')}</span>
        </button>
      </div>

    </div>
  );
};
