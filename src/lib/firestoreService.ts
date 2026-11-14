import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  limit,
  getDocFromServer,
  writeBatch,
  Timestamp
} from 'firebase/firestore';
import { db, auth, OWNER_ADMIN_UID, isVerifiedOwnerAccount } from './firebase.ts';
import type {
  Question,
  Exam,
  PaymentRequest,
  UserSubscription,
  ExamResult,
  UserProfile,
  Subject,
  LeaderboardEntry,
  PreviousQuestion
} from '../types/index.ts';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  code?: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function fromFirestoreTimestamp(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const d = new Date(trimmed);
    return isNaN(d.getTime()) ? trimmed : d.toISOString();
  }
  if (value instanceof Timestamp) {
    return value.toDate().toISOString();
  }
  if (typeof (value as { toDate?: () => Date }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  if (typeof (value as { seconds?: number }).seconds === 'number') {
    const ts = value as { seconds: number; nanoseconds?: number };
    return new Date(ts.seconds * 1000 + Math.floor((ts.nanoseconds || 0) / 1e6)).toISOString();
  }
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? undefined : value.toISOString();
  }
  return undefined;
}

export function toFirestoreTimestamp(value: unknown): Timestamp | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Timestamp) return value;
  const date = value instanceof Date ? value : new Date(String(value));
  if (isNaN(date.getTime())) return null;
  return Timestamp.fromDate(date);
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  const errCode = (error as { code?: string })?.code;
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    code: errCode,
    operationType,
    path,
    authInfo: {
      userId: auth?.currentUser?.uid,
      email: auth?.currentUser?.email,
      emailVerified: auth?.currentUser?.emailVerified,
      isAnonymous: auth?.currentUser?.isAnonymous,
      tenantId: auth?.currentUser?.tenantId,
      providerInfo: auth?.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    }
  };
  console.error('Firestore Error:', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// -------------------------------------------------------------
// CONNECTION TEST
// -------------------------------------------------------------
export async function testFirestoreConnection(): Promise<boolean> {
  if (!db) return false;
  try {
    await getDocFromServer(doc(db, 'config', 'examDate'));
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.warn('Firestore client is offline or connection unavailable.');
      return false;
    }
    return true;
  }
}

// -------------------------------------------------------------
// QUESTIONS CRUD (Sanitized /questions + Restricted /questionKeys)
// -------------------------------------------------------------
export async function fetchQuestionsFromFirestore(): Promise<Question[]> {
  if (!db || !isVerifiedOwnerAdmin()) return [];
  const path = 'questions';
  try {
    const [qSnapshot, keySnapshot] = await Promise.all([
      getDocs(collection(db, path)),
      getDocs(collection(db, 'questionKeys')).catch(() => null)
    ]);

    const keyMap = new Map<string, Record<string, unknown>>();
    if (keySnapshot) {
      keySnapshot.forEach(docSnap => {
        keyMap.set(docSnap.id, docSnap.data());
      });
    }

    const items: Question[] = [];
    qSnapshot.forEach((docSnap) => {
      const data = docSnap.data() as Omit<Question, 'id'>;
      const keyData = keyMap.get(docSnap.id) as Partial<Question> | undefined;
      items.push({
        id: docSnap.id,
        ...data,
        ...(keyData ? {
          correctOptionIndex: keyData.correctOptionIndex ?? data.correctOptionIndex,
          explanationBn: keyData.explanationBn ?? data.explanationBn,
          explanationEn: keyData.explanationEn ?? data.explanationEn
        } : {})
      });
    });
    return items;
  } catch (err) {
    console.warn('Could not fetch questions from Firestore:', err);
    return [];
  }
}

