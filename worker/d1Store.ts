import type { Exam, ExamAttempt, ExamResult, LeaderboardEntry, PaymentRequest } from '../src/types/index.ts';
import {
  WorkerHttpError,
  type AuditLog,
  type D1Database,
  type D1PreparedStatement,
  type StudentSession,
  type UserSubscription
} from './types.ts';
import {
  checkUserHasActiveSubscriptionRest,
  timestampToIso,
  type FirestoreRestClient
} from './firestoreRest.ts';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  retryAfterSeconds: number;
}

export async function consumeRateLimitD1(
  db: D1Database,
  options: {
    key: string;
    windowMs: number;
    maxRequests: number;
    nowMs?: number;
  }
): Promise<RateLimitResult> {
  const nowMs = options.nowMs ?? Date.now();
  const safeKey = options.key.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 180);
  const windowStartMs = Math.floor(nowMs / options.windowMs) * options.windowMs;
  const windowEndMs = windowStartMs + options.windowMs;
  const retryAfterSeconds = Math.max(1, Math.ceil((windowEndMs - nowMs) / 1000));
  const nowIso = new Date(nowMs).toISOString();

  const row = await db
    .prepare(
      `INSERT INTO rate_limits (bucket_key, window_start_ms, window_end_ms, count, updated_at)
       VALUES (?1, ?2, ?3, 1, ?4)
       ON CONFLICT(bucket_key) DO UPDATE SET
         count = CASE
           WHEN rate_limits.window_start_ms = excluded.window_start_ms THEN rate_limits.count + 1
           ELSE 1
         END,
         window_start_ms = excluded.window_start_ms,
         window_end_ms = excluded.window_end_ms,
         updated_at = excluded.updated_at
       RETURNING count`
    )
    .bind(safeKey, windowStartMs, windowEndMs, nowIso)
    .first<{ count: number }>();

  const nextCount = Number(row?.count ?? 1);
  if (nextCount > options.maxRequests) {
    return {
      allowed: false,
      remaining: 0,
      limit: options.maxRequests,
      retryAfterSeconds
    };
  }

  return {
    allowed: true,
    remaining: Math.max(0, options.maxRequests - nextCount),
    limit: options.maxRequests,
    retryAfterSeconds
  };
}

interface SessionRow {
  session_id: string;
  user_id: string;
  user_email: string;
  user_name: string;
  device_info: string;
  created_at: string;
  last_active_at: string;
  status: 'active' | 'revoked';
  revoked_reason: string | null;
}

function rowToStudentSession(row: SessionRow): StudentSession {
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    userEmail: row.user_email,
    userName: row.user_name,
    deviceInfo: row.device_info,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    status: row.status,
    ...(row.revoked_reason ? { revokedReason: row.revoked_reason } : {})
  };
}

export async function createOrReplaceSessionD1(
  db: D1Database,
  newSession: StudentSession
): Promise<{ session: StudentSession; previousSessionId?: string }> {
  const existingUserSess = await db
    .prepare(`SELECT active_session_id FROM user_sessions WHERE user_id = ?1`)
    .bind(newSession.userId)
    .first<{ active_session_id: string }>();

  const previousSessionId = existingUserSess?.active_session_id;
  const statements = [];

  if (previousSessionId) {
    statements.push(
      db
        .prepare(
          `UPDATE sessions
           SET status = 'revoked',
               revoked_reason = ?1
           WHERE session_id = ?2 AND status = 'active'`
        )
        .bind('Logged in from another device or tab (Single active session enforcement)', previousSessionId)
    );
  } else {
    statements.push(
      db
        .prepare(
          `UPDATE sessions
           SET status = 'revoked',
               revoked_reason = ?1
           WHERE user_id = ?2 AND status = 'active'`
        )
        .bind('Logged in from another device or tab (Single active session enforcement)', newSession.userId)
    );
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO sessions (
           session_id, user_id, user_email, user_name, device_info,
           created_at, last_active_at, status, revoked_reason
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active', NULL)`
      )
      .bind(
        newSession.sessionId,
        newSession.userId,
        newSession.userEmail,
        newSession.userName,
        newSession.deviceInfo,
        newSession.createdAt,
        newSession.lastActiveAt
      )
  );

  statements.push(
    db
      .prepare(
        `INSERT INTO user_sessions (user_id, active_session_id, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(user_id) DO UPDATE SET
           active_session_id = excluded.active_session_id,
           updated_at = excluded.updated_at`
      )
      .bind(newSession.userId, newSession.sessionId, newSession.createdAt)
  );

  await db.batch(statements);
  return { session: newSession, ...(previousSessionId ? { previousSessionId } : {}) };
}

