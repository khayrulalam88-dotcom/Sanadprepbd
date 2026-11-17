import {
  EXPECTED_FIREBASE_PROJECT_ID,
  isStagingEnvironment,
  isValidFirebaseProjectId,
  OWNER_ADMIN_EMAIL,
  OWNER_ADMIN_UID,
  WorkerHttpError,
  type DecodedAuthUser
} from './types.ts';

export const GOOGLE_SECURE_TOKEN_JWKS_URL =
  'https://www.googleapis.com/robot/v1/metadata/jwk/securetoken@system.gserviceaccount.com';

export interface FirebaseJwk extends JsonWebKey {
  kid?: string;
  alg?: string;
  use?: string;
  kty: string;
  n?: string;
  e?: string;
}

export interface JwksFetchResult {
  keys: FirebaseJwk[];
  maxAgeSeconds: number;
}

export type JwksFetcher = (url: string) => Promise<JwksFetchResult>;

export interface OwnerAdminOptions {
  environment?: string;
  stagingOwnerAdminUid?: string;
  ENVIRONMENT?: string;
  STAGING_OWNER_ADMIN_UID?: string;
}

export function resolveFirebaseProjectId(rawProjectId?: string, environment?: string): string {
  const trimmed = (rawProjectId || '').trim();
  if (!isStagingEnvironment(environment)) {
    if (!trimmed) return EXPECTED_FIREBASE_PROJECT_ID;
    if (trimmed !== EXPECTED_FIREBASE_PROJECT_ID) {
      throw new WorkerHttpError(
        503,
        'FIREBASE_PROJECT_MISMATCH',
        `Configured FIREBASE_PROJECT_ID "${trimmed}" does not match expected "${EXPECTED_FIREBASE_PROJECT_ID}".`
      );
    }
    return trimmed;
  }

  if (!trimmed || !isValidFirebaseProjectId(trimmed)) {
    throw new WorkerHttpError(
      503,
      'FIREBASE_PROJECT_MISMATCH',
      `Staging FIREBASE_PROJECT_ID "${trimmed}" is missing or invalid.`
    );
  }
  return trimmed;
}

export function base64UrlDecodeToBytes(input: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(input)) {
    throw new WorkerHttpError(401, 'INVALID_TOKEN', 'Malformed base64url segment in JWT.');
  }
  const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=');
  const binary = atob(padded);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64UrlJson<T>(segment: string): T {
  const bytes = base64UrlDecodeToBytes(segment);
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new WorkerHttpError(401, 'INVALID_TOKEN', 'Malformed JSON payload in JWT.');
  }
}

export function parseCacheControlMaxAge(header: string | null, fallbackSeconds = 3600): number {
  if (!header) return fallbackSeconds;
  const match = header.match(/max-age=(\d+)/i);
  if (!match) return fallbackSeconds;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackSeconds;
  return Math.min(parsed, 86_400);
}

export const defaultJwksFetcher: JwksFetcher = async (url: string): Promise<JwksFetchResult> => {
  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' }
  });
  if (!response.ok) {
    throw new WorkerHttpError(
      503,
      'JWKS_FETCH_FAILED',
      `Failed to fetch Firebase public keys (HTTP ${response.status}).`
    );
  }
  const body = (await response.json()) as { keys?: FirebaseJwk[] };
  if (!body || !Array.isArray(body.keys) || body.keys.length === 0) {
    throw new WorkerHttpError(503, 'JWKS_INVALID', 'Firebase JWKS endpoint returned no keys.');
  }
  return {
    keys: body.keys,
    maxAgeSeconds: parseCacheControlMaxAge(response.headers.get('cache-control'), 3600)
  };
};

interface CachedJwksState {
  keysByKid: Map<string, CryptoKey>;
  fetchedAtMs: number;
  expiresAtMs: number;
}

let cachedJwks: CachedJwksState | null = null;
let inFlightJwksRefresh: Promise<CachedJwksState> | null = null;

export function clearFirebaseJwksCacheForTests(): void {
  cachedJwks = null;
  inFlightJwksRefresh = null;
}

async function importRs256PublicKeys(keys: FirebaseJwk[]): Promise<Map<string, CryptoKey>> {
  const map = new Map<string, CryptoKey>();
  for (const jwk of keys) {
    if (!jwk.kid || jwk.kty !== 'RSA' || (jwk.alg && jwk.alg !== 'RS256')) {
      continue;
    }
    const cryptoKey = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );
    map.set(jwk.kid, cryptoKey);
  }
  if (map.size === 0) {
    throw new WorkerHttpError(503, 'JWKS_EMPTY', 'No usable RS256 public keys in Firebase JWKS.');
  }
  return map;
}

