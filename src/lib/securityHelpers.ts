import type { PaymentRequest } from '../types';

export interface BackendApiResult<T> {
  ok: boolean;
  status: number;
  code?: string;
  message?: string;
  data?: T;
}

/**
 * Normalizes and validates HTTP status + API error codes into clear user-facing messages.
 */
export function formatBackendApiError(params: {
  status: number;
  code?: string;
  serverMessage?: string;
  isJson?: boolean;
}): string {
  const { status, code, serverMessage, isJson = true } = params;

  if (code === 'SESSION_REVOKED') {
    return (
      serverMessage ||
      'একই অ্যাকাউন্ট অন্য ডিভাইস থেকে লগইন করা হয়েছে। অনুগ্রহ করে পুনরায় লগইন করুন।'
    );
  }

  if (code === 'SESSION_REQUIRED' || code === 'SESSION_MISMATCH') {
    return (
      serverMessage ||
      'সক্রিয় ডিভাইস সেশন যাচাই করা যায়নি। অনুগ্রহ করে সেশন পুনরায় সক্রিয় করুন অথবা লগইন করুন।'
    );
  }

  if (code === 'EMAIL_NOT_VERIFIED') {
    return (
      serverMessage ||
      'আপনার ইমেইল ঠিকানা এখনও যাচাই (Verify) করা হয়নি। অনুগ্রহ করে ইমেইল ইনবক্সের ভেরিফিকেশন লিংকে ক্লিক করুন।'
    );
  }

  if (
    code === 'RESOURCE_EXHAUSTED' ||
    code === 'FIRESTORE_QUOTA_EXHAUSTED' ||
    (status === 429 &&
      code !== 'RATE_LIMITED' &&
      typeof serverMessage === 'string' &&
      /quota|resource_exhausted/i.test(serverMessage))
  ) {
    return (
      serverMessage ||
      'Firestore-এর দৈনিক কোটা সীমা অতিক্রম করেছে (429 RESOURCE_EXHAUSTED)। D1 ক্যাশ থেকে সংরক্ষিত তথ্য নিরাপদ রয়েছে।'
    );
  }

  if (status === 429 || code === 'RATE_LIMITED') {
    return (
      serverMessage ||
      'অল্প সময়ে অতিরিক্ত অনুরোধ পাঠানো হয়েছে (429)। অনুগ্রহ করে কিছুক্ষণ অপেক্ষা করে পুনরায় চেষ্টা করুন।'
    );
  }

  if (status === 401 || code === 'UNAUTHORIZED' || code === 'INVALID_TOKEN') {
    return (
      serverMessage ||
      'আপনার লগইন সেশন যাচাই করা যায়নি (401)। অনুগ্রহ করে পুনরায় সাইন ইন করুন।'
    );
  }

  if (status === 403 || code === 'FORBIDDEN' || code === 'PERMISSION_DENIED') {
    return (
      serverMessage ||
      'অননুমোদিত অনুরোধ (403): এই কাজটি করার জন্য আপনার প্রয়োজনীয় অনুমতি নেই।'
    );
  }

  if (status === 409 || code === 'DUPLICATE_TRX_ID' || code === 'ALREADY_EXISTS' || code === 'TRX_ALREADY_APPROVED') {
    return (
      serverMessage ||
      'তথ্যের দ্বন্দ্ব (409): এই রেকর্ডটি ইতিপূর্বে জমা দেওয়া হয়েছে।'
    );
  }

  if (status === 503 || code === 'FIRESTORE_UNAVAILABLE') {
    return 'ব্যাকএন্ড সার্ভার বা ডাটাবেজ বর্তমানে অনুপলব্ধ (503)। অনুগ্রহ করে কিছুক্ষণ পর পুনরায় চেষ্টা করুন।';
  }

  if (status >= 500) {
    return isJson && serverMessage
      ? serverMessage
      : `ব্যাকএন্ড সার্ভারে ত্রুটি (${status})। অনুগ্রহ করে কিছুক্ষণ পর পুনরায় চেষ্টা করুন।`;
  }

  if (code === 'NETWORK_ERROR' || status === 0) {
    return 'ব্যাকএন্ড সার্ভারের সাথে সংযোগ স্থাপন করা যায়নি। ইন্টারনেট সংযোগ পরীক্ষা করে পুনরায় চেষ্টা করুন।';
  }

  if (code === 'NON_JSON_RESPONSE' || !isJson) {
    return 'ব্যাকএন্ড API থেকে অপ্রত্যাশিত রেসপন্স পাওয়া গেছে (Backend unavailable)। অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন।';
  }

  return serverMessage || 'অনুরোধটি সম্পন্ন করা যায়নি। অনুগ্রহ করে পুনরায় চেষ্টা করুন।';
}

export function isBackendUnavailableResponse<T>(res: BackendApiResult<T>): boolean {
  return (
    res.status === 0 ||
    res.status >= 500 ||
    res.code === 'NETWORK_ERROR' ||
    res.code === 'NON_JSON_RESPONSE' ||
    res.code === 'FIRESTORE_UNAVAILABLE'
  );
}

/**
 * Authoritative frontend payment submission helper.
 * - Strictly requires authenticated backend API (/api/payments/create).
 * - NEVER accepts or sends client-side price/amount as authoritative.
 * - NEVER falls back to direct Firestore payment writes on network error, non-JSON, HTTP 500, or 503.
 */
