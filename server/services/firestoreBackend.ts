import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeApp as initializeAdminApp, getApps as getAdminApps, cert, App } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { getFirestore, Firestore, Timestamp } from 'firebase-admin/firestore';
import type {
  ServerQuestion,
  ServerPreviousQuestion,
  Question,
  PreviousQuestion,
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
import { INITIAL_LEADERBOARD_ENTRIES } from '../../src/data/initialLeaderboard.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');

export const OWNER_ADMIN_UID = 'PjBRV7LAQ8cIwOdM3z474A16dWg2';
export const OWNER_ADMIN_EMAIL = 'khayrulalam88@gmail.com';
export const FIREBASE_PROJECT_ID =
  process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID || 'galvanic-aviary-tzp2g';
export const FIREBASE_DATABASE_ID =
  process.env.FIREBASE_DATABASE_ID ||
  process.env.VITE_FIREBASE_DATABASE_ID ||
  'ai-studio-barcouncilmcqpre-9a5aecc8-3819-4aeb-b7e2-c6066b637cab';

function loadServerJson<T>(relativePath: string, fallback: T): T {
  try {
    const fullPath = path.resolve(ROOT_DIR, relativePath);
    if (fs.existsSync(fullPath)) {
      return JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as T;
    }
  } catch (err) {
    console.warn(`Failed to load ${relativePath}:`, err);
  }
  return fallback;
}

export function initFirebaseAdminApp(): App {
  if (getAdminApps().length > 0) {
    return getAdminApps()[0];
  }
  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (saJson && saJson.trim()) {
    try {
      const parsed = JSON.parse(saJson);
      return initializeAdminApp({
        credential: cert(parsed),
        projectId: parsed.project_id || FIREBASE_PROJECT_ID
      });
    } catch (err) {
      console.error('Invalid FIREBASE_SERVICE_ACCOUNT_JSON:', err);
    }
  }
  return initializeAdminApp({ projectId: FIREBASE_PROJECT_ID });
}

export const adminApp = initFirebaseAdminApp();
export const adminAuth = getAdminAuth(adminApp);
export const adminDb: Firestore = FIREBASE_DATABASE_ID
  ? getFirestore(adminApp, FIREBASE_DATABASE_ID)
  : getFirestore(adminApp);

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

export function sanitizePreviousQuestionForClient(pq: ServerPreviousQuestion | PreviousQuestion): PreviousQuestion {
  const {
    correctAnswer: _ca,
    explanation: _exp,
    correctOptionIndex: _co,
    explanationBn: _eb,
    explanationEn: _ee,
    ...sanitized
  } = pq;
  return sanitized;
}

export interface PersistenceState {
  mode: 'firestore' | 'memory-fallback';
  lastCheckedAt: string;
  reason?: string;
}

export const persistenceState: PersistenceState = {
  mode: 'firestore',
  lastCheckedAt: new Date().toISOString()
};

export async function probeFirestoreAdminConnectivity(): Promise<PersistenceState> {
  try {
    await adminDb.collection('config').limit(1).get();
    persistenceState.mode = 'firestore';
    persistenceState.lastCheckedAt = new Date().toISOString();
    delete persistenceState.reason;
  } catch (err: unknown) {
    persistenceState.lastCheckedAt = new Date().toISOString();
    if (isPermissionOrCredentialError(err)) {
      persistenceState.mode = 'memory-fallback';
      persistenceState.reason =
        'Admin SDK runtime identity lacks Firestore IAM permissions in this environment; using server memory store alongside Auth verification.';
      console.warn('[SanadPrep Server]', persistenceState.reason);
    } else {
      persistenceState.mode = 'memory-fallback';
      persistenceState.reason = (err as Error)?.message || String(err);
      console.warn('[SanadPrep Server] Firestore probe error:', persistenceState.reason);
    }
  }
  return persistenceState;
}

// Initial authoritative question & previous question stores loaded ONLY on backend
const FULL_QUESTIONS_RAW = loadServerJson<ServerQuestion[]>('server/data/questionBankFull.json', []);
const FULL_PREVIOUS_RAW = loadServerJson<ServerPreviousQuestion[]>('server/data/previousQuestionsFull.json', []);

