import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FIREBASE_PROJECT_ID = 'galvanic-aviary-tzp2g';
export const FIRESTORE_DATABASE_ID = 'ai-studio-barcouncilmcqpre-9a5aecc8-3819-4aeb-b7e2-c6066b637cab';
export const OWNER_ADMIN_UID = 'PjBRV7LAQ8cIwOdM3z474A16dWg2';
export const OWNER_ADMIN_EMAIL = 'khayrulalam88@gmail.com';
export const MAX_COMMIT_BATCH_SIZE = 200;

export const FIRESTORE_DATABASE_ROOT = `projects/${FIREBASE_PROJECT_ID}/databases/${FIRESTORE_DATABASE_ID}`;
export const FIRESTORE_DOCUMENTS_ROOT = `${FIRESTORE_DATABASE_ROOT}/documents`;
export const FIRESTORE_REST_BASE_URL = `https://firestore.googleapis.com/v1/${FIRESTORE_DOCUMENTS_ROOT}`;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

export function sanitizeDiagnosticMessage(raw) {
  return String(raw || 'Unknown error')
    .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, '[REDACTED_KEY]')
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, '[REDACTED_JWT]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED_API_KEY]')
    .slice(0, 300);
}

export class SeederError extends Error {
  constructor(code, message, details) {
    super(sanitizeDiagnosticMessage(message));
    this.name = 'SeederError';
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export function parseCliArgs(argv) {
  const args = argv.filter(Boolean);
  const dryRun = args.includes('--dry-run');
  const execute = args.includes('--execute');
  const help = args.includes('--help') || args.includes('-h');
  const unknown = args.filter(a => a !== '--dry-run' && a !== '--execute' && a !== '--help' && a !== '-h');

  if (help) {
    return { valid: true, help: true, dryRun: true, execute: false };
  }
  if (unknown.length > 0) {
    return {
      valid: false,
      help: false,
      dryRun: false,
      execute: false,
      error: `Unknown argument(s): ${unknown.join(', ')}. Allowed flags: --dry-run (default), --execute, --help`
    };
  }
  if (dryRun && execute) {
    return {
      valid: false,
      help: false,
      dryRun: false,
      execute: false,
      error: 'Cannot pass both --dry-run and --execute simultaneously.'
    };
  }
  return {
    valid: true,
    help: false,
    dryRun: !execute,
    execute
  };
}

function decodeBase64UrlJson(segment) {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw new SeederError('INVALID_TOKEN', 'OWNER_FIREBASE_ID_TOKEN is not a valid JWT segment.');
  }
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(segment.length / 4) * 4, '=');
  const jsonText = Buffer.from(padded, 'base64').toString('utf8');
  return JSON.parse(jsonText);
}

export function validateOwnerIdToken(rawToken, nowMs = Date.now()) {
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (!token) {
    throw new SeederError(
      'MISSING_TOKEN',
      'Missing OWNER_FIREBASE_ID_TOKEN environment variable. Set OWNER_FIREBASE_ID_TOKEN before running.'
    );
  }

  const segments = token.split('.');
  if (segments.length !== 3 || !segments[0] || !segments[1] || !segments[2]) {
    throw new SeederError(
      'INVALID_TOKEN',
      'OWNER_FIREBASE_ID_TOKEN must be a valid Firebase ID token (JWT).'
    );
  }

  let claims;
  try {
    claims = decodeBase64UrlJson(segments[1]);
  } catch (err) {
    if (err instanceof SeederError) throw err;
    throw new SeederError('INVALID_TOKEN', 'Unable to decode OWNER_FIREBASE_ID_TOKEN payload.');
  }

  const uid = String(claims.user_id || claims.sub || '').trim();
  const email = String(claims.email || '').trim().toLowerCase();
  const emailVerified = claims.email_verified === true;
  const aud = typeof claims.aud === 'string' ? claims.aud.trim() : '';
  const expSec = typeof claims.exp === 'number' ? claims.exp : Number(claims.exp);

  if (aud && aud !== FIREBASE_PROJECT_ID) {
    throw new SeederError(
      'TOKEN_PROJECT_MISMATCH',
      `Token audience "${aud}" does not match project "${FIREBASE_PROJECT_ID}".`
    );
  }
  if (!Number.isFinite(expSec) || expSec * 1000 <= nowMs) {
    throw new SeederError(
      'TOKEN_EXPIRED',
      'OWNER_FIREBASE_ID_TOKEN is expired. Obtain a fresh Owner Firebase ID token and retry.'
    );
  }
  if (uid !== OWNER_ADMIN_UID) {
    throw new SeederError(
      'UNAUTHORIZED_UID',
      `Token UID does not match required Owner UID (${OWNER_ADMIN_UID}).`
    );
  }
  if (email !== OWNER_ADMIN_EMAIL.toLowerCase()) {
    throw new SeederError(
      'UNAUTHORIZED_EMAIL',
      `Token email does not match required Owner email (${OWNER_ADMIN_EMAIL}).`
    );
  }
  if (!emailVerified) {
    throw new SeederError(
      'EMAIL_NOT_VERIFIED',
      'Owner Firebase ID token must have email_verified=true.'
    );
  }

  return { token, uid, email };
}

