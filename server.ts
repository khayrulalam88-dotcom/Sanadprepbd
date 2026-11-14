import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import type {
  SubscriptionPackage,
  ExamDateConfig,
  UserSubscription,
  PaymentRequest,
  StudentSession,
  ExamResult,
  ExamAttempt,
  Exam,
  LeaderboardEntry,
  ServerQuestion,
  ServerPreviousQuestion,
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
  createMemoryMirror,
  checkUserHasActiveSubscription,
  getAllQuestionsAuthoritative,
  getAuthoritativeExam,
  getAuthoritativeQuestionMap,
  sanitizeQuestionForClient,
  sanitizePreviousQuestionForClient,
  isoToTimestamp,
  isAlreadyExistsError,
  isPermissionOrCredentialError,
  migrateAllSubscriptionTimestampsAdmin,
  importMissingDataToFirestoreAdmin,
  type MemoryMirror
} from './server/services/firestoreBackend.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface DecodedAuthUser {
  uid: string;
  email?: string;
  name?: string;
}

export interface AuthenticatedRequest extends Request {
  authUser?: DecodedAuthUser;
  session?: StudentSession;
}

export type TokenVerifier = (idToken: string) => Promise<DecodedAuthUser>;

function isOwnerUser(user?: { uid?: string; email?: string }): boolean {
  if (!user || !user.uid) return false;
  if (user.uid !== OWNER_ADMIN_UID) return false;
  if (user.email && user.email.toLowerCase().trim() !== OWNER_ADMIN_EMAIL) return false;
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

function isOriginAllowed(origin?: string): boolean {
  if (!origin) return true;
  const extraOrigins = (process.env.ALLOWED_ORIGIN || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (extraOrigins.includes(origin)) return true;

  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1') return true;
    if (host.endsWith('.pages.dev') || host.endsWith('.workers.dev') || host.endsWith('.run.app')) return true;
  } catch {
    return false;
  }
  return false;
}

export function createSanadPrepApp(options?: {
  tokenVerifier?: TokenVerifier;
  mirror?: MemoryMirror;
  disableFirestoreWrites?: boolean;
}) {
  const mirror: MemoryMirror = options?.mirror || createMemoryMirror();
  const useFirestore = () => !options?.disableFirestoreWrites && persistenceState.mode === 'firestore';

  const verifyIdToken: TokenVerifier =
    options?.tokenVerifier ||
    (async (idToken: string) => {
      const decoded = await adminAuth.verifyIdToken(idToken);
      return {
        uid: decoded.uid,
        email: decoded.email,
        name: decoded.name || decoded.email?.split('@')[0] || 'Student'
      };
    });

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
      req.authUser = await verifyIdToken(idToken);
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

  function authenticateSession(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    const sessionTokenHeader = req.headers['x-session-id'];
    const token = typeof sessionTokenHeader === 'string' ? sessionTokenHeader.trim() : '';
    if (!token) {
      return next();
    }
    const session = mirror.sessions[token];
    if (!session) {
      // Allow stateless Cloud Run horizontal scale when Firebase ID token is valid unless explicitly revoked in mirror
      return next();
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
  app.use(
    cors({
      origin: (origin, callback) => {
        if (isOriginAllowed(origin)) {
          callback(null, true);
        } else {
          callback(new Error('Not allowed by CORS'));
        }
      },
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Session-Id'],
      credentials: true
    })
  );
  app.use(express.json({ limit: '5mb' }));

  // ---------------------------------------------------------
  // HEALTH & PUBLIC CONFIGURATION ENDPOINTS
  // ---------------------------------------------------------
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'Sanad Prep BD Subscription & Examination Engine',
      persistenceMode: useFirestore() ? 'firestore' : 'memory-fallback',
      questionBankCount: mirror.questions.length,
      examCount: mirror.exams.length,
      serverTime: new Date().toISOString(),
      timezone: mirror.examDateConfig.timezone
    });
  });

  app.get('/api/packages', async (_req, res) => {
    let packagesList = mirror.packages;
    if (useFirestore()) {
      try {
        const snap = await adminDb.collection('packages').get();
        if (!snap.empty) {
          packagesList = snap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<SubscriptionPackage, 'id'>) }));
        }
      } catch {
        // use mirror
      }
    }
    const active = packagesList.filter(p => p.isActive && !p.isArchived);
    const mapped = active.map(p =>
      p.id === 'pkg_exam_pass' ? { ...p, price: mirror.examDateConfig.examPassPrice } : p
    );
    res.json({ packages: mapped });
  });

  app.get('/api/exam-config', (_req, res) => {
    res.json({ examDateConfig: mirror.examDateConfig });
  });

  app.get('/api/payment-settings', (_req, res) => {
    res.json({
      paymentSettings: mirror.paymentSettings,
      supportSettings: mirror.supportSettings
    });
  });

  app.get('/api/support-settings', (_req, res) => {
    res.json({ supportSettings: mirror.supportSettings });
  });

  app.get('/api/subjects', (_req, res) => {
    res.json({ subjects: mirror.subjects });
  });

  app.get('/api/exams', async (_req, res) => {
    let examList = mirror.exams;
    if (useFirestore()) {
      try {
        const snap = await adminDb.collection('exams').get();
        if (!snap.empty) {
          examList = snap.docs.map(d => {
            const data = d.data() as Omit<Exam, 'id'>;
            return {
              id: d.id,
              ...data,
              isActive: data.isActive !== undefined ? data.isActive : (!data.isPaid || d.id === 'exam_model_test_01'),
              scheduledDate: data.scheduledDate || undefined
            };
          });
        }
      } catch {
        // use mirror
      }
    }
    // Preserve full exam catalog metadata (without exposing answer keys)
    res.json({ exams: examList });
  });

  app.get('/api/leaderboard', async (req, res) => {
    const examId = typeof req.query.examId === 'string' ? req.query.examId : undefined;
    let entries = [...mirror.leaderboard];
    if (useFirestore()) {
      try {
        const qRef =
          examId && examId !== 'all'
            ? adminDb.collection('leaderboard').where('examId', '==', examId).limit(50)
            : adminDb.collection('leaderboard').limit(50);
        const snap = await qRef.get();
        if (!snap.empty) {
          entries = snap.docs.map(d => d.data() as LeaderboardEntry);
        }
      } catch {
        // fallback to mirror
      }
    }
    if (examId && examId !== 'all') {
      entries = entries.filter(e => e.examId === examId);
    }
    entries.sort((a, b) => b.score - a.score || a.timeSpentSeconds - b.timeSpentSeconds);
    res.json({ leaderboard: entries.map((e, i) => ({ ...e, rank: i + 1 })) });
  });

  // ---------------------------------------------------------
  // SANITIZED QUESTIONS & PRACTICE VERIFICATION
  // (NEVER exposes correctOptionIndex or explanations pre-submission!)
  // ---------------------------------------------------------
  app.get('/api/questions', requireFirebaseAuth, async (req: AuthenticatedRequest, res) => {
    const subjectId = typeof req.query.subjectId === 'string' ? req.query.subjectId : undefined;
    const examId = typeof req.query.examId === 'string' ? req.query.examId : undefined;
    const uid = req.authUser!.uid;
    const isOwner = isOwnerUser(req.authUser);

    const allQuestions = await getAllQuestionsAuthoritative(mirror);
    let list = allQuestions;

    if (subjectId) {
      list = list.filter(q => q.subjectId === subjectId);
    }
    if (examId) {
      const targetExam = await getAuthoritativeExam(examId, mirror);
      if (targetExam) {
        if (targetExam.isPaid && !isOwner) {
          const subCheck = await checkUserHasActiveSubscription(uid, mirror);
          if (!subCheck.active) {
            return res.status(403).json({
              error: 'SUBSCRIPTION_REQUIRED',
              message: 'Pro subscription required to access paid exam questions.'
            });
          }
        }
        list = getQuestionsForExam(targetExam, list) as ServerQuestion[];
      }
    }

    // ALWAYS sanitize stems/options for student consumption (answer keys locked on server)
    return res.json({ questions: list.map(sanitizeQuestionForClient) });
  });

  app.post('/api/practice/check', requireFirebaseAuth, authenticateSession, async (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const isOwner = isOwnerUser(req.authUser);
    const { questionId, selectedOption } = req.body || {};

    if (!questionId || typeof selectedOption !== 'number') {
      return res.status(400).json({ error: 'INVALID_REQUEST', message: 'questionId and selectedOption required.' });
    }

    const qMap = await getAuthoritativeQuestionMap([String(questionId)], mirror);
    const q = qMap.get(String(questionId));
    if (!q) {
      return res.status(404).json({ error: 'QUESTION_NOT_FOUND', message: 'Question not found.' });
    }

    if (!q.isDemoSample && !isOwner) {
      const subCheck = await checkUserHasActiveSubscription(uid, mirror);
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
  });

  // ---------------------------------------------------------
  // PREVIOUS YEAR QUESTIONS (Sanitized catalog + On-demand check/grade)
  // ---------------------------------------------------------
  app.get('/api/previous-questions', async (_req, res) => {
    let list = mirror.previousQuestions;
    if (useFirestore()) {
      try {
        const snap = await adminDb.collection('previous_questions').get();
        if (!snap.empty) {
          list = snap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<ServerPreviousQuestion, 'id'>) }));
        }
      } catch {
        // fallback to mirror
      }
    }
    const sorted = [...list].sort((a, b) => b.year - a.year);
    res.json({ previousQuestions: sorted.map(sanitizePreviousQuestionForClient) });
  });

  app.post('/api/previous-questions/check', async (req, res) => {
    const { questionId, selectedAnswer } = req.body || {};
    if (!questionId) {
      return res.status(400).json({ error: 'INVALID_REQUEST', message: 'questionId required.' });
    }

    let pq = mirror.previousQuestions.find(item => item.id === questionId);
    if (useFirestore()) {
      try {
        const [qSnap, kSnap] = await Promise.all([
          adminDb.collection('previous_questions').doc(String(questionId)).get(),
          adminDb.collection('previousQuestionKeys').doc(String(questionId)).get()
        ]);
        if (qSnap.exists) {
          const base = qSnap.data() as Omit<ServerPreviousQuestion, 'id'>;
          const key = kSnap.exists ? (kSnap.data() as { correctAnswer?: string; explanation?: string }) : {};
          pq = {
            id: qSnap.id,
            ...base,
            correctAnswer: key.correctAnswer ?? base.correctAnswer ?? pq?.correctAnswer ?? '',
            explanation: key.explanation ?? base.explanation ?? pq?.explanation ?? ''
          };
        }
      } catch {
        // use mirror
      }
    }

    if (!pq) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Previous question not found.' });
    }

    const cleanSelected = typeof selectedAnswer === 'string' ? selectedAnswer.trim() : '';
    const cleanCorrect = (pq.correctAnswer || '').trim();
    const isCorrect = Boolean(cleanSelected && cleanCorrect && cleanSelected === cleanCorrect);

    return res.json({
      success: true,
      questionId: pq.id,
      isCorrect,
      correctAnswer: pq.correctAnswer,
      explanation: pq.explanation,
      legalSection: pq.legalSection || '',
      source: pq.source || ''
    });
  });

  app.post('/api/previous-questions/grade', async (req, res) => {
    const { questionIds, answers } = req.body || {};
    if (!Array.isArray(questionIds) || questionIds.length === 0) {
      return res.status(400).json({ error: 'INVALID_REQUEST', message: 'questionIds array required.' });
    }

    const answerMap: Record<string, string> = answers && typeof answers === 'object' ? answers : {};
    const pqMap = new Map(mirror.previousQuestions.map(q => [q.id, q]));

    if (useFirestore()) {
      try {
        const [qSnap, kSnap] = await Promise.all([
          adminDb.collection('previous_questions').get(),
          adminDb.collection('previousQuestionKeys').get()
        ]);
        if (!qSnap.empty) {
          const kMap = new Map(kSnap.docs.map(d => [d.id, d.data()]));
          qSnap.forEach(d => {
            const base = d.data() as Partial<ServerPreviousQuestion>;
            const key = kMap.get(d.id) as { correctAnswer?: string; explanation?: string } | undefined;
            const fb = pqMap.get(d.id);
            pqMap.set(d.id, {
              ...(base as ServerPreviousQuestion),
              id: d.id,
              correctAnswer: key?.correctAnswer ?? base.correctAnswer ?? fb?.correctAnswer ?? '',
              explanation: key?.explanation ?? base.explanation ?? fb?.explanation ?? ''
            });
          });
        }
      } catch {
        // fallback to mirror
      }
    }

    let correctCount = 0;
    let incorrectCount = 0;
    let evaluatedTotal = 0;
    const incorrectList: { question: ServerPreviousQuestion; selectedAnswer?: string }[] = [];

    for (const qId of questionIds) {
      const q = pqMap.get(String(qId));
      if (!q) continue;
      evaluatedTotal++;
      const chosen = answerMap[q.id];
      if (!chosen) {
        // unanswered
      } else if (chosen.trim() === (q.correctAnswer || '').trim()) {
        correctCount++;
      } else {
        incorrectCount++;
        incorrectList.push({ question: q, selectedAnswer: chosen });
      }
    }

    const unansweredCount = Math.max(0, evaluatedTotal - (correctCount + incorrectCount));
    const positiveMarks = correctCount * 1.0;
    const negativeMarks = incorrectCount * 0.25;
    const finalScore = Math.max(0, positiveMarks - negativeMarks);
    const percentage = evaluatedTotal > 0 ? (finalScore / evaluatedTotal) * 100 : 0;

    return res.json({
      success: true,
      evaluation: {
        totalQuestions: evaluatedTotal,
        correctCount,
        incorrectCount,
        unansweredCount,
        positiveMarks,
        negativeMarks,
        finalScore: Number(finalScore.toFixed(2)),
        percentage: Number(percentage.toFixed(1)),
        isPassed: percentage >= 50,
        incorrectList
      }
    });
  });

  // ---------------------------------------------------------
  // SESSION & SUBSCRIPTION STATUS
  // ---------------------------------------------------------
  app.post('/api/auth/session', requireFirebaseAuth, async (req: AuthenticatedRequest, res) => {
    const userId = req.authUser!.uid;
    const userEmail = req.authUser!.email || '';
    const userName = req.body?.userName || req.authUser!.name || 'Student';
    const deviceInfo = req.body?.deviceInfo;

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
        timestamp: new Date().toISOString()
      });
    }

    const sessionId = `sess_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const newSession: StudentSession = {
      sessionId,
      userId,
      userEmail,
      userName,
      deviceInfo: deviceInfo || req.headers['user-agent'] || 'Web Browser',
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status: 'active'
    };

    mirror.sessions[sessionId] = newSession;
    mirror.userActiveSessions[userId] = sessionId;

    const subStatus = await checkUserHasActiveSubscription(userId, mirror);
    res.json({
      success: true,
      sessionId,
      session: newSession,
      activeSubscription: subStatus.activeSubscription
    });
  });

  app.get('/api/auth/session/status', requireFirebaseAuth, authenticateSession, async (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const subStatus = await checkUserHasActiveSubscription(uid, mirror);
    res.json({
      active: true,
      session: req.session || null,
      activeSubscription: subStatus.activeSubscription
    });
  });

  // ---------------------------------------------------------
  // PAYMENT SUBMISSION (Priority 1 Hardened)
  // ---------------------------------------------------------
  app.post('/api/payments/create', requireFirebaseAuth, authenticateSession, async (req: AuthenticatedRequest, res) => {
    const uid = req.authUser!.uid;
    const { method, senderNumber, transactionId, packageId, studentPhone, studentName } = req.body || {};

    if (!method || !senderNumber || !transactionId || !packageId) {
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

    // 1. Authoritative package pricing from trusted backend (NEVER trusts client amount)
    let pkg = mirror.packages.find(p => p.id === packageId && p.isActive);
    if (!pkg && useFirestore()) {
      try {
        const pkgSnap = await adminDb.collection('packages').doc(String(packageId)).get();
        if (pkgSnap.exists) {
          const data = pkgSnap.data() as Omit<SubscriptionPackage, 'id'>;
          if (data.isActive) pkg = { id: pkgSnap.id, ...data };
        }
      } catch {
        // fallback handled below
      }
    }
    if (!pkg) {
      return res.status(404).json({
        error: 'PACKAGE_NOT_FOUND',
        message: 'নির্বাচিত সাবস্ক্রিপশন প্যাকেজটি পাওয়া যায়নি বা নিষ্ক্রিয় রয়েছে।'
      });
    }

    const authoritativeAmount =
      pkg.id === 'pkg_exam_pass' ? mirror.examDateConfig.examPassPrice : pkg.price;
    const durationDays = pkg.durationDays || 90;
    const validityType = pkg.validityType || 'days';

    // 2. Check duplicate TrxID across ALL payment requests & statuses (including REJECTED!)
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

    const newReq: PaymentRequest = {
      id: docId,
      userId: uid,
      studentName: String(studentName || req.authUser!.name || 'Student').trim().slice(0, 100),
      studentPhone: String(studentPhone || senderNumber).trim().slice(0, 20),
      method: method as 'bKash' | 'Nagad' | 'Rocket',
      senderNumber: String(senderNumber).trim().slice(0, 20),
      transactionId: cleanTrxId,
      amount: authoritativeAmount,
      packageId: pkg.id,
      packageNameBn: pkg.nameBn,
      packageNameEn: pkg.nameEn,
      packageTitle: `${pkg.nameBn} - ৳${authoritativeAmount}`,
      durationDays,
      validityType,
      status: 'pending',
      requestedAt: new Date().toISOString()
    };

    // 3. Persist atomically to Firestore BEFORE confirming success
    if (useFirestore()) {
      try {
        await adminDb.collection('paymentRequests').doc(docId).create({
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
      } catch (err: unknown) {
        if (isAlreadyExistsError(err)) {
          return res.status(409).json({
            error: 'ALREADY_EXISTS',
            message: 'এই ট্রানজাকশন আইডিটি (TrxID) ইতিপূর্বে সিস্টেমে নিবন্ধিত হয়েছে। পুনরায় জমা দেওয়া সম্ভব নয়।'
          });
        }
        if (isPermissionOrCredentialError(err)) {
          return res.status(403).json({
            error: 'PERMISSION_DENIED',
            message: 'ডাটাবেজে পেমেন্ট রিকোয়েস্ট সংরক্ষণ অনুমোদিত হয়নি। অনুগ্রহ করে অ্যাডমিনের সাথে যোগাযোগ করুন।'
          });
        }
        return res.status(500).json({
          error: 'PAYMENT_PERSIST_FAILED',
          message: 'পেমেন্ট রিকোয়েস্ট সংরক্ষণে সমস্যা হয়েছে। অনুগ্রহ করে পুনরায় চেষ্টা করুন।'
        });
      }
    }

    mirror.paymentRequests.unshift(newReq);
    mirror.auditLogs.unshift({
      id: `log_${Date.now()}`,
      userId: newReq.userId,
      userName: newReq.studentName,
      action: 'PAYMENT_SUBMITTED',
      details: `${method} TrxID: ${cleanTrxId} (৳${newReq.amount}) for package "${pkg.nameEn}". Pending manual admin review.`,
      timestamp: new Date().toISOString()
    });

    return res.json({
      success: true,
      message: 'পেমেন্ট রিকোয়েস্ট সফলভাবে জমা হয়েছে। অ্যাডমিন ম্যানুয়ালি যাচাই করার পর এক্সেস চালু হবে।',
      paymentRequest: newReq
    });
  });

  app.get('/api/payments', requireFirebaseAuth, async (req: AuthenticatedRequest, res) => {
    const isOwner = isOwnerUser(req.authUser);
    let list = [...mirror.paymentRequests];
    if (useFirestore()) {
      try {
        const snap = isOwner
          ? await adminDb.collection('paymentRequests').get()
          : await adminDb.collection('paymentRequests').where('userId', '==', req.authUser!.uid).get();
        if (!snap.empty) {
          list = snap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<PaymentRequest, 'id'>) }));
        }
      } catch {
        // fallback to mirror
      }
    }
    if (isOwner) {
      return res.json({ paymentRequests: list });
    }
    return res.json({ paymentRequests: list.filter(p => p.userId === req.authUser!.uid) });
  });

  app.post('/api/admin/payments/:id/approve', requireFirebaseAuth, requireOwnerAdmin, async (req: AuthenticatedRequest, res) => {
    const id = String(req.params.id);
    const { verifierName } = req.body || {};

    let reqItem = mirror.paymentRequests.find(p => p.id === id);
    if (!reqItem && useFirestore()) {
      try {
        const snap = await adminDb.collection('paymentRequests').doc(id).get();
        if (snap.exists) {
          reqItem = { id: snap.id, ...(snap.data() as Omit<PaymentRequest, 'id'>) };
        }
      } catch {
        // ignore
      }
    }

    if (!reqItem) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Payment request not found' });
    }
    if (reqItem.status === 'approved') {
      return res.status(400).json({ error: 'ALREADY_APPROVED', message: 'Payment already approved' });
    }

    const duplicateApproved = mirror.paymentRequests.find(
      p => p.id !== id && p.transactionId === reqItem!.transactionId && p.status === 'approved'
    );
    if (duplicateApproved) {
      return res.status(409).json({
        error: 'TRX_ALREADY_APPROVED',
        message: 'এই TrxID দিয়ে ইতিপূর্বে আরেকটি পেমেন্ট অনুমোদন করা হয়েছে!'
      });
    }

    const pkg = mirror.packages.find(p => p.id === reqItem!.packageId) || {
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

    const verifier = String(verifierName || req.authUser!.email || 'Owner Admin');

    if (useFirestore()) {
      try {
        const batch = adminDb.batch();
        const payRef = adminDb.collection('paymentRequests').doc(id);
        const subRef = adminDb.collection('subscriptions').doc(newSubscription.id);
        const userRef = adminDb.collection('users').doc(reqItem.userId);

        batch.update(payRef, {
          status: 'approved',
          verifiedAt: activatedAt,
          verifiedBy: verifier,
          subscriptionId: newSubscription.id
        });
        batch.set(subRef, {
          userId: newSubscription.userId,
          studentName: newSubscription.studentName,
          studentPhone: newSubscription.studentPhone,
          packageId: newSubscription.packageId,
          packageNameBn: newSubscription.packageNameBn,
          packageNameEn: newSubscription.packageNameEn,
          pricePaid: newSubscription.pricePaid,
          paymentRequestId: newSubscription.paymentRequestId,
          paymentMethod: newSubscription.paymentMethod,
          transactionId: newSubscription.transactionId,
          activatedAt: isoToTimestamp(activatedAt),
          expiresAt: isoToTimestamp(expiresAt),
          validityType: newSubscription.validityType,
          status: 'active',
          targetExamDateSnapshot: newSubscription.targetExamDateSnapshot || null,
          createdAt: activatedAt
        });
        batch.set(
          userRef,
          {
            subscriptionStatus: 'pro',
            subscriptionExpiresAt: isoToTimestamp(expiresAt),
            activePackageId: reqItem.packageId,
            activePackageNameBn: reqItem.packageNameBn,
            activePackageNameEn: reqItem.packageNameEn
          },
          { merge: true }
        );
        await batch.commit();
      } catch (err) {
        return res.status(500).json({
          error: 'APPROVAL_PERSIST_FAILED',
          message: err instanceof Error ? err.message : 'Failed to commit approval to Firestore'
        });
      }
    }

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
      timestamp: new Date().toISOString()
    });

    return res.json({
      success: true,
      paymentRequest: reqItem,
      subscription: newSubscription
    });
  });

  app.post('/api/admin/payments/:id/reject', requireFirebaseAuth, requireOwnerAdmin, async (req: AuthenticatedRequest, res) => {
    const id = String(req.params.id);
    const { reason, verifierName } = req.body || {};

    let reqItem = mirror.paymentRequests.find(p => p.id === id);
    if (!reqItem && useFirestore()) {
      try {
        const snap = await adminDb.collection('paymentRequests').doc(id).get();
        if (snap.exists) {
          reqItem = { id: snap.id, ...(snap.data() as Omit<PaymentRequest, 'id'>) };
        }
      } catch {
        // ignore
      }
    }
    if (!reqItem) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Payment request not found' });
    }

    const verifier = String(verifierName || req.authUser!.email || 'Owner Admin');
    const rejectionReason = String(reason || 'Unverified Transaction ID or Amount Mismatch');
    const verifiedAt = new Date().toISOString();

    if (useFirestore()) {
      try {
        await adminDb.collection('paymentRequests').doc(id).update({
          status: 'rejected',
          rejectionReason,
          verifiedAt,
          verifiedBy: verifier
        });
      } catch (err) {
        return res.status(500).json({
          error: 'REJECTION_PERSIST_FAILED',
          message: err instanceof Error ? err.message : 'Failed to reject payment in Firestore'
        });
      }
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
      timestamp: new Date().toISOString()
    });

    return res.json({
      success: true,
      paymentRequest: reqItem
    });
  });

  // ---------------------------------------------------------
  // ADMIN PACKAGES, CONFIG, SETTINGS & USER MANAGEMENT
  // ---------------------------------------------------------
  app.get('/api/admin/packages', requireFirebaseAuth, requireOwnerAdmin, (_req, res) => {
    res.json({ packages: mirror.packages, examDateConfig: mirror.examDateConfig });
  });

  app.post('/api/admin/packages/update', requireFirebaseAuth, requireOwnerAdmin, async (req: AuthenticatedRequest, res) => {
    const { id, price, durationDays, isActive } = req.body || {};
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

    if (useFirestore()) {
      await adminDb.collection('packages').doc(pkg.id).set(pkg, { merge: true }).catch(() => {});
    }

    mirror.auditLogs.unshift({
      id: `log_${Date.now()}`,
      userId: req.authUser!.uid,
      userName: req.authUser!.email || 'Owner Admin',
      action: 'UPDATE_PACKAGE',
      details: `Updated package ${pkg.nameEn}: Price=${pkg.price}, Duration=${pkg.durationDays}d, Active=${pkg.isActive}`,
      timestamp: new Date().toISOString()
    });

    res.json({ success: true, package: pkg });
  });

  app.post('/api/admin/exam-config', requireFirebaseAuth, requireOwnerAdmin, async (req: AuthenticatedRequest, res) => {
    const { targetExamDate, examDatePolicy, examPassPrice, examTitleBn, examTitleEn } = req.body || {};
    if (targetExamDate) mirror.examDateConfig.targetExamDate = targetExamDate;
    if (examDatePolicy) mirror.examDateConfig.examDatePolicy = examDatePolicy;
    if (examPassPrice !== undefined) {
      mirror.examDateConfig.examPassPrice = Number(examPassPrice);
      const epPkg = mirror.packages.find(p => p.id === 'pkg_exam_pass');
      if (epPkg) epPkg.price = Number(examPassPrice);
    }
    if (examTitleBn) mirror.examDateConfig.examTitleBn = examTitleBn;
    if (examTitleEn) mirror.examDateConfig.examTitleEn = examTitleEn;
    mirror.examDateConfig.lastUpdated = new Date().toISOString();

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

    if (useFirestore()) {
      await adminDb.collection('config').doc('examDate').set(mirror.examDateConfig, { merge: true }).catch(() => {});
    }

    res.json({
      success: true,
      examDateConfig: mirror.examDateConfig,
      affectedSubscribers
    });
  });

  app.post('/api/admin/payment-settings', requireFirebaseAuth, requireOwnerAdmin, (req: AuthenticatedRequest, res) => {
    const { bkashNumber, nagadNumber, whatsappNumber, whatsappMessage } = req.body || {};
    if (bkashNumber) mirror.paymentSettings.bkashNumber = String(bkashNumber).trim();
    if (nagadNumber) mirror.paymentSettings.nagadNumber = String(nagadNumber).trim();
    if (whatsappNumber) {
      mirror.paymentSettings.whatsappNumber = String(whatsappNumber).trim();
      mirror.supportSettings.whatsappNumber = String(whatsappNumber).trim();
    }
    if (whatsappMessage) {
      mirror.paymentSettings.whatsappMessage = String(whatsappMessage).trim();
      mirror.supportSettings.whatsappMessage = String(whatsappMessage).trim();
    }
    res.json({
      success: true,
      paymentSettings: mirror.paymentSettings,
      supportSettings: mirror.supportSettings
    });
  });

  app.post('/api/admin/support-settings', requireFirebaseAuth, requireOwnerAdmin, (req: AuthenticatedRequest, res) => {
    const { whatsappNumber, whatsappMessage } = req.body || {};
    if (whatsappNumber) {
      mirror.supportSettings.whatsappNumber = String(whatsappNumber).trim();
      mirror.paymentSettings.whatsappNumber = String(whatsappNumber).trim();
    }
    if (whatsappMessage) {
      mirror.supportSettings.whatsappMessage = String(whatsappMessage).trim();
      mirror.paymentSettings.whatsappMessage = String(whatsappMessage).trim();
    }
    res.json({ success: true, supportSettings: mirror.supportSettings });
  });

  app.post('/api/admin/users/update', requireFirebaseAuth, requireOwnerAdmin, async (req: AuthenticatedRequest, res) => {
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

    if (!userId) {
      return res.status(400).json({ error: 'MISSING_USER_ID', message: 'userId is required' });
    }

    const safeRole: UserRole = role === 'admin' && userId !== OWNER_ADMIN_UID ? 'student' : (role || 'student');
    const cleanExpiresIso = expiresAt ? new Date(expiresAt).toISOString() : undefined;

    if (useFirestore()) {
      await adminDb
        .collection('users')
        .doc(String(userId))
        .set(
          {
            name,
            email,
            phone,
            role: safeRole,
            subscriptionStatus,
            subscriptionExpiresAt: isoToTimestamp(cleanExpiresIso),
            activePackageId: packageId || null,
            activePackageNameBn: packageNameBn || null,
            activePackageNameEn: packageNameEn || null
          },
          { merge: true }
        )
        .catch(() => {});

      if (subscriptionId) {
        await adminDb
          .collection('subscriptions')
          .doc(String(subscriptionId))
          .set(
            {
              studentName: name,
              studentPhone: phone,
              status: subscriptionStatus === 'pro' ? 'active' : subscriptionStatus === 'expired' ? 'expired' : 'cancelled',
              ...(cleanExpiresIso ? { expiresAt: isoToTimestamp(cleanExpiresIso) } : {})
            },
            { merge: true }
          )
          .catch(() => {});
      }
    }

    const existing = mirror.users[userId];
    mirror.users[userId] = {
      ...(existing || { uid: userId, createdAt: new Date().toISOString() }),
      uid: userId,
      name,
      email,
      phone,
      role: safeRole,
      subscriptionStatus,
      subscriptionExpiresAt: cleanExpiresIso,
      activePackageId: packageId,
      activePackageNameBn: packageNameBn,
      activePackageNameEn: packageNameEn
    };

    if (isSessionRevoked) {
      const sessId = mirror.userActiveSessions[userId];
      if (sessId && mirror.sessions[sessId]) {
        mirror.sessions[sessId].status = 'revoked';
        mirror.sessions[sessId].revokedReason = 'Revoked by administrator';
      }
    }

    return res.json({ success: true, user: mirror.users[userId] });
  });

  // ---------------------------------------------------------
  // ADMIN QUESTIONS, PREVIOUS QUESTIONS & EXAMS CRUD
  // (Owner Admin Only - exposes answer keys only here)
  // ---------------------------------------------------------
  app.get('/api/admin/questions', requireFirebaseAuth, requireOwnerAdmin, async (_req, res) => {
    const list = await getAllQuestionsAuthoritative(mirror);
    res.json({ questions: list });
  });

  app.post('/api/admin/questions', requireFirebaseAuth, requireOwnerAdmin, async (req: AuthenticatedRequest, res) => {
    const q = req.body as ServerQuestion;
    if (!q || !q.questionBn || !Array.isArray(q.optionsBn)) {
      return res.status(400).json({ error: 'INVALID_QUESTION' });
    }
    const now = new Date().toISOString();
    const fullQ: ServerQuestion = {
      ...q,
      id: q.id || `q_custom_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      createdAt: q.createdAt || now,
      updatedAt: now
    };
    if (useFirestore()) {
      const batch = adminDb.batch();
      batch.set(adminDb.collection('questions').doc(fullQ.id), sanitizeQuestionForClient(fullQ));
      batch.set(adminDb.collection('questionKeys').doc(fullQ.id), {
        correctOptionIndex: fullQ.correctOptionIndex,
        explanationBn: fullQ.explanationBn || '',
        explanationEn: fullQ.explanationEn || '',
        legalReference: fullQ.legalReference || '',
        updatedAt: now
      });
      await batch.commit().catch(() => {});
    }
    mirror.questions.unshift(fullQ);
    res.json({ success: true, question: fullQ });
  });

  app.delete('/api/admin/questions/:id', requireFirebaseAuth, requireOwnerAdmin, async (req, res) => {
    const id = String(req.params.id);
    if (useFirestore()) {
      const batch = adminDb.batch();
      batch.delete(adminDb.collection('questions').doc(id));
      batch.delete(adminDb.collection('questionKeys').doc(id));
      await batch.commit().catch(() => {});
    }
    mirror.questions = mirror.questions.filter(q => q.id !== id);
    res.json({ success: true });
  });

  app.get('/api/admin/previous-questions', requireFirebaseAuth, requireOwnerAdmin, async (_req, res) => {
    res.json({ previousQuestions: mirror.previousQuestions });
  });

  app.post('/api/admin/previous-questions', requireFirebaseAuth, requireOwnerAdmin, async (req, res) => {
    const pq = req.body as ServerPreviousQuestion;
    if (!pq || !pq.question) {
      return res.status(400).json({ error: 'INVALID_PREVIOUS_QUESTION' });
    }
    const id = pq.id || `pq_${pq.year}_${Date.now()}`;
    const fullPq: ServerPreviousQuestion = { ...pq, id };
    if (useFirestore()) {
      const batch = adminDb.batch();
      batch.set(adminDb.collection('previous_questions').doc(id), sanitizePreviousQuestionForClient(fullPq));
      batch.set(adminDb.collection('previousQuestionKeys').doc(id), {
        correctAnswer: fullPq.correctAnswer || '',
        explanation: fullPq.explanation || '',
        updatedAt: new Date().toISOString()
      });
      await batch.commit().catch(() => {});
    }
    const idx = mirror.previousQuestions.findIndex(x => x.id === id);
    if (idx >= 0) mirror.previousQuestions[idx] = fullPq;
    else mirror.previousQuestions.unshift(fullPq);
    res.json({ success: true, previousQuestion: fullPq });
  });

  app.post('/api/admin/exams/save', requireFirebaseAuth, requireOwnerAdmin, async (req, res) => {
    const exam = req.body as Exam;
    if (!exam || !exam.id) {
      return res.status(400).json({ error: 'INVALID_EXAM' });
    }
    const normalized: Exam = {
      ...exam,
      isActive: exam.isActive !== undefined ? exam.isActive : !exam.isPaid,
      scheduledDate: exam.scheduledDate || undefined
    };
    if (useFirestore()) {
      await adminDb
        .collection('exams')
        .doc(normalized.id)
        .set({ ...normalized, scheduledDate: normalized.scheduledDate ?? null }, { merge: true })
        .catch(() => {});
    }
    const idx = mirror.exams.findIndex(e => e.id === normalized.id);
    if (idx >= 0) mirror.exams[idx] = normalized;
    else mirror.exams.unshift(normalized);
    res.json({ success: true, exam: normalized });
  });

  app.post('/api/admin/migrate-timestamps', requireFirebaseAuth, requireOwnerAdmin, async (_req, res) => {
    if (!useFirestore()) {
      return res.json({
        success: false,
        persistenceMode: persistenceState.mode,
        message: 'Firestore Admin IAM is not attached in this environment. Use migration script with service account or Cloud Run.'
      });
    }
    const summary = await migrateAllSubscriptionTimestampsAdmin();
    return res.json({ success: true, ...summary });
  });

  app.post('/api/admin/import-questions-to-firestore', requireFirebaseAuth, requireOwnerAdmin, async (_req, res) => {
    if (!useFirestore()) {
      return res.json({
        success: false,
        persistenceMode: persistenceState.mode,
        message: 'Firestore Admin IAM is not attached in this environment. Use import script with service account or Cloud Run.'
      });
    }
    const summary = await importMissingDataToFirestoreAdmin(mirror);
    return res.json({ success: true, ...summary });
  });

  // ---------------------------------------------------------
  // SUBSCRIPTIONS & ADMIN STATS
  // ---------------------------------------------------------
  app.get('/api/admin/subscriptions', requireFirebaseAuth, requireOwnerAdmin, (_req, res) => {
    const now = Date.now();
    const mapped = mirror.subscriptions.map(s => {
      const isExpired = new Date(s.expiresAt).getTime() <= now;
      const daysRemaining = Math.max(0, Math.ceil((new Date(s.expiresAt).getTime() - now) / (1000 * 60 * 60 * 24)));
      return {
        ...s,
        status: isExpired ? 'expired' : s.status,
        daysRemaining
      };
    });
    res.json({ subscriptions: mapped });
  });

  app.get('/api/subscriptions/active/:userId', requireFirebaseAuth, async (req: AuthenticatedRequest, res) => {
    const { userId } = req.params;
    if (userId !== req.authUser!.uid && !isOwnerUser(req.authUser)) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Cannot access another user subscription.' });
    }
    const subStatus = await checkUserHasActiveSubscription(String(userId), mirror);
    if (!subStatus.active || !subStatus.activeSubscription) {
      return res.json({
        hasActiveSubscription: false,
        status: 'free',
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
  });

  app.get('/api/admin/dashboard-stats', requireFirebaseAuth, requireOwnerAdmin, (_req, res) => {
    const now = Date.now();
    const studentUserIds = new Set<string>();
    mirror.paymentRequests.forEach(p => { if (p.userId) studentUserIds.add(p.userId); });
    mirror.subscriptions.forEach(s => { if (s.userId) studentUserIds.add(s.userId); });
    mirror.examResults.forEach(r => { if (r.userId) studentUserIds.add(r.userId); });
    const totalStudents = Math.max(studentUserIds.size, 1);

    const activeSubscribers = mirror.subscriptions.filter(
      s => s.status === 'active' && new Date(s.expiresAt).getTime() > now
    ).length;

    const pendingPayments = mirror.paymentRequests.filter(p => p.status === 'pending').length;
    const approvedPayments = mirror.paymentRequests.filter(p => p.status === 'approved').length;
    const rejectedPayments = mirror.paymentRequests.filter(p => p.status === 'rejected').length;

    const expiredSubscriptions = mirror.subscriptions.filter(
      s => s.status === 'expired' || new Date(s.expiresAt).getTime() <= now
    ).length;

    const totalVerifiedRevenue = mirror.paymentRequests
      .filter(p => p.status === 'approved')
      .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);

    res.json({
      totalStudents,
      activeSubscribers,
      pendingPayments,
      approvedPayments,
      rejectedPayments,
      expiredSubscriptions,
      totalVerifiedRevenue,
      monthlyRevenueReport: []
    });
  });

  app.get('/api/admin/audit-logs', requireFirebaseAuth, requireOwnerAdmin, (_req, res) => {
    res.json({ auditLogs: mirror.auditLogs });
  });

  // ---------------------------------------------------------
  // SERVER-SIDE EXAMINATION ENGINE (Priority 3 & 4 Hardened)
  // ---------------------------------------------------------
  app.post('/api/exams/start', requireFirebaseAuth, authenticateSession, async (req: AuthenticatedRequest, res) => {
    const session = req.session;
    const { examId, studentName } = req.body || {};
    const targetUserId = req.authUser!.uid;
    const isOwner = isOwnerUser(req.authUser);

    if (!examId || typeof examId !== 'string') {
      return res.status(400).json({ error: 'INVALID_EXAM_ID', message: 'Valid examId is required.' });
    }

    const exam = await getAuthoritativeExam(examId, mirror);
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
      const subCheck = await checkUserHasActiveSubscription(targetUserId, mirror);
      if (!subCheck.active) {
        return res.status(403).json({
          error: 'SUBSCRIPTION_REQUIRED',
          message: 'এই ৬০ মিনিটের স্পেশাল মডেল টেস্টটি আনলক করতে সক্রিয় প্রো সাবস্ক্রিপশন প্রয়োজন।'
        });
      }
    }

    const allQuestions = await getAllQuestionsAuthoritative(mirror);
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

    if (useFirestore()) {
      await adminDb
        .collection('examAttempts')
        .doc(attempt.id)
        .set({ ...attempt, resolvedQuestionIds })
        .catch(() => {});
    }

    mirror.examAttempts[attempt.id] = attempt;

    // Sanitized questions returned (NO correctOptionIndex, NO explanationBn/En!)
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
  });

  app.post('/api/exams/save-answer', requireFirebaseAuth, authenticateSession, async (req: AuthenticatedRequest, res) => {
    const { attemptId, answers, flaggedQuestionIds, currentQuestionIndex } = req.body || {};
    if (!attemptId) {
      return res.status(400).json({ error: 'INVALID_REQUEST' });
    }
    const attempt = mirror.examAttempts[String(attemptId)];
    if (!attempt) {
      return res.status(404).json({ error: 'ATTEMPT_NOT_FOUND' });
    }
    if (attempt.userId !== req.authUser!.uid) {
      return res.status(403).json({ error: 'FORBIDDEN' });
    }
    if (attempt.status !== 'in_progress') {
      return res.status(400).json({ error: 'ALREADY_SUBMITTED' });
    }

    if (answers && typeof answers === 'object') {
      const cleaned: Record<string, number> = {};
      for (const [k, v] of Object.entries(answers)) {
        if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 3) {
          cleaned[k] = v;
        }
      }
      attempt.answers = cleaned;
    }
    if (Array.isArray(flaggedQuestionIds)) {
      attempt.flaggedQuestionIds = flaggedQuestionIds.map(String);
    }
    if (typeof currentQuestionIndex === 'number') {
      attempt.currentQuestionIndex = currentQuestionIndex;
    }
    attempt.lastSavedAt = new Date().toISOString();

    if (useFirestore()) {
      await adminDb
        .collection('examAttempts')
        .doc(attempt.id)
        .update({
          answers: attempt.answers,
          flaggedQuestionIds: attempt.flaggedQuestionIds,
          currentQuestionIndex: attempt.currentQuestionIndex,
          lastSavedAt: attempt.lastSavedAt
        })
        .catch(() => {});
    }

    return res.json({ success: true });
  });

  // Authoritative server-side scoring (+1 correct, -0.25 incorrect, 0 unanswered)
  app.post('/api/exams/submit', requireFirebaseAuth, authenticateSession, async (req: AuthenticatedRequest, res) => {
    const { attemptId, answers, isAutoTimeout } = req.body || {};
    const uid = req.authUser!.uid;

    if (!attemptId || typeof attemptId !== 'string') {
      return res.status(400).json({ error: 'INVALID_ATTEMPT_ID', message: 'Valid attemptId is required.' });
    }

    let attempt: ExamAttempt | undefined = mirror.examAttempts[attemptId];
    let resolvedQuestionIdsFromDoc: string[] | undefined;

    if (!attempt && useFirestore()) {
      try {
        const snap = await adminDb.collection('examAttempts').doc(attemptId).get();
        if (snap.exists) {
          const raw = snap.data() as ExamAttempt & { resolvedQuestionIds?: string[] };
          resolvedQuestionIdsFromDoc = raw.resolvedQuestionIds;
          attempt = { ...raw, id: snap.id };
          mirror.examAttempts[attemptId] = attempt;
        }
      } catch {
        // ignore
      }
    }

    if (!attempt) {
      return res.status(404).json({ error: 'ATTEMPT_NOT_FOUND', message: 'Exam attempt not found.' });
    }

    // Strict token UID validation (ignores any client-submitted userId)
    if (attempt.userId !== uid) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Cannot submit another user exam attempt.' });
    }

    // Prevent duplicate submissions for an already completed attempt
    if (attempt.status !== 'in_progress') {
      return res.status(400).json({ error: 'ALREADY_SUBMITTED', message: 'Attempt has already been submitted.' });
    }

    const exam = await getAuthoritativeExam(attempt.examId, mirror);
    if (!exam) {
      return res.status(404).json({ error: 'EXAM_NOT_FOUND', message: 'Exam not found.' });
    }

    // Re-resolve authoritative questions & answer keys from server storage
    const allQuestions = await getAllQuestionsAuthoritative(mirror);
    const examMetaWithIds =
      resolvedQuestionIdsFromDoc && resolvedQuestionIdsFromDoc.length > 0
        ? { ...exam, questionIds: resolvedQuestionIdsFromDoc }
        : exam;
    const examQuestions = getQuestionsForExam(examMetaWithIds, allQuestions) as ServerQuestion[];
    const authQMap = await getAuthoritativeQuestionMap(
      examQuestions.map(q => q.id),
      mirror
    );
    const authoritativeQuestions: ServerQuestion[] = examQuestions.map(q => authQMap.get(q.id) || q);
    const validQIdSet = new Set(authoritativeQuestions.map(q => q.id));

    // Validate submitted answer map: only valid question IDs belonging to this exam and valid 0..3 option index
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

    const startTimeMs = new Date(attempt.startTime).getTime();
    const deadlineMs = new Date(attempt.deadlineTime).getTime();
    const submissionTimeMs = Math.min(Date.now(), isNaN(deadlineMs) ? Date.now() : deadlineMs + 15000);
    const timeSpentSeconds = Math.max(1, Math.round((submissionTimeMs - startTimeMs) / 1000));

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

    const submittedAt = new Date().toISOString();
    const nextAttemptStatus: ExamAttempt['status'] = isAutoTimeout ? 'timed_out' : 'submitted';

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
      questions: authoritativeQuestions // Full solution revealed ONLY after submission
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

    if (useFirestore()) {
      try {
        const batch = adminDb.batch();
        const attemptRef = adminDb.collection('examAttempts').doc(attempt.id);
        const resultRef = adminDb.collection('examResults').doc(newResult.id);
        const leadRef = adminDb.collection('leaderboard').doc(leaderboardEntry.id);

        batch.update(attemptRef, {
          status: nextAttemptStatus,
          submittedTime: submittedAt,
          answers: sanitizedAnswers
        });
        const { questions: _q, ...firestoreResultPayload } = newResult;
        batch.set(resultRef, { ...firestoreResultPayload, score: newResult.finalScore });
        batch.set(leadRef, leaderboardEntry, { merge: true });
        await batch.commit();
      } catch (err) {
        if (!isPermissionOrCredentialError(err)) {
          return res.status(500).json({ error: 'SUBMIT_PERSIST_FAILED', message: 'Failed to persist exam result.' });
        }
      }
    }

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
      action: isAutoTimeout ? 'EXAM_TIMED_OUT' : 'SUBMIT_EXAM',
      details: `Server graded "${exam.titleEn}": ${newResult.finalScore}/${newResult.totalQuestions} (${newResult.percentage}%)`,
      timestamp: submittedAt
    });

    return res.json({
      success: true,
      result: newResult,
      leaderboardEntry
    });
  });

  app.get('/api/exams/results/:userId?', requireFirebaseAuth, async (req: AuthenticatedRequest, res) => {
    const requestedUid = req.params.userId ? String(req.params.userId) : req.authUser!.uid;
    const isOwner = isOwnerUser(req.authUser);
    if (requestedUid !== req.authUser!.uid && !isOwner) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Cannot read another user exam results.' });
    }

    let list = mirror.examResults.filter(r => r.userId === requestedUid);
    if (useFirestore()) {
      try {
        const snap = await adminDb.collection('examResults').where('userId', '==', requestedUid).get();
        if (!snap.empty) {
          list = snap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<ExamResult, 'id'>) }));
        }
      } catch {
        // fallback to mirror
      }
    }
    return res.json({ results: list });
  });

  return { app, mirror };
}

async function startServer() {
  await probeFirestoreAdminConnectivity();
  const { app, mirror } = createSanadPrepApp();

  const distDir = path.resolve(__dirname, 'dist');
  const distIndex = path.resolve(distDir, 'index.html');
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction && fs.existsSync(distIndex)) {
    app.use(express.static(distDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) {
        return next();
      }
      res.sendFile(distIndex);
    });
  } else {
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
      try {
        const indexPath = path.resolve(__dirname, 'index.html');
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
  const PORT = cliPort || (isProduction && process.env.PORT ? Number(process.env.PORT) : 3000);

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
