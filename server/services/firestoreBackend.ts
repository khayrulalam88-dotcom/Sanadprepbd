import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeApp as initializeAdminApp, getApps as getAdminApps, App } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { getFirestore, Firestore, Timestamp } from 'firebase-admin/firestore';
import type {
  ServerQuestion,
  Question,
  Exam,
  ExamAttempt,
  ExamResult,
  PaymentRequest,
  UserSubscription,
  UserProfile,
  LeaderboardEntry,
  Subject,
  SubscriptionPackage,
  ExamDateConfig,
  AuditLog
} from '../../src/types/index.ts';
import { INITIAL_SUBJECTS } from '../../src/data/mockData.ts';
import { INITIAL_EXAMS } from '../../src/data/initialExams.ts';
import { INITIAL_PACKAGES, INITIAL_EXAM_DATE_CONFIG } from '../../src/data/initialPackages.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function resolveWorkspacePath(...segments: string[]): string {
  const candidates = [
    path.resolve(process.cwd(), ...segments),
    path.resolve(__dirname, ...segments),
    path.resolve(__dirname, '..', ...segments),
    path.resolve(__dirname, '../..', ...segments)
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

export const OWNER_ADMIN_UID = 'PjBRV7LAQ8cIwOdM3z474A16dWg2';
export const OWNER_ADMIN_EMAIL = 'khayrulalam88@gmail.com';
function loadServerJson<T>(relativePath: string, fallback: T): T {
  try {
    const fullPath = resolveWorkspacePath(...relativePath.split('/'));
    if (fs.existsSync(fullPath)) {
      return JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as T;
    }
  } catch (err) {
    console.warn(`Failed to load ${relativePath}:`, err);
  }
  return fallback;
}

const appletFirebaseConfig = loadServerJson<{ projectId?: string; firestoreDatabaseId?: string }>(
  'firebase-applet-config.json',
  {}
);

export const EXPECTED_FIREBASE_PROJECT_ID =
  appletFirebaseConfig.projectId?.trim() || 'galvanic-aviary-tzp2g';
export const EXPECTED_FIREBASE_DATABASE_ID =
  appletFirebaseConfig.firestoreDatabaseId?.trim() ||
  'ai-studio-barcouncilmcqpre-9a5aecc8-3819-4aeb-b7e2-c6066b637cab';

export const FIREBASE_PROJECT_ID =
  (process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID || EXPECTED_FIREBASE_PROJECT_ID).trim() ||
  EXPECTED_FIREBASE_PROJECT_ID;

export function resolveEffectiveDatabaseId(rawEnvDbId?: string): string {
  const trimmed = (rawEnvDbId || '').trim();
  if (!trimmed) {
    return EXPECTED_FIREBASE_DATABASE_ID;
  }
  if (trimmed === FIREBASE_PROJECT_ID || trimmed === EXPECTED_FIREBASE_PROJECT_ID) {
    console.warn(
      `[SanadPrep Server] Ignoring FIREBASE_DATABASE_ID "${trimmed}" because it matches the Firebase Project ID; using named database "${EXPECTED_FIREBASE_DATABASE_ID}".`
    );
    return EXPECTED_FIREBASE_DATABASE_ID;
  }
  return trimmed;
}

export const FIREBASE_DATABASE_ID = resolveEffectiveDatabaseId(
  process.env.FIREBASE_DATABASE_ID || process.env.VITE_FIREBASE_DATABASE_ID
);

export function initFirebaseAdminApp(): App {
  if (getAdminApps().length > 0) {
    return getAdminApps()[0];
  }
  // Keyless Application Default Credentials (ADC / Workload Identity on Cloud Run / local gcloud ADC)
  return initializeAdminApp({ projectId: FIREBASE_PROJECT_ID });
}

export const adminApp = initFirebaseAdminApp();
export const adminAuth = getAdminAuth(adminApp);
export const adminDb: Firestore = getFirestore(adminApp, FIREBASE_DATABASE_ID);

export function getConfiguredDatabaseInfo(db: Firestore = adminDb): {
  projectId: string;
  configuredDatabaseId: string;
  sdkDatabaseId: string | undefined;
  expectedDatabaseId: string;
  matchesExpected: boolean;
} {
  const sdkDatabaseId =
    (db as unknown as { databaseId?: string; _settings?: { databaseId?: string } }).databaseId ||
    (db as unknown as { _settings?: { databaseId?: string } })._settings?.databaseId;
  const resolvedDbId = sdkDatabaseId || FIREBASE_DATABASE_ID;
  const matchesExpected =
    FIREBASE_DATABASE_ID === EXPECTED_FIREBASE_DATABASE_ID &&
    resolvedDbId === EXPECTED_FIREBASE_DATABASE_ID;

  return {
    projectId: FIREBASE_PROJECT_ID,
    configuredDatabaseId: FIREBASE_DATABASE_ID,
    sdkDatabaseId,
    expectedDatabaseId: EXPECTED_FIREBASE_DATABASE_ID,
    matchesExpected
  };
}

export function assertExpectedNamedDatabase(db: Firestore = adminDb): {
  valid: boolean;
  reason?: string;
} {
  const info = getConfiguredDatabaseInfo(db);
  if (!info.configuredDatabaseId || info.configuredDatabaseId === '(default)') {
    return {
      valid: false,
      reason: `Refusing default/empty Firestore database "${info.configuredDatabaseId}". Expected "${EXPECTED_FIREBASE_DATABASE_ID}".`
    };
  }
  if (info.configuredDatabaseId !== EXPECTED_FIREBASE_DATABASE_ID) {
    return {
      valid: false,
      reason: `Configured FIREBASE_DATABASE_ID "${info.configuredDatabaseId}" does not match expected "${EXPECTED_FIREBASE_DATABASE_ID}".`
    };
  }
  if (info.sdkDatabaseId && info.sdkDatabaseId !== EXPECTED_FIREBASE_DATABASE_ID) {
    return {
      valid: false,
      reason: `Firestore SDK instance bound to "${info.sdkDatabaseId}" instead of "${EXPECTED_FIREBASE_DATABASE_ID}".`
    };
  }
  return { valid: true };
}

export function isPermissionOrCredentialError(err: unknown): boolean {
  const code = (err as { code?: number | string })?.code;
  const msg = String((err as { message?: string })?.message || err || '').toLowerCase();
  return (
    code === 7 ||
    code === 16 ||
    code === 'permission-denied' ||
    msg.includes('permission_denied') ||
    msg.includes('permission denied') ||
    msg.includes('could not load the default credentials') ||
    msg.includes('missing or insufficient permissions') ||
    msg.includes('unauthenticated')
  );
}

export function isAlreadyExistsError(err: unknown): boolean {
  const code = (err as { code?: number | string })?.code;
  const msg = String((err as { message?: string })?.message || err || '').toLowerCase();
  return code === 6 || code === 'already-exists' || msg.includes('already exists') || msg.includes('already_exists');
}

export function timestampToIso(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'string') {
    const d = new Date(value);
    return isNaN(d.getTime()) ? value : d.toISOString();
  }
  if (value instanceof Timestamp) {
    return value.toDate().toISOString();
  }
  if (typeof (value as { toDate?: () => Date }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  if (typeof (value as { seconds?: number }).seconds === 'number') {
    const t = value as { seconds: number; nanoseconds?: number };
    return new Date(t.seconds * 1000 + Math.floor((t.nanoseconds || 0) / 1e6)).toISOString();
  }
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? undefined : value.toISOString();
  }
  return undefined;
}

export function isoToTimestamp(value?: string | Date | null): Timestamp | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return null;
  return Timestamp.fromDate(d);
}

export function sanitizeQuestionForClient(q: ServerQuestion | Question): Question {
  const { correctOptionIndex: _c, explanationBn: _eb, explanationEn: _ee, ...sanitized } = q;
  return sanitized;
}

