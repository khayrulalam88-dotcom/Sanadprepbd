import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { OWNER_ADMIN_UID } from '../lib/firebase';
import { 
  X, 
  UserCog, 
  Calendar, 
  Clock, 
  Crown, 
  ShieldCheck, 
  Save, 
  Smartphone, 
  AlertTriangle,
  CheckCircle,
  PlusCircle,
  Phone,
  Mail,
  User,
  Zap
} from 'lucide-react';
import { UserRole, UserSubscription } from '../types';

export interface EditableUserData {
  userId: string;
  subscriptionId?: string;
  name: string;
  email: string;
  phone: string;
  role: UserRole;
  subscriptionStatus: 'free' | 'pro' | 'expired';
  packageId?: string;
  packageNameBn?: string;
  packageNameEn?: string;
  expiresAt: string;
  isSessionRevoked?: boolean;
}

interface EditUserModalProps {
  user: EditableUserData;
  isOpen: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

export const EditUserModal: React.FC<EditUserModalProps> = ({
  user,
  isOpen,
  onClose,
  onSaved
}) => {
  const { language, t, packages, adminUpdateUser } = useApp();

  const [name, setName] = useState<string>(user.name || '');
  const [email, setEmail] = useState<string>(user.email || '');
  const [phone, setPhone] = useState<string>(user.phone || '');
  const [role, setRole] = useState<UserRole>(user.role || 'student');
  const [subscriptionStatus, setSubscriptionStatus] = useState<'free' | 'pro' | 'expired'>(user.subscriptionStatus || 'pro');
  const [packageId, setPackageId] = useState<string>(user.packageId || packages[0]?.id || 'pkg_pro_mock');
  
  // Format datetime-local string (YYYY-MM-DDTHH:mm)
  const initialDateStr = user.expiresAt 
    ? new Date(user.expiresAt).toISOString().slice(0, 16)
    : new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString().slice(0, 16);

  const [expiryDateInput, setExpiryDateInput] = useState<string>(initialDateStr);
  const [isSessionRevoked, setIsSessionRevoked] = useState<boolean>(user.isSessionRevoked || false);
  const [saving, setSaving] = useState<boolean>(false);
  const [successMsg, setSuccessMsg] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string>('');

  if (!isOpen) return null;

  // Calculate remaining days from current input date
  const getDaysRemaining = () => {
    try {
      const targetTime = new Date(expiryDateInput).getTime();
      const diff = targetTime - Date.now();
      return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
    } catch (e) {
      return 0;
    }
  };

  const remainingDays = getDaysRemaining();

  // Quick extend helper
  const handleQuickExtend = (daysToAdd: number) => {
    try {
      const currentTarget = new Date(expiryDateInput).getTime();
      const baseTime = currentTarget > Date.now() ? currentTarget : Date.now();
      const newTarget = new Date(baseTime + daysToAdd * 24 * 3600 * 1000);
      setExpiryDateInput(newTarget.toISOString().slice(0, 16));
      setSubscriptionStatus('pro');
    } catch (e) {
      console.warn('Error extending date:', e);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    setSuccessMsg('');

    if (!name.trim()) {
      setErrorMsg(t('শিক্ষার্থীর নাম প্রদান করুন', 'Please provide student name'));
      return;
    }

    if (!phone.trim()) {
      setErrorMsg(t('মোবাইল নম্বর প্রদান করুন', 'Please provide phone number'));
      return;
    }

    setSaving(true);

    const selectedPkg = packages.find(p => p.id === packageId);
    const isoExpiry = new Date(expiryDateInput).toISOString();

    const result = adminUpdateUser({
      userId: user.userId,
      subscriptionId: user.subscriptionId,
      name: name.trim(),
      email: email.trim(),
      phone: phone.trim(),
      role,
      subscriptionStatus,
      packageId,
      packageNameBn: selectedPkg?.nameBn || 'প্রো মডেল টেস্ট পাস',
      packageNameEn: selectedPkg?.nameEn || 'Pro Model Test Pass',
      expiresAt: isoExpiry,
      isSessionRevoked
    });

    setSaving(false);

    if (result.success) {
      setSuccessMsg(t('ইউজার ও সাবস্ক্রিপশন সফলভাবে আপডেট করা হয়েছে!', 'User and subscription updated successfully!'));
      setTimeout(() => {
        if (onSaved) onSaved();
        onClose();
      }, 1200);
    } else {
      setErrorMsg(result.message || 'Update failed');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs overflow-y-auto">
      <div className="bg-white rounded-3xl max-w-xl w-full p-6 sm:p-7 shadow-2xl border border-slate-200 relative my-8 animate-in fade-in zoom-in-95 duration-150">
        
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-[#102A43] text-[#D4AF37] flex items-center justify-center shadow-xs">
              <UserCog className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-black text-[#102A43]">
                {t('একটিভ ইউজার ও সাবস্ক্রিপশন এডিট', 'Edit Active User & Subscription')}
              </h2>
              <p className="text-xs text-slate-500 font-mono">
                User ID: {user.userId} {user.subscriptionId ? `• Sub: ${user.subscriptionId}` : ''}
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-500 hover:text-slate-700 flex items-center justify-center transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Feedback Alerts */}
        {errorMsg && (
          <div className="mt-4 p-3 rounded-2xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-semibold flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        {successMsg && (
          <div className="mt-4 p-3 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-semibold flex items-center gap-2">
            <CheckCircle className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>{successMsg}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-5 space-y-5 text-xs sm:text-sm">
          
          {/* Section 1: User Profile Info */}
          <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200 space-y-3">
            <span className="text-[11px] font-bold text-[#102A43] uppercase tracking-wider block">
              {t('১. ইউজার প্রোফাইল তথ্য', '1. User Profile Details')}
            </span>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-bold text-slate-700 block mb-1">
                  {t('পূর্ণ নাম (Full Name):', 'Full Name:')}
                </label>
                <div className="relative">
                  <User className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
                  <input
                    type="text"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. মো: খাইরুল আলম"
                    className="w-full pl-9 pr-3 py-2 rounded-xl border border-slate-300 text-xs bg-white focus:ring-2 focus:ring-[#102A43]"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-bold text-slate-700 block mb-1">
                  {t('মোবাইল নম্বর (Phone):', 'Phone Number:')}
                </label>
                <div className="relative">
                  <Phone className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
                  <input
                    type="text"
                    required
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="01712-345678"
                    className="w-full pl-9 pr-3 py-2 rounded-xl border border-slate-300 text-xs bg-white focus:ring-2 focus:ring-[#102A43]"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-bold text-slate-700 block mb-1">
                  {t('ইমেইল ঠিকানা (Email):', 'Email Address:')}
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="student@example.com"
                    className="w-full pl-9 pr-3 py-2 rounded-xl border border-slate-300 text-xs bg-white focus:ring-2 focus:ring-[#102A43]"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-bold text-slate-700 block mb-1">
                  {t('অ্যাকাউন্ট রোল (Role):', 'Account Role:')}
                </label>
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value as UserRole)}
                  className="w-full py-2 px-3 rounded-xl border border-slate-300 text-xs bg-white font-semibold focus:ring-2 focus:ring-[#102A43]"
                >
                  <option value="student">{t('শিক্ষার্থী (Student)', 'Student')}</option>
                  <option value="question_manager">{t('প্রশ্ন ব্যবস্থাপক (Question Manager)', 'Question Manager')}</option>
                  {user.userId === OWNER_ADMIN_UID && (
                    <option value="admin">{t('অ্যাডমিন (Admin)', 'Administrator')}</option>
                  )}
                </select>
              </div>
            </div>
          </div>

          {/* Section 2: Subscription & Validity Controls */}
          <div className="p-4 rounded-2xl bg-amber-50/60 border border-amber-200/80 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold text-amber-950 uppercase tracking-wider flex items-center gap-1.5">
                <Crown className="w-3.5 h-3.5 text-amber-700" />
                <span>{t('২. সাবস্ক্রিপশন ও মেয়াদ নিয়ন্ত্রণ', '2. Subscription & Validity')}</span>
              </span>

              <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold uppercase ${
                subscriptionStatus === 'pro' && remainingDays > 0
                  ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                  : 'bg-slate-100 text-slate-600'
              }`}>
                {subscriptionStatus === 'pro' && remainingDays > 0 ? `ACTIVE (${remainingDays} দিন বাকি)` : 'FREE / EXPIRED'}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-bold text-slate-700 block mb-1">
                  {t('সাবস্ক্রিপশন স্ট্যাটাস:', 'Subscription Status:')}
                </label>
                <select
                  value={subscriptionStatus}
                  onChange={(e) => setSubscriptionStatus(e.target.value as 'free' | 'pro' | 'expired')}
                  className="w-full py-2 px-3 rounded-xl border border-slate-300 text-xs bg-white font-bold text-[#102A43]"
                >
                  <option value="pro">{t('PRO PASS (সক্রিয় প্রো অ্যাক্সেস)', 'PRO PASS (Active)')}</option>
                  <option value="free">{t('FREE TIER (ফ্রি ট্রায়াল)', 'FREE TIER')}</option>
                  <option value="expired">{t('EXPIRED (মেয়াদ শেষ)', 'EXPIRED')}</option>
                </select>
              </div>

              <div>
                <label className="text-xs font-bold text-slate-700 block mb-1">
                  {t('প্যাকেজ নির্বাচন:', 'Assign Package:')}
                </label>
                <select
                  value={packageId}
                  onChange={(e) => setPackageId(e.target.value)}
                  className="w-full py-2 px-3 rounded-xl border border-slate-300 text-xs bg-white font-semibold"
                >
                  {packages.map(p => (
                    <option key={p.id} value={p.id}>
                      {language === 'bn' ? p.nameBn : p.nameEn} (৳{p.price})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Expiry Date input & quick extend buttons */}
            <div className="space-y-2 pt-1 border-t border-amber-200/60">
              <label className="text-xs font-bold text-slate-700 block">
                {t('মেয়াদোত্তীর্ণ তারিখ ও সময় (Expiration Date & Time):', 'Expiration Date & Time:')}
              </label>

              <div className="flex flex-col sm:flex-row items-center gap-2">
                <input
                  type="datetime-local"
                  required
                  value={expiryDateInput}
                  onChange={(e) => setExpiryDateInput(e.target.value)}
                  className="w-full sm:flex-1 py-2 px-3 rounded-xl border border-slate-300 text-xs bg-white font-mono font-bold"
                />

                <span className="text-xs font-bold text-emerald-800 px-3 py-2 bg-emerald-50 rounded-xl border border-emerald-200 shrink-0">
                  {remainingDays} {t('দিন অবশিষ্ট', 'days left')}
                </span>
              </div>

              {/* Quick Extend Buttons */}
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                <span className="text-[11px] text-slate-500 font-semibold mr-1">{t('দ্রুত মেয়াদ বাড়ান:', 'Quick Extend:')}</span>
                <button
                  type="button"
                  onClick={() => handleQuickExtend(30)}
                  className="px-2.5 py-1 rounded-lg text-xs font-bold bg-white hover:bg-[#102A43] hover:text-[#D4AF37] border border-amber-300 transition cursor-pointer shadow-2xs"
                >
                  +৩০ দিন
                </button>
                <button
                  type="button"
                  onClick={() => handleQuickExtend(60)}
                  className="px-2.5 py-1 rounded-lg text-xs font-bold bg-white hover:bg-[#102A43] hover:text-[#D4AF37] border border-amber-300 transition cursor-pointer shadow-2xs"
                >
                  +৬০ দিন
                </button>
                <button
                  type="button"
                  onClick={() => handleQuickExtend(90)}
                  className="px-2.5 py-1 rounded-lg text-xs font-bold bg-white hover:bg-[#102A43] hover:text-[#D4AF37] border border-amber-300 transition cursor-pointer shadow-2xs"
                >
                  +৯০ দিন
                </button>
                <button
                  type="button"
                  onClick={() => handleQuickExtend(365)}
                  className="px-2.5 py-1 rounded-lg text-xs font-bold bg-[#102A43] text-[#D4AF37] hover:bg-[#243B53] transition cursor-pointer shadow-2xs"
                >
                  +৩৬৫ দিন (১ বছর)
                </button>
              </div>
            </div>

          </div>

          {/* Section 3: Session & Account Security */}
          <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200 space-y-2">
            <span className="text-[11px] font-bold text-[#102A43] uppercase tracking-wider flex items-center gap-1.5">
              <Smartphone className="w-3.5 h-3.5 text-slate-600" />
              <span>{t('৩. ডিভাইস সেশন ও একাউন্ট নিরাপত্তা', '3. Device Session & Security')}</span>
            </span>

            <div className="flex items-center justify-between p-3 rounded-xl bg-white border border-slate-200">
              <div>
                <p className="text-xs font-bold text-slate-800">
                  {t('ডিভাইস সেশন স্ট্যাটাস', 'Device Session State')}
                </p>
                <p className="text-[11px] text-slate-500">
                  {isSessionRevoked 
                    ? t('সেশন স্থগিত (ব্যবহারকারী লগআউট অবস্থায় থাকবেন)', 'Session is Revoked (User blocked on this session)')
                    : t('সেশন সক্রিয় ও স্বাভাবিকভাবে অনুমোদিত', 'Session is Active and authorized')}
                </p>
              </div>

              <button
                type="button"
                onClick={() => setIsSessionRevoked(!isSessionRevoked)}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold transition cursor-pointer ${
                  isSessionRevoked
                    ? 'bg-emerald-100 text-emerald-800 border border-emerald-300 hover:bg-emerald-200'
                    : 'bg-rose-100 text-rose-800 border border-rose-300 hover:bg-rose-200'
                }`}
              >
                {isSessionRevoked ? t('সেশন পুনর্বহাল করুন', 'Restore Session') : t('সেশন বাতিল / ফোর্স লগআউট', 'Revoke Session')}
              </button>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="pt-3 border-t border-slate-100 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2.5 rounded-xl border border-slate-300 text-slate-600 hover:bg-slate-100 font-bold text-xs transition cursor-pointer"
            >
              {t('বাতিল', 'Cancel')}
            </button>

            <button
              type="submit"
              disabled={saving}
              className="px-6 py-2.5 rounded-xl bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] border border-[#D4AF37] font-bold text-xs transition flex items-center gap-2 shadow-md cursor-pointer disabled:opacity-50"
            >
              <Save className="w-4 h-4" />
              <span>{saving ? t('সংরক্ষণ হচ্ছে...', 'Saving...') : t('পরিবর্তন সংরক্ষণ করুন', 'Save Changes')}</span>
            </button>
          </div>

        </form>

      </div>
    </div>
  );
};
