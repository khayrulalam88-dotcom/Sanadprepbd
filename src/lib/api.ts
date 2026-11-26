import { auth } from './firebase';
import { formatBackendApiError } from './securityHelpers';
import type {
  AuditLog,
  Exam,
  ExamAttempt,
  ExamDateConfig,
  ExamResult,
  LeaderboardEntry,
  PaymentRequest,
  PaymentSettings,
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

export function normalizeApiBaseUrl(raw: string): string {
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.origin + parsed.pathname.replace(/\/+$/, '');
    }
  } catch {
    // Invalid URL format
  }
  return '';
}

export const API_BASE_URL = normalizeApiBaseUrl(rawBase);

export function resolveApiRequestUrl(path: string, configuredBaseUrl: string = API_BASE_URL): string {
  const normalizedBase = normalizeApiBaseUrl(configuredBaseUrl.trim());
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

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
    const response = await fetch(resolveApiRequestUrl(path), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const nonJsonCode = response.status >= 500 ? `HTTP_${response.status}` : 'NON_JSON_RESPONSE';
      if (contentType.includes('text/html')) {
        console.error(
          `[SanadPrep Frontend] ${path} returned HTML instead of JSON. Check same-origin Worker /api/* routing or VITE_API_BASE_URL.`
        );
      }
      return {
        ok: false,
        status: response.status,
        code: nonJsonCode,
        message: formatBackendApiError({
          status: response.status,
          code: nonJsonCode,
          isJson: false
        })
      };
    }

    const payload = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      const errCode = typeof payload.error === 'string' ? payload.error : `HTTP_${response.status}`;
      const rawMessage =
        typeof payload.message === 'string'
          ? payload.message
          : typeof payload.error === 'string'
          ? payload.error
          : undefined;
      return {
        ok: false,
        status: response.status,
        code: errCode,
        message: formatBackendApiError({
          status: response.status,
          code: errCode,
          serverMessage: rawMessage,
          isJson: true
        })
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
      message: formatBackendApiError({
        status: 0,
        code: 'NETWORK_ERROR',
        serverMessage: err instanceof Error ? err.message : undefined
      })
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
    apiRequest<{ leaderboard: LeaderboardEntry[] }>('/api/leaderboard')
  ]);
}

export async function apiFetchLeaderboard(examId?: string) {
  const qs = examId && examId !== 'all' ? `?examId=${encodeURIComponent(examId)}` : '';
  return apiRequest<{ leaderboard: LeaderboardEntry[] }>(`/api/leaderboard${qs}`);
}

export async function apiFetchSubjectQuestionCounts() {
  return apiRequest<{ counts: Record<string, number>; total: number }>('/api/subjects/counts');
}

export async function apiFetchExams() {
  return apiRequest<{ exams: Exam[] }>('/api/exams');
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

export async function apiCheckSessionStatus() {
  return apiRequest<{
    active: boolean;
    session: StudentSession | null;
    activeSubscription: UserSubscription | null;
  }>('/api/auth/session/status', {
    method: 'GET',
    requireAuth: true
  });
}

export async function apiLogoutSession(overrideAuth?: { token: string; sessionId: string }) {
  if (overrideAuth) {
    try {
      const response = await fetch(`${API_BASE_URL}/api/auth/logout`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${overrideAuth.token}`,
          'X-Session-Id': overrideAuth.sessionId
        }
      });
      return { ok: response.ok, status: response.status };
    } catch {
      return { ok: false, status: 0 };
    }
  }
  return apiRequest<{ success: boolean }>('/api/auth/logout', {
    method: 'POST',
    requireAuth: true
  });
}

// Questions & Practice (Sanitized for Students; Full Keys for Owner Admin)
export async function apiFetchSanitizedQuestions(params?: {
  subjectId?: string;
  examId?: string;
  search?: string;
  limit?: number;
  offset?: number;
}) {
  const search = new URLSearchParams();
  if (params?.subjectId) search.set('subjectId', params.subjectId);
  if (params?.examId) search.set('examId', params.examId);
  if (params?.search) search.set('search', params.search);
  if (params?.limit !== undefined) search.set('limit', String(params.limit));
  if (params?.offset !== undefined) search.set('offset', String(params.offset));
  const qs = search.toString() ? `?${search.toString()}` : '';
  return apiRequest<{
    questions: Question[];
    total?: number;
    limit?: number | null;
    offset?: number;
    hasMore?: boolean;
  }>(`/api/questions${qs}`, { requireAuth: true });
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
export async function apiFetchAdminQuestions(params?: {
  subjectId?: string;
  topicId?: string;
  difficulty?: 'easy' | 'medium' | 'hard';
  status?: 'draft' | 'reviewed' | 'published';
  search?: string;
  limit?: number;
  offset?: number;
}) {
  const searchParams = new URLSearchParams();
  if (params?.subjectId && params.subjectId !== 'all') searchParams.set('subjectId', params.subjectId);
  if (params?.topicId) searchParams.set('topicId', params.topicId);
  if (params?.difficulty) searchParams.set('difficulty', params.difficulty);
  if (params?.status) searchParams.set('status', params.status);
  if (params?.search) searchParams.set('search', params.search);
  if (params?.limit !== undefined) searchParams.set('limit', String(params.limit));
  if (params?.offset !== undefined) searchParams.set('offset', String(params.offset));
  const qs = searchParams.toString() ? `?${searchParams.toString()}` : '';
  return apiRequest<{
    questions: Question[];
    total?: number;
    limit?: number;
    offset?: number;
    hasMore?: boolean;
    source?: 'd1' | 'firestore';
  }>(`/api/admin/questions${qs}`, { requireAuth: true });
}

export async function apiAdminSyncQuestionCache() {
  return apiRequest<{
    success: boolean;
    versionToken: string;
    questionCount: number;
    keyCount: number;
    examsCount: number;
  }>('/api/admin/questions/sync-cache', {
    method: 'POST',
    requireAuth: true
  });
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
  email?: string;
  phone: string;
  role: UserRole;
  subscriptionStatus: 'free' | 'pro' | 'expired';
  packageId?: string;
  packageNameBn?: string;
  packageNameEn?: string;
  expiresAt?: string;
  isSessionRevoked?: boolean;
}) {
  return apiRequest<{
    success: boolean;
    user: UserProfile;
    subscription?: UserSubscription | null;
    updatedSubscriptions?: UserSubscription[];
  }>('/api/admin/users/update', {
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

export interface AdminDashboardStatsResponse {
  totalStudents: number;
  activeSubscribers: number;
  pendingPayments: number;
  approvedPayments: number;
  rejectedPayments: number;
  expiredSubscriptions: number;
  totalVerifiedRevenue: number;
  totalExamsCompleted: number;
}

export async function apiAdminFetchDashboardStats() {
  return apiRequest<AdminDashboardStatsResponse>('/api/admin/dashboard-stats', {
    requireAuth: true
  });
}

export async function apiAdminFetchAuditLogs() {
  return apiRequest<{ auditLogs: AuditLog[] }>('/api/admin/audit-logs', {
    requireAuth: true
  });
}
