-- Keyless Edge Store Schema: Enables Cloudflare Worker + D1 operation without
-- any downloaded Firebase service-account JSON private key.
-- Privileged student-initiated writes (payment requests, exam attempts, graded results,
-- leaderboard updates, and edge audit logs) are validated and persisted atomically in D1,
-- and synchronized with Firestore via Owner Admin's verified Firebase ID token.

CREATE TABLE IF NOT EXISTS edge_exams_cache (
  id TEXT PRIMARY KEY,
  is_paid INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_edge_exams_paid
  ON edge_exams_cache (is_paid, is_active);

CREATE TABLE IF NOT EXISTS edge_payment_requests (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  synced_to_firestore INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_edge_payments_user
  ON edge_payment_requests (user_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_edge_payments_status
  ON edge_payment_requests (status, requested_at DESC);

CREATE TABLE IF NOT EXISTS edge_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'cancelled')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  synced_to_firestore INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_edge_subs_user
  ON edge_subscriptions (user_id, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_edge_subs_trx
  ON edge_subscriptions (transaction_id);

CREATE TABLE IF NOT EXISTS edge_exam_attempts (
  id TEXT PRIMARY KEY,
  exam_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'submitted', 'timed_out')),
  start_time TEXT NOT NULL,
  deadline_time TEXT NOT NULL,
  last_saved_at TEXT NOT NULL,
  submitted_time TEXT,
  payload_json TEXT NOT NULL,
  synced_to_firestore INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_edge_attempts_user
  ON edge_exam_attempts (user_id, start_time DESC);

CREATE TABLE IF NOT EXISTS edge_exam_results (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE,
  exam_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  final_score REAL NOT NULL,
  payload_json TEXT NOT NULL,
  synced_to_firestore INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_edge_results_user
  ON edge_exam_results (user_id, submitted_at DESC);

CREATE TABLE IF NOT EXISTS edge_leaderboard (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  exam_id TEXT NOT NULL,
  score REAL NOT NULL,
  time_spent_seconds INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  synced_to_firestore INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_edge_leaderboard_score
  ON edge_leaderboard (score DESC, time_spent_seconds ASC);

CREATE INDEX IF NOT EXISTS idx_edge_leaderboard_exam
  ON edge_leaderboard (exam_id, score DESC, time_spent_seconds ASC);

CREATE TABLE IF NOT EXISTS edge_audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  synced_to_firestore INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_edge_audit_ts
  ON edge_audit_logs (timestamp DESC);
