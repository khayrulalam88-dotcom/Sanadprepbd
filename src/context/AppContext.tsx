import React, { createContext, useContext, useState, useEffect, useRef, ReactNode, useCallback } from 'react';
import { 
  Language, 
  UserProfile, 
  UserRole, 
  Subject, 
  Question, 
  Exam, 
  ExamAttempt, 
  ExamResult, 
  PaymentRequest, 
  AuditLog,
  PaymentSettings,
  SupportContactSettings,
  SubscriptionPackage,
  ExamDateConfig,
  UserSubscription,
  StudentSession,
  SubjectPracticeProgress,
  AnsweredQuestionRecord,
  LeaderboardEntry
} from '../types';
import { INITIAL_SUBJECTS, INITIAL_QUESTIONS } from '../data/mockData';
import { INITIAL_EXAMS } from '../data/initialExams';
import { INITIAL_PACKAGES, INITIAL_EXAM_DATE_CONFIG } from '../data/initialPackages';
import { generate30ModelTests } from '../utils/modelTestGenerator';
import {
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  reload,
  signOut,
  onAuthStateChanged
} from 'firebase/auth';
import {
  isFirebaseConnected,
  getFirebaseProjectDetails,
  auth,
  googleProvider,
  resolveFrontendOwnerAdminUid,
  isVerifiedOwnerAccount
} from '../lib/firebase';
import {
  fetchExamsFromFirestore,
  fetchPaymentRequestsFromFirestore,
  fetchSubscriptionsFromFirestore,
  fetchExamResultsFromFirestore,
  fetchLeaderboardFromFirestore,
  fetchUserProfileStatusFromFirestore,
  saveUserProfileToFirestore,
  updateUserRoleOrSubscriptionInFirestore
} from '../lib/firestoreService';
import { ensureUserProfileInitialized } from '../lib/profileHelpers';
import { ExamAnswerBatcher } from '../lib/examAnswerBatcher';
import {
  setApiSessionId,
  apiFetchPublicCatalog,
  apiFetchSubjectQuestionCounts,
  apiFetchExams,
  apiFetchLeaderboard,
  apiCreateSession,
  apiCheckSessionStatus,
  apiLogoutSession,
  apiFetchSanitizedQuestions,
  apiFetchAdminQuestions,
  apiAdminSyncQuestionCache,
  apiCheckPracticeAnswer,
  apiStartExam,
  apiSaveExamAnswer,
  apiSubmitExam,
  apiFetchExamResults,
  apiCreatePaymentRequest,
  apiFetchPaymentRequests,
  apiApprovePaymentRequest,
  apiRejectPaymentRequest,
  apiAdminSaveQuestion,
  apiAdminDeleteQuestion,
  apiAdminSaveExam,
  apiAdminFetchSubscriptions,
  apiAdminFetchDashboardStats,
  apiAdminFetchAuditLogs,
  apiAdminUpdateUser,
  apiAdminUpdatePackage,
  apiAdminUpdateExamConfig,
  apiAdminUpdatePaymentSettings,
  apiAdminUpdateSupportSettings,
  type AdminDashboardStatsResponse
} from '../lib/api';
import {
  submitPaymentViaAuthoritativeBackend,
  executeAuthoritativeAdminApi,
  formatBackendApiError
} from '../lib/securityHelpers';
import {
  resolveAdminQuestionBankFetchOutcome,
  type AdminQuestionBankLoadState
} from '../lib/adminQuestionHelpers';

interface AppContextType {
  language: Language;
  toggleLanguage: () => void;
  t: (bn: string, en: string) => string;
  currentUser: UserProfile;
  switchRole: (role: UserRole) => void;
  updateUserProfile: (data: Partial<UserProfile>) => void;
  
  // Data
  subjects: Subject[];
  questions: Question[];
  subjectQuestionCounts: Record<string, number>;
  totalQuestionCount: number;
  loadMoreSubjectQuestions: (subjectId: string) => Promise<void>;
  getSubjectLoadState: (subjectId: string) => {
    loadedCount: number;
    total: number;
    hasMore: boolean;
    loading: boolean;
  };
  adminDashboardStats: AdminDashboardStatsResponse | null;
  adminQuestionsState: AdminQuestionBankLoadState;
  adminQuestionsPageData: {
    questions: Question[];
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
    subjectId: string;
    search: string;
    source: 'd1' | 'firestore';
  };
  loadAdminQuestionsPage: (params?: {
    subjectId?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }) => Promise<void>;
  ensureAdminQuestionPool: () => Promise<void>;
  reloadAdminQuestions: () => Promise<void>;
  syncEdgeQuestionCache: () => Promise<{
    success: boolean;
    questionCount?: number;
    keyCount?: number;
    examsCount?: number;
    message: string;
  }>;
  exams: Exam[];
  examResults: ExamResult[];
  paymentRequests: PaymentRequest[];
  paymentSettings: PaymentSettings;
  updatePaymentSettings: (settings: Partial<PaymentSettings>) => Promise<{ success: boolean; error?: string }>;
  supportSettings: SupportContactSettings;
  updateSupportSettings: (settings: Partial<SupportContactSettings>) => Promise<{ success: boolean; error?: string }>;
  isFirebaseActive: boolean;
  firebaseProjectDetails: ReturnType<typeof getFirebaseProjectDetails>;
  auditLogs: AuditLog[];
  
  // Subscription Packages & Exam Date Config
  packages: SubscriptionPackage[];
  updatePackage: (pkg: Partial<SubscriptionPackage> & { id: string }) => Promise<{ success: boolean; error?: string }>;
  examDateConfig: ExamDateConfig;
  updateExamDateConfig: (config: Partial<ExamDateConfig>) => Promise<{ success: boolean; error?: string }>;
  subscriptions: UserSubscription[];
  activeSubscription: UserSubscription | null;
  calculateDaysRemaining: (expiresAt?: string) => number;
  adminUpdateUser: (params: {
    userId: string;
    subscriptionId?: string;
    name: string;
    email?: string;
    phone: string;
    role: UserRole;
    subscriptionStatus: 'free' | 'pro' | 'expired';
    packageId?: string;
    packageNameBn?: string;
    packageNameEn?: string;
    expiresAt?: string;
    isSessionRevoked?: boolean;
  }) => Promise<{ success: boolean; message: string }>;
  
  // Single-Active-Session & Security
  currentSession: StudentSession | null;
  isSessionRevoked: boolean;
  sessionRevokedReason: string;
  simulateConcurrentLogin: () => void;
  recoverSession: () => Promise<boolean>;

  // Screen Navigation
  activeScreen: 'landing' | 'dashboard' | 'exam' | 'practice' | 'result' | 'admin' | 'tests' | 'subjects' | 'history' | 'question_bank';
  setActiveScreen: (screen: 'landing' | 'dashboard' | 'exam' | 'practice' | 'result' | 'admin' | 'tests' | 'subjects' | 'history' | 'question_bank') => void;

  // Exams & Custom Model Test
  activeAttempt: ExamAttempt | null;
  currentExamForAttempt: Exam | null;
  startExam: (examId: string) => Promise<{ success: boolean; reason?: string }>;
  createAndStartCustomExam: (config: {
    titleBn?: string;
    titleEn?: string;
    durationMinutes: number;
    questionIds: string[];
    negativeMarkRatio?: number;
  }) => Promise<{ success: boolean; examId?: string; reason?: string }>;
  showCustomTestModal: boolean;
  setShowCustomTestModal: (show: boolean) => void;
  saveActiveAnswer: (questionId: string, optionIndex: number) => void;
  clearActiveAnswer: (questionId: string) => void;
  toggleFlagQuestion: (questionId: string) => void;
  submitExamAttempt: (isAutoTimeout?: boolean) => Promise<ExamResult | null>;
  examLaunchError: string | null;
  setExamLaunchError: (err: string | null) => void;
  
  // Results & Leaderboard
  activeResult: ExamResult | null;
  viewResult: (resultId: string) => void;
  leaderboardEntries: LeaderboardEntry[];
  refreshLeaderboard: () => Promise<void>;
  isProSubscribed: boolean;
  
  // Practice & Progress Tracking
  selectedSubjectForPractice: Subject | null;
  startSubjectPractice: (subjectId: string) => { success: boolean; reason?: string };
  answeredQuestions: Record<string, AnsweredQuestionRecord>;
  recordQuestionAnswer: (questionId: string, subjectId: string, selectedOption: number, isCorrect: boolean) => void;
  checkPracticeAnswer: (questionId: string, selectedOption: number) => Promise<{
    success: boolean;
    isCorrect?: boolean;
    correctOptionIndex?: number;
    explanationBn?: string;
    explanationEn?: string;
    legalReference?: string;
    error?: string;
  }>;
  getSubjectProgress: (subjectId: string) => SubjectPracticeProgress;
  
  // Questions & Exams CRUD
  addQuestion: (q: Omit<Question, 'id' | 'createdAt' | 'updatedAt'>) => Promise<{ success: boolean; error?: string }>;
  updateQuestion: (q: Question) => Promise<{ success: boolean; error?: string }>;
  deleteQuestion: (id: string) => Promise<{ success: boolean; error?: string }>;
  addExam: (exam: Omit<Exam, 'id' | 'createdAt'>) => Promise<{ success: boolean; exam?: Exam; error?: string }>;
  updateExam: (exam: Exam) => Promise<{ success: boolean; error?: string }>;
  toggleExamStatus: (examId: string, isActive?: boolean, scheduledDate?: string) => Promise<{ success: boolean; error?: string }>;
  generateAndSync30ModelTests: () => Promise<{ success: boolean; count: number; message: string }>;
  
  // Payment Flow
  selectedPackageForPayment: SubscriptionPackage | null;
  setSelectedPackageForPayment: (pkg: SubscriptionPackage | null) => void;
  openSubscriptionModal: (packageId?: string) => void;
  createPaymentRequest: (req: { 
    method: 'bKash' | 'Nagad' | 'Rocket'; 
    studentPhone?: string;
    senderNumber: string; 
    transactionId: string; 
    amount?: number; 
    packageId: string;
    packageTitle?: string; 
  }) => Promise<{ success: boolean; error?: string }>;
  approvePaymentRequest: (id: string) => Promise<{ success: boolean; error?: string }>;
  rejectPaymentRequest: (id: string, reason: string) => Promise<{ success: boolean; error?: string }>;
  
  // UI Modals & Auth
  isLoggedIn: boolean;
  isEmailVerified: boolean;
  isVerifiedAdmin: boolean;
  loginWithGoogle: () => Promise<{ success: boolean; error?: string }>;
  loginWithEmail: (
    email: string,
    password: string,
    isSignUp?: boolean,
    candidateName?: string
  ) => Promise<{ success: boolean; needsEmailVerification?: boolean; error?: string }>;
  resendVerificationEmail: () => Promise<{ success: boolean; error?: string }>;
  refreshVerificationStatus: () => Promise<{ verified: boolean; error?: string }>;
  sendPasswordReset: (email: string) => Promise<{ success: boolean; error?: string }>;
  getIdToken: () => Promise<string | null>;
  logoutUser: () => void;
  showLoginModal: boolean;
  setShowLoginModal: (show: boolean) => void;
  showSearchModal: boolean;
  setShowSearchModal: (show: boolean) => void;
  showInfoModal: 'about' | 'syllabus' | 'rules' | 'books' | null;
  setShowInfoModal: (modal: 'about' | 'syllabus' | 'rules' | 'books' | null) => void;
  showPaymentModal: boolean;
  setShowPaymentModal: (show: boolean) => void;
  showFirebaseGuide: boolean;
  setShowFirebaseGuide: (show: boolean) => void;
  showTestRunner: boolean;
  setShowTestRunner: (show: boolean) => void;
  isSubmittingExam: boolean;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

// Storage Keys (public UI preferences & non-sensitive local caches only)
const LOCAL_STORAGE_KEY_ATTEMPT = 'barprep_bd_active_attempt';
const LOCAL_STORAGE_KEY_RESULTS = 'barprep_bd_exam_results';
const LOCAL_STORAGE_KEY_PAYMENT_SETTINGS = 'barprep_bd_payment_settings';
const LOCAL_STORAGE_KEY_SUPPORT_SETTINGS = 'barprep_bd_support_settings';
const LOCAL_STORAGE_KEY_PACKAGES = 'barprep_bd_subscription_packages';
const LOCAL_STORAGE_KEY_EXAM_CONFIG = 'barprep_bd_exam_date_config';
const LOCAL_STORAGE_KEY_EXAMS = 'sanadprep_bd_exams';
const LOCAL_STORAGE_KEY_ANSWERED_QUESTIONS = 'sanadprep_answered_questions';
const LOCAL_STORAGE_KEY_LEADERBOARD = 'sanadprep_bd_leaderboard';
const LOCAL_STORAGE_KEY_ACTIVE_SESSION = 'sanadprep_active_session';

function readStoredActiveSession(uid: string): string | null {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY_ACTIVE_SESSION);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { uid?: string; sessionId?: string };
    if (parsed && parsed.uid === uid && typeof parsed.sessionId === 'string' && parsed.sessionId.trim()) {
      return parsed.sessionId.trim();
    }
  } catch {
    // ignore malformed localStorage state
  }
  return null;
}

function writeStoredActiveSession(uid: string, sessionId: string): void {
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY_ACTIVE_SESSION, JSON.stringify({ uid, sessionId }));
  } catch {
    // ignore storage quota failures
  }
}

function clearStoredActiveSession(): void {
  try {
    localStorage.removeItem(LOCAL_STORAGE_KEY_ACTIVE_SESSION);
  } catch {
    // ignore storage removal errors
  }
}

const createGuestUserProfile = (): UserProfile => ({
  uid: '',
  name: 'অতিথি শিক্ষার্থী (Guest)',
  email: '',
  phone: '',
  role: 'student',
  subscriptionStatus: 'free',
  createdAt: new Date().toISOString(),
});

