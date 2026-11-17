import { INITIAL_EXAM_DATE_CONFIG, INITIAL_PACKAGES } from '../src/data/initialPackages.ts';
import type {
  Exam,
  ExamDateConfig,
  ExamResult,
  PaymentRequest,
  PaymentSettings,
  SubscriptionPackage,
  SupportContactSettings,
  UserRole
} from '../src/types/index.ts';
import {
  assertOwnerAdmin,
  authenticateFirebaseRequest,
  isOwnerUser,
  resolveEffectiveOwnerAdmin,
  type JwksFetcher
} from './firebaseAuth.ts';
import {
  checkUserHasActiveSubscriptionRest,
  FirestoreRestClient,
  FirestoreTimestampValue,
  timestampToIso,
  type FirestoreWriteOp
} from './firestoreRest.ts';
import {
  consumeRateLimitD1,
  revokeUserSessionsByAdminD1,
  validateAndTouchSessionD1,
  type RateLimitResult
} from './d1Store.ts';
import {
  WorkerHttpError,
  type AuditLog,
  type DecodedAuthUser,
  type UserSubscription,
  type WorkerEnv
} from './types.ts';

const DEFAULT_PAYMENT_SETTINGS: PaymentSettings = {
  bkashNumber: '01712607777',
  nagadNumber: '01712607777',
  packagePrice: 300,
  instructionsBn: 'বিকাশ বা নগদ সেন্ড মানি (Personal) করে ট্রানজেকশন আইডি দিন।',
  instructionsEn: 'Send Money to the bKash or Nagad Personal number above and submit your TrxID.',
  whatsappNumber: '+8801671819027',
  whatsappMessage: 'Hello Sanad Prep BD Support, I need help with my account or subscription.'
};

const DEFAULT_SUPPORT_SETTINGS: SupportContactSettings = {
  whatsappNumber: '+8801671819027',
  whatsappMessage: 'Hello Sanad Prep BD Support, I need help with my account or subscription.'
};

export interface Phase3RouteContext {
  request: Request;
  url: URL;
  pathname: string;
  method: string;
  env: WorkerEnv;
  projectId: string;
  nowMs: number;
  firestoreClient: FirestoreRestClient;
  jwksFetcher?: JwksFetcher;
  tokenVerifier?: (idToken: string) => Promise<DecodedAuthUser>;
  questionBankCacheTtlMsOverride?: number;
  rateLimitOverrides?: {
    windowMs?: number;
    routeMax?: Record<string, number>;
  };
}

export interface Phase3RouteResult {
  status: number;
  payload: unknown;
  headers?: Record<string, string>;
}

export function calculateSubscriptionExpiryWorker(
  validityType: 'days' | 'exam_date',
  durationDays?: number,
  targetExamDate?: string,
  nowMs: number = Date.now()
): string {
  if (validityType === 'days') {
    const days = durationDays || 90;
    return new Date(nowMs + days * 24 * 60 * 60 * 1000).toISOString();
  }
  if (targetExamDate) {
    const d = new Date(targetExamDate);
    if (!isNaN(d.getTime())) {
      return d.toISOString();
    }
  }
  return new Date(nowMs + 90 * 24 * 60 * 60 * 1000).toISOString();
}

export async function parsePhase3JsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get('content-length') || '0');
  if (Number.isFinite(contentLength) && contentLength > 131_072) {
    throw new WorkerHttpError(413, 'PAYLOAD_TOO_LARGE', 'Request payload too large.');
  }
  const raw = await request.text();
  if (!raw || !raw.trim()) {
    return {};
  }
  if (raw.length > 131_072) {
    throw new WorkerHttpError(413, 'PAYLOAD_TOO_LARGE', 'Request payload too large.');
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new WorkerHttpError(400, 'INVALID_REQUEST', 'Request body must be a JSON object.');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof WorkerHttpError) throw err;
    throw new WorkerHttpError(400, 'INVALID_JSON', 'Invalid JSON request body.');
  }
}

function makeAuditId(nowMs: number): string {
  const rand =
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 6)
      : Math.random().toString(36).slice(2, 8);
  return `log_${nowMs}_${rand}`;
}

async function commitWritesChunked(
  firestoreClient: FirestoreRestClient,
  ops: FirestoreWriteOp[],
  chunkSize = 400
): Promise<void> {
  for (let i = 0; i < ops.length; i += chunkSize) {
    await firestoreClient.commitWrites(ops.slice(i, i + chunkSize));
  }
}

