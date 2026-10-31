package com.barprepbd.app.data.repository

import android.content.Context
import android.content.SharedPreferences
import com.barprepbd.app.BarPrepApp
import com.barprepbd.app.data.api.ApiClient
import com.barprepbd.app.data.model.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.UUID

class BarPrepRepository private constructor(context: Context) {

    private val prefs: SharedPreferences =
        context.getSharedPreferences("barprep_prefs", Context.MODE_PRIVATE)

    companion object {
        @Volatile
        private var instance: BarPrepRepository? = null

        fun getInstance(): BarPrepRepository {
            return instance ?: synchronized(this) {
                instance ?: BarPrepRepository(BarPrepApp.instance).also { instance = it }
            }
        }
    }

    // Session Management
    fun getSavedUserId(): String? = prefs.getString("user_id", "demo-student-1")
    fun getSavedUserName(): String = prefs.getString("user_name", "Farhan Ahmed") ?: "Farhan Ahmed"
    fun getSavedUserEmail(): String = prefs.getString("user_email", "student@barprep.bd") ?: "student@barprep.bd"
    fun getSavedSessionId(): String? = prefs.getString("session_id", null)

    fun saveUserSession(userId: String, name: String, email: String, sessionId: String) {
        prefs.edit()
            .putString("user_id", userId)
            .putString("user_name", name)
            .putString("user_email", email)
            .putString("session_id", sessionId)
            .apply()

        ApiClient.setAuthToken(userId, sessionId)
    }

    fun clearSession() {
        prefs.edit().clear().apply()
        ApiClient.setAuthToken(null, null)
    }

    // API calls with Coroutines
    suspend fun fetchSubjects(): Result<List<Subject>> = withContext(Dispatchers.IO) {
        try {
            val response = ApiClient.service.getSubjects()
            if (response.isSuccessful && response.body() != null) {
                Result.success(response.body()!!)
            } else {
                Result.failure(Exception("Failed to fetch subjects: ${response.code()}"))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    suspend fun fetchExams(): Result<List<Exam>> = withContext(Dispatchers.IO) {
        try {
            val response = ApiClient.service.getExams()
            if (response.isSuccessful && response.body() != null) {
                Result.success(response.body()!!)
            } else {
                Result.failure(Exception("Failed to fetch exams: ${response.code()}"))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    suspend fun fetchQuestions(subjectId: String? = null, examId: String? = null): Result<List<Question>> =
        withContext(Dispatchers.IO) {
            try {
                val response = ApiClient.service.getQuestions(subjectId, examId)
                if (response.isSuccessful && response.body() != null) {
                    Result.success(response.body()!!)
                } else {
                    Result.failure(Exception("Failed to fetch questions: ${response.code()}"))
                }
            } catch (e: Exception) {
                Result.failure(e)
            }
        }

    suspend fun fetchPackages(): Result<List<SubscriptionPackage>> = withContext(Dispatchers.IO) {
        try {
            val response = ApiClient.service.getPackages()
            if (response.isSuccessful && response.body() != null) {
                Result.success(response.body()!!)
            } else {
                Result.failure(Exception("Failed to fetch packages: ${response.code()}"))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    suspend fun fetchExamConfig(): Result<ExamDateConfig> = withContext(Dispatchers.IO) {
        try {
            val response = ApiClient.service.getExamConfig()
            if (response.isSuccessful && response.body() != null) {
                Result.success(response.body()!!)
            } else {
                Result.failure(Exception("Failed to fetch exam config: ${response.code()}"))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    suspend fun fetchPaymentSettings(): Result<PaymentSettingsResponse> = withContext(Dispatchers.IO) {
        try {
            val response = ApiClient.service.getPaymentSettings()
            if (response.isSuccessful && response.body() != null) {
                Result.success(response.body()!!)
            } else {
                Result.failure(Exception("Failed to fetch payment settings: ${response.code()}"))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    suspend fun startExamAttempt(examId: String, userId: String): Result<ExamAttempt> =
        withContext(Dispatchers.IO) {
            try {
                val response = ApiClient.service.startExam(ExamStartRequest(examId, userId))
                if (response.isSuccessful && response.body() != null) {
                    Result.success(response.body()!!)
                } else {
                    Result.failure(Exception("Failed to start exam: ${response.code()}"))
                }
            } catch (e: Exception) {
                Result.failure(e)
            }
        }

    suspend fun submitExam(
        attemptId: String,
        examId: String,
        userId: String,
        answers: Map<String, Int>,
        timeSpentSeconds: Int
    ): Result<ExamResult> = withContext(Dispatchers.IO) {
        try {
            val response = ApiClient.service.submitExam(
                ExamSubmitRequest(
                    attemptId = attemptId,
                    examId = examId,
                    userId = userId,
                    answers = answers,
                    timeSpentSeconds = timeSpentSeconds
                )
            )
            if (response.isSuccessful && response.body() != null) {
                Result.success(response.body()!!)
            } else {
                Result.failure(Exception("Failed to submit exam: ${response.code()}"))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    suspend fun fetchUserResults(userId: String): Result<List<ExamResult>> = withContext(Dispatchers.IO) {
        try {
            val response = ApiClient.service.getUserResults(userId)
            if (response.isSuccessful && response.body() != null) {
                Result.success(response.body()!!)
            } else {
                Result.failure(Exception("Failed to fetch results: ${response.code()}"))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    suspend fun submitPayment(
        userId: String,
        userName: String,
        userEmail: String,
        packageId: String,
        packageName: String,
        amount: Int,
        method: String,
        senderNumber: String,
        trxId: String
    ): Result<PaymentSubmitResponse> = withContext(Dispatchers.IO) {
        try {
            val response = ApiClient.service.submitPayment(
                PaymentSubmitRequest(
                    userId = userId,
                    userName = userName,
                    userEmail = userEmail,
                    packageId = packageId,
                    packageName = packageName,
                    amount = amount,
                    method = method,
                    senderNumber = senderNumber,
                    trxId = trxId
                )
            )
            if (response.isSuccessful && response.body() != null) {
                Result.success(response.body()!!)
            } else {
                Result.failure(Exception("Failed to submit payment: ${response.code()}"))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    suspend fun checkSessionActive(userId: String, sessionId: String): Result<Boolean> =
        withContext(Dispatchers.IO) {
            try {
                val response = ApiClient.service.validateSession(
                    SessionCheckRequest(userId = userId, sessionId = sessionId)
                )
                if (response.isSuccessful && response.body() != null) {
                    Result.success(response.body()!!.valid)
                } else {
                    Result.failure(Exception("Session check failed: ${response.code()}"))
                }
            } catch (e: Exception) {
                Result.failure(e)
            }
        }
}
