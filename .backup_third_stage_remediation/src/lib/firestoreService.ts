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
  orderBy, 
  limit, 
  getDocFromServer,
  writeBatch, Timestamp
} from 'firebase/firestore';
import { db, auth, isFirebaseConnected, OWNER_ADMIN_UID, isVerifiedOwnerAccount } from './firebase.ts';
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

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
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
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// -------------------------------------------------------------
// CONNECTION TEST
// -------------------------------------------------------------
export async function testFirestoreConnection(): Promise<boolean> {
  if (!db) return false;
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.warn("Firestore client is offline or connection unavailable.");
      return false;
    }
    // Any other response means we connected to the server (even a permission-denied proves server reachable)
    return true;
  }
}

// -------------------------------------------------------------
// QUESTIONS CRUD
// -------------------------------------------------------------
export async function fetchQuestionsFromFirestore(): Promise<Question[]> {
  if (!db) return [];
  const path = 'questions';
  try {
    const qSnapshot = await getDocs(collection(db, path));
    const items: Question[] = [];
    qSnapshot.forEach((docSnap) => {
      items.push({ id: docSnap.id, ...(docSnap.data() as Omit<Question, 'id'>) });
    });
    return items;
  } catch (err) {
    console.warn('Could not fetch questions from Firestore, falling back to local:', err);
    return [];
  }
}

