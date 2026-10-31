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

export const firebaseConfig: FirebaseConfig = firebaseConfigJson as FirebaseConfig;

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