// ---------------------------------------------------------
// Firestore REST v1 Value Codec (mirrors worker/firestoreRest.ts)
// ---------------------------------------------------------

export function encodeFirestoreValue(value) {
  if (value === null || value === undefined) {
    return { nullValue: null };
  }
  if (typeof value === 'boolean') {
    return { booleanValue: value };
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return { nullValue: null };
    }
    if (Number.isInteger(value) && Number.isSafeInteger(value)) {
      return { integerValue: String(value) };
    }
    return { doubleValue: value };
  }
  if (typeof value === 'string') {
    return { stringValue: value };
  }
  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.map(item => encodeFirestoreValue(item))
      }
    };
  }
  if (typeof value === 'object') {
    return {
      mapValue: {
        fields: encodeDocumentFields(value)
      }
    };
  }
  return { stringValue: String(value) };
}

export function encodeDocumentFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    fields[k] = encodeFirestoreValue(v);
  }
  return fields;
}

export function decodeFirestoreValue(value) {
  if (!value || typeof value !== 'object') return undefined;
  if ('nullValue' in value) return null;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('stringValue' in value) return value.stringValue;
  if ('arrayValue' in value) {
    return (value.arrayValue.values || []).map(item => decodeFirestoreValue(item));
  }
  if ('mapValue' in value) {
    return decodeDocumentFields(value.mapValue.fields || {});
  }
  return undefined;
}

export function decodeDocumentFields(fields) {
  if (!fields || typeof fields !== 'object') return {};
  const result = {};
  for (const [k, v] of Object.entries(fields)) {
    result[k] = decodeFirestoreValue(v);
  }
  return result;
}

export function extractDocumentId(resourceName) {
  const parts = String(resourceName || '').split('/');
  return parts[parts.length - 1] || '';
}

// ---------------------------------------------------------
// Canonical Document Schemas (mirrors worker/questionCache.ts & catalogAndPractice.ts)
// ---------------------------------------------------------

export function buildSanitizedQuestionDoc(q, fallbackIso) {
  const difficulty = q.difficulty === 'easy' || q.difficulty === 'hard' ? q.difficulty : 'medium';
  const status = q.status === 'draft' || q.status === 'reviewed' ? q.status : 'published';
  const optionsBn = Array.isArray(q.optionsBn) ? q.optionsBn.map(o => String(o ?? '')) : [];
  const optionsEn =
    Array.isArray(q.optionsEn) && q.optionsEn.length > 0
      ? q.optionsEn.map(o => String(o ?? ''))
      : [...optionsBn];

  return {
    id: String(q.id).trim(),
    subjectId: String(q.subjectId).trim(),
    ...(typeof q.topicId === 'string' && q.topicId.trim() ? { topicId: q.topicId.trim() } : {}),
    questionBn: String(q.questionBn),
    questionEn: String(q.questionEn || q.questionBn),
    optionsBn,
    optionsEn,
    legalReference: String(q.legalReference || ''),
    difficulty,
    status,
    isDemoSample: Boolean(q.isDemoSample),
    createdAt: String(q.createdAt || fallbackIso),
    updatedAt: String(q.updatedAt || fallbackIso),
    ...(typeof q.createdBy === 'string' && q.createdBy.trim() ? { createdBy: q.createdBy.trim() } : {})
  };
}

export function buildQuestionKeyDoc(q, fallbackIso) {
  return {
    correctOptionIndex: Number(q.correctOptionIndex),
    explanationBn: String(q.explanationBn || ''),
    explanationEn: String(q.explanationEn || ''),
    legalReference: String(q.legalReference || ''),
    updatedAt: String(q.updatedAt || fallbackIso)
  };
}