export async function validateAndTouchSessionD1(
  db: D1Database,
  options: {
    sessionId: string;
    uid: string;
    nowIso?: string;
    touchMinIntervalMs?: number;
  }
): Promise<StudentSession> {
  const token = options.sessionId.trim();
  if (!token) {
    throw new WorkerHttpError(
      401,
      'SESSION_REQUIRED',
      'সক্রিয় ডিভাইস সেশন পাওয়া যায়নি। অনুগ্রহ করে পুনরায় সাইন ইন করুন।'
    );
  }

  const [sessRes, userSessRes] = await db.batch<SessionRow | { active_session_id: string }>([
    db
      .prepare(
        `SELECT session_id, user_id, user_email, user_name, device_info,
                created_at, last_active_at, status, revoked_reason
         FROM sessions WHERE session_id = ?1`
      )
      .bind(token),
    db.prepare(`SELECT active_session_id FROM user_sessions WHERE user_id = ?1`).bind(options.uid)
  ]);

  const sessRow = (sessRes.results[0] as SessionRow | undefined) || undefined;
  if (!sessRow) {
    throw new WorkerHttpError(
      401,
      'SESSION_REQUIRED',
      'সেশনটি খুঁজে পাওয়া যায়নি বা মেয়াদ শেষ হয়েছে। অনুগ্রহ করে পুনরায় সাইন ইন করুন।'
    );
  }

  if (sessRow.user_id !== options.uid) {
    throw new WorkerHttpError(403, 'SESSION_MISMATCH', 'Session does not match authenticated user.');
  }

  const userSessRow = (userSessRes.results[0] as { active_session_id: string } | undefined) || undefined;
  const currentActiveId = userSessRow?.active_session_id;

  if (sessRow.status === 'revoked' || (currentActiveId && currentActiveId !== token)) {
    if (sessRow.status !== 'revoked') {
      await db
        .prepare(
          `UPDATE sessions
           SET status = 'revoked', revoked_reason = ?1
           WHERE session_id = ?2`
        )
        .bind('Logged in from another device/browser', token)
        .run();
    }
    throw new WorkerHttpError(
      401,
      'SESSION_REVOKED',
      'একই অ্যাকাউন্ট অন্য ডিভাইস থেকে লগইন করা হয়েছে। আপনার পূর্ববর্তী সেশনটি বন্ধ করা হয়েছে।'
    );
  }

  const nowIso = options.nowIso || new Date().toISOString();
  const minInterval = options.touchMinIntervalMs ?? 0;
  const prevMs = new Date(sessRow.last_active_at).getTime();
  const nowMs = new Date(nowIso).getTime();

  if (minInterval <= 0 || isNaN(prevMs) || nowMs - prevMs >= minInterval) {
    await db
      .prepare(`UPDATE sessions SET last_active_at = ?1 WHERE session_id = ?2`)
      .bind(nowIso, token)
      .run();
    return {
      ...rowToStudentSession(sessRow),
      lastActiveAt: nowIso
    };
  }

  return rowToStudentSession(sessRow);
}

export async function revokeSessionOnLogoutD1(
  db: D1Database,
  options: { sessionId: string; uid: string; nowIso?: string }
): Promise<void> {
  const nowIso = options.nowIso || new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `UPDATE sessions
         SET status = 'revoked',
             revoked_reason = 'Logged out by user',
             last_active_at = ?1
         WHERE session_id = ?2 AND user_id = ?3`
      )
      .bind(nowIso, options.sessionId, options.uid),
    db
      .prepare(
        `DELETE FROM user_sessions
         WHERE user_id = ?1 AND active_session_id = ?2`
      )
      .bind(options.uid, options.sessionId)
  ]);
}

