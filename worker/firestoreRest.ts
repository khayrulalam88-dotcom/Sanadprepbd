import {
  EXPECTED_FIREBASE_DATABASE_ID,
  EXPECTED_FIREBASE_PROJECT_ID,
  isStagingEnvironment,
  isValidFirebaseProjectId,
  isValidFirestoreDatabaseId,
  WorkerHttpError,
  type AuditLog,
  type UserSubscription
} from './types.ts';

export function getSafeDiagnosticError(err: unknown): { code?: string | number; message: string } {
  const code = (err as { code?: number | string })?.code;
  const rawMessage = err instanceof Error ? err.message : String(err || 'Unknown database error');
  const sanitizedMessage = rawMessage
    .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, '[REDACTED_KEY]')
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED_API_KEY]')
    .replace(/([?&](?:key|api_key|apiKey)=)[^&\s"']+/gi, '$1[REDACTED]')
    .slice(0, 240);
  return { ...(code !== undefined ? { code } : {}), message: sanitizedMessage };
}

export function resolveEffectiveDatabaseId(
  rawEnvDbId?: string,
  projectId: string = EXPECTED_FIREBASE_PROJECT_ID,
  environment?: string
): string {
  const trimmed = (rawEnvDbId || '').trim();
  if (isStagingEnvironment(environment)) {
    return trimmed;
  }
  if (!trimmed) {
    return EXPECTED_FIREBASE_DATABASE_ID;
  }
  if (trimmed === projectId || trimmed === EXPECTED_FIREBASE_PROJECT_ID) {
    console.warn(
      `[SanadPrep Worker] Ignoring FIREBASE_DATABASE_ID "${trimmed}" because it matches Project ID; using named database "${EXPECTED_FIREBASE_DATABASE_ID}".`
    );
    return EXPECTED_FIREBASE_DATABASE_ID;
  }
  return trimmed;
}

export function assertExpectedNamedDatabase(params?: {
  projectId?: string;
  databaseId?: string;
  environment?: string;
}): { valid: boolean; projectId: string; databaseId: string; reason?: string } {
  const isStaging = isStagingEnvironment(params?.environment);

  if (!isStaging) {
    const projectId = (params?.projectId || '').trim() || EXPECTED_FIREBASE_PROJECT_ID;
    const databaseId = resolveEffectiveDatabaseId(params?.databaseId, projectId, params?.environment);

    if (projectId !== EXPECTED_FIREBASE_PROJECT_ID) {
      return {
        valid: false,
        projectId,
        databaseId,
        reason: `Configured FIREBASE_PROJECT_ID "${projectId}" does not match expected "${EXPECTED_FIREBASE_PROJECT_ID}".`
      };
    }
    if (!databaseId || databaseId === '(default)') {
      return {
        valid: false,
        projectId,
        databaseId,
        reason: `Refusing default/empty Firestore database "${databaseId}". Expected "${EXPECTED_FIREBASE_DATABASE_ID}".`
      };
    }
    if (databaseId !== EXPECTED_FIREBASE_DATABASE_ID) {
      return {
        valid: false,
        projectId,
        databaseId,
        reason: `Configured FIREBASE_DATABASE_ID "${databaseId}" does not match expected "${EXPECTED_FIREBASE_DATABASE_ID}".`
      };
    }
    return { valid: true, projectId, databaseId };
  }

  const projectId = (params?.projectId || '').trim();
  const databaseId = resolveEffectiveDatabaseId(params?.databaseId, projectId, params?.environment);

  if (!projectId || !isValidFirebaseProjectId(projectId)) {
    return {
      valid: false,
      projectId,
      databaseId,
      reason: `Staging FIREBASE_PROJECT_ID "${projectId}" is missing or invalid.`
    };
  }
  if (!databaseId || !isValidFirestoreDatabaseId(databaseId)) {
    return {
      valid: false,
      projectId,
      databaseId,
      reason: `Staging FIREBASE_DATABASE_ID "${databaseId}" is missing or invalid.`
    };
  }
  if (projectId === EXPECTED_FIREBASE_PROJECT_ID && databaseId !== EXPECTED_FIREBASE_DATABASE_ID) {
    return {
      valid: false,
      projectId,
      databaseId,
      reason: `Project "${projectId}" requires named Firestore database "${EXPECTED_FIREBASE_DATABASE_ID}", refusing "${databaseId}".`
    };
  }
  if (projectId !== EXPECTED_FIREBASE_PROJECT_ID && databaseId === EXPECTED_FIREBASE_DATABASE_ID) {
    return {
      valid: false,
      projectId,
      databaseId,
      reason: `Staging project "${projectId}" cannot use production named Firestore database "${EXPECTED_FIREBASE_DATABASE_ID}".`
    };
  }
  return { valid: true, projectId, databaseId };
}

// ---------------------------------------------------------
// Firestore REST v1 Value Codec
// ---------------------------------------------------------

export class FirestoreTimestampValue {
  readonly isoString: string;
  constructor(value: string | Date) {
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) {
      throw new Error(`Invalid FirestoreTimestampValue: ${String(value)}`);
    }
    this.isoString = d.toISOString();
  }
}

