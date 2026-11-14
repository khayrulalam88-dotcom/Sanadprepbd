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
    loginWithGoogle,
    loginWithEmail,
    logoutUser, 
    setActiveScreen,
    t, 
    language 
  } = useApp();

  const [authTab, setAuthTab] = useState<'email' | 'phone'>('email');
  const [emailMode, setEmailMode] = useState<'signin' | 'signup'>('signin');
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Email login state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [candidateName, setCandidateName] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // Mobile guidance state
  const [phoneNumber, setPhoneNumber] = useState('');

  // Feedback state
  const [successMessage, setSuccessMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  if (!showLoginModal) return null;

  const handleGoogleLogin = async () => {
    setIsGoogleLoading(true);
    setErrorMessage('');
    try {
      const res = await loginWithGoogle();
      if (!res.success) {
        setErrorMessage(res.error || (language === 'bn' ? 'গুগল সাইন ইন সম্পন্ন করা যায়নি।' : 'Google Sign-In failed.'));
      } else {
        setSuccessMessage(language === 'bn' ? 'গুগল দিয়ে সফলভাবে সাইন ইন সম্পন্ন হয়েছে!' : 'Signed in with Google successfully!');
        setTimeout(() => {
          setShowLoginModal(false);
          setSuccessMessage('');
        }, 500);
      }
    } catch (e: any) {
      setErrorMessage(e?.message || 'Google Sign-In error');
    } finally {
      setIsGoogleLoading(false);
    }
  };

  // Real Email & Password Login / Registration via Firebase Auth
  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage('');
    setSuccessMessage('');

    const cleanEmail = email.trim();
    if (!cleanEmail) {
      setErrorMessage(language === 'bn' ? 'ইমেইল অ্যাড্রেস প্রদান করুন।' : 'Please provide your email address.');
      return;
    }

    if (!password || password.length < 6) {
      setErrorMessage(language === 'bn' ? 'পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে।' : 'Password must be at least 6 characters.');
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await loginWithEmail(cleanEmail, password, emailMode === 'signup', candidateName.trim());
      if (!res.success) {
        setErrorMessage(res.error || (language === 'bn' ? 'প্রমাণীকরণ সম্পন্ন করা যায়নি।' : 'Authentication failed.'));
      } else {
        setSuccessMessage(
          emailMode === 'signup'
            ? (language === 'bn' ? 'নিবন্ধন সফলভাবে সম্পন্ন হয়েছে!' : 'Account registered successfully!')
            : (language === 'bn' ? 'সফলভাবে লগইন হয়েছে!' : 'Logged in successfully!')
        );
        setTimeout(() => {
          setShowLoginModal(false);
          setSuccessMessage('');
        }, 600);
      }
    } catch (err: any) {
      setErrorMessage(err?.message || 'Authentication error');
    } finally {
      setIsSubmitting(false);
    }
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

          {/* Google Sign-In (Firebase Auth Free Tier) */}
          <button
            type="button"
            disabled={isGoogleLoading}
            onClick={handleGoogleLogin}
            className="w-full py-2.5 px-4 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 font-bold text-xs flex items-center justify-center gap-2.5 transition shadow-xs cursor-pointer disabled:opacity-60"
          >
            <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
            </svg>
            <span>
              {isGoogleLoading 
                ? t('যাচাই করা হচ্ছে...', 'Authenticating...') 
                : t('গুগল দিয়ে নিরাপদ সাইন ইন (Firebase)', 'Sign in with Google (Firebase Auth)')}
            </span>
          </button>

          <div className="relative flex py-1 items-center">
            <div className="grow border-t border-slate-200"></div>
            <span className="shrink mx-3 text-slate-400 text-[10px] font-bold uppercase tracking-wider">
              {t('অথবা', 'OR')}
            </span>
            <div className="grow border-t border-slate-200"></div>
          </div>

          {/* Login Tabs */}
          <div className="flex items-center p-1 bg-slate-100 rounded-xl text-xs font-bold text-slate-600">
            <button
              onClick={() => { setAuthTab('email'); setErrorMessage(''); }}
              className={`flex-1 py-2 rounded-lg transition flex items-center justify-center gap-1.5 cursor-pointer ${
                authTab === 'email' ? 'bg-white text-slate-900 shadow-xs' : 'hover:text-slate-900'
              }`}
            >
              <Mail className="w-3.5 h-3.5" />
              <span>{t('ইমেইল ও পাসওয়ার্ড', 'Email & Password')}</span>
            </button>

            <button
              onClick={() => { setAuthTab('phone'); setErrorMessage(''); }}
              className={`flex-1 py-2 rounded-lg transition flex items-center justify-center gap-1.5 cursor-pointer ${
                authTab === 'phone' ? 'bg-white text-slate-900 shadow-xs' : 'hover:text-slate-900'
              }`}
            >
              <Phone className="w-3.5 h-3.5" />
              <span>{t('মোবাইল নম্বর', 'Mobile Number')}</span>
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

          {/* Tab 1: Email & Password (Real Firebase Auth) */}
          {authTab === 'email' && (
            <form onSubmit={handleEmailSubmit} className="space-y-3">
              {/* Sign In vs Sign Up Toggle */}
              <div className="flex items-center justify-center gap-2 p-1 bg-slate-50 border border-slate-200 rounded-lg text-[11px] font-bold">
                <button
                  type="button"
                  onClick={() => { setEmailMode('signin'); setErrorMessage(''); }}
                  className={`flex-1 py-1 rounded transition cursor-pointer ${
                    emailMode === 'signin' ? 'bg-[#102A43] text-[#D4AF37]' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {t('সাইন ইন (Sign In)', 'Sign In')}
                </button>
                <button
                  type="button"
                  onClick={() => { setEmailMode('signup'); setErrorMessage(''); }}
                  className={`flex-1 py-1 rounded transition cursor-pointer ${
                    emailMode === 'signup' ? 'bg-[#102A43] text-[#D4AF37]' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {t('নতুন একাউন্ট (Sign Up)', 'Create Account')}
                </button>
              </div>

              {emailMode === 'signup' && (
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    {t('আপনার পূর্ণ নাম', 'Full Name')}
                  </label>
                  <div className="flex items-center rounded-xl border border-slate-300 p-2.5 bg-white focus-within:border-[#102A43]">
                    <User className="w-4 h-4 text-slate-400 mr-2" />
                    <input
                      type="text"
                      value={candidateName}
                      onChange={(e) => setCandidateName(e.target.value)}
                      placeholder={t('যেমন: মো: খাইরুল আলম', 'e.g. Adv. Rahat Islam')}
                      className="flex-1 text-xs text-slate-900 outline-none"
                      required={emailMode === 'signup'}
                    />
                  </div>
                </div>
              )}

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
                    placeholder="student@example.com"
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
                disabled={isSubmitting}
                className="w-full py-3 rounded-xl bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] font-bold text-xs transition shadow-sm cursor-pointer disabled:opacity-60 flex items-center justify-center gap-2"
              >
                {isSubmitting ? (
                  <span>{t('যাচাই করা হচ্ছে...', 'Processing...')}</span>
                ) : (
                  <span>{emailMode === 'signup' ? t('নিবন্ধন সম্পন্ন করুন', 'Register Account') : t('নিরাপদ সাইন ইন', 'Sign In')}</span>
                )}
              </button>
            </form>
          )}

          {/* Tab 2: Mobile Notice & Direct Recommendation */}
          {authTab === 'phone' && (
            <div className="space-y-3 p-4 rounded-2xl bg-amber-50/60 border border-amber-200 text-xs text-slate-700">
              <div className="flex items-center gap-2 font-bold text-[#102A43]">
                <ShieldCheck className="w-4 h-4 text-amber-600" />
                <span>{t('মোবাইল ও এসএমএস প্রমাণীকরণ নির্দেশিকা', 'Mobile SMS Authentication')}</span>
              </div>
              <p className="text-[11px] leading-relaxed text-slate-600">
                {t(
                  'মোবাইল নম্বর দিয়ে সাইন ইন করতে ফায়ারবেস কনসোলে ফোন নম্বর প্রভাইডার সক্রিয় থাকা আবশ্যক। আপনার সংরক্ষিত সাবস্ক্রিপশন ও ফলাফল সুরক্ষার জন্য গুগল বা ইমেইল দিয়ে সাইন ইন করুন।',
                  'Phone SMS verification requires SMS Gateway setup in Firebase Console. For immediate cross-device access and to preserve your subscription, sign in with Google or Email.'
                )}
              </p>
              <div className="pt-2 space-y-2">
                <button
                  type="button"
                  onClick={() => { setAuthTab('email'); setEmailMode('signup'); }}
                  className="w-full py-2.5 rounded-xl bg-[#102A43] text-[#D4AF37] font-bold text-xs hover:bg-[#243B53] transition cursor-pointer text-center block"
                >
                  {t('ইমেইল দিয়ে অ্যাকাউন্ট তৈরি করুন', 'Create Account with Email')}
                </button>
                <button
                  type="button"
                  onClick={handleGoogleLogin}
                  className="w-full py-2.5 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 font-bold text-xs transition cursor-pointer text-center block"
                >
                  {t('গুগল দিয়ে দ্রুত সাইন ইন', 'Continue with Google')}
                </button>
              </div>
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
