import 'dotenv/config';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import type { Firestore } from 'firebase-admin/firestore';
import type {
  SubscriptionPackage,
  ExamDateConfig,
  UserSubscription,
  PaymentRequest,
  PaymentSettings,
  SupportContactSettings,
  StudentSession,
  ExamResult,
  ExamAttempt,
  Exam,
  LeaderboardEntry,
  Question,
  ServerQuestion,
  AuditLog,
  UserRole
} from './src/types/index.ts';
import { calculateExamScore } from './src/utils/scoring.ts';
import { getQuestionsForExam } from './src/utils/modelTestGenerator.ts';
import {
  OWNER_ADMIN_UID,
  OWNER_ADMIN_EMAIL,
  adminAuth,
  adminDb,
  persistenceState,
  probeFirestoreAdminConnectivity,
  ensureProductionFirestoreReady,
  createMemoryMirror,
  consumeRateLimit,
  resolveWorkspacePath,
  checkUserHasActiveSubscription,
  getAllQuestionsAuthoritative,
  getSanitizedQuestionsAuthoritative,
  invalidateQuestionBankCache,
  createQuestionBankVersionPayload,
  getConfiguredDatabaseInfo,
  assertExpectedNamedDatabase,
  getAuthoritativeExam,
  getAuthoritativeQuestionMap,
  sanitizeQuestionForClient,
  isoToTimestamp,
  timestampToIso,
  isAlreadyExistsError,
  isPermissionOrCredentialError,
  getSafeDiagnosticError,
  migrateAllSubscriptionTimestampsAdmin,
  importMissingDataToFirestoreAdmin,
  type MemoryMirror
} from './server/services/firestoreBackend.ts';
import { isGeminiConfigured } from './server/services/geminiService.ts';

const __filename = fileURLToPath(import.meta.url);

export interface DecodedAuthUser {
  uid: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
}

export interface AuthenticatedRequest extends Request {
  authUser?: DecodedAuthUser;
  session?: StudentSession;
}

export type TokenVerifier = (idToken: string) => Promise<DecodedAuthUser>;

class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function isOwnerUser(user?: { uid?: string; email?: string; emailVerified?: boolean }): boolean {
  if (!user || !user.uid) return false;
  if (user.uid !== OWNER_ADMIN_UID) return false;
  if (typeof user.email !== 'string' || user.email.trim().toLowerCase() !== OWNER_ADMIN_EMAIL) {
    return false;
  }
  if (user.emailVerified !== true) return false;
  return true;
}

export function calculateSubscriptionExpiry(
  validityType: 'days' | 'exam_date',
  durationDays?: number,
  targetExamDate?: string
): string {
  if (validityType === 'days') {
    const days = durationDays || 90;
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  }
  if (targetExamDate) {
    const d = new Date(targetExamDate);
    if (!isNaN(d.getTime())) {
      return d.toISOString();
    }
  }
  return new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
}

export function parseAllowedOrigins(raw?: string): Set<string> {
  const allowed = new Set<string>();
  const entries = (raw || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  for (const entry of entries) {
    try {
      const parsed = new URL(entry);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        allowed.add(parsed.origin.toLowerCase());
      }
    } catch {
      // Ignore malformed origin entries
    }
  }
  return allowed;
}

export function isOriginAllowed(
  origin?: string,
  options?: { isProduction?: boolean; allowedOriginEnv?: string }
): boolean {
  if (!origin) return true;

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    return false;
  }

  if (parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:') {
    return false;
  }

  const normalizedOrigin = parsedOrigin.origin.toLowerCase();
  const isProd = options?.isProduction ?? (process.env.NODE_ENV === 'production');
  const allowedSet = parseAllowedOrigins(
    options?.allowedOriginEnv !== undefined ? options.allowedOriginEnv : process.env.ALLOWED_ORIGIN
  );

  if (allowedSet.has(normalizedOrigin)) {
    return true;
  }

  const host = parsedOrigin.hostname.toLowerCase();
  if (!isProd && (host === 'localhost' || host === '127.0.0.1')) {
    return true;
  }

  return false;
}

function sendRouteError(
  res: Response,
  context: string,
  err: unknown,
  defaultCode = 'DATABASE_ERROR',
  defaultMessage = 'Database operation failed.'
) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.code, message: err.message });
  }
  if (isAlreadyExistsError(err)) {
    return res.status(409).json({ error: 'ALREADY_EXISTS', message: 'Record already exists.' });
  }
  const safe = getSafeDiagnosticError(err);
  console.error(`[SanadPrep][${context}]`, safe.code ?? '', safe.message);
  return res.status(500).json({ error: defaultCode, message: defaultMessage });
}