export function getSafeDiagnosticError(err: unknown): { code?: string | number; message: string } {
  const code = (err as { code?: number | string })?.code;
  const rawMessage = err instanceof Error ? err.message : String(err || 'Unknown database error');
  // Redact any accidental bearer tokens, private keys, API keys, or key query params from diagnostics
  const sanitizedMessage = rawMessage
    .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, '[REDACTED_KEY]')
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED_API_KEY]')
    .replace(/([?&](?:key|api_key|apiKey)=)[^&\s"']+/gi, '$1[REDACTED]')
    .slice(0, 240);
  return { ...(code !== undefined ? { code } : {}), message: sanitizedMessage };
}

export interface PersistenceState {
  mode: 'firestore' | 'memory-fallback' | 'unavailable';
  lastCheckedAt: string;
  reason?: string;
}

export const persistenceState: PersistenceState = {
  mode: 'firestore',
  lastCheckedAt: new Date().toISOString()
};

export async function probeFirestoreAdminConnectivity(db: Firestore = adminDb): Promise<PersistenceState> {
  const isProd = process.env.NODE_ENV === 'production';
  const dbGuard = assertExpectedNamedDatabase(db);
  if (!dbGuard.valid) {
    persistenceState.lastCheckedAt = new Date().toISOString();
    persistenceState.mode = isProd ? 'unavailable' : 'memory-fallback';
    persistenceState.reason = dbGuard.reason;
    console.error('[SanadPrep Server] Named database check failed:', dbGuard.reason);
    return persistenceState;
  }

  const probeTimeoutMs = isProd ? 6000 : 2000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`PERMISSION_DENIED_TIMEOUT: Firestore Admin probe timed out after ${probeTimeoutMs}ms`));
      }, probeTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });

    await Promise.race([db.collection('config').limit(1).get(), timeoutPromise]);
    persistenceState.mode = 'firestore';
    persistenceState.lastCheckedAt = new Date().toISOString();
    delete persistenceState.reason;
  } catch (err: unknown) {
    const safeErr = getSafeDiagnosticError(err);
    persistenceState.lastCheckedAt = new Date().toISOString();
    if (isProd) {
      persistenceState.mode = 'unavailable';
      persistenceState.reason =
        'Authoritative Firestore connectivity unavailable in production; in-memory fallback disabled.';
      console.error('[SanadPrep Server] Production Firestore probe failed:', safeErr.code || '', safeErr.message);
    } else if (isPermissionOrCredentialError(err)) {
      persistenceState.mode = 'memory-fallback';
      persistenceState.reason =
        'Development mode: Admin SDK lacks Firestore IAM permissions; using development memory store alongside Auth verification.';
      console.warn('[SanadPrep Server]', persistenceState.reason);
    } else {
      persistenceState.mode = 'memory-fallback';
      persistenceState.reason = safeErr.message;
      console.warn('[SanadPrep Server] Development Firestore probe notice:', safeErr.message);
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
  return persistenceState;
}

let inFlightProdProbe: Promise<PersistenceState> | null = null;
let lastProdProbeAttemptMs = 0;

export async function ensureProductionFirestoreReady(
  db: Firestore = adminDb,
  minRetryIntervalMs = 15_000
): Promise<PersistenceState> {
  if (process.env.NODE_ENV !== 'production') {
    return persistenceState;
  }
  if (persistenceState.mode === 'firestore') {
    return persistenceState;
  }
  if (!assertExpectedNamedDatabase(db).valid) {
    persistenceState.mode = 'unavailable';
    return persistenceState;
  }
  const now = Date.now();
  if (inFlightProdProbe) {
    return inFlightProdProbe;
  }
  if (now - lastProdProbeAttemptMs < minRetryIntervalMs) {
    return persistenceState;
  }
  lastProdProbeAttemptMs = now;
  inFlightProdProbe = probeFirestoreAdminConnectivity(db).finally(() => {
    inFlightProdProbe = null;
  });
  return inFlightProdProbe;
}

// Initial authoritative question bank store loaded ONLY on backend
const FULL_QUESTIONS_RAW = loadServerJson<ServerQuestion[]>('server/data/questionBankFull.json', []);

export interface MemoryMirror {
  packages: SubscriptionPackage[];
  examDateConfig: ExamDateConfig;
  paymentSettings: {
    bkashNumber: string;
    nagadNumber: string;
    packagePrice: number;
    instructionsBn?: string;
    instructionsEn?: string;
    whatsappNumber: string;
    whatsappMessage: string;
  };
  supportSettings: {
    whatsappNumber: string;
    whatsappMessage: string;
  };
  subjects: Subject[];
  questions: ServerQuestion[];
  exams: Exam[];
  users: Record<string, UserProfile>;
  paymentRequests: PaymentRequest[];
  subscriptions: UserSubscription[];
  sessions: Record<string, {
    sessionId: string;
    userId: string;
    userEmail: string;
    userName: string;
    deviceInfo: string;
    createdAt: string;
    lastActiveAt: string;
    status: 'active' | 'revoked';
    revokedReason?: string;
  }>;
  userActiveSessions: Record<string, string>;
  examAttempts: Record<string, ExamAttempt>;
  examResults: ExamResult[];
  leaderboard: LeaderboardEntry[];
  auditLogs: AuditLog[];
}

export function createMemoryMirror(): MemoryMirror {
  return {
    packages: INITIAL_PACKAGES.map(p => ({ ...p })),
    examDateConfig: { ...INITIAL_EXAM_DATE_CONFIG },
    paymentSettings: {
      bkashNumber: '01712607777',
      nagadNumber: '01712607777',
      packagePrice: 300,
      instructionsBn: 'বিকাশ বা নগদ সেন্ড মানি (Personal) করে ট্রানজেকশন আইডি দিন।',
      instructionsEn: 'Send Money to the bKash or Nagad Personal number above and submit your TrxID.',
      whatsappNumber: '+8801671819027',
      whatsappMessage: 'Hello Sanad Prep BD Support, I need help with my account or subscription.'
    },
    supportSettings: {
      whatsappNumber: '+8801671819027',
      whatsappMessage: 'Hello Sanad Prep BD Support, I need help with my account or subscription.'
    },
    subjects: INITIAL_SUBJECTS.map(s => ({ ...s })),
    questions: FULL_QUESTIONS_RAW.map(q => ({ ...q })),
    exams: INITIAL_EXAMS.map(e => ({ ...e })),
    users: {},
    paymentRequests: [],
    subscriptions: [],
    sessions: {},
    userActiveSessions: {},
    examAttempts: {},
    examResults: [],
    leaderboard: [],
    auditLogs: [
      {
        id: 'log_boot',
        userId: 'admin_sys',
        userName: 'Sanad Prep BD System',
        action: 'SERVER_BOOT',
        details: `Initialized with ${FULL_QUESTIONS_RAW.length} full MCQs and ${INITIAL_EXAMS.length} exams.`,
        timestamp: new Date().toISOString()
      }
    ]
  };
}

// =========================================================================
// DISTRIBUTED FIRESTORE-BACKED RATE LIMITER (Fixed Window Counter)
// =========================================================================
interface MemoryRateLimitBucket {
  count: number;
  windowStartMs: number;
  windowEndMs: number;
}

const memoryRateLimitBuckets = new Map<string, MemoryRateLimitBucket>();

export function clearRateLimitBucketsForTests(): void {
  memoryRateLimitBuckets.clear();
}

export async function consumeRateLimit(options: {
  key: string;
  windowMs: number;
  maxRequests: number;
  db?: Firestore;
  useFirestoreDb: boolean;
  nowMs?: number;
}): Promise<{ allowed: boolean; remaining: number; limit: number; retryAfterSeconds: number }> {
  const nowMs = options.nowMs ?? Date.now();
  const safeKey = options.key.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 180);
  const windowStartMs = Math.floor(nowMs / options.windowMs) * options.windowMs;
  const windowEndMs = windowStartMs + options.windowMs;
  const retryAfterSeconds = Math.max(1, Math.ceil((windowEndMs - nowMs) / 1000));

  if (options.useFirestoreDb) {
    const db = options.db || adminDb;
    const bucketRef = db.collection('rateLimits').doc(safeKey);
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(bucketRef);
      const data = snap.exists ? (snap.data() as Partial<MemoryRateLimitBucket>) : undefined;
      const isSameWindow =
        typeof data?.windowStartMs === 'number' && data.windowStartMs === windowStartMs;
      const currentCount = isSameWindow && typeof data?.count === 'number' ? data.count : 0;

      if (currentCount >= options.maxRequests) {
        return {
          allowed: false,
          remaining: 0,
          limit: options.maxRequests,
          retryAfterSeconds
        };
      }

      const nextCount = currentCount + 1;
      tx.set(bucketRef, {
        count: nextCount,
        windowStartMs,
        windowEndMs,
        updatedAt: new Date(nowMs).toISOString()
      });

      return {
        allowed: true,
        remaining: Math.max(0, options.maxRequests - nextCount),
        limit: options.maxRequests,
        retryAfterSeconds
      };
    });
    return result;
  }

  const existing = memoryRateLimitBuckets.get(safeKey);
  const currentCount =
    existing && existing.windowStartMs === windowStartMs ? existing.count : 0;

  if (currentCount >= options.maxRequests) {
    return {
      allowed: false,
      remaining: 0,
      limit: options.maxRequests,
      retryAfterSeconds
    };
  }

  const nextCount = currentCount + 1;
  memoryRateLimitBuckets.set(safeKey, {
    count: nextCount,
    windowStartMs,
    windowEndMs
  });

  // Periodic cleanup of stale buckets to keep memory bounded
  if (memoryRateLimitBuckets.size > 5000) {
    for (const [k, b] of memoryRateLimitBuckets.entries()) {
      if (b.windowEndMs <= nowMs) {
        memoryRateLimitBuckets.delete(k);
      }
    }
  }

  return {
    allowed: true,
    remaining: Math.max(0, options.maxRequests - nextCount),
    limit: options.maxRequests,
    retryAfterSeconds
  };
}

