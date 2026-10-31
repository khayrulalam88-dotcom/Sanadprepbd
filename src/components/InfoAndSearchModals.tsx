import React, { useState, useMemo } from 'react';
import { useApp } from '../context/AppContext';
import { 
  X, 
  Search, 
  BookOpen, 
  Scale, 
  Award, 
  FileText, 
  ExternalLink, 
  CheckCircle,
  HelpCircle,
  Layers,
  ArrowRight
} from 'lucide-react';

export const InfoAndSearchModals: React.FC = () => {
  const { 
    showSearchModal, 
    setShowSearchModal, 
    showInfoModal, 
    setShowInfoModal,
    subjects,
    questions,
    startSubjectPractice,
    setActiveScreen,
    language,
    t
  } = useApp();

  const [searchQuery, setSearchQuery] = useState('');

  // Search Results
  const searchResults = useMemo(() => {
    if (!searchQuery.trim() || searchQuery.trim().length < 2) return [];
    const query = searchQuery.toLowerCase().trim();
    return questions.filter(q => 
      q.questionBn.toLowerCase().includes(query) ||
      (q.legalReference && q.legalReference.toLowerCase().includes(query)) ||
      (q.explanationBn && q.explanationBn.toLowerCase().includes(query))
    ).slice(0, 10);
  }, [searchQuery, questions]);

  return (
    <>
      {/* 1. Quick Search Modal */}
      {showSearchModal && (
        <div 
          className="fixed inset-0 z-50 flex items-start justify-center pt-20 p-4 bg-slate-950/60 backdrop-blur-xs animate-in fade-in"
          onClick={() => setShowSearchModal(false)}
        >
          <div 
            className="bg-white rounded-3xl max-w-xl w-full shadow-2xl border border-slate-200 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-4 border-b border-slate-100 flex items-center gap-3">
              <Search className="w-5 h-5 text-slate-400 shrink-0" />
              <input
                type="text"
                autoFocus
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('ধারা, আইন বা প্রশ্ন সার্চ করুন (যেমন: Section 151, CrPC, জামিন)...', 'Search sections, acts or questions...')}
                className="w-full text-sm text-slate-900 outline-none"
              />
              <button 
                onClick={() => setShowSearchModal(false)}
                className="w-7 h-7 rounded-full bg-slate-100 hover:bg-slate-200 flex items-center justify-center text-slate-500"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Quick Filter Subject Pills */}
            <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-100 flex items-center gap-2 overflow-x-auto text-[11px] font-bold text-slate-600">
              <span className="text-slate-400 shrink-0">{t('আইনসমূহ:', 'Laws:')}</span>
              {subjects.map(s => (
                <button
                  key={s.id}
                  onClick={() => setSearchQuery(s.code)}
                  className="px-2.5 py-1 rounded-lg bg-white border border-slate-200 hover:border-slate-400 shrink-0 cursor-pointer"
                >
                  {s.code}
                </button>
              ))}
            </div>

            {/* Results List */}
            <div className="max-h-96 overflow-y-auto p-4 space-y-2.5">
              {searchQuery.trim().length >= 2 ? (
                searchResults.length > 0 ? (
                  searchResults.map(q => (
                    <div 
                      key={q.id}
                      className="p-3 rounded-2xl bg-slate-50 hover:bg-slate-100 border border-slate-200 transition text-xs space-y-1.5"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-[#102A43] px-2 py-0.5 rounded bg-white border border-slate-200 text-[10px]">
                          {q.legalReference || 'Section Reference'}
                        </span>
                        <span className="text-slate-400 text-[10px] font-mono">{q.subjectId}</span>
                      </div>
                      <p className="font-bold text-slate-800 line-clamp-2">{q.questionBn}</p>
                      {q.explanationBn && (
                        <p className="text-slate-500 text-[11px] line-clamp-1 italic">ব্যাখ্যা: {q.explanationBn}</p>
                      )}
                    </div>
                  ))
                ) : (
                  <p className="text-center text-slate-400 py-8 text-xs">
                    {t('কোনো ফলাফল পাওয়া যায়নি। অন্য শব্দ দিয়ে খুঁজুন।', 'No matching questions found.')}
                  </p>
                )
              ) : (
                <div className="text-center text-slate-400 py-6 text-xs space-y-1">
                  <p>{t('যেকোনো ধারা বা আইনি বিষয় টাইপ করুন।', 'Type section or keywords to search.')}</p>
                  <p className="text-[11px] text-slate-400">উদাহরণ: <code className="bg-slate-100 px-1 py-0.5 rounded">151</code>, <code className="bg-slate-100 px-1 py-0.5 rounded">জামিন</code>, <code className="bg-slate-100 px-1 py-0.5 rounded">Penal Code</code></p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 2. Info / Syllabus / Rules / Bare Acts Modal */}
      {showInfoModal && (
        <div 
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-xs animate-in fade-in"
          onClick={() => setShowInfoModal(null)}
        >
          <div 
            className="bg-white rounded-3xl max-w-2xl w-full shadow-2xl border border-slate-100 overflow-hidden relative max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="p-6 bg-gradient-to-r from-[#102A43] to-[#243B53] text-white flex items-center justify-between">
              <div>
                <h3 className="text-lg font-black">
                  {showInfoModal === 'syllabus' && t('বার কাউন্সিল অফিসিয়াল সিলেবাস ও মানবণ্টন', 'Official Syllabus & Marks Weightage')}
                  {showInfoModal === 'rules' && t('পরীক্ষা পদ্ধতি ও নেগেটিভ মার্কিং নিয়মাবলী', 'Exam Rules & Negative Scoring')}
                  {showInfoModal === 'about' && t('আমাদের সম্পর্কে (Sanad Prep BD)', 'About Sanad Prep BD')}
                  {showInfoModal === 'books' && t('মূল বইসমূহ ও বেয়ার অ্যাক্ট (Bare Acts List)', 'Bare Acts & Recommended Reference Books')}
                </h3>
                <p className="text-xs text-slate-300 mt-0.5">
                  বাংলাদেশ বার কাউন্সিল এনরোলমেন্ট এমসিকিউ পরীক্ষার প্রমিত তথ্য।
                </p>
              </div>
              <button 
                onClick={() => setShowInfoModal(null)}
                className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Body */}
            <div className="p-6 overflow-y-auto space-y-4 text-xs sm:text-sm text-slate-700">
              
              {showInfoModal === 'syllabus' && (
                <div className="space-y-4">
                  <p className="text-xs text-slate-600">
                    বার কাউন্সিল প্রিলিমিনারি ১০০ নম্বরের এমসিকিউ পরীক্ষা মোট ৭টি অফিসিয়াল আইনের সিলেবাস অনুসারে অনুষ্ঠিত হয়:
                  </p>
                  <div className="space-y-2">
                    {subjects.map(s => (
                      <div key={s.id} className="p-3 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between">
                        <div>
                          <h4 className="font-bold text-slate-900 text-xs sm:text-sm">{language === 'bn' ? s.nameBn : s.nameEn} ({s.code})</h4>
                          <p className="text-[11px] text-slate-500">{s.actTitle}</p>
                        </div>
                        <div className="text-right shrink-0">
                          <span className="font-mono font-bold text-base text-[#102A43]">{s.marksWeight}</span>
                          <span className="text-xs text-slate-500 block">নম্বর</span>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900 font-bold flex justify-between">
                    <span>সর্বমোট নম্বর:</span>
                    <span>১০০ নম্বর (১০০টি বহুনির্বাচনী প্রশ্ন)</span>
                  </div>
                </div>
              )}

              {showInfoModal === 'rules' && (
                <div className="space-y-3">
                  <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200 space-y-2">
                    <h4 className="font-bold text-slate-900">১. মোট সময় ও প্রশ্নের ধরন</h4>
                    <p className="text-xs text-slate-600">মোট সময় নির্ধারিত ঠিক ৬০ মিনিট (১ ঘণ্টা)। কোনো বিরতি নেই। ১০০টি প্রশ্নের প্রতিটি সঠিক উত্তরের মান ১.০০ নম্বর।</p>
                  </div>
                  <div className="p-4 rounded-2xl bg-rose-50 border border-rose-200 space-y-2 text-rose-950">
                    <h4 className="font-bold text-rose-900">২. নেগেটিভ মার্কিং নিয়ম (-০.২৫)</h4>
                    <p className="text-xs text-rose-800">প্রতিটি ভুল উত্তরের জন্য ০.২৫ নম্বর কাটা যাবে। ৪টি ভুল উত্তরের জন্য ১ নম্বর কর্তন করা হয়। অনুত্তর প্রশ্নের ক্ষেত্রে কোনো নম্বর কাটা যায় না।</p>
                  </div>
                  <div className="p-4 rounded-2xl bg-emerald-50 border border-emerald-200 space-y-2 text-emerald-950">
                    <h4 className="font-bold text-emerald-900">৩. পাস নম্বর</h4>
                    <p className="text-xs text-emerald-800">পাস করার জন্য ন্যূনতম ৫০% (৫০ নম্বর) অর্জন করতে হবে।</p>
                  </div>
                </div>
              )}

              {showInfoModal === 'books' && (
                <div className="space-y-3">
                  <p className="text-xs text-slate-600">
                    বার কাউন্সিল পরীক্ষার জন্য সুপারিশকৃত মূল বেয়ার অ্যাক্ট (Original Bare Acts) সমূহ:
                  </p>
                  <div className="space-y-2.5">
                    {[
                      { title: 'The Code of Civil Procedure, 1908', bn: 'দেওয়ানী কার্যবিধি, ১৯০৮ (মূল ধারা ও আদেশসমূহ)', marks: '২০ নম্বর' },
                      { title: 'The Specific Relief Act, 1877', bn: 'সুনির্দিষ্ট প্রতিকার আইন, ১৮৭৭', marks: '১০ নম্বর' },
                      { title: 'The Code of Criminal Procedure, 1898', bn: 'ফৌজদারী কার্যবিধি, ১৮৯৮', marks: '২০ নম্বর' },
                      { title: 'The Penal Code, 1860', bn: 'দণ্ডবিধি, ১৮৬০', marks: '২০ নম্বর' },
                      { title: 'The Evidence Act, 1872', bn: 'সাক্ষ্য আইন, ১৮৭২', marks: '১৫ নম্বর' },
                      { title: 'The Limitation Act, 1908', bn: 'তামাদি আইন, ১৯০৮', marks: '১০ নম্বর' },
                      { title: 'The Bangladesh Legal Practitioners & Bar Council Order, 1972', bn: 'বার কাউন্সিল অর্ডার ও পেশাগত আচরণবিধি', marks: '০৫ নম্বর' }
                    ].map((b, i) => (
                      <div key={i} className="p-3 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between text-xs">
                        <div>
                          <h4 className="font-bold text-slate-900">{b.bn}</h4>
                          <p className="text-[11px] text-slate-500 font-mono">{b.title}</p>
                        </div>
                        <span className="font-bold text-[#102A43] bg-white px-2.5 py-1 rounded border border-slate-200">
                          {b.marks}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {showInfoModal === 'about' && (
                <div className="space-y-3 leading-relaxed">
                  <p>
                    <strong>Sanad Prep BD</strong> হলো বাংলাদেশ বার কাউন্সিল আইনজীবী তালিকাভুক্তি (এনরোলমেন্ট) এমসিকিউ পরীক্ষার জন্য একটি বিশেষায়িত, নির্ভরযোগ্য ও সময়াবদ্ধ ডিজিটাল প্রস্তুতি প্ল্যাটফর্ম।
                  </p>
                  <p>
                    এখানে রয়েছে ৩,০০০+ প্রমিত আইনভিত্তিক প্রশ্ন, ৩০টি পূর্ণাঙ্গ লাইভ মডেল টেস্ট, নেগেটিভ মার্কিং অটোমেশন, এবং প্রতিটি উত্তরের বিস্তারিত আইনি ব্যাখ্যা ও মূল ধারার রেফারেন্স।
                  </p>
                  <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900">
                    <strong>লক্ষ্য:</strong> প্রত্যেক আইন শিক্ষানবিস যেন ভয় ও অনিশ্চয়তা কাটিয়ে আত্মবিশ্বাসের সাথে প্রিলিমিনারি পরীক্ষায় প্রথমবারেই সফলভাবে উত্তীর্ণ হতে পারেন।
                  </div>
                </div>
              )}

            </div>

            {/* Footer */}
            <div className="p-4 border-t border-slate-100 bg-slate-50 flex justify-end">
              <button
                onClick={() => setShowInfoModal(null)}
                className="px-5 py-2 rounded-xl bg-[#102A43] text-white font-bold text-xs"
              >
                {t('ঠিক আছে', 'OK')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
