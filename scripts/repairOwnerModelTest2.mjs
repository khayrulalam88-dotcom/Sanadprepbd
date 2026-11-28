import { pathToFileURL } from 'node:url';

export const FIREBASE_PROJECT_ID = 'galvanic-aviary-tzp2g';
export const OWNER_ADMIN_UID = 'PjBRV7LAQ8cIwOdM3z474A16dWg2';
export const OWNER_ADMIN_EMAIL = 'khayrulalam88@gmail.com';
export const DEFAULT_WORKER_BASE_URL = 'https://s--khayrul-alam.khayrulalam88.workers.dev';
export const TARGET_EXAM_ID = 'exam_1795671882276_o1zj5';
export const REPAIR_ENDPOINT_PATH = '/api/admin/exams/repair-model-test-2';

export const CANONICAL_LEGACY_QUESTION_IDS = [
  'q_lim_1',
  'q_sra_1',
  'q_bco_1',
  'q_crpc_1',
  'q_penal_1',
  'q_evi_1',
  'q_cpc_1'
];

// Proposed 7-question mapping from the read-only reconciliation audit.
// Note: #4 (q_bank_0609) is intentionally included as the audited CrPC Sec 144 candidate
// so dry-run demonstrates flagging NEEDS_CORRECTION_AND_OWNER_APPROVAL and blocking execution.
export const DEFAULT_PROPOSED_REPLACEMENTS = [
  'q_bank_2648', // #1 q_lim_1 -> sub_limitation (Limitation Act Sec 5)
  'q_bank_2269', // #2 q_sra_1 -> sub_sra (SRA Sec 9)
  'q_bank_2851', // #3 q_bco_1 -> sub_bar_ethics (Bar Council Art 5 / AG Chairman)
  'q_bank_0609', // #4 q_crpc_1 -> sub_crpc (CrPC Sec 144 - FLAGGED SEMANTIC MISMATCH)
  'q_bank_1292', // #5 q_penal_1 -> sub_penal (Penal Code Sec 299)
  'q_bank_1874', // #6 q_evi_1 -> sub_evidence (Evidence Act Sec 32(1))
  'q_bank_0043'  // #7 q_cpc_1 -> sub_cpc (CPC Sec 9)
];

export function sanitizeDiagnosticMessage(raw) {
  return String(raw || 'Unknown error')
    .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, '[REDACTED_KEY]')
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, '[REDACTED_JWT]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED_API_KEY]')
    .slice(0, 400);
}

export class RepairScriptError extends Error {
  constructor(code, message, details) {
    super(sanitizeDiagnosticMessage(message));
    this.name = 'RepairScriptError';
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
    throw new RepairScriptError('INVALID_WORKER_URL', `Invalid Worker URL: "${candidate}".`);
  }
  const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(isLocal && parsed.protocol === 'http:')) {
    throw new RepairScriptError(
      'INVALID_WORKER_URL',
      'Worker URL must use https:// (or http://localhost / http://127.0.0.1 for local tests).'
    );
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

export function parseRepairCliArgs(argv) {
  const args = argv.filter(Boolean);
  let dryRun = false;
  let execute = false;
  let help = false;
  let json = false;
  let workerUrl;
  let expectedUpdateTime;
  let questionIds;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--execute') {
      execute = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--worker-url') {
      const val = args[i + 1];
      if (!val || val.startsWith('--')) {
        return { valid: false, help: false, dryRun: true, execute: false, error: 'Missing value for --worker-url.' };
      }
      workerUrl = val;
      i += 1;
    } else if (arg.startsWith('--worker-url=')) {
      workerUrl = arg.slice('--worker-url='.length);
    } else if (arg === '--expected-update-time') {
      const val = args[i + 1];
      if (!val || val.startsWith('--')) {
        return { valid: false, help: false, dryRun: true, execute: false, error: 'Missing value for --expected-update-time.' };
      }
      expectedUpdateTime = val;
      i += 1;
    } else if (arg.startsWith('--expected-update-time=')) {
      expectedUpdateTime = arg.slice('--expected-update-time='.length);
    } else if (arg === '--question-ids') {
      const val = args[i + 1];
      if (!val || val.startsWith('--')) {
        return { valid: false, help: false, dryRun: true, execute: false, error: 'Missing value for --question-ids.' };
      }
      questionIds = val.split(',').map(s => s.trim()).filter(Boolean);
      i += 1;
    } else if (arg.startsWith('--question-ids=')) {
      questionIds = arg.slice('--question-ids='.length).split(',').map(s => s.trim()).filter(Boolean);
    } else {
      return {
        valid: false,
        help: false,
        dryRun: true,
        execute: false,
        error: `Unknown argument "${arg}". Allowed: --dry-run (default), --execute, --worker-url <url>, --question-ids <7 comma-separated IDs>, --expected-update-time <iso>, --json, --help`
      };
    }
  }

  if (help) {
    return { valid: true, help: true, dryRun: true, execute: false, json };
  }
  if (dryRun && execute) {
    return {
      valid: false,
      help: false,
      dryRun: true,
      execute: false,
      error: 'Cannot pass both --dry-run and --execute simultaneously.'
    };
  }
  if (questionIds && questionIds.length !== 7) {
    return {
      valid: false,
      help: false,
      dryRun: true,
      execute: false,
      error: `--question-ids must provide exactly 7 IDs (got ${questionIds.length}).`
    };
  }

  return {
    valid: true,
    help: false,
    dryRun: !execute,
    execute,
    json,
    ...(workerUrl ? { workerUrl } : {}),
    ...(expectedUpdateTime ? { expectedUpdateTime } : {}),
    ...(questionIds ? { questionIds } : {})
  };
}

