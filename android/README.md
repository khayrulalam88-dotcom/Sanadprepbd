# BarPrep BD – Native Android Application (Kotlin & Jetpack Compose)

This is the native Android application for **BarPrep BD** (Bangladesh Bar Council MCQ Exam Preparation), built with modern **Kotlin** and **Jetpack Compose**. It shares the exact same Firebase authentication, Cloud Firestore schema, and backend exam scoring engine as the web platform.

---

## 1. Architecture & Features

- **Framework**: Kotlin 1.9.22, Jetpack Compose (BOM 2024.02.01), Material 3.
- **Package Name**: `com.barprepbd.app`
- **Target SDK**: Android 14 (API 34), Min SDK: Android 7.0 (API 24).
- **Network Layer**: Retrofit 2 + OkHttp 4 communicating with BarPrep BD Express backend.
- **Single-Active-Session Enforcement**: Polling and header verification that terminates stale sessions when a candidate signs in from another device/browser.
- **Official Exam Engine**:
  - Full-length 100-mark mock tests.
  - Strict 60-minute countdown timer with auto-submit.
  - Official Bangladesh Bar Council scoring (+1.00 for correct, -0.25 negative marking deduction, 50.0 pass threshold).
  - Instant statutory citations (CPC 1908, CrPC 1898, Penal Code 1860, Evidence Act 1872, etc.) in English and Bangla.
- **Subscription Management**:
  - **Package A**: Pro Model Test Pass (৳300 / 90 days)
  - **Package B**: Long Course Pass (৳999 / 365 days)
  - **Package C**: Bar Council Exam Pass (Configurable price / Until official exam day)
- **Manual bKash & Nagad Verification**:
  - Dedicated copy buttons for bKash and Nagad payment number (`01712607777`).
  - Submission of TrxID, sender phone number, and package selection for administrator verification.

---

## 2. Project Directory Structure

```
android/
├── build.gradle.kts                   # Root build script (AGP 8.3.1, Google Services)
├── settings.gradle.kts                # Project & repository settings
├── gradle.properties                  # JVM & AndroidX build options
└── app/
    ├── build.gradle.kts               # Module build script & dependencies
    ├── proguard-rules.pro             # Proguard obfuscation rules
    ├── google-services.json.example   # Template Firebase configuration
    └── src/
        └── main/
            ├── AndroidManifest.xml    # App manifest with INTERNET permission
            ├── res/
            │   └── values/
            │       ├── colors.xml     # Primary Navy (#102A43), Gold (#D4AF37)
            │       ├── strings.xml    # App strings and payment numbers
            │       └── themes.xml     # Material 3 Theme
            └── java/com/barprepbd/app/
                ├── BarPrepApp.kt      # Application class
                ├── MainActivity.kt    # Root Compose Activity & Navigation
                ├── data/
                │   ├── api/
                │   │   ├── ApiClient.kt          # Retrofit / OkHttp client
                │   │   └── BarPrepApiService.kt  # Backend REST endpoints
                │   ├── model/
                │   │   └── Models.kt             # Data classes
                │   └── repository/
                │       └── BarPrepRepository.kt  # Central data & session repo
                └── ui/
                    ├── theme/                    # Color, Type, Theme
                    ├── components/
                    │   ├── BarPrepLogo.kt        # Official Logo Composable
                    │   ├── SubscriptionCard.kt   # Package cards
                    │   ├── PaymentDialog.kt      # bKash / Nagad dialog
                    │   └── SessionRevokedDialog.kt # Single session dialog
                    ├── screens/
                    │   ├── DashboardScreen.kt    # Overview & Mock Tests
                    │   ├── ExamScreen.kt         # Timed Exam with Palette
                    │   ├── ResultScreen.kt       # Score & Statutory review
                    │   ├── PracticeScreen.kt     # Subject-wise practice
                    │   ├── SubscriptionScreen.kt # Plan comparison
                    │   └── HistoryScreen.kt      # Attempt records
                    └── viewmodel/
                        └── BarPrepViewModel.kt   # State holder & timer
```

---

## 3. How to Run in Android Studio & Emulator

1. **Open in Android Studio**:
   - Launch Android Studio Hedgehog or newer.
   - Choose **File > Open** and select the `/android` directory.
   - Wait for Gradle sync to complete.

2. **Backend Connection**:
   - When running on the Android Emulator, the app connects to your local machine via `http://10.0.2.2:3000/`.
   - To connect to the live cloud URL, update `currentBaseUrl` in `ApiClient.kt` or use `ApiClient.setCustomBaseUrl("YOUR_CLOUD_URL")`.

3. **Run the App**:
   - Select an Android Virtual Device (AVD) running API 30+ (e.g. Pixel 7 with Android 14).
   - Click the green **Run (Shift+F10)** button in Android Studio.

---

## 4. Firebase Configuration Steps

To connect this Android app to your existing BarPrep BD Firebase project:

1. Open the [Firebase Console](https://console.firebase.google.com/).
2. Select your BarPrep BD Firebase project.
3. Click **Add App** and select **Android**.
4. Enter the package name: `com.barprepbd.app`.
5. Enter app nickname: `BarPrep BD Android`.
6. (Optional) Provide your debug SHA-1 signing certificate hash.
7. Download the `google-services.json` file.
8. Place `google-services.json` into `android/app/google-services.json` (replacing the example template).
9. Rebuild and launch the Android project.
