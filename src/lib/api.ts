import { auth } from './firebase';
import type {
  Exam,
  ExamAttempt,
  ExamDateConfig,
  ExamResult,
  LeaderboardEntry,
  PaymentRequest,
  PaymentSettings,
  PreviousQuestion,
  Question,
  StudentSession,
  Subject,
  SubscriptionPackage,
  SupportContactSettings,
  UserProfile,
  UserRole,
  UserSubscription
} from '../types';

const rawBase =
  typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE_URL
    ? String(import.meta.env.VITE_API_BASE_URL).trim()
    : '';

export const API_BASE_URL = rawBase.replace(/\/+$/, '');

export interface ApiResponse<T> {
  ok: boolean;
  status: number;
  code?: string;
  message?: string;
  data?: T;
}

let activeSessionIdForHeader: string | null = null;

export function setApiSessionId(sessionId: string | null) {
  activeSessionIdForHeader = sessionId;
}

async function getBearerToken(): Promise<string | null> {
  try {
    if (auth?.currentUser) {
      return await auth.currentUser.getIdToken();
    }
  } catch {
    // ignore token acquisition failure
  }
  return null;
}

async function apiRequest<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: unknown;
    requireAuth?: boolean;
  } = {}
): Promise<ApiResponse<T>> {
  const { method = 'GET', body, requireAuth = false } = options;
  const headers: Record<string, string> = {};

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const token = await getBearerToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  } else if (requireAuth) {
    return {
      ok: false,
      status: 401,
      code: 'UNAUTHORIZED',
      message: 'অ্যাকাউন্টে লগইন করা নেই। অনুগ্রহ করে প্রথমে Firebase অ্যাকাউন্ট দিয়ে সাইন ইন করুন।'
    };
  }

  if (activeSessionIdForHeader) {
    headers['X-Session-Id'] = activeSessionIdForHeader;
  }

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return {
        ok: false,
        status: response.status,
        code: 'NON_JSON_RESPONSE',
        message: 'Backend API returned an unexpected non-JSON response.'
      };
    }

    const payload = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        code: typeof payload.error === 'string' ? payload.error : `HTTP_${response.status}`,
        message:
          typeof payload.message === 'string'
            ? payload.message
            : typeof payload.error === 'string'
            ? payload.error
            : 'Request failed'
      };
    }

    return {
      ok: true,
      status: response.status,
      data: payload as T
    };
  } catch (err: unknown) {
    return {
      ok: false,
      status: 0,
      code: 'NETWORK_ERROR',
      message: err instanceof Error ? err.message : 'Network error connecting to backend'
    };
  }
}

// Catalog & Public Configuration
export async function apiFetchPublicCatalog() {
  return Promise.all([
    apiRequest<{ exams: Exam[] }>('/api/exams'),
    apiRequest<{ packages: SubscriptionPackage[] }>('/api/packages'),
    apiRequest<{ examDateConfig: ExamDateConfig }>('/api/exam-config'),
    apiRequest<{ paymentSettings: PaymentSettings; supportSettings: SupportContactSettings }>('/api/payment-settings'),
    apiRequest<{ subjects: Subject[] }>('/api/subjects'),
    apiRequest<{ leaderboard: LeaderboardEntry[] }>('/api/leaderboard'),
    apiRequest<{ previousQuestions: PreviousQuestion[] }>('/api/previous-questions')
  ]);
}

export async function apiFetchLeaderboard(examId?: string) {
  const qs = examId && examId !== 'all' ? `?examId=${encodeURIComponent(examId)}` : '';
  return apiRequest<{ leaderboard: LeaderboardEntry[] }>(`/api/leaderboard${qs}`);
}

// Auth & Session
export async function apiCreateSession(userName?: string, deviceInfo?: string) {
  return apiRequest<{
    success: boolean;
    sessionId: string;
    session: StudentSession;
    activeSubscription: UserSubscription | null;
  }>('/api/auth/session', {
    method: 'POST',
    body: { userName, deviceInfo },
    requireAuth: true
  });
}