export function buildExamDoc(exam, fallbackIso) {
  return {
    id: String(exam.id).trim(),
    titleBn: String(exam.titleBn),
    titleEn: String(exam.titleEn || exam.titleBn),
    descriptionBn: String(exam.descriptionBn || ''),
    descriptionEn: String(exam.descriptionEn || ''),
    type: String(exam.type || 'full_mock'),
    durationMinutes: Number(exam.durationMinutes || 60),
    totalMarks: Number(exam.totalMarks || 100),
    passThresholdPercentage: Number(exam.passThresholdPercentage ?? 50),
    questionIds: Array.isArray(exam.questionIds) ? exam.questionIds.map(String) : [],
    isPaid: Boolean(exam.isPaid),
    isActive:
      exam.isActive !== undefined
        ? Boolean(exam.isActive)
        : !exam.isPaid || String(exam.id).trim() === 'exam_model_test_01',
    published: Boolean(exam.published),
    releaseExplanationsImmediately: exam.releaseExplanationsImmediately ?? true,
    subjectId: exam.subjectId ?? null,
    negativeMarkRatio: Number(exam.negativeMarkRatio ?? 0.25),
    positiveMarkRatio: Number(exam.positiveMarkRatio ?? 1.0),
    createdAt: String(exam.createdAt || fallbackIso),
    updatedAt: String(exam.updatedAt || fallbackIso),
    scheduledDate: exam.scheduledDate ?? null
  };
}

export function createQuestionBankVersionPayload(nowMs = Date.now(), updatedAt = new Date(nowMs).toISOString()) {
  const randomSuffix =
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 6)
      : Math.random().toString(36).slice(2, 8);
  return {
    version: nowMs * 1000 + 1,
    versionToken: `${nowMs}_1_${randomSuffix}`,
    updatedAt
  };
}

// ---------------------------------------------------------
// Source Loading & Validation
// ---------------------------------------------------------

export function loadAndValidateSources(options = {}) {
  const questionsPath =
    options.questionsPath || path.join(ROOT_DIR, 'server', 'data', 'questionBankFull.json');
  const examsPath =
    options.examsPath || path.join(ROOT_DIR, 'src', 'data', 'initialExamsMeta.json');

  const rawQuestions =
    options.questions || JSON.parse(fs.readFileSync(questionsPath, 'utf8'));
  const rawExamsMeta =
    options.examsMeta || JSON.parse(fs.readFileSync(examsPath, 'utf8'));
  const rawExams =
    options.exams || [
      ...(Array.isArray(rawExamsMeta.modelTests30) ? rawExamsMeta.modelTests30 : []),
      ...(Array.isArray(rawExamsMeta.subjectPracticeTests) ? rawExamsMeta.subjectPracticeTests : [])
    ];

  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    throw new SeederError('INVALID_SOURCE', 'Source questionBankFull.json is empty or not an array.');
  }
  if (!Array.isArray(rawExams) || rawExams.length === 0) {
    throw new SeederError('INVALID_SOURCE', 'Source initialExamsMeta.json produced zero exams.');
  }

  const questionIdSet = new Set();
  for (let i = 0; i < rawQuestions.length; i++) {
    const q = rawQuestions[i];
    const qId = typeof q?.id === 'string' ? q.id.trim() : '';
    if (!qId) {
      throw new SeederError('INVALID_SOURCE', `Question at index ${i} is missing id.`);
    }
    if (questionIdSet.has(qId)) {
      throw new SeederError('INVALID_SOURCE', `Duplicate question id "${qId}" in source data.`);
    }
    questionIdSet.add(qId);

    if (typeof q.subjectId !== 'string' || !q.subjectId.trim()) {
      throw new SeederError('INVALID_SOURCE', `Question "${qId}" is missing subjectId.`);
    }
    if (typeof q.questionBn !== 'string' || !q.questionBn.trim()) {
      throw new SeederError('INVALID_SOURCE', `Question "${qId}" is missing questionBn.`);
    }
    if (!Array.isArray(q.optionsBn) || q.optionsBn.length !== 4 || q.optionsBn.some(o => !String(o ?? '').trim())) {
      throw new SeederError('INVALID_SOURCE', `Question "${qId}" must have 4 non-empty optionsBn.`);
    }
    if (
      typeof q.correctOptionIndex !== 'number' ||
      !Number.isInteger(q.correctOptionIndex) ||
      q.correctOptionIndex < 0 ||
      q.correctOptionIndex > 3
    ) {
      throw new SeederError('INVALID_SOURCE', `Question "${qId}" has invalid correctOptionIndex.`);
    }
  }

  const examIdSet = new Set();
  for (let i = 0; i < rawExams.length; i++) {
    const ex = rawExams[i];
    const exId = typeof ex?.id === 'string' ? ex.id.trim() : '';
    if (!exId) {
      throw new SeederError('INVALID_SOURCE', `Exam at index ${i} is missing id.`);
    }
    if (examIdSet.has(exId)) {
      throw new SeederError('INVALID_SOURCE', `Duplicate exam id "${exId}" in source data.`);
    }
    examIdSet.add(exId);

    if (typeof ex.titleBn !== 'string' || !ex.titleBn.trim()) {
      throw new SeederError('INVALID_SOURCE', `Exam "${exId}" is missing titleBn.`);
    }
    if (!Array.isArray(ex.questionIds) || ex.questionIds.length === 0) {
      throw new SeederError('INVALID_SOURCE', `Exam "${exId}" has empty questionIds.`);
    }
    for (const refQId of ex.questionIds) {
      if (!questionIdSet.has(String(refQId).trim())) {
        throw new SeederError(
          'INVALID_SOURCE',
          `Exam "${exId}" references missing question id "${refQId}".`
        );
      }
    }
  }

  return { questions: rawQuestions, exams: rawExams };
}

