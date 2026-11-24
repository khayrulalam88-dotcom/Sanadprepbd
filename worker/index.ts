import {
  assertOwnerAdmin,
  authenticateFirebaseRequest,
  isOwnerUser,
  resolveFirebaseProjectId,
  type JwksFetcher
} from './firebaseAuth.ts';
import {
  assertExpectedNamedDatabase,
  FirestoreRestClient,
  getSafeDiagnosticError
} from './firestoreRest.ts';
import {
  checkUserHasActiveSubscriptionKeyless,
  consumeRateLimitD1,
  createOrReplaceSessionD1,
  revokeSessionOnLogoutD1,
  upsertExamsBatchD1,
  validateAndTouchSessionD1,
  writeAuditLogD1,
  type RateLimitResult
} from './d1Store.ts';
import {
  getD1QuestionBankMeta,
  getRemoteQuestionBankVersion,
  syncQuestionsAndKeysToD1
} from './questionCache.ts';
import type { Exam } from '../src/types/index.ts';
import {
  WorkerHttpError,
  type DecodedAuthUser,
  type ExecutionContext,
  type StudentSession,
  type WorkerEnv
} from './types.ts';
import { handlePhase2Routes } from './catalogAndPractice.ts';
import {
  handlePaymentsAndAdminRoutes,
  syncEdgeRecordsWithOwnerFirestore
} from './paymentsAndAdmin.ts';
import { handleExamsAndResultsRoutes } from './examsAndResults.ts';

export { assertOwnerAdmin, isOwnerUser };

export interface WorkerDependencies {
  tokenVerifier?: (idToken: string) => Promise<DecodedAuthUser>;
  jwksFetcher?: JwksFetcher;
  firestoreClientFactory?: (env: WorkerEnv) => FirestoreRestClient;
  fetchImpl?: typeof fetch;
  nowMsFn?: () => number;
  questionBankCacheTtlMs?: number;
  rateLimitOverrides?: {
    windowMs?: number;
    globalMax?: number;
    routeMax?: Record<string, number>;
  };
}

export function parseAllowedOrigins(raw?: string): Set<string> {
  const allowed = new Set<string>();
  const entries = (raw || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  for (const entry of entries) {
    try {
      const parsed = new URL(entry);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        allowed.add(parsed.origin.toLowerCase());
      }
    } catch {
      // Ignore malformed origin entries
    }
  }
  return allowed;
}

export function isOriginAllowed(
  origin?: string | null,
  options?: { isProduction?: boolean; allowedOriginEnv?: string }
): boolean {
  if (!origin) return true;

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    return false;
  }

  if (parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:') {
    return false;
  }

  const normalizedOrigin = parsedOrigin.origin.toLowerCase();
  const isProd = options?.isProduction ?? true;
  const allowedSet = parseAllowedOrigins(options?.allowedOriginEnv);

  if (allowedSet.has(normalizedOrigin)) {
    return true;
  }

  const host = parsedOrigin.hostname.toLowerCase();
  if (!isProd && (host === 'localhost' || host === '127.0.0.1')) {
    return true;
  }

  return false;
}

function buildSecurityHeaders(request: Request, pathname: string, isProduction: boolean): Record<string, string> {
  const hostHeader = String(
    request.headers.get('x-forwarded-host') || request.headers.get('host') || new URL(request.url).host || ''
  )
    .split(',')[0]
    .trim()
    .toLowerCase();
  const isAiStudioHost = /^ais-(dev|pre)-[a-z0-9-]+\.[a-z0-9.-]+\.run\.app(?::\d+)?$/.test(hostHeader);
  const isApiOrHealth = pathname === '/health' || pathname.startsWith('/api');

  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups'
  };

  if (isApiOrHealth || (isProduction && !isAiStudioHost)) {
    headers['X-Frame-Options'] = 'DENY';
  } else {
    headers['Content-Security-Policy'] =
      "frame-ancestors 'self' https://aistudio.google.com https://*.google.com https://*.googleusercontent.com";
  }

  if (isProduction) {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }

  return headers;
}

