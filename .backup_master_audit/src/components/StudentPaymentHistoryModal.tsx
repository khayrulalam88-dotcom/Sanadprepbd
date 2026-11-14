import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { 
  X, 
  Receipt, 
  Clock, 
  CheckCircle2, 
  XCircle, 
  AlertCircle, 
  Crown, 
  Copy, 
  Check, 
  ExternalLink, 
  CreditCard,
  Calendar,
  Sparkles,
  ShieldCheck
} from 'lucide-react';
import { WhatsAppSupportButton } from './WhatsAppSupportButton';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export const StudentPaymentHistoryModal: React.FC<Props> = ({ isOpen, onClose }) => {
  const { 
    language, 
    t, 
    currentUser, 
    paymentRequests, 
    subscriptions, 
    activeSubscription,
    calculateDaysRemaining,
    openSubscriptionModal
  } = useApp();

  const [filter, setFilter] = useState<'all' | 'pending' | 'approved' | 'rejected'>('all');
  const [copiedTrxId, setCopiedTrxId] = useState<string | null>(null);

  if (!isOpen) return null;

  // Filter payment requests for current student
  const studentPayments = paymentRequests.filter(p => 
    p.userId === currentUser.uid || 
    (p.studentPhone && currentUser.phone && p.studentPhone.replace(/[^0-9]/g, '') === currentUser.phone.replace(/[^0-9]/g, ''))
  );

  const filteredPayments = studentPayments.filter(p => {
    if (filter === 'all') return true;
    return p.status === filter;
  });

  const handleCopyTrx = (trx: string) => {
    navigator.clipboard.writeText(trx);
    setCopiedTrxId(trx);
    setTimeout(() => setCopiedTrxId(null), 2000);
  };

  const daysRemaining = activeSubscription ? calculateDaysRemaining(activeSubscription.expiresAt) : 0;
  const isSubscriptionActive = activeSubscription && daysRemaining > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/70 backdrop-blur-xs overflow-y-auto animate-in fade-in">
      <div 
        className="bg-white rounded-3xl max-w-2xl w-full shadow-2xl border border-slate-200 overflow-hidden my-auto flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-5 sm:p-6 bg-gradient-to-r from-[#102A43] to-[#243B53] text-white flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-[#D4AF37]/20 border border-[#D4AF37]/40 flex items-center justify-center text-[#D4AF37]">
              <Receipt className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base sm:text-lg font-black tracking-tight">
                {t('আমার পেমেন্ট ও সাবস্ক্রিপশন ইতিহাস', 'My Payment & Subscription History')}
              </h3>
              <p className="text-xs text-slate-300">
                {t('আপনার সকল TrxID সাবমিশন, অনুমোদন স্থিতি ও সাবস্ক্রিপশন রেকর্ড', 'Track TrxID submissions, approval status & active passes')}
              </p>
            </div>
          </div>

          <button 
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Current Subscription Status Strip */}
        <div className={`p-4 border-b flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs shrink-0 ${
          isSubscriptionActive 
            ? 'bg-emerald-50/70 border-emerald-200 text-emerald-950' 
            : currentUser.subscriptionStatus === 'expired'
              ? 'bg-rose-50/70 border-rose-200 text-rose-950'
              : 'bg-slate-50 border-slate-200 text-slate-800'
        }`}>
          <div className="flex items-center gap-2.5">
            <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${
              isSubscriptionActive ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-600'
            }`}>
              <Crown className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold">
                  {isSubscriptionActive 
                    ? t('বর্তমান সক্রিয় সাবস্ক্রিপশন:', 'Active Subscription:') 
                    : currentUser.subscriptionStatus === 'expired'
                      ? t('সাবস্ক্রিপশন মেয়াদ শেষ:', 'Pass Expired:')
                      : t('বর্তমান স্ট্যাটাস:', 'Current Tier:')}
                </span>
                <span className={`px-2 py-0.5 rounded-full font-bold text-[10px] uppercase ${
                  isSubscriptionActive 
                    ? 'bg-emerald-200 text-emerald-900' 
                    : currentUser.subscriptionStatus === 'expired'
                      ? 'bg-rose-200 text-rose-900'
                      : 'bg-slate-200 text-slate-700'
                }`}>
                  {isSubscriptionActive ? 'PRO ACTIVE' : currentUser.subscriptionStatus === 'expired' ? 'EXPIRED' : 'FREE TIER'}
                </span>
              </div>
              <p className="text-[11px] text-slate-600 mt-0.5">
                {isSubscriptionActive 
                  ? `${language === 'bn' ? activeSubscription.packageNameBn : activeSubscription.packageNameEn} • মেয়াদ: ${new Date(activeSubscription.expiresAt).toLocaleDateString()} (${daysRemaining} দিন বাকি)`
                  : t('পেইড মডেল টেস্ট ও MCQ ব্যাংক আনলক করতে সাবস্ক্রিপশন সক্রিয় করুন।', 'Unlock full-length mock tests and question bank with a subscription.')}
              </p>
            </div>
          </div>

          <button
            onClick={() => {
              onClose();
              openSubscriptionModal();
            }}
            className="px-3.5 py-1.5 rounded-xl bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] font-bold text-xs shrink-0 transition flex items-center justify-center gap-1 cursor-pointer self-start sm:self-auto shadow-xs"
          >
            <Sparkles className="w-3.5 h-3.5 text-[#D4AF37]" />
            <span>{isSubscriptionActive ? t('প্ল্যান পরিবর্তন', 'Change Plan') : t('সাবস্ক্রিপশন নিন', 'Upgrade Pass')}</span>
          </button>
        </div>

        {/* Filter Pills */}
        <div className="p-4 border-b border-slate-100 flex items-center justify-between gap-2 overflow-x-auto text-xs shrink-0">
          <div className="flex items-center gap-1.5">
            {[
              { id: 'all', labelBn: 'সকল রিকোয়েস্ট', labelEn: 'All', count: studentPayments.length },
              { id: 'pending', labelBn: 'অপেক্ষমান', labelEn: 'Pending', count: studentPayments.filter(p => p.status === 'pending').length },
              { id: 'approved', labelBn: 'অনুমোদিত', labelEn: 'Approved', count: studentPayments.filter(p => p.status === 'approved').length },
              { id: 'rejected', labelBn: 'বাতিলকৃত', labelEn: 'Rejected', count: studentPayments.filter(p => p.status === 'rejected').length }
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => setFilter(tab.id as any)}
                className={`px-3 py-1.5 rounded-xl font-bold transition whitespace-nowrap cursor-pointer flex items-center gap-1.5 ${
                  filter === tab.id 
                    ? 'bg-[#102A43] text-white shadow-xs' 
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                <span>{language === 'bn' ? tab.labelBn : tab.labelEn}</span>
                <span className={`px-1.5 py-0.2 rounded-full text-[10px] ${
                  filter === tab.id ? 'bg-white/20 text-white' : 'bg-slate-200 text-slate-700'
                }`}>
                  {tab.count}
                </span>
              </button>
            ))}
          </div>

          <span className="text-[11px] text-slate-400 font-medium hidden sm:inline">
            {t(`মোট ${studentPayments.length}টি ট্রানজাকশন`, `${studentPayments.length} total`)}
          </span>
        </div>

        {/* Payments List Body */}
        <div className="p-4 sm:p-6 overflow-y-auto space-y-3.5 flex-1">
          {filteredPayments.length === 0 ? (
            <div className="p-8 text-center space-y-3 text-slate-400">
              <Receipt className="w-10 h-10 mx-auto opacity-40 text-[#102A43]" />
              <p className="text-xs sm:text-sm font-bold text-slate-600">
                {t('কোনো পেমেন্ট রেকর্ড পাওয়া যায়নি', 'No payment records found under this filter')}
              </p>
              <p className="text-xs text-slate-400 max-w-sm mx-auto">
                {t('বিকাশ বা নগদে টাকা পাঠিয়ে ট্রানজাকশন আইডি জমা দিলে এখানে স্ট্যাটাস ও ইতিহাস দেখতে পাবেন।', 'Submit your bKash or Nagad transaction ID to see verification progress.')}
              </p>
              <button
                onClick={() => {
                  onClose();
                  openSubscriptionModal();
                }}
                className="px-4 py-2 rounded-xl bg-[#102A43] text-[#D4AF37] font-bold text-xs cursor-pointer inline-flex items-center gap-1.5 shadow-xs"
              >
                <Crown className="w-3.5 h-3.5 text-[#D4AF37]" />
                <span>{t('প্যাকেজ দেখুন ও পেমেন্ট করুন', 'View Subscription Plans')}</span>
              </button>
            </div>
          ) : (
            filteredPayments.map((payment) => {
              const isPending = payment.status === 'pending';
              const isApproved = payment.status === 'approved';
              const isRejected = payment.status === 'rejected';

              return (
                <div 
                  key={payment.id}
                  className={`p-4 rounded-2xl border transition flex flex-col justify-between gap-3 text-xs ${
                    isPending 
                      ? 'bg-amber-50/40 border-amber-300 ring-1 ring-amber-200' 
                      : isApproved
                        ? 'bg-emerald-50/30 border-emerald-200'
                        : 'bg-rose-50/30 border-rose-200'
                  }`}
                >
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2.5 border-b border-slate-100">
                    <div className="flex items-center gap-2">
                      <span className={`px-2.5 py-0.5 rounded-full font-bold text-[10px] uppercase tracking-wider flex items-center gap-1 ${
                        isPending 
                          ? 'bg-amber-100 text-amber-900 border border-amber-300' 
                          : isApproved
                            ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                            : 'bg-rose-100 text-rose-800 border border-rose-300'
                      }`}>
                        {isPending && <Clock className="w-3 h-3 text-amber-700 animate-pulse" />}
                        {isApproved && <CheckCircle2 className="w-3 h-3 text-emerald-700" />}
                        {isRejected && <XCircle className="w-3 h-3 text-rose-700" />}
                        <span>
                          {isPending ? t('অপেক্ষমান (Pending)', 'Pending Review') : isApproved ? t('অনুমোদিত (Approved)', 'Approved') : t('বাতিল (Rejected)', 'Rejected')}
                        </span>
                      </span>

                      <span className={`px-2 py-0.5 rounded-md font-bold text-[10px] ${
                        payment.method === 'bKash' ? 'bg-[#D12053]/10 text-[#D12053]' : 'bg-[#F7941D]/10 text-[#F7941D]'
                      }`}>
                        {payment.method}
                      </span>

                      <span className="font-bold text-slate-800">
                        {language === 'bn' ? payment.packageNameBn : payment.packageNameEn}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="font-black text-sm text-[#102A43]">
                        ৳ {payment.amount} BDT
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] text-slate-600">
                    <div className="flex items-center gap-1.5">
                      <span className="text-slate-400">{t('ট্রানজাকশন আইডি:', 'TrxID:')}</span>
                      <strong className="font-mono text-slate-900 bg-white px-2 py-0.5 rounded border border-slate-200">
                        {payment.transactionId}
                      </strong>
                      <button
                        onClick={() => handleCopyTrx(payment.transactionId)}
                        className="text-slate-400 hover:text-slate-700 cursor-pointer ml-1"
                        title="Copy TrxID"
                      >
                        {copiedTrxId === payment.transactionId ? (
                          <Check className="w-3.5 h-3.5 text-emerald-600" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>

                    <div>
                      <span className="text-slate-400">{t('প্রেরক নম্বর:', 'Sender:')}</span>{' '}
                      <strong className="text-slate-800 font-mono">{payment.senderNumber}</strong>
                    </div>

                    <div>
                      <span className="text-slate-400">{t('সাবমিটের সময়:', 'Submitted:')}</span>{' '}
                      <span className="text-slate-700">{new Date(payment.requestedAt).toLocaleString()}</span>
                    </div>

                    {payment.verifiedAt && (
                      <div>
                        <span className="text-slate-400">{t('যাচাইয়ের সময়:', 'Verified:')}</span>{' '}
                        <span className="text-slate-700">{new Date(payment.verifiedAt).toLocaleString()}</span>
                      </div>
                    )}
                  </div>

                  {/* Status explanation alert */}
                  {isPending && (
                    <div className="p-2.5 rounded-xl bg-amber-100/60 border border-amber-200 text-amber-900 text-[11px] flex items-start gap-2">
                      <AlertCircle className="w-3.5 h-3.5 text-amber-700 shrink-0 mt-0.5" />
                      <span>
                        {t(
                          'আপনার পেমেন্টটি বর্তমানে অ্যাডমিন অনুমোদনের অপেক্ষায় রয়েছে। অ্যাডমিন TrxID যাচাই করা মাত্রই প্রো সুবিধা স্বয়ংক্রিয়ভাবে চালু হবে।',
                          'Your transaction is awaiting manual admin verification. Access will be unlocked as soon as verified.'
                        )}
                      </span>
                    </div>
                  )}

                  {isApproved && (
                    <div className="p-2.5 rounded-xl bg-emerald-100/60 border border-emerald-200 text-emerald-900 text-[11px] flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5">
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-700 shrink-0" />
                        <span>{t('পেমেন্ট সফলভাবে যাচাই ও অনুমোদিত হয়েছে।', 'Payment verified and approved.')}</span>
                      </div>
                      {payment.verifiedBy && (
                        <span className="text-emerald-700 text-[10px]">
                          {t('যাচাইকারী:', 'By:')} {payment.verifiedBy}
                        </span>
                      )}
                    </div>
                  )}

                  {isRejected && (
                    <div className="p-2.5 rounded-xl bg-rose-100/70 border border-rose-200 text-rose-950 text-[11px] space-y-1">
                      <div className="font-bold flex items-center gap-1.5 text-rose-800">
                        <XCircle className="w-3.5 h-3.5 text-rose-700 shrink-0" />
                        <span>{t('পেমেন্ট রিকোয়েস্ট বাতিল করা হয়েছে', 'Payment Request Rejected')}</span>
                      </div>
                      <p className="text-rose-900 pl-5">
                        {t('কারণ:', 'Reason:')} <strong>{payment.rejectionReason || 'Unverified TrxID'}</strong>
                      </p>
                      <p className="text-[10px] text-rose-700 pl-5">
                        {t('যদি আপনি সঠিক টাকা পাঠিয়ে থাকেন, অনুগ্রহ করে WhatsApp সাপোর্টে প্রমাণসহ মেসেজ দিন।', 'If you sent the money, please contact WhatsApp support with proof.')}
                      </p>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="p-4 bg-slate-50 border-t border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs shrink-0">
          <div className="flex items-center gap-2">
            <WhatsAppSupportButton className="py-2 px-3 text-xs" />
          </div>

          <button
            onClick={onClose}
            className="px-5 py-2 rounded-xl bg-[#102A43] text-white font-bold text-xs hover:bg-[#243B53] transition cursor-pointer self-end sm:self-auto"
          >
            {t('বন্ধ করুন', 'Close')}
          </button>
        </div>

      </div>
    </div>
  );
};