// ---------------------------------------------------------
// Firestore REST Client Operations (Read & Create-Only Commit)
// ---------------------------------------------------------

function parseFirestoreErrorPayload(rawText, status) {
  try {
    const parsed = JSON.parse(rawText);
    const err = parsed?.error;
    if (err) {
      return {
        statusText: String(err.status || `HTTP_${status}`),
        message: sanitizeDiagnosticMessage(err.message || `Firestore REST failed (${status})`)
      };
    }
  } catch {
    // Non-JSON body
  }
  return {
    statusText: `HTTP_${status}`,
    message: sanitizeDiagnosticMessage(rawText || `Firestore REST failed (${status})`)
  };
}

export async function listCollectionDocumentsRest(fetchImpl, token, collectionName, options = {}) {
  const cleanCollection = collectionName.replace(/^\/+|\/+$/g, '');
  const pageSize = Math.min(500, Math.max(1, Math.floor(options.pageSize ?? 500)));
  const maxPages = Math.min(200, Math.max(1, Math.floor(options.maxPages ?? 100)));
  const docs = [];
  let pageToken = '';
  let pagesFetched = 0;

  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({ pageSize: String(pageSize) });
    if (pageToken) {
      params.set('pageToken', pageToken);
    }
    const url = `${FIRESTORE_REST_BASE_URL}/${cleanCollection}?${params.toString()}`;
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      }
    });

    const text = await res.text();
    if (!res.ok) {
      const { statusText, message } = parseFirestoreErrorPayload(text, res.status);
      if (res.status === 401 || res.status === 403 || statusText === 'PERMISSION_DENIED') {
        throw new SeederError(
          'OWNER_AUTH_REJECTED',
          `Firestore rejected Owner authorization reading /${cleanCollection} (${res.status} ${statusText}): ${message}`
        );
      }
      throw new SeederError(
        'FIRESTORE_READ_FAILED',
        `Failed reading /${cleanCollection} (${res.status} ${statusText}): ${message}`
      );
    }

    const data = text ? JSON.parse(text) : {};
    pagesFetched += 1;
    for (const doc of data.documents || []) {
      docs.push({
        id: extractDocumentId(doc.name),
        ...decodeDocumentFields(doc.fields)
      });
    }

    if (!data.nextPageToken) {
      return { docs, pagesFetched };
    }
    pageToken = String(data.nextPageToken);
  }

  throw new SeederError(
    'PAGINATION_LIMIT_EXCEEDED',
    `Collection /${cleanCollection} exceeded maxPages=${maxPages} pagination limit.`
  );
}

