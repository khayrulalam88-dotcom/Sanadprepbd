-- Phase 1 D1 Schema: Version-coordinated read-only mirror cache for Sanitized Questions & Restricted Keys
-- Firestore remains the single authoritative source of truth.
-- Never store answer keys or explanations in question_bank_cache!

CREATE TABLE IF NOT EXISTS question_bank_meta (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 0,
  version_token TEXT NOT NULL DEFAULT '__initial__',
  synced_at TEXT NOT NULL,
  question_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS question_bank_cache (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  topic_id TEXT,
  question_bn TEXT NOT NULL,
  question_en TEXT NOT NULL DEFAULT '',
  options_bn_json TEXT NOT NULL,
  options_en_json TEXT NOT NULL,
  legal_reference TEXT NOT NULL DEFAULT '',
  difficulty TEXT NOT NULL CHECK (difficulty IN ('easy', 'medium', 'hard')),
  status TEXT NOT NULL CHECK (status IN ('draft', 'reviewed', 'published')),
  is_demo_sample INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  synced_version TEXT NOT NULL DEFAULT '__initial__'
);

CREATE INDEX IF NOT EXISTS idx_question_bank_cache_subject
  ON question_bank_cache (subject_id, status);

-- Physically separated table for server-only scoring / practice verification / Owner Admin CRUD.
-- Never serialized to /api/questions or unauthenticated callers.
CREATE TABLE IF NOT EXISTS question_keys_cache (
  question_id TEXT PRIMARY KEY,
  correct_option_index INTEGER NOT NULL,
  explanation_bn TEXT NOT NULL DEFAULT '',
  explanation_en TEXT NOT NULL DEFAULT '',
  legal_reference TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  synced_version TEXT NOT NULL DEFAULT '__initial__'
);
