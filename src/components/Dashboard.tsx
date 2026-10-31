import React, { useMemo } from 'react';
import { useApp } from '../context/AppContext';
import { Logo } from './Logo';
import { SubscriptionPlansSection } from './SubscriptionPlansSection';
import { TopPerformersLeaderboard } from './TopPerformersLeaderboard';
import { WhatsAppSupportButton } from './WhatsAppSupportButton';
import { 
  Play, 
  Clock, 
  Award, 
  TrendingUp, 
  CheckCircle, 
  Lock, 
  ArrowRight, 
  HelpCircle,
  FileText,
  AlertTriangle,
  Scale,
  Sparkles,
  BookOpen,
  Target,
  Compass,
  CheckCircle2,
  Lightbulb,
  Crown,
  Calendar,
  Smartphone,
  RefreshCw,
  Zap
} from 'lucide-react';

export const Dashboard: React.FC = () => {
  const { 
    language, 
    t, 
    currentUser, 
    subjects, 
    exams, 
    examResults, 
    startExam, 
    startSubjectPractice,
    setActiveScreen, 
    viewResult,
    openSubscriptionModal,
    activeSubscription,
    calculateDaysRemaining,
    examDateConfig,
    isSessionRevoked,
    sessionRevokedReason,
    recoverSession,
    answeredQuestions,
    setShowCustomTestModal
  } = useApp();

  // Extract student first name
  const getFirstName = () => {
    const raw = currentUser.name;
    if (language === 'bn') {
      const match = raw.match(/খাইরুল|আলম|করিম|রহিম|[^\s(]+/);
      return match ? match[0] : raw.split(' ')[0];
    } else {
      const match = raw.match(/\(([^)]+)\)/);
      if (match) {
        return match[1].split(' ')[0];
      }
      return raw.split(' ')[0];
    }
  };

  const studentFirstName = getFirstName();

  // Calculate student statistics
  const totalAttempts = examResults.length;
  const avgScore = totalAttempts > 0 
    ? (examResults.reduce((acc, r) => acc + r.finalScore, 0) / totalAttempts).toFixed(1)
    : '0';

  const totalCorrect = examResults.reduce((acc, r) => acc + r.correctAnswersCount, 0);
  const totalIncorrect = examResults.reduce((acc, r) => acc + r.incorrectAnswersCount, 0);
  const accuracyRate = (totalCorrect + totalIncorrect) > 0 
    ? Math.round((totalCorrect / (totalCorrect + totalIncorrect)) * 100) 
    : 0;

  const practicedSubjectIds = new Set<string>();
  examResults.forEach(r => {
    Object.keys(r.subjectWiseScores || {}).forEach(subId => {
      if (r.subjectWiseScores[subId].total > 0) {
        practicedSubjectIds.add(subId);
      }
    });
  });
  Object.values(answeredQuestions || {}).forEach(rec => {
    if (rec.subjectId) {
      practicedSubjectIds.add(rec.subjectId);
    }
  });
  const studyProgressPct = Math.round((practicedSubjectIds.size / Math.max(1, subjects.length)) * 100);

  // Recommended practice
  let recommendedSubject = subjects[0];
  if (examResults.length > 0) {
    let lowestScoreRate = 999;
    for (const sub of subjects) {
      let subCorrect = 0;
      let subTotal = 0;
      examResults.forEach(r => {
        const stat = r.subjectWiseScores?.[sub.id];
        if (stat) {
          subCorrect += stat.correct;
          subTotal += stat.total;
        }
      });
      if (subTotal > 0) {
        const rate = subCorrect / subTotal;
        if (rate < lowestScoreRate) {
          lowestScoreRate = rate;
          recommendedSubject = sub;
        }
      }
    }
  }

  // User submission records map (examId -> ExamResult)
  const userTakenExamMap = useMemo(() => {
    const map = new Map<string, typeof examResults[0]>();
    examResults.forEach(r => map.set(r.examId, r));
    return map;
  }, [examResults]);

  const daysRemaining = activeSubscription ? calculateDaysRemaining(activeSubscription.expiresAt) : 0;
  const isSubscriptionActive = activeSubscription && daysRemaining > 0;

  // VISIBILITY LOGIC (USER REQUIREMENT):
  // 1. "শুধু ফ্রি মডেলে টেস্ট সবাই দেখতে পারবে" -> Free model test is visible to everyone
  // 2. "অ্যাডমিন প্যানেল থেকে যেদিন ইচ্ছা ওই দিন পরীক্ষা চালু করা হবে" -> Paid tests are visible ONLY when admin activates them (isActive === true)
  // 3. "যে ইউজার যেটি পরীক্ষা দিবে সেটি দেখতে পারবে" -> Student sees tests they are eligible to take or have already taken
  const visibleMockExams = useMemo(() => {
    return exams.filter(e => {
      if (e.type !== 'full_mock') return false;

      // 1. Free model test is always visible to everyone
      if (!e.isPaid) return true;

      // 2. If student has already taken this exam, keep it visible so they can review their result
      if (userTakenExamMap.has(e.id)) return true;

      // 3. For paid tests, visible to Pro subscribers ONLY when the Admin has activated it
      if (isSubscriptionActive) {
        return e.isActive === true;
      }

      // Non-pro users only see the free model test!
      return false;
    });
  }, [exams, isSubscriptionActive, userTakenExamMap]);

  return (
    <div className="space-y-8 pb-16">
      
      {/* Session Revocation Alert (Section 5 requirement) */}
      {isSessionRevoked && (
        <div className="p-4 sm:p-5 rounded-3xl bg-rose-50 border-2 border-rose-300 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-4 animate-in fade-in">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-2xl bg-rose-600 text-white flex items-center justify-center shrink-0">
              <Smartphone className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-rose-950 text-sm sm:text-base">
                {t('একাউন্ট শেয়ারিং সতর্কতা: সেশন বাতিল করা হয়েছে', 'Session Revoked: Account Sharing Protection')}
              </h3>
              <p className="text-xs text-rose-700 mt-0.5 leading-relaxed">
                {sessionRevokedReason || t(
                  'একই অ্যাকাউন্ট অন্য কোনো ডিভাইস থেকে ব্যবহার করা হচ্ছে। নিরাপত্তা বিধির কারণে আপনার পূর্ববর্তী সেশনটি বন্ধ করা হয়েছে।',
                  'Your account was authenticated on another device or tab. Previous session has been revoked.'
                )}
              </p>
            </div>
          </div>

          <button
            onClick={recoverSession}
            className="px-4 py-2 rounded-xl bg-rose-700 hover:bg-rose-800 text-white font-bold text-xs flex items-center gap-1.5 shrink-0 shadow-xs cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>{t('এই ডিভাইসে পুনরায় সেশন সক্রিয় করুন', 'Re-Authenticate Session')}</span>
          </button>
        </div>
      )}

      {/* Welcome Banner */}
      <div className="relative overflow-hidden rounded-3xl bg-[#102A43] text-white shadow-xl border border-[#243B53] p-6 sm:p-8">
        <div className="absolute right-0 top-0 translate-x-8 -translate-y-8 w-64 h-64 bg-[#D4AF37]/10 rounded-full blur-2xl pointer-events-none" />

        <div className="relative z-10 max-w-3xl">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#243B53] text-[#D4AF37] border border-[#D4AF37]/30 text-xs font-bold mb-3">
            <Sparkles className="w-3.5 h-3.5 text-[#D4AF37]" />
            <span>{t('সনদ প্রেপ বিডি স্টুডেন্ট পোর্টাল', 'Sanad Prep BD Student Portal')}</span>
          </div>

          <h1 className="text-2xl sm:text-4xl font-black tracking-tight text-white mb-2">
            {language === 'bn' ? `স্বাগতম, ${studentFirstName}!` : `Welcome, ${studentFirstName}!`}
          </h1>

          <p className="text-slate-300 text-xs sm:text-base leading-relaxed mb-6">
            {t(
              'অনুশীলনে দক্ষতা, প্রস্তুতিতে আত্মবিশ্বাস। ৬০ মিনিটের অফিসিয়াল লাইভ টাইমার এবং ১:০.২৫ নেগেটিভ মার্কিং ফরম্যাটে প্রস্তুতি নিন।',
              'Practice Smart. Become an Advocate. Prepare with strict 60-minute timed mock tests and exact 1:0.25 negative scoring.'
            )}
          </p>

          <div className="flex flex-wrap gap-3">
            <button
              onClick={() => {
                if (visibleMockExams.length > 0) {
                  startExam(visibleMockExams[0].id);
                }
              }}
              className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-[#D4AF37] hover:bg-[#b89528] text-[#102A43] font-black transition shadow-md shadow-[#D4AF37]/20 text-xs sm:text-sm cursor-pointer"
            >
              <Play className="w-4 h-4 fill-current" />
              <span>{t('৬০ মিনিটের পূর্ণাঙ্গ মডেল টেস্ট শুরু করুন', 'Start 60-Minute Mock Test')}</span>
            </button>

            <button
              onClick={() => setActiveScreen('subjects')}
              className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-[#243B53] hover:bg-[#1A365D] text-white font-bold border border-slate-600 transition text-xs sm:text-sm cursor-pointer"
            >
              <BookOpen className="w-4 h-4 text-[#D4AF37]" />
              <span>{t('আইনভিত্তিক অনুশীলন', 'Practice by Code')}</span>
            </button>

            <button
              onClick={() => setActiveScreen('question_bank')}
              className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-white/10 hover:bg-white/20 text-[#D4AF37] border border-[#D4AF37]/50 font-bold transition text-xs sm:text-sm cursor-pointer"
            >
              <Sparkles className="w-4 h-4 text-[#D4AF37]" />
              <span>{t('প্রশ্ন সম্ভার ও কাস্টম টেস্ট', 'Question Bank & Custom Tests')}</span>
            </button>

            <WhatsAppSupportButton 
              className="px-5 py-3"
            />
          </div>
        </div>
      </div>

      {/* NEW: Dedicated Question Bank & Custom Model Test Callout Card */}
      <div className="bg-gradient-to-r from-amber-500/10 via-[#102A43]/5 to-transparent rounded-3xl p-6 border-2 border-[#D4AF37] shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-5">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-2xl bg-[#102A43] text-[#D4AF37] flex items-center justify-center shrink-0 shadow-sm mt-0.5">
            <Sparkles className="w-6 h-6 text-[#D4AF37]" />
          </div>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="px-2.5 py-0.5 rounded-full text-[10px] font-black bg-[#102A43] text-[#D4AF37] uppercase">
                NEW FEATURE
              </span>
              <span className="text-xs font-bold text-[#102A43]">
                {t('৩,০০০+ প্রশ্নের সমৃদ্ধ সংগ্রহশালা', '3,000+ Question Repository')}
              </span>
            </div>
            <h3 className="text-base sm:text-lg font-black text-[#102A43]">
              {t('প্রশ্ন সম্ভার থেকে নিজের মতো করে মডেল টেস্ট দিন', 'Take Self-Curated Model Tests from Question Bank')}
            </h3>
            <p className="text-xs sm:text-sm text-slate-600 max-w-xl">
              {t(
                'প্রশ্ন সম্ভারের প্রশ্নসমূহ ব্রাউজ করে টিকচিহ্ন দিয়ে বাছাই করুন অথবা আপনার সুবিধাজনক আইন, প্রশ্নের সংখ্যা (১০/২৫/৫০/১০০) ও সময় নির্ধারণ করে এখনই কাস্টম মডেল টেস্ট শুরু করুন।',
                'Pick specific questions or configure a custom test by legal subjects, question quota, and time limit.'
              )}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            onClick={() => setActiveScreen('question_bank')}
            className="px-4 py-2.5 rounded-xl bg-white border border-slate-300 text-[#102A43] hover:bg-slate-50 font-bold text-xs transition flex items-center gap-1.5 cursor-pointer shadow-xs"
          >
            <BookOpen className="w-3.5 h-3.5 text-[#102A43]" />
            <span>{t('প্রশ্ন সম্ভার খুলুন', 'Browse Repository')}</span>
          </button>

          <button
            onClick={() => setShowCustomTestModal(true)}
            className="px-5 py-2.5 rounded-xl bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] border border-[#D4AF37] font-black text-xs transition flex items-center gap-1.5 cursor-pointer shadow-sm"
          >
            <Play className="w-3.5 h-3.5 fill-current text-[#D4AF37]" />
            <span>{t('কাস্টম টেস্ট শুরু করুন', 'Start Custom Test')}</span>
          </button>
        </div>
      </div>

      {/* SECTION 4 REQUIREMENT: Dedicated Active / Expired / Free Subscription Card */}
      <div className={`rounded-3xl border-2 p-5 sm:p-6 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-5 relative overflow-hidden ${
        isSubscriptionActive 
          ? 'bg-white border-slate-200' 
          : currentUser.subscriptionStatus === 'expired'
            ? 'bg-amber-50/50 border-amber-300'
            : 'bg-white border-slate-200'
      }`}>
        <div className="flex items-start gap-4">
          <div className={`w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 ${
            isSubscriptionActive 
              ? 'bg-[#102A43] text-[#D4AF37]' 
              : currentUser.subscriptionStatus === 'expired'
                ? 'bg-amber-100 text-amber-700'
                : 'bg-slate-100 text-slate-400'
          }`}>
            <Crown className="w-6 h-6" />
          </div>

          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className={`px-2.5 py-0.5 rounded-full text-xs font-bold uppercase tracking-wider ${
                isSubscriptionActive 
                  ? 'bg-emerald-100 text-emerald-800 border border-emerald-200' 
                  : currentUser.subscriptionStatus === 'expired'
                    ? 'bg-rose-100 text-rose-800 border border-rose-200'
                    : 'bg-slate-100 text-slate-600'
              }`}>
                {isSubscriptionActive 
                  ? t('সক্রিয় সাবস্ক্রিপশন (PRO PASS ACTIVE)', 'PRO PASS ACTIVE') 
                  : currentUser.subscriptionStatus === 'expired'
                    ? t('সাবস্ক্রিপশনের মেয়াদ উত্তীর্ণ (EXPIRED)', 'PASS EXPIRED')
                    : t('ফ্রি ট্রায়াল একাউন্ট (FREE TIER)', 'FREE TIER')}
              </span>

              {isSubscriptionActive && (
                <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 text-xs font-mono font-bold flex items-center gap-1">
                  <Clock className="w-3 h-3 text-[#D4AF37]" />
                  <span>{daysRemaining} {t('দিন বাকি', 'days left')}</span>
                </span>
              )}
            </div>

            <h3 className="text-lg sm:text-xl font-black text-[#102A43]">
              {isSubscriptionActive 
                ? (language === 'bn' ? activeSubscription.packageNameBn : activeSubscription.packageNameEn)
                : currentUser.subscriptionStatus === 'expired'
                  ? t('আপনার পূর্ববর্তী পাসের মেয়াদ শেষ হয়েছে', 'Your Previous Pass Has Expired')
                  : t('সনদ প্রেপ বিডি ফ্রি এক্সেস', 'Sanad Prep BD Free Access')}
            </h3>

            {isSubscriptionActive ? (
              <div className="flex flex-wrap gap-4 text-xs text-slate-600 pt-1">
                <span>{t('ক্রয়ের তারিখ:', 'Purchased:')} <strong>{new Date(activeSubscription.activatedAt).toLocaleDateString()}</strong></span>
                <span>{t('মেয়াদোত্তীর্ণ তারিখ:', 'Expires:')} <strong className="text-emerald-800">{new Date(activeSubscription.expiresAt).toLocaleDateString()}</strong> ({examDateConfig.timezone})</span>
                <span>{t('পেমেন্ট TrxID:', 'TrxID:')} <strong className="font-mono text-[#102A43]">{activeSubscription.transactionId}</strong></span>
              </div>
            ) : currentUser.subscriptionStatus === 'expired' ? (
              <p className="text-xs text-amber-900">
                {t(
                  'পেইড MCQ ব্যাংক ও ৬০ মিনিটের লাইভ মডেল টেস্টের সুবিধা বন্ধ রয়েছে। প্রবেশাধিকার পুনরায় চালু করতে অনুগ্রহ করে সাবস্ক্রিপশন রিনিউ করুন।',
                  'Access to paid MCQs and full-length mock tests is locked. Please renew to continue preparation.'
                )}
              </p>
            ) : (
              <p className="text-xs text-slate-500">
                {t(
                  'সকল ১০০ নম্বরের পূর্ণাঙ্গ মডেল টেস্ট ও আনলিমিটেড প্র্যাকটিস আনলক করতে আপনার পছন্দমতো পাস বেছে নিন।',
                  'Upgrade to Pro Model Test Pass, Long Course Pass, or Bar Council Exam Pass to unlock all timed 100-mark tests.'
                )}
              </p>
            )}
          </div>
        </div>

        <div className="shrink-0 flex items-center gap-3">
          <button
            onClick={() => openSubscriptionModal()}
            className="w-full sm:w-auto px-5 py-2.5 rounded-xl bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] border border-[#D4AF37] font-bold text-xs sm:text-sm transition flex items-center justify-center gap-1.5 cursor-pointer shadow-xs"
          >
            <Crown className="w-4 h-4 text-[#D4AF37]" />
            <span>
              {isSubscriptionActive 
                ? t('প্ল্যান পরিবর্তন / বৃদ্ধি', 'Change / Extend Plan') 
                : currentUser.subscriptionStatus === 'expired'
                  ? t('পুনরায় রিনিউ করুন', 'Renew Subscription')
                  : t('প্রো সাবস্ক্রিপশন কিনুন', 'Upgrade to Pro Pass')}
            </span>
          </button>
        </div>
      </div>

      {/* Metrics Row: Tests Completed, Avg Score, Accuracy Rate, Study Progress */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        
        {/* Total Completed Tests */}
        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs flex items-center space-x-4">
          <div className="w-12 h-12 rounded-xl bg-slate-100 text-[#102A43] flex items-center justify-center shrink-0">
            <FileText className="w-6 h-6" />
          </div>
          <div>
            <p className="text-xs text-slate-500 font-semibold uppercase tracking-wider">{t('সম্পন্ন পরীক্ষা', 'Tests Completed')}</p>
            <p className="text-2xl font-black text-[#102A43] mt-0.5">{totalAttempts}</p>
          </div>
        </div>

        {/* Average Score */}
        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs flex items-center space-x-4">
          <div className="w-12 h-12 rounded-xl bg-emerald-50 text-emerald-700 flex items-center justify-center shrink-0">
            <TrendingUp className="w-6 h-6" />
          </div>
          <div>
            <p className="text-xs text-slate-500 font-semibold uppercase tracking-wider">{t('গড় স্কোর (মার্কস)', 'Average Score')}</p>
            <p className="text-2xl font-black text-emerald-800 mt-0.5 font-mono">{avgScore}</p>
          </div>
        </div>

        {/* Accuracy Rate */}
        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs flex items-center space-x-4">
          <div className="w-12 h-12 rounded-xl bg-amber-50 text-[#D4AF37] flex items-center justify-center shrink-0">
            <Target className="w-6 h-6 text-amber-600" />
          </div>
          <div>
            <p className="text-xs text-slate-500 font-semibold uppercase tracking-wider">{t('নির্ভুলতার হার', 'Accuracy Rate')}</p>
            <p className="text-2xl font-black text-[#102A43] mt-0.5 font-mono">{accuracyRate}%</p>
          </div>
        </div>

        {/* Study Progress */}
        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs flex items-center space-x-4">
          <div className="w-12 h-12 rounded-xl bg-[#243B53]/10 text-[#102A43] flex items-center justify-center shrink-0">
            <Compass className="w-6 h-6 text-[#102A43]" />
          </div>
          <div>
            <p className="text-xs text-slate-500 font-semibold uppercase tracking-wider">{t('সিলেবাস কভারেজ', 'Study Progress')}</p>
            <p className="text-2xl font-black text-[#102A43] mt-0.5 font-mono">{studyProgressPct}%</p>
          </div>
        </div>

      </div>

      {/* Available 60-Minute Mock Tests */}
      <section className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h2 className="text-xl font-bold text-[#102A43] tracking-tight flex items-center gap-2">
              <span>{t('উপলব্ধ ৬০ মিনিটের মডেল টেস্টসমূহ', 'Available 60-Minute Mock Tests')}</span>
              <span className="px-2 py-0.5 rounded-full bg-slate-100 text-[#102A43] text-xs font-mono font-bold">
                {visibleMockExams.length}
              </span>
            </h2>
            <p className="text-xs sm:text-sm text-slate-500">
              {t('বার কাউন্সিলের অফিসিয়াল পরীক্ষার অনুরূপ সময় ও নেগেটিভ মার্কিং', 'Official 60-minute duration with server-timed countdown')}
            </p>
          </div>

          <div className="flex items-center gap-3 text-xs text-slate-500">
            <button
              onClick={() => setShowCustomTestModal(true)}
              className="px-3.5 py-1.5 rounded-xl bg-amber-50 hover:bg-amber-100 text-[#102A43] border border-[#D4AF37] font-bold text-xs transition flex items-center gap-1.5 cursor-pointer shadow-xs"
            >
              <Sparkles className="w-3.5 h-3.5 text-[#D4AF37]" />
              <span>{t('+ নিজস্ব টেস্ট তৈরি করুন', '+ Create Custom Test')}</span>
            </button>

            {isSubscriptionActive ? (
              <span className="text-emerald-700 font-semibold flex items-center gap-1">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                <span>{t('প্রো এক্সেস সক্রিয়: অ্যাডমিন নির্ধারিত লাইভ পরীক্ষা দৃশ্যমান', 'Pro Access Active')}</span>
              </span>
            ) : (
              <span className="text-amber-800 font-semibold flex items-center gap-1">
                <Sparkles className="w-3.5 h-3.5 text-amber-600" />
                <span>{t('ফ্রি ডেমো টেস্ট উন্মুক্ত', 'Free Demo Test Open for All')}</span>
              </span>
            )}
          </div>
        </div>

        {/* Mock Exam Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {visibleMockExams.map((exam) => {
            const takenResult = userTakenExamMap.get(exam.id);
            const isCompleted = !!takenResult;
            const isLive = exam.isActive === true;

            return (
              <div 
                key={exam.id} 
                className={`p-5 rounded-3xl border transition flex flex-col justify-between ${
                  isCompleted 
                    ? 'bg-emerald-50/20 border-emerald-200 shadow-xs' 
                    : isLive && exam.isPaid
                      ? 'bg-white border-[#D4AF37] ring-1 ring-[#D4AF37]/40 shadow-sm'
                      : 'bg-white border-slate-200 shadow-xs hover:border-[#D4AF37]/50'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2">
                      <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-slate-100 text-[#102A43]">
                        FULL MOCK
                      </span>

                      {/* State Badges */}
                      {isCompleted ? (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-200 flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                          <span>{t('সম্পন্ন', 'Completed')}</span>
                        </span>
                      ) : !exam.isPaid ? (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-100 text-blue-800 border border-blue-200 flex items-center gap-1">
                          <Award className="w-3 h-3 text-blue-600" />
                          <span>{t('সবার জন্য ফ্রি', 'Free Demo')}</span>
                        </span>
                      ) : isLive ? (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300 flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-600 animate-pulse"></span>
                          <span>{t('আজকের লাইভ পরীক্ষা', 'Live Exam Today')}</span>
                        </span>
                      ) : null}
                    </div>

                    <span className="text-xs font-mono font-bold text-slate-500 flex items-center gap-1 bg-slate-50 px-2 py-0.5 rounded-lg border border-slate-100">
                      <Clock className="w-3.5 h-3.5 text-[#D4AF37]" />
                      <span>{exam.durationMinutes} {t('মিনিট', 'mins')}</span>
                    </span>
                  </div>

                  <h3 className="font-bold text-slate-900 text-base mb-1">
                    {language === 'bn' ? exam.titleBn : exam.titleEn}
                  </h3>

                  <p className="text-xs text-slate-500 mb-3 line-clamp-2">
                    {language === 'bn' ? exam.descriptionBn : exam.descriptionEn}
                  </p>

                  {/* Previous Result Summary if completed */}
                  {isCompleted && (
                    <div className="p-3 rounded-2xl bg-white border border-emerald-200 mb-3 text-xs flex items-center justify-between">
                      <div>
                        <span className="text-slate-500 block text-[11px]">{t('আপনার অর্জিত স্কোর:', 'Your Score:')}</span>
                        <strong className="text-emerald-800 font-mono text-sm">
                          {takenResult.finalScore} / {takenResult.totalQuestions} ({takenResult.percentage}%)
                        </strong>
                      </div>
                      <div className="text-right">
                        <span className="text-slate-400 block text-[10px]">
                          {new Date(takenResult.submittedAt).toLocaleDateString()}
                        </span>
                        <span className={`font-bold text-[11px] ${takenResult.passed ? 'text-emerald-600' : 'text-amber-700'}`}>
                          {takenResult.passed ? t('উত্তীর্ণ (PASSED)', 'PASSED') : t('পুনর্বিবেচনা (REVIEW)', 'REVIEW')}
                        </span>
                      </div>
                    </div>
                  )}
                </div>

                <div className="pt-3 border-t border-slate-100 flex items-center justify-between">
                  <div className="text-xs text-slate-500 flex items-center gap-3">
                    <span>{exam.questionIds.length} {t('প্রশ্ন', 'MCQs')}</span>
                    <span>-{exam.negativeMarkRatio} {t('নেগেটিভ', 'Negative')}</span>
                  </div>

                  {isCompleted ? (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => viewResult(takenResult.id)}
                        className="px-3.5 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold transition flex items-center gap-1.5 cursor-pointer"
                      >
                        <FileText className="w-3.5 h-3.5 text-[#102A43]" />
                        <span>{t('ফলাফল দেখুন', 'View Result')}</span>
                      </button>

                      <button
                        onClick={() => startExam(exam.id)}
                        className="px-3.5 py-2 rounded-xl bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] text-xs font-bold transition flex items-center gap-1 cursor-pointer"
                        title={t('পুনরায় পরীক্ষা দিন', 'Retake Exam')}
                      >
                        <RefreshCw className="w-3 h-3" />
                        <span>{t('পুনরায় দিন', 'Retake')}</span>
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => startExam(exam.id)}
                      className="px-4 py-2 rounded-xl bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] text-xs font-bold transition flex items-center gap-1.5 cursor-pointer shadow-xs"
                    >
                      <Play className="w-3.5 h-3.5 fill-current" />
                      <span>{t('পরীক্ষা দিন', 'Start Exam')}</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Free Tier Teaser Card */}
        {(!isSubscriptionActive && currentUser.subscriptionStatus !== 'pro') && (
          <div className="p-5 rounded-3xl bg-gradient-to-r from-[#102A43] to-[#243B53] text-white border border-[#D4AF37]/40 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-4 mt-2">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="px-2.5 py-0.5 rounded-full bg-[#D4AF37] text-[#102A43] text-[10px] font-black uppercase">
                  PRO PASS
                </span>
                <span className="text-xs text-[#D4AF37] font-semibold">
                  {t('বাকি ২৯টি পূর্ণাঙ্গ মডেল টেস্ট', 'Remaining 29 Full Mock Tests')}
                </span>
              </div>
              <h4 className="font-bold text-sm sm:text-base text-white">
                {t('অ্যাডমিন কর্তৃক নির্ধারিত দিনে প্রতিদিনের লাইভ মডেল টেস্ট অনুষ্ঠিত হবে', 'Daily live mock tests will be opened on scheduled dates by the Admin')}
              </h4>
              <p className="text-xs text-slate-300">
                {t('সকল ৬০ মিনিটের পূর্ণাঙ্গ মডেল টেস্টে অংশ নিতে এবং রিয়েলটাইম মেরিট লিস্ট দেখতে প্রো প্যাকেজ আনলক করুন।', 'Upgrade to Pro to participate in all scheduled 60-minute mock tests.')}
              </p>
            </div>
            <button
              onClick={() => openSubscriptionModal()}
              className="px-5 py-2.5 rounded-xl bg-[#D4AF37] hover:bg-[#b89528] text-[#102A43] font-bold text-xs shrink-0 cursor-pointer transition shadow-sm"
            >
              {t('প্রো প্যাকেজ আনলক করুন', 'Unlock Pro Access')}
            </button>
          </div>
        )}
      </section>

      {/* Top Performers Merit Leaderboard (Firestore Tracked & Synced) */}
      <section className="space-y-4">
        <TopPerformersLeaderboard />
      </section>

      {/* The 3 Subscription Plans Section (Embedded on Dashboard) */}
      <SubscriptionPlansSection
        className="pt-4"
        titleBn="বার কাউন্সিল প্রস্তুতি সাবস্ক্রিপশন প্যাকেজসমূহ"
        titleEn="Bar Council Enrollment Subscription Passes"
        subtitleBn="প্রো মডেল টেস্ট পাস, লং কোর্স পাস এবং বার কাউন্সিল এক্সাম পাস থেকে আপনার প্রয়োজনীয় প্যাকেজটি বেছে নিন।"
        subtitleEn="Choose from Pro Model Test Pass (300 BDT), Long Course Pass (999 BDT), and Bar Council Exam Pass."
      />

    </div>
  );
};
