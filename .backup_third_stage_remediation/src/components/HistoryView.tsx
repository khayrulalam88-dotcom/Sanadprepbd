import React from 'react';
import { useApp } from '../context/AppContext';
import { 
  History, 
  Award, 
  ArrowRight, 
  Calendar, 
  Clock, 
  CheckCircle, 
  XCircle, 
  FileText,
  Play
} from 'lucide-react';

export const HistoryView: React.FC = () => {
  const { 
    language, 
    t, 
    examResults, 
    viewResult, 
    setActiveScreen, 
    exams, 
    startExam 
  } = useApp();

  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-16">
      
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <span className="text-xs font-bold text-[#D4AF37] uppercase tracking-wider bg-[#102A43] px-3 py-1 rounded-full">
            Sanad Prep BD • {t('ফলাফল রেকর্ড', 'Candidate History')}
          </span>
          <h1 className="text-2xl sm:text-3xl font-black text-[#102A43] tracking-tight mt-3">
            {t('পরীক্ষার ফলাফল ও পূর্ববর্তী ইতিহাস', 'Exam Results & Submission History')}
          </h1>
          <p className="text-xs sm:text-sm text-slate-500 mt-1">
            {t('আপনার সকল সম্পন্ন পরীক্ষার বিস্তারিত মূল্যায়ন ও উত্তরের রেকর্ড', 'Comprehensive record of all submitted mock examinations and performance trends')}
          </p>
        </div>

        {examResults.length > 0 && (
          <button
            onClick={() => {
              const fullMock = exams.find(e => e.type === 'full_mock');
              if (fullMock) startExam(fullMock.id);
            }}
            className="px-5 py-2.5 bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] border border-[#D4AF37] rounded-xl font-bold text-xs sm:text-sm flex items-center gap-1.5 transition shadow-sm cursor-pointer"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            <span>{t('নতুন পরীক্ষা দিন', 'Take Another Mock')}</span>
          </button>
        )}
      </div>

      {/* Results List */}
      {examResults.length === 0 ? (
        <div className="bg-white rounded-3xl border border-slate-200 p-12 text-center shadow-xs">
          <div className="w-16 h-16 rounded-2xl bg-slate-100 text-[#102A43] flex items-center justify-center mx-auto mb-4">
            <History className="w-8 h-8" />
          </div>
          <h3 className="text-lg font-bold text-[#102A43] mb-1">
            {t('এখনো কোনো পরীক্ষার ইতিহাস নেই', 'No Exam Attempts Recorded Yet')}
          </h3>
          <p className="text-xs sm:text-sm text-slate-500 max-w-md mx-auto mb-6">
            {t(
              'বাংলাদেশ বার কাউন্সিল এনরোলমেন্ট পরীক্ষার জন্য আপনার প্রথম ৬০ মিনিটের মডেল টেস্ট শুরু করুন এবং স্কোরিং পর্যালোচনা দেখুন।',
              'Take your first 60-minute Bar Council mock exam to see instant negative-marking scoring and detailed question reviews.'
            )}
          </p>
          <button
            onClick={() => {
              const fullMock = exams.find(e => e.type === 'full_mock');
              if (fullMock) startExam(fullMock.id);
            }}
            className="px-6 py-3 bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] border border-[#D4AF37] font-bold text-sm rounded-xl transition shadow-sm cursor-pointer"
          >
            {t('প্রথম মডেল টেস্ট শুরু করুন', 'Start First Mock Exam')}
          </button>
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-xs divide-y divide-slate-100 overflow-hidden">
          {examResults.map((result) => {
            const timeMins = Math.floor(result.timeSpentSeconds / 60);

            return (
              <div 
                key={result.id}
                className="p-5 sm:p-6 flex flex-col md:flex-row md:items-center justify-between gap-5 hover:bg-slate-50/70 transition"
              >
                <div>
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    <span className={`text-[10px] font-bold uppercase px-2.5 py-0.5 rounded-full ${
                      result.passed !== undefined 
                        ? (result.passed ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800')
                        : 'bg-slate-100 text-slate-700'
                    }`}>
                      {result.passed !== undefined ? (result.passed ? t('পাস (PASSED)', 'PASSED') : t('ফেল (FAILED)', 'FAILED')) : t('সম্পন্ন', 'COMPLETED')}
                    </span>

                    <span className="text-xs text-slate-400 flex items-center gap-1">
                      <Calendar className="w-3.5 h-3.5" />
                      <span>{new Date(result.submittedAt).toLocaleDateString()}</span>
                    </span>

                    <span className="text-xs text-slate-400 flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5" />
                      <span>{timeMins} {t('মিনিট', 'mins')}</span>
                    </span>
                  </div>

                  <h3 className="text-base sm:text-lg font-bold text-[#102A43] mb-1">
                    {language === 'bn' ? result.examTitleBn : result.examTitleEn}
                  </h3>

                  <div className="flex flex-wrap items-center gap-4 text-xs text-slate-500">
                    <span>{t('সঠিক:', 'Correct:')} <strong className="text-emerald-700">{result.correctAnswersCount}</strong></span>
                    <span>{t('ভুল:', 'Incorrect:')} <strong className="text-rose-600">{result.incorrectAnswersCount}</strong></span>
                    <span>{t('অনুত্তর:', 'Skipped:')} <strong>{result.unansweredCount}</strong></span>
                    <span>{t('পজিটিভ:', 'Positive:')} +{result.positiveMarks.toFixed(2)}</span>
                    <span>{t('কর্তন:', 'Deduction:')} -{result.negativeMarks.toFixed(2)}</span>
                  </div>
                </div>

                <div className="flex items-center justify-between md:justify-end gap-5 shrink-0 pt-3 md:pt-0 border-t md:border-t-0 border-slate-100">
                  <div className="text-right">
                    <span className="text-[11px] text-slate-400 uppercase font-semibold block">{t('চূড়ান্ত স্কোর', 'Final Score')}</span>
                    <span className="text-2xl font-black text-[#102A43] font-mono-numbers">
                      {result.finalScore} <span className="text-xs text-slate-400 font-normal">/ {result.totalQuestions}</span>
                    </span>
                    <span className="text-xs font-bold text-emerald-600 block">{result.percentage}%</span>
                  </div>

                  <button
                    onClick={() => viewResult(result.id)}
                    className="px-4 py-2.5 rounded-xl bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] border border-[#D4AF37] font-bold text-xs sm:text-sm flex items-center gap-1.5 transition shadow-xs cursor-pointer"
                  >
                    <span>{t('রিভিউ দেখুন', 'View Review')}</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

    </div>
  );
};