async function getVerificationKey(
  kid: string,
  options: { jwksFetcher?: JwksFetcher; nowMs: number }
): Promise<CryptoKey | null> {
  const fetcher = options.jwksFetcher || defaultJwksFetcher;
  const nowMs = options.nowMs;

  if (cachedJwks && nowMs < cachedJwks.expiresAtMs) {
    const existing = cachedJwks.keysByKid.get(kid);
    if (existing) return existing;
    // Key rotation: allow re-fetch at most once every 30s if kid is unknown
    if (nowMs - cachedJwks.fetchedAtMs < 30_000) {
      return null;
    }
  }

  if (!inFlightJwksRefresh) {
    inFlightJwksRefresh = (async () => {
      const res = await fetcher(GOOGLE_SECURE_TOKEN_JWKS_URL);
      const keysByKid = await importRs256PublicKeys(res.keys);
      const fetchedAt = Date.now();
      const nextState: CachedJwksState = {
        keysByKid,
        fetchedAtMs: fetchedAt,
        expiresAtMs: fetchedAt + Math.max(60, res.maxAgeSeconds) * 1000
      };
      cachedJwks = nextState;
      return nextState;
    })().finally(() => {
      inFlightJwksRefresh = null;
    });
  }

  const latest = await inFlightJwksRefresh;
  return latest.keysByKid.get(kid) || null;
}

export interface VerifyFirebaseTokenOptions {
  projectId?: string;
  environment?: string;
  jwksFetcher?: JwksFetcher;
  nowMs?: number;
  clockSkewSeconds?: number;
}

interface RawFirebaseJwtHeader {
  alg?: unknown;
  kid?: unknown;
  typ?: unknown;
}

interface RawFirebaseJwtClaims {
  aud?: unknown;
  iss?: unknown;
  sub?: unknown;
  user_id?: unknown;
  exp?: unknown;
  iat?: unknown;
  auth_time?: unknown;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
}

export async function verifyFirebaseIdToken(
  idToken: string,
  options?: VerifyFirebaseTokenOptions
): Promise<DecodedAuthUser> {
  const trimmed = (idToken || '').trim();
  const parts = trimmed.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new WorkerHttpError(401, 'INVALID_TOKEN', 'Malformed JWT token structure.');
  }

  const [headerSeg, payloadSeg, sigSeg] = parts;
  const header = decodeBase64UrlJson<RawFirebaseJwtHeader>(headerSeg);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid.trim()) {
    throw new WorkerHttpError(401, 'INVALID_TOKEN', 'Unsupported JWT algorithm or missing key ID.');
  }

  const projectId = resolveFirebaseProjectId(options?.projectId, options?.environment);
  const nowMs = options?.nowMs ?? Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const clockSkewSec = options?.clockSkewSeconds ?? 0;

  const publicKey = await getVerificationKey(header.kid.trim(), {
    jwksFetcher: options?.jwksFetcher,
    nowMs
  });
  if (!publicKey) {
    throw new WorkerHttpError(401, 'INVALID_TOKEN', 'Signing key ID not recognized.');
  }

  const signatureBytes = base64UrlDecodeToBytes(sigSeg);
  const signedInput = new TextEncoder().encode(`${headerSeg}.${payloadSeg}`);
  const signedBuffer = signedInput.buffer.slice(
    signedInput.byteOffset,
    signedInput.byteOffset + signedInput.byteLength
  ) as ArrayBuffer;

  const validSig = await crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    publicKey,
    signatureBytes,
    signedBuffer
  );
  if (!validSig) {
    throw new WorkerHttpError(401, 'INVALID_TOKEN', 'Invalid JWT signature.');
  }

  const claims = decodeBase64UrlJson<RawFirebaseJwtClaims>(payloadSeg);
  const expectedIssuer = `https://securetoken.google.com/${projectId}`;

  if (claims.aud !== projectId) {
    throw new WorkerHttpError(401, 'INVALID_TOKEN', 'Token audience does not match Firebase project.');
  }
  if (claims.iss !== expectedIssuer) {
    throw new WorkerHttpError(401, 'INVALID_TOKEN', 'Token issuer does not match Firebase project.');
  }
  if (typeof claims.sub !== 'string' || !claims.sub.trim() || claims.sub.length > 128) {
    throw new WorkerHttpError(401, 'INVALID_TOKEN', 'Invalid Firebase subject (uid) claim.');
  }
  if (claims.user_id !== undefined && claims.user_id !== claims.sub) {
    throw new WorkerHttpError(401, 'INVALID_TOKEN', 'Mismatched user_id and sub claims.');
  }
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp + clockSkewSec <= nowSec) {
    throw new WorkerHttpError(401, 'INVALID_TOKEN', 'Authentication token has expired.');
  }
  if (typeof claims.iat !== 'number' || !Number.isFinite(claims.iat) || claims.iat > nowSec + Math.max(clockSkewSec, 300)) {
    throw new WorkerHttpError(401, 'INVALID_TOKEN', 'Token issued-at timestamp is invalid.');
  }
  if (
    claims.auth_time !== undefined &&
    (typeof claims.auth_time !== 'number' ||
      !Number.isFinite(claims.auth_time) ||
      claims.auth_time > nowSec + Math.max(clockSkewSec, 300))
  ) {
    throw new WorkerHttpError(401, 'INVALID_TOKEN', 'Token auth_time timestamp is invalid.');
  }

  const email = typeof claims.email === 'string' ? claims.email.trim() : undefined;
  const emailVerified = claims.email_verified === true;
  const displayName =
    typeof claims.name === 'string' && claims.name.trim()
      ? claims.name.trim()
      : email
      ? email.split('@')[0]
      : 'Student';

  return {
    uid: claims.sub,
    email,
    emailVerified,
    name: displayName,
    authTime: typeof claims.auth_time === 'number' ? claims.auth_time : undefined,
    issuedAt: claims.iat,
    expiresAt: claims.exp
  };
}

