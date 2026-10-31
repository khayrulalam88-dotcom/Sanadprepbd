import React from 'react';
import { useApp } from '../context/AppContext';
import { 
  Check, 
  Crown, 
  Clock, 
  Sparkles, 
  Calendar, 
  ArrowRight, 
  ShieldCheck,
  CheckCircle2,
  Zap
} from 'lucide-react';
import { WhatsAppSupportButton } from './WhatsAppSupportButton';

interface Props {
  className?: string;
  titleBn?: string;
  titleEn?: string;
  subtitleBn?: string;
  subtitleEn?: string;
}

export const SubscriptionPlansSection: React.FC<Props> = ({
  className = '',
  titleBn = 'বার কাউন্সিল পরীক্ষার জন্য সেরা সাবস্ক্রিপশন প্ল্যান',
  titleEn = 'Choose Your Bar Council Preparation Pass',
  subtitleBn = 'প্রস্তুতির ধরন ও সময়সীমা অনুযায়ী আপনার উপযোগী প্যাকেজটি বেছে নিন',
  subtitleEn = 'Select the ideal plan tailored to your exam timeline and preparation depth'
}) => {
  const { 
    language, 
    t, 
    packages, 
    examDateConfig, 
    activeSubscription, 
    openSubscriptionModal 
  } = useApp();

  const formattedExamDate = new Date(examDateConfig.targetExamDate).toLocaleDateString(
    language === 'bn' ? 'bn-BD' : 'en-US',
    { day: 'numeric', month: 'long', year: 'numeric' }
  );

  return (
    <div className={`space-y-8 ${className}`}>
      
      {/* Section Header */}
      <div className="text-center max-w-3xl mx-auto space-y-2">
        <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#102A43] text-[#D4AF37] text-xs font-bold border border-[#D4AF37]/30 shadow-xs">
          <Crown className="w-3.5 h-3.5 text-[#D4AF37]" />
          <span>{t('অফিসিয়াল সাবস্ক্রিপশন প্যাকেজসমূহ', 'Official Sanad Prep BD Passes')}</span>
        </div>
        <h2 className="text-2xl sm:text-4xl font-black text-[#102A43] tracking-tight">
          {t(titleBn, titleEn)}
        </h2>
        <p className="text-xs sm:text-sm text-slate-600">
          {t(subtitleBn, subtitleEn)}
        </p>
      </div>

      {/* Target Exam Date Banner */}
      <div className="max-w-2xl mx-auto p-3.5 rounded-2xl bg-amber-50/80 border border-[#D4AF37]/50 text-xs text-amber-950 flex flex-col sm:flex-row sm:items-center justify-between gap-2 shadow-xs">
        <div className="flex items-center gap-2">
          <Calendar className="w-4 h-4 text-[#102A43] shrink-0" />
          <span>
            <strong className="text-[#102A43]">{t('লক্ষ্য বার কাউন্সিল পরীক্ষা:', 'Target Bar Council Exam:')}</strong>{' '}
            {formattedExamDate} ({examDateConfig.timezone})
          </span>
        </div>
        <span className="text-[11px] font-bold text-amber-800 bg-amber-100/90 px-2 py-0.5 rounded border border-amber-300 shrink-0">
          {t('অফিসিয়াল শিডিউল সিঙ্কড', 'Schedule Synced')}
        </span>
      </div>

      {/* Packages Cards (Monthly Subscription & One-Time Packages) */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 items-stretch">
        {packages.filter(p => p.isActive).map((pkg) => {
          const isCurrentActive = activeSubscription?.packageId === pkg.id && new Date(activeSubscription.expiresAt).getTime() > Date.now();
          const isExamPass = pkg.id === 'pkg_exam_pass';
          const isMonthly = pkg.billingType === 'monthly';

          return (
            <div
              key={pkg.id}
              className={`rounded-3xl p-6 sm:p-7 flex flex-col justify-between transition-all duration-200 relative bg-white border-2 shadow-sm ${
                pkg.popular
                  ? 'border-[#D4AF37] ring-4 ring-[#D4AF37]/15 shadow-md -translate-y-1'
                  : 'border-slate-200 hover:border-slate-300'
              }`}
            >
              {/* Badge */}
              {pkg.popular && (
                <div className="absolute -top-3.5 left-1/2 -translate-x-1/2">
                  <span className="px-3.5 py-1 rounded-full bg-[#102A43] text-[#D4AF37] border border-[#D4AF37] text-xs font-black uppercase tracking-wider shadow-sm flex items-center gap-1">
                    <Sparkles className="w-3 h-3 text-[#D4AF37]" />
                    <span>{t('সেরা পছন্দ', 'Most Popular')}</span>
                  </span>
                </div>
              )}

              {isMonthly && !pkg.popular && (
                <div className="absolute -top-3.5 left-1/2 -translate-x-1/2">
                  <span className="px-3 py-0.5 rounded-full bg-blue-600 text-white text-[11px] font-bold uppercase tracking-wider shadow-xs">
                    {t('মাসিক সাবস্ক্রিপশন', 'Monthly Pass')}
                  </span>
                </div>
              )}

              {isExamPass && !pkg.popular && (
                <div className="absolute -top-3.5 left-1/2 -translate-x-1/2">
                  <span className="px-3 py-0.5 rounded-full bg-[#243B53] text-[#D4AF37] text-[11px] font-bold uppercase tracking-wider shadow-xs">
                    {t('পরীক্ষা পর্যন্ত মেয়াদ', 'Until Exam Day')}
                  </span>
                </div>
              )}

              {/* Card Header */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
                    {isMonthly ? t('মাসিক প্ল্যান', 'Monthly Pass') : t('এককালীন প্যাকেজ', 'One-Time')}
                  </span>
                  {isCurrentActive && (
                    <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[11px] font-bold flex items-center gap-1 border border-emerald-300">
                      <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                      <span>{t('সক্রিয় প্যাক', 'Current Plan')}</span>
                    </span>
                  )}
                </div>

                <h3 className="text-xl font-black text-[#102A43] leading-snug">
                  {language === 'bn' ? pkg.nameBn : pkg.nameEn}
                </h3>

                <p className="text-xs text-slate-600 leading-relaxed min-h-[36px]">
                  {language === 'bn' ? pkg.taglineBn : pkg.taglineEn}
                </p>

                {/* Price Display */}
                <div className="pt-2 pb-3 border-y border-slate-100 flex items-baseline justify-between">
                  <div>
                    <span className="text-xs text-slate-400 font-semibold uppercase tracking-wider block">
                      {isMonthly ? t('মাসিক ফি', 'Monthly Fee') : t('এককালীন ফি', 'One-Time Fee')}
                    </span>
                    <div className="flex items-baseline gap-1">
                      <span className="text-3xl sm:text-4xl font-black text-[#102A43] font-mono">
                        ৳ {pkg.price}
                      </span>
                      <span className="text-xs text-slate-500 font-bold">BDT</span>
                    </div>
                  </div>

                  {/* Validity Info */}
                  <div className="text-right">
                    <span className="text-xs text-slate-400 font-semibold uppercase tracking-wider block">
                      {t('কার্যকাল', 'Validity')}
                    </span>
                    <span className="text-xs sm:text-sm font-bold text-slate-800 flex items-center gap-1 justify-end">
                      <Clock className="w-3.5 h-3.5 text-[#D4AF37]" />
                      {pkg.billingType === 'monthly' ? (
                        <span>30 {t('দিন (মাসিক)', 'Days (Monthly)')}</span>
                      ) : pkg.validityType === 'days' ? (
                        <span>{pkg.durationDays} {t('দিন', 'Days')}</span>
                      ) : (
                        <span>{t('পরীক্ষার দিন পর্যন্ত', 'Until Exam')}</span>
                      )}
                    </span>
                  </div>
                </div>

                {/* Detailed Features */}
                <div className="pt-2 space-y-2.5">
                  <span className="text-xs font-bold text-slate-700 block">
                    {t('অন্তর্ভুক্ত সুবিধাসমূহ:', 'Included Features:')}
                  </span>
                  <ul className="space-y-2 text-xs text-slate-600">
                    {(language === 'bn' ? pkg.featuresBn : pkg.featuresEn).map((feature, fIdx) => (
                      <li key={fIdx} className="flex items-start gap-2">
                        <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                        <span className="leading-snug">{feature}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              {/* Action Button */}
              <div className="pt-6 mt-4 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => openSubscriptionModal(pkg.id)}
                  className={`w-full py-3 px-4 rounded-2xl font-bold text-xs sm:text-sm transition flex items-center justify-center gap-2 cursor-pointer shadow-sm ${
                    pkg.popular
                      ? 'bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] border border-[#D4AF37]'
                      : 'bg-slate-900 hover:bg-[#102A43] text-white'
                  }`}
                >
                  <Crown className="w-4 h-4 text-[#D4AF37]" />
                  <span>
                    {isCurrentActive 
                      ? t('পুনরায় রিনিউ / বৃদ্ধি করুন', 'Renew / Extend') 
                      : t('সাবস্ক্রাইব করুন (Buy Now)', 'Buy Now')}
                  </span>
                  <ArrowRight className="w-4 h-4" />
                </button>

                <p className="text-[10px] text-center text-slate-400 mt-2">
                  {t('বিকাশ ও নগদ পার্সোনাল সেন্ড মানি সমর্থিত', 'bKash & Nagad Personal Send Money Supported')}
                </p>
              </div>

            </div>
          );
        })}
      </div>

      {/* Security Note Footer */}
      <div className="p-4 rounded-2xl bg-white border border-slate-200 text-xs text-slate-600 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-xs">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-emerald-600 shrink-0" />
          <span>
            {t(
              'নিরাপদ পেমেন্ট গ্যারান্টি: কোনো ভুয়া অটোমেশন নেই। প্রতিটি পেমেন্ট ব্যাংক স্টেটমেন্টের সাথে অ্যাডমিন কর্তৃক যাচাই করে সক্রিয় করা হয়।',
              'Safe & manual ledger verification: Every transaction is validated against official statements before activation.'
            )}
          </span>
        </div>
        <span className="text-[11px] font-bold text-slate-500 whitespace-nowrap">
          Support: 01712607777 (bKash/Nagad)
        </span>
      </div>

      {/* WhatsApp Assistance Card */}
      <WhatsAppSupportButton variant="card" />

    </div>
  );
};