export async function getDocumentRest(fetchImpl, token, collectionName, docId) {
  const cleanCollection = collectionName.replace(/^\/+|\/+$/g, '');
  const url = `${FIRESTORE_REST_BASE_URL}/${cleanCollection}/${encodeURIComponent(docId)}`;
  const res = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json'
    }
  });

  if (res.status === 404) {
    return null;
  }

  const text = await res.text();
  if (!res.ok) {
    const { statusText, message } = parseFirestoreErrorPayload(text, res.status);
    if (res.status === 401 || res.status === 403 || statusText === 'PERMISSION_DENIED') {
      throw new SeederError(
        'OWNER_AUTH_REJECTED',
        `Firestore rejected Owner authorization reading /${cleanCollection}/${docId} (${res.status} ${statusText}): ${message}`
      );
    }
    throw new SeederError(
      'FIRESTORE_READ_FAILED',
      `Failed reading /${cleanCollection}/${docId} (${res.status} ${statusText}): ${message}`
    );
  }

  const doc = text ? JSON.parse(text) : {};
  return {
    id: extractDocumentId(doc.name || docId),
    ...decodeDocumentFields(doc.fields)
  };
}

export function buildCreateOnlyWriteOp(collection, docId, data) {
  const cleanCollection = collection.replace(/^\/+|\/+$/g, '');
  return {
    update: {
      name: `${FIRESTORE_DOCUMENTS_ROOT}/${cleanCollection}/${encodeURIComponent(docId)}`,
      fields: encodeDocumentFields(data)
    },
    currentDocument: { exists: false }
  };
}

async function commitCreateBatchRest(fetchImpl, token, writes) {
  const res = await fetchImpl(`${FIRESTORE_REST_BASE_URL}:commit`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({ writes })
  });

  const text = await res.text();
  if (!res.ok) {
    const { statusText, message } = parseFirestoreErrorPayload(text, res.status);
    if (res.status === 401 || res.status === 403 || statusText === 'PERMISSION_DENIED') {
      throw new SeederError(
        'OWNER_AUTH_REJECTED',
        `Firestore rejected Owner authorization during commit (${res.status} ${statusText}): ${message}`
      );
    }
    throw new SeederError(
      'FIRESTORE_COMMIT_FAILED',
      `Firestore commit failed (${res.status} ${statusText}): ${message}`
    );
  }
  return text ? JSON.parse(text) : {};
}

// ---------------------------------------------------------
// Conflict Comparison Helpers
// ---------------------------------------------------------

function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function findQuestionConflictReason(existing, expected) {
  if (
    'correctOptionIndex' in existing ||
    'explanationBn' in existing ||
    'explanationEn' in existing
  ) {
    return 'Existing /questions doc contains embedded answer key or explanation fields.';
  }
  if (String(existing.subjectId ?? '') !== expected.subjectId) return 'subjectId mismatch';
  if (String(existing.questionBn ?? '') !== expected.questionBn) return 'questionBn mismatch';
  if (String(existing.questionEn ?? '') !== expected.questionEn) return 'questionEn mismatch';
  if (!arraysEqual(existing.optionsBn, expected.optionsBn)) return 'optionsBn mismatch';
  if (!arraysEqual(existing.optionsEn, expected.optionsEn)) return 'optionsEn mismatch';
  if (String(existing.legalReference ?? '') !== expected.legalReference) return 'legalReference mismatch';
  if (String(existing.difficulty ?? 'medium') !== expected.difficulty) return 'difficulty mismatch';
  if (String(existing.status ?? 'published') !== expected.status) return 'status mismatch';
  if (Boolean(existing.isDemoSample) !== expected.isDemoSample) return 'isDemoSample mismatch';
  if ((existing.topicId ?? null) !== (expected.topicId ?? null)) return 'topicId mismatch';
  return null;
}

function findQuestionKeyConflictReason(existing, expected) {
  if (Number(existing.correctOptionIndex) !== expected.correctOptionIndex) {
    return 'correctOptionIndex mismatch';
  }
  if (String(existing.explanationBn ?? '') !== expected.explanationBn) {
    return 'explanationBn mismatch';
  }
  if (String(existing.explanationEn ?? '') !== expected.explanationEn) {
    return 'explanationEn mismatch';
  }
  if (String(existing.legalReference ?? '') !== expected.legalReference) {
    return 'legalReference mismatch';
  }
  return null;
}

function findExamConflictReason(existing, expected) {
  // Preserve admin-customizable fields (isActive, scheduledDate, isPaid, published, passThresholdPercentage),
  // while flagging structural identity mismatches as conflicts.
  if (String(existing.type ?? 'full_mock') !== expected.type) return 'type mismatch';
  if (Number(existing.durationMinutes) !== expected.durationMinutes) return 'durationMinutes mismatch';
  if (Number(existing.totalMarks) !== expected.totalMarks) return 'totalMarks mismatch';
  if ((existing.subjectId ?? null) !== (expected.subjectId ?? null)) return 'subjectId mismatch';
  if (!arraysEqual(existing.questionIds, expected.questionIds)) return 'questionIds mismatch';
  return null;
}

