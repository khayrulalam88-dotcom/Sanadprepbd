import type { UserProfile, UserRole } from '../types/index.ts';
import { isVerifiedOwnerAccount } from './firebase.ts';

export interface AuthUserSnapshot {
  uid?: string | null;
  email?: string | null;
  emailVerified?: boolean | null;
  displayName?: string | null;
  phoneNumber?: string | null;
}

export interface ValidatedUserProfileCreateDoc {
  uid: string;
  name: string;
  email: string;
  phone: string;
  role: 'student' | 'admin';
  subscriptionStatus: 'free';
  subscriptionExpiresAt: null;
  activePackageId: null;
  activePackageNameBn: null;
  activePackageNameEn: null;
  createdAt: string;
}

export type FirestoreProfileLookupResult =
  | { status: 'found'; profile: UserProfile }
  | { status: 'missing' }
  | { status: 'error'; error: string };

/**
 * Builds a schema-compliant Firestore /users/{uid} creation payload that strictly
 * satisfies firestore.rules (including mandatory `uid == request.auth.uid`,
 * non-empty bounded `name`, locked `role`/`subscriptionStatus`, and `null` expiry).
 */
export function buildUserProfileDocument(params: {
  authUser?: AuthUserSnapshot | null;
  profile?: Partial<UserProfile> | ValidatedUserProfileCreateDoc;
  nowIso?: string;
}): ValidatedUserProfileCreateDoc {
  const { authUser, profile, nowIso = new Date().toISOString() } = params;

  const authUid = typeof authUser?.uid === 'string' ? authUser.uid.trim() : '';
  if (!authUid) {
    throw new Error('UNAUTHENTICATED_PROFILE_WRITE: Authenticated user UID is required.');
  }

  const requestedUid = typeof profile?.uid === 'string' ? profile.uid.trim() : '';
  if (requestedUid && requestedUid !== authUid) {
    throw new Error('UID_MISMATCH_PROFILE_WRITE: Profile UID does not match authenticated user.');
  }

  const isOwner = isVerifiedOwnerAccount(authUser);
  if (!isOwner && authUser?.emailVerified !== true) {
    throw new Error('EMAIL_NOT_VERIFIED_FOR_PROFILE: Email verification is required before profile creation.');
  }

  const rawName =
    (typeof profile?.name === 'string' && profile.name.trim()) ||
    (typeof authUser?.displayName === 'string' && authUser.displayName.trim()) ||
    (isOwner ? 'মো: খাইরুল আলম' : 'শিক্ষার্থী');
  const safeName = rawName.trim().slice(0, 100) || (isOwner ? 'মো: খাইরুল আলম' : 'শিক্ষার্থী');

  const rawEmail =
    (typeof authUser?.email === 'string' && authUser.email.trim()) ||
    (typeof profile?.email === 'string' && profile.email.trim()) ||
    '';
  const safeEmail = rawEmail.trim().toLowerCase().slice(0, 150);

  const rawPhone =
    (typeof profile?.phone === 'string' && profile.phone.trim()) ||
    (typeof authUser?.phoneNumber === 'string' && authUser.phoneNumber.trim()) ||
    '';
  const safePhone = rawPhone.trim().slice(0, 20);

  const safeCreatedAt =
    typeof profile?.createdAt === 'string' && profile.createdAt.trim()
      ? profile.createdAt.trim()
      : nowIso;

  return {
    uid: authUid,
    name: safeName,
    email: safeEmail,
    phone: safePhone,
    role: isOwner ? 'admin' : 'student',
    subscriptionStatus: 'free',
    subscriptionExpiresAt: null,
    activePackageId: null,
    activePackageNameBn: null,
    activePackageNameEn: null,
    createdAt: safeCreatedAt
  };
}

/**
 * Coordinates safe profile lookup + initial creation across Email login,
 * Email verification refresh, Google Sign-In, and onAuthStateChanged restore.
 */
export async function ensureUserProfileInitialized(params: {
  authUser: AuthUserSnapshot;
  candidateName?: string;
  fetchProfileStatus: (uid: string) => Promise<FirestoreProfileLookupResult>;
  createProfile: (docData: ValidatedUserProfileCreateDoc) => Promise<void>;
  updateOwnerRole?: (uid: string) => Promise<void>;
  nowIso?: string;
}): Promise<{ ok: true; profile: UserProfile; created: boolean } | { ok: false; error: string }> {
  const {
    authUser,
    candidateName,
    fetchProfileStatus,
    createProfile,
    updateOwnerRole,
    nowIso = new Date().toISOString()
  } = params;

  const uid = typeof authUser.uid === 'string' ? authUser.uid.trim() : '';
  if (!uid) {
    return { ok: false, error: 'Authenticated UID is missing.' };
  }

  const isOwner = isVerifiedOwnerAccount(authUser);
  const effectiveRole: UserRole = isOwner ? 'admin' : 'student';

  const lookup = await fetchProfileStatus(uid);
  if (lookup.status === 'error') {
    return { ok: false, error: lookup.error };
  }

  if (lookup.status === 'found') {
    const existing = lookup.profile;
    if (isOwner && existing.role !== 'admin' && updateOwnerRole) {
      await updateOwnerRole(uid).catch(() => undefined);
    }
    return {
      ok: true,
      created: false,
      profile: {
        ...existing,
        uid,
        role: effectiveRole
      }
    };
  }

  try {
    const newDoc = buildUserProfileDocument({
      authUser,
      profile: candidateName ? { name: candidateName } : undefined,
      nowIso
    });
    await createProfile(newDoc);
    return {
      ok: true,
      created: true,
      profile: {
        uid: newDoc.uid,
        name: newDoc.name,
        email: newDoc.email,
        phone: newDoc.phone,
        role: newDoc.role,
        subscriptionStatus: newDoc.subscriptionStatus,
        createdAt: newDoc.createdAt
      }
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err || 'Failed to create user profile.');
    return { ok: false, error: msg };
  }
}
