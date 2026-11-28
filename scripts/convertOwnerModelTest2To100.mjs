import { pathToFileURL } from 'node:url';

export const FIREBASE_PROJECT_ID = 'galvanic-aviary-tzp2g';
export const OWNER_ADMIN_UID = 'PjBRV7LAQ8cIwOdM3z474A16dWg2';
export const OWNER_ADMIN_EMAIL = 'khayrulalam88@gmail.com';
export const DEFAULT_WORKER_BASE_URL = 'https://s--khayrul-alam.khayrulalam88.workers.dev';
export const TARGET_EXAM_ID = 'exam_1795671882276_o1zj5';
export const CONVERSION_ENDPOINT_PATH = '/api/admin/exams/convert-model-test-2';

export const APPROVED_100_QUESTION_IDS = [
  // CPC (20)
  'q_bank_0043', 'q_bank_0001', 'q_bank_0002', 'q_bank_0005', 'q_bank_0006',
  'q_bank_0007', 'q_bank_0008', 'q_bank_0010', 'q_bank_0011', 'q_bank_0012',
  'q_bank_0013', 'q_bank_0014', 'q_bank_0016', 'q_bank_0017', 'q_bank_0018',
  'q_bank_0019', 'q_bank_0020', 'q_bank_0022', 'q_bank_0023', 'q_bank_0024',
  // CrPC (20)
  'q_bank_3001', 'q_bank_0601', 'q_bank_0602', 'q_bank_0604', 'q_bank_0605',
  'q_bank_0606', 'q_bank_0607', 'q_bank_0608', 'q_bank_0610', 'q_bank_0611',
  'q_bank_0612', 'q_bank_0613', 'q_bank_0614', 'q_bank_0616', 'q_bank_0617',
  'q_bank_0618', 'q_bank_0619', 'q_bank_0620', 'q_bank_0622', 'q_bank_0623',
  // Penal Code (20)
  'q_bank_1292', 'q_bank_1201', 'q_bank_1202', 'q_bank_1204', 'q_bank_1205',
  'q_bank_1206', 'q_bank_1207', 'q_bank_1208', 'q_bank_1210', 'q_bank_1211',
  'q_bank_1212', 'q_bank_1213', 'q_bank_1214', 'q_bank_1216', 'q_bank_1217',
  'q_bank_1219', 'q_bank_1220', 'q_bank_1222', 'q_bank_1223', 'q_bank_1224',
  // Evidence Act (15)
  'q_bank_1874', 'q_bank_1801', 'q_bank_1802', 'q_bank_1804', 'q_bank_1805',
  'q_bank_1806', 'q_bank_1807', 'q_bank_1808', 'q_bank_1810', 'q_bank_1811',
  'q_bank_1813', 'q_bank_1814', 'q_bank_1816', 'q_bank_1817', 'q_bank_1818',
  // Specific Relief Act (10)
  'q_bank_2269', 'q_bank_2251', 'q_bank_2254', 'q_bank_2255', 'q_bank_2256',
  'q_bank_2257', 'q_bank_2258', 'q_bank_2260', 'q_bank_2261', 'q_bank_2262',
  // Limitation Act (10)
  'q_bank_2648', 'q_bank_2551', 'q_bank_2552', 'q_bank_2554', 'q_bank_2555',
  'q_bank_2556', 'q_bank_2557', 'q_bank_2558', 'q_bank_2560', 'q_bank_2561',
  // Bar Council & Ethics (5)
  'q_bank_2851', 'q_bank_2852', 'q_bank_2854', 'q_bank_2855', 'q_bank_2856'
];

export function sanitizeDiagnosticMessage(raw) {
  return String(raw || 'Unknown error')
    .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, '[REDACTED_KEY]')
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, '[REDACTED_JWT]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED_API_KEY]')
    .slice(0, 400);
}

