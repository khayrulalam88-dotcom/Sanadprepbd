import test, { describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type http from 'node:http';
import type { Firestore } from 'firebase-admin/firestore';
import { createSanadPrepApp, type DecodedAuthUser } from '../server.ts';
import {
  OWNER_ADMIN_UID,
  OWNER_ADMIN_EMAIL,
  EXPECTED_FIREBASE_DATABASE_ID,
  createMemoryMirror,
  invalidateQuestionBankCache,
  clearRateLimitBucketsForTests
} from '../server/services/firestoreBackend.ts';

const OWNER_TOKEN = 'p5f-token-owner';
const STUDENT_A_TOKEN = 'p5f-token-student-a';
const STUDENT_B_TOKEN = 'p5f-token-student-b';

const TOKEN_MAP: Record<string, DecodedAuthUser> = {
  [OWNER_TOKEN]: {
    uid: OWNER_ADMIN_UID,
    email: OWNER_ADMIN_EMAIL,
    emailVerified: true,
    name: 'Owner Admin'
  },
  [STUDENT_A_TOKEN]: {
    uid: 'p5f_student_alpha',
    email: 'alpha.student@example.com',
    emailVerified: true,
    name: 'Student Alpha'
  },
  [STUDENT_B_TOKEN]: {
    uid: 'p5f_student_beta',
    email: 'beta.student@example.com',
    emailVerified: true,
    name: 'Student Beta'
  }
};

function cloneValue<T>(v: T): T {
  if (v === null || v === undefined || typeof v !== 'object') return v;
  if (v instanceof Date) return new Date(v.getTime()) as unknown as T;
  if (typeof (v as unknown as { toDate?: () => Date }).toDate === 'function') {
    return (v as unknown as { toDate: () => Date }).toDate() as unknown as T;
  }
  if (Array.isArray(v)) return v.map(cloneValue) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val !== undefined) out[k] = cloneValue(val);
  }
  return out as T;
}

class FakeDocSnapshot {
  constructor(
    public readonly id: string,
    public readonly ref: FakeDocRef,
    private readonly raw?: Record<string, unknown>
  ) {}
  get exists(): boolean {
    return this.raw !== undefined;
  }
  data(): Record<string, unknown> | undefined {
    return this.raw ? cloneValue(this.raw) : undefined;
  }
}

class FakeQuerySnapshot {
  constructor(public readonly docs: FakeDocSnapshot[]) {}
  get empty(): boolean {
    return this.docs.length === 0;
  }
  get size(): number {
    return this.docs.length;
  }
  forEach(cb: (doc: FakeDocSnapshot) => void): void {
    this.docs.forEach(cb);
  }
}

class FakeDocRef {
  constructor(
    private readonly fsDb: FakeFirestore,
    public readonly collectionName: string,
    public readonly id: string
  ) {}
  get path(): string {
    return `${this.collectionName}/${this.id}`;
  }
  async get(): Promise<FakeDocSnapshot> {
    await Promise.resolve();
    this.fsDb.recordRead(this.collectionName, 1);
    return new FakeDocSnapshot(this.id, this, this.fsDb.rawGet(this.path));
  }
  async set(data: Record<string, unknown>, opts?: { merge?: boolean }): Promise<void> {
    await Promise.resolve();
    this.fsDb.rawSet(this.path, data, opts?.merge);
  }
  async update(data: Record<string, unknown>): Promise<void> {
    await Promise.resolve();
    if (this.fsDb.rawGet(this.path) === undefined) {
      const err = new Error(`5 NOT_FOUND: ${this.path}`) as Error & { code: number };
      err.code = 5;
      throw err;
    }
    this.fsDb.rawSet(this.path, data, true);
  }
  async delete(): Promise<void> {
    await Promise.resolve();
    this.fsDb.rawDelete(this.path);
  }
}

class FakeQuery {
  constructor(
    private readonly fsDb: FakeFirestore,
    private readonly collectionName: string,
    private readonly filters: Array<{ field: string; op: string; value: unknown }> = [],
    private readonly limitCount?: number
  ) {}
  where(field: string, op: string, value: unknown): FakeQuery {
    return new FakeQuery(this.fsDb, this.collectionName, [...this.filters, { field, op, value }], this.limitCount);
  }
  limit(n: number): FakeQuery {
    return new FakeQuery(this.fsDb, this.collectionName, this.filters, n);
  }
  async get(): Promise<FakeQuerySnapshot> {
    await Promise.resolve();
    const snap = this.fsDb.runQuerySync(this.collectionName, this.filters, this.limitCount);
    this.fsDb.recordRead(this.collectionName, Math.max(1, snap.docs.length));
    return snap;
  }
}

class FakeCollectionRef extends FakeQuery {
  private readonly _fsDb: FakeFirestore;
  constructor(fsDb: FakeFirestore, public readonly name: string) {
    super(fsDb, name);
    this._fsDb = fsDb;
  }
  doc(id?: string): FakeDocRef {
    return new FakeDocRef(this._fsDb, this.name, id || `auto_${Math.random().toString(36).slice(2, 10)}`);
  }
}

