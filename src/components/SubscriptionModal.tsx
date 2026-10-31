import React, { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { 
  X, 
  Crown, 
  CheckCircle2, 
  ShieldCheck, 
  Send,
  Copy,
  Check,
  Phone,
  Hash,
  Coins,
  Info,
  Clock,
  Calendar,
  Sparkles,
  Layers
} from 'lucide-react';
import { SubscriptionPackage } from '../types';
import { WhatsAppSupportButton } from './WhatsAppSupportButton';

export const SubscriptionModal: React.FC = () => {
  const { 
    language, 
    t, 
    showPaymentModal, 
    setShowPaymentModal, 
    currentUser, 
    paymentSettings,
    packages,
    selectedPackageForPayment,
    setSelectedPackageForPayment,
    examDateConfig,
    createPaymentRequest 
  } = useApp();

  const [activePkg, setActivePkg] = useState<SubscriptionPackage>(() => {
    return selectedPackageForPayment || packages[0];
  });

  const [selectedMethod, setSelectedMethod] = useState<'bKash' | 'Nagad'>('bKash');
  const [studentPhone, setStudentPhone] = useState<string>(currentUser.phone || '');
  const [senderNumber, setSenderNumber] = useState<string>(currentUser.phone || '');
  const [transactionId, setTransactionId] = useState<string>('');
  const [amountPaid, setAmountPaid] = useState<number>(300);
  const [copiedMethod, setCopiedMethod] = useState<'bKash' | 'Nagad' | null>(null);
  const [submitted, setSubmitted] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string>('');

  // Keep activePkg synced with selectedPackageForPayment when opened
  useEffect(() => {
    if (selectedPackageForPayment) {
      setActivePkg(selectedPackageForPayment);
      setAmountPaid(selectedPackageForPayment.price);
    } else if (packages.length > 0) {
      setActivePkg(packages[0]);
      setAmountPaid(packages[0].price);
    }
  }, [selectedPackageForPayment, packages]);

  // When changing package inside modal
  const handleSelectPackage = (pkg: SubscriptionPackage) => {
    setActivePkg(pkg);
    setSelectedPackageForPayment(pkg);
    setAmountPaid(pkg.price);
  };

  if (!showPaymentModal) return null;

  const handleCopy = (numberToCopy: string, method: 'bKash' | 'Nagad') => {
    navigator.clipboard.writeText(numberToCopy);
    setCopiedMethod(method);
    setTimeout(() => {
      setCopiedMethod(null);
    }, 2500);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');

    if (!studentPhone.trim()) {
      setErrorMsg(t('অনুগ্রহ করে আপনার নিবন্ধিত মোবাইল নম্বর দিন।', 'Please provide your registered mobile number.'));
      return;
    }

    if (!transactionId.trim()) {
      setErrorMsg(t('অনুগ্রহ করে ট্রানজেকশন আইডি (TrxID) দিন।', 'Please provide the Transaction ID (TrxID).'));
      return;
    }

    if (!amountPaid || amountPaid <= 0) {
      setErrorMsg(t('সঠিক পরিশোধিত টাকার পরিমাণ দিন।', 'Please provide a valid amount paid.'));
      return;
    }

    const res = createPaymentRequest({
      method: selectedMethod,
      studentPhone: studentPhone.trim(),
      senderNumber: senderNumber.trim() || studentPhone.trim(),
      transactionId: transactionId.trim().toUpperCase(),
      amount: Number(amountPaid),
      packageId: activePkg.id,
      packageTitle: `${activePkg.nameBn} (৳${amountPaid})`
    });

    if (res.success) {
      setSubmitted(true);
    } else {
      setErrorMsg(res.error || t('পেমেন্ট রিকোয়েস্ট পাঠাতে ব্যর্থ হয়েছে।', 'Failed to submit payment request.'));
    }
  };

  const handleClose = () => {
    setSubmitted(false);
    setErrorMsg('');
    setShowPaymentModal(false);
  };

  const formattedExamDate = new Date(examDateConfig.targetExamDate).toLocaleDateString(
    language === 'bn' ? 'bn-BD' : 'en-US',
    { day: 'numeric', month: 'long', year: 'numeric' }
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/75 backdrop-blur-xs overflow-y-auto">
      <div className="bg-white rounded-3xl max-w-xl w-full p-5 sm:p-7 shadow-2xl border border-slate-100 relative my-auto animate-in fade-in zoom-in-95 max-h-[94vh] overflow-y-auto">
        
        {/* Close Button */}
        <button
          onClick={handleClose}
          className="absolute right-4 top-4 sm:right-6 sm:top-6 p-1.5 rounded-full text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition cursor-pointer z-10"
          aria-label="Close modal"
        >
          <X className="w-5 h-5" />
        </button>

        {submitted ? (
          <div className="text-center py-6 sm:py-8 space-y-4">
            <div className="w-16 h-16 rounded-full bg-amber-50 border-2 border-amber-300 text-amber-600 flex items-center justify-center mx-auto">
              <Clock className="w-8 h-8 animate-pulse" />
            </div>

            <div className="space-y-1">
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-100 text-amber-900 text-xs font-bold uppercase tracking-wider">
                <span className="w-2 h-2 rounded-full bg-amber-500 animate-ping"></span>
                <span>স্ট্যাটাস: পেন্ডিং ভেরিফিকেশন (Pending Verification)</span>
              </div>
              <h3 className="text-xl sm:text-2xl font-black text-[#102A43] pt-2">
                {t('পেমেন্ট রিকোয়েস্ট সফলভাবে জমা হয়েছে!', 'Payment Request Submitted Successfully!')}
              </h3>
            </div>

            <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200 text-xs sm:text-sm text-slate-700 space-y-2 text-left max-w-md mx-auto">
              <div className="flex justify-between py-1 border-b border-slate-200">
                <span className="text-slate-500">{t('নির্বাচিত প্যাকেজ:', 'Selected Package:')}</span>
                <strong className="text-[#102A43] text-right">{language === 'bn' ? activePkg.nameBn : activePkg.nameEn}</strong>
              </div>
              <div className="flex justify-between py-1 border-b border-slate-200">
                <span className="text-slate-500">{t('পেমেন্ট মাধ্যম:', 'Payment Method:')}</span>
                <span className="font-bold text-[#102A43]">{selectedMethod} Personal</span>
              </div>
              <div className="flex justify-between py-1 border-b border-slate-200">
                <span className="text-slate-500">{t('নিবন্ধিত মোবাইল:', 'Registered Mobile:')}</span>
                <span className="font-bold text-[#102A43]">{studentPhone}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-slate-200">
                <span className="text-slate-500">{t('ট্রানজাকশন আইডি (TrxID):', 'Transaction ID:')}</span>
                <span className="font-mono font-bold text-emerald-700">{transactionId.toUpperCase()}</span>
              </div>
              <div className="flex justify-between py-1">
                <span className="text-slate-500">{t('পরিশোধিত ফি:', 'Amount Paid:')}</span>
                <span className="font-bold text-[#102A43]">৳ {amountPaid} BDT</span>
              </div>
            </div>

            <p className="text-xs sm:text-sm text-slate-600 max-w-md mx-auto leading-relaxed">
              {t(
                'Sanad Prep BD কর্তৃপক্ষ ব্যাংক/স্টেটমেন্টের সাথে আপনার TrxID ম্যানুয়ালি যাচাই করার সাথে সাথেই আপনার অ্যাকাউন্টে উক্ত সাবস্ক্রিপশন প্ল্যান সক্রিয় হবে। ভুয়া পেমেন্ট স্বয়ংক্রিয়ভাবে বাতিল হবে।',
                'Your payment request has been saved with Pending Verification status. An authorized administrator will manually verify the transaction and activate your plan.'
              )}
            </p>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
              <button
                onClick={handleClose}
                className="w-full sm:w-auto px-6 py-2.5 rounded-xl bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] font-bold text-xs sm:text-sm transition cursor-pointer"
              >
                {t('ঠিক আছে (বন্ধ করুন)', 'Close & Return to Dashboard')}
              </button>

              <WhatsAppSupportButton
                variant="button"
                customText={language === 'bn' ? 'হোয়াটসঅ্যাপে জানান' : 'Notify on WhatsApp'}
                specificContextMessage={`Hello Sanad Prep BD Support, I submitted payment for ${activePkg.nameEn} (৳${amountPaid}) via ${selectedMethod}. My TrxID is ${transactionId.toUpperCase()} and registered phone is ${studentPhone}. Please verify.`}
                className="w-full sm:w-auto py-2.5"
              />
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            
            {/* Header Badge */}
            <div className="flex items-center gap-2">
              <span className="w-8 h-8 rounded-xl bg-[#102A43] text-[#D4AF37] flex items-center justify-center shrink-0">
                <Crown className="w-5 h-5" />
              </span>
              <span className="text-[11px] font-bold text-[#D4AF37] uppercase tracking-wider bg-[#102A43] px-2.5 py-0.5 rounded">
                Sanad Prep BD Official Subscription
              </span>
            </div>

            {/* Title */}
            <div>
              <h2 className="text-xl sm:text-2xl font-black text-[#102A43]">
                {t('বার কাউন্সিল প্রিপারেশন পাস কিনুন', 'Subscribe to Sanad Prep BD Pass')}
              </h2>
              <p className="text-xs text-slate-600 mt-0.5">
                {t(
                  'আপনার সুবিধাজনক সাবস্ক্রিপশন প্ল্যান বেছে নিন এবং বিকাশ বা নগদে সেন্ড মানি করুন।',
                  'Select your preferred subscription package and pay via bKash or Nagad Personal Send Money.'
                )}
              </p>
            </div>

            {/* Package Selection Tabs (Monthly vs One-Time) */}
            <div className="space-y-1.5">
              <label className="font-bold text-xs text-slate-700 block">
                {t('সাবস্ক্রিপশন প্যাকেজ নির্বাচন করুন (মাসিক বা এককালীন):', 'Select Subscription Package (Monthly or One-Time):')}
              </label>
              
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {packages.filter(p => p.isActive).map(pkg => {
                  const isSelected = activePkg.id === pkg.id;
                  const isMonthly = pkg.billingType === 'monthly';
                  return (
                    <button
                      key={pkg.id}
                      type="button"
                      onClick={() => handleSelectPackage(pkg)}
                      className={`p-2.5 rounded-2xl border-2 text-left transition cursor-pointer relative ${
                        isSelected 
                          ? 'border-[#102A43] bg-slate-50 shadow-xs' 
                          : 'border-slate-200 hover:border-slate-300 bg-white'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.2 rounded ${
                          isMonthly ? 'bg-blue-100 text-blue-800' : 'bg-slate-100 text-slate-600'
                        }`}>
                          {isMonthly ? t('মাসিক', 'Monthly') : t('এককালীন', 'One-Time')}
                        </span>
                        {pkg.popular && (
                          <span className="text-[9px] font-bold bg-[#D4AF37] text-[#102A43] px-1.5 py-0.2 rounded font-mono">
                            BEST
                          </span>
                        )}
                      </div>

                      <div className="font-bold text-xs text-[#102A43] truncate mt-1">
                        {language === 'bn' ? pkg.nameBn.split('(')[0] : pkg.nameEn}
                      </div>

                      <div className="flex items-baseline justify-between mt-1 pt-1 border-t border-slate-100">
                        <span className="text-xs font-black text-[#102A43] font-mono">
                          ৳ {pkg.price}
                        </span>
                        <span className="text-[10px] text-slate-500 font-medium">
                          {pkg.validityType === 'days' ? `${pkg.durationDays}d` : 'Exam'}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Selected Package Details Banner */}
            <div className="p-3.5 rounded-2xl bg-gradient-to-r from-slate-50 via-amber-50/30 to-slate-50 border border-[#D4AF37]/50 flex items-center justify-between">
              <div>
                <span className="text-[11px] text-slate-500 block font-semibold">
                  {t('নির্বাচিত প্ল্যান:', 'Selected Plan:')} <strong className="text-[#102A43]">{language === 'bn' ? activePkg.nameBn : activePkg.nameEn}</strong>
                </span>
                <div className="text-xs text-slate-600 mt-0.5 flex items-center gap-2">
                  <Clock className="w-3.5 h-3.5 text-[#D4AF37]" />
                  <span>
                    {activePkg.billingType === 'monthly'
                      ? t(`মেয়াদ: ৩০ দিন (মাসিক সাবস্ক্রিপশন)`, `Validity: 30 Days (Monthly Subscription)`)
                      : activePkg.validityType === 'days' 
                        ? t(`মেয়াদ: ${activePkg.durationDays} দিন (এককালীন প্যাকেজ)`, `Validity: ${activePkg.durationDays} Days (One-Time Package)`)
                        : t(`মেয়াদ: ${formattedExamDate} পর্যন্ত (এককালীন)`, `Validity: Until ${formattedExamDate} (One-Time)`)}
                  </span>
                </div>
              </div>

              <div className="text-right">
                <span className="text-2xl font-black text-[#102A43] font-mono">
                  ৳ {activePkg.price}
                </span>
                <span className="text-[10px] text-slate-400 block font-bold">BDT</span>
              </div>
            </div>

            {/* Payment Method Selector & Number Display */}
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <label className="font-bold text-xs text-slate-800">
                  {t('পেমেন্ট মাধ্যম বেছে নিন ও নম্বর কপি করুন:', 'Payment Gateways & Account Numbers:')}
                </label>
                <span className="text-[11px] font-semibold text-slate-500 bg-slate-100 px-2 py-0.5 rounded">
                  Send Money (Personal)
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {/* bKash Card */}
                <div 
                  onClick={() => setSelectedMethod('bKash')}
                  className={`p-3.5 rounded-2xl border-2 transition cursor-pointer relative flex flex-col justify-between ${
                    selectedMethod === 'bKash'
                      ? 'border-[#D12053] bg-pink-50/40 shadow-xs'
                      : 'border-slate-200 bg-white hover:border-pink-300'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-lg bg-[#D12053] flex items-center justify-center text-white shadow-xs">
                        <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current">
                          <path d="M3 14l7-10 11 3-9 7 9 6-12-2-4 2 1-5z" />
                        </svg>
                      </div>
                      <div>
                        <span className="font-black text-xs text-[#D12053] block leading-none">bKash</span>
                        <span className="text-[10px] text-slate-500">{t('বিকাশ (Personal)', 'bKash Personal')}</span>
                      </div>
                    </div>

                    <div className={`w-4 h-4 rounded-full border flex items-center justify-center ${
                      selectedMethod === 'bKash' ? 'border-[#D12053] bg-[#D12053]' : 'border-slate-300'
                    }`}>
                      {selectedMethod === 'bKash' && <div className="w-1.5 h-1.5 rounded-full bg-white"></div>}
                    </div>
                  </div>

                  <div className="pt-1.5 border-t border-pink-100/60 flex items-center justify-between">
                    <span className="text-sm font-black font-mono tracking-wider text-slate-900">
                      {paymentSettings.bkashNumber || '01712607777'}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCopy(paymentSettings.bkashNumber || '01712607777', 'bKash');
                      }}
                      className={`px-2 py-0.8 rounded-lg text-[11px] font-bold transition flex items-center gap-1 cursor-pointer ${
                        copiedMethod === 'bKash'
                          ? 'bg-emerald-600 text-white'
                          : 'bg-[#D12053] hover:bg-[#b01742] text-white'
                      }`}
                    >
                      {copiedMethod === 'bKash' ? (
                        <>
                          <Check className="w-3 h-3" />
                          <span>{t('কপি হয়েছে!', 'Copied!')}</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3" />
                          <span>{t('কপি নম্বর', 'Copy')}</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>

                {/* Nagad Card */}
                <div 
                  onClick={() => setSelectedMethod('Nagad')}
                  className={`p-3.5 rounded-2xl border-2 transition cursor-pointer relative flex flex-col justify-between ${
                    selectedMethod === 'Nagad'
                      ? 'border-[#F7941D] bg-orange-50/40 shadow-xs'
                      : 'border-slate-200 bg-white hover:border-orange-300'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-[#F7941D] to-[#E2136E] flex items-center justify-center text-white shadow-xs">
                        <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current">
                          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 14.5c-2.48 0-4.5-2.02-4.5-4.5S10.52 7.5 13 7.5c1.47 0 2.78.71 3.6 1.8l-1.6 1.2c-.5-.7-1.2-1-2-1-1.38 0-2.5 1.12-2.5 2.5s1.12 2.5 2.5 2.5c1 0 1.8-.5 2.2-1.3h-2.2v-2h4.5v5.3h-1.5v-1.1c-.8.9-1.9 1.6-3 1.6z"/>
                        </svg>
                      </div>
                      <div>
                        <span className="font-black text-xs text-[#E2136E] block leading-none">Nagad</span>
                        <span className="text-[10px] text-slate-500">{t('নগদ (Personal)', 'Nagad Personal')}</span>
                      </div>
                    </div>

                    <div className={`w-4 h-4 rounded-full border flex items-center justify-center ${
                      selectedMethod === 'Nagad' ? 'border-[#F7941D] bg-[#F7941D]' : 'border-slate-300'
                    }`}>
                      {selectedMethod === 'Nagad' && <div className="w-1.5 h-1.5 rounded-full bg-white"></div>}
                    </div>
                  </div>

                  <div className="pt-1.5 border-t border-orange-100/60 flex items-center justify-between">
                    <span className="text-sm font-black font-mono tracking-wider text-slate-900">
                      {paymentSettings.nagadNumber || '01712607777'}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCopy(paymentSettings.nagadNumber || '01712607777', 'Nagad');
                      }}
                      className={`px-2 py-0.8 rounded-lg text-[11px] font-bold transition flex items-center gap-1 cursor-pointer ${
                        copiedMethod === 'Nagad'
                          ? 'bg-emerald-600 text-white'
                          : 'bg-gradient-to-r from-[#F7941D] to-[#E2136E] text-white'
                      }`}
                    >
                      {copiedMethod === 'Nagad' ? (
                        <>
                          <Check className="w-3 h-3" />
                          <span>{t('কপি হয়েছে!', 'Copied!')}</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3" />
                          <span>{t('কপি নম্বর', 'Copy')}</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Quick 2-Step Instructions */}
            <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-600 space-y-1">
              <div className="flex items-start gap-1.5">
                <Info className="w-3.5 h-3.5 text-[#102A43] shrink-0 mt-0.5" />
                <p className="font-semibold text-slate-800">
                  {t(
                    `১. ${selectedMethod} অ্যাপ থেকে ${selectedMethod === 'bKash' ? paymentSettings.bkashNumber : paymentSettings.nagadNumber} নম্বরে ৳${activePkg.price} "Send Money" করুন।`,
                    `1. Send ৳${activePkg.price} via "Send Money" to ${selectedMethod === 'bKash' ? paymentSettings.bkashNumber : paymentSettings.nagadNumber} from your ${selectedMethod} app.`
                  )}
                </p>
              </div>
              <p className="pl-5 text-slate-500">
                {t(
                  '২. সেন্ড মানি সম্পন্ন হলে নিচের ফর্মে প্রাপ্ত ট্রানজেকশন আইডি (TrxID) ও নম্বর দিয়ে সাবমিট করুন।',
                  '2. After payment, enter your Transaction ID (TrxID) and registered mobile below.'
                )}
              </p>
            </div>

            {/* WhatsApp Assistance Banner on Payment Instructions */}
            <div className="flex items-center justify-between p-3 rounded-xl bg-emerald-50/80 border border-emerald-200">
              <div className="text-xs text-emerald-950 font-medium">
                {t('পেমেন্ট বা যাচাইকরণে সমস্যা হচ্ছে?', 'Having issues with payment or TrxID?')}
              </div>
              <WhatsAppSupportButton 
                variant="compact"
                specificContextMessage={`Hello Sanad Prep BD Support, I need help with my payment for ${activePkg.nameEn} (৳${activePkg.price}).`}
              />
            </div>

            {/* Post-Payment Submission Form */}
            <form onSubmit={handleSubmit} className="space-y-3 text-xs sm:text-sm">
              {errorMsg && (
                <div className="p-2.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 font-semibold text-xs">
                  {errorMsg}
                </div>
              )}

              {/* Registered Student Mobile */}
              <div>
                <label className="font-bold text-slate-700 block mb-1">
                  {t('শিক্ষার্থীর নিবন্ধিত মোবাইল নম্বর', 'Registered Student Mobile Number')} <span className="text-rose-500">*</span>
                </label>
                <div className="relative">
                  <Phone className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
                  <input
                    type="text"
                    required
                    placeholder="01XXXXXXXXX"
                    value={studentPhone}
                    onChange={(e) => setStudentPhone(e.target.value)}
                    className="w-full pl-9 pr-3 py-2 rounded-xl border border-slate-300 font-mono text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-[#102A43]"
                  />
                </div>
              </div>

              {/* Sender Number & Amount */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-bold text-slate-700 block mb-1">
                    {t('টাকা পাঠানোর নম্বর', 'Sender Mobile')} <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="01XXXXXXXXX"
                    value={senderNumber}
                    onChange={(e) => setSenderNumber(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 font-mono text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-[#102A43]"
                  />
                </div>

                <div>
                  <label className="font-bold text-slate-700 block mb-1">
                    {t('পরিশোধিত টাকার পরিমাণ (৳)', 'Amount Paid (BDT)')} <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="number"
                    required
                    min={100}
                    value={amountPaid}
                    onChange={(e) => setAmountPaid(Number(e.target.value))}
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 font-mono font-bold text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-[#102A43]"
                  />
                </div>
              </div>

              {/* Transaction ID */}
              <div>
                <label className="font-bold text-slate-700 block mb-1">
                  {t('ট্রানজাকশন আইডি (TrxID)', 'Transaction ID (TrxID)')} <span className="text-rose-500">*</span>
                </label>
                <div className="relative">
                  <Hash className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
                  <input
                    type="text"
                    required
                    placeholder="e.g. 9K28DF10PQ"
                    value={transactionId}
                    onChange={(e) => setTransactionId(e.target.value)}
                    className="w-full pl-9 pr-3 py-2 rounded-xl border border-slate-300 uppercase font-mono font-bold tracking-wider text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-[#102A43]"
                  />
                </div>
              </div>

              {/* Security Warning */}
              <div className="flex items-start gap-2 text-[11px] text-slate-500 pt-1 bg-slate-50 p-2.5 rounded-xl border border-slate-100">
                <ShieldCheck className="w-4 h-4 text-[#D4AF37] shrink-0 mt-0.5" />
                <span>
                  {t(
                    'নিরাপত্তা সতর্কতা: কখনোই আপনার বিকাশ বা নগদ পিন (PIN) কাউকে জানাবেন না। অ্যাডমিন শুধুমাত্র পাবলিক TrxID মিলিয়ে ম্যানুয়ালি প্রোপাস সক্রিয় করবেন।',
                    'Security note: Never share your bKash or Nagad PIN or OTP. Only the public Transaction ID is verified.'
                  )}
                </span>
              </div>

              {/* Submit Button */}
              <div className="pt-2">
                <button
                  type="submit"
                  className="w-full py-3 rounded-xl bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] border border-[#D4AF37] font-bold text-xs sm:text-sm transition shadow-sm flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Send className="w-4 h-4" />
                  <span>{t('পেমেন্ট যাচাইয়ের অনুরোধ পাঠান', 'Submit Payment for Verification')}</span>
                </button>
              </div>
            </form>
          </div>
        )}

      </div>
    </div>
  );
};