export type FirestoreRestValue =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { timestampValue: string }
  | { stringValue: string }
  | { arrayValue: { values?: FirestoreRestValue[] } }
  | { mapValue: { fields?: Record<string, FirestoreRestValue> } };

export interface FirestoreRestDocument {
  name: string;
  fields?: Record<string, FirestoreRestValue>;
  createTime?: string;
  updateTime?: string;
}

export function encodeFirestoreValue(value: unknown): FirestoreRestValue {
  if (value === null || value === undefined) {
    return { nullValue: null };
  }
  if (value instanceof FirestoreTimestampValue) {
    return { timestampValue: value.isoString };
  }
  if (value instanceof Date) {
    return { timestampValue: value.toISOString() };
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
        fields: encodeDocumentFields(value as Record<string, unknown>)
      }
    };
  }
  return { stringValue: String(value) };
}

export function encodeDocumentFields(obj: Record<string, unknown>): Record<string, FirestoreRestValue> {
  const fields: Record<string, FirestoreRestValue> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    fields[k] = encodeFirestoreValue(v);
  }
  return fields;
}

export function decodeFirestoreValue(value: FirestoreRestValue | undefined): unknown {
  if (!value) return undefined;
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

export function decodeDocumentFields(fields?: Record<string, FirestoreRestValue>): Record<string, unknown> {
  if (!fields) return {};
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    result[k] = decodeFirestoreValue(v);
  }
  return result;
}

export function extractDocumentId(resourceName: string): string {
  const parts = resourceName.split('/');
  return parts[parts.length - 1] || '';
}

export type FirestoreWriteOp =
  | {
      type: 'set';
      collection: string;
      docId: string;
      data: Record<string, unknown>;
      merge?: boolean;
      currentDocument?: { exists?: boolean };
    }
  | {
      type: 'create';
      collection: string;
      docId: string;
      data: Record<string, unknown>;
    }
  | {
      type: 'update';
      collection: string;
      docId: string;
      patch: Record<string, unknown>;
      currentDocument?: { exists?: boolean };
    }
  | {
      type: 'delete';
      collection: string;
      docId: string;
      currentDocument?: { exists?: boolean };
    };

export interface StructuredQueryWhere {
  field: string;
  op:
    | 'EQUAL'
    | 'NOT_EQUAL'
    | 'LESS_THAN'
    | 'LESS_THAN_OR_EQUAL'
    | 'GREATER_THAN'
    | 'GREATER_THAN_OR_EQUAL'
    | 'ARRAY_CONTAINS'
    | 'IN';
  value: unknown;
}

/**
 * Keyless Firestore REST v1 client.
 * Uses either anonymous public access (for `allow read: if true` collections/config)
 * or the caller's verified Firebase ID token via `.withToken(idToken)` so Firestore
 * Security Rules evaluate `request.auth` directly without any service-account private key.
 */
export class FirestoreRestClient {
  readonly projectId: string;
  readonly databaseId: string;
  readonly databaseRoot: string;
  readonly documentsRoot: string;
  readonly baseUrl: string;
  readonly hasBearerToken: boolean;
  private readonly environment?: string;
  private readonly bearerToken?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly nowMsFn: () => number;

