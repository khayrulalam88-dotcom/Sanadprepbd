import { WorkerHttpError, type D1Database, type StudentSession } from './types.ts';

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

  // Atomic single-statement fixed-window upsert in SQLite/D1.
  // Note: If the bucket has already reached maxRequests inside the same window,
  // we cap/preserve or check the returned count without requiring a separate read first.
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
    // Also ensure any lingering active session for this user_id is marked revoked
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