export async function revokeUserSessionsByAdminD1(
  db: D1Database,
  options: { uid: string; reason?: string; nowIso?: string }
): Promise<void> {
  const nowIso = options.nowIso || new Date().toISOString();
  const reason = options.reason || 'Revoked by administrator';
  await db.batch([
    db
      .prepare(
        `UPDATE sessions
         SET status = 'revoked',
             revoked_reason = ?1,
             last_active_at = ?2
         WHERE user_id = ?3 AND status = 'active'`
      )
      .bind(reason, nowIso, options.uid),
    db.prepare(`DELETE FROM user_sessions WHERE user_id = ?1`).bind(options.uid)
  ]);
}

// ---------------------------------------------------------
// KEYLESS EDGE COLLECTIONS (D1 Store for Exams, Payments,
// Subscriptions, Exam Attempts, Exam Results, Leaderboard, Audit Logs)
// ---------------------------------------------------------

function safeJsonParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function isUniqueConstraintError(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message || err || '');
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(msg);
}

// --- 1. Audit Logs ---

export async function writeAuditLogD1(
  db: D1Database,
  entry: AuditLog,
  syncedToFirestore = false
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO edge_audit_logs (id, user_id, action, timestamp, payload_json, synced_to_firestore)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(id) DO UPDATE SET
         payload_json = excluded.payload_json,
         synced_to_firestore = MAX(edge_audit_logs.synced_to_firestore, excluded.synced_to_firestore)`
    )
    .bind(entry.id, entry.userId, entry.action, entry.timestamp, JSON.stringify(entry), syncedToFirestore ? 1 : 0)
    .run();
}

export async function listAuditLogsD1(db: D1Database, limit = 200): Promise<AuditLog[]> {
  const res = await db
    .prepare(`SELECT payload_json FROM edge_audit_logs ORDER BY timestamp DESC LIMIT ?1`)
    .bind(Math.max(1, Math.min(500, limit)))
    .all<{ payload_json: string }>();

  const out: AuditLog[] = [];
  for (const row of res.results) {
    const parsed = safeJsonParse<AuditLog>(row.payload_json);
    if (parsed) out.push(parsed);
  }
  return out;
}

export async function listUnsyncedAuditLogsD1(db: D1Database, limit = 100): Promise<AuditLog[]> {
  const res = await db
    .prepare(`SELECT payload_json FROM edge_audit_logs WHERE synced_to_firestore = 0 ORDER BY timestamp ASC LIMIT ?1`)
    .bind(Math.max(1, Math.min(200, limit)))
    .all<{ payload_json: string }>();

  const out: AuditLog[] = [];
  for (const row of res.results) {
    const parsed = safeJsonParse<AuditLog>(row.payload_json);
    if (parsed) out.push(parsed);
  }
  return out;
}

export async function markAuditLogsSyncedD1(db: D1Database, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    const placeholders = chunk.map((_, idx) => `?${idx + 1}`).join(', ');
    await db
      .prepare(`UPDATE edge_audit_logs SET synced_to_firestore = 1 WHERE id IN (${placeholders})`)
      .bind(...chunk)
      .run();
  }
}

// --- 2. Exams Cache ---

export async function upsertExamCacheD1(
  db: D1Database,
  exam: Exam,
  updatedAt: string = new Date().toISOString()
): Promise<void> {
  const isActive = exam.isActive !== undefined ? Boolean(exam.isActive) : !exam.isPaid;
  const normalized: Exam = {
    ...exam,
    isActive
  };
  await db
    .prepare(
      `INSERT INTO edge_exams_cache (id, is_paid, is_active, payload_json, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(id) DO UPDATE SET
         is_paid = excluded.is_paid,
         is_active = excluded.is_active,
         payload_json = excluded.payload_json,
         updated_at = excluded.updated_at`
    )
    .bind(normalized.id, normalized.isPaid ? 1 : 0, isActive ? 1 : 0, JSON.stringify(normalized), updatedAt)
    .run();
}

export async function upsertExamsBatchD1(
  db: D1Database,
  exams: Exam[],
  updatedAt: string = new Date().toISOString()
): Promise<void> {
  if (exams.length === 0) return;
  const stmts: D1PreparedStatement[] = exams.map(exam => {
    const isActive = exam.isActive !== undefined ? Boolean(exam.isActive) : !exam.isPaid;
    const normalized: Exam = { ...exam, isActive };
    return db
      .prepare(
        `INSERT INTO edge_exams_cache (id, is_paid, is_active, payload_json, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET
           is_paid = excluded.is_paid,
           is_active = excluded.is_active,
           payload_json = excluded.payload_json,
           updated_at = excluded.updated_at`
      )
      .bind(normalized.id, normalized.isPaid ? 1 : 0, isActive ? 1 : 0, JSON.stringify(normalized), updatedAt);
  });
  for (let i = 0; i < stmts.length; i += 40) {
    await db.batch(stmts.slice(i, i + 40));
  }
}

export async function getExamFromCacheD1(db: D1Database, examId: string): Promise<Exam | null> {
  const row = await db
    .prepare(`SELECT payload_json FROM edge_exams_cache WHERE id = ?1`)
    .bind(examId)
    .first<{ payload_json: string }>();
  if (!row) return null;
  return safeJsonParse<Exam>(row.payload_json);
}

export async function listExamsFromCacheD1(db: D1Database): Promise<Exam[]> {
  const res = await db
    .prepare(`SELECT payload_json FROM edge_exams_cache ORDER BY id ASC`)
    .all<{ payload_json: string }>();
  const out: Exam[] = [];
  for (const row of res.results) {
    const parsed = safeJsonParse<Exam>(row.payload_json);
    if (parsed) out.push(parsed);
  }
  return out;
}

// --- 3. Payment Requests ---

export async function insertPaymentRequestAtomicD1(
  db: D1Database,
  reqItem: PaymentRequest,
  auditEntry: AuditLog,
  syncedToFirestore = false
): Promise<void> {
  const updatedAt = reqItem.requestedAt || new Date().toISOString();
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO edge_payment_requests (
             id, transaction_id, user_id, status, requested_at, payload_json, synced_to_firestore, updated_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
        )
        .bind(
          reqItem.id,
          reqItem.transactionId,
          reqItem.userId,
          reqItem.status,
          reqItem.requestedAt,
          JSON.stringify(reqItem),
          syncedToFirestore ? 1 : 0,
          updatedAt
        ),
      db
        .prepare(
          `INSERT INTO edge_audit_logs (id, user_id, action, timestamp, payload_json, synced_to_firestore)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
        )
        .bind(
          auditEntry.id,
          auditEntry.userId,
          auditEntry.action,
          auditEntry.timestamp,
          JSON.stringify(auditEntry),
          syncedToFirestore ? 1 : 0
        )
    ]);
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      const existing = await findPaymentRequestByTrxIdD1(db, reqItem.transactionId);
      throw new WorkerHttpError(
        409,
        'DUPLICATE_TRX_ID',
        existing?.status === 'rejected'
          ? 'এই ট্রানজাকশন আইডিটি (TrxID) পূর্বে বাতিল করা হয়েছে এবং পুনরায় জমা দেওয়া যাবে না।'
          : 'এই ট্রানজাকশন আইডিটি (TrxID) ইতিপূর্বে সিস্টেমে নিবন্ধিত হয়েছে। পুনরায় জমা দেওয়া সম্ভব নয়।'
      );
    }
    throw err;
  }
}