  constructor(options: {
    projectId?: string;
    databaseId?: string;
    environment?: string;
    bearerToken?: string;
    fetchImpl?: typeof fetch;
    nowMsFn?: () => number;
  }) {
    const dbCheck = assertExpectedNamedDatabase({
      projectId: options.projectId,
      databaseId: options.databaseId,
      environment: options.environment
    });
    if (!dbCheck.valid) {
      throw new WorkerHttpError(503, 'NAMED_DATABASE_MISMATCH', dbCheck.reason || 'Database validation failed.');
    }

    this.projectId = dbCheck.projectId;
    this.databaseId = dbCheck.databaseId;
    this.environment = options.environment;
    this.bearerToken = options.bearerToken?.trim() || undefined;
    this.hasBearerToken = Boolean(this.bearerToken);
    this.databaseRoot = `projects/${this.projectId}/databases/${this.databaseId}`;
    this.documentsRoot = `${this.databaseRoot}/documents`;
    this.baseUrl = `https://firestore.googleapis.com/v1/${this.documentsRoot}`;
    this.fetchImpl =
      options.fetchImpl || ((input, init) => fetch(input, init));
    this.nowMsFn = options.nowMsFn || (() => Date.now());
  }

  /**
   * Returns a shallow copy scoped to a verified caller's Firebase ID token (or public if omitted).
   */
  withToken(bearerToken?: string): FirestoreRestClient {
    return new FirestoreRestClient({
      projectId: this.projectId,
      databaseId: this.databaseId,
      environment: this.environment,
      bearerToken,
      fetchImpl: this.fetchImpl,
      nowMsFn: this.nowMsFn
    });
  }

  documentResourceName(collectionPath: string, docId: string): string {
    const cleanCollection = collectionPath.replace(/^\/+|\/+$/g, '');
    const cleanDocId = encodeURIComponent(docId);
    return `${this.documentsRoot}/${cleanCollection}/${cleanDocId}`;
  }

  private documentUrl(collectionPath: string, docId: string): string {
    const cleanCollection = collectionPath.replace(/^\/+|\/+$/g, '');
    return `${this.baseUrl}/${cleanCollection}/${encodeURIComponent(docId)}`;
  }

  private applyAuthHeader(headers: Headers): void {
    if (this.bearerToken) {
      headers.set('Authorization', `Bearer ${this.bearerToken}`);
    }
  }

  private async requestJson<T>(url: string, init: RequestInit): Promise<{ status: number; data: T }> {
    const headers = new Headers(init.headers);
    this.applyAuthHeader(headers);
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const res = await this.fetchImpl(url, { ...init, headers });
    const text = await res.text();
    let parsed: unknown = {};
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
    }

    if (!res.ok) {
      const errObj = parsed as { error?: { code?: number; status?: string; message?: string } };
      const statusText = errObj?.error?.status || `HTTP_${res.status}`;
      const message = errObj?.error?.message || `Firestore REST request failed (${res.status})`;
      if (res.status === 409 && statusText === 'ALREADY_EXISTS') {
        throw new WorkerHttpError(409, 'ALREADY_EXISTS', 'Document already exists.');
      }
      if (res.status === 409 || statusText === 'ABORTED' || statusText === 'FAILED_PRECONDITION') {
        throw new WorkerHttpError(409, statusText, message);
      }
      if (res.status === 404) {
        throw new WorkerHttpError(404, 'NOT_FOUND', message);
      }
      if (res.status === 403 || statusText === 'PERMISSION_DENIED') {
        throw new WorkerHttpError(403, 'PERMISSION_DENIED', message);
      }
      throw new WorkerHttpError(res.status >= 500 ? 503 : res.status, statusText, message);
    }