export async function authenticateFirebaseRequest(
  request: Request,
  options?: VerifyFirebaseTokenOptions & {
    tokenVerifier?: (idToken: string) => Promise<DecodedAuthUser>;
  }
): Promise<DecodedAuthUser> {
  const authHeader = request.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new WorkerHttpError(
      401,
      'UNAUTHORIZED',
      'Authentication required. Please sign in with Firebase.'
    );
  }

  const idToken = authHeader.slice(7).trim();
  if (!idToken) {
    throw new WorkerHttpError(401, 'UNAUTHORIZED', 'Missing bearer token.');
  }

  let decoded: DecodedAuthUser;
  try {
    decoded = options?.tokenVerifier
      ? await options.tokenVerifier(idToken)
      : await verifyFirebaseIdToken(idToken, options);
  } catch (err) {
    if (err instanceof WorkerHttpError) {
      if (err.status === 503) throw err;
      throw new WorkerHttpError(401, 'INVALID_TOKEN', 'Invalid or expired authentication token.');
    }
    throw new WorkerHttpError(401, 'INVALID_TOKEN', 'Invalid or expired authentication token.');
  }

  if (decoded.emailVerified !== true) {
    throw new WorkerHttpError(
      403,
      'EMAIL_NOT_VERIFIED',
      'অ্যাকাউন্ট সক্রিয় করতে অনুগ্রহ করে আপনার ইমেইল ভেরিফাই করুন।'
    );
  }

  return decoded;
}

export function resolveEffectiveOwnerAdmin(
  options?: OwnerAdminOptions
): { uid: string; email: string } | null {
  const environment = options?.environment ?? options?.ENVIRONMENT;
  if (!isStagingEnvironment(environment)) {
    // Production or unset environment: strictly locked to production Owner UID & email.
    return {
      uid: OWNER_ADMIN_UID,
      email: OWNER_ADMIN_EMAIL
    };
  }

  const rawStagingUid = (options?.stagingOwnerAdminUid ?? options?.STAGING_OWNER_ADMIN_UID ?? '').trim();
  if (!rawStagingUid) {
    return {
      uid: OWNER_ADMIN_UID,
      email: OWNER_ADMIN_EMAIL
    };
  }

  // Strictly enforce a single-owner UID (reject multi-UID lists, whitespace, or control chars).
  if (/[\s,;|]/.test(rawStagingUid) || rawStagingUid.length > 128) {
    return null;
  }

  return {
    uid: rawStagingUid,
    email: OWNER_ADMIN_EMAIL
  };
}

export function isOwnerUser(
  user?: {
    uid?: string;
    email?: string;
    emailVerified?: boolean;
  },
  options?: OwnerAdminOptions
): boolean {
  if (!user || !user.uid) return false;
  const expectedOwner = resolveEffectiveOwnerAdmin(options);
  if (!expectedOwner) return false;
  if (user.uid !== expectedOwner.uid) return false;
  if (typeof user.email !== 'string' || user.email.trim().toLowerCase() !== expectedOwner.email) {
    return false;
  }
  if (user.emailVerified !== true) return false;
  return true;
}

export function assertOwnerAdmin(user?: DecodedAuthUser, options?: OwnerAdminOptions): DecodedAuthUser {
  if (!user || !isOwnerUser(user, options)) {
    throw new WorkerHttpError(
      403,
      'FORBIDDEN',
      'Access restricted to verified Owner Administrator only.'
    );
  }
  return user;
}
