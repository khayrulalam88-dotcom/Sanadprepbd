package com.barprepbd.app.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.barprepbd.app.ui.theme.GoldAccent
import com.barprepbd.app.ui.theme.PrimaryNavy
import com.barprepbd.app.ui.theme.SuccessGreen
import com.barprepbd.app.ui.viewmodel.BarPrepUiState
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ExamScreen(
    state: BarPrepUiState,
    onSelectAnswer: (String, Int) -> Unit,
    onToggleFlag: (String) -> Unit,
    onGoToQuestion: (Int) -> Unit,
    onSubmitExam: () -> Unit,
    onCancelExam: () -> Unit
) {
    val exam = state.activeExam ?: return
    val questions = state.examQuestions
    if (questions.isEmpty()) {
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator(color = PrimaryNavy)
        }
        return
    }

    val currentIdx = state.currentQuestionIndex
    val currentQuestion = questions[currentIdx]
    val isFlagged = state.flaggedQuestionIds.contains(currentQuestion.id)
    val selectedOption = state.userAnswers[currentQuestion.id]

    var showPaletteSheet by remember { mutableStateOf(false) }
    var showSubmitConfirmation by remember { mutableStateOf(false) }

    // Timer calculation
    val minutes = state.timeRemainingSeconds / 60
    val seconds = state.timeRemainingSeconds % 60
    val timeFormatted = String.format(Locale.US, "%02d:%02d", minutes, seconds)
    val isLowTime = state.timeRemainingSeconds < 300 // < 5 mins

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(
                            text = exam.titleEn,
                            fontSize = 14.sp,
                            fontWeight = FontWeight.Bold,
                            color = PrimaryNavy,
                            maxLines = 1
                        )
                        Text(
                            text = "Question ${currentIdx + 1} of ${questions.size}",
                            fontSize = 11.sp,
                            color = Color(0xFF627D98)
                        )
                    }
                },
                actions = {
                    // Countdown Timer Pill
                    Surface(
                        color = if (isLowTime) Color(0xFFFFEBEE) else Color(0xFFF0F4F8),
                        shape = RoundedCornerShape(20.dp),
                        border = BorderStroke(1.dp, if (isLowTime) Color(0xFFC62828) else Color(0xFFCBD2D9))
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Icon(
                                imageVector = Icons.Default.Timer,
                                contentDescription = "Timer",
                                tint = if (isLowTime) Color(0xFFC62828) else PrimaryNavy,
                                modifier = Modifier.size(14.dp)
                            )
                            Spacer(modifier = Modifier.width(4.dp))
                            Text(
                                text = timeFormatted,
                                fontSize = 13.sp,
                                fontWeight = FontWeight.ExtraBold,
                                color = if (isLowTime) Color(0xFFC62828) else PrimaryNavy
                            )
                        }
                    }

                    IconButton(onClick = { showPaletteSheet = true }) {
                        Icon(Icons.Default.GridView, contentDescription = "Question Grid", tint = PrimaryNavy)
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.White)
            )
        },
        bottomBar = {
            Surface(
                color = Color.White,
                shadowElevation = 8.dp,
                border = BorderStroke(1.dp, Color(0xFFE2E8F0))
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(14.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    OutlinedButton(
                        onClick = { if (currentIdx > 0) onGoToQuestion(currentIdx - 1) },
                        enabled = currentIdx > 0,
                        shape = RoundedCornerShape(10.dp)
                    ) {
                        Icon(Icons.Default.ArrowBack, contentDescription = null, modifier = Modifier.size(16.dp))
                        Spacer(modifier = Modifier.width(4.dp))
                        Text("Previous")
                    }

                    Button(
                        onClick = { showSubmitConfirmation = true },
                        colors = ButtonDefaults.buttonColors(
                            containerColor = Color(0xFFC62828),
                            contentColor = Color.White
                        ),
                        shape = RoundedCornerShape(10.dp)
                    ) {
                        Text("Submit Exam", fontWeight = FontWeight.Bold, fontSize = 13.sp)
                    }

                    Button(
                        onClick = {
                            if (currentIdx < questions.size - 1) {
                                onGoToQuestion(currentIdx + 1)
                            } else {
                                showSubmitConfirmation = true
                            }
                        },
                        colors = ButtonDefaults.buttonColors(
                            containerColor = PrimaryNavy,
                            contentColor = Color.White
                        ),
                        shape = RoundedCornerShape(10.dp)
                    ) {
                        Text(if (currentIdx == questions.size - 1) "Review" else "Next")
                        Spacer(modifier = Modifier.width(4.dp))
                        Icon(Icons.Default.ArrowForward, contentDescription = null, modifier = Modifier.size(16.dp))
                    }
                }
            }
        }
    ) { paddingValues ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .background(Color(0xFFF5F7FA))
                .padding(paddingValues)
                .padding(16.dp)
                .verticalScroll(rememberScrollState())
        ) {
            // Negative Marking Notice
            Surface(
                color = Color(0xFFFFF7ED),
                shape = RoundedCornerShape(8.dp),
                border = BorderStroke(1.dp, Color(0xFFFDBA74)),
                modifier = Modifier.fillMaxWidth()
            ) {
                Row(
                    modifier = Modifier.padding(10.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Icon(
                        Icons.Default.Info,
                        contentDescription = null,
                        tint = Color(0xFFC2410C),
                        modifier = Modifier.size(16.dp)
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(
                        text = "Bar Council Rule: +1.00 for correct answer, -0.25 deduction for each wrong answer.",
                        fontSize = 11.sp,
                        color = Color(0xFF9A3412),
                        fontWeight = FontWeight.Medium
                    )
                }
            }

            Spacer(modifier = Modifier.height(14.dp))

            // Question Card
            Card(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(16.dp),
                colors = CardDefaults.cardColors(containerColor = Color.White),
                border = BorderStroke(1.dp, Color(0xFFE2E8F0)),
                elevation = CardDefaults.cardElevation(2.dp)
            ) {
                Column(modifier = Modifier.padding(18.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Surface(
                            color = PrimaryNavy,
                            shape = RoundedCornerShape(6.dp)
                        ) {
                            Text(
                                text = "Q ${currentIdx + 1}",
                                color = Color.White,
                                fontSize = 12.sp,
                                fontWeight = FontWeight.Bold,
                                modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp)
                            )
                        }

                        IconButton(onClick = { onToggleFlag(currentQuestion.id) }) {
                            Icon(
                                imageVector = if (isFlagged) Icons.Default.Bookmark else Icons.Default.BookmarkBorder,
                                contentDescription = "Flag for review",
                                tint = if (isFlagged) GoldAccent else Color(0xFF627D98)
                            )
                        }
                    }

                    Spacer(modifier = Modifier.height(10.dp))

                    Text(
                        text = currentQuestion.textEn,
                        fontSize = 15.sp,
                        fontWeight = FontWeight.Bold,
                        color = PrimaryNavy,
                        lineHeight = 22.sp
                    )

                    Spacer(modifier = Modifier.height(8.dp))

                    Text(
                        text = currentQuestion.textBn,
                        fontSize = 13.sp,
                        color = Color(0xFF486581),
                        lineHeight = 19.sp
                    )
                }
            }

            Spacer(modifier = Modifier.height(16.dp))

            // Options List
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                currentQuestion.options.forEachIndexed { optIndex, optionText ->
                    val isSelected = selectedOption == optIndex
                    val optionLabel = ('A'.code + optIndex).toChar().toString()

                    Surface(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(12.dp))
                            .clickable { onSelectAnswer(currentQuestion.id, optIndex) },
                        shape = RoundedCornerShape(12.dp),
                        color = if (isSelected) Color(0xFFEBF8FF) else Color.White,
                        border = BorderStroke(
                            width = if (isSelected) 2.dp else 1.dp,
                            color = if (isSelected) PrimaryNavy else Color(0xFFCBD2D9)
                        )
                    ) {
                        Row(
                            modifier = Modifier.padding(14.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Box(
                                modifier = Modifier
                                    .size(32.dp)
                                    .clip(CircleShape)
                                    .background(if (isSelected) PrimaryNavy else Color(0xFFF0F4F8)),
                                contentAlignment = Alignment.Center
                            ) {
                                Text(
                                    text = optionLabel,
                                    fontSize = 13.sp,
                                    fontWeight = FontWeight.Bold,
                                    color = if (isSelected) Color.White else PrimaryNavy
                                )
                            }

                            Spacer(modifier = Modifier.width(12.dp))

                            Text(
                                text = optionText,
                                fontSize = 14.sp,
                                color = if (isSelected) PrimaryNavy else Color(0xFF334E68),
                                fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Normal,
                                modifier = Modifier.weight(1f)
                            )

                            if (isSelected) {
                                Icon(
                                    imageVector = Icons.Default.CheckCircle,
                                    contentDescription = null,
                                    tint = PrimaryNavy,
                                    modifier = Modifier.size(20.dp)
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    // Question Grid Bottom Sheet Dialog
    if (showPaletteSheet) {
        AlertDialog(
            onDismissRequest = { showPaletteSheet = false },
            title = {
                Text(
                    text = "Question Palette (${state.userAnswers.size}/${questions.size} Answered)",
                    fontSize = 16.sp,
                    fontWeight = FontWeight.Bold,
                    color = PrimaryNavy
                )
            },
            text = {
                Column {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceAround
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Box(modifier = Modifier.size(10.dp).background(SuccessGreen, CircleShape))
                            Spacer(modifier = Modifier.width(4.dp))
                            Text("Answered", fontSize = 10.sp)
                        }
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Box(modifier = Modifier.size(10.dp).background(GoldAccent, CircleShape))
                            Spacer(modifier = Modifier.width(4.dp))
                            Text("Flagged", fontSize = 10.sp)
                        }
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Box(modifier = Modifier.size(10.dp).background(Color(0xFFCBD2D9), CircleShape))
                            Spacer(modifier = Modifier.width(4.dp))
                            Text("Skipped", fontSize = 10.sp)
                        }
                    }
                    Spacer(modifier = Modifier.height(14.dp))
                    LazyVerticalGrid(
                        columns = GridCells.Fixed(5),
                        modifier = Modifier.height(260.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        items(questions.size) { i ->
                            val qId = questions[i].id
                            val isAns = state.userAnswers.containsKey(qId)
                            val isFlg = state.flaggedQuestionIds.contains(qId)

                            val bg = when {
                                i == currentIdx -> PrimaryNavy
                                isAns -> SuccessGreen
                                isFlg -> GoldAccent
                                else -> Color(0xFFF0F4F8)
                            }

                            val txtColor = when {
                                i == currentIdx || isAns -> Color.White
                                isFlg -> PrimaryNavy
                                else -> Color(0xFF486581)
                            }

                            Box(
                                modifier = Modifier
                                    .size(40.dp)
                                    .clip(RoundedCornerShape(8.dp))
                                    .background(bg)
                                    .clickable {
                                        onGoToQuestion(i)
                                        showPaletteSheet = false
                                    },
                                contentAlignment = Alignment.Center
                            ) {
                                Text(
                                    text = "${i + 1}",
                                    fontSize = 12.sp,
                                    fontWeight = FontWeight.Bold,
                                    color = txtColor
                                )
                            }
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { showPaletteSheet = false }) {
                    Text("Close", fontWeight = FontWeight.Bold)
                }
            }
        )
    }

    // Submit Confirmation Dialog
    if (showSubmitConfirmation) {
        val answeredCount = state.userAnswers.size
        val unattemptedCount = questions.size - answeredCount

        AlertDialog(
            onDismissRequest = { showSubmitConfirmation = false },
            title = {
                Text(
                    text = "Submit Bar Council Examination?",
                    fontSize = 18.sp,
                    fontWeight = FontWeight.Bold,
                    color = PrimaryNavy
                )
            },
            text = {
                Column {
                    Text(
                        text = "Are you sure you want to finish this examination?",
                        fontSize = 13.sp,
                        color = Color(0xFF486581)
                    )
                    Spacer(modifier = Modifier.height(10.dp))
                    Text(
                        text = "• Answered: $answeredCount\n• Unattempted: $unattemptedCount\n• Negative Marking: -0.25 per incorrect answer\n• Passing Requirement: 50.0 marks",
                        fontSize = 12.sp,
                        color = PrimaryNavy,
                        fontWeight = FontWeight.Medium,
                        lineHeight = 18.sp
                    )
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        showSubmitConfirmation = false
                        onSubmitExam()
                    },
                    colors = ButtonDefaults.buttonColors(
                        containerColor = PrimaryNavy,
                        contentColor = Color.White
                    )
                ) {
                    Text("Yes, Finish & Submit")
                }
            },
            dismissButton = {
                OutlinedButton(onClick = { showSubmitConfirmation = false }) {
                    Text("Continue Exam")
                }
            }
        )
    }
}
