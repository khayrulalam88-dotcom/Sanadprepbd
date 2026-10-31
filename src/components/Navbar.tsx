import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { Logo } from './Logo';
import { 
  Home, 
  Languages, 
  User, 
  ShieldCheck, 
  LogOut, 
  LayoutDashboard,
  ShieldAlert,
  ChevronDown,
  BookOpen
} from 'lucide-react';

export const Navbar: React.FC = () => {
  const { 
    language, 
    toggleLanguage, 
    t, 
    currentUser, 
    isLoggedIn,
    logoutUser,
    activeScreen, 
    setActiveScreen, 
    setShowLoginModal
  } = useApp();

  const [adminDropdownOpen, setAdminDropdownOpen] = useState(false);

  // Super Admin Check
  const isAdmin = isLoggedIn && currentUser.role === 'admin' && currentUser.email === 'khayrulalam88@gmail.com';
  const isStudentLoggedIn = isLoggedIn && !isAdmin;

  return (
    <header className="sticky top-0 z-40 bg-white border-b border-slate-200 shadow-xs">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16 sm:h-18">
          
          {/* 1. Left: Brand Logo & Navigation */}
          <div className="flex items-center gap-3 sm:gap-6">
            <div 
              className="cursor-pointer shrink-0" 
              onClick={() => setActiveScreen('landing')}
              title="Sanad Prep BD Home"
            >
              <Logo size="md" variant="navbar" language={language} showTagline={true} />
            </div>

            {/* হোম (Home) Button - always visible */}
            <button
              onClick={() => setActiveScreen('landing')}
              className={`px-3 sm:px-4 py-1.5 sm:py-2 rounded-xl text-xs sm:text-sm font-bold transition flex items-center gap-1.5 cursor-pointer ${
                activeScreen === 'landing'
                  ? 'bg-[#102A43] text-white shadow-xs'
                  : 'text-slate-700 hover:text-[#102A43] hover:bg-slate-100'
              }`}
            >
              <Home className="w-4 h-4" />
              <span>{t('হোম', 'Home')}</span>
            </button>

            {/* Admin-only Navigation: "ড্যাশবোর্ড" & "অ্যাডমিন প্যানেল" */}
            {isAdmin && (
              <div className="hidden sm:flex items-center gap-2">
                <button
                  onClick={() => setActiveScreen('dashboard')}
                  className={`px-3 py-1.5 rounded-xl text-xs sm:text-sm font-bold transition flex items-center gap-1.5 cursor-pointer ${
                    activeScreen === 'dashboard'
                      ? 'bg-[#102A43] text-[#D4AF37] shadow-xs'
                      : 'text-slate-700 hover:text-[#102A43] hover:bg-slate-100'
                  }`}
                >
                  <LayoutDashboard className="w-4 h-4" />
                  <span>{t('ড্যাশবোর্ড', 'Dashboard')}</span>
                </button>

                <button
                  onClick={() => setActiveScreen('question_bank')}
                  className={`px-3 py-1.5 rounded-xl text-xs sm:text-sm font-bold transition flex items-center gap-1.5 cursor-pointer ${
                    activeScreen === 'question_bank'
                      ? 'bg-[#102A43] text-[#D4AF37] shadow-xs'
                      : 'text-slate-700 hover:text-[#102A43] hover:bg-slate-100'
                  }`}
                >
                  <BookOpen className="w-4 h-4" />
                  <span>{t('প্রশ্ন সম্ভার', 'Question Bank')}</span>
                </button>

                <button
                  onClick={() => setActiveScreen('admin')}
                  className={`px-3.5 py-1.5 rounded-xl text-xs sm:text-sm font-bold transition flex items-center gap-1.5 cursor-pointer ${
                    activeScreen === 'admin'
                      ? 'bg-[#102A43] text-[#D4AF37] border border-[#D4AF37] shadow-xs'
                      : 'text-[#102A43] bg-amber-50 border border-amber-300 hover:bg-amber-100'
                  }`}
                >
                  <ShieldAlert className="w-4 h-4 text-[#D4AF37]" />
                  <span>{t('অ্যাডমিন প্যানেল', 'Admin Panel')}</span>
                </button>
              </div>
            )}

            {/* Logged in student navigation (Dashboard for taking tests) */}
            {isStudentLoggedIn && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setActiveScreen('dashboard')}
                  className={`px-3 py-1.5 rounded-xl text-xs sm:text-sm font-bold transition flex items-center gap-1.5 cursor-pointer ${
                    activeScreen === 'dashboard'
                      ? 'bg-[#102A43] text-white shadow-xs'
                      : 'text-slate-700 hover:text-[#102A43] hover:bg-slate-100'
                  }`}
                >
                  <LayoutDashboard className="w-4 h-4" />
                  <span>{t('ড্যাশবোর্ড', 'Dashboard')}</span>
                </button>

                <button
                  onClick={() => setActiveScreen('question_bank')}
                  className={`px-3 py-1.5 rounded-xl text-xs sm:text-sm font-bold transition flex items-center gap-1.5 cursor-pointer ${
                    activeScreen === 'question_bank'
                      ? 'bg-[#102A43] text-white shadow-xs'
                      : 'text-slate-700 hover:text-[#102A43] hover:bg-slate-100'
                  }`}
                >
                  <BookOpen className="w-4 h-4" />
                  <span>{t('প্রশ্ন সম্ভার', 'Question Bank')}</span>
                </button>
              </div>
            )}
          </div>

          {/* 2. Right: বাংলা & লগ ইন (In place of "Student") */}
          <div className="flex items-center space-x-2 sm:space-x-3">
            
            {/* বাংলা (Language Switcher) */}
            <button
              onClick={toggleLanguage}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-300 text-xs font-bold text-slate-800 hover:bg-slate-50 transition cursor-pointer"
              title={t('ভাষা পরিবর্তন করুন', 'Toggle Language')}
            >
              <Languages className="w-3.5 h-3.5 text-[#102A43]" />
              <span>{language === 'bn' ? 'বাংলা' : 'English'}</span>
            </button>

            {/* "লগ ইন" (User specified: "ষ্টুডেন্ট এর জায়গায় লগ ইন লেখা থাকবে") */}
            {!isLoggedIn ? (
              <button
                onClick={() => setShowLoginModal(true)}
                className="flex items-center gap-1.5 px-3.5 sm:px-4 py-1.5 sm:py-2 rounded-xl text-xs sm:text-sm font-bold bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] border border-[#D4AF37] transition cursor-pointer shadow-xs"
                title="লগইন করুন"
              >
                <User className="w-4 h-4" />
                <span>{t('লগ ইন', 'Log In')}</span>
              </button>
            ) : isAdmin ? (
              <div className="relative">
                <button
                  onClick={() => setAdminDropdownOpen(!adminDropdownOpen)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-amber-50 hover:bg-amber-100 text-[#102A43] border border-amber-300 font-bold text-xs transition cursor-pointer"
                >
                  <ShieldCheck className="w-4 h-4 text-[#D4AF37]" />
                  <span>{t('মো: খাইরুল আলম (Admin)', 'Admin')}</span>
                  <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
                </button>

                {adminDropdownOpen && (
                  <div 
                    className="absolute right-0 mt-2 w-52 bg-white rounded-2xl shadow-xl border border-slate-200 py-2 z-50 animate-in fade-in"
                    onMouseLeave={() => setAdminDropdownOpen(false)}
                  >
                    <button
                      onClick={() => {
                        setActiveScreen('admin');
                        setAdminDropdownOpen(false);
                      }}
                      className="w-full text-left px-4 py-2 text-xs font-semibold hover:bg-slate-50 flex items-center gap-2 text-[#102A43]"
                    >
                      <ShieldAlert className="w-4 h-4 text-[#D4AF37]" />
                      <span>{t('অ্যাডমিন প্যানেল', 'Admin Panel')}</span>
                    </button>
                    <button
                      onClick={() => {
                        setActiveScreen('dashboard');
                        setAdminDropdownOpen(false);
                      }}
                      className="w-full text-left px-4 py-2 text-xs font-semibold hover:bg-slate-50 flex items-center gap-2 text-slate-700"
                    >
                      <LayoutDashboard className="w-4 h-4" />
                      <span>{t('ড্যাশবোর্ড', 'Dashboard')}</span>
                    </button>
                    <div className="border-t border-slate-100 mt-1 pt-1">
                      <button
                        onClick={() => {
                          logoutUser();
                          setAdminDropdownOpen(false);
                        }}
                        className="w-full text-left px-4 py-2 text-xs font-semibold hover:bg-rose-50 flex items-center gap-2 text-rose-600"
                      >
                        <LogOut className="w-4 h-4" />
                        <span>{t('লগআউট করুন', 'Log Out')}</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setActiveScreen('dashboard')}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-200 bg-slate-50 text-xs font-bold text-slate-800"
                >
                  <User className="w-3.5 h-3.5 text-[#102A43]" />
                  <span>{currentUser.name.split(' ')[0]}</span>
                </button>
                <button
                  onClick={() => logoutUser()}
                  className="px-2.5 py-1.5 rounded-xl bg-slate-100 hover:bg-rose-50 hover:text-rose-600 text-slate-700 text-xs font-bold transition flex items-center gap-1 cursor-pointer"
                  title={t('লগআউট', 'Log Out')}
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">{t('লগআউট', 'Log Out')}</span>
                </button>
              </div>
            )}

          </div>

        </div>
      </div>
    </header>
  );
};
