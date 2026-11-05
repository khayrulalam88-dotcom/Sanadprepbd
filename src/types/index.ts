export type Language = 'bn' | 'en';

export type UserRole = 'student' | 'question_manager' | 'admin';

export interface UserSubscription {
  id: string;
  userId: string;
  studentName: string;
  studentPhone: string;
  packageId: string;
  packageNameBn: string;
  packageNameEn: string;
  pricePaid: number;
  paymentRequestId: string;
  paymentMethod: 'bKash' | 'Nagad';
  transactionId: string;
  activatedAt: string; // ISO string
  expiresAt: string; // ISO string
  validityType: 'days' | 'exam_date';
  status: 'active' | 'expired' | 'cancelled';
  targetExamDateSnapshot?: string;
  createdAt: string;
}

export interface StudentSession {
  sessionId: string;
  userId: string;
  userEmail: string;
  userName: string;
  deviceInfo: string;
  createdAt: string;
  lastActiveAt: string;
  status: 'active' | 'revoked';
  revokedReason?: string;
}

export interface UserProfile {
  uid: string;
  name: string;
  email: string;
  phone: string;
  role: UserRole;
  subscriptionStatus: 'free' | 'pro' | 'expired';
  subscriptionExpiresAt?: string;
  activePackageId?: string;
  activePackageNameBn?: string;
  activePackageNameEn?: string;
  currentSubscription?: UserSubscription;
  currentSessionId?: string;
  createdAt: string;
  avatarUrl?: string;
}

export interface Subject {
  id: string;
  code: string;
  nameBn: string;
  nameEn: string;
  marksWeight: number; // e.g. 20 for CPC, 20 for CrPC, etc.
  totalQuestions: number;
  iconName: string;
  color: string;
  actTitle: string;
}

export interface Topic {
  id: string;
  subjectId: string;
  nameBn: string;
  nameEn: string;
  questionCount: number;
}

export interface AnsweredQuestionRecord {
  questionId: string;
  subjectId: string;
  selectedOption: number;
  isCorrect: boolean;
  timestamp: string;
}

export interface SubjectPracticeProgress {
  subjectId: string;
  totalQuestions: number;
  answeredCount: number;
  correctCount: number;
  incorrectCount: number;
  percentage: number;
  accuracy: number;
}

export type QuestionDifficulty = 'easy' | 'medium' | 'hard';
export type QuestionStatus = 'draft' | 'reviewed' | 'published';

export interface Question {
  id: string;
  subjectId: string;
  topicId?: string;
  questionBn: string;
  questionEn: string;
  optionsBn: string[];
  optionsEn: string[];
  correctOptionIndex: number; // 0, 1, 2, 3
  explanationBn: string;
  explanationEn: string;
  legalReference?: string; // e.g., "Section 9, Code of Civil Procedure, 1908"
  difficulty: QuestionDifficulty;
  status: QuestionStatus;
  isDemoSample: boolean; // clearly indicates demo sample
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}

export type ExamType = 'full_mock' | 'subject_test' | 'practice_quiz' | 'custom_test';

export interface Exam {
  id: string;
  titleBn: string;
  titleEn: string;
  descriptionBn: string;
  descriptionEn: string;
  type: ExamType;
  durationMinutes: number; // Exactly 60 for full mock
  totalMarks: number;
  passThresholdPercentage?: number; // Configurable pass threshold, e.g. 50%
  questionIds: string[];
  isPaid: boolean;
  published: boolean;
  releaseExplanationsImmediately: boolean; // release immediately or after exam window
  subjectId?: string; // for subject-specific exams
  negativeMarkRatio: number; // 0.25
  positiveMarkRatio: number; // 1.0
  createdAt: string;
  isActive?: boolean; // Admin can toggle active on whichever day
  scheduledDate?: string; // Optional designated launch date (YYYY-MM-DD)
}

