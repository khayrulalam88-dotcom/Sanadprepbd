import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  OWNER_ADMIN_EMAIL,
  OWNER_ADMIN_UID,
  PRODUCTION_FIREBASE_DATABASE_ID,
  PRODUCTION_FIREBASE_PROJECT_ID,
  isFrontendStagingEnvironment,
  isVerifiedOwnerAccount,
  resolveFrontendOwnerAdminUid
} from '../src/lib/firebase.ts';
import {
  EXPECTED_FIREBASE_DATABASE_ID,
  EXPECTED_FIREBASE_PROJECT_ID,
  OWNER_ADMIN_EMAIL as WORKER_OWNER_EMAIL,
  OWNER_ADMIN_UID as WORKER_OWNER_UID
} from '../worker/types.ts';

const STAGING_OWNER_UID = 'StagingOwnerUidPhase5DTest999';
const STUDENT_UID = 'StudentUidTest123456';

function computeSafeUpdatedRole(
  requestedRole: 'student' | 'question_manager' | 'admin',
  targetUserId: string,
  rawEnv: Record<string, string | undefined>
): 'student' | 'question_manager' | 'admin' {
  const effectiveOwnerAdminUid = resolveFrontendOwnerAdminUid(rawEnv);
  return requestedRole === 'admin' && (!effectiveOwnerAdminUid || targetUserId !== effectiveOwnerAdminUid)
    ? 'student'
    : requestedRole;
}

function computeEditRowRole(
  userId: string,
  rawEnv: Record<string, string | undefined>
): 'admin' | 'student' {
  const effectiveOwnerAdminUid = resolveFrontendOwnerAdminUid(rawEnv);
  return effectiveOwnerAdminUid && userId === effectiveOwnerAdminUid ? 'admin' : 'student';
}

function canShowAdminOption(
  userId: string,
  rawEnv: Record<string, string | undefined>
): boolean {
  const effectiveOwnerAdminUid = resolveFrontendOwnerAdminUid(rawEnv);
  return Boolean(effectiveOwnerAdminUid) && userId === effectiveOwnerAdminUid;
}

function canAccessOwnerUi(
  user: { uid?: string | null; email?: string | null; emailVerified?: boolean | null } | null,
  rawEnv: Record<string, string | undefined>
): boolean {
  const effectiveOwnerAdminUid = resolveFrontendOwnerAdminUid(rawEnv);
  return (
    Boolean(user) &&
    isVerifiedOwnerAccount(user, rawEnv) &&
    Boolean(effectiveOwnerAdminUid) &&
    user?.uid === effectiveOwnerAdminUid
  );
}