// Authoritative check whether a user currently holds an active non-expired Pro subscription
export async function checkUserHasActiveSubscription(
  uid: string,
  mirror: MemoryMirror,
  db: Firestore = adminDb,
  allowMemoryFallback = false,
  useFirestoreDb = true
): Promise<{ active: boolean; activeSubscription: UserSubscription | null; reason?: string }> {
  const nowMs = Date.now();

  if (useFirestoreDb) {
    try {
      const [userSnap, subSnap] = await Promise.all([
        db.collection('users').doc(uid).get(),
        db.collection('subscriptions').where('userId', '==', uid).get()
      ]);

      let matchedSub: UserSubscription | null = null;
      subSnap.forEach(d => {
        const raw = d.data();
        const subExp = timestampToIso(raw.expiresAt);
        if (!matchedSub && raw.status === 'active' && subExp && new Date(subExp).getTime() > nowMs) {
          matchedSub = {
            ...(raw as Omit<UserSubscription, 'id'>),
            id: d.id,
            activatedAt: timestampToIso(raw.activatedAt) || new Date().toISOString(),
            expiresAt: subExp,
            createdAt: timestampToIso(raw.createdAt) || new Date().toISOString()
          };
        }
      });

      if (matchedSub) {
        return { active: true, activeSubscription: matchedSub };
      }

      if (userSnap.exists) {
        const uData = userSnap.data() || {};
        const expiryIso = timestampToIso(uData.subscriptionExpiresAt);
        if (uData.subscriptionStatus === 'pro' && expiryIso && new Date(expiryIso).getTime() > nowMs) {
          return { active: true, activeSubscription: null };
        }
      }

      return { active: false, activeSubscription: null, reason: 'NO_ACTIVE_SUBSCRIPTION' };
    } catch (err) {
      if (!allowMemoryFallback) {
        throw err;
      }
      if (!isPermissionOrCredentialError(err)) {
        console.warn('[SubscriptionCheck] Development fallback:', getSafeDiagnosticError(err).message);
      }
    }
  }

  if (!allowMemoryFallback) {
    throw new Error('FIRESTORE_UNAVAILABLE: Subscription check requires Firestore in production.');
  }

  // Development-only memory fallback
  const memUser = mirror.users[uid];
  if (
    memUser &&
    memUser.subscriptionStatus === 'pro' &&
    memUser.subscriptionExpiresAt &&
    new Date(memUser.subscriptionExpiresAt).getTime() > nowMs
  ) {
    const matchedSub =
      mirror.subscriptions.find(
        s => s.userId === uid && s.status === 'active' && new Date(s.expiresAt).getTime() > nowMs
      ) || null;
    return { active: true, activeSubscription: matchedSub };
  }

  const activeSub =
    mirror.subscriptions.find(
      s => s.userId === uid && s.status === 'active' && new Date(s.expiresAt).getTime() > nowMs
    ) || null;
  if (activeSub) {
    return { active: true, activeSubscription: activeSub };
  }

  return { active: false, activeSubscription: null, reason: 'EXPIRED_OR_FREE' };
}

// =========================================================================
// VERSION-COORDINATED, CONFIGURABLE-TTL QUESTION BANK CACHE
// Never caches payment, subscription, session, or admin-auth data!
// =========================================================================
export const DEFAULT_QUESTION_BANK_CACHE_TTL_MS = 300_000;
const QUESTION_BANK_VERSION_DOC_ID = 'questionBankVersion';
let questionBankVersionSeq = 0;

interface QuestionBankCacheEntry {
  sanitized?: Question[];
  sanitizedFetchedAt: number;
  sanitizedVersion?: string;
  sanitizedInFlight?: Promise<Question[]>;
  full?: ServerQuestion[];
  fullFetchedAt: number;
  fullVersion?: string;
  fullInFlight?: Promise<ServerQuestion[]>;
}

const questionBankCacheByDb = new WeakMap<Firestore, QuestionBankCacheEntry>();

function getCacheEntry(db: Firestore): QuestionBankCacheEntry {
  let entry = questionBankCacheByDb.get(db);
  if (!entry) {
    entry = {
      sanitizedFetchedAt: 0,
      fullFetchedAt: 0
    };
    questionBankCacheByDb.set(db, entry);
  }
  return entry;
}

export function getQuestionBankCacheTtlMs(overrideMs?: number): number {
  if (typeof overrideMs === 'number' && Number.isFinite(overrideMs) && overrideMs >= 0) {
    return overrideMs;
  }
  const raw = process.env.QUESTION_BANK_CACHE_TTL_MS;
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return DEFAULT_QUESTION_BANK_CACHE_TTL_MS;
}

export function createQuestionBankVersionPayload(updatedAt = new Date().toISOString()): {
  version: number;
  versionToken: string;
  updatedAt: string;
} {
  questionBankVersionSeq += 1;
  const nowMs = Date.now();
  return {
    version: nowMs * 1000 + (questionBankVersionSeq % 1000),
    versionToken: `${nowMs}_${questionBankVersionSeq}_${Math.random().toString(36).slice(2, 7)}`,
    updatedAt
  };
}

export function invalidateQuestionBankCache(db: Firestore = adminDb): void {
  const entry = questionBankCacheByDb.get(db);
  if (!entry) return;
  delete entry.sanitized;
  delete entry.sanitizedVersion;
  entry.sanitizedFetchedAt = 0;
  delete entry.sanitizedInFlight;
  delete entry.full;
  delete entry.fullVersion;
  entry.fullFetchedAt = 0;
  delete entry.fullInFlight;
}

async function fetchRemoteQuestionBankVersion(db: Firestore): Promise<string> {
  const snap = await db.collection('config').doc(QUESTION_BANK_VERSION_DOC_ID).get();
  if (!snap.exists) return '__initial__';
  const data = snap.data() as { versionToken?: string; version?: number } | undefined;
  if (data?.versionToken) return String(data.versionToken);
  if (data?.version !== undefined) return String(data.version);
  return '__initial__';
}