// Questions & Practice (Sanitized for Students; Full Keys for Owner Admin)
export async function apiFetchSanitizedQuestions(params?: { subjectId?: string; examId?: string }) {
  const search = new URLSearchParams();
  if (params?.subjectId) search.set('subjectId', params.subjectId);
  if (params?.examId) search.set('examId', params.examId);
  const qs = search.toString() ? `?${search.toString()}` : '';
  return apiRequest<{ questions: Question[] }>(`/api/questions${qs}`, { requireAuth: true });
}

export async function apiCheckPracticeAnswer(questionId: string, selectedOption: number) {
  return apiRequest<{
    success: boolean;
    questionId: string;
    isCorrect: boolean;
    correctOptionIndex: number;
    explanationBn: string;
    explanationEn: string;
    legalReference: string;
  }>('/api/practice/check', {
    method: 'POST',
    body: { questionId, selectedOption },
    requireAuth: true
  });
}

export async function apiCheckPreviousQuestion(questionId: string, selectedAnswer?: string) {
  return apiRequest<{
    success: boolean;
    questionId: string;
    isCorrect: boolean;
    correctAnswer: string;
    explanation: string;
    legalSection: string;
    source: string;
  }>('/api/previous-questions/check', {
    method: 'POST',
    body: { questionId, selectedAnswer }
  });
}

export async function apiGradePreviousQuestions(questionIds: string[], answers: Record<string, string>) {
  return apiRequest<{
    success: boolean;
    evaluation: {
      totalQuestions: number;
      correctCount: number;
      incorrectCount: number;
      unansweredCount: number;
      positiveMarks: number;
      negativeMarks: number;
      finalScore: number;
      percentage: number;
      isPassed: boolean;
      incorrectList: { question: PreviousQuestion; selectedAnswer?: string }[];
    };
  }>('/api/previous-questions/grade', {
    method: 'POST',
    body: { questionIds, answers }
  });
}

// Exam Flow (Server Authoritative)
export async function apiStartExam(examId: string, studentName?: string) {
  return apiRequest<{
    success: boolean;
    attempt: ExamAttempt;
    exam: Exam;
    questions: Question[];
    durationMinutes: number;
    deadlineTime: string;
  }>('/api/exams/start', {
    method: 'POST',
    body: { examId, studentName },
    requireAuth: true
  });
}

export async function apiSaveExamAnswer(params: {
  attemptId: string;
  answers: Record<string, number>;
  flaggedQuestionIds: string[];
  currentQuestionIndex: number;
}) {
  return apiRequest<{ success: boolean }>('/api/exams/save-answer', {
    method: 'POST',
    body: params,
    requireAuth: true
  });
}

export async function apiSubmitExam(attemptId: string, answers: Record<string, number>, isAutoTimeout = false) {
  return apiRequest<{
    success: boolean;
    result: ExamResult;
    leaderboardEntry: LeaderboardEntry;
  }>('/api/exams/submit', {
    method: 'POST',
    body: { attemptId, answers, isAutoTimeout },
    requireAuth: true
  });
}

export async function apiFetchExamResults(userId?: string) {
  const path = userId ? `/api/exams/results/${encodeURIComponent(userId)}` : '/api/exams/results';
  return apiRequest<{ results: ExamResult[] }>(path, { requireAuth: true });
}

// Payments & Subscriptions (Server Pricing + Duplicate TrxID Protection)
export async function apiCreatePaymentRequest(params: {
  method: 'bKash' | 'Nagad' | 'Rocket';
  studentPhone?: string;
  senderNumber: string;
  transactionId: string;
  packageId: string;
  studentName?: string;
}) {
  return apiRequest<{
    success: boolean;
    message: string;
    paymentRequest: PaymentRequest;
  }>('/api/payments/create', {
    method: 'POST',
    body: params,
    requireAuth: true
  });
}

