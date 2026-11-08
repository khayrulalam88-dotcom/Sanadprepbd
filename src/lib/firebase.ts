import { initializeApp, getApps, getApp, FirebaseApp } from 'firebase/app';
import { getAuth, Auth } from 'firebase/auth';
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

// Support environment variables with seamless fallback to firebase-applet-config.json
const env = typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env : {} as Record<string, string | undefined>;

export const firebaseConfig: FirebaseConfig = {
  projectId: env.VITE_FIREBASE_PROJECT_ID || firebaseConfigJson.projectId,
  appId: env.VITE_FIREBASE_APP_ID || firebaseConfigJson.appId,
  apiKey: env.VITE_FIREBASE_API_KEY || firebaseConfigJson.apiKey,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || firebaseConfigJson.authDomain,
  firestoreDatabaseId: env.VITE_FIREBASE_DATABASE_ID || firebaseConfigJson.firestoreDatabaseId,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET || firebaseConfigJson.storageBucket,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || firebaseConfigJson.messagingSenderId,
  measurementId: env.VITE_FIREBASE_MEASUREMENT_ID || firebaseConfigJson.measurementId || '',
  oAuthClientId: env.VITE_FIREBASE_OAUTH_CLIENT_ID || firebaseConfigJson.oAuthClientId || '',
};

let appInstance: FirebaseApp;
let authInstance: Auth;
let firestoreInstance: Firestore;
let isInitializedSuccessfully = false;
let initError: string | null = null;

try {
  if (!getApps().length) {
    appInstance = initializeApp(firebaseConfig);
  } else {
    appInstance = getApp();
  }

  authInstance = getAuth(appInstance);

  if (firebaseConfig.firestoreDatabaseId && firebaseConfig.firestoreDatabaseId !== '(default)') {
    firestoreInstance = getFirestore(appInstance, firebaseConfig.firestoreDatabaseId);
  } else {
    firestoreInstance = getFirestore(appInstance);
  }

  isInitializedSuccessfully = true;
} catch (err: any) {
  console.error('Firebase initialization error:', err);
  initError = err?.message || 'Failed to initialize Firebase';
  isInitializedSuccessfully = false;
}

export const app = appInstance!;
export const auth = authInstance!;
export const db = firestoreInstance!;
export const isFirebaseConnected = () => isInitializedSuccessfully;
export const getFirebaseInitError = () => initError;
export const getFirebaseProjectDetails = () => ({
  projectId: firebaseConfig.projectId,
  databaseId: firebaseConfig.firestoreDatabaseId || '(default)',
  appId: firebaseConfig.appId,
  isInitialized: isInitializedSuccessfully
});
