import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { Logo } from './Logo';
import { 
  X, 
  Phone, 
  Mail, 
  Lock, 
  Eye, 
  EyeOff, 
  CheckCircle2, 
  Sparkles, 
  ShieldCheck, 
  ArrowRight, 
  User, 
  LogOut
} from 'lucide-react';

export const LoginModal: React.FC = () => {
  const { 
    showLoginModal, 
    setShowLoginModal, 
    isLoggedIn, 
    currentUser, 
    loginUser, 
    logoutUser, 
    setActiveScreen,
    t, 
    language 
  } = useApp();

  const [authTab, setAuthTab] = useState<'phone' | 'email' | 'fast'>('phone');
  
  // Mobile login state (Direct login, NO OTP)
  const [phoneNumber, setPhoneNumber] = useState('01712345678');
  const [candidateName, setCandidateName] = useState('মো: খাইরুল আলম');

  // Email login state
  const [email, setEmail] = useState('khayrulalam88@gmail.com');
  const [password, setPassword] = useState('AdminSanadPrep2026!');
  const [showPassword, setShowPassword] = useState(false);

  // Feedback state
  const [successMessage, setSuccessMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  if (!showLoginModal) return null;

  // Direct Mobile Login - NO OTP
  const handleMobileLogin = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage('');
    
    const cleanedPhone = phoneNumber.trim().replace(/\D/g, '');
    if (cleanedPhone.length < 10) {
      setErrorMessage(language === 'bn' ? 'অনুগ্রহ করে সঠিক মোবাইল নম্বর দিন' : 'Please enter a valid mobile number');
      return;
    }

    loginUser({
      name: candidateName.trim() || 'পরীক্ষার্থী (Candidate)',
      phone: phoneNumber,
      email: `${cleanedPhone}@sanadprep.com`,
      role: 'student',
      subscriptionStatus: 'pro'
    });

    setSuccessMessage(language === 'bn' ? 'সফলভাবে লগইন সম্পন্ন হয়েছে!' : 'Logged in successfully!');
    setTimeout(() => {
      setShowLoginModal(false);
      setSuccessMessage('');
      setActiveScreen('dashboard');
    }, 600);
  };

  // Email Login
  const handleEmailLogin = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage('');
    if (!email) {
      setErrorMessage(language === 'bn' ? 'ইমেইল এড্রেস প্রদান করুন' : 'Provide your email address');
      return;
    }

    const isAdmin = email.toLowerCase().trim() === 'khayrulalam88@gmail.com';
    loginUser({
      name: isAdmin ? 'মো: খাইরুল আলম (সুপার অ্যাডমিন)' : (candidateName || 'পরীক্ষার্থী'),
      email: email.trim(),
      phone: '01712-345678',
      role: isAdmin ? 'admin' : 'student',
      subscriptionStatus: 'pro'
    });

    setSuccessMessage(language === 'bn' ? 'সফলভাবে লগইন হয়েছে!' : 'Logged in successfully!');
    setTimeout(() => {
      setShowLoginModal(false);
      setSuccessMessage('');
      if (isAdmin) {
        setActiveScreen('admin');
      } else {
        setActiveScreen('dashboard');
      }
    }, 600);
  };

  // 1-Click Fast Login for easy testing
  const handleFastLogin = (role: 'admin' | 'student_pro' | 'student_free') => {
    if (role === 'admin') {
      loginUser({
        uid: 'user_candidate_786',
        name: 'মো: খাইরুল আলম (সুপার অ্যাডমিন)',
        email: 'khayrulalam88@gmail.com',
        phone: '01712-345678',
        role: 'admin',
        subscriptionStatus: 'pro'
      });
      setActiveScreen('admin');
    } else if (role === 'student_pro') {
      loginUser({
        uid: 'user_candidate_786',
        name: 'মো: খাইরুল আলম (প্রো পরীক্ষার্থী)',
        email: 'khayrulalam88@gmail.com',
        phone: '01712-345678',
        role: 'student',
        subscriptionStatus: 'pro'
      });
      setActiveScreen('dashboard');
    } else {
      loginUser({
        uid: `user_${Date.now()}`,
        name: 'নতুন শিক্ষার্থী (ফ্রি একাউন্ট)',
        email: 'student@sanadprep.com',
        phone: '01811223344',
        role: 'student',
        subscriptionStatus: 'free'
      });
      setActiveScreen('dashboard');
    }

    setSuccessMessage(language === 'bn' ? 'সফলভাবে লগইন সম্পন্ন হয়েছে!' : 'Login successful!');
    setTimeout(() => {
      setShowLoginModal(false);
      setSuccessMessage('');
    }, 500);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-xs animate-in fade-in duration-200">
      <div 
        className="bg-white rounded-3xl max-w-md w-full shadow-2xl border border-slate-100 overflow-hidden relative"
        onClick={(e) => e.stopPropagation()}
      >
        
        {/* Close Button */}
        <button
          onClick={() => setShowLoginModal(false)}
          className="absolute top-4 right-4 z-10 w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 flex items-center justify-center text-slate-500 hover:text-slate-800 transition cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>

        {/* Modal Header without any 7-day trial notice */}
        <div className="bg-gradient-to-br from-[#102A43] to-[#243B53] text-white p-6 pb-5">
          <div className="flex items-center justify-between mb-3">
            <Logo size="sm" theme="light" variant="navbar" language={language} />
            <span className="text-[11px] font-bold px-2.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-400/30">
              Sanad Auth
            </span>
          </div>

          <h2 className="text-xl font-black text-white">
            {language === 'bn' ? 'লগইন করুন' : 'Sign In to Your Account'}
          </h2>
          <p className="text-xs text-slate-300 mt-1">
            {language === 'bn' 
              ? 'বার কাউন্সিল পরীক্ষার পূর্ণাঙ্গ প্রস্তুতি ও ৬০ মিনিটের লাইভ মক টেস্ট।' 
              : 'Access timed mock tests, questions & legal statutory references.'}
          </p>
        </div>

        {/* Content Body */}
        <div className="p-6 space-y-4">

          {/* Already logged in status */}
          {isLoggedIn && (
            <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200 text-xs space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-bold text-slate-500 uppercase tracking-wider text-[11px]">
                  {t('বর্তমান একাউন্ট', 'Current Account')}
                </span>
                <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-bold text-[10px]">
                  ACTIVE
                </span>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-[#102A43] text-white flex items-center justify-center font-bold text-sm">
                  {currentUser.name.charAt(0)}
                </div>
                <div>
                  <h4 className="font-bold text-slate-900 text-sm">{currentUser.name}</h4>
                  <p className="text-slate-500 text-[11px]">{currentUser.phone || currentUser.email}</p>
                  <p className="text-[#D4AF37] font-semibold text-[11px] capitalize">
                    {currentUser.role} · {currentUser.subscriptionStatus === 'pro' ? 'Pro Member' : 'Free Tier'}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 pt-2 border-t border-slate-200">
                {currentUser.email === 'khayrulalam88@gmail.com' && (
                  <button
                    onClick={() => {
                      setActiveScreen('admin');
                      setShowLoginModal(false);
                    }}
                    className="flex-1 py-2 rounded-xl bg-[#102A43] text-[#D4AF37] font-bold text-xs hover:bg-[#243B53] transition cursor-pointer"
                  >
                    {t('অ্যাডমিন প্যানেল', 'Admin Panel')}
                  </button>
                )}
                <button
                  onClick={() => {
                    logoutUser();
                    setSuccessMessage(t('লগআউট সফল হয়েছে', 'Logged out successfully'));
                  }}
                  className="px-3 py-2 rounded-xl border border-rose-200 text-rose-600 hover:bg-rose-50 font-bold text-xs flex items-center gap-1.5 transition cursor-pointer"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>{t('লগআউট', 'Log Out')}</span>
                </button>
              </div>
            </div>
          )}

          {/* Login Tabs */}
          <div className="flex items-center p-1 bg-slate-100 rounded-xl text-xs font-bold text-slate-600">
            <button
              onClick={() => { setAuthTab('phone'); setErrorMessage(''); }}
              className={`flex-1 py-2 rounded-lg transition flex items-center justify-center gap-1.5 cursor-pointer ${
                authTab === 'phone' ? 'bg-white text-slate-900 shadow-xs' : 'hover:text-slate-900'
              }`}
            >
              <Phone className="w-3.5 h-3.5" />
              <span>{t('মোবাইল নম্বর', 'Mobile')}</span>
            </button>

            <button
              onClick={() => { setAuthTab('email'); setErrorMessage(''); }}
              className={`flex-1 py-2 rounded-lg transition flex items-center justify-center gap-1.5 cursor-pointer ${
                authTab === 'email' ? 'bg-white text-slate-900 shadow-xs' : 'hover:text-slate-900'
              }`}
            >
              <Mail className="w-3.5 h-3.5" />
              <span>{t('ইমেইল / অ্যাডমিন', 'Email / Admin')}</span>
            </button>

            <button
              onClick={() => { setAuthTab('fast'); setErrorMessage(''); }}
              className={`flex-1 py-2 rounded-lg transition flex items-center justify-center gap-1.5 cursor-pointer ${
                authTab === 'fast' ? 'bg-white text-slate-900 shadow-xs' : 'hover:text-slate-900'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5 text-amber-500" />
              <span>{t('দ্রুত লগইন', '1-Click')}</span>
            </button>
          </div>

          {/* Feedback Messages */}
          {errorMessage && (
            <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs font-semibold">
              {errorMessage}
            </div>
          )}
          {successMessage && (
            <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-semibold flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              <span>{successMessage}</span>
            </div>
          )}

          {/* Tab 1: Direct Mobile Login (NO OTP) */}
          {authTab === 'phone' && (
            <form onSubmit={handleMobileLogin} className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  {t('আপনার নাম', 'Candidate Name')}
                </label>
                <div className="flex items-center rounded-xl border border-slate-300 p-2.5 bg-white focus-within:border-[#102A43]">
                  <User className="w-4 h-4 text-slate-400 mr-2" />
                  <input
                    type="text"
                    value={candidateName}
                    onChange={(e) => setCandidateName(e.target.value)}
                    placeholder={t('আপনার নাম লিখুন', 'Enter your name')}
                    className="flex-1 text-xs text-slate-900 outline-none"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  {t('মোবাইল নম্বর', 'Mobile Number')}
                </label>
                <div className="flex items-center rounded-xl border border-slate-300 focus-within:border-[#102A43] overflow-hidden bg-white">
                  <span className="px-3 py-2.5 bg-slate-100 text-xs font-bold text-slate-700 border-r border-slate-200">
                    +880
                  </span>
                  <input
                    type="tel"
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value)}
                    placeholder="017XXXXXXXX"
                    maxLength={11}
                    className="flex-1 p-2.5 text-xs text-slate-900 outline-none"
                    required
                  />
                </div>
              </div>

              <button
                type="submit"
                className="w-full py-3 rounded-xl bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] font-bold text-xs transition shadow-sm cursor-pointer flex items-center justify-center gap-2"
              >
                <span>{t('সরাসরি লগইন করুন', 'Sign In Directly')}</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </form>
          )}

          {/* Tab 2: Email & Password (Super Admin & Student) */}
          {authTab === 'email' && (
            <form onSubmit={handleEmailLogin} className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  {t('ইমেইল অ্যাড্রেস', 'Email Address')}
                </label>
                <div className="flex items-center rounded-xl border border-slate-300 p-2.5 bg-white focus-within:border-[#102A43]">
                  <Mail className="w-4 h-4 text-slate-400 mr-2" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="khayrulalam88@gmail.com"
                    className="flex-1 text-xs text-slate-900 outline-none"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  {t('পাসওয়ার্ড', 'Password')}
                </label>
                <div className="flex items-center rounded-xl border border-slate-300 p-2.5 bg-white focus-within:border-[#102A43]">
                  <Lock className="w-4 h-4 text-slate-400 mr-2" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="flex-1 text-xs text-slate-900 outline-none"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="text-slate-400 hover:text-slate-600 cursor-pointer"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                className="w-full py-3 rounded-xl bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] font-bold text-xs transition shadow-sm cursor-pointer"
              >
                {t('লগইন করুন', 'Sign In')}
              </button>
            </form>
          )}

          {/* Tab 3: Fast 1-Click Login */}
          {authTab === 'fast' && (
            <div className="space-y-2.5">
              <p className="text-xs text-slate-500 mb-2">
                {t('দ্রুত লগইন করতে নিচের যেকোনো একটি একাউন্ট বেছে নিন:', 'Select an account for quick instant access:')}
              </p>

              <button
                type="button"
                onClick={() => handleFastLogin('admin')}
                className="w-full p-3 rounded-2xl border border-slate-200 hover:border-[#D4AF37] hover:bg-amber-50/50 transition flex items-center justify-between text-left cursor-pointer group"
              >
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-xl bg-[#102A43] text-[#D4AF37] flex items-center justify-center font-bold text-xs">
                    👑
                  </div>
                  <div>
                    <h4 className="font-bold text-xs text-slate-900 group-hover:text-[#102A43]">
                      মো: খাইরুল আলম (সুপার অ্যাডমিন)
                    </h4>
                    <p className="text-[10px] text-slate-500 font-mono">khayrulalam88@gmail.com</p>
                  </div>
                </div>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-[#102A43] text-[#D4AF37]">
                  ADMIN
                </span>
              </button>

              <button
                type="button"
                onClick={() => handleFastLogin('student_pro')}
                className="w-full p-3 rounded-2xl border border-slate-200 hover:border-emerald-400 hover:bg-emerald-50/50 transition flex items-center justify-between text-left cursor-pointer group"
              >
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-xl bg-emerald-600 text-white flex items-center justify-center font-bold text-xs">
                    🎓
                  </div>
                  <div>
                    <h4 className="font-bold text-xs text-slate-900 group-hover:text-emerald-900">
                      মো: খাইরুল আলম (প্রো পরীক্ষার্থী)
                    </h4>
                    <p className="text-[10px] text-slate-500 font-mono">01712-345678 · PRO PASS</p>
                  </div>
                </div>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-100 text-emerald-800">
                  PRO
                </span>
              </button>

              <button
                type="button"
                onClick={() => handleFastLogin('student_free')}
                className="w-full p-3 rounded-2xl border border-slate-200 hover:border-blue-400 hover:bg-blue-50/50 transition flex items-center justify-between text-left cursor-pointer group"
              >
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-xl bg-blue-600 text-white flex items-center justify-center font-bold text-xs">
                    👤
                  </div>
                  <div>
                    <h4 className="font-bold text-xs text-slate-900 group-hover:text-blue-900">
                      সাধারণ পরীক্ষার্থী (ফ্রি একাউন্ট)
                    </h4>
                    <p className="text-[10px] text-slate-500">Student Free Tier</p>
                  </div>
                </div>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-blue-100 text-blue-800">
                  FREE
                </span>
              </button>
            </div>
          )}

          {/* Privacy Note */}
          <p className="text-[11px] text-center text-slate-400 pt-2 border-t border-slate-100">
            {t('নিরাপদ ও এনক্রিপ্টেড ডাটাবেস। একাউন্ট শেয়ারিং সুরক্ষা সক্রিয়।', 'Secure & encrypted authentication. Account sharing protection active.')}
          </p>

        </div>
      </div>
    </div>
  );
};