function decodeBase64UrlJson(segment) {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw new RepairScriptError('INVALID_TOKEN', 'OWNER_FIREBASE_ID_TOKEN is not a valid JWT segment.');
  }
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(segment.length / 4) * 4, '=');
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}

export function validateOwnerIdToken(rawToken, nowMs = Date.now()) {
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (!token) {
    throw new RepairScriptError(
      'MISSING_TOKEN',
      'Missing OWNER_FIREBASE_ID_TOKEN environment variable. Set OWNER_FIREBASE_ID_TOKEN before running.'
    );
  }
  if (/^Bearer\s+/i.test(token)) {
    throw new RepairScriptError(
      'INVALID_TOKEN',
      'OWNER_FIREBASE_ID_TOKEN must be the raw Firebase ID token JWT without a "Bearer " prefix.'
    );
  }
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    throw new RepairScriptError(
      'INVALID_TOKEN',
      'OWNER_FIREBASE_ID_TOKEN contains surrounding quotes. Pass the raw JWT without quotes.'
    );
  }

  const segments = token.split('.');
  if (segments.length !== 3 || !segments[0] || !segments[1] || !segments[2]) {
    throw new RepairScriptError('INVALID_TOKEN', 'OWNER_FIREBASE_ID_TOKEN must be a valid Firebase ID token (JWT).');
  }

  let claims;
  try {
    claims = decodeBase64UrlJson(segments[1]);
  } catch (err) {
    if (err instanceof RepairScriptError) throw err;
    throw new RepairScriptError('INVALID_TOKEN', 'Unable to decode OWNER_FIREBASE_ID_TOKEN payload.');
  }

  const uid = String(claims.user_id || claims.sub || '').trim();
  const email = String(claims.email || '').trim().toLowerCase();
  const emailVerified = claims.email_verified === true;
  const aud = typeof claims.aud === 'string' ? claims.aud.trim() : '';
  const iss = typeof claims.iss === 'string' ? claims.iss.trim() : '';
  const expSec = typeof claims.exp === 'number' ? claims.exp : Number(claims.exp);

  if (aud && aud !== FIREBASE_PROJECT_ID) {
    throw new RepairScriptError(
      'TOKEN_PROJECT_MISMATCH',
      `Token audience "${aud}" does not match project "${FIREBASE_PROJECT_ID}".`
    );
  }
  if (iss && iss !== `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`) {
    throw new RepairScriptError(
      'TOKEN_ISSUER_MISMATCH',
      `Token issuer "${iss}" does not match Firebase project "${FIREBASE_PROJECT_ID}".`
    );
  }
  if (!Number.isFinite(expSec) || expSec * 1000 <= nowMs) {
    throw new RepairScriptError('TOKEN_EXPIRED', 'OWNER_FIREBASE_ID_TOKEN is expired.');
  }
  if (uid !== OWNER_ADMIN_UID) {
    throw new RepairScriptError('UNAUTHORIZED_UID', `Token UID does not match required Owner UID (${OWNER_ADMIN_UID}).`);
  }
  if (email !== OWNER_ADMIN_EMAIL.toLowerCase()) {
    throw new RepairScriptError(
      'UNAUTHORIZED_EMAIL',
      `Token email does not match required Owner email (${OWNER_ADMIN_EMAIL}).`
    );
  }
  if (!emailVerified) {
    throw new RepairScriptError('EMAIL_NOT_VERIFIED', 'Owner Firebase ID token must have email_verified=true.');
  }

  return { token, uid, email };
}

