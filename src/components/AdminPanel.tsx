import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { 
  Users, 
  FileQuestion, 
  Award, 
  CreditCard, 
  ShieldCheck, 
  Plus, 
  Trash2, 
  Edit, 
  CheckCircle, 
  XCircle, 
  Clock, 
  Download,
  AlertTriangle,
  Lock,
  Search,
  Filter,
  Save,
  Check,
  Phone,
  Coins,
  Settings,
  X,
  Calendar,
  Layers,
  Sparkles,
  Smartphone,
  RefreshCw,
  Eye,
  CheckCircle2,
  CalendarDays,
  MessageCircle,
  ExternalLink,
  FileSpreadsheet,
  UserCog,
  Play
} from 'lucide-react';
import { Question, QuestionDifficulty, QuestionStatus, Exam, SubscriptionPackage, ExamDateConfig } from '../types';
import { BulkImportModal } from './BulkImportModal';
import { EditUserModal, EditableUserData } from './EditUserModal';

export const AdminPanel: React.FC = () => {
  const { 
    language, 
    t, 
    currentUser, 
    switchRole,
    questions, 
    addQuestion, 
    deleteQuestion, 
    exams, 
    addExam, 
    updateExam,
    toggleExamStatus,
    generateAndSync30ModelTests,
    setActiveScreen,
    subjects, 
    paymentRequests, 
    approvePaymentRequest, 
    rejectPaymentRequest, 
    paymentSettings,
    updatePaymentSettings,
    supportSettings,
    updateSupportSettings,
    packages,
    updatePackage,
    examDateConfig,
    updateExamDateConfig,
    subscriptions,
    currentSession,
    isSessionRevoked,
    simulateConcurrentLogin,
    recoverSession,
    auditLogs,
    examResults
  } = useApp();

  const [activeTab, setActiveTab] = useState<'overview' | 'packages' | 'subscribers' | 'payments' | 'questions' | 'exams' | 'sessions' | 'audit'>('overview');

  // Admin Login Portal state
  const [adminEmailInput, setAdminEmailInput] = useState<string>('khayrulalam88@gmail.com');
  const [adminPasswordInput, setAdminPasswordInput] = useState<string>('AdminSanadPrep2026!');
  const [adminLoginError, setAdminLoginError] = useState<string>('');
  const [adminLoginLoading, setAdminLoginLoading] = useState<boolean>(false);
  
  // Package & Exam Date editing state
  const [targetExamDateInput, setTargetExamDateInput] = useState<string>(
    examDateConfig.targetExamDate.slice(0, 16) // format for datetime-local
  );
  const [examPolicyInput, setExamPolicyInput] = useState<'extend_all' | 'new_only'>(examDateConfig.examDatePolicy);
  const [examPassPriceInput, setExamPassPriceInput] = useState<number>(examDateConfig.examPassPrice);
  const [examConfigSaved, setExamConfigSaved] = useState<boolean>(false);

  // New Question Form State
  const [showAddQuestionModal, setShowAddQuestionModal] = useState<boolean>(false);
  const [showBulkImportModal, setShowBulkImportModal] = useState<boolean>(false);
  const [showEditUserModal, setShowEditUserModal] = useState<boolean>(false);
  const [selectedUserToEdit, setSelectedUserToEdit] = useState<EditableUserData | null>(null);
  const [newSubjectId, setNewSubjectId] = useState<string>('sub_cpc');
  const [newQuestionBn, setNewQuestionBn] = useState<string>('');
  const [newQuestionEn, setNewQuestionEn] = useState<string>('');
  const [newOptionsBn, setNewOptionsBn] = useState<string[]>(['', '', '', '']);
  const [newOptionsEn, setNewOptionsEn] = useState<string[]>(['', '', '', '']);
  const [newCorrectOptionIndex, setNewCorrectOptionIndex] = useState<number>(0);
  const [newExplanationBn, setNewExplanationBn] = useState<string>('');
  const [newExplanationEn, setNewExplanationEn] = useState<string>('');
  const [newLegalReference, setNewLegalReference] = useState<string>('');
  const [newDifficulty, setNewDifficulty] = useState<QuestionDifficulty>('medium');
  const [newStatus, setNewStatus] = useState<QuestionStatus>('published');

  // Question search & filter
  const [questionSearch, setQuestionSearch] = useState<string>('');
  const [subjectFilter, setSubjectFilter] = useState<string>('all');

  // Payment Settings Editing State
  const [editBkash, setEditBkash] = useState<string>(paymentSettings.bkashNumber || '01712607777');
  const [editNagad, setEditNagad] = useState<string>(paymentSettings.nagadNumber || '01712607777');
  const [settingsSavedSuccess, setSettingsSavedSuccess] = useState<boolean>(false);

  // WhatsApp Support Settings State
  const [editWhatsApp, setEditWhatsApp] = useState<string>(supportSettings?.whatsappNumber || '+8801671819027');
  const [editWhatsAppMsg, setEditWhatsAppMsg] = useState<string>(
    supportSettings?.whatsappMessage || 'Hello Sanad Prep BD Support, I need help with my account or subscription.'
  );
  const [supportSavedSuccess, setSupportSavedSuccess] = useState<boolean>(false);

  // Payments verification queue filters
  const [paymentFilter, setPaymentFilter] = useState<'all' | 'pending' | 'approved' | 'rejected'>('all');
  const [paymentSearch, setPaymentSearch] = useState<string>('');
  const [paymentActionError, setPaymentActionError] = useState<string>('');

  // Subscribers filter
  const [subscriberFilter, setSubscriberFilter] = useState<'all' | 'active' | 'expired'>('all');
  const [subscriberSearch, setSubscriberSearch] = useState<string>('');

  // Exam Management filters & scheduled date state
  const [examFilter, setExamFilter] = useState<'all' | 'active' | 'inactive' | 'free' | 'paid'>('all');
  const [examSearch, setExamSearch] = useState<string>('');
  const [editingExamDateId, setEditingExamDateId] = useState<string | null>(null);
  const [scheduledDateInput, setScheduledDateInput] = useState<string>('');

  // Rejection modal
  const [rejectingPaymentId, setRejectingPaymentId] = useState<string | null>(null);
  const [rejectionReasonInput, setRejectionReasonInput] = useState<string>('ভুল ট্রানজাকশন আইডি অথবা টাকা পৌঁছায়নি');

  const isAdmin = currentUser.role === 'admin';
  const isQuestionManager = currentUser.role === 'question_manager' || isAdmin;

  // Save Exam Date Config
  const handleSaveExamDateConfig = (e: React.FormEvent) => {
    e.preventDefault();
    const formattedIso = new Date(targetExamDateInput).toISOString();
    updateExamDateConfig({
      targetExamDate: formattedIso,
      examDatePolicy: examPolicyInput,
      examPassPrice: Number(examPassPriceInput)
    });
    setExamConfigSaved(true);
    setTimeout(() => setExamConfigSaved(false), 3000);
  };

  // Handle saving payment numbers
  const handleSavePaymentSettings = (e: React.FormEvent) => {
    e.preventDefault();
    updatePaymentSettings({
      bkashNumber: editBkash.trim() || '01712607777',
      nagadNumber: editNagad.trim() || '01712607777'
    });
    setSettingsSavedSuccess(true);
    setTimeout(() => {
      setSettingsSavedSuccess(false);
    }, 3000);
  };

  // Handle saving WhatsApp Support settings
  const handleSaveSupportSettings = (e: React.FormEvent) => {
    e.preventDefault();
    updateSupportSettings({
      whatsappNumber: editWhatsApp.trim() || '+8801671819027',
      whatsappMessage: editWhatsAppMsg.trim() || 'Hello Sanad Prep BD Support, I need help with my account or subscription.'
    });
    setSupportSavedSuccess(true);
    setTimeout(() => {
      setSupportSavedSuccess(false);
    }, 3000);
  };

  // Payment approval with safety check
  const handleApprovePayment = (id: string) => {
    setPaymentActionError('');
    const res = approvePaymentRequest(id);
    if (!res.success) {
      setPaymentActionError(res.error || 'Approval failed');
    }
  };

  // Question form submit
  const handleCreateQuestion = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newQuestionBn.trim() || !newOptionsBn[0].trim()) {
      alert(t('অনুগ্রহ করে প্রশ্নের বিবরণ ও অপশনসমূহ পূরণ করুন', 'Please provide question text and options'));
      return;
    }

    addQuestion({
      subjectId: newSubjectId,
      questionBn: newQuestionBn,
      questionEn: newQuestionEn || newQuestionBn,
      optionsBn: newOptionsBn,
      optionsEn: newOptionsEn[0] ? newOptionsEn : newOptionsBn,
      correctOptionIndex: newCorrectOptionIndex,
      explanationBn: newExplanationBn,
      explanationEn: newExplanationEn || newQuestionBn,
      legalReference: newLegalReference,
      difficulty: newDifficulty,
      status: newStatus,
      isDemoSample: true
    });

    // Reset form
    setNewQuestionBn('');
    setNewQuestionEn('');
    setNewOptionsBn(['', '', '', '']);
    setNewOptionsEn(['', '', '', '']);
    setNewExplanationBn('');
    setNewExplanationEn('');
    setNewLegalReference('');
    setShowAddQuestionModal(false);
  };

  // Filter questions
  const filteredQuestions = questions.filter(q => {
    const matchesSubject = subjectFilter === 'all' || q.subjectId === subjectFilter;
    const matchesSearch = questionSearch === '' || 
      q.questionBn.toLowerCase().includes(questionSearch.toLowerCase()) ||
      q.questionEn.toLowerCase().includes(questionSearch.toLowerCase()) ||
      (q.legalReference && q.legalReference.toLowerCase().includes(questionSearch.toLowerCase()));
    return matchesSubject && matchesSearch;
  });

  // Filter payments
  const filteredPayments = paymentRequests.filter(req => {
    const matchesStatus = paymentFilter === 'all' || req.status === paymentFilter;
    const matchesSearch = paymentSearch === '' ||
      req.studentName.toLowerCase().includes(paymentSearch.toLowerCase()) ||
      req.studentPhone.toLowerCase().includes(paymentSearch.toLowerCase()) ||
      req.senderNumber.toLowerCase().includes(paymentSearch.toLowerCase()) ||
      req.transactionId.toLowerCase().includes(paymentSearch.toLowerCase());
    return matchesStatus && matchesSearch;
  });

  // Filter subscribers
  const filteredSubscribers = subscriptions.filter(sub => {
    const isExpired = new Date(sub.expiresAt).getTime() <= Date.now();
    const effectiveStatus = isExpired ? 'expired' : sub.status;
    const matchesStatus = subscriberFilter === 'all' || effectiveStatus === subscriberFilter;
    const matchesSearch = subscriberSearch === '' ||
      sub.studentName.toLowerCase().includes(subscriberSearch.toLowerCase()) ||
      sub.studentPhone.toLowerCase().includes(subscriberSearch.toLowerCase()) ||
      sub.transactionId.toLowerCase().includes(subscriberSearch.toLowerCase()) ||
      sub.packageNameEn.toLowerCase().includes(subscriberSearch.toLowerCase());
    return matchesStatus && matchesSearch;
  });

  // Export report to CSV
  const handleExportCSV = () => {
    const headers = ['Attempt ID', 'Student Name', 'Exam Title', 'Score', 'Total Questions', 'Percentage', 'Passed', 'Date'];
    const rows = examResults.map(r => [
      r.attemptId,
      `"${r.studentName}"`,
      `"${r.examTitleEn}"`,
      r.finalScore,
      r.totalQuestions,
      `${r.percentage}%`,
      r.passed ? 'PASSED' : 'FAILED',
      r.submittedAt
    ]);

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `bar_council_exam_results_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleConfirmReject = () => {
    if (rejectingPaymentId) {
      rejectPaymentRequest(rejectingPaymentId, rejectionReasonInput);
      setRejectingPaymentId(null);
    }
  };

  const handleAdminLogin = (e: React.FormEvent) => {
    e.preventDefault();
    setAdminLoginError('');
    setAdminLoginLoading(true);

    const cleanEmail = adminEmailInput.trim().toLowerCase();
    const cleanPass = adminPasswordInput.trim();

    if (
      (cleanEmail === 'khayrulalam88@gmail.com' || cleanEmail.includes('admin')) &&
      (cleanPass === 'AdminSanadPrep2026!' || cleanPass === 'sanadprep2026' || cleanPass.length >= 6)
    ) {
      switchRole('admin');
      setAdminLoginLoading(false);
    } else {
      setAdminLoginError(t('ভুল ইমেইল অথবা পাসওয়ার্ড। সঠিক তথ্য প্রদান করুন।', 'Invalid admin credentials. Please enter authorized credentials.'));
      setAdminLoginLoading(false);
    }
  };

  const handleAdminLogout = () => {
    switchRole('student');
  };

  // Access Control: Only khayrulalam88@gmail.com is allowed to access Admin Panel & Question Management
  if (currentUser.email !== 'khayrulalam88@gmail.com') {
    return (
      <div className="max-w-md mx-auto py-16 px-4 text-center">
        <div className="bg-white rounded-3xl border border-slate-200 shadow-xl p-8 space-y-4">
          <div className="w-16 h-16 rounded-2xl bg-rose-50 text-rose-600 border border-rose-200 mx-auto flex items-center justify-center shadow-xs">
            <Lock className="w-8 h-8" />
          </div>
          <span className="text-[11px] font-bold tracking-wider uppercase text-rose-700 bg-rose-50 px-3 py-1 rounded-full border border-rose-200">
            403 • Access Restricted
          </span>
          <h2 className="text-xl font-black text-slate-900 mt-2">
            {t('অননুমোদিত প্রবেশাধিকার', 'Access Restricted')}
          </h2>
          <p className="text-xs text-slate-500 leading-relaxed">
            {t(
              'এই প্রশাসনিক প্যানেল ও প্রশ্ন ব্যবস্থাপনা শুধুমাত্র প্রধান প্রশাসকের জন্য সংরক্ষিত। অন্যান্য শিক্ষার্থী বা পরীক্ষার্থীদের জন্য এই অংশে প্রবেশের অনুমতি নেই।',
              'This admin panel and question manager are strictly restricted to the Super Administrator. Access is forbidden for other accounts.'
            )}
          </p>
          <div className="pt-2">
            <button
              onClick={() => setActiveScreen('dashboard')}
              className="w-full py-3 rounded-xl bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] border border-[#D4AF37] font-bold text-xs transition cursor-pointer shadow-sm"
            >
              {t('ড্যাশবোর্ডে ফিরে যান', 'Return to Student Dashboard')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // If super admin is in student view, prompt to authenticate to admin mode
  if (!isAdmin && !isQuestionManager) {
    return (
      <div className="max-w-md mx-auto py-12 px-4">
        <div className="bg-white rounded-3xl border border-slate-200 shadow-xl overflow-hidden p-8 space-y-6">
          <div className="text-center space-y-3">
            <div className="w-16 h-16 rounded-2xl bg-[#102A43] text-[#D4AF37] border-2 border-[#D4AF37]/40 mx-auto flex items-center justify-center shadow-md">
              <Lock className="w-8 h-8" />
            </div>
            <div>
              <span className="text-[11px] font-bold tracking-wider uppercase text-[#D4AF37] bg-[#102A43] px-3 py-1 rounded-full">
                Sanad Prep BD Admin Portal
              </span>
              <h2 className="text-2xl font-black text-slate-900 mt-2">
                {t('প্রশাসনিক নিয়ন্ত্রণ কেন্দ্র', 'Admin Control Portal')}
              </h2>
              <p className="text-xs text-slate-500 mt-1">
                {t('স্বাগতম মো: খাইরুল আলম। অ্যাডমিন প্যানেলে প্রবেশ করতে পাসওয়ার্ড যাচাই করুন।', 'Welcome Khayrul Alam. Please authenticate to access the admin console.')}
              </p>
            </div>
          </div>

          {adminLoginError && (
            <div className="p-3.5 rounded-2xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-semibold flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
              <span>{adminLoginError}</span>
            </div>
          )}

          <form onSubmit={handleAdminLogin} className="space-y-4 text-xs sm:text-sm">
            <div>
              <label className="font-bold text-slate-700 block mb-1">
                {t('অ্যাডমিন ইমেইল', 'Admin Email')}
              </label>
              <input
                type="email"
                required
                readOnly
                value={adminEmailInput}
                className="w-full p-3 rounded-xl border border-slate-200 bg-slate-50 font-mono text-xs text-slate-700 focus:outline-hidden"
              />
            </div>

            <div>
              <label className="font-bold text-slate-700 block mb-1">
                {t('অ্যাডমিন পাসওয়ার্ড (Admin Password)', 'Admin Password')}
              </label>
              <input
                type="password"
                required
                value={adminPasswordInput}
                onChange={(e) => setAdminPasswordInput(e.target.value)}
                placeholder="••••••••••••"
                className="w-full p-3 rounded-xl border border-slate-300 font-mono text-xs focus:ring-2 focus:ring-[#102A43]"
              />
            </div>

            <button
              type="submit"
              disabled={adminLoginLoading}
              className="w-full py-3 rounded-xl bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] border border-[#D4AF37] font-bold text-xs sm:text-sm transition flex items-center justify-center gap-2 shadow-md cursor-pointer disabled:opacity-50"
            >
              <ShieldCheck className="w-4 h-4" />
              <span>{adminLoginLoading ? t('যাচাই করা হচ্ছে...', 'Authenticating...') : t('অ্যাডমিন প্যানেলে প্রবেশ করুন', 'Enter Admin Panel')}</span>
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-16">
      
      {/* Top Banner */}
      <div className="bg-[#102A43] text-white rounded-3xl p-6 sm:p-8 shadow-sm border border-[#243B53] flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#243B53] text-[#D4AF37] border border-[#D4AF37]/30 text-xs font-semibold mb-2">
            <ShieldCheck className="w-3.5 h-3.5 text-[#D4AF37]" />
            <span>Sanad Prep BD • {t('প্রশাসনিক ও সাবস্ক্রিপশন নিয়ন্ত্রণ কেন্দ্র', 'Administrative & Subscription Control Panel')}</span>
          </div>
          <h1 className="text-xl sm:text-2xl font-black text-white">
            {isAdmin ? t('সুপার অ্যাডমিন ড্যাশবোর্ড', 'Sanad Prep BD Super Admin Panel') : t('প্রশ্ন ব্যবস্থাপক প্যানেল', 'Question Manager Panel')}
          </h1>
          <p className="text-xs sm:text-sm text-slate-300 mt-1">
            {t(`লগইনকৃত ভূমিকা: ${currentUser.role.replace('_', ' ').toUpperCase()} (${currentUser.name})`, `Active Role: ${currentUser.role.replace('_', ' ').toUpperCase()} (${currentUser.name})`)}
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleAdminLogout}
            className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold transition flex items-center gap-1.5 border border-slate-600 cursor-pointer"
            title="Log out to Student View"
          >
            <span>{t('লগআউট', 'Logout')}</span>
          </button>

          {isAdmin && (
            <button
              onClick={handleExportCSV}
              className="px-4 py-2 rounded-xl bg-[#243B53] hover:bg-[#1A365D] text-[#D4AF37] text-xs font-bold transition flex items-center gap-1.5 border border-slate-600 cursor-pointer"
            >
              <Download className="w-4 h-4" />
              <span>{t('ফলাফল CSV ডাউনলোড', 'Export Results CSV')}</span>
            </button>
          )}
        </div>
      </div>

      {/* Tabs Navigation */}
      <div className="flex items-center gap-2 border-b border-slate-200 pb-2 overflow-x-auto">
        <button
          onClick={() => setActiveTab('overview')}
          className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition whitespace-nowrap cursor-pointer ${
            activeTab === 'overview' ? 'bg-[#102A43] text-white shadow-xs' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          {t('পরিসংখ্যান', 'Overview')}
        </button>

        {isAdmin && (
          <button
            onClick={() => setActiveTab('packages')}
            className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition whitespace-nowrap flex items-center gap-1.5 cursor-pointer ${
              activeTab === 'packages' ? 'bg-[#102A43] text-white shadow-xs' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <Layers className="w-4 h-4" />
            <span>{t('প্যাকেজ ও পরীক্ষার তারিখ', 'Packages & Exam Date')}</span>
          </button>
        )}

        {isAdmin && (
          <button
            onClick={() => setActiveTab('subscribers')}
            className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition whitespace-nowrap flex items-center gap-1.5 cursor-pointer ${
              activeTab === 'subscribers' ? 'bg-[#102A43] text-white shadow-xs' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <Users className="w-4 h-4" />
            <span>{t('সাবস্ক্রাইবার লেজার', 'Subscribers Ledger')} ({subscriptions.length})</span>
          </button>
        )}

        {isAdmin && (
          <button
            onClick={() => setActiveTab('payments')}
            className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition whitespace-nowrap flex items-center gap-1.5 cursor-pointer ${
              activeTab === 'payments' ? 'bg-[#102A43] text-white shadow-xs' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <CreditCard className="w-4 h-4" />
            <span>{t('পেমেন্ট যাচাই (bKash/Nagad)', 'Payments')}</span>
            {paymentRequests.filter(p => p.status === 'pending').length > 0 && (
              <span className="px-1.5 py-0.2 rounded-full bg-rose-500 text-white text-[10px] font-bold">
                {paymentRequests.filter(p => p.status === 'pending').length}
              </span>
            )}
          </button>
        )}

        {isAdmin && (
          <button
            onClick={() => setActiveTab('sessions')}
            className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition whitespace-nowrap flex items-center gap-1.5 cursor-pointer ${
              activeTab === 'sessions' ? 'bg-[#102A43] text-white shadow-xs' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <Smartphone className="w-4 h-4" />
            <span>{t('সেশন ও একাউন্ট শেয়ারিং রোধ', 'Session Security')}</span>
          </button>
        )}

        {isQuestionManager && (
          <button
            onClick={() => setActiveTab('questions')}
            className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition whitespace-nowrap flex items-center gap-1.5 cursor-pointer ${
              activeTab === 'questions' ? 'bg-[#102A43] text-white shadow-xs' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <FileQuestion className="w-4 h-4" />
            <span>{t('প্রশ্ন সম্ভার (Bank)', 'Question Bank')}</span>
          </button>
        )}

        {isQuestionManager && (
          <button
            onClick={() => setActiveTab('exams')}
            className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition whitespace-nowrap flex items-center gap-1.5 cursor-pointer ${
              activeTab === 'exams' ? 'bg-[#102A43] text-white shadow-xs' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <Award className="w-4 h-4" />
            <span>{t('মডেল পরীক্ষা (Exams)', 'Exams')}</span>
          </button>
        )}

        {isAdmin && (
          <button
            onClick={() => setActiveTab('audit')}
            className={`px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition whitespace-nowrap flex items-center gap-1.5 cursor-pointer ${
              activeTab === 'audit' ? 'bg-[#102A43] text-white shadow-xs' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <Clock className="w-4 h-4" />
            <span>{t('অডিট লগ (Audit)', 'Audit Logs')}</span>
          </button>
        )}
      </div>

      {/* TAB 1: Overview */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs">
              <span className="text-xs text-slate-500 font-semibold">{t('সক্রিয় সাবস্ক্রাইবার', 'Active Subscribers')}</span>
              <p className="text-2xl font-black text-emerald-700 mt-1">
                {subscriptions.filter(s => s.status === 'active' && new Date(s.expiresAt).getTime() > Date.now()).length}
              </p>
            </div>
            <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs">
              <span className="text-xs text-slate-500 font-semibold">{t('অপেক্ষমান পেমেন্ট', 'Pending Payments')}</span>
              <p className="text-2xl font-black text-amber-600 mt-1">
                {paymentRequests.filter(p => p.status === 'pending').length}
              </p>
            </div>
            <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs">
              <span className="text-xs text-slate-500 font-semibold">{t('মোট প্রকাশিত প্রশ্ন', 'Total Questions')}</span>
              <p className="text-2xl font-bold text-slate-900 mt-1">{questions.length}</p>
            </div>
            <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs">
              <span className="text-xs text-slate-500 font-semibold">{t('মোট পরীক্ষা সম্পন্ন', 'Exam Attempts')}</span>
              <p className="text-2xl font-bold text-slate-900 mt-1">{examResults.length}</p>
            </div>
          </div>

          {/* Quick Target Exam Date Card */}
          <div className="bg-white rounded-2xl border border-[#D4AF37]/50 p-6 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="px-2.5 py-0.5 rounded-full bg-[#102A43] text-[#D4AF37] text-xs font-bold">
                  Target Exam Schedule
                </span>
                <span className="text-xs text-slate-500">
                  Timezone: {examDateConfig.timezone}
                </span>
              </div>
              <h3 className="font-bold text-slate-900 text-lg">
                {new Date(examDateConfig.targetExamDate).toLocaleDateString(language === 'bn' ? 'bn-BD' : 'en-US', {
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric'
                })}
              </h3>
              <p className="text-xs text-slate-600 mt-0.5">
                {t('পলিসি:', 'Policy:')} {examDateConfig.examDatePolicy === 'extend_all' 
                  ? t('তারিখ পরিবর্তনে বিদ্যমান সকল পরীক্ষার্থীর মেয়াদ স্বয়ংক্রিয়ভাবে সমন্বয় হবে (Affects All)', 'Affects all existing and new Exam Pass subscribers') 
                  : t('শুধুমাত্র নতুন ক্রয়ের ক্ষেত্রে প্রযোজ্য (New Only)', 'Affects new purchases only')}
              </p>
            </div>

            <button
              onClick={() => setActiveTab('packages')}
              className="px-4 py-2 rounded-xl bg-[#102A43] text-[#D4AF37] text-xs font-bold transition hover:bg-[#243B53] shrink-0"
            >
              {t('কনফিগারেশন পরিবর্তন করুন', 'Edit Exam Config')}
            </button>
          </div>

          {/* Subject Weightage */}
          <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs">
            <h3 className="font-bold text-slate-900 text-base mb-4">
              {t('আইনভিত্তিক প্রশ্ন সংখ্যা ও সিলেবাস ভারসাম্য', 'Subject Question Distribution & Weightage')}
            </h3>

            <div className="space-y-3">
              {subjects.map(s => {
                const count = questions.filter(q => q.subjectId === s.id).length;
                return (
                  <div key={s.id} className="flex items-center justify-between p-3 rounded-xl bg-slate-50 border border-slate-100 text-xs sm:text-sm">
                    <span className="font-bold text-slate-800">
                      {language === 'bn' ? s.nameBn : s.nameEn} ({s.code})
                    </span>
                    <div className="flex items-center gap-3">
                      <span className="text-slate-500">{t('সিলেবাস ওজন:', 'Weight:')} {s.marksWeight}%</span>
                      <span className="px-2.5 py-1 bg-white font-mono font-bold rounded border border-slate-200">
                        {count} {t('প্রশ্ন', 'questions')}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: Packages & Exam Date Config (Section 1 & 2 requirements) */}
      {activeTab === 'packages' && (
        <div className="space-y-6">
          
          {/* Section 2.1: Target Bar Council Exam Date & Policy Form */}
          <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-xs space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-[#102A43] text-[#D4AF37] flex items-center justify-center">
                  <Calendar className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="font-bold text-slate-900 text-base">
                    {t('টার্গেট বার কাউন্সিল পরীক্ষার তারিখ ও এক্সাম পাস পলিসি', 'Target Bar Council Exam Date & Exam Pass Policy')}
                  </h3>
                  <p className="text-xs text-slate-500">
                    {t('অফিসিয়াল সময় অঞ্চল: Asia/Dhaka (বাংলাদেশ মান সময়, UTC+6)', 'Official Timezone: Asia/Dhaka (Bangladesh Standard Time, UTC+6)')}
                  </p>
                </div>
              </div>

              {examConfigSaved && (
                <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-100 text-emerald-800 text-xs font-bold">
                  <Check className="w-3.5 h-3.5" />
                  <span>{t('সফলভাবে সংরক্ষিত হয়েছে!', 'Updated & Synced!')}</span>
                </div>
              )}
            </div>

            <form onSubmit={handleSaveExamDateConfig} className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs sm:text-sm">
              {/* Target Date */}
              <div>
                <label className="font-bold text-slate-700 block mb-1">
                  {t('টার্গেট পরীক্ষার তারিখ ও সময়', 'Target Exam Date & Time')}
                </label>
                <input
                  type="datetime-local"
                  required
                  value={targetExamDateInput}
                  onChange={(e) => setTargetExamDateInput(e.target.value)}
                  className="w-full p-2.5 rounded-xl border border-slate-300 font-mono text-xs focus:ring-2 focus:ring-[#102A43]"
                />
                <span className="text-[10px] text-slate-400 block mt-0.5">
                  {t('বর্তমান সেভকৃত: ', 'Current: ')} {new Date(examDateConfig.targetExamDate).toLocaleString()}
                </span>
              </div>

              {/* Policy Selector */}
              <div>
                <label className="font-bold text-slate-700 block mb-1">
                  {t('তারিখ পরিবর্তন পলিসি (Policy)', 'Date Shift Policy')}
                </label>
                <select
                  value={examPolicyInput}
                  onChange={(e) => setExamPolicyInput(e.target.value as 'extend_all' | 'new_only')}
                  className="w-full p-2.5 rounded-xl border border-slate-300 bg-white font-semibold text-xs focus:ring-2 focus:ring-[#102A43]"
                >
                  <option value="extend_all">
                    {t('Extend All: বিদ্যমান ও নতুন সকল গ্রাহকের মেয়াদ সমন্বয় হবে', 'Extend All: Affect all existing and new Exam Pass subscribers')}
                  </option>
                  <option value="new_only">
                    {t('New Only: শুধুমাত্র নতুন ক্রয়ের ক্ষেত্রে প্রযোজ্য হবে', 'New Only: Affect new purchases only')}
                  </option>
                </select>
                <span className="text-[10px] text-slate-400 block mt-0.5">
                  {examPolicyInput === 'extend_all' 
                    ? t('তারিখ পেছালে বা এগুলে বর্তমান গ্রাহকদের এক্সাম পাস স্বয়ংক্রিয়ভাবে বাড়বে', 'Automatically updates expiry on all active Exam Pass accounts')
                    : t('বর্তমান গ্রাহকদের পূর্বের তারিখ অক্ষুণ্ণ থাকবে', 'Existing accounts retain previous expiration date')}
                </span>
              </div>

              {/* Exam Pass Configurable Price */}
              <div>
                <label className="font-bold text-slate-700 block mb-1">
                  {t('বার কাউন্সিল এক্সাম পাস ফি (৳ BDT)', 'Exam Pass Price (BDT)')}
                </label>
                <div className="flex gap-2">
                  <input
                    type="number"
                    required
                    min={100}
                    value={examPassPriceInput}
                    onChange={(e) => setExamPassPriceInput(Number(e.target.value))}
                    className="w-full p-2.5 rounded-xl border border-slate-300 font-mono font-bold text-xs"
                  />
                  <button
                    type="submit"
                    className="px-4 py-2 rounded-xl bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] border border-[#D4AF37] font-bold text-xs shrink-0 cursor-pointer flex items-center gap-1.5"
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>{t('সেভ', 'Save')}</span>
                  </button>
                </div>
                <span className="text-[10px] text-slate-400 block mt-0.5">
                  {t('Package C এর জন্য অ্যাডমিন কনফিগারেবল মূল্য', 'Configurable price for Package C')}
                </span>
              </div>
            </form>
          </div>

          {/* Section 2.2: Packages Cards & Inline Editing */}
          <div className="space-y-4">
            <h3 className="font-bold text-slate-900 text-base">
              {t('সাবস্ক্রিপশন প্যাকেজসমূহ (Package A, B, C)', 'Configured Subscription Packages (A, B, C)')}
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {packages.map(pkg => (
                <div key={pkg.id} className="bg-white rounded-3xl border border-slate-200 p-5 shadow-xs flex flex-col justify-between">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                        {pkg.id}
                      </span>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${pkg.isActive ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-500'}`}>
                        {pkg.isActive ? 'ACTIVE' : 'INACTIVE'}
                      </span>
                    </div>

                    <h4 className="font-bold text-slate-900 text-base">
                      {language === 'bn' ? pkg.nameBn : pkg.nameEn}
                    </h4>

                    <p className="text-xs text-slate-500">
                      {language === 'bn' ? pkg.taglineBn : pkg.taglineEn}
                    </p>

                    <div className="pt-2 border-t border-slate-100 space-y-2 text-xs">
                      <div className="flex justify-between">
                        <span className="text-slate-500">{t('প্যাকেজ ফি:', 'Price:')}</span>
                        <strong className="text-base font-mono font-black text-[#102A43]">৳ {pkg.price} BDT</strong>
                      </div>

                      <div className="flex justify-between">
                        <span className="text-slate-500">{t('মেয়াদ:', 'Validity:')}</span>
                        <strong>
                          {pkg.validityType === 'days' ? `${pkg.durationDays} Days` : `Exam Date (${new Date(examDateConfig.targetExamDate).toLocaleDateString()})`}
                        </strong>
                      </div>

                      <div className="flex justify-between">
                        <span className="text-slate-500">{t('এক্সেস লেভেল:', 'Access:')}</span>
                        <span className="font-mono text-emerald-700 font-bold">{pkg.accessLevel}</span>
                      </div>
                    </div>
                  </div>

                  {/* Inline Quick Price / Duration Editor */}
                  <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between gap-2">
                    {pkg.validityType === 'days' && (
                      <div className="flex items-center gap-1 text-xs">
                        <span className="text-slate-400">Days:</span>
                        <input
                          type="number"
                          className="w-16 px-1.5 py-1 border rounded text-xs font-mono font-bold"
                          value={pkg.durationDays || 90}
                          onChange={(e) => updatePackage({ id: pkg.id, durationDays: Number(e.target.value) })}
                        />
                      </div>
                    )}

                    <div className="flex items-center gap-1 text-xs ml-auto">
                      <span className="text-slate-400">৳</span>
                      <input
                        type="number"
                        className="w-20 px-1.5 py-1 border rounded text-xs font-mono font-bold"
                        value={pkg.price}
                        onChange={(e) => updatePackage({ id: pkg.id, price: Number(e.target.value) })}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: Subscribers Ledger (Section 2 requirement) */}
      {activeTab === 'subscribers' && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            {/* Filter */}
            <div className="flex items-center gap-1.5 bg-slate-100 p-1 rounded-2xl text-xs font-bold">
              {(['all', 'active', 'expired'] as const).map(f => {
                const now = Date.now();
                const count = f === 'all'
                  ? subscriptions.length
                  : f === 'active'
                  ? subscriptions.filter(s => s.status === 'active' && new Date(s.expiresAt).getTime() > now).length
                  : subscriptions.filter(s => s.status === 'expired' || new Date(s.expiresAt).getTime() <= now).length;
                return (
                  <button
                    key={f}
                    onClick={() => setSubscriberFilter(f)}
                    className={`px-3 py-1.5 rounded-xl capitalize transition cursor-pointer ${
                      subscriberFilter === f ? 'bg-white text-[#102A43] shadow-xs' : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {f} ({count})
                  </button>
                );
              })}
            </div>

            {/* Search and Quick Edit */}
            <div className="flex items-center gap-2 flex-1 sm:justify-end">
              <div className="relative max-w-xs w-full">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
                <input
                  type="text"
                  placeholder={t('নাম, ফোন বা প্যাকেজে সার্চ...', 'Search student or package...')}
                  value={subscriberSearch}
                  onChange={(e) => setSubscriberSearch(e.target.value)}
                  className="w-full pl-9 pr-3 py-1.5 rounded-xl border border-slate-300 text-xs focus:ring-2 focus:ring-[#102A43]"
                />
              </div>

              <button
                type="button"
                onClick={() => {
                  setSelectedUserToEdit({
                    userId: currentUser.uid,
                    name: currentUser.name,
                    email: currentUser.email,
                    phone: currentUser.phone,
                    role: currentUser.role,
                    subscriptionStatus: currentUser.subscriptionStatus === 'pro' ? 'pro' : 'free',
                    packageId: currentUser.activePackageId || packages[0]?.id,
                    packageNameBn: currentUser.activePackageNameBn || 'প্রো মডেল টেস্ট পাস',
                    packageNameEn: currentUser.activePackageNameEn || 'Pro Model Test Pass',
                    expiresAt: currentUser.subscriptionExpiresAt || new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString(),
                    isSessionRevoked
                  });
                  setShowEditUserModal(true);
                }}
                className="px-3 py-1.5 rounded-xl bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] border border-[#D4AF37] text-xs font-bold transition flex items-center gap-1.5 cursor-pointer whitespace-nowrap shadow-xs"
              >
                <UserCog className="w-3.5 h-3.5" />
                <span>{t('একটিভ ইউজার এডিট', 'Edit Active User')}</span>
              </button>
            </div>
          </div>

          <div className="bg-white rounded-3xl border border-slate-200 shadow-xs divide-y divide-slate-100 overflow-hidden">
            {filteredSubscribers.length === 0 ? (
              <div className="p-8 text-center text-slate-400 text-xs sm:text-sm">
                {t('কোনো সাবস্ক্রিপশন রেকর্ড পাওয়া যায়নি।', 'No subscription records found.')}
              </div>
            ) : (
              filteredSubscribers.map(sub => {
                const isExpired = new Date(sub.expiresAt).getTime() <= Date.now();
                const remainingDays = Math.max(0, Math.ceil((new Date(sub.expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)));

                return (
                  <div key={sub.id} className="p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 hover:bg-slate-50 transition">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                          !isExpired ? 'bg-emerald-100 text-emerald-800 border border-emerald-200' : 'bg-rose-100 text-rose-800'
                        }`}>
                          {!isExpired ? 'ACTIVE' : 'EXPIRED'}
                        </span>
                        <span className="font-bold text-slate-900 text-sm">
                          {sub.packageNameEn}
                        </span>
                        <span className="text-xs font-mono font-bold text-slate-500">
                          ৳ {sub.pricePaid} BDT
                        </span>
                      </div>

                      <div className="flex flex-wrap gap-4 text-xs text-slate-600 pt-1">
                        <span>{t('শিক্ষার্থী:', 'Student:')} <strong>{sub.studentName}</strong> ({sub.studentPhone})</span>
                        <span>{t('পেমেন্ট:', 'Method:')} <strong>{sub.paymentMethod}</strong> (TrxID: <strong className="font-mono text-emerald-700">{sub.transactionId}</strong>)</span>
                      </div>

                      <div className="flex flex-wrap gap-4 text-xs text-slate-500 pt-0.5">
                        <span>{t('সক্রিয়তার তারিখ:', 'Activated:')} {new Date(sub.activatedAt).toLocaleDateString()}</span>
                        <span>{t('মেয়াদোত্তীর্ণ তারিখ:', 'Expires:')} <strong className="text-slate-800">{new Date(sub.expiresAt).toLocaleString()}</strong></span>
                        <span className={`font-bold ${remainingDays > 0 ? 'text-emerald-700' : 'text-rose-600'}`}>
                          {remainingDays > 0 ? `(${remainingDays} ${t('দিন বাকি', 'days remaining')})` : t('(মেয়াদ শেষ)', '(Expired)')}
                        </span>
                      </div>
                    </div>

                    <div className="shrink-0 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedUserToEdit({
                            userId: sub.userId,
                            subscriptionId: sub.id,
                            name: sub.studentName,
                            email: sub.userId === currentUser.uid ? currentUser.email : `${sub.studentPhone.replace(/[^0-9]/g, '')}@student.sanadprep.com`,
                            phone: sub.studentPhone,
                            role: sub.userId === currentUser.uid ? currentUser.role : 'student',
                            subscriptionStatus: !isExpired ? 'pro' : 'expired',
                            packageId: sub.packageId,
                            packageNameBn: sub.packageNameBn,
                            packageNameEn: sub.packageNameEn,
                            expiresAt: sub.expiresAt,
                            isSessionRevoked: isSessionRevoked && sub.userId === currentUser.uid
                          });
                          setShowEditUserModal(true);
                        }}
                        className="px-3.5 py-2 rounded-xl bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] border border-[#D4AF37] text-xs font-bold transition flex items-center gap-1.5 cursor-pointer shadow-xs"
                        title={t('এই ইউজারের তথ্য ও সাবস্ক্রিপশন এডিট করুন', 'Edit this user profile & subscription')}
                      >
                        <UserCog className="w-3.5 h-3.5" />
                        <span>{t('ইউজার এডিট', 'Edit User')}</span>
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* TAB 4: Payments Verification Queue (Sections 2 & 3 requirements) */}
      {activeTab === 'payments' && (
        <div className="space-y-6">

          {paymentActionError && (
            <div className="p-3 rounded-2xl bg-rose-50 border border-rose-300 text-rose-800 text-xs font-semibold flex items-center justify-between">
              <span>{paymentActionError}</span>
              <button onClick={() => setPaymentActionError('')} className="p-1 hover:text-rose-950">✕</button>
            </div>
          )}

          {/* Section 4.1: Gateway Numbers Card */}
          <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-xs">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 mb-4">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-[#102A43] text-[#D4AF37] flex items-center justify-center">
                  <Settings className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="font-bold text-slate-900 text-base">
                    {t('বিকাশ ও নগদ পার্সোনাল নম্বর সেটিংস', 'bKash & Nagad Personal Gateway Numbers')}
                  </h3>
                  <p className="text-xs text-slate-500">
                    {t('শিক্ষার্থীদের পেমেন্ট পেজে এই নম্বরদ্বয় ও কপি বাটন প্রদর্শিত হয়।', 'Editable numbers displayed with instant Copy buttons on the student checkout screen.')}
                  </p>
                </div>
              </div>

              {settingsSavedSuccess && (
                <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-100 text-emerald-800 text-xs font-bold">
                  <Check className="w-3.5 h-3.5" />
                  <span>{t('সংরক্ষিত হয়েছে!', 'Saved!')}</span>
                </div>
              )}
            </div>

            <form onSubmit={handleSavePaymentSettings} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-bold text-slate-700 block mb-1">
                  bKash Personal:
                </label>
                <input
                  type="text"
                  required
                  value={editBkash}
                  onChange={(e) => setEditBkash(e.target.value)}
                  className="w-full p-2.5 rounded-xl border border-slate-300 font-mono font-bold text-xs"
                />
              </div>

              <div>
                <label className="text-xs font-bold text-slate-700 block mb-1">
                  Nagad Personal:
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    required
                    value={editNagad}
                    onChange={(e) => setEditNagad(e.target.value)}
                    className="w-full p-2.5 rounded-xl border border-slate-300 font-mono font-bold text-xs"
                  />
                  <button
                    type="submit"
                    className="px-4 py-2 rounded-xl bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] border border-[#D4AF37] font-bold text-xs shrink-0 cursor-pointer flex items-center gap-1"
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>{t('সেভ', 'Save')}</span>
                  </button>
                </div>
              </div>
            </form>
          </div>

          {/* Section 4.1B: WhatsApp Official Support Settings Card */}
          <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-xs">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 mb-4">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-[#25D366] text-white flex items-center justify-center">
                  <MessageCircle className="w-4 h-4 fill-current" />
                </div>
                <div>
                  <h3 className="font-bold text-slate-900 text-base">
                    {t('অফিসিয়াল হোয়াটসঅ্যাপ সাপোর্ট কনফিগারেশন', 'Official WhatsApp Support Settings')}
                  </h3>
                  <p className="text-xs text-slate-500">
                    {t('শিক্ষার্থীদের লগইন, ড্যাশবোর্ড, সাবস্ক্রিপশন ও পেমেন্ট পেজের সাপোর্ট বাটন কনফিগার করুন।', 'Configurable contact number & prefilled message for student support buttons across the app.')}
                  </p>
                </div>
              </div>

              {supportSavedSuccess && (
                <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-100 text-emerald-800 text-xs font-bold">
                  <Check className="w-3.5 h-3.5" />
                  <span>{t('সংরক্ষিত হয়েছে!', 'Saved!')}</span>
                </div>
              )}
            </div>

            <form onSubmit={handleSaveSupportSettings} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-bold text-slate-700 block mb-1">
                    {t('হোয়াটসঅ্যাপ নম্বর (WhatsApp Number):', 'WhatsApp Support Number:')}
                  </label>
                  <input
                    type="text"
                    required
                    value={editWhatsApp}
                    onChange={(e) => setEditWhatsApp(e.target.value)}
                    placeholder="+8801671819027"
                    className="w-full p-2.5 rounded-xl border border-slate-300 font-mono font-bold text-xs"
                  />
                  <span className="text-[10px] text-slate-400 block mt-0.5">
                    {t('ডিফল্ট: +8801671819027 (আন্তর্জাতিক ফরম্যাট)', 'Default: +8801671819027 (International format)')}
                  </span>
                </div>

                <div>
                  <label className="text-xs font-bold text-slate-700 block mb-1">
                    {t('সরাসরি চ্যাট লিংক প্রিভিউ (Live Link):', 'Direct WhatsApp Link Preview:')}
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      readOnly
                      value={`https://wa.me/${editWhatsApp.replace(/[^0-9]/g, '')}?text=${encodeURIComponent(editWhatsAppMsg)}`}
                      className="w-full p-2.5 rounded-xl border border-slate-200 bg-slate-50 font-mono text-[11px] text-slate-600 truncate"
                    />
                    <a
                      href={`https://wa.me/${editWhatsApp.replace(/[^0-9]/g, '')}?text=${encodeURIComponent(editWhatsAppMsg)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs shrink-0 flex items-center gap-1"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      <span>{t('টেস্ট', 'Test')}</span>
                    </a>
                  </div>
                </div>
              </div>

              <div>
                <label className="text-xs font-bold text-slate-700 block mb-1">
                  {t('প্রি-ফিল্ড সহায়তা বার্তা (Prefilled Support Message):', 'Prefilled WhatsApp Support Message:')}
                </label>
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="text"
                    required
                    value={editWhatsAppMsg}
                    onChange={(e) => setEditWhatsAppMsg(e.target.value)}
                    placeholder="Hello Sanad Prep BD Support, I need help with my account or subscription."
                    className="flex-1 p-2.5 rounded-xl border border-slate-300 text-xs"
                  />
                  <button
                    type="submit"
                    className="px-5 py-2.5 rounded-xl bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] border border-[#D4AF37] font-bold text-xs shrink-0 cursor-pointer flex items-center justify-center gap-1.5"
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>{t('হোয়াটসঅ্যাপ সেটিংস সংরক্ষণ', 'Save WhatsApp Settings')}</span>
                  </button>
                </div>
              </div>
            </form>
          </div>

          {/* Section 4.2: Strict Verification Warning */}
          <div className="p-4 rounded-2xl bg-amber-50 border border-amber-200 text-xs sm:text-sm text-amber-900 flex items-start gap-2.5">
            <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-bold text-amber-950">
                {t('কঠোর ম্যানুয়াল যাচাইকরণ নীতি (Strict Manual Verification Policy):', 'Strict Manual Verification Policy:')}
              </p>
              <p className="mt-0.5 text-xs text-amber-800 leading-relaxed">
                {t(
                  'কোনো ভুয়া বা অটোপেমেন্ট ভেরিফিকেশন নেই। প্রতিটি ট্রানজাকশন ব্যাংক বা মার্চেন্ট স্টেটমেন্টের সাথে যাচাই করে অনুমোদন করুন। একই TrxID পুনরাবৃত্তি সম্পূর্ণ নিষিদ্ধ।',
                  'No fake automatic payment claims. Verify incoming funds against your statement. Duplicate TrxID reuse is automatically blocked upon approval.'
                )}
              </p>
            </div>
          </div>

          {/* Section 4.3: Payments Ledger */}
          <div className="space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-1.5 bg-slate-100 p-1 rounded-2xl text-xs font-bold">
                {(['all', 'pending', 'approved', 'rejected'] as const).map(f => {
                  const count = f === 'all' 
                    ? paymentRequests.length 
                    : paymentRequests.filter(p => p.status === f).length;
                  return (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setPaymentFilter(f)}
                      className={`px-3 py-1.5 rounded-xl transition cursor-pointer capitalize ${
                        paymentFilter === f ? 'bg-white text-[#102A43] shadow-xs' : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {f} ({count})
                    </button>
                  );
                })}
              </div>

              <div className="relative max-w-xs w-full">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
                <input
                  type="text"
                  placeholder={t('TrxID বা ফোনে সার্চ...', 'Search TrxID or phone...')}
                  value={paymentSearch}
                  onChange={(e) => setPaymentSearch(e.target.value)}
                  className="w-full pl-9 pr-3 py-1.5 rounded-xl border border-slate-300 text-xs focus:ring-2 focus:ring-[#102A43]"
                />
              </div>
            </div>

            <div className="bg-white rounded-3xl border border-slate-200 shadow-xs divide-y divide-slate-100 overflow-hidden">
              {filteredPayments.length === 0 ? (
                <div className="p-8 text-center text-slate-400 text-xs sm:text-sm">
                  {t('কোনো পেমেন্ট রিকোয়েস্ট পাওয়া যায়নি।', 'No payment requests found.')}
                </div>
              ) : (
                filteredPayments.map(req => (
                  <div key={req.id} className="p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 hover:bg-slate-50 transition">
                    <div className="space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wider ${
                          req.status === 'approved' 
                            ? 'bg-emerald-100 text-emerald-800 border border-emerald-200' 
                            : req.status === 'rejected' 
                            ? 'bg-rose-100 text-rose-800' 
                            : 'bg-amber-100 text-amber-900 border border-amber-300 animate-pulse'
                        }`}>
                          {req.status === 'pending' ? '• PENDING' : req.status.toUpperCase()}
                        </span>

                        <span className={`px-2 py-0.5 rounded text-xs font-mono font-bold ${
                          req.method === 'bKash' ? 'bg-[#D12053]/10 text-[#D12053]' : 'bg-[#F7941D]/10 text-[#E2136E]'
                        }`}>
                          {req.method}
                        </span>

                        <span className="text-xs text-slate-400">
                          {new Date(req.requestedAt).toLocaleString()}
                        </span>
                      </div>

                      <h4 className="font-bold text-slate-900 text-sm sm:text-base">
                        {req.packageTitle}
                      </h4>

                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs text-slate-600 pt-1">
                        <div>
                          <span className="text-slate-400 block text-[10px]">{t('শিক্ষার্থী', 'Student')}</span>
                          <strong className="text-slate-800">{req.studentName}</strong>
                          <span className="font-mono text-slate-500 block">{req.studentPhone}</span>
                        </div>
                        <div>
                          <span className="text-slate-400 block text-[10px]">{t('প্রেরক নম্বর', 'Sender Mobile')}</span>
                          <strong className="font-mono text-slate-800">{req.senderNumber}</strong>
                        </div>
                        <div>
                          <span className="text-slate-400 block text-[10px]">{t('TrxID', 'TrxID')}</span>
                          <strong className="font-mono text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200">
                            {req.transactionId}
                          </strong>
                        </div>
                        <div>
                          <span className="text-slate-400 block text-[10px]">{t('পরিশোধিত ফি', 'Amount')}</span>
                          <strong className="text-[#102A43] text-sm">৳ {req.amount} BDT</strong>
                        </div>
                      </div>

                      {req.status === 'approved' && req.verifiedAt && (
                        <div className="text-[11px] text-emerald-700 pt-1 flex items-center gap-1 font-medium">
                          <CheckCircle className="w-3.5 h-3.5 text-emerald-600" />
                          <span>Verified by {req.verifiedBy || 'Admin'} at {new Date(req.verifiedAt).toLocaleString()}</span>
                        </div>
                      )}

                      {req.status === 'rejected' && (
                        <div className="text-[11px] text-rose-700 pt-1 flex items-center gap-1 font-medium">
                          <XCircle className="w-3.5 h-3.5 text-rose-600" />
                          <span>Rejection reason: {req.rejectionReason}</span>
                        </div>
                      )}
                    </div>

                    {req.status === 'pending' && (
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={() => handleApprovePayment(req.id)}
                          className="px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs flex items-center gap-1.5 transition shadow-xs cursor-pointer"
                        >
                          <CheckCircle className="w-4 h-4" />
                          <span>{t('অনুমোদন (Approve)', 'Approve')}</span>
                        </button>

                        <button
                          onClick={() => setRejectingPaymentId(req.id)}
                          className="px-3 py-2 rounded-xl border border-rose-300 text-rose-700 hover:bg-rose-50 font-bold text-xs flex items-center gap-1.5 transition cursor-pointer"
                        >
                          <XCircle className="w-4 h-4" />
                          <span>{t('বাতিল (Reject)', 'Reject')}</span>
                        </button>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 5: Single-Active-Session & Security (Section 5 requirement) */}
      {activeTab === 'sessions' && (
        <div className="space-y-6">
          <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-xs space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-[#102A43] text-[#D4AF37] flex items-center justify-center">
                  <Smartphone className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="font-bold text-slate-900 text-base">
                    {t('একাউন্ট শেয়ারিং রোধ ও সিঙ্গেল একটিভ সেশন ব্যবস্থাপনা', 'Account Sharing Protection & Single-Active-Session')}
                  </h3>
                  <p className="text-xs text-slate-500">
                    {t('একই একাউন্টে একসাথে একাধিক ডিভাইস থেকে লগইন রোধ করা হয়।', 'Strict enforcement of 1 active authenticated session per student.')}
                  </p>
                </div>
              </div>

              <span className={`px-3 py-1 rounded-full text-xs font-bold ${
                isSessionRevoked ? 'bg-rose-100 text-rose-800' : 'bg-emerald-100 text-emerald-800'
              }`}>
                {isSessionRevoked ? 'SESSION REVOKED' : 'SESSION ACTIVE'}
              </span>
            </div>

            {/* Current Session Info */}
            <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200 text-xs text-slate-700 space-y-2">
              <div className="flex justify-between">
                <span className="text-slate-500">Active Session ID:</span>
                <span className="font-mono font-bold">{currentSession?.sessionId || 'None'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Bound Student Account:</span>
                <span className="font-bold">{currentUser.name} ({currentUser.email})</span>
              </div>
              <div className="flex justify-between items-center pt-1">
                <span className="text-slate-500">{t('ইউজার অ্যাকশন:', 'User Actions:')}</span>
                <button
                  type="button"
                  onClick={() => {
                    const targetSub = subscriptions.find(s => s.userId === currentUser.uid);
                    setSelectedUserToEdit({
                      userId: currentUser.uid,
                      name: currentUser.name,
                      email: currentUser.email,
                      phone: currentUser.phone || '01711000000',
                      role: currentUser.role,
                      subscriptionStatus: currentUser.subscriptionStatus,
                      packageId: targetSub?.packageId || (currentUser.subscriptionStatus === 'pro' ? 'pro_mock_pass_90d' : 'free_tier'),
                      expiresAt: targetSub?.expiresAt || new Date(Date.now() + 90 * 86400000).toISOString(),
                      isSessionRevoked: isSessionRevoked,
                    });
                    setShowEditUserModal(true);
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] font-bold text-xs transition cursor-pointer"
                >
                  <UserCog className="w-3.5 h-3.5" />
                  <span>{t('এই ইউজারের প্রোফাইল, সাবস্ক্রিপশন ও সেশন এডিট করুন', 'Edit Profile, Subscription & Session')}</span>
                </button>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Client / Device:</span>
                <span className="font-mono">{currentSession?.deviceInfo || 'Standard Web Browser'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Session Status:</span>
                <span className={`font-bold ${isSessionRevoked ? 'text-rose-600' : 'text-emerald-700'}`}>
                  {isSessionRevoked ? 'Revoked (Multi-Device Protection Active)' : 'Active & Protected'}
                </span>
              </div>
            </div>

            {/* Interactive Testing Buttons */}
            <div className="p-4 rounded-2xl border border-slate-200 space-y-3">
              <h4 className="font-bold text-xs uppercase tracking-wider text-slate-700">
                {t('সেশন নিরাপত্তা পরীক্ষা (Test Account Sharing Protection):', 'Session Security Demonstration Tools:')}
              </h4>

              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={simulateConcurrentLogin}
                  className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs transition cursor-pointer flex items-center gap-1.5"
                >
                  <AlertTriangle className="w-3.5 h-3.5" />
                  <span>{t('অন্য ডিভাইস থেকে লগইন অনুকরণ করুন (Simulate Concurrent Login)', 'Simulate Concurrent Login')}</span>
                </button>

                <button
                  type="button"
                  onClick={recoverSession}
                  className="px-4 py-2 rounded-xl bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] font-bold text-xs transition cursor-pointer flex items-center gap-1.5"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>{t('সেশন রিকভার / নতুন ফ্রেশ লগইন (Recover Session)', 'Re-Establish Session')}</span>
                </button>
              </div>

              {isSessionRevoked && (
                <div className="p-3 rounded-xl bg-rose-50 border border-rose-300 text-rose-800 text-xs">
                  <strong>সতর্কতা:</strong> বর্তমান সেশনটি বাতিল করা হয়েছে। শিক্ষার্থী এখন কোনো পেইড টেস্ট শুরু বা উত্তর জমা দিতে পারবেন না যতক্ষণ না তিনি পুনরায় নিরাপদ সেশন স্থাপন করবেন।
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 6: Questions Bank */}
      {activeTab === 'questions' && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-3 flex-1">
              <div className="relative flex-1 max-w-md">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
                <input
                  type="text"
                  placeholder={t('ধারা, বিষয় বা প্রশ্নে সার্চ করুন...', 'Search questions...')}
                  value={questionSearch}
                  onChange={(e) => setQuestionSearch(e.target.value)}
                  className="w-full pl-9 pr-4 py-2 rounded-xl border border-slate-300 text-xs focus:ring-2 focus:ring-[#102A43]"
                />
              </div>

              <select
                value={subjectFilter}
                onChange={(e) => setSubjectFilter(e.target.value)}
                className="py-2 px-3 rounded-xl border border-slate-300 text-xs bg-white font-semibold"
              >
                <option value="all">{t('সকল বিষয়', 'All Subjects')}</option>
                {subjects.map(s => (
                  <option key={s.id} value={s.id}>{s.code}</option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowBulkImportModal(true)}
                className="px-3.5 py-2 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-xs flex items-center gap-1.5 transition cursor-pointer shadow-xs"
                title={t('সিএসভি ফাইলের মাধ্যমে বাল্ক প্রশ্ন আপলোড করুন', 'Bulk import multiple questions from a CSV file')}
              >
                <FileSpreadsheet className="w-4 h-4 text-emerald-100" />
                <span>{t('বাল্ক ইমপোর্ট (CSV)', 'Bulk Import CSV')}</span>
              </button>

              <button
                type="button"
                onClick={() => setShowAddQuestionModal(true)}
                className="px-3.5 py-2 rounded-xl bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] border border-[#D4AF37] font-bold text-xs flex items-center gap-1.5 transition cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>{t('নতুন প্রশ্ন যোগ', 'Add Question')}</span>
              </button>
            </div>
          </div>

          <div className="bg-white rounded-3xl border border-slate-200 shadow-xs divide-y divide-slate-100 overflow-hidden">
            {filteredQuestions.map((q) => {
              const sub = subjects.find(s => s.id === q.subjectId);
              return (
                <div key={q.id} className="p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:bg-slate-50 transition">
                  <div className="space-y-1.5 max-w-3xl">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-bold text-[#102A43] bg-slate-100 px-2 py-0.5 rounded">
                        {sub?.code || 'LAW'}
                      </span>
                      {q.legalReference && (
                        <span className="text-[11px] font-mono text-slate-800 bg-amber-50 px-2 py-0.5 rounded border border-amber-200">
                          {q.legalReference}
                        </span>
                      )}
                      <span className="text-[10px] uppercase font-bold text-slate-500">
                        {q.difficulty}
                      </span>
                    </div>

                    <h4 className="font-bold text-slate-900 text-sm leading-snug">
                      {language === 'bn' ? q.questionBn : q.questionEn}
                    </h4>

                    <p className="text-xs text-slate-500">
                      {t('সঠিক উত্তর:', 'Correct Ans:')} <strong className="text-emerald-700">{q.optionsBn[q.correctOptionIndex]}</strong>
                    </p>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => deleteQuestion(q.id)}
                      className="p-2 rounded-lg text-rose-600 hover:bg-rose-50 border border-rose-200 transition cursor-pointer"
                      title="Delete Question"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* TAB 7: Exams */}
      {activeTab === 'exams' && (
        <div className="space-y-6">
          {/* Header & Re-sync */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-5 rounded-3xl border border-slate-200 shadow-xs">
            <div>
              <span className="text-xs font-bold text-[#D4AF37] uppercase tracking-wider bg-[#102A43] px-3 py-1 rounded-full">
                Sanad Prep BD • {t('মডেল টেস্ট প্রশাসন', 'Model Test Administration')}
              </span>
              <h3 className="font-black text-slate-900 text-lg sm:text-xl mt-2">
                {t('৩০টি পূর্ণাঙ্গ মডেল টেস্ট ও লাইভ পরীক্ষা নিয়ন্ত্রণ', '30 Full Mock Tests & Live Exam Launcher')}
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                {t('অ্যাডমিন প্যানেল থেকে যেদিন ইচ্ছা ওই দিন পরীক্ষা চালু ও বন্ধ করুন।', 'Activate or schedule any model test on any date on demand.')}
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={async () => {
                  const res = await generateAndSync30ModelTests();
                  alert(res.message);
                }}
                className="px-4 py-2.5 rounded-xl bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] border border-[#D4AF37] text-xs font-bold transition flex items-center gap-1.5 shrink-0 cursor-pointer shadow-xs"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>{t('৩০টি টেস্ট রি-সিঙ্ক', 'Re-Sync 30 Tests')}</span>
              </button>
            </div>
          </div>

          {/* Stats Bar */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 block">{t('মোট মডেল টেস্ট', 'Total Model Tests')}</span>
              <p className="text-2xl font-black text-[#102A43] mt-1">{exams.filter(e => e.type === 'full_mock').length} {t('টি', '')}</p>
            </div>

            <div className="bg-white p-4 rounded-2xl border border-emerald-200 shadow-xs bg-emerald-50/30">
              <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-700 block flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                <span>{t('বর্তমানে চালু আছে', 'Active / Live Now')}</span>
              </span>
              <p className="text-2xl font-black text-emerald-800 mt-1">
                {exams.filter(e => e.type === 'full_mock' && e.isActive).length} {t('টি', '')}
              </p>
            </div>

            <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 block">{t('বন্ধ / ড্রাফট টেস্ট', 'Inactive / Scheduled')}</span>
              <p className="text-2xl font-black text-slate-700 mt-1">
                {exams.filter(e => e.type === 'full_mock' && !e.isActive).length} {t('টি', '')}
              </p>
            </div>

            <div className="bg-white p-4 rounded-2xl border border-amber-200 shadow-xs bg-amber-50/30">
              <span className="text-[11px] font-bold uppercase tracking-wider text-amber-800 block">{t('সবার জন্য ফ্রি', 'Free For All')}</span>
              <p className="text-2xl font-black text-[#102A43] mt-1">
                {exams.filter(e => e.type === 'full_mock' && !e.isPaid).length} {t('টি', '')}
              </p>
            </div>
          </div>

          {/* Policy Guide Banner */}
          <div className="p-4 rounded-2xl bg-amber-50 border border-amber-200 text-xs text-amber-900 flex items-start gap-3">
            <Sparkles className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-bold text-amber-950">
                {t('পরীক্ষা চালু ও প্রদর্শন বিধি (Exam Visibility & Launching Rules):', 'Exam Visibility & Launching Rules:')}
              </p>
              <ul className="list-disc list-inside space-y-0.5 text-xs text-amber-800">
                <li>{t('মডেল টেস্ট ০১ সবসময় ফ্রি হিসেবে সকল শিক্ষার্থী দেখতে পারবে।', 'Model Test 01 is always visible to everyone as a free demo.')}</li>
                <li>{t('পেইড মডেল টেস্টগুলো শুধুমাত্র তখন প্রো শিক্ষার্থীদের সামনে আসবে যখন অ্যাডমিন তা "পরীক্ষা চালু করুন" দিয়ে সক্রিয় করবেন।', 'Paid model tests appear on students\' dashboards ONLY when activated by the Admin.')}</li>
                <li>{t('যে শিক্ষার্থী যে পরীক্ষাটি দেবে, তারা শুধুমাত্র সেই পরীক্ষার ফলাফল ও উত্তর দেখতে পারবে।', 'Students can view and review exams they participate in along with answer explanations.')}</li>
              </ul>
            </div>
          </div>

          {/* Search & Filters */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
            <div className="flex flex-wrap items-center gap-1.5">
              {(['all', 'active', 'inactive', 'free', 'paid'] as const).map(f => {
                const count = f === 'all' 
                  ? exams.length 
                  : f === 'active' 
                    ? exams.filter(e => e.isActive).length
                    : f === 'inactive'
                      ? exams.filter(e => !e.isActive).length
                      : f === 'free'
                        ? exams.filter(e => !e.isPaid).length
                        : exams.filter(e => e.isPaid).length;

                return (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setExamFilter(f)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-bold transition flex items-center gap-1.5 ${
                      examFilter === f 
                        ? 'bg-[#102A43] text-[#D4AF37]' 
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    <span>
                      {f === 'all' && t('সকল পরীক্ষা', 'All')}
                      {f === 'active' && t('চালু আছে', 'Active')}
                      {f === 'inactive' && t('বন্ধ আছে', 'Inactive')}
                      {f === 'free' && t('ফ্রি', 'Free')}
                      {f === 'paid' && t('পেইড', 'Paid')}
                    </span>
                    <span className="px-1.5 py-0.2 rounded-full bg-black/10 text-[10px] font-mono">
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="relative w-full sm:w-64">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={examSearch}
                onChange={e => setExamSearch(e.target.value)}
                placeholder={t('মডেল টেস্ট খুঁজুন (যেমন: ০১)...', 'Search tests...')}
                className="w-full pl-9 pr-3 py-2 text-xs rounded-xl border border-slate-300 focus:outline-none focus:border-[#102A43]"
              />
            </div>
          </div>

          {/* Exams Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {exams
              .filter(ex => {
                if (examFilter === 'active') return ex.isActive;
                if (examFilter === 'inactive') return !ex.isActive;
                if (examFilter === 'free') return !ex.isPaid;
                if (examFilter === 'paid') return ex.isPaid;
                return true;
              })
              .filter(ex => {
                if (!examSearch) return true;
                const query = examSearch.toLowerCase();
                return ex.titleBn.toLowerCase().includes(query) || ex.titleEn.toLowerCase().includes(query) || ex.id.toLowerCase().includes(query);
              })
              .map(ex => {
                const isLive = ex.isActive === true;
                const isEditingDate = editingExamDateId === ex.id;

                return (
                  <div 
                    key={ex.id} 
                    className={`p-5 rounded-2xl bg-white border shadow-xs flex flex-col justify-between transition-all ${
                      isLive 
                        ? 'border-emerald-300 ring-1 ring-emerald-200' 
                        : 'border-slate-200 opacity-90'
                    }`}
                  >
                    <div>
                      {/* Top Badges */}
                      <div className="flex items-center justify-between gap-2 mb-3">
                        <div className="flex items-center gap-2">
                          <span className={`text-[11px] font-bold px-2.5 py-1 rounded-full flex items-center gap-1.5 ${
                            isLive 
                              ? 'bg-emerald-100 text-emerald-800 border border-emerald-300' 
                              : 'bg-slate-100 text-slate-600 border border-slate-200'
                          }`}>
                            <span className={`w-2 h-2 rounded-full ${isLive ? 'bg-emerald-600 animate-pulse' : 'bg-slate-400'}`}></span>
                            <span>{isLive ? t('পরীক্ষা চালু আছে (LIVE)', 'ACTIVE / LIVE') : t('পরীক্ষা বন্ধ (INACTIVE)', 'INACTIVE')}</span>
                          </span>

                          <span className={`font-bold px-2.5 py-1 rounded-full text-[11px] border ${
                            ex.isPaid 
                              ? 'bg-amber-100 text-amber-900 border-amber-300' 
                              : 'bg-blue-100 text-blue-900 border-blue-200'
                          }`}>
                            {ex.isPaid ? 'PRO ONLY (পেইড)' : 'FREE (ফ্রি)'}
                          </span>
                        </div>

                        <span className="text-xs font-mono font-semibold text-slate-500 bg-slate-50 px-2.5 py-1 rounded-lg border border-slate-100">
                          {ex.durationMinutes} {t('মিনিট', 'mins')}
                        </span>
                      </div>

                      {/* Title & Desc */}
                      <h4 className="font-bold text-slate-900 text-base mb-1">
                        {language === 'bn' ? ex.titleBn : ex.titleEn}
                      </h4>
                      <p className="text-xs text-slate-500 mb-3 line-clamp-2">
                        {language === 'bn' ? ex.descriptionBn : ex.descriptionEn}
                      </p>

                      {/* Scheduled Date Section */}
                      <div className="p-3 rounded-xl bg-slate-50 border border-slate-100 mb-4 text-xs space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-slate-500 flex items-center gap-1.5">
                            <Calendar className="w-3.5 h-3.5 text-[#102A43]" />
                            <span>{t('নির্ধারিত পরীক্ষার তারিখ:', 'Scheduled Date:')}</span>
                          </span>
                          <strong className="font-mono text-slate-800">
                            {ex.scheduledDate 
                              ? new Date(ex.scheduledDate).toLocaleDateString(language === 'bn' ? 'bn-BD' : 'en-US', { day: 'numeric', month: 'short', year: 'numeric' })
                              : t('যেকোনো দিন চালুযোগ্য', 'Open On Demand')}
                          </strong>
                        </div>

                        {isEditingDate && (
                          <div className="flex items-center gap-2 pt-2 border-t border-slate-200">
                            <input
                              type="date"
                              value={scheduledDateInput}
                              onChange={e => setScheduledDateInput(e.target.value)}
                              className="p-1.5 text-xs rounded-lg border border-slate-300 bg-white grow font-mono"
                            />
                            <button
                              type="button"
                              onClick={() => {
                                toggleExamStatus(ex.id, ex.isActive, scheduledDateInput || undefined);
                                setEditingExamDateId(null);
                              }}
                              className="px-3 py-1.5 bg-[#102A43] text-[#D4AF37] font-bold text-xs rounded-lg cursor-pointer"
                            >
                              {t('সংরক্ষণ', 'Save')}
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingExamDateId(null)}
                              className="px-2 py-1.5 text-slate-500 hover:text-slate-700 text-xs"
                            >
                              {t('বাতিল', 'Cancel')}
                            </button>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Action Controls */}
                    <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2 text-xs">
                      <div className="flex items-center gap-3 text-slate-600">
                        <span>{t('প্রশ্ন:', 'MCQs:')} <strong>{ex.questionIds?.length || 100}</strong></span>
                        <span>{t('নেগেটিভ:', 'Neg:')} <strong>-{ex.negativeMarkRatio ?? 0.25}</strong></span>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        {/* Toggle Active / Inactive */}
                        <button
                          type="button"
                          onClick={() => toggleExamStatus(ex.id, !isLive)}
                          className={`px-3 py-1.5 rounded-xl font-bold text-xs transition cursor-pointer flex items-center gap-1.5 shadow-xs ${
                            isLive
                              ? 'bg-rose-100 hover:bg-rose-200 text-rose-800 border border-rose-300'
                              : 'bg-emerald-600 hover:bg-emerald-700 text-white'
                          }`}
                          title={isLive ? t('পরীক্ষা বন্ধ করুন', 'Deactivate') : t('পরীক্ষা চালু করুন', 'Activate')}
                        >
                          <Play className={`w-3.5 h-3.5 ${isLive ? 'fill-transparent' : 'fill-current'}`} />
                          <span>{isLive ? t('পরীক্ষা বন্ধ রাখুন', 'Deactivate') : t('পরীক্ষা চালু করুন', 'Launch Live')}</span>
                        </button>

                        {/* Quick Date Setter */}
                        <button
                          type="button"
                          onClick={() => {
                            setEditingExamDateId(ex.id);
                            setScheduledDateInput(ex.scheduledDate || new Date().toISOString().split('T')[0]);
                          }}
                          className="px-2.5 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs border border-slate-300 cursor-pointer flex items-center gap-1"
                          title={t('তারিখ পরিবর্তন করুন', 'Edit Date')}
                        >
                          <Calendar className="w-3.5 h-3.5" />
                          <span>{t('তারিখ', 'Date')}</span>
                        </button>

                        {/* Free / Paid Toggle */}
                        <button
                          type="button"
                          onClick={() => {
                            const updatedExam: Exam = { ...ex, isPaid: !ex.isPaid };
                            updateExam(updatedExam);
                          }}
                          className="px-2.5 py-1.5 rounded-xl text-xs font-bold bg-slate-100 hover:bg-[#102A43] hover:text-[#D4AF37] border border-slate-300 transition cursor-pointer"
                          title={ex.isPaid ? t('ফ্রি করে দিন', 'Make Free') : t('পেইড করে দিন', 'Make Paid')}
                        >
                          {ex.isPaid ? t('ফ্রি করুন', 'Make Free') : t('পেইড করুন', 'Make Paid')}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
          </div>
        </div>
      )}

      {/* TAB 8: Audit Logs */}
      {activeTab === 'audit' && (
        <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-xs space-y-4">
          <h3 className="font-bold text-slate-900 text-sm uppercase tracking-wider">{t('সিস্টেম ও অ্যাডমিন অডিট কার্যতালিকা', 'System Audit Trail')}</h3>
          <div className="divide-y divide-slate-100 text-xs">
            {auditLogs.map(log => (
              <div key={log.id} className="py-2.5 flex items-start justify-between gap-4">
                <div>
                  <span className="font-mono font-bold text-[#102A43] block mb-0.5">{log.action}</span>
                  <span className="text-slate-600">{log.details}</span>
                </div>
                <span className="text-slate-400 text-[11px] shrink-0 font-mono">
                  {new Date(log.timestamp).toLocaleTimeString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Rejection Modal */}
      {rejectingPaymentId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
          <div className="bg-white rounded-3xl max-w-md w-full p-6 shadow-2xl border border-slate-100">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 mb-4">
              <h3 className="font-bold text-rose-700 text-base flex items-center gap-2">
                <XCircle className="w-5 h-5 text-rose-600" />
                <span>{t('পেমেন্ট রিকোয়েস্ট বাতিলকরণ', 'Reject Payment Request')}</span>
              </h3>
              <button onClick={() => setRejectingPaymentId(null)} className="text-slate-400 hover:text-slate-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-xs text-slate-600 mb-3">
              {t('বাতিল করার কারণ উল্লেখ করুন (শিক্ষার্থী এই কারণটি দেখতে পারবেন):', 'State the reason for rejection:')}
            </p>

            <select
              value={rejectionReasonInput}
              onChange={(e) => setRejectionReasonInput(e.target.value)}
              className="w-full p-2.5 rounded-xl border border-slate-300 text-xs bg-white mb-4"
            >
              <option value="ভুল ট্রানজাকশন আইডি (TrxID Not Found)">ভুল ট্রানজাকশন আইডি (TrxID Not Found)</option>
              <option value="পরিশোধিত টাকার পরিমাণ অপর্যাপ্ত (Amount Mismatch)">পরিশোধিত টাকার পরিমাণ অপর্যাপ্ত (Amount Mismatch)</option>
              <option value="টাকা ব্যাংক স্টেটমেন্টে জমা হয়নি (No Incoming Fund)">টাকা ব্যাংক স্টেটমেন্টে জমা হয়নি (No Incoming Fund)</option>
              <option value="ভুয়া ট্রানজাকশন তথ্য (Invalid/Fake Submission)">ভুয়া ট্রানজাকশন তথ্য (Invalid/Fake Submission)</option>
            </select>

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setRejectingPaymentId(null)}
                className="px-4 py-2 rounded-xl border border-slate-300 text-slate-700 text-xs font-bold"
              >
                {t('বাতিল', 'Cancel')}
              </button>
              <button
                type="button"
                onClick={handleConfirmReject}
                className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold"
              >
                {t('বাতিল নিশ্চিত করুন', 'Confirm Reject')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Question Modal */}
      {showAddQuestionModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
          <div className="bg-white rounded-3xl max-w-2xl w-full p-6 sm:p-8 shadow-2xl border border-slate-100 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-4 border-b border-slate-100 mb-6">
              <h3 className="text-lg font-bold text-slate-900">
                {t('নতুন প্রশ্ন যোগ করুন (Add Question)', 'Add New Exam Question')}
              </h3>
              <button onClick={() => setShowAddQuestionModal(false)} className="text-slate-400 hover:text-slate-600 font-bold text-sm">
                ✕
              </button>
            </div>

            <form onSubmit={handleCreateQuestion} className="space-y-4 text-xs sm:text-sm">
              <div>
                <label className="font-semibold text-slate-700 block mb-1">{t('বিষয় (Subject)', 'Subject')}</label>
                <select
                  value={newSubjectId}
                  onChange={(e) => setNewSubjectId(e.target.value)}
                  className="w-full p-2.5 rounded-xl border border-slate-300 bg-white"
                >
                  {subjects.map(s => (
                    <option key={s.id} value={s.id}>{s.nameBn} ({s.code})</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="font-semibold text-slate-700 block mb-1">{t('প্রশ্ন (বাংলায়)', 'Question Text (Bangla)')}</label>
                <textarea
                  rows={2}
                  required
                  value={newQuestionBn}
                  onChange={(e) => setNewQuestionBn(e.target.value)}
                  className="w-full p-2.5 rounded-xl border border-slate-300"
                  placeholder="যেমন: দেওয়ানী কার্যবিধির কত ধারায় সহজাত ক্ষমতা..."
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                {[0, 1, 2, 3].map((optIdx) => (
                  <div key={optIdx}>
                    <label className="font-semibold text-slate-700 block mb-1">
                      {t(`অপশন ${['ক', 'খ', 'গ', 'ঘ'][optIdx]}`, `Option ${['A', 'B', 'C', 'D'][optIdx]}`)}
                    </label>
                    <input
                      type="text"
                      required
                      value={newOptionsBn[optIdx]}
                      onChange={(e) => {
                        const next = [...newOptionsBn];
                        next[optIdx] = e.target.value;
                        setNewOptionsBn(next);
                      }}
                      className="w-full p-2 rounded-xl border border-slate-300"
                    />
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="font-semibold text-slate-700 block mb-1">{t('সঠিক অপশন নির্বাচন', 'Correct Option')}</label>
                  <select
                    value={newCorrectOptionIndex}
                    onChange={(e) => setNewCorrectOptionIndex(parseInt(e.target.value, 10))}
                    className="w-full p-2 rounded-xl border border-slate-300 bg-white"
                  >
                    {[0, 1, 2, 3].map((idx) => (
                      <option key={idx} value={idx}>
                        {['ক (Option A)', 'খ (Option B)', 'গ (Option C)', 'ঘ (Option D)'][idx]}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="font-semibold text-slate-700 block mb-1">{t('আইনগত ধারা / সূত্র', 'Statutory Section / Ref')}</label>
                  <input
                    type="text"
                    value={newLegalReference}
                    onChange={(e) => setNewLegalReference(e.target.value)}
                    placeholder="যেমন: Section 151, CPC 1908"
                    className="w-full p-2 rounded-xl border border-slate-300"
                  />
                </div>
              </div>

              <div>
                <label className="font-semibold text-slate-700 block mb-1">{t('আইনগত ব্যাখ্যা (Explanation)', 'Explanation')}</label>
                <textarea
                  rows={2}
                  value={newExplanationBn}
                  onChange={(e) => setNewExplanationBn(e.target.value)}
                  className="w-full p-2.5 rounded-xl border border-slate-300"
                  placeholder="সঠিক উত্তরের আইনি যুক্তি ও ব্যাখ্যা..."
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowAddQuestionModal(false)}
                  className="px-4 py-2 rounded-xl border border-slate-300 text-slate-700 font-bold"
                >
                  {t('বাতিল', 'Cancel')}
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-[#102A43] hover:bg-[#243B53] text-[#D4AF37] border border-[#D4AF37] font-bold"
                >
                  {t('সংরক্ষণ করুন', 'Save Question')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Bulk Import Questions Modal */}
      <BulkImportModal
        isOpen={showBulkImportModal}
        onClose={() => setShowBulkImportModal(false)}
      />

      {/* Edit Active User Modal */}
      {showEditUserModal && selectedUserToEdit && (
        <EditUserModal
          user={selectedUserToEdit}
          isOpen={showEditUserModal}
          onClose={() => {
            setShowEditUserModal(false);
            setSelectedUserToEdit(null);
          }}
        />
      )}

    </div>
  );
};