export async function saveQuestionToFirestore(question: Question): Promise<void> {
  if (!db) return;
  const path = `questions/${question.id}`;
  try {
    await setDoc(doc(db, 'questions', question.id), {
      subjectId: question.subjectId,
      questionBn: question.questionBn,
      questionEn: question.questionEn || question.questionBn,
      optionsBn: question.optionsBn,
      optionsEn: question.optionsEn || question.optionsBn,
      correctOptionIndex: question.correctOptionIndex,
      explanationBn: question.explanationBn || '',
      explanationEn: question.explanationEn || '',
      legalReference: question.legalReference || '',
      difficulty: question.difficulty || 'medium',
      status: question.status || 'published',
      isDemoSample: Boolean(question.isDemoSample),
      createdAt: question.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: question.createdBy || 'Admin'
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function deleteQuestionFromFirestore(questionId: string): Promise<void> {
  if (!db) return;
  const path = `questions/${questionId}`;
  try {
    await deleteDoc(doc(db, 'questions', questionId));
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
      items.push({ id: docSnap.id, ...(docSnap.data() as Omit<Exam, 'id'>) });
    });
    return items;
  } catch (err) {
    console.warn('Could not fetch exams from Firestore, falling back to local:', err);
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
  if (!db) return;
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
      status: req.status || 'pending',
      requestedAt: req.requestedAt || new Date().toISOString(),
      verifiedAt: req.verifiedAt || null,
      verifiedBy: req.verifiedBy || null,
      rejectionReason: req.rejectionReason || null,
      subscriptionId: req.subscriptionId || null
    });
  } catch (err) {
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
// SUBSCRIPTIONS (Paid Access Records)
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
      items.push({ id: docSnap.id, ...(docSnap.data() as Omit<UserSubscription, 'id'>) });
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
      activatedAt: sub.activatedAt,
      expiresAt: sub.expiresAt,
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
    await updateDoc(doc(db, 'subscriptions', id), updates);
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

// -------------------------------------------------------------
// EXAM RESULTS
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
  if (!db) return;
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
// USER PROFILES & ROLES
// -------------------------------------------------------------
export async function fetchUsersFromFirestore(): Promise<UserProfile[]> {
  if (!db) return [];
  const path = 'users';
  try {
    const snap = await getDocs(collection(db, path));
    const items: UserProfile[] = [];
    snap.forEach((docSnap) => {
      items.push({ uid: docSnap.id, ...(docSnap.data() as Omit<UserProfile, 'uid'>) });
    });
    return items;
  } catch (err) {
    console.warn('Could not fetch users from Firestore:', err);
    return [];
  }
}

export async function fetchUserProfileFromFirestore(uid: string): Promise<UserProfile | null> {
  if (!db) return null;
  const path = `users/${uid}`;
  try {
    const docSnap = await getDoc(doc(db, 'users', uid));
    if (docSnap.exists()) {
      return { uid: docSnap.id, ...(docSnap.data() as Omit<UserProfile, 'uid'>) };
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
  // Cryptographically verify that the queried UID matches the currently authenticated Firebase Auth user
  if (auth.currentUser.uid !== uid) return false;
  if (uid === OWNER_ADMIN_UID && isVerifiedOwnerAccount(auth.currentUser)) {
    return true;
  }
  try {
    const adminDoc = await getDoc(doc(db, 'admins', uid));
    return adminDoc.exists();
  } catch (err) {
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
      subscriptionExpiresAt: user.subscriptionExpiresAt || null,
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
    await updateDoc(doc(db, 'users', uid), updates);
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

// -------------------------------------------------------------
// SEEDING DATABASE (Guarantees Real Questions in Firestore)
// -------------------------------------------------------------
export async function seedFirestoreIfEmpty(
  seedQuestions: Question[], 
  seedExams: Exam[], 
  seedSubjects: Subject[]
): Promise<{ seeded: boolean; questionCount: number; examCount: number }> {
  if (!db) return { seeded: false, questionCount: 0, examCount: 0 };

  // Strict guard: Seeding writes require verified owner admin Firebase UID
  if (!isVerifiedOwnerAdmin()) {
    return { seeded: false, questionCount: 0, examCount: 0 };
  }

  try {
    const existingQuestions = await fetchQuestionsFromFirestore();
    if (existingQuestions.length > 0) {
      return { seeded: false, questionCount: existingQuestions.length, examCount: 0 };
    }

    console.log(`Authenticated admin: seeding ${seedQuestions.length} questions to Firestore...`);
    for (const q of seedQuestions) {
      await saveQuestionToFirestore(q);
    }

    for (const e of seedExams) {
      await saveExamToFirestore(e);
    }

    return { seeded: true, questionCount: seedQuestions.length, examCount: seedExams.length };
  } catch (err) {
    console.warn('Seeding to Firestore skipped or unpermitted:', err);
    return { seeded: false, questionCount: 0, examCount: 0 };
  }
}

// -------------------------------------------------------------
// LEADERBOARD CRUD
// -------------------------------------------------------------
export async function saveLeaderboardEntryToFirestore(entry: LeaderboardEntry): Promise<void> {
  if (!db) return;
  const path = `leaderboard/${entry.id}`;
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
    let q;
    if (examId && examId !== 'all') {
      q = query(
        collection(db, path),
        where('examId', '==', examId),
        limit(50)
      );
    } else {
      q = query(
        collection(db, path),
        limit(50)
      );
    }
    const snap = await getDocs(q);
    const results: LeaderboardEntry[] = [];
    snap.forEach((docSnap) => {
      results.push(docSnap.data() as LeaderboardEntry);
    });
    // Sort in memory by score descending, then timeSpentSeconds ascending
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
// PREVIOUS YEAR QUESTIONS CRUD & BATCH IMPORT
// -------------------------------------------------------------
export async function fetchPreviousQuestionsFromFirestore(): Promise<PreviousQuestion[]> {
  if (!db) return [];
  const path = 'previous_questions';
  try {
    const qSnapshot = await getDocs(collection(db, path));
    const items: PreviousQuestion[] = [];
    qSnapshot.forEach((docSnap) => {
      items.push({ id: docSnap.id, ...(docSnap.data() as Omit<PreviousQuestion, 'id'>) });
    });
    // Sort by year descending
    items.sort((a, b) => b.year - a.year);
    return items;
  } catch (err) {
    console.warn('Could not fetch previous questions from Firestore, falling back to local:', err);
    return [];
  }
}

export async function savePreviousQuestionToFirestore(question: PreviousQuestion): Promise<void> {
  if (!db) return;
  const path = `previous_questions/${question.id}`;
  try {
    await setDoc(doc(db, 'previous_questions', question.id), {
      year: Number(question.year),
      subject: question.subject || '',
      question: question.question || '',
      options: question.options || [],
      correctAnswer: question.correctAnswer || '',
      explanation: question.explanation || '',
      legalSection: question.legalSection || '',
      source: question.source || `Bangladesh Bar Council MCQ Exam ${question.year}`,
      createdAt: question.createdAt || new Date().toISOString()
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function deletePreviousQuestionFromFirestore(questionId: string): Promise<void> {
  if (!db) return;
  const path = `previous_questions/${questionId}`;
  try {
    await deleteDoc(doc(db, 'previous_questions', questionId));
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

  // Write in batches of max 400 to stay well under the 500 document limit
  const CHUNK_SIZE = 400;
  for (let i = 0; i < questions.length; i += CHUNK_SIZE) {
    const chunk = questions.slice(i, i + CHUNK_SIZE);
    const batch = writeBatch(db);

    for (const q of chunk) {
      const qId = q.id || `pq_${q.year}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const docRef = doc(db, 'previous_questions', qId);
      batch.set(docRef, {
        year: Number(q.year),
        subject: q.subject || '',
        question: q.question || '',
        options: Array.isArray(q.options) ? q.options : [],
        correctAnswer: q.correctAnswer || '',
        explanation: q.explanation || '',
        legalSection: q.legalSection || '',
        source: q.source || `Bangladesh Bar Council MCQ Exam ${q.year}`,
        createdAt: q.createdAt || new Date().toISOString()
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