function withStandardHeaders(
  response: Response,
  request: Request,
  pathname: string,
  isProduction: boolean,
  corsOrigin?: string,
  extraHeaders?: Record<string, string>
): Response {
  const nextHeaders = new Headers(response.headers);
  const secHeaders = buildSecurityHeaders(request, pathname, isProduction);
  for (const [k, v] of Object.entries(secHeaders)) {
    nextHeaders.set(k, v);
  }
  if (corsOrigin) {
    nextHeaders.set('Access-Control-Allow-Origin', corsOrigin);
    nextHeaders.set('Access-Control-Allow-Credentials', 'true');
    nextHeaders.set('Vary', 'Origin');
  }
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      nextHeaders.set(k, v);
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: nextHeaders
  });
}

function jsonResponse(
  status: number,
  payload: unknown,
  extraHeaders?: Record<string, string>
): Response {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      headers.set(k, v);
    }
  }
  return new Response(JSON.stringify(payload), { status, headers });
}

function getClientIp(request: Request): string {
  const cfIp = request.headers.get('cf-connecting-ip');
  if (cfIp && cfIp.trim()) return cfIp.trim();
  const xff = request.headers.get('x-forwarded-for');
  if (xff && xff.trim()) return xff.split(',')[0].trim();
  return 'unknown';
}

