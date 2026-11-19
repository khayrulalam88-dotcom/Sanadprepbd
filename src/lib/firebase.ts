import { initializeApp, getApps, getApp, FirebaseApp } from 'firebase/app';
import { getAuth, Auth, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore, Firestore } from 'firebase/firestore';
import firebaseConfigJson from '../../firebase-applet-config.json' with { type: 'json' };

export interface FirebaseConfig {
  projectId: string;
  appId: string;
  apiKey: string;
  authDomain: string;
  firestoreDatabaseId?: string;
  storageBucket?: string;
  messagingSenderId?: string;
  measurementId?: string;
  oAuthClientId?: string;
}

export const PRODUCTION_FIREBASE_PROJECT_ID = 'galvanic-aviary-tzp2g';
export const PRODUCTION_FIREBASE_DATABASE_ID =
  'ai-studio-barcouncilmcqpre-9a5aecc8-3819-4aeb-b7e2-c6066b637cab';
export const OWNER_ADMIN_UID = 'PjBRV7LAQ8cIwOdM3z474A16dWg2';
export const OWNER_ADMIN_EMAIL = 'khayrulalam88@gmail.com';

// Support environment variables with strict production/staging isolation
const env =
  typeof import.meta !== 'undefined' && import.meta.env
    ? (import.meta.env as Record<string, string | undefined>)
    : ({} as Record<string, string | undefined>);

export function isFrontendStagingEnvironment(
  rawEnv: Record<string, string | undefined> = env
): boolean {
  const mode = (rawEnv.VITE_ENVIRONMENT || '').trim().toLowerCase();
  return mode === 'staging';
}

export function resolveFrontendFirebaseConfig(
  rawEnv: Record<string, string | undefined> = env,
  fallbackConfig: typeof firebaseConfigJson = firebaseConfigJson
): FirebaseConfig {
  const isStaging = isFrontendStagingEnvironment(rawEnv);
  const envProjectId = rawEnv.VITE_FIREBASE_PROJECT_ID?.trim() || '';
  const envDatabaseId = rawEnv.VITE_FIREBASE_DATABASE_ID?.trim() || '';

  if (!isStaging) {
    if (envProjectId && envProjectId !== PRODUCTION_FIREBASE_PROJECT_ID) {
      throw new Error(
        `Configured VITE_FIREBASE_PROJECT_ID "${envProjectId}" is rejected in production mode.`
      );
    }

    if (
      envDatabaseId &&
      envDatabaseId !== PRODUCTION_FIREBASE_DATABASE_ID &&
      envDatabaseId !== PRODUCTION_FIREBASE_PROJECT_ID &&
      envDatabaseId !== fallbackConfig.projectId
    ) {
      throw new Error(
        `Configured VITE_FIREBASE_DATABASE_ID "${envDatabaseId}" does not match production database "${PRODUCTION_FIREBASE_DATABASE_ID}".`
      );
    }

    return {
      projectId: PRODUCTION_FIREBASE_PROJECT_ID,
      appId: rawEnv.VITE_FIREBASE_APP_ID || fallbackConfig.appId,
      apiKey: rawEnv.VITE_FIREBASE_API_KEY || fallbackConfig.apiKey,
      authDomain: rawEnv.VITE_FIREBASE_AUTH_DOMAIN || fallbackConfig.authDomain,
      firestoreDatabaseId: PRODUCTION_FIREBASE_DATABASE_ID,
      storageBucket: rawEnv.VITE_FIREBASE_STORAGE_BUCKET || fallbackConfig.storageBucket,
      messagingSenderId:
        rawEnv.VITE_FIREBASE_MESSAGING_SENDER_ID || fallbackConfig.messagingSenderId,
      measurementId: rawEnv.VITE_FIREBASE_MEASUREMENT_ID || fallbackConfig.measurementId || '',
      oAuthClientId: rawEnv.VITE_FIREBASE_OAUTH_CLIENT_ID || fallbackConfig.oAuthClientId || ''
    };
  }

  // Staging mode: NEVER fall back to production projectId or production named Firestore databaseId
  if (!envProjectId) {
    throw new Error('Staging build requires explicit VITE_FIREBASE_PROJECT_ID.');
  }
  if (envProjectId === PRODUCTION_FIREBASE_PROJECT_ID) {
    throw new Error('Staging build cannot target production Firebase project.');
  }
  if (envDatabaseId === PRODUCTION_FIREBASE_DATABASE_ID || envDatabaseId === PRODUCTION_FIREBASE_PROJECT_ID) {
    throw new Error(
      'Staging build cannot fall back to or target the production named Firestore database.'
    );
  }

  const resolvedDatabaseId =
    envDatabaseId && envDatabaseId !== envProjectId ? envDatabaseId : '(default)';

  return {
    projectId: envProjectId,
    appId: rawEnv.VITE_FIREBASE_APP_ID?.trim() || '',
    apiKey: rawEnv.VITE_FIREBASE_API_KEY?.trim() || '',
    authDomain: rawEnv.VITE_FIREBASE_AUTH_DOMAIN?.trim() || `${envProjectId}.firebaseapp.com`,
    firestoreDatabaseId: resolvedDatabaseId,
    storageBucket: rawEnv.VITE_FIREBASE_STORAGE_BUCKET?.trim() || `${envProjectId}.firebasestorage.app`,
    messagingSenderId: rawEnv.VITE_FIREBASE_MESSAGING_SENDER_ID?.trim() || '',
    measurementId: rawEnv.VITE_FIREBASE_MEASUREMENT_ID?.trim() || '',
    oAuthClientId: rawEnv.VITE_FIREBASE_OAUTH_CLIENT_ID?.trim() || ''
  };
}

