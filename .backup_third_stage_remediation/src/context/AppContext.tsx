import React, { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';
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
  LeaderboardEntry,
  PreviousQuestion,
  PreviousExamResult
} from '../types';
import { INITIAL_SUBJECTS, INITIAL_QUESTIONS } from '../data/mockData';
import { INITIAL_EXAMS, SUBJECT_PRACTICE_TESTS } from '../data/initialExams';
import { INITIAL_PACKAGES, INITIAL_EXAM_DATE_CONFIG } from '../data/initialPackages';
import { INITIAL_LEADERBOARD_ENTRIES } from '../data/initialLeaderboard';
import { INITIAL_PREVIOUS_QUESTIONS } from '../data/initialPreviousQuestions';
import { calculateExamScore } from '../utils/scoring';
import { generate30ModelTests } from '../utils/modelTestGenerator';
import { signInWithPopup, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged } from 'firebase/auth';
import {
  isFirebaseConnected,
  getFirebaseProjectDetails,
  auth,
  googleProvider,
  OWNER_ADMIN_UID,
  OWNER_ADMIN_EMAIL,
  isVerifiedOwnerAccount
} from '../lib/firebase';
import { 
  fetchQuestionsFromFirestore, 
  saveQuestionToFirestore, 
  deleteQuestionFromFirestore, 
  fetchExamsFromFirestore, 
  saveExamToFirestore, 
  fetchPaymentRequestsFromFirestore, 
  savePaymentRequestToFirestore, 
  updatePaymentRequestStatusInFirestore, 
  fetchSubscriptionsFromFirestore, 
  saveSubscriptionToFirestore, 
  fetchExamResultsFromFirestore, 
  saveExamResultToFirestore, 
  fetchLeaderboardFromFirestore,
  saveLeaderboardEntryToFirestore,
  fetchPreviousQuestionsFromFirestore,
  savePreviousQuestionToFirestore,
  deletePreviousQuestionFromFirestore,
  batchImportPreviousQuestionsToFirestore,
  seedFirestoreIfEmpty,
  fetchUserProfileFromFirestore,
  checkIsAdminInFirestore,
  saveUserProfileToFirestore,
  updateUserRoleOrSubscriptionInFirestore
} from '../lib/firestoreService';

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
  exams: Exam[];
  examResults: ExamResult[];
  paymentRequests: PaymentRequest[];
  paymentSettings: PaymentSettings;
  updatePaymentSettings: (settings: Partial<PaymentSettings>) => void;
  supportSettings: SupportContactSettings;
  updateSupportSettings: (settings: Partial<SupportContactSettings>) => void;
  isFirebaseActive: boolean;
  firebaseProjectDetails: ReturnType<typeof getFirebaseProjectDetails>;
  auditLogs: AuditLog[];
  
  // Subscription Packages & Exam Date Config
  packages: SubscriptionPackage[];
  updatePackage: (pkg: Partial<SubscriptionPackage> & { id: string }) => void;
  examDateConfig: ExamDateConfig;
  updateExamDateConfig: (config: Partial<ExamDateConfig>) => void;
  subscriptions: UserSubscription[];
  activeSubscription: UserSubscription | null;
  calculateDaysRemaining: (expiresAt?: string) => number;
  adminUpdateUser: (params: {
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
    expiresAt?: string;
    isSessionRevoked?: boolean;
  }) => { success: boolean; message: string };
  
  // Single-Active-Session & Security
  currentSession: StudentSession | null;
  isSessionRevoked: boolean;
  sessionRevokedReason: string;
  simulateConcurrentLogin: () => void;
  recoverSession: () => void;
  
  // Screen Navigation
  activeScreen: 'landing' | 'dashboard' | 'exam' | 'practice' | 'result' | 'admin' | 'tests' | 'subjects' | 'history' | 'question_bank' | 'previous_questions';
  setActiveScreen: (screen: 'landing' | 'dashboard' | 'exam' | 'practice' | 'result' | 'admin' | 'tests' | 'subjects' | 'history' | 'question_bank' | 'previous_questions') => void;
  
  // Previous Year Questions
  previousQuestions: PreviousQuestion[];
  selectedPreviousYear: number | 'all';
  setSelectedPreviousYear: (year: number | 'all') => void;
  savePreviousQuestion: (question: PreviousQuestion) => Promise<void>;
  deletePreviousQuestion: (id: string) => Promise<void>;
  batchImportPreviousQuestions: (questions: PreviousQuestion[]) => Promise<{ successCount: number; failureCount: number; errors: string[] }>;

  // Exams & Custom Model Test
  activeAttempt: ExamAttempt | null;
  currentExamForAttempt: Exam | null;
  startExam: (examId: string) => { success: boolean; reason?: string };
  createAndStartCustomExam: (config: {
    titleBn?: string;
    titleEn?: string;
    durationMinutes: number;
    questionIds: string[];
    negativeMarkRatio?: number;
  }) => { success: boolean; examId?: string; reason?: string };
  showCustomTestModal: boolean;
  setShowCustomTestModal: (show: boolean) => void;
  saveActiveAnswer: (questionId: string, optionIndex: number) => void;
  clearActiveAnswer: (questionId: string) => void;
  toggleFlagQuestion: (questionId: string) => void;
  submitExamAttempt: (isAutoTimeout?: boolean) => ExamResult | null;
  
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
  getSubjectProgress: (subjectId: string) => SubjectPracticeProgress;
  
  // Questions & Exams CRUD
  addQuestion: (q: Omit<Question, 'id' | 'createdAt' | 'updatedAt'>) => void;
  updateQuestion: (q: Question) => void;
  deleteQuestion: (id: string) => void;
  addExam: (exam: Omit<Exam, 'id' | 'createdAt'>) => void;
  updateExam: (exam: Exam) => void;
  toggleExamStatus: (examId: string, isActive?: boolean, scheduledDate?: string) => void;
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
    amount: number; 
    packageId: string;
    packageTitle?: string; 
  }) => { success: boolean; error?: string };
  approvePaymentRequest: (id: string) => { success: boolean; error?: string };
  rejectPaymentRequest: (id: string, reason: string) => { success: boolean; error?: string };
  
  // UI Modals & Auth
  isLoggedIn: boolean;
  isVerifiedAdmin: boolean;
  loginWithGoogle: () => Promise<{ success: boolean; error?: string }>;
  loginWithEmail: (email: string, password: string, isSignUp?: boolean, candidateName?: string) => Promise<{ success: boolean; error?: string }>;
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