function generateSecureSessionId(nowMs: number): string {
  const randomPart =
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      : `${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;
  return `sess_${nowMs}_${randomPart}`;
}

async function parseOptionalJsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get('content-length') || '0');
  if (Number.isFinite(contentLength) && contentLength > 65_536) {
    throw new WorkerHttpError(413, 'PAYLOAD_TOO_LARGE', 'Request payload too large.');
  }
  const raw = await request.text();
  if (!raw || !raw.trim()) return {};
  if (raw.length > 65_536) {
    throw new WorkerHttpError(413, 'PAYLOAD_TOO_LARGE', 'Request payload too large.');
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new WorkerHttpError(400, 'INVALID_REQUEST', 'Request body must be a JSON object.');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof WorkerHttpError) throw err;
    throw new WorkerHttpError(400, 'INVALID_JSON', 'Invalid JSON request body.');
  }
}

export function createWorkerHandler(deps?: WorkerDependencies) {
  return async function handleRequest(
    request: Request,
    env: WorkerEnv,
    _ctx?: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method.toUpperCase();
    const environment = (env.ENVIRONMENT || 'production').trim().toLowerCase();
    const isProduction = environment !== 'development';
    const nowMs = deps?.nowMsFn ? deps.nowMsFn() : Date.now();

    const origin = request.headers.get('origin');
    if (
      origin &&
      !isOriginAllowed(origin, {
        isProduction,
        allowedOriginEnv: env.ALLOWED_ORIGIN
      })
    ) {
      return withStandardHeaders(
        jsonResponse(403, {
          error: 'CORS_ORIGIN_NOT_ALLOWED',
          message: 'Origin not allowed by CORS policy.'
        }),
        request,
        pathname,
        isProduction
      );
    }

    const corsOrigin = origin || undefined;

    if (method === 'OPTIONS') {
      return withStandardHeaders(
        new Response(null, { status: 204 }),
        request,
        pathname,
        isProduction,
        corsOrigin,
        {
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Session-Id',
          'Access-Control-Max-Age': '86400'
        }
      );
    }

    // Serve static frontend assets when route is outside Worker API/health boundaries
    if (pathname !== '/health' && !pathname.startsWith('/api')) {
      if (env.ASSETS) {
        const assetResponse = await env.ASSETS.fetch(request);
        return withStandardHeaders(assetResponse, request, pathname, isProduction, corsOrigin);
      }
      return withStandardHeaders(
        jsonResponse(404, { error: 'NOT_FOUND', message: 'Static asset binding not configured.' }),
        request,
        pathname,
        isProduction,
        corsOrigin
      );
    }

    // Retired endpoints must remain permanently closed
    if (
      pathname === '/api/previous-questions' ||
      pathname.startsWith('/api/previous-questions/') ||
      pathname === '/api/admin/previous-questions' ||
      pathname.startsWith('/api/admin/previous-questions/')
    ) {
      return withStandardHeaders(
        jsonResponse(404, {
          error: 'NOT_FOUND',
          message: 'This endpoint has been permanently retired.'
        }),
        request,
        pathname,
        isProduction,
        corsOrigin
      );
    }

    const dbCheck = assertExpectedNamedDatabase({
      projectId: env.FIREBASE_PROJECT_ID,
      databaseId: env.FIREBASE_DATABASE_ID,
      environment: env.ENVIRONMENT
    });
    const d1Configured = Boolean(env.DB);

    const buildFirestoreClient = (): FirestoreRestClient => {
      if (deps?.firestoreClientFactory) {
        return deps.firestoreClientFactory(env);
      }
      return new FirestoreRestClient({
        projectId: env.FIREBASE_PROJECT_ID,
        databaseId: env.FIREBASE_DATABASE_ID,
        environment: env.ENVIRONMENT,
        fetchImpl: deps?.fetchImpl,
        nowMsFn: deps?.nowMsFn
      });
    };

    // ---------------------------------------------------------
    // HEALTH ENDPOINT (No auth required, exempt from rate limit)
    // ---------------------------------------------------------
    if ((pathname === '/health' || pathname === '/api/health') && method === 'GET') {
      let probeOk: boolean | undefined;
      let probeReason: string | undefined;
      const shouldProbe = url.searchParams.get('probe') === '1';

      if (shouldProbe && dbCheck.valid) {
        try {
          const client = buildFirestoreClient();
          const probeRes = await client.probeConnectivity();
          probeOk = probeRes.ok;
          probeReason = probeRes.reason;
        } catch (err) {
          probeOk = false;
          probeReason = getSafeDiagnosticError(err).message;
        }
      }

      const persistenceMode =
        dbCheck.valid && probeOk !== false ? 'keyless-firestore-and-d1' : 'unavailable';
      const healthy = dbCheck.valid && d1Configured && probeOk !== false;

      return withStandardHeaders(
        jsonResponse(healthy ? 200 : 503, {
          status: healthy ? 'ok' : 'degraded',
          runtime: 'cloudflare-worker',
          phase: 3,
          service: 'Sanad Prep BD Subscription & Examination Engine',
          authMode: 'keyless-firebase-id-token-and-d1',
          persistenceMode,
          environment,
          projectId: dbCheck.projectId,
          databaseId: dbCheck.databaseId,
          expectedDatabaseMatched: dbCheck.valid,
          d1Configured,
          ...(probeOk !== undefined ? { firestoreProbeOk: probeOk } : {}),
          ...(probeReason && !isProduction ? { diagnosticNotice: probeReason } : {}),
          serverTime: new Date(nowMs).toISOString(),
          timezone: 'Asia/Dhaka'
        }),
        request,
        pathname,
        isProduction,
        corsOrigin
      );
    }

    // All /api/* endpoints below require valid D1 + Named Firestore REST client
    if (!env.DB) {
      return withStandardHeaders(
        jsonResponse(503, {
          error: 'D1_UNAVAILABLE',
          message: 'Edge session & rate-limit database unavailable.'
        }),
        request,
        pathname,
        isProduction,
        corsOrigin
      );
    }

    let rateLimitHeaders: Record<string, string> = {};
    const windowMs = deps?.rateLimitOverrides?.windowMs ?? 60_000;
    const globalMax = deps?.rateLimitOverrides?.globalMax ?? 120;

    try {
      const globalResult: RateLimitResult = await consumeRateLimitD1(env.DB, {
        key: `global:ip_${getClientIp(request)}`,
        windowMs,
        maxRequests: globalMax,
        nowMs
      });
      rateLimitHeaders = {
        'X-RateLimit-Limit': String(globalResult.limit),
        'X-RateLimit-Remaining': String(globalResult.remaining)
      };
      if (!globalResult.allowed) {
        return withStandardHeaders(
          jsonResponse(
            429,
            {
              error: 'RATE_LIMITED',
              retryAfterSeconds: globalResult.retryAfterSeconds,
              message: `অতিরিক্ত অনুরোধ পাঠানো হয়েছে। অনুগ্রহ করে ${globalResult.retryAfterSeconds} সেকেন্ড পর আবার চেষ্টা করুন।`
            },
            {
              ...rateLimitHeaders,
              'Retry-After': String(globalResult.retryAfterSeconds)
            }
          ),
          request,
          pathname,
          isProduction,
          corsOrigin
        );
      }

      if (!dbCheck.valid) {
        throw new WorkerHttpError(503, 'NAMED_DATABASE_MISMATCH', dbCheck.reason || 'Named database mismatch.');
      }
      const firestoreClient = buildFirestoreClient();
      const projectId = resolveFirebaseProjectId(env.FIREBASE_PROJECT_ID, env.ENVIRONMENT);

      // ---------------------------------------------------------
      // PHASE 1: AUTHENTICATION & SINGLE-DEVICE SESSION ENDPOINTS
      // ---------------------------------------------------------
      if (pathname === '/api/auth/session' && method === 'POST') {
        const authUser = await authenticateFirebaseRequest(request, {
          projectId,
          environment: env.ENVIRONMENT,
          jwksFetcher: deps?.jwksFetcher,
          tokenVerifier: deps?.tokenVerifier,
          nowMs
        });

        const authSessionMax = deps?.rateLimitOverrides?.routeMax?.auth_session ?? 15;
        const routeLimit = await consumeRateLimitD1(env.DB, {
          key: `auth_session:uid_${authUser.uid}`,
          windowMs,
          maxRequests: authSessionMax,
          nowMs
        });
        rateLimitHeaders = {
          'X-RateLimit-Limit': String(routeLimit.limit),
          'X-RateLimit-Remaining': String(routeLimit.remaining)
        };
        if (!routeLimit.allowed) {
          return withStandardHeaders(
            jsonResponse(
              429,
              {
                error: 'RATE_LIMITED',
                retryAfterSeconds: routeLimit.retryAfterSeconds,
                message: `অতিরিক্ত অনুরোধ পাঠানো হয়েছে। অনুগ্রহ করে ${routeLimit.retryAfterSeconds} সেকেন্ড পর আবার চেষ্টা করুন।`
              },
              {
                ...rateLimitHeaders,
                'Retry-After': String(routeLimit.retryAfterSeconds)
              }
            ),
            request,
            pathname,
            isProduction,
            corsOrigin
          );
        }

        const body = await parseOptionalJsonBody(request);
        const rawName = typeof body.userName === 'string' && body.userName.trim() ? body.userName : authUser.name || 'Student';
        const rawDevice =
          typeof body.deviceInfo === 'string' && body.deviceInfo.trim()
            ? body.deviceInfo
            : request.headers.get('user-agent') || 'Web Browser';

        const nowIso = new Date(nowMs).toISOString();
        const sessionId = generateSecureSessionId(nowMs);
        const newSession: StudentSession = {
          sessionId,
          userId: authUser.uid,
          userEmail: authUser.email || '',
          userName: rawName.trim().slice(0, 100),
          deviceInfo: rawDevice.trim().slice(0, 160),
          createdAt: nowIso,
          lastActiveAt: nowIso,
          status: 'active'
        };

        const { previousSessionId } = await createOrReplaceSessionD1(env.DB, newSession);

        if (previousSessionId) {
          await writeAuditLogD1(env.DB, {
            id: `log_${nowMs}_${Math.random().toString(36).slice(2, 6)}`,
            userId: authUser.uid,
            userName: newSession.userName,
            action: 'SESSION_REVOKED_CONCURRENT',
            details: `Previous session ${previousSessionId.slice(0, 8)}... revoked due to new login.`,
            timestamp: nowIso
          });
        }

        const userClient = firestoreClient.withToken(authUser.idToken);

        // When Owner Admin signs in, best-effort warm cold D1 question/key/exam cache & replicate pending edge records
        if (isOwnerUser(authUser, env)) {
          try {
            const [localMeta, remoteVersion] = await Promise.all([
              getD1QuestionBankMeta(env.DB),
              getRemoteQuestionBankVersion(userClient)
            ]);
            if (
              !localMeta ||
              localMeta.question_count === 0 ||
              localMeta.version_token !== remoteVersion.versionToken
            ) {
              await syncQuestionsAndKeysToD1(env.DB, userClient, { nowMs }).catch(() => undefined);
              const examDocs = await userClient
                .listDocuments<Record<string, unknown>>('exams', { pageSize: 200, maxPages: 5 })
                .catch(() => [] as Array<Record<string, unknown> & { id: string }>);
              if (examDocs.length > 0) {
                await upsertExamsBatchD1(
                  env.DB,
                  examDocs.map(d => ({
                    ...(d as unknown as Omit<Exam, 'id'>),
                    id: d.id,
                    isActive: d.isActive !== undefined ? Boolean(d.isActive) : !d.isPaid || d.id === 'exam_model_test_01'
                  })),
                  nowIso
                ).catch(() => undefined);
              }
            }
            await syncEdgeRecordsWithOwnerFirestore(env.DB, userClient).catch(() => undefined);
          } catch {
            // Best-effort warmup; never block Owner Admin login
          }
        }

        const subStatus = await checkUserHasActiveSubscriptionKeyless(
          env.DB,
          userClient,
          authUser.uid,
          nowMs
        );

        return withStandardHeaders(
          jsonResponse(
            200,
            {
              success: true,
              sessionId,
              session: newSession,
              activeSubscription: subStatus.activeSubscription
            },
            rateLimitHeaders
          ),
          request,
          pathname,
          isProduction,
          corsOrigin
        );
      }

      if (pathname === '/api/auth/session/status' && method === 'GET') {
        const authUser = await authenticateFirebaseRequest(request, {
          projectId,
          environment: env.ENVIRONMENT,
          jwksFetcher: deps?.jwksFetcher,
          tokenVerifier: deps?.tokenVerifier,
          nowMs
        });

        const sessionHeader = request.headers.get('x-session-id') || '';
        const session = await validateAndTouchSessionD1(env.DB, {
          sessionId: sessionHeader,
          uid: authUser.uid,
          nowIso: new Date(nowMs).toISOString()
        });

        const userClient = firestoreClient.withToken(authUser.idToken);
        const subStatus = await checkUserHasActiveSubscriptionKeyless(
          env.DB,
          userClient,
          authUser.uid,
          nowMs
        );
        return withStandardHeaders(
          jsonResponse(
            200,
            {
              active: true,
              session,
              activeSubscription: subStatus.activeSubscription
            },
            rateLimitHeaders
          ),
          request,
          pathname,
          isProduction,
          corsOrigin
        );
      }

      if (pathname === '/api/auth/logout' && method === 'POST') {
        const authUser = await authenticateFirebaseRequest(request, {
          projectId,
          environment: env.ENVIRONMENT,
          jwksFetcher: deps?.jwksFetcher,
          tokenVerifier: deps?.tokenVerifier,
          nowMs
        });

        const sessionHeader = request.headers.get('x-session-id') || '';
        const session = await validateAndTouchSessionD1(env.DB, {
          sessionId: sessionHeader,
          uid: authUser.uid,
          nowIso: new Date(nowMs).toISOString()
        });

        await revokeSessionOnLogoutD1(env.DB, {
          sessionId: session.sessionId,
          uid: authUser.uid,
          nowIso: new Date(nowMs).toISOString()
        });

        return withStandardHeaders(
          jsonResponse(200, { success: true }, rateLimitHeaders),
          request,
          pathname,
          isProduction,
          corsOrigin
        );
      }

      // ---------------------------------------------------------
      // PHASE 2: CATALOG, QUESTION BANK, PRACTICE & OWNER QUESTION CRUD
      // ---------------------------------------------------------
      const phase2Result = await handlePhase2Routes({
        request,
        url,
        pathname,
        method,
        env,
        projectId,
        nowMs,
        firestoreClient,
        jwksFetcher: deps?.jwksFetcher,
        tokenVerifier: deps?.tokenVerifier,
        questionBankCacheTtlMsOverride: deps?.questionBankCacheTtlMs,
        rateLimitOverrides: deps?.rateLimitOverrides
      });
      if (phase2Result) {
        return withStandardHeaders(
          jsonResponse(phase2Result.status, phase2Result.payload, {
            ...rateLimitHeaders,
            ...(phase2Result.headers || {})
          }),
          request,
          pathname,
          isProduction,
          corsOrigin
        );
      }

      // ---------------------------------------------------------
      // PHASE 3: EXAMS, SCORING, LEADERBOARD, PAYMENTS, SUBSCRIPTIONS & ADMIN
      // ---------------------------------------------------------
      const phase3Ctx = {
        request,
        url,
        pathname,
        method,
        env,
        projectId,
        nowMs,
        firestoreClient,
        jwksFetcher: deps?.jwksFetcher,
        tokenVerifier: deps?.tokenVerifier,
        questionBankCacheTtlMsOverride: deps?.questionBankCacheTtlMs,
        rateLimitOverrides: deps?.rateLimitOverrides
      };

      const examResult = await handleExamsAndResultsRoutes(phase3Ctx);
      if (examResult) {
        return withStandardHeaders(
          jsonResponse(examResult.status, examResult.payload, {
            ...rateLimitHeaders,
            ...(examResult.headers || {})
          }),
          request,
          pathname,
          isProduction,
          corsOrigin
        );
      }

      const paymentAdminResult = await handlePaymentsAndAdminRoutes(phase3Ctx);
      if (paymentAdminResult) {
        return withStandardHeaders(
          jsonResponse(paymentAdminResult.status, paymentAdminResult.payload, {
            ...rateLimitHeaders,
            ...(paymentAdminResult.headers || {})
          }),
          request,
          pathname,
          isProduction,
          corsOrigin
        );
      }

      return withStandardHeaders(
        jsonResponse(
          404,
          {
            error: 'NOT_FOUND',
            message: 'API endpoint not found.'
          },
          rateLimitHeaders
        ),
        request,
        pathname,
        isProduction,
        corsOrigin
      );
    } catch (err) {
      if (err instanceof WorkerHttpError) {
        const extra =
          err.status === 429
            ? { ...rateLimitHeaders, 'Retry-After': '60' }
            : rateLimitHeaders;
        return withStandardHeaders(
          jsonResponse(err.status, { error: err.code, message: err.message }, extra),
          request,
          pathname,
          isProduction,
          corsOrigin
        );
      }

      const safe = getSafeDiagnosticError(err);
      console.error(`[SanadPrep Worker][${method} ${pathname}]`, safe.code ?? '', safe.message);
      return withStandardHeaders(
        jsonResponse(
          500,
          {
            error: 'WORKER_INTERNAL_ERROR',
            message: 'Request processing failed.'
          },
          rateLimitHeaders
        ),
        request,
        pathname,
        isProduction,
        corsOrigin
      );
    }
  };
}

const defaultHandler = createWorkerHandler();

export default {
  fetch: defaultHandler
};
