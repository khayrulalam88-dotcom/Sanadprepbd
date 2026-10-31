package com.barprepbd.app.ui.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.barprepbd.app.data.model.*
import com.barprepbd.app.data.repository.BarPrepRepository
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.*
import java.util.concurrent.TimeUnit

data class BarPrepUiState(
    val isLoading: Boolean = false,
    val errorMessage: String? = null,
    val userProfile: UserProfile? = null,
    val subjects: List<Subject> = emptyList(),
    val exams: List<Exam> = emptyList(),
    val packages: List<SubscriptionPackage> = emptyList(),
    val examConfig: ExamDateConfig? = null,
    val userResults: List<ExamResult> = emptyList(),
    
    // Active Exam Session State
    val activeExam: Exam? = null,
    val activeAttempt: ExamAttempt? = null,
    val examQuestions: List<Question> = emptyList(),
    val currentQuestionIndex: Int = 0,
    val userAnswers: Map<String, Int> = emptyMap(),
    val flaggedQuestionIds: Set<String> = emptySet(),
    val timeRemainingSeconds: Int = 3600, // 60 minutes
    val latestResult: ExamResult? = null,

    // Single active session
    val isSessionRevoked: Boolean = false,
    val paymentSuccessMessage: String? = null
)

class BarPrepViewModel : ViewModel() {

    private val repository = BarPrepRepository.getInstance()

    private val _uiState = MutableStateFlow(BarPrepUiState())
    val uiState: StateFlow<BarPrepUiState> = _uiState.asStateFlow()

    private var examTimerJob: Job? = null
    private var sessionPollerJob: Job? = null

    init {
        loadInitialData()
        startSessionPoller()
    }