function chunkItems(items, maxSize = MAX_COMMIT_BATCH_SIZE) {
  const out = [];
  for (let i = 0; i < items.length; i += maxSize) {
    out.push(items.slice(i, i + maxSize));
  }
  return out;
}

// ---------------------------------------------------------
// Core Inspection, Planning & Execution
// ---------------------------------------------------------

export async function runSeedFirestoreKeyless(options = {}) {
  const mode = options.execute === true ? 'execute' : 'dry-run';
  const nowMs = typeof options.nowMs === 'number' ? options.nowMs : Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const fetchImpl = options.fetchImpl || fetch;
  const batchSize = Math.min(
    MAX_COMMIT_BATCH_SIZE,
    Math.max(1, Math.floor(options.batchSize ?? MAX_COMMIT_BATCH_SIZE))
  );

  const rawToken =
    options.token !== undefined ? options.token : process.env.OWNER_FIREBASE_ID_TOKEN;
  const { token } = validateOwnerIdToken(rawToken, nowMs);

  const { questions, exams } = loadAndValidateSources(options);

  const [questionsRes, keysRes, examsRes, versionDoc] = await Promise.all([
    listCollectionDocumentsRest(fetchImpl, token, 'questions', { pageSize: options.pageSize }),
    listCollectionDocumentsRest(fetchImpl, token, 'questionKeys', { pageSize: options.pageSize }),
    listCollectionDocumentsRest(fetchImpl, token, 'exams', { pageSize: options.pageSize }),
    getDocumentRest(fetchImpl, token, 'config', 'questionBankVersion')
  ]);

  const existingQuestionsMap = new Map(questionsRes.docs.map(d => [d.id, d]));
  const existingKeysMap = new Map(keysRes.docs.map(d => [d.id, d]));
  const existingExamsMap = new Map(examsRes.docs.map(d => [d.id, d]));

  const conflicts = [];
  const matching = { questions: [], questionKeys: [], exams: [] };
  const missingQuestionOps = [];
  const missingKeyOps = [];
  const missingExamOps = [];

  for (const q of questions) {
    const qId = String(q.id).trim();
    const sanitized = buildSanitizedQuestionDoc(q, nowIso);
    const existingQ = existingQuestionsMap.get(qId);
    if (!existingQ) {
      missingQuestionOps.push(buildCreateOnlyWriteOp('questions', qId, sanitized));
    } else {
      const reason = findQuestionConflictReason(existingQ, sanitized);
      if (reason) {
        conflicts.push({ collection: 'questions', docId: qId, reason });
      } else {
        matching.questions.push(qId);
      }
    }

    const keyDoc = buildQuestionKeyDoc(q, nowIso);
    const existingKey = existingKeysMap.get(qId);
    if (!existingKey) {
      missingKeyOps.push(buildCreateOnlyWriteOp('questionKeys', qId, keyDoc));
    } else {
      const reason = findQuestionKeyConflictReason(existingKey, keyDoc);
      if (reason) {
        conflicts.push({ collection: 'questionKeys', docId: qId, reason });
      } else {
        matching.questionKeys.push(qId);
      }
    }
  }

  for (const exam of exams) {
    const exId = String(exam.id).trim();
    const examDoc = buildExamDoc(exam, nowIso);
    const existingExam = existingExamsMap.get(exId);
    if (!existingExam) {
      missingExamOps.push(buildCreateOnlyWriteOp('exams', exId, examDoc));
    } else {
      const reason = findExamConflictReason(existingExam, examDoc);
      if (reason) {
        conflicts.push({ collection: 'exams', docId: exId, reason });
      } else {
        matching.exams.push(exId);
      }
    }
  }

  const dataWritesPlanned =
    missingQuestionOps.length + missingKeyOps.length + missingExamOps.length;

  let versionDocumentStatus;
  let versionPayload = null;
  let versionBatchOps = [];

  if (!versionDoc) {
    versionDocumentStatus = 'missing (will create last)';
    versionPayload =
      options.versionPayload || createQuestionBankVersionPayload(nowMs, nowIso);
    versionBatchOps = [buildCreateOnlyWriteOp('config', 'questionBankVersion', versionPayload)];
  } else if (dataWritesPlanned > 0) {
    versionDocumentStatus = `exists (versionToken=${String(versionDoc.versionToken || versionDoc.version || 'unknown')})`;
    conflicts.push({
      collection: 'config',
      docId: 'questionBankVersion',
      reason:
        'config/questionBankVersion already exists while missing documents remain; create-only seeder will not overwrite existing version document.'
    });
  } else {
    versionDocumentStatus = `exists (versionToken=${String(versionDoc.versionToken || versionDoc.version || 'unknown')}, up-to-date)`;
  }

  const questionBatches = chunkItems(missingQuestionOps, batchSize).map((writes, idx) => ({
    phase: 'questions',
    phaseBatchNumber: idx + 1,
    writes
  }));
  const keyBatches = chunkItems(missingKeyOps, batchSize).map((writes, idx) => ({
    phase: 'questionKeys',
    phaseBatchNumber: idx + 1,
    writes
  }));
  const examBatches = chunkItems(missingExamOps, batchSize).map((writes, idx) => ({
    phase: 'exams',
    phaseBatchNumber: idx + 1,
    writes
  }));
  const versionBatches =
    versionBatchOps.length > 0 && conflicts.length === 0
      ? [{ phase: 'config/questionBankVersion', phaseBatchNumber: 1, writes: versionBatchOps }]
      : [];

  const plannedBatches = [...questionBatches, ...keyBatches, ...examBatches, ...versionBatches];
  const safeToExecute = conflicts.length === 0;

  const summary = {
    mode,
    projectId: FIREBASE_PROJECT_ID,
    databaseId: FIRESTORE_DATABASE_ID,
    sourceCounts: {
      questions: questions.length,
      questionKeys: questions.length,
      exams: exams.length
    },
    existingFirestoreCounts: {
      questions: existingQuestionsMap.size,
      questionKeys: existingKeysMap.size,
      exams: existingExamsMap.size,
      questionBankVersionExists: Boolean(versionDoc)
    },
    paginationPagesRead: {
      questions: questionsRes.pagesFetched,
      questionKeys: keysRes.pagesFetched,
      exams: examsRes.pagesFetched
    },
    matchingCounts: {
      questions: matching.questions.length,
      questionKeys: matching.questionKeys.length,
      exams: matching.exams.length
    },
    wouldCreate: {
      questions: missingQuestionOps.length,
      questionKeys: missingKeyOps.length,
      exams: missingExamOps.length,
      versionDocument: versionBatches.length,
      total: dataWritesPlanned + versionBatches.length
    },
    conflicts,
    versionDocumentStatus,
    ...(versionPayload ? { plannedVersionToken: versionPayload.versionToken } : {}),
    plannedCommitBatches: {
      questions: questionBatches.length,
      questionKeys: keyBatches.length,
      exams: examBatches.length,
      versionDocument: versionBatches.length,
      total: plannedBatches.length,
      maxBatchSize: batchSize
    },
    safeToExecute,
    executed: false,
    batchesSucceeded: 0,
    writesCommitted: 0
  };

  if (mode === 'dry-run') {
    return summary;
  }

  if (!safeToExecute) {
    throw new SeederError(
      'CONFLICT_DETECTED',
      `Aborting --execute: ${conflicts.length} conflict(s) detected during pre-flight inspection. Zero writes committed.`,
      summary
    );
  }

  if (plannedBatches.length === 0) {
    return { ...summary, executed: true };
  }

  let batchesSucceeded = 0;
  let writesCommitted = 0;

  for (let i = 0; i < plannedBatches.length; i++) {
    const batch = plannedBatches[i];
    try {
      await commitCreateBatchRest(fetchImpl, token, batch.writes);
      batchesSucceeded += 1;
      writesCommitted += batch.writes.length;
    } catch (err) {
      const partialSummary = {
        ...summary,
        executed: false,
        partialExecution: batchesSucceeded > 0,
        batchesSucceeded,
        writesCommitted,
        failedBatch: {
          batchNumber: i + 1,
          totalBatches: plannedBatches.length,
          phase: batch.phase,
          phaseBatchNumber: batch.phaseBatchNumber,
          writeCount: batch.writes.length,
          error: sanitizeDiagnosticMessage(err instanceof Error ? err.message : String(err))
        }
      };
      throw new SeederError(
        err instanceof SeederError ? err.code : 'BATCH_COMMIT_FAILED',
        `Execution stopped at batch ${i + 1}/${plannedBatches.length} (${batch.phase} #${batch.phaseBatchNumber}). ${batchesSucceeded} batch(es) (${writesCommitted} writes) committed before failure; remaining batches and config/questionBankVersion were NOT written.`,
        partialSummary
      );
    }
  }

  return {
    ...summary,
    executed: true,
    batchesSucceeded,
    writesCommitted
  };
}