export async function apiFetchPaymentRequests() {
  return apiRequest<{ paymentRequests: PaymentRequest[] }>('/api/payments', { requireAuth: true });
}

export async function apiApprovePaymentRequest(id: string, verifierName?: string) {
  return apiRequest<{
    success: boolean;
    paymentRequest: PaymentRequest;
    subscription: UserSubscription;
  }>(`/api/admin/payments/${encodeURIComponent(id)}/approve`, {
    method: 'POST',
    body: { verifierName },
    requireAuth: true
  });
}

export async function apiRejectPaymentRequest(id: string, reason: string, verifierName?: string) {
  return apiRequest<{
    success: boolean;
    paymentRequest: PaymentRequest;
  }>(`/api/admin/payments/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
    body: { reason, verifierName },
    requireAuth: true
  });
}

// Admin Endpoints (Verified Owner Admin Only)
export async function apiFetchAdminQuestions() {
  return apiRequest<{ questions: Question[] }>('/api/admin/questions', { requireAuth: true });
}

export async function apiAdminSaveQuestion(q: Question) {
  return apiRequest<{ success: boolean; question: Question }>('/api/admin/questions', {
    method: 'POST',
    body: q,
    requireAuth: true
  });
}

export async function apiAdminDeleteQuestion(id: string) {
  return apiRequest<{ success: boolean }>(`/api/admin/questions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    requireAuth: true
  });
}

export async function apiFetchAdminPreviousQuestions() {
  return apiRequest<{ previousQuestions: PreviousQuestion[] }>('/api/admin/previous-questions', { requireAuth: true });
}

export async function apiAdminSavePreviousQuestion(pq: PreviousQuestion) {
  return apiRequest<{ success: boolean; previousQuestion: PreviousQuestion }>('/api/admin/previous-questions', {
    method: 'POST',
    body: pq,
    requireAuth: true
  });
}

export async function apiAdminSaveExam(exam: Exam) {
  return apiRequest<{ success: boolean; exam: Exam }>('/api/admin/exams/save', {
    method: 'POST',
    body: exam,
    requireAuth: true
  });
}

export async function apiAdminFetchSubscriptions() {
  return apiRequest<{ subscriptions: UserSubscription[] }>('/api/admin/subscriptions', { requireAuth: true });
}

export async function apiAdminUpdateUser(params: {
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
}) {
  return apiRequest<{ success: boolean; user: UserProfile }>('/api/admin/users/update', {
    method: 'POST',
    body: params,
    requireAuth: true
  });
}

export async function apiAdminUpdatePackage(pkg: Partial<SubscriptionPackage> & { id: string }) {
  return apiRequest<{ success: boolean; package: SubscriptionPackage }>('/api/admin/packages/update', {
    method: 'POST',
    body: pkg,
    requireAuth: true
  });
}

export async function apiAdminUpdateExamConfig(config: Partial<ExamDateConfig>) {
  return apiRequest<{ success: boolean; examDateConfig: ExamDateConfig; affectedSubscribers: number }>(
    '/api/admin/exam-config',
    {
      method: 'POST',
      body: config,
      requireAuth: true
    }
  );
}

export async function apiAdminUpdatePaymentSettings(settings: Partial<PaymentSettings>) {
  return apiRequest<{
    success: boolean;
    paymentSettings: PaymentSettings;
    supportSettings: SupportContactSettings;
  }>('/api/admin/payment-settings', {
    method: 'POST',
    body: settings,
    requireAuth: true
  });
}

export async function apiAdminUpdateSupportSettings(settings: Partial<SupportContactSettings>) {
  return apiRequest<{ success: boolean; supportSettings: SupportContactSettings }>('/api/admin/support-settings', {
    method: 'POST',
    body: settings,
    requireAuth: true
  });
}