// Storage Keys
const LOCAL_STORAGE_KEY_ATTEMPT = 'barprep_bd_active_attempt';
const LOCAL_STORAGE_KEY_RESULTS = 'barprep_bd_exam_results';
const LOCAL_STORAGE_KEY_PAYMENTS = 'barprep_bd_payment_requests';
const LOCAL_STORAGE_KEY_QUESTIONS = 'barprep_bd_custom_questions';
const LOCAL_STORAGE_KEY_PAYMENT_SETTINGS = 'barprep_bd_payment_settings';
const LOCAL_STORAGE_KEY_SUPPORT_SETTINGS = 'barprep_bd_support_settings';
const LOCAL_STORAGE_KEY_PACKAGES = 'barprep_bd_subscription_packages';
const LOCAL_STORAGE_KEY_EXAM_CONFIG = 'barprep_bd_exam_date_config';
const LOCAL_STORAGE_KEY_SUBSCRIPTIONS = 'barprep_bd_user_subscriptions';
const LOCAL_STORAGE_KEY_SESSION = 'barprep_bd_current_session';
const LOCAL_STORAGE_KEY_EXAMS = 'sanadprep_bd_exams';
const LOCAL_STORAGE_KEY_ANSWERED_QUESTIONS = 'sanadprep_answered_questions';
const LOCAL_STORAGE_KEY_LEADERBOARD = 'sanadprep_bd_leaderboard';
const LOCAL_STORAGE_KEY_PREVIOUS_QUESTIONS = 'sanadprep_previous_questions';

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
  
  // 3,000 MCQ Questions partitioned for 30 Model Tests
  const [questions, setQuestions] = useState<Question[]>(() => {
    try {
      const saved = localStorage.getItem(LOCAL_STORAGE_KEY_QUESTIONS);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length >= 3000) {
          return parsed;
        }
      }
    } catch (e) {}
    return INITIAL_QUESTIONS;
  });

  const [exams, setExams] = useState<Exam[]>(() => {
    try {
      const saved = localStorage.getItem(LOCAL_STORAGE_KEY_EXAMS);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length >= 30) {
          const test1 = parsed.find((e: Exam) => e.id === 'exam_model_test_01');
          if (test1 && test1.questionIds && test1.questionIds.length === 100) {
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
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    return [];
  });

  // Top Performers Leaderboard
  const [leaderboardEntries, setLeaderboardEntries] = useState<LeaderboardEntry[]>(() => {
    try {
      const saved = localStorage.getItem(LOCAL_STORAGE_KEY_LEADERBOARD);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch (e) {}
    return INITIAL_LEADERBOARD_ENTRIES;
  });

  // Packages (Monthly Pass, Pro Mock Pass, Exam Pass, Long Course Pass)
  const [packages, setPackages] = useState<SubscriptionPackage[]>(() => {
    try {
      const saved = localStorage.getItem(LOCAL_STORAGE_KEY_PACKAGES);
      if (saved) {
        const parsed: SubscriptionPackage[] = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.some(p => p.id === 'pkg_monthly') && parsed.length >= 4) {
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
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    return INITIAL_EXAM_DATE_CONFIG;
  });

  // Subscriptions Ledger (Loaded strictly from Firestore for authenticated session)
  const [subscriptions, setSubscriptions] = useState<UserSubscription[]>([]);

  // Payment Settings (Configurable bKash & Nagad numbers)
  const [paymentSettings, setPaymentSettings] = useState<PaymentSettings>(() => {
    try {
      const saved = localStorage.getItem(LOCAL_STORAGE_KEY_PAYMENT_SETTINGS);
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    return {
      bkashNumber: '01712607777',
      nagadNumber: '01712607777',
      packagePrice: 300,
      instructionsBn: 'বিকাশ বা নগদ সেন্ড মানি (Personal) করে ট্রানজেকশন আইডি দিন।',
      instructionsEn: 'Send Money to the bKash or Nagad Personal number above and submit your TrxID.',
      whatsappNumber: '+8801671819027',
      whatsappMessage: 'Hello Sanad Prep BD Support, I need help with my account or subscription.'
    };
  });

  // Support Contact Settings (Configurable WhatsApp Support)
  const [supportSettings, setSupportSettings] = useState<SupportContactSettings>(() => {
    try {
      const saved = localStorage.getItem(LOCAL_STORAGE_KEY_SUPPORT_SETTINGS);
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    return {
      whatsappNumber: '+8801671819027',
      whatsappMessage: 'Hello Sanad Prep BD Support, I need help with my account or subscription.'
    };
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

  const [activeScreen, setActiveScreen] = useState<'landing' | 'dashboard' | 'exam' | 'practice' | 'result' | 'admin' | 'tests' | 'subjects' | 'history' | 'question_bank' | 'previous_questions'>('landing');
  const [selectedPreviousYear, setSelectedPreviousYear] = useState<number | 'all'>('all');
  const [previousQuestions, setPreviousQuestions] = useState<PreviousQuestion[]>(() => {
    try {
      const saved = localStorage.getItem(LOCAL_STORAGE_KEY_PREVIOUS_QUESTIONS);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch (e) {}
    return INITIAL_PREVIOUS_QUESTIONS;
  });
  const [showCustomTestModal, setShowCustomTestModal] = useState<boolean>(false);
  const [activeAttempt, setActiveAttempt] = useState<ExamAttempt | null>(() => {
    try {
      const saved = localStorage.getItem(LOCAL_STORAGE_KEY_ATTEMPT);
      if (saved) {
        const parsed: ExamAttempt = JSON.parse(saved);
        if (parsed.status === 'in_progress') return parsed;
      }
    } catch (e) {}
    return null;
  });

  const [activeResult, setActiveResult] = useState<ExamResult | null>(null);
  const [selectedSubjectForPractice, setSelectedSubjectForPractice] = useState<Subject | null>(null);
  
  const [showPaymentModal, setShowPaymentModal] = useState<boolean>(false);
  const [selectedPackageForPayment, setSelectedPackageForPayment] = useState<SubscriptionPackage | null>(packages[0]);
  const [showFirebaseGuide, setShowFirebaseGuide] = useState<boolean>(false);
  const [showTestRunner, setShowTestRunner] = useState<boolean>(false);
  const [isSubmittingExam, setIsSubmittingExam] = useState<boolean>(false);

  const [isLoggedIn, setIsLoggedIn] = useState<boolean>(false);
  const [isVerifiedAdmin, setIsVerifiedAdmin] = useState<boolean>(false);
  const [showLoginModal, setShowLoginModal] = useState<boolean>(false);
  const [showSearchModal, setShowSearchModal] = useState<boolean>(false);
  const [showInfoModal, setShowInfoModal] = useState<'about' | 'syllabus' | 'rules' | 'books' | null>(null);

  // Student's Answered Questions Ledger for Subject Practice Completion Progress
  const [answeredQuestions, setAnsweredQuestions] = useState<Record<string, AnsweredQuestionRecord>>(() => {
    try {
      const saved = localStorage.getItem(LOCAL_STORAGE_KEY_ANSWERED_QUESTIONS);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === 'object') return parsed;
      }
    } catch (e) {}

    // Seed realistic sample practice progress across subjects based on initial questions
    const initialSeed: Record<string, AnsweredQuestionRecord> = {};
    const sampleQuestions = INITIAL_QUESTIONS.slice(0, 48);
    sampleQuestions.forEach((q, idx) => {
      initialSeed[q.id] = {
        questionId: q.id,
        subjectId: q.subjectId,
        selectedOption: idx % 6 === 0 ? (q.correctOptionIndex + 1) % 4 : q.correctOptionIndex,
        isCorrect: idx % 6 !== 0,
        timestamp: new Date(Date.now() - (idx + 1) * 3600 * 1000).toISOString()
      };
    });
    return initialSeed;
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

  const loginWithEmail = async (
    email: string, 
    password: string, 
    isSignUp = false, 
    candidateName?: string
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      if (!auth) {
        return { success: false, error: 'Firebase Authentication is not available.' };
      }
      const trimmedEmail = email.trim().toLowerCase();
      let userCredential;
      if (isSignUp) {
        userCredential = await createUserWithEmailAndPassword(auth, trimmedEmail, password);
      } else {
        userCredential = await signInWithEmailAndPassword(auth, trimmedEmail, password);
      }
      const fbUser = userCredential.user;
      const uid = fbUser.uid;
      const resolvedEmail = fbUser.email || trimmedEmail;
      const isOwner = isVerifiedOwnerAccount(fbUser);
      const isAdmin = isOwner || (await checkIsAdminInFirestore(uid));
      const resolvedName = fbUser.displayName || candidateName || (isOwner ? 'মো: খাইরুল আলম' : 'শিক্ষার্থী');
      const effectiveRole: UserRole = isAdmin ? 'admin' : 'student';

      let existingProfile = await fetchUserProfileFromFirestore(uid);
      if (!existingProfile) {
        const newProfile: UserProfile = {
          uid,
          name: resolvedName,
          email: resolvedEmail,
          phone: fbUser.phoneNumber || '',
          role: effectiveRole,
          subscriptionStatus: 'free',
          createdAt: new Date().toISOString()
        };
        await saveUserProfileToFirestore(newProfile);
        existingProfile = newProfile;
      } else {
        existingProfile = { ...existingProfile, role: effectiveRole };
        if (isOwner && existingProfile.role !== 'admin') {
          await updateUserRoleOrSubscriptionInFirestore(uid, { role: 'admin' }).catch(() => {});
        }
      }

      setIsVerifiedAdmin(isAdmin);
      setCurrentUser(existingProfile);
      setIsLoggedIn(true);
      setCurrentSession({
        sessionId: `sess_${Date.now()}_${uid.slice(0, 6)}`,
        userId: uid,
        userEmail: resolvedEmail,
        userName: existingProfile.name,
        deviceInfo: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 60) : 'Web Browser',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active'
      });

      try {
        const [userPayments, userSubs, userResults] = await Promise.all([
          fetchPaymentRequestsFromFirestore(uid, isAdmin),
          fetchSubscriptionsFromFirestore(uid, isAdmin),
          fetchExamResultsFromFirestore(uid, isAdmin)
        ]);
        setPaymentRequests(userPayments || []);
        setSubscriptions(userSubs || []);
        setExamResults(userResults || []);
        const now = Date.now();
        const hasActiveSub = (userSubs || []).some(s => s.userId === uid && s.status === 'active' && new Date(s.expiresAt).getTime() > now);
        if (hasActiveSub && existingProfile.subscriptionStatus !== 'pro') {
          setCurrentUser(prev => ({ ...prev, subscriptionStatus: 'pro' }));
        }
        const dbExams = await fetchExamsFromFirestore(hasActiveSub || isAdmin);
        if (dbExams && dbExams.length > 0) setExams(dbExams);
      } catch (err) {
        console.warn('Post-login Firestore sync notice:', err);
      }

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
    }
  };

  const loginWithGoogle = async (): Promise<{ success: boolean; error?: string }> => {
    try {
      if (!auth || !googleProvider) {
        return { success: false, error: 'Firebase Authentication is not available.' };
      }
      const result = await signInWithPopup(auth, googleProvider);
      const fbUser = result.user;
      const uid = fbUser.uid;
      const email = fbUser.email || '';
      const name = fbUser.displayName || 'ব্যবহারকারী';
      const phone = fbUser.phoneNumber || '';

      const isOwner = isVerifiedOwnerAccount(fbUser);
      const isAdmin = isOwner || (await checkIsAdminInFirestore(uid));
      const effectiveRole: UserRole = isAdmin ? 'admin' : 'student';

      let existingProfile = await fetchUserProfileFromFirestore(uid);
      if (!existingProfile) {
        const newProfile: UserProfile = {
          uid,
          name,
          email,
          phone,
          role: effectiveRole,
          subscriptionStatus: 'free',
          createdAt: new Date().toISOString()
        };
        await saveUserProfileToFirestore(newProfile);
        existingProfile = newProfile;
      } else {
        existingProfile = { ...existingProfile, role: effectiveRole };
        if (isOwner && existingProfile.role !== 'admin') {
          await updateUserRoleOrSubscriptionInFirestore(uid, { role: 'admin' }).catch(() => {});
        }
      }

      setIsVerifiedAdmin(isAdmin);
      setCurrentUser(existingProfile);
      setIsLoggedIn(true);
      setCurrentSession({
        sessionId: `sess_${Date.now()}_${uid.slice(0, 6)}`,
        userId: uid,
        userEmail: email,
        userName: existingProfile.name,
        deviceInfo: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 60) : 'Web Browser',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active'
      });

      // Fetch user-scoped records from Firestore
      try {
        const [userPayments, userSubs, userResults] = await Promise.all([
          fetchPaymentRequestsFromFirestore(uid, isAdmin),
          fetchSubscriptionsFromFirestore(uid, isAdmin),
          fetchExamResultsFromFirestore(uid, isAdmin)
        ]);

        setPaymentRequests(userPayments || []);
        setSubscriptions(userSubs || []);
        setExamResults(userResults || []);
        const now = Date.now();
        const hasActiveSub = (userSubs || []).some(s => s.userId === uid && s.status === 'active' && new Date(s.expiresAt).getTime() > now);
        if (hasActiveSub && existingProfile.subscriptionStatus !== 'pro') {
          setCurrentUser(prev => ({ ...prev, subscriptionStatus: 'pro' }));
        }
        const dbExams = await fetchExamsFromFirestore(hasActiveSub || isAdmin);
        if (dbExams && dbExams.length > 0) setExams(dbExams);
      } catch (err) {
        console.warn('Post-login Firestore sync notice:', err);
      }

      if (isAdmin) {
        setActiveScreen('admin');
      } else {
        setActiveScreen('dashboard');
      }
      return { success: true };
    } catch (err: any) {
      console.error('Google Sign-In failed:', err);
      return { success: false, error: err?.message || 'Google Sign-In failed' };
    }
  };

  const logoutUser = () => {
    if (auth) {
      signOut(auth).catch(e => console.warn('Firebase sign out notice:', e));
    }
    setIsLoggedIn(false);
    setIsVerifiedAdmin(false);
    setCurrentUser(createGuestUserProfile());
    setSubscriptions([]);
    setPaymentRequests([]);
    setExamResults([]);
    setCurrentSession(null);
    setActiveAttempt(null);
    setActiveScreen('landing');
    try {
      localStorage.removeItem('sanadprep_is_logged_in');
      localStorage.removeItem(LOCAL_STORAGE_KEY_RESULTS);
      localStorage.removeItem(LOCAL_STORAGE_KEY_PAYMENTS);
      localStorage.removeItem(LOCAL_STORAGE_KEY_SUBSCRIPTIONS);
      localStorage.removeItem(LOCAL_STORAGE_KEY_SESSION);
      localStorage.removeItem(LOCAL_STORAGE_KEY_ATTEMPT);
    } catch (e) {}
  };

  // Firebase Auth State Listener (Auto-restores session on page reload / navigation)
  useEffect(() => {
    if (!auth) return;
    const unsubscribe = onAuthStateChanged(auth, async (fbUser) => {
      if (fbUser) {
        const uid = fbUser.uid;
        const email = fbUser.email || '';
        const name = fbUser.displayName || 'ব্যবহারকারী';
        const phone = fbUser.phoneNumber || '';

        const isOwner = isVerifiedOwnerAccount(fbUser);
        const isAdmin = isOwner || (await checkIsAdminInFirestore(uid));
        const effectiveRole: UserRole = isAdmin ? 'admin' : 'student';
        const profile = await fetchUserProfileFromFirestore(uid);

        setIsVerifiedAdmin(isAdmin);

        if (profile) {
          const verifiedProfile = { ...profile, role: effectiveRole };
          if (isOwner && profile.role !== 'admin') {
            updateUserRoleOrSubscriptionInFirestore(uid, { role: 'admin' }).catch(() => {});
          }
          setCurrentUser(verifiedProfile);
        } else {
          const newProfile: UserProfile = {
            uid,
            name,
            email,
            phone,
            role: effectiveRole,
            subscriptionStatus: 'free',
            createdAt: new Date().toISOString()
          };
          saveUserProfileToFirestore(newProfile).catch(() => {});
          setCurrentUser(newProfile);
        }

        setCurrentSession(prev => prev && prev.userId === uid ? prev : {
          sessionId: `sess_${Date.now()}_${uid.slice(0, 6)}`,
          userId: uid,
          userEmail: email,
          userName: profile?.name || name,
          deviceInfo: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 60) : 'Web Browser',
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
          status: 'active'
        });

        setIsLoggedIn(true);

        // Fetch scoped data for the authenticated user
        try {
          const [userPayments, userSubs, userResults] = await Promise.all([
            fetchPaymentRequestsFromFirestore(uid, isAdmin),
            fetchSubscriptionsFromFirestore(uid, isAdmin),
            fetchExamResultsFromFirestore(uid, isAdmin)
          ]);
          setPaymentRequests(userPayments || []);
          setSubscriptions(userSubs || []);
          setExamResults(userResults || []);

          const hasActiveSub = (userSubs || []).some(
            s => s.userId === uid && s.status === 'active' && new Date(s.expiresAt).getTime() > Date.now()
          );
          const dbExams = await fetchExamsFromFirestore(hasActiveSub || isAdmin);
          if (dbExams && dbExams.length > 0) setExams(dbExams);
        } catch (e) {
          console.warn('Scoped user data load notice:', e);
        }
      } else {
        setIsLoggedIn(false);
        setIsVerifiedAdmin(false);
        setCurrentUser(createGuestUserProfile());
        setSubscriptions([]);
        setPaymentRequests([]);
        setCurrentSession(null);
        setActiveScreen(prev => (prev === 'admin' || prev === 'question_bank') ? 'landing' : prev);
        try {
          localStorage.removeItem('sanadprep_is_logged_in');
          localStorage.removeItem(LOCAL_STORAGE_KEY_PAYMENTS);
          localStorage.removeItem(LOCAL_STORAGE_KEY_SUBSCRIPTIONS);
          localStorage.removeItem(LOCAL_STORAGE_KEY_SESSION);
        } catch (e) {}
      }
    });

    return () => unsubscribe();
  }, []);

  // Synchronize public catalog with Firestore Database on Mount
  useEffect(() => {
    let isMounted = true;
    async function loadDatabaseData() {
      try {
        const dbQuestions = await fetchQuestionsFromFirestore();
        if (isMounted && dbQuestions && dbQuestions.length > 0) {
          setQuestions(dbQuestions);
        }

        const dbExams = await fetchExamsFromFirestore(false);
        if (isMounted && dbExams && dbExams.length > 0) {
          setExams(dbExams);
        }

        const dbLeaderboard = await fetchLeaderboardFromFirestore();
        if (isMounted && dbLeaderboard && dbLeaderboard.length > 0) {
          setLeaderboardEntries(prev => {
            const map = new Map<string, LeaderboardEntry>();
            prev.forEach(item => map.set(item.id, item));
            dbLeaderboard.forEach(item => map.set(item.id, item));
            const merged = Array.from(map.values());
            merged.sort((a, b) => b.score - a.score || a.timeSpentSeconds - b.timeSpentSeconds);
            return merged.map((e, idx) => ({ ...e, rank: idx + 1 }));
          });
        }

        const dbPrevQuestions = await fetchPreviousQuestionsFromFirestore();
        if (isMounted && dbPrevQuestions && dbPrevQuestions.length > 0) {
          setPreviousQuestions(dbPrevQuestions);
        }
      } catch (err) {
        console.warn('Initial Firestore database sync notice:', err);
      }
    }

    loadDatabaseData();
    return () => { isMounted = false; };
  }, []);

  // Sync to Storage
  useEffect(() => {
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY_PREVIOUS_QUESTIONS, JSON.stringify(previousQuestions));
    } catch (e) {}
  }, [previousQuestions]);

  useEffect(() => {
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY_QUESTIONS, JSON.stringify(questions));
    } catch (e) {}
  }, [questions]);

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
      localStorage.setItem(LOCAL_STORAGE_KEY_SUBSCRIPTIONS, JSON.stringify(subscriptions));
    } catch (e) {}
  }, [subscriptions]);

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
      localStorage.setItem(LOCAL_STORAGE_KEY_PAYMENTS, JSON.stringify(paymentRequests));
    } catch (e) {}
  }, [paymentRequests]);

  useEffect(() => {
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY_EXAMS, JSON.stringify(exams));
    } catch (e) {}
  }, [exams]);

  useEffect(() => {
    try {
      if (currentSession) {
        localStorage.setItem(LOCAL_STORAGE_KEY_SESSION, JSON.stringify(currentSession));
      }
    } catch (e) {}
  }, [currentSession]);

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

  // Refresh leaderboard from Firestore
  const refreshLeaderboard = async () => {
    try {
      const dbLeaderboard = await fetchLeaderboardFromFirestore();
      if (dbLeaderboard && dbLeaderboard.length > 0) {
        setLeaderboardEntries(prev => {
          const map = new Map<string, LeaderboardEntry>();
          prev.forEach(item => map.set(item.id, item));
          dbLeaderboard.forEach(item => map.set(item.id, item));
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

  // Update Package (Verified Owner Admin only)
  const updatePackage = (updated: Partial<SubscriptionPackage> & { id: string }) => {
    if (!isVerifiedOwnerAccount(auth?.currentUser)) return;
    setPackages(prev => prev.map(p => {
      if (p.id === updated.id) {
        return { ...p, ...updated, updatedAt: new Date().toISOString() };
      }
      return p;
    }));

    // If updating Exam Pass price, keep examDateConfig in sync
    if (updated.id === 'pkg_exam_pass' && updated.price !== undefined) {
      setExamDateConfig(prev => ({ ...prev, examPassPrice: Number(updated.price) }));
    }

    setAuditLogs(prev => [
      {
        id: `log_${Date.now()}`,
        userId: currentUser.uid,
        userName: currentUser.name,
        action: 'UPDATE_PACKAGE',
        details: `Updated package ID ${updated.id}: Price=৳${updated.price || 'same'}, Validity=${updated.durationDays || 'same'}d`,
        timestamp: new Date().toISOString()
      },
      ...prev
    ]);
  };

  // Update Exam Date Configuration & Apply Policy (Verified Owner Admin only)
  const updateExamDateConfig = (config: Partial<ExamDateConfig>) => {
    if (!isVerifiedOwnerAccount(auth?.currentUser)) return;
    const nextConfig = {
      ...examDateConfig,
      ...config,
      lastUpdated: new Date().toISOString()
    };
    setExamDateConfig(nextConfig);

    // Sync package C price
    if (config.examPassPrice !== undefined) {
      setPackages(prev => prev.map(p => p.id === 'pkg_exam_pass' ? { ...p, price: Number(config.examPassPrice) } : p));
    }

    // POLICY ENFORCEMENT:
    // If 'extend_all' policy and targetExamDate changed, update all existing active Exam Pass subscribers
    let affectedCount = 0;
    if (nextConfig.examDatePolicy === 'extend_all' && config.targetExamDate) {
      setSubscriptions(prev => prev.map(sub => {
        if (sub.packageId === 'pkg_exam_pass' && sub.status === 'active') {
          affectedCount++;
          return {
            ...sub,
            expiresAt: new Date(config.targetExamDate!).toISOString(),
            targetExamDateSnapshot: config.targetExamDate
          };
        }
        return sub;
      }));
    }

    setAuditLogs(prev => [
      {
        id: `log_${Date.now()}`,
        userId: currentUser.uid,
        userName: currentUser.name,
        action: 'UPDATE_EXAM_DATE_CONFIG',
        details: `Exam Date set to ${nextConfig.targetExamDate} (${nextConfig.timezone}). Policy: ${nextConfig.examDatePolicy}. Affected active subscribers: ${affectedCount}`,
        timestamp: new Date().toISOString()
      },
      ...prev
    ]);
  };

  const updatePaymentSettings = (settings: Partial<PaymentSettings>) => {
    if (!isVerifiedOwnerAccount(auth?.currentUser)) return;
    setPaymentSettings(prev => ({ ...prev, ...settings }));
    if (settings.whatsappNumber || settings.whatsappMessage) {
      setSupportSettings(prev => ({
        ...prev,
        ...(settings.whatsappNumber ? { whatsappNumber: settings.whatsappNumber } : {}),
        ...(settings.whatsappMessage ? { whatsappMessage: settings.whatsappMessage } : {})
      }));
    }
    setAuditLogs(prev => [
      {
        id: `log_${Date.now()}`,
        userId: currentUser.uid,
        userName: currentUser.name,
        action: 'UPDATE_PAYMENT_SETTINGS',
        details: `Updated Payment Numbers: bKash: ${settings.bkashNumber ?? paymentSettings.bkashNumber}, Nagad: ${settings.nagadNumber ?? paymentSettings.nagadNumber}`,
        timestamp: new Date().toISOString()
      },
      ...prev
    ]);
  };

  const updateSupportSettings = (settings: Partial<SupportContactSettings>) => {
    if (!isVerifiedOwnerAccount(auth?.currentUser)) return;
    setSupportSettings(prev => ({ ...prev, ...settings }));
    setPaymentSettings(prev => ({ ...prev, ...settings }));
    setAuditLogs(prev => [
      {
        id: `log_${Date.now()}`,
        userId: currentUser.uid,
        userName: currentUser.name,
        action: 'UPDATE_SUPPORT_SETTINGS',
        details: `Updated WhatsApp Support: ${settings.whatsappNumber ?? supportSettings.whatsappNumber}`,
        timestamp: new Date().toISOString()
      },
      ...prev
    ]);
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

  const recoverSession = () => {
    const freshSession: StudentSession = {
      sessionId: `sess_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      userId: currentUser.uid,
      userEmail: currentUser.email,
      userName: currentUser.name,
      deviceInfo: 'Verified Device (Dhaka, BD)',
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status: 'active'
    };
    setCurrentSession(freshSession);
    setIsSessionRevoked(false);
    setSessionRevokedReason('');
    setAuditLogs(prev => [
      {
        id: `log_${Date.now()}`,
        userId: currentUser.uid,
        userName: currentUser.name,
        action: 'SESSION_RECOVERED',
        details: `Single active session re-established: ${freshSession.sessionId}.`,
        timestamp: new Date().toISOString()
      },
      ...prev
    ]);
  };

  const currentExamForAttempt = activeAttempt 
    ? (exams.find(e => e.id === activeAttempt.examId) || null)
    : null;

  // Start exam with strict subscription & session verification
  const startExam = (examId: string): { success: boolean; reason?: string } => {
    // 1. Session Revocation Check
    if (isSessionRevoked || (currentSession && currentSession.status === 'revoked')) {
      return { 
        success: false, 
        reason: 'সেশনটি অন্য ডিভাইস থেকে ব্যবহারের কারণে বন্ধ করা হয়েছে। অনুগ্রহ করে পুনরায় লগইন করুন।' 
      };
    }

    const exam = exams.find(e => e.id === examId);
    if (!exam) return { success: false, reason: 'Exam not found' };

    // 2. Strict Subscription Check for Paid / Pro Exams
    if (exam.isPaid) {
      const hasValidSub = isProSubscribed;
      if (!hasValidSub) {
        openSubscriptionModal(packages[0]?.id);
        return { 
          success: false, 
          reason: 'এই স্পেশাল ৬০ মিনিটের পূর্ণাঙ্গ মডেল টেস্টটি আনলক করতে সক্রিয় প্রো সাবস্ক্রিপশন প্রয়োজন। আপনার সাবস্ক্রিপশনের মেয়াদ শেষ হয়েছে অথবা সক্রিয় নেই।' 
        };
      }

      // Check if Exam is Active/Launched by Admin
      if (exam.isActive === false && !isVerifiedOwnerAccount(auth?.currentUser)) {
        return {
          success: false,
          reason: 'এই মডেল টেস্টটি এখনো চালু করা হয়নি। অ্যাডমিন কর্তৃক নির্ধারিত দিনে পরীক্ষাটি চালু করা হবে।'
        };
      }
    }

    // 3. Custom Test Restriction: "অ্যাডমিন ছাড়া কেউ কাষ্টম টেষ্ট নিতে পারবে না।"
    if (exam.type === 'custom_test') {
      if (!isVerifiedOwnerAccount(auth?.currentUser)) {
        return {
          success: false,
          reason: 'অননুমোদিত: অ্যাডমিন ছাড়া কেউ কাস্টম টেস্ট নিতে পারবেন না। শিক্ষার্থীরা শুধুমাত্র অ্যাডমিন কর্তৃক পরিচালিত নির্ধারিত মডেল টেস্টে অংশ নিতে পারবে।'
        };
      }
    }

    const now = new Date();
    const durationMinutes = exam.durationMinutes || 60;
    const deadline = new Date(now.getTime() + durationMinutes * 60 * 1000);

    const newAttempt: ExamAttempt = {
      id: `attempt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      examId: exam.id,
      userId: auth?.currentUser?.uid || currentUser.uid || 'guest',
      sessionId: currentSession?.sessionId,
      studentName: currentUser.name,
      startTime: now.toISOString(),
      deadlineTime: deadline.toISOString(),
      status: 'in_progress',
      answers: {},
      flaggedQuestionIds: [],
      currentQuestionIndex: 0,
      lastSavedAt: now.toISOString()
    };

    setActiveAttempt(newAttempt);
    setActiveScreen('exam');

    setAuditLogs(prev => [
      {
        id: `log_${Date.now()}`,
        userId: auth?.currentUser?.uid || currentUser.uid || 'guest',
        userName: currentUser.name,
        action: 'START_EXAM',
        details: `Started exam "${exam.titleEn}" (Duration: ${durationMinutes}m, Session: ${currentSession?.sessionId?.substring(0, 8) || 'local'})`,
        timestamp: new Date().toISOString()
      },
      ...prev
    ]);

    return { success: true };
  };

  // Create & Start Custom Model Test directly from Question Bank
  const createAndStartCustomExam = (config: {
    titleBn?: string;
    titleEn?: string;
    durationMinutes: number;
    questionIds: string[];
    negativeMarkRatio?: number;
  }): { success: boolean; examId?: string; reason?: string } => {
    // Strict Admin Authorization Check via verified Firebase UID
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
      isPaid: false, // User's self-selected test
      isActive: true,
      published: true,
      releaseExplanationsImmediately: true,
      negativeMarkRatio: config.negativeMarkRatio ?? 0.25,
      positiveMarkRatio: 1.0,
      createdAt: new Date().toISOString()
    };

    // Add to exams state
    setExams(prev => [newCustomExam, ...prev]);
    saveExamToFirestore(newCustomExam).catch(e => console.warn('Firestore custom exam save notice:', e));

    const now = new Date();
    const durationMinutes = newCustomExam.durationMinutes || 30;
    const deadline = new Date(now.getTime() + durationMinutes * 60 * 1000);

    const newAttempt: ExamAttempt = {
      id: `attempt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      examId: newCustomExam.id,
      userId: currentUser.uid,
      sessionId: currentSession?.sessionId,
      studentName: currentUser.name,
      startTime: now.toISOString(),
      deadlineTime: deadline.toISOString(),
      status: 'in_progress',
      answers: {},
      flaggedQuestionIds: [],
      currentQuestionIndex: 0,
      lastSavedAt: now.toISOString()
    };

    setActiveAttempt(newAttempt);
    setActiveScreen('exam');

    setAuditLogs(prev => [
      {
        id: `log_${Date.now()}`,
        userId: currentUser.uid,
        userName: currentUser.name,
        action: 'START_CUSTOM_EXAM',
        details: `Started custom exam "${titleEn}" with ${config.questionIds.length} MCQs (Duration: ${durationMinutes}m)`,
        timestamp: new Date().toISOString()
      },
      ...prev
    ]);

    return { success: true, examId: testId };
  };

  const saveActiveAnswer = (questionId: string, optionIndex: number) => {
    if (isSessionRevoked) return;
    setActiveAttempt(prev => {
      if (!prev || prev.status !== 'in_progress') return prev;
      return {
        ...prev,
        answers: { ...prev.answers, [questionId]: optionIndex },
        lastSavedAt: new Date().toISOString()
      };
    });
  };

  const clearActiveAnswer = (questionId: string) => {
    if (isSessionRevoked) return;
    setActiveAttempt(prev => {
      if (!prev || prev.status !== 'in_progress') return prev;
      const updatedAnswers = { ...prev.answers };
      delete updatedAnswers[questionId];
      return {
        ...prev,
        answers: updatedAnswers,
        lastSavedAt: new Date().toISOString()
      };
    });
  };

  const toggleFlagQuestion = (questionId: string) => {
    setActiveAttempt(prev => {
      if (!prev || prev.status !== 'in_progress') return prev;
      const exists = prev.flaggedQuestionIds.includes(questionId);
      const flagged = exists 
        ? prev.flaggedQuestionIds.filter(id => id !== questionId)
        : [...prev.flaggedQuestionIds, questionId];
      return {
        ...prev,
        flaggedQuestionIds: flagged,
        lastSavedAt: new Date().toISOString()
      };
    });
  };

  // Submit exam attempt
  const submitExamAttempt = (isAutoTimeout = false): ExamResult | null => {
    if (!activeAttempt || activeAttempt.status !== 'in_progress') {
      return null;
    }

    if (isSessionRevoked) {
      alert('আপনার সেশনটি অন্য ডিভাইস থেকে ব্যবহারের কারণে বন্ধ করা হয়েছে। উত্তর জমা নেওয়া সম্ভব নয়।');
      return null;
    }

    setIsSubmittingExam(true);

    const exam = exams.find(e => e.id === activeAttempt.examId);
    if (!exam) {
      setIsSubmittingExam(false);
      return null;
    }

    const examQuestions = (exam.questionIds && exam.questionIds.length > 0)
      ? questions.filter(q => exam.questionIds.includes(q.id))
      : (exam.subjectId ? questions.filter(q => q.subjectId === exam.subjectId) : questions.slice(0, exam.totalMarks || 100));

    // Calculate score: +1 correct, -0.25 incorrect
    const scoreResult = calculateExamScore(activeAttempt.answers, examQuestions, {
      positiveMarkRatio: exam.positiveMarkRatio ?? 1.0,
      negativeMarkRatio: exam.negativeMarkRatio ?? 0.25,
      passThresholdPercentage: exam.passThresholdPercentage
    });

    const startTime = new Date(activeAttempt.startTime).getTime();
    const submissionTime = Date.now();
    const timeSpentSeconds = Math.max(1, Math.round((submissionTime - startTime) / 1000));

    // Subject-wise performance
    const subjectScores: ExamResult['subjectWiseScores'] = {};
    for (const sub of subjects) {
      const subQuestions = examQuestions.filter(q => q.subjectId === sub.id);
      if (subQuestions.length > 0) {
        let correct = 0;
        let incorrect = 0;
        let unanswered = 0;
        for (const q of subQuestions) {
          const ans = activeAttempt.answers[q.id];
          if (ans === undefined || ans === null) unanswered++;
          else if (ans === q.correctOptionIndex) correct++;
          else incorrect++;
        }
        const score = Math.round((correct * 1.0 - incorrect * 0.25) * 100) / 100;
        subjectScores[sub.id] = {
          subjectNameBn: sub.nameBn,
          subjectNameEn: sub.nameEn,
          total: subQuestions.length,
          correct,
          incorrect,
          unanswered,
          score
        };
      }
    }

    const newResult: ExamResult = {
      id: `result_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      attemptId: activeAttempt.id,
      examId: exam.id,
      examTitleBn: exam.titleBn,
      examTitleEn: exam.titleEn,
      examType: exam.type,
      userId: currentUser.uid,
      studentName: currentUser.name,
      submittedAt: new Date().toISOString(),
      timeSpentSeconds,
      totalQuestions: scoreResult.totalQuestions,
      correctAnswersCount: scoreResult.correctAnswersCount,
      incorrectAnswersCount: scoreResult.incorrectAnswersCount,
      unansweredCount: scoreResult.unansweredCount,
      positiveMarks: scoreResult.positiveMarks,
      negativeMarks: scoreResult.negativeMarks,
      finalScore: scoreResult.finalScore,
      percentage: scoreResult.percentage,
      passed: scoreResult.passed,
      passThresholdPercentage: exam.passThresholdPercentage,
      subjectWiseScores: subjectScores,
      answers: activeAttempt.answers,
      questions: examQuestions
    };

    setActiveAttempt(prev => prev ? {
      ...prev,
      status: isAutoTimeout ? 'timed_out' : 'submitted',
      submittedTime: new Date().toISOString()
    } : null);

    setExamResults(prev => [newResult, ...prev]);
    saveExamResultToFirestore(newResult).catch(e => console.warn('Firestore result save error:', e));

    // Record to Top Performers Leaderboard
    const newLeaderboardEntry: LeaderboardEntry = {
      id: `lead_${newResult.id}`,
      userId: currentUser.uid,
      studentName: currentUser.name,
      examId: exam.id,
      examTitleBn: exam.titleBn,
      examTitleEn: exam.titleEn,
      score: newResult.finalScore,
      totalMarks: newResult.totalQuestions,
      percentage: newResult.percentage,
      correctAnswersCount: newResult.correctAnswersCount,
      incorrectAnswersCount: newResult.incorrectAnswersCount,
      unansweredCount: newResult.unansweredCount,
      timeSpentSeconds,
      completedAt: new Date().toISOString()
    };
    setLeaderboardEntries(prev => {
      const filtered = prev.filter(item => !(item.userId === currentUser.uid && item.examId === exam.id));
      const list = [...filtered, newLeaderboardEntry];
      list.sort((a, b) => b.score - a.score || a.timeSpentSeconds - b.timeSpentSeconds);
      return list.map((item, idx) => ({ ...item, rank: idx + 1 }));
    });
    saveLeaderboardEntryToFirestore(newLeaderboardEntry).catch(e => console.warn('Firestore leaderboard entry save error:', e));

    setActiveResult(newResult);
    setActiveScreen('result');

    // Sync answered questions into student's subject practice progress ledger
    setAnsweredQuestions(prev => {
      const next = { ...prev };
      for (const q of examQuestions) {
        const userChoice = activeAttempt.answers[q.id];
        if (userChoice !== undefined && userChoice !== null) {
          next[q.id] = {
            questionId: q.id,
            subjectId: q.subjectId,
            selectedOption: userChoice,
            isCorrect: userChoice === q.correctOptionIndex,
            timestamp: new Date().toISOString()
          };
        }
      }
      return next;
    });

    try {
      localStorage.removeItem(LOCAL_STORAGE_KEY_ATTEMPT);
    } catch (e) {}

    setAuditLogs(prev => [
      {
        id: `log_${Date.now()}`,
        userId: currentUser.uid,
        userName: currentUser.name,
        action: isAutoTimeout ? 'EXAM_TIMED_OUT' : 'SUBMIT_EXAM',
        details: `Completed "${exam.titleEn}". Score: ${newResult.finalScore}/${newResult.totalQuestions} (${newResult.percentage}%)`,
        timestamp: new Date().toISOString()
      },
      ...prev
    ]);

    setIsSubmittingExam(false);
    return newResult;
  };

  const viewResult = (resultId: string) => {
    const res = examResults.find(r => r.id === resultId);
    if (res) {
      setActiveResult(res);
      setActiveScreen('result');
    }
  };

  const startSubjectPractice = (subjectId: string): { success: boolean; reason?: string } => {
    // Subject practice is a Pro feature ("সিলেবাস কাঠামো - ৭টি মূল আইনের বিষয়ভিত্তিক অনুশীলন - এটাও পেইড করার পর অনুশীলন করতে পারবে।")
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

  const getSubjectProgress = useCallback((subjectId: string): SubjectPracticeProgress => {
    const subQuestions = questions.filter(q => q.subjectId === subjectId);
    const totalQuestions = subQuestions.length > 0 ? subQuestions.length : 1;
    let answeredCount = 0;
    let correctCount = 0;
    let incorrectCount = 0;

    for (const q of subQuestions) {
      const record = answeredQuestions[q.id];
      if (record) {
        answeredCount++;
        if (record.isCorrect) {
          correctCount++;
        } else {
          incorrectCount++;
        }
      }
    }

    const percentage = Math.min(100, Math.round((answeredCount / totalQuestions) * 100));
    const accuracy = answeredCount > 0 ? Math.round((correctCount / answeredCount) * 100) : 0;

    return {
      subjectId,
      totalQuestions: subQuestions.length,
      answeredCount,
      correctCount,
      incorrectCount,
      percentage,
      accuracy
    };
  }, [questions, answeredQuestions]);

  const addQuestion = (newQ: Omit<Question, 'id' | 'createdAt' | 'updatedAt'>) => {
    if (!isVerifiedOwnerAccount(auth?.currentUser) && !isVerifiedAdmin) return;
    const created: Question = {
      ...newQ,
      id: `q_custom_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: currentUser.name
    };
    setQuestions(prev => [created, ...prev]);
    saveQuestionToFirestore(created).catch(e => console.warn('Firestore question save error:', e));
  };

  const updateQuestion = (updated: Question) => {
    if (!isVerifiedOwnerAccount(auth?.currentUser) && !isVerifiedAdmin) return;
    setQuestions(prev => prev.map(q => q.id === updated.id ? { ...updated, updatedAt: new Date().toISOString() } : q));
    saveQuestionToFirestore(updated).catch(e => console.warn('Firestore question update error:', e));
  };

  const deleteQuestion = (id: string) => {
    if (!isVerifiedOwnerAccount(auth?.currentUser) && !isVerifiedAdmin) return;
    setQuestions(prev => prev.filter(q => q.id !== id));
    deleteQuestionFromFirestore(id).catch(e => console.warn('Firestore question delete error:', e));
  };

  const savePreviousQuestion = async (question: PreviousQuestion): Promise<void> => {
    if (!isVerifiedOwnerAccount(auth?.currentUser) && !isVerifiedAdmin) return;
    const exists = previousQuestions.some(q => q.id === question.id);
    if (exists) {
      setPreviousQuestions(prev => prev.map(q => q.id === question.id ? question : q));
    } else {
      setPreviousQuestions(prev => [question, ...prev]);
    }
    await savePreviousQuestionToFirestore(question);
  };

  const deletePreviousQuestion = async (id: string): Promise<void> => {
    if (!isVerifiedOwnerAccount(auth?.currentUser) && !isVerifiedAdmin) return;
    setPreviousQuestions(prev => prev.filter(q => q.id !== id));
    await deletePreviousQuestionFromFirestore(id);
  };

  const batchImportPreviousQuestions = async (
    newQuestions: PreviousQuestion[]
  ): Promise<{ successCount: number; failureCount: number; errors: string[] }> => {
    if (!isVerifiedOwnerAccount(auth?.currentUser) && !isVerifiedAdmin) {
      return { successCount: 0, failureCount: newQuestions.length, errors: ['Unauthorized: Admin verification required.'] };
    }
    // Optimistically merge into local state
    setPreviousQuestions(prev => {
      const map = new Map<string, PreviousQuestion>();
      newQuestions.forEach(q => map.set(q.id, q));
      prev.forEach(q => {
        if (!map.has(q.id)) {
          map.set(q.id, q);
        }
      });
      return Array.from(map.values()).sort((a, b) => b.year - a.year);
    });

    // Write batch directly to Firestore
    const res = await batchImportPreviousQuestionsToFirestore(newQuestions);
    return res;
  };

  const addExam = (newExam: Omit<Exam, 'id' | 'createdAt'>) => {
    if (!isVerifiedOwnerAccount(auth?.currentUser) && !isVerifiedAdmin) return;
    const created: Exam = {
      ...newExam,
      id: `exam_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      createdAt: new Date().toISOString()
    };
    setExams(prev => [...prev, created]);
    saveExamToFirestore(created).catch(e => console.warn('Firestore exam save error:', e));
  };

  const updateExam = (updated: Exam) => {
    if (!isVerifiedOwnerAccount(auth?.currentUser) && !isVerifiedAdmin) return;
    setExams(prev => prev.map(e => e.id === updated.id ? updated : e));
    saveExamToFirestore(updated).catch(e => console.warn('Firestore exam update error:', e));
  };

  const toggleExamStatus = (examId: string, isActive?: boolean, scheduledDate?: string) => {
    if (!isVerifiedOwnerAccount(auth?.currentUser) && !isVerifiedAdmin) return;
    setExams(prev => prev.map(e => {
      if (e.id === examId) {
        const nextActive = isActive !== undefined ? isActive : !e.isActive;
        const updated: Exam = {
          ...e,
          isActive: nextActive,
          published: nextActive ? true : e.published,
          scheduledDate: scheduledDate !== undefined ? scheduledDate : e.scheduledDate
        };
        saveExamToFirestore(updated).catch(err => console.warn('Firestore exam status update error:', err));
        return updated;
      }
      return e;
    }));

    const target = exams.find(e => e.id === examId);
    const nextActive = isActive !== undefined ? isActive : (target ? !target.isActive : true);
    setAuditLogs(prev => [
      {
        id: `log_${Date.now()}`,
        userId: currentUser.uid,
        userName: currentUser.name,
        action: nextActive ? 'LAUNCH_EXAM' : 'DEACTIVATE_EXAM',
        details: `${nextActive ? 'Launched' : 'Deactivated'} exam ${examId} (${target?.titleEn || 'Model Test'}) - Scheduled: ${scheduledDate || target?.scheduledDate || 'Immediate'}`,
        timestamp: new Date().toISOString()
      },
      ...prev
    ]);
  };

  const generateAndSync30ModelTests = async (): Promise<{ success: boolean; count: number; message: string }> => {
    if (!isVerifiedOwnerAccount(auth?.currentUser) && !isVerifiedAdmin) {
      return { success: false, count: 0, message: 'অননুমোদিত: শুধুমাত্র অ্যাডমিন মডেল টেস্ট সিঙ্ক করতে পারবেন।' };
    }
    const freshQuestions = questions.length >= 3000 ? questions : INITIAL_QUESTIONS;
    const generated = generate30ModelTests(freshQuestions);
    const nonModelExams = exams.filter(e => e.type !== 'full_mock');
    const updatedExams = [...generated, ...nonModelExams];
    setExams(updatedExams);
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY_EXAMS, JSON.stringify(updatedExams));
    } catch (e) {}
    return {
      success: true,
      count: generated.length,
      message: '৩০টি পূর্ণাঙ্গ মডেল টেস্ট সফলভাবে প্রস্তুত ও সমন্বিত হয়েছে।'
    };
  };

  // Create Payment Request (Requires verified Firebase sign-in)
  const createPaymentRequest = (req: { 
    method: 'bKash' | 'Nagad' | 'Rocket'; 
    studentPhone?: string;
    senderNumber: string; 
    transactionId: string; 
    amount: number; 
    packageId: string;
    packageTitle?: string; 
  }): { success: boolean; error?: string } => {
    const authenticatedUid = auth?.currentUser?.uid;
    if (!isLoggedIn || !authenticatedUid) {
      return { success: false, error: 'পেমেন্ট রিকোয়েস্ট পাঠাতে অনুগ্রহ করে প্রথমে আপনার অ্যাকাউন্টে লগইন করুন।' };
    }

    const cleanTrxId = req.transactionId.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (cleanTrxId.length < 4) {
      return { success: false, error: 'সঠিক ট্রানজাকশন আইডি (TrxID) প্রদান করুন (কমপক্ষে ৪ অক্ষর)।' };
    }

    // Prevent duplicate TrxID reuse across all requests
    const duplicate = paymentRequests.find(
      p => p.transactionId === cleanTrxId && p.status !== 'rejected'
    );
    if (duplicate) {
      return { 
        success: false, 
        error: 'এই ট্রানজাকশন আইডিটি (TrxID) ইতিপূর্বে জমা দেওয়া হয়েছে। একই TrxID পুনরাবৃত্তি গ্রহণযোগ্য নয়।' 
      };
    }

    const pkg = packages.find(p => p.id === req.packageId) || packages[0];
    const durationDays = pkg.durationDays || (pkg.validityType === 'exam_date' ? calculateDaysRemaining(examDateConfig.targetExamDate) : 90);

    const newReq: PaymentRequest = {
      id: `trx_${cleanTrxId}`,
      userId: authenticatedUid,
      studentName: currentUser.name,
      studentPhone: req.studentPhone || currentUser.phone,
      method: req.method,
      senderNumber: req.senderNumber,
      transactionId: cleanTrxId,
      amount: req.amount,
      packageId: pkg.id,
      packageNameBn: pkg.nameBn,
      packageNameEn: pkg.nameEn,
      packageTitle: req.packageTitle || `${pkg.nameBn} - ৳${req.amount}`,
      durationDays,
      validityType: pkg.validityType,
      status: 'pending',
      requestedAt: new Date().toISOString()
    };

    setPaymentRequests(prev => [newReq, ...prev]);
    savePaymentRequestToFirestore(newReq).catch(e => console.warn('Firestore payment save notice:', e));

    setAuditLogs(prev => [
      {
        id: `log_${Date.now()}`,
        userId: authenticatedUid,
        userName: currentUser.name,
        action: 'PAYMENT_REQUEST_SUBMITTED',
        details: `${req.method} TrxID: ${newReq.transactionId} (৳${req.amount}) submitted for package "${pkg.nameEn}". Pending manual admin verification.`,
        timestamp: new Date().toISOString()
      },
      ...prev
    ]);

    return { success: true };
  };

  // Approve Payment Request & Atomically Activate Subscription
  const approvePaymentRequest = (id: string): { success: boolean; error?: string } => {
    // 1. Authorization: Strictly verified owner Firebase UID only
    if (!isVerifiedOwnerAccount(auth?.currentUser)) {
      return { success: false, error: 'অননুমোদিত চেষ্টা: শুধুমাত্র যাচাইকৃত সুপার অ্যাডমিন পেমেন্ট অনুমোদন করতে পারবেন।' };
    }

    const req = paymentRequests.find(r => r.id === id);
    if (!req) return { success: false, error: 'Payment request not found' };

    if (req.status === 'approved') {
      return { success: false, error: 'Payment request is already approved' };
    }

    // Check if TrxID was already used in another approved transaction
    const duplicateApproved = paymentRequests.find(
      p => p.id !== id && p.transactionId === req.transactionId && p.status === 'approved'
    );
    if (duplicateApproved) {
      return { 
        success: false, 
        error: 'এই ট্রানজাকশন আইডিটি (TrxID) ইতিপূর্বে আরেকটি পেমেন্টে অনুমোদিত হয়েছে! একই TrxID পুনরাবৃত্তি রোধ করা হলো।' 
      };
    }

    const pkg = packages.find(p => p.id === req.packageId) || {
      id: req.packageId,
      nameBn: req.packageNameBn,
      nameEn: req.packageNameEn,
      validityType: req.validityType || 'days',
      durationDays: req.durationDays || 90
    };

    // Calculate exact expiry
    const activatedAt = new Date().toISOString();
    let expiresAt: string;

    if (pkg.validityType === 'exam_date') {
      expiresAt = new Date(examDateConfig.targetExamDate).toISOString();
    } else {
      const days = pkg.durationDays || 90;
      expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    }

    // Create Subscription record strictly for req.userId
    const newSubscription: UserSubscription = {
      id: `sub_${req.userId}_${req.transactionId}`,
      userId: req.userId,
      studentName: req.studentName,
      studentPhone: req.studentPhone,
      packageId: req.packageId,
      packageNameBn: req.packageNameBn,
      packageNameEn: req.packageNameEn,
      pricePaid: req.amount,
      paymentRequestId: req.id,
      paymentMethod: req.method as 'bKash' | 'Nagad',
      transactionId: req.transactionId,
      activatedAt,
      expiresAt,
      validityType: pkg.validityType as 'days' | 'exam_date',
      status: 'active',
      targetExamDateSnapshot: pkg.validityType === 'exam_date' ? examDateConfig.targetExamDate : undefined,
      createdAt: activatedAt
    };

    setSubscriptions(prev => [newSubscription, ...prev]);
    saveSubscriptionToFirestore(newSubscription).catch(e => console.warn('Firestore subscription save notice:', e));

    const updatedPaymentApproval = {
      status: 'approved' as const,
      verifiedAt: activatedAt,
      verifiedBy: currentUser.name,
      subscriptionId: newSubscription.id
    };
    updatePaymentRequestStatusInFirestore(id, updatedPaymentApproval).catch(e => console.warn('Firestore payment status notice:', e));

    // Update payment request status
    setPaymentRequests(prev => prev.map(r => {
      if (r.id === id) {
        return {
          ...r,
          ...updatedPaymentApproval
        };
      }
      return r;
    }));

    // Persist pro subscription status strictly to req.userId document in Firestore
    if (req.userId) {
      updateUserRoleOrSubscriptionInFirestore(req.userId, {
        subscriptionStatus: 'pro',
        subscriptionExpiresAt: expiresAt,
        activePackageId: req.packageId,
        activePackageNameBn: req.packageNameBn,
        activePackageNameEn: req.packageNameEn
      }).catch(e => console.warn('Firestore student pro update notice:', e));
    }

    // Grant Pro status in local UI ONLY if req.userId strictly matches currentUser.uid
    if (req.userId === currentUser.uid) {
      setCurrentUser(prev => ({
        ...prev,
        subscriptionStatus: 'pro',
        subscriptionExpiresAt: expiresAt,
        activePackageId: req.packageId,
        activePackageNameBn: req.packageNameBn,
        activePackageNameEn: req.packageNameEn
      }));
    }

    setAuditLogs(prev => [
      {
        id: `log_${Date.now()}`,
        userId: currentUser.uid,
        userName: currentUser.name,
        action: 'PAYMENT_APPROVED',
        details: `Payment ID ${id} (TrxID: ${req.transactionId}) manually approved for UID ${req.userId}. Activated "${pkg.nameEn}" until ${new Date(expiresAt).toLocaleDateString()}.`,
        timestamp: new Date().toISOString()
      },
      ...prev
    ]);

    return { success: true };
  };

  const rejectPaymentRequest = (id: string, reason: string): { success: boolean; error?: string } => {
    // 1. Authorization: Strictly verified owner Firebase UID only
    if (!isVerifiedOwnerAccount(auth?.currentUser)) {
      return { success: false, error: 'অননুমোদিত চেষ্টা: শুধুমাত্র যাচাইকৃত সুপার অ্যাডমিন পেমেন্ট বাতিল করতে পারবেন।' };
    }

    const req = paymentRequests.find(r => r.id === id);
    const rejectionUpdates = {
      status: 'rejected' as const,
      rejectionReason: reason,
      verifiedAt: new Date().toISOString(),
      verifiedBy: currentUser.name
    };

    updatePaymentRequestStatusInFirestore(id, rejectionUpdates).catch(e => console.warn('Firestore payment reject notice:', e));

    setPaymentRequests(prev => prev.map(r => {
      if (r.id === id) {
        return {
          ...r,
          ...rejectionUpdates
        };
      }
      return r;
    }));

    setAuditLogs(prev => [
      {
        id: `log_${Date.now()}`,
        userId: currentUser.uid,
        userName: currentUser.name,
        action: 'PAYMENT_REJECTED',
        details: `Payment ID ${id} (TrxID: ${req?.transactionId || 'N/A'}) rejected: ${reason}`,
        timestamp: new Date().toISOString()
      },
      ...prev
    ]);

    return { success: true };
  };

  const adminUpdateUser = (params: {
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
    expiresAt?: string;
    isSessionRevoked?: boolean;
  }): { success: boolean; message: string } => {
    // 0. Authorization: Strictly verified owner Firebase UID only
    if (!isVerifiedOwnerAccount(auth?.currentUser)) {
      return {
        success: false,
        message: 'অননুমোদিত চেষ্টা: শুধুমাত্র যাচাইকৃত সুপার অ্যাডমিন ব্যবহারকারীর তথ্য বা সাবস্ক্রিপশন পরিবর্তন করতে পারবেন।'
      };
    }

    // Prevent granting admin role to any account other than OWNER_ADMIN_UID
    const safeRole: UserRole = params.role === 'admin' && params.userId !== OWNER_ADMIN_UID
      ? 'student'
      : params.role;

    // 1. Update target user document in Firestore
    if (params.userId) {
      updateUserRoleOrSubscriptionInFirestore(params.userId, {
        name: params.name,
        phone: params.phone,
        role: safeRole,
        subscriptionStatus: params.subscriptionStatus,
        subscriptionExpiresAt: params.expiresAt,
        activePackageId: params.packageId,
        activePackageNameBn: params.packageNameBn,
        activePackageNameEn: params.packageNameEn
      }).catch(e => console.warn('Firestore user profile update notice:', e));
    }

    // 2. Update currentUser if matching UID
    if (params.userId === currentUser.uid) {
      setCurrentUser(prev => ({
        ...prev,
        name: params.name,
        email: params.email,
        phone: params.phone,
        role: safeRole,
        subscriptionStatus: params.subscriptionStatus,
        subscriptionExpiresAt: params.expiresAt,
        activePackageId: params.packageId,
        activePackageNameBn: params.packageNameBn,
        activePackageNameEn: params.packageNameEn
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

    // 3. Update subscription record in subscriptions ledger
    setSubscriptions(prev => {
      let found = false;
      const updatedList = prev.map(sub => {
        if (sub.userId === params.userId || (params.subscriptionId && sub.id === params.subscriptionId)) {
          found = true;
          const updatedSub: UserSubscription = {
            ...sub,
            studentName: params.name,
            studentPhone: params.phone,
            packageId: params.packageId || sub.packageId,
            packageNameBn: params.packageNameBn || sub.packageNameBn,
            packageNameEn: params.packageNameEn || sub.packageNameEn,
            status: params.subscriptionStatus === 'pro' ? 'active' : (params.subscriptionStatus === 'expired' ? 'expired' : 'cancelled'),
            expiresAt: params.expiresAt || sub.expiresAt
          };
          saveSubscriptionToFirestore(updatedSub).catch(e => console.warn('Firestore subscription update notice:', e));
          return updatedSub;
        }
        return sub;
      });

      // If user had no subscription record yet and is given Pro status
      if (!found && params.subscriptionStatus === 'pro') {
        const pkg = packages.find(p => p.id === params.packageId) || packages[0];
        const newSub: UserSubscription = {
          id: `sub_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          userId: params.userId,
          studentName: params.name,
          studentPhone: params.phone,
          packageId: pkg.id,
          packageNameBn: pkg.nameBn,
          packageNameEn: pkg.nameEn,
          pricePaid: pkg.price,
          paymentRequestId: `admin_grant_${Date.now()}`,
          paymentMethod: 'bKash',
          transactionId: `ADMIN_GRANT_${Date.now().toString().slice(-6)}`,
          activatedAt: new Date().toISOString(),
          expiresAt: params.expiresAt || new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString(),
          validityType: pkg.validityType as 'days' | 'exam_date',
          status: 'active',
          createdAt: new Date().toISOString()
        };
        saveSubscriptionToFirestore(newSub).catch(e => console.warn('Firestore subscription save notice:', e));
        return [newSub, ...updatedList];
      }

      return updatedList;
    });

    // 4. Update active session if present
    if (currentSession && currentSession.userId === params.userId) {
      setCurrentSession(prev => prev ? {
        ...prev,
        userName: params.name,
        userEmail: params.email,
        status: params.isSessionRevoked ? 'revoked' : 'active'
      } : null);
    }

    // 5. Audit Log
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
        previousQuestions,
        selectedPreviousYear,
        setSelectedPreviousYear,
        savePreviousQuestion,
        deletePreviousQuestion,
        batchImportPreviousQuestions,
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
        activeResult,
        viewResult,
        leaderboardEntries,
        refreshLeaderboard,
        isProSubscribed,
        selectedSubjectForPractice,
        startSubjectPractice,
        answeredQuestions,
        recordQuestionAnswer,
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
        isVerifiedAdmin,
        loginWithGoogle,
        loginWithEmail,
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
