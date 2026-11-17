# Sanad Prep BD — Firebase Spark Staging Project Provisioning Guide (Phase 5C)

This guide covers preparing the **isolated Firebase Spark (Free) staging project** `sanad-prep-bd-staging`.

**Strict Isolation Guarantees:**
- **Production Project (`galvanic-aviary-tzp2g`) & Named DB (`ai-studio-barcouncilmcqpre-9a5aecc8-3819-4aeb-b7e2-c6066b637cab`)** are **never** touched, modified, or linked.
- **No Google Cloud Billing** is required or enabled (`Spark` plan only).
- **No Production data** (students, payments, subscriptions, questions, results) is copied.
- **No service account keys, Cloudflare secrets, remote D1 provisioning, or deployments** are performed in this phase.

---

## Step 1 — Create `sanad-prep-bd-staging` on the Spark (Free) Plan

1. Open [https://console.firebase.google.com/](https://console.firebase.google.com/) while signed in as `khayrulalam88@gmail.com`.
2. Click **Create a project** (or **Add project**).
3. Enter Project name: **`sanad-prep-bd-staging`**.
4. Verify the **Project ID** beneath the input box is **`sanad-prep-bd-staging`** (click the small pencil icon if Firebase appends a suffix; if `sanad-prep-bd-staging` is already globally taken, pick a unique lowercase hyphenated ID such as `sanad-prep-bd-staging-bd` and update all staging templates consistently).
5. **Do NOT link a Google Cloud Billing account** — stay on the **Spark (No-cost)** plan.
6. Click **Continue**.
7. On the **Google Analytics** step, toggle **Enable Google Analytics for this project** to **OFF** (avoids creating extra Analytics/Cloud resources).
8. Click **Create project**, wait for provisioning, then click **Continue**.

---

## Step 2 — Register the Staging Web App & Populate the Staging Config Template

1. In the left sidebar of `sanad-prep-bd-staging`, click the **Gear icon** next to **Project Overview** -> **Project settings**.
2. Stay on the **General** tab and scroll down to **Your apps**.
3. Click the **Web (`</>`)** icon.
4. Enter App nickname: **`Sanad Prep BD Staging Web`**.
5. Leave **Also set up Firebase Hosting** **unchecked**.
6. Click **Register app**.
7. Copy the generated `firebaseConfig` fields (`apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId`, `appId`) into:
   - `firebase-staging-config.example.json` (or your local staging copy), and
   - your local `.env.staging` (copied from `.env.staging.example`).
8. Click **Continue to console**.

---

## Step 3 — Configure Staging Firebase Authentication

1. In the left sidebar, click **Build** -> **Authentication** -> **Get started**.
2. Open the **Sign-in method** tab and enable:
   - **Email/Password**:
     - Click **Email/Password** -> toggle **Enable** to **ON**.
     - Keep **Email link (passwordless sign-in)** **OFF** unless explicitly needed.
     - Click **Save**.
   - **Google**:
     - Click **Add new provider** -> **Google** -> toggle **Enable** to **ON**.
     - Set **Project support email** to `khayrulalam88@gmail.com`.
     - Click **Save**. (Copy the generated Web SDK OAuth Client ID from the **Web SDK configuration** accordion if using `VITE_FIREBASE_OAUTH_CLIENT_ID`).
3. Open the **Settings** tab inside **Authentication**:
   - Click **Authorized domains** -> **Add domain**:
     - Add **`s--khayrul-alam-worker-staging.khayrulalam88.workers.dev`**
     - Verify `localhost` and `sanad-prep-bd-staging.firebaseapp.com` are present (do **NOT** add the production domain).
   - Click **User actions**:
     - Verify **Email enumeration protection** is enabled if desired (compatible with our auth flow).
4. Open the **Templates** tab inside **Authentication** (optional):
   - Confirm **Email address verification** template is active (both Worker and Firestore rules enforce `email_verified == true`).

---

## Step 4 — Create the Separate Staging Firestore Database (`(default)` on Spark Plan)

> Under the Firebase **Spark (Free)** plan, each project supports **one** Firestore database: the **`(default)`** database. Phase 5B explicitly permits `"(default)"` **only** when `ENVIRONMENT === "staging"` and `projectId !== "galvanic-aviary-tzp2g"`.

1. In the left sidebar of `sanad-prep-bd-staging`, click **Build** -> **Firestore Database**.
2. Click **Create database**.
3. Keep the database ID as **`(default)`** (Standard edition, free Spark tier).
4. Select location: **`asia-south1 (Mumbai)`** or **`asia-southeast1 (Singapore)`** (closest low-latency region for Bangladesh; note that location cannot be changed later).
5. Click **Next**.
6. On the **Configure security rules** step, select **Start in production mode** (denies all client reads/writes until staging rules are published).
7. Click **Create**.

---

## Step 5 — Apply Staging Firestore Security Rules (`firestore.staging.rules`)

**Do NOT modify `/firestore.rules` (production) and do NOT run `firebase deploy` against `galvanic-aviary-tzp2g`.**

1. Create your staging Owner Admin account first (Step 6 below) so you have the exact `STAGING_OWNER_UID`.
2. Open `firestore.staging.rules` in this repo and replace `REPLACE_WITH_STAGING_OWNER_UID` with the staging Owner UID from Step 6.
   - Verify line 36 still guards `request.auth.uid != 'PjBRV7LAQ8cIwOdM3z474A16dWg2'`.
3. In Firebase Console for **`sanad-prep-bd-staging`**:
   - Go to **Build** -> **Firestore Database** -> **Rules** tab.
   - Paste the updated contents of `firestore.staging.rules`.
   - Click **Publish**.
4. Confirm in the top project switcher that the active project is **`sanad-prep-bd-staging`** (never `galvanic-aviary-tzp2g`) before clicking **Publish**.

---

## Step 6 — Create the Separate Staging Owner Admin Account & Obtain Its UID

Because `sanad-prep-bd-staging` has a completely separate Firebase Authentication tenant, creating a user there generates a **brand-new UID** isolated from Production (`PjBRV7LAQ8cIwOdM3z474A16dWg2`).

1. In Firebase Console for **`sanad-prep-bd-staging`**, go to **Build** -> **Authentication** -> **Users** tab.
2. **Option A (Console creation + email verification link via app sign-in):**
   - Click **Add user**.
   - Email: **`khayrulalam88@gmail.com`** (required because Phase 5B Worker `isOwnerUser` and `firestore.staging.rules` `isOwnerAccount()` enforce `email == 'khayrulalam88@gmail.com'` + `email_verified === true`).
   - Password: set a **new staging-only password** (never reuse your production password).
   - Click **Add user**.
   - Note: Users created via **Add user** start with `emailVerified: false` until verified via Google Sign-In or an email verification link triggered on first sign-in from the staging app.
3. **Option B (Recommended — Google Sign-In on staging app):**
   - Once the staging frontend is running in a later phase, sign in with Google using `khayrulalam88@gmail.com` (`emailVerified` is automatically `true`).
4. In **Authentication** -> **Users**, locate the row for `khayrulalam88@gmail.com` and click the **Copy UID** icon in the **User UID** column.
5. Verify the copied UID is **strictly different** from the Production Owner UID:
   - Production Owner UID: `PjBRV7LAQ8cIwOdM3z474A16dWg2`
   - Staging Owner UID: `<your-new-uid-from-sanad-prep-bd-staging>` (must NOT equal `PjBRV7LAQ8cIwOdM3z474A16dWg2`)
6. Place the new Staging Owner UID into:
   - `firestore.staging.rules` (`isOwnerAccount()`)
   - `worker/wrangler.jsonc` (`vars.STAGING_OWNER_ADMIN_UID`)
   - your local `.env.staging` (`VITE_STAGING_OWNER_ADMIN_UID` and `STAGING_OWNER_ADMIN_UID`)

---

## Step 7 — Phase 5B Code Compatibility Verification

| Setting | Phase 5B Worker Requirement | Phase 5B Frontend (`src/lib/firebase.ts`) | Phase 5C Staging Template | Match |
|---|---|---|---|---|
| Environment flag | `ENVIRONMENT = "staging"` | `VITE_ENVIRONMENT = "staging"` | `"staging"` | Yes |
| Firebase Project ID | `FIREBASE_PROJECT_ID = "sanad-prep-bd-staging"` | `VITE_FIREBASE_PROJECT_ID = "sanad-prep-bd-staging"` | `"sanad-prep-bd-staging"` | Yes |
| Firestore Database ID | `FIREBASE_DATABASE_ID = "(default)"` | `VITE_FIREBASE_DATABASE_ID = "(default)"` | `"(default)"` | Yes |
| Staging Owner UID | `STAGING_OWNER_ADMIN_UID` (single non-empty UID, no separators) | `VITE_STAGING_OWNER_ADMIN_UID` (single non-empty UID) | `REPLACE_WITH_STAGING_OWNER_UID` | Yes |
| Owner Email & Verification | `khayrulalam88@gmail.com` + `emailVerified === true` | `khayrulalam88@gmail.com` + `emailVerified === true` | Enforced in `firestore.staging.rules` & Auth setup | Yes |
| Production DB isolation | Rejects pairing staging project with `ai-studio-barcouncilmcqpre-...` | Rejects `VITE_FIREBASE_DATABASE_ID === ai-studio-barcouncilmcqpre-...` | Uses `(default)` only | Yes |

### Important Frontend UI Follow-Up Noted Before Staging Frontend Build
Phase 5B scoped changes strictly to `worker/types.ts`, `worker/firebaseAuth.ts`, `worker/firestoreRest.ts`, and `src/lib/firebase.ts`. During Phase 5C verification, 5 direct comparisons against `OWNER_ADMIN_UID` were observed outside `src/lib/firebase.ts`:
- `src/components/AdminPanel.tsx:552` (`currentUser.uid === OWNER_ADMIN_UID`)
- `src/components/AdminPanel.tsx:1445` (`sub.userId === OWNER_ADMIN_UID`)
- `src/components/LoginModal.tsx:286` (`currentUser.uid === OWNER_ADMIN_UID`)
- `src/components/EditUserModal.tsx:291` (`user.userId === OWNER_ADMIN_UID`)
- `src/context/AppContext.tsx:2657` (`params.userId !== OWNER_ADMIN_UID`)

When ready to build the staging frontend with a **distinct** `VITE_STAGING_OWNER_ADMIN_UID`, update those 5 checks to use `resolveFrontendOwnerAdminUid()` from `src/lib/firebase.ts` so the staging Owner Admin UI matches `isVerifiedOwnerAccount()` and the Worker APIs. (Production behavior remains unchanged.)