export async function upsertPaymentRequestD1(
  db: D1Database,
  reqItem: PaymentRequest,
  syncedToFirestore = true,
  updatedAt: string = new Date().toISOString()
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO edge_payment_requests (
         id, transaction_id, user_id, status, requested_at, payload_json, synced_to_firestore, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         payload_json = excluded.payload_json,
         synced_to_firestore = excluded.synced_to_firestore,
         updated_at = excluded.updated_at`
    )
    .bind(
      reqItem.id,
      reqItem.transactionId,
      reqItem.userId,
      reqItem.status,
      reqItem.requestedAt,
      JSON.stringify(reqItem),
      syncedToFirestore ? 1 : 0,
      updatedAt
    )
    .run();
}

export async function getPaymentRequestD1(db: D1Database, id: string): Promise<PaymentRequest | null> {
  const row = await db
    .prepare(`SELECT payload_json FROM edge_payment_requests WHERE id = ?1`)
    .bind(id)
    .first<{ payload_json: string }>();
  return row ? safeJsonParse<PaymentRequest>(row.payload_json) : null;
}

export async function findPaymentRequestByTrxIdD1(
  db: D1Database,
  transactionId: string
): Promise<PaymentRequest | null> {
  const row = await db
    .prepare(`SELECT payload_json FROM edge_payment_requests WHERE transaction_id = ?1`)
    .bind(transactionId)
    .first<{ payload_json: string }>();
  return row ? safeJsonParse<PaymentRequest>(row.payload_json) : null;
}

export async function listPaymentRequestsD1(
  db: D1Database,
  userId?: string
): Promise<PaymentRequest[]> {
  const res = userId
    ? await db
        .prepare(`SELECT payload_json FROM edge_payment_requests WHERE user_id = ?1 ORDER BY requested_at DESC`)
        .bind(userId)
        .all<{ payload_json: string }>()
    : await db
        .prepare(`SELECT payload_json FROM edge_payment_requests ORDER BY requested_at DESC`)
        .all<{ payload_json: string }>();

  const out: PaymentRequest[] = [];
  for (const row of res.results) {
    const parsed = safeJsonParse<PaymentRequest>(row.payload_json);
    if (parsed) out.push(parsed);
  }
  return out;
}

export async function listUnsyncedPaymentRequestsD1(db: D1Database): Promise<PaymentRequest[]> {
  const res = await db
    .prepare(`SELECT payload_json FROM edge_payment_requests WHERE synced_to_firestore = 0 ORDER BY requested_at ASC`)
    .all<{ payload_json: string }>();

  const out: PaymentRequest[] = [];
  for (const row of res.results) {
    const parsed = safeJsonParse<PaymentRequest>(row.payload_json);
    if (parsed) out.push(parsed);
  }
  return out;
}

export async function markPaymentsSyncedD1(db: D1Database, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    const placeholders = chunk.map((_, idx) => `?${idx + 1}`).join(', ');
    await db
      .prepare(`UPDATE edge_payment_requests SET synced_to_firestore = 1 WHERE id IN (${placeholders})`)
      .bind(...chunk)
      .run();
  }
}

// --- 4. Subscriptions ---

export async function upsertSubscriptionD1(
  db: D1Database,
  sub: UserSubscription,
  syncedToFirestore = true
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO edge_subscriptions (
         id, user_id, transaction_id, status, expires_at, created_at, payload_json, synced_to_firestore
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         expires_at = excluded.expires_at,
         payload_json = excluded.payload_json,
         synced_to_firestore = excluded.synced_to_firestore`
    )
    .bind(
      sub.id,
      sub.userId,
      sub.transactionId,
      sub.status,
      sub.expiresAt,
      sub.createdAt,
      JSON.stringify(sub),
      syncedToFirestore ? 1 : 0
    )
    .run();
}

