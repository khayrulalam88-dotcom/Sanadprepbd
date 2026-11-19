export const DEFAULT_GEMINI_MODEL = 'gemini-4-hydrogen';

const ALLOWED_GEMINI_MODELS = new Set<string>([
  'gemini-4-hydrogen',
  'gemini-3.1-flash-lite',
  'gemini-4-argon',
  'gemini-4-carbon'
]);

const DEPRECATED_GEMINI_MODELS = new Set<string>([
  'gemini-1.5-flash',
  'gemini-1.5-pro',
  'gemini-pro',
  'gemini-2.0-flash',
  'gemini-2.0-pro',
  'gemini-2.0-flash-thinking'
]);

const MAX_PROMPT_LENGTH = 16000;

export function redactGeminiSecrets(input: string): string {
  return String(input || '')
    .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, '[REDACTED_KEY]')
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED_API_KEY]')
    .replace(/([?&](?:key|api_key|apiKey)=)[^&\s"']+/gi, '$1[REDACTED]');
}

export function isGeminiConfigured(): boolean {
  return false;
}

export function getGeminiClient(): null {
  return null;
}

export interface ValidatedGeminiRequest {
  valid: boolean;
  status?: number;
  code?: string;
  message?: string;
  prompt?: string;
  systemInstruction?: string;
  model?: string;
}

export function validateGeminiRequest(params: {
  prompt?: unknown;
  systemInstruction?: unknown;
  model?: unknown;
}): ValidatedGeminiRequest {
  if (typeof params.prompt !== 'string' || !params.prompt.trim()) {
    return {
      valid: false,
      status: 400,
      code: 'INVALID_PROMPT',
      message: 'A non-empty text prompt is required.'
    };
  }

  const cleanPrompt = params.prompt.trim();
  if (cleanPrompt.length > MAX_PROMPT_LENGTH) {
    return {
      valid: false,
      status: 400,
      code: 'PROMPT_TOO_LONG',
      message: `Prompt exceeds maximum allowed length (${MAX_PROMPT_LENGTH} characters).`
    };
  }

  let cleanSystemInstruction: string | undefined;
  if (params.systemInstruction !== undefined) {
    if (typeof params.systemInstruction !== 'string') {
      return {
        valid: false,
        status: 400,
        code: 'INVALID_SYSTEM_INSTRUCTION',
        message: 'systemInstruction must be a string when provided.'
      };
    }
    cleanSystemInstruction = params.systemInstruction.trim().slice(0, 4000) || undefined;
  }

  const requestedModel =
    typeof params.model === 'string' && params.model.trim()
      ? params.model.trim()
      : DEFAULT_GEMINI_MODEL;

  if (DEPRECATED_GEMINI_MODELS.has(requestedModel) || !ALLOWED_GEMINI_MODELS.has(requestedModel)) {
    return {
      valid: false,
      status: 400,
      code: 'UNSUPPORTED_GEMINI_MODEL',
      message: 'Requested Gemini model is unsupported.'
    };
  }

  return {
    valid: true,
    prompt: cleanPrompt,
    systemInstruction: cleanSystemInstruction,
    model: requestedModel
  };
}

export function normalizeGeminiError(err: unknown): {
  status: number;
  code: string;
  message: string;
} {
  const statusRaw = Number((err as { status?: number })?.status || 0);
  const safeMsg = redactGeminiSecrets(err instanceof Error ? err.message : String(err || ''));
  const lower = safeMsg.toLowerCase();

  if (statusRaw === 400 || lower.includes('api_key_invalid')) {
    return {
      status: lower.includes('api_key_invalid') ? 503 : 400,
      code: lower.includes('api_key_invalid') ? 'GEMINI_KEY_INVALID' : 'GEMINI_BAD_REQUEST',
      message: lower.includes('api_key_invalid')
        ? 'Server Gemini API configuration is invalid. Please verify GEMINI_API_KEY in server Secrets.'
        : 'Gemini request rejected as invalid.'
    };
  }

  if (statusRaw === 401 || statusRaw === 403 || lower.includes('permission_denied')) {
    return {
      status: 503,
      code: 'GEMINI_PERMISSION_DENIED',
      message: 'Server Gemini API credential was rejected. Verify GEMINI_API_KEY in server Secrets.'
    };
  }

  if (statusRaw === 404 || lower.includes('not_found')) {
    return {
      status: 404,
      code: 'GEMINI_MODEL_NOT_FOUND',
      message: 'Configured Gemini model was not found.'
    };
  }

  if (statusRaw === 429 || lower.includes('resource_exhausted')) {
    return {
      status: 429,
      code: 'GEMINI_RATE_LIMITED',
      message: 'Gemini API quota exceeded. Please try again shortly.'
    };
  }

  return {
    status: 502,
    code: 'GEMINI_UPSTREAM_ERROR',
    message: 'Failed to process Gemini request on the server.'
  };
}

export async function generateGeminiText(_params: {
  prompt: unknown;
  systemInstruction?: unknown;
  model?: unknown;
}): Promise<
  | { ok: true; text: string; model: string }
  | { ok: false; status: number; code: string; message: string }
> {
  return {
    ok: false,
    status: 503,
    code: 'GEMINI_DISABLED',
    message: 'Gemini API integration is disabled in Sanad Prep BD.'
  };
}
