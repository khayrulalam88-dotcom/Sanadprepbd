import type {
  D1Database,
  D1PreparedStatement,
  QuestionKeyRecord,
  SanitizedQuestion,
  ServerQuestion
} from './types.ts';
import type { FirestoreRestClient } from './firestoreRest.ts';

export const DEFAULT_QUESTION_BANK_CACHE_TTL_MS = 3_600_000;
const META_ROW_ID = 'questionBankVersion';
let localVersionSeq = 0;

export function parseQuestionBankCacheTtlMs(rawEnv?: string, overrideMs?: number): number {
  if (typeof overrideMs === 'number' && Number.isFinite(overrideMs) && overrideMs >= 0) {
    return overrideMs;
  }
  if (rawEnv !== undefined && rawEnv.trim() !== '') {
    const parsed = Number(rawEnv);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return DEFAULT_QUESTION_BANK_CACHE_TTL_MS;
}

export function createQuestionBankVersionPayload(
  updatedAt: string = new Date().toISOString(),
  nowMs: number = Date.now()
): {
  version: number;
  versionToken: string;
  updatedAt: string;
} {
  localVersionSeq += 1;
  const randomSuffix =
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 6)
      : Math.random().toString(36).slice(2, 7);
  return {
    version: nowMs * 1000 + (localVersionSeq % 1000),
    versionToken: `${nowMs}_${localVersionSeq}_${randomSuffix}`,
    updatedAt
  };
}

export function sanitizeQuestion(q: ServerQuestion | SanitizedQuestion): SanitizedQuestion {
  const clone = { ...q } as unknown as Record<string, unknown>;
  delete clone.correctOptionIndex;
  delete clone.explanationBn;
  delete clone.explanationEn;
  return clone as unknown as SanitizedQuestion;
}

interface QuestionCacheRow {
  id: string;
  subject_id: string;
  topic_id: string | null;
  question_bn: string;
  question_en: string;
  options_bn_json: string;
  options_en_json: string;
  legal_reference: string;
  difficulty: 'easy' | 'medium' | 'hard';
  status: 'draft' | 'reviewed' | 'published';
  is_demo_sample: number;
  created_at: string;
  updated_at: string;
}

interface QuestionKeyRow {
  question_id: string;
  correct_option_index: number;
  explanation_bn: string;
  explanation_en: string;
  legal_reference: string;
  updated_at: string;
}

interface MetaRow {
  id: string;
  version: number;
  version_token: string;
  synced_at: string;
  question_count: number;
}

