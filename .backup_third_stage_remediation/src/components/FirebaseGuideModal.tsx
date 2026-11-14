import React from 'react';
import { useApp } from '../context/AppContext';
import { 
  X, 
  Database, 
  CheckCircle2, 
  Lock, 
  Layers, 
  ShieldCheck, 
  ExternalLink,
  Server
} from 'lucide-react';

export const FirebaseGuideModal: React.FC = () => {
  const { language, t, showFirebaseGuide, setShowFirebaseGuide, isFirebaseActive, firebaseProjectDetails } = useApp();

  if (!showFirebaseGuide) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/70 backdrop-blur-xs">
      <div className="bg-white rounded-3xl max-w-2xl w-full p-6 sm:p-8 shadow-2xl border border-slate-100 max-h-[90vh] overflow-y-auto relative animate-in fade-in zoom-in-95">
        
        <button
          onClick={() => setShowFirebaseGuide(false)}
          className="absolute right-5 top-5 p-1 rounded-full text-slate-400 hover:text-slate-600 hover:bg-slate-100 cursor-pointer"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="flex items-center gap-3 mb-4">
          <div className="w-12 h-12 rounded-2xl bg-slate-100 text-[#102A43] flex items-center justify-center">
            <Database className="w-6 h-6 text-[#D4AF37]" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-[#D4AF37] uppercase tracking-wider bg-[#102A43] px-2.5 py-0.5 rounded">
                Sanad Prep BD Cloud Architecture
              </span>
              <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold ${
                isFirebaseActive ? 'bg-emerald-100 text-emerald-800 border border-emerald-300' : 'bg-amber-100 text-amber-800'
              }`}>
                <span className={`w-2 h-2 rounded-full ${isFirebaseActive ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}`} />
                <span>{isFirebaseActive ? t('সংযুক্ত ও সক্রিয় (Active)', 'Connected & Active') : t('কনফিগারেশন অপেক্ষমান', 'Pending Setup')}</span>
              </span>
            </div>
            <h2 className="text-xl font-black text-[#102A43] mt-1">
              {t('ফায়ারবেস অথেনটিকেশন ও ফায়ারস্টোর কানেকশন গাইড', 'Firebase Auth & Cloud Firestore Guide')}
            </h2>
          </div>
        </div>

        {/* Live Config Summary Box */}
        {isFirebaseActive && (
          <div className="mb-6 p-4 rounded-2xl bg-emerald-50/80 border border-emerald-200 space-y-2">
            <div className="flex items-center gap-2 text-emerald-800 font-bold text-xs">
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              <span>{t('ফায়ারবেস ক্লাউড ডাটাবেজ সফলভাবে কানেক্টেড!', 'Firebase Cloud Database Successfully Initialized!')}</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] font-mono text-slate-700 pt-1">
              <div className="bg-white/80 p-2 rounded-lg border border-emerald-100">
                <span className="text-slate-400 block text-[10px]">Project ID:</span>
                <strong className="text-[#102A43]">{firebaseProjectDetails.projectId}</strong>
              </div>
              <div className="bg-white/80 p-2 rounded-lg border border-emerald-100">
                <span className="text-slate-400 block text-[10px]">Database ID:</span>
                <strong className="text-[#102A43] truncate block" title={firebaseProjectDetails.databaseId}>{firebaseProjectDetails.databaseId}</strong>
              </div>
            </div>
          </div>
        )}

        <p className="text-xs sm:text-sm text-slate-600 leading-relaxed mb-6">
          {t(
            'Sanad Prep BD প্ল্যাটফর্মে ফায়ারবেস অথেনটিকেশন এবং ক্লাউড ফায়ারস্টোর ডাটাবেজ প্রোভিশনিং ও ইনিশিয়ালাইজেশন সম্পন্ন হয়েছে। ৬০ মিনিটের টাইমার, নেগেটিভ মার্কিং স্কোরিং এবং রিয়েল-টাইম ডাটা সিঙ্ক সক্রিয়।',
            'Sanad Prep BD is fully connected to Cloud Firestore and Firebase Authentication. 60-min timer, negative marking scoring, and real-time data sync are active.'
          )}
        </p>

        {/* Database Collections Schema Designed */}
        <div className="space-y-4 mb-6">
          <h3 className="font-bold text-[#102A43] text-sm flex items-center gap-2">
            <Layers className="w-4 h-4 text-[#D4AF37]" />
            <span>{t('ক্লাউড ফায়ারস্টোর ডাটাবেজ স্কিমা (Firestore Schema)', 'Cloud Firestore Database Collections')}</span>
          </h3>

          <div className="grid grid-cols-2 gap-2 text-xs font-mono">
            {[
              { col: 'users', desc: 'UID, Role (student/admin/mgr), Profile, Phone' },
              { col: 'subjects', desc: '7 Statutory Bar Council acts & marks weights' },
              { col: 'questions', desc: 'Syllabus questions, legal sections, options' },
              { col: 'exams', desc: '60-min mocks, negative marking ratios, pass thresholds' },
              { col: 'examAttempts', desc: 'Server deadline, autosaved answers, state' },
              { col: 'examResults', desc: 'Score, correct, incorrect, positive, negative' },
              { col: 'paymentRequests', desc: 'bKash/Nagad TrxID, sender number, status' },
              { col: 'auditLogs', desc: 'Administrative audit trails for compliance' }
            ].map(item => (
              <div key={item.col} className="p-2.5 rounded-xl bg-slate-50 border border-slate-200">
                <span className="font-bold text-[#102A43] block">/{item.col}</span>
                <span className="text-[11px] text-slate-500 font-sans">{item.desc}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Step-by-step Roadmap */}
        <div className="space-y-3 mb-6 p-4 rounded-2xl bg-slate-50 border border-slate-200 text-xs sm:text-sm">
          <h4 className="font-bold text-[#102A43]">{t('পরবর্তী স্টেজসমূহ (Roadmap):', 'Upcoming Stages Roadmap:')}</h4>
          <ol className="list-decimal list-inside space-y-1.5 text-slate-600">
            <li><strong>Stage 1 (Done):</strong> Working UI, 60-min timed exam, exact marking, review page, Sanad Prep BD branding.</li>
            <li><strong>Stage 2:</strong> Connect Firebase Authentication & Cloud Firestore database with terms confirmation.</li>
            <li><strong>Stage 3:</strong> Trusted server-side timing and answer scoring functions.</li>
            <li><strong>Stage 4:</strong> Production admin dashboard and question workflow.</li>
            <li><strong>Stage 5:</strong> Live bKash/Nagad payment verification.</li>
            <li><strong>Stage 6:</strong> Firestore Security Rules (`firestore.rules`) and production deployment.</li>
          </ol>
        </div>

        <div className="flex justify-end">
          <button
            onClick={() => setShowFirebaseGuide(false)}
            className="px-5 py-2.5 rounded-xl bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] border border-[#D4AF37] font-bold text-xs cursor-pointer"
          >
            {t('বুঝেছি (Got It)', 'Close')}
          </button>
        </div>

      </div>
    </div>
  );
};
