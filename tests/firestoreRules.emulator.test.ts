import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  OWNER_ADMIN_UID,
  OWNER_ADMIN_EMAIL,
  EXPECTED_FIREBASE_PROJECT_ID,
  EXPECTED_FIREBASE_DATABASE_ID
} from '../server/services/firestoreBackend.ts';

const EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST?.trim() || '';
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID?.trim() || EXPECTED_FIREBASE_PROJECT_ID;
const DATABASE_ID = process.env.FIREBASE_DATABASE_ID?.trim() || EXPECTED_FIREBASE_DATABASE_ID;

function toBase64Url(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

function makeEmulatorJwt(claims: {
  uid: string;
  email: string;
  email_verified: boolean;
}): string {
  const header = toBase64Url({ alg: 'none', typ: 'JWT' });
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = toBase64Url({
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    aud: PROJECT_ID,
    auth_time: nowSec,
    user_id: claims.uid,
    sub: claims.uid,
    iat: nowSec,
    exp: nowSec + 3600,
    email: claims.email,
    email_verified: claims.email_verified,
    firebase: { sign_in_provider: 'password' }
  });
  return `${header}.${payload}.`;
}

function docBaseUrl(): string {
  return `http://${EMULATOR_HOST}/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents`;
}

async function seedWithAdmin(collectionPath: string, docId: string, fields: Record<string, unknown>) {
  const res = await fetch(`${docBaseUrl()}/${collectionPath}?documentId=${encodeURIComponent(docId)}`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer owner',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields })
  });
  if (res.status === 409) {
    const patchRes = await fetch(`${docBaseUrl()}/${collectionPath}/${encodeURIComponent(docId)}`, {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer owner',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ fields })
    });
    assert.ok(patchRes.ok, `Admin seed patch failed for ${collectionPath}/${docId}: ${patchRes.status}`);
    return;
  }
  assert.ok(res.ok, `Admin seed create failed for ${collectionPath}/${docId}: ${res.status}`);
}

