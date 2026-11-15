# Sanad Prep BD – Firestore Backup, Verification & Rollback Guide

## Target Firebase Project & Named Database
- **Firebase / GCP Project ID**: `galvanic-aviary-tzp2g`
- **Named Firestore Database ID**: `ai-studio-barcouncilmcqpre-9a5aecc8-3819-4aeb-b7e2-c6066b637cab`

---

## 1. Billing & Cloud Storage Prerequisites (Verify Before Proceeding)
**Do NOT assume billing is enabled on `galvanic-aviary-tzp2g`.**

1. **Google Cloud Billing (Blaze Plan Required for Managed Exports)**:
   - Managed Firestore exports (`gcloud firestore export`) and Cloud Storage bucket writes require an **active billing account** on the GCP project. The Firebase Spark (free) tier does **not** permit managed Firestore exports or imports.
   - Verify billing status before attempting backup:
     ```bash
     gcloud billing projects describe galvanic-aviary-tzp2g
     ```
   - Confirm `billingEnabled: true`. If billing is **not** enabled, **stop** and do **not** run `scripts/migrateFirestoreData.ts --execute` until either:
     - Billing is enabled and a managed Cloud Storage export completes, **or**
     - You take a verified read-only collection JSON snapshot externally via Firebase Admin SDK while maintaining read-only access.
2. **Cloud Storage Bucket Prerequisites**:
   - Create or reuse a dedicated Cloud Storage bucket in the **same location/multi-region** as the Firestore database (`ai-studio-barcouncilmcqpre-9a5aecc8-3819-4aeb-b7e2-c6066b637cab`).
   - Enable object versioning (`--versioning`) and prevent public access (`--public-access-prevention`) so answer keys (`questionKeys`, `previousQuestionKeys`) and student PII (`users`, `paymentRequests`) remain private.

---

## 2. Required Google Cloud IAM Permissions

### A. Operator / CLI Account Running Backup & Restore
- `roles/datastore.importExportAdmin` (to invoke `gcloud firestore export`, `gcloud firestore import`, and inspect operations)
- `roles/storage.objectViewer` and `roles/storage.objectCreator` (or `roles/storage.admin`) on the backup GCS bucket

### B. Firestore Service Agent
- The project's Firestore service agent (`service-533350425747@gcp-sa-firestore.iam.gserviceaccount.com`, or check exact project number via `gcloud projects describe galvanic-aviary-tzp2g`) must have `roles/storage.admin` (or `roles/storage.objectAdmin`) on the target GCS bucket so Firestore can write export shards and read them back during restore.

### C. Migration Script Principal (`scripts/migrateFirestoreData.ts`)
- For `--dry-run` (read-only inspection): `roles/datastore.viewer`
- For `--execute` (writing missing packages/config/keys and sanitizing legacy docs): `roles/datastore.user`

---

## 3. Pre-Migration Managed Export Commands

```bash
export PROJECT_ID="galvanic-aviary-tzp2g"
export DATABASE_ID="ai-studio-barcouncilmcqpre-9a5aecc8-3819-4aeb-b7e2-c6066b637cab"
export BACKUP_BUCKET="gs://galvanic-aviary-tzp2g-firestore-backups"
export BACKUP_TS="$(date -u +%Y%m%dT%H%M%SZ)"
export BACKUP_PATH="${BACKUP_BUCKET}/pre-stage2-migration-${BACKUP_TS}"

# Run full managed export for the named database
gcloud firestore export "${BACKUP_PATH}" \
  --project="${PROJECT_ID}" \
  --database="${DATABASE_ID}"
```

To confirm the bucket location matches the Firestore database location before creating the bucket:
```bash
gcloud firestore databases describe \
  --project="${PROJECT_ID}" \
  --database="${DATABASE_ID}"
```

---

## 4. Backup Verification (Mandatory Before `--execute`)

Confirm **all three** checks succeed before executing any migration writes:

1. **Operation Status Check**:
   ```bash
   gcloud firestore operations list \
     --project="${PROJECT_ID}" \
     --database="${DATABASE_ID}"

   gcloud firestore operations describe "<OPERATION_NAME>" \
     --project="${PROJECT_ID}"
   ```
   Verify `"done": true` and **zero `"error"` field** in the operation response.

2. **Cloud Storage Metadata & Shard Check**:
   ```bash
   gcloud storage ls -l "${BACKUP_PATH}"
   gcloud storage ls -l "${BACKUP_PATH}/all_namespaces/all_kinds/"
   ```
   Confirm `<BACKUP_TS>.overall_export_metadata` exists and output shard files are non-zero bytes.

3. **Dry-Run Pre-Flight Check**:
   ```bash
   npx tsx scripts/migrateFirestoreData.ts --dry-run
   ```
   Confirm `safeToExecute: true`, `conflicts: []`, and `errors: []`.

---

## 5. Rollback Procedure & Limitations

### Targeted Collection Restore (Recommended Rollback)
If a migration write causes an unexpected regression, restore **only** the migration-touched collections (`previous_questions`, `previousQuestionKeys`, `questions`, `questionKeys`, `packages`, `config`, `users`, `subscriptions`, `exams`) so you do **not** overwrite live student payments or exam attempts submitted after the backup:

```bash
gcloud firestore import "${BACKUP_PATH}" \
  --project="${PROJECT_ID}" \
  --database="${DATABASE_ID}" \
  --collection-ids="packages,config,previous_questions,previousQuestionKeys,questions,questionKeys,exams,users,subscriptions"
```

### Critical Rollback Limitations
1. **Import Does NOT Delete Newly Created Documents**:
   - `gcloud firestore import` restores/overwrites documents whose IDs existed at export time, **but does not remove brand-new documents** added after the export (such as newly seeded `/packages/*`, `/config/examDate`, `/questionKeys/*`, or `/previousQuestionKeys/*` IDs that did not exist before the export). Those newly created doc IDs must be deleted manually if a full revert to pre-migration absence is required.
2. **Import Is NOT Transactional Across Live Traffic**:
   - Importing over live collections while users are writing `users`, `subscriptions`, `paymentRequests`, or `examResults` can revert post-backup state changes. Restrict traffic (or use `--collection-ids` strictly for static/config/question collections) before importing.
3. **Firebase Auth & Security Rules Are Excluded**:
   - Firestore exports do **not** contain Firebase Auth user accounts or `firestore.rules`. Keep `firestore.rules` under version control and export Firebase Auth separately (`firebase auth:export`) when taking full disaster-recovery snapshots.
4. **Billing Cost & Operation Latency**:
   - Managed export and import operations incur Firestore document read/write operations and Cloud Storage storage/egress fees under Blaze billing, and cannot be instantaneously cancelled mid-import without leaving partial collection state.