export async function findSubscriptionByTrxIdD1(
  db: D1Database,
  transactionId: string
): Promise<UserSubscription | null> {
  const row = await db
    .prepare(`SELECT payload_json FROM edge_subscriptions WHERE transaction_id = ?1 LIMIT 1`)
    .bind(transactionId)
    .first<{ payload_json: string }>();
  return row ? safeJsonParse<UserSubscription>(row.payload_json) : null;
}

export async function getActiveSubscriptionD1(
  db: D1Database,
  userId: string,
  nowMs: number = Date.now()
): Promise<UserSubscription | null> {
  const nowIso = new Date(nowMs).toISOString();
  const row = await db
    .prepare(
      `SELECT payload_json FROM edge_subscriptions
       WHERE user_id = ?1 AND status = 'active' AND expires_at > ?2
       ORDER BY expires_at DESC LIMIT 1`
    )
    .bind(userId, nowIso)
    .first<{ payload_json: string }>();
  return row ? safeJsonParse<UserSubscription>(row.payload_json) : null;
}

export async function listSubscriptionsD1(db: D1Database): Promise<UserSubscription[]> {
  const res = await db
    .prepare(`SELECT payload_json FROM edge_subscriptions ORDER BY created_at DESC`)
    .all<{ payload_json: string }>();
  const out: UserSubscription[] = [];
  for (const row of res.results) {
    const parsed = safeJsonParse<UserSubscription>(row.payload_json);
    if (parsed) out.push(parsed);
  }
  return out;
}