export async function saveQuestionToFirestore(question: Question): Promise<void> {
  if (!db) return;
  const path = `questions/${question.id}`;
  try {
    const batch = writeBatch(db);
    // Sanitized stem & options only in /questions
    batch.set(doc(db, 'questions', question.id), {
      subjectId: question.subjectId,
      topicId: question.topicId || null,
      questionBn: question.questionBn,
      questionEn: question.questionEn || question.questionBn,
      optionsBn: question.optionsBn,
      optionsEn: question.optionsEn || question.optionsBn,
      legalReference: question.legalReference || '',
      difficulty: question.difficulty || 'medium',
      status: question.status || 'published',
      isDemoSample: Boolean(question.isDemoSample),
      createdAt: question.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: question.createdBy || 'Owner Admin'
    });

    // Restricted answer keys & explanations in /questionKeys
    if (question.correctOptionIndex !== undefined) {
      batch.set(doc(db, 'questionKeys', question.id), {
        correctOptionIndex: question.correctOptionIndex,
        explanationBn: question.explanationBn || '',
        explanationEn: question.explanationEn || '',
        legalReference: question.legalReference || '',
        updatedAt: new Date().toISOString()
      });
    }

    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function deleteQuestionFromFirestore(questionId: string): Promise<void> {
  if (!db) return;
  const path = `questions/${questionId}`;
  try {
    const batch = writeBatch(db);
    batch.delete(doc(db, 'questions', questionId));
    batch.delete(doc(db, 'questionKeys', questionId));
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

// -------------------------------------------------------------
// EXAMS CRUD (Mock Tests)
// -------------------------------------------------------------
export async function fetchExamsFromFirestore(hasPaidAccess = false): Promise<Exam[]> {
  if (!db) return [];
  const path = 'exams';
  try {
    const qRef = hasPaidAccess
      ? collection(db, path)
      : query(collection(db, path), where('isPaid', '==', false));
    const snap = await getDocs(qRef);
    const items: Exam[] = [];
    snap.forEach((docSnap) => {
      const data = docSnap.data() as Omit<Exam, 'id'>;
      items.push({
        id: docSnap.id,
        ...data,
        isActive: data.isActive !== undefined ? data.isActive : (!data.isPaid || docSnap.id === 'exam_model_test_01'),
        scheduledDate: data.scheduledDate || undefined
      });
    });
    return items;
  } catch (err) {
    console.warn('Could not fetch exams from Firestore:', err);
    return [];
  }
}

export async function saveExamToFirestore(exam: Exam): Promise<void> {
  if (!db) return;
  const path = `exams/${exam.id}`;
  try {
    await setDoc(doc(db, 'exams', exam.id), {
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
      releaseExplanationsImmediately: exam.releaseExplanationsImmediately !== undefined
        ? Boolean(exam.releaseExplanationsImmediately)
        : true,
      subjectId: exam.subjectId ?? null,
      negativeMarkRatio: exam.negativeMarkRatio ?? 0.25,
      positiveMarkRatio: exam.positiveMarkRatio ?? 1.0,
      questionIds: exam.questionIds || [],
      createdAt: exam.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function deleteExamFromFirestore(examId: string): Promise<void> {
  if (!db) return;
  const path = `exams/${examId}`;
  try {
    await deleteDoc(doc(db, 'exams', examId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

// -------------------------------------------------------------
// PAYMENT REQUESTS (bKash & Nagad Verification)
// -------------------------------------------------------------
export async function fetchPaymentRequestsFromFirestore(userId?: string, isAdminUser?: boolean): Promise<PaymentRequest[]> {
  if (!db) return [];
  const path = 'paymentRequests';
  try {
    let qRef;
    if (isAdminUser) {
      qRef = collection(db, path);
    } else if (userId) {
      qRef = query(collection(db, path), where('userId', '==', userId));
    } else if (auth?.currentUser) {
      qRef = query(collection(db, path), where('userId', '==', auth.currentUser.uid));
    } else {
      return [];
    }
    const snap = await getDocs(qRef);
    const items: PaymentRequest[] = [];
    snap.forEach((docSnap) => {
      items.push({ id: docSnap.id, ...(docSnap.data() as Omit<PaymentRequest, 'id'>) });
    });
    return items;
  } catch (err) {
    console.warn('Could not fetch payment requests from Firestore:', err);
    return [];
  }
}

export async function savePaymentRequestToFirestore(req: PaymentRequest): Promise<void> {
  if (!db) {
    throw new Error('FIRESTORE_UNAVAILABLE');
  }
  const path = `paymentRequests/${req.id}`;
  try {
    await setDoc(doc(db, 'paymentRequests', req.id), {
      userId: req.userId,
      studentName: req.studentName,
      studentPhone: req.studentPhone || '',
      method: req.method,
      senderNumber: req.senderNumber,
      transactionId: req.transactionId,
      amount: req.amount,
      packageId: req.packageId,
      packageNameBn: req.packageNameBn,
      packageNameEn: req.packageNameEn,
      packageTitle: req.packageTitle,
      durationDays: req.durationDays || 90,
      validityType: req.validityType || 'days',
      status: 'pending',
      requestedAt: req.requestedAt || new Date().toISOString(),
      verifiedAt: null,
      verifiedBy: null,
      rejectionReason: null,
      subscriptionId: null
    });
  } catch (err: any) {
    const code = String(err?.code || '').toLowerCase();
    const msg = String(err?.message || '').toLowerCase();
    if (code.includes('already-exists') || msg.includes('already exists')) {
      throw new Error('DUPLICATE_TRX_ID');
    }
    if (code.includes('permission-denied') || msg.includes('permission') || msg.includes('insufficient permissions')) {
      // Because updates/resubmissions on an existing trx_{cleanTrxId} doc are denied by security rules
      throw new Error('TRX_ALREADY_EXISTS_OR_PERMISSION_DENIED');
    }
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function updatePaymentRequestStatusInFirestore(
  id: string,
  updates: Partial<PaymentRequest>
): Promise<void> {
  if (!db) return;
  const path = `paymentRequests/${id}`;
  try {
    await updateDoc(doc(db, 'paymentRequests', id), updates);
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

// -------------------------------------------------------------
// SUBSCRIPTIONS (Paid Access Records with Timestamp Support)
// -------------------------------------------------------------
export async function fetchSubscriptionsFromFirestore(userId?: string, isAdminUser?: boolean): Promise<UserSubscription[]> {
  if (!db) return [];
  const path = 'subscriptions';
  try {
    let qRef;
    if (isAdminUser) {
      qRef = collection(db, path);
    } else if (userId) {
      qRef = query(collection(db, path), where('userId', '==', userId));
    } else if (auth?.currentUser) {
      qRef = query(collection(db, path), where('userId', '==', auth.currentUser.uid));
    } else {
      return [];
    }
    const snap = await getDocs(qRef);
    const items: UserSubscription[] = [];
    snap.forEach((docSnap) => {
      const raw = docSnap.data() as Record<string, unknown>;
      items.push({
        ...(raw as Omit<UserSubscription, 'id'>),
        id: docSnap.id,
        activatedAt: fromFirestoreTimestamp(raw.activatedAt) || new Date().toISOString(),
        expiresAt: fromFirestoreTimestamp(raw.expiresAt) || new Date(0).toISOString(),
        createdAt: fromFirestoreTimestamp(raw.createdAt) || new Date().toISOString()
      });
    });
    return items;
  } catch (err) {
    console.warn('Could not fetch subscriptions from Firestore:', err);
    return [];
  }
}

export async function saveSubscriptionToFirestore(sub: UserSubscription): Promise<void> {
  if (!db) return;
  const path = `subscriptions/${sub.id}`;
  try {
    await setDoc(doc(db, 'subscriptions', sub.id), {
      userId: sub.userId,
      studentName: sub.studentName,
      studentPhone: sub.studentPhone || '',
      packageId: sub.packageId,
      packageNameBn: sub.packageNameBn,
      packageNameEn: sub.packageNameEn,
      pricePaid: sub.pricePaid,
      paymentRequestId: sub.paymentRequestId || '',
      paymentMethod: sub.paymentMethod || 'bKash',
      transactionId: sub.transactionId || '',
      activatedAt: toFirestoreTimestamp(sub.activatedAt) || Timestamp.now(),
      expiresAt: toFirestoreTimestamp(sub.expiresAt) || Timestamp.now(),
      validityType: sub.validityType,
      status: sub.status,
      targetExamDateSnapshot: sub.targetExamDateSnapshot || null,
      createdAt: sub.createdAt || new Date().toISOString()
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function updateSubscriptionInFirestore(
  id: string,
  updates: Partial<UserSubscription>
): Promise<void> {
  if (!db) return;
  const path = `subscriptions/${id}`;
  try {
    const payload: Record<string, unknown> = { ...updates };
    if (updates.activatedAt !== undefined) {
      payload.activatedAt = toFirestoreTimestamp(updates.activatedAt);
    }
    if (updates.expiresAt !== undefined) {
      payload.expiresAt = toFirestoreTimestamp(updates.expiresAt);
    }
    await updateDoc(doc(db, 'subscriptions', id), payload);
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

// -------------------------------------------------------------
// EXAM RESULTS (Read-only for Students, Writes Restricted to Server / Owner)
// -------------------------------------------------------------
export async function fetchExamResultsFromFirestore(userId?: string, isAdminUser?: boolean): Promise<ExamResult[]> {
  if (!db) return [];
  const path = 'examResults';
  try {
    let qRef;
    if (isAdminUser) {
      qRef = collection(db, path);
    } else if (userId) {
      qRef = query(collection(db, path), where('userId', '==', userId));
    } else if (auth?.currentUser) {
      qRef = query(collection(db, path), where('userId', '==', auth.currentUser.uid));
    } else {
      return [];
    }
    const snap = await getDocs(qRef);
    const items: ExamResult[] = [];
    snap.forEach((docSnap) => {
      items.push({ id: docSnap.id, ...(docSnap.data() as Omit<ExamResult, 'id'>) });
    });
    return items;
  } catch (err) {
    console.warn('Could not fetch exam results from Firestore:', err);
    return [];
  }
}

export async function saveExamResultToFirestore(result: ExamResult): Promise<void> {
  if (!db || !isVerifiedOwnerAdmin()) return;
  const path = `examResults/${result.id}`;
  try {
    await setDoc(doc(db, 'examResults', result.id), {
      attemptId: result.attemptId,
      examId: result.examId,
      examTitleBn: result.examTitleBn,
      examTitleEn: result.examTitleEn,
      examType: result.examType,
      userId: result.userId,
      studentName: result.studentName,
      submittedAt: result.submittedAt,
      timeSpentSeconds: result.timeSpentSeconds,
      totalQuestions: result.totalQuestions,
      correctAnswersCount: result.correctAnswersCount,
      incorrectAnswersCount: result.incorrectAnswersCount,
      unansweredCount: result.unansweredCount,
      positiveMarks: result.positiveMarks,
      negativeMarks: result.negativeMarks,
      finalScore: result.finalScore,
      score: result.finalScore,
      percentage: result.percentage,
      passed: result.passed,
      passThresholdPercentage: result.passThresholdPercentage || 50,
      subjectWiseScores: result.subjectWiseScores || {}
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

// -------------------------------------------------------------
// USER PROFILES & ROLES (With Timestamp subscriptionExpiresAt)
// -------------------------------------------------------------
function normalizeUserProfile(uid: string, raw: Record<string, unknown>): UserProfile {
  return {
    ...(raw as Omit<UserProfile, 'uid'>),
    uid,
    subscriptionExpiresAt: fromFirestoreTimestamp(raw.subscriptionExpiresAt)
  };
}

export async function fetchUsersFromFirestore(): Promise<UserProfile[]> {
  if (!db) return [];
  const path = 'users';
  try {
    const snap = await getDocs(collection(db, path));
    const items: UserProfile[] = [];
    snap.forEach((docSnap) => {
      items.push(normalizeUserProfile(docSnap.id, docSnap.data()));
    });
    return items;
  } catch (err) {
    console.warn('Could not fetch users from Firestore:', err);
    return [];
  }
}

export async function fetchUserProfileFromFirestore(uid: string): Promise<UserProfile | null> {
  if (!db) return null;
  try {
    const docSnap = await getDoc(doc(db, 'users', uid));
    if (docSnap.exists()) {
      return normalizeUserProfile(docSnap.id, docSnap.data());
    }
    return null;
  } catch (err) {
    console.warn('Fetch user profile from Firestore notice:', err);
    return null;
  }
}

export function isVerifiedOwnerAdmin(): boolean {
  return isVerifiedOwnerAccount(auth?.currentUser);
}

export async function checkIsAdminInFirestore(uid: string): Promise<boolean> {
  if (!db || !uid || !auth?.currentUser) return false;
  if (auth.currentUser.uid !== uid) return false;
  if (uid === OWNER_ADMIN_UID && isVerifiedOwnerAccount(auth.currentUser)) {
    return true;
  }
  try {
    const adminDoc = await getDoc(doc(db, 'admins', uid));
    return adminDoc.exists();
  } catch {
    return false;
  }
}

export async function saveUserProfileToFirestore(user: UserProfile): Promise<void> {
  if (!db) return;
  const path = `users/${user.uid}`;
  try {
    await setDoc(doc(db, 'users', user.uid), {
      name: user.name,
      email: user.email,
      phone: user.phone || '',
      role: user.role,
      subscriptionStatus: user.subscriptionStatus,
      subscriptionExpiresAt: toFirestoreTimestamp(user.subscriptionExpiresAt),
      activePackageId: user.activePackageId || null,
      activePackageNameBn: user.activePackageNameBn || null,
      activePackageNameEn: user.activePackageNameEn || null,
      createdAt: user.createdAt || new Date().toISOString()
    }, { merge: true });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function updateUserRoleOrSubscriptionInFirestore(
  uid: string,
  updates: Partial<UserProfile>
): Promise<void> {
  if (!db) return;
  const path = `users/${uid}`;
  try {
    const payload: Record<string, unknown> = { ...updates };
    if ('subscriptionExpiresAt' in updates) {
      payload.subscriptionExpiresAt = toFirestoreTimestamp(updates.subscriptionExpiresAt);
    }
    await updateDoc(doc(db, 'users', uid), payload);
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

// Safe idempotent migration: converts legacy string subscriptionExpiresAt to Firestore Timestamp
export async function migrateSubscriptionTimestampsInFirestore(): Promise<{ updatedUsers: number; updatedSubscriptions: number }> {
  if (!db || !isVerifiedOwnerAdmin()) {
    return { updatedUsers: 0, updatedSubscriptions: 0 };
  }
  let updatedUsers = 0;
  let updatedSubscriptions = 0;

  const userSnap = await getDocs(collection(db, 'users'));
  for (const userDoc of userSnap.docs) {
    const data = userDoc.data();
    if (typeof data.subscriptionExpiresAt === 'string' && data.subscriptionExpiresAt.trim()) {
      const ts = toFirestoreTimestamp(data.subscriptionExpiresAt);
      if (ts) {
        await updateDoc(userDoc.ref, { subscriptionExpiresAt: ts });
        updatedUsers++;
      }
    }
  }

  const subSnap = await getDocs(collection(db, 'subscriptions'));
  for (const subDoc of subSnap.docs) {
    const data = subDoc.data();
    const patch: Record<string, unknown> = {};
    if (typeof data.expiresAt === 'string' && data.expiresAt.trim()) {
      const ts = toFirestoreTimestamp(data.expiresAt);
      if (ts) patch.expiresAt = ts;
    }
    if (typeof data.activatedAt === 'string' && data.activatedAt.trim()) {
      const ts = toFirestoreTimestamp(data.activatedAt);
      if (ts) patch.activatedAt = ts;
    }
    if (Object.keys(patch).length > 0) {
      await updateDoc(subDoc.ref, patch);
      updatedSubscriptions++;
    }
  }

  return { updatedUsers, updatedSubscriptions };
}

// -------------------------------------------------------------
// SAFE NON-OVERWRITING SEEDING (Owner Admin Only)
// -------------------------------------------------------------
export async function seedFirestoreIfEmpty(
  seedQuestions: Question[],
  seedExams: Exam[],
  seedSubjects: Subject[],
  seedPreviousQuestions: PreviousQuestion[] = []
): Promise<{ seeded: boolean; questionCount: number; examCount: number; previousCount: number }> {
  if (!db || !isVerifiedOwnerAdmin()) {
    return { seeded: false, questionCount: 0, examCount: 0, previousCount: 0 };
  }

  try {
    const [existingQSnap, existingExamSnap, existingSubjSnap, existingPrevSnap] = await Promise.all([
      getDocs(collection(db, 'questions')),
      getDocs(collection(db, 'exams')),
      getDocs(collection(db, 'subjects')),
      getDocs(collection(db, 'previous_questions'))
    ]);

    const existingQIds = new Set(existingQSnap.docs.map(d => d.id));
    const existingExamIds = new Set(existingExamSnap.docs.map(d => d.id));
    const existingSubjIds = new Set(existingSubjSnap.docs.map(d => d.id));
    const existingPrevIds = new Set(existingPrevSnap.docs.map(d => d.id));

    let addedQuestions = 0;
    let addedExams = 0;
    let addedPrevious = 0;

    // 1. Only add missing subjects
    const missingSubjects = seedSubjects.filter(s => !existingSubjIds.has(s.id));
    if (missingSubjects.length > 0) {
      const batch = writeBatch(db);
      for (const s of missingSubjects) {
        batch.set(doc(db, 'subjects', s.id), s);
      }
      await batch.commit();
    }

    // 2. Only add missing questions in batches (sanitized /questions + restricted /questionKeys)
    const missingQuestions = seedQuestions.filter(q => !existingQIds.has(q.id));
    for (let i = 0; i < missingQuestions.length; i += 200) {
      const chunk = missingQuestions.slice(i, i + 200);
      const batch = writeBatch(db);
      for (const q of chunk) {
        batch.set(doc(db, 'questions', q.id), {
          subjectId: q.subjectId,
          topicId: q.topicId || null,
          questionBn: q.questionBn,
          questionEn: q.questionEn || q.questionBn,
          optionsBn: q.optionsBn,
          optionsEn: q.optionsEn || q.optionsBn,
          legalReference: q.legalReference || '',
          difficulty: q.difficulty || 'medium',
          status: q.status || 'published',
          isDemoSample: Boolean(q.isDemoSample),
          createdAt: q.createdAt || new Date().toISOString(),
          updatedAt: q.updatedAt || new Date().toISOString(),
          createdBy: q.createdBy || 'System'
        });
        if (q.correctOptionIndex !== undefined) {
          batch.set(doc(db, 'questionKeys', q.id), {
            correctOptionIndex: q.correctOptionIndex,
            explanationBn: q.explanationBn || '',
            explanationEn: q.explanationEn || '',
            legalReference: q.legalReference || '',
            updatedAt: q.updatedAt || new Date().toISOString()
          });
        }
      }
      await batch.commit();
      addedQuestions += chunk.length;
    }

    // 3. Only add missing exams (never overwrite existing admin changes)
    const missingExams = seedExams.filter(e => !existingExamIds.has(e.id));
    for (let i = 0; i < missingExams.length; i += 200) {
      const chunk = missingExams.slice(i, i + 200);
      const batch = writeBatch(db);
      for (const exam of chunk) {
        batch.set(doc(db, 'exams', exam.id), {
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
      }
      await batch.commit();
      addedExams += chunk.length;
    }

    // 4. Only add missing previous questions (sanitized + keys)
    const missingPrev = seedPreviousQuestions.filter(pq => !existingPrevIds.has(pq.id));
    for (let i = 0; i < missingPrev.length; i += 200) {
      const chunk = missingPrev.slice(i, i + 200);
      const batch = writeBatch(db);
      for (const pq of chunk) {
        batch.set(doc(db, 'previous_questions', pq.id), {
          year: Number(pq.year),
          subject: pq.subject || '',
          question: pq.question || '',
          options: pq.options || [],
          legalSection: pq.legalSection || '',
          source: pq.source || `Bangladesh Bar Council MCQ Exam ${pq.year}`,
          createdAt: pq.createdAt || new Date().toISOString()
        });
        if (pq.correctAnswer) {
          batch.set(doc(db, 'previousQuestionKeys', pq.id), {
            correctAnswer: pq.correctAnswer,
            explanation: pq.explanation || '',
            updatedAt: new Date().toISOString()
          });
        }
      }
      await batch.commit();
      addedPrevious += chunk.length;
    }

    return {
      seeded: addedQuestions > 0 || addedExams > 0 || addedPrevious > 0,
      questionCount: addedQuestions,
      examCount: addedExams,
      previousCount: addedPrevious
    };
  } catch (err) {
    console.warn('Seeding to Firestore skipped or unpermitted:', err);
    return { seeded: false, questionCount: 0, examCount: 0, previousCount: 0 };
  }
}

// -------------------------------------------------------------
// LEADERBOARD CRUD (Read-Only Client; Server Writes)
// -------------------------------------------------------------
export async function saveLeaderboardEntryToFirestore(entry: LeaderboardEntry): Promise<void> {
  if (!db || !isVerifiedOwnerAdmin()) return;
  try {
    await setDoc(doc(db, 'leaderboard', entry.id), entry, { merge: true });
  } catch (err) {
    console.warn('Leaderboard save failed or offline:', err);
  }
}

export async function fetchLeaderboardFromFirestore(examId?: string): Promise<LeaderboardEntry[]> {
  if (!db) return [];
  const path = 'leaderboard';
  try {
    const q = (examId && examId !== 'all')
      ? query(collection(db, path), where('examId', '==', examId), limit(50))
      : query(collection(db, path), limit(50));
    const snap = await getDocs(q);
    const results: LeaderboardEntry[] = [];
    snap.forEach((docSnap) => {
      results.push(docSnap.data() as LeaderboardEntry);
    });
    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.timeSpentSeconds - b.timeSpentSeconds;
    });
    return results.map((entry, idx) => ({ ...entry, rank: idx + 1 }));
  } catch (err) {
    console.warn('Fetch leaderboard from Firestore error:', err);
    return [];
  }
}

// -------------------------------------------------------------
// PREVIOUS YEAR QUESTIONS CRUD & BATCH IMPORT (Owner Admin Only)
// -------------------------------------------------------------
export async function fetchPreviousQuestionsFromFirestore(): Promise<PreviousQuestion[]> {
  if (!db || !isVerifiedOwnerAdmin()) return [];
  const path = 'previous_questions';
  try {
    const [qSnapshot, keySnapshot] = await Promise.all([
      getDocs(collection(db, path)),
      getDocs(collection(db, 'previousQuestionKeys')).catch(() => null)
    ]);
    const keyMap = new Map<string, { correctAnswer?: string; explanation?: string }>();
    if (keySnapshot) {
      keySnapshot.forEach(d => keyMap.set(d.id, d.data() as { correctAnswer?: string; explanation?: string }));
    }

    const items: PreviousQuestion[] = [];
    qSnapshot.forEach((docSnap) => {
      const data = docSnap.data() as Omit<PreviousQuestion, 'id'>;
      const key = keyMap.get(docSnap.id);
      items.push({
        id: docSnap.id,
        ...data,
        ...(key ? {
          correctAnswer: key.correctAnswer ?? data.correctAnswer,
          explanation: key.explanation ?? data.explanation
        } : {})
      });
    });
    items.sort((a, b) => b.year - a.year);
    return items;
  } catch (err) {
    console.warn('Could not fetch previous questions from Firestore:', err);
    return [];
  }
}

export async function savePreviousQuestionToFirestore(question: PreviousQuestion): Promise<void> {
  if (!db) return;
  const path = `previous_questions/${question.id}`;
  try {
    const batch = writeBatch(db);
    batch.set(doc(db, 'previous_questions', question.id), {
      year: Number(question.year),
      subject: question.subject || '',
      question: question.question || '',
      options: question.options || [],
      legalSection: question.legalSection || '',
      source: question.source || `Bangladesh Bar Council MCQ Exam ${question.year}`,
      createdAt: question.createdAt || new Date().toISOString()
    });
    if (question.correctAnswer !== undefined || question.explanation !== undefined) {
      batch.set(doc(db, 'previousQuestionKeys', question.id), {
        correctAnswer: question.correctAnswer || '',
        explanation: question.explanation || '',
        updatedAt: new Date().toISOString()
      });
    }
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function deletePreviousQuestionFromFirestore(questionId: string): Promise<void> {
  if (!db) return;
  const path = `previous_questions/${questionId}`;
  try {
    const batch = writeBatch(db);
    batch.delete(doc(db, 'previous_questions', questionId));
    batch.delete(doc(db, 'previousQuestionKeys', questionId));
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

export async function batchImportPreviousQuestionsToFirestore(
  questions: PreviousQuestion[]
): Promise<{ successCount: number; failureCount: number; errors: string[] }> {
  if (!db) {
    return { successCount: 0, failureCount: questions.length, errors: ['Firestore database is not connected'] };
  }

  let successCount = 0;
  let failureCount = 0;
  const errors: string[] = [];

  const CHUNK_SIZE = 200; // 2 writes per question = max 400 writes per batch
  for (let i = 0; i < questions.length; i += CHUNK_SIZE) {
    const chunk = questions.slice(i, i + CHUNK_SIZE);
    const batch = writeBatch(db);

    for (const q of chunk) {
      const qId = q.id || `pq_${q.year}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      batch.set(doc(db, 'previous_questions', qId), {
        year: Number(q.year),
        subject: q.subject || '',
        question: q.question || '',
        options: Array.isArray(q.options) ? q.options : [],
        legalSection: q.legalSection || '',
        source: q.source || `Bangladesh Bar Council MCQ Exam ${q.year}`,
        createdAt: q.createdAt || new Date().toISOString()
      }, { merge: true });

      batch.set(doc(db, 'previousQuestionKeys', qId), {
        correctAnswer: q.correctAnswer || '',
        explanation: q.explanation || '',
        updatedAt: new Date().toISOString()
      }, { merge: true });
    }

    try {
      await batch.commit();
      successCount += chunk.length;
    } catch (err: any) {
      console.error('Batch commit failed for chunk:', err);
      failureCount += chunk.length;
      errors.push(err?.message || 'Failed to commit batch to Firestore');
    }
  }

  return { successCount, failureCount, errors };
}