export async function getSanitizedQuestionsAuthoritative(
  mirror: MemoryMirror,
  db: Firestore = adminDb,
  allowMemoryFallback = false,
  useFirestoreDb = true,
  options?: { ttlMs?: number; bypassCache?: boolean }
): Promise<Question[]> {
  if (useFirestoreDb) {
    const ttlMs = getQuestionBankCacheTtlMs(options?.ttlMs);
    const cache = getCacheEntry(db);
    try {
      const remoteVersion = options?.bypassCache ? '__bypass__' : await fetchRemoteQuestionBankVersion(db);
      const now = Date.now();

      if (
        !options?.bypassCache &&
        ttlMs > 0 &&
        cache.sanitized &&
        cache.sanitizedVersion === remoteVersion &&
        now - cache.sanitizedFetchedAt < ttlMs
      ) {
        return cache.sanitized;
      }

      if (!options?.bypassCache && cache.sanitizedInFlight) {
        return await cache.sanitizedInFlight;
      }

      const loadPromise = (async () => {
        // Read ONLY /questions collection (NEVER /questionKeys) for sanitized endpoints
        const qSnap = await db.collection('questions').get();
        if (qSnap.empty && allowMemoryFallback) {
          return mirror.questions.map(sanitizeQuestionForClient);
        }
        const list: Question[] = [];
        qSnap.forEach(d => {
          const data = d.data() as Partial<ServerQuestion>;
          list.push(
            sanitizeQuestionForClient({
              ...(data as ServerQuestion),
              id: d.id
            })
          );
        });
        if (!options?.bypassCache && ttlMs > 0) {
          cache.sanitized = list;
          cache.sanitizedFetchedAt = Date.now();
          cache.sanitizedVersion = remoteVersion;
        }
        return list;
      })();

      if (!options?.bypassCache) {
        cache.sanitizedInFlight = loadPromise;
      }
      try {
        return await loadPromise;
      } finally {
        if (cache.sanitizedInFlight === loadPromise) {
          delete cache.sanitizedInFlight;
        }
      }
    } catch (err) {
      if (!allowMemoryFallback) {
        throw err;
      }
      if (!isPermissionOrCredentialError(err)) {
        console.warn('Development sanitized questions fallback:', getSafeDiagnosticError(err).message);
      }
    }
  }

  if (!allowMemoryFallback) {
    throw new Error('FIRESTORE_UNAVAILABLE: Questions require Firestore in production.');
  }
  return mirror.questions.map(sanitizeQuestionForClient);
}

export async function getAllQuestionsAuthoritative(
  mirror: MemoryMirror,
  db: Firestore = adminDb,
  allowMemoryFallback = false,
  useFirestoreDb = true,
  options?: { ttlMs?: number; bypassCache?: boolean }
): Promise<ServerQuestion[]> {
  if (useFirestoreDb) {
    const ttlMs = getQuestionBankCacheTtlMs(options?.ttlMs);
    const cache = getCacheEntry(db);
    try {
      const remoteVersion = options?.bypassCache ? '__bypass__' : await fetchRemoteQuestionBankVersion(db);
      const now = Date.now();

      if (
        !options?.bypassCache &&
        ttlMs > 0 &&
        cache.full &&
        cache.fullVersion === remoteVersion &&
        now - cache.fullFetchedAt < ttlMs
      ) {
        return cache.full;
      }

      if (!options?.bypassCache && cache.fullInFlight) {
        return await cache.fullInFlight;
      }

      const loadPromise = (async () => {
        const hasWarmSanitized =
          !options?.bypassCache &&
          ttlMs > 0 &&
          cache.sanitized &&
          cache.sanitizedVersion === remoteVersion &&
          now - cache.sanitizedFetchedAt < ttlMs;

        const [sanitizedDocs, keySnap] = hasWarmSanitized
          ? [null, await db.collection('questionKeys').get()]
          : await Promise.all([db.collection('questions').get(), db.collection('questionKeys').get()]);

        const fallbackMap = allowMemoryFallback
          ? new Map(mirror.questions.map(q => [q.id, q]))
          : new Map<string, ServerQuestion>();
        const keyMap = new Map<string, Record<string, unknown>>();
        keySnap.forEach(d => keyMap.set(d.id, d.data()));

        const list: ServerQuestion[] = [];
        const sanitizedOut: Question[] = [];

        if (sanitizedDocs) {
          if (sanitizedDocs.empty && allowMemoryFallback) {
            return mirror.questions;
          }
          sanitizedDocs.forEach(d => {
            const data = d.data() as Partial<ServerQuestion>;
            const key = keyMap.get(d.id) as Partial<ServerQuestion> | undefined;
            const fb = fallbackMap.get(d.id);
            const fullItem: ServerQuestion = {
              ...(data as ServerQuestion),
              id: d.id,
              correctOptionIndex: key?.correctOptionIndex ?? data.correctOptionIndex ?? fb?.correctOptionIndex ?? 0,
              explanationBn: key?.explanationBn ?? data.explanationBn ?? fb?.explanationBn ?? '',
              explanationEn: key?.explanationEn ?? data.explanationEn ?? fb?.explanationEn ?? ''
            };
            list.push(fullItem);
            sanitizedOut.push(sanitizeQuestionForClient(fullItem));
          });
        } else if (cache.sanitized) {
          if (cache.sanitized.length === 0 && allowMemoryFallback) {
            return mirror.questions;
          }
          for (const base of cache.sanitized) {
            const key = keyMap.get(base.id) as Partial<ServerQuestion> | undefined;
            const fb = fallbackMap.get(base.id);
            list.push({
              ...base,
              correctOptionIndex: key?.correctOptionIndex ?? fb?.correctOptionIndex ?? 0,
              explanationBn: key?.explanationBn ?? fb?.explanationBn ?? '',
              explanationEn: key?.explanationEn ?? fb?.explanationEn ?? ''
            });
          }
        }

        if (!options?.bypassCache && ttlMs > 0) {
          const updatedAt = Date.now();
          cache.full = list;
          cache.fullFetchedAt = updatedAt;
          cache.fullVersion = remoteVersion;
          if (sanitizedDocs) {
            cache.sanitized = sanitizedOut;
            cache.sanitizedFetchedAt = updatedAt;
            cache.sanitizedVersion = remoteVersion;
          }
        }
        return list;
      })();

      if (!options?.bypassCache) {
        cache.fullInFlight = loadPromise;
      }
      try {
        return await loadPromise;
      } finally {
        if (cache.fullInFlight === loadPromise) {
          delete cache.fullInFlight;
        }
      }
    } catch (err) {
      if (!allowMemoryFallback) {
        throw err;
      }
      if (!isPermissionOrCredentialError(err)) {
        console.warn('Development questions fallback:', getSafeDiagnosticError(err).message);
      }
    }
  }

  if (!allowMemoryFallback) {
    throw new Error('FIRESTORE_UNAVAILABLE: Questions require Firestore in production.');
  }
  return mirror.questions;
}

export async function getAuthoritativeExam(
  examId: string,
  mirror: MemoryMirror,
  db: Firestore = adminDb,
  allowMemoryFallback = false,
  useFirestoreDb = true
): Promise<Exam | null> {
  if (useFirestoreDb) {
    try {
      const snap = await db.collection('exams').doc(examId).get();
      if (snap.exists) {
        const data = snap.data() as Omit<Exam, 'id'>;
        return {
          id: snap.id,
          ...data,
          isActive: data.isActive !== undefined ? data.isActive : (!data.isPaid || snap.id === 'exam_model_test_01'),
          scheduledDate: data.scheduledDate || undefined
        };
      }
      if (!allowMemoryFallback) {
        return null;
      }
    } catch (err) {
      if (!allowMemoryFallback) {
        throw err;
      }
      if (!isPermissionOrCredentialError(err)) {
        console.warn('Development exam fallback:', getSafeDiagnosticError(err).message);
      }
    }
  }

  if (!allowMemoryFallback) {
    throw new Error('FIRESTORE_UNAVAILABLE: Exam lookup requires Firestore in production.');
  }
  return mirror.exams.find(e => e.id === examId) || null;
}