describe('Sanad Prep BD – Phase 5D Frontend Staging Owner UID Compatibility', () => {
  test('1. Production and unset VITE_ENVIRONMENT resolve strictly to production OWNER_ADMIN_UID', () => {
    assert.equal(OWNER_ADMIN_UID, 'PjBRV7LAQ8cIwOdM3z474A16dWg2');
    assert.equal(OWNER_ADMIN_EMAIL, 'khayrulalam88@gmail.com');

    for (const envMode of [undefined, '', 'production', 'PRODUCTION', 'development']) {
      const envMap = {
        VITE_ENVIRONMENT: envMode,
        VITE_STAGING_OWNER_ADMIN_UID: STAGING_OWNER_UID
      };
      assert.equal(isFrontendStagingEnvironment(envMap), false);
      assert.equal(resolveFrontendOwnerAdminUid(envMap), OWNER_ADMIN_UID);

      assert.equal(
        canAccessOwnerUi(
          { uid: OWNER_ADMIN_UID, email: OWNER_ADMIN_EMAIL, emailVerified: true },
          envMap
        ),
        true
      );
      assert.equal(
        canAccessOwnerUi(
          { uid: STAGING_OWNER_UID, email: OWNER_ADMIN_EMAIL, emailVerified: true },
          envMap
        ),
        false
      );
      assert.equal(
        canAccessOwnerUi(
          { uid: STUDENT_UID, email: OWNER_ADMIN_EMAIL, emailVerified: true },
          envMap
        ),
        false
      );
    }
  });

  test('2. Staging uses ONLY VITE_STAGING_OWNER_ADMIN_UID and never falls back to production OWNER_ADMIN_UID', () => {
    for (const stagingMode of ['staging', 'STAGING', ' staging ']) {
      const validStagingEnv = {
        VITE_ENVIRONMENT: stagingMode,
        VITE_STAGING_OWNER_ADMIN_UID: `  ${STAGING_OWNER_UID}  `
      };
      assert.equal(isFrontendStagingEnvironment(validStagingEnv), true);
      assert.equal(resolveFrontendOwnerAdminUid(validStagingEnv), STAGING_OWNER_UID);

      assert.equal(
        canAccessOwnerUi(
          { uid: STAGING_OWNER_UID, email: OWNER_ADMIN_EMAIL, emailVerified: true },
          validStagingEnv
        ),
        true
      );
      assert.equal(
        canAccessOwnerUi(
          { uid: OWNER_ADMIN_UID, email: OWNER_ADMIN_EMAIL, emailVerified: true },
          validStagingEnv
        ),
        false
      );

      // Missing or empty VITE_STAGING_OWNER_ADMIN_UID must fail closed (never fall back to OWNER_ADMIN_UID)
      for (const emptyUid of [undefined, '', '   ']) {
        const missingStagingEnv = {
          VITE_ENVIRONMENT: stagingMode,
          VITE_STAGING_OWNER_ADMIN_UID: emptyUid
        };
        assert.equal(resolveFrontendOwnerAdminUid(missingStagingEnv), '');
        assert.equal(
          canAccessOwnerUi(
            { uid: OWNER_ADMIN_UID, email: OWNER_ADMIN_EMAIL, emailVerified: true },
            missingStagingEnv
          ),
          false
        );
        assert.equal(
          canAccessOwnerUi(
            { uid: '', email: OWNER_ADMIN_EMAIL, emailVerified: true },
            missingStagingEnv
          ),
          false
        );
      }
    }
  });

  test('3. Single-owner authorization rejects multi-admin configs, wrong emails, and unverified accounts', () => {
    for (const badMultiUid of [
      `${STAGING_OWNER_UID},${OWNER_ADMIN_UID}`,
      `${STAGING_OWNER_UID} ${OWNER_ADMIN_UID}`,
      `${STAGING_OWNER_UID};${STUDENT_UID}`,
      `${STAGING_OWNER_UID}|${STUDENT_UID}`,
      'x'.repeat(129)
    ]) {
      const badEnv = {
        VITE_ENVIRONMENT: 'staging',
        VITE_STAGING_OWNER_ADMIN_UID: badMultiUid
      };
      assert.equal(resolveFrontendOwnerAdminUid(badEnv), '');
      assert.equal(
        canAccessOwnerUi(
          { uid: STAGING_OWNER_UID, email: OWNER_ADMIN_EMAIL, emailVerified: true },
          badEnv
        ),
        false
      );
      assert.equal(
        canAccessOwnerUi(
          { uid: OWNER_ADMIN_UID, email: OWNER_ADMIN_EMAIL, emailVerified: true },
          badEnv
        ),
        false
      );
    }

    const stagingEnv = {
      VITE_ENVIRONMENT: 'staging',
      VITE_STAGING_OWNER_ADMIN_UID: STAGING_OWNER_UID
    };

    assert.equal(
      canAccessOwnerUi(
        { uid: STAGING_OWNER_UID, email: OWNER_ADMIN_EMAIL, emailVerified: false },
        stagingEnv
      ),
      false
    );
    assert.equal(
      canAccessOwnerUi(
        { uid: STAGING_OWNER_UID, email: 'attacker@example.com', emailVerified: true },
        stagingEnv
      ),
      false
    );
    assert.equal(canAccessOwnerUi(null, stagingEnv), false);
  });

  test('4. Secondary Admin accounts are blocked in EditUserModal, AdminPanel role mapping, and AppContext role sanitization', () => {
    const prodEnv = { VITE_ENVIRONMENT: 'production' };
    const stagingEnv = {
      VITE_ENVIRONMENT: 'staging',
      VITE_STAGING_OWNER_ADMIN_UID: STAGING_OWNER_UID
    };
    const unsetStagingUidEnv = {
      VITE_ENVIRONMENT: 'staging',
      VITE_STAGING_OWNER_ADMIN_UID: ''
    };

    // EditUserModal Admin option visibility
    assert.equal(canShowAdminOption(OWNER_ADMIN_UID, prodEnv), true);
    assert.equal(canShowAdminOption(STAGING_OWNER_UID, prodEnv), false);
    assert.equal(canShowAdminOption(STUDENT_UID, prodEnv), false);

    assert.equal(canShowAdminOption(STAGING_OWNER_UID, stagingEnv), true);
    assert.equal(canShowAdminOption(OWNER_ADMIN_UID, stagingEnv), false);
    assert.equal(canShowAdminOption(STUDENT_UID, stagingEnv), false);
    assert.equal(canShowAdminOption('', unsetStagingUidEnv), false);

    // AdminPanel subscription edit row role inference
    assert.equal(computeEditRowRole(OWNER_ADMIN_UID, prodEnv), 'admin');
    assert.equal(computeEditRowRole(STAGING_OWNER_UID, prodEnv), 'student');
    assert.equal(computeEditRowRole(STAGING_OWNER_UID, stagingEnv), 'admin');
    assert.equal(computeEditRowRole(OWNER_ADMIN_UID, stagingEnv), 'student');
    assert.equal(computeEditRowRole('', unsetStagingUidEnv), 'student');

    // AppContext adminUpdateUser role sanitization
    assert.equal(computeSafeUpdatedRole('admin', OWNER_ADMIN_UID, prodEnv), 'admin');
    assert.equal(computeSafeUpdatedRole('admin', STAGING_OWNER_UID, prodEnv), 'student');
    assert.equal(computeSafeUpdatedRole('admin', STUDENT_UID, prodEnv), 'student');

    assert.equal(computeSafeUpdatedRole('admin', STAGING_OWNER_UID, stagingEnv), 'admin');
    assert.equal(computeSafeUpdatedRole('admin', OWNER_ADMIN_UID, stagingEnv), 'student');
    assert.equal(computeSafeUpdatedRole('admin', STUDENT_UID, stagingEnv), 'student');
    assert.equal(computeSafeUpdatedRole('admin', '', unsetStagingUidEnv), 'student');

    // Non-admin role options remain intact
    assert.equal(computeSafeUpdatedRole('question_manager', STUDENT_UID, stagingEnv), 'question_manager');
    assert.equal(computeSafeUpdatedRole('student', STUDENT_UID, prodEnv), 'student');
  });

  test('5. All five frontend target locations use resolveFrontendOwnerAdminUid() with zero hardcoded OWNER_ADMIN_UID checks and unchanged production constants', () => {
    const repoRoot = path.resolve(import.meta.dirname, '..');

    const targetFiles = [
      'src/components/AdminPanel.tsx',
      'src/components/LoginModal.tsx',
      'src/components/EditUserModal.tsx',
      'src/context/AppContext.tsx'
    ];

    for (const relPath of targetFiles) {
      const content = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
      assert.equal(
        /\bOWNER_ADMIN_UID\b/.test(content),
        false,
        `${relPath} must not contain any hardcoded OWNER_ADMIN_UID reference`
      );
      assert.equal(
        /resolveFrontendOwnerAdminUid\(\)/.test(content),
        true,
        `${relPath} must call resolveFrontendOwnerAdminUid()`
      );
    }

    // Production constants remain completely untouched
    assert.equal(PRODUCTION_FIREBASE_PROJECT_ID, 'galvanic-aviary-tzp2g');
    assert.equal(
      PRODUCTION_FIREBASE_DATABASE_ID,
      'ai-studio-barcouncilmcqpre-9a5aecc8-3819-4aeb-b7e2-c6066b637cab'
    );
    assert.equal(OWNER_ADMIN_UID, WORKER_OWNER_UID);
    assert.equal(OWNER_ADMIN_EMAIL, WORKER_OWNER_EMAIL);
    assert.equal(PRODUCTION_FIREBASE_PROJECT_ID, EXPECTED_FIREBASE_PROJECT_ID);
    assert.equal(PRODUCTION_FIREBASE_DATABASE_ID, EXPECTED_FIREBASE_DATABASE_ID);
  });
});