export async function handlePaymentsAndAdminRoutes(
  ctx: Phase3RouteContext
): Promise<Phase3RouteResult | null> {
  const { pathname, method, env, projectId, nowMs, firestoreClient } = ctx;
  const db = env.DB!;
  const windowMs = ctx.rateLimitOverrides?.windowMs ?? 60_000;
  const nowIso = new Date(nowMs).toISOString();

  // ---------------------------------------------------------
  // 1. STUDENT PAYMENT SUBMISSION & RETRIEVAL
  // ---------------------------------------------------------
  if (pathname === '/api/payments/create' && method === 'POST') {
    const authUser = await authenticateFirebaseRequest(ctx.request, {
      projectId,
      environment: env.ENVIRONMENT,
      jwksFetcher: ctx.jwksFetcher,
      tokenVerifier: ctx.tokenVerifier,
      nowMs
    });

    const paymentsCreateMax = ctx.rateLimitOverrides?.routeMax?.payments_create ?? 10;
    const rateResult: RateLimitResult = await consumeRateLimitD1(db, {
      key: `payments_create:uid_${authUser.uid}`,
      windowMs,
      maxRequests: paymentsCreateMax,
      nowMs
    });
    const rlHeaders = {
      'X-RateLimit-Limit': String(rateResult.limit),
      'X-RateLimit-Remaining': String(rateResult.remaining)
    };
    if (!rateResult.allowed) {
      return {
        status: 429,
        payload: {
          error: 'RATE_LIMITED',
          retryAfterSeconds: rateResult.retryAfterSeconds,
          message: `অতিরিক্ত পেমেন্ট অনুরোধ পাঠানো হয়েছে। অনুগ্রহ করে ${rateResult.retryAfterSeconds} সেকেন্ড পর আবার চেষ্টা করুন।`
        },
        headers: {
          ...rlHeaders,
          'Retry-After': String(rateResult.retryAfterSeconds)
        }
      };
    }

    await validateAndTouchSessionD1(db, {
      sessionId: ctx.request.headers.get('x-session-id') || '',
      uid: authUser.uid,
      nowIso
    });

    const body = await parsePhase3JsonBody(ctx.request);
    const paymentMethod = typeof body.method === 'string' ? body.method.trim() : '';
    const senderNumber = typeof body.senderNumber === 'string' ? body.senderNumber.trim() : '';
    const rawTrxId = typeof body.transactionId === 'string' ? body.transactionId : '';
    const packageId = typeof body.packageId === 'string' ? body.packageId.trim() : '';
    const studentPhone = typeof body.studentPhone === 'string' ? body.studentPhone.trim() : '';
    const studentName = typeof body.studentName === 'string' ? body.studentName.trim() : '';

    if (!paymentMethod || !senderNumber || !rawTrxId || !packageId) {
      throw new WorkerHttpError(
        400,
        'MISSING_FIELDS',
        'অনুগ্রহ করে সকল আবশ্যিক পেমেন্ট তথ্য প্রদান করুন। (Missing required payment fields)'
      );
    }

    if (!['bKash', 'Nagad', 'Rocket'].includes(paymentMethod)) {
      throw new WorkerHttpError(
        400,
        'INVALID_METHOD',
        'অবৈধ পেমেন্ট মাধ্যম। bKash বা Nagad ব্যবহার করুন।'
      );
    }

    if (senderNumber.length < 6 || senderNumber.length > 20) {
      throw new WorkerHttpError(
        400,
        'INVALID_SENDER_NUMBER',
        'সঠিক প্রেরকের মোবাইল নম্বর প্রদান করুন।'
      );
    }

    const cleanTrxId = rawTrxId
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
    if (cleanTrxId.length < 4 || cleanTrxId.length > 64) {
      throw new WorkerHttpError(
        400,
        'INVALID_TRX_ID',
        'সঠিক ট্রানজাকশন আইডি (TrxID) প্রদান করুন (৪–৬৪ অক্ষর)।'
      );
    }

    const docId = `trx_${cleanTrxId}`;

    // Authoritative Firestore lookups: package pricing, exam config, and duplicate TrxID checks
    const [pkgDoc, configDoc, dupPayDocs, dupSubDocs] = await Promise.all([
      firestoreClient.getDocument<Record<string, unknown>>('packages', packageId),
      firestoreClient.getDocument<Record<string, unknown>>('config', 'examDate'),
      firestoreClient.runQuery<Record<string, unknown>>({
        collection: 'paymentRequests',
        where: [{ field: 'transactionId', op: 'EQUAL', value: cleanTrxId }],
        limit: 1
      }),
      firestoreClient.runQuery<Record<string, unknown>>({
        collection: 'subscriptions',
        where: [{ field: 'transactionId', op: 'EQUAL', value: cleanTrxId }],
        limit: 1
      })
    ]);

    if (!pkgDoc) {
      throw new WorkerHttpError(
        404,
        'PACKAGE_NOT_FOUND',
        'নির্বাচিত সাবস্ক্রিপশন প্যাকেজটি ডাটাবেজে পাওয়া যায়নি।'
      );
    }
    const pkg = pkgDoc as unknown as SubscriptionPackage;
    if (!pkg.isActive || pkg.isArchived) {
      throw new WorkerHttpError(
        404,
        'PACKAGE_NOT_FOUND',
        'নির্বাচিত সাবস্ক্রিপশন প্যাকেজটি বর্তমানে নিষ্ক্রিয় রয়েছে।'
      );
    }

    if (dupPayDocs.length > 0) {
      const existingStatus = String(dupPayDocs[0].status || '');
      throw new WorkerHttpError(
        409,
        'DUPLICATE_TRX_ID',
        existingStatus === 'rejected'
          ? 'এই ট্রানজাকশন আইডিটি (TrxID) পূর্বে বাতিল করা হয়েছে এবং পুনরায় জমা দেওয়া যাবে না।'
          : 'এই ট্রানজাকশন আইডিটি (TrxID) ইতিপূর্বে ব্যবহার করা হয়েছে। একই TrxID পুনরায় গ্রহণযোগ্য নয়।'
      );
    }
    if (dupSubDocs.length > 0) {
      throw new WorkerHttpError(
        409,
        'DUPLICATE_TRX_ID',
        'এই ট্রানজাকশন আইডিটি (TrxID) ইতিপূর্বে একটি সাবস্ক্রিপশনে ব্যবহৃত হয়েছে।'
      );
    }

    const examPassConfigPrice = configDoc ? Number(configDoc.examPassPrice) : NaN;
    const authoritativeAmount =
      pkg.id === 'pkg_exam_pass' && !isNaN(examPassConfigPrice) && examPassConfigPrice > 0
        ? examPassConfigPrice
        : Number(pkg.price);

    if (!Number.isFinite(authoritativeAmount) || authoritativeAmount <= 0) {
      throw new WorkerHttpError(
        500,
        'INVALID_PACKAGE_CONFIGURATION',
        'প্যাকেজের মূল্য কনফিগারেশন সঠিক নয়।'
      );
    }

    const durationDays = Number(pkg.durationDays) || 90;
    const validityType: 'days' | 'exam_date' = pkg.validityType === 'exam_date' ? 'exam_date' : 'days';

    // Always bind userId & student identity from verified Firebase Auth token, ignoring client amount/status
    const newReq: PaymentRequest = {
      id: docId,
      userId: authUser.uid,
      studentName: (studentName || authUser.name || authUser.email?.split('@')[0] || 'Student').slice(0, 100),
      studentPhone: (studentPhone || senderNumber).slice(0, 20),
      method: paymentMethod as 'bKash' | 'Nagad' | 'Rocket',
      senderNumber: senderNumber.slice(0, 20),
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
      id: makeAuditId(nowMs),
      userId: newReq.userId,
      userName: newReq.studentName,
      action: 'PAYMENT_SUBMITTED',
      details: `${newReq.method} TrxID: ${cleanTrxId} (৳${newReq.amount}) for package "${pkg.nameEn}". Pending manual admin review.`,
      timestamp: nowIso
    };

    try {
      // Atomic create precondition (currentDocument.exists = false) on trx_${cleanTrxId}
      await firestoreClient.commitWrites([
        {
          type: 'create',
          collection: 'paymentRequests',
          docId,
          data: {
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
          }
        },
        {
          type: 'set',
          collection: 'auditLogs',
          docId: auditEntry.id,
          data: { ...auditEntry }
        }
      ]);
    } catch (err) {
      if (err instanceof WorkerHttpError && err.code === 'ALREADY_EXISTS') {
        throw new WorkerHttpError(
          409,
          'DUPLICATE_TRX_ID',
          'এই ট্রানজাকশন আইডিটি (TrxID) ইতিপূর্বে সিস্টেমে নিবন্ধিত হয়েছে। পুনরায় জমা দেওয়া সম্ভব নয়।'
        );
      }
      throw err;
    }

    return {
      status: 200,
      payload: {
        success: true,
        message: 'পেমেন্ট রিকোয়েস্ট সফলভাবে জমা হয়েছে। অ্যাডমিন ম্যানুয়ালি যাচাই করার পর এক্সেস চালু হবে।',
        paymentRequest: newReq
      },
      headers: rlHeaders
    };
  }

  if ((pathname === '/api/payments/my' || pathname === '/api/payments') && method === 'GET') {
    const authUser = await authenticateFirebaseRequest(ctx.request, {
      projectId,
      environment: env.ENVIRONMENT,
      jwksFetcher: ctx.jwksFetcher,
      tokenVerifier: ctx.tokenVerifier,
      nowMs
    });
    await validateAndTouchSessionD1(db, {
      sessionId: ctx.request.headers.get('x-session-id') || '',
      uid: authUser.uid,
      nowIso
    });

    const isOwner = isOwnerUser(authUser, env);
    const list =
      pathname === '/api/payments' && isOwner
        ? await firestoreClient.listDocuments<Record<string, unknown>>('paymentRequests', {
            pageSize: 500,
            maxPages: 10
          })
        : await firestoreClient.runQuery<Record<string, unknown>>({
            collection: 'paymentRequests',
            where: [{ field: 'userId', op: 'EQUAL', value: authUser.uid }]
          });

    list.sort(
      (a, b) =>
        new Date(String(b.requestedAt || 0)).getTime() - new Date(String(a.requestedAt || 0)).getTime()
    );
    return { status: 200, payload: { paymentRequests: list } };
  }

  // ---------------------------------------------------------
  // 2. OWNER ADMIN PAYMENTS LIST, ATOMIC APPROVE & REJECT
  // ---------------------------------------------------------
  if (pathname === '/api/admin/payments' && method === 'GET') {
    const authUser = await authenticateFirebaseRequest(ctx.request, {
      projectId,
      environment: env.ENVIRONMENT,
      jwksFetcher: ctx.jwksFetcher,
      tokenVerifier: ctx.tokenVerifier,
      nowMs
    });
    assertOwnerAdmin(authUser, env);

    const list = await firestoreClient.listDocuments<Record<string, unknown>>('paymentRequests', {
      pageSize: 500,
      maxPages: 10
    });
    list.sort(
      (a, b) =>
        new Date(String(b.requestedAt || 0)).getTime() - new Date(String(a.requestedAt || 0)).getTime()
    );
    return { status: 200, payload: { paymentRequests: list } };
  }

  const approveMatch = pathname.match(/^\/api\/admin\/payments\/([^/]+)\/approve$/);
  if (approveMatch && method === 'POST') {
    const authUser = await authenticateFirebaseRequest(ctx.request, {
      projectId,
      environment: env.ENVIRONMENT,
      jwksFetcher: ctx.jwksFetcher,
      tokenVerifier: ctx.tokenVerifier,
      nowMs
    });
    assertOwnerAdmin(authUser, env);

    const id = decodeURIComponent(approveMatch[1]).trim();
    if (!id) {
      throw new WorkerHttpError(400, 'INVALID_REQUEST', 'Payment request id is required.');
    }
    const body = await parsePhase3JsonBody(ctx.request);
    const verifier =
      typeof body.verifierName === 'string' && body.verifierName.trim()
        ? body.verifierName.trim().slice(0, 100)
        : authUser.email || 'Owner Admin';

    const { updatedPay, newSubscription } = await firestoreClient.runTransaction(async tx => {
      const payDoc = await tx.get<Record<string, unknown>>('paymentRequests', id);
      if (!payDoc) {
        throw new WorkerHttpError(404, 'NOT_FOUND', 'Payment request not found.');
      }
      const reqItem = payDoc as unknown as PaymentRequest;

      if (reqItem.status === 'approved') {
        throw new WorkerHttpError(409, 'ALREADY_APPROVED', 'Payment already approved.');
      }
      if (reqItem.status === 'rejected') {
        throw new WorkerHttpError(400, 'ALREADY_REJECTED', 'Rejected payment request cannot be approved.');
      }

      const [sameTrxPayDocs, sameTrxSubDocs, pkgDoc, configDoc] = await Promise.all([
        firestoreClient.runQuery<Record<string, unknown>>({
          collection: 'paymentRequests',
          where: [{ field: 'transactionId', op: 'EQUAL', value: reqItem.transactionId }],
          transactionId: tx.transactionId
        }),
        firestoreClient.runQuery<Record<string, unknown>>({
          collection: 'subscriptions',
          where: [{ field: 'transactionId', op: 'EQUAL', value: reqItem.transactionId }],
          transactionId: tx.transactionId
        }),
        tx.get<Record<string, unknown>>('packages', reqItem.packageId),
        tx.get<Record<string, unknown>>('config', 'examDate')
      ]);

      const hasDuplicateApprovedPay = sameTrxPayDocs.some(d => d.id !== id && d.status === 'approved');
      if (hasDuplicateApprovedPay || sameTrxSubDocs.length > 0) {
        throw new WorkerHttpError(
          409,
          'TRX_ALREADY_APPROVED',
          'এই TrxID দিয়ে ইতিপূর্বে আরেকটি পেমেন্ট অনুমোদন করা হয়েছে!'
        );
      }

      const pkgData = (pkgDoc || undefined) as Partial<SubscriptionPackage> | undefined;
      const targetExamDate =
        typeof configDoc?.targetExamDate === 'string' && configDoc.targetExamDate
          ? configDoc.targetExamDate
          : INITIAL_EXAM_DATE_CONFIG.targetExamDate;

      const validityType: 'days' | 'exam_date' =
        (pkgData?.validityType || reqItem.validityType || 'days') === 'exam_date'
          ? 'exam_date'
          : 'days';
      // Preserve Pro Model Test Pass 90-day duration as default fallback when validityType === 'days'
      const durationDays = Number(pkgData?.durationDays || reqItem.durationDays || 90);
      const packageNameBn = String(pkgData?.nameBn || reqItem.packageNameBn || 'Pro Package');
      const packageNameEn = String(pkgData?.nameEn || reqItem.packageNameEn || 'Pro Package');

      const activatedAt = nowIso;
      const expiresAt = calculateSubscriptionExpiryWorker(
        validityType,
        durationDays,
        targetExamDate,
        nowMs
      );

      const subId = `sub_${reqItem.userId}_${reqItem.transactionId}`;
      const createdSub: UserSubscription = {
        id: subId,
        userId: reqItem.userId,
        studentName: reqItem.studentName,
        studentPhone: reqItem.studentPhone,
        packageId: reqItem.packageId,
        packageNameBn,
        packageNameEn,
        pricePaid: Number(reqItem.amount),
        paymentRequestId: reqItem.id,
        paymentMethod: (reqItem.method === 'Nagad' ? 'Nagad' : 'bKash') as 'bKash' | 'Nagad',
        transactionId: reqItem.transactionId,
        activatedAt,
        expiresAt,
        validityType,
        status: 'active',
        ...(validityType === 'exam_date' ? { targetExamDateSnapshot: targetExamDate } : {}),
        createdAt: activatedAt
      };

      const auditId = makeAuditId(nowMs);

      tx.update('paymentRequests', id, {
        status: 'approved',
        verifiedAt: activatedAt,
        verifiedBy: verifier,
        subscriptionId: subId
      });

      // Use atomic create so concurrent replay can never overwrite an existing subscription
      tx.create('subscriptions', subId, {
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
        activatedAt: new FirestoreTimestampValue(activatedAt),
        expiresAt: new FirestoreTimestampValue(expiresAt),
        validityType: createdSub.validityType,
        status: 'active',
        targetExamDateSnapshot: createdSub.targetExamDateSnapshot || null,
        createdAt: activatedAt
      });

      tx.set(
        'users',
        reqItem.userId,
        {
          subscriptionStatus: 'pro',
          subscriptionExpiresAt: new FirestoreTimestampValue(expiresAt),
          activePackageId: reqItem.packageId,
          activePackageNameBn: packageNameBn,
          activePackageNameEn: packageNameEn
        },
        { merge: true }
      );

      tx.set('auditLogs', auditId, {
        id: auditId,
        userId: authUser.uid,
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

    return {
      status: 200,
      payload: {
        success: true,
        paymentRequest: updatedPay,
        subscription: newSubscription
      }
    };
  }

  const rejectMatch = pathname.match(/^\/api\/admin\/payments\/([^/]+)\/reject$/);
  if (rejectMatch && method === 'POST') {
    const authUser = await authenticateFirebaseRequest(ctx.request, {
      projectId,
      environment: env.ENVIRONMENT,
      jwksFetcher: ctx.jwksFetcher,
      tokenVerifier: ctx.tokenVerifier,
      nowMs
    });
    assertOwnerAdmin(authUser, env);

    const id = decodeURIComponent(rejectMatch[1]).trim();
    if (!id) {
      throw new WorkerHttpError(400, 'INVALID_REQUEST', 'Payment request id is required.');
    }
    const body = await parsePhase3JsonBody(ctx.request);
    const verifier =
      typeof body.verifierName === 'string' && body.verifierName.trim()
        ? body.verifierName.trim().slice(0, 100)
        : authUser.email || 'Owner Admin';
    const rejectionReason =
      typeof body.reason === 'string' && body.reason.trim()
        ? body.reason.trim().slice(0, 300)
        : 'Unverified Transaction ID or Amount Mismatch';

    const updatedPay = await firestoreClient.runTransaction(async tx => {
      const payDoc = await tx.get<Record<string, unknown>>('paymentRequests', id);
      if (!payDoc) {
        throw new WorkerHttpError(404, 'NOT_FOUND', 'Payment request not found.');
      }
      const reqItem = payDoc as unknown as PaymentRequest;
      if (reqItem.status === 'approved') {
        throw new WorkerHttpError(400, 'ALREADY_APPROVED', 'Approved payment request cannot be rejected.');
      }
      if (reqItem.status === 'rejected') {
        throw new WorkerHttpError(409, 'ALREADY_REJECTED', 'Payment request has already been rejected.');
      }

      const auditId = makeAuditId(nowMs);
      tx.update('paymentRequests', id, {
        status: 'rejected',
        rejectionReason,
        verifiedAt: nowIso,
        verifiedBy: verifier
      });
      tx.set('auditLogs', auditId, {
        id: auditId,
        userId: authUser.uid,
        userName: verifier,
        action: 'PAYMENT_REJECTED',
        details: `Rejected ${reqItem.method} TrxID: ${reqItem.transactionId}. Reason: ${rejectionReason}`,
        timestamp: nowIso
      });

      return {
        ...reqItem,
        status: 'rejected' as const,
        rejectionReason,
        verifiedAt: nowIso,
        verifiedBy: verifier
      };
    });

    return { status: 200, payload: { success: true, paymentRequest: updatedPay } };
  }

  // ---------------------------------------------------------
  // 3. SUBSCRIPTIONS VALIDATION & OWNER ADMIN LISTING
  // ---------------------------------------------------------
  const activeSubMatch = pathname.match(/^\/api\/subscriptions\/active\/([^/]+)$/);
  if (activeSubMatch && method === 'GET') {
    const authUser = await authenticateFirebaseRequest(ctx.request, {
      projectId,
      environment: env.ENVIRONMENT,
      jwksFetcher: ctx.jwksFetcher,
      tokenVerifier: ctx.tokenVerifier,
      nowMs
    });
    await validateAndTouchSessionD1(db, {
      sessionId: ctx.request.headers.get('x-session-id') || '',
      uid: authUser.uid,
      nowIso
    });

    const requestedUserId = decodeURIComponent(activeSubMatch[1]).trim();
    if (requestedUserId !== authUser.uid && !isOwnerUser(authUser, env)) {
      throw new WorkerHttpError(403, 'FORBIDDEN', 'Cannot access another user subscription.');
    }

    const subStatus = await checkUserHasActiveSubscriptionRest(firestoreClient, requestedUserId, nowMs);
    if (!subStatus.active || !subStatus.activeSubscription) {
      return {
        status: 200,
        payload: {
          hasActiveSubscription: false,
          status: subStatus.active ? 'pro' : 'free',
          activeSubscription: null
        }
      };
    }

    const daysRemaining = Math.max(
      0,
      Math.ceil((new Date(subStatus.activeSubscription.expiresAt).getTime() - nowMs) / (1000 * 60 * 60 * 24))
    );

    return {
      status: 200,
      payload: {
        hasActiveSubscription: true,
        status: 'pro',
        activeSubscription: subStatus.activeSubscription,
        daysRemaining
      }
    };
  }

  if (pathname === '/api/admin/subscriptions' && method === 'GET') {
    const authUser = await authenticateFirebaseRequest(ctx.request, {
      projectId,
      environment: env.ENVIRONMENT,
      jwksFetcher: ctx.jwksFetcher,
      tokenVerifier: ctx.tokenVerifier,
      nowMs
    });
    assertOwnerAdmin(authUser, env);

    const docs = await firestoreClient.listDocuments<Record<string, unknown>>('subscriptions', {
      pageSize: 500,
      maxPages: 10
    });

    const uniqueUids = Array.from(
      new Set(
        docs
          .map(raw => (typeof raw.userId === 'string' ? raw.userId.trim() : ''))
          .filter(Boolean)
      )
    );
    const userDocsMap =
      uniqueUids.length > 0
        ? await firestoreClient
            .batchGetDocuments<Record<string, unknown>>(
              uniqueUids.map(uid => ({ collection: 'users', docId: uid }))
            )
            .catch(() => new Map<string, Record<string, unknown> & { id: string }>())
        : new Map<string, Record<string, unknown> & { id: string }>();

    const mapped = docs.map(raw => {
      const activatedAt = timestampToIso(raw.activatedAt) || nowIso;
      const expiresAt = timestampToIso(raw.expiresAt) || new Date(0).toISOString();
      const createdAt = timestampToIso(raw.createdAt) || nowIso;
      const expMs = new Date(expiresAt).getTime();
      const isExpired = isNaN(expMs) || expMs <= nowMs;
      const daysRemaining = isNaN(expMs) ? 0 : Math.max(0, Math.ceil((expMs - nowMs) / (1000 * 60 * 60 * 24)));
      const rawStatus = String(raw.status || 'expired') as 'active' | 'expired' | 'cancelled';
      const ownerDoc = userDocsMap.get(String(raw.userId || '').trim());
      const resolvedStudentEmail =
        typeof ownerDoc?.email === 'string' && ownerDoc.email.trim()
          ? ownerDoc.email.trim()
          : typeof raw.studentEmail === 'string' && raw.studentEmail.trim()
          ? raw.studentEmail.trim()
          : '';

      return {
        ...(raw as unknown as Omit<UserSubscription, 'id'>),
        id: raw.id,
        ...(resolvedStudentEmail ? { studentEmail: resolvedStudentEmail } : {}),
        activatedAt,
        expiresAt,
        createdAt,
        status: isExpired && rawStatus === 'active' ? ('expired' as const) : rawStatus,
        daysRemaining
      };
    });

    mapped.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return { status: 200, payload: { subscriptions: mapped } };
  }

  // ---------------------------------------------------------
  // 4. OWNER ADMIN PACKAGES, CONFIG, SETTINGS, EXAMS & USERS
  // ---------------------------------------------------------
  if (pathname === '/api/admin/packages' && method === 'GET') {
    const authUser = await authenticateFirebaseRequest(ctx.request, {
      projectId,
      environment: env.ENVIRONMENT,
      jwksFetcher: ctx.jwksFetcher,
      tokenVerifier: ctx.tokenVerifier,
      nowMs
    });
    assertOwnerAdmin(authUser, env);

    const [pkgDocs, configDoc] = await Promise.all([
      firestoreClient.listDocuments<Record<string, unknown>>('packages', { pageSize: 50, maxPages: 2 }),
      firestoreClient.getDocument<Record<string, unknown>>('config', 'examDate')
    ]);
    const examDateConfig = configDoc
      ? { ...INITIAL_EXAM_DATE_CONFIG, ...configDoc }
      : INITIAL_EXAM_DATE_CONFIG;

    return { status: 200, payload: { packages: pkgDocs, examDateConfig } };
  }

  if (pathname === '/api/admin/packages/update' && method === 'POST') {
    const authUser = await authenticateFirebaseRequest(ctx.request, {
      projectId,
      environment: env.ENVIRONMENT,
      jwksFetcher: ctx.jwksFetcher,
      tokenVerifier: ctx.tokenVerifier,
      nowMs
    });
    assertOwnerAdmin(authUser, env);

    const body = await parsePhase3JsonBody(ctx.request);
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    if (!id) {
      throw new WorkerHttpError(400, 'INVALID_PACKAGE_ID', 'Package id is required.');
    }

    const pkgDoc = await firestoreClient.getDocument<Record<string, unknown>>('packages', id);
    if (!pkgDoc) {
      throw new WorkerHttpError(404, 'PACKAGE_NOT_FOUND', 'Package not found in Firestore.');
    }
    const existing = pkgDoc as unknown as SubscriptionPackage;

    if (body.price !== undefined) {
      const parsedPrice = Number(body.price);
      if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
        throw new WorkerHttpError(400, 'INVALID_PACKAGE_PRICE', 'Valid positive price is required.');
      }
    }
    if (body.durationDays !== undefined) {
      const parsedDays = Number(body.durationDays);
      if (!Number.isFinite(parsedDays) || parsedDays <= 0) {
        throw new WorkerHttpError(400, 'INVALID_DURATION', 'Valid positive durationDays is required.');
      }
    }

    const updatedPkg: SubscriptionPackage = {
      ...existing,
      ...(body.price !== undefined ? { price: Number(body.price) } : {}),
      ...(body.durationDays !== undefined ? { durationDays: Number(body.durationDays) } : {}),
      ...(body.isActive !== undefined ? { isActive: Boolean(body.isActive) } : {}),
      updatedAt: nowIso
    };

    const auditEntry: AuditLog = {
      id: makeAuditId(nowMs),
      userId: authUser.uid,
      userName: authUser.email || 'Owner Admin',
      action: 'UPDATE_PACKAGE',
      details: `Updated package ${updatedPkg.nameEn}: Price=${updatedPkg.price}, Duration=${updatedPkg.durationDays}d, Active=${updatedPkg.isActive}`,
      timestamp: nowIso
    };

    const writes: FirestoreWriteOp[] = [
      {
        type: 'set',
        collection: 'packages',
        docId: id,
        data: updatedPkg as unknown as Record<string, unknown>,
        merge: true
      },
      {
        type: 'set',
        collection: 'auditLogs',
        docId: auditEntry.id,
        data: { ...auditEntry }
      }
    ];

    if (updatedPkg.id === 'pkg_exam_pass' && body.price !== undefined) {
      writes.push({
        type: 'set',
        collection: 'config',
        docId: 'examDate',
        data: { examPassPrice: Number(body.price), lastUpdated: nowIso },
        merge: true
      });
    }

    await firestoreClient.commitWrites(writes);
    return { status: 200, payload: { success: true, package: updatedPkg } };
  }

  if (pathname === '/api/admin/exam-config' && method === 'POST') {
    const authUser = await authenticateFirebaseRequest(ctx.request, {
      projectId,
      environment: env.ENVIRONMENT,
      jwksFetcher: ctx.jwksFetcher,
      tokenVerifier: ctx.tokenVerifier,
      nowMs
    });
    assertOwnerAdmin(authUser, env);

    const body = await parsePhase3JsonBody(ctx.request);
    const targetExamDate = typeof body.targetExamDate === 'string' ? body.targetExamDate.trim() : undefined;
    const examDatePolicy =
      body.examDatePolicy === 'extend_all' || body.examDatePolicy === 'new_only'
        ? body.examDatePolicy
        : undefined;
    const examPassPrice = body.examPassPrice;
    const examTitleBn = typeof body.examTitleBn === 'string' ? body.examTitleBn.trim() : undefined;
    const examTitleEn = typeof body.examTitleEn === 'string' ? body.examTitleEn.trim() : undefined;

    if (targetExamDate) {
      const parsedDate = new Date(targetExamDate);
      if (isNaN(parsedDate.getTime())) {
        throw new WorkerHttpError(400, 'INVALID_EXAM_DATE', 'Invalid targetExamDate format.');
      }
    }
    if (examPassPrice !== undefined) {
      const parsedPrice = Number(examPassPrice);
      if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
        throw new WorkerHttpError(400, 'INVALID_PACKAGE_PRICE', 'Valid positive examPassPrice is required.');
      }
    }

    const configDoc = await firestoreClient.getDocument<Record<string, unknown>>('config', 'examDate');
    const currentConfig: ExamDateConfig = {
      ...INITIAL_EXAM_DATE_CONFIG,
      ...(configDoc ? (configDoc as Partial<ExamDateConfig>) : {})
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

    const pendingUpdates: Array<{ subId: string; userId: string }> = [];
    if (nextConfig.examDatePolicy === 'extend_all' && targetExamDate) {
      const examPassSubs = await firestoreClient.runQuery<Record<string, unknown>>({
        collection: 'subscriptions',
        where: [{ field: 'packageId', op: 'EQUAL', value: 'pkg_exam_pass' }]
      });
      for (const s of examPassSubs) {
        if (s.status === 'active') {
          pendingUpdates.push({ subId: s.id, userId: String(s.userId) });
        }
      }
    }

    const writes: FirestoreWriteOp[] = [
      {
        type: 'set',
        collection: 'config',
        docId: 'examDate',
        data: nextConfig as unknown as Record<string, unknown>,
        merge: true
      }
    ];

    if (examPassPrice !== undefined) {
      const epDoc = await firestoreClient.getDocument<Record<string, unknown>>('packages', 'pkg_exam_pass');
      if (epDoc) {
        writes.push({
          type: 'update',
          collection: 'packages',
          docId: 'pkg_exam_pass',
          patch: { price: Number(examPassPrice), updatedAt: nowIso }
        });
      }
    }

    if (targetExamDate) {
      const nextTs = new FirestoreTimestampValue(new Date(targetExamDate).toISOString());
      for (const item of pendingUpdates) {
        writes.push({
          type: 'update',
          collection: 'subscriptions',
          docId: item.subId,
          patch: {
            expiresAt: nextTs,
            targetExamDateSnapshot: targetExamDate
          }
        });
        writes.push({
          type: 'set',
          collection: 'users',
          docId: item.userId,
          data: { subscriptionExpiresAt: nextTs },
          merge: true
        });
      }
    }

    const auditEntry: AuditLog = {
      id: makeAuditId(nowMs),
      userId: authUser.uid,
      userName: authUser.email || 'Owner Admin',
      action: 'UPDATE_EXAM_DATE_CONFIG',
      details: `Updated exam date config (${nextConfig.targetExamDate}). Policy: ${nextConfig.examDatePolicy}. Affected: ${pendingUpdates.length}.`,
      timestamp: nowIso
    };
    writes.push({
      type: 'set',
      collection: 'auditLogs',
      docId: auditEntry.id,
      data: { ...auditEntry }
    });

    await commitWritesChunked(firestoreClient, writes);
    return {
      status: 200,
      payload: {
        success: true,
        examDateConfig: nextConfig,
        affectedSubscribers: pendingUpdates.length
      }
    };
  }

  if (pathname === '/api/admin/payment-settings' && method === 'POST') {
    const authUser = await authenticateFirebaseRequest(ctx.request, {
      projectId,
      environment: env.ENVIRONMENT,
      jwksFetcher: ctx.jwksFetcher,
      tokenVerifier: ctx.tokenVerifier,
      nowMs
    });
    assertOwnerAdmin(authUser, env);

    const body = await parsePhase3JsonBody(ctx.request);
    const {
      bkashNumber,
      nagadNumber,
      packagePrice,
      instructionsBn,
      instructionsEn,
      whatsappNumber,
      whatsappMessage
    } = body;

    const bdWalletRegex = /^01[3-9]\d{8}$/;
    if (bkashNumber !== undefined && !bdWalletRegex.test(String(bkashNumber).trim())) {
      throw new WorkerHttpError(
        400,
        'INVALID_PAYMENT_NUMBER',
        'bKash নম্বরটি সঠিক ১১ ডিজিটের বাংলাদেশি মোবাইল নম্বর হতে হবে (যেমন: 017xxxxxxxx)।'
      );
    }
    if (nagadNumber !== undefined && !bdWalletRegex.test(String(nagadNumber).trim())) {
      throw new WorkerHttpError(
        400,
        'INVALID_PAYMENT_NUMBER',
        'Nagad নম্বরটি সঠিক ১১ ডিজিটের বাংলাদেশি মোবাইল নম্বর হতে হবে (যেমন: 017xxxxxxxx)।'
      );
    }
    if (packagePrice !== undefined) {
      const parsedPrice = Number(packagePrice);
      if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
        throw new WorkerHttpError(400, 'INVALID_PACKAGE_PRICE', 'Valid positive packagePrice is required.');
      }
    }
    if (whatsappNumber !== undefined) {
      const waDigits = String(whatsappNumber).replace(/[^0-9]/g, '');
      if (waDigits.length < 10 || waDigits.length > 15) {
        throw new WorkerHttpError(
          400,
          'INVALID_WHATSAPP_NUMBER',
          'Valid WhatsApp number (10-15 digits) is required.'
        );
      }
    }

    const [payDoc, supDoc] = await Promise.all([
      firestoreClient.getDocument<Record<string, unknown>>('config', 'paymentSettings'),
      firestoreClient.getDocument<Record<string, unknown>>('config', 'supportSettings')
    ]);

    const currentPay: PaymentSettings = {
      ...DEFAULT_PAYMENT_SETTINGS,
      ...(payDoc ? (payDoc as Partial<PaymentSettings>) : {})
    };
    const currentSup: SupportContactSettings = {
      ...DEFAULT_SUPPORT_SETTINGS,
      ...(supDoc ? (supDoc as Partial<SupportContactSettings>) : {})
    };

    const nextPay: PaymentSettings = {
      ...currentPay,
      ...(bkashNumber !== undefined ? { bkashNumber: String(bkashNumber).trim() } : {}),
      ...(nagadNumber !== undefined ? { nagadNumber: String(nagadNumber).trim() } : {}),
      ...(packagePrice !== undefined ? { packagePrice: Number(packagePrice) } : {}),
      ...(instructionsBn !== undefined ? { instructionsBn: String(instructionsBn).trim() } : {}),
      ...(instructionsEn !== undefined ? { instructionsEn: String(instructionsEn).trim() } : {}),
      ...(whatsappNumber !== undefined ? { whatsappNumber: String(whatsappNumber).trim() } : {}),
      ...(whatsappMessage !== undefined ? { whatsappMessage: String(whatsappMessage).trim() } : {})
    };

    const nextSup: SupportContactSettings = {
      ...currentSup,
      ...(whatsappNumber !== undefined ? { whatsappNumber: String(whatsappNumber).trim() } : {}),
      ...(whatsappMessage !== undefined ? { whatsappMessage: String(whatsappMessage).trim() } : {})
    };

    const auditEntry: AuditLog = {
      id: makeAuditId(nowMs),
      userId: authUser.uid,
      userName: authUser.email || 'Owner Admin',
      action: 'UPDATE_PAYMENT_SETTINGS',
      details: `Updated Payment Numbers: bKash=${nextPay.bkashNumber}, Nagad=${nextPay.nagadNumber}`,
      timestamp: nowIso
    };

    await firestoreClient.commitWrites([
      {
        type: 'set',
        collection: 'config',
        docId: 'paymentSettings',
        data: { ...nextPay, updatedAt: nowIso },
        merge: true
      },
      {
        type: 'set',
        collection: 'config',
        docId: 'supportSettings',
        data: { ...nextSup, updatedAt: nowIso },
        merge: true
      },
      {
        type: 'set',
        collection: 'auditLogs',
        docId: auditEntry.id,
        data: { ...auditEntry }
      }
    ]);

    return {
      status: 200,
      payload: {
        success: true,
        paymentSettings: nextPay,
        supportSettings: nextSup
      }
    };
  }

  if (pathname === '/api/admin/support-settings' && method === 'POST') {
    const authUser = await authenticateFirebaseRequest(ctx.request, {
      projectId,
      environment: env.ENVIRONMENT,
      jwksFetcher: ctx.jwksFetcher,
      tokenVerifier: ctx.tokenVerifier,
      nowMs
    });
    assertOwnerAdmin(authUser, env);

    const body = await parsePhase3JsonBody(ctx.request);
    const { whatsappNumber, whatsappMessage } = body;

    if (whatsappNumber !== undefined) {
      const waDigits = String(whatsappNumber).replace(/[^0-9]/g, '');
      if (waDigits.length < 10 || waDigits.length > 15) {
        throw new WorkerHttpError(
          400,
          'INVALID_WHATSAPP_NUMBER',
          'Valid WhatsApp number (10-15 digits) is required.'
        );
      }
    }

    const [supDoc, payDoc] = await Promise.all([
      firestoreClient.getDocument<Record<string, unknown>>('config', 'supportSettings'),
      firestoreClient.getDocument<Record<string, unknown>>('config', 'paymentSettings')
    ]);

    const currentSup: SupportContactSettings = {
      ...DEFAULT_SUPPORT_SETTINGS,
      ...(supDoc ? (supDoc as Partial<SupportContactSettings>) : {})
    };
    const currentPay: PaymentSettings = {
      ...DEFAULT_PAYMENT_SETTINGS,
      ...(payDoc ? (payDoc as Partial<PaymentSettings>) : {})
    };

    const nextSup: SupportContactSettings = {
      ...currentSup,
      ...(whatsappNumber !== undefined ? { whatsappNumber: String(whatsappNumber).trim() } : {}),
      ...(whatsappMessage !== undefined ? { whatsappMessage: String(whatsappMessage).trim() } : {})
    };

    const auditEntry: AuditLog = {
      id: makeAuditId(nowMs),
      userId: authUser.uid,
      userName: authUser.email || 'Owner Admin',
      action: 'UPDATE_SUPPORT_SETTINGS',
      details: `Updated WhatsApp Support: ${nextSup.whatsappNumber}`,
      timestamp: nowIso
    };

    await firestoreClient.commitWrites([
      {
        type: 'set',
        collection: 'config',
        docId: 'supportSettings',
        data: { ...nextSup, updatedAt: nowIso },
        merge: true
      },
      {
        type: 'set',
        collection: 'config',
        docId: 'paymentSettings',
        data: {
          ...currentPay,
          whatsappNumber: nextSup.whatsappNumber,
          whatsappMessage: nextSup.whatsappMessage,
          updatedAt: nowIso
        },
        merge: true
      },
      {
        type: 'set',
        collection: 'auditLogs',
        docId: auditEntry.id,
        data: { ...auditEntry }
      }
    ]);

    return { status: 200, payload: { success: true, supportSettings: nextSup } };
  }

  if (pathname === '/api/admin/users/update' && method === 'POST') {
    const authUser = await authenticateFirebaseRequest(ctx.request, {
      projectId,
      environment: env.ENVIRONMENT,
      jwksFetcher: ctx.jwksFetcher,
      tokenVerifier: ctx.tokenVerifier,
      nowMs
    });
    assertOwnerAdmin(authUser, env);

    const body = await parsePhase3JsonBody(ctx.request);
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
    } = body;

    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      throw new WorkerHttpError(400, 'MISSING_USER_ID', 'userId is required.');
    }
    const cleanName = typeof name === 'string' ? name.trim().slice(0, 100) : '';
    if (!cleanName) {
      throw new WorkerHttpError(400, 'INVALID_USER_NAME', 'Valid user name is required.');
    }

    const allowedStatuses = new Set(['free', 'pro', 'expired']);
    const safeSubStatus = allowedStatuses.has(String(subscriptionStatus))
      ? (String(subscriptionStatus) as 'free' | 'pro' | 'expired')
      : 'free';

    const targetUid = userId.trim();
    const allowedRoles = new Set<UserRole>(['student', 'question_manager', 'admin']);
    const requestedRole = allowedRoles.has(role as UserRole) ? (role as UserRole) : 'student';
    const effectiveOwner = resolveEffectiveOwnerAdmin(env);
    // Strictly prevent creating secondary Admin accounts — admin role allowed ONLY on effective single owner UID
    const safeRole: UserRole =
      requestedRole === 'admin' && (!effectiveOwner || targetUid !== effectiveOwner.uid)
        ? 'student'
        : requestedRole;

    let cleanExpiresIso: string | undefined;
    if (expiresAt !== undefined && expiresAt !== null && String(expiresAt).trim() !== '') {
      const parsedExp = new Date(String(expiresAt));
      if (isNaN(parsedExp.getTime())) {
        throw new WorkerHttpError(400, 'INVALID_EXPIRES_AT', 'Invalid expiresAt date format.');
      }
      cleanExpiresIso = parsedExp.toISOString();
    }

    const rawEmailInput = typeof email === 'string' ? email.trim() : '';
    if (rawEmailInput) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (rawEmailInput.length > 150 || !emailRegex.test(rawEmailInput)) {
        throw new WorkerHttpError(400, 'INVALID_EMAIL', 'Valid email address is required.');
      }
    }

    const cleanPhone = typeof phone === 'string' ? phone.trim().slice(0, 20) : '';
    const cleanSubId = typeof subscriptionId === 'string' && subscriptionId.trim() ? subscriptionId.trim() : '';

    const [existingUserDoc, queriedUserSubs, explicitSubDoc] = await Promise.all([
      firestoreClient.getDocument<Record<string, unknown>>('users', targetUid),
      firestoreClient.runQuery<Record<string, unknown>>({
        collection: 'subscriptions',
        where: [{ field: 'userId', op: 'EQUAL', value: targetUid }]
      }),
      cleanSubId
        ? firestoreClient.getDocument<Record<string, unknown>>('subscriptions', cleanSubId)
        : Promise.resolve(null)
    ]);

    const targetSubMap = new Map<string, Record<string, unknown> & { id: string }>();
    for (const subDoc of queriedUserSubs) {
      if (String(subDoc.userId || '') === targetUid) {
        targetSubMap.set(subDoc.id, subDoc);
      }
    }
    if (explicitSubDoc) {
      if (explicitSubDoc.userId && String(explicitSubDoc.userId) !== targetUid) {
        throw new WorkerHttpError(
          403,
          'SUBSCRIPTION_USER_MISMATCH',
          'Subscription record does not belong to target user.'
        );
      }
      targetSubMap.set(explicitSubDoc.id, explicitSubDoc);
    }
    const allUserSubDocs = Array.from(targetSubMap.values()).sort(
      (a, b) =>
        new Date(timestampToIso(b.createdAt) || 0).getTime() -
        new Date(timestampToIso(a.createdAt) || 0).getTime()
    );

    const existingEmail =
      typeof existingUserDoc?.email === 'string' ? existingUserDoc.email.trim() : '';
    const resolvedEmail = rawEmailInput
      ? rawEmailInput.toLowerCase().slice(0, 150)
      : existingEmail;

    const existingExpiresIso = timestampToIso(existingUserDoc?.subscriptionExpiresAt);
    const effectiveUserExpiresIso = cleanExpiresIso || existingExpiresIso;
    const resolvedActivePackageId =
      typeof packageId === 'string' && packageId
        ? packageId
        : (existingUserDoc?.activePackageId as string | undefined) ?? null;
    const resolvedActivePackageNameBn =
      typeof packageNameBn === 'string' && packageNameBn
        ? packageNameBn
        : (existingUserDoc?.activePackageNameBn as string | undefined) ?? null;
    const resolvedActivePackageNameEn =
      typeof packageNameEn === 'string' && packageNameEn
        ? packageNameEn
        : (existingUserDoc?.activePackageNameEn as string | undefined) ?? null;

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
      createdAt: (existingUserDoc?.createdAt as string) || nowIso
    };

    const userFirestorePayload: Record<string, unknown> = {
      ...userPayloadForResponse,
      subscriptionExpiresAt: effectiveUserExpiresIso
        ? new FirestoreTimestampValue(effectiveUserExpiresIso)
        : null
    };
    if (!resolvedEmail) {
      delete userFirestorePayload.email;
    }

    const writes: FirestoreWriteOp[] = [
      {
        type: 'set',
        collection: 'users',
        docId: targetUid,
        data: userFirestorePayload,
        merge: true
      }
    ];

    let persistedSubscription: UserSubscription | null = null;
    const updatedSubscriptions: UserSubscription[] = [];

    if (safeSubStatus === 'pro') {
      const resolvedSubDoc =
        (cleanSubId ? targetSubMap.get(cleanSubId) : undefined) || allUserSubDocs[0] || null;
      const targetSubId = cleanSubId || resolvedSubDoc?.id || `sub_admin_${targetUid}`;
      const pkgMatch =
        INITIAL_PACKAGES.find(
          p => p.id === (packageId || resolvedSubDoc?.packageId)
        ) || INITIAL_PACKAGES[0];
      const effectiveExpiresIso =
        cleanExpiresIso ||
        timestampToIso(resolvedSubDoc?.expiresAt) ||
        new Date(nowMs + 90 * 24 * 3600 * 1000).toISOString();
      const activatedIso = timestampToIso(resolvedSubDoc?.activatedAt) || nowIso;

      const subFirestorePayload: Record<string, unknown> = {
        id: targetSubId,
        userId: targetUid,
        studentName: cleanName,
        studentPhone: cleanPhone,
        packageId: (typeof packageId === 'string' && packageId) || (resolvedSubDoc?.packageId as string) || pkgMatch.id,
        packageNameBn:
          (typeof packageNameBn === 'string' && packageNameBn) ||
          (resolvedSubDoc?.packageNameBn as string) ||
          pkgMatch.nameBn,
        packageNameEn:
          (typeof packageNameEn === 'string' && packageNameEn) ||
          (resolvedSubDoc?.packageNameEn as string) ||
          pkgMatch.nameEn,
        pricePaid:
          typeof resolvedSubDoc?.pricePaid === 'number' ? resolvedSubDoc.pricePaid : pkgMatch.price,
        paymentRequestId: (resolvedSubDoc?.paymentRequestId as string) || `admin_grant_${targetUid}`,
        paymentMethod: (resolvedSubDoc?.paymentMethod as string) || 'bKash',
        transactionId:
          (resolvedSubDoc?.transactionId as string) || `ADMIN_GRANT_${String(nowMs).slice(-6)}`,
        validityType:
          ((resolvedSubDoc?.validityType as 'days' | 'exam_date') || pkgMatch.validityType),
        status: 'active',
        activatedAt: new FirestoreTimestampValue(activatedIso),
        expiresAt: new FirestoreTimestampValue(effectiveExpiresIso),
        createdAt: timestampToIso(resolvedSubDoc?.createdAt) || nowIso,
        updatedAt: nowIso
      };

      writes.push({
        type: 'set',
        collection: 'subscriptions',
        docId: targetSubId,
        data: subFirestorePayload,
        merge: true
      });

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
        doc => String(doc.userId || '') === targetUid && (doc.status === 'active' || (cleanSubId && doc.id === cleanSubId))
      );

      for (const subDoc of subsToUpdate) {
        const isPrimaryEdited = Boolean(cleanSubId && subDoc.id === cleanSubId);
        const existingSubExpIso = timestampToIso(subDoc.expiresAt) || nowIso;
        const effectiveExpiresIso =
          isPrimaryEdited && cleanExpiresIso ? cleanExpiresIso : existingSubExpIso;
        const activatedIso = timestampToIso(subDoc.activatedAt) || nowIso;
        const pkgMatch =
          INITIAL_PACKAGES.find(
            p => p.id === (subDoc.packageId || packageId)
          ) || INITIAL_PACKAGES[0];

        const subFirestorePayload: Record<string, unknown> = {
          id: subDoc.id,
          userId: targetUid,
          studentName: isPrimaryEdited ? cleanName : String(subDoc.studentName || cleanName),
          studentPhone: isPrimaryEdited ? cleanPhone : String(subDoc.studentPhone || cleanPhone),
          packageId: (subDoc.packageId as string) || (typeof packageId === 'string' && packageId) || pkgMatch.id,
          packageNameBn: (subDoc.packageNameBn as string) || pkgMatch.nameBn,
          packageNameEn: (subDoc.packageNameEn as string) || pkgMatch.nameEn,
          pricePaid: typeof subDoc.pricePaid === 'number' ? subDoc.pricePaid : pkgMatch.price,
          paymentRequestId: (subDoc.paymentRequestId as string) || `admin_grant_${targetUid}`,
          paymentMethod: (subDoc.paymentMethod as string) || 'bKash',
          transactionId:
            (subDoc.transactionId as string) || `ADMIN_GRANT_${String(nowMs).slice(-6)}`,
          validityType:
            ((subDoc.validityType as 'days' | 'exam_date') || pkgMatch.validityType),
          status: nextSubStatus,
          activatedAt: new FirestoreTimestampValue(activatedIso),
          expiresAt: new FirestoreTimestampValue(effectiveExpiresIso),
          createdAt: timestampToIso(subDoc.createdAt) || nowIso,
          updatedAt: nowIso
        };

        writes.push({
          type: 'set',
          collection: 'subscriptions',
          docId: subDoc.id,
          data: subFirestorePayload,
          merge: true
        });

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

    const auditEntry: AuditLog = {
      id: makeAuditId(nowMs),
      userId: authUser.uid,
      userName: authUser.email || 'Owner Admin',
      action: 'USER_EDITED_BY_ADMIN',
      details: `Admin updated user ${targetUid} (role=${safeRole}, status=${safeSubStatus}, subsUpdated=${updatedSubscriptions.length}${
        isSessionRevoked ? ', session_revoked' : ''
      }).`,
      timestamp: nowIso
    };
    writes.push({
      type: 'set',
      collection: 'auditLogs',
      docId: auditEntry.id,
      data: { ...auditEntry }
    });

    await commitWritesChunked(firestoreClient, writes);

    if (isSessionRevoked) {
      // Authoritative Worker sessions live in D1 — revoke immediately so active student session is blocked
      await revokeUserSessionsByAdminD1(db, {
        uid: targetUid,
        reason: 'Revoked by administrator',
        nowIso
      });
    }

    return {
      status: 200,
      payload: {
        success: true,
        user: userPayloadForResponse,
        subscription: persistedSubscription,
        updatedSubscriptions,
        revokedSubscriptionCount: safeSubStatus === 'pro' ? 0 : updatedSubscriptions.length
      }
    };
  }

  if (pathname === '/api/admin/exams/save' && method === 'POST') {
    const authUser = await authenticateFirebaseRequest(ctx.request, {
      projectId,
      environment: env.ENVIRONMENT,
      jwksFetcher: ctx.jwksFetcher,
      tokenVerifier: ctx.tokenVerifier,
      nowMs
    });
    assertOwnerAdmin(authUser, env);

    const exam = (await parsePhase3JsonBody(ctx.request)) as unknown as Exam;
    if (!exam || typeof exam.id !== 'string' || !exam.id.trim()) {
      throw new WorkerHttpError(400, 'INVALID_EXAM', 'Valid exam id is required.');
    }
    const cleanExamId = exam.id.trim();
    const normalized: Exam = {
      ...exam,
      id: cleanExamId,
      isActive: exam.isActive !== undefined ? Boolean(exam.isActive) : !exam.isPaid,
      scheduledDate: exam.scheduledDate || undefined
    };

    const auditEntry: AuditLog = {
      id: makeAuditId(nowMs),
      userId: authUser.uid,
      userName: authUser.email || 'Owner Admin',
      action: 'SAVE_EXAM',
      details: `Saved exam ${normalized.id} (isActive=${normalized.isActive}, isPaid=${normalized.isPaid})`,
      timestamp: nowIso
    };

    await firestoreClient.commitWrites([
      {
        type: 'set',
        collection: 'exams',
        docId: cleanExamId,
        data: {
          ...normalized,
          scheduledDate: normalized.scheduledDate ?? null,
          updatedAt: nowIso
        },
        merge: true
      },
      {
        type: 'set',
        collection: 'auditLogs',
        docId: auditEntry.id,
        data: { ...auditEntry }
      }
    ]);

    return { status: 200, payload: { success: true, exam: normalized } };
  }

  if (pathname === '/api/admin/dashboard-stats' && method === 'GET') {
    const authUser = await authenticateFirebaseRequest(ctx.request, {
      projectId,
      environment: env.ENVIRONMENT,
      jwksFetcher: ctx.jwksFetcher,
      tokenVerifier: ctx.tokenVerifier,
      nowMs
    });
    assertOwnerAdmin(authUser, env);

    const [userDocs, payDocs, subDocs, resDocs] = await Promise.all([
      firestoreClient.listDocuments<Record<string, unknown>>('users', { pageSize: 500, maxPages: 10 }),
      firestoreClient.listDocuments<Record<string, unknown>>('paymentRequests', { pageSize: 500, maxPages: 10 }),
      firestoreClient.listDocuments<Record<string, unknown>>('subscriptions', { pageSize: 500, maxPages: 10 }),
      firestoreClient.listDocuments<Record<string, unknown>>('examResults', { pageSize: 500, maxPages: 10 })
    ]);

    const studentUserIds = new Set<string>();
    for (const u of userDocs) studentUserIds.add(u.id);
    for (const p of payDocs) if (p.userId) studentUserIds.add(String(p.userId));
    for (const s of subDocs) if (s.userId) studentUserIds.add(String(s.userId));
    for (const r of resDocs) if (r.userId) studentUserIds.add(String(r.userId));

    const payments = payDocs as unknown as PaymentRequest[];
    const subs = subDocs.map(raw => ({
      ...(raw as unknown as Omit<UserSubscription, 'id'>),
      id: raw.id,
      expiresAt: timestampToIso(raw.expiresAt) || new Date(0).toISOString()
    }));
    const results = resDocs as unknown as ExamResult[];

    const activeSubscribers = subs.filter(
      s => s.status === 'active' && new Date(s.expiresAt).getTime() > nowMs
    ).length;
    const expiredSubscriptions = subs.filter(
      s => s.status === 'expired' || new Date(s.expiresAt).getTime() <= nowMs
    ).length;

    const pendingPayments = payments.filter(p => p.status === 'pending').length;
    const approvedPayments = payments.filter(p => p.status === 'approved').length;
    const rejectedPayments = payments.filter(p => p.status === 'rejected').length;
    const totalVerifiedRevenue = payments
      .filter(p => p.status === 'approved')
      .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);

    return {
      status: 200,
      payload: {
        totalStudents: studentUserIds.size,
        activeSubscribers,
        pendingPayments,
        approvedPayments,
        rejectedPayments,
        expiredSubscriptions,
        totalVerifiedRevenue,
        totalExamsCompleted: results.length,
        monthlyRevenueReport: []
      }
    };
  }

  if (pathname === '/api/admin/audit-logs' && method === 'GET') {
    const authUser = await authenticateFirebaseRequest(ctx.request, {
      projectId,
      environment: env.ENVIRONMENT,
      jwksFetcher: ctx.jwksFetcher,
      tokenVerifier: ctx.tokenVerifier,
      nowMs
    });
    assertOwnerAdmin(authUser, env);

    const logs = await firestoreClient.listDocuments<Record<string, unknown>>('auditLogs', {
      pageSize: 500,
      maxPages: 5
    });
    const sorted = logs
      .map(d => d as unknown as AuditLog)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 200);

    return { status: 200, payload: { auditLogs: sorted } };
  }

  if (
    (pathname === '/api/admin/migrate-timestamps' ||
      pathname === '/api/admin/import-questions-to-firestore') &&
    method === 'POST'
  ) {
    const authUser = await authenticateFirebaseRequest(ctx.request, {
      projectId,
      environment: env.ENVIRONMENT,
      jwksFetcher: ctx.jwksFetcher,
      tokenVerifier: ctx.tokenVerifier,
      nowMs
    });
    assertOwnerAdmin(authUser, env);

    return {
      status: 501,
      payload: {
        error: 'CLI_MIGRATION_ONLY',
        message: 'Bulk migrations run via the offline admin script (scripts/migrateFirestoreData.ts), not edge requests.'
      }
    };
  }

  return null;
}