export async function expireOrCancelUserSubscriptionsD1(
  db: D1Database,
  userId: string,
  nextStatus: 'expired' | 'cancelled'
): Promise<void> {
  const res = await db
    .prepare(`SELECT payload_json FROM edge_subscriptions WHERE user_id = ?1 AND status = 'active'`)
    .bind(userId)
    .all<{ payload_json: string }>();
  if (res.results.length === 0) return;

  const stmts: D1PreparedStatement[] = [];
  for (const row of res.results) {
    const parsed = safeJsonParse<UserSubscription>(row.payload_json);
    if (!parsed) continue;
    const updated: UserSubscription = { ...parsed, status: nextStatus };
    stmts.push(
      db
        .prepare(
          `UPDATE edge_subscriptions
           SET status = ?1, payload_json = ?2, synced_to_firestore = 1
           WHERE id = ?3`
        )
        .bind(nextStatus, JSON.stringify(updated), parsed.id)
    );
  }
  if (stmts.length > 0) {
    await db.batch(stmts);
  }
}

export async function checkUserHasActiveSubscriptionKeyless(
  db: D1Database,
  userClient: FirestoreRestClient,
  uid: string,
  nowMs: number = Date.now()
): Promise<{ active: boolean; activeSubscription: UserSubscription | null; reason?: string }> {
  const [restStatus, d1Sub] = await Promise.all([
    checkUserHasActiveSubscriptionRest(userClient, uid, nowMs).catch(() => ({
      active: false,
      activeSubscription: null as UserSubscription | null,
      reason: 'FIRESTORE_UNAVAILABLE',
      firestoreReachable: false
    })),
    getActiveSubscriptionD1(db, uid, nowMs)
  ]);

  if (restStatus.active) {
    if (restStatus.activeSubscription) {
      await upsertSubscriptionD1(db, restStatus.activeSubscription, true).catch(() => undefined);
    }
    return {
      active: true,
      activeSubscription: restStatus.activeSubscription || d1Sub
    };
  }

  if (restStatus.firestoreReachable !== false) {
    if (d1Sub) {
      await expireOrCancelUserSubscriptionsD1(db, uid, 'cancelled').catch(() => undefined);
    }
    return { active: false, activeSubscription: null, reason: 'NO_ACTIVE_SUBSCRIPTION' };
  }

  if (d1Sub && new Date(d1Sub.expiresAt).getTime() > nowMs && d1Sub.status === 'active') {
    return {
      active: true,
      activeSubscription: d1Sub,
      reason: 'D1_EDGE_FALLBACK'
    };
  }

  return { active: false, activeSubscription: null, reason: 'NO_ACTIVE_SUBSCRIPTION' };
}

// --- 5. Exam Attempts, Results & Leaderboard ---

export type StoredExamAttempt = ExamAttempt & { resolvedQuestionIds?: string[] };