export async function submitPaymentViaAuthoritativeBackend(params: {
  authenticatedUid?: string | null;
  method: 'bKash' | 'Nagad' | 'Rocket';
  studentPhone?: string;
  senderNumber: string;
  transactionId: string;
  packageId: string;
  studentName?: string;
  existingRequests: Pick<PaymentRequest, 'id' | 'transactionId' | 'status'>[];
  apiBaseUrl?: string;
  isProduction?: boolean;
  callCreatePaymentApi: (payload: {
    method: 'bKash' | 'Nagad' | 'Rocket';
    studentPhone?: string;
    senderNumber: string;
    transactionId: string;
    packageId: string;
    studentName?: string;
  }) => Promise<BackendApiResult<{ success: boolean; message: string; paymentRequest: PaymentRequest }>>;
  onUnauthorized?: () => void;
  onSessionRevoked?: (reason: string) => void;
}): Promise<{ success: boolean; paymentRequest?: PaymentRequest; error?: string }> {
  const {
    authenticatedUid,
    method,
    studentPhone,
    senderNumber,
    transactionId,
    packageId,
    studentName,
    existingRequests,
    callCreatePaymentApi,
    onUnauthorized,
    onSessionRevoked
  } = params;

  if (!authenticatedUid) {
    onUnauthorized?.();
    return {
      success: false,
      error: 'পেমেন্ট রিকোয়েস্ট পাঠাতে অনুগ্রহ করে প্রথমে আপনার অ্যাকাউন্টে লগইন করুন।'
    };
  }

  const cleanTrxId = String(transactionId || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

  if (cleanTrxId.length < 4 || cleanTrxId.length > 64) {
    return {
      success: false,
      error: 'সঠিক ট্রানজাকশন আইডি (TrxID) প্রদান করুন (৪–৬৪ অক্ষর)।'
    };
  }

  const cleanSender = String(senderNumber || '').trim();
  if (!cleanSender) {
    return {
      success: false,
      error: 'অনুগ্রহ করে টাকা পাঠানোর মোবাইল নম্বর প্রদান করুন।'
    };
  }

  if (!packageId || !String(packageId).trim()) {
    return {
      success: false,
      error: 'অনুগ্রহ করে একটি বৈধ সাবস্ক্রিপশন প্যাকেজ নির্বাচন করুন।'
    };
  }

  const duplicate = existingRequests.find(
    p => p.id === `trx_${cleanTrxId}` || p.transactionId === cleanTrxId
  );
  if (duplicate) {
    return {
      success: false,
      error:
        duplicate.status === 'rejected'
          ? 'এই ট্রানজাকশন আইডিটি (TrxID) পূর্বে বাতিল করা হয়েছে এবং পুনরায় জমা দেওয়া যাবে না।'
          : 'এই ট্রানজাকশন আইডিটি (TrxID) ইতিপূর্বে জমা দেওয়া হয়েছে। একই TrxID পুনরাবৃত্তি গ্রহণযোগ্য নয়।'
    };
  }

  // Call backend API strictly without sending any client-calculated amount
  const apiRes = await callCreatePaymentApi({
    method,
    studentPhone,
    senderNumber: cleanSender,
    transactionId: cleanTrxId,
    packageId: String(packageId).trim(),
    studentName
  });

  if (apiRes.ok && apiRes.data?.success && apiRes.data.paymentRequest) {
    return {
      success: true,
      paymentRequest: apiRes.data.paymentRequest
    };
  }

  if (apiRes.code === 'SESSION_REVOKED') {
    onSessionRevoked?.(apiRes.message || 'Session revoked');
  } else if (apiRes.status === 401) {
    onUnauthorized?.();
  }

  return {
    success: false,
    error: formatBackendApiError({
      status: apiRes.status,
      code: apiRes.code,
      serverMessage: apiRes.message,
      isJson: apiRes.code !== 'NON_JSON_RESPONSE'
    })
  };
}

/**
 * Authoritative admin API execution helper.
 * - Rejects non-owner calls immediately.
 * - Awaits backend API response before allowing caller to commit state or report success.
 * - Never suppresses errors silently and never falls back to client-side writes.
 */
export async function executeAuthoritativeAdminApi<T>(params: {
  isVerifiedOwner: boolean;
  operation: () => Promise<BackendApiResult<T>>;
  onUnauthorized?: () => void;
  onSessionRevoked?: (reason: string) => void;
}): Promise<{ success: boolean; data?: T; error?: string }> {
  const { isVerifiedOwner, operation, onUnauthorized, onSessionRevoked } = params;

  if (!isVerifiedOwner) {
    return {
      success: false,
      error: 'অননুমোদিত চেষ্টা: শুধুমাত্র যাচাইকৃত সুপার অ্যাডমিন এই পরিবর্তন করতে পারবেন।'
    };
  }

  const res = await operation();
  if (res.ok && res.data !== undefined) {
    return {
      success: true,
      data: res.data
    };
  }

  if (res.code === 'SESSION_REVOKED') {
    onSessionRevoked?.(res.message || 'Session revoked');
  } else if (res.status === 401) {
    onUnauthorized?.();
  }

  return {
    success: false,
    error: formatBackendApiError({
      status: res.status,
      code: res.code,
      serverMessage: res.message,
      isJson: res.code !== 'NON_JSON_RESPONSE'
    })
  };
}
