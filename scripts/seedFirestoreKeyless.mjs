import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FIREBASE_PROJECT_ID = 'galvanic-aviary-tzp2g';
export const FIRESTORE_DATABASE_ID = 'ai-studio-barcouncilmcqpre-9a5aecc8-3819-4aeb-b7e2-c6066b637cab';
export const OWNER_ADMIN_UID = 'PjBRV7LAQ8cIwOdM3z474A16dWg2';
export const OWNER_ADMIN_EMAIL = 'khayrulalam88@gmail.com';
export const DEFAULT_WORKER_BASE_URL = 'https://s--khayrul-alam.khayrulalam88.workers.dev';
export const MAX_QUESTION_BATCH_COUNT = 75;
export const MAX_EXAM_BATCH_COUNT = 20;
export const MAX_BATCH_PAYLOAD_BYTES = 380_000;

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

export function normalizeWorkerBaseUrl(rawUrl) {
  const candidate = String(rawUrl || DEFAULT_WORKER_BASE_URL).trim();
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new SeederError('INVALID_WORKER_URL', `Invalid Worker URL: "${candidate}".`);
  }
  const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(isLocal && parsed.protocol === 'http:')) {
    throw new SeederError(
      'INVALID_WORKER_URL',
      'Worker URL must use https:// (or http://localhost / http://127.0.0.1 for local tests).'
    );
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

export function parseCliArgs(argv) {
  const args = argv.filter(Boolean);
  let dryRun = false;
  let execute = false;
  let help = false;
  let skipD1Sync = false;
  let workerUrl;
  let batchSize;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--execute') {
      execute = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--skip-d1-sync') {
      skipD1Sync = true;
    } else if (arg === '--worker-url') {
      const val = args[i + 1];
      if (!val || val.startsWith('--')) {
        return { valid: false, help: false, dryRun: false, execute: false, error: 'Missing value for --worker-url.' };
      }
      workerUrl = val;
      i += 1;
    } else if (arg.startsWith('--worker-url=')) {
      workerUrl = arg.slice('--worker-url='.length);
    } else if (arg === '--batch-size') {
      const val = Number(args[i + 1]);
      if (!Number.isInteger(val) || val < 1 || val > 100) {
        return { valid: false, help: false, dryRun: false, execute: false, error: 'Invalid --batch-size (must be 1..100).' };
      }
      batchSize = val;
      i += 1;
    } else if (arg.startsWith('--batch-size=')) {
      const val = Number(arg.slice('--batch-size='.length));
      if (!Number.isInteger(val) || val < 1 || val > 100) {
        return { valid: false, help: false, dryRun: false, execute: false, error: 'Invalid --batch-size (must be 1..100).' };
      }
      batchSize = val;
    } else {
      return {
        valid: false,
        help: false,
        dryRun: false,
        execute: false,
        error: `Unknown argument "${arg}". Allowed: --dry-run (default), --execute, --worker-url <url>, --batch-size <1-100>, --skip-d1-sync, --help`
      };
    }
  }

  if (help) {
    return { valid: true, help: true, dryRun: true, execute: false, skipD1Sync };
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
    execute,
    skipD1Sync,
    ...(workerUrl ? { workerUrl } : {}),
    ...(batchSize !== undefined ? { batchSize } : {})
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
  if (/^Bearer\s+/i.test(token)) {
    throw new SeederError(
      'INVALID_TOKEN',
      'OWNER_FIREBASE_ID_TOKEN must be the raw Firebase ID token JWT without a "Bearer " prefix.'
    );
  }
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    throw new SeederError(
      'INVALID_TOKEN',
      'OWNER_FIREBASE_ID_TOKEN contains surrounding quotes. Pass the raw JWT without quotes.'
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
  const iss = typeof claims.iss === 'string' ? claims.iss.trim() : '';
  const expSec = typeof claims.exp === 'number' ? claims.exp : Number(claims.exp);

  if (aud && aud !== FIREBASE_PROJECT_ID) {
    throw new SeederError(
      'TOKEN_PROJECT_MISMATCH',
      `Token audience "${aud}" does not match project "${FIREBASE_PROJECT_ID}".`
    );
  }
  if (iss && iss !== `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`) {
    throw new SeederError(
      'TOKEN_ISSUER_MISMATCH',
      `Token issuer "${iss}" does not match Firebase project "${FIREBASE_PROJECT_ID}".`
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

export function buildBoundedPayloadChunks(items, fieldName, dryRun, maxCount, maxBytes = MAX_BATCH_PAYLOAD_BYTES) {
  const chunks = [];
  let current = [];

  for (const item of items) {
    const candidate = [...current, item];
    const candidateJson = JSON.stringify({ dryRun, [fieldName]: candidate });
    const exceedsCount = candidate.length > maxCount;
    const exceedsBytes = Buffer.byteLength(candidateJson, 'utf8') > maxBytes;

    if (current.length > 0 && (exceedsCount || exceedsBytes)) {
      chunks.push(current);
      current = [item];
    } else {
      current = candidate;
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

async function callWorkerSeedApi(fetchImpl, url, token, body, options = {}) {
  const sleepFn = options.sleepFn || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const maxRetries = options.maxRetries ?? 3;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify(body)
      });
    } catch (err) {
      throw new SeederError(
        'WORKER_NETWORK_ERROR',
        `Network error calling Worker endpoint ${url}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const rawText = await res.text();
    let parsed = {};
    if (rawText) {
      try {
        parsed = JSON.parse(rawText);
      } catch {
        throw new SeederError(
          'WORKER_NON_JSON',
          `Worker endpoint returned non-JSON HTTP ${res.status}.`
        );
      }
    }

    if (res.status === 429 && attempt < maxRetries) {
      const retryAfterHdr = Number(res.headers?.get?.('retry-after') || parsed.retryAfterSeconds || '5');
      const waitMs = Math.min(65_000, Math.max(1000, (Number.isFinite(retryAfterHdr) ? retryAfterHdr : 5) * 1000 + 250));
      await sleepFn(waitMs);
      continue;
    }

    if (res.status === 401 || res.status === 403 || parsed.error === 'PERMISSION_DENIED') {
      throw new SeederError(
        'OWNER_AUTH_REJECTED',
        `Worker/Firestore rejected Owner authorization (${res.status} ${parsed.error || ''}): ${parsed.message || 'Forbidden'}`
      );
    }

    if (res.status === 409 || parsed.error === 'CONFLICT_DETECTED') {
      throw new SeederError(
        'CONFLICT_DETECTED',
        parsed.message || `Conflict detected during seeding (${res.status}).`,
        parsed
      );
    }

    if (!res.ok) {
      throw new SeederError(
        parsed.error || 'WORKER_REQUEST_FAILED',
        `Worker request failed (${res.status} ${parsed.error || ''}): ${parsed.message || rawText || 'Unknown error'}`,
        parsed
      );
    }

    return parsed;
  }

  throw new SeederError('RATE_LIMITED', 'Worker rate limit retries exhausted.');
}

export async function runSeedFirestoreKeyless(options = {}) {
  const mode = options.execute === true ? 'execute' : 'dry-run';
  const dryRun = mode === 'dry-run';
  const nowMs = typeof options.nowMs === 'number' ? options.nowMs : Date.now();
  const fetchImpl = options.fetchImpl || fetch;
  const workerBaseUrl = normalizeWorkerBaseUrl(
    options.workerUrl || process.env.SANAD_WORKER_URL || DEFAULT_WORKER_BASE_URL
  );
  const questionBatchMax = Math.min(
    100,
    Math.max(1, Math.floor(options.batchSize ?? MAX_QUESTION_BATCH_COUNT))
  );
  const examBatchMax = Math.min(
    50,
    Math.max(1, Math.floor(options.examBatchSize ?? MAX_EXAM_BATCH_COUNT))
  );

  const rawToken =
    options.token !== undefined ? options.token : process.env.OWNER_FIREBASE_ID_TOKEN;
  const { token } = validateOwnerIdToken(rawToken, nowMs);

  const { questions, exams } = loadAndValidateSources(options);

  const questionChunks = buildBoundedPayloadChunks(
    questions,
    'questions',
    dryRun,
    questionBatchMax,
    options.maxPayloadBytes ?? MAX_BATCH_PAYLOAD_BYTES
  );
  const examChunks = buildBoundedPayloadChunks(
    exams,
    'exams',
    dryRun,
    examBatchMax,
    options.maxPayloadBytes ?? MAX_BATCH_PAYLOAD_BYTES
  );

  const totalPlannedDataBatches = questionChunks.length + examChunks.length;
  const preflightEndpoint = `${workerBaseUrl}/api/admin/seed/question-bank/preflight`;
  const batchEndpoint = `${workerBaseUrl}/api/admin/seed/question-bank/batch`;
  const finalizeEndpoint = `${workerBaseUrl}/api/admin/seed/question-bank/finalize`;
  const syncCacheEndpoint = `${workerBaseUrl}/api/admin/questions/sync-cache`;

  const preflightRes = await callWorkerSeedApi(
    fetchImpl,
    preflightEndpoint,
    token,
    { dryRun },
    { sleepFn: options.sleepFn }
  );

  if (!dryRun && !preflightRes.safeToExecute) {
    const preflightConflicts = Array.isArray(preflightRes.conflicts) ? preflightRes.conflicts : [];
    throw new SeederError(
      'CONFLICT_DETECTED',
      preflightConflicts[0]?.reason ||
        'Preflight failed: config/questionBankVersion marker is incompatible. Aborting before any batch writes.',
      {
        mode,
        workerBaseUrl,
        projectId: FIREBASE_PROJECT_ID,
        databaseId: FIRESTORE_DATABASE_ID,
        partialExecution: false,
        batchesSucceeded: 0,
        writesCommitted: 0,
        conflicts: preflightConflicts,
        safeToExecute: false
      }
    );
  }

  const existingCounts = {
    questions: 0,
    questionKeys: 0,
    exams: 0,
    questionBankVersionExists: Boolean(preflightRes.versionExists)
  };
  const matchingCounts = { questions: 0, questionKeys: 0, exams: 0 };
  const wouldCreate = { questions: 0, questionKeys: 0, exams: 0, versionDocument: 0, total: 0 };
  const conflicts = [];

  let batchesSucceeded = 0;
  let writesCommitted = 0;

  const processBatch = async (phase, phaseBatchNumber, batchIndex, payload) => {
    try {
      const res = await callWorkerSeedApi(fetchImpl, batchEndpoint, token, payload, {
        sleepFn: options.sleepFn
      });

      existingCounts.questions += Number(res.existing?.questions || 0);
      existingCounts.questionKeys += Number(res.existing?.questionKeys || 0);
      existingCounts.exams += Number(res.existing?.exams || 0);

      matchingCounts.questions += Number(res.matching?.questions || 0);
      matchingCounts.questionKeys += Number(res.matching?.questionKeys || 0);
      matchingCounts.exams += Number(res.matching?.exams || 0);

      wouldCreate.questions += Number(res.wouldCreate?.questions || 0);
      wouldCreate.questionKeys += Number(res.wouldCreate?.questionKeys || 0);
      wouldCreate.exams += Number(res.wouldCreate?.exams || 0);

      if (Array.isArray(res.conflicts) && res.conflicts.length > 0) {
        conflicts.push(...res.conflicts);
      }

      if (!dryRun) {
        batchesSucceeded += 1;
        writesCommitted += Number(res.writesCommitted || 0);
      }
    } catch (err) {
      const baseDetails = err instanceof SeederError && err.details ? err.details : {};
      if (Array.isArray(baseDetails.conflicts)) {
        conflicts.push(...baseDetails.conflicts);
      }
      const partialSummary = {
        mode,
        workerBaseUrl,
        projectId: FIREBASE_PROJECT_ID,
        databaseId: FIRESTORE_DATABASE_ID,
        partialExecution: batchesSucceeded > 0,
        batchesSucceeded,
        writesCommitted,
        conflicts,
        safeToExecute: false,
        failedBatch: {
          batchNumber: batchIndex + 1,
          totalBatches: totalPlannedDataBatches + 1,
          phase,
          phaseBatchNumber,
          error: sanitizeDiagnosticMessage(err instanceof Error ? err.message : String(err))
        }
      };

      if (err instanceof SeederError && err.code === 'CONFLICT_DETECTED') {
        throw new SeederError(
          'CONFLICT_DETECTED',
          `Aborting ${mode}: ${conflicts.length} conflict(s) detected in batch ${batchIndex + 1}. Remaining batches and config/questionBankVersion were NOT written.`,
          partialSummary
        );
      }
      if (err instanceof SeederError && err.code === 'OWNER_AUTH_REJECTED') {
        throw err;
      }

      throw new SeederError(
        err instanceof SeederError ? err.code : 'BATCH_COMMIT_FAILED',
        `Execution stopped at batch ${batchIndex + 1}/${totalPlannedDataBatches + 1} (${phase} #${phaseBatchNumber}). ${batchesSucceeded} batch(es) (${writesCommitted} writes) committed before failure; remaining batches and config/questionBankVersion were NOT written.`,
        partialSummary
      );
    }
  };

  let batchIdx = 0;
  for (let i = 0; i < questionChunks.length; i++) {
    await processBatch('questions+questionKeys', i + 1, batchIdx++, {
      dryRun,
      questions: questionChunks[i]
    });
  }
  for (let i = 0; i < examChunks.length; i++) {
    await processBatch('exams', i + 1, batchIdx++, {
      dryRun,
      exams: examChunks[i]
    });
  }

  const dataWritesTotal = wouldCreate.questions + wouldCreate.questionKeys + wouldCreate.exams;

  let versionRes = {};
  if (dryRun || conflicts.length === 0) {
    versionRes = await callWorkerSeedApi(
      fetchImpl,
      finalizeEndpoint,
      token,
      {
        dryRun,
        pendingDataWrites: dryRun ? dataWritesTotal : writesCommitted,
        questionsCreated: wouldCreate.questions,
        questionKeysCreated: wouldCreate.questionKeys,
        examsCreated: wouldCreate.exams,
        expectedVersionExists: Boolean(preflightRes.versionExists),
        ...(preflightRes.expectedUpdateTime
          ? { expectedUpdateTime: preflightRes.expectedUpdateTime }
          : {}),
        ...(preflightRes.existingVersionToken
          ? { expectedVersionToken: preflightRes.existingVersionToken }
          : {})
      },
      { sleepFn: options.sleepFn }
    );
  }

  existingCounts.questionBankVersionExists = Boolean(
    versionRes.versionExists ?? preflightRes.versionExists
  );
  const versionConflicts = Array.isArray(versionRes.conflicts)
    ? versionRes.conflicts
    : Array.isArray(preflightRes.conflicts)
    ? preflightRes.conflicts
    : [];
  if (versionConflicts.length > 0) {
    conflicts.push(...versionConflicts);
  }

  const versionDocCreatePlanned = existingCounts.questionBankVersionExists ? 0 : 1;
  const versionDocUpdatePlanned = Number(
    versionRes.wouldUpdateVersionDocument ??
      (existingCounts.questionBankVersionExists && dataWritesTotal > 0 ? 1 : 0)
  );
  wouldCreate.versionDocument = versionDocCreatePlanned;
  wouldCreate.total = dataWritesTotal + versionDocCreatePlanned;

  if (!dryRun) {
    writesCommitted += Number(versionRes.writesCommitted || 0);
    if (Number(versionRes.writesCommitted || 0) > 0) {
      batchesSucceeded += 1;
    }
  }

  let d1SyncResult = null;
  if (!dryRun && options.syncD1 !== false) {
    try {
      d1SyncResult = await callWorkerSeedApi(fetchImpl, syncCacheEndpoint, token, {}, {
        sleepFn: options.sleepFn
      });
    } catch (err) {
      d1SyncResult = {
        success: false,
        error: sanitizeDiagnosticMessage(err instanceof Error ? err.message : String(err))
      };
    }
  }

  const safeToExecute =
    conflicts.length === 0 &&
    (dryRun ? preflightRes.safeToExecute !== false && versionRes.safeToExecute !== false : true);
  const finalizeBatchCount = versionDocCreatePlanned > 0 || versionDocUpdatePlanned > 0 ? 1 : 0;

  return {
    mode,
    authPath: 'worker-owner-id-token-via-batchGet-and-commit',
    workerBaseUrl,
    projectId: FIREBASE_PROJECT_ID,
    databaseId: FIRESTORE_DATABASE_ID,
    sourceCounts: {
      questions: questions.length,
      questionKeys: questions.length,
      exams: exams.length
    },
    existingFirestoreCounts: existingCounts,
    matchingCounts,
    wouldCreate,
    wouldUpdateVersionDocument: versionDocUpdatePlanned,
    conflicts,
    versionDocumentStatus: String(
      versionRes.versionDocumentStatus ||
        preflightRes.versionDocumentStatus ||
        (existingCounts.questionBankVersionExists ? 'exists' : 'missing')
    ),
    ...(preflightRes.existingVersionToken
      ? { existingVersionToken: preflightRes.existingVersionToken }
      : {}),
    ...(preflightRes.expectedUpdateTime
      ? { existingVersionUpdateTime: preflightRes.expectedUpdateTime }
      : {}),
    ...(versionRes.plannedVersionToken ? { plannedVersionToken: versionRes.plannedVersionToken } : {}),
    ...(versionRes.versionToken ? { versionToken: versionRes.versionToken } : {}),
    plannedCommitBatches: {
      questionsAndKeys: questionChunks.length,
      exams: examChunks.length,
      versionDocument: finalizeBatchCount,
      total: totalPlannedDataBatches + finalizeBatchCount,
      maxQuestionBatchSize: questionBatchMax,
      maxExamBatchSize: examBatchMax
    },
    safeToExecute,
    executed: !dryRun,
    batchesSucceeded,
    writesCommitted,
    ...(d1SyncResult ? { d1SyncResult } : {})
  };
}

function formatReport(report) {
  const lines = [
    `=== Sanad Prep BD: Worker-Mediated Keyless Firestore Seeder (${report.mode.toUpperCase()}) ===`,
    `Worker URL: ${report.workerBaseUrl}`,
    `Target Firebase: ${report.projectId} / ${report.databaseId}`,
    `Source counts -> questions: ${report.sourceCounts.questions}, questionKeys: ${report.sourceCounts.questionKeys}, exams: ${report.sourceCounts.exams}`,
    `Existing Firestore counts -> questions: ${report.existingFirestoreCounts.questions}, questionKeys: ${report.existingFirestoreCounts.questionKeys}, exams: ${report.existingFirestoreCounts.exams}, config/questionBankVersion: ${report.existingFirestoreCounts.questionBankVersionExists ? 'exists' : 'missing'}`,
    `Existing version marker: ${report.versionDocumentStatus}`,
    `Conflicting documents: ${report.conflicts.length}`,
    `Questions to create: ${report.wouldCreate.questions}`,
    `Question keys to create: ${report.wouldCreate.questionKeys}`,
    `Existing exams preserved: ${report.matchingCounts.exams}`,
    `Exams to create: ${report.wouldCreate.exams}`,
    `Worker batches -> questions+keys: ${report.plannedCommitBatches.questionsAndKeys} (<= ${report.plannedCommitBatches.maxQuestionBatchSize}/batch), exams: ${report.plannedCommitBatches.exams}, finalize: ${report.plannedCommitBatches.versionDocument}, total: ${report.plannedCommitBatches.total}`,
    `Safe to execute: ${report.safeToExecute}`
  ];

  if (report.conflicts.length > 0) {
    lines.push('Conflicts (first 20):');
    for (const c of report.conflicts.slice(0, 20)) {
      lines.push(`  - ${c.collection}/${c.docId}: ${c.reason}`);
    }
  }

  if (report.mode === 'dry-run') {
    lines.push('[DRY-RUN COMPLETE] Zero Firestore write requests were executed.');
  } else if (report.executed) {
    lines.push(
      `[EXECUTED] Committed ${report.writesCommitted} write(s) across ${report.batchesSucceeded} Worker batch(es).`
    );
    if (report.d1SyncResult) {
      if (report.d1SyncResult.success) {
        lines.push(
          `[D1 SYNC COMPLETE] Synced ${report.d1SyncResult.questionCount} questions, ${report.d1SyncResult.keyCount} keys, ${report.d1SyncResult.examsCount} exams to D1.`
        );
      } else {
        lines.push(`[D1 SYNC WARNING] Firestore seeded, but D1 /sync-cache returned: ${report.d1SyncResult.error}`);
      }
    }
  }

  return lines.join('\n');
}

async function main() {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (parsed.help) {
    console.log(
      'Usage:\n' +
        '  node scripts/seedFirestoreKeyless.mjs [--dry-run] [--worker-url <url>]\n' +
        '  node scripts/seedFirestoreKeyless.mjs --execute [--worker-url <url>] [--skip-d1-sync]\n' +
        'Requires OWNER_FIREBASE_ID_TOKEN environment variable (raw JWT, no quotes or Bearer prefix).'
    );
    return;
  }
  if (!parsed.valid) {
    console.error(`[ERROR] ${parsed.error}`);
    process.exitCode = 1;
    return;
  }

  try {
    const report = await runSeedFirestoreKeyless({
      execute: parsed.execute,
      workerUrl: parsed.workerUrl,
      batchSize: parsed.batchSize,
      syncD1: !parsed.skipD1Sync
    });
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
        console.error(
          `Conflicts (${err.details.conflicts.length}):`,
          JSON.stringify(err.details.conflicts.slice(0, 20), null, 2)
        );
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