export async function insertExamAttemptD1(
  db: D1Database,
  attempt: StoredExamAttempt,
  auditEntry?: AuditLog
): Promise<void> {
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO edge_exam_attempts (
           id, exam_id, user_id, status, start_time, deadline_time, last_saved_at, submitted_time, payload_json, synced_to_firestore
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, 0)`
      )
      .bind(
        attempt.id,
        attempt.examId,
        attempt.userId,
        attempt.status,
        attempt.startTime,
        attempt.deadlineTime,
        attempt.lastSavedAt,
        JSON.stringify(attempt)
      )
  ];

  if (auditEntry) {
    statements.push(
      db
        .prepare(
          `INSERT INTO edge_audit_logs (id, user_id, action, timestamp, payload_json, synced_to_firestore)
           VALUES (?1, ?2, ?3, ?4, ?5, 0)`
        )
        .bind(auditEntry.id, auditEntry.userId, auditEntry.action, auditEntry.timestamp, JSON.stringify(auditEntry))
    );
  }

  await db.batch(statements);
}

export async function getExamAttemptD1(db: D1Database, attemptId: string): Promise<StoredExamAttempt | null> {
  const row = await db
    .prepare(`SELECT payload_json FROM edge_exam_attempts WHERE id = ?1`)
    .bind(attemptId)
    .first<{ payload_json: string }>();
  return row ? safeJsonParse<StoredExamAttempt>(row.payload_json) : null;
}

export async function updateExamAttemptProgressD1(
  db: D1Database,
  attempt: StoredExamAttempt
): Promise<void> {
  await db
    .prepare(
      `UPDATE edge_exam_attempts
       SET last_saved_at = ?1, payload_json = ?2
       WHERE id = ?3 AND user_id = ?4 AND status = 'in_progress'`
    )
    .bind(attempt.lastSavedAt, JSON.stringify(attempt), attempt.id, attempt.userId)
    .run();
}

export async function commitExamSubmissionD1(
  db: D1Database,
  params: {
    attempt: StoredExamAttempt;
    result: ExamResult;
    leaderboardEntry: LeaderboardEntry;
    auditEntry: AuditLog;
  }
): Promise<void> {
  const { attempt, result, leaderboardEntry, auditEntry } = params;
  await db.batch([
    db
      .prepare(
        `UPDATE edge_exam_attempts
         SET status = ?1, submitted_time = ?2, last_saved_at = ?2, payload_json = ?3, synced_to_firestore = 0
         WHERE id = ?4 AND status = 'in_progress'`
      )
      .bind(attempt.status, attempt.submittedTime || attempt.lastSavedAt, JSON.stringify(attempt), attempt.id),
    db
      .prepare(
        `INSERT INTO edge_exam_results (
           id, attempt_id, exam_id, user_id, submitted_at, final_score, payload_json, synced_to_firestore
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)`
      )
      .bind(
        result.id,
        result.attemptId,
        result.examId,
        result.userId,
        result.submittedAt,
        result.finalScore,
        JSON.stringify(result)
      ),
    db
      .prepare(
        `INSERT INTO edge_leaderboard (
           id, user_id, exam_id, score, time_spent_seconds, completed_at, payload_json, synced_to_firestore
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)
         ON CONFLICT(id) DO UPDATE SET
           score = excluded.score,
           time_spent_seconds = excluded.time_spent_seconds,
           completed_at = excluded.completed_at,
           payload_json = excluded.payload_json,
           synced_to_firestore = 0`
      )
      .bind(
        leaderboardEntry.id,
        leaderboardEntry.userId,
        leaderboardEntry.examId,
        leaderboardEntry.score,
        leaderboardEntry.timeSpentSeconds,
        leaderboardEntry.completedAt,
        JSON.stringify(leaderboardEntry)
      ),
    db
      .prepare(
        `INSERT INTO edge_audit_logs (id, user_id, action, timestamp, payload_json, synced_to_firestore)
         VALUES (?1, ?2, ?3, ?4, ?5, 0)`
      )
      .bind(auditEntry.id, auditEntry.userId, auditEntry.action, auditEntry.timestamp, JSON.stringify(auditEntry))
  ]);
}

export async function listExamResultsByUserD1(db: D1Database, userId: string): Promise<ExamResult[]> {
  const res = await db
    .prepare(`SELECT payload_json FROM edge_exam_results WHERE user_id = ?1 ORDER BY submitted_at DESC`)
    .bind(userId)
    .all<{ payload_json: string }>();
  const out: ExamResult[] = [];
  for (const row of res.results) {
    const parsed = safeJsonParse<ExamResult>(row.payload_json);
    if (parsed) out.push(parsed);
  }
  return out;
}

export async function listAllExamResultsD1(db: D1Database): Promise<ExamResult[]> {
  const res = await db
    .prepare(`SELECT payload_json FROM edge_exam_results ORDER BY submitted_at DESC`)
    .all<{ payload_json: string }>();
  const out: ExamResult[] = [];
  for (const row of res.results) {
    const parsed = safeJsonParse<ExamResult>(row.payload_json);
    if (parsed) out.push(parsed);
  }
  return out;
}

export async function listUnsyncedExamResultsD1(db: D1Database, limit = 100): Promise<ExamResult[]> {
  const res = await db
    .prepare(`SELECT payload_json FROM edge_exam_results WHERE synced_to_firestore = 0 ORDER BY submitted_at ASC LIMIT ?1`)
    .bind(limit)
    .all<{ payload_json: string }>();
  const out: ExamResult[] = [];
  for (const row of res.results) {
    const parsed = safeJsonParse<ExamResult>(row.payload_json);
    if (parsed) out.push(parsed);
  }
  return out;
}

export async function markExamResultsSyncedD1(db: D1Database, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    const placeholders = chunk.map((_, idx) => `?${idx + 1}`).join(', ');
    await db
      .prepare(`UPDATE edge_exam_results SET synced_to_firestore = 1 WHERE id IN (${placeholders})`)
      .bind(...chunk)
      .run();
  }
}

export async function listUnsyncedExamAttemptsD1(db: D1Database, limit = 100): Promise<StoredExamAttempt[]> {
  const res = await db
    .prepare(`SELECT payload_json FROM edge_exam_attempts WHERE synced_to_firestore = 0 ORDER BY start_time ASC LIMIT ?1`)
    .bind(limit)
    .all<{ payload_json: string }>();
  const out: StoredExamAttempt[] = [];
  for (const row of res.results) {
    const parsed = safeJsonParse<StoredExamAttempt>(row.payload_json);
    if (parsed) out.push(parsed);
  }
  return out;
}

export async function markExamAttemptsSyncedD1(db: D1Database, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    const placeholders = chunk.map((_, idx) => `?${idx + 1}`).join(', ');
    await db
      .prepare(`UPDATE edge_exam_attempts SET synced_to_firestore = 1 WHERE id IN (${placeholders})`)
      .bind(...chunk)
      .run();
  }
}

export async function listLeaderboardEntriesD1(db: D1Database, examId?: string): Promise<LeaderboardEntry[]> {
  const res =
    examId && examId !== 'all'
      ? await db
          .prepare(
            `SELECT payload_json FROM edge_leaderboard WHERE exam_id = ?1 ORDER BY score DESC, time_spent_seconds ASC LIMIT 100`
          )
          .bind(examId)
          .all<{ payload_json: string }>()
      : await db
          .prepare(`SELECT payload_json FROM edge_leaderboard ORDER BY score DESC, time_spent_seconds ASC LIMIT 100`)
          .all<{ payload_json: string }>();

  const out: LeaderboardEntry[] = [];
  for (const row of res.results) {
    const parsed = safeJsonParse<LeaderboardEntry>(row.payload_json);
    if (parsed) out.push(parsed);
  }
  return out;
}

export async function listUnsyncedLeaderboardD1(db: D1Database, limit = 100): Promise<LeaderboardEntry[]> {
  const res = await db
    .prepare(`SELECT payload_json FROM edge_leaderboard WHERE synced_to_firestore = 0 ORDER BY completed_at ASC LIMIT ?1`)
    .bind(limit)
    .all<{ payload_json: string }>();
  const out: LeaderboardEntry[] = [];
  for (const row of res.results) {
    const parsed = safeJsonParse<LeaderboardEntry>(row.payload_json);
    if (parsed) out.push(parsed);
  }
  return out;
}

export async function markLeaderboardSyncedD1(db: D1Database, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    const placeholders = chunk.map((_, idx) => `?${idx + 1}`).join(', ');
    await db
      .prepare(`UPDATE edge_leaderboard SET synced_to_firestore = 1 WHERE id IN (${placeholders})`)
      .bind(...chunk)
      .run();
  }
}

export function normalizeSubscriptionDoc(
  raw: Record<string, unknown> & { id: string },
  fallbackIso: string
): UserSubscription {
  return {
    ...(raw as unknown as Omit<UserSubscription, 'id'>),
    id: raw.id,
    activatedAt: timestampToIso(raw.activatedAt) || fallbackIso,
    expiresAt: timestampToIso(raw.expiresAt) || new Date(0).toISOString(),
    createdAt: timestampToIso(raw.createdAt) || fallbackIso
  };
}
