import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { Logo } from './Logo';
import { SubscriptionPlansSection } from './SubscriptionPlansSection';
import { WhatsAppSupportButton } from './WhatsAppSupportButton';
import { 
  Play, 
  BookOpen, 
  Clock, 
  Award, 
  CheckCircle, 
  ArrowRight, 
  Scale, 
  ShieldCheck, 
  ChevronDown, 
  ChevronUp, 
  Layers, 
  HelpCircle,
  FileCheck2,
  Sparkles,
  BarChart3,
  Flame,
  Lock
} from 'lucide-react';

export const LandingPage: React.FC = () => {
  const { 
    language, 
    t, 
    subjects, 
    exams, 
    startExam, 
    startSubjectPractice, 
    setActiveScreen,
    currentUser,
    setShowPaymentModal,
    openSubscriptionModal,
    isProSubscribed
  } = useApp();

  const [openFaq, setOpenFaq] = useState<number | null>(null);

  const toggleFaq = (idx: number) => {
    setOpenFaq(prev => prev === idx ? null : idx);
  };

  // Landing Page: ONLY free model test is visible to general public ("শুধু ফ্রি মডেলে টেস্ট সবাই দেখতে পারবে")
  const freeMockExams = exams.filter(e => e.type === 'full_mock' && !e.isPaid);

  const faqs = [
    {
      qBn: 'বার কাউন্সিল এনরোলমেন্ট এমসিকিউ পরীক্ষার মোট সময় ও নম্বর কত?',
      qEn: 'What is the total duration and marks for the Bar Council Enrollment MCQ exam?',
      aBn: 'বার কাউন্সিল এনরোলমেন্ট এমসিকিউ পরীক্ষার পূর্ণমান ১০০ নম্বর এবং নির্ধারিত সময় ঠিক ৬০ মিনিট (১ ঘণ্টা)। ১০০টি প্রশ্ন থাকে, প্রতিটি সঠিক উত্তরের জন্য ১ নম্বর।',
      aEn: 'The Bar Council MCQ exam consists of 100 questions for a total of 100 marks, with an exact duration of 60 minutes (1 hour). Each correct answer carries 1 mark.'
    },
    {
      qBn: 'নেগেটিভ মার্কিং কীভাবে হিসাব করা হয়?',
      qEn: 'How does negative marking work in the examination?',
      aBn: 'প্রতিটি ভুল উত্তরের জন্য ০.২৫ নম্বর কর্তন করা হয়। সূত্র: প্রাপ্ত নম্বর = (সঠিক উত্তর সংখ্যা × ১.০০) − (ভুল উত্তর সংখ্যা × ০.২৫)। অনুত্তর প্রশ্নের জন্য কোনো নম্বর কাটা যায় না।',
      aEn: 'Each incorrect answer deducts 0.25 marks. The formula is: Final Score = (Correct × 1.0) - (Incorrect × 0.25). Unanswered questions carry zero penalty.'
    },
    {
      qBn: 'Sanad Prep BD-তে কোন কোন আইন অন্তর্ভুক্ত রয়েছে?',
      qEn: 'Which legal codes are covered in Sanad Prep BD?',
      aBn: 'বাংলাদেশ বার কাউন্সিলের অফিসিয়াল সিলেবাসভুক্ত ৭টি মূল আইন অন্তর্ভুক্ত: দেওয়ানী কার্যবিধি, সুনির্দিষ্ট প্রতিকার আইন, ফৌজদারী কার্যবিধি, দণ্ডবিধি, সাক্ষ্য আইন, তামাদি আইন, এবং বার কাউন্সিল অর্ডার ও পেশাগত শিষ্টাচার।',
      aEn: 'All 7 official syllabus codes: The Code of Civil Procedure 1908, The Specific Relief Act 1877, The Code of Criminal Procedure 1898, The Penal Code 1860, The Evidence Act 1872, The Limitation Act 1908, and Legal Practitioners Order & Canons of Professional Conduct.'
    },
    {
      qBn: 'পরীক্ষা চলাকালীন ইন্টারনেট সংযোগ বিচ্ছিন্ন হলে বা রিলোড দিলে কী হবে?',
      qEn: 'What happens if the internet disconnects or the page is refreshed during a test?',
      aBn: 'Sanad Prep BD-র পরীক্ষা সার্ভার-নিয়ন্ত্রিত সময়সীমা (Server-Authoritative Deadline) অনুসরণ করে। পেজ রিফ্রেশ করলেও পূর্বে সংরক্ষিত উত্তর বহাল থাকে এবং অবশিষ্ট সময় অক্ষুণ্ণ রেখে পরীক্ষা পুনরায় চালু হয়।',
      aEn: 'Sanad Prep BD uses server-authoritative timing. Your saved answers are preserved in active storage, and the deadline cannot be reset or extended by page reloads.'
    },
    {
      qBn: 'Sanad Prep BD কি বাংলাদেশ বার কাউন্সিলের অফিসিয়াল অ্যাপ্লিকেশন?',
      qEn: 'Is Sanad Prep BD an official Bar Council application?',
      aBn: 'না। Sanad Prep BD একটি স্বাধীন আইন শিক্ষা ও প্রস্তুতিমূলক প্ল্যাটফর্ম। এটি বাংলাদেশ বার কাউন্সিলের অফিসিয়াল অঙ্গ বা অনুমোদিত সংস্থা নয়। সকল নমুনা প্রশ্ন প্রস্তুতিমূলক শিক্ষার উদ্দেশ্যে DEMO হিসেবে চিহ্নিত।',
      aEn: 'No. Sanad Prep BD is an independent legal education and examination preparatory tool. It is not affiliated with, nor officially endorsed by, the Bangladesh Bar Council.'
    }
  ];

  return (
    <div className="space-y-16 pb-20">
      
      {/* Hero Section */}
      <section className="relative overflow-hidden rounded-3xl bg-[#102A43] text-white shadow-xl border border-[#243B53] px-6 py-12 sm:px-12 sm:py-16">
        
        {/* Subtle Gold Ambient Highlight */}
        <div className="absolute -top-24 -right-24 w-96 h-96 bg-[#D4AF37]/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute -bottom-24 -left-24 w-96 h-96 bg-[#243B53]/50 rounded-full blur-3xl pointer-events-none" />

        <div className="relative z-10 max-w-4xl mx-auto text-center space-y-6">
          
          {/* Brand Logo & Pill */}
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-[#243B53]/80 border border-[#D4AF37]/40 text-xs font-semibold text-[#D4AF37] mb-2 shadow-xs">
            <Sparkles className="w-4 h-4 text-[#D4AF37]" />
            <span>{language === 'bn' ? 'অনুশীলনে দক্ষতা, প্রস্তুতিতে আত্মবিশ্বাস' : 'Practice Smart. Become an Advocate.'}</span>
          </div>

          <div className="flex justify-center mb-4">
            <Logo size="xl" theme="light" variant="full" language={language} />
          </div>

          <h1 className="text-3xl sm:text-5xl font-black tracking-tight text-white leading-tight">
            {language === 'bn' 
              ? 'বার কাউন্সিল MCQ পরীক্ষার প্রস্তুতি হোক আরও গোছানো' 
              : 'Prepare for Your Bar Council MCQ Examination'}
          </h1>

          <p className="text-sm sm:text-lg text-slate-300 max-w-2xl mx-auto leading-relaxed">
            {language === 'bn'
              ? '৬০ মিনিটের সময়াবদ্ধ মডেল টেস্ট, আইনভিত্তিক অধ্যায় অনুশীলন, তাৎক্ষণিক নেগেটিভ মার্কিং হিসাব এবং প্রতিটি প্রশ্নের প্রাসঙ্গিক ধারা ও ব্যাখ্যাসহ পূর্ণাঙ্গ প্রস্তুতি প্ল্যাটফর্ম।'
              : 'Experience strict 60-minute timed mock tests, subject-wise practice, automated negative scoring (+1 / -0.25), and in-depth statutory explanations.'}
          </p>

          {/* Action CTA Buttons */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-4">
            <button
              onClick={() => setActiveScreen('dashboard')}
              className="w-full sm:w-auto px-8 py-3.5 rounded-xl bg-[#D4AF37] hover:bg-[#b89528] text-[#102A43] font-black text-sm sm:text-base transition shadow-lg shadow-[#D4AF37]/20 flex items-center justify-center gap-2 cursor-pointer"
            >
              <Play className="w-4 h-4 fill-current" />
              <span>{language === 'bn' ? 'অনুশীলন শুরু করুন (Start Practicing)' : 'Start Practicing'}</span>
            </button>

            <button
              onClick={() => {
                const el = document.getElementById('mock-section');
                if (el) el.scrollIntoView({ behavior: 'smooth' });
              }}
              className="w-full sm:w-auto px-7 py-3.5 rounded-xl bg-[#243B53] hover:bg-[#1A365D] text-white font-bold text-sm sm:text-base border border-slate-600 transition flex items-center justify-center gap-2 cursor-pointer"
            >
              <Clock className="w-4 h-4 text-[#D4AF37]" />
              <span>{language === 'bn' ? 'মডেল টেস্ট দেখুন (Explore Mock Tests)' : 'Explore Mock Tests'}</span>
            </button>

            <WhatsAppSupportButton 
              className="w-full sm:w-auto py-3.5"
            />
          </div>

          {/* Trust Badges Bar */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-8 border-t border-slate-700/60 text-xs text-slate-300">
            <div className="flex items-center justify-center gap-2">
              <Clock className="w-4 h-4 text-[#D4AF37]" />
              <span>{t('ঠিক ৬০ মিনিট সময়সীমা', 'Exact 60:00 Timer')}</span>
            </div>
            <div className="flex items-center justify-center gap-2">
              <Scale className="w-4 h-4 text-[#D4AF37]" />
              <span>{t('অফিসিয়াল নেগেটিভ মার্কিং (-০.২৫)', '-0.25 Negative Marking')}</span>
            </div>
            <div className="flex items-center justify-center gap-2">
              <BookOpen className="w-4 h-4 text-[#D4AF37]" />
              <span>{t('৭টি মূল আইনসমূহ', '7 Statutory Codes')}</span>
            </div>
            <div className="flex items-center justify-center gap-2">
              <ShieldCheck className="w-4 h-4 text-[#D4AF37]" />
              <span>{t('সার্ভার সুরক্ষিত মূল্যায়ন', 'Server-Authoritative')}</span>
            </div>
          </div>

        </div>
      </section>

      {/* Feature Pillars: Why Sanad Prep BD */}
      <section className="space-y-6">
        <div className="text-center max-w-2xl mx-auto">
          <span className="text-xs font-bold uppercase tracking-wider text-[#D4AF37] bg-[#102A43] px-3 py-1 rounded-full">
            {t('প্ল্যাটফর্মের মূল সুবিধাসমূহ', 'Core Capabilities')}
          </span>
          <h2 className="text-2xl sm:text-3xl font-extrabold text-[#102A43] mt-3">
            {t('বার কাউন্সিল পরীক্ষার নিয়ম মেনে বাস্তব অভিজ্ঞতা', 'Built Specifically for Bar Council MCQ Preparation')}
          </h2>
          <p className="text-xs sm:text-sm text-slate-600 mt-1">
            {t('পরীক্ষার প্রতিটি ক্ষেত্রে কঠোর আইনি নির্ভুলতা এবং সহজ ইন্টারফেস', 'Rigorous legal accuracy with distraction-free candidate UX')}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="p-6 rounded-2xl bg-white border border-slate-200 shadow-xs hover:border-[#D4AF37] transition">
            <div className="w-12 h-12 rounded-xl bg-[#102A43] text-[#D4AF37] flex items-center justify-center mb-4">
              <Clock className="w-6 h-6" />
            </div>
            <h3 className="font-bold text-lg text-[#102A43] mb-2">
              {t('বাস্তবসম্মত ৬০ মিনিটের লাইভ মক', 'Realistic 60-Minute Timed Mock')}
            </h3>
            <p className="text-xs sm:text-sm text-slate-600 leading-relaxed">
              {t(
                'বার কাউন্সিলের আসল পরীক্ষার মতো ঘড়ির কাঁটায় ৬০ মিনিট। ৫ মিনিট ও ১ মিনিটের অ্যালার্ট এবং সময় শেষ হলে স্বয়ংক্রিয় জমা।',
                'Strict 60-minute countdown with automatic submission and warning alerts when 5m and 1m remain.'
              )}
            </p>
          </div>

          <div className="p-6 rounded-2xl bg-white border border-slate-200 shadow-xs hover:border-[#D4AF37] transition">
            <div className="w-12 h-12 rounded-xl bg-[#102A43] text-[#D4AF37] flex items-center justify-center mb-4">
              <Scale className="w-6 h-6" />
            </div>
            <h3 className="font-bold text-lg text-[#102A43] mb-2">
              {t('সঠিক নেগেটিভ মার্কিং হিসাব', 'Exact Negative Marking (+1 / -0.25)')}
            </h3>
            <p className="text-xs sm:text-sm text-slate-600 leading-relaxed">
              {t(
                'সঠিক উত্তরে +১, প্রতি ভুল উত্তরে -০.২৫ এবং অনুত্তরে ০। প্রাপ্ত স্কোর কোনো কৃত্রিম ফ্লোর ছাড়াই বাস্তবসম্মতভাবে প্রদর্শিত হয়।',
                'Each correct answer earns +1, incorrect deducts 0.25, with unanswered awarding 0. Preserves true score calculation.'
              )}
            </p>
          </div>

          <div className="p-6 rounded-2xl bg-white border border-slate-200 shadow-xs hover:border-[#D4AF37] transition">
            <div className="w-12 h-12 rounded-xl bg-[#102A43] text-[#D4AF37] flex items-center justify-center mb-4">
              <BookOpen className="w-6 h-6" />
            </div>
            <h3 className="font-bold text-lg text-[#102A43] mb-2">
              {t('ধারাভিত্তিক ব্যাখ্যা ও বিশ্লেষণ', 'Statutory Section Analysis')}
            </h3>
            <p className="text-xs sm:text-sm text-slate-600 leading-relaxed">
              {t(
                'প্রতিটি প্রশ্নের সাথে মূল আইনের সংশ্লিষ্ট ধারা ও সুস্পষ্ট ব্যাখ্যা উল্লেখ থাকে, যা প্রস্তুতিকে আরও মজবুত করে।',
                'Every sample question includes relevant statutory Bare Act citations, options review, and detailed reasoning.'
              )}
            </p>
          </div>
        </div>
      </section>

      {/* Mock Examination Section */}
      <section id="mock-section" className="space-y-6 scroll-mt-24">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <span className="text-xs font-bold text-[#D4AF37] uppercase tracking-wider block">
              {t('মডেল টেস্ট সম্ভার', 'Examination Suite')}
            </span>
            <h2 className="text-2xl sm:text-3xl font-extrabold text-[#102A43] mt-1">
              {t('৬০ মিনিটের পূর্ণাঙ্গ মডেল টেস্ট', 'Available 60-Minute Mock Examinations')}
            </h2>
            <p className="text-xs sm:text-sm text-slate-500">
              {t('১০০ নম্বরের অফিসিয়াল সিলেবাস ফরম্যাট', 'Standard 100-mark syllabus structure with live timer')}
            </p>
          </div>

          <button
            onClick={() => setActiveScreen('dashboard')}
            className="text-xs sm:text-sm font-bold text-[#102A43] hover:text-[#D4AF37] flex items-center gap-1.5 transition"
          >
            <span>{t('ড্যাশবোর্ডে সকল পরীক্ষা দেখুন', 'View All in Dashboard')}</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {freeMockExams.map((exam) => (
            <div 
              key={exam.id}
              className="rounded-2xl border p-6 bg-white shadow-xs flex flex-col justify-between transition-all hover:shadow-md border-emerald-300 ring-1 ring-emerald-100"
            >
              <div>
                <div className="flex items-center justify-between gap-2 mb-3">
                  <span className="px-2.5 py-1 rounded-full text-xs font-bold flex items-center gap-1.5 bg-emerald-100 text-emerald-800 border border-emerald-200">
                    <Award className="w-3.5 h-3.5 text-emerald-700" />
                    <span>{t('সবার জন্য উন্মুক্ত ফ্রি ডেমো টেস্ট', 'FREE DEMO MOCK TEST')}</span>
                  </span>

                  <span className="text-xs font-mono font-bold text-[#102A43] bg-slate-100 px-2.5 py-1 rounded-md flex items-center gap-1">
                    <Clock className="w-3.5 h-3.5 text-slate-500" />
                    <span>{exam.durationMinutes}:00 {t('মিনিট', 'mins')}</span>
                  </span>
                </div>

                <h3 className="text-lg font-bold text-[#102A43] mb-2">
                  {language === 'bn' ? exam.titleBn : exam.titleEn}
                </h3>
                <p className="text-xs sm:text-sm text-slate-600 mb-5 leading-relaxed">
                  {language === 'bn' ? exam.descriptionBn : exam.descriptionEn}
                </p>

                <div className="grid grid-cols-3 gap-2 py-3 border-y border-slate-100 text-center mb-6">
                  <div>
                    <span className="text-[11px] text-slate-400 uppercase font-medium block">{t('প্রশ্ন সংখ্যা', 'Questions')}</span>
                    <span className="text-sm font-black text-slate-800">{exam.questionIds.length || 100}</span>
                  </div>
                  <div>
                    <span className="text-[11px] text-slate-400 uppercase font-medium block">{t('নেগেটিভ', 'Negative')}</span>
                    <span className="text-sm font-black text-rose-600">-0.25</span>
                  </div>
                  <div>
                    <span className="text-[11px] text-slate-400 uppercase font-medium block">{t('পাস মার্ক', 'Pass Mark')}</span>
                    <span className="text-sm font-black text-emerald-600">{exam.passThresholdPercentage}%</span>
                  </div>
                </div>
              </div>

              <button
                onClick={() => startExam(exam.id)}
                className="w-full py-3 rounded-xl font-bold text-sm transition flex items-center justify-center gap-2 bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] border border-[#D4AF37] shadow-sm cursor-pointer"
              >
                <Play className="w-4 h-4 fill-current text-[#D4AF37]" />
                <span>{t('ফ্রি ডেমো পরীক্ষা শুরু করুন (Start Free Exam)', 'Start Free Exam')}</span>
              </button>
            </div>
          ))}

          {/* Pro Tests Schedule Preview Card */}
          <div className="rounded-2xl border p-6 bg-gradient-to-br from-[#102A43] to-[#1A365D] text-white shadow-sm flex flex-col justify-between border-[#D4AF37]/50 relative overflow-hidden">
            <div className="absolute top-0 right-0 -translate-y-4 translate-x-4 w-32 h-32 bg-[#D4AF37]/10 rounded-full blur-xl pointer-events-none"></div>

            <div>
              <div className="flex items-center justify-between gap-2 mb-3">
                <span className="px-2.5 py-1 rounded-full text-xs font-bold flex items-center gap-1.5 bg-[#D4AF37] text-[#102A43]">
                  <Lock className="w-3.5 h-3.5" />
                  <span>{t('প্রো মডেল টেস্ট (২৯টি টেস্ট)', 'PRO MOCK TEST SUITE')}</span>
                </span>

                <span className="text-xs font-semibold text-[#D4AF37] bg-white/10 px-2.5 py-1 rounded-md">
                  {t('অ্যাডমিন নির্ধারিত দিনে লাইভ', 'Live on Scheduled Days')}
                </span>
              </div>

              <h3 className="text-lg font-bold text-white mb-2">
                {t('বার কাউন্সিল স্পেশাল মডেল টেস্ট ০২ থেকে ৩০', 'Bar Council Special Model Tests 02 to 30')}
              </h3>
              <p className="text-xs sm:text-sm text-slate-300 mb-5 leading-relaxed">
                {t(
                  'অ্যাডমিন প্যানেল থেকে নির্ধারিত তারিখে প্রতিদিনের লাইভ মডেল টেস্ট চালু করা হবে। শুধুমাত্র প্রো পরীক্ষার্থীরা নির্দিষ্ট দিনে লাইভ পরীক্ষায় অংশ নিতে পারবেন।',
                  'Full mock tests 02 to 30 are launched live by the Admin on scheduled dates. Pro members can access and take each test as it goes live.'
                )}
              </p>

              <div className="p-3.5 rounded-xl bg-white/10 border border-white/10 text-xs space-y-1.5 mb-6 text-slate-200">
                <div className="flex justify-between">
                  <span>{t('মোট প্রশ্ন সম্ভার:', 'Question Bank:')}</span>
                  <strong className="text-[#D4AF37]">{t('১০০ নম্বরের ৩০টি পূর্ণাঙ্গ মডেল টেস্ট', '30 Full Mock Tests')}</strong>
                </div>
                <div className="flex justify-between">
                  <span>{t('পরীক্ষা চালু নীতি:', 'Activation Policy:')}</span>
                  <strong className="text-white">{t('অ্যাডমিন নির্ধারিত দিনে উন্মুক্ত', 'Admin On-Demand Launch')}</strong>
                </div>
              </div>
            </div>

            <button
              onClick={() => setShowPaymentModal(true)}
              className="w-full py-3 rounded-xl font-bold text-sm transition flex items-center justify-center gap-2 bg-[#D4AF37] hover:bg-[#b89528] text-[#102A43] shadow-md cursor-pointer"
            >
              <Sparkles className="w-4 h-4 text-[#102A43]" />
              <span>{t('প্রো সাবস্ক্রিপশন পাস সংগ্রহ করুন (Upgrade to Pro)', 'Upgrade to Pro Access')}</span>
            </button>
          </div>
        </div>

        {/* Question Bank & Custom Model Test Feature Callout */}
        <div className="bg-gradient-to-r from-amber-500/10 via-[#102A43]/5 to-transparent rounded-3xl p-6 sm:p-8 border-2 border-[#D4AF37] shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="flex items-start gap-4">
            <div className="w-14 h-14 rounded-2xl bg-[#102A43] text-[#D4AF37] flex items-center justify-center shrink-0 shadow-md">
              <Sparkles className="w-7 h-7 text-[#D4AF37]" />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="px-2.5 py-0.5 rounded-full text-[10px] font-black bg-[#102A43] text-[#D4AF37] uppercase">
                  CUSTOM TEST MAKER
                </span>
                <span className="text-xs font-bold text-[#102A43]">
                  {t('৩,০০০+ প্রশ্নের বিশাল সম্ভার', '3,000+ Question Repository')}
                </span>
              </div>
              <h3 className="text-lg sm:text-xl font-black text-[#102A43]">
                {t('যে প্রশ্নগুলো প্রশ্ন সম্ভারে আছে সেগুলো থেকে আপনি নিজে মডেল টেস্ট নিতে পারবেন!', 'Create and take personalized model tests directly from the question bank!')}
              </h3>
              <p className="text-xs sm:text-sm text-slate-600 max-w-xl leading-relaxed">
                {t(
                  'প্রশ্ন সম্ভার ব্রাউজ করে নিজের পছন্দের প্রশ্নগুলো টিকচিহ্ন দিয়ে বাছাই করুন অথবা আইনসমূহ, প্রশ্নের সংখ্যা (১০/২৫/৫০/১০০) ও সময় নির্ধারণ করে এখনই কাস্টম মডেল টেস্ট শুরু করুন।',
                  'Pick questions individually or customize duration and quotas to take self-curated mock exams anytime.'
                )}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <button
              onClick={() => setActiveScreen('question_bank')}
              className="px-5 py-3 rounded-xl bg-white border border-slate-300 text-[#102A43] hover:bg-slate-50 font-bold text-xs sm:text-sm transition flex items-center gap-2 cursor-pointer shadow-xs"
            >
              <BookOpen className="w-4 h-4 text-[#102A43]" />
              <span>{t('প্রশ্ন সম্ভার খুলুন', 'Open Question Bank')}</span>
            </button>

            <button
              onClick={() => setActiveScreen('question_bank')}
              className="px-6 py-3 rounded-xl bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] border border-[#D4AF37] font-black text-xs sm:text-sm transition flex items-center gap-2 shadow-md cursor-pointer"
            >
              <Play className="w-4 h-4 fill-current text-[#D4AF37]" />
              <span>{t('কাস্টম টেস্ট শুরু করুন', 'Start Custom Test')}</span>
            </button>
          </div>
        </div>

      </section>

      {/* 7 Core Statutory Subjects Breakdown */}
      <section className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-bold text-[#D4AF37] uppercase tracking-wider block">
                {t('সিলেবাস কাঠামো', 'Syllabus Framework')}
              </span>
              <span className="px-2.5 py-0.5 rounded-full text-[10px] font-black bg-amber-100 text-amber-900 border border-amber-300 flex items-center gap-1">
                <Lock className="w-3 h-3 text-amber-700" />
                {t('পেইড সাবস্ক্রিপশন ফিচার', 'Paid Feature')}
              </span>
            </div>
            <h2 className="text-2xl sm:text-3xl font-extrabold text-[#102A43]">
              {t('৭টি মূল আইনের বিষয়ভিত্তিক অনুশীলন', '7 Core Bar Council Subject Categories')}
            </h2>
            <p className="text-xs sm:text-sm text-slate-500 mt-1">
              {t('অফিসিয়াল নম্বর বিন্যাস অনুযায়ী প্রতিটি কোড অধ্যয়ন করুন। এটাও পেইড করার পর অনুশীলন করতে পারবে।', 'Study each statutory code according to the official marks distribution. Unlocked for practice after activating a paid subscription.')}
            </p>
          </div>

          <button
            onClick={() => setActiveScreen('subjects')}
            className="text-xs sm:text-sm font-bold text-[#102A43] hover:text-[#D4AF37] flex items-center gap-1.5 transition cursor-pointer"
          >
            <span>{t('সবগুলো বিষয় ও অগ্রগতি দেখুন', 'View All Subjects & Progress')}</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {subjects.map((sub) => (
            <div 
              key={sub.id}
              className="p-5 rounded-2xl bg-white border border-slate-200 shadow-xs hover:border-[#102A43] transition flex flex-col justify-between group"
            >
              <div>
                <div className="flex items-center justify-between mb-3">
                  <span className="px-2 py-0.5 rounded text-xs font-mono font-bold bg-slate-100 text-[#102A43]">
                    {sub.code}
                  </span>
                  <div className="flex items-center gap-1.5">
                    {!isProSubscribed && (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-50 text-amber-800 border border-amber-200 flex items-center gap-1">
                        <Lock className="w-2.5 h-2.5" />
                        <span>PRO</span>
                      </span>
                    )}
                    <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-[#102A43] text-[#D4AF37]">
                      {sub.marksWeight} {t('নম্বর', 'Marks')}
                    </span>
                  </div>
                </div>

                <h4 className="font-bold text-sm text-[#102A43] mb-1 line-clamp-2">
                  {language === 'bn' ? sub.nameBn : sub.nameEn}
                </h4>
                <p className="text-[11px] font-mono text-slate-500 mb-4">
                  {sub.actTitle}
                </p>
              </div>

              <div className="pt-3 border-t border-slate-100 flex items-center justify-between">
                <span className="text-xs text-slate-500 font-semibold">
                  {sub.marksWeight} {t('নম্বর মান', 'Marks Weight')}
                </span>

                {isProSubscribed ? (
                  <button
                    onClick={() => startSubjectPractice(sub.id)}
                    className="px-3 py-1.5 rounded-lg bg-[#102A43] hover:bg-[#1E3A5F] text-[#D4AF37] text-xs font-bold transition flex items-center gap-1 cursor-pointer"
                  >
                    <BookOpen className="w-3.5 h-3.5" />
                    <span>{t('অনুশীলন', 'Practice')}</span>
                  </button>
                ) : (
                  <button
                    onClick={() => openSubscriptionModal()}
                    className="px-3 py-1.5 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-300 text-xs font-bold transition flex items-center gap-1 cursor-pointer"
                    title={t('এটাও পেইড করার পর অনুশীলন করতে পারবে', 'Practice unlocked after subscribing')}
                  >
                    <Lock className="w-3 h-3 text-amber-700" />
                    <span>{t('পেইড আনলক', 'Unlock Pro')}</span>
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Student Performance & Progress Features Section */}
      <section className="rounded-3xl bg-white border border-slate-200 p-8 sm:p-10 shadow-xs">
        <div className="max-w-3xl mx-auto text-center space-y-4 mb-10">
          <span className="text-xs font-bold text-[#D4AF37] uppercase tracking-wider bg-[#102A43] px-3 py-1 rounded-full">
            {t('দক্ষতা বৃদ্ধি ও অগ্রগতি', 'Performance Analytics')}
          </span>
          <h2 className="text-2xl sm:text-3xl font-extrabold text-[#102A43]">
            {t('আপনার প্রস্তুতির প্রতিটি ধাপে ধারাবাহিক মূল্যায়ন', 'Track Every Metric That Determines Your Result')}
          </h2>
          <p className="text-xs sm:text-sm text-slate-600">
            {t('পরীক্ষা শেষে নির্ভুল বিশ্লেষণ আপনাকে দুর্বল ক্ষেত্রগুলো দ্রুত চিহ্নিত করতে সাহায্য করে।', 'Immediate post-exam feedback highlights gaps across statutory sections.')}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="p-5 rounded-2xl bg-slate-50 border border-slate-200 text-center space-y-2">
            <div className="w-10 h-10 rounded-xl bg-[#102A43] text-[#D4AF37] flex items-center justify-center mx-auto mb-3">
              <BarChart3 className="w-5 h-5" />
            </div>
            <h4 className="font-bold text-slate-900 text-sm">{t('বিষয়ভিত্তিক ফলাফল বিশ্লেষণ', 'Subject-Wise Performance')}</h4>
            <p className="text-xs text-slate-600">
              {t('৭টি আইনের প্রতিটিতে কয়টি সঠিক, ভুল বা অনুত্তর হয়েছে তার পৃথক হিসাব।', 'Breakdown of correct, incorrect, and skipped counts for every Bare Act.')}
            </p>
          </div>

          <div className="p-5 rounded-2xl bg-slate-50 border border-slate-200 text-center space-y-2">
            <div className="w-10 h-10 rounded-xl bg-[#102A43] text-[#D4AF37] flex items-center justify-center mx-auto mb-3">
              <FileCheck2 className="w-5 h-5" />
            </div>
            <h4 className="font-bold text-slate-900 text-sm">{t('প্রশ্নোত্তর বিশদ সমাধান', 'Complete Answer Key Review')}</h4>
            <p className="text-xs text-slate-600">
              {t('আপনার প্রদত্ত উত্তর, সঠিক উত্তর এবং আইনের সুনির্দিষ্ট বিধান পাশাপাশি দেখার সুবিধা।', 'Review your selected option side-by-side with statutory explanations.')}
            </p>
          </div>

          <div className="p-5 rounded-2xl bg-slate-50 border border-slate-200 text-center space-y-2">
            <div className="w-10 h-10 rounded-xl bg-[#102A43] text-[#D4AF37] flex items-center justify-center mx-auto mb-3">
              <Award className="w-5 h-5" />
            </div>
            <h4 className="font-bold text-slate-900 text-sm">{t('ধারাবাহিক ইতিহাস ও ট্র্যাকিং', 'Historical Submission Archive')}</h4>
            <p className="text-xs text-slate-600">
              {t('পূর্ববর্তী সকল পরীক্ষার স্কোর ও সময় ব্যয়ের ইতিহাস স্থায়ীভাবে সংরক্ষিত।', 'Review past mock attempts to observe preparation trends and score growth.')}
            </p>
          </div>
        </div>
      </section>

      {/* Subscription Plans Section (Package A, B, C) */}
      <SubscriptionPlansSection />

      {/* Frequently Asked Questions Section (FAQ) */}
      <section className="max-w-4xl mx-auto space-y-6">
        <div className="text-center">
          <span className="text-xs font-bold text-[#D4AF37] uppercase tracking-wider bg-[#102A43] px-3 py-1 rounded-full">
            {t('সাধারণ জিজ্ঞাসা', 'FAQ')}
          </span>
          <h2 className="text-2xl sm:text-3xl font-extrabold text-[#102A43] mt-3">
            {t('সচরাচর জিজ্ঞাসিত প্রশ্নাবলী (FAQ)', 'Frequently Asked Questions')}
          </h2>
          <p className="text-xs sm:text-sm text-slate-500 mt-1">
            {t('বার কাউন্সিল পরীক্ষা ও Sanad Prep BD প্ল্যাটফর্ম সম্পর্কিত জরুরি তথ্যাবলী', 'Essential guidance regarding Bar Council exam rules and platform usage')}
          </p>
        </div>

        <div className="space-y-3">
          {faqs.map((faq, idx) => {
            const isOpen = openFaq === idx;
            return (
              <div 
                key={idx}
                className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs transition"
              >
                <button
                  onClick={() => toggleFaq(idx)}
                  className="w-full p-5 text-left flex items-center justify-between gap-4 font-bold text-sm sm:text-base text-[#102A43] hover:text-[#D4AF37] transition"
                >
                  <span>{language === 'bn' ? faq.qBn : faq.qEn}</span>
                  <span className="text-slate-400 shrink-0">
                    {isOpen ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
                  </span>
                </button>

                {isOpen && (
                  <div className="px-5 pb-5 pt-1 text-xs sm:text-sm text-slate-600 leading-relaxed border-t border-slate-100 bg-slate-50/50">
                    {language === 'bn' ? faq.aBn : faq.aEn}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Candidate Registration / Quick Start Banner */}
      <section className="rounded-3xl bg-[#102A43] text-white p-8 sm:p-12 text-center border border-[#243B53] space-y-5">
        <h3 className="text-2xl sm:text-4xl font-extrabold text-white">
          {language === 'bn' ? 'আজই আপনার প্রথম ৬০ মিনিটের মডেল টেস্ট দিন' : 'Take Your First 60-Minute Mock Test Today'}
        </h3>
        <p className="text-xs sm:text-base text-slate-300 max-w-xl mx-auto">
          {language === 'bn' 
            ? 'Sanad Prep BD প্ল্যাটফর্মের সাথে প্রতিটি আইন সহজে আয়ত্ত করুন এবং আত্মবিশ্বাসের সাথে পরীক্ষা হলে প্রবেশ করুন।'
            : 'Build statutory clarity, exam stamina, and time management before sitting for the enrollment exam.'}
        </p>

        <div className="pt-2">
          <button
            onClick={() => setActiveScreen('dashboard')}
            className="px-8 py-3.5 rounded-xl bg-[#D4AF37] hover:bg-[#b89528] text-[#102A43] font-black text-sm sm:text-base transition shadow-lg cursor-pointer"
          >
            {language === 'bn' ? 'স্টুডেন্ট ড্যাশবোর্ডে প্রবেশ করুন' : 'Access Student Dashboard'}
          </button>
        </div>
      </section>

    </div>
  );
};