type BatchOp =
  | { type: 'set'; path: string; data: Record<string, unknown>; merge?: boolean }
  | { type: 'create'; path: string; data: Record<string, unknown> }
  | { type: 'update'; path: string; data: Record<string, unknown> }
  | { type: 'delete'; path: string };

class FakeWriteBatch {
  private ops: BatchOp[] = [];
  constructor(private readonly fsDb: FakeFirestore) {}
  set(ref: FakeDocRef, data: Record<string, unknown>, opts?: { merge?: boolean }): FakeWriteBatch {
    this.ops.push({ type: 'set', path: ref.path, data: cloneValue(data), merge: opts?.merge });
    return this;
  }
  create(ref: FakeDocRef, data: Record<string, unknown>): FakeWriteBatch {
    this.ops.push({ type: 'create', path: ref.path, data: cloneValue(data) });
    return this;
  }
  update(ref: FakeDocRef, data: Record<string, unknown>): FakeWriteBatch {
    this.ops.push({ type: 'update', path: ref.path, data: cloneValue(data) });
    return this;
  }
  delete(ref: FakeDocRef): FakeWriteBatch {
    this.ops.push({ type: 'delete', path: ref.path });
    return this;
  }
  async commit(): Promise<void> {
    await Promise.resolve();
    this.fsDb.applyOps(this.ops);
  }
}

class FakeTransaction {
  private ops: BatchOp[] = [];
  constructor(private readonly fsDb: FakeFirestore) {}
  async get(target: FakeDocRef | FakeQuery): Promise<unknown> {
    await Promise.resolve();
    if (target instanceof FakeDocRef) {
      this.fsDb.recordRead(target.collectionName, 1);
      return new FakeDocSnapshot(target.id, target, this.fsDb.rawGet(target.path));
    }
    return target.get();
  }
  set(ref: FakeDocRef, data: Record<string, unknown>, opts?: { merge?: boolean }): FakeTransaction {
    this.ops.push({ type: 'set', path: ref.path, data: cloneValue(data), merge: opts?.merge });
    return this;
  }
  create(ref: FakeDocRef, data: Record<string, unknown>): FakeTransaction {
    this.ops.push({ type: 'create', path: ref.path, data: cloneValue(data) });
    return this;
  }
  update(ref: FakeDocRef, data: Record<string, unknown>): FakeTransaction {
    this.ops.push({ type: 'update', path: ref.path, data: cloneValue(data) });
    return this;
  }
  delete(ref: FakeDocRef): FakeTransaction {
    this.ops.push({ type: 'delete', path: ref.path });
    return this;
  }
  commit(): void {
    this.fsDb.applyOps(this.ops);
  }
}

class FakeFirestore {
  public store = new Map<string, Record<string, unknown>>();
  public databaseId: string = EXPECTED_FIREBASE_DATABASE_ID;
  private readCounts = new Map<string, number>();

  recordRead(collectionName: string, count: number): void {
    this.readCounts.set(collectionName, (this.readCounts.get(collectionName) || 0) + count);
  }
  getReadCount(collectionName: string): number {
    return this.readCounts.get(collectionName) || 0;
  }
  resetReadCounts(): void {
    this.readCounts.clear();
  }
  collection(name: string): FakeCollectionRef {
    return new FakeCollectionRef(this, name);
  }
  batch(): FakeWriteBatch {
    return new FakeWriteBatch(this);
  }
  rawGet(docPath: string): Record<string, unknown> | undefined {
    const val = this.store.get(docPath);
    return val ? cloneValue(val) : undefined;
  }
  rawSet(docPath: string, data: Record<string, unknown>, merge = false): void {
    const existing = this.store.get(docPath);
    const next = merge && existing ? { ...existing, ...cloneValue(data) } : cloneValue(data);
    this.store.set(docPath, next);
  }
  rawDelete(docPath: string): void {
    this.store.delete(docPath);
  }
  runQuerySync(
    collectionName: string,
    filters: Array<{ field: string; op: string; value: unknown }>,
    limitCount?: number
  ): FakeQuerySnapshot {
    const prefix = `${collectionName}/`;
    const matched: FakeDocSnapshot[] = [];
    for (const [docPath, data] of this.store.entries()) {
      if (!docPath.startsWith(prefix)) continue;
      const docId = docPath.slice(prefix.length);
      if (docId.includes('/')) continue;
      let ok = true;
      for (const f of filters) {
        if (f.field === '__name__' && f.op === 'in') {
          const arr = Array.isArray(f.value) ? f.value : [];
          if (!arr.includes(docId)) {
            ok = false;
            break;
          }
        } else if (f.op === '==') {
          if (data[f.field] !== f.value) {
            ok = false;
            break;
          }
        }
      }
      if (ok) {
        matched.push(new FakeDocSnapshot(docId, new FakeDocRef(this, collectionName, docId), data));
        if (limitCount !== undefined && matched.length >= limitCount) break;
      }
    }
    return new FakeQuerySnapshot(matched);
  }
  applyOps(ops: BatchOp[]): void {
    const created = new Set<string>();
    for (const op of ops) {
      const existsNow = this.store.has(op.path) || created.has(op.path);
      if (op.type === 'create') {
        if (existsNow) {
          const err = new Error(`6 ALREADY_EXISTS: ${op.path}`) as Error & { code: number };
          err.code = 6;
          throw err;
        }
        created.add(op.path);
      } else if (op.type === 'update' && !existsNow) {
        const err = new Error(`5 NOT_FOUND: ${op.path}`) as Error & { code: number };
        err.code = 5;
        throw err;
      }
    }
    for (const op of ops) {
      if (op.type === 'set') this.rawSet(op.path, op.data, op.merge);
      else if (op.type === 'create') this.rawSet(op.path, op.data, false);
      else if (op.type === 'update') this.rawSet(op.path, op.data, true);
      else if (op.type === 'delete') this.rawDelete(op.path);
    }
  }
  async runTransaction<T>(fn: (tx: FakeTransaction) => Promise<T>): Promise<T> {
    const tx = new FakeTransaction(this);
    const result = await fn(tx);
    tx.commit();
    return result;
  }
}

