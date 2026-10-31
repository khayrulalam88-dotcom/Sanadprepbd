/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { AppProvider, useApp } from './context/AppContext';
import { Navbar } from './components/Navbar';
import { LandingPage } from './components/LandingPage';
import { Dashboard } from './components/Dashboard';
import { ExamScreen } from './components/ExamScreen';
import { PracticeScreen } from './components/PracticeScreen';
import { ResultsScreen } from './components/ResultsScreen';
import { SubjectsView } from './components/SubjectsView';
import { HistoryView } from './components/HistoryView';
import { AdminPanel } from './components/AdminPanel';
import { QuestionBankView } from './components/QuestionBankView';
import { CustomTestModal } from './components/CustomTestModal';
import { SubscriptionModal } from './components/SubscriptionModal';
import { TestingSuiteModal } from './components/TestingSuiteModal';
import { FirebaseGuideModal } from './components/FirebaseGuideModal';
import { LoginModal } from './components/LoginModal';
import { InfoAndSearchModals } from './components/InfoAndSearchModals';
import { Logo } from './components/Logo';
import { Scale, Mail, Shield, FileText, CheckCircle2 } from 'lucide-react';

const MainContent: React.FC = () => {
  const { activeScreen, language, t, setActiveScreen } = useApp();
  const [showPolicyModal, setShowPolicyModal] = useState<'privacy' | 'terms' | null>(null);

  return (
    <div className="min-h-screen flex flex-col bg-[#F5F7FA] text-[#243447]">
      <Navbar />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 pt-6 sm:pt-8">
        {activeScreen === 'landing' && <LandingPage />}
        {activeScreen === 'dashboard' && <Dashboard />}
        {activeScreen === 'exam' && <ExamScreen />}
        {activeScreen === 'practice' && <PracticeScreen />}
        {activeScreen === 'result' && <ResultsScreen />}
        {activeScreen === 'subjects' && <SubjectsView />}
        {activeScreen === 'question_bank' && <QuestionBankView />}
        {activeScreen === 'history' && <HistoryView />}
        {activeScreen === 'admin' && <AdminPanel />}
      </main>

      {/* Global Modals */}
      <SubscriptionModal />
      <TestingSuiteModal />
      <FirebaseGuideModal />
      <LoginModal />
      <InfoAndSearchModals />
      <CustomTestModal 
        isOpen={useApp().showCustomTestModal} 
        onClose={() => useApp().setShowCustomTestModal(false)} 
      />

      {/* Privacy / Terms Modal */}
      {showPolicyModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
          <div className="bg-white rounded-3xl max-w-lg w-full p-6 sm:p-8 shadow-2xl border border-slate-100">
            <h3 className="text-xl font-bold text-[#102A43] mb-3">
              {showPolicyModal === 'privacy' 
                ? t('গোপনীয়তা নীতি (Privacy Policy)', 'Privacy Policy') 
                : t('ব্যবহারের শর্তাবলী (Terms of Service)', 'Terms of Service')}
            </h3>
            <p className="text-xs sm:text-sm text-slate-600 leading-relaxed mb-6">
              {showPolicyModal === 'privacy' ? (
                language === 'bn' 
                  ? 'Sanad Prep BD ব্যবহারকারীদের ব্যক্তিগত গোপনীয়তাকে সর্বোচ্চ গুরুত্ব প্রদান করে। পরীক্ষার ফলাফল, সংরক্ষিত উত্তর এবং একাউন্ট তথ্য সম্পূর্ণ সুরক্ষিত রাখা হয়। আমরা কখনোই কোনো তৃতীয় পক্ষের সাথে শিক্ষার্থীদের ব্যক্তিগত তথ্য শেয়ার বা বিক্রয় করি না।'
                  : 'Sanad Prep BD respects candidate privacy. Exam results, practice attempts, and account information are maintained securely. We do not sell or share student data with unauthorized third parties.'
              ) : (
                language === 'bn'
                  ? 'Sanad Prep BD একটি উন্মুক্ত প্রস্তুতিমূলক শিক্ষা সেবা। এই প্ল্যাটফর্মের সকল প্রশ্ন এবং ব্যাখ্যা পরীক্ষার্থীদের ব্যক্তিগত দক্ষতা বৃদ্ধির উদ্দেশ্যে প্রণীত। এটি অফিসিয়াল পরীক্ষার কোনো নিশ্চিত গ্যারান্টি বা সরকারি সনদ নয়।'
                  : 'Sanad Prep BD is an independent educational preparatory service. Practice questions and answers are designed for self-assessment. It does not confer official certification or replace direct Bare Act study.'
              )}
            </p>
            <div className="flex justify-end">
              <button
                onClick={() => setShowPolicyModal(null)}
                className="px-5 py-2.5 rounded-xl bg-[#102A43] text-white font-bold text-xs cursor-pointer"
              >
                {t('বন্ধ করুন', 'Close')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Footer (Section 4 & 1 requirement) */}
      <footer className="mt-auto border-t border-slate-200 bg-white py-12 text-xs text-slate-500">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-8">
          
          <div className="flex flex-col md:flex-row md:items-start justify-between gap-8">
            {/* Logo and Taglines */}
            <div className="space-y-2 max-w-sm">
              <Logo size="md" variant="full" language={language} />
              <p className="text-xs text-slate-500 leading-relaxed pt-2">
                {language === 'bn'
                  ? 'বাংলাদেশ বার কাউন্সিল এনরোলমেন্ট পরীক্ষার জন্য আধুনিক, নির্ভরযোগ্য ও কার্যকরী ৬০ মিনিটের লাইভ এমসিকিউ প্রস্তুতি প্ল্যাটফর্ম।'
                  : 'Modern, reliable, and timed preparation platform tailored for the Bangladesh Bar Council Enrollment Examination.'}
              </p>
            </div>

            {/* Quick Links */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-8 text-xs">
              <div>
                <h4 className="font-bold text-[#102A43] uppercase tracking-wider mb-3">
                  {t('প্ল্যাটফর্ম', 'Platform')}
                </h4>
                <ul className="space-y-2 text-slate-600 font-medium">
                  <li>
                    <button onClick={() => setActiveScreen('landing')} className="hover:text-[#102A43]">
                      {t('হোম পেজ', 'Home')}
                    </button>
                  </li>
                  <li>
                    <button onClick={() => setActiveScreen('dashboard')} className="hover:text-[#102A43]">
                      {t('স্টুডেন্ট ড্যাশবোর্ড', 'Dashboard')}
                    </button>
                  </li>
                  <li>
                    <button onClick={() => setActiveScreen('subjects')} className="hover:text-[#102A43]">
                      {t('আইনভিত্তিক অধ্যায়', 'Subjects')}
                    </button>
                  </li>
                  <li>
                    <button onClick={() => setActiveScreen('question_bank')} className="hover:text-[#102A43]">
                      {t('প্রশ্ন সম্ভার ও কাস্টম টেস্ট', 'Question Bank & Custom Tests')}
                    </button>
                  </li>
                  <li>
                    <button onClick={() => setActiveScreen('history')} className="hover:text-[#102A43]">
                      {t('ফলাফল ইতিহাস', 'Exam History')}
                    </button>
                  </li>
                  <li>
                    <button onClick={() => setActiveScreen('admin')} className="hover:text-[#102A43] flex items-center gap-1">
                      <Shield className="w-3 h-3 text-[#D4AF37]" />
                      <span>{t('অ্যাডমিন লগইন', 'Admin Login')}</span>
                    </button>
                  </li>
                </ul>
              </div>

              <div>
                <h4 className="font-bold text-[#102A43] uppercase tracking-wider mb-3">
                  {t('আইনগত নীতি', 'Legal & Policy')}
                </h4>
                <ul className="space-y-2 text-slate-600 font-medium">
                  <li>
                    <button onClick={() => setShowPolicyModal('privacy')} className="hover:text-[#102A43]">
                      {t('গোপনীয়তা নীতি', 'Privacy Policy')}
                    </button>
                  </li>
                  <li>
                    <button onClick={() => setShowPolicyModal('terms')} className="hover:text-[#102A43]">
                      {t('ব্যবহারের শর্তাবলী', 'Terms of Service')}
                    </button>
                  </li>
                </ul>
              </div>

              <div>
                <h4 className="font-bold text-[#102A43] uppercase tracking-wider mb-3">
                  {t('যোগাযোগ ও সহায়তা', 'Contact & Help')}
                </h4>
                <p className="text-slate-600 leading-relaxed">
                  support@sanadprepbd.com<br />
                  {t('ঢাকা, বাংলাদেশ', 'Dhaka, Bangladesh')}
                </p>
              </div>
            </div>
          </div>

          {/* Bottom Copyright & Strict Non-affiliation Disclaimer */}
          <div className="pt-8 border-t border-slate-100 flex flex-col sm:flex-row items-center justify-between gap-4 text-[11px] text-slate-400">
            <p>
              © {new Date().getFullYear()} Sanad Prep BD. All rights reserved.
            </p>

            <p className="text-center sm:text-right max-w-xl">
              {t(
                'আইনগত ঘোষণা: Sanad Prep BD একটি স্বাধীন আইন শিক্ষা ও প্রস্তুতিমূলক প্ল্যাটফর্ম। এটি বাংলাদেশ বার কাউন্সিলের অফিসিয়াল অঙ্গ নয় এবং কোনো সরকারি অনুমোদন বা প্রতিনিধিত্ব দাবি করে না।',
                'Disclaimer: Sanad Prep BD is an independent legal education and preparatory tool. It is not affiliated with, sponsored by, or endorsed by the Bangladesh Bar Council.'
              )}
            </p>
          </div>

        </div>
      </footer>
    </div>
  );
};

export default function App() {
  return (
    <AppProvider>
      <MainContent />
    </AppProvider>
  );
}
