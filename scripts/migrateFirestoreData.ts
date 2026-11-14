import {
  probeFirestoreAdminConnectivity,
  createMemoryMirror,
  migrateAllSubscriptionTimestampsAdmin,
  importMissingDataToFirestoreAdmin,
  persistenceState
} from '../server/services/firestoreBackend.ts';

async function main() {
  console.log('=== Sanad Prep BD: Non-Destructive Firestore Security Migration ===');
  const state = await probeFirestoreAdminConnectivity();

  if (state.mode !== 'firestore') {
    console.error(
      '\n[SKIPPED] Firebase Admin Firestore credentials were not detected or lack Firestore IAM permissions in this environment.\n' +
        'Reason: ' +
        (state.reason || persistenceState.reason || 'Missing credentials') +
        '\n\nTo execute this migration safely against production Firestore without modifying existing records:\n' +
        '  1. Export FIREBASE_SERVICE_ACCOUNT_JSON="$(cat service-account.json)" (or run in Cloud Run / gcloud auth application-default login)\n' +
        '  2. Run: npx tsx scripts/migrateFirestoreData.ts\n'
    );
    process.exitCode = 1;
    return;
  }

  const mirror = createMemoryMirror();

  console.log('1. Migrating legacy ISO string subscriptionExpiresAt / expiresAt fields to Firestore Timestamp...');
  const tsSummary = await migrateAllSubscriptionTimestampsAdmin();
  console.log('   -> Timestamp migration summary:', tsSummary);

  console.log('2. Importing missing questions/questionKeys/previousQuestions/exams/packages/config (non-overwriting)...');
  const importSummary = await importMissingDataToFirestoreAdmin(mirror);
  console.log('   -> Non-destructive import summary:', importSummary);

  console.log('\nMigration complete. Existing users, payments, subscriptions, and exam records were preserved.');
}

main().catch((err) => {
  console.error('Migration error:', err);
  process.exit(1);
});