export function createSanadPrepApp(options?: {
  tokenVerifier?: TokenVerifier;
  mirror?: MemoryMirror;
  disableFirestoreWrites?: boolean;
  firestoreDb?: Firestore;
  isProduction?: boolean;
  allowedOriginEnv?: string;
  questionBankCacheTtlMs?: number;
  rateLimitOverrides?: {
    windowMs?: number;
    globalMax?: number;
    routeMax?: Record<string, number>;
  };
}) {
  const mirror: MemoryMirror = options?.mirror || createMemoryMirror();
  const isProductionMode = options?.isProduction ?? (process.env.NODE_ENV === 'production');
  const db: Firestore = options?.firestoreDb || adminDb;
  const allowMemoryFallback = !isProductionMode;
  const dbInfo = getConfiguredDatabaseInfo(db);
  const dbValidation = assertExpectedNamedDatabase(db);

  const isFirestoreReady = () => {
    if (options?.disableFirestoreWrites) return false;
    if (options?.firestoreDb) return true;
    return persistenceState.mode === 'firestore';
  };

  const useFirestore = () => isFirestoreReady();

  async function recordAuditLog(entry: AuditLog): Promise<void> {
    if (useFirestore()) {
      await db.collection('auditLogs').doc(entry.id).set(entry);
    }
    if (!isProductionMode) {
      mirror.auditLogs.unshift(entry);
    }
  }

  const verifyIdToken: TokenVerifier =
    options?.tokenVerifier ||
    (async (idToken: string) => {
      const decoded = await adminAuth.verifyIdToken(idToken);
      return {
        uid: decoded.uid,
        email: decoded.email,
        emailVerified: decoded.email_verified === true,
        name: decoded.name || decoded.email?.split('@')[0] || 'Student'
      };
    });

  async function requireProductionDatabase(req: Request, res: Response, next: NextFunction) {
    if (req.path === '/health' || req.path === '/api/health') {
      return next();
    }
    if (isProductionMode && !useFirestore()) {
      if (!options?.firestoreDb && !options?.disableFirestoreWrites && dbValidation.valid) {
        await ensureProductionFirestoreReady(db);
      }
      if (!useFirestore()) {
        return res.status(503).json({
          error: 'FIRESTORE_UNAVAILABLE',
          message: 'Authoritative database unavailable in production.'
        });
      }
    }
    return next();
  }

  function createRateLimiter(bucketName: string, defaultMax: number, keyBy: 'ip' | 'uid' = 'uid') {
    const windowMs = options?.rateLimitOverrides?.windowMs ?? 60_000;
    const maxRequests =
      bucketName === 'global'
        ? (options?.rateLimitOverrides?.globalMax ?? defaultMax)
        : (options?.rateLimitOverrides?.routeMax?.[bucketName] ?? defaultMax);

    return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      if (bucketName === 'global' && (req.path === '/health' || req.path === '/api/health')) {
        return next();
      }
      try {
        const subject =
          keyBy === 'uid' && req.authUser?.uid
            ? `uid_${req.authUser.uid}`
            : `ip_${req.ip || req.socket.remoteAddress || 'unknown'}`;
        const result = await consumeRateLimit({
          key: `${bucketName}:${subject}`,
          windowMs,
          maxRequests,
          db,
          useFirestoreDb: useFirestore()
        });
        res.setHeader('X-RateLimit-Limit', String(result.limit));
        res.setHeader('X-RateLimit-Remaining', String(result.remaining));
        if (!result.allowed) {
          res.setHeader('Retry-After', String(result.retryAfterSeconds));
          return res.status(429).json({
            error: 'RATE_LIMITED',
            retryAfterSeconds: result.retryAfterSeconds,
            message: `অতিরিক্ত অনুরোধ পাঠানো হয়েছে। অনুগ্রহ করে ${result.retryAfterSeconds} সেকেন্ড পর আবার চেষ্টা করুন।`
          });
        }
        return next();
      } catch (err) {
        return sendRouteError(res, `rateLimit:${bucketName}`, err);
      }
    };
  }

  const globalRateLimiter = createRateLimiter('global', 120, 'ip');
  const practiceCheckRateLimiter = createRateLimiter('practice_check', 30, 'uid');
  const authSessionRateLimiter = createRateLimiter('auth_session', 15, 'uid');
  const paymentsCreateRateLimiter = createRateLimiter('payments_create', 10, 'uid');
  const examsStartRateLimiter = createRateLimiter('exams_start', 15, 'uid');
  const examsSubmitRateLimiter = createRateLimiter('exams_submit', 15, 'uid');

  async function requireFirebaseAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'Authentication required. Please sign in with Firebase.'
      });
    }

    const idToken = authHeader.substring(7).trim();
    if (!idToken) {
      return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Missing bearer token.' });
    }

    try {
      const decoded = await verifyIdToken(idToken);
      if (decoded.emailVerified !== true) {
        return res.status(403).json({
          error: 'EMAIL_NOT_VERIFIED',
          message: 'অ্যাকাউন্ট সক্রিয় করতে অনুগ্রহ করে আপনার ইমেইল ভেরিফাই করুন।'
        });
      }
      req.authUser = decoded;
      return next();
    } catch {
      return res.status(401).json({
        error: 'INVALID_TOKEN',
        message: 'Invalid or expired authentication token.'
      });
    }
  }

  function requireOwnerAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    if (!isOwnerUser(req.authUser)) {
      return res.status(403).json({
        error: 'FORBIDDEN',
        message: 'Access restricted to verified Owner Administrator only.'
      });
    }
    return next();
  }

  async function authenticateSession(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    const sessionTokenHeader = req.headers['x-session-id'];
    const token = typeof sessionTokenHeader === 'string' ? sessionTokenHeader.trim() : '';
    if (!token) {
      return res.status(401).json({
        error: 'SESSION_REQUIRED',
        message: 'সক্রিয় ডিভাইস সেশন পাওয়া যায়নি। অনুগ্রহ করে পুনরায় সাইন ইন করুন।'
      });
    }

    if (useFirestore()) {
      try {
        const uid = req.authUser?.uid;
        const [sessSnap, userSessSnap] = await Promise.all([
          db.collection('sessions').doc(token).get(),
          uid ? db.collection('userSessions').doc(uid).get() : Promise.resolve(null)
        ]);

        if (!sessSnap.exists) {
          return res.status(401).json({
            error: 'SESSION_REQUIRED',
            message: 'সেশনটি খুঁজে পাওয়া যায়নি বা মেয়াদ শেষ হয়েছে। অনুগ্রহ করে পুনরায় সাইন ইন করুন।'
          });
        }

        const session = sessSnap.data() as StudentSession;
        if (req.authUser && session.userId !== req.authUser.uid) {
          return res.status(403).json({
            error: 'SESSION_MISMATCH',
            message: 'Session does not match authenticated user.'
          });
        }

        const currentActiveId = userSessSnap?.exists
          ? (userSessSnap.data()?.activeSessionId as string | undefined)
          : undefined;

        if (session.status === 'revoked' || (currentActiveId && currentActiveId !== token)) {
          if (session.status !== 'revoked') {
            await db
              .collection('sessions')
              .doc(token)
              .update({ status: 'revoked', revokedReason: 'Logged in from another device/browser' });
          }
          return res.status(401).json({
            error: 'SESSION_REVOKED',
            message: 'একই অ্যাকাউন্ট অন্য ডিভাইস থেকে লগইন করা হয়েছে। আপনার পূর্ববর্তী সেশনটি বন্ধ করা হয়েছে।'
          });
        }

        const nowIso = new Date().toISOString();
        await db.collection('sessions').doc(token).update({ lastActiveAt: nowIso });
        req.session = { ...session, lastActiveAt: nowIso };
        return next();
      } catch (err) {
        return sendRouteError(
          res,
          'authenticateSession',
          err,
          'SESSION_CHECK_FAILED',
          'Failed to verify session state.'
        );
      }
    }

    if (!allowMemoryFallback) {
      return res.status(503).json({ error: 'FIRESTORE_UNAVAILABLE', message: 'Database unavailable.' });
    }

    const session = mirror.sessions[token];
    if (!session) {
      return res.status(401).json({
        error: 'SESSION_REQUIRED',
        message: 'সেশনটি খুঁজে পাওয়া যায়নি বা মেয়াদ শেষ হয়েছে। অনুগ্রহ করে পুনরায় সাইন ইন করুন।'
      });
    }
    if (req.authUser && session.userId !== req.authUser.uid) {
      return res.status(403).json({ error: 'SESSION_MISMATCH', message: 'Session does not match authenticated user.' });
    }
    if (session.status === 'revoked') {
      return res.status(401).json({
        error: 'SESSION_REVOKED',
        message: 'একই অ্যাকাউন্ট অন্য ডিভাইস থেকে লগইন করা হয়েছে। আপনার পূর্ববর্তী সেশনটি বন্ধ করা হয়েছে।'
      });
    }
    const currentActive = mirror.userActiveSessions[session.userId];
    if (currentActive && currentActive !== token) {
      session.status = 'revoked';
      session.revokedReason = 'Logged in from another device/browser';
      return res.status(401).json({
        error: 'SESSION_REVOKED',
        message: 'Multi-device account sharing protection: Session revoked.'
      });
    }
    session.lastActiveAt = new Date().toISOString();
    req.session = session;
    return next();
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const hostHeader = String(req.headers['x-forwarded-host'] || req.headers.host || '')
      .split(',')[0]
      .trim()
      .toLowerCase();
    const isAiStudioHost = /^ais-(dev|pre)-[a-z0-9-]+\.[a-z0-9.-]+\.run\.app(?::\d+)?$/.test(hostHeader);
    const isApiOrHealth = req.path === '/health' || req.path.startsWith('/api');

    if (isApiOrHealth || (isProductionMode && !isAiStudioHost)) {
      res.setHeader('X-Frame-Options', 'DENY');
    } else {
      res.setHeader(
        'Content-Security-Policy',
        "frame-ancestors 'self' https://aistudio.google.com https://*.google.com https://*.googleusercontent.com https://*.usercontent.goog"
      );
    }
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    if (isProductionMode) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });
  app.use(['/api', '/health'], (req, res, next) => {
    const reqOrigin = req.headers.origin;
    const forwardedHost = String(req.headers['x-forwarded-host'] || '')
      .split(',')[0]
      .trim()
      .toLowerCase();
    let isSameAiStudioPreviewOrigin = false;
    if (reqOrigin && forwardedHost && /^ais-(dev|pre)-[a-z0-9-]+\.[a-z0-9.-]+\.run\.app(?::\d+)?$/.test(forwardedHost)) {
      try {
        const parsed = new URL(reqOrigin);
        isSameAiStudioPreviewOrigin =
          parsed.protocol === 'https:' && parsed.host.toLowerCase() === forwardedHost;
      } catch {
        isSameAiStudioPreviewOrigin = false;
      }
    }

    return cors({
      origin: (origin, callback) => {
        if (
          isSameAiStudioPreviewOrigin ||
          isOriginAllowed(origin, {
            isProduction: isProductionMode,
            allowedOriginEnv: options?.allowedOriginEnv
          })
        ) {
          callback(null, true);
        } else {
          callback(new HttpError(403, 'CORS_ORIGIN_NOT_ALLOWED', 'Origin not allowed by CORS policy.'));
        }
      },
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Session-Id'],
      credentials: true
    })(req, res, next);
  });
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof HttpError && err.code === 'CORS_ORIGIN_NOT_ALLOWED') {
      return res.status(403).json({ error: err.code, message: err.message });
    }
    return next(err);
  });
  app.use(express.json({ limit: '5mb' }));
  app.use(['/api/previous-questions', '/api/admin/previous-questions'], (_req, res) => {
    return res.status(404).json({
      error: 'NOT_FOUND',
      message: 'This endpoint has been permanently retired.'
    });
  });
  app.use('/api', requireProductionDatabase);
  app.use('/api', globalRateLimiter);

  // ---------------------------------------------------------
  // HEALTH & PUBLIC CONFIGURATION ENDPOINTS
  // ---------------------------------------------------------
  app.get(['/health', '/api/health'], async (_req, res) => {
    if (isProductionMode && !useFirestore() && !options?.firestoreDb && !options?.disableFirestoreWrites && dbValidation.valid) {
      await ensureProductionFirestoreReady(db);
    }
    const mode = useFirestore() ? 'firestore' : isProductionMode ? 'unavailable' : 'memory-fallback';
    const healthy = !isProductionMode || (mode === 'firestore' && dbValidation.valid);
    return res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      service: 'Sanad Prep BD Subscription & Examination Engine',
      persistenceMode: mode,
      environment: isProductionMode ? 'production' : 'development',
      projectId: dbInfo.projectId,
      databaseId: dbInfo.configuredDatabaseId,
      expectedDatabaseMatched: dbValidation.valid,
      questionBankCount: mirror.questions.length,
      examCount: mirror.exams.length,
      geminiConfigured: isGeminiConfigured(),
      serverTime: new Date().toISOString(),
      timezone: mirror.examDateConfig.timezone
    });
  });

  app.get('/api/packages', async (_req, res) => {
    try {
      if (useFirestore()) {
        const [pkgSnap, configSnap] = await Promise.all([
          db.collection('packages').get(),
          db.collection('config').doc('examDate').get()
        ]);
        const examPassPrice = configSnap.exists ? (configSnap.data()?.examPassPrice as number | undefined) : undefined;
        const packagesList = pkgSnap.docs.map(d => ({
          id: d.id,
          ...(d.data() as Omit<SubscriptionPackage, 'id'>)
        }));
        const active = packagesList.filter(p => p.isActive && !p.isArchived);
        const mapped = active.map(p =>
          p.id === 'pkg_exam_pass' && typeof examPassPrice === 'number' ? { ...p, price: examPassPrice } : p
        );
        return res.json({ packages: mapped });
      }

      if (!allowMemoryFallback) {
        return res.status(503).json({ error: 'FIRESTORE_UNAVAILABLE' });
      }
      const active = mirror.packages.filter(p => p.isActive && !p.isArchived);
      const mapped = active.map(p =>
        p.id === 'pkg_exam_pass' ? { ...p, price: mirror.examDateConfig.examPassPrice } : p
      );
      return res.json({ packages: mapped });
    } catch (err) {
      return sendRouteError(res, 'GET /api/packages', err);
    }
  });

  app.get('/api/exam-config', async (_req, res) => {
    try {
      if (useFirestore()) {
        const snap = await db.collection('config').doc('examDate').get();
        const examDateConfig = snap.exists
          ? { ...mirror.examDateConfig, ...(snap.data() as Partial<ExamDateConfig>) }
          : mirror.examDateConfig;
        return res.json({ examDateConfig });
      }
      if (!allowMemoryFallback) {
        return res.status(503).json({ error: 'FIRESTORE_UNAVAILABLE' });
      }
      return res.json({ examDateConfig: mirror.examDateConfig });
    } catch (err) {
      return sendRouteError(res, 'GET /api/exam-config', err);
    }
  });

  app.get('/api/payment-settings', async (_req, res) => {
    try {
      if (useFirestore()) {
        const [paySnap, supSnap] = await Promise.all([
          db.collection('config').doc('paymentSettings').get(),
          db.collection('config').doc('supportSettings').get()
        ]);
        const paymentSettings: PaymentSettings = {
          ...mirror.paymentSettings,
          ...(paySnap.exists ? (paySnap.data() as Partial<PaymentSettings>) : {})
        };
        const supportSettings: SupportContactSettings = {
          ...mirror.supportSettings,
          ...(supSnap.exists ? (supSnap.data() as Partial<SupportContactSettings>) : {})
        };
        if (supSnap.exists) {
          paymentSettings.whatsappNumber = supportSettings.whatsappNumber;
          paymentSettings.whatsappMessage = supportSettings.whatsappMessage;
        }
        return res.json({ paymentSettings, supportSettings });
      }
      if (!allowMemoryFallback) {
        return res.status(503).json({ error: 'FIRESTORE_UNAVAILABLE' });
      }
      return res.json({
        paymentSettings: mirror.paymentSettings,
        supportSettings: mirror.supportSettings
      });
    } catch (err) {
      return sendRouteError(res, 'GET /api/payment-settings', err);
    }
  });

  app.get('/api/support-settings', async (_req, res) => {
    try {
      if (useFirestore()) {
        const supSnap = await db.collection('config').doc('supportSettings').get();
        const supportSettings: SupportContactSettings = {
          ...mirror.supportSettings,
          ...(supSnap.exists ? (supSnap.data() as Partial<SupportContactSettings>) : {})
        };
        return res.json({ supportSettings });
      }
      if (!allowMemoryFallback) {
        return res.status(503).json({ error: 'FIRESTORE_UNAVAILABLE' });
      }
      return res.json({ supportSettings: mirror.supportSettings });
    } catch (err) {
      return sendRouteError(res, 'GET /api/support-settings', err);
    }
  });

  app.get('/api/subjects', async (_req, res) => {
    try {
      if (useFirestore()) {
        const snap = await db.collection('subjects').get();
        const subjectList = snap.docs.map(d => ({
          id: d.id,
          ...(d.data() as Record<string, unknown>)
        }));
        return res.json({ subjects: subjectList.length > 0 ? subjectList : mirror.subjects });
      }
      if (!allowMemoryFallback) {
        return res.status(503).json({ error: 'FIRESTORE_UNAVAILABLE' });
      }
      return res.json({ subjects: mirror.subjects });
    } catch (err) {
      return sendRouteError(res, 'GET /api/subjects', err);
    }
  });

  app.get('/api/subjects/counts', async (_req, res) => {
    try {
      const list = await getSanitizedQuestionsAuthoritative(
        mirror,
        db,
        allowMemoryFallback,
        useFirestore(),
        { ttlMs: options?.questionBankCacheTtlMs }
      );
      const counts: Record<string, number> = {};
      for (const q of list) {
        if (q.subjectId) {
          counts[q.subjectId] = (counts[q.subjectId] || 0) + 1;
        }
      }
      return res.json({ counts, total: list.length });
    } catch (err) {
      return sendRouteError(res, 'GET /api/subjects/counts', err);
    }
  });

  app.get('/api/exams', async (_req, res) => {
    try {
      if (useFirestore()) {
        const snap = await db.collection('exams').get();
        const examList = snap.docs.map(d => {
          const data = d.data() as Omit<Exam, 'id'>;
          return {
            id: d.id,
            ...data,
            isActive: data.isActive !== undefined ? data.isActive : (!data.isPaid || d.id === 'exam_model_test_01'),
            scheduledDate: data.scheduledDate || undefined
          };
        });
        return res.json({ exams: examList });
      }
      if (!allowMemoryFallback) {
        return res.status(503).json({ error: 'FIRESTORE_UNAVAILABLE' });
      }
      return res.json({ exams: mirror.exams });
    } catch (err) {
      return sendRouteError(res, 'GET /api/exams', err);
    }
  });

  app.get('/api/leaderboard', async (req, res) => {
    try {
      const examId = typeof req.query.examId === 'string' ? req.query.examId : undefined;
      let entries: LeaderboardEntry[];
      if (useFirestore()) {
        const qRef =
          examId && examId !== 'all'
            ? db.collection('leaderboard').where('examId', '==', examId)
            : db.collection('leaderboard');
        const snap = await qRef.get();
        entries = snap.docs.map(d => d.data() as LeaderboardEntry);
      } else {
        if (!allowMemoryFallback) {
          return res.status(503).json({ error: 'FIRESTORE_UNAVAILABLE' });
        }
        entries = [...mirror.leaderboard];
        if (examId && examId !== 'all') {
          entries = entries.filter(e => e.examId === examId);
        }
      }

      entries.sort((a, b) => b.score - a.score || a.timeSpentSeconds - b.timeSpentSeconds);
      const top50 = entries.slice(0, 50).map((e, i) => ({ ...e, rank: i + 1 }));
      return res.json({ leaderboard: top50 });
    } catch (err) {
      return sendRouteError(res, 'GET /api/leaderboard', err);
    }
  });

  // ---------------------------------------------------------
  // SANITIZED QUESTIONS & PRACTICE VERIFICATION
  // (NEVER exposes correctOptionIndex or explanations pre-submission!)
  // ---------------------------------------------------------
  app.get('/api/questions', requireFirebaseAuth, authenticateSession, async (req: AuthenticatedRequest, res) => {
    try {
      const subjectId = typeof req.query.subjectId === 'string' ? req.query.subjectId : undefined;
      const examId = typeof req.query.examId === 'string' ? req.query.examId : undefined;
      const search = typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : '';
      const rawLimit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
      const rawOffset = typeof req.query.offset === 'string' ? Number(req.query.offset) : 0;
      const uid = req.authUser!.uid;
      const isOwner = isOwnerUser(req.authUser);

      // Uses version-checked TTL cache and reads ONLY /questions (never /questionKeys)
      let list: Question[] = await getSanitizedQuestionsAuthoritative(
        mirror,
        db,
        allowMemoryFallback,
        useFirestore(),
        { ttlMs: options?.questionBankCacheTtlMs }
      );

      if (subjectId) {
        list = list.filter(q => q.subjectId === subjectId);
      }
      if (search) {
        list = list.filter(
          q =>
            q.questionBn.toLowerCase().includes(search) ||
            (q.questionEn || '').toLowerCase().includes(search) ||
            (q.legalReference || '').toLowerCase().includes(search)
        );
      }
      if (examId) {
        const targetExam = await getAuthoritativeExam(
          examId,
          mirror,
          db,
          allowMemoryFallback,
          useFirestore()
        );
        if (targetExam) {
          if (targetExam.isPaid && !isOwner) {
            const subCheck = await checkUserHasActiveSubscription(
              uid,
              mirror,
              db,
              allowMemoryFallback,
              useFirestore()
            );
            if (!subCheck.active) {
              return res.status(403).json({
                error: 'SUBSCRIPTION_REQUIRED',
                message: 'Pro subscription required to access paid exam questions.'
              });
            }
          }
          list = getQuestionsForExam(targetExam, list);
        }
      }

      const sanitized = list.map(sanitizeQuestionForClient);
      const total = sanitized.length;

      if (rawLimit !== undefined && Number.isFinite(rawLimit) && rawLimit > 0) {
        const safeLimit = Math.min(500, Math.floor(rawLimit));
        const safeOffset = Number.isFinite(rawOffset) && rawOffset >= 0 ? Math.floor(rawOffset) : 0;
        const sliced = sanitized.slice(safeOffset, safeOffset + safeLimit);
        return res.json({
          questions: sliced,
          total,
          limit: safeLimit,
          offset: safeOffset,
          hasMore: safeOffset + sliced.length < total
        });
      }

      return res.json({ questions: sanitized, total });
    } catch (err) {
      return sendRouteError(res, 'GET /api/questions', err);
    }
  });

  app.post('/api/practice/check', requireFirebaseAuth, practiceCheckRateLimiter, authenticateSession, async (req: AuthenticatedRequest, res) => {
    try {
      const uid = req.authUser!.uid;
      const isOwner = isOwnerUser(req.authUser);
      const { questionId, selectedOption } = req.body || {};
      const cleanQuestionId = typeof questionId === 'string' ? questionId.trim() : '';

      if (
        !cleanQuestionId ||
        cleanQuestionId.length > 128 ||
        typeof selectedOption !== 'number' ||
        !Number.isInteger(selectedOption) ||
        selectedOption < 0 ||
        selectedOption > 3
      ) {
        return res.status(400).json({
          error: 'INVALID_REQUEST',
          message: 'Valid questionId and integer selectedOption (0-3) are required.'
        });
      }

      const qMap = await getAuthoritativeQuestionMap(
        [cleanQuestionId],
        mirror,
        db,
        allowMemoryFallback,
        useFirestore()
      );
      const q = qMap.get(cleanQuestionId);
      if (!q) {
        return res.status(404).json({ error: 'QUESTION_NOT_FOUND', message: 'Question not found.' });
      }

      if (!q.isDemoSample && !isOwner) {
        const subCheck = await checkUserHasActiveSubscription(
          uid,
          mirror,
          db,
          allowMemoryFallback,
          useFirestore()
        );
        if (!subCheck.active) {
          return res.status(403).json({
            error: 'SUBSCRIPTION_REQUIRED',
            message: 'বিষয়ভিত্তিক অনুশীলন ও উত্তর যাচাইয়ের জন্য সক্রিয় প্রো সাবস্ক্রিপশন প্রয়োজন।'
          });
        }
      }

      const isCorrect = selectedOption === q.correctOptionIndex;
      return res.json({
        success: true,
        questionId: q.id,
        isCorrect,
        correctOptionIndex: q.correctOptionIndex,
        explanationBn: q.explanationBn || '',
        explanationEn: q.explanationEn || '',
        legalReference: q.legalReference || ''
      });
    } catch (err) {
      return sendRouteError(res, 'POST /api/practice/check', err);
    }
  });

  // ---------------------------------------------------------
  // SESSION & SUBSCRIPTION STATUS (Persistent across Cloud Run instances)
  // ---------------------------------------------------------
  app.post('/api/auth/session', requireFirebaseAuth, authSessionRateLimiter, async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.authUser!.uid;
      const userEmail = req.authUser!.email || '';
      const userName = String(req.body?.userName || req.authUser!.name || 'Student').slice(0, 100);
      const deviceInfo = String(req.body?.deviceInfo || req.headers['user-agent'] || 'Web Browser').slice(0, 160);

      const nowIso = new Date().toISOString();
      const sessionId = `sess_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      const newSession: StudentSession = {
        sessionId,
        userId,
        userEmail,
        userName,
        deviceInfo,
        createdAt: nowIso,
        lastActiveAt: nowIso,
        status: 'active'
      };

      if (useFirestore()) {
        await db.runTransaction(async (tx) => {
          const userSessRef = db.collection('userSessions').doc(userId);
          const userSessSnap = await tx.get(userSessRef);
          const prevSessionId = userSessSnap.exists
            ? (userSessSnap.data()?.activeSessionId as string | undefined)
            : undefined;

          let prevSnapExists = false;
          const prevSessRef = prevSessionId ? db.collection('sessions').doc(prevSessionId) : null;
          if (prevSessRef) {
            const prevSnap = await tx.get(prevSessRef);
            prevSnapExists = prevSnap.exists;
          }

          if (prevSessRef && prevSnapExists) {
            tx.update(prevSessRef, {
              status: 'revoked',
              revokedReason: 'Logged in from another device or tab (Single active session enforcement)'
            });
            const auditRef = db.collection('auditLogs').doc(`log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`);
            tx.set(auditRef, {
              id: auditRef.id,
              userId,
              userName,
              action: 'SESSION_REVOKED_CONCURRENT',
              details: `Previous session ${prevSessionId!.substring(0, 8)}... revoked due to new login.`,
              timestamp: nowIso
            });
          }

          tx.set(db.collection('sessions').doc(sessionId), newSession);
          tx.set(userSessRef, { activeSessionId: sessionId, updatedAt: nowIso });
        });
      } else {
        if (!allowMemoryFallback) {
          return res.status(503).json({ error: 'FIRESTORE_UNAVAILABLE' });
        }
        const previousSessionId = mirror.userActiveSessions[userId];
        if (previousSessionId && mirror.sessions[previousSessionId]) {
          mirror.sessions[previousSessionId].status = 'revoked';
          mirror.sessions[previousSessionId].revokedReason =
            'Logged in from another device or tab (Single active session enforcement)';
          mirror.auditLogs.unshift({
            id: `log_${Date.now()}`,
            userId,
            userName,
            action: 'SESSION_REVOKED_CONCURRENT',
            details: `Previous session ${previousSessionId.substring(0, 8)}... revoked due to new login.`,
            timestamp: nowIso
          });
        }
        mirror.sessions[sessionId] = newSession;
        mirror.userActiveSessions[userId] = sessionId;
      }

      const subStatus = await checkUserHasActiveSubscription(
        userId,
        mirror,
        db,
        allowMemoryFallback,
        useFirestore()
      );
      return res.json({
        success: true,
        sessionId,
        session: newSession,
        activeSubscription: subStatus.activeSubscription
      });
    } catch (err) {
      return sendRouteError(res, 'POST /api/auth/session', err, 'SESSION_CREATE_FAILED', 'Failed to establish session.');
    }
  });

  app.get('/api/auth/session/status', requireFirebaseAuth, authenticateSession, async (req: AuthenticatedRequest, res) => {
    try {
      const uid = req.authUser!.uid;
      const subStatus = await checkUserHasActiveSubscription(
        uid,
        mirror,
        db,
        allowMemoryFallback,
        useFirestore()
      );
      return res.json({
        active: true,
        session: req.session || null,
        activeSubscription: subStatus.activeSubscription
      });
    } catch (err) {
      return sendRouteError(res, 'GET /api/auth/session/status', err);
    }
  });

  app.post('/api/auth/logout', requireFirebaseAuth, authenticateSession, async (req: AuthenticatedRequest, res) => {
    try {
      const uid = req.authUser!.uid;
      const tokenHeader = req.headers['x-session-id'];
      const sessionId = typeof tokenHeader === 'string' ? tokenHeader.trim() : req.session?.sessionId;
      const nowIso = new Date().toISOString();

      if (useFirestore()) {
        if (sessionId) {
          await db.runTransaction(async (tx) => {
            const sessRef = db.collection('sessions').doc(sessionId);
            const userSessRef = db.collection('userSessions').doc(uid);
            const [sessSnap, userSessSnap] = await Promise.all([tx.get(sessRef), tx.get(userSessRef)]);
            if (sessSnap.exists) {
              tx.update(sessRef, {
                status: 'revoked',
                revokedReason: 'Logged out by user',
                lastActiveAt: nowIso
              });
            }
            if (userSessSnap.exists && userSessSnap.data()?.activeSessionId === sessionId) {
              tx.delete(userSessRef);
            }
          });
        }
        return res.json({ success: true });
      }

      if (!allowMemoryFallback) {
        return res.status(503).json({ error: 'FIRESTORE_UNAVAILABLE' });
      }

      if (sessionId && mirror.sessions[sessionId]) {
        mirror.sessions[sessionId].status = 'revoked';
        mirror.sessions[sessionId].revokedReason = 'Logged out by user';
        mirror.sessions[sessionId].lastActiveAt = nowIso;
      }
      if (sessionId && mirror.userActiveSessions[uid] === sessionId) {
        delete mirror.userActiveSessions[uid];
      }
      return res.json({ success: true });
    } catch (err) {
      return sendRouteError(res, 'POST /api/auth/logout', err, 'LOGOUT_FAILED', 'Failed to revoke session.');
    }
  });

  // ---------------------------------------------------------
  // PAYMENT SUBMISSION (Priority 1 Hardened + Authoritative Firestore Pricing)
  // ---------------------------------------------------------
  app.post('/api/payments/create', requireFirebaseAuth, paymentsCreateRateLimiter, authenticateSession, async (req: AuthenticatedRequest, res) => {
    try {
      const uid = req.authUser!.uid;
      const { method, senderNumber, transactionId, packageId, studentPhone, studentName } = req.body || {};
      const cleanSenderNumber = typeof senderNumber === 'string' ? senderNumber.trim() : '';

      if (!method || !cleanSenderNumber || !transactionId || !packageId) {
        return res.status(400).json({
          error: 'MISSING_FIELDS',
          message: 'অনুগ্রহ করে সকল আবশ্যিক পেমেন্ট তথ্য প্রদান করুন। (Missing required payment fields)'
        });
      }

      if (!['bKash', 'Nagad', 'Rocket'].includes(String(method))) {
        return res.status(400).json({
          error: 'INVALID_METHOD',
          message: 'অবৈধ পেমেন্ট মাধ্যম। bKash বা Nagad ব্যবহার করুন।'
        });
      }

      if (cleanSenderNumber.length < 6 || cleanSenderNumber.length > 20) {
        return res.status(400).json({
          error: 'INVALID_SENDER_NUMBER',
          message: 'সঠিক প্রেরকের মোবাইল নম্বর প্রদান করুন।'
        });
      }

      const cleanTrxId = String(transactionId)
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '');

      if (cleanTrxId.length < 4 || cleanTrxId.length > 64) {
        return res.status(400).json({
          error: 'INVALID_TRX_ID',
          message: 'সঠিক ট্রানজাকশন আইডি (TrxID) প্রদান করুন (৪–৬৪ অক্ষর)।'
        });
      }

      const docId = `trx_${cleanTrxId}`;

      let pkg: SubscriptionPackage | undefined;
      let authoritativeAmount = 0;

      if (useFirestore()) {
        const [pkgSnap, configSnap, dupQuerySnap, dupSubSnap] = await Promise.all([
          db.collection('packages').doc(String(packageId)).get(),
          db.collection('config').doc('examDate').get(),
          db.collection('paymentRequests').where('transactionId', '==', cleanTrxId).limit(1).get(),
          db.collection('subscriptions').where('transactionId', '==', cleanTrxId).limit(1).get()
        ]);

        if (!pkgSnap.exists) {
          return res.status(404).json({
            error: 'PACKAGE_NOT_FOUND',
            message: 'নির্বাচিত সাবস্ক্রিপশন প্যাকেজটি ডাটাবেজে পাওয়া যায়নি।'
          });
        }
        const pkgData = pkgSnap.data() as Omit<SubscriptionPackage, 'id'>;
        if (!pkgData.isActive || pkgData.isArchived) {
          return res.status(404).json({
            error: 'PACKAGE_NOT_FOUND',
            message: 'নির্বাচিত সাবস্ক্রিপশন প্যাকেজটি বর্তমানে নিষ্ক্রিয় রয়েছে।'
          });
        }
        pkg = { id: pkgSnap.id, ...pkgData };

        const examPassConfigPrice = configSnap.exists
          ? Number(configSnap.data()?.examPassPrice)
          : NaN;
        authoritativeAmount =
          pkg.id === 'pkg_exam_pass' && !isNaN(examPassConfigPrice) && examPassConfigPrice > 0
            ? examPassConfigPrice
            : Number(pkg.price);

        if (!dupQuerySnap.empty) {
          const existingDoc = dupQuerySnap.docs[0].data() as PaymentRequest;
          return res.status(409).json({
            error: 'DUPLICATE_TRX_ID',
            message:
              existingDoc.status === 'rejected'
                ? 'এই ট্রানজাকশন আইডিটি (TrxID) পূর্বে বাতিল করা হয়েছে এবং পুনরায় জমা দেওয়া যাবে না।'
                : 'এই ট্রানজাকশন আইডিটি (TrxID) ইতিপূর্বে ব্যবহার করা হয়েছে। একই TrxID পুনরায় গ্রহণযোগ্য নয়।'
          });
        }
        if (!dupSubSnap.empty) {
          return res.status(409).json({
            error: 'DUPLICATE_TRX_ID',
            message: 'এই ট্রানজাকশন আইডিটি (TrxID) ইতিপূর্বে একটি সাবস্ক্রিপশনে ব্যবহৃত হয়েছে।'
          });
        }
      } else {
        if (!allowMemoryFallback) {
          return res.status(503).json({ error: 'FIRESTORE_UNAVAILABLE' });
        }
        pkg = mirror.packages.find(p => p.id === packageId && p.isActive && !p.isArchived);
        if (!pkg) {
          return res.status(404).json({
            error: 'PACKAGE_NOT_FOUND',
            message: 'নির্বাচিত সাবস্ক্রিপশন প্যাকেজটি পাওয়া যায়নি বা নিষ্ক্রিয় রয়েছে।'
          });
        }
        authoritativeAmount =
          pkg.id === 'pkg_exam_pass' ? mirror.examDateConfig.examPassPrice : pkg.price;

        const existingLocal = mirror.paymentRequests.find(
          p => p.id === docId || p.transactionId === cleanTrxId
        );
        if (existingLocal) {
          return res.status(409).json({
            error: 'DUPLICATE_TRX_ID',
            message:
              existingLocal.status === 'rejected'
                ? 'এই ট্রানজাকশন আইডিটি (TrxID) পূর্বে বাতিল করা হয়েছে এবং পুনরায় জমা দেওয়া যাবে না।'
                : 'এই ট্রানজাকশন আইডিটি (TrxID) ইতিপূর্বে ব্যবহার করা হয়েছে। একই TrxID পুনরায় গ্রহণযোগ্য নয়।'
          });
        }
        const existingSubLocal = mirror.subscriptions.find(s => s.transactionId === cleanTrxId);
        if (existingSubLocal) {
          return res.status(409).json({
            error: 'DUPLICATE_TRX_ID',
            message: 'এই ট্রানজাকশন আইডিটি (TrxID) ইতিপূর্বে একটি সাবস্ক্রিপশনে ব্যবহৃত হয়েছে।'
          });
        }
      }

      if (!Number.isFinite(authoritativeAmount) || authoritativeAmount <= 0) {
        return res.status(500).json({
          error: 'INVALID_PACKAGE_CONFIGURATION',
          message: 'প্যাকেজের মূল্য কনফিগারেশন সঠিক নয়।'
        });
      }

      const durationDays = pkg.durationDays || 90;
      const validityType = pkg.validityType || 'days';
      const nowIso = new Date().toISOString();

      const newReq: PaymentRequest = {
        id: docId,
        userId: uid,
        studentName: String(studentName || req.authUser!.name || 'Student').trim().slice(0, 100),
        studentPhone: String(studentPhone || cleanSenderNumber).trim().slice(0, 20),
        method: method as 'bKash' | 'Nagad' | 'Rocket',
        senderNumber: cleanSenderNumber.slice(0, 20),
        transactionId: cleanTrxId,
        amount: authoritativeAmount,
        packageId: pkg.id,
        packageNameBn: pkg.nameBn,
        packageNameEn: pkg.nameEn,
        packageTitle: `${pkg.nameBn} - ৳${authoritativeAmount}`,
        durationDays,
        validityType,
        status: 'pending',
        requestedAt: nowIso
      };

      const auditEntry: AuditLog = {
        id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        userId: newReq.userId,
        userName: newReq.studentName,
        action: 'PAYMENT_SUBMITTED',
        details: `${method} TrxID: ${cleanTrxId} (৳${newReq.amount}) for package "${pkg.nameEn}". Pending manual admin review.`,
        timestamp: nowIso
      };

      if (useFirestore()) {
        try {
          const batch = db.batch();
          batch.create(db.collection('paymentRequests').doc(docId), {
            userId: newReq.userId,
            studentName: newReq.studentName,
            studentPhone: newReq.studentPhone,
            method: newReq.method,
            senderNumber: newReq.senderNumber,
            transactionId: newReq.transactionId,
            amount: newReq.amount,
            packageId: newReq.packageId,
            packageNameBn: newReq.packageNameBn,
            packageNameEn: newReq.packageNameEn,
            packageTitle: newReq.packageTitle,
            durationDays: newReq.durationDays,
            validityType: newReq.validityType,
            status: 'pending',
            requestedAt: newReq.requestedAt,
            verifiedAt: null,
            verifiedBy: null,
            rejectionReason: null,
            subscriptionId: null
          });
          batch.set(db.collection('auditLogs').doc(auditEntry.id), auditEntry);
          await batch.commit();
        } catch (err: unknown) {
          if (isAlreadyExistsError(err)) {
            return res.status(409).json({
              error: 'ALREADY_EXISTS',
              message: 'এই ট্রানজাকশন আইডিটি (TrxID) ইতিপূর্বে সিস্টেমে নিবন্ধিত হয়েছে। পুনরায় জমা দেওয়া সম্ভব নয়।'
            });
          }
          if (isPermissionOrCredentialError(err)) {
            const safe = getSafeDiagnosticError(err);
            console.error('[SanadPrep][POST /api/payments/create] Permission/credential error:', safe.code ?? '', safe.message);
            return res.status(403).json({
              error: 'PERMISSION_DENIED',
              message: 'ডাটাবেজে পেমেন্ট রিকোয়েস্ট সংরক্ষণ অনুমোদিত হয়নি। অনুগ্রহ করে অ্যাডমিনের সাথে যোগাযোগ করুন।'
            });
          }
          return sendRouteError(
            res,
            'POST /api/payments/create',
            err,
            'PAYMENT_PERSIST_FAILED',
            'পেমেন্ট রিকোয়েস্ট সংরক্ষণে সমস্যা হয়েছে। অনুগ্রহ করে পুনরায় চেষ্টা করুন।'
          );
        }
      } else {
        mirror.paymentRequests.unshift(newReq);
        mirror.auditLogs.unshift(auditEntry);
      }

      return res.json({
        success: true,
        message: 'পেমেন্ট রিকোয়েস্ট সফলভাবে জমা হয়েছে। অ্যাডমিন ম্যানুয়ালি যাচাই করার পর এক্সেস চালু হবে।',
        paymentRequest: newReq
      });
    } catch (err) {
      return sendRouteError(
        res,
        'POST /api/payments/create',
        err,
        'PAYMENT_PERSIST_FAILED',
        'পেমেন্ট রিকোয়েস্ট সংরক্ষণে সমস্যা হয়েছে।'
      );
    }
  });

  app.get(['/api/payments', '/api/payments/my'], requireFirebaseAuth, authenticateSession, async (req: AuthenticatedRequest, res) => {
    try {
      const isOwner = isOwnerUser(req.authUser);
      const isAllAllowed = req.path === '/api/payments' && isOwner;
      let list: PaymentRequest[];
      if (useFirestore()) {
        const snap = isAllAllowed
          ? await db.collection('paymentRequests').get()
          : await db.collection('paymentRequests').where('userId', '==', req.authUser!.uid).get();
        list = snap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<PaymentRequest, 'id'>) }));
      } else {
        if (!allowMemoryFallback) {
          return res.status(503).json({ error: 'FIRESTORE_UNAVAILABLE' });
        }
        list = isAllAllowed
          ? [...mirror.paymentRequests]
          : mirror.paymentRequests.filter(p => p.userId === req.authUser!.uid);
      }
      list.sort(
        (a, b) =>
          new Date(String(b.requestedAt || 0)).getTime() - new Date(String(a.requestedAt || 0)).getTime()
      );
      return res.json({ paymentRequests: list });
    } catch (err) {
      return sendRouteError(res, 'GET /api/payments', err);
    }
  });

  app.get('/api/admin/payments', requireFirebaseAuth, requireOwnerAdmin, async (_req: AuthenticatedRequest, res) => {
    try {
      let list: PaymentRequest[];
      if (useFirestore()) {
        const snap = await db.collection('paymentRequests').get();
        list = snap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<PaymentRequest, 'id'>) }));
      } else {
        if (!allowMemoryFallback) {
          return res.status(503).json({ error: 'FIRESTORE_UNAVAILABLE' });
        }
        list = [...mirror.paymentRequests];
      }
      list.sort(
        (a, b) =>
          new Date(String(b.requestedAt || 0)).getTime() - new Date(String(a.requestedAt || 0)).getTime()
      );
      return res.json({ paymentRequests: list });
    } catch (err) {
      return sendRouteError(res, 'GET /api/admin/payments', err);
    }
  });

  app.post('/api/admin/payments/:id/approve', requireFirebaseAuth, requireOwnerAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const id = String(req.params.id);
      const { verifierName } = req.body || {};
      const verifier = String(verifierName || req.authUser!.email || 'Owner Admin');

      if (useFirestore()) {
        const { updatedPay, newSubscription } = await db.runTransaction(async (tx) => {
          const payRef = db.collection('paymentRequests').doc(id);
          const paySnap = await tx.get(payRef);
          if (!paySnap.exists) {
            throw new HttpError(404, 'NOT_FOUND', 'Payment request not found');
          }
          const reqItem = { id: paySnap.id, ...(paySnap.data() as Omit<PaymentRequest, 'id'>) };

          if (reqItem.status === 'approved') {
            throw new HttpError(400, 'ALREADY_APPROVED', 'Payment already approved');
          }
          if (reqItem.status === 'rejected') {
            throw new HttpError(400, 'ALREADY_REJECTED', 'Rejected payment request cannot be approved');
          }

          const [sameTrxPaySnap, sameTrxSubSnap, pkgSnap, configSnap] = await Promise.all([
            tx.get(db.collection('paymentRequests').where('transactionId', '==', reqItem.transactionId)),
            tx.get(db.collection('subscriptions').where('transactionId', '==', reqItem.transactionId)),
            tx.get(db.collection('packages').doc(reqItem.packageId)),
            tx.get(db.collection('config').doc('examDate'))
          ]);

          const hasDuplicateApprovedPay = sameTrxPaySnap.docs.some(
            d => d.id !== id && (d.data()?.status === 'approved')
          );
          const hasExistingSubForTrx = !sameTrxSubSnap.empty;
          if (hasDuplicateApprovedPay || hasExistingSubForTrx) {
            throw new HttpError(
              409,
              'TRX_ALREADY_APPROVED',
              'এই TrxID দিয়ে ইতিপূর্বে আরেকটি পেমেন্ট অনুমোদন করা হয়েছে!'
            );
          }

          const pkgData = pkgSnap.exists ? (pkgSnap.data() as Partial<SubscriptionPackage>) : undefined;
          const targetExamDate = configSnap.exists
            ? (configSnap.data()?.targetExamDate as string | undefined)
            : mirror.examDateConfig.targetExamDate;
          const validityType = pkgData?.validityType || reqItem.validityType || 'days';
          const durationDays = pkgData?.durationDays || reqItem.durationDays || 90;
          const packageNameBn = pkgData?.nameBn || reqItem.packageNameBn;
          const packageNameEn = pkgData?.nameEn || reqItem.packageNameEn;

          const activatedAt = new Date().toISOString();
          const expiresAt = calculateSubscriptionExpiry(validityType, durationDays, targetExamDate);

          const subId = `sub_${reqItem.userId}_${reqItem.transactionId}`;
          const createdSub: UserSubscription = {
            id: subId,
            userId: reqItem.userId,
            studentName: reqItem.studentName,
            studentPhone: reqItem.studentPhone,
            packageId: reqItem.packageId,
            packageNameBn,
            packageNameEn,
            pricePaid: reqItem.amount,
            paymentRequestId: reqItem.id,
            paymentMethod: reqItem.method as 'bKash' | 'Nagad',
            transactionId: reqItem.transactionId,
            activatedAt,
            expiresAt,
            validityType,
            status: 'active',
            targetExamDateSnapshot: validityType === 'exam_date' ? targetExamDate : undefined,
            createdAt: activatedAt
          };

          const subRef = db.collection('subscriptions').doc(subId);
          const userRef = db.collection('users').doc(reqItem.userId);
          const auditRef = db.collection('auditLogs').doc(`log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`);

          tx.update(payRef, {
            status: 'approved',
            verifiedAt: activatedAt,
            verifiedBy: verifier,
            subscriptionId: subId
          });
          tx.set(subRef, {
            userId: createdSub.userId,
            studentName: createdSub.studentName,
            studentPhone: createdSub.studentPhone,
            packageId: createdSub.packageId,
            packageNameBn: createdSub.packageNameBn,
            packageNameEn: createdSub.packageNameEn,
            pricePaid: createdSub.pricePaid,
            paymentRequestId: createdSub.paymentRequestId,
            paymentMethod: createdSub.paymentMethod,
            transactionId: createdSub.transactionId,
            activatedAt: isoToTimestamp(activatedAt),
            expiresAt: isoToTimestamp(expiresAt),
            validityType: createdSub.validityType,
            status: 'active',
            targetExamDateSnapshot: createdSub.targetExamDateSnapshot || null,
            createdAt: activatedAt
          });
          tx.set(
            userRef,
            {
              subscriptionStatus: 'pro',
              subscriptionExpiresAt: isoToTimestamp(expiresAt),
              activePackageId: reqItem.packageId,
              activePackageNameBn: packageNameBn,
              activePackageNameEn: packageNameEn
            },
            { merge: true }
          );
          tx.set(auditRef, {
            id: auditRef.id,
            userId: req.authUser!.uid,
            userName: verifier,
            action: 'PAYMENT_APPROVED',
            details: `Approved ${reqItem.method} TrxID: ${reqItem.transactionId} (৳${reqItem.amount}) for UID ${reqItem.userId}.`,
            timestamp: activatedAt
          });

          return {
            updatedPay: {
              ...reqItem,
              status: 'approved' as const,
              verifiedAt: activatedAt,
              verifiedBy: verifier,
              subscriptionId: subId
            },
            newSubscription: createdSub
          };
        });

        return res.json({
          success: true,
          paymentRequest: updatedPay,
          subscription: newSubscription
        });
      }

      if (!allowMemoryFallback) {
        return res.status(503).json({ error: 'FIRESTORE_UNAVAILABLE' });
      }

      // Development-only memory fallback
      const reqItem = mirror.paymentRequests.find(p => p.id === id);
      if (!reqItem) {
        return res.status(404).json({ error: 'NOT_FOUND', message: 'Payment request not found' });
      }
      if (reqItem.status === 'approved') {
        return res.status(400).json({ error: 'ALREADY_APPROVED', message: 'Payment already approved' });
      }
      const duplicateApproved = mirror.paymentRequests.find(
        p => p.id !== id && p.transactionId === reqItem.transactionId && p.status === 'approved'
      );
      if (duplicateApproved) {
        return res.status(409).json({
          error: 'TRX_ALREADY_APPROVED',
          message: 'এই TrxID দিয়ে ইতিপূর্বে আরেকটি পেমেন্ট অনুমোদন করা হয়েছে!'
        });
      }

      const pkg = mirror.packages.find(p => p.id === reqItem.packageId) || {
        id: reqItem.packageId,
        nameBn: reqItem.packageNameBn,
        nameEn: reqItem.packageNameEn,
        validityType: reqItem.validityType || ('days' as const),
        durationDays: reqItem.durationDays || 90
      };
      const activatedAt = new Date().toISOString();
      const expiresAt = calculateSubscriptionExpiry(
        pkg.validityType,
        pkg.durationDays,
        mirror.examDateConfig.targetExamDate
      );
      const newSubscription: UserSubscription = {
        id: `sub_${reqItem.userId}_${reqItem.transactionId}`,
        userId: reqItem.userId,
        studentName: reqItem.studentName,
        studentPhone: reqItem.studentPhone,
        packageId: reqItem.packageId,
        packageNameBn: reqItem.packageNameBn,
        packageNameEn: reqItem.packageNameEn,
        pricePaid: reqItem.amount,
        paymentRequestId: reqItem.id,
        paymentMethod: reqItem.method as 'bKash' | 'Nagad',
        transactionId: reqItem.transactionId,
        activatedAt,
        expiresAt,
        validityType: pkg.validityType,
        status: 'active',
        targetExamDateSnapshot: pkg.validityType === 'exam_date' ? mirror.examDateConfig.targetExamDate : undefined,
        createdAt: activatedAt
      };
      reqItem.status = 'approved';
      reqItem.verifiedAt = activatedAt;
      reqItem.verifiedBy = verifier;
      reqItem.subscriptionId = newSubscription.id;
      mirror.subscriptions.unshift(newSubscription);
      const existingUser = mirror.users[reqItem.userId];
      mirror.users[reqItem.userId] = {
        ...(existingUser || {
          uid: reqItem.userId,
          name: reqItem.studentName,
          email: '',
          phone: reqItem.studentPhone,
          role: 'student',
          createdAt: activatedAt
        }),
        subscriptionStatus: 'pro',
        subscriptionExpiresAt: expiresAt,
        activePackageId: reqItem.packageId,
        activePackageNameBn: reqItem.packageNameBn,
        activePackageNameEn: reqItem.packageNameEn
      };
      mirror.auditLogs.unshift({
        id: `log_${Date.now()}`,
        userId: req.authUser!.uid,
        userName: verifier,
        action: 'PAYMENT_APPROVED',
        details: `Approved ${reqItem.method} TrxID: ${reqItem.transactionId} (৳${reqItem.amount}) for UID ${reqItem.userId}.`,
        timestamp: activatedAt
      });

      return res.json({
        success: true,
        paymentRequest: reqItem,
        subscription: newSubscription
      });
    } catch (err) {
      return sendRouteError(
        res,
        'POST /api/admin/payments/:id/approve',
        err,
        'APPROVAL_PERSIST_FAILED',
        'Failed to commit payment approval.'
      );
    }
  });

  app.post('/api/admin/payments/:id/reject', requireFirebaseAuth, requireOwnerAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const id = String(req.params.id);
      const { reason, verifierName } = req.body || {};
      const verifier = String(verifierName || req.authUser!.email || 'Owner Admin');
      const rejectionReason = String(reason || 'Unverified Transaction ID or Amount Mismatch');
      const verifiedAt = new Date().toISOString();

      if (useFirestore()) {
        const updatedPay = await db.runTransaction(async (tx) => {
          const payRef = db.collection('paymentRequests').doc(id);
          const snap = await tx.get(payRef);
          if (!snap.exists) {
            throw new HttpError(404, 'NOT_FOUND', 'Payment request not found');
          }
          const reqItem = { id: snap.id, ...(snap.data() as Omit<PaymentRequest, 'id'>) };
          if (reqItem.status === 'approved') {
            throw new HttpError(400, 'ALREADY_APPROVED', 'Approved payment request cannot be rejected');
          }
          const auditRef = db.collection('auditLogs').doc(`log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`);
          tx.update(payRef, {
            status: 'rejected',
            rejectionReason,
            verifiedAt,
            verifiedBy: verifier
          });
          tx.set(auditRef, {
            id: auditRef.id,
            userId: req.authUser!.uid,
            userName: verifier,
            action: 'PAYMENT_REJECTED',
            details: `Rejected ${reqItem.method} TrxID: ${reqItem.transactionId}. Reason: ${rejectionReason}`,
            timestamp: verifiedAt
          });
          return {
            ...reqItem,
            status: 'rejected' as const,
            rejectionReason,
            verifiedAt,
            verifiedBy: verifier
          };
        });
        return res.json({ success: true, paymentRequest: updatedPay });
      }

      if (!allowMemoryFallback) {
        return res.status(503).json({ error: 'FIRESTORE_UNAVAILABLE' });
      }

      const reqItem = mirror.paymentRequests.find(p => p.id === id);
      if (!reqItem) {
        return res.status(404).json({ error: 'NOT_FOUND', message: 'Payment request not found' });
      }
      if (reqItem.status === 'approved') {
        return res.status(400).json({ error: 'ALREADY_APPROVED', message: 'Approved payment request cannot be rejected' });
      }
      reqItem.status = 'rejected';
      reqItem.rejectionReason = rejectionReason;
      reqItem.verifiedAt = verifiedAt;
      reqItem.verifiedBy = verifier;
      mirror.auditLogs.unshift({
        id: `log_${Date.now()}`,
        userId: req.authUser!.uid,
        userName: verifier,
        action: 'PAYMENT_REJECTED',
        details: `Rejected ${reqItem.method} TrxID: ${reqItem.transactionId}. Reason: ${rejectionReason}`,
        timestamp: verifiedAt
      });

      return res.json({ success: true, paymentRequest: reqItem });
    } catch (err) {
      return sendRouteError(
        res,
        'POST /api/admin/payments/:id/reject',
        err,
        'REJECTION_PERSIST_FAILED',
        'Failed to reject payment in Firestore.'
      );
    }
  });

  // ---------------------------------------------------------
  // ADMIN PACKAGES, CONFIG, SETTINGS & USER MANAGEMENT
  // ---------------------------------------------------------
  app.get('/api/admin/packages', requireFirebaseAuth, requireOwnerAdmin, async (_req, res) => {
    try {
      if (useFirestore()) {
        const [pkgSnap, configSnap] = await Promise.all([
          db.collection('packages').get(),
          db.collection('config').doc('examDate').get()
        ]);
        const packagesList = pkgSnap.docs.map(d => ({
          id: d.id,
          ...(d.data() as Omit<SubscriptionPackage, 'id'>)
        }));
        const examDateConfig = configSnap.exists
          ? { ...mirror.examDateConfig, ...(configSnap.data() as Partial<ExamDateConfig>) }
          : mirror.examDateConfig;
        return res.json({ packages: packagesList, examDateConfig });
      }
      if (!allowMemoryFallback) {
        return res.status(503).json({ error: 'FIRESTORE_UNAVAILABLE' });
      }
      return res.json({ packages: mirror.packages, examDateConfig: mirror.examDateConfig });
    } catch (err) {
      return sendRouteError(res, 'GET /api/admin/packages', err);
    }
  });

  app.post('/api/admin/packages/update', requireFirebaseAuth, requireOwnerAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const { id, price, durationDays, isActive } = req.body || {};
      if (!id || typeof id !== 'string' || !id.trim()) {
        return res.status(400).json({ error: 'INVALID_PACKAGE_ID', message: 'Package id is required' });
      }

      if (price !== undefined) {
        const parsedPrice = Number(price);
        if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
          return res.status(400).json({ error: 'INVALID_PACKAGE_PRICE', message: 'Valid positive price is required.' });
        }
      }
      if (durationDays !== undefined) {
        const parsedDays = Number(durationDays);
        if (!Number.isFinite(parsedDays) || parsedDays <= 0) {
          return res.status(400).json({ error: 'INVALID_DURATION', message: 'Valid positive durationDays is required.' });
        }
      }

      if (useFirestore()) {
        const pkgRef = db.collection('packages').doc(id);
        const snap = await pkgRef.get();
        if (!snap.exists) {
          return res.status(404).json({ error: 'PACKAGE_NOT_FOUND', message: 'Package not found in Firestore' });
        }
        const existing = { id: snap.id, ...(snap.data() as Omit<SubscriptionPackage, 'id'>) };
        const updatedPkg: SubscriptionPackage = {
          ...existing,
          ...(price !== undefined ? { price: Number(price) } : {}),
          ...(durationDays !== undefined ? { durationDays: Number(durationDays) } : {}),
          ...(isActive !== undefined ? { isActive: Boolean(isActive) } : {}),
          updatedAt: new Date().toISOString()
        };

        const batch = db.batch();
        batch.set(pkgRef, updatedPkg, { merge: true });
        if (updatedPkg.id === 'pkg_exam_pass' && price !== undefined) {
          batch.set(
            db.collection('config').doc('examDate'),
            { examPassPrice: Number(price), lastUpdated: updatedPkg.updatedAt },
            { merge: true }
          );
        }
        const auditEntry: AuditLog = {
          id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          userId: req.authUser!.uid,
          userName: req.authUser!.email || 'Owner Admin',
          action: 'UPDATE_PACKAGE',
          details: `Updated package ${updatedPkg.nameEn}: Price=${updatedPkg.price}, Duration=${updatedPkg.durationDays}d, Active=${updatedPkg.isActive}`,
          timestamp: updatedPkg.updatedAt!
        };
        batch.set(db.collection('auditLogs').doc(auditEntry.id), auditEntry);
        await batch.commit();

        return res.json({ success: true, package: updatedPkg });
      }

      if (!allowMemoryFallback) {
        return res.status(503).json({ error: 'FIRESTORE_UNAVAILABLE' });
      }

      const pkg = mirror.packages.find(p => p.id === id);
      if (!pkg) {
        return res.status(404).json({ error: 'Package not found' });
      }
      if (price !== undefined) pkg.price = Number(price);
      if (durationDays !== undefined) pkg.durationDays = Number(durationDays);
      if (isActive !== undefined) pkg.isActive = Boolean(isActive);
      pkg.updatedAt = new Date().toISOString();

      if (pkg.id === 'pkg_exam_pass' && price !== undefined) {
        mirror.examDateConfig.examPassPrice = Number(price);
      }

      mirror.auditLogs.unshift({
        id: `log_${Date.now()}`,
        userId: req.authUser!.uid,
        userName: req.authUser!.email || 'Owner Admin',
        action: 'UPDATE_PACKAGE',
        details: `Updated package ${pkg.nameEn}: Price=${pkg.price}, Duration=${pkg.durationDays}d, Active=${pkg.isActive}`,
        timestamp: pkg.updatedAt
      });

      return res.json({ success: true, package: pkg });
    } catch (err) {
      return sendRouteError(res, 'POST /api/admin/packages/update', err);
    }
  });

  app.post('/api/admin/exam-config', requireFirebaseAuth, requireOwnerAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const { targetExamDate, examDatePolicy, examPassPrice, examTitleBn, examTitleEn } = req.body || {};
      const nowIso = new Date().toISOString();

      if (useFirestore()) {
        const configRef = db.collection('config').doc('examDate');
        const configSnap = await configRef.get();
        const currentConfig: ExamDateConfig = {
          ...mirror.examDateConfig,
          ...(configSnap.exists ? (configSnap.data() as Partial<ExamDateConfig>) : {})
        };

        const nextConfig: ExamDateConfig = {
          ...currentConfig,
          ...(targetExamDate ? { targetExamDate } : {}),
          ...(examDatePolicy ? { examDatePolicy } : {}),
          ...(examPassPrice !== undefined ? { examPassPrice: Number(examPassPrice) } : {}),
          ...(examTitleBn ? { examTitleBn } : {}),
          ...(examTitleEn ? { examTitleEn } : {}),
          lastUpdated: nowIso
        };

        let affectedSubscribers = 0;
        const pendingUpdates: Array<{ subId: string; userId: string }> = [];

        if (nextConfig.examDatePolicy === 'extend_all' && targetExamDate) {
          const subSnap = await db.collection('subscriptions').where('packageId', '==', 'pkg_exam_pass').get();
          subSnap.forEach(d => {
            const data = d.data();
            if (data.status === 'active') {
              pendingUpdates.push({ subId: d.id, userId: String(data.userId) });
            }
          });
          affectedSubscribers = pendingUpdates.length;
        }

        const nextTs = targetExamDate ? isoToTimestamp(new Date(targetExamDate).toISOString()) : null;
        const writeOps: Array<(batch: ReturnType<Firestore['batch']>) => void> = [];

        writeOps.push(batch => batch.set(configRef, nextConfig, { merge: true }));

        if (examPassPrice !== undefined) {
          const pkgRef = db.collection('packages').doc('pkg_exam_pass');
          const pkgSnap = await pkgRef.get();
          if (pkgSnap.exists) {
            writeOps.push(batch =>
              batch.update(pkgRef, { price: Number(examPassPrice), updatedAt: nowIso })
            );
          }
        }

        for (const item of pendingUpdates) {
          if (nextTs) {
            writeOps.push(batch =>
              batch.update(db.collection('subscriptions').doc(item.subId), {
                expiresAt: nextTs,
                targetExamDateSnapshot: targetExamDate
              })
            );
            writeOps.push(batch =>
              batch.set(
                db.collection('users').doc(item.userId),
                { subscriptionExpiresAt: nextTs },
                { merge: true }
              )
            );
          }
        }

        const auditEntry: AuditLog = {
          id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          userId: req.authUser!.uid,
          userName: req.authUser!.email || 'Owner Admin',
          action: 'UPDATE_EXAM_DATE_CONFIG',
          details: `Updated exam date config (${nextConfig.targetExamDate}). Policy: ${nextConfig.examDatePolicy}. Affected: ${affectedSubscribers}.`,
          timestamp: nowIso
        };
        writeOps.push(batch => batch.set(db.collection('auditLogs').doc(auditEntry.id), auditEntry));

        for (let i = 0; i < writeOps.length; i += 400) {
          const batch = db.batch();
          for (const op of writeOps.slice(i, i + 400)) {
            op(batch);
          }
          await batch.commit();
        }

        return res.json({
          success: true,
          examDateConfig: nextConfig,
          affectedSubscribers
        });
      }

      if (!allowMemoryFallback) {
        return res.status(503).json({ error: 'FIRESTORE_UNAVAILABLE' });
      }

      if (targetExamDate) mirror.examDateConfig.targetExamDate = targetExamDate;
      if (examDatePolicy) mirror.examDateConfig.examDatePolicy = examDatePolicy;
      if (examPassPrice !== undefined) {
        mirror.examDateConfig.examPassPrice = Number(examPassPrice);
        const epPkg = mirror.packages.find(p => p.id === 'pkg_exam_pass');
        if (epPkg) epPkg.price = Number(examPassPrice);
      }
      if (examTitleBn) mirror.examDateConfig.examTitleBn = examTitleBn;
      if (examTitleEn) mirror.examDateConfig.examTitleEn = examTitleEn;
      mirror.examDateConfig.lastUpdated = nowIso;

      let affectedSubscribers = 0;
      if (mirror.examDateConfig.examDatePolicy === 'extend_all' && targetExamDate) {
        const nextIso = new Date(targetExamDate).toISOString();
        mirror.subscriptions.forEach(sub => {
          if (sub.packageId === 'pkg_exam_pass' && sub.status === 'active') {
            sub.expiresAt = nextIso;
            sub.targetExamDateSnapshot = targetExamDate;
            affectedSubscribers++;
          }
        });
      }

      return res.json({
        success: true,
        examDateConfig: mirror.examDateConfig,
        affectedSubscribers
      });
    } catch (err) {
      return sendRouteError(res, 'POST /api/admin/exam-config', err);
    }
  });

  app.post('/api/admin/payment-settings', requireFirebaseAuth, requireOwnerAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const { bkashNumber, nagadNumber, packagePrice, instructionsBn, instructionsEn, whatsappNumber, whatsappMessage } =
        req.body || {};

      const bdWalletRegex = /^01[3-9]\d{8}$/;
      if (bkashNumber !== undefined && !bdWalletRegex.test(String(bkashNumber).trim())) {
        return res.status(400).json({
          error: 'INVALID_PAYMENT_NUMBER',
          message: 'bKash নম্বরটি সঠিক ১১ ডিজিটের বাংলাদেশি মোবাইল নম্বর হতে হবে (যেমন: 017xxxxxxxx)।'
        });
      }
      if (nagadNumber !== undefined && !bdWalletRegex.test(String(nagadNumber).trim())) {
        return res.status(400).json({
          error: 'INVALID_PAYMENT_NUMBER',
          message: 'Nagad নম্বরটি সঠিক ১১ ডিজিটের বাংলাদেশি মোবাইল নম্বর হতে হবে (যেমন: 017xxxxxxxx)।'
        });
      }
      if (packagePrice !== undefined) {
        const parsedPrice = Number(packagePrice);
        if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
          return res.status(400).json({ error: 'INVALID_PACKAGE_PRICE', message: 'Valid positive packagePrice is required.' });
        }
      }
      if (whatsappNumber !== undefined) {
        const waDigits = String(whatsappNumber).replace(/[^0-9]/g, '');
        if (waDigits.length < 10 || waDigits.length > 15) {
          return res.status(400).json({ error: 'INVALID_WHATSAPP_NUMBER', message: 'Valid WhatsApp number (10-15 digits) is required.' });
        }
      }

      if (useFirestore()) {
        const payRef = db.collection('config').doc('paymentSettings');
        const supRef = db.collection('config').doc('supportSettings');
        const [paySnap, supSnap] = await Promise.all([payRef.get(), supRef.get()]);

        const currentPay: PaymentSettings = {
          ...mirror.paymentSettings,
          ...(paySnap.exists ? (paySnap.data() as Partial<PaymentSettings>) : {})
        };
        const currentSup: SupportContactSettings = {
          ...mirror.supportSettings,
          ...(supSnap.exists ? (supSnap.data() as Partial<SupportContactSettings>) : {})
        };

        const nextPay: PaymentSettings = {
          ...currentPay,
          ...(bkashNumber ? { bkashNumber: String(bkashNumber).trim() } : {}),
          ...(nagadNumber ? { nagadNumber: String(nagadNumber).trim() } : {}),
          ...(packagePrice !== undefined ? { packagePrice: Number(packagePrice) } : {}),
          ...(instructionsBn ? { instructionsBn: String(instructionsBn).trim() } : {}),
          ...(instructionsEn ? { instructionsEn: String(instructionsEn).trim() } : {}),
          ...(whatsappNumber ? { whatsappNumber: String(whatsappNumber).trim() } : {}),
          ...(whatsappMessage ? { whatsappMessage: String(whatsappMessage).trim() } : {})
        };

        const nextSup: SupportContactSettings = {
          ...currentSup,
          ...(whatsappNumber ? { whatsappNumber: String(whatsappNumber).trim() } : {}),
          ...(whatsappMessage ? { whatsappMessage: String(whatsappMessage).trim() } : {})
        };

        const nowIso = new Date().toISOString();
        const auditEntry: AuditLog = {
          id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          userId: req.authUser!.uid,
          userName: req.authUser!.email || 'Owner Admin',
          action: 'UPDATE_PAYMENT_SETTINGS',
          details: `Updated Payment Numbers: bKash=${nextPay.bkashNumber}, Nagad=${nextPay.nagadNumber}`,
          timestamp: nowIso
        };

        const batch = db.batch();
        batch.set(payRef, { ...nextPay, updatedAt: nowIso }, { merge: true });
        batch.set(supRef, { ...nextSup, updatedAt: nowIso }, { merge: true });
        batch.set(db.collection('auditLogs').doc(auditEntry.id), auditEntry);
        await batch.commit();

        return res.json({
          success: true,
          paymentSettings: nextPay,
          supportSettings: nextSup
        });
      }

      if (!allowMemoryFallback) {
        return res.status(503).json({ error: 'FIRESTORE_UNAVAILABLE' });
      }

      if (bkashNumber) mirror.paymentSettings.bkashNumber = String(bkashNumber).trim();
      if (nagadNumber) mirror.paymentSettings.nagadNumber = String(nagadNumber).trim();
      if (packagePrice !== undefined) mirror.paymentSettings.packagePrice = Number(packagePrice);
      if (instructionsBn) mirror.paymentSettings.instructionsBn = String(instructionsBn).trim();
      if (instructionsEn) mirror.paymentSettings.instructionsEn = String(instructionsEn).trim();
      if (whatsappNumber) {
        mirror.paymentSettings.whatsappNumber = String(whatsappNumber).trim();
        mirror.supportSettings.whatsappNumber = String(whatsappNumber).trim();
      }
      if (whatsappMessage) {
        mirror.paymentSettings.whatsappMessage = String(whatsappMessage).trim();
        mirror.supportSettings.whatsappMessage = String(whatsappMessage).trim();
      }
      return res.json({
        success: true,
        paymentSettings: mirror.paymentSettings,
        supportSettings: mirror.supportSettings
      });
    } catch (err) {
      return sendRouteError(res, 'POST /api/admin/payment-settings', err);
    }
  });

  app.post('/api/admin/support-settings', requireFirebaseAuth, requireOwnerAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const { whatsappNumber, whatsappMessage } = req.body || {};

      if (whatsappNumber !== undefined) {
        const waDigits = String(whatsappNumber).replace(/[^0-9]/g, '');
        if (waDigits.length < 10 || waDigits.length > 15) {
          return res.status(400).json({ error: 'INVALID_WHATSAPP_NUMBER', message: 'Valid WhatsApp number (10-15 digits) is required.' });
        }
      }

      if (useFirestore()) {
        const supRef = db.collection('config').doc('supportSettings');
        const payRef = db.collection('config').doc('paymentSettings');
        const [supSnap, paySnap] = await Promise.all([supRef.get(), payRef.get()]);

        const currentSup: SupportContactSettings = {
          ...mirror.supportSettings,
          ...(supSnap.exists ? (supSnap.data() as Partial<SupportContactSettings>) : {})
        };
        const currentPay: PaymentSettings = {
          ...mirror.paymentSettings,
          ...(paySnap.exists ? (paySnap.data() as Partial<PaymentSettings>) : {})
        };

        const nextSup: SupportContactSettings = {
          ...currentSup,
          ...(whatsappNumber ? { whatsappNumber: String(whatsappNumber).trim() } : {}),
          ...(whatsappMessage ? { whatsappMessage: String(whatsappMessage).trim() } : {})
        };

        const nowIso = new Date().toISOString();
        const auditEntry: AuditLog = {
          id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          userId: req.authUser!.uid,
          userName: req.authUser!.email || 'Owner Admin',
          action: 'UPDATE_SUPPORT_SETTINGS',
          details: `Updated WhatsApp Support: ${nextSup.whatsappNumber}`,
          timestamp: nowIso
        };

        const batch = db.batch();
        batch.set(supRef, { ...nextSup, updatedAt: nowIso }, { merge: true });
        batch.set(
          payRef,
          {
            ...currentPay,
            whatsappNumber: nextSup.whatsappNumber,
            whatsappMessage: nextSup.whatsappMessage,
            updatedAt: nowIso
          },
          { merge: true }
        );
        batch.set(db.collection('auditLogs').doc(auditEntry.id), auditEntry);
        await batch.commit();

        return res.json({ success: true, supportSettings: nextSup });
      }

      if (!allowMemoryFallback) {
        return res.status(503).json({ error: 'FIRESTORE_UNAVAILABLE' });
      }

      if (whatsappNumber) {
        mirror.supportSettings.whatsappNumber = String(whatsappNumber).trim();
        mirror.paymentSettings.whatsappNumber = String(whatsappNumber).trim();
      }
      if (whatsappMessage) {
        mirror.supportSettings.whatsappMessage = String(whatsappMessage).trim();
        mirror.paymentSettings.whatsappMessage = String(whatsappMessage).trim();
      }
      return res.json({ success: true, supportSettings: mirror.supportSettings });
    } catch (err) {
      return sendRouteError(res, 'POST /api/admin/support-settings', err);
    }
  });

  app.post('/api/admin/users/update', requireFirebaseAuth, requireOwnerAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const {
        userId,
        subscriptionId,
        name,
        email,
        phone,
        role,
        subscriptionStatus,
        packageId,
        packageNameBn,
        packageNameEn,
        expiresAt,
        isSessionRevoked
      } = req.body || {};

      if (!userId || typeof userId !== 'string' || !userId.trim()) {
        return res.status(400).json({ error: 'MISSING_USER_ID', message: 'userId is required' });
      }
      const cleanName = typeof name === 'string' ? name.trim().slice(0, 100) : '';
      if (!cleanName) {
        return res.status(400).json({ error: 'INVALID_USER_NAME', message: 'Valid user name is required.' });
      }
      const allowedStatuses = new Set(['free', 'pro', 'expired']);
      const safeSubStatus = allowedStatuses.has(String(subscriptionStatus))
        ? (String(subscriptionStatus) as 'free' | 'pro' | 'expired')
        : 'free';

      const targetUid = userId.trim();
      const allowedRoles = new Set<UserRole>(['student', 'question_manager', 'admin']);
      const requestedRole = allowedRoles.has(role as UserRole) ? (role as UserRole) : 'student';
      const safeRole: UserRole =
        requestedRole === 'admin' && targetUid !== OWNER_ADMIN_UID ? 'student' : requestedRole;

      let cleanExpiresIso: string | undefined;
      if (expiresAt !== undefined && expiresAt !== null && String(expiresAt).trim() !== '') {
        const parsedExp = new Date(String(expiresAt));
        if (isNaN(parsedExp.getTime())) {
          return res.status(400).json({ error: 'INVALID_EXPIRES_AT', message: 'Invalid expiresAt date format.' });
        }
        cleanExpiresIso = parsedExp.toISOString();
      }

      const rawEmailInput = typeof email === 'string' ? email.trim() : '';
      if (rawEmailInput) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (rawEmailInput.length > 150 || !emailRegex.test(rawEmailInput)) {
          return res.status(400).json({ error: 'INVALID_EMAIL', message: 'Valid email address is required.' });
        }
      }

      const nowIso = new Date().toISOString();
      const cleanPhone = typeof phone === 'string' ? phone.trim().slice(0, 20) : '';
      const cleanSubId = typeof subscriptionId === 'string' && subscriptionId.trim() ? subscriptionId.trim() : '';

      if (useFirestore()) {
        const userRef = db.collection('users').doc(targetUid);
        const requestedPkgIdHint =
          typeof packageId === 'string' && packageId.trim() ? packageId.trim() : '';
        const [userSnap, userSessSnap, queriedSubsSnap, explicitSubSnap, firestorePkgHintSnap] = await Promise.all([
          userRef.get(),
          isSessionRevoked ? db.collection('userSessions').doc(targetUid).get() : Promise.resolve(null),
          db.collection('subscriptions').where('userId', '==', targetUid).get(),
          cleanSubId ? db.collection('subscriptions').doc(cleanSubId).get() : Promise.resolve(null),
          requestedPkgIdHint ? db.collection('packages').doc(requestedPkgIdHint).get().catch(() => null) : Promise.resolve(null)
        ]);

        const targetSubMap = new Map<string, Record<string, unknown> & { id: string }>();
        queriedSubsSnap.forEach(d => {
          const data = d.data() as Record<string, unknown>;
          if (String(data.userId || '') === targetUid) {
            targetSubMap.set(d.id, { ...data, id: d.id });
          }
        });
        if (explicitSubSnap && explicitSubSnap.exists) {
          const explicitData = explicitSubSnap.data() as Record<string, unknown>;
          if (explicitData.userId && String(explicitData.userId) !== targetUid) {
            return res.status(403).json({
              error: 'SUBSCRIPTION_USER_MISMATCH',
              message: 'Subscription record does not belong to target user.'
            });
          }
          targetSubMap.set(explicitSubSnap.id, { ...explicitData, id: explicitSubSnap.id });
        }

        const allUserSubDocs = Array.from(targetSubMap.values()).sort(
          (a, b) =>
            new Date(timestampToIso(b.createdAt) || 0).getTime() -
            new Date(timestampToIso(a.createdAt) || 0).getTime()
        );

        const existingUserData = userSnap.exists ? (userSnap.data() as Record<string, unknown>) : {};
        const existingEmail =
          typeof existingUserData?.email === 'string' ? existingUserData.email.trim() : '';
        const resolvedEmail = rawEmailInput
          ? rawEmailInput.toLowerCase().slice(0, 150)
          : existingEmail;

        const existingExpiresIso = timestampToIso(existingUserData?.subscriptionExpiresAt);
        const effectiveUserExpiresIso = cleanExpiresIso || existingExpiresIso;
        const resolvedActivePackageId =
          typeof packageId === 'string' && packageId
            ? packageId
            : (existingUserData?.activePackageId as string | undefined) ?? null;
        const resolvedActivePackageNameBn =
          typeof packageNameBn === 'string' && packageNameBn
            ? packageNameBn
            : (existingUserData?.activePackageNameBn as string | undefined) ?? null;
        const resolvedActivePackageNameEn =
          typeof packageNameEn === 'string' && packageNameEn
            ? packageNameEn
            : (existingUserData?.activePackageNameEn as string | undefined) ?? null;

        const userPayloadForResponse = {
          uid: targetUid,
          name: cleanName,
          email: resolvedEmail,
          phone: cleanPhone,
          role: safeRole,
          subscriptionStatus: safeSubStatus,
          subscriptionExpiresAt: effectiveUserExpiresIso,
          activePackageId: resolvedActivePackageId,
          activePackageNameBn: resolvedActivePackageNameBn,
          activePackageNameEn: resolvedActivePackageNameEn,
          createdAt: (existingUserData?.createdAt as string) || nowIso
        };

        const userFirestorePayload: Record<string, unknown> = {
          ...userPayloadForResponse,
          subscriptionExpiresAt: effectiveUserExpiresIso ? isoToTimestamp(effectiveUserExpiresIso) : null
        };
        if (!resolvedEmail) {
          delete userFirestorePayload.email;
        }

        const batch = db.batch();
        batch.set(userRef, userFirestorePayload, { merge: true });

        let persistedSubscription: UserSubscription | null = null;
        const updatedSubscriptions: UserSubscription[] = [];

        if (safeSubStatus === 'pro') {
          const resolvedSubDoc =
            (cleanSubId ? targetSubMap.get(cleanSubId) : undefined) || allUserSubDocs[0] || null;
          const targetSubId = cleanSubId || resolvedSubDoc?.id || `sub_admin_${targetUid}`;
          const effectivePkgId =
            (typeof packageId === 'string' && packageId.trim()) ||
            (resolvedSubDoc?.packageId as string | undefined) ||
            mirror.packages[0].id;
          const livePkgSnap =
            firestorePkgHintSnap && (!requestedPkgIdHint || requestedPkgIdHint === effectivePkgId)
              ? firestorePkgHintSnap
              : await db.collection('packages').doc(effectivePkgId).get().catch(() => null);
          const livePkgData = livePkgSnap?.exists ? (livePkgSnap.data() as Record<string, unknown>) : null;
          const mirrorFallback = mirror.packages.find(p => p.id === effectivePkgId) || mirror.packages[0];
          const pkgMatch = {
            id: effectivePkgId,
            nameBn: (typeof livePkgData?.nameBn === 'string' && livePkgData.nameBn) || mirrorFallback.nameBn,
            nameEn: (typeof livePkgData?.nameEn === 'string' && livePkgData.nameEn) || mirrorFallback.nameEn,
            price:
              typeof livePkgData?.price === 'number' && Number.isFinite(livePkgData.price)
                ? livePkgData.price
                : mirrorFallback.price,
            validityType:
              livePkgData?.validityType === 'exam_date' || livePkgData?.validityType === 'days'
                ? livePkgData.validityType
                : mirrorFallback.validityType
          };
          const effectiveExpiresIso =
            cleanExpiresIso ||
            timestampToIso(resolvedSubDoc?.expiresAt) ||
            new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();
          const activatedIso = timestampToIso(resolvedSubDoc?.activatedAt) || nowIso;

          const subFirestorePayload: Record<string, unknown> = {
            id: targetSubId,
            userId: targetUid,
            studentName: cleanName,
            studentPhone: cleanPhone,
            packageId:
              (typeof packageId === 'string' && packageId) ||
              (resolvedSubDoc?.packageId as string) ||
              pkgMatch.id,
            packageNameBn:
              (typeof packageNameBn === 'string' && packageNameBn) ||
              (resolvedSubDoc?.packageNameBn as string) ||
              pkgMatch.nameBn,
            packageNameEn:
              (typeof packageNameEn === 'string' && packageNameEn) ||
              (resolvedSubDoc?.packageNameEn as string) ||
              pkgMatch.nameEn,
            pricePaid: typeof resolvedSubDoc?.pricePaid === 'number' ? resolvedSubDoc.pricePaid : pkgMatch.price,
            paymentRequestId: (resolvedSubDoc?.paymentRequestId as string) || `admin_grant_${targetUid}`,
            paymentMethod: (resolvedSubDoc?.paymentMethod as string) || 'bKash',
            transactionId:
              (resolvedSubDoc?.transactionId as string) || `ADMIN_GRANT_${Date.now().toString().slice(-6)}`,
            validityType: (resolvedSubDoc?.validityType as 'days' | 'exam_date') || pkgMatch.validityType,
            status: 'active',
            activatedAt: isoToTimestamp(activatedIso) || activatedIso,
            expiresAt: isoToTimestamp(effectiveExpiresIso),
            createdAt: timestampToIso(resolvedSubDoc?.createdAt) || nowIso,
            updatedAt: nowIso
          };

          batch.set(db.collection('subscriptions').doc(targetSubId), subFirestorePayload, { merge: true });
          persistedSubscription = {
            ...(subFirestorePayload as unknown as UserSubscription),
            ...(resolvedEmail ? { studentEmail: resolvedEmail } : {}),
            activatedAt: activatedIso,
            expiresAt: effectiveExpiresIso
          };
          updatedSubscriptions.push(persistedSubscription);
        } else {
          const nextSubStatus: 'expired' | 'cancelled' =
            safeSubStatus === 'expired' ? 'expired' : 'cancelled';
          const subsToUpdate = allUserSubDocs.filter(
            doc =>
              String(doc.userId || '') === targetUid &&
              (doc.status === 'active' || (cleanSubId && doc.id === cleanSubId))
          );

          for (const subDoc of subsToUpdate) {
            const isPrimaryEdited = Boolean(cleanSubId && subDoc.id === cleanSubId);
            const existingSubExpIso = timestampToIso(subDoc.expiresAt) || nowIso;
            const effectiveExpiresIso =
              isPrimaryEdited && cleanExpiresIso ? cleanExpiresIso : existingSubExpIso;
            const activatedIso = timestampToIso(subDoc.activatedAt) || nowIso;
            const pkgMatch =
              mirror.packages.find(p => p.id === (subDoc.packageId || packageId)) || mirror.packages[0];

            const subFirestorePayload: Record<string, unknown> = {
              id: subDoc.id,
              userId: targetUid,
              studentName: isPrimaryEdited ? cleanName : String(subDoc.studentName || cleanName),
              studentPhone: isPrimaryEdited ? cleanPhone : String(subDoc.studentPhone || cleanPhone),
              packageId:
                (subDoc.packageId as string) || (typeof packageId === 'string' && packageId) || pkgMatch.id,
              packageNameBn: (subDoc.packageNameBn as string) || pkgMatch.nameBn,
              packageNameEn: (subDoc.packageNameEn as string) || pkgMatch.nameEn,
              pricePaid: typeof subDoc.pricePaid === 'number' ? subDoc.pricePaid : pkgMatch.price,
              paymentRequestId: (subDoc.paymentRequestId as string) || `admin_grant_${targetUid}`,
              paymentMethod: (subDoc.paymentMethod as string) || 'bKash',
              transactionId:
                (subDoc.transactionId as string) || `ADMIN_GRANT_${Date.now().toString().slice(-6)}`,
              validityType: (subDoc.validityType as 'days' | 'exam_date') || pkgMatch.validityType,
              status: nextSubStatus,
              activatedAt: isoToTimestamp(activatedIso) || activatedIso,
              expiresAt: isoToTimestamp(effectiveExpiresIso),
              createdAt: timestampToIso(subDoc.createdAt) || nowIso,
              updatedAt: nowIso
            };

            batch.set(db.collection('subscriptions').doc(subDoc.id), subFirestorePayload, { merge: true });
            updatedSubscriptions.push({
              ...(subFirestorePayload as unknown as UserSubscription),
              ...(resolvedEmail ? { studentEmail: resolvedEmail } : {}),
              activatedAt: activatedIso,
              expiresAt: effectiveExpiresIso
            });
          }

          persistedSubscription =
            (cleanSubId ? updatedSubscriptions.find(s => s.id === cleanSubId) : undefined) ||
            updatedSubscriptions[0] ||
            null;
        }

        if (isSessionRevoked && userSessSnap?.exists) {
          const activeSessId = userSessSnap.data()?.activeSessionId as string | undefined;
          if (activeSessId) {
            batch.set(
              db.collection('sessions').doc(activeSessId),
              { status: 'revoked', revokedReason: 'Revoked by administrator' },
              { merge: true }
            );
          }
        }

        const auditEntry: AuditLog = {
          id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          userId: req.authUser!.uid,
          userName: req.authUser!.email || 'Owner Admin',
          action: 'USER_EDITED_BY_ADMIN',
          details: `Admin updated user ${targetUid} (role=${safeRole}, status=${safeSubStatus}, subsUpdated=${updatedSubscriptions.length}${
            isSessionRevoked ? ', session_revoked' : ''
          }).`,
          timestamp: nowIso
        };
        batch.set(db.collection('auditLogs').doc(auditEntry.id), auditEntry);
        await batch.commit();

        return res.json({
          success: true,
          user: userPayloadForResponse,
          subscription: persistedSubscription,
          updatedSubscriptions,
          revokedSubscriptionCount: safeSubStatus === 'pro' ? 0 : updatedSubscriptions.length
        });
      }

      if (!allowMemoryFallback) {
        return res.status(503).json({ error: 'FIRESTORE_UNAVAILABLE' });
      }

      if (cleanSubId) {
        const explicitMirrorSub = mirror.subscriptions.find(s => s.id === cleanSubId);
        if (explicitMirrorSub && explicitMirrorSub.userId && explicitMirrorSub.userId !== targetUid) {
          return res.status(403).json({
            error: 'SUBSCRIPTION_USER_MISMATCH',
            message: 'Subscription record does not belong to target user.'
          });
        }
      }

      const existing = mirror.users[targetUid];
      const existingEmail = typeof existing?.email === 'string' ? existing.email.trim() : '';
      const resolvedEmail = rawEmailInput ? rawEmailInput.toLowerCase().slice(0, 150) : existingEmail;
      const effectiveUserExpiresIso = cleanExpiresIso || existing?.subscriptionExpiresAt;
      const resolvedActivePackageId =
        typeof packageId === 'string' && packageId ? packageId : existing?.activePackageId;
      const resolvedActivePackageNameBn =
        typeof packageNameBn === 'string' && packageNameBn ? packageNameBn : existing?.activePackageNameBn;
      const resolvedActivePackageNameEn =
        typeof packageNameEn === 'string' && packageNameEn ? packageNameEn : existing?.activePackageNameEn;

      mirror.users[targetUid] = {
        ...(existing || { uid: targetUid, createdAt: nowIso }),
        uid: targetUid,
        name: cleanName,
        email: resolvedEmail,
        phone: cleanPhone,
        role: safeRole,
        subscriptionStatus: safeSubStatus,
        subscriptionExpiresAt: effectiveUserExpiresIso,
        activePackageId: resolvedActivePackageId,
        activePackageNameBn: resolvedActivePackageNameBn,
        activePackageNameEn: resolvedActivePackageNameEn
      };

      let mirrorSub: UserSubscription | null = null;
      const updatedSubscriptions: UserSubscription[] = [];

      if (safeSubStatus === 'pro') {
        const targetIdx = mirror.subscriptions.findIndex(s =>
          cleanSubId ? s.id === cleanSubId : s.userId === targetUid
        );
        if (targetIdx >= 0) {
          const prevSub = mirror.subscriptions[targetIdx];
          mirrorSub = {
            ...prevSub,
            studentName: cleanName,
            studentPhone: cleanPhone,
            ...(resolvedEmail ? { studentEmail: resolvedEmail } : {}),
            packageId: (typeof packageId === 'string' && packageId) || prevSub.packageId,
            packageNameBn: (typeof packageNameBn === 'string' && packageNameBn) || prevSub.packageNameBn,
            packageNameEn: (typeof packageNameEn === 'string' && packageNameEn) || prevSub.packageNameEn,
            status: 'active',
            expiresAt: cleanExpiresIso || prevSub.expiresAt
          };
          mirror.subscriptions[targetIdx] = mirrorSub;
        } else {
          const pkgMatch = mirror.packages.find(p => p.id === packageId) || mirror.packages[0];
          mirrorSub = {
            id: cleanSubId || `sub_admin_${targetUid}`,
            userId: targetUid,
            studentName: cleanName,
            studentPhone: cleanPhone,
            ...(resolvedEmail ? { studentEmail: resolvedEmail } : {}),
            packageId: pkgMatch.id,
            packageNameBn: (typeof packageNameBn === 'string' && packageNameBn) || pkgMatch.nameBn,
            packageNameEn: (typeof packageNameEn === 'string' && packageNameEn) || pkgMatch.nameEn,
            pricePaid: pkgMatch.price,
            paymentRequestId: `admin_grant_${Date.now()}`,
            paymentMethod: 'bKash',
            transactionId: `ADMIN_GRANT_${Date.now().toString().slice(-6)}`,
            activatedAt: nowIso,
            expiresAt: cleanExpiresIso || new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString(),
            validityType: pkgMatch.validityType,
            status: 'active',
            createdAt: nowIso
          };
          mirror.subscriptions.unshift(mirrorSub);
        }
        updatedSubscriptions.push(mirrorSub);
      } else {
        const nextSubStatus: 'expired' | 'cancelled' = safeSubStatus === 'expired' ? 'expired' : 'cancelled';
        for (let i = 0; i < mirror.subscriptions.length; i++) {
          const sub = mirror.subscriptions[i];
          if (sub.userId === targetUid && (sub.status === 'active' || (cleanSubId && sub.id === cleanSubId))) {
            const isPrimaryEdited = Boolean(cleanSubId && sub.id === cleanSubId);
            const updated: UserSubscription = {
              ...sub,
              studentName: isPrimaryEdited ? cleanName : sub.studentName,
              studentPhone: isPrimaryEdited ? cleanPhone : sub.studentPhone,
              ...(resolvedEmail ? { studentEmail: resolvedEmail } : {}),
              status: nextSubStatus,
              expiresAt: isPrimaryEdited && cleanExpiresIso ? cleanExpiresIso : sub.expiresAt
            };
            mirror.subscriptions[i] = updated;
            updatedSubscriptions.push(updated);
          }
        }
        mirrorSub =
          (cleanSubId ? updatedSubscriptions.find(s => s.id === cleanSubId) : undefined) ||
          updatedSubscriptions[0] ||
          null;
      }

      if (isSessionRevoked) {
        const sessId = mirror.userActiveSessions[targetUid];
        if (sessId && mirror.sessions[sessId]) {
          mirror.sessions[sessId].status = 'revoked';
          mirror.sessions[sessId].revokedReason = 'Revoked by administrator';
        }
      }

      return res.json({
        success: true,
        user: mirror.users[targetUid],
        subscription: mirrorSub,
        updatedSubscriptions,
        revokedSubscriptionCount: safeSubStatus === 'pro' ? 0 : updatedSubscriptions.length
      });
    } catch (err) {
      return sendRouteError(res, 'POST /api/admin/users/update', err);
    }
  });

  // ---------------------------------------------------------
  // ADMIN QUESTIONS & EXAMS CRUD
  // (Owner Admin Only - exposes answer keys only here)
  // ---------------------------------------------------------
  app.get('/api/admin/questions', requireFirebaseAuth, requireOwnerAdmin, async (_req, res) => {
    try {
      const list = await getAllQuestionsAuthoritative(
        mirror,
        db,
        allowMemoryFallback,
        useFirestore(),
        { ttlMs: options?.questionBankCacheTtlMs }
      );
      return res.json({ questions: list });
    } catch (err) {
      return sendRouteError(res, 'GET /api/admin/questions', err);
    }
  });

  app.post('/api/admin/questions', requireFirebaseAuth, requireOwnerAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const q = req.body as Partial<ServerQuestion> | undefined;
      const validSubjectIds = new Set(mirror.subjects.map(s => s.id));
      const cleanQuestionBn = typeof q?.questionBn === 'string' ? q.questionBn.trim() : '';
      const cleanOptionsBn = Array.isArray(q?.optionsBn)
        ? q.optionsBn.map(opt => (typeof opt === 'string' ? opt.trim() : ''))
        : [];
      const correctIdx = q?.correctOptionIndex;

      if (
        !q ||
        !cleanQuestionBn ||
        cleanQuestionBn.length > 1000 ||
        typeof q.subjectId !== 'string' ||
        !validSubjectIds.has(q.subjectId) ||
        cleanOptionsBn.length !== 4 ||
        cleanOptionsBn.some(opt => !opt) ||
        typeof correctIdx !== 'number' ||
        !Number.isInteger(correctIdx) ||
        correctIdx < 0 ||
        correctIdx > 3
      ) {
        return res.status(400).json({
          error: 'INVALID_QUESTION',
          message:
            'Valid subjectId, questionBn (<= 1000 chars), 4 non-empty optionsBn, and integer correctOptionIndex (0-3) are required.'
        });
      }

      const cleanOptionsEn =
        Array.isArray(q.optionsEn) && q.optionsEn.length === 4 && q.optionsEn.every(opt => typeof opt === 'string' && opt.trim())
          ? q.optionsEn.map(opt => opt.trim())
          : cleanOptionsBn;

      const now = new Date().toISOString();
      const fullQ: ServerQuestion = {
        id:
          typeof q.id === 'string' && q.id.trim()
            ? q.id.trim().slice(0, 128)
            : `q_custom_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        subjectId: q.subjectId,
        topicId: typeof q.topicId === 'string' && q.topicId.trim() ? q.topicId.trim().slice(0, 64) : undefined,
        questionBn: cleanQuestionBn,
        questionEn:
          typeof q.questionEn === 'string' && q.questionEn.trim()
            ? q.questionEn.trim().slice(0, 1000)
            : cleanQuestionBn,
        optionsBn: cleanOptionsBn,
        optionsEn: cleanOptionsEn,
        correctOptionIndex: correctIdx,
        explanationBn: typeof q.explanationBn === 'string' ? q.explanationBn.trim().slice(0, 2000) : '',
        explanationEn: typeof q.explanationEn === 'string' ? q.explanationEn.trim().slice(0, 2000) : '',
        legalReference: typeof q.legalReference === 'string' ? q.legalReference.trim().slice(0, 200) : '',
        difficulty: q.difficulty === 'easy' || q.difficulty === 'hard' ? q.difficulty : 'medium',
        status: q.status === 'draft' || q.status === 'reviewed' ? q.status : 'published',
        isDemoSample: Boolean(q.isDemoSample),
        createdAt: typeof q.createdAt === 'string' && q.createdAt.trim() ? q.createdAt.trim() : now,
        updatedAt: now,
        createdBy:
          typeof q.createdBy === 'string' && q.createdBy.trim() ? q.createdBy.trim().slice(0, 100) : 'Owner Admin'
      };

      const versionPayload = createQuestionBankVersionPayload(now);
      if (useFirestore()) {
        const batch = db.batch();
        batch.set(db.collection('questions').doc(fullQ.id), sanitizeQuestionForClient(fullQ));
        batch.set(db.collection('questionKeys').doc(fullQ.id), {
          correctOptionIndex: fullQ.correctOptionIndex,
          explanationBn: fullQ.explanationBn || '',
          explanationEn: fullQ.explanationEn || '',
          legalReference: fullQ.legalReference || '',
          updatedAt: now
        });
        batch.set(
          db.collection('config').doc('questionBankVersion'),
          versionPayload,
          { merge: true }
        );
        const auditEntry: AuditLog = {
          id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          userId: req.authUser!.uid,
          userName: req.authUser!.email || 'Owner Admin',
          action: 'SAVE_QUESTION',
          details: `Saved question ${fullQ.id} (${fullQ.subjectId})`,
          timestamp: now
        };
        batch.set(db.collection('auditLogs').doc(auditEntry.id), auditEntry);
        await batch.commit();
        invalidateQuestionBankCache(db);
      } else {
        if (!allowMemoryFallback) {
          return res.status(503).json({ error: 'FIRESTORE_UNAVAILABLE' });
        }
        const existingIdx = mirror.questions.findIndex(item => item.id === fullQ.id);
        if (existingIdx >= 0) mirror.questions[existingIdx] = fullQ;
        else mirror.questions.unshift(fullQ);
      }
      return res.json({ success: true, question: fullQ, versionToken: versionPayload.versionToken });
    } catch (err) {
      return sendRouteError(res, 'POST /api/admin/questions', err);
    }
  });

  app.post('/api/admin/questions/invalidate-cache', requireFirebaseAuth, requireOwnerAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const now = new Date().toISOString();
      const versionPayload = createQuestionBankVersionPayload(now);
      if (useFirestore()) {
        const auditEntry: AuditLog = {
          id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          userId: req.authUser!.uid,
          userName: req.authUser!.email || 'Owner Admin',
          action: 'INVALIDATE_QUESTION_CACHE',
          details: `Owner invalidated question bank cache (token: ${versionPayload.versionToken})`,
          timestamp: now
        };
        const batch = db.batch();
        batch.set(db.collection('config').doc('questionBankVersion'), versionPayload, { merge: true });
        batch.set(db.collection('auditLogs').doc(auditEntry.id), auditEntry);
        await batch.commit();
        invalidateQuestionBankCache(db);
        return res.json({ success: true, version: versionPayload });
      }
      if (!allowMemoryFallback) {
        return res.status(503).json({ error: 'FIRESTORE_UNAVAILABLE' });
      }
      invalidateQuestionBankCache(db);
      return res.json({ success: true, version: versionPayload });
    } catch (err) {
      return sendRouteError(res, 'POST /api/admin/questions/invalidate-cache', err);
    }
  });

  app.delete('/api/admin/questions/:id', requireFirebaseAuth, requireOwnerAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const id = decodeURIComponent(String(req.params.id || '')).trim();
      if (!id || id.length > 128) {
        return res.status(400).json({ error: 'INVALID_REQUEST', message: 'Valid questionId is required.' });
      }
      const now = new Date().toISOString();
      const versionPayload = createQuestionBankVersionPayload(now);
      if (useFirestore()) {
        const batch = db.batch();
        batch.delete(db.collection('questions').doc(id));
        batch.delete(db.collection('questionKeys').doc(id));
        batch.set(
          db.collection('config').doc('questionBankVersion'),
          versionPayload,
          { merge: true }
        );
        const auditEntry: AuditLog = {
          id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          userId: req.authUser!.uid,
          userName: req.authUser!.email || 'Owner Admin',
          action: 'DELETE_QUESTION',
          details: `Deleted question ${id}`,
          timestamp: now
        };
        batch.set(db.collection('auditLogs').doc(auditEntry.id), auditEntry);
        await batch.commit();
        invalidateQuestionBankCache(db);
      } else {
        if (!allowMemoryFallback) {
          return res.status(503).json({ error: 'FIRESTORE_UNAVAILABLE' });
        }
        mirror.questions = mirror.questions.filter(q => q.id !== id);
      }
      return res.json({ success: true, versionToken: versionPayload.versionToken });
    } catch (err) {
      return sendRouteError(res, 'DELETE /api/admin/questions/:id', err);
    }
  });


  app.post('/api/admin/exams/save', requireFirebaseAuth, requireOwnerAdmin, async (req: AuthenticatedRequest, res) => {
    try {
      const exam = req.body as Exam;
      if (!exam || !exam.id) {
        return res.status(400).json({ error: 'INVALID_EXAM' });
      }
      const normalized: Exam = {
        ...exam,
        isActive: exam.isActive !== undefined ? exam.isActive : !exam.isPaid,
        scheduledDate: exam.scheduledDate || undefined
      };
      const now = new Date().toISOString();

      if (useFirestore()) {
        const batch = db.batch();
        batch.set(
          db.collection('exams').doc(normalized.id),
          { ...normalized, scheduledDate: normalized.scheduledDate ?? null, updatedAt: now },
          { merge: true }
        );
        const auditEntry: AuditLog = {
          id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          userId: req.authUser!.uid,
          userName: req.authUser!.email || 'Owner Admin',
          action: 'SAVE_EXAM',
          details: `Saved exam ${normalized.id} (isActive=${normalized.isActive}, isPaid=${normalized.isPaid})`,
          timestamp: now
        };
        batch.set(db.collection('auditLogs').doc(auditEntry.id), auditEntry);
        await batch.commit();
      } else {
        if (!allowMemoryFallback) {
          return res.status(503).json({ error: 'FIRESTORE_UNAVAILABLE' });
        }
        const idx = mirror.exams.findIndex(e => e.id === normalized.id);
        if (idx >= 0) mirror.exams[idx] = normalized;
        else mirror.exams.unshift(normalized);
      }
      return res.json({ success: true, exam: normalized });
    } catch (err) {
      return sendRouteError(res, 'POST /api/admin/exams/save', err);
    }
  });

  app.post('/api/admin/migrate-timestamps', requireFirebaseAuth, requireOwnerAdmin, async (_req, res) => {
    try {
      if (!useFirestore()) {
        return res.status(isProductionMode ? 503 : 200).json({
          success: false,
          persistenceMode: isProductionMode ? 'unavailable' : persistenceState.mode,
          message: 'Firestore Admin IAM is not attached in this environment. Use migration script with service account or Cloud Run.'
        });
      }
      const summary = await migrateAllSubscriptionTimestampsAdmin();
      return res.json({ success: true, ...summary });
    } catch (err) {
      return sendRouteError(res, 'POST /api/admin/migrate-timestamps', err);
    }
  });

  app.post('/api/admin/import-questions-to-firestore', requireFirebaseAuth, requireOwnerAdmin, async (_req, res) => {
    try {
      if (!useFirestore()) {
        return res.status(isProductionMode ? 503 : 200).json({
          success: false,
          persistenceMode: isProductionMode ? 'unavailable' : persistenceState.mode,
          message: 'Firestore Admin IAM is not attached in this environment. Use import script with service account or Cloud Run.'
        });
      }
      const summary = await importMissingDataToFirestoreAdmin(mirror);
      return res.json({ success: true, ...summary });
    } catch (err) {
      return sendRouteError(res, 'POST /api/admin/import-questions-to-firestore', err);
    }
  });

  // ---------------------------------------------------------
  // SUBSCRIPTIONS & ADMIN STATS (Authoritative Firestore Reads)
  // ---------------------------------------------------------
  app.get('/api/admin/subscriptions', requireFirebaseAuth, requireOwnerAdmin, async (_req, res) => {
    try {
      const now = Date.now();
      let subList: UserSubscription[];
      const userEmailMap = new Map<string, string>();
      if (useFirestore()) {
        const snap = await db.collection('subscriptions').get();
        subList = snap.docs.map(d => {
          const raw = d.data() as Record<string, unknown>;
          return {
            ...(raw as Omit<UserSubscription, 'id'>),
            id: d.id,
            activatedAt: timestampToIso(raw.activatedAt) || new Date().toISOString(),
            expiresAt: timestampToIso(raw.expiresAt) || new Date(0).toISOString(),
            createdAt: timestampToIso(raw.createdAt) || new Date().toISOString()
          };
        });

        const uniqueUids = Array.from(
          new Set(subList.map(s => (typeof s.userId === 'string' ? s.userId.trim() : '')).filter(Boolean))
        );
        for (let i = 0; i < uniqueUids.length; i += 50) {
          const chunk = uniqueUids.slice(i, i + 50);
          const userSnaps = await Promise.all(
            chunk.map(uid => db.collection('users').doc(uid).get())
          ).catch(() => []);
          for (const uSnap of userSnaps) {
            if (uSnap.exists) {
              const emailVal = uSnap.data()?.email;
              if (typeof emailVal === 'string' && emailVal.trim()) {
                userEmailMap.set(uSnap.id, emailVal.trim());
              }
            }
          }
        }
      } else {
        if (!allowMemoryFallback) {
          return res.status(503).json({ error: 'FIRESTORE_UNAVAILABLE' });
        }
        subList = mirror.subscriptions;
        for (const [uid, u] of Object.entries(mirror.users)) {
          if (typeof u.email === 'string' && u.email.trim()) {
            userEmailMap.set(uid, u.email.trim());
          }
        }
      }

      const mapped = subList.map(s => {
        const expMs = new Date(s.expiresAt).getTime();
        const isExpired = isNaN(expMs) || expMs <= now;
        const daysRemaining = isNaN(expMs) ? 0 : Math.max(0, Math.ceil((expMs - now) / (1000 * 60 * 60 * 24)));
        const rawStudentEmail =
          typeof s.studentEmail === 'string' && s.studentEmail.trim() ? s.studentEmail.trim() : '';
        const resolvedStudentEmail = userEmailMap.get(String(s.userId || '').trim()) || rawStudentEmail;
        return {
          ...s,
          ...(resolvedStudentEmail ? { studentEmail: resolvedStudentEmail } : {}),
          status: isExpired && s.status === 'active' ? ('expired' as const) : s.status,
          daysRemaining
        };
      });
      mapped.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      return res.json({ subscriptions: mapped });
    } catch (err) {
      return sendRouteError(res, 'GET /api/admin/subscriptions', err);
    }
  });

  app.get('/api/subscriptions/active/:userId', requireFirebaseAuth, authenticateSession, async (req: AuthenticatedRequest, res) => {
    try {
      const { userId } = req.params;
      if (userId !== req.authUser!.uid && !isOwnerUser(req.authUser)) {
        return res.status(403).json({ error: 'FORBIDDEN', message: 'Cannot access another user subscription.' });
      }
      const subStatus = await checkUserHasActiveSubscription(
        String(userId),
        mirror,
        db,
        allowMemoryFallback,
        useFirestore()
      );
      if (!subStatus.active || !subStatus.activeSubscription) {
        return res.json({
          hasActiveSubscription: false,
          status: subStatus.active ? 'pro' : 'free',
          activeSubscription: null
        });
      }
      const daysRemaining = Math.max(
        0,
        Math.ceil((new Date(subStatus.activeSubscription.expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
      );
      return res.json({
        hasActiveSubscription: true,
        status: 'pro',
        activeSubscription: subStatus.activeSubscription,
        daysRemaining
      });
    } catch (err) {
      return sendRouteError(res, 'GET /api/subscriptions/active/:userId', err);
    }
  });

  app.get('/api/admin/dashboard-stats', requireFirebaseAuth, requireOwnerAdmin, async (_req, res) => {
    try {
      const now = Date.now();
      let payments: PaymentRequest[];
      let subs: UserSubscription[];
      let results: ExamResult[];
      const studentUserIds = new Set<string>();

      if (useFirestore()) {
        const [userSnap, paySnap, subSnap, resSnap] = await Promise.all([
          db.collection('users').get(),
          db.collection('paymentRequests').get(),
          db.collection('subscriptions').get(),
          db.collection('examResults').get()
        ]);
        userSnap.forEach(d => studentUserIds.add(d.id));
        payments = paySnap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<PaymentRequest, 'id'>) }));
        subs = subSnap.docs.map(d => {
          const raw = d.data() as Record<string, unknown>;
          return {
            ...(raw as Omit<UserSubscription, 'id'>),
            id: d.id,
            activatedAt: timestampToIso(raw.activatedAt) || new Date().toISOString(),
            expiresAt: timestampToIso(raw.expiresAt) || new Date(0).toISOString(),
            createdAt: timestampToIso(raw.createdAt) || new Date().toISOString()
          };
        });
        results = resSnap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<ExamResult, 'id'>) }));
      } else {
        if (!allowMemoryFallback) {
          return res.status(503).json({ error: 'FIRESTORE_UNAVAILABLE' });
        }
        payments = mirror.paymentRequests;
        subs = mirror.subscriptions;
        results = mirror.examResults;
        Object.keys(mirror.users).forEach(uid => studentUserIds.add(uid));
      }

      payments.forEach(p => { if (p.userId) studentUserIds.add(p.userId); });
      subs.forEach(s => { if (s.userId) studentUserIds.add(s.userId); });
      results.forEach(r => { if (r.userId) studentUserIds.add(r.userId); });

      const totalStudents = studentUserIds.size;
      const activeSubscribers = subs.filter(
        s => s.status === 'active' && new Date(s.expiresAt).getTime() > now
      ).length;
      const pendingPayments = payments.filter(p => p.status === 'pending').length;
      const approvedPayments = payments.filter(p => p.status === 'approved').length;
      const rejectedPayments = payments.filter(p => p.status === 'rejected').length;
      const expiredSubscriptions = subs.filter(
        s => s.status === 'expired' || new Date(s.expiresAt).getTime() <= now
      ).length;
      const totalVerifiedRevenue = payments
        .filter(p => p.status === 'approved')
        .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);

      return res.json({
        totalStudents,
        activeSubscribers,
        pendingPayments,
        approvedPayments,
        rejectedPayments,
        expiredSubscriptions,
        totalVerifiedRevenue,
        totalExamsCompleted: results.length,
        monthlyRevenueReport: []
      });
    } catch (err) {
      return sendRouteError(res, 'GET /api/admin/dashboard-stats', err);
    }
  });

  app.get('/api/admin/audit-logs', requireFirebaseAuth, requireOwnerAdmin, async (_req, res) => {
    try {
      if (useFirestore()) {
        const snap = await db.collection('auditLogs').get();
        const logs = snap.docs
          .map(d => ({ id: d.id, ...(d.data() as Omit<AuditLog, 'id'>) }))
          .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
          .slice(0, 200);
        return res.json({ auditLogs: logs });
      }
      if (!allowMemoryFallback) {
        return res.status(503).json({ error: 'FIRESTORE_UNAVAILABLE' });
      }
      return res.json({ auditLogs: mirror.auditLogs });
    } catch (err) {
      return sendRouteError(res, 'GET /api/admin/audit-logs', err);
    }
  });

  // ---------------------------------------------------------
  // SERVER-SIDE EXAMINATION ENGINE (Atomic Transactions & Multi-Instance Safe)
  // ---------------------------------------------------------
  app.post('/api/exams/start', requireFirebaseAuth, examsStartRateLimiter, authenticateSession, async (req: AuthenticatedRequest, res) => {
    try {
      const session = req.session;
      const { examId, studentName } = req.body || {};
      const targetUserId = req.authUser!.uid;
      const isOwner = isOwnerUser(req.authUser);

      if (!examId || typeof examId !== 'string') {
        return res.status(400).json({ error: 'INVALID_EXAM_ID', message: 'Valid examId is required.' });
      }

      const exam = await getAuthoritativeExam(
        examId,
        mirror,
        db,
        allowMemoryFallback,
        useFirestore()
      );
      if (!exam) {
        return res.status(404).json({ error: 'EXAM_NOT_FOUND', message: 'Exam not found.' });
      }

      if (exam.isActive === false && !isOwner) {
        return res.status(403).json({
          error: 'EXAM_INACTIVE',
          message: 'এই পরীক্ষাটি এখনো অ্যাডমিন কর্তৃক চালু করা হয়নি।'
        });
      }

      if (exam.type === 'custom_test' && !isOwner) {
        return res.status(403).json({
          error: 'FORBIDDEN',
          message: 'অননুমোদিত: অ্যাডমিন ছাড়া কেউ কাস্টম টেস্ট নিতে পারবেন না।'
        });
      }

      if (exam.isPaid && !isOwner) {
        const subCheck = await checkUserHasActiveSubscription(
          targetUserId,
          mirror,
          db,
          allowMemoryFallback,
          useFirestore()
        );
        if (!subCheck.active) {
          return res.status(403).json({
            error: 'SUBSCRIPTION_REQUIRED',
            message: 'এই ৬০ মিনিটের স্পেশাল মডেল টেস্টটি আনলক করতে সক্রিয় প্রো সাবস্ক্রিপশন প্রয়োজন।'
          });
        }
      }

      const allQuestions = await getSanitizedQuestionsAuthoritative(
        mirror,
        db,
        allowMemoryFallback,
        useFirestore(),
        { ttlMs: options?.questionBankCacheTtlMs }
      );
      const examQuestions = getQuestionsForExam(exam, allQuestions);
      const resolvedQuestionIds = examQuestions.map(q => q.id);

      const durationMinutes = exam.durationMinutes || 60;
      const now = new Date();
      const deadline = new Date(now.getTime() + durationMinutes * 60 * 1000);

      const attempt: ExamAttempt = {
        id: `attempt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        examId: exam.id,
        userId: targetUserId,
        sessionId: session?.sessionId,
        studentName: String(studentName || req.authUser!.name || 'Student').slice(0, 100),
        startTime: now.toISOString(),
        deadlineTime: deadline.toISOString(),
        status: 'in_progress',
        answers: {},
        flaggedQuestionIds: [],
        currentQuestionIndex: 0,
        lastSavedAt: now.toISOString()
      };

      const auditEntry: AuditLog = {
        id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        userId: targetUserId,
        userName: attempt.studentName,
        action: 'START_EXAM',
        details: `Started authoritative exam "${exam.titleEn}" (${attempt.id})`,
        timestamp: now.toISOString()
      };

      if (useFirestore()) {
        const batch = db.batch();
        batch.set(db.collection('examAttempts').doc(attempt.id), {
          ...attempt,
          sessionId: attempt.sessionId || null,
          resolvedQuestionIds
        });
        batch.set(db.collection('auditLogs').doc(auditEntry.id), auditEntry);
        await batch.commit();
      } else {
        if (!allowMemoryFallback) {
          return res.status(503).json({ error: 'FIRESTORE_UNAVAILABLE' });
        }
        mirror.examAttempts[attempt.id] = attempt;
        mirror.auditLogs.unshift(auditEntry);
      }

      return res.json({
        success: true,
        attempt,
        exam: {
          ...exam,
          questionIds: resolvedQuestionIds
        },
        questions: examQuestions.map(sanitizeQuestionForClient),
        durationMinutes,
        deadlineTime: attempt.deadlineTime
      });
    } catch (err) {
      return sendRouteError(res, 'POST /api/exams/start', err, 'START_EXAM_FAILED', 'Failed to start exam.');
    }
  });

  app.post('/api/exams/save-answer', requireFirebaseAuth, authenticateSession, async (req: AuthenticatedRequest, res) => {
    try {
      const { attemptId, answers, flaggedQuestionIds, currentQuestionIndex } = req.body || {};
      if (!attemptId || typeof attemptId !== 'string') {
        return res.status(400).json({ error: 'INVALID_REQUEST' });
      }

      const cleanedAnswers: Record<string, number> | undefined =
        answers && typeof answers === 'object' && !Array.isArray(answers)
          ? Object.entries(answers).reduce<Record<string, number>>((acc, [k, v]) => {
              if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 3) {
                acc[k] = v;
              }
              return acc;
            }, {})
          : undefined;
      const cleanedFlagged = Array.isArray(flaggedQuestionIds)
        ? flaggedQuestionIds.map(String).slice(0, 200)
        : undefined;
      let cleanedIndex: number | undefined;
      if (currentQuestionIndex !== undefined) {
        if (
          typeof currentQuestionIndex !== 'number' ||
          !Number.isInteger(currentQuestionIndex) ||
          currentQuestionIndex < 0
        ) {
          return res.status(400).json({
            error: 'INVALID_REQUEST',
            message: 'currentQuestionIndex must be a non-negative integer.'
          });
        }
        cleanedIndex = currentQuestionIndex;
      }
      const lastSavedAt = new Date().toISOString();

      if (useFirestore()) {
        await db.runTransaction(async (tx) => {
          const attemptRef = db.collection('examAttempts').doc(attemptId);
          const snap = await tx.get(attemptRef);
          if (!snap.exists) {
            throw new HttpError(404, 'ATTEMPT_NOT_FOUND', 'Exam attempt not found.');
          }
          const attempt = { id: snap.id, ...(snap.data() as Omit<ExamAttempt, 'id'>) };
          if (attempt.userId !== req.authUser!.uid) {
            throw new HttpError(403, 'FORBIDDEN', 'Cannot modify another user exam attempt.');
          }
          if (attempt.status !== 'in_progress') {
            throw new HttpError(400, 'ALREADY_SUBMITTED', 'Attempt has already been submitted.');
          }
          tx.update(attemptRef, {
            ...(cleanedAnswers !== undefined ? { answers: cleanedAnswers } : {}),
            ...(cleanedFlagged !== undefined ? { flaggedQuestionIds: cleanedFlagged } : {}),
            ...(cleanedIndex !== undefined ? { currentQuestionIndex: cleanedIndex } : {}),
            lastSavedAt
          });
        });
        return res.json({ success: true });
      }

      if (!allowMemoryFallback) {
        return res.status(503).json({ error: 'FIRESTORE_UNAVAILABLE' });
      }

      const attempt = mirror.examAttempts[attemptId];
      if (!attempt) {
        return res.status(404).json({ error: 'ATTEMPT_NOT_FOUND' });
      }
      if (attempt.userId !== req.authUser!.uid) {
        return res.status(403).json({ error: 'FORBIDDEN' });
      }
      if (attempt.status !== 'in_progress') {
        return res.status(400).json({ error: 'ALREADY_SUBMITTED' });
      }

      if (cleanedAnswers !== undefined) attempt.answers = cleanedAnswers;
      if (cleanedFlagged !== undefined) attempt.flaggedQuestionIds = cleanedFlagged;
      if (cleanedIndex !== undefined) attempt.currentQuestionIndex = cleanedIndex;
      attempt.lastSavedAt = lastSavedAt;

      return res.json({ success: true });
    } catch (err) {
      return sendRouteError(res, 'POST /api/exams/save-answer', err, 'SAVE_ANSWER_FAILED', 'Failed to save exam progress.');
    }
  });

  // Authoritative server-side scoring with Atomic Firestore Transaction
  app.post('/api/exams/submit', requireFirebaseAuth, examsSubmitRateLimiter, authenticateSession, async (req: AuthenticatedRequest, res) => {
    try {
      const { attemptId, answers, isAutoTimeout } = req.body || {};
      const uid = req.authUser!.uid;

      if (!attemptId || typeof attemptId !== 'string') {
        return res.status(400).json({ error: 'INVALID_ATTEMPT_ID', message: 'Valid attemptId is required.' });
      }

      const buildEvaluation = (
        attempt: ExamAttempt,
        exam: Exam,
        authoritativeQuestions: ServerQuestion[]
      ) => {
        const validQIdSet = new Set(authoritativeQuestions.map(q => q.id));
        const rawAnswers: Record<string, unknown> =
          answers && typeof answers === 'object' ? answers : attempt.answers || {};
        const sanitizedAnswers: Record<string, number> = {};
        for (const [qId, optVal] of Object.entries(rawAnswers)) {
          if (validQIdSet.has(qId) && typeof optVal === 'number' && Number.isInteger(optVal) && optVal >= 0 && optVal <= 3) {
            sanitizedAnswers[qId] = optVal;
          }
        }

        const scoreResult = calculateExamScore(sanitizedAnswers, authoritativeQuestions, {
          positiveMarkRatio: exam.positiveMarkRatio ?? 1.0,
          negativeMarkRatio: exam.negativeMarkRatio ?? 0.25,
          passThresholdPercentage: exam.passThresholdPercentage
        });

        const nowMs = Date.now();
        const startTimeMs = new Date(attempt.startTime).getTime();
        const deadlineMs = new Date(attempt.deadlineTime).getTime();
        const submissionTimeMs = Math.min(nowMs, isNaN(deadlineMs) ? nowMs : deadlineMs + 15000);
        const timeSpentSeconds = Math.max(
          1,
          Math.round((submissionTimeMs - (isNaN(startTimeMs) ? nowMs : startTimeMs)) / 1000)
        );

        const subjectScores: ExamResult['subjectWiseScores'] = {};
        for (const sub of mirror.subjects) {
          const subQuestions = authoritativeQuestions.filter(q => q.subjectId === sub.id);
          if (subQuestions.length > 0) {
            let correct = 0;
            let incorrect = 0;
            let unanswered = 0;
            for (const q of subQuestions) {
              const ans = sanitizedAnswers[q.id];
              if (ans === undefined || ans === null) unanswered++;
              else if (ans === q.correctOptionIndex) correct++;
              else incorrect++;
            }
            const score = Math.round((correct * (exam.positiveMarkRatio ?? 1.0) - incorrect * (exam.negativeMarkRatio ?? 0.25)) * 100) / 100;
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

        const isServerTimedOut = !isNaN(deadlineMs) && nowMs > deadlineMs + 15000;
        const effectiveTimedOut = Boolean(isAutoTimeout) || isServerTimedOut;
        const submittedAt = new Date(nowMs).toISOString();
        const nextAttemptStatus: ExamAttempt['status'] = effectiveTimedOut ? 'timed_out' : 'submitted';

        const newResult: ExamResult = {
          id: `res_${attempt.id}`,
          attemptId: attempt.id,
          examId: exam.id,
          examTitleBn: exam.titleBn,
          examTitleEn: exam.titleEn,
          examType: exam.type,
          userId: uid,
          studentName: attempt.studentName,
          submittedAt,
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
          answers: sanitizedAnswers,
          questions: authoritativeQuestions
        };

        const leaderboardEntry: LeaderboardEntry = {
          id: `lead_${uid}_${exam.id}`,
          userId: uid,
          studentName: attempt.studentName,
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
          completedAt: submittedAt
        };

        return { sanitizedAnswers, submittedAt, nextAttemptStatus, effectiveTimedOut, newResult, leaderboardEntry };
      };

      if (useFirestore()) {
        const txOutcome = await db.runTransaction(async (tx) => {
          const attemptRef = db.collection('examAttempts').doc(attemptId);
          const attemptSnap = await tx.get(attemptRef);

          if (!attemptSnap.exists) {
            throw new HttpError(404, 'ATTEMPT_NOT_FOUND', 'Exam attempt not found.');
          }

          const rawAttempt = attemptSnap.data() as ExamAttempt & { resolvedQuestionIds?: string[] };
          const attempt: ExamAttempt = { ...rawAttempt, id: attemptSnap.id };

          if (attempt.userId !== uid) {
            throw new HttpError(403, 'FORBIDDEN', 'Cannot submit another user exam attempt.');
          }
          if (attempt.status !== 'in_progress') {
            throw new HttpError(400, 'ALREADY_SUBMITTED', 'Attempt has already been submitted.');
          }

          const examRef = db.collection('exams').doc(attempt.examId);
          const examSnap = await tx.get(examRef);
          if (!examSnap.exists) {
            throw new HttpError(404, 'EXAM_NOT_FOUND', 'Exam not found.');
          }
          const examData = examSnap.data() as Omit<Exam, 'id'>;
          const exam: Exam = {
            id: examSnap.id,
            ...examData,
            isActive: examData.isActive !== undefined ? examData.isActive : (!examData.isPaid || examSnap.id === 'exam_model_test_01')
          };

          const resolvedIds =
            Array.isArray(rawAttempt.resolvedQuestionIds) && rawAttempt.resolvedQuestionIds.length > 0
              ? rawAttempt.resolvedQuestionIds
              : exam.questionIds || [];

          let authoritativeQuestions: ServerQuestion[] = [];
          if (resolvedIds.length > 0 && resolvedIds.length <= 200) {
            // Read questions and questionKeys atomically inside transaction
            const [qSnaps, kSnaps] = await Promise.all([
              Promise.all(resolvedIds.map(qId => tx.get(db.collection('questions').doc(qId)))),
              Promise.all(resolvedIds.map(qId => tx.get(db.collection('questionKeys').doc(qId))))
            ]);
            for (let i = 0; i < resolvedIds.length; i++) {
              const qS = qSnaps[i];
              const kS = kSnaps[i];
              if (!qS.exists) continue;
              const qBase = qS.data() as Partial<ServerQuestion>;
              const kData = kS.exists ? (kS.data() as Partial<ServerQuestion>) : undefined;
              const rawCorrectIdx = kData?.correctOptionIndex ?? qBase.correctOptionIndex;
              if (
                typeof rawCorrectIdx !== 'number' ||
                !Number.isInteger(rawCorrectIdx) ||
                rawCorrectIdx < 0 ||
                rawCorrectIdx > 3
              ) {
                throw new HttpError(
                  503,
                  'QUESTION_KEYS_UNAVAILABLE',
                  'Authoritative exam answer keys could not be loaded.'
                );
              }
              authoritativeQuestions.push({
                ...(qBase as ServerQuestion),
                id: qS.id,
                correctOptionIndex: rawCorrectIdx,
                explanationBn: kData?.explanationBn ?? qBase.explanationBn ?? '',
                explanationEn: kData?.explanationEn ?? qBase.explanationEn ?? ''
              });
            }
          } else {
            const allQuestions = await getAllQuestionsAuthoritative(
              mirror,
              db,
              allowMemoryFallback,
              true,
              { ttlMs: options?.questionBankCacheTtlMs }
            );
            const examMetaWithIds = resolvedIds.length > 0 ? { ...exam, questionIds: resolvedIds } : exam;
            const examQuestions = getQuestionsForExam(examMetaWithIds, allQuestions) as ServerQuestion[];
            const qMap = await getAuthoritativeQuestionMap(
              examQuestions.map(q => q.id),
              mirror,
              db,
              allowMemoryFallback,
              true
            );
            authoritativeQuestions = examQuestions.map(q => {
              const resolved = qMap.get(q.id) || q;
              if (
                typeof resolved.correctOptionIndex !== 'number' ||
                !Number.isInteger(resolved.correctOptionIndex) ||
                resolved.correctOptionIndex < 0 ||
                resolved.correctOptionIndex > 3
              ) {
                throw new HttpError(
                  503,
                  'QUESTION_KEYS_UNAVAILABLE',
                  'Authoritative exam answer keys could not be loaded.'
                );
              }
              return resolved;
            });
          }

          if (authoritativeQuestions.length === 0) {
            throw new HttpError(500, 'QUESTIONS_UNAVAILABLE', 'Authoritative exam questions could not be loaded.');
          }

          const { sanitizedAnswers, submittedAt, nextAttemptStatus, effectiveTimedOut, newResult, leaderboardEntry } =
            buildEvaluation(attempt, exam, authoritativeQuestions);

          const resultRef = db.collection('examResults').doc(newResult.id);
          const leadRef = db.collection('leaderboard').doc(leaderboardEntry.id);
          const auditRef = db.collection('auditLogs').doc(`log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`);

          const { questions: _q, ...firestoreResultPayload } = newResult;

          tx.update(attemptRef, {
            status: nextAttemptStatus,
            submittedTime: submittedAt,
            answers: sanitizedAnswers
          });
          tx.set(resultRef, { ...firestoreResultPayload, score: newResult.finalScore });
          tx.set(leadRef, leaderboardEntry, { merge: true });
          tx.set(auditRef, {
            id: auditRef.id,
            userId: uid,
            userName: attempt.studentName,
            action: effectiveTimedOut ? 'EXAM_TIMED_OUT' : 'SUBMIT_EXAM',
            details: `Server graded "${exam.titleEn}": ${newResult.finalScore}/${newResult.totalQuestions} (${newResult.percentage}%)`,
            timestamp: submittedAt
          });

          return { newResult, leaderboardEntry };
        });

        return res.json({
          success: true,
          result: txOutcome.newResult,
          leaderboardEntry: txOutcome.leaderboardEntry
        });
      }

      if (!allowMemoryFallback) {
        return res.status(503).json({ error: 'FIRESTORE_UNAVAILABLE' });
      }

      // Development-only memory fallback
      const attempt = mirror.examAttempts[attemptId];
      if (!attempt) {
        return res.status(404).json({ error: 'ATTEMPT_NOT_FOUND', message: 'Exam attempt not found.' });
      }
      if (attempt.userId !== uid) {
        return res.status(403).json({ error: 'FORBIDDEN', message: 'Cannot submit another user exam attempt.' });
      }
      if (attempt.status !== 'in_progress') {
        return res.status(400).json({ error: 'ALREADY_SUBMITTED', message: 'Attempt has already been submitted.' });
      }
      const exam = mirror.exams.find(e => e.id === attempt.examId);
      if (!exam) {
        return res.status(404).json({ error: 'EXAM_NOT_FOUND', message: 'Exam not found.' });
      }
      const examQuestions = getQuestionsForExam(exam, mirror.questions) as ServerQuestion[];
      const { sanitizedAnswers, submittedAt, nextAttemptStatus, effectiveTimedOut, newResult, leaderboardEntry } =
        buildEvaluation(attempt, exam, examQuestions);

      attempt.status = nextAttemptStatus;
      attempt.submittedTime = submittedAt;
      attempt.answers = sanitizedAnswers;
      mirror.examResults.unshift(newResult);
      mirror.leaderboard = [
        ...mirror.leaderboard.filter(item => !(item.userId === uid && item.examId === exam.id)),
        leaderboardEntry
      ].sort((a, b) => b.score - a.score || a.timeSpentSeconds - b.timeSpentSeconds);
      mirror.auditLogs.unshift({
        id: `log_${Date.now()}`,
        userId: uid,
        userName: attempt.studentName,
        action: effectiveTimedOut ? 'EXAM_TIMED_OUT' : 'SUBMIT_EXAM',
        details: `Server graded "${exam.titleEn}": ${newResult.finalScore}/${newResult.totalQuestions} (${newResult.percentage}%)`,
        timestamp: submittedAt
      });

      return res.json({
        success: true,
        result: newResult,
        leaderboardEntry
      });
    } catch (err) {
      return sendRouteError(
        res,
        'POST /api/exams/submit',
        err,
        'SUBMIT_PERSIST_FAILED',
        'Failed to persist exam result.'
      );
    }
  });

  app.get('/api/exams/results/:userId?', requireFirebaseAuth, authenticateSession, async (req: AuthenticatedRequest, res) => {
    try {
      const requestedUid = req.params.userId ? String(req.params.userId) : req.authUser!.uid;
      const isOwner = isOwnerUser(req.authUser);
      if (requestedUid !== req.authUser!.uid && !isOwner) {
        return res.status(403).json({ error: 'FORBIDDEN', message: 'Cannot read another user exam results.' });
      }

      if (useFirestore()) {
        const snap = await db.collection('examResults').where('userId', '==', requestedUid).get();
        const list = snap.docs
          .map(d => ({ id: d.id, ...(d.data() as Omit<ExamResult, 'id'>) }))
          .sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime());
        return res.json({ results: list });
      }

      if (!allowMemoryFallback) {
        return res.status(503).json({ error: 'FIRESTORE_UNAVAILABLE' });
      }
      const list = mirror.examResults.filter(r => r.userId === requestedUid);
      return res.json({ results: list });
    } catch (err) {
      return sendRouteError(res, 'GET /api/exams/results', err);
    }
  });

  app.use('/api', (_req, res) => {
    return res.status(404).json({
      error: 'NOT_FOUND',
      message: 'API endpoint not found.'
    });
  });

  return { app, mirror };
}

async function startServer() {
  await probeFirestoreAdminConnectivity();
  const { app, mirror } = createSanadPrepApp();

  const distDir = resolveWorkspacePath('dist');
  const distIndex = path.resolve(distDir, 'index.html');
  const isProduction = process.env.NODE_ENV === 'production';

  const isStaticModuleOrAssetRequest = (reqPath: string) =>
    reqPath.startsWith('/assets/') ||
    reqPath.startsWith('/src/') ||
    reqPath.startsWith('/node_modules/') ||
    reqPath.startsWith('/@') ||
    /\.(?:js|mjs|cjs|ts|tsx|jsx|css|map|json|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot)$/i.test(reqPath);

  if (isProduction && fs.existsSync(distIndex)) {
    app.use(express.static(distDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) {
        return next();
      }
      if (isStaticModuleOrAssetRequest(req.path)) {
        return res.status(404).type('text/plain').send('Asset not found');
      }
      res.sendFile(distIndex);
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR === 'true' ? false : undefined
      },
      appType: 'spa'
    });
    app.use(vite.middlewares);

    app.get('*', async (req, res, next) => {
      if (req.path.startsWith('/api')) {
        return next();
      }
      if (isStaticModuleOrAssetRequest(req.path)) {
        return res.status(404).type('text/plain').send('Module or asset not found');
      }
      try {
        const indexPath = resolveWorkspacePath('index.html');
        let template = fs.readFileSync(indexPath, 'utf-8');
        template = await vite.transformIndexHtml(req.originalUrl, template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
      } catch (e) {
        next(e);
      }
    });
  }

  const portArgIndex = process.argv.indexOf('--port');
  const cliPort = portArgIndex !== -1 ? Number(process.argv[portArgIndex + 1]) : null;
  const PORT = cliPort || (isProduction ? Number(process.env.PORT || 8080) : 3000);

  if (isProduction && parseAllowedOrigins(process.env.ALLOWED_ORIGIN).size === 0) {
    console.warn(
      '[SanadPrep Server] ALLOWED_ORIGIN is empty in production; browser requests from Cloudflare Workers/custom domains will be rejected by CORS until ALLOWED_ORIGIN is configured.'
    );
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(
      `Sanad Prep BD Engine running on port ${PORT} [mode: ${isProduction ? 'production' : 'development'}, persistence: ${persistenceState.mode}, questions: ${mirror.questions.length}]`
    );
  });

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use.`);
    } else {
      console.error('Server error:', err);
    }
  });

  const handleShutdown = () => {
    server.close(() => {
      process.exit(0);
    });
  };
  process.on('SIGTERM', handleShutdown);
  process.on('SIGINT', handleShutdown);
}

const isMainEntry =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMainEntry) {
  startServer();
}
