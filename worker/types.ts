export const OWNER_ADMIN_UID = 'PjBRV7LAQ8cIwOdM3z474A16dWg2';
export const OWNER_ADMIN_EMAIL = 'khayrulalam88@gmail.com';
export const EXPECTED_FIREBASE_PROJECT_ID = 'galvanic-aviary-tzp2g';
export const EXPECTED_FIREBASE_DATABASE_ID =
  'ai-studio-barcouncilmcqpre-9a5aecc8-3819-4aeb-b7e2-c6066b637cab';

export function normalizeEnvironment(rawEnvironment?: string): string {
  return (rawEnvironment || '').trim().toLowerCase();
}

export function isStagingEnvironment(rawEnvironment?: string): boolean {
  return normalizeEnvironment(rawEnvironment) === 'staging';
}

export function isValidFirebaseProjectId(projectId: string): boolean {
  const trimmed = projectId.trim();
  return /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(trimmed);
}

export function isValidFirestoreDatabaseId(databaseId: string): boolean {
  const trimmed = databaseId.trim();
  if (!trimmed) return false;
  if (trimmed === '(default)') return true;
  return /^[a-z0-9][a-z0-9-]{2,126}[a-z0-9]$/.test(trimmed);
}

export interface D1Meta {
  changed_db?: boolean;
  changes?: number;
  duration?: number;
  last_row_id?: number;
  rows_read?: number;
  rows_written?: number;
}

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: D1Meta;
}

export interface D1ExecResult {
  count: number;
  duration: number;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  raw<T = unknown[]>(): Promise<T[]>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
}

export interface Fetcher {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

export interface WorkerEnv {
  DB?: D1Database;
  ASSETS?: Fetcher;
  FIREBASE_PROJECT_ID?: string;
  FIREBASE_DATABASE_ID?: string;
  STAGING_OWNER_ADMIN_UID?: string;
  ALLOWED_ORIGIN?: string;
  ENVIRONMENT?: string;
  QUESTION_BANK_CACHE_TTL_MS?: string;
}

export interface DecodedAuthUser {
  uid: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
  idToken?: string;
  authTime?: number;
  issuedAt?: number;
  expiresAt?: number;
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

export interface UserSubscription {
  id: string;
  userId: string;
  studentName: string;
  studentEmail?: string;
  studentPhone: string;
  packageId: string;
  packageNameBn: string;
  packageNameEn: string;
  pricePaid: number;
  paymentRequestId: string;
  paymentMethod: 'bKash' | 'Nagad';
  transactionId: string;
  activatedAt: string;
  expiresAt: string;
  validityType: 'days' | 'exam_date';
  status: 'active' | 'expired' | 'cancelled';
  targetExamDateSnapshot?: string;
  createdAt: string;
}

export interface AuditLog {
  id: string;
  userId: string;
  userName: string;
  action: string;
  details: string;
  timestamp: string;
}

export interface SanitizedQuestion {
  id: string;
  subjectId: string;
  topicId?: string;
  questionBn: string;
  questionEn: string;
  optionsBn: string[];
  optionsEn: string[];
  legalReference?: string;
  difficulty: 'easy' | 'medium' | 'hard';
  status: 'draft' | 'reviewed' | 'published';
  isDemoSample: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}

export interface QuestionKeyRecord {
  id: string;
  correctOptionIndex: number;
  explanationBn: string;
  explanationEn: string;
  legalReference?: string;
  updatedAt: string;
}

export interface ServerQuestion extends SanitizedQuestion {
  correctOptionIndex: number;
  explanationBn: string;
  explanationEn: string;
}

export class WorkerHttpError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'WorkerHttpError';
    this.status = status;
    this.code = code;
  }
}