export class ConversionScriptError extends Error {
  constructor(code, message, details) {
    super(sanitizeDiagnosticMessage(message));
    this.name = 'ConversionScriptError';
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
    throw new ConversionScriptError('INVALID_WORKER_URL', `Invalid Worker URL: "${candidate}".`);
  }
  const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(isLocal && parsed.protocol === 'http:')) {
    throw new ConversionScriptError(
      'INVALID_WORKER_URL',
      'Worker URL must use https:// (or http://localhost / http://127.0.0.1 for local tests).'
    );
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

export function parseConversionCliArgs(argv) {
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
        error: `Unknown argument "${arg}". Allowed: --dry-run (default), --execute, --worker-url <url>, --question-ids <100 comma-separated IDs>, --expected-update-time <iso>, --json, --help`
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
  if (questionIds && questionIds.length !== 100) {
    return {
      valid: false,
      help: false,
      dryRun: true,
      execute: false,
      error: `--question-ids must provide exactly 100 IDs (got ${questionIds.length}).`
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
    throw new ConversionScriptError('INVALID_TOKEN', 'OWNER_FIREBASE_ID_TOKEN is not a valid JWT segment.');
  }
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(segment.length / 4) * 4, '=');
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}

export function validateOwnerIdToken(rawToken, nowMs = Date.now()) {
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (!token) {
    throw new ConversionScriptError(
      'MISSING_TOKEN',
      'Missing OWNER_FIREBASE_ID_TOKEN environment variable. Set OWNER_FIREBASE_ID_TOKEN before running.'
    );
  }
  if (/^Bearer\s+/i.test(token)) {
    throw new ConversionScriptError(
      'INVALID_TOKEN',
      'OWNER_FIREBASE_ID_TOKEN must be the raw Firebase ID token JWT without a "Bearer " prefix.'
    );
  }
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    throw new ConversionScriptError(
      'INVALID_TOKEN',
      'OWNER_FIREBASE_ID_TOKEN contains surrounding quotes. Pass the raw JWT without quotes.'
    );
  }

  const segments = token.split('.');
  if (segments.length !== 3 || !segments[0] || !segments[1] || !segments[2]) {
    throw new ConversionScriptError('INVALID_TOKEN', 'OWNER_FIREBASE_ID_TOKEN must be a valid Firebase ID token (JWT).');
  }

  let claims;
  try {
    claims = decodeBase64UrlJson(segments[1]);
  } catch (err) {
    if (err instanceof ConversionScriptError) throw err;
    throw new ConversionScriptError('INVALID_TOKEN', 'Unable to decode OWNER_FIREBASE_ID_TOKEN payload.');
  }

  const uid = String(claims.user_id || claims.sub || '').trim();
  const email = String(claims.email || '').trim().toLowerCase();
  const emailVerified = claims.email_verified === true;
  const aud = typeof claims.aud === 'string' ? claims.aud.trim() : '';
  const iss = typeof claims.iss === 'string' ? claims.iss.trim() : '';
  const expSec = typeof claims.exp === 'number' ? claims.exp : Number(claims.exp);

  if (aud && aud !== FIREBASE_PROJECT_ID) {
    throw new ConversionScriptError(
      'TOKEN_PROJECT_MISMATCH',
      `Token audience "${aud}" does not match project "${FIREBASE_PROJECT_ID}".`
    );
  }
  if (iss && iss !== `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`) {
    throw new ConversionScriptError(
      'TOKEN_ISSUER_MISMATCH',
      `Token issuer "${iss}" does not match Firebase project "${FIREBASE_PROJECT_ID}".`
    );
  }
  if (!Number.isFinite(expSec) || expSec * 1000 <= nowMs) {
    throw new ConversionScriptError('TOKEN_EXPIRED', 'OWNER_FIREBASE_ID_TOKEN is expired.');
  }
  if (uid !== OWNER_ADMIN_UID) {
    throw new ConversionScriptError(
      'UNAUTHORIZED_UID',
      `Token UID does not match required Owner UID (${OWNER_ADMIN_UID}).`
    );
  }
  if (email !== OWNER_ADMIN_EMAIL.toLowerCase()) {
    throw new ConversionScriptError(
      'UNAUTHORIZED_EMAIL',
      `Token email does not match required Owner email (${OWNER_ADMIN_EMAIL}).`
    );
  }
  if (!emailVerified) {
    throw new ConversionScriptError('EMAIL_NOT_VERIFIED', 'Owner Firebase ID token must have email_verified=true.');
  }

  return { token, uid, email };
}

