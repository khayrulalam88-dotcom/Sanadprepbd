import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  probeFirestoreAdminConnectivity,
  createMemoryMirror,
  executeFirestoreMigration,
  persistenceState,
  type MigrationExecutionResult
} from '../server/services/firestoreBackend.ts';

export interface ParsedMigrationArgs {
  valid: boolean;
  dryRun: boolean;
  execute: boolean;
  error?: string;
}

export function parseMigrationCliArgs(argv: string[]): ParsedMigrationArgs {
  const args = argv.filter(Boolean);
  const dryRun = args.includes('--dry-run');
  const execute = args.includes('--execute');
  const unknown = args.filter(a => a !== '--dry-run' && a !== '--execute');

  if (unknown.length > 0) {
    return {
      valid: false,
      dryRun: false,
      execute: false,
      error: `Unknown flag(s): ${unknown.join(', ')}. Allowed flags: --dry-run | --execute`
    };
  }
  if (dryRun && execute) {
    return {
      valid: false,
      dryRun: false,
      execute: false,
      error: 'Cannot pass both --dry-run and --execute simultaneously.'
    };
  }
  if (!dryRun && !execute) {
    return {
      valid: false,
      dryRun: false,
      execute: false,
      error: 'Explicit mode flag required. Use --dry-run for read-only inspection or --execute after completing backup.'
    };
  }
  return { valid: true, dryRun, execute };
}

function formatReport(result: MigrationExecutionResult): void {
  const { report } = result;
  console.log(`\nMode: ${report.mode.toUpperCase()} | InspectedAt: ${report.inspectedAt}`);
  console.log('Missing collections / config:', report.missingCollectionsOrConfig.length > 0 ? report.missingCollectionsOrConfig.join(', ') : 'None');
  console.log('Counts:', JSON.stringify(report.counts, null, 2));
  console.log('Total planned writes:', report.totalPlannedWrites);
  console.log('Safe to execute:', report.safeToExecute);

  if (report.warnings.length > 0) {
    console.warn('\nWarnings:');
    for (const w of report.warnings) {
      console.warn(`  - [${w.code}] ${w.collection}${w.docId ? `/${w.docId}` : ''}: ${w.message}`);
    }
  }
  if (report.conflicts.length > 0) {
    console.error('\nConflicts (manual review required; blocks execution):');
    for (const c of report.conflicts) {
      console.error(`  - [${c.code}] ${c.collection}${c.docId ? `/${c.docId}` : ''}: ${c.message}`);
    }
  }
  if (report.errors.length > 0) {
    console.error('\nErrors (incomplete or invalid records; blocks execution):');
    for (const e of report.errors) {
      console.error(`  - [${e.code}] ${e.collection}${e.docId ? `/${e.docId}` : ''}: ${e.message}`);
    }
  }

  if (report.mode === 'dry-run') {
    console.log('\n[DRY-RUN COMPLETE] Zero writes or deletions were performed.');
  } else if (result.abortedDueToIssues) {
    console.error('\n[ABORTED] Conflicts or errors detected during pre-flight inspection. Zero writes were committed.');
  } else {
    console.log(`\n[EXECUTED] Committed ${result.writesCommitted} non-destructive writes. Existing users, payments, subscriptions, and exam records were preserved.`);
  }
}

async function main() {
  console.log('=== Sanad Prep BD: Safe Non-Destructive Firestore Migration ===');
  const parsed = parseMigrationCliArgs(process.argv.slice(2));
  if (!parsed.valid) {
    console.error(`\n[REFUSED] ${parsed.error}`);
    console.error('Usage:');
    console.error('  npx tsx scripts/migrateFirestoreData.ts --dry-run');
    console.error('  npx tsx scripts/migrateFirestoreData.ts --execute');
    process.exitCode = 1;
    return;
  }

  const state = await probeFirestoreAdminConnectivity();
  if (state.mode !== 'firestore') {
    console.error(
      '\n[SKIPPED] Firebase Admin Firestore credentials were not detected or lack Firestore IAM permissions in this environment.\n' +
        'Reason: ' +
        (state.reason || persistenceState.reason || 'Missing credentials') +
        '\n\nTo inspect or execute this migration safely against production Firestore:\n' +
        '  1. Attach Cloud Run / ADC credentials or export FIREBASE_SERVICE_ACCOUNT_JSON securely\n' +
        '  2. Inspect first (read-only): npx tsx scripts/migrateFirestoreData.ts --dry-run\n' +
        '  3. Take a verified Firestore export backup before running --execute\n' +
        '  4. Execute only when dry-run reports safeToExecute=true: npx tsx scripts/migrateFirestoreData.ts --execute\n'
    );
    process.exitCode = 1;
    return;
  }

  const mirror = createMemoryMirror();
  const result = await executeFirestoreMigration({
    mirror,
    dryRun: parsed.dryRun,
    execute: parsed.execute
  });
  formatReport(result);

  if (result.abortedDueToIssues || (parsed.dryRun && !result.report.safeToExecute)) {
    process.exitCode = 1;
  }
}

const __filename = fileURLToPath(import.meta.url);
const isMainEntry =
  typeof process !== 'undefined' &&
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMainEntry) {
  main().catch((err) => {
    console.error('Migration error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