export async function getAuthoritativeQuestionMap(
  questionIds: string[],
  mirror: MemoryMirror,
  db: Firestore = adminDb,
  allowMemoryFallback = false,
  useFirestoreDb = true
): Promise<Map<string, ServerQuestion>> {
  const map = new Map<string, ServerQuestion>();
  const mirrorMap = allowMemoryFallback ? new Map(mirror.questions.map(q => [q.id, q])) : new Map<string, ServerQuestion>();

  if (useFirestoreDb && questionIds.length > 0) {
    try {
      for (let i = 0; i < questionIds.length; i += 30) {
        const chunk = questionIds.slice(i, i + 30);
        const [qSnap, kSnap] = await Promise.all([
          db.collection('questions').where('__name__', 'in', chunk).get(),
          db.collection('questionKeys').where('__name__', 'in', chunk).get()
        ]);
        const keyMap = new Map<string, Record<string, unknown>>();
        kSnap.forEach(d => keyMap.set(d.id, d.data()));
        qSnap.forEach(d => {
          const data = d.data() as Partial<ServerQuestion>;
          const key = keyMap.get(d.id) as Partial<ServerQuestion> | undefined;
          const fb = mirrorMap.get(d.id);
          map.set(d.id, {
            ...(data as ServerQuestion),
            id: d.id,
            correctOptionIndex: key?.correctOptionIndex ?? data.correctOptionIndex ?? fb?.correctOptionIndex ?? 0,
            explanationBn: key?.explanationBn ?? data.explanationBn ?? fb?.explanationBn ?? '',
            explanationEn: key?.explanationEn ?? data.explanationEn ?? fb?.explanationEn ?? ''
          });
        });
      }
      if (!allowMemoryFallback) {
        return map;
      }
    } catch (err) {
      if (!allowMemoryFallback) {
        throw err;
      }
      if (!isPermissionOrCredentialError(err)) {
        console.warn('Development question batch fallback:', getSafeDiagnosticError(err).message);
      }
    }
  }

  if (!allowMemoryFallback) {
    throw new Error('FIRESTORE_UNAVAILABLE: Question lookup requires Firestore in production.');
  }

  for (const id of questionIds) {
    if (!map.has(id)) {
      const fb = mirrorMap.get(id);
      if (fb) map.set(id, fb);
    }
  }
  return map;
}

export async function migrateAllSubscriptionTimestampsAdmin(db: Firestore = adminDb): Promise<{
  updatedUsers: number;
  updatedSubscriptions: number;
}> {
  let updatedUsers = 0;
  let updatedSubscriptions = 0;

  const usersSnap = await db.collection('users').get();
  for (const docSnap of usersSnap.docs) {
    const data = docSnap.data();
    if (typeof data.subscriptionExpiresAt === 'string' && data.subscriptionExpiresAt.trim()) {
      const ts = isoToTimestamp(data.subscriptionExpiresAt);
      if (ts) {
        await docSnap.ref.update({ subscriptionExpiresAt: ts });
        updatedUsers++;
      }
    }
  }

  const subsSnap = await db.collection('subscriptions').get();
  for (const docSnap of subsSnap.docs) {
    const data = docSnap.data();
    const patch: Record<string, unknown> = {};
    if (typeof data.expiresAt === 'string' && data.expiresAt.trim()) {
      const ts = isoToTimestamp(data.expiresAt);
      if (ts) patch.expiresAt = ts;
    }
    if (typeof data.activatedAt === 'string' && data.activatedAt.trim()) {
      const ts = isoToTimestamp(data.activatedAt);
      if (ts) patch.activatedAt = ts;
    }
    if (Object.keys(patch).length > 0) {
      await docSnap.ref.update(patch);
      updatedSubscriptions++;
    }
  }

  return { updatedUsers, updatedSubscriptions };
}