function formatReport(report) {
  const lines = [
    `=== Sanad Prep BD: Keyless Firestore REST Seeder (${report.mode.toUpperCase()}) ===`,
    `Target: ${report.projectId} / ${report.databaseId}`,
    `Source counts -> questions: ${report.sourceCounts.questions}, questionKeys: ${report.sourceCounts.questionKeys}, exams: ${report.sourceCounts.exams}`,
    `Existing Firestore counts -> questions: ${report.existingFirestoreCounts.questions}, questionKeys: ${report.existingFirestoreCounts.questionKeys}, exams: ${report.existingFirestoreCounts.exams}, config/questionBankVersion: ${report.existingFirestoreCounts.questionBankVersionExists ? 'exists' : 'missing'}`,
    `Matching preserved IDs -> questions: ${report.matchingCounts.questions}, questionKeys: ${report.matchingCounts.questionKeys}, exams: ${report.matchingCounts.exams}`,
    `Documents to create (exists=false) -> questions: ${report.wouldCreate.questions}, questionKeys: ${report.wouldCreate.questionKeys}, exams: ${report.wouldCreate.exams}, config/questionBankVersion: ${report.wouldCreate.versionDocument} (total: ${report.wouldCreate.total})`,
    `Conflicting documents: ${report.conflicts.length}`,
    `Version document status: ${report.versionDocumentStatus}`,
    `Planned commit batches (max ${report.plannedCommitBatches.maxBatchSize}/batch) -> questions: ${report.plannedCommitBatches.questions}, questionKeys: ${report.plannedCommitBatches.questionKeys}, exams: ${report.plannedCommitBatches.exams}, versionDoc: ${report.plannedCommitBatches.versionDocument}, total: ${report.plannedCommitBatches.total}`,
    `Safe to execute: ${report.safeToExecute}`
  ];

  if (report.conflicts.length > 0) {
    lines.push('Conflicts (first 20):');
    for (const c of report.conflicts.slice(0, 20)) {
      lines.push(`  - ${c.collection}/${c.docId}: ${c.reason}`);
    }
  }

  if (report.mode === 'dry-run') {
    lines.push('[DRY-RUN COMPLETE] Zero Firestore write requests were sent.');
  } else if (report.executed) {
    lines.push(
      `[EXECUTED] Committed ${report.writesCommitted} create-only writes across ${report.batchesSucceeded} batch(es).`
    );
  }

  return lines.join('\n');
}