export const AppProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [language, setLanguage] = useState<Language>('bn');
  const [currentUser, setCurrentUser] = useState<UserProfile>(createGuestUserProfile);

  const [subjects] = useState<Subject[]>(INITIAL_SUBJECTS);
  
  // Sanitized questions (hydrated cleanly from backend API or Owner Admin endpoint; never leaked from localStorage)
  const [questions, setQuestions] = useState<Question[]>(INITIAL_QUESTIONS);

  const [exams, setExams] = useState<Exam[]>(() => {
    try {
      const saved = localStorage.getItem(LOCAL_STORAGE_KEY_EXAMS);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (
          Array.isArray(parsed) &&
          parsed.length >= 30 &&
          parsed.every((e: unknown) => !!e && typeof e === 'object' && typeof (e as Exam).id === 'string' && Array.isArray((e as Exam).questionIds))
        ) {
          const test1 = parsed.find((e: Exam) => e.id === 'exam_model_test_01');
          if (test1 && test1.questionIds.length === 100) {
            return parsed.map((e: Exam) => ({
              ...e,
              isActive: e.isActive !== undefined ? e.isActive : (!e.isPaid || e.id === 'exam_model_test_01')
            }));
          }
        }
      }
    } catch (e) {}
    return INITIAL_EXAMS;
  });

  // Results
  const [examResults, setExamResults] = useState<ExamResult[]>(() => {
    try {
      const saved = localStorage.getItem(LOCAL_STORAGE_KEY_RESULTS);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (e) {}
    return [];
  });

  // Top Performers Leaderboard (real exam submissions only — never pre-seeded mock entries)
  const [leaderboardEntries, setLeaderboardEntries] = useState<LeaderboardEntry[]>(() => {
    try {
      const saved = localStorage.getItem(LOCAL_STORAGE_KEY_LEADERBOARD);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          return parsed.filter(
            (item: LeaderboardEntry) =>
              item &&
              typeof item.id === 'string' &&
              !/^lead_(farhana|mahmud|nusrat|rakib|tanvir|sadia|imran|shamima)_/.test(item.id)
          );
        }
      }
    } catch (e) {}
    return [];
  });

  // Packages (Monthly Pass, Pro Mock Pass, Exam Pass, Long Course Pass)
  const [packages, setPackages] = useState<SubscriptionPackage[]>(() => {
    try {
      const saved = localStorage.getItem(LOCAL_STORAGE_KEY_PACKAGES);
      if (saved) {
        const parsed: SubscriptionPackage[] = JSON.parse(saved);
        if (
          Array.isArray(parsed) &&
          parsed.some(p => p && p.id === 'pkg_monthly') &&
          parsed.length >= 4 &&
          parsed.every(p => p && typeof p.id === 'string' && Array.isArray(p.featuresBn) && Array.isArray(p.featuresEn))
        ) {
          return parsed;
        }
      }
    } catch (e) {}
    return INITIAL_PACKAGES;
  });

  // Exam Date Config (Target Bar Council exam date & policy)
  const [examDateConfig, setExamDateConfig] = useState<ExamDateConfig>(() => {
    try {
      const saved = localStorage.getItem(LOCAL_STORAGE_KEY_EXAM_CONFIG);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.targetExamDate) {
          return { ...INITIAL_EXAM_DATE_CONFIG, ...parsed };
        }
      }
    } catch (e) {}
    return INITIAL_EXAM_DATE_CONFIG;
  });

  // Subscriptions Ledger (Loaded strictly from Firestore for authenticated session)
  const [subscriptions, setSubscriptions] = useState<UserSubscription[]>([]);

  // Payment Settings (Configurable bKash & Nagad numbers)
  const [paymentSettings, setPaymentSettings] = useState<PaymentSettings>(() => {
    const defaults: PaymentSettings = {
      bkashNumber: '01712607777',
      nagadNumber: '01712607777',
      packagePrice: 300,
      instructionsBn: 'বিকাশ বা নগদ সেন্ড মানি (Personal) করে ট্রানজেকশন আইডি দিন।',
      instructionsEn: 'Send Money to the bKash or Nagad Personal number above and submit your TrxID.',
      whatsappNumber: '+8801671819027',
      whatsappMessage: 'Hello Sanad Prep BD Support, I need help with my account or subscription.'
    };
    try {
      const saved = localStorage.getItem(LOCAL_STORAGE_KEY_PAYMENT_SETTINGS);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return { ...defaults, ...parsed };
        }
      }
    } catch (e) {}
    return defaults;
  });

  // Support Contact Settings (Configurable WhatsApp Support)
  const [supportSettings, setSupportSettings] = useState<SupportContactSettings>(() => {
    const defaults: SupportContactSettings = {
      whatsappNumber: '+8801671819027',
      whatsappMessage: 'Hello Sanad Prep BD Support, I need help with my account or subscription.'
    };
    try {
      const saved = localStorage.getItem(LOCAL_STORAGE_KEY_SUPPORT_SETTINGS);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return { ...defaults, ...parsed };
        }
      }
    } catch (e) {}
    return defaults;
  });

  // Payments Requests (Loaded strictly from Firestore for authenticated session)
  const [paymentRequests, setPaymentRequests] = useState<PaymentRequest[]>([]);

  // Single-Active-Session State (Created only on verified Firebase login)
  const [currentSession, setCurrentSession] = useState<StudentSession | null>(null);

  const [isSessionRevoked, setIsSessionRevoked] = useState<boolean>(false);
  const [sessionRevokedReason, setSessionRevokedReason] = useState<string>('');

  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([
    {
      id: 'log_1',
      userId: 'admin_sys',
      userName: 'Sanad Prep BD System',
      action: 'SYSTEM_BOOT',
      details: 'Sanad Prep BD Production Subscription Engine initialized with 3 Packages (Pro, Long Course, Exam Pass).',
      timestamp: new Date().toISOString()
    }
  ]);

  const [activeScreen, setActiveScreen] = useState<'landing' | 'dashboard' | 'exam' | 'practice' | 'result' | 'admin' | 'tests' | 'subjects' | 'history' | 'question_bank'>('landing');
  const [showCustomTestModal, setShowCustomTestModal] = useState<boolean>(false);
  const [activeAttempt, setActiveAttempt] = useState<ExamAttempt | null>(() => {
    try {
      const saved = localStorage.getItem(LOCAL_STORAGE_KEY_ATTEMPT);
      if (saved) {
        const parsed: ExamAttempt = JSON.parse(saved);
        if (parsed && typeof parsed === 'object' && parsed.status === 'in_progress') return parsed;
      }
    } catch (e) {}
    return null;
  });

  const [activeResult, setActiveResult] = useState<ExamResult | null>(null);
  const [selectedSubjectForPractice, setSelectedSubjectForPractice] = useState<Subject | null>(null);
  const [examLaunchError, setExamLaunchError] = useState<string | null>(null);
  
  const [showPaymentModal, setShowPaymentModal] = useState<boolean>(false);
  const [selectedPackageForPayment, setSelectedPackageForPayment] = useState<SubscriptionPackage | null>(packages[0]);
  const [showFirebaseGuide, setShowFirebaseGuide] = useState<boolean>(false);
  const [showTestRunner, setShowTestRunner] = useState<boolean>(false);
  const [isSubmittingExam, setIsSubmittingExam] = useState<boolean>(false);

  const [isLoggedIn, setIsLoggedIn] = useState<boolean>(false);
  const [isEmailVerified, setIsEmailVerified] = useState<boolean>(false);
  const [isVerifiedAdmin, setIsVerifiedAdmin] = useState<boolean>(false);
  const [showLoginModal, setShowLoginModal] = useState<boolean>(false);
  const [showSearchModal, setShowSearchModal] = useState<boolean>(false);
  const [showInfoModal, setShowInfoModal] = useState<'about' | 'syllabus' | 'rules' | 'books' | null>(null);
  const paymentSubmitLockRef = useRef<boolean>(false);
  const explicitAuthInProgressRef = useRef<boolean>(false);
  const activeSyncRef = useRef<{ uid: string; promise: Promise<void> } | null>(null);
  const questionsLoadedModeRef = useRef<'none' | 'sanitized' | 'admin'>('none');
  const questionsLoadedFromApiRef = useRef<boolean>(false);
  const questionsFetchInFlightRef = useRef<{ mode: 'sanitized' | 'admin'; promise: Promise<void> } | null>(null);
  const [subjectQuestionCounts, setSubjectQuestionCounts] = useState<Record<string, number>>({});
  const [totalQuestionCount, setTotalQuestionCount] = useState<number>(0);
  const [subjectPagination, setSubjectPagination] = useState<
    Record<string, { loadedCount: number; total: number; hasMore: boolean; loading: boolean }>
  >({});
  const subjectLoadedMetaRef = useRef<
    Record<string, { nextOffset: number; total: number; hasMore: boolean; initialized: boolean }>
  >({});
  const subjectFetchInFlightRef = useRef<Map<string, Promise<void>>>(new Map());
  const [adminDashboardStats, setAdminDashboardStats] = useState<AdminDashboardStatsResponse | null>(null);
  const [adminQuestionsState, setAdminQuestionsState] = useState<AdminQuestionBankLoadState>({
    status: 'idle',
    questionCount: 0
  });
  const [adminQuestionsPageData, setAdminQuestionsPageData] = useState<{
    questions: Question[];
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
    subjectId: string;
    search: string;
    source: 'd1' | 'firestore';
  }>({
    questions: [],
    total: 0,
    limit: 50,
    offset: 0,
    hasMore: false,
    subjectId: 'all',
    search: '',
    source: 'd1'
  });
  const adminQuestionsPageDataRef = useRef(adminQuestionsPageData);
  adminQuestionsPageDataRef.current = adminQuestionsPageData;
  const adminPageRequestSeqRef = useRef<number>(0);
  const activeAttemptRef = useRef<ExamAttempt | null>(activeAttempt);
  const handleSessionRevokedRef = useRef<(reason: string) => void>(() => {});
  const examBatcherRef = useRef<ExamAnswerBatcher | null>(null);

  if (!examBatcherRef.current) {
    examBatcherRef.current = new ExamAnswerBatcher({
      saveFn: async (snapshot) => apiSaveExamAnswer(snapshot),
      debounceMs: 2500,
      maxWaitMs: 10000,
      maxRetries: 3,
      retryBaseDelayMs: 1000,
      onLockedError: ({ code, message }) => {
        if (code === 'SESSION_REVOKED') {
          handleSessionRevokedRef.current(
            message || 'একই অ্যাকাউন্ট অন্য ডিভাইস থেকে লগইন করা হয়েছে। নিরাপত্তা বিধির কারণে এই সেশনটি বন্ধ করা হয়েছে।'
          );
        } else if (code === 'ALREADY_SUBMITTED') {
          setExamLaunchError(
            message || 'এই পরীক্ষাটি ইতিমধ্যে জমা দেওয়া হয়েছে। আর উত্তর পরিবর্তন করা যাবে না।'
          );
        }
      },
      onTransientError: (err) => {
        console.warn('Exam answer batched auto-save notice:', err);
      }
    });
  }

  // Student's Answered Questions Ledger for Subject Practice Completion Progress
  const [answeredQuestions, setAnsweredQuestions] = useState<Record<string, AnsweredQuestionRecord>>(() => {
    try {
      const saved = localStorage.getItem(LOCAL_STORAGE_KEY_ANSWERED_QUESTIONS);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      }
    } catch (e) {}
    return {};
  });

  const getIdToken = async (): Promise<string | null> => {
    try {
      if (auth?.currentUser) {
        return await auth.currentUser.getIdToken();
      }
      return null;
    } catch (e) {
      return null;
    }
  };

  const updateQuestionCountsFromPool = useCallback((pool: Question[]) => {
    const counts: Record<string, number> = {};
    for (const q of pool) {
      if (q.subjectId) {
        counts[q.subjectId] = (counts[q.subjectId] || 0) + 1;
      }
    }
    setSubjectQuestionCounts(prev => ({ ...prev, ...counts }));
    setTotalQuestionCount(pool.length);
  }, []);

  const ensureQuestionsLoaded = useCallback(async (opts?: { forceReload?: boolean }) => {
    const fbUser = auth?.currentUser;
    if (!fbUser || !fbUser.emailVerified) {
      if (activeScreen === 'admin' || activeScreen === 'question_bank') {
        setAdminQuestionsState(prev => ({
          status: 'error',
          questionCount: prev.questionCount,
          httpStatus: 401,
          errorCode: 'UNAUTHORIZED',
          errorCategory: 'auth',
          errorMessage: 'অ্যাডমিন প্রশ্ন সম্ভার দেখতে যাচাইকৃত Firebase অ্যাকাউন্ট দিয়ে সাইন ইন করুন।'
        }));
      }
      return;
    }

    const isOwner = isVerifiedOwnerAccount(fbUser);
    const desiredMode: 'sanitized' | 'admin' = isOwner ? 'admin' : 'sanitized';

    if (opts?.forceReload) {
      questionsLoadedModeRef.current = 'none';
    }

    if (
      questionsLoadedModeRef.current === desiredMode ||
      (desiredMode === 'sanitized' && questionsLoadedModeRef.current === 'admin')
    ) {
      return;
    }

    if (questionsFetchInFlightRef.current?.mode === desiredMode) {
      return questionsFetchInFlightRef.current.promise;
    }

    const runFetch = async () => {
      try {
        if (isOwner) {
          setAdminQuestionsState(prev => ({
            ...prev,
            status: 'loading',
            errorMessage: undefined
          }));
          const adminQRes = await apiFetchAdminQuestions();
          const outcome = resolveAdminQuestionBankFetchOutcome(adminQRes, {
            previousQuestionCount: questionsLoadedFromApiRef.current
              ? adminQuestionsPageDataRef.current.total || totalQuestionCount
              : 0
          });
          if (outcome.ok) {
            questionsLoadedFromApiRef.current = true;
            setQuestions(outcome.questions);
            updateQuestionCountsFromPool(outcome.questions);
            questionsLoadedModeRef.current = 'admin';
            setAdminQuestionsState(outcome.state);
          } else {
            if (outcome.state.errorCode === 'SESSION_REVOKED') {
              handleSessionRevokedRef.current(outcome.state.errorMessage || 'Session revoked');
            }
            if (!questionsLoadedFromApiRef.current) {
              setQuestions([]);
            }
            questionsLoadedModeRef.current = 'none';
            setAdminQuestionsState(outcome.state);
          }
        } else {
          const qRes = await apiFetchSanitizedQuestions();
          if (qRes.ok && qRes.data?.questions?.length) {
            questionsLoadedFromApiRef.current = true;
            setQuestions(qRes.data.questions);
            updateQuestionCountsFromPool(qRes.data.questions);
            questionsLoadedModeRef.current = 'sanitized';
          }
        }
      } catch (err) {
        console.warn('Lazy question bank load notice:', err);
        if (isOwner) {
          if (!questionsLoadedFromApiRef.current) {
            setQuestions([]);
          }
          questionsLoadedModeRef.current = 'none';
          setAdminQuestionsState(prev => ({
            status: 'error',
            questionCount: questionsLoadedFromApiRef.current ? prev.questionCount : 0,
            httpStatus: 0,
            errorCode: 'NETWORK_ERROR',
            errorCategory: 'unavailable',
            errorMessage: formatBackendApiError({ status: 0, code: 'NETWORK_ERROR' })
          }));
        }
      }
    };

    const promise = runFetch().finally(() => {
      if (questionsFetchInFlightRef.current?.promise === promise) {
        questionsFetchInFlightRef.current = null;
      }
    });
    questionsFetchInFlightRef.current = { mode: desiredMode, promise };
    return promise;
  }, [activeScreen, totalQuestionCount, updateQuestionCountsFromPool]);

  const loadAdminQuestionsPage = useCallback(
    async (params?: { subjectId?: string; search?: string; limit?: number; offset?: number }) => {
      const fbUser = auth?.currentUser;
      if (!fbUser || !fbUser.emailVerified || !isVerifiedOwnerAccount(fbUser)) {
        setAdminQuestionsState(prev => ({
          status: 'error',
          questionCount: prev.questionCount,
          httpStatus: 401,
          errorCode: 'UNAUTHORIZED',
          errorCategory: 'auth',
          errorMessage: 'অ্যাডমিন প্রশ্ন সম্ভার দেখতে যাচাইকৃত Firebase অ্যাকাউন্ট দিয়ে সাইন ইন করুন।'
        }));
        return;
      }

      const current = adminQuestionsPageDataRef.current;
      const subjectId = params?.subjectId !== undefined ? params.subjectId : current.subjectId;
      const search = params?.search !== undefined ? params.search : current.search;
      const limit = params?.limit !== undefined ? params.limit : current.limit || 50;
      const offset = params?.offset !== undefined ? params.offset : current.offset;
      const reqSeq = ++adminPageRequestSeqRef.current;

      setAdminQuestionsState(prev => ({
        ...prev,
        status: 'loading',
        errorMessage: undefined
      }));

      try {
        const res = await apiFetchAdminQuestions({
          subjectId,
          search: search.trim() || undefined,
          limit,
          offset
        });
        if (reqSeq !== adminPageRequestSeqRef.current) return;

        const outcome = resolveAdminQuestionBankFetchOutcome(res, {
          previousQuestionCount: current.total
        });

        if (outcome.ok) {
          questionsLoadedFromApiRef.current = true;
          const total = outcome.total;
          const hasMore =
            typeof res.data?.hasMore === 'boolean'
              ? res.data.hasMore
              : offset + outcome.questions.length < total;
          const source = res.data?.source || 'd1';

          setAdminQuestionsPageData({
            questions: outcome.questions,
            total,
            limit,
            offset,
            hasMore,
            subjectId,
            search,
            source
          });
          setAdminQuestionsState(outcome.state);

          if ((subjectId === 'all' || !subjectId) && !search.trim()) {
            setTotalQuestionCount(total);
          }

          if (questionsLoadedModeRef.current !== 'admin' && outcome.questions.length > 0) {
            setQuestions(prev => {
              const map = new Map<string, Question>();
              prev.forEach(q => map.set(q.id, q));
              outcome.questions.forEach(q => map.set(q.id, q));
              return Array.from(map.values());
            });
          }
        } else {
          if (outcome.state.errorCode === 'SESSION_REVOKED') {
            handleSessionRevokedRef.current(outcome.state.errorMessage || 'Session revoked');
          }
          // Never wipe previously cached questions on refresh/error
          setAdminQuestionsState(outcome.state);
        }
      } catch (err) {
        if (reqSeq !== adminPageRequestSeqRef.current) return;
        console.warn('Admin D1 question page load notice:', err);
        setAdminQuestionsState({
          status: 'error',
          questionCount: current.total,
          totalCount: current.total,
          httpStatus: 0,
          errorCode: 'NETWORK_ERROR',
          errorCategory: 'unavailable',
          errorMessage: formatBackendApiError({ status: 0, code: 'NETWORK_ERROR' })
        });
      }
    },
    []
  );

  const ensureAdminQuestionPool = useCallback(async () => {
    await ensureQuestionsLoaded();
  }, [ensureQuestionsLoaded]);

  const reloadAdminQuestions = useCallback(async () => {
    questionsLoadedModeRef.current = 'none';
    const [countsRes] = await Promise.all([
      apiFetchSubjectQuestionCounts(),
      loadAdminQuestionsPage()
    ]);
    if (countsRes.ok && countsRes.data) {
      setSubjectQuestionCounts(countsRes.data.counts || {});
      setTotalQuestionCount(Number(countsRes.data.total || 0));
    }
  }, [loadAdminQuestionsPage]);

  const syncEdgeQuestionCache = useCallback(async () => {
    const res = await executeAuthoritativeAdminApi({
      isVerifiedOwner: isVerifiedOwnerAccount(auth?.currentUser),
      operation: () => apiAdminSyncQuestionCache(),
      onSessionRevoked: reason => handleSessionRevokedRef.current(reason)
    });
    if (!res.success || !res.data) {
      return {
        success: false,
        message: res.error || 'D1 Edge Cache সিঙ্ক করা যায়নি।'
      };
    }
    const { questionCount, keyCount, examsCount } = res.data;
    setTotalQuestionCount(questionCount);
    await reloadAdminQuestions();
    return {
      success: true,
      questionCount,
      keyCount,
      examsCount,
      message: `Edge Cache সিঙ্ক সম্পন্ন: ${questionCount}টি প্রশ্ন, ${keyCount}টি উত্তর কী এবং ${examsCount}টি পরীক্ষা D1-এ আপডেট হয়েছে।`
    };
  }, [reloadAdminQuestions]);

  const ensureSubjectQuestionsLoaded = useCallback(
    async (subjectId: string, opts?: { loadNextPage?: boolean }) => {
      const cleanSubjectId = subjectId.trim();
      if (!cleanSubjectId) return;

      const fbUser = auth?.currentUser;
      if (!fbUser || !fbUser.emailVerified) return;
      if (questionsLoadedModeRef.current === 'admin') return;

      const loadNext = Boolean(opts?.loadNextPage);
      const currentMeta = subjectLoadedMetaRef.current[cleanSubjectId];

      if (!loadNext && currentMeta?.initialized) {
        return;
      }
      if (loadNext && currentMeta && !currentMeta.hasMore) {
        return;
      }

      const existingPromise = subjectFetchInFlightRef.current.get(cleanSubjectId);
      if (existingPromise) {
        await existingPromise;
        if (!loadNext) return;
      }

      const offset = loadNext && currentMeta ? currentMeta.nextOffset : 0;
      const pageSize = 100;

      const runSubjectFetch = async () => {
        setSubjectPagination(prev => ({
          ...prev,
          [cleanSubjectId]: {
            loadedCount: prev[cleanSubjectId]?.loadedCount ?? offset,
            total: prev[cleanSubjectId]?.total ?? (subjectQuestionCounts[cleanSubjectId] || 0),
            hasMore: prev[cleanSubjectId]?.hasMore ?? true,
            loading: true
          }
        }));

        try {
          const qRes = await apiFetchSanitizedQuestions({
            subjectId: cleanSubjectId,
            limit: pageSize,
            offset
          });

          if (qRes.ok && qRes.data) {
            const fetched = qRes.data.questions || [];
            const total =
              typeof qRes.data.total === 'number'
                ? qRes.data.total
                : Math.max(offset + fetched.length, subjectQuestionCounts[cleanSubjectId] || 0);
            const nextOffset = offset + fetched.length;
            const hasMore =
              typeof qRes.data.hasMore === 'boolean'
                ? qRes.data.hasMore
                : nextOffset < total && fetched.length > 0;

            if (fetched.length > 0) {
              const isOwner = isVerifiedOwnerAccount(auth?.currentUser);
              setQuestions(prev => {
                const map = new Map<string, Question>();
                prev.forEach(q => map.set(q.id, q));
                fetched.forEach(sq => {
                  const existing = map.get(sq.id);
                  map.set(sq.id, existing && isOwner ? { ...sq, ...existing } : sq);
                });
                return Array.from(map.values());
              });
            }

            subjectLoadedMetaRef.current[cleanSubjectId] = {
              nextOffset,
              total,
              hasMore,
              initialized: true
            };

            setSubjectQuestionCounts(prev => {
              const nextCounts = { ...prev, [cleanSubjectId]: total };
              const summed = Object.values(nextCounts).reduce((acc, n) => acc + n, 0);
              setTotalQuestionCount(prevTotal => Math.max(prevTotal, summed));
              return nextCounts;
            });

            setSubjectPagination(prev => ({
              ...prev,
              [cleanSubjectId]: {
                loadedCount: nextOffset,
                total,
                hasMore,
                loading: false
              }
            }));
          } else {
            setSubjectPagination(prev => ({
              ...prev,
              [cleanSubjectId]: {
                loadedCount: prev[cleanSubjectId]?.loadedCount ?? offset,
                total: prev[cleanSubjectId]?.total ?? (subjectQuestionCounts[cleanSubjectId] || 0),
                hasMore: false,
                loading: false
              }
            }));
          }
        } catch (err) {
          console.warn('Subject question page load notice:', err);
          setSubjectPagination(prev => ({
            ...prev,
            [cleanSubjectId]: {
              loadedCount: prev[cleanSubjectId]?.loadedCount ?? offset,
              total: prev[cleanSubjectId]?.total ?? (subjectQuestionCounts[cleanSubjectId] || 0),
              hasMore: prev[cleanSubjectId]?.hasMore ?? false,
              loading: false
            }
          }));
        }
      };

      const promise = runSubjectFetch().finally(() => {
        if (subjectFetchInFlightRef.current.get(cleanSubjectId) === promise) {
          subjectFetchInFlightRef.current.delete(cleanSubjectId);
        }
      });
      subjectFetchInFlightRef.current.set(cleanSubjectId, promise);
      return promise;
    },
    [subjectQuestionCounts]
  );

  const loadMoreSubjectQuestions = useCallback(
    async (subjectId: string) => {
      await ensureSubjectQuestionsLoaded(subjectId, { loadNextPage: true });
    },
    [ensureSubjectQuestionsLoaded]
  );

  const getSubjectLoadState = useCallback(
    (subjectId: string) => {
      const pag = subjectPagination[subjectId];
      if (pag) return pag;
      const loaded = questions.filter(q => q.subjectId === subjectId).length;
      const total = Math.max(loaded, subjectQuestionCounts[subjectId] || 0);
      return {
        loadedCount: loaded,
        total,
        hasMore: total > loaded && questionsLoadedModeRef.current !== 'admin',
        loading: false
      };
    },
    [subjectPagination, questions, subjectQuestionCounts]
  );

  const syncAuthenticatedUserData = useCallback(
    async (
      fbUser: { uid: string; email?: string | null; displayName?: string | null },
      isAdmin: boolean,
      opts?: { forceNewSession?: boolean }
    ) => {
      const uid = fbUser.uid;
      if (!opts?.forceNewSession && activeSyncRef.current?.uid === uid) {
        return activeSyncRef.current.promise;
      }

      const runSync = async () => {
        const isOwner = isVerifiedOwnerAccount(fbUser);
        const isProdEnv = typeof import.meta !== 'undefined' && Boolean(import.meta.env?.PROD);

        try {
          // 1. Validate existing session on page reload OR establish a fresh single-device session on explicit login
          let activeSessData: {
            session: StudentSession;
            sessionId: string;
            activeSubscription: UserSubscription | null;
          } | null = null;
          const storedSessionId = !opts?.forceNewSession ? readStoredActiveSession(uid) : null;

          if (storedSessionId) {
            setApiSessionId(storedSessionId);
            const statusRes = await apiCheckSessionStatus();
            if (statusRes.ok && statusRes.data?.active && statusRes.data.session) {
              activeSessData = {
                sessionId: storedSessionId,
                session: statusRes.data.session,
                activeSubscription: statusRes.data.activeSubscription ?? null
              };
            } else if (statusRes.code === 'SESSION_REVOKED') {
              setApiSessionId(null);
              clearStoredActiveSession();
              setCurrentSession(null);
              setIsSessionRevoked(true);
              setSessionRevokedReason(
                statusRes.message ||
                  'একই অ্যাকাউন্ট অন্য ডিভাইস থেকে লগইন করা হয়েছে। নিরাপত্তা বিধির কারণে এই সেশনটি বন্ধ করা হয়েছে।'
              );
              return;
            } else if (statusRes.code === 'SESSION_REQUIRED') {
              setApiSessionId(null);
              clearStoredActiveSession();
              const recreated = await apiCreateSession(
                fbUser.displayName || undefined,
                typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 80) : 'Web Browser'
              );
              if (recreated.ok && recreated.data) {
                activeSessData = {
                  sessionId: recreated.data.sessionId,
                  session: recreated.data.session,
                  activeSubscription: recreated.data.activeSubscription ?? null
                };
              }
            } else {
              // Fail closed on backend/network unavailability without clobbering another active device
              setApiSessionId(null);
              setCurrentSession(null);
              return;
            }
          } else {
            const sessionRes = await apiCreateSession(
              fbUser.displayName || undefined,
              typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 80) : 'Web Browser'
            );
            if (sessionRes.ok && sessionRes.data) {
              activeSessData = {
                sessionId: sessionRes.data.sessionId,
                session: sessionRes.data.session,
                activeSubscription: sessionRes.data.activeSubscription ?? null
              };
            } else {
              setApiSessionId(null);
              clearStoredActiveSession();
              setCurrentSession(null);
              return;
            }
          }

          if (!activeSessData) {
            setApiSessionId(null);
            setCurrentSession(null);
            return;
          }

          setCurrentSession(activeSessData.session);
          setApiSessionId(activeSessData.sessionId);
          writeStoredActiveSession(uid, activeSessData.sessionId);
          setIsSessionRevoked(false);
          setSessionRevokedReason('');

          // 2. Fetch payments, subscriptions (owner ledger or student active subscription from session),
          //    exam results, exams, and Owner-only dashboard stats/audit logs via authoritative backend APIs.
          //    The 3,000-question bank is lazy-loaded only when needed.
          const [
            apiPaymentsRes,
            apiSubsRes,
            apiResultsRes,
            apiExamsRes,
            apiAdminStatsRes,
            apiAdminAuditRes
          ] = await Promise.all([
            apiFetchPaymentRequests(),
            isOwner ? apiAdminFetchSubscriptions() : Promise.resolve(null),
            apiFetchExamResults(uid),
            apiFetchExams(),
            isOwner ? apiAdminFetchDashboardStats() : Promise.resolve(null),
            isOwner ? apiAdminFetchAuditLogs() : Promise.resolve(null)
          ]);

          const mergedPayments = apiPaymentsRes.ok
            ? apiPaymentsRes.data?.paymentRequests || []
            : (!isProdEnv ? await fetchPaymentRequestsFromFirestore(uid, isAdmin) : []);
          mergedPayments.sort(
            (a, b) => new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime()
          );
          setPaymentRequests(mergedPayments);

          const mergedSubs: UserSubscription[] = isOwner
            ? (apiSubsRes?.ok
                ? apiSubsRes.data?.subscriptions || []
                : (!isProdEnv ? await fetchSubscriptionsFromFirestore(uid, isAdmin) : []))
            : (activeSessData.activeSubscription ? [activeSessData.activeSubscription] : []);
          setSubscriptions(mergedSubs);

          const mergedResults = apiResultsRes.ok
            ? apiResultsRes.data?.results || []
            : (!isProdEnv ? await fetchExamResultsFromFirestore(uid, isAdmin) : []);
          mergedResults.sort(
            (a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()
          );
          setExamResults(mergedResults);

          if (isOwner) {
            if (apiAdminStatsRes?.ok && apiAdminStatsRes.data) {
              setAdminDashboardStats(apiAdminStatsRes.data);
            }
            if (apiAdminAuditRes?.ok && apiAdminAuditRes.data?.auditLogs?.length) {
              const serverLogs = apiAdminAuditRes.data.auditLogs;
              setAuditLogs(prev => {
                const map = new Map<string, AuditLog>();
                serverLogs.forEach(item => map.set(item.id, item));
                prev.forEach(item => {
                  if (!map.has(item.id)) map.set(item.id, item);
                });
                return Array.from(map.values())
                  .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
                  .slice(0, 200);
              });
            }
          } else {
            setAdminDashboardStats(null);
          }

          const hasActiveSub = mergedSubs.some(
            s => s.userId === uid && s.status === 'active' && new Date(s.expiresAt).getTime() > Date.now()
          );
          if (hasActiveSub) {
            setCurrentUser(prev => ({ ...prev, subscriptionStatus: 'pro' }));
          }

          const examSource =
            apiExamsRes.ok && apiExamsRes.data?.exams?.length
              ? apiExamsRes.data.exams
              : (!isProdEnv ? await fetchExamsFromFirestore(hasActiveSub || isAdmin) : []);
          if (examSource && examSource.length > 0) {
            setExams(prev => {
              const map = new Map<string, Exam>();
              examSource.forEach(e => map.set(e.id, e));
              prev.forEach(e => {
                if (!map.has(e.id)) map.set(e.id, e);
              });
              return Array.from(map.values());
            });
          }
        } catch (err) {
          console.warn('Post-login sync notice:', err);
        }
      };

      const promise = runSync().finally(() => {
        if (activeSyncRef.current?.promise === promise) {
          activeSyncRef.current = null;
        }
      });
      activeSyncRef.current = { uid, promise };
      return promise;
    },
    []
  );

  const loginWithEmail = async (
    email: string,
    password: string,
    isSignUp = false,
    candidateName?: string
  ): Promise<{ success: boolean; needsEmailVerification?: boolean; error?: string }> => {
    explicitAuthInProgressRef.current = true;
    try {
      if (!auth) {
        return { success: false, error: 'Firebase Authentication is not available.' };
      }
      const trimmedEmail = email.trim().toLowerCase();
      const userCredential = isSignUp
        ? await createUserWithEmailAndPassword(auth, trimmedEmail, password)
        : await signInWithEmailAndPassword(auth, trimmedEmail, password);
      const fbUser = userCredential.user;
      if (isSignUp && !fbUser.emailVerified) {
        await sendEmailVerification(fbUser).catch(err => console.warn('Send email verification notice:', err));
      }

      const uid = fbUser.uid;
      const resolvedEmail = fbUser.email || trimmedEmail;
      const isOwner = isVerifiedOwnerAccount(fbUser);
      const isAdmin = isOwner;
      const resolvedName = fbUser.displayName || candidateName || (isOwner ? 'মো: খাইরুল আলম' : 'শিক্ষার্থী');

      let existingProfile: UserProfile;
      if (fbUser.emailVerified || isOwner) {
        const initRes = await ensureUserProfileInitialized({
          authUser: fbUser,
          candidateName: resolvedName,
          fetchProfileStatus: fetchUserProfileStatusFromFirestore,
          createProfile: async (docData) => {
            await saveUserProfileToFirestore(docData);
          },
          updateOwnerRole: (targetUid) => updateUserRoleOrSubscriptionInFirestore(targetUid, { role: 'admin' })
        });

        if (!initRes.ok) {
          await signOut(auth).catch(() => undefined);
          setApiSessionId(null);
          clearStoredActiveSession();
          return {
            success: false,
            error:
              language === 'bn'
                ? 'অ্যাকাউন্ট প্রোফাইল তৈরি বা যাচাই করতে ব্যর্থ হয়েছে। অনুগ্রহ করে আবার চেষ্টা করুন।'
                : `Failed to initialize user profile: ${initRes.error}`
          };
        }
        existingProfile = initRes.profile;
      } else {
        existingProfile = {
          uid,
          name: resolvedName,
          email: resolvedEmail,
          phone: fbUser.phoneNumber || '',
          role: 'student',
          subscriptionStatus: 'free',
          createdAt: new Date().toISOString()
        };
      }

      setIsEmailVerified(Boolean(fbUser.emailVerified));
      setIsVerifiedAdmin(isAdmin);
      setCurrentUser(existingProfile);
      setIsLoggedIn(true);
      setExamLaunchError(null);

      if (!fbUser.emailVerified) {
        setApiSessionId(null);
        clearStoredActiveSession();
        setCurrentSession(null);
        return { success: true, needsEmailVerification: true };
      }

      await syncAuthenticatedUserData(fbUser, isAdmin, { forceNewSession: true });

      if (isAdmin) {
        setActiveScreen('admin');
      } else {
        setActiveScreen('dashboard');
      }
      return { success: true };
    } catch (err: any) {
      console.error('Email Authentication failed:', err);
      let errMsg = err?.message || 'Authentication failed';
      if (err?.code === 'auth/wrong-password' || err?.code === 'auth/invalid-credential') {
        errMsg = language === 'bn' ? 'ভুল পাসওয়ার্ড অথবা ইমেইল। সঠিক তথ্য প্রদান করুন।' : 'Invalid email or password.';
      } else if (err?.code === 'auth/user-not-found') {
        errMsg = language === 'bn' ? 'এই ইমেইল দিয়ে কোনো অ্যাকাউন্ট খুঁজে পাওয়া যায়নি। সাইন আপ করুন।' : 'No account found with this email. Please sign up.';
      } else if (err?.code === 'auth/email-already-in-use') {
        errMsg = language === 'bn' ? 'এই ইমেইলটি ইতিপূর্বে নিবন্ধিত হয়েছে। অনুগ্রহ করে লগইন করুন।' : 'This email is already in use. Please sign in.';
      } else if (err?.code === 'auth/weak-password') {
        errMsg = language === 'bn' ? 'পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে।' : 'Password should be at least 6 characters.';
      }
      return { success: false, error: errMsg };
    } finally {
      explicitAuthInProgressRef.current = false;
    }
  };

  const resendVerificationEmail = async (): Promise<{ success: boolean; error?: string }> => {
    try {
      if (!auth?.currentUser) {
        return { success: false, error: 'অ্যাকাউন্টে লগইন করা নেই।' };
      }
      await sendEmailVerification(auth.currentUser);
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : 'Verification email failed' };
    }
  };

  const refreshVerificationStatus = async (): Promise<{ verified: boolean; error?: string }> => {
    try {
      if (!auth?.currentUser) {
        return { verified: false, error: 'অ্যাকাউন্টে লগইন করা নেই।' };
      }
      await reload(auth.currentUser);
      const verified = Boolean(auth.currentUser.emailVerified);
      setIsEmailVerified(verified);
      if (verified) {
        const fbUser = auth.currentUser;
        const isOwner = isVerifiedOwnerAccount(fbUser);
        setIsVerifiedAdmin(isOwner);
        await fbUser.getIdToken(true);

        const initRes = await ensureUserProfileInitialized({
          authUser: fbUser,
          candidateName: currentUser.name || fbUser.displayName || undefined,
          fetchProfileStatus: fetchUserProfileStatusFromFirestore,
          createProfile: async (docData) => {
            await saveUserProfileToFirestore(docData);
          },
          updateOwnerRole: (targetUid) => updateUserRoleOrSubscriptionInFirestore(targetUid, { role: 'admin' })
        });

        if (!initRes.ok) {
          return {
            verified: true,
            error:
              language === 'bn'
                ? 'ইমেইল ভেরিফাই হয়েছে, কিন্তু প্রোফাইল সংরক্ষণ করা যায়নি। পুনরায় চেষ্টা করুন।'
                : `Email verified, but profile initialization failed: ${initRes.error}`
          };
        }

        setCurrentUser(initRes.profile);
        setExamLaunchError(null);
        await syncAuthenticatedUserData(fbUser, isOwner, { forceNewSession: true });
        setActiveScreen(isOwner ? 'admin' : 'dashboard');
      }
      return { verified };
    } catch (err: unknown) {
      return { verified: false, error: err instanceof Error ? err.message : 'Status check failed' };
    }
  };

  const sendPasswordReset = async (email: string): Promise<{ success: boolean; error?: string }> => {
    try {
      if (!auth) {
        return { success: false, error: 'Firebase Authentication is not available.' };
      }
      await sendPasswordResetEmail(auth, email.trim().toLowerCase());
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : 'Password reset failed' };
    }
  };

  const loginWithGoogle = async (): Promise<{ success: boolean; error?: string }> => {
    explicitAuthInProgressRef.current = true;
    try {
      if (!auth || !googleProvider) {
        return { success: false, error: 'Firebase Authentication is not available.' };
      }
      const result = await signInWithPopup(auth, googleProvider);
      const fbUser = result.user;
      const isOwner = isVerifiedOwnerAccount(fbUser);
      const isAdmin = isOwner;

      const initRes = await ensureUserProfileInitialized({
        authUser: fbUser,
        candidateName: fbUser.displayName || 'ব্যবহারকারী',
        fetchProfileStatus: fetchUserProfileStatusFromFirestore,
        createProfile: async (docData) => {
          await saveUserProfileToFirestore(docData);
        },
        updateOwnerRole: (targetUid) => updateUserRoleOrSubscriptionInFirestore(targetUid, { role: 'admin' })
      });

      if (!initRes.ok) {
        await signOut(auth).catch(() => undefined);
        setApiSessionId(null);
        clearStoredActiveSession();
        return {
          success: false,
          error:
            language === 'bn'
              ? 'গুগল সাইন-ইনের পর প্রোফাইল সংরক্ষণ করা যায়নি। অনুগ্রহ করে আবার চেষ্টা করুন।'
              : `Google profile initialization failed: ${initRes.error}`
        };
      }

      setIsEmailVerified(Boolean(fbUser.emailVerified));
      setIsVerifiedAdmin(isAdmin);
      setCurrentUser(initRes.profile);
      setIsLoggedIn(true);
      setExamLaunchError(null);

      await syncAuthenticatedUserData(fbUser, isAdmin, { forceNewSession: true });

      if (isAdmin) {
        setActiveScreen('admin');
      } else {
        setActiveScreen('dashboard');
      }
      return { success: true };
    } catch (err: any) {
      console.error('Google Sign-In failed:', err);
      return { success: false, error: err?.message || 'Google Sign-In failed' };
    } finally {
      explicitAuthInProgressRef.current = false;
    }
  };

  const logoutUser = async () => {
    const activeSessionId = currentSession?.sessionId || (currentUser.uid ? readStoredActiveSession(currentUser.uid) : null);
    let capturedToken: string | null = null;
    if (auth?.currentUser && activeSessionId) {
      try {
        capturedToken = await auth.currentUser.getIdToken();
      } catch {
        capturedToken = null;
      }
    }

    examBatcherRef.current?.reset();
    activeAttemptRef.current = null;
    setApiSessionId(null);
    clearStoredActiveSession();
    setIsSessionRevoked(false);
    setSessionRevokedReason('');
    setIsLoggedIn(false);
    setIsEmailVerified(false);
    setIsVerifiedAdmin(false);
    setCurrentUser(createGuestUserProfile());
    questionsLoadedModeRef.current = 'none';
    questionsFetchInFlightRef.current = null;
    subjectLoadedMetaRef.current = {};
    subjectFetchInFlightRef.current.clear();
    setSubjectPagination({});
    setAdminDashboardStats(null);
    setAdminQuestionsState({ status: 'idle', questionCount: 0 });
    setQuestions(INITIAL_QUESTIONS);
    setSubscriptions([]);
    setPaymentRequests([]);
    setExamResults([]);
    setAnsweredQuestions({});
    setCurrentSession(null);
    setActiveAttempt(null);
    setActiveScreen('landing');
    try {
      localStorage.removeItem('sanadprep_is_logged_in');
      localStorage.removeItem(LOCAL_STORAGE_KEY_RESULTS);
      localStorage.removeItem(LOCAL_STORAGE_KEY_ATTEMPT);
      localStorage.removeItem(LOCAL_STORAGE_KEY_ANSWERED_QUESTIONS);
      localStorage.removeItem('barprep_bd_custom_questions');
      localStorage.removeItem('barprep_bd_payment_requests');
      localStorage.removeItem('barprep_bd_user_subscriptions');
      localStorage.removeItem('barprep_bd_current_session');
      localStorage.removeItem('sanadprep_previous_questions');
    } catch (e) {}

    if (capturedToken && activeSessionId) {
      apiLogoutSession({ token: capturedToken, sessionId: activeSessionId }).catch(err =>
        console.warn('Server logout notice:', err)
      );
    }
    if (auth) {
      signOut(auth).catch(e => console.warn('Firebase sign out notice:', e));
    }
  };

  // Firebase Auth State Listener (Auto-restores session on page reload / navigation)
  useEffect(() => {
    if (!auth) return;
    const unsubscribe = onAuthStateChanged(auth, async (fbUser) => {
      if (fbUser) {
        if (explicitAuthInProgressRef.current) {
          return;
        }
        const uid = fbUser.uid;
        const email = fbUser.email || '';
        const name = fbUser.displayName || 'ব্যবহারকারী';
        const phone = fbUser.phoneNumber || '';

        const verified = Boolean(fbUser.emailVerified);
        const isOwner = isVerifiedOwnerAccount(fbUser);
        const isAdmin = isOwner;

        setIsEmailVerified(verified);
        setIsVerifiedAdmin(isAdmin);

        if (!verified && !isOwner) {
          setCurrentUser({
            uid,
            name,
            email,
            phone,
            role: 'student',
            subscriptionStatus: 'free',
            createdAt: new Date().toISOString()
          });
          setIsLoggedIn(true);
          setApiSessionId(null);
          clearStoredActiveSession();
          setCurrentSession(null);
          return;
        }

        const initRes = await ensureUserProfileInitialized({
          authUser: fbUser,
          candidateName: name,
          fetchProfileStatus: fetchUserProfileStatusFromFirestore,
          createProfile: async (docData) => {
            await saveUserProfileToFirestore(docData);
          },
          updateOwnerRole: (targetUid) => updateUserRoleOrSubscriptionInFirestore(targetUid, { role: 'admin' })
        });

        if (!initRes.ok) {
          console.error('Auth restore profile initialization error:', initRes.error);
          setExamLaunchError(
            language === 'bn'
              ? 'প্রোফাইল তথ্য লোড বা তৈরি করা যায়নি। অনুগ্রহ করে পেজ রিলোড করে পুনরায় চেষ্টা করুন।'
              : 'Failed to load or initialize your user profile. Please refresh and try again.'
          );
          setCurrentUser({
            uid,
            name,
            email,
            phone,
            role: 'student',
            subscriptionStatus: 'free',
            createdAt: new Date().toISOString()
          });
          setIsVerifiedAdmin(false);
          setIsLoggedIn(false);
          setApiSessionId(null);
          clearStoredActiveSession();
          setCurrentSession(null);
          return;
        }

        setCurrentUser(initRes.profile);
        setExamLaunchError(null);
        setIsLoggedIn(true);
        await syncAuthenticatedUserData(fbUser, isAdmin, { forceNewSession: false });
      } else {
        examBatcherRef.current?.reset();
        activeAttemptRef.current = null;
        setApiSessionId(null);
        clearStoredActiveSession();
        setIsSessionRevoked(false);
        setSessionRevokedReason('');
        setIsLoggedIn(false);
        setIsEmailVerified(false);
        setIsVerifiedAdmin(false);
        setCurrentUser(createGuestUserProfile());
        questionsLoadedModeRef.current = 'none';
        questionsLoadedFromApiRef.current = false;
        questionsFetchInFlightRef.current = null;
        subjectLoadedMetaRef.current = {};
        subjectFetchInFlightRef.current.clear();
        setSubjectPagination({});
        setAdminDashboardStats(null);
        setAdminQuestionsState({ status: 'idle', questionCount: 0 });
        setAdminQuestionsPageData({
          questions: [],
          total: 0,
          limit: 50,
          offset: 0,
          hasMore: false,
          subjectId: 'all',
          search: '',
          source: 'd1'
        });
        setQuestions(INITIAL_QUESTIONS);
        setSubscriptions([]);
        setPaymentRequests([]);
        setExamResults([]);
        setAnsweredQuestions({});
        setActiveAttempt(null);
        setCurrentSession(null);
        setActiveScreen(prev => (prev === 'admin' || prev === 'question_bank') ? 'landing' : prev);
        try {
          localStorage.removeItem('sanadprep_is_logged_in');
          localStorage.removeItem(LOCAL_STORAGE_KEY_RESULTS);
          localStorage.removeItem(LOCAL_STORAGE_KEY_ATTEMPT);
          localStorage.removeItem(LOCAL_STORAGE_KEY_ANSWERED_QUESTIONS);
          localStorage.removeItem('barprep_bd_payment_requests');
          localStorage.removeItem('barprep_bd_user_subscriptions');
          localStorage.removeItem('barprep_bd_current_session');
          localStorage.removeItem('barprep_bd_custom_questions');
          localStorage.removeItem('sanadprep_previous_questions');
        } catch (e) {}
      }
    });

    return () => unsubscribe();
  }, [language, syncAuthenticatedUserData]);

  // Lazy-load paginated D1 questions for Owner Admin views, full D1 pool for QuestionBankView, or subject slice for Practice
  useEffect(() => {
    if (!isLoggedIn || !isEmailVerified || isSessionRevoked || !currentSession) return;
    if (activeScreen === 'admin') {
      if (isVerifiedOwnerAccount(auth?.currentUser)) {
        void loadAdminQuestionsPage();
      }
    } else if (activeScreen === 'question_bank') {
      if (isVerifiedOwnerAccount(auth?.currentUser)) {
        void ensureQuestionsLoaded();
      }
    } else if (activeScreen === 'practice' && selectedSubjectForPractice) {
      void ensureSubjectQuestionsLoaded(selectedSubjectForPractice.id);
    }
  }, [
    isLoggedIn,
    isEmailVerified,
    isSessionRevoked,
    currentSession,
    activeScreen,
    selectedSubjectForPractice,
    loadAdminQuestionsPage,
    ensureQuestionsLoaded,
    ensureSubjectQuestionsLoaded
  ]);

  // Synchronize public catalog & subject question counts with Backend API & Firestore on Mount
  useEffect(() => {
    let isMounted = true;
    async function loadDatabaseData() {
      try {
        const [
          [examsRes, packagesRes, configRes, paySettingsRes, _subjectsRes, leaderboardRes],
          subjectCountsRes
        ] = await Promise.all([
          apiFetchPublicCatalog(),
          apiFetchSubjectQuestionCounts()
        ]);

        if (isMounted && subjectCountsRes.ok && subjectCountsRes.data) {
          setSubjectQuestionCounts(subjectCountsRes.data.counts || {});
          setTotalQuestionCount(Number(subjectCountsRes.data.total || 0));
        }

        if (isMounted && examsRes.ok && examsRes.data?.exams?.length) {
          setExams(examsRes.data.exams);
        } else {
          const dbExams = await fetchExamsFromFirestore(false);
          if (isMounted && dbExams && dbExams.length > 0) {
            setExams(dbExams);
          }
        }

        if (isMounted && packagesRes.ok && packagesRes.data?.packages?.length) {
          setPackages(packagesRes.data.packages);
        }
        if (isMounted && configRes.ok && configRes.data?.examDateConfig) {
          setExamDateConfig(configRes.data.examDateConfig);
        }
        if (isMounted && paySettingsRes.ok && paySettingsRes.data) {
          if (paySettingsRes.data.paymentSettings) setPaymentSettings(paySettingsRes.data.paymentSettings);
          if (paySettingsRes.data.supportSettings) setSupportSettings(paySettingsRes.data.supportSettings);
        }

        const apiLeaderboard = leaderboardRes.ok
          ? leaderboardRes.data?.leaderboard || []
          : await fetchLeaderboardFromFirestore();
        if (isMounted && apiLeaderboard.length > 0) {
          setLeaderboardEntries(prev => {
            const map = new Map<string, LeaderboardEntry>();
            prev.forEach(item => map.set(item.id, item));
            apiLeaderboard.forEach(item => map.set(item.id, item));
            const merged = Array.from(map.values());
            merged.sort((a, b) => b.score - a.score || a.timeSpentSeconds - b.timeSpentSeconds);
            return merged.map((e, idx) => ({ ...e, rank: idx + 1 }));
          });
        }
      } catch (err) {
        console.warn('Initial catalog sync notice:', err);
      }
    }

    loadDatabaseData();
    return () => { isMounted = false; };
  }, []);

  // Sync non-sensitive UI preferences & catalog to Storage (never store answer keys, payments, or subscriptions in localStorage)
  useEffect(() => {
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY_RESULTS, JSON.stringify(examResults));
    } catch (e) {}
  }, [examResults]);

  useEffect(() => {
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY_LEADERBOARD, JSON.stringify(leaderboardEntries));
    } catch (e) {}
  }, [leaderboardEntries]);

  useEffect(() => {
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY_PACKAGES, JSON.stringify(packages));
    } catch (e) {}
  }, [packages]);

  useEffect(() => {
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY_EXAM_CONFIG, JSON.stringify(examDateConfig));
    } catch (e) {}
  }, [examDateConfig]);

  useEffect(() => {
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY_PAYMENT_SETTINGS, JSON.stringify(paymentSettings));
    } catch (e) {}
  }, [paymentSettings]);

  useEffect(() => {
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY_SUPPORT_SETTINGS, JSON.stringify(supportSettings));
    } catch (e) {}
  }, [supportSettings]);

  useEffect(() => {
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY_EXAMS, JSON.stringify(exams));
    } catch (e) {}
  }, [exams]);

  useEffect(() => {
    if (activeAttempt) {
      try {
        localStorage.setItem(LOCAL_STORAGE_KEY_ATTEMPT, JSON.stringify(activeAttempt));
      } catch (e) {}
    } else {
      try {
        localStorage.removeItem(LOCAL_STORAGE_KEY_ATTEMPT);
      } catch (e) {}
    }
  }, [activeAttempt]);

  useEffect(() => {
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY_ANSWERED_QUESTIONS, JSON.stringify(answeredQuestions));
    } catch (e) {}
  }, [answeredQuestions]);

  // Derive Active Subscription for Current User
  const activeSubscription = (isLoggedIn && currentUser.uid)
    ? (subscriptions.find(
        s => s.userId === currentUser.uid && s.status === 'active' && !!s.expiresAt && new Date(s.expiresAt).getTime() > Date.now()
      ) || null)
    : null;

  // Keep currentUser.subscriptionStatus synced with real subscription
  useEffect(() => {
    if (!isLoggedIn || !currentUser.uid) return;
    if (activeSubscription) {
      setCurrentUser(prev => ({
        ...prev,
        subscriptionStatus: 'pro',
        subscriptionExpiresAt: activeSubscription.expiresAt,
        activePackageId: activeSubscription.packageId,
        activePackageNameBn: activeSubscription.packageNameBn,
        activePackageNameEn: activeSubscription.packageNameEn
      }));
    } else {
      const userSubs = subscriptions.filter(s => s.userId === currentUser.uid);
      const isPastExpired = userSubs.some(s => s.status === 'expired' || (!!s.expiresAt && new Date(s.expiresAt).getTime() <= Date.now()));
      setCurrentUser(prev => {
        const nextStatus = isPastExpired
          ? 'expired'
          : (prev.subscriptionStatus === 'pro' && (!prev.subscriptionExpiresAt || new Date(prev.subscriptionExpiresAt).getTime() <= Date.now()) ? 'expired' : (prev.subscriptionStatus === 'pro' ? 'pro' : 'free'));
        if (prev.subscriptionStatus !== nextStatus || (nextStatus !== 'pro' && prev.subscriptionExpiresAt !== undefined)) {
          return {
            ...prev,
            subscriptionStatus: nextStatus,
            subscriptionExpiresAt: nextStatus === 'pro' ? prev.subscriptionExpiresAt : undefined,
            activePackageId: nextStatus === 'pro' ? prev.activePackageId : undefined,
            activePackageNameBn: nextStatus === 'pro' ? prev.activePackageNameBn : undefined,
            activePackageNameEn: nextStatus === 'pro' ? prev.activePackageNameEn : undefined
          };
        }
        return prev;
      });
    }
  }, [activeSubscription, subscriptions, currentUser.uid, isLoggedIn]);

  // Helper to calculate remaining days
  const calculateDaysRemaining = (expiresAt?: string): number => {
    if (!expiresAt) return 0;
    const diff = new Date(expiresAt).getTime() - Date.now();
    return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
  };

  // Check if current user has active Pro access (Verified Owner Admin OR Active Paid Subscription with valid future expiry)
  const isOwnerAuthenticated = isLoggedIn && isVerifiedAdmin && isVerifiedOwnerAccount(auth?.currentUser);
  const isProSubscribed = isOwnerAuthenticated || (isLoggedIn && !!currentUser.uid && (
    (currentUser.subscriptionStatus === 'pro' && !!currentUser.subscriptionExpiresAt && new Date(currentUser.subscriptionExpiresAt).getTime() > Date.now()) ||
    (!!activeSubscription && !!activeSubscription.expiresAt && new Date(activeSubscription.expiresAt).getTime() > Date.now())
  ));

  // Refresh leaderboard from Backend API (Firestore fallback only if backend unavailable)
  const refreshLeaderboard = async () => {
    try {
      const apiRes = await apiFetchLeaderboard();
      const combined = apiRes.ok ? apiRes.data?.leaderboard || [] : await fetchLeaderboardFromFirestore();
      if (combined.length > 0) {
        setLeaderboardEntries(prev => {
          const map = new Map<string, LeaderboardEntry>();
          prev.forEach(item => map.set(item.id, item));
          combined.forEach(item => map.set(item.id, item));
          const merged = Array.from(map.values());
          merged.sort((a, b) => b.score - a.score || a.timeSpentSeconds - b.timeSpentSeconds);
          return merged.map((e, idx) => ({ ...e, rank: idx + 1 }));
        });
      }
    } catch (e) {
      console.warn('Leaderboard refresh error:', e);
    }
  };

  const toggleLanguage = () => {
    setLanguage(prev => (prev === 'bn' ? 'en' : 'bn'));
  };

  const t = (bnText: string, enText: string) => {
    return language === 'bn' ? bnText : enText;
  };

  const switchRole = (role: UserRole) => {
    if ((role === 'admin' || role === 'question_manager') && !isVerifiedOwnerAccount(auth?.currentUser)) {
      console.warn('Unauthorized role switch attempt prevented: verified owner UID only.');
      return;
    }
    setCurrentUser(prev => ({ ...prev, role }));
  };

  const updateUserProfile = (data: Partial<UserProfile>) => {
    // Strip protected fields from client-side profile updates
    const { role: _r, subscriptionStatus: _s, subscriptionExpiresAt: _e, uid: _u, ...safeData } = data;
    setCurrentUser(prev => ({ ...prev, ...safeData }));
  };

  // Open subscription modal with specific package pre-selected
  const openSubscriptionModal = (packageId?: string) => {
    if (packageId) {
      const target = packages.find(p => p.id === packageId);
      if (target) {
        setSelectedPackageForPayment(target);
      }
    }
    setShowPaymentModal(true);
  };

  const handleAdminUnauthorized = () => setShowLoginModal(true);
  const handleAdminSessionRevoked = useCallback((reason: string) => {
    examBatcherRef.current?.reset();
    setApiSessionId(null);
    clearStoredActiveSession();
    setCurrentSession(null);
    setIsSessionRevoked(true);
    setSessionRevokedReason(reason);
  }, []);
  handleSessionRevokedRef.current = handleAdminSessionRevoked;

  // Update Package (Verified Owner Admin only — Authoritative Backend API)
  const updatePackage = async (
    updated: Partial<SubscriptionPackage> & { id: string }
  ): Promise<{ success: boolean; error?: string }> => {
    const res = await executeAuthoritativeAdminApi({
      isVerifiedOwner: isVerifiedOwnerAccount(auth?.currentUser),
      operation: () => apiAdminUpdatePackage(updated),
      onUnauthorized: handleAdminUnauthorized,
      onSessionRevoked: handleAdminSessionRevoked
    });

    if (!res.success || !res.data?.package) {
      return { success: false, error: res.error || 'প্যাকেজ আপডেট করা যায়নি।' };
    }

    const savedPkg = res.data.package;
    setPackages(prev => prev.map(p => (p.id === savedPkg.id ? savedPkg : p)));

    if (savedPkg.id === 'pkg_exam_pass') {
      setExamDateConfig(prev => ({ ...prev, examPassPrice: Number(savedPkg.price) }));
    }

    setAuditLogs(prev => [
      {
        id: `log_${Date.now()}`,
        userId: currentUser.uid,
        userName: currentUser.name,
        action: 'UPDATE_PACKAGE',
        details: `Updated package ID ${savedPkg.id}: Price=৳${savedPkg.price}, Validity=${savedPkg.durationDays || 'exam_date'}d`,
        timestamp: new Date().toISOString()
      },
      ...prev
    ]);

    return { success: true };
  };

  // Update Exam Date Configuration & Apply Policy (Verified Owner Admin only — Authoritative Backend API)
  const updateExamDateConfig = async (
    config: Partial<ExamDateConfig>
  ): Promise<{ success: boolean; error?: string }> => {
    const res = await executeAuthoritativeAdminApi({
      isVerifiedOwner: isVerifiedOwnerAccount(auth?.currentUser),
      operation: () => apiAdminUpdateExamConfig(config),
      onUnauthorized: handleAdminUnauthorized,
      onSessionRevoked: handleAdminSessionRevoked
    });

    if (!res.success || !res.data?.examDateConfig) {
      return { success: false, error: res.error || 'পরীক্ষার তারিখ কনফিগারেশন সংরক্ষণ করা যায়নি।' };
    }

    const savedConfig = res.data.examDateConfig;
    const affectedCount = res.data.affectedSubscribers ?? 0;
    setExamDateConfig(savedConfig);

    if (savedConfig.examPassPrice !== undefined) {
      setPackages(prev =>
        prev.map(p => (p.id === 'pkg_exam_pass' ? { ...p, price: Number(savedConfig.examPassPrice) } : p))
      );
    }

    if (savedConfig.examDatePolicy === 'extend_all' && savedConfig.targetExamDate) {
      setSubscriptions(prev =>
        prev.map(sub => {
          if (sub.packageId === 'pkg_exam_pass' && sub.status === 'active') {
            return {
              ...sub,
              expiresAt: new Date(savedConfig.targetExamDate).toISOString(),
              targetExamDateSnapshot: savedConfig.targetExamDate
            };
          }
          return sub;
        })
      );
    }

    setAuditLogs(prev => [
      {
        id: `log_${Date.now()}`,
        userId: currentUser.uid,
        userName: currentUser.name,
        action: 'UPDATE_EXAM_DATE_CONFIG',
        details: `Exam Date set to ${savedConfig.targetExamDate} (${savedConfig.timezone}). Policy: ${savedConfig.examDatePolicy}. Affected active subscribers: ${affectedCount}`,
        timestamp: new Date().toISOString()
      },
      ...prev
    ]);

    return { success: true };
  };

  const updatePaymentSettings = async (
    settings: Partial<PaymentSettings>
  ): Promise<{ success: boolean; error?: string }> => {
    const res = await executeAuthoritativeAdminApi({
      isVerifiedOwner: isVerifiedOwnerAccount(auth?.currentUser),
      operation: () => apiAdminUpdatePaymentSettings(settings),
      onUnauthorized: handleAdminUnauthorized,
      onSessionRevoked: handleAdminSessionRevoked
    });

    if (!res.success || !res.data?.paymentSettings) {
      return { success: false, error: res.error || 'পেমেন্ট সেটিংস সংরক্ষণ করা যায়নি।' };
    }

    const savedPayment = res.data.paymentSettings;
    setPaymentSettings(savedPayment);
    if (res.data.supportSettings) {
      setSupportSettings(res.data.supportSettings);
    }

    setAuditLogs(prev => [
      {
        id: `log_${Date.now()}`,
        userId: currentUser.uid,
        userName: currentUser.name,
        action: 'UPDATE_PAYMENT_SETTINGS',
        details: `Updated Payment Numbers: bKash: ${savedPayment.bkashNumber}, Nagad: ${savedPayment.nagadNumber}`,
        timestamp: new Date().toISOString()
      },
      ...prev
    ]);

    return { success: true };
  };

  const updateSupportSettings = async (
    settings: Partial<SupportContactSettings>
  ): Promise<{ success: boolean; error?: string }> => {
    const res = await executeAuthoritativeAdminApi({
      isVerifiedOwner: isVerifiedOwnerAccount(auth?.currentUser),
      operation: () => apiAdminUpdateSupportSettings(settings),
      onUnauthorized: handleAdminUnauthorized,
      onSessionRevoked: handleAdminSessionRevoked
    });

    if (!res.success || !res.data?.supportSettings) {
      return { success: false, error: res.error || 'সাপোর্ট সেটিংস সংরক্ষণ করা যায়নি।' };
    }

    const savedSupport = res.data.supportSettings;
    setSupportSettings(savedSupport);
    setPaymentSettings(prev => ({
      ...prev,
      whatsappNumber: savedSupport.whatsappNumber,
      whatsappMessage: savedSupport.whatsappMessage
    }));

    setAuditLogs(prev => [
      {
        id: `log_${Date.now()}`,
        userId: currentUser.uid,
        userName: currentUser.name,
        action: 'UPDATE_SUPPORT_SETTINGS',
        details: `Updated WhatsApp Support: ${savedSupport.whatsappNumber}`,
        timestamp: new Date().toISOString()
      },
      ...prev
    ]);

    return { success: true };
  };

  // Single Active Session Simulation (Account sharing protection test)
  const simulateConcurrentLogin = () => {
    setIsSessionRevoked(true);
    setSessionRevokedReason('একই অ্যাকাউন্ট অন্য ডিভাইস বা ব্রাউজার থেকে লগইন করা হয়েছে। নিরাপত্তা বিধির কারণে আপনার পূর্ববর্তী সেশনটি বন্ধ করা হয়েছে। (Multi-device account sharing protection triggered)');
    if (currentSession) {
      setCurrentSession(prev => prev ? { ...prev, status: 'revoked' } : null);
    }
    setAuditLogs(prev => [
      {
        id: `log_${Date.now()}`,
        userId: currentUser.uid,
        userName: currentUser.name,
        action: 'CONCURRENT_SESSION_DETECTED',
        details: 'Active session revoked due to concurrent login detected from another client.',
        timestamp: new Date().toISOString()
      },
      ...prev
    ]);
  };

  const recoverSession = async (): Promise<boolean> => {
    if (!auth?.currentUser) return false;
    const res = await apiCreateSession(
      currentUser.name || auth.currentUser.displayName || undefined,
      typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 80) : 'Web Browser'
    );
    if (!res.ok || !res.data?.success) {
      return false;
    }
    setApiSessionId(res.data.sessionId);
    writeStoredActiveSession(auth.currentUser.uid, res.data.sessionId);
    setCurrentSession(res.data.session);
    setIsSessionRevoked(false);
    setSessionRevokedReason('');
    setAuditLogs(prev => [
      {
        id: `log_${Date.now()}`,
        userId: currentUser.uid,
        userName: currentUser.name,
        action: 'SESSION_RECOVERED',
        details: `Single active session re-established: ${res.data!.sessionId}.`,
        timestamp: new Date().toISOString()
      },
      ...prev
    ]);
    return true;
  };

  const currentExamForAttempt = activeAttempt 
    ? (exams.find(e => e.id === activeAttempt.examId) || null)
    : null;

  // Start exam via server-authoritative /api/exams/start with subscription & token verification
  const startExam = async (examId: string): Promise<{ success: boolean; reason?: string }> => {
    setExamLaunchError(null);

    if (isSessionRevoked || (currentSession && currentSession.status === 'revoked')) {
      const msg = 'সেশনটি অন্য ডিভাইস থেকে ব্যবহারের কারণে বন্ধ করা হয়েছে। অনুগ্রহ করে পুনরায় লগইন করুন।';
      setExamLaunchError(msg);
      return { success: false, reason: msg };
    }

    if (!isLoggedIn || !auth?.currentUser) {
      const msg = language === 'bn'
        ? 'পরীক্ষা শুরু করতে অনুগ্রহ করে প্রথমে আপনার Firebase অ্যাকাউন্ট দিয়ে লগইন করুন।'
        : 'Please sign in with your Firebase account to start an exam.';
      setExamLaunchError(msg);
      setShowLoginModal(true);
      return { success: false, reason: msg };
    }

    const exam = exams.find(e => e.id === examId);
    if (exam) {
      if (exam.isPaid && !isProSubscribed) {
        openSubscriptionModal(packages[0]?.id);
        return {
          success: false,
          reason: 'এই স্পেশাল ৬০ মিনিটের পূর্ণাঙ্গ মডেল টেস্টটি আনলক করতে সক্রিয় প্রো সাবস্ক্রিপশন প্রয়োজন।'
        };
      }
      if (exam.isActive === false && !isVerifiedOwnerAccount(auth.currentUser)) {
        const msg = 'এই মডেল টেস্টটি এখনো চালু করা হয়নি। অ্যাডমিন কর্তৃক নির্ধারিত দিনে পরীক্ষাটি চালু করা হবে।';
        setExamLaunchError(msg);
        return { success: false, reason: msg };
      }
      if (exam.type === 'custom_test' && !isVerifiedOwnerAccount(auth.currentUser)) {
        const msg = 'অননুমোদিত: অ্যাডমিন ছাড়া কেউ কাস্টম টেস্ট নিতে পারবেন না।';
        setExamLaunchError(msg);
        return { success: false, reason: msg };
      }
    }

    const res = await apiStartExam(examId, currentUser.name);
    if (!res.ok || !res.data?.success) {
      if (res.code === 'SUBSCRIPTION_REQUIRED') {
        openSubscriptionModal(packages[0]?.id);
      } else if (res.code === 'SESSION_REVOKED') {
        setIsSessionRevoked(true);
        setSessionRevokedReason(res.message || 'Session revoked');
      } else if (res.status === 401) {
        setShowLoginModal(true);
      }
      const errReason = res.message || 'পরীক্ষা শুরু করা যায়নি।';
      setExamLaunchError(errReason);
      return { success: false, reason: errReason };
    }

    const { attempt, exam: serverExam, questions: serverQuestions } = res.data;

    // Merge sanitized exam questions into questions state without exposing keys
    if (Array.isArray(serverQuestions) && serverQuestions.length > 0) {
      setQuestions(prev => {
        const map = new Map<string, Question>();
        prev.forEach(q => map.set(q.id, q));
        serverQuestions.forEach(sq => {
          const existing = map.get(sq.id);
          // Preserve admin-held keys only if already loaded for verified owner; otherwise keep sanitized question
          map.set(sq.id, existing && isVerifiedOwnerAccount(auth?.currentUser) ? { ...sq, ...existing } : sq);
        });
        return Array.from(map.values());
      });
    }

    setExams(prev => {
      const exists = prev.some(e => e.id === serverExam.id);
      if (exists) return prev.map(e => (e.id === serverExam.id ? serverExam : e));
      return [serverExam, ...prev];
    });

    examBatcherRef.current?.reset();
    activeAttemptRef.current = attempt;
    setActiveAttempt(attempt);
    setActiveScreen('exam');

    setAuditLogs(prev => [
      {
        id: `log_${Date.now()}`,
        userId: auth.currentUser!.uid,
        userName: currentUser.name,
        action: 'START_EXAM',
        details: `Started authoritative exam "${serverExam.titleEn}" (${attempt.id})`,
        timestamp: new Date().toISOString()
      },
      ...prev
    ]);

    return { success: true };
  };

  // Create & Start Custom Model Test directly from Question Bank (Owner Admin Only)
  const createAndStartCustomExam = async (config: {
    titleBn?: string;
    titleEn?: string;
    durationMinutes: number;
    questionIds: string[];
    negativeMarkRatio?: number;
  }): Promise<{ success: boolean; examId?: string; reason?: string }> => {
    if (!isVerifiedOwnerAccount(auth?.currentUser)) {
      return {
        success: false,
        reason: 'অননুমোদিত: অ্যাডমিন ছাড়া কেউ কাস্টম টেস্ট তৈরি বা পরিচালনা করতে পারবে না।'
      };
    }

    if (isSessionRevoked || (currentSession && currentSession.status === 'revoked')) {
      return {
        success: false,
        reason: 'সেশনটি অন্য ডিভাইস থেকে ব্যবহারের কারণে বন্ধ করা হয়েছে। অনুগ্রহ করে পুনরায় লগইন করুন।'
      };
    }

    if (!config.questionIds || config.questionIds.length === 0) {
      return {
        success: false,
        reason: 'কোনো প্রশ্ন নির্বাচন করা হয়নি।'
      };
    }

    const testId = `exam_custom_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const titleBn = config.titleBn || `কাস্টম মডেল টেস্ট (${config.questionIds.length} টি প্রশ্ন)`;
    const titleEn = config.titleEn || `Custom Model Test (${config.questionIds.length} MCQs)`;

    const newCustomExam: Exam = {
      id: testId,
      titleBn,
      titleEn,
      descriptionBn: `প্রশ্ন সম্ভার থেকে তৈরিকৃত কাস্টম মডেল টেস্ট। প্রশ্ন সংখ্যা: ${config.questionIds.length}টি, সময়: ${config.durationMinutes} মিনিট। নেগেটিভ মার্কিং: ${config.negativeMarkRatio ?? 0.25}।`,
      descriptionEn: `Custom mock test curated from the question repository. Questions: ${config.questionIds.length}, Duration: ${config.durationMinutes} mins. Negative mark: ${config.negativeMarkRatio ?? 0.25}.`,
      type: 'custom_test',
      durationMinutes: config.durationMinutes,
      totalMarks: config.questionIds.length,
      passThresholdPercentage: 50,
      questionIds: config.questionIds,
      isPaid: false,
      isActive: true,
      published: true,
      releaseExplanationsImmediately: true,
      negativeMarkRatio: config.negativeMarkRatio ?? 0.25,
      positiveMarkRatio: 1.0,
      createdAt: new Date().toISOString()
    };

    const saveRes = await executeAuthoritativeAdminApi({
      isVerifiedOwner: isVerifiedOwnerAccount(auth?.currentUser),
      operation: () => apiAdminSaveExam(newCustomExam),
      onUnauthorized: handleAdminUnauthorized,
      onSessionRevoked: handleAdminSessionRevoked
    });

    if (!saveRes.success || !saveRes.data?.exam) {
      return {
        success: false,
        reason: saveRes.error || 'কাস্টম মডেল টেস্ট ব্যাকএন্ডে সংরক্ষণ করা যায়নি।'
      };
    }

    const persistedExam = saveRes.data.exam;
    setExams(prev => [persistedExam, ...prev]);

    const startRes = await startExam(persistedExam.id);
    if (!startRes.success) {
      return { success: false, reason: startRes.reason };
    }
    return { success: true, examId: persistedExam.id };
  };

  useEffect(() => {
    activeAttemptRef.current = activeAttempt;
  }, [activeAttempt]);

  // Flush pending exam answers safely when tab loses visibility or hides
  useEffect(() => {
    if (!activeAttempt || activeAttempt.status !== 'in_progress') return;
    const attemptId = activeAttempt.id;
    const handleFlush = () => {
      if (document.visibilityState === 'hidden') {
        void examBatcherRef.current?.flush(attemptId);
      }
    };
    const handlePageHide = () => {
      void examBatcherRef.current?.flush(attemptId);
    };
    document.addEventListener('visibilitychange', handleFlush);
    window.addEventListener('pagehide', handlePageHide);
    return () => {
      document.removeEventListener('visibilitychange', handleFlush);
      window.removeEventListener('pagehide', handlePageHide);
    };
  }, [activeAttempt?.id, activeAttempt?.status]);

  const saveActiveAnswer = (questionId: string, optionIndex: number) => {
    if (isSessionRevoked || isSubmittingExam) return;
    const prev = activeAttemptRef.current;
    if (!prev || prev.status !== 'in_progress') return;

    const nextAnswers = { ...prev.answers, [questionId]: optionIndex };
    const nextAttempt: ExamAttempt = {
      ...prev,
      answers: nextAnswers,
      lastSavedAt: new Date().toISOString()
    };
    activeAttemptRef.current = nextAttempt;
    setActiveAttempt(nextAttempt);

    examBatcherRef.current?.enqueue({
      attemptId: nextAttempt.id,
      answers: nextAttempt.answers,
      flaggedQuestionIds: nextAttempt.flaggedQuestionIds,
      currentQuestionIndex: nextAttempt.currentQuestionIndex
    });
  };

  const clearActiveAnswer = (questionId: string) => {
    if (isSessionRevoked || isSubmittingExam) return;
    const prev = activeAttemptRef.current;
    if (!prev || prev.status !== 'in_progress') return;

    const updatedAnswers = { ...prev.answers };
    delete updatedAnswers[questionId];
    const nextAttempt: ExamAttempt = {
      ...prev,
      answers: updatedAnswers,
      lastSavedAt: new Date().toISOString()
    };
    activeAttemptRef.current = nextAttempt;
    setActiveAttempt(nextAttempt);

    examBatcherRef.current?.enqueue({
      attemptId: nextAttempt.id,
      answers: nextAttempt.answers,
      flaggedQuestionIds: nextAttempt.flaggedQuestionIds,
      currentQuestionIndex: nextAttempt.currentQuestionIndex
    });
  };

  const toggleFlagQuestion = (questionId: string) => {
    if (isSessionRevoked || isSubmittingExam) return;
    const prev = activeAttemptRef.current;
    if (!prev || prev.status !== 'in_progress') return;

    const exists = prev.flaggedQuestionIds.includes(questionId);
    const flagged = exists
      ? prev.flaggedQuestionIds.filter(id => id !== questionId)
      : [...prev.flaggedQuestionIds, questionId];
    const nextAttempt: ExamAttempt = {
      ...prev,
      flaggedQuestionIds: flagged,
      lastSavedAt: new Date().toISOString()
    };
    activeAttemptRef.current = nextAttempt;
    setActiveAttempt(nextAttempt);

    examBatcherRef.current?.enqueue({
      attemptId: nextAttempt.id,
      answers: nextAttempt.answers,
      flaggedQuestionIds: nextAttempt.flaggedQuestionIds,
      currentQuestionIndex: nextAttempt.currentQuestionIndex
    });
  };

  // Authoritative server-side exam submission & scoring (NO client-side score calculation)
  const submitExamAttempt = async (isAutoTimeout = false): Promise<ExamResult | null> => {
    const targetAttempt = activeAttemptRef.current || activeAttempt;
    if (!targetAttempt || targetAttempt.status !== 'in_progress' || isSubmittingExam) {
      return null;
    }

    if (isSessionRevoked) {
      setExamLaunchError('আপনার সেশনটি অন্য ডিভাইস থেকে ব্যবহারের কারণে বন্ধ করা হয়েছে। উত্তর জমা নেওয়া সম্ভব নয়।');
      return null;
    }

    setIsSubmittingExam(true);
    try {
      await examBatcherRef.current?.flush(targetAttempt.id);
      const latestAttempt = activeAttemptRef.current || targetAttempt;

      const res = await apiSubmitExam(latestAttempt.id, latestAttempt.answers, isAutoTimeout);
      if (!res.ok || !res.data?.success || !res.data.result) {
        if (res.code === 'ALREADY_SUBMITTED') {
          examBatcherRef.current?.markSubmitted(latestAttempt.id);
        } else if (res.code === 'SESSION_REVOKED') {
          handleAdminSessionRevoked(
            res.message || 'একই অ্যাকাউন্ট অন্য ডিভাইস থেকে লগইন করা হয়েছে। উত্তর জমা নেওয়া সম্ভব নয়।'
          );
        }
        const errMsg = res.message || 'পরীক্ষা জমা দিতে সমস্যা হয়েছে। অনুগ্রহ করে পুনরায় চেষ্টা করুন।';
        setExamLaunchError(errMsg);
        return null;
      }

      const { result: serverResult, leaderboardEntry } = res.data;

      examBatcherRef.current?.markSubmitted(latestAttempt.id);
      activeAttemptRef.current = null;
      setActiveAttempt(null);
      setExamResults(prev => [serverResult, ...prev.filter(r => r.id !== serverResult.id)]);

      if (leaderboardEntry) {
        setLeaderboardEntries(prev => {
          const filtered = prev.filter(
            item => !(item.userId === leaderboardEntry.userId && item.examId === leaderboardEntry.examId)
          );
          const list = [...filtered, leaderboardEntry];
          list.sort((a, b) => b.score - a.score || a.timeSpentSeconds - b.timeSpentSeconds);
          return list.map((item, idx) => ({ ...item, rank: idx + 1 }));
        });
      }

      // Sync revealed question answers into practice completion ledger
      setAnsweredQuestions(prev => {
        const next = { ...prev };
        for (const q of serverResult.questions || []) {
          const userChoice = serverResult.answers[q.id];
          if (userChoice !== undefined && userChoice !== null && q.correctOptionIndex !== undefined) {
            next[q.id] = {
              questionId: q.id,
              subjectId: q.subjectId,
              selectedOption: userChoice,
              isCorrect: userChoice === q.correctOptionIndex,
              timestamp: serverResult.submittedAt
            };
          }
        }
        return next;
      });

      try {
        localStorage.removeItem(LOCAL_STORAGE_KEY_ATTEMPT);
      } catch (e) {}

      setActiveResult(serverResult);
      setActiveScreen('result');

      setAuditLogs(prev => [
        {
          id: `log_${Date.now()}`,
          userId: serverResult.userId,
          userName: serverResult.studentName,
          action: isAutoTimeout ? 'EXAM_TIMED_OUT' : 'SUBMIT_EXAM',
          details: `Server evaluated "${serverResult.examTitleEn}": ${serverResult.finalScore}/${serverResult.totalQuestions} (${serverResult.percentage}%)`,
          timestamp: serverResult.submittedAt
        },
        ...prev
      ]);

      return serverResult;
    } finally {
      setIsSubmittingExam(false);
    }
  };

  const viewResult = (resultId: string) => {
    const res = examResults.find(r => r.id === resultId);
    if (res) {
      setActiveResult(res);
      setActiveScreen('result');
    }
  };

  const startSubjectPractice = (subjectId: string): { success: boolean; reason?: string } => {
    if (!isProSubscribed) {
      openSubscriptionModal(packages[0]?.id);
      return {
        success: false,
        reason: '৭টি মূল আইনের বিষয়ভিত্তিক অনুশীলন করতে পেইড প্রো সাবস্ক্রিপশন প্রয়োজন। পেইড করার পর অনুশীলন করতে পারবেন।'
      };
    }

    const sub = subjects.find(s => s.id === subjectId);
    if (sub) {
      setSelectedSubjectForPractice(sub);
      setActiveScreen('practice');
      void ensureSubjectQuestionsLoaded(sub.id);
      return { success: true };
    }
    return { success: false, reason: 'Subject not found' };
  };

  const recordQuestionAnswer = (questionId: string, subjectId: string, selectedOption: number, isCorrect: boolean) => {
    setAnsweredQuestions(prev => ({
      ...prev,
      [questionId]: {
        questionId,
        subjectId,
        selectedOption,
        isCorrect,
        timestamp: new Date().toISOString()
      }
    }));
  };

  const checkPracticeAnswer = async (questionId: string, selectedOption: number) => {
    if (!isLoggedIn || !auth?.currentUser) {
      setShowLoginModal(true);
      return { success: false, error: 'অনুগ্রহ করে প্রথমে লগইন করুন।' };
    }
    const res = await apiCheckPracticeAnswer(questionId, selectedOption);
    if (!res.ok || !res.data?.success) {
      if (res.code === 'SUBSCRIPTION_REQUIRED') {
        openSubscriptionModal(packages[0]?.id);
      } else if (res.code === 'SESSION_REVOKED') {
        handleAdminSessionRevoked(res.message || 'সেশনটি অন্য ডিভাইস থেকে ব্যবহারের কারণে বন্ধ করা হয়েছে।');
      }
      return { success: false, error: res.message || 'উত্তর যাচাই করা যায়নি।' };
    }
    const targetQ = questions.find(q => q.id === questionId);
    recordQuestionAnswer(questionId, targetQ?.subjectId || '', selectedOption, res.data.isCorrect);
    return {
      success: true,
      isCorrect: res.data.isCorrect,
      correctOptionIndex: res.data.correctOptionIndex,
      explanationBn: res.data.explanationBn,
      explanationEn: res.data.explanationEn,
      legalReference: res.data.legalReference
    };
  };

  const getSubjectProgress = useCallback((subjectId: string): SubjectPracticeProgress => {
    const subQuestions = questions.filter(q => q.subjectId === subjectId);
    const totalCountForSubject = Math.max(subQuestions.length, subjectQuestionCounts[subjectId] || 0);
    const denominator = totalCountForSubject > 0 ? totalCountForSubject : 1;
    const subQuestionIdSet = new Set(subQuestions.map(q => q.id));

    let answeredCount = 0;
    let correctCount = 0;
    let incorrectCount = 0;

    for (const [qId, record] of Object.entries(answeredQuestions) as [string, AnsweredQuestionRecord][]) {
      if (record && (record.subjectId === subjectId || subQuestionIdSet.has(qId))) {
        answeredCount++;
        if (record.isCorrect) {
          correctCount++;
        } else {
          incorrectCount++;
        }
      }
    }

    const percentage = Math.min(100, Math.round((answeredCount / denominator) * 100));
    const accuracy = answeredCount > 0 ? Math.round((correctCount / answeredCount) * 100) : 0;

    return {
      subjectId,
      totalQuestions: totalCountForSubject,
      answeredCount,
      correctCount,
      incorrectCount,
      percentage,
      accuracy
    };
  }, [questions, answeredQuestions, subjectQuestionCounts]);

  const addQuestion = async (
    newQ: Omit<Question, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<{ success: boolean; error?: string }> => {
    const candidate: Question = {
      ...newQ,
      id: `q_custom_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: currentUser.name
    };

    const res = await executeAuthoritativeAdminApi({
      isVerifiedOwner: isVerifiedOwnerAccount(auth?.currentUser),
      operation: () => apiAdminSaveQuestion(candidate),
      onUnauthorized: handleAdminUnauthorized,
      onSessionRevoked: handleAdminSessionRevoked
    });

    if (!res.success || !res.data?.question) {
      return { success: false, error: res.error || 'প্রশ্ন সংরক্ষণ করা যায়নি।' };
    }

    const savedQ = res.data.question;
    setQuestions(prev => [savedQ, ...prev]);
    setSubjectQuestionCounts(prev => ({
      ...prev,
      [savedQ.subjectId]: (prev[savedQ.subjectId] || 0) + 1
    }));
    setTotalQuestionCount(prev => (prev > 0 ? prev + 1 : 1));
    void loadAdminQuestionsPage();
    return { success: true };
  };

  const updateQuestion = async (updated: Question): Promise<{ success: boolean; error?: string }> => {
    const withTime = { ...updated, updatedAt: new Date().toISOString() };
    const res = await executeAuthoritativeAdminApi({
      isVerifiedOwner: isVerifiedOwnerAccount(auth?.currentUser),
      operation: () => apiAdminSaveQuestion(withTime),
      onUnauthorized: handleAdminUnauthorized,
      onSessionRevoked: handleAdminSessionRevoked
    });

    if (!res.success || !res.data?.question) {
      return { success: false, error: res.error || 'প্রশ্ন আপডেট করা যায়নি।' };
    }

    const saved = res.data.question;
    setQuestions(prev => prev.map(q => (q.id === saved.id ? saved : q)));
    setAdminQuestionsPageData(prev => ({
      ...prev,
      questions: prev.questions.map(q => (q.id === saved.id ? saved : q))
    }));
    return { success: true };
  };

  const deleteQuestion = async (id: string): Promise<{ success: boolean; error?: string }> => {
    const targetQ =
      questions.find(q => q.id === id) ||
      adminQuestionsPageDataRef.current.questions.find(q => q.id === id);
    const res = await executeAuthoritativeAdminApi({
      isVerifiedOwner: isVerifiedOwnerAccount(auth?.currentUser),
      operation: () => apiAdminDeleteQuestion(id),
      onUnauthorized: handleAdminUnauthorized,
      onSessionRevoked: handleAdminSessionRevoked
    });

    if (!res.success) {
      return { success: false, error: res.error || 'প্রশ্ন মুছে ফেলা যায়নি।' };
    }

    setQuestions(prev => prev.filter(q => q.id !== id));
    setAdminQuestionsPageData(prev => ({
      ...prev,
      questions: prev.questions.filter(q => q.id !== id),
      total: Math.max(0, prev.total - 1)
    }));
    if (targetQ?.subjectId) {
      setSubjectQuestionCounts(prev => ({
        ...prev,
        [targetQ.subjectId]: Math.max(0, (prev[targetQ.subjectId] || 0) - 1)
      }));
    }
    setTotalQuestionCount(prev => Math.max(0, prev - 1));
    void loadAdminQuestionsPage();
    return { success: true };
  };

  const addExam = async (
    newExam: Omit<Exam, 'id' | 'createdAt'>
  ): Promise<{ success: boolean; exam?: Exam; error?: string }> => {
    const created: Exam = {
      ...newExam,
      id: `exam_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      createdAt: new Date().toISOString()
    };

    const res = await executeAuthoritativeAdminApi({
      isVerifiedOwner: isVerifiedOwnerAccount(auth?.currentUser),
      operation: () => apiAdminSaveExam(created),
      onUnauthorized: handleAdminUnauthorized,
      onSessionRevoked: handleAdminSessionRevoked
    });

    if (!res.success || !res.data?.exam) {
      return { success: false, error: res.error || 'মডেল টেস্ট সংরক্ষণ করা যায়নি।' };
    }

    const saved = res.data.exam;
    setExams(prev => [...prev, saved]);
    return { success: true, exam: saved };
  };

  const updateExam = async (updated: Exam): Promise<{ success: boolean; error?: string }> => {
    const res = await executeAuthoritativeAdminApi({
      isVerifiedOwner: isVerifiedOwnerAccount(auth?.currentUser),
      operation: () => apiAdminSaveExam(updated),
      onUnauthorized: handleAdminUnauthorized,
      onSessionRevoked: handleAdminSessionRevoked
    });

    if (!res.success || !res.data?.exam) {
      return { success: false, error: res.error || 'পরীক্ষা আপডেট করা যায়নি।' };
    }

    const saved = res.data.exam;
    setExams(prev => prev.map(e => (e.id === saved.id ? saved : e)));
    return { success: true };
  };

  const toggleExamStatus = async (
    examId: string,
    isActive?: boolean,
    scheduledDate?: string
  ): Promise<{ success: boolean; error?: string }> => {
    const target = exams.find(e => e.id === examId);
    if (!target) {
      return { success: false, error: 'পরীক্ষাটি খুঁজে পাওয়া যায়নি।' };
    }

    const nextActive = isActive !== undefined ? isActive : !target.isActive;
    const candidate: Exam = {
      ...target,
      isActive: nextActive,
      published: nextActive ? true : target.published,
      scheduledDate: scheduledDate !== undefined ? scheduledDate : target.scheduledDate
    };

    const res = await executeAuthoritativeAdminApi({
      isVerifiedOwner: isVerifiedOwnerAccount(auth?.currentUser),
      operation: () => apiAdminSaveExam(candidate),
      onUnauthorized: handleAdminUnauthorized,
      onSessionRevoked: handleAdminSessionRevoked
    });

    if (!res.success || !res.data?.exam) {
      return { success: false, error: res.error || 'পরীক্ষার স্ট্যাটাস পরিবর্তন করা যায়নি।' };
    }

    const saved = res.data.exam;
    setExams(prev => prev.map(e => (e.id === saved.id ? saved : e)));

    setAuditLogs(prev => [
      {
        id: `log_${Date.now()}`,
        userId: currentUser.uid,
        userName: currentUser.name,
        action: nextActive ? 'LAUNCH_EXAM' : 'DEACTIVATE_EXAM',
        details: `${nextActive ? 'Launched' : 'Deactivated'} exam ${examId} (${target.titleEn || 'Model Test'}) - Scheduled: ${scheduledDate || target.scheduledDate || 'Immediate'}`,
        timestamp: new Date().toISOString()
      },
      ...prev
    ]);

    return { success: true };
  };

  const generateAndSync30ModelTests = async (): Promise<{ success: boolean; count: number; message: string }> => {
    if (!isVerifiedOwnerAccount(auth?.currentUser)) {
      return { success: false, count: 0, message: 'অননুমোদিত: শুধুমাত্র অ্যাডমিন মডেল টেস্ট সিঙ্ক করতে পারবেন।' };
    }
    let questionPool = questions;
    if (questionPool.length < 3000) {
      const adminQRes = await apiFetchAdminQuestions();
      if (!adminQRes.ok) {
        return {
          success: false,
          count: 0,
          message: formatBackendApiError({
            status: adminQRes.status,
            code: adminQRes.code,
            serverMessage: adminQRes.message,
            isJson: adminQRes.code !== 'NON_JSON_RESPONSE'
          })
        };
      }
      if (adminQRes.data?.questions?.length) {
        questionPool = adminQRes.data.questions;
        setQuestions(questionPool);
      }
    }

    const generated = generate30ModelTests(questionPool);
    const savedExams: Exam[] = [];
    const errors: string[] = [];

    for (const ex of generated.slice(0, 30)) {
      const saveRes = await apiAdminSaveExam(ex);
      if (saveRes.ok && saveRes.data?.exam) {
        savedExams.push(saveRes.data.exam);
      } else {
        errors.push(
          saveRes.message ||
            formatBackendApiError({
              status: saveRes.status,
              code: saveRes.code,
              isJson: saveRes.code !== 'NON_JSON_RESPONSE'
            })
        );
      }
    }

    if (savedExams.length > 0) {
      setExams(prev => {
        const savedMap = new Map(savedExams.map(e => [e.id, e]));
        const retained = prev.filter(e => !savedMap.has(e.id));
        return [...savedExams, ...retained];
      });
    }

    if (errors.length > 0) {
      return {
        success: false,
        count: savedExams.length,
        message: `${savedExams.length}/${generated.length}টি টেস্ট সেভ হয়েছে, কিন্তু ${errors.length}টি ব্যর্থ: ${errors[0]}`
      };
    }

    return {
      success: true,
      count: savedExams.length,
      message: `${savedExams.length}টি পূর্ণাঙ্গ মডেল টেস্ট সফলভাবে প্রস্তুত ও সমন্বিত হয়েছে।`
    };
  };

  // Create Payment Request (Strictly Authenticated Backend API — Zero Firestore fallback, Zero client pricing)
  const createPaymentRequest = async (req: {
    method: 'bKash' | 'Nagad' | 'Rocket';
    studentPhone?: string;
    senderNumber: string;
    transactionId: string;
    amount?: number;
    packageId: string;
    packageTitle?: string;
  }): Promise<{ success: boolean; error?: string }> => {
    if (paymentSubmitLockRef.current) {
      return {
        success: false,
        error: 'পেমেন্ট রিকোয়েস্ট ইতিমধ্যে পাঠানো হচ্ছে। অনুগ্রহ করে কয়েক সেকেন্ড অপেক্ষা করুন।'
      };
    }

    const authenticatedUid = isLoggedIn ? auth?.currentUser?.uid : null;
    paymentSubmitLockRef.current = true;

    try {
      const result = await submitPaymentViaAuthoritativeBackend({
        authenticatedUid,
        method: req.method,
        studentPhone: req.studentPhone || currentUser.phone,
        senderNumber: req.senderNumber,
        transactionId: req.transactionId,
        packageId: req.packageId,
        studentName: currentUser.name,
        existingRequests: paymentRequests,
        apiBaseUrl: typeof import.meta !== 'undefined' ? import.meta.env?.VITE_API_BASE_URL : '',
        isProduction: typeof import.meta !== 'undefined' ? Boolean(import.meta.env?.PROD) : false,
        callCreatePaymentApi: apiCreatePaymentRequest,
        onUnauthorized: () => setShowLoginModal(true),
        onSessionRevoked: handleAdminSessionRevoked
      });

      if (!result.success || !result.paymentRequest) {
        return {
          success: false,
          error: result.error || 'পেমেন্ট রিকোয়েস্ট জমা দেওয়া যায়নি। অনুগ্রহ করে পুনরায় চেষ্টা করুন।'
        };
      }

      const persistedReq = result.paymentRequest;
      setPaymentRequests(prev => [persistedReq, ...prev.filter(p => p.id !== persistedReq.id)]);
      setAuditLogs(prev => [
        {
          id: `log_${Date.now()}`,
          userId: authenticatedUid!,
          userName: currentUser.name,
          action: 'PAYMENT_REQUEST_SUBMITTED',
          details: `${persistedReq.method} TrxID: ${persistedReq.transactionId} (৳${persistedReq.amount}) submitted for package "${persistedReq.packageNameEn}".`,
          timestamp: new Date().toISOString()
        },
        ...prev
      ]);
      return { success: true };
    } finally {
      paymentSubmitLockRef.current = false;
    }
  };

  // Approve Payment Request & Atomically Activate Subscription (Owner Admin Only — Authoritative Backend API)
  const approvePaymentRequest = async (id: string): Promise<{ success: boolean; error?: string }> => {
    const req = paymentRequests.find(r => r.id === id);
    if (!req) return { success: false, error: 'Payment request not found' };
    if (req.status === 'approved') {
      return { success: false, error: 'Payment request is already approved' };
    }

    const res = await executeAuthoritativeAdminApi({
      isVerifiedOwner: isVerifiedOwnerAccount(auth?.currentUser),
      operation: () => apiApprovePaymentRequest(id, currentUser.name),
      onUnauthorized: handleAdminUnauthorized,
      onSessionRevoked: handleAdminSessionRevoked
    });

    if (!res.success || !res.data?.success) {
      return {
        success: false,
        error: res.error || 'পেমেন্ট অনুমোদন করা যায়নি।'
      };
    }

    const { paymentRequest: updatedPay, subscription: newSub } = res.data;
    setPaymentRequests(prev => prev.map(r => (r.id === id ? updatedPay : r)));
    setSubscriptions(prev => [newSub, ...prev.filter(s => s.id !== newSub.id)]);

    if (updatedPay.userId === currentUser.uid) {
      setCurrentUser(prev => ({
        ...prev,
        subscriptionStatus: 'pro',
        subscriptionExpiresAt: newSub.expiresAt,
        activePackageId: updatedPay.packageId,
        activePackageNameBn: updatedPay.packageNameBn,
        activePackageNameEn: updatedPay.packageNameEn
      }));
    }

    return { success: true };
  };

  const rejectPaymentRequest = async (id: string, reason: string): Promise<{ success: boolean; error?: string }> => {
    const res = await executeAuthoritativeAdminApi({
      isVerifiedOwner: isVerifiedOwnerAccount(auth?.currentUser),
      operation: () => apiRejectPaymentRequest(id, reason, currentUser.name),
      onUnauthorized: handleAdminUnauthorized,
      onSessionRevoked: handleAdminSessionRevoked
    });

    if (!res.success || !res.data?.success) {
      return {
        success: false,
        error: res.error || 'পেমেন্ট বাতিল করা যায়নি।'
      };
    }

    const updatedPay = res.data.paymentRequest;
    setPaymentRequests(prev => prev.map(r => (r.id === id ? updatedPay : r)));
    return { success: true };
  };

  const adminUpdateUser = async (params: {
    userId: string;
    subscriptionId?: string;
    name: string;
    email?: string;
    phone: string;
    role: UserRole;
    subscriptionStatus: 'free' | 'pro' | 'expired';
    packageId?: string;
    packageNameBn?: string;
    packageNameEn?: string;
    expiresAt?: string;
    isSessionRevoked?: boolean;
  }): Promise<{ success: boolean; message: string }> => {
    const effectiveOwnerAdminUid = resolveFrontendOwnerAdminUid();
    const safeRole: UserRole =
      params.role === 'admin' && (!effectiveOwnerAdminUid || params.userId !== effectiveOwnerAdminUid)
        ? 'student'
        : params.role;

    const res = await executeAuthoritativeAdminApi({
      isVerifiedOwner: isVerifiedOwnerAccount(auth?.currentUser),
      operation: () => apiAdminUpdateUser({ ...params, role: safeRole }),
      onUnauthorized: handleAdminUnauthorized,
      onSessionRevoked: handleAdminSessionRevoked
    });

    if (!res.success || !res.data?.success) {
      return { success: false, message: res.error || 'আপডেট ব্যর্থ হয়েছে।' };
    }

    const updatedUser = res.data.user;
    const persistedSub = res.data.subscription;
    const updatedSubsList = res.data.updatedSubscriptions;

    if (params.userId === currentUser.uid) {
      setCurrentUser(prev => ({
        ...prev,
        name: updatedUser?.name ?? params.name,
        email: updatedUser?.email || params.email || prev.email,
        phone: updatedUser?.phone ?? params.phone,
        role: updatedUser?.role ?? safeRole,
        subscriptionStatus: updatedUser?.subscriptionStatus ?? params.subscriptionStatus,
        subscriptionExpiresAt: updatedUser?.subscriptionExpiresAt ?? params.expiresAt,
        activePackageId: updatedUser?.activePackageId ?? params.packageId,
        activePackageNameBn: updatedUser?.activePackageNameBn ?? params.packageNameBn,
        activePackageNameEn: updatedUser?.activePackageNameEn ?? params.packageNameEn
      }));

      if (params.isSessionRevoked !== undefined) {
        setIsSessionRevoked(params.isSessionRevoked);
        if (params.isSessionRevoked) {
          setSessionRevokedReason('প্রশাসক কর্তৃক একাউন্ট নিরাপত্তা পর্যালোচনার স্বার্থে সেশন স্থগিত করা হয়েছে।');
        } else {
          setSessionRevokedReason('');
        }
      }
    }

    if (Array.isArray(updatedSubsList) && updatedSubsList.length > 0) {
      const byId = new Map(updatedSubsList.map(item => [item.id, item]));
      setSubscriptions(prev => {
        const mapped = prev.map(existing => byId.get(existing.id) || existing);
        const existingIds = new Set(mapped.map(s => s.id));
        const additions = updatedSubsList.filter(item => !existingIds.has(item.id));
        return additions.length > 0 ? [...additions, ...mapped] : mapped;
      });
    } else if (persistedSub) {
      const targetInactiveStatus: 'expired' | 'cancelled' =
        params.subscriptionStatus === 'expired' ? 'expired' : 'cancelled';
      setSubscriptions(prev => {
        const exists = prev.some(s => s.id === persistedSub.id);
        if (exists) {
          return prev.map(s => {
            if (s.id === persistedSub.id) return persistedSub;
            if (params.subscriptionStatus !== 'pro' && s.userId === params.userId && s.status === 'active') {
              return { ...s, status: targetInactiveStatus };
            }
            return s;
          });
        }
        return [persistedSub, ...prev];
      });
    } else if (params.subscriptionStatus !== 'pro') {
      setSubscriptions(prev =>
        prev.map(sub => {
          if (sub.userId === params.userId || (params.subscriptionId && sub.id === params.subscriptionId)) {
            return {
              ...sub,
              studentName: params.name,
              studentPhone: params.phone,
              status: params.subscriptionStatus === 'expired' ? 'expired' : 'cancelled',
              expiresAt: params.expiresAt || sub.expiresAt
            };
          }
          return sub;
        })
      );
    }

    if (currentSession && currentSession.userId === params.userId) {
      setCurrentSession(prev => prev ? {
        ...prev,
        userName: params.name,
        userEmail: updatedUser?.email || params.email || prev.userEmail,
        status: params.isSessionRevoked ? 'revoked' : 'active'
      } : null);
    }

    setAuditLogs(prev => [
      {
        id: `log_${Date.now()}`,
        userId: currentUser.uid,
        userName: currentUser.name,
        action: 'USER_EDITED_BY_ADMIN',
        details: `অ্যাডমিন কর্তৃক ইউজার "${params.name}" (${params.phone}) এর প্রোফাইল ও সাবস্ক্রিপশন সফলভাবে আপডেট করা হয়েছে।`,
        timestamp: new Date().toISOString()
      },
      ...prev
    ]);

    return { success: true, message: `ইউজার "${params.name}" এর তথ্য সফলভাবে আপডেট করা হয়েছে।` };
  };

  return (
    <AppContext.Provider
      value={{
        language,
        toggleLanguage,
        t,
        currentUser,
        switchRole,
        updateUserProfile,
        subjects,
        questions,
        subjectQuestionCounts,
        totalQuestionCount,
        loadMoreSubjectQuestions,
        getSubjectLoadState,
        adminDashboardStats,
        adminQuestionsState,
        adminQuestionsPageData,
        loadAdminQuestionsPage,
        ensureAdminQuestionPool,
        reloadAdminQuestions,
        syncEdgeQuestionCache,
        exams,
        examResults,
        paymentRequests,
        paymentSettings,
        updatePaymentSettings,
        supportSettings,
        updateSupportSettings,
        isFirebaseActive: isFirebaseConnected(),
        firebaseProjectDetails: getFirebaseProjectDetails(),
        auditLogs,
        packages,
        updatePackage,
        examDateConfig,
        updateExamDateConfig,
        subscriptions,
        activeSubscription,
        calculateDaysRemaining,
        adminUpdateUser,
        currentSession,
        isSessionRevoked,
        sessionRevokedReason,
        simulateConcurrentLogin,
        recoverSession,
        activeScreen,
        setActiveScreen,
        activeAttempt,
        currentExamForAttempt,
        startExam,
        createAndStartCustomExam,
        showCustomTestModal,
        setShowCustomTestModal,
        saveActiveAnswer,
        clearActiveAnswer,
        toggleFlagQuestion,
        submitExamAttempt,
        examLaunchError,
        setExamLaunchError,
        activeResult,
        viewResult,
        leaderboardEntries,
        refreshLeaderboard,
        isProSubscribed,
        selectedSubjectForPractice,
        startSubjectPractice,
        answeredQuestions,
        recordQuestionAnswer,
        checkPracticeAnswer,
        getSubjectProgress,
        addQuestion,
        updateQuestion,
        deleteQuestion,
        addExam,
        updateExam,
        toggleExamStatus,
        generateAndSync30ModelTests,
        selectedPackageForPayment,
        setSelectedPackageForPayment,
        openSubscriptionModal,
        createPaymentRequest,
        approvePaymentRequest,
        rejectPaymentRequest,
        isLoggedIn,
        isEmailVerified,
        isVerifiedAdmin,
        loginWithGoogle,
        loginWithEmail,
        resendVerificationEmail,
        refreshVerificationStatus,
        sendPasswordReset,
        getIdToken,
        logoutUser,
        showLoginModal,
        setShowLoginModal,
        showSearchModal,
        setShowSearchModal,
        showInfoModal,
        setShowInfoModal,
        showPaymentModal,
        setShowPaymentModal,
        showFirebaseGuide,
        setShowFirebaseGuide,
        showTestRunner,
        setShowTestRunner,
        isSubmittingExam
      }}
    >
      {children}
    </AppContext.Provider>
  );
};

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
};