async function callRepairEndpoint({ workerBaseUrl, idToken, payload, fetchImpl }) {
  const url = `${workerBaseUrl}${REPAIR_ENDPOINT_PATH}`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`
    },
    body: JSON.stringify(payload)
  });

  const text = await res.text();
  let parsed = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }
  return { status: res.status, data: parsed };
}

export function formatRepairReportText(report) {
  const lines = [
    `=== Owner Exam Repair Report (${report.examId}) ===`,
    `Mode: ${report.mode} | Dry-Run: ${report.dryRun} | SafeToExecute: ${report.safeToExecute} | Executed: ${report.executed}`,
    `Current UpdateTime (CAS): ${report.currentUpdateTime ?? 'N/A'}`,
    `Expected UpdateTime (CAS): ${report.expectedUpdateTime ?? 'auto-preflight'}`,
    `Already Repaired: ${report.alreadyRepaired} | CAS Conflict: ${report.casConflict}`
  ];

  if (report.preservedSettings) {
    const p = report.preservedSettings;
    lines.push(
      `Preserved Exam Invariants: id=${p.id}, type=${p.type}, isPaid=${p.isPaid}, isActive=${p.isActive}, published=${p.published}, durationMinutes=${p.durationMinutes}, totalMarks=${p.totalMarks}`
    );
  }

  lines.push('Slot Validations:');
  for (const s of report.slotValidations || []) {
    const approvalFlag = s.requiresCorrectionAndOwnerApproval ? ' [NEEDS_CORRECTION_AND_OWNER_APPROVAL]' : '';
    lines.push(
      `  #${s.slotNumber} ${s.legacyQuestionId} -> ${s.replacementQuestionId} (${s.expectedSubjectId}) | status=${s.status}${approvalFlag} | key=${s.answerKeyFoundInD1}/${s.answerKeyValid} | subjectMatch=${s.subjectMatch} | semanticMatch=${s.semanticMatch}`
    );
    if (s.status !== 'VALID') {
      lines.push(`      Reason: ${s.reason}`);
    }
  }

  if (report.blockedReasons && report.blockedReasons.length > 0) {
    lines.push('Blocked Reasons:');
    for (const reason of report.blockedReasons) {
      lines.push(`  - ${reason}`);
    }
  }

  if (report.auditLogId) {
    lines.push(`Audit Log ID: ${report.auditLogId} | Repaired At: ${report.repairedAt}`);
  }

  return lines.join('\n');
}