async function main() {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (parsed.help) {
    console.log(
      'Usage:\n' +
        '  node scripts/seedFirestoreKeyless.mjs [--dry-run]   # Read-only inspection (default)\n' +
        '  node scripts/seedFirestoreKeyless.mjs --execute     # Create missing docs only (requires OWNER_FIREBASE_ID_TOKEN)'
    );
    return;
  }
  if (!parsed.valid) {
    console.error(`[ERROR] ${parsed.error}`);
    process.exitCode = 1;
    return;
  }

  try {
    const report = await runSeedFirestoreKeyless({ execute: parsed.execute });
    console.log(formatReport(report));
    if (!report.safeToExecute) {
      process.exitCode = 1;
    }
  } catch (err) {
    const msg = sanitizeDiagnosticMessage(err instanceof Error ? err.message : String(err));
    console.error(`[FAILED] ${err instanceof SeederError ? `[${err.code}] ` : ''}${msg}`);
    if (err instanceof SeederError && err.details) {
      if (err.details.failedBatch) {
        console.error('Failed batch details:', JSON.stringify(err.details.failedBatch, null, 2));
      } else if (Array.isArray(err.details.conflicts)) {
        console.error(`Conflicts (${err.details.conflicts.length}):`, JSON.stringify(err.details.conflicts.slice(0, 20), null, 2));
      }
    }
    process.exitCode = 1;
  }
}

const isMainEntry =
  typeof process !== 'undefined' &&
  Boolean(process.argv[1]) &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMainEntry) {
  await main();
}