    fun loadInitialData() {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true, errorMessage = null) }

            // Default logged-in user profile
            val defaultUser = UserProfile(
                uid = repository.getSavedUserId() ?: "demo-student-1",
                name = repository.getSavedUserName(),
                email = repository.getSavedUserEmail(),
                role = "student",
                isSubscribed = true,
                subscriptionPlan = "Package B: Long Course Pass",
                subscriptionExpiry = "2026-10-24T23:59:59.000Z",
                createdAt = "2025-01-01"
            )
            _uiState.update { it.copy(userProfile = defaultUser) }

            // Fetch remote data concurrently
            val subjectsResult = repository.fetchSubjects()
            val examsResult = repository.fetchExams()
            val packagesResult = repository.fetchPackages()
            val configResult = repository.fetchExamConfig()
            val resultsResult = repository.fetchUserResults(defaultUser.uid)

            _uiState.update { current ->
                current.copy(
                    isLoading = false,
                    subjects = subjectsResult.getOrDefault(getFallbackSubjects()),
                    exams = examsResult.getOrDefault(getFallbackExams()),
                    packages = packagesResult.getOrDefault(getFallbackPackages()),
                    examConfig = configResult.getOrDefault(
                        ExamDateConfig(
                            targetExamDate = "2026-12-18",
                            timezone = "Asia/Dhaka",
                            note = "Expected Bangladesh Bar Council Enrollment MCQ Examination"
                        )
                    ),
                    userResults = resultsResult.getOrDefault(emptyList())
                )
            }
        }
    }

    private fun startSessionPoller() {
        sessionPollerJob?.cancel()
        sessionPollerJob = viewModelScope.launch {
            while (true) {
                delay(30000) // check every 30s
                val userId = _uiState.value.userProfile?.uid ?: continue
                val sessionId = repository.getSavedSessionId() ?: continue
                val checkResult = repository.checkSessionActive(userId, sessionId)
                if (checkResult.isSuccess && checkResult.getOrNull() == false) {
                    _uiState.update { it.copy(isSessionRevoked = true) }
                }
            }
        }
    }

    fun startExam(exam: Exam) {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true) }
            val userId = _uiState.value.userProfile?.uid ?: "demo-student-1"
            val attemptResult = repository.startExamAttempt(exam.id, userId)
            val questionsResult = repository.fetchQuestions(examId = exam.id)

            val questions = questionsResult.getOrDefault(getFallbackQuestionsForExam(exam.id))
            val attempt = attemptResult.getOrNull() ?: ExamAttempt(
                id = "att_${UUID.randomUUID()}",
                examId = exam.id,
                userId = userId,
                startedAt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).format(Date()),
                status = "in_progress"
            )

            _uiState.update {
                it.copy(
                    isLoading = false,
                    activeExam = exam,
                    activeAttempt = attempt,
                    examQuestions = questions,
                    currentQuestionIndex = 0,
                    userAnswers = emptyMap(),
                    flaggedQuestionIds = emptySet(),
                    timeRemainingSeconds = exam.durationMinutes * 60,
                    latestResult = null
                )
            }

            startTimer(exam.durationMinutes * 60)
        }
    }

    private fun startTimer(totalSeconds: Int) {
        examTimerJob?.cancel()
        examTimerJob = viewModelScope.launch {
            var remaining = totalSeconds
            while (remaining > 0) {
                delay(1000)
                remaining--
                _uiState.update { it.copy(timeRemainingSeconds = remaining) }
            }
            // Auto submit when timer expires
            submitActiveExam()
        }
    }

    fun selectAnswer(questionId: String, optionIndex: Int) {
        _uiState.update { current ->
            val updated = current.userAnswers.toMutableMap()
            if (updated[questionId] == optionIndex) {
                updated.remove(questionId) // Deselect option
            } else {
                updated[questionId] = optionIndex
            }
            current.copy(userAnswers = updated)
        }
    }

    fun toggleFlagQuestion(questionId: String) {
        _uiState.update { current ->
            val updated = current.flaggedQuestionIds.toMutableSet()
            if (updated.contains(questionId)) {
                updated.remove(questionId)
            } else {
                updated.add(questionId)
            }
            current.copy(flaggedQuestionIds = updated)
        }
    }

    fun goToQuestion(index: Int) {
        if (index in 0 until _uiState.value.examQuestions.size) {
            _uiState.update { it.copy(currentQuestionIndex = index) }
        }
    }

    fun submitActiveExam() {
        examTimerJob?.cancel()
        val current = _uiState.value
        val exam = current.activeExam ?: return
        val attempt = current.activeAttempt ?: return
        val userId = current.userProfile?.uid ?: "demo-student-1"
        val timeSpent = (exam.durationMinutes * 60) - current.timeRemainingSeconds

        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true) }

            val submitResult = repository.submitExam(
                attemptId = attempt.id,
                examId = exam.id,
                userId = userId,
                answers = current.userAnswers,
                timeSpentSeconds = timeSpent
            )

            val result = submitResult.getOrElse {
                // Fallback local scoring (+1 for correct, -0.25 for incorrect)
                calculateLocalResult(exam, current.examQuestions, current.userAnswers, timeSpent, userId)
            }

            _uiState.update {
                it.copy(
                    isLoading = false,
                    activeExam = null,
                    activeAttempt = null,
                    latestResult = result,
                    userResults = listOf(result) + it.userResults
                )
            }
        }
    }

    private fun calculateLocalResult(
        exam: Exam,
        questions: List<Question>,
        answers: Map<String, Int>,
        timeSpentSeconds: Int,
        userId: String
    ): ExamResult {
        var correct = 0
        var wrong = 0
        val details = questions.map { q ->
            val selected = answers[q.id]
            val isCorr = selected != null && selected == q.correctOptionIndex
            if (selected != null) {
                if (isCorr) correct++ else wrong++
            }
            QuestionResultDetail(
                questionId = q.id,
                selectedOption = selected,
                correctOption = q.correctOptionIndex,
                isCorrect = isCorr,
                explanationEn = q.explanationEn,
                explanationBn = q.explanationBn,
                legalReference = q.legalReference
            )
        }
        val unattempted = questions.size - (correct + wrong)
        val negativeMarks = wrong * exam.negativeMarking
        val finalScore = (correct * 1.0) - negativeMarks
        val percentage = if (questions.isNotEmpty()) (finalScore / questions.size.toDouble()) * 100 else 0.0

        return ExamResult(
            id = "res_${UUID.randomUUID()}",
            attemptId = "att_${UUID.randomUUID()}",
            examId = exam.id,
            examTitle = exam.titleEn,
            userId = userId,
            score = Math.max(0.0, finalScore),
            totalMarks = questions.size,
            correctCount = correct,
            wrongCount = wrong,
            unattemptedCount = unattempted,
            negativeMarksDeducted = negativeMarks,
            percentage = Math.max(0.0, percentage),
            passed = finalScore >= exam.passingMarks,
            timeSpentSeconds = timeSpentSeconds,
            submittedAt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).format(Date()),
            questionDetails = details
        )
    }

    fun submitPayment(
        pkg: SubscriptionPackage,
        method: String,
        senderNumber: String,
        trxId: String,
        onComplete: (Boolean, String) -> Unit
    ) {
        val user = _uiState.value.userProfile ?: return
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true) }
            val res = repository.submitPayment(
                userId = user.uid,
                userName = user.name,
                userEmail = user.email,
                packageId = pkg.id,
                packageName = pkg.nameEn,
                amount = pkg.price,
                method = method,
                senderNumber = senderNumber,
                trxId = trxId
            )
            _uiState.update { it.copy(isLoading = false) }
            if (res.isSuccess) {
                val msg = res.getOrNull()?.message ?: "Payment verification submitted! Admin will verify shortly."
                _uiState.update { it.copy(paymentSuccessMessage = msg) }
                onComplete(true, msg)
            } else {
                onComplete(false, res.exceptionOrNull()?.message ?: "Payment submission failed")
            }
        }
    }

    fun dismissPaymentSuccess() {
        _uiState.update { it.copy(paymentSuccessMessage = null) }
    }

    fun resetSessionRevoked() {
        _uiState.update { it.copy(isSessionRevoked = false) }
        loadInitialData()
    }

    // Default Fallbacks matching BarPrep BD standard curriculum
    private fun getFallbackSubjects(): List<Subject> = listOf(
        Subject("sub_cpc", "Code of Civil Procedure, 1908", "দেওয়ানী কার্যবিধি, ১৯০৮", 20, 1),
        Subject("sub_crpc", "Code of Criminal Procedure, 1898", "ফৌজদারী কার্যবিধি, ১৮৯৮", 20, 2),
        Subject("sub_penal", "Penal Code, 1860", "দণ্ডবিধি, ১৮৬০", 20, 3),
        Subject("sub_evidence", "Evidence Act, 1872", "সাক্ষ্য আইন, ১৮৭২", 15, 4),
        Subject("sub_limitation", "Limitation Act, 1908", "তামাদি আইন, ১৯০৮", 10, 5),
        Subject("sub_sr", "Specific Relief Act, 1877", "সুনির্দিষ্ট প্রতিকার আইন, ১৮৭৭", 10, 6),
        Subject("sub_ethics", "Bar Council Canons of Professional Conduct", "বার কাউন্সিল অনুশাসন ও আচরণবিধি", 5, 7)
    )

    private fun getFallbackExams(): List<Exam> = listOf(
        Exam(
            id = "mock_test_1",
            titleEn = "Bar Council Full Mock Test 01",
            titleBn = "বার কাউন্সিল পূর্ণাঙ্গ মডেল টেস্ট ০১",
            durationMinutes = 60,
            totalMarks = 100,
            passingMarks = 50,
            negativeMarking = 0.25,
            isFullLength = true,
            isPremium = true
        ),
        Exam(
            id = "mock_test_2",
            titleEn = "Bar Council Full Mock Test 02",
            titleBn = "বার কাউন্সিল পূর্ণাঙ্গ মডেল টেস্ট ০২",
            durationMinutes = 60,
            totalMarks = 100,
            passingMarks = 50,
            negativeMarking = 0.25,
            isFullLength = true,
            isPremium = true
        ),
        Exam(
            id = "sub_test_crpc",
            titleEn = "Criminal Procedure (CrPC) Speed Test",
            titleBn = "ফৌজদারী কার্যবিধি স্পিড টেস্ট",
            durationMinutes = 20,
            totalMarks = 20,
            passingMarks = 10,
            negativeMarking = 0.25,
            isFullLength = false,
            subjectId = "sub_crpc",
            isPremium = false
        )
    )

    private fun getFallbackPackages(): List<SubscriptionPackage> = listOf(
        SubscriptionPackage(
            id = "package_a",
            nameEn = "Pro Model Test Pass",
            nameBn = "প্রো মডেল টেস্ট পাস",
            price = 300,
            validityDays = 90,
            description = "Ideal for final revision and timed full-length Bar Council exam simulation.",
            features = listOf(
                "Full-length 100-mark model tests",
                "Strict 60-minute exam timer",
                "Official -0.25 negative marking calculation",
                "Instant results with legal section references"
            ),
            isActive = true
        ),
        SubscriptionPackage(
            id = "package_b",
            nameEn = "Long Course Pass",
            nameBn = "লং কোর্স পাস",
            price = 999,
            validityDays = 365,
            description = "Complete 1-year access to all subjects, topic-wise practice, and mock tests.",
            features = listOf(
                "Subject-wise MCQ practice across all 7 Acts",
                "Full-length 100-mark model tests",
                "Comprehensive statutory explanations in Bangla & English",
                "All upcoming premium preparation materials"
            ),
            isActive = true
        ),
        SubscriptionPackage(
            id = "pkg_exam_pass",
            nameEn = "Bar Council Exam Pass",
            nameBn = "বার কাউন্সিল এক্সাম পাস",
            price = 699,
            validityDays = 0,
            description = "Valid until the official Bar Council enrollment examination day.",
            features = listOf(
                "Valid until official exam day (auto-extends if rescheduled)",
                "Full-length 100-mark mock tests with leaderboard",
                "Subject-wise practice across all 7 subjects",
                "Complete statutory citations (CPC, CrPC, Penal Code, Evidence Act)"
            ),
            isActive = true
        )
    )

    private fun getFallbackQuestionsForExam(examId: String): List<Question> = listOf(
        Question(
            id = "q_crpc_1",
            subjectId = "sub_crpc",
            textEn = "Under Section 154 of the Code of Criminal Procedure, 1898, every information relating to the commission of a cognizable offence shall be reduced into writing by or under the direction of:",
            textBn = "ফৌজদারী কার্যবিধি, ১৮৯৮-এর ১৫৪ ধারা অনুযায়ী আমলযোগ্য অপরাধ সংঘটন সংক্রান্ত প্রতিটি তথ্য কার দ্বারা বা কার নির্দেশে লিপিবদ্ধ করতে হবে?",
            options = listOf(
                "The Magistrate having jurisdiction",
                "The Officer-in-Charge of a police station",
                "The Public Prosecutor",
                "The Sessions Judge"
            ),
            correctOptionIndex = 1,
            explanationEn = "Section 154 of CrPC mandates that information relating to the commission of a cognizable offence given orally to an officer-in-charge of a police station shall be reduced to writing by him or under his direction.",
            explanationBn = "ফৌজদারী কার্যবিধির ১৫৪ ধারা মোতাবেক আমলযোগ্য অপরাধের সংবাদ থানার ভারপ্রাপ্ত কর্মকর্তা (OC) নিজে অথবা তার নির্দেশক্রমে লিখিত করবেন এবং সংবাদদাতাকে পড়ে শুনিয়ে স্বাক্ষর নেবেন।",
            legalReference = "Section 154, CrPC 1898"
        ),
        Question(
            id = "q_cpc_1",
            subjectId = "sub_cpc",
            textEn = "Under Section 10 of the Code of Civil Procedure, 1908, which doctrine prohibits the trial of any suit in which the matter in issue is directly and substantially in issue in a previously instituted suit?",
            textBn = "দেওয়ানী কার্যবিধি, ১৯০৮-এর ১০ ধারা অনুসারে কোন নীতি ইতিপূর্বে দায়েরকৃত বিচারাধীন মামলার কারণে পরবর্তী মামলা বিচার স্থগিত রাখে?",
            options = listOf(
                "Res Judicata",
                "Res Sub-Judice",
                "Estoppel",
                "Caveat Emptor"
            ),
            correctOptionIndex = 1,
            explanationEn = "Section 10 lays down the rule of Res Sub-Judice (Stay of Suit) to prevent courts of concurrent jurisdiction from adjudicating upon identical causes simultaneously.",
            explanationBn = "দেওয়ানী কার্যবিধির ১০ ধারা হলো সাব-জুডিস নীতি (বিচার স্থগিত রাখা), যার মাধ্যমে একই বিষয়ে বিচারাধীন পূর্ববর্তী মামলা থাকলে পরবর্তী মামলার বিচার স্থগিত রাখা হয়।",
            legalReference = "Section 10, CPC 1908"
        ),
        Question(
            id = "q_penal_1",
            subjectId = "sub_penal",
            textEn = "Under Section 300 of the Penal Code, 1860, how many exceptions are provided where culpable homicide does not amount to murder?",
            textBn = "দণ্ডবিধি, ১৮৬০-এর ৩০০ ধারায় কয়টি ব্যতিক্রম রয়েছে যেখানে অপরাধজনক নরহত্যাকে খুন বলে গণ্য করা হয় না?",
            options = listOf(
                "3 exceptions",
                "4 exceptions",
                "5 exceptions",
                "6 exceptions"
            ),
            correctOptionIndex = 2,
            explanationEn = "Section 300 of the Penal Code contains 5 distinct exceptions: grave & sudden provocation, right of private defence, public servant acting for the advancement of justice, sudden fight, and consent of adult victim.",
            explanationBn = "দণ্ডবিধির ৩০০ ধারায় ৫টি ব্যতিক্রম বর্ণিত আছে। এই ৫টি ব্যতিক্রমের যেকোনো একটির মধ্যে পড়লে অপরাধজনক নরহত্যা খুন বলে গণ্য হয় না, বরং দণ্ডবিধির ৩০৪ ধারায় শাস্তিযোগ্য হয়।",
            legalReference = "Section 300 (Exceptions 1 to 5), Penal Code 1860"
        ),
        Question(
            id = "q_evidence_1",
            subjectId = "sub_evidence",
            textEn = "According to Section 115 of the Evidence Act, 1872, what legal doctrine prevents a person from denying the truth of a declaration or act which caused another to believe and act upon it?",
            textBn = "সাক্ষ্য আইন, ১৮৭২-এর ১১৫ ধারা অনুযায়ী কোন আইনি নীতি দ্বারা কোনো ব্যক্তিকে তার পূর্ববর্তী ঘোষণার বিপরীত দাবি করতে বাধা দেয়?",
            options = listOf(
                "Doctrine of Promissory Estoppel",
                "Doctrine of Res Judicata",
                "Doctrine of Election",
                "Doctrine of Estoppel"
            ),
            correctOptionIndex = 3,
            explanationEn = "Section 115 of the Evidence Act embodies the rule of Estoppel: when one person has intentionally caused another to believe a thing to be true and to act upon such belief, neither he nor his representative shall deny the truth thereof.",
            explanationBn = "সাক্ষ্য আইনের ১১৫ ধারায় প্রতিবন্ধকতা (Estoppel) নীতি বর্ণিত। কেউ ইচ্ছাকৃতভাবে কোনো বিবৃতি বা কাজের দ্বারা অপরকে বিভ্রান্ত করে কোনো কাজ করালে পরবর্তীতে সেই বিবৃতির সত্যতা অস্বীকার করতে পারে না।",
            legalReference = "Section 115, Evidence Act 1872"
        ),
        Question(
            id = "q_limitation_1",
            subjectId = "sub_limitation",
            textEn = "Under Section 5 of the Limitation Act, 1908, extension of prescribed period on grounds of sufficient cause is applicable to:",
            textBn = "তামাদি আইন, ১৯০৮-এর ৫ ধারার অধীন উপযুক্ত কারণে সময় বর্ধিতকরণ প্রযোজ্য হয়:",
            options = listOf(
                "Suits and applications only",
                "Appeals and applications for review/revision only (not original suits)",
                "Original suits only",
                "Criminal complaints only"
            ),
            correctOptionIndex = 1,
            explanationEn = "Section 5 of the Limitation Act applies only to appeals and certain applications (review, revision, leave to appeal), and explicitly EXCLUDES original suits.",
            explanationBn = "তামাদি আইনের ৫ ধারা শুধুমাত্র আপিল ও দরখাস্তের (রিভিউ, রিভিশন ইত্যাদি) ক্ষেত্রে প্রযোজ্য। এটি মূল মামলার (Original Suit) ক্ষেত্রে কোনোভাবেই প্রযোজ্য নয়।",
            legalReference = "Section 5, Limitation Act 1908"
        )
    )
}