export function resolveFrontendOwnerAdminUid(
  rawEnv: Record<string, string | undefined> = env
): string {
  if (!isFrontendStagingEnvironment(rawEnv)) {
    return OWNER_ADMIN_UID;
  }
  const rawStagingUid = rawEnv.VITE_STAGING_OWNER_ADMIN_UID?.trim() || '';
  if (!rawStagingUid) {
    return '';
  }
  if (/[\s,;|]/.test(rawStagingUid) || rawStagingUid.length > 128) {
    return '';
  }
  return rawStagingUid;
}

let resolvedConfig: FirebaseConfig = {
  projectId: '',
  appId: '',
  apiKey: '',
  authDomain: '',
  firestoreDatabaseId: '',
  storageBucket: '',
  messagingSenderId: '',
  measurementId: '',
  oAuthClientId: ''
};

let appInstance: FirebaseApp;
let authInstance: Auth;
let firestoreInstance: Firestore;
let isInitializedSuccessfully = false;
let initError: string | null = null;

try {
  resolvedConfig = resolveFrontendFirebaseConfig(env, firebaseConfigJson);

  if (!getApps().length) {
    appInstance = initializeApp(resolvedConfig);
  } else {
    appInstance = getApp();
  }

  authInstance = getAuth(appInstance);

  if (resolvedConfig.firestoreDatabaseId && resolvedConfig.firestoreDatabaseId !== '(default)') {
    firestoreInstance = getFirestore(appInstance, resolvedConfig.firestoreDatabaseId);
  } else {
    firestoreInstance = getFirestore(appInstance);
  }

  isInitializedSuccessfully = true;
} catch (err: any) {
  console.error('Firebase initialization error:', err);
  initError = err?.message || 'Failed to initialize Firebase';
  isInitializedSuccessfully = false;
}

export const firebaseConfig: FirebaseConfig = resolvedConfig;

export function isVerifiedOwnerAccount(
  user?: { uid?: string | null; email?: string | null; emailVerified?: boolean | null } | null,
  rawEnvOverride?: Record<string, string | undefined>
): boolean {
  if (!user || !user.uid || !user.email) return false;
  const effectiveOwnerUid = resolveFrontendOwnerAdminUid(rawEnvOverride ?? env);
  if (!effectiveOwnerUid || user.uid !== effectiveOwnerUid) return false;
  if (user.email.toLowerCase().trim() !== OWNER_ADMIN_EMAIL) return false;
  if (user.emailVerified !== true) return false;
  return true;
}

export const app = appInstance!;
export const auth = authInstance!;
export const db = firestoreInstance!;
export const googleProvider = new GoogleAuthProvider();
export const isFirebaseConnected = () => isInitializedSuccessfully;
export const getFirebaseInitError = () => initError;
export const getFirebaseProjectDetails = () => ({
  projectId: firebaseConfig.projectId,
  databaseId: firebaseConfig.firestoreDatabaseId || '(default)',
  appId: firebaseConfig.appId,
  isInitialized: isInitializedSuccessfully
});