export interface ExamAttempt {
  id: string;
  examId: string;
  userId: string;
  sessionId?: string;
  studentName: string;
  startTime: string; // ISO string
  deadlineTime: string; // ISO string - server deadline
  submittedTime?: string;
  status: 'in_progress' | 'submitted' | 'timed_out';
  answers: Record<string, number>; // questionId -> selectedOptionIndex (0-3)
  flaggedQuestionIds: string[]; // questions marked for review
  currentQuestionIndex: number;
  lastSavedAt: string;
}

export interface ExamResult {
  id: string;
  attemptId: string;
  examId: string;
  examTitleBn: string;
  examTitleEn: string;
  examType: ExamType;
  userId: string;
  studentName: string;
  submittedAt: string;
  timeSpentSeconds: number;
  totalQuestions: number;
  correctAnswersCount: number;
  incorrectAnswersCount: number;
  unansweredCount: number;
  positiveMarks: number;
  negativeMarks: number;
  finalScore: number; // (correct * 1) - (incorrect * 0.25)
  percentage: number;
  passed?: boolean; // undefined if no threshold configured
  passThresholdPercentage?: number;
  subjectWiseScores: Record<string, {
    subjectNameBn: string;
    subjectNameEn: string;
    total: number;
    correct: number;
    incorrect: number;
    unanswered: number;
    score: number;
  }>;
  answers: Record<string, number>;
  questions: Question[];
}

export interface PaymentRequest {
  id: string;
  userId: string;
  studentName: string;
  studentPhone: string;
  method: 'bKash' | 'Nagad' | 'Rocket';
  senderNumber: string;
  transactionId: string;
  amount: number;
  packageId: string;
  packageNameBn: string;
  packageNameEn: string;
  packageTitle: string;
  durationDays: number;
  validityType?: 'days' | 'exam_date';
  status: 'pending' | 'approved' | 'rejected';
  rejectionReason?: string;
  requestedAt: string;
  verifiedAt?: string;
  verifiedBy?: string;
  subscriptionId?: string;
}

export interface AuditLog {
  id: string;
  userId: string;
  userName: string;
  action: string;
  details: string;
  timestamp: string;
}

export interface SupportContactSettings {
  whatsappNumber: string;
  whatsappMessage: string;
}

export interface PaymentSettings {
  bkashNumber: string;
  nagadNumber: string;
  packagePrice: number;
  instructionsBn?: string;
  instructionsEn?: string;
  whatsappNumber?: string;
  whatsappMessage?: string;
}

export interface SubscriptionPackage {
  id: string; // 'pkg_monthly' | 'pkg_pro_mock' | 'pkg_long_course' | 'pkg_exam_pass'
  nameBn: string;
  nameEn: string;
  taglineBn: string;
  taglineEn: string;
  price: number;
  validityType: 'days' | 'exam_date';
  durationDays?: number; // 30 for Monthly, 90 for Pro, 365 for Long Course
  accessLevel: 'pro_mock' | 'long_course' | 'all_inclusive';
  billingType?: 'monthly' | 'onetime';
  featuresBn: string[];
  featuresEn: string[];
  badgeBn?: string;
  badgeEn?: string;
  popular?: boolean;
  isActive: boolean;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ExamDateConfig {
  targetExamDate: string; // ISO string e.g. "2026-11-28T09:00:00+06:00"
  timezone: string; // "Asia/Dhaka" (BST UTC+6)
  examDatePolicy: 'extend_all' | 'new_only'; // whether exam-date changes affect existing subscribers or only new purchases
  examPassPrice: number; // configurable price for Package C (default 650)
  examTitleBn: string;
  examTitleEn: string;
  lastUpdated: string;
}

export interface AdminAuthResponse {
  success: boolean;
  token?: string;
  adminUser?: {
    uid: string;
    email: string;
    name: string;
    role: 'admin';
  };
  error?: string;
}

export interface LeaderboardEntry {
  id: string;
  userId: string;
  studentName: string;
  examId: string;
  examTitleBn: string;
  examTitleEn: string;
  score: number;
  totalMarks: number;
  percentage: number;
  correctAnswersCount: number;
  incorrectAnswersCount: number;
  unansweredCount?: number;
  timeSpentSeconds: number;
  completedAt: string; // ISO string
  rank?: number;
}
