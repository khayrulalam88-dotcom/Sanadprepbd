import type { UserRole } from '../types';

export interface EditUserFormInput {
  userId: string;
  subscriptionId?: string;
  name: string;
  email: string;
  initialEmail?: string;
  phone: string;
  role: UserRole;
  subscriptionStatus: 'free' | 'pro' | 'expired';
  packageId?: string;
  packageNameBn?: string;
  packageNameEn?: string;
  expiryDateInput: string;
  initialDateInput?: string;
  originalExpiresAtIso?: string;
  isSessionRevoked?: boolean;
}

export interface EditUserSubmitPayload {
  userId: string;
  subscriptionId?: string;
  name: string;
  email?: string;
  phone: string;
  role: UserRole;
  subscriptionStatus: 'free' | 'pro' | 'expired';
  packageId?: string;
  packageNameBn?: string;
  packageNameEn?: string;
  expiresAt: string;
  isSessionRevoked?: boolean;
}

const LOCAL_DATETIME_REGEX = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const EMAIL_VALIDATION_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function coerceValidDate(value?: string | number | Date | null): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'object' && typeof (value as { seconds?: number }).seconds === 'number') {
    const ts = value as { seconds: number; nanoseconds?: number };
    const d = new Date(ts.seconds * 1000 + Math.floor((ts.nanoseconds || 0) / 1e6));
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(value as string | number);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Formats an ISO/Date/Firestore timestamp into `YYYY-MM-DDTHH:mm` using
 * local calendar components (`getFullYear`, `getMonth`, `getDate`, `getHours`, `getMinutes`)
 * so `<input type="datetime-local">` matches the administrator's local timezone (e.g. Asia/Dhaka UTC+6).
 */
export function formatDateToLocalDateTimeInput(
  value?: string | number | Date | null,
  fallbackMs?: number
): string {
  const parsed = coerceValidDate(value);
  const d = parsed || new Date(fallbackMs ?? Date.now() + 90 * 24 * 3600 * 1000);

  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');

  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

/**
 * Parses a local `YYYY-MM-DDTHH:mm` string from `<input type="datetime-local">`
 * explicitly using local calendar components into epoch milliseconds.
 */
export function parseLocalDateTimeInputToMs(localInput: string): number {
  const trimmed = String(localInput || '').trim();
  const match = LOCAL_DATETIME_REGEX.exec(trimmed);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);
    const hours = Number(match[4]);
    const minutes = Number(match[5]);
    const seconds = match[6] ? Number(match[6]) : 0;
    const localDate = new Date(year, month, day, hours, minutes, seconds, 0);
    return localDate.getTime();
  }
  return new Date(trimmed).getTime();
}

/**
 * Converts a local `YYYY-MM-DDTHH:mm` input string back into a UTC ISO string.
 * When the input matches `initialLocalInput` and `originalExpiresAtIso` is valid,
 * preserves the exact original timestamp without truncation or timezone drift.
 */
export function parseLocalDateTimeInputToIso(
  localInput: string,
  options?: {
    originalExpiresAtIso?: string;
    initialLocalInput?: string;
  }
): string {
  if (
    options?.originalExpiresAtIso &&
    options?.initialLocalInput &&
    localInput.trim() === options.initialLocalInput.trim()
  ) {
    const origDate = coerceValidDate(options.originalExpiresAtIso);
    if (origDate) {
      return origDate.toISOString();
    }
  }

  const ms = parseLocalDateTimeInputToMs(localInput);
  if (isNaN(ms)) {
    throw new Error('INVALID_LOCAL_DATE_INPUT');
  }
  return new Date(ms).toISOString();
}

export function isValidEmailAddress(email: string): boolean {
  const trimmed = email.trim();
  return trimmed.length > 0 && trimmed.length <= 150 && EMAIL_VALIDATION_REGEX.test(trimmed);
}

/**
 * Builds a validated update payload for `EditUserModal` without submitting
 * an empty email string that could overwrite an existing Firestore user email.
 */
export function buildEditUserSubmitPayload(input: EditUserFormInput): EditUserSubmitPayload {
  const trimmedEmail = (input.email || '').trim();
  let normalizedEmail: string | undefined;

  if (trimmedEmail.length > 0) {
    if (!isValidEmailAddress(trimmedEmail)) {
      throw new Error('INVALID_EMAIL_FORMAT');
    }
    normalizedEmail = trimmedEmail.toLowerCase();
  } else if (input.initialEmail && input.initialEmail.trim()) {
    // Never overwrite a known existing email with an empty value if cleared
    normalizedEmail = undefined;
  }

  const expiresAtIso = parseLocalDateTimeInputToIso(input.expiryDateInput, {
    originalExpiresAtIso: input.originalExpiresAtIso,
    initialLocalInput: input.initialDateInput
  });

  return {
    userId: input.userId,
    ...(input.subscriptionId ? { subscriptionId: input.subscriptionId } : {}),
    name: input.name.trim(),
    ...(normalizedEmail !== undefined ? { email: normalizedEmail } : {}),
    phone: input.phone.trim(),
    role: input.role,
    subscriptionStatus: input.subscriptionStatus,
    ...(input.packageId ? { packageId: input.packageId } : {}),
    ...(input.packageNameBn ? { packageNameBn: input.packageNameBn } : {}),
    ...(input.packageNameEn ? { packageNameEn: input.packageNameEn } : {}),
    expiresAt: expiresAtIso,
    ...(input.isSessionRevoked !== undefined ? { isSessionRevoked: input.isSessionRevoked } : {})
  };
}