export interface MemoryMirror {
  packages: SubscriptionPackage[];
  examDateConfig: ExamDateConfig;
  paymentSettings: {
    bkashNumber: string;
    nagadNumber: string;
    packagePrice: number;
    whatsappNumber: string;
    whatsappMessage: string;
  };
  supportSettings: {
    whatsappNumber: string;
    whatsappMessage: string;
  };
  subjects: Subject[];
  questions: ServerQuestion[];
  previousQuestions: ServerPreviousQuestion[];
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
      whatsappNumber: '+8801671819027',
      whatsappMessage: 'Hello Sanad Prep BD Support, I need help with my account or subscription.'
    },
    supportSettings: {
      whatsappNumber: '+8801671819027',
      whatsappMessage: 'Hello Sanad Prep BD Support, I need help with my account or subscription.'
    },
    subjects: INITIAL_SUBJECTS.map(s => ({ ...s })),
    questions: FULL_QUESTIONS_RAW.map(q => ({ ...q })),
    previousQuestions: FULL_PREVIOUS_RAW.map(pq => ({ ...pq })),
    exams: INITIAL_EXAMS.map(e => ({ ...e })),
    users: {},
    paymentRequests: [],
    subscriptions: [],
    sessions: {},
    userActiveSessions: {},
    examAttempts: {},
    examResults: [],
    leaderboard: INITIAL_LEADERBOARD_ENTRIES.map(l => ({ ...l })),
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