export async function runRepairOwnerModelTest2(options = {}) {
  const dryRun = options.execute === true ? false : options.dryRun !== false;
  const nowMs = options.nowMs ?? Date.now();
  const fetchImpl = options.fetchImpl || fetch;
  const workerBaseUrl = normalizeWorkerBaseUrl(options.workerUrl || process.env.WORKER_BASE_URL);
  const replacementQuestionIds =
    Array.isArray(options.questionIds) && options.questionIds.length === 7
      ? options.questionIds.map(id => String(id).trim())
      : [...DEFAULT_PROPOSED_REPLACEMENTS];

  const { token } = validateOwnerIdToken(options.idToken ?? process.env.OWNER_FIREBASE_ID_TOKEN, nowMs);

  // Step 1: Always run preflight dry-run first (read-only)
  const preflight = await callRepairEndpoint({
    workerBaseUrl,
    idToken: token,
    payload: {
      examId: TARGET_EXAM_ID,
      dryRun: true,
      ...(options.expectedUpdateTime ? { expectedUpdateTime: options.expectedUpdateTime } : {}),
      expectedQuestionIds: CANONICAL_LEGACY_QUESTION_IDS,
      replacementQuestionIds
    },
    fetchImpl
  });

  if (preflight.status !== 200) {
    throw new RepairScriptError(
      preflight.data?.error || `HTTP_${preflight.status}`,
      preflight.data?.message || `Preflight dry-run failed with HTTP ${preflight.status}.`,
      preflight.data
    );
  }

  const preflightReport = preflight.data;

  // Step 2: Stop here in dry-run mode (zero writes)
  if (dryRun) {
    return {
      mode: 'dry_run',
      dryRun: true,
      executed: false,
      safeToExecute: Boolean(preflightReport.safeToExecute),
      report: preflightReport
    };
  }

  // Step 3: Execute mode — strictly refuse execution if preflight is unsafe
  if (!preflightReport.safeToExecute) {
    throw new RepairScriptError(
      'PREFLIGHT_BLOCKED',
      preflightReport.blockedReasons?.[0] || 'Preflight validation failed; refusing to execute repair.',
      preflightReport
    );
  }

  const casUpdateTime = options.expectedUpdateTime || preflightReport.currentUpdateTime;
  if (!casUpdateTime) {
    throw new RepairScriptError(
      'MISSING_CAS_UPDATE_TIME',
      'Preflight did not return currentUpdateTime for CAS precondition.'
    );
  }

  const execRes = await callRepairEndpoint({
    workerBaseUrl,
    idToken: token,
    payload: {
      examId: TARGET_EXAM_ID,
      dryRun: false,
      expectedUpdateTime: casUpdateTime,
      expectedQuestionIds: preflightReport.currentQuestionIds || CANONICAL_LEGACY_QUESTION_IDS,
      replacementQuestionIds
    },
    fetchImpl
  });

  if (execRes.status !== 200 || !execRes.data?.success) {
    throw new RepairScriptError(
      execRes.data?.error || `HTTP_${execRes.status}`,
      execRes.data?.message || `Execute repair failed with HTTP ${execRes.status}.`,
      execRes.data
    );
  }

  return {
    mode: 'executed',
    dryRun: false,
    executed: true,
    safeToExecute: true,
    exam: execRes.data.exam,
    report: execRes.data.report
  };
}

function printHelp() {
  console.log(`Sanad Prep BD — Owner-only CAS Repair for ${TARGET_EXAM_ID}

Usage:
  OWNER_FIREBASE_ID_TOKEN=<raw_owner_jwt> node scripts/repairOwnerModelTest2.mjs [options]

Options:
  --dry-run                  Validate and print audit report without writing (DEFAULT)
  --execute                  Execute CAS repair after preflight passes (requires safeToExecute=true)
  --worker-url <url>         Worker base URL (default: ${DEFAULT_WORKER_BASE_URL})
  --question-ids <id1,...>   7 comma-separated replacement question IDs in slot order
  --expected-update-time <t> Explicit Firestore updateTime for CAS precondition
  --json                     Print full JSON output
  --help, -h                 Show this help message
`);
}

async function main() {
  const cli = parseRepairCliArgs(process.argv.slice(2));
  if (!cli.valid) {
    console.error(`[REPAIR_ERROR] ${cli.error}`);
    process.exitCode = 1;
    return;
  }
  if (cli.help) {
    printHelp();
    return;
  }

  try {
    const result = await runRepairOwnerModelTest2({
      dryRun: cli.dryRun,
      execute: cli.execute,
      workerUrl: cli.workerUrl,
      questionIds: cli.questionIds,
      expectedUpdateTime: cli.expectedUpdateTime
    });

    if (cli.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatRepairReportText(result.report));
    }

    if (!result.safeToExecute && cli.execute) {
      process.exitCode = 2;
    }
  } catch (err) {
    const code = err instanceof RepairScriptError ? err.code : 'REPAIR_FAILED';
    const message = err instanceof Error ? sanitizeDiagnosticMessage(err.message) : 'Repair script failed.';
    console.error(`[${code}] ${message}`);
    if (cli.json && err instanceof RepairScriptError && err.details) {
      console.error(JSON.stringify(err.details, null, 2));
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error('[REPAIR_FATAL]', sanitizeDiagnosticMessage(err instanceof Error ? err.message : String(err)));
    process.exitCode = 1;
  });
}