async function startTestServer(app: ReturnType<typeof createSanadPrepApp>['app']) {
  const srv = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => srv.once('listening', resolve));
  const port = (srv.address() as { port: number }).port;
  return {
    server: srv,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(resolve => srv.close(() => resolve()))
  };
}

const tokenVerifier = async (idToken: string): Promise<DecodedAuthUser> => {
  const user = TOKEN_MAP[idToken];
  if (!user) throw new Error('Invalid token');
  return user;
};

describe('Phase 5F — server.ts Worker Parity Remediation Suite', () => {
  beforeEach(() => {
    clearRateLimitBucketsForTests();
  });

  test('1–5. Admin user update preserves email & omitted subscription metadata, revokes ALL active subscriptions, and GET /api/admin/subscriptions hydrates studentEmail', async () => {
    const fakeDb = new FakeFirestore();
    const seedMirror = createMemoryMirror();
    for (const pkg of seedMirror.packages) {
      fakeDb.rawSet(`packages/${pkg.id}`, pkg as unknown as Record<string, unknown>);
    }

    const existingEmail = 'rahim.advocate@example.com';
    const existingExpiry = '2027-06-15T12:00:00.000Z';

    fakeDb.rawSet('users/student_multi_p5f', {
      uid: 'student_multi_p5f',
      name: 'Rahim Uddin',
      email: existingEmail,
      phone: '01711112222',
      role: 'student',
      subscriptionStatus: 'pro',
      subscriptionExpiresAt: existingExpiry,
      activePackageId: 'pkg_long_course',
      activePackageNameBn: 'লং কোর্স',
      activePackageNameEn: 'Long Course Pass',
      avatarUrl: 'https://example.com/avatar.png',
      createdAt: '2026-01-01T00:00:00.000Z'
    });

    // Seed 2 overlapping active subscriptions + 1 already-expired historical subscription + 1 bystander user subscription
    fakeDb.rawSet('subscriptions/sub_hist_old', {
      id: 'sub_hist_old',
      userId: 'student_multi_p5f',
      studentName: 'Rahim Uddin',
      studentPhone: '01711112222',
      packageId: 'pkg_monthly',
      packageNameBn: 'মাসিক',
      packageNameEn: 'Monthly',
      pricePaid: 150,
      paymentRequestId: 'trx_OLD00',
      paymentMethod: 'bKash',
      transactionId: 'OLD00',
      validityType: 'days',
      status: 'expired',
      activatedAt: '2025-01-01T00:00:00.000Z',
      expiresAt: '2025-02-01T00:00:00.000Z',
      createdAt: '2025-01-01T00:00:00.000Z'
    });
    fakeDb.rawSet('subscriptions/sub_act_1', {
      id: 'sub_act_1',
      userId: 'student_multi_p5f',
      studentName: 'Rahim Uddin',
      studentPhone: '01711112222',
      packageId: 'pkg_pro_mock',
      packageNameBn: 'প্রো',
      packageNameEn: 'Pro',
      pricePaid: 300,
      paymentRequestId: 'trx_ACT01',
      paymentMethod: 'bKash',
      transactionId: 'ACT01',
      validityType: 'days',
      status: 'active',
      activatedAt: '2026-10-01T00:00:00.000Z',
      expiresAt: '2027-04-01T00:00:00.000Z',
      createdAt: '2026-10-01T00:00:00.000Z'
    });
    fakeDb.rawSet('subscriptions/sub_act_2', {
      id: 'sub_act_2',
      userId: 'student_multi_p5f',
      studentName: 'Rahim Uddin',
      studentPhone: '01711112222',
      packageId: 'pkg_long_course',
      packageNameBn: 'লং কোর্স',
      packageNameEn: 'Long Course Pass',
      pricePaid: 999,
      paymentRequestId: 'trx_ACT02',
      paymentMethod: 'Nagad',
      transactionId: 'ACT02',
      validityType: 'days',
      status: 'active',
      activatedAt: '2026-11-01T00:00:00.000Z',
      expiresAt: existingExpiry,
      createdAt: '2026-11-01T00:00:00.000Z'
    });
    fakeDb.rawSet('subscriptions/sub_bystander', {
      id: 'sub_bystander',
      userId: 'student_bystander',
      studentName: 'Bystander',
      studentPhone: '01800000000',
      packageId: 'pkg_monthly',
      packageNameBn: 'মাসিক',
      packageNameEn: 'Monthly',
      pricePaid: 150,
      paymentRequestId: 'trx_BYST1',
      paymentMethod: 'bKash',
      transactionId: 'BYST1',
      validityType: 'days',
      status: 'active',
      activatedAt: '2026-11-01T00:00:00.000Z',
      expiresAt: existingExpiry,
      createdAt: '2026-11-01T00:00:00.000Z'
    });

    const { app } = createSanadPrepApp({
      firestoreDb: fakeDb as unknown as Firestore,
      isProduction: true,
      rateLimitOverrides: { globalMax: 1000 },
      tokenVerifier
    });
    const srv = await startTestServer(app);

    try {
      // A. GET /api/admin/subscriptions hydrates studentEmail from users collection
      const subsRes = await fetch(`${srv.url}/api/admin/subscriptions`, {
        headers: { Authorization: `Bearer ${OWNER_TOKEN}` }
      });
      assert.equal(subsRes.status, 200);
      const subsJson = (await subsRes.json()) as {
        subscriptions: Array<{ id: string; userId: string; studentEmail?: string }>;
      };
      const rahimSubs = subsJson.subscriptions.filter(s => s.userId === 'student_multi_p5f');
      assert.equal(rahimSubs.length, 3);
      for (const s of rahimSubs) {
        assert.equal(s.studentEmail, existingEmail);
      }

      // B. Empty email (`""`) & omitted packageId/packageNameBn/packageNameEn/expiresAt do NOT erase stored values
      const updateEmptyRes = await fetch(`${srv.url}/api/admin/users/update`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${OWNER_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: 'student_multi_p5f',
          name: 'Rahim Uddin Edited',
          email: '',
          phone: '01799998888',
          role: 'admin', // non-owner cannot be elevated to admin -> forced to student
          subscriptionStatus: 'pro'
        })
      });
      assert.equal(updateEmptyRes.status, 200);
      const updateEmptyBody = (await updateEmptyRes.json()) as {
        user: Record<string, unknown>;
      };
      assert.equal(updateEmptyBody.user.email, existingEmail);
      assert.equal(updateEmptyBody.user.role, 'student');
      assert.equal(updateEmptyBody.user.activePackageId, 'pkg_long_course');
      assert.equal(updateEmptyBody.user.activePackageNameBn, 'লং কোর্স');
      assert.equal(updateEmptyBody.user.activePackageNameEn, 'Long Course Pass');
      assert.equal(updateEmptyBody.user.subscriptionExpiresAt, existingExpiry);

      const storedUserAfterEmpty = fakeDb.rawGet('users/student_multi_p5f')!;
      assert.equal(storedUserAfterEmpty.email, existingEmail);
      assert.equal(storedUserAfterEmpty.avatarUrl, 'https://example.com/avatar.png');
      assert.equal(storedUserAfterEmpty.activePackageId, 'pkg_long_course');

      // C. Omitted email also preserves email; invalid email returns 400 INVALID_EMAIL
      const badEmailRes = await fetch(`${srv.url}/api/admin/users/update`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${OWNER_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: 'student_multi_p5f',
          name: 'Rahim Uddin Edited',
          email: 'bad-email-format',
          subscriptionStatus: 'pro'
        })
      });
      assert.equal(badEmailRes.status, 400);
      assert.equal(((await badEmailRes.json()) as { error: string }).error, 'INVALID_EMAIL');
      assert.equal(fakeDb.rawGet('users/student_multi_p5f')?.email, existingEmail);

      // D. Mismatched subscriptionId belonging to bystander -> 403 SUBSCRIPTION_USER_MISMATCH
      const mismatchSubRes = await fetch(`${srv.url}/api/admin/users/update`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${OWNER_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: 'student_multi_p5f',
          subscriptionId: 'sub_bystander',
          name: 'Rahim',
          subscriptionStatus: 'free'
        })
      });
      assert.equal(mismatchSubRes.status, 403);
      assert.equal(fakeDb.rawGet('subscriptions/sub_bystander')?.status, 'active');

      // E. Downgrade to 'free' revokes ALL active subscriptions of student_multi_p5f while preserving history & bystander
      const downgradeFreeRes = await fetch(`${srv.url}/api/admin/users/update`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${OWNER_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: 'student_multi_p5f',
          subscriptionId: 'sub_act_2',
          name: 'Rahim Downgraded',
          subscriptionStatus: 'free'
        })
      });
      assert.equal(downgradeFreeRes.status, 200);
      const downgradeBody = (await downgradeFreeRes.json()) as {
        revokedSubscriptionCount: number;
        updatedSubscriptions: Array<{ id: string; status: string }>;
      };
      assert.equal(downgradeBody.revokedSubscriptionCount, 2);
      assert.equal(fakeDb.rawGet('subscriptions/sub_act_1')?.status, 'cancelled');
      assert.equal(fakeDb.rawGet('subscriptions/sub_act_2')?.status, 'cancelled');
      assert.equal(fakeDb.rawGet('subscriptions/sub_hist_old')?.status, 'expired');
      assert.equal(fakeDb.rawGet('subscriptions/sub_bystander')?.status, 'active');
      assert.equal(fakeDb.rawGet('users/student_multi_p5f')?.email, existingEmail);

      // F. Downgrade to 'expired' marks ALL active subscriptions expired
      fakeDb.rawSet('subscriptions/sub_act_1', { ...fakeDb.rawGet('subscriptions/sub_act_1')!, status: 'active' });
      fakeDb.rawSet('subscriptions/sub_act_2', { ...fakeDb.rawGet('subscriptions/sub_act_2')!, status: 'active' });
      const downgradeExpRes = await fetch(`${srv.url}/api/admin/users/update`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${OWNER_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: 'student_multi_p5f',
          name: 'Rahim Expired',
          subscriptionStatus: 'expired'
        })
      });
      assert.equal(downgradeExpRes.status, 200);
      assert.equal(fakeDb.rawGet('subscriptions/sub_act_1')?.status, 'expired');
      assert.equal(fakeDb.rawGet('subscriptions/sub_act_2')?.status, 'expired');
      assert.equal(fakeDb.rawGet('subscriptions/sub_bystander')?.status, 'active');
    } finally {
      await srv.close();
    }
  });

  test('6–7 & 16. GET /api/subjects reads Firestore subjects, GET /api/subjects/counts aggregates accurately without leaking keys, and dashboard-stats includes totalExamsCompleted', async () => {
    const fakeDb = new FakeFirestore();
    const seedMirror = createMemoryMirror();

    // Seed custom subject in Firestore to prove GET /api/subjects reads Firestore instead of static mirror only
    fakeDb.rawSet('subjects/sub_cpc', {
      ...seedMirror.subjects[0],
      nameEn: 'Code of Civil Procedure (Firestore Authoritative)'
    });
    fakeDb.rawSet('subjects/sub_crpc', {
      ...seedMirror.subjects[1]
    });

    // Seed 3 CPC questions and 2 CrPC questions (without keys in public doc)
    const cpcQs = seedMirror.questions.filter(q => q.subjectId === 'sub_cpc').slice(0, 3);
    const crpcQs = seedMirror.questions.filter(q => q.subjectId === 'sub_crpc').slice(0, 2);
    for (const q of [...cpcQs, ...crpcQs]) {
      const { correctOptionIndex: _c, explanationBn: _eb, explanationEn: _ee, ...sanitized } = q;
      fakeDb.rawSet(`questions/${q.id}`, sanitized as unknown as Record<string, unknown>);
      fakeDb.rawSet(`questionKeys/${q.id}`, {
        correctOptionIndex: q.correctOptionIndex,
        explanationBn: q.explanationBn,
        explanationEn: q.explanationEn
      });
    }

    // Seed 2 exam results for totalExamsCompleted
    fakeDb.rawSet('examResults/res_1', { id: 'res_1', userId: 'u1', finalScore: 80 });
    fakeDb.rawSet('examResults/res_2', { id: 'res_2', userId: 'u2', finalScore: 65 });

    const { app } = createSanadPrepApp({
      firestoreDb: fakeDb as unknown as Firestore,
      isProduction: true,
      rateLimitOverrides: { globalMax: 1000 },
      tokenVerifier
    });
    const srv = await startTestServer(app);

    try {
      const subRes = await fetch(`${srv.url}/api/subjects`);
      assert.equal(subRes.status, 200);
      const subJson = (await subRes.json()) as { subjects: Array<{ id: string; nameEn: string }> };
      assert.equal(subJson.subjects.length, 2);
      assert.equal(
        subJson.subjects.find(s => s.id === 'sub_cpc')?.nameEn,
        'Code of Civil Procedure (Firestore Authoritative)'
      );

      fakeDb.resetReadCounts();
      const countsRes = await fetch(`${srv.url}/api/subjects/counts`);
      assert.equal(countsRes.status, 200);
      const countsJson = (await countsRes.json()) as { counts: Record<string, number>; total: number };
      assert.equal(countsJson.total, 5);
      assert.equal(countsJson.counts.sub_cpc, 3);
      assert.equal(countsJson.counts.sub_crpc, 2);
      assert.equal(fakeDb.getReadCount('questionKeys'), 0);

      const statsRes = await fetch(`${srv.url}/api/admin/dashboard-stats`, {
        headers: { Authorization: `Bearer ${OWNER_TOKEN}` }
      });
      assert.equal(statsRes.status, 200);
      const statsJson = (await statsRes.json()) as { totalExamsCompleted: number };
      assert.equal(statsJson.totalExamsCompleted, 2);

      // Fail closed when Firestore is unavailable in production
      const { app: downApp } = createSanadPrepApp({
        isProduction: true,
        disableFirestoreWrites: true,
        tokenVerifier
      });
      const downSrv = await startTestServer(downApp);
      try {
        const downSubjects = await fetch(`${downSrv.url}/api/subjects`);
        const downCounts = await fetch(`${downSrv.url}/api/subjects/counts`);
        assert.equal(downSubjects.status, 503);
        assert.equal(downCounts.status, 503);
      } finally {
        await downSrv.close();
      }
    } finally {
      invalidateQuestionBankCache(fakeDb as unknown as Firestore);
      await srv.close();
    }
  });

  test('8–10. Payment creation rejects duplicate TrxID in subscriptions, validates senderNumber, and sorts GET /api/payments descending', async () => {
    const fakeDb = new FakeFirestore();
    const seedMirror = createMemoryMirror();
    for (const pkg of seedMirror.packages) {
      fakeDb.rawSet(`packages/${pkg.id}`, pkg as unknown as Record<string, unknown>);
    }

    // Seed an existing subscription with transactionId ONLY in subscriptions (not in paymentRequests)
    fakeDb.rawSet('subscriptions/sub_legacy_trx', {
      id: 'sub_legacy_trx',
      userId: 'other_student',
      studentName: 'Legacy',
      studentPhone: '01700000001',
      packageId: 'pkg_monthly',
      packageNameBn: 'মাসিক',
      packageNameEn: 'Monthly',
      pricePaid: 150,
      paymentRequestId: 'trx_SUBONLY99',
      paymentMethod: 'bKash',
      transactionId: 'SUBONLY99',
      validityType: 'days',
      status: 'active',
      activatedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2027-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z'
    });

    // Seed two payment requests with out-of-order insertion to test sorting
    fakeDb.rawSet('paymentRequests/trx_OLDER01', {
      userId: 'p5f_student_alpha',
      studentName: 'Alpha',
      transactionId: 'OLDER01',
      amount: 150,
      status: 'approved',
      requestedAt: '2026-05-01T08:00:00.000Z'
    });
    fakeDb.rawSet('paymentRequests/trx_NEWER02', {
      userId: 'p5f_student_alpha',
      studentName: 'Alpha',
      transactionId: 'NEWER02',
      amount: 300,
      status: 'pending',
      requestedAt: '2026-06-10T12:00:00.000Z'
    });

    const { app } = createSanadPrepApp({
      firestoreDb: fakeDb as unknown as Firestore,
      isProduction: true,
      rateLimitOverrides: { globalMax: 1000 },
      tokenVerifier
    });
    const srv = await startTestServer(app);

    try {
      const sessRes = await fetch(`${srv.url}/api/auth/session`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${STUDENT_A_TOKEN}` }
      });
      const { sessionId } = (await sessRes.json()) as { sessionId: string };

      // A. Reject short senderNumber (< 6 chars)
      const shortSenderRes = await fetch(`${srv.url}/api/payments/create`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${STUDENT_A_TOKEN}`,
          'X-Session-Id': sessionId,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          method: 'bKash',
          senderNumber: '12345',
          transactionId: 'VALIDTRX01',
          packageId: 'pkg_monthly'
        })
      });
      assert.equal(shortSenderRes.status, 400);
      assert.equal(((await shortSenderRes.json()) as { error: string }).error, 'INVALID_SENDER_NUMBER');

      // B. Reject overly long senderNumber (> 20 chars)
      const longSenderRes = await fetch(`${srv.url}/api/payments/create`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${STUDENT_A_TOKEN}`,
          'X-Session-Id': sessionId,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          method: 'bKash',
          senderNumber: '017111122223333444455',
          transactionId: 'VALIDTRX02',
          packageId: 'pkg_monthly'
        })
      });
      assert.equal(longSenderRes.status, 400);
      assert.equal(((await longSenderRes.json()) as { error: string }).error, 'INVALID_SENDER_NUMBER');

      // C. Reject TrxID already used in subscriptions collection
      const dupSubTrxRes = await fetch(`${srv.url}/api/payments/create`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${STUDENT_A_TOKEN}`,
          'X-Session-Id': sessionId,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          method: 'bKash',
          senderNumber: '01711112222',
          transactionId: 'sub-only-99',
          packageId: 'pkg_monthly'
        })
      });
      assert.equal(dupSubTrxRes.status, 409);
      assert.equal(((await dupSubTrxRes.json()) as { error: string }).error, 'DUPLICATE_TRX_ID');

      // D. GET /api/payments sorts descending by requestedAt
      const listRes = await fetch(`${srv.url}/api/payments`, {
        headers: { Authorization: `Bearer ${STUDENT_A_TOKEN}`, 'X-Session-Id': sessionId }
      });
      assert.equal(listRes.status, 200);
      const listJson = (await listRes.json()) as { paymentRequests: Array<{ id: string }> };
      assert.deepEqual(
        listJson.paymentRequests.map(p => p.id),
        ['trx_NEWER02', 'trx_OLDER01']
      );
    } finally {
      await srv.close();
    }
  });

  test('11–13. Server-side exam deadline enforces timed_out, save-answer rejects invalid currentQuestionIndex, and practice/check validates selectedOption 0–3', async () => {
    const fakeDb = new FakeFirestore();
    const seedMirror = createMemoryMirror();
    const demoQ = seedMirror.questions.find(q => q.isDemoSample) || seedMirror.questions[0];
    const { correctOptionIndex: _c, explanationBn: _eb, explanationEn: _ee, ...sanitizedDemo } = demoQ;
    fakeDb.rawSet(`questions/${demoQ.id}`, { ...sanitizedDemo, isDemoSample: true });
    fakeDb.rawSet(`questionKeys/${demoQ.id}`, {
      correctOptionIndex: demoQ.correctOptionIndex,
      explanationBn: demoQ.explanationBn || '',
      explanationEn: demoQ.explanationEn || ''
    });

    const freeExam = seedMirror.exams.find(e => !e.isPaid) || seedMirror.exams[0];
    fakeDb.rawSet(`exams/${freeExam.id}`, {
      ...freeExam,
      isPaid: false,
      isActive: true,
      questionIds: [demoQ.id]
    });

    // Seed an expired in-progress attempt (deadline was 30 seconds ago, beyond 15s grace period)
    fakeDb.rawSet('examAttempts/attempt_overdue_p5f', {
      id: 'attempt_overdue_p5f',
      examId: freeExam.id,
      userId: 'p5f_student_alpha',
      studentName: 'Student Alpha',
      startTime: new Date(Date.now() - 3600_000).toISOString(),
      deadlineTime: new Date(Date.now() - 30_000).toISOString(),
      status: 'in_progress',
      answers: {},
      flaggedQuestionIds: [],
      currentQuestionIndex: 0,
      lastSavedAt: new Date(Date.now() - 60_000).toISOString(),
      resolvedQuestionIds: [demoQ.id]
    });

    // Seed an active in-progress attempt for save-answer validation
    fakeDb.rawSet('examAttempts/attempt_active_p5f', {
      id: 'attempt_active_p5f',
      examId: freeExam.id,
      userId: 'p5f_student_alpha',
      studentName: 'Student Alpha',
      startTime: new Date().toISOString(),
      deadlineTime: new Date(Date.now() + 3600_000).toISOString(),
      status: 'in_progress',
      answers: {},
      flaggedQuestionIds: [],
      currentQuestionIndex: 0,
      lastSavedAt: new Date().toISOString(),
      resolvedQuestionIds: [demoQ.id]
    });

    const { app } = createSanadPrepApp({
      firestoreDb: fakeDb as unknown as Firestore,
      isProduction: true,
      rateLimitOverrides: { globalMax: 1000 },
      tokenVerifier
    });
    const srv = await startTestServer(app);

    try {
      const sessRes = await fetch(`${srv.url}/api/auth/session`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${STUDENT_A_TOKEN}` }
      });
      const { sessionId } = (await sessRes.json()) as { sessionId: string };

      // 13. POST /api/practice/check rejects invalid selectedOption (-1, 4, 1.5, "1")
      for (const badOpt of [-1, 4, 1.5, '1', null]) {
        const res = await fetch(`${srv.url}/api/practice/check`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${STUDENT_A_TOKEN}`,
            'X-Session-Id': sessionId,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ questionId: demoQ.id, selectedOption: badOpt })
        });
        assert.equal(res.status, 400, `Expected 400 for selectedOption=${String(badOpt)}`);
        assert.equal(((await res.json()) as { error: string }).error, 'INVALID_REQUEST');
      }

      // 12. POST /api/exams/save-answer rejects invalid currentQuestionIndex (-1, 1.5, "0", null)
      for (const badIdx of [-1, 1.5, '0', null]) {
        const res = await fetch(`${srv.url}/api/exams/save-answer`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${STUDENT_A_TOKEN}`,
            'X-Session-Id': sessionId,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            attemptId: 'attempt_active_p5f',
            answers: { [demoQ.id]: demoQ.correctOptionIndex },
            currentQuestionIndex: badIdx
          })
        });
        assert.equal(res.status, 400, `Expected 400 for currentQuestionIndex=${String(badIdx)}`);
        assert.equal(((await res.json()) as { error: string }).error, 'INVALID_REQUEST');
      }

      // Valid non-negative integer currentQuestionIndex succeeds
      const okSaveRes = await fetch(`${srv.url}/api/exams/save-answer`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${STUDENT_A_TOKEN}`,
          'X-Session-Id': sessionId,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          attemptId: 'attempt_active_p5f',
          answers: { [demoQ.id]: demoQ.correctOptionIndex },
          currentQuestionIndex: 0
        })
      });
      assert.equal(okSaveRes.status, 200);

      // 11. POST /api/exams/submit enforces server-side timeout even when client sends isAutoTimeout: false
      const submitOverdueRes = await fetch(`${srv.url}/api/exams/submit`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${STUDENT_A_TOKEN}`,
          'X-Session-Id': sessionId,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          attemptId: 'attempt_overdue_p5f',
          answers: { [demoQ.id]: demoQ.correctOptionIndex },
          isAutoTimeout: false
        })
      });
      assert.equal(submitOverdueRes.status, 200);
      assert.equal(fakeDb.rawGet('examAttempts/attempt_overdue_p5f')?.status, 'timed_out');
    } finally {
      invalidateQuestionBankCache(fakeDb as unknown as Firestore);
      await srv.close();
    }
  });

  test('14–15. Admin packages/update validates price & durationDays, admin/questions enforces field length bounds, and invalidate-cache updates version & clears cache', async () => {
    const fakeDb = new FakeFirestore();
    const seedMirror = createMemoryMirror();
    for (const pkg of seedMirror.packages) {
      fakeDb.rawSet(`packages/${pkg.id}`, pkg as unknown as Record<string, unknown>);
    }

    const sampleQ = seedMirror.questions[0];
    const { correctOptionIndex: _c, explanationBn: _eb, explanationEn: _ee, ...sanitized } = sampleQ;
    fakeDb.rawSet(`questions/${sampleQ.id}`, sanitized as unknown as Record<string, unknown>);

    const opts = {
      firestoreDb: fakeDb as unknown as Firestore,
      isProduction: true,
      questionBankCacheTtlMs: 60_000,
      rateLimitOverrides: { globalMax: 1000 },
      tokenVerifier
    };

    const inst1 = createSanadPrepApp(opts);
    const inst2 = createSanadPrepApp(opts);
    const srv1 = await startTestServer(inst1.app);
    const srv2 = await startTestServer(inst2.app);

    try {
      // 14. Package price and durationDays validation
      for (const badPrice of [0, -100, 'abc', null]) {
        const res = await fetch(`${srv1.url}/api/admin/packages/update`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${OWNER_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 'pkg_monthly', price: badPrice })
        });
        assert.equal(res.status, 400);
        assert.equal(((await res.json()) as { error: string }).error, 'INVALID_PACKAGE_PRICE');
      }
      for (const badDays of [0, -5, 'not-num', null]) {
        const res = await fetch(`${srv1.url}/api/admin/packages/update`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${OWNER_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 'pkg_monthly', durationDays: badDays })
        });
        assert.equal(res.status, 400);
        assert.equal(((await res.json()) as { error: string }).error, 'INVALID_DURATION');
      }

      // 15a. Question field length validation: questionBn > 1000 rejected with 400 INVALID_QUESTION
      const tooLongQRes = await fetch(`${srv1.url}/api/admin/questions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${OWNER_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subjectId: 'sub_cpc',
          questionBn: 'ক'.repeat(1001),
          optionsBn: ['ক', 'খ', 'গ', 'ঘ'],
          correctOptionIndex: 0
        })
      });
      assert.equal(tooLongQRes.status, 400);
      assert.equal(((await tooLongQRes.json()) as { error: string }).error, 'INVALID_QUESTION');

      // 15b. Other question string fields are bounded cleanly
      const boundedRes = await fetch(`${srv1.url}/api/admin/questions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${OWNER_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'q_len_'.padEnd(160, 'x'),
          subjectId: 'sub_cpc',
          topicId: 't_'.padEnd(90, 'y'),
          questionBn: 'বৈধ প্রশ্ন',
          questionEn: 'E'.repeat(1200),
          optionsBn: ['ক', 'খ', 'গ', 'ঘ'],
          correctOptionIndex: 1,
          explanationBn: 'ব'.repeat(2500),
          explanationEn: 'X'.repeat(2500),
          legalReference: 'L'.repeat(300),
          createdBy: 'A'.repeat(150)
        })
      });
      assert.equal(boundedRes.status, 200);
      const boundedJson = (await boundedRes.json()) as { question: Record<string, string> };
      assert.equal(boundedJson.question.id.length, 128);
      assert.equal(boundedJson.question.topicId.length, 64);
      assert.equal(boundedJson.question.questionEn.length, 1000);
      assert.equal(boundedJson.question.explanationBn.length, 2000);
      assert.equal(boundedJson.question.explanationEn.length, 2000);
      assert.equal(boundedJson.question.legalReference.length, 200);
      assert.equal(boundedJson.question.createdBy.length, 100);

      // 15c. Cache invalidation endpoint requires Owner Admin and refreshes cross-instance cache
      const unauthInv = await fetch(`${srv1.url}/api/admin/questions/invalidate-cache`, { method: 'POST' });
      assert.equal(unauthInv.status, 401);
      const studentInv = await fetch(`${srv1.url}/api/admin/questions/invalidate-cache`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${STUDENT_A_TOKEN}` }
      });
      assert.equal(studentInv.status, 403);

      // Warm cache on inst2 via /api/subjects/counts
      const warmBefore = await fetch(`${srv2.url}/api/subjects/counts`);
      const warmTotalBefore = ((await warmBefore.json()) as { total: number }).total;

      // Directly inject a question into Firestore (bypassing admin POST)
      fakeDb.rawSet('questions/q_direct_injected', {
        ...sanitized,
        id: 'q_direct_injected',
        subjectId: 'sub_cpc'
      });

      // Before invalidation, inst2 serves cached total
      const stillCached = await fetch(`${srv2.url}/api/subjects/counts`);
      assert.equal(((await stillCached.json()) as { total: number }).total, warmTotalBefore);

      // Owner triggers /api/admin/questions/invalidate-cache on inst1
      const invRes = await fetch(`${srv1.url}/api/admin/questions/invalidate-cache`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${OWNER_TOKEN}` }
      });
      assert.equal(invRes.status, 200);
      const invJson = (await invRes.json()) as { success: boolean; version: { versionToken: string } };
      assert.equal(invJson.success, true);
      assert.ok(invJson.version.versionToken);

      // Immediately visible on inst2
      const afterInv = await fetch(`${srv2.url}/api/subjects/counts`);
      assert.equal(((await afterInv.json()) as { total: number }).total, warmTotalBefore + 1);
    } finally {
      invalidateQuestionBankCache(fakeDb as unknown as Firestore);
      await Promise.all([srv1.close(), srv2.close()]);
    }
  });
});