// Authoritative check whether a user currently holds an active non-expired Pro subscription
export async function checkUserHasActiveSubscription(
  uid: string,
  mirror: MemoryMirror
): Promise<{ active: boolean; activeSubscription: UserSubscription | null; reason?: string }> {
  const nowMs = Date.now();

  // 1. Check Firestore directly when Admin Firestore persistence is available
  if (persistenceState.mode === 'firestore') {
    try {
      const userSnap = await adminDb.collection('users').doc(uid).get();
      if (userSnap.exists) {
        const uData = userSnap.data() || {};
        const expiryIso = timestampToIso(uData.subscriptionExpiresAt);
        if (uData.subscriptionStatus === 'pro' && expiryIso && new Date(expiryIso).getTime() > nowMs) {
          const subSnap = await adminDb
            .collection('subscriptions')
            .where('userId', '==', uid)
            .where('status', '==', 'active')
            .limit(5)
            .get();
          let matchedSub: UserSubscription | null = null;
          subSnap.forEach(d => {
            const raw = d.data();
            const subExp = timestampToIso(raw.expiresAt);
            if (!matchedSub && subExp && new Date(subExp).getTime() > nowMs) {
              matchedSub = {
                ...(raw as Omit<UserSubscription, 'id'>),
                id: d.id,
                activatedAt: timestampToIso(raw.activatedAt) || new Date().toISOString(),
                expiresAt: subExp,
                createdAt: timestampToIso(raw.createdAt) || new Date().toISOString()
              };
            }
          });
          return { active: true, activeSubscription: matchedSub };
        }
      }

      const subSnap = await adminDb
        .collection('subscriptions')
        .where('userId', '==', uid)
        .where('status', '==', 'active')
        .get();
      for (const docSnap of subSnap.docs) {
        const raw = docSnap.data();
        const subExp = timestampToIso(raw.expiresAt);
        if (subExp && new Date(subExp).getTime() > nowMs) {
          return {
            active: true,
            activeSubscription: {
              ...(raw as Omit<UserSubscription, 'id'>),
              id: docSnap.id,
              activatedAt: timestampToIso(raw.activatedAt) || new Date().toISOString(),
              expiresAt: subExp,
              createdAt: timestampToIso(raw.createdAt) || new Date().toISOString()
            }
          };
        }
      }
      return { active: false, activeSubscription: null, reason: 'NO_ACTIVE_SUBSCRIPTION' };
    } catch (err) {
      if (!isPermissionOrCredentialError(err)) {
        console.warn('[SubscriptionCheck] Firestore lookup fallback:', err);
      }
    }
  }

  // 2. Fallback to authoritative backend memory store (e.g. sandbox / local tests)
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

export async function getAllQuestionsAuthoritative(mirror: MemoryMirror): Promise<ServerQuestion[]> {
  if (persistenceState.mode === 'firestore') {
    try {
      const [qSnap, keySnap] = await Promise.all([
        adminDb.collection('questions').get(),
        adminDb.collection('questionKeys').get()
      ]);
      if (!qSnap.empty) {
        const keyMap = new Map<string, Record<string, unknown>>();
        keySnap.forEach(d => keyMap.set(d.id, d.data()));
        const fallbackMap = new Map(mirror.questions.map(q => [q.id, q]));
        const list: ServerQuestion[] = [];
        qSnap.forEach(d => {
          const data = d.data() as Partial<ServerQuestion>;
          const key = keyMap.get(d.id) as Partial<ServerQuestion> | undefined;
          const fb = fallbackMap.get(d.id);
          list.push({
            ...(data as ServerQuestion),
            id: d.id,
            correctOptionIndex: key?.correctOptionIndex ?? data.correctOptionIndex ?? fb?.correctOptionIndex ?? 0,
            explanationBn: key?.explanationBn ?? data.explanationBn ?? fb?.explanationBn ?? '',
            explanationEn: key?.explanationEn ?? data.explanationEn ?? fb?.explanationEn ?? ''
          });
        });
        return list;
      }
    } catch (err) {
      if (!isPermissionOrCredentialError(err)) console.warn('Firestore questions fetch error:', err);
    }
  }
  return mirror.questions;
}

export async function getAuthoritativeExam(examId: string, mirror: MemoryMirror): Promise<Exam | null> {
  if (persistenceState.mode === 'firestore') {
    try {
      const snap = await adminDb.collection('exams').doc(examId).get();
      if (snap.exists) {
        const data = snap.data() as Omit<Exam, 'id'>;
        return {
          id: snap.id,
          ...data,
          isActive: data.isActive !== undefined ? data.isActive : (!data.isPaid || snap.id === 'exam_model_test_01'),
          scheduledDate: data.scheduledDate || undefined
        };
      }
    } catch (err) {
      if (!isPermissionOrCredentialError(err)) console.warn('Firestore exam fetch error:', err);
    }
  }
  return mirror.exams.find(e => e.id === examId) || null;
}

export async function getAuthoritativeQuestionMap(
  questionIds: string[],
  mirror: MemoryMirror
): Promise<Map<string, ServerQuestion>> {
  const map = new Map<string, ServerQuestion>();
  const mirrorMap = new Map(mirror.questions.map(q => [q.id, q]));

  if (persistenceState.mode === 'firestore' && questionIds.length > 0) {
    try {
      // Fetch missing or authoritative records in batches of 30 (`in` query limit)
      for (let i = 0; i < questionIds.length; i += 30) {
        const chunk = questionIds.slice(i, i + 30);
        const [qSnap, kSnap] = await Promise.all([
          adminDb.collection('questions').where('__name__', 'in', chunk).get(),
          adminDb.collection('questionKeys').where('__name__', 'in', chunk).get()
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
    } catch (err) {
      if (!isPermissionOrCredentialError(err)) console.warn('Firestore question batch fetch error:', err);
    }
  }

  for (const id of questionIds) {
    if (!map.has(id)) {
      const fb = mirrorMap.get(id);
      if (fb) map.set(id, fb);
    }
  }
  return map;
}

export async function migrateAllSubscriptionTimestampsAdmin(): Promise<{
  updatedUsers: number;
  updatedSubscriptions: number;
}> {
  let updatedUsers = 0;
  let updatedSubscriptions = 0;

  const usersSnap = await adminDb.collection('users').get();
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

  const subsSnap = await adminDb.collection('subscriptions').get();
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

export async function importMissingDataToFirestoreAdmin(mirror: MemoryMirror): Promise<{
  addedQuestions: number;
  sanitizedExistingQuestions: number;
  addedExams: number;
  addedPreviousQuestions: number;
}> {
  let addedQuestions = 0;
  let sanitizedExistingQuestions = 0;
  let addedExams = 0;
  let addedPreviousQuestions = 0;

  const [existingQSnap, existingKeySnap, existingExamSnap, existingPrevSnap] = await Promise.all([
    adminDb.collection('questions').get(),
    adminDb.collection('questionKeys').get(),
    adminDb.collection('exams').get(),
    adminDb.collection('previous_questions').get()
  ]);

  const existingQMap = new Map(existingQSnap.docs.map(d => [d.id, d.data()]));
  const existingKeyIds = new Set(existingKeySnap.docs.map(d => d.id));
  const existingExamIds = new Set(existingExamSnap.docs.map(d => d.id));
  const existingPrevIds = new Set(existingPrevSnap.docs.map(d => d.id));

  // Safely seed missing questions AND extract keys out of any legacy /questions docs without deleting any question!
  for (let i = 0; i < mirror.questions.length; i += 200) {
    const chunk = mirror.questions.slice(i, i + 200);
    const batch = adminDb.batch();
    let batchWrites = 0;

    for (const q of chunk) {
      const qRef = adminDb.collection('questions').doc(q.id);
      const kRef = adminDb.collection('questionKeys').doc(q.id);
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
    const batch = adminDb.batch();
    for (const exam of chunk) {
      batch.set(adminDb.collection('exams').doc(exam.id), {
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

  // Safely add missing previous questions + keys
  const missingPrev = mirror.previousQuestions.filter(pq => !existingPrevIds.has(pq.id));
  for (let i = 0; i < missingPrev.length; i += 200) {
    const chunk = missingPrev.slice(i, i + 200);
    const batch = adminDb.batch();
    for (const pq of chunk) {
      batch.set(adminDb.collection('previous_questions').doc(pq.id), sanitizePreviousQuestionForClient(pq));
      batch.set(adminDb.collection('previousQuestionKeys').doc(pq.id), {
        correctAnswer: pq.correctAnswer,
        explanation: pq.explanation,
        updatedAt: new Date().toISOString()
      });
      addedPreviousQuestions++;
    }
    await batch.commit();
  }

  return {
    addedQuestions,
    sanitizedExistingQuestions,
    addedExams,
    addedPreviousQuestions
  };
}