    return { status: res.status, data: parsed as T };
  }

  async getDocument<T extends Record<string, unknown> = Record<string, unknown>>(
    collectionPath: string,
    docId: string,
    options?: { transactionId?: string }
  ): Promise<(T & { id: string }) | null> {
    const qs = options?.transactionId ? `?transaction=${encodeURIComponent(options.transactionId)}` : '';
    const headers = new Headers();
    this.applyAuthHeader(headers);
    const res = await this.fetchImpl(`${this.documentUrl(collectionPath, docId)}${qs}`, {
      method: 'GET',
      headers
    });
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 403) {
        throw new WorkerHttpError(403, 'PERMISSION_DENIED', text.slice(0, 200) || 'Firestore GET permission denied.');
      }
      throw new WorkerHttpError(
        res.status >= 500 ? 503 : res.status,
        `FIRESTORE_GET_${res.status}`,
        text.slice(0, 200) || `Firestore GET failed (${res.status})`
      );
    }
    const doc = (await res.json()) as FirestoreRestDocument;
    return {
      ...(decodeDocumentFields(doc.fields) as T),
      id: extractDocumentId(doc.name)
    };
  }

  async batchGetDocuments<T extends Record<string, unknown> = Record<string, unknown>>(
    refs: Array<{ collection: string; docId: string }>,
    options?: { transactionId?: string }
  ): Promise<Map<string, T & { id: string }>> {
    const resultMap = new Map<string, T & { id: string }>();
    if (refs.length === 0) return resultMap;

    for (let i = 0; i < refs.length; i += 100) {
      const chunk = refs.slice(i, i + 100);
      const headers = new Headers({ 'Content-Type': 'application/json' });
      this.applyAuthHeader(headers);
      const body: Record<string, unknown> = {
        documents: chunk.map(r => this.documentResourceName(r.collection, r.docId))
      };
      if (options?.transactionId) {
        body.transaction = options.transactionId;
      }
      const res = await this.fetchImpl(`${this.baseUrl}:batchGet`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        if (res.status === 403) {
          throw new WorkerHttpError(403, 'PERMISSION_DENIED', 'Firestore batchGet permission denied.');
        }
        throw new WorkerHttpError(503, 'FIRESTORE_BATCH_GET_FAILED', `Firestore batchGet failed (${res.status})`);
      }
      const items = (await res.json()) as Array<{ found?: FirestoreRestDocument; missing?: string }>;
      for (const item of items) {
        if (item.found) {
          const docId = extractDocumentId(item.found.name);
          resultMap.set(docId, {
            ...(decodeDocumentFields(item.found.fields) as T),
            id: docId
          });
        }
      }
    }
    return resultMap;
  }

  async setDocument(
    collectionPath: string,
    docId: string,
    data: Record<string, unknown>,
    options?: { merge?: boolean }
  ): Promise<void> {
    await this.commitWrites([{ type: 'set', collection: collectionPath, docId, data, merge: options?.merge }]);
  }

  async createDocument(collectionPath: string, docId: string, data: Record<string, unknown>): Promise<void> {
    await this.commitWrites([{ type: 'create', collection: collectionPath, docId, data }]);
  }

  async updateDocument(
    collectionPath: string,
    docId: string,
    patch: Record<string, unknown>
  ): Promise<void> {
    await this.commitWrites([{ type: 'update', collection: collectionPath, docId, patch }]);
  }

  async deleteDocument(collectionPath: string, docId: string): Promise<void> {
    await this.commitWrites([{ type: 'delete', collection: collectionPath, docId }]);
  }

  async runQuery<T extends Record<string, unknown> = Record<string, unknown>>(params: {
    collection: string;
    where?: StructuredQueryWhere[];
    orderBy?: Array<{ field: string; direction?: 'ASCENDING' | 'DESCENDING' }>;
    limit?: number;
    transactionId?: string;
  }): Promise<Array<T & { id: string }>> {
    const structuredQuery: Record<string, unknown> = {
      from: [{ collectionId: params.collection.replace(/^\/+|\/+$/g, '') }]
    };

    if (params.where && params.where.length > 0) {
      const filters = params.where.map(w => ({
        fieldFilter: {
          field: { fieldPath: w.field },
          op: w.op,
          value: encodeFirestoreValue(w.value)
        }
      }));
      structuredQuery.where =
        filters.length === 1
          ? filters[0]
          : {
              compositeFilter: {
                op: 'AND',
                filters
              }
            };
    }

    if (params.orderBy && params.orderBy.length > 0) {
      structuredQuery.orderBy = params.orderBy.map(o => ({
        field: { fieldPath: o.field },
        direction: o.direction || 'ASCENDING'
      }));
    }

    if (params.limit !== undefined) {
      structuredQuery.limit = params.limit;
    }

    const requestBody: Record<string, unknown> = { structuredQuery };
    if (params.transactionId) {
      requestBody.transaction = params.transactionId;
    }

    const { data } = await this.requestJson<Array<{ document?: FirestoreRestDocument }>>(
      `${this.baseUrl}:runQuery`,
      {
        method: 'POST',
        body: JSON.stringify(requestBody)
      }
    );

    const out: Array<T & { id: string }> = [];
    for (const row of Array.isArray(data) ? data : []) {
      if (row.document) {
        out.push({
          ...(decodeDocumentFields(row.document.fields) as T),
          id: extractDocumentId(row.document.name)
        });
      }
    }
    return out;
  }

  async listDocuments<T extends Record<string, unknown> = Record<string, unknown>>(
    collectionPath: string,
    options?: { pageSize?: number; maxPages?: number }
  ): Promise<Array<T & { id: string }>> {
    const cleanCollection = collectionPath.replace(/^\/+|\/+$/g, '');
    const pageSize = Math.min(500, Math.max(1, Math.floor(options?.pageSize ?? 500)));
    const maxPages = Math.min(40, Math.max(1, Math.floor(options?.maxPages ?? 20)));
    const out: Array<T & { id: string }> = [];
    let pageToken: string | undefined;

    for (let page = 0; page < maxPages; page++) {
      const params = new URLSearchParams({ pageSize: String(pageSize) });
      if (pageToken) {
        params.set('pageToken', pageToken);
      }
      const { data } = await this.requestJson<{
        documents?: FirestoreRestDocument[];
        nextPageToken?: string;
      }>(`${this.baseUrl}/${cleanCollection}?${params.toString()}`, {
        method: 'GET'
      });

      for (const doc of data.documents || []) {
        out.push({
          ...(decodeDocumentFields(doc.fields) as T),
          id: extractDocumentId(doc.name)
        });
      }

      if (!data.nextPageToken) {
        break;
      }
      pageToken = data.nextPageToken;
    }

    return out;
  }

  async beginTransaction(readOnly = false): Promise<string> {
    const { data } = await this.requestJson<{ transaction?: string }>(
      `${this.baseUrl}:beginTransaction`,
      {
        method: 'POST',
        body: JSON.stringify({
          options: readOnly ? { readOnly: {} } : { readWrite: {} }
        })
      }
    );
    if (!data.transaction) {
      throw new WorkerHttpError(503, 'FIRESTORE_TX_FAILED', 'Firestore beginTransaction returned no transaction ID.');
    }
    return data.transaction;
  }

  async rollbackTransaction(transactionId: string): Promise<void> {
    try {
      await this.requestJson(`${this.baseUrl}:rollback`, {
        method: 'POST',
        body: JSON.stringify({ transaction: transactionId })
      });
    } catch {
      // Best-effort rollback on abort/error
    }
  }

  private encodeWriteOp(op: FirestoreWriteOp): Record<string, unknown> {
    const name = this.documentResourceName(op.collection, op.docId);
    if (op.type === 'delete') {
      return {
        delete: name,
        ...(op.currentDocument ? { currentDocument: op.currentDocument } : {})
      };
    }
    if (op.type === 'create') {
      return {
        update: {
          name,
          fields: encodeDocumentFields(op.data)
        },
        currentDocument: { exists: false }
      };
    }
    if (op.type === 'update') {
      const fieldPaths = Object.keys(op.patch).filter(k => op.patch[k] !== undefined);
      return {
        update: {
          name,
          fields: encodeDocumentFields(op.patch)
        },
        updateMask: { fieldPaths },
        currentDocument: op.currentDocument || { exists: true }
      };
    }
    if (op.merge) {
      const fieldPaths = Object.keys(op.data).filter(k => op.data[k] !== undefined);
      return {
        update: {
          name,
          fields: encodeDocumentFields(op.data)
        },
        updateMask: { fieldPaths },
        ...(op.currentDocument ? { currentDocument: op.currentDocument } : {})
      };
    }
    return {
      update: {
        name,
        fields: encodeDocumentFields(op.data)
      },
      ...(op.currentDocument ? { currentDocument: op.currentDocument } : {})
    };
  }

  async commitWrites(ops: FirestoreWriteOp[], transactionId?: string): Promise<void> {
    const body: Record<string, unknown> = {
      writes: ops.map(op => this.encodeWriteOp(op))
    };
    if (transactionId) {
      body.transaction = transactionId;
    }
    await this.requestJson(`${this.baseUrl}:commit`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
  }

  async runTransaction<T>(
    callback: (tx: FirestoreTransactionContext) => Promise<T>,
    maxRetries = 3
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const txId = await this.beginTransaction(false);
      const txCtx = new FirestoreTransactionContext(this, txId);
      try {
        const result = await callback(txCtx);
        await this.commitWrites(txCtx.getQueuedWrites(), txId);
        return result;
      } catch (err) {
        await this.rollbackTransaction(txId);
        lastError = err;
        const isConflict =
          err instanceof WorkerHttpError && (err.code === 'ABORTED' || err.code === 'CONFLICT');
        if (!isConflict || attempt + 1 >= maxRetries) {
          throw err;
        }
      }
    }
    throw lastError;
  }

  async probeConnectivity(): Promise<{ ok: boolean; reason?: string }> {
    try {
      await this.runQuery({ collection: 'config', limit: 1 });
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: getSafeDiagnosticError(err).message };
    }
  }
}