async function callConversionEndpoint({ workerBaseUrl, idToken, payload, fetchImpl }) {
  const url = `${workerBaseUrl}${CONVERSION_ENDPOINT_PATH}`;
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

export function formatConversionReportText(report) {
  const lines = [
    `=== Owner Exam 100-Question Conversion Report (${report.examId}) ===`,
    `Mode: ${report.mode} | Dry-Run: ${report.dryRun} | SafeToExecute: ${report.safeToExecute} | Executed: ${report.executed} | Recovered: ${report.recovered}`,
    `Status: ${report.conversionStatus} | Already Converted: ${report.alreadyConverted} | Recovery Required: ${report.recoveryRequired} | CAS Conflict: ${report.casConflict}`,
    `Current UpdateTime (CAS): ${report.currentUpdateTime ?? 'N/A'}`,
    `Expected UpdateTime (CAS): ${report.expectedUpdateTime ?? 'auto-preflight'}`
  ];

  if (report.currentExamState) {
    const c = report.currentExamState;
    lines.push(
      `Current Exam: questions=${c.questionCount}, totalMarks=${c.totalMarks}, duration=${c.durationMinutes}m, isPaid=${c.isPaid}, published=${c.published}, isActive=${c.isActive}`
    );
  }

  if (report.proposedExamState) {
    const p = report.proposedExamState;
    lines.push(
      `Proposed Exam: questions=${p.questionCount}, totalMarks=${p.totalMarks}, duration=${p.durationMinutes}m, +${p.positiveMarkRatio}/-${p.negativeMarkRatio}, pass=${p.passThresholdPercentage}%, isPaid=${p.isPaid}, published=${p.published}, isActive=${p.isActive}`
    );
  }

  if (report.subjectDistribution) {
    lines.push(
      `Subject Distribution Matched: ${report.subjectDistribution.matched} | Actual: ${JSON.stringify(report.subjectDistribution.actual)}`
    );
  }

  if (report.missingQuestionIds) {
    lines.push(
      `Missing Questions: totalUnique=${report.missingQuestionIds.allUniqueMissing?.length ?? 0} (FS Q=${report.missingQuestionIds.firestoreQuestions?.length ?? 0}, FS Key=${report.missingQuestionIds.firestoreKeys?.length ?? 0}, D1 Q=${report.missingQuestionIds.d1Questions?.length ?? 0}, D1 Key=${report.missingQuestionIds.d1Keys?.length ?? 0})`
    );
  }

  if (report.firestoreD1Parity) {
    lines.push(
      `Firestore <-> D1 Parity: ok=${report.firestoreD1Parity.ok}, examMatches=${report.firestoreD1Parity.examMatches}, qMatched=${report.firestoreD1Parity.questionCountMatched}, keyMatched=${report.firestoreD1Parity.keyCountMatched}, mismatches=${report.firestoreD1Parity.mismatches?.length ?? 0}`
    );
  }

  if (report.keyIntegrity) {
    lines.push(
      `Key & Content Integrity: ok=${report.keyIntegrity.ok}, valid=${report.keyIntegrity.validCount}/${report.keyIntegrity.totalChecked}, remedyViolations=${report.remedyTemplateViolations?.length ?? 0}`
    );
  }

  if (report.approvedMappingsValidation?.length) {
    lines.push('Approved 7 Replacement Slots:');
    for (const m of report.approvedMappingsValidation) {
      lines.push(
        `  ${m.legacyQuestionId} -> expected=${m.expectedReplacementId}, actual=${m.actualIdAtPosition ?? 'none'} | status=${m.status} | valid=${m.valid}`
      );
    }
  }

  if (report.blockedReasons && report.blockedReasons.length > 0) {
    lines.push('Blocked Reasons:');
    for (const reason of report.blockedReasons) {
      lines.push(`  - ${reason}`);
    }
  }

  if (report.auditLogId) {
    lines.push(`Audit Log ID: ${report.auditLogId} | Converted At: ${report.convertedAt}`);
  }

  return lines.join('\n');
}

export async function runConvertOwnerModelTest2To100(options = {}) {
  const dryRun = options.execute === true ? false : options.dryRun !== false;
  const nowMs = options.nowMs ?? Date.now();
  const fetchImpl = options.fetchImpl || fetch;
  const workerBaseUrl = normalizeWorkerBaseUrl(options.workerUrl || process.env.WORKER_BASE_URL);
  const questionIds =
    Array.isArray(options.questionIds) && options.questionIds.length === 100
      ? options.questionIds.map(id => String(id).trim())
      : [...APPROVED_100_QUESTION_IDS];

  const { token } = validateOwnerIdToken(options.idToken ?? process.env.OWNER_FIREBASE_ID_TOKEN, nowMs);

  // Step 1: Always run preflight dry-run first (read-only, 0 writes)
  const preflight = await callConversionEndpoint({
    workerBaseUrl,
    idToken: token,
    payload: {
      examId: TARGET_EXAM_ID,
      dryRun: true,
      ...(options.expectedUpdateTime ? { expectedUpdateTime: options.expectedUpdateTime } : {}),
      questionIds
    },
    fetchImpl
  });

  if (preflight.status !== 200) {
    throw new ConversionScriptError(
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
      recovered: false,
      safeToExecute: Boolean(preflightReport.safeToExecute),
      report: preflightReport
    };
  }

  // Step 3: Execute mode — strictly refuse execution if preflight is unsafe
  if (!preflightReport.safeToExecute) {
    throw new ConversionScriptError(
      preflightReport.alreadyConverted ? 'ALREADY_CONVERTED' : 'PREFLIGHT_BLOCKED',
      preflightReport.blockedReasons?.[0] || 'Preflight validation failed; refusing to execute conversion.',
      preflightReport
    );
  }

  const casUpdateTime = options.expectedUpdateTime || preflightReport.currentUpdateTime;
  if (!casUpdateTime) {
    throw new ConversionScriptError(
      'MISSING_CAS_UPDATE_TIME',
      'Preflight did not return currentUpdateTime for CAS precondition.'
    );
  }

  const expectedSnapshotIds = preflightReport.currentExamState?.questionIds;
  const execRes = await callConversionEndpoint({
    workerBaseUrl,
    idToken: token,
    payload: {
      examId: TARGET_EXAM_ID,
      dryRun: false,
      expectedUpdateTime: casUpdateTime,
      ...(Array.isArray(expectedSnapshotIds) && expectedSnapshotIds.length > 0
        ? { expectedQuestionIds: expectedSnapshotIds }
        : {}),
      questionIds
    },
    fetchImpl
  });

  if (execRes.status !== 200 || !execRes.data?.success) {
    throw new ConversionScriptError(
      execRes.data?.error || `HTTP_${execRes.status}`,
      execRes.data?.message || `Execute conversion failed with HTTP ${execRes.status}.`,
      execRes.data
    );
  }

  return {
    mode: execRes.data.recovered ? 'recovered' : 'executed',
    dryRun: false,
    executed: true,
    recovered: Boolean(execRes.data.recovered),
    safeToExecute: true,
    exam: execRes.data.exam,
    report: execRes.data.report
  };
}

function printHelp() {
  console.log(`Sanad Prep BD — Owner-only 100-Question Conversion for ${TARGET_EXAM_ID}

Usage:
  OWNER_FIREBASE_ID_TOKEN=<raw_owner_jwt> node scripts/convertOwnerModelTest2To100.mjs [options]

Options:
  --dry-run                  Validate 100 questions and print diagnostic report without writing (DEFAULT)
  --execute                  Execute recoverable CAS conversion after preflight passes (requires safeToExecute=true)
  --worker-url <url>         Worker base URL (default: ${DEFAULT_WORKER_BASE_URL})
  --question-ids <id1,...>   Optional override of 100 comma-separated question IDs
  --expected-update-time <t> Explicit Firestore updateTime for CAS precondition
  --json                     Print full JSON output
  --help, -h                 Show this help message
`);
}

async function main() {
  const cli = parseConversionCliArgs(process.argv.slice(2));
  if (!cli.valid) {
    console.error(`[CONVERSION_ERROR] ${cli.error}`);
    process.exitCode = 1;
    return;
  }
  if (cli.help) {
    printHelp();
    return;
  }

  try {
    const result = await runConvertOwnerModelTest2To100({
      dryRun: cli.dryRun,
      execute: cli.execute,
      workerUrl: cli.workerUrl,
      questionIds: cli.questionIds,
      expectedUpdateTime: cli.expectedUpdateTime
    });

    if (cli.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatConversionReportText(result.report));
    }

    if (!result.safeToExecute && cli.execute) {
      process.exitCode = 2;
    }
  } catch (err) {
    const code = err instanceof ConversionScriptError ? err.code : 'CONVERSION_FAILED';
    const message = err instanceof Error ? sanitizeDiagnosticMessage(err.message) : 'Conversion script failed.';
    console.error(`[${code}] ${message}`);
    if (cli.json && err instanceof ConversionScriptError && err.details) {
      console.error(JSON.stringify(err.details, null, 2));
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error('[CONVERSION_FATAL]', sanitizeDiagnosticMessage(err instanceof Error ? err.message : String(err)));
    process.exitCode = 1;
  });
}