async function fsRequest(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  urlPath: string,
  token?: string,
  body?: Record<string, unknown>
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${docBaseUrl()}${urlPath}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

describe(
  'Firestore Security Rules Emulator Verification Suite',
  { skip: EMULATOR_HOST ? false : 'FIRESTORE_EMULATOR_HOST not active (requires Java runtime + firebase emulators:exec)' },
  () => {
    const studentAToken = makeEmulatorJwt({
      uid: 'emu_student_a',
      email: 'emu.student.a@example.com',
      email_verified: true
    });
    const studentBToken = makeEmulatorJwt({
      uid: 'emu_student_b',
      email: 'emu.student.b@example.com',
      email_verified: true
    });
    const unverifiedToken = makeEmulatorJwt({
      uid: 'emu_unverified',
      email: 'unverified@example.com',
      email_verified: false
    });
    const ownerToken = makeEmulatorJwt({
      uid: OWNER_ADMIN_UID,
      email: OWNER_ADMIN_EMAIL,
      email_verified: true
    });

    test('Setup rules and seed fixtures in named emulator database', async () => {
      const rulesSource = fs.readFileSync(path.join(process.cwd(), 'firestore.rules'), 'utf8');
      const loadRes = await fetch(
        `http://${EMULATOR_HOST}/emulator/v1/projects/${PROJECT_ID}:securityRules`,
        {
          method: 'PUT',
          headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
          body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content: rulesSource }] } })
        }
      );
      assert.ok(loadRes.ok, `Expected rules load on emulator to succeed, got ${loadRes.status}`);

      await seedWithAdmin('paymentRequests', 'trx_EMU001', {
        userId: { stringValue: 'emu_student_a' },
        status: { stringValue: 'pending' },
        amount: { integerValue: '300' }
      });
      await seedWithAdmin('subscriptions', 'sub_emu_a', {
        userId: { stringValue: 'emu_student_a' },
        status: { stringValue: 'active' }
      });
      await seedWithAdmin('sessions', 'sess_emu_a', {
        userId: { stringValue: 'emu_student_a' },
        status: { stringValue: 'active' }
      });
      await seedWithAdmin('userSessions', 'emu_student_a', {
        activeSessionId: { stringValue: 'sess_emu_a' }
      });
      await seedWithAdmin('questions', 'q_emu_1', {
        questionBn: { stringValue: 'দণ্ডবিধি কত সালে প্রণীত হয়?' },
        subjectId: { stringValue: 'sub_penal_code' }
      });
      await seedWithAdmin('questionKeys', 'q_emu_1', {
        correctOptionIndex: { integerValue: '1' },
        explanationBn: { stringValue: '১৮৬০ সালে প্রণীত হয়।' }
      });
    });

    test('Student profile create/update enforces verified email and blocks role/subscription escalation', async () => {
      const unverifiedCreate = await fsRequest('POST', '/users?documentId=emu_unverified', unverifiedToken, {
        fields: {
          uid: { stringValue: 'emu_unverified' },
          name: { stringValue: 'Unverified' },
          role: { stringValue: 'student' },
          subscriptionStatus: { stringValue: 'free' },
          createdAt: { stringValue: new Date().toISOString() }
        }
      });
      assert.equal(unverifiedCreate.status, 403);

      const forgedRoleCreate = await fsRequest('POST', '/users?documentId=emu_student_a', studentAToken, {
        fields: {
          uid: { stringValue: 'emu_student_a' },
          name: { stringValue: 'Student A' },
          role: { stringValue: 'admin' },
          subscriptionStatus: { stringValue: 'free' },
          createdAt: { stringValue: new Date().toISOString() }
        }
      });
      assert.equal(forgedRoleCreate.status, 403);

      const validCreate = await fsRequest('POST', '/users?documentId=emu_student_a', studentAToken, {
        fields: {
          uid: { stringValue: 'emu_student_a' },
          name: { stringValue: 'Student A' },
          email: { stringValue: 'emu.student.a@example.com' },
          role: { stringValue: 'student' },
          subscriptionStatus: { stringValue: 'free' },
          createdAt: { stringValue: new Date().toISOString() }
        }
      });
      assert.equal(validCreate.status, 200);

      const safeUpdate = await fsRequest(
        'PATCH',
        '/users/emu_student_a?updateMask.fieldPaths=name',
        studentAToken,
        { fields: { name: { stringValue: 'Student Alpha Updated' } } }
      );
      assert.equal(safeUpdate.status, 200);

      const proEscalateUpdate = await fsRequest(
        'PATCH',
        '/users/emu_student_a?updateMask.fieldPaths=subscriptionStatus',
        studentAToken,
        { fields: { subscriptionStatus: { stringValue: 'pro' } } }
      );
      assert.equal(proEscalateUpdate.status, 403);
    });

    test('Client writes to paymentRequests and client access to subscriptions/sessions/questions/questionKeys are denied', async () => {
      const studentPayWrite = await fsRequest('POST', '/paymentRequests?documentId=trx_FORGED', studentAToken, {
        fields: { userId: { stringValue: 'emu_student_a' }, amount: { integerValue: '1' } }
      });
      assert.equal(studentPayWrite.status, 403);

      const crossReadPay = await fsRequest('GET', '/paymentRequests/trx_EMU001', studentBToken);
      assert.equal(crossReadPay.status, 403);

      const studentSubWrite = await fsRequest('POST', '/subscriptions?documentId=sub_forged', studentAToken, {
        fields: { userId: { stringValue: 'emu_student_a' }, status: { stringValue: 'active' } }
      });
      assert.equal(studentSubWrite.status, 403);

      const studentReadSession = await fsRequest('GET', '/sessions/sess_emu_a', studentAToken);
      assert.equal(studentReadSession.status, 403);

      const studentReadUserSession = await fsRequest('GET', '/userSessions/emu_student_a', studentAToken);
      assert.equal(studentReadUserSession.status, 403);

      const studentReadQuestion = await fsRequest('GET', '/questions/q_emu_1', studentAToken);
      assert.equal(studentReadQuestion.status, 403);

      const studentReadQuestionKey = await fsRequest('GET', '/questionKeys/q_emu_1', studentAToken);
      assert.equal(studentReadQuestionKey.status, 403);
    });

    test('Verified Owner Admin retains authorized access to questions, questionKeys, and subscriptions', async () => {
      const ownerReadKey = await fsRequest('GET', '/questionKeys/q_emu_1', ownerToken);
      assert.equal(ownerReadKey.status, 200);

      const ownerReadQ = await fsRequest('GET', '/questions/q_emu_1', ownerToken);
      assert.equal(ownerReadQ.status, 200);

      const ownerReadSub = await fsRequest('GET', '/subscriptions/sub_emu_a', ownerToken);
      assert.equal(ownerReadSub.status, 200);
    });
  }
);
