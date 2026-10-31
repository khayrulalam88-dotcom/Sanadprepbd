package com.barprepbd.app.data.api

import com.barprepbd.app.data.model.*
import retrofit2.Response
import retrofit2.http.*

data class PackagesResponse(val packages: List<SubscriptionPackage>)
data class ExamConfigResponse(val examDateConfig: ExamDateConfig)
data class PaymentSettingsResponse(val paymentSettings: Map<String, Any>)
data class SubjectsResponse(val subjects: List<Subject>)
data class ExamsResponse(val exams: List<Exam>)
data class QuestionsResponse(val questions: List<Question>)
data class ResultsResponse(val results: List<ExamResult>)

data class SessionRequest(
    val userId: String,
    val userEmail: String,
    val userName: String,
    val deviceInfo: String
)

data class SessionResponse(
    val success: Boolean,
    val sessionId: String,
    val session: StudentSession,
    val activeSubscription: UserSubscription?
)

data class CreatePaymentBody(
    val method: String,
    val senderNumber: String,
    val transactionId: String,
    val amount: Int,
    val packageId: String,
    val studentPhone: String? = null
)

data class StartExamBody(
    val examId: String,
    val userId: String,
    val studentName: String
)

data class SubmitExamBody(
    val attemptId: String,
    val answers: Map<String, Int>
)

data class StartExamResponse(
    val success: Boolean,
    val attempt: ExamAttempt,
    val durationMinutes: Int,
    val deadlineTime: String
)

data class SubmitExamResponse(
    val success: Boolean,
    val result: ExamResult
)

interface BarPrepApiService {

    @GET("/api/packages")
    suspend fun getPackages(): Response<PackagesResponse>

    @GET("/api/exam-config")
    suspend fun getExamConfig(): Response<ExamConfigResponse>

    @GET("/api/subjects")
    suspend fun getSubjects(): Response<SubjectsResponse>

    @GET("/api/exams")
    suspend fun getExams(): Response<ExamsResponse>

    @GET("/api/questions")
    suspend fun getQuestions(
        @Query("subjectId") subjectId: String? = null,
        @Query("examId") examId: String? = null
    ): Response<QuestionsResponse>

    @POST("/api/auth/session")
    suspend fun createSession(
        @Body body: SessionRequest
    ): Response<SessionResponse>

    @GET("/api/auth/session/status")
    suspend fun getSessionStatus(
        @Header("Authorization") token: String
    ): Response<Map<String, Any>>

    @POST("/api/payments/create")
    suspend fun createPayment(
        @Header("Authorization") token: String,
        @Body body: CreatePaymentBody
    ): Response<Map<String, Any>>

    @POST("/api/exams/start")
    suspend fun startExam(
        @Header("Authorization") token: String,
        @Body body: StartExamBody
    ): Response<StartExamResponse>

    @POST("/api/exams/submit")
    suspend fun submitExam(
        @Header("Authorization") token: String,
        @Body body: SubmitExamBody
    ): Response<SubmitExamResponse>

    @GET("/api/exams/results/{userId}")
    suspend fun getResults(
        @Path("userId") userId: String
    ): Response<ResultsResponse>
}