export class FirestoreTransactionContext {
  private readonly writes: FirestoreWriteOp[] = [];
  constructor(
    private readonly client: FirestoreRestClient,
    readonly transactionId: string
  ) {}

  async get<T extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    docId: string
  ): Promise<(T & { id: string }) | null> {
    return this.client.getDocument<T>(collection, docId, { transactionId: this.transactionId });
  }

  create(collection: string, docId: string, data: Record<string, unknown>): this {
    this.writes.push({ type: 'create', collection, docId, data });
    return this;
  }

  set(
    collection: string,
    docId: string,
    data: Record<string, unknown>,
    options?: { merge?: boolean }
  ): this {
    this.writes.push({ type: 'set', collection, docId, data, merge: options?.merge });
    return this;
  }

  update(collection: string, docId: string, patch: Record<string, unknown>): this {
    this.writes.push({ type: 'update', collection, docId, patch, currentDocument: { exists: true } });
    return this;
  }

  delete(collection: string, docId: string): this {
    this.writes.push({ type: 'delete', collection, docId });
    return this;
  }

  getQueuedWrites(): FirestoreWriteOp[] {
    return [...this.writes];
  }
}

export function timestampToIso(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'string') {
    const d = new Date(value);
    return isNaN(d.getTime()) ? value : d.toISOString();
  }
  if (typeof (value as { seconds?: number }).seconds === 'number') {
    const t = value as { seconds: number; nanoseconds?: number };
    return new Date(t.seconds * 1000 + Math.floor((t.nanoseconds || 0) / 1e6)).toISOString();
  }
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? undefined : value.toISOString();
  }
  return undefined;
}