function rowToSanitizedQuestion(row: QuestionCacheRow): SanitizedQuestion {
  let optionsBn: string[] = [];
  let optionsEn: string[] = [];
  try {
    optionsBn = JSON.parse(row.options_bn_json) as string[];
  } catch {
    optionsBn = [];
  }
  try {
    optionsEn = JSON.parse(row.options_en_json) as string[];
  } catch {
    optionsEn = [];
  }

  return {
    id: row.id,
    subjectId: row.subject_id,
    ...(row.topic_id ? { topicId: row.topic_id } : {}),
    questionBn: row.question_bn,
    questionEn: row.question_en,
    optionsBn,
    optionsEn,
    legalReference: row.legal_reference,
    difficulty: row.difficulty,
    status: row.status,
    isDemoSample: row.is_demo_sample === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function firestoreDocToSanitizedQuestion(raw: Record<string, unknown> & { id: string }): SanitizedQuestion {
  const difficulty =
    raw.difficulty === 'easy' || raw.difficulty === 'hard' ? raw.difficulty : 'medium';
  const status =
    raw.status === 'draft' || raw.status === 'reviewed' ? raw.status : 'published';
  const optionsBn = Array.isArray(raw.optionsBn)
    ? raw.optionsBn.map(o => String(o ?? ''))
    : [];
  const optionsEn = Array.isArray(raw.optionsEn)
    ? raw.optionsEn.map(o => String(o ?? ''))
    : optionsBn;

  return {
    id: raw.id,
    subjectId: String(raw.subjectId ?? ''),
    ...(typeof raw.topicId === 'string' && raw.topicId.trim() ? { topicId: raw.topicId.trim() } : {}),
    questionBn: String(raw.questionBn ?? ''),
    questionEn: String(raw.questionEn ?? raw.questionBn ?? ''),
    optionsBn,
    optionsEn,
    legalReference: String(raw.legalReference ?? ''),
    difficulty,
    status,
    isDemoSample: Boolean(raw.isDemoSample),
    createdAt: String(raw.createdAt ?? ''),
    updatedAt: String(raw.updatedAt ?? ''),
    ...(typeof raw.createdBy === 'string' && raw.createdBy.trim() ? { createdBy: raw.createdBy.trim() } : {})
  };
}

export async function getRemoteQuestionBankVersion(
  firestoreClient: FirestoreRestClient
): Promise<{ version: number; versionToken: string; updatedAt?: string }> {
  const versionDoc = await firestoreClient.getDocument<{
    versionToken?: string;
    version?: number;
    updatedAt?: string;
  }>('config', META_ROW_ID);

  const versionToken = versionDoc?.versionToken
    ? String(versionDoc.versionToken)
    : versionDoc?.version !== undefined
    ? String(versionDoc.version)
    : '__initial__';

  return {
    version: typeof versionDoc?.version === 'number' ? versionDoc.version : 0,
    versionToken,
    ...(typeof versionDoc?.updatedAt === 'string' ? { updatedAt: versionDoc.updatedAt } : {})
  };
}

/**
 * Checks whether the D1 question_bank_cache matches Firestore's authoritative config/questionBankVersion.
 * Does NOT fetch keys into student cache paths.
 */
export async function checkD1QuestionCacheFreshness(
  db: D1Database,
  firestoreClient: FirestoreRestClient,
  options?: { ttlMs?: number; nowMs?: number }
): Promise<{ fresh: boolean; remoteVersionToken: string; localMeta: MetaRow | null }> {
  const ttlMs = options?.ttlMs ?? DEFAULT_QUESTION_BANK_CACHE_TTL_MS;
  const nowMs = options?.nowMs ?? Date.now();

  const localMeta = await db
    .prepare(`SELECT id, version, version_token, synced_at, question_count FROM question_bank_meta WHERE id = ?1`)
    .bind(META_ROW_ID)
    .first<MetaRow>();

  if (localMeta && ttlMs > 0) {
    const syncedAtMs = new Date(localMeta.synced_at).getTime();
    if (!isNaN(syncedAtMs) && nowMs - syncedAtMs < ttlMs && localMeta.question_count > 0) {
      return { fresh: true, remoteVersionToken: localMeta.version_token, localMeta };
    }
  }

  // Single Firestore document read to check authoritative version
  const remote = await getRemoteQuestionBankVersion(firestoreClient);

  if (localMeta && localMeta.version_token === remote.versionToken && localMeta.question_count > 0) {
    await db
      .prepare(`UPDATE question_bank_meta SET synced_at = ?1 WHERE id = ?2`)
      .bind(new Date(nowMs).toISOString(), META_ROW_ID)
      .run();
    return { fresh: true, remoteVersionToken: remote.versionToken, localMeta };
  }

  return { fresh: false, remoteVersionToken: remote.versionToken, localMeta };
}

export async function invalidateLocalD1QuestionCache(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE question_bank_meta SET synced_at = '1970-01-01T00:00:00.000Z', version_token = '__invalidated__' WHERE id = ?1`).bind(META_ROW_ID)
  ]);
}

const inFlightSanitizedSync = new WeakMap<D1Database, Promise<{ synced: boolean; versionToken: string; count: number }>>();

/**
 * Ensures D1 question_bank_cache holds the latest sanitized questions from authoritative Firestore /questions.
 * NEVER reads or writes /questionKeys in this function!
 */
export async function ensureSanitizedQuestionsSyncedD1(
  db: D1Database,
  firestoreClient: FirestoreRestClient,
  options?: { ttlMs?: number; nowMs?: number; bypassCache?: boolean }
): Promise<{ versionToken: string; fromCache: boolean }> {
  const nowMs = options?.nowMs ?? Date.now();
  const ttlMs = options?.ttlMs ?? DEFAULT_QUESTION_BANK_CACHE_TTL_MS;

  if (!options?.bypassCache) {
    const check = await checkD1QuestionCacheFreshness(db, firestoreClient, { ttlMs, nowMs });
    if (check.fresh) {
      return { versionToken: check.remoteVersionToken, fromCache: true };
    }
  }

  const inflight = inFlightSanitizedSync.get(db);
  if (inflight) {
    const done = await inflight;
    return { versionToken: done.versionToken, fromCache: false };
  }

  const syncPromise = (async () => {
    const remote = await getRemoteQuestionBankVersion(firestoreClient);
    const docs = await firestoreClient.listDocuments<Record<string, unknown>>('questions', {
      pageSize: 500,
      maxPages: 20
    });

    const sanitizedList = docs.map(d => sanitizeQuestion(firestoreDocToSanitizedQuestion(d)));
    const syncedIso = new Date(nowMs).toISOString();

    // Clear outdated sanitized questions + any stale keys if version changed so keys revalidate cleanly too
    await db.batch([
      db.prepare(`DELETE FROM question_bank_cache`),
      db.prepare(`DELETE FROM question_keys_cache`)
    ]);

    // Multi-row insert keeping <= 70 bound params per SQL statement (5 rows * 14 cols = 70 < D1 100 param limit)
    const rowsPerStmt = 5;
    const stmtsPerBatch = 40;
    const allStmts: D1PreparedStatement[] = [];

    for (let i = 0; i < sanitizedList.length; i += rowsPerStmt) {
      const chunk = sanitizedList.slice(i, i + rowsPerStmt);
      const placeholders = chunk
        .map((_, idx) => {
          const b = idx * 14;
          return `(?${b + 1}, ?${b + 2}, ?${b + 3}, ?${b + 4}, ?${b + 5}, ?${b + 6}, ?${b + 7}, ?${b + 8}, ?${b + 9}, ?${b + 10}, ?${b + 11}, ?${b + 12}, ?${b + 13}, ?${b + 14})`;
        })
        .join(', ');
      const values: unknown[] = [];
      for (const q of chunk) {
        values.push(
          q.id,
          q.subjectId,
          q.topicId || null,
          q.questionBn,
          q.questionEn || '',
          JSON.stringify(q.optionsBn || []),
          JSON.stringify(q.optionsEn || []),
          q.legalReference || '',
          q.difficulty,
          q.status,
          q.isDemoSample ? 1 : 0,
          q.createdAt || syncedIso,
          q.updatedAt || syncedIso,
          remote.versionToken
        );
      }

      allStmts.push(
        db
          .prepare(
            `INSERT INTO question_bank_cache (
               id, subject_id, topic_id, question_bn, question_en,
               options_bn_json, options_en_json, legal_reference,
               difficulty, status, is_demo_sample, created_at, updated_at, synced_version
             ) VALUES ${placeholders}
             ON CONFLICT(id) DO UPDATE SET
               subject_id = excluded.subject_id,
               topic_id = excluded.topic_id,
               question_bn = excluded.question_bn,
               question_en = excluded.question_en,
               options_bn_json = excluded.options_bn_json,
               options_en_json = excluded.options_en_json,
               legal_reference = excluded.legal_reference,
               difficulty = excluded.difficulty,
               status = excluded.status,
               is_demo_sample = excluded.is_demo_sample,
               updated_at = excluded.updated_at,
               synced_version = excluded.synced_version`
          )
          .bind(...values)
      );
    }

    for (let j = 0; j < allStmts.length; j += stmtsPerBatch) {
      await db.batch(allStmts.slice(j, j + stmtsPerBatch));
    }

    await db
      .prepare(
        `INSERT INTO question_bank_meta (id, version, version_token, synced_at, question_count)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET
           version = excluded.version,
           version_token = excluded.version_token,
           synced_at = excluded.synced_at,
           question_count = excluded.question_count`
      )
      .bind(META_ROW_ID, remote.version, remote.versionToken, syncedIso, sanitizedList.length)
      .run();

    return { synced: true, versionToken: remote.versionToken, count: sanitizedList.length };
  })().finally(() => {
    inFlightSanitizedSync.delete(db);
  });

  inFlightSanitizedSync.set(db, syncPromise);
  const done = await syncPromise;
  return { versionToken: done.versionToken, fromCache: false };
}

export interface SanitizedQuestionFilter {
  subjectId?: string;
  topicId?: string;
  difficulty?: 'easy' | 'medium' | 'hard';
  search?: string;
  demoOnly?: boolean;
  limit?: number;
  offset?: number;
}

export function escapeSqliteLikePattern(rawSearch: string): string {
  return String(rawSearch || '')
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

/**
 * SQL-filtered sanitized query against D1 question_bank_cache ONLY.
 * Guaranteed zero exposure of question_keys_cache.
 */
export async function querySanitizedQuestionsFromD1(
  db: D1Database,
  filter: SanitizedQuestionFilter = {}
): Promise<{ questions: SanitizedQuestion[]; total: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.subjectId) {
    params.push(filter.subjectId);
    conditions.push(`subject_id = ?${params.length}`);
  }
  if (filter.topicId) {
    params.push(filter.topicId);
    conditions.push(`topic_id = ?${params.length}`);
  }
  if (filter.difficulty) {
    params.push(filter.difficulty);
    conditions.push(`difficulty = ?${params.length}`);
  }
  if (filter.demoOnly) {
    conditions.push(`is_demo_sample = 1`);
  }
  if (filter.search && filter.search.trim()) {
    const escapedSearch = escapeSqliteLikePattern(filter.search.trim().toLowerCase());
    const pattern = `%${escapedSearch}%`;
    params.push(pattern);
    const pIdx = params.length;
    conditions.push(
      `(LOWER(question_bn) LIKE ?${pIdx} ESCAPE '\\' OR LOWER(question_en) LIKE ?${pIdx} ESCAPE '\\' OR LOWER(legal_reference) LIKE ?${pIdx} ESCAPE '\\')`
    );
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const countRow = await db
    .prepare(`SELECT COUNT(*) AS total FROM question_bank_cache ${whereClause}`)
    .bind(...params)
    .first<{ total: number }>();
  const total = Number(countRow?.total ?? 0);

  let limitOffsetSql = '';
  const queryParams = [...params];
  if (filter.limit !== undefined && filter.limit > 0) {
    queryParams.push(filter.limit);
    const limitIdx = queryParams.length;
    const safeOffset = filter.offset !== undefined && filter.offset >= 0 ? filter.offset : 0;
    queryParams.push(safeOffset);
    const offsetIdx = queryParams.length;
    limitOffsetSql = `LIMIT ?${limitIdx} OFFSET ?${offsetIdx}`;
  }

  const res = await db
    .prepare(
      `SELECT id, subject_id, topic_id, question_bn, question_en,
              options_bn_json, options_en_json, legal_reference,
              difficulty, status, is_demo_sample, created_at, updated_at
       FROM question_bank_cache
       ${whereClause}
       ORDER BY id ASC
       ${limitOffsetSql}`
    )
    .bind(...queryParams)
    .all<QuestionCacheRow>();

  return {
    questions: res.results.map(rowToSanitizedQuestion),
    total
  };
}

/**
 * Legacy/simple reader helper (sanitized only, never touches question_keys_cache).
 */
export async function readSanitizedQuestionsFromD1(
  db: D1Database,
  options?: { subjectId?: string }
): Promise<SanitizedQuestion[]> {
  const { questions } = await querySanitizedQuestionsFromD1(db, { subjectId: options?.subjectId });
  return questions;
}

export async function getSubjectQuestionCountsFromD1(
  db: D1Database
): Promise<{ counts: Record<string, number>; total: number }> {
  const res = await db
    .prepare(
      `SELECT subject_id, COUNT(*) AS cnt
       FROM question_bank_cache
       GROUP BY subject_id`
    )
    .all<{ subject_id: string; cnt: number }>();

  const counts: Record<string, number> = {};
  let total = 0;
  for (const row of res.results) {
    const c = Number(row.cnt ?? 0);
    if (row.subject_id) {
      counts[row.subject_id] = c;
    }
    total += c;
  }
  return { counts, total };
}

/**
 * Looks up a single sanitized question (for practice subscription gating) from D1 or authoritative Firestore.
 */
export async function getSanitizedQuestionMeta(
  db: D1Database,
  firestoreClient: FirestoreRestClient,
  questionId: string
): Promise<SanitizedQuestion | null> {
  const row = await db
    .prepare(
      `SELECT id, subject_id, topic_id, question_bn, question_en,
              options_bn_json, options_en_json, legal_reference,
              difficulty, status, is_demo_sample, created_at, updated_at
       FROM question_bank_cache WHERE id = ?1`
    )
    .bind(questionId)
    .first<QuestionCacheRow>();
  if (row) {
    return rowToSanitizedQuestion(row);
  }

  const remoteDoc = await firestoreClient.getDocument<Record<string, unknown>>('questions', questionId);
  if (!remoteDoc) return null;
  return sanitizeQuestion(firestoreDocToSanitizedQuestion(remoteDoc));
}

/**
 * Server-internal helper for scoring, practice verification, and Owner Admin CRUD ONLY.
 * Revalidates cache version against Firestore so stale keys are never served after remote admin edits.
 */
export async function getAuthoritativeQuestionKeys(
  db: D1Database,
  firestoreClient: FirestoreRestClient,
  questionIds: string[],
  options?: { ttlMs?: number; nowMs?: number }
): Promise<Map<string, QuestionKeyRecord>> {
  const out = new Map<string, QuestionKeyRecord>();
  const uniqueIds = Array.from(new Set(questionIds.map(id => String(id).trim()).filter(Boolean)));
  if (uniqueIds.length === 0) return out;

  const freshness = await checkD1QuestionCacheFreshness(db, firestoreClient, {
    ttlMs: options?.ttlMs,
    nowMs: options?.nowMs
  });

  if (freshness.fresh) {
    for (let i = 0; i < uniqueIds.length; i += 90) {
      const chunk = uniqueIds.slice(i, i + 90);
      const placeholders = chunk.map((_, idx) => `?${idx + 1}`).join(', ');
      const res = await db
        .prepare(
          `SELECT question_id, correct_option_index, explanation_bn, explanation_en, legal_reference, updated_at
           FROM question_keys_cache
           WHERE question_id IN (${placeholders})`
        )
        .bind(...chunk)
        .all<QuestionKeyRow>();

      for (const row of res.results) {
        out.set(row.question_id, {
          id: row.question_id,
          correctOptionIndex: row.correct_option_index,
          explanationBn: row.explanation_bn,
          explanationEn: row.explanation_en,
          legalReference: row.legal_reference,
          updatedAt: row.updated_at
        });
      }
    }
  }

  const missingIds = uniqueIds.filter(id => !out.has(id));
  if (missingIds.length > 0) {
    const fetched = await firestoreClient.batchGetDocuments<Record<string, unknown>>(
      missingIds.map(docId => ({ collection: 'questionKeys', docId }))
    );
    const cacheWrites: D1PreparedStatement[] = [];
    for (const [docId, data] of fetched.entries()) {
      const rec: QuestionKeyRecord = {
        id: docId,
        correctOptionIndex: Number(data.correctOptionIndex ?? 0),
        explanationBn: String(data.explanationBn ?? ''),
        explanationEn: String(data.explanationEn ?? ''),
        legalReference: String(data.legalReference ?? ''),
        updatedAt: String(data.updatedAt ?? '')
      };
      out.set(docId, rec);
      cacheWrites.push(
        db
          .prepare(
            `INSERT INTO question_keys_cache (
               question_id, correct_option_index, explanation_bn, explanation_en,
               legal_reference, updated_at, synced_version
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(question_id) DO UPDATE SET
               correct_option_index = excluded.correct_option_index,
               explanation_bn = excluded.explanation_bn,
               explanation_en = excluded.explanation_en,
               legal_reference = excluded.legal_reference,
               updated_at = excluded.updated_at,
               synced_version = excluded.synced_version`
          )
          .bind(
            rec.id,
            rec.correctOptionIndex,
            rec.explanationBn,
            rec.explanationEn,
            rec.legalReference || '',
            rec.updatedAt,
            freshness.remoteVersionToken
          )
      );
    }
    for (let j = 0; j < cacheWrites.length; j += 40) {
      await db.batch(cacheWrites.slice(j, j + 40));
    }
  }

  return out;
}

/**
 * Authoritative full question + answer key list for VERIFIED OWNER ADMIN ONLY (/api/admin/questions).
 * Reads directly from authoritative Firestore /questions + /questionKeys.
 */
export async function fetchAllQuestionsWithKeysAuthoritative(
  firestoreClient: FirestoreRestClient
): Promise<ServerQuestion[]> {
  const [questionDocs, keyDocs] = await Promise.all([
    firestoreClient.listDocuments<Record<string, unknown>>('questions', { pageSize: 500, maxPages: 20 }),
    firestoreClient.listDocuments<Record<string, unknown>>('questionKeys', { pageSize: 500, maxPages: 20 })
  ]);

  const keyMap = new Map<string, Record<string, unknown>>();
  for (const k of keyDocs) {
    keyMap.set(k.id, k);
  }

  return questionDocs.map(doc => {
    const base = firestoreDocToSanitizedQuestion(doc);
    const key = keyMap.get(doc.id);
    return {
      ...base,
      correctOptionIndex: Number(key?.correctOptionIndex ?? doc.correctOptionIndex ?? 0),
      explanationBn: String(key?.explanationBn ?? doc.explanationBn ?? ''),
      explanationEn: String(key?.explanationEn ?? doc.explanationEn ?? '')
    };
  });
}

/**
 * Upserts a single question + key into D1 cache (after Owner Admin save)
 * and updates local version token metadata so cached reads stay consistent.
 */
export async function upsertSingleQuestionCacheD1(
  db: D1Database,
  question: ServerQuestion,
  versionToken: string,
  nowIso: string = new Date().toISOString(),
  options?: { onlyIfCacheInitialized?: boolean }
): Promise<void> {
  const sanitized = sanitizeQuestion(question);
  const onlyIfInitialized = Boolean(options?.onlyIfCacheInitialized);
  const metaInsertStmt = onlyIfInitialized
    ? db
        .prepare(
          `INSERT INTO question_bank_meta (id, version, version_token, synced_at, question_count)
           VALUES (?1, 1, '__invalidated__', '1970-01-01T00:00:00.000Z', (SELECT COUNT(*) FROM question_bank_cache))
           ON CONFLICT(id) DO UPDATE SET
             version = question_bank_meta.version + 1,
             version_token = CASE
               WHEN question_bank_meta.question_count > 0
                AND question_bank_meta.version_token != '__invalidated__'
                AND question_bank_meta.synced_at != '1970-01-01T00:00:00.000Z'
               THEN ?2
               ELSE '__invalidated__'
             END,
             synced_at = CASE
               WHEN question_bank_meta.question_count > 0
                AND question_bank_meta.version_token != '__invalidated__'
                AND question_bank_meta.synced_at != '1970-01-01T00:00:00.000Z'
               THEN ?3
               ELSE '1970-01-01T00:00:00.000Z'
             END,
             question_count = (SELECT COUNT(*) FROM question_bank_cache)`
        )
        .bind(META_ROW_ID, versionToken, nowIso)
    : db
        .prepare(
          `INSERT INTO question_bank_meta (id, version, version_token, synced_at, question_count)
           VALUES (?1, 1, ?2, ?3, (SELECT COUNT(*) FROM question_bank_cache))
           ON CONFLICT(id) DO UPDATE SET
             version = question_bank_meta.version + 1,
             version_token = ?2,
             synced_at = ?3,
             question_count = (SELECT COUNT(*) FROM question_bank_cache)`
        )
        .bind(META_ROW_ID, versionToken, nowIso);

  await db.batch([
    db
      .prepare(
        `INSERT INTO question_bank_cache (
           id, subject_id, topic_id, question_bn, question_en,
           options_bn_json, options_en_json, legal_reference,
           difficulty, status, is_demo_sample, created_at, updated_at, synced_version
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT(id) DO UPDATE SET
           subject_id = excluded.subject_id,
           topic_id = excluded.topic_id,
           question_bn = excluded.question_bn,
           question_en = excluded.question_en,
           options_bn_json = excluded.options_bn_json,
           options_en_json = excluded.options_en_json,
           legal_reference = excluded.legal_reference,
           difficulty = excluded.difficulty,
           status = excluded.status,
           is_demo_sample = excluded.is_demo_sample,
           updated_at = excluded.updated_at,
           synced_version = excluded.synced_version`
      )
      .bind(
        sanitized.id,
        sanitized.subjectId,
        sanitized.topicId || null,
        sanitized.questionBn,
        sanitized.questionEn || '',
        JSON.stringify(sanitized.optionsBn || []),
        JSON.stringify(sanitized.optionsEn || []),
        sanitized.legalReference || '',
        sanitized.difficulty,
        sanitized.status,
        sanitized.isDemoSample ? 1 : 0,
        sanitized.createdAt || nowIso,
        sanitized.updatedAt || nowIso,
        versionToken
      ),
    db
      .prepare(
        `INSERT INTO question_keys_cache (
           question_id, correct_option_index, explanation_bn, explanation_en,
           legal_reference, updated_at, synced_version
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(question_id) DO UPDATE SET
           correct_option_index = excluded.correct_option_index,
           explanation_bn = excluded.explanation_bn,
           explanation_en = excluded.explanation_en,
           legal_reference = excluded.legal_reference,
           updated_at = excluded.updated_at,
           synced_version = excluded.synced_version`
      )
      .bind(
        question.id,
        question.correctOptionIndex,
        question.explanationBn || '',
        question.explanationEn || '',
        question.legalReference || '',
        question.updatedAt || nowIso,
        versionToken
      ),
    metaInsertStmt
  ]);
}

export async function deleteQuestionFromCacheD1(
  db: D1Database,
  questionId: string,
  versionToken: string,
  nowIso: string = new Date().toISOString()
): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM question_bank_cache WHERE id = ?1`).bind(questionId),
    db.prepare(`DELETE FROM question_keys_cache WHERE question_id = ?1`).bind(questionId),
    db
      .prepare(
        `INSERT INTO question_bank_meta (id, version, version_token, synced_at, question_count)
         VALUES (?1, 1, '__invalidated__', '1970-01-01T00:00:00.000Z', (SELECT COUNT(*) FROM question_bank_cache))
         ON CONFLICT(id) DO UPDATE SET
           version = question_bank_meta.version + 1,
           version_token = CASE
             WHEN question_bank_meta.question_count > 0
              AND question_bank_meta.version_token != '__invalidated__'
              AND question_bank_meta.synced_at != '1970-01-01T00:00:00.000Z'
             THEN ?2
             ELSE '__invalidated__'
           END,
           synced_at = CASE
             WHEN question_bank_meta.question_count > 0
              AND question_bank_meta.version_token != '__invalidated__'
              AND question_bank_meta.synced_at != '1970-01-01T00:00:00.000Z'
             THEN ?3
             ELSE '1970-01-01T00:00:00.000Z'
           END,
           question_count = (SELECT COUNT(*) FROM question_bank_cache)`
      )
      .bind(META_ROW_ID, versionToken, nowIso)
  ]);
}
