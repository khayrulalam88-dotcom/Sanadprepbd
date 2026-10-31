package com.barprepbd.app.data.model

import com.google.gson.annotations.SerializedName

data class UserProfile(
    val uid: String = "",
    val name: String = "",
    val email: String = "",
    val phone: String = "",
    val role: String = "student", // "student", "question_manager", "admin"
    val subscriptionStatus: String = "free", // "free", "pro", "expired"
    val subscriptionExpiresAt: String? = null,
    val activePackageId: String? = null,
    val activePackageNameBn: String? = null,
    val activePackageNameEn: String? = null,
    val currentSessionId: String? = null,
    val createdAt: String = ""
)

data class Subject(
    val id: String = "",
    val code: String = "",
    val nameBn: String = "",
    val nameEn: String = "",
    val marksWeight: Int = 0,
    val totalQuestions: Int = 0,
    val iconName: String = "",
    val color: String = "#102A43",
    val actTitle: String = ""
)

data class Question(
    val id: String = "",
    val subjectId: String = "",
    val questionBn: String = "",
    val questionEn: String = "",
    val optionsBn: List<String> = emptyList(),
    val optionsEn: List<String> = emptyList(),
    val correctOptionIndex: Int = 0,
    val explanationBn: String = "",
    val explanationEn: String = "",
    val legalReference: String? = null,
    val difficulty: String = "medium",
    val status: String = "published",
    val isDemoSample: Boolean = true
)

data class Exam(
    val id: String = "",
    val titleBn: String = "",
    val titleEn: String = "",
    val descriptionBn: String = "",
    val descriptionEn: String = "",
    val type: String = "full_mock", // "full_mock", "subject_test", "practice_quiz"
    val durationMinutes: Int = 60,
    val totalMarks: Int = 100,
    val passThresholdPercentage: Int = 50,
    val questionIds: List<String> = emptyList(),
    val isPaid: Boolean = false,
    val negativeMarkRatio: Double = 0.25,
    val positiveMarkRatio: Double = 1.0
)

data class ExamAttempt(
    val id: String = "",
    val examId: String = "",
    val userId: String = "",
    val sessionId: String? = null,
    val studentName: String = "",
    val startTime: String = "",
    val deadlineTime: String = "",
    val status: String = "in_progress", // "in_progress", "submitted", "timed_out"
    val answers: Map<String, Int> = emptyMap(),
    val flaggedQuestionIds: List<String> = emptyList(),
    val currentQuestionIndex: Int = 0,
    val lastSavedAt: String = ""
)

data class SubjectScore(
    val subjectNameBn: String = "",
    val subjectNameEn: String = "",
    val total: Int = 0,
    val correct: Int = 0,
    val incorrect: Int = 0,
    val unanswered: Int = 0,
    val score: Double = 0.0
)

data class ExamResult(
    val id: String = "",
    val attemptId: String = "",
    val examId: String = "",
    val examTitleBn: String = "",
    val examTitleEn: String = "",
    val examType: String = "full_mock",
    val userId: String = "",
    val studentName: String = "",
    val submittedAt: String = "",
    val timeSpentSeconds: Int = 0,
    val totalQuestions: Int = 100,
    val correctAnswersCount: Int = 0,
    val incorrectAnswersCount: Int = 0,
    val unansweredCount: Int = 0,
    val positiveMarks: Double = 0.0,
    val negativeMarks: Double = 0.0,
    val finalScore: Double = 0.0,
    val percentage: Double = 0.0,
    val passed: Boolean = false,
    val subjectWiseScores: Map<String, SubjectScore> = emptyMap(),
    val answers: Map<String, Int> = emptyMap(),
    val questions: List<Question> = emptyList()
)

data class SubscriptionPackage(
    val id: String = "",
    val nameBn: String = "",
    val nameEn: String = "",
    val taglineBn: String = "",
    val taglineEn: String = "",
    val price: Int = 0,
    val validityType: String = "days", // "days" or "exam_date"
    val durationDays: Int? = null,
    val accessLevel: String = "pro_mock",
    val featuresBn: List<String> = emptyList(),
    val featuresEn: List<String> = emptyList(),
    val popular: Boolean = false,
    val isActive: Boolean = true
)

data class ExamDateConfig(
    val targetExamDate: String = "2026-11-28T09:00:00+06:00",
    val timezone: String = "Asia/Dhaka",
    val examDatePolicy: String = "extend_all", // "extend_all" or "new_only"
    val examPassPrice: Int = 650,
    val examTitleBn: String = "বাংলাদেশ বার কাউন্সিল এনরোলমেন্ট এমসিকিউ পরীক্ষা",
    val examTitleEn: String = "Bangladesh Bar Council Enrollment MCQ Examination"
)

data class UserSubscription(
    val id: String = "",
    val userId: String = "",
    val studentName: String = "",
    val studentPhone: String = "",
    val packageId: String = "",
    val packageNameBn: String = "",
    val packageNameEn: String = "",
    val pricePaid: Int = 0,
    val paymentRequestId: String = "",
    val paymentMethod: String = "bKash",
    val transactionId: String = "",
    val activatedAt: String = "",
    val expiresAt: String = "",
    val validityType: String = "days",
    val status: String = "active" // "active", "expired", "cancelled"
)

data class PaymentRequest(
    val id: String = "",
    val userId: String = "",
    val studentName: String = "",
    val studentPhone: String = "",
    val method: String = "bKash",
    val senderNumber: String = "",
    val transactionId: String = "",
    val amount: Int = 0,
    val packageId: String = "",
    val packageNameBn: String = "",
    val packageNameEn: String = "",
    val packageTitle: String = "",
    val durationDays: Int = 90,
    val validityType: String = "days",
    val status: String = "pending", // "pending", "approved", "rejected"
    val rejectionReason: String? = null,
    val requestedAt: String = "",
    val verifiedAt: String? = null,
    val verifiedBy: String? = null
)

data class StudentSession(
    val sessionId: String = "",
    val userId: String = "",
    val userEmail: String = "",
    val userName: String = "",
    val deviceInfo: String = "Android Device",
    val createdAt: String = "",
    val lastActiveAt: String = "",
    val status: String = "active", // "active", "revoked"
    val revokedReason: String? = null
)