export async function importMissingDataToFirestoreAdmin(
  mirror: MemoryMirror,
  db: Firestore = adminDb
): Promise<{
  addedQuestions: number;
  sanitizedExistingQuestions: number;
  addedExams: number;
}> {
  let addedQuestions = 0;
  let sanitizedExistingQuestions = 0;
  let addedExams = 0;

  const [existingQSnap, existingKeySnap, existingExamSnap] = await Promise.all([
    db.collection('questions').get(),
    db.collection('questionKeys').get(),
    db.collection('exams').get()
  ]);

  const existingQMap = new Map(existingQSnap.docs.map(d => [d.id, d.data()]));
  const existingKeyIds = new Set(existingKeySnap.docs.map(d => d.id));
  const existingExamIds = new Set(existingExamSnap.docs.map(d => d.id));

  // Safely seed missing questions AND extract keys out of any legacy /questions docs without deleting any question!
  for (let i = 0; i < mirror.questions.length; i += 200) {
    const chunk = mirror.questions.slice(i, i + 200);
    const batch = db.batch();
    let batchWrites = 0;

    for (const q of chunk) {
      const qRef = db.collection('questions').doc(q.id);
      const kRef = db.collection('questionKeys').doc(q.id);
      const existingData = existingQMap.get(q.id);

      if (!existingData) {
        const sanitized = sanitizeQuestionForClient(q);
        batch.set(qRef, sanitized);
        batch.set(kRef, {
          correctOptionIndex: q.correctOptionIndex,
          explanationBn: q.explanationBn || '',
          explanationEn: q.explanationEn || '',
          legalReference: q.legalReference || '',
          updatedAt: q.updatedAt || new Date().toISOString()
        });
        batchWrites += 2;
        addedQuestions++;
      } else {
        if (!existingKeyIds.has(q.id)) {
          batch.set(kRef, {
            correctOptionIndex: existingData.correctOptionIndex ?? q.correctOptionIndex,
            explanationBn: existingData.explanationBn ?? q.explanationBn ?? '',
            explanationEn: existingData.explanationEn ?? q.explanationEn ?? '',
            legalReference: existingData.legalReference ?? q.legalReference ?? '',
            updatedAt: new Date().toISOString()
          });
          batchWrites++;
        }
        // Strip legacy answer key fields from public /questions/{id} doc if present
        if (
          'correctOptionIndex' in existingData ||
          'explanationBn' in existingData ||
          'explanationEn' in existingData
        ) {
          const cleanCopy = { ...existingData };
          delete cleanCopy.correctOptionIndex;
          delete cleanCopy.explanationBn;
          delete cleanCopy.explanationEn;
          batch.set(qRef, cleanCopy);
          batchWrites++;
          sanitizedExistingQuestions++;
        }
      }
    }

    if (batchWrites > 0) {
      await batch.commit();
    }
  }

  // Safely add missing exams (never overwrite existing customized exams)
  const missingExams = mirror.exams.filter(e => !existingExamIds.has(e.id));
  for (let i = 0; i < missingExams.length; i += 200) {
    const chunk = missingExams.slice(i, i + 200);
    const batch = db.batch();
    for (const exam of chunk) {
      batch.set(db.collection('exams').doc(exam.id), {
        titleBn: exam.titleBn,
        titleEn: exam.titleEn,
        descriptionBn: exam.descriptionBn || '',
        descriptionEn: exam.descriptionEn || '',
        type: exam.type || 'full_mock',
        durationMinutes: exam.durationMinutes || 60,
        totalMarks: exam.totalMarks || 100,
        passThresholdPercentage: exam.passThresholdPercentage || 50,
        isPaid: Boolean(exam.isPaid),
        published: Boolean(exam.published),
        isActive: exam.isActive !== undefined ? Boolean(exam.isActive) : !exam.isPaid,
        scheduledDate: exam.scheduledDate ?? null,
        releaseExplanationsImmediately: exam.releaseExplanationsImmediately ?? true,
        subjectId: exam.subjectId ?? null,
        negativeMarkRatio: exam.negativeMarkRatio ?? 0.25,
        positiveMarkRatio: exam.positiveMarkRatio ?? 1.0,
        questionIds: exam.questionIds || [],
        createdAt: exam.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      addedExams++;
    }
    await batch.commit();
  }

  if (addedQuestions > 0 || sanitizedExistingQuestions > 0) {
    await db
      .collection('config')
      .doc(QUESTION_BANK_VERSION_DOC_ID)
      .set(createQuestionBankVersionPayload(), { merge: true });
    invalidateQuestionBankCache(db);
  }

  return {
    addedQuestions,
    sanitizedExistingQuestions,
    addedExams
  };
}

// =========================================================================
// STAGE 2: SAFE, IDEMPOTENT, CONFLICT-AWARE MIGRATION PLANNER & EXECUTOR
// =========================================================================
export interface MigrationIssue {
  collection: string;
  docId?: string;
  code: string;
  message: string;
}

export interface MigrationPlanReport {
  mode: 'dry-run' | 'execute';
  inspectedAt: string;
  missingCollectionsOrConfig: string[];
  counts: {
    usersScanned: number;
    usersTimestampToUpdate: number;
    subscriptionsScanned: number;
    subscriptionsTimestampToUpdate: number;
    packagesExistingValid: number;
    packagesToCreate: number;
    examDateConfigAction: 'preserve' | 'create' | 'skip_ambiguous' | 'conflict';
    questionsExisting: number;
    questionsToCreate: number;
    questionsToSanitize: number;
    questionKeysToCreate: number;
    examsExisting: number;
    examsToCreate: number;
  };
  warnings: MigrationIssue[];
  conflicts: MigrationIssue[];
  errors: MigrationIssue[];
  totalPlannedWrites: number;
  safeToExecute: boolean;
}

export interface MigrationExecutionResult {
  executed: boolean;
  abortedDueToIssues: boolean;
  writesCommitted: number;
  report: MigrationPlanReport;
}

type PlannedWriteOp =
  | { type: 'set'; collection: string; docId: string; data: Record<string, unknown>; merge?: boolean }
  | { type: 'update'; collection: string; docId: string; data: Record<string, unknown> };

function isValidPackageDoc(data: Record<string, unknown> | undefined): { valid: boolean; reason?: string } {
  if (!data) return { valid: false, reason: 'Document data is empty.' };
  if (typeof data.nameBn !== 'string' || !data.nameBn.trim()) {
    return { valid: false, reason: 'Missing or empty nameBn.' };
  }
  if (typeof data.nameEn !== 'string' || !data.nameEn.trim()) {
    return { valid: false, reason: 'Missing or empty nameEn.' };
  }
  if (typeof data.price !== 'number' || !Number.isFinite(data.price) || data.price <= 0) {
    return { valid: false, reason: 'Price must be a finite number > 0.' };
  }
  if (data.validityType !== 'days' && data.validityType !== 'exam_date') {
    return { valid: false, reason: `Invalid validityType: ${String(data.validityType)}.` };
  }
  if (
    data.validityType === 'days' &&
    (typeof data.durationDays !== 'number' || !Number.isFinite(data.durationDays) || data.durationDays <= 0)
  ) {
    return { valid: false, reason: 'validityType="days" requires durationDays > 0.' };
  }
  if (!Array.isArray(data.featuresBn) || !Array.isArray(data.featuresEn)) {
    return { valid: false, reason: 'featuresBn and featuresEn must be arrays.' };
  }
  return { valid: true };
}

function validateExamDateConfigShape(
  cfg: Partial<ExamDateConfig> | Record<string, unknown> | undefined
): { valid: boolean; reason?: string; normalized?: ExamDateConfig } {
  if (!cfg || typeof cfg !== 'object') {
    return { valid: false, reason: 'examDate configuration object is missing.' };
  }
  const c = cfg as Record<string, unknown>;
  if (typeof c.targetExamDate !== 'string' || !c.targetExamDate.trim()) {
    return { valid: false, reason: 'targetExamDate is missing or empty.' };
  }
  const parsedDate = new Date(c.targetExamDate);
  if (isNaN(parsedDate.getTime())) {
    return { valid: false, reason: `targetExamDate is not a valid date: "${c.targetExamDate}".` };
  }
  if (typeof c.timezone !== 'string' || !c.timezone.trim()) {
    return { valid: false, reason: 'timezone is missing or empty.' };
  }
  if (c.examDatePolicy !== 'extend_all' && c.examDatePolicy !== 'new_only') {
    return { valid: false, reason: `Invalid examDatePolicy: "${String(c.examDatePolicy)}".` };
  }
  if (typeof c.examPassPrice !== 'number' || !Number.isFinite(c.examPassPrice) || c.examPassPrice <= 0) {
    return { valid: false, reason: `Invalid examPassPrice: ${String(c.examPassPrice)}.` };
  }
  if (typeof c.examTitleBn !== 'string' || !c.examTitleBn.trim()) {
    return { valid: false, reason: 'examTitleBn is missing or empty.' };
  }
  if (typeof c.examTitleEn !== 'string' || !c.examTitleEn.trim()) {
    return { valid: false, reason: 'examTitleEn is missing or empty.' };
  }
  return {
    valid: true,
    normalized: {
      targetExamDate: c.targetExamDate,
      timezone: c.timezone,
      examDatePolicy: c.examDatePolicy,
      examPassPrice: c.examPassPrice,
      examTitleBn: c.examTitleBn,
      examTitleEn: c.examTitleEn,
      lastUpdated: typeof c.lastUpdated === 'string' && c.lastUpdated.trim() ? c.lastUpdated : new Date().toISOString()
    }
  };
}

async function buildFirestoreMigrationPlan(options: {
  mirror: MemoryMirror;
  db?: Firestore;
  mode: 'dry-run' | 'execute';
  examDateConfigOverride?: Partial<ExamDateConfig> | null;
}): Promise<{ report: MigrationPlanReport; plannedOps: PlannedWriteOp[] }> {
  const db = options.db || adminDb;
  const mirror = options.mirror;
  const nowIso = new Date().toISOString();

  const [
    usersSnap,
    subsSnap,
    pkgSnap,
    examDateSnap,
    paySettingsSnap,
    supportSettingsSnap,
    subjectsSnap,
    existingQSnap,
    existingKeySnap,
    existingExamSnap
  ] = await Promise.all([
    db.collection('users').get(),
    db.collection('subscriptions').get(),
    db.collection('packages').get(),
    db.collection('config').doc('examDate').get(),
    db.collection('config').doc('paymentSettings').get(),
    db.collection('config').doc('supportSettings').get(),
    db.collection('subjects').get(),
    db.collection('questions').get(),
    db.collection('questionKeys').get(),
    db.collection('exams').get()
  ]);

  const missingCollectionsOrConfig: string[] = [];
  if (pkgSnap.empty) missingCollectionsOrConfig.push('packages');
  if (!examDateSnap.exists) missingCollectionsOrConfig.push('config/examDate');
  if (!paySettingsSnap.exists) missingCollectionsOrConfig.push('config/paymentSettings');
  if (!supportSettingsSnap.exists) missingCollectionsOrConfig.push('config/supportSettings');
  if (subjectsSnap.empty) missingCollectionsOrConfig.push('subjects');
  if (existingQSnap.empty) missingCollectionsOrConfig.push('questions');
  if (existingKeySnap.empty) missingCollectionsOrConfig.push('questionKeys');
  if (existingExamSnap.empty) missingCollectionsOrConfig.push('exams');

  const warnings: MigrationIssue[] = [];
  const conflicts: MigrationIssue[] = [];
  const errors: MigrationIssue[] = [];
  const plannedOps: PlannedWriteOp[] = [];

  if (!paySettingsSnap.exists) {
    warnings.push({
      collection: 'config',
      docId: 'paymentSettings',
      code: 'MISSING_PAYMENT_SETTINGS',
      message: 'config/paymentSettings does not exist yet in Firestore; configure via Owner Admin Panel or verify numbers before production launch.'
    });
  }
  if (!supportSettingsSnap.exists) {
    warnings.push({
      collection: 'config',
      docId: 'supportSettings',
      code: 'MISSING_SUPPORT_SETTINGS',
      message: 'config/supportSettings does not exist yet in Firestore; configure via Owner Admin Panel.'
    });
  }

  // 1. Inspect users & subscriptions timestamp fields
  let usersTimestampToUpdate = 0;
  for (const docSnap of usersSnap.docs) {
    const data = docSnap.data();
    if (typeof data.subscriptionExpiresAt === 'string' && data.subscriptionExpiresAt.trim()) {
      const ts = isoToTimestamp(data.subscriptionExpiresAt);
      if (!ts) {
        errors.push({
          collection: 'users',
          docId: docSnap.id,
          code: 'INVALID_TIMESTAMP_STRING',
          message: `Unparseable subscriptionExpiresAt string: "${data.subscriptionExpiresAt}"`
        });
      } else {
        plannedOps.push({
          type: 'update',
          collection: 'users',
          docId: docSnap.id,
          data: { subscriptionExpiresAt: ts }
        });
        usersTimestampToUpdate++;
      }
    }
  }

  let subscriptionsTimestampToUpdate = 0;
  for (const docSnap of subsSnap.docs) {
    const data = docSnap.data();
    const patch: Record<string, unknown> = {};
    if (typeof data.expiresAt === 'string' && data.expiresAt.trim()) {
      const ts = isoToTimestamp(data.expiresAt);
      if (!ts) {
        errors.push({
          collection: 'subscriptions',
          docId: docSnap.id,
          code: 'INVALID_TIMESTAMP_STRING',
          message: `Unparseable expiresAt string: "${data.expiresAt}"`
        });
      } else {
        patch.expiresAt = ts;
      }
    }
    if (typeof data.activatedAt === 'string' && data.activatedAt.trim()) {
      const ts = isoToTimestamp(data.activatedAt);
      if (!ts) {
        errors.push({
          collection: 'subscriptions',
          docId: docSnap.id,
          code: 'INVALID_TIMESTAMP_STRING',
          message: `Unparseable activatedAt string: "${data.activatedAt}"`
        });
      } else {
        patch.activatedAt = ts;
      }
    }
    if (Object.keys(patch).length > 0) {
      plannedOps.push({
        type: 'update',
        collection: 'subscriptions',
        docId: docSnap.id,
        data: patch
      });
      subscriptionsTimestampToUpdate++;
    }
  }

  // 2. Inspect & plan /packages seeding (never overwrite existing valid package docs)
  const existingPkgMap = new Map(pkgSnap.docs.map(d => [d.id, d.data()]));
  const baselinePkgMap = new Map(mirror.packages.map(p => [p.id, p]));
  let packagesExistingValid = 0;
  let packagesToCreate = 0;

  for (const [pkgId, existingData] of existingPkgMap.entries()) {
    const validation = isValidPackageDoc(existingData);
    if (!validation.valid) {
      conflicts.push({
        collection: 'packages',
        docId: pkgId,
        code: 'INVALID_EXISTING_PACKAGE',
        message: `Existing package "${pkgId}" is invalid or incomplete (${validation.reason}); preserved without overwrite for manual review.`
      });
      continue;
    }
    packagesExistingValid++;
    const baseline = baselinePkgMap.get(pkgId);
    if (baseline) {
      if (
        existingData.price !== baseline.price ||
        existingData.validityType !== baseline.validityType ||
        (baseline.validityType === 'days' && existingData.durationDays !== baseline.durationDays)
      ) {
        warnings.push({
          collection: 'packages',
          docId: pkgId,
          code: 'PACKAGE_DIFFERS_FROM_BASELINE',
          message: `Existing package "${pkgId}" (price=${existingData.price}, validity=${existingData.validityType}) differs from static app baseline (price=${baseline.price}); existing Firestore package will be preserved.`
        });
      }
    }
  }

  for (const pkg of mirror.packages) {
    if (!existingPkgMap.has(pkg.id)) {
      const pkgValidation = isValidPackageDoc(pkg as unknown as Record<string, unknown>);
      if (!pkgValidation.valid) {
        errors.push({
          collection: 'packages',
          docId: pkg.id,
          code: 'INVALID_BASELINE_PACKAGE',
          message: `Application package definition "${pkg.id}" is invalid (${pkgValidation.reason}).`
        });
        continue;
      }
      plannedOps.push({
        type: 'set',
        collection: 'packages',
        docId: pkg.id,
        data: { ...pkg }
      });
      packagesToCreate++;
    }
  }

  // 3. Inspect & plan /config/examDate (never guess missing/ambiguous config)
  let examDateConfigAction: 'preserve' | 'create' | 'skip_ambiguous' | 'conflict' = 'preserve';
  const existingExamPassPkg = existingPkgMap.get('pkg_exam_pass');
  const existingExamDateData = examDateSnap.exists ? examDateSnap.data() : undefined;

  if (examDateSnap.exists) {
    const existingValidation = validateExamDateConfigShape(existingExamDateData);
    if (!existingValidation.valid || !existingValidation.normalized) {
      examDateConfigAction = 'conflict';
      conflicts.push({
        collection: 'config',
        docId: 'examDate',
        code: 'INVALID_EXISTING_EXAM_CONFIG',
        message: `Existing config/examDate is incomplete or ambiguous (${existingValidation.reason}); manual review required.`
      });
    } else if (
      existingExamPassPkg &&
      typeof existingExamPassPkg.price === 'number' &&
      existingExamPassPkg.price !== existingValidation.normalized.examPassPrice
    ) {
      examDateConfigAction = 'conflict';
      conflicts.push({
        collection: 'config',
        docId: 'examDate',
        code: 'EXAM_PASS_PRICE_CONFLICT',
        message: `config/examDate.examPassPrice (${existingValidation.normalized.examPassPrice}) conflicts with packages/pkg_exam_pass.price (${existingExamPassPkg.price}).`
      });
    } else {
      examDateConfigAction = 'preserve';
    }
  } else {
    const candidateConfig =
      options.examDateConfigOverride === null
        ? undefined
        : options.examDateConfigOverride !== undefined
          ? options.examDateConfigOverride
          : mirror.examDateConfig;
    const candidateValidation = validateExamDateConfigShape(candidateConfig);
    if (!candidateValidation.valid || !candidateValidation.normalized) {
      examDateConfigAction = 'skip_ambiguous';
      conflicts.push({
        collection: 'config',
        docId: 'examDate',
        code: 'MISSING_OR_AMBIGUOUS_APP_EXAM_CONFIG',
        message: `Cannot initialize config/examDate because application config is missing or ambiguous (${candidateValidation.reason}). No guessed values will be inserted.`
      });
    } else {
      const appExamPassPkg = mirror.packages.find(p => p.id === 'pkg_exam_pass');
      const firestorePkgPrice =
        existingExamPassPkg && typeof existingExamPassPkg.price === 'number' ? existingExamPassPkg.price : undefined;
      if (firestorePkgPrice !== undefined && firestorePkgPrice !== candidateValidation.normalized.examPassPrice) {
        examDateConfigAction = 'conflict';
        conflicts.push({
          collection: 'config',
          docId: 'examDate',
          code: 'AMBIGUOUS_EXAM_PASS_PRICE',
          message: `Existing packages/pkg_exam_pass.price (${firestorePkgPrice}) differs from app INITIAL_EXAM_DATE_CONFIG.examPassPrice (${candidateValidation.normalized.examPassPrice}); resolve ambiguity manually.`
        });
      } else if (appExamPassPkg && appExamPassPkg.price !== candidateValidation.normalized.examPassPrice) {
        examDateConfigAction = 'conflict';
        conflicts.push({
          collection: 'config',
          docId: 'examDate',
          code: 'APP_EXAM_PASS_PRICE_MISMATCH',
          message: `App pkg_exam_pass.price (${appExamPassPkg.price}) differs from INITIAL_EXAM_DATE_CONFIG.examPassPrice (${candidateValidation.normalized.examPassPrice}).`
        });
      } else {
        examDateConfigAction = 'create';
        plannedOps.push({
          type: 'set',
          collection: 'config',
          docId: 'examDate',
          data: { ...candidateValidation.normalized }
        });
      }
    }
  }

  // 4. Inspect & plan /questions & /questionKeys + /exams
  const existingQMap = new Map(existingQSnap.docs.map(d => [d.id, d.data()]));
  const existingKeyMap = new Map(existingKeySnap.docs.map(d => [d.id, d.data()]));
  const mirrorQMap = new Map(mirror.questions.map(q => [q.id, q]));
  let questionsToCreate = 0;
  let questionsToSanitize = 0;
  let questionKeysToCreate = 0;

  for (const [qId, existingData] of existingQMap.entries()) {
    const existingKey = existingKeyMap.get(qId);
    const hasLegacyFields =
      'correctOptionIndex' in existingData || 'explanationBn' in existingData || 'explanationEn' in existingData;

    if (
      existingKey &&
      typeof existingData.correctOptionIndex === 'number' &&
      typeof existingKey.correctOptionIndex === 'number' &&
      existingData.correctOptionIndex !== existingKey.correctOptionIndex
    ) {
      conflicts.push({
        collection: 'questions',
        docId: qId,
        code: 'QUESTION_KEY_CONFLICT',
        message: `Question "${qId}" has embedded correctOptionIndex (${existingData.correctOptionIndex}) conflicting with questionKeys/${qId} (${existingKey.correctOptionIndex}).`
      });
      continue;
    }

    if (!existingKey) {
      const seed = mirrorQMap.get(qId);
      const resolvedCorrect =
        typeof existingData.correctOptionIndex === 'number' ? existingData.correctOptionIndex : seed?.correctOptionIndex;
      if (typeof resolvedCorrect !== 'number') {
        errors.push({
          collection: 'questions',
          docId: qId,
          code: 'MISSING_QUESTION_KEY',
          message: `Question "${qId}" exists without questionKeys/${qId} and has no correctOptionIndex.`
        });
        continue;
      }
      plannedOps.push({
        type: 'set',
        collection: 'questionKeys',
        docId: qId,
        data: {
          correctOptionIndex: resolvedCorrect,
          explanationBn: String(existingData.explanationBn ?? seed?.explanationBn ?? ''),
          explanationEn: String(existingData.explanationEn ?? seed?.explanationEn ?? ''),
          legalReference: String(existingData.legalReference ?? seed?.legalReference ?? ''),
          updatedAt: nowIso
        }
      });
      questionKeysToCreate++;
    }

    if (hasLegacyFields) {
      const cleanCopy = { ...existingData };
      delete cleanCopy.correctOptionIndex;
      delete cleanCopy.explanationBn;
      delete cleanCopy.explanationEn;
      plannedOps.push({
        type: 'set',
        collection: 'questions',
        docId: qId,
        data: cleanCopy
      });
      questionsToSanitize++;
    }
  }

  for (const q of mirror.questions) {
    if (!existingQMap.has(q.id)) {
      plannedOps.push({
        type: 'set',
        collection: 'questions',
        docId: q.id,
        data: { ...sanitizeQuestionForClient(q) }
      });
      questionsToCreate++;
      if (!existingKeyMap.has(q.id)) {
        plannedOps.push({
          type: 'set',
          collection: 'questionKeys',
          docId: q.id,
          data: {
            correctOptionIndex: q.correctOptionIndex,
            explanationBn: q.explanationBn || '',
            explanationEn: q.explanationEn || '',
            legalReference: q.legalReference || '',
            updatedAt: q.updatedAt || nowIso
          }
        });
        questionKeysToCreate++;
      }
    }
  }

  const existingExamIds = new Set(existingExamSnap.docs.map(d => d.id));
  let examsToCreate = 0;
  for (const exam of mirror.exams) {
    if (!existingExamIds.has(exam.id)) {
      plannedOps.push({
        type: 'set',
        collection: 'exams',
        docId: exam.id,
        data: {
          titleBn: exam.titleBn,
          titleEn: exam.titleEn,
          descriptionBn: exam.descriptionBn || '',
          descriptionEn: exam.descriptionEn || '',
          type: exam.type || 'full_mock',
          durationMinutes: exam.durationMinutes || 60,
          totalMarks: exam.totalMarks || 100,
          passThresholdPercentage: exam.passThresholdPercentage || 50,
          isPaid: Boolean(exam.isPaid),
          published: Boolean(exam.published),
          isActive: exam.isActive !== undefined ? Boolean(exam.isActive) : !exam.isPaid,
          scheduledDate: exam.scheduledDate ?? null,
          releaseExplanationsImmediately: exam.releaseExplanationsImmediately ?? true,
          subjectId: exam.subjectId ?? null,
          negativeMarkRatio: exam.negativeMarkRatio ?? 0.25,
          positiveMarkRatio: exam.positiveMarkRatio ?? 1.0,
          questionIds: exam.questionIds || [],
          createdAt: exam.createdAt || nowIso,
          updatedAt: nowIso
        }
      });
      examsToCreate++;
    }
  }

  const safeToExecute = conflicts.length === 0 && errors.length === 0;
  const report: MigrationPlanReport = {
    mode: options.mode,
    inspectedAt: nowIso,
    missingCollectionsOrConfig,
    counts: {
      usersScanned: usersSnap.size,
      usersTimestampToUpdate,
      subscriptionsScanned: subsSnap.size,
      subscriptionsTimestampToUpdate,
      packagesExistingValid,
      packagesToCreate,
      examDateConfigAction,
      questionsExisting: existingQMap.size,
      questionsToCreate,
      questionsToSanitize,
      questionKeysToCreate,
      examsExisting: existingExamIds.size,
      examsToCreate
    },
    warnings,
    conflicts,
    errors,
    totalPlannedWrites: plannedOps.length,
    safeToExecute
  };

  return { report, plannedOps };
}

export async function planFirestoreMigration(options: {
  mirror: MemoryMirror;
  db?: Firestore;
  examDateConfigOverride?: Partial<ExamDateConfig> | null;
}): Promise<MigrationPlanReport> {
  const { report } = await buildFirestoreMigrationPlan({
    mirror: options.mirror,
    db: options.db,
    mode: 'dry-run',
    examDateConfigOverride: options.examDateConfigOverride
  });
  return report;
}

export async function executeFirestoreMigration(options: {
  mirror: MemoryMirror;
  db?: Firestore;
  dryRun?: boolean;
  execute?: boolean;
  examDateConfigOverride?: Partial<ExamDateConfig> | null;
}): Promise<MigrationExecutionResult> {
  const isExecute = options.execute === true && options.dryRun !== true;
  const { report, plannedOps } = await buildFirestoreMigrationPlan({
    mirror: options.mirror,
    db: options.db,
    mode: isExecute ? 'execute' : 'dry-run',
    examDateConfigOverride: options.examDateConfigOverride
  });

  if (!isExecute) {
    return {
      executed: false,
      abortedDueToIssues: false,
      writesCommitted: 0,
      report
    };
  }

  if (!report.safeToExecute) {
    return {
      executed: false,
      abortedDueToIssues: true,
      writesCommitted: 0,
      report
    };
  }

  const db = options.db || adminDb;
  let writesCommitted = 0;
  for (let i = 0; i < plannedOps.length; i += 200) {
    const chunk = plannedOps.slice(i, i + 200);
    const batch = db.batch();
    for (const op of chunk) {
      const ref = db.collection(op.collection).doc(op.docId);
      if (op.type === 'update') {
        batch.update(ref, op.data);
      } else if (op.merge) {
        batch.set(ref, op.data, { merge: true });
      } else {
        batch.set(ref, op.data);
      }
    }
    await batch.commit();
    writesCommitted += chunk.length;
  }

  if (
    report.counts.questionsToCreate > 0 ||
    report.counts.questionsToSanitize > 0 ||
    report.counts.questionKeysToCreate > 0
  ) {
    await db
      .collection('config')
      .doc(QUESTION_BANK_VERSION_DOC_ID)
      .set(createQuestionBankVersionPayload(new Date().toISOString()), { merge: true });
    writesCommitted += 1;
    invalidateQuestionBankCache(db);
  }

  return {
    executed: true,
    abortedDueToIssues: false,
    writesCommitted,
    report
  };
}

