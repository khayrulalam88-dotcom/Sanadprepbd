-- Phase 1 D1 Schema: Single-device session control & distributed rate limiting
-- Offloads high-frequency writes from Firebase Spark Firestore (20k writes/day cap)
-- while keeping users, subscriptions, paymentRequests, exams, and auditLogs authoritative in Firestore.

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  user_email TEXT NOT NULL DEFAULT '',
  user_name TEXT NOT NULL DEFAULT 'Student',
  device_info TEXT NOT NULL DEFAULT 'Web Browser',
  created_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  revoked_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_status
  ON sessions (user_id, status);

CREATE TABLE IF NOT EXISTS user_sessions (
  user_id TEXT PRIMARY KEY,
  active_session_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket_key TEXT PRIMARY KEY,
  window_start_ms INTEGER NOT NULL,
  window_end_ms INTEGER NOT NULL,
  count INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_window_end
  ON rate_limits (window_end_ms);