export async function checkUserHasActiveSubscriptionRest(
  client: FirestoreRestClient,
  uid: string,
  nowMs: number = Date.now()
): Promise<{
  active: boolean;
  activeSubscription: UserSubscription | null;
  reason?: string;
  firestoreReachable?: boolean;
}> {
  let userErr: unknown = null;
  let subErr: unknown = null;
  const [userDoc, subDocs] = await Promise.all([
    client.getDocument<Record<string, unknown>>('users', uid).catch(err => {
      userErr = err;
      return null;
    }),
    client
      .runQuery<Record<string, unknown>>({
        collection: 'subscriptions',
        where: [{ field: 'userId', op: 'EQUAL', value: uid }]
      })
      .catch(err => {
        subErr = err;
        return [] as Array<Record<string, unknown> & { id: string }>;
      })
  ]);
  const firestoreReachable = !userErr && !subErr;

  let matchedSub: UserSubscription | null = null;
  for (const raw of subDocs) {
    const subExp = timestampToIso(raw.expiresAt);
    if (raw.status === 'active' && subExp && new Date(subExp).getTime() > nowMs) {
      matchedSub = {
        ...(raw as unknown as Omit<UserSubscription, 'id'>),
        id: raw.id,
        activatedAt: timestampToIso(raw.activatedAt) || new Date(nowMs).toISOString(),
        expiresAt: subExp,
        createdAt: timestampToIso(raw.createdAt) || new Date(nowMs).toISOString()
      };
      break;
    }
  }

  if (matchedSub) {
    return { active: true, activeSubscription: matchedSub, firestoreReachable };
  }

  if (userDoc) {
    const expiryIso = timestampToIso(userDoc.subscriptionExpiresAt);
    if (userDoc.subscriptionStatus === 'pro' && expiryIso && new Date(expiryIso).getTime() > nowMs) {
      return { active: true, activeSubscription: null, firestoreReachable };
    }
  }

  return {
    active: false,
    activeSubscription: null,
    reason: firestoreReachable ? 'NO_ACTIVE_SUBSCRIPTION' : 'FIRESTORE_UNAVAILABLE',
    firestoreReachable
  };
}

export async function writeAuditLogRest(client: FirestoreRestClient, entry: AuditLog): Promise<void> {
  await client.setDocument('auditLogs', entry.id, { ...entry });
}
