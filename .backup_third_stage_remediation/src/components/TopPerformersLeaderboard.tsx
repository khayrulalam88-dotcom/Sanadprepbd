import React, { useState, useMemo } from 'react';
import { useApp } from '../context/AppContext';
import { LeaderboardEntry } from '../types';
import { 
  Trophy, 
  Medal, 
  Crown, 
  Flame, 
  Clock, 
  CheckCircle2, 
  TrendingUp, 
  Award, 
  Search, 
  Sparkles, 
  UserCheck, 
  Calendar,
  Layers,
  ChevronRight,
  Filter
} from 'lucide-react';

interface Props {
  className?: string;
  limitEntries?: number;
  showPodiumOnly?: boolean;
}

export const TopPerformersLeaderboard: React.FC<Props> = ({ 
  className = '', 
  limitEntries,
  showPodiumOnly = false 
}) => {
  const { 
    language, 
    t, 
    currentUser, 
    leaderboardEntries, 
    exams, 
    startExam,
    openSubscriptionModal,
    activeSubscription
  } = useApp();

  const [selectedExamId, setSelectedExamId] = useState<string>('all');
  const [selectedTimeframe, setSelectedTimeframe] = useState<'all' | 'week'>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Filtered and sorted leaderboard entries
  const filteredEntries = useMemo(() => {
    let list = [...leaderboardEntries];

    // Filter by Exam
    if (selectedExamId !== 'all') {
      list = list.filter(e => e.examId === selectedExamId);
    }

    // Filter by Timeframe (This Week vs All Time)
    if (selectedTimeframe === 'week') {
      const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      list = list.filter(e => new Date(e.completedAt).getTime() >= oneWeekAgo);
    }

    // Filter by Search Query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(e => 
        e.studentName.toLowerCase().includes(q) || 
        e.examTitleBn.toLowerCase().includes(q) ||
        e.examTitleEn.toLowerCase().includes(q)
      );
    }

    // Sort by Score DESC, then Time ASC
    list.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.timeSpentSeconds - b.timeSpentSeconds;
    });

    // Assign actual ranks
    const ranked = list.map((entry, index) => ({
      ...entry,
      rank: index + 1
    }));

    if (limitEntries) {
      return ranked.slice(0, limitEntries);
    }

    return ranked;
  }, [leaderboardEntries, selectedExamId, selectedTimeframe, searchQuery, limitEntries]);

  // Top 3 for Podium
  const top1 = filteredEntries[0] || null;
  const top2 = filteredEntries[1] || null;
  const top3 = filteredEntries[2] || null;

  // Remaining entries (Rank 4+)
  const restEntries = filteredEntries.slice(3);

  // Check if current user is in leaderboard
  const currentUserRankEntry = useMemo(() => {
    return filteredEntries.find(e => e.userId === currentUser.uid);
  }, [filteredEntries, currentUser.uid]);

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins} মি. ${secs < 10 ? '0' : ''}${secs} সে.`;
  };

  const formatDate = (dateStr: string) => {
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString(language === 'bn' ? 'bn-BD' : 'en-US', {
        month: 'short',
        day: 'numeric'
      });
    } catch {
      return dateStr;
    }
  };

  return (
    <div className={`rounded-3xl bg-white border border-slate-200/90 shadow-sm p-6 sm:p-8 space-y-6 ${className}`}>
      
      {/* Header Section */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-100 pb-5">
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <span className="px-3 py-0.5 rounded-full text-xs font-black bg-[#102A43] text-[#D4AF37] uppercase tracking-wider flex items-center gap-1.5">
              <Trophy className="w-3.5 h-3.5 text-[#D4AF37]" />
              {t('মেধা তালিকা ও শীর্ষ ফলাফল', 'Top Performers Leaderboard')}
            </span>
            <span className="text-xs font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200 flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-600 animate-pulse" />
              {t('লাইভ ফায়ারবেস ট্র্যাকিং', 'Live Firestore Synced')}
            </span>
          </div>

          <h2 className="text-xl sm:text-2xl font-black text-[#102A43] tracking-tight">
            {t('মডেল টেস্টের শীর্ষ পরীক্ষার্থী ও মেধা অবস্থান', 'Model Test Top Achievers & Merit Standing')}
          </h2>
          <p className="text-xs sm:text-sm text-slate-500">
            {t('বার কাউন্সিলের অফিসিয়াল নম্বর পদ্ধতি (প্রতি ভুল উত্তরে -০.২৫ কর্তন) অনুযায়ী পরীক্ষার্থীদের লাইভ র‍্যাংকিং', 'Live ranks calculated with official Bar Council standard (1.00 mark per correct, -0.25 per wrong answer)')}
          </p>
        </div>

        {/* Current User Quick Rank Pill */}
        {currentUserRankEntry && (
          <div className="bg-gradient-to-r from-[#102A43] to-[#1E3A5F] text-white p-3.5 rounded-2xl flex items-center gap-3 shadow-xs border border-[#D4AF37]/30 shrink-0">
            <div className="w-10 h-10 rounded-xl bg-[#D4AF37] text-[#102A43] font-black text-lg flex items-center justify-center shrink-0">
              #{currentUserRankEntry.rank}
            </div>
            <div>
              <div className="text-[11px] text-slate-300 font-medium">{t('আপনার বর্তমান মেধা ক্রম', 'Your Current Rank')}</div>
              <div className="text-sm font-extrabold text-[#D4AF37]">
                {currentUserRankEntry.score} / {currentUserRankEntry.totalMarks} {t('নম্বর', 'Marks')}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Filters and Controls Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-50 p-3 rounded-2xl border border-slate-200/80">
        <div className="flex flex-wrap items-center gap-2">
          {/* Exam Filter */}
          <div className="flex items-center gap-1.5 bg-white px-3 py-1.5 rounded-xl border border-slate-200 text-xs text-slate-700">
            <Layers className="w-3.5 h-3.5 text-slate-500" />
            <select
              value={selectedExamId}
              onChange={(e) => setSelectedExamId(e.target.value)}
              className="bg-transparent font-bold outline-none cursor-pointer pr-2 text-slate-800"
            >
              <option value="all">{t('সকল মডেল টেস্ট (All Mocks)', 'All Model Tests')}</option>
              {exams.map(exam => (
                <option key={exam.id} value={exam.id}>
                  {language === 'bn' ? exam.titleBn : exam.titleEn}
                </option>
              ))}
            </select>
          </div>

          {/* Timeframe Filter */}
          <div className="flex items-center bg-white p-0.5 rounded-xl border border-slate-200 text-xs">
            <button
              onClick={() => setSelectedTimeframe('all')}
              className={`px-3 py-1.5 rounded-lg font-bold transition cursor-pointer ${
                selectedTimeframe === 'all' 
                  ? 'bg-[#102A43] text-white' 
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {t('সর্বকালের সেরা', 'All-Time')}
            </button>
            <button
              onClick={() => setSelectedTimeframe('week')}
              className={`px-3 py-1.5 rounded-lg font-bold transition cursor-pointer ${
                selectedTimeframe === 'week' 
                  ? 'bg-[#102A43] text-white' 
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {t('এই সপ্তাহে', 'This Week')}
            </button>
          </div>
        </div>

        {/* Candidate Search */}
        <div className="relative min-w-[200px]">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder={t('নাম লিখে খুঁজুন...', 'Search candidate...')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-white pl-8 pr-3 py-1.5 text-xs rounded-xl border border-slate-200 outline-none focus:border-[#102A43] font-medium"
          />
        </div>
      </div>

      {/* TOP 3 PODIUM DISPLAY */}
      {filteredEntries.length >= 3 && (
        <div className="pt-4 pb-2">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end max-w-4xl mx-auto">
            
            {/* 2ND PLACE (SILVER) */}
            {top2 && (
              <div className="order-2 md:order-1 bg-gradient-to-t from-slate-100 to-white rounded-3xl p-5 border-2 border-slate-300 shadow-xs flex flex-col items-center text-center relative pt-8 hover:-translate-y-1 transition duration-200">
                <div className="absolute -top-5 w-10 h-10 rounded-full bg-gradient-to-b from-slate-200 to-slate-400 text-white font-black text-sm flex items-center justify-center shadow-md border-2 border-white ring-2 ring-slate-300">
                  2
                </div>
                <div className="w-14 h-14 rounded-full bg-slate-200 text-slate-700 flex items-center justify-center font-black text-xl mb-3 shadow-inner">
                  {top2.studentName.charAt(0)}
                </div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 bg-slate-200/80 px-2 py-0.5 rounded-full mb-1">
                  {t('২য় স্থান (Silver)', '2nd Place • Silver')}
                </span>
                <h4 className="font-extrabold text-[#102A43] text-sm line-clamp-1 mb-1">
                  {top2.studentName}
                </h4>
                <div className="text-xl font-black text-slate-800 font-mono mb-2">
                  {top2.score} <span className="text-xs text-slate-500 font-normal">/ {top2.totalMarks}</span>
                </div>
                <div className="w-full pt-3 border-t border-slate-200/70 grid grid-cols-2 text-[11px] text-slate-600 gap-1">
                  <div>
                    <span className="text-slate-400 block">{t('নির্ভুলতা', 'Accuracy')}</span>
                    <strong className="text-emerald-700 font-bold">{top2.percentage}%</strong>
                  </div>
                  <div>
                    <span className="text-slate-400 block">{t('সময়', 'Time')}</span>
                    <strong className="text-slate-700 font-bold">{formatDuration(top2.timeSpentSeconds)}</strong>
                  </div>
                </div>
              </div>
            )}

            {/* 1ST PLACE (GOLD PODIUM - TALLER) */}
            {top1 && (
              <div className="order-1 md:order-2 bg-gradient-to-b from-[#FFFDF0] via-white to-amber-50/40 rounded-3xl p-6 border-2 border-[#D4AF37] shadow-lg flex flex-col items-center text-center relative pt-9 -mt-2 md:-mt-6 ring-4 ring-[#D4AF37]/20 hover:-translate-y-1 transition duration-200">
                <div className="absolute -top-6 w-12 h-12 rounded-full bg-gradient-to-tr from-[#D4AF37] to-amber-300 text-[#102A43] font-black text-base flex items-center justify-center shadow-lg border-2 border-white ring-2 ring-[#D4AF37]">
                  <Crown className="w-6 h-6 text-[#102A43] fill-current" />
                </div>
                <div className="w-16 h-16 rounded-full bg-[#102A43] text-[#D4AF37] flex items-center justify-center font-black text-2xl mb-3 ring-4 ring-[#D4AF37]/40 shadow-md">
                  {top1.studentName.charAt(0)}
                </div>
                <span className="text-[11px] font-black uppercase tracking-wider text-[#102A43] bg-[#D4AF37] px-3 py-0.5 rounded-full mb-1 flex items-center gap-1 shadow-xs">
                  <Sparkles className="w-3 h-3 text-[#102A43]" />
                  {t('১ম স্থান (Top Performer)', 'Champion • 1st Place')}
                </span>
                <h4 className="font-black text-[#102A43] text-base line-clamp-1 mb-1">
                  {top1.studentName}
                </h4>
                <div className="text-2xl font-black text-emerald-800 font-mono mb-2">
                  {top1.score} <span className="text-xs text-slate-500 font-normal">/ {top1.totalMarks}</span>
                </div>
                <div className="w-full pt-3 border-t border-amber-200/80 grid grid-cols-2 text-[11px] text-slate-700 gap-1 bg-amber-50/60 p-2 rounded-xl">
                  <div>
                    <span className="text-slate-500 block">{t('নির্ভুলতা', 'Accuracy')}</span>
                    <strong className="text-emerald-800 font-extrabold">{top1.percentage}%</strong>
                  </div>
                  <div>
                    <span className="text-slate-500 block">{t('সময়', 'Time')}</span>
                    <strong className="text-[#102A43] font-extrabold">{formatDuration(top1.timeSpentSeconds)}</strong>
                  </div>
                </div>
              </div>
            )}

            {/* 3RD PLACE (BRONZE) */}
            {top3 && (
              <div className="order-3 md:order-3 bg-gradient-to-t from-amber-100/40 to-white rounded-3xl p-5 border-2 border-amber-300 shadow-xs flex flex-col items-center text-center relative pt-8 hover:-translate-y-1 transition duration-200">
                <div className="absolute -top-5 w-10 h-10 rounded-full bg-gradient-to-b from-amber-600 to-amber-700 text-white font-black text-sm flex items-center justify-center shadow-md border-2 border-white ring-2 ring-amber-400">
                  3
                </div>
                <div className="w-14 h-14 rounded-full bg-amber-100 text-amber-900 flex items-center justify-center font-black text-xl mb-3 shadow-inner">
                  {top3.studentName.charAt(0)}
                </div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-amber-800 bg-amber-100 px-2 py-0.5 rounded-full mb-1">
                  {t('৩য় স্থান (Bronze)', '3rd Place • Bronze')}
                </span>
                <h4 className="font-extrabold text-[#102A43] text-sm line-clamp-1 mb-1">
                  {top3.studentName}
                </h4>
                <div className="text-xl font-black text-amber-900 font-mono mb-2">
                  {top3.score} <span className="text-xs text-slate-500 font-normal">/ {top3.totalMarks}</span>
                </div>
                <div className="w-full pt-3 border-t border-amber-200/70 grid grid-cols-2 text-[11px] text-slate-600 gap-1">
                  <div>
                    <span className="text-slate-400 block">{t('নির্ভুলতা', 'Accuracy')}</span>
                    <strong className="text-emerald-700 font-bold">{top3.percentage}%</strong>
                  </div>
                  <div>
                    <span className="text-slate-400 block">{t('সময়', 'Time')}</span>
                    <strong className="text-slate-700 font-bold">{formatDuration(top3.timeSpentSeconds)}</strong>
                  </div>
                </div>
              </div>
            )}

          </div>
        </div>
      )}

      {/* FULL RANKINGS LIST / TABLE */}
      {!showPodiumOnly && (
        <div className="space-y-3 pt-2">
          <div className="flex items-center justify-between text-xs text-slate-500 font-semibold px-2">
            <span>{t('সম্পূর্ণ মেধা তালিকা', 'All Ranked Aspirants')} ({filteredEntries.length} {t('জন পরীক্ষার্থী', 'Candidates')})</span>
            <span>{t('স্কোরিং: সঠিক +১ | ভুল -০.২৫', 'Scoring: Correct +1 | Wrong -0.25')}</span>
          </div>

          <div className="overflow-hidden rounded-2xl border border-slate-200 shadow-2xs">
            <div className="divide-y divide-slate-100">
              {filteredEntries.map((entry) => {
                const isCurrentUser = entry.userId === currentUser.uid;
                
                return (
                  <div 
                    key={entry.id}
                    className={`flex items-center justify-between p-3.5 sm:p-4 text-xs sm:text-sm transition ${
                      isCurrentUser 
                        ? 'bg-amber-50/80 border-l-4 border-l-[#D4AF37] font-semibold' 
                        : 'bg-white hover:bg-slate-50/80'
                    }`}
                  >
                    {/* Rank & Candidate */}
                    <div className="flex items-center gap-3 min-w-0">
                      <div className={`w-8 h-8 rounded-xl flex items-center justify-center font-black text-xs shrink-0 ${
                        entry.rank === 1 
                          ? 'bg-[#D4AF37] text-[#102A43] shadow-xs' 
                          : entry.rank === 2 
                            ? 'bg-slate-300 text-slate-800' 
                            : entry.rank === 3 
                              ? 'bg-amber-600 text-white' 
                              : 'bg-slate-100 text-slate-600'
                      }`}>
                        #{entry.rank}
                      </div>

                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className={`font-bold truncate ${isCurrentUser ? 'text-[#102A43]' : 'text-slate-800'}`}>
                            {entry.studentName}
                          </span>
                          {isCurrentUser && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-[#102A43] text-[#D4AF37]">
                              {t('আপনি (You)', 'You')}
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-slate-400 truncate flex items-center gap-2 mt-0.5">
                          <span>{language === 'bn' ? entry.examTitleBn : entry.examTitleEn}</span>
                          <span>•</span>
                          <span>{formatDate(entry.completedAt)}</span>
                        </div>
                      </div>
                    </div>

                    {/* Score, Accuracy & Time */}
                    <div className="flex items-center gap-4 sm:gap-6 shrink-0 text-right">
                      <div className="hidden sm:block text-[11px] text-slate-500">
                        <div className="text-emerald-700 font-bold">
                          +{entry.correctAnswersCount} <span className="text-rose-600">-{entry.incorrectAnswersCount}</span>
                        </div>
                        <div>{formatDuration(entry.timeSpentSeconds)}</div>
                      </div>

                      <div className="w-16 sm:w-20">
                        <div className="text-base sm:text-lg font-black font-mono text-[#102A43]">
                          {entry.score}
                        </div>
                        <div className="text-[10px] font-bold text-emerald-600">
                          {entry.percentage}% {t('নির্ভুল', 'acc')}
                        </div>
                      </div>
                    </div>

                  </div>
                );
              })}

              {filteredEntries.length === 0 && (
                <div className="p-8 text-center text-slate-500 space-y-2">
                  <Trophy className="w-8 h-8 text-slate-300 mx-auto" />
                  <p className="font-semibold text-sm">
                    {t('কোনো ফলাফল পাওয়া যায়নি', 'No leaderboard results found')}
                  </p>
                  <p className="text-xs text-slate-400">
                    {t('মডেল টেস্টে অংশ নিয়ে সবার প্রথমে আপনার মেধা অবস্থান নির্ধারণ করুন।', 'Participate in a mock test to establish your merit ranking.')}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Encouragement Footer */}
      <div className="p-4 rounded-2xl bg-gradient-to-r from-slate-50 to-amber-50/50 border border-amber-200/50 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-2 text-slate-700">
          <Award className="w-4 h-4 text-[#D4AF37] shrink-0" />
          <span>
            {t(
              'প্রতিটি ৬০ মিনিটের মডেল টেস্ট সম্পন্ন করার সাথে সাথেই আপনার স্কোর মেধা তালিকায় যুক্ত হবে।',
              'Scores are automatically submitted to the Firestore merit leaderboard upon mock test completion.'
            )}
          </span>
        </div>

        <button
          onClick={() => {
            const firstMock = exams.find(e => e.type === 'full_mock');
            if (firstMock) startExam(firstMock.id);
          }}
          className="px-4 py-2 rounded-xl bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] font-bold flex items-center justify-center gap-1.5 cursor-pointer shadow-xs shrink-0"
        >
          <Trophy className="w-3.5 h-3.5" />
          <span>{t('মডেল টেস্টে অংশ নিন', 'Compete in Mock Test')}</span>
        </button>
      </div>

    </div>
  );
};
