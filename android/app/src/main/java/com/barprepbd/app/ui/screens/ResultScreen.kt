package com.barprepbd.app.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.barprepbd.app.data.model.ExamResult
import com.barprepbd.app.ui.theme.GoldAccent
import com.barprepbd.app.ui.theme.PrimaryNavy
import com.barprepbd.app.ui.theme.SuccessGreen
import java.util.Locale

@Composable
fun ResultScreen(
    result: ExamResult,
    onBackToDashboard: () -> Unit
) {
    val isPassed = result.passed
    val minutesSpent = result.timeSpentSeconds / 60
    val secondsSpent = result.timeSpentSeconds % 60

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFFF5F7FA))
            .padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
        contentPadding = PaddingValues(vertical = 16.dp)
    ) {
        // Result Summary Header Card
        item {
            Card(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(16.dp),
                colors = CardDefaults.cardColors(
                    containerColor = if (isPassed) Color(0xFFF0FDF4) else Color(0xFFFEF2F2)
                ),
                border = BorderStroke(
                    1.dp,
                    if (isPassed) Color(0xFFBBF7D0) else Color(0xFFFECACA)
                )
            ) {
                Column(
                    modifier = Modifier.padding(20.dp),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Icon(
                        imageVector = if (isPassed) Icons.Default.CheckCircle else Icons.Default.Cancel,
                        contentDescription = null,
                        tint = if (isPassed) SuccessGreen else Color(0xFFC62828),
                        modifier = Modifier.size(54.dp)
                    )

                    Spacer(modifier = Modifier.height(10.dp))

                    Text(
                        text = if (isPassed) "CONGRATULATIONS! PASSED" else "NEEDS IMPROVEMENT (FAILED)",
                        fontSize = 16.sp,
                        fontWeight = FontWeight.ExtraBold,
                        color = if (isPassed) SuccessGreen else Color(0xFFC62828)
                    )

                    Text(
                        text = result.examTitle,
                        fontSize = 13.sp,
                        color = Color(0xFF627D98),
                        modifier = Modifier.padding(top = 2.dp)
                    )

                    Spacer(modifier = Modifier.height(14.dp))

                    Text(
                        text = String.format(Locale.US, "%.2f", result.score),
                        fontSize = 42.sp,
                        fontWeight = FontWeight.ExtraBold,
                        color = PrimaryNavy
                    )
                    Text(
                        text = "Out of ${result.totalMarks} Marks (Pass mark is 50.0)",
                        fontSize = 12.sp,
                        color = Color(0xFF627D98)
                    )
                }
            }
        }

        // Metrics Grid
        item {
            Card(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(14.dp),
                colors = CardDefaults.cardColors(containerColor = Color.White),
                border = BorderStroke(1.dp, Color(0xFFE2E8F0))
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Text(
                        text = "Performance Breakdown",
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Bold,
                        color = PrimaryNavy
                    )

                    Spacer(modifier = Modifier.height(12.dp))

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        MetricItem(label = "Correct (+1.00)", value = "${result.correctCount}", color = SuccessGreen)
                        MetricItem(label = "Wrong (-0.25)", value = "${result.wrongCount}", color = Color(0xFFC62828))
                        MetricItem(label = "Deduction", value = String.format(Locale.US, "-%.2f", result.negativeMarksDeducted), color = Color(0xFFC62828))
                        MetricItem(label = "Skipped", value = "${result.unattemptedCount}", color = Color(0xFF627D98))
                    }

                    Spacer(modifier = Modifier.height(12.dp))
                    HorizontalDivider(color = Color(0xFFF0F4F8))
                    Spacer(modifier = Modifier.height(10.dp))

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Text(
                            text = "Time Spent: ${minutesSpent}m ${secondsSpent}s",
                            fontSize = 12.sp,
                            color = Color(0xFF627D98)
                        )
                        Text(
                            text = String.format(Locale.US, "Accuracy: %.1f%%", result.percentage),
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Bold,
                            color = PrimaryNavy
                        )
                    }
                }
            }
        }

        // Review Statutory Solutions Header
        item {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "Statutory Answers & Explanations",
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Bold,
                    color = PrimaryNavy
                )
            }
        }

        // Review Question Cards
        itemsIndexed(result.questionDetails) { idx, detail ->
            Card(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(12.dp),
                colors = CardDefaults.cardColors(containerColor = Color.White),
                border = BorderStroke(
                    1.dp,
                    if (detail.isCorrect) Color(0xFFBBF7D0) else if (detail.selectedOption != null) Color(0xFFFECACA) else Color(0xFFE2E8F0)
                )
            ) {
                Column(modifier = Modifier.padding(14.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Surface(
                            color = if (detail.isCorrect) SuccessGreen else if (detail.selectedOption != null) Color(0xFFC62828) else Color(0xFF627D98),
                            shape = RoundedCornerShape(4.dp)
                        ) {
                            Text(
                                text = "Q ${idx + 1}: ${if (detail.isCorrect) "CORRECT (+1)" else if (detail.selectedOption != null) "INCORRECT (-0.25)" else "UNATTEMPTED"}",
                                fontSize = 10.sp,
                                fontWeight = FontWeight.Bold,
                                color = Color.White,
                                modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp)
                            )
                        }

                        if (!detail.legalReference.isNullOrBlank()) {
                            Surface(
                                color = Color(0xFFFEF3C7),
                                shape = RoundedCornerShape(4.dp)
                            ) {
                                Text(
                                    text = detail.legalReference,
                                    fontSize = 10.sp,
                                    fontWeight = FontWeight.Bold,
                                    color = Color(0xFFB45309),
                                    modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp)
                                )
                            }
                        }
                    }

                    Spacer(modifier = Modifier.height(10.dp))

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(16.dp)
                    ) {
                        Text(
                            text = "Your Answer: ${detail.selectedOption?.let { ('A'.code + it).toChar().toString() } ?: "None"}",
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Bold,
                            color = if (detail.isCorrect) SuccessGreen else Color(0xFFC62828)
                        )
                        Text(
                            text = "Correct Answer: ${('A'.code + detail.correctOption).toChar()}",
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Bold,
                            color = SuccessGreen
                        )
                    }

                    Spacer(modifier = Modifier.height(8.dp))

                    // Legal Explanation
                    Surface(
                        color = Color(0xFFF8FAFC),
                        shape = RoundedCornerShape(8.dp),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Column(modifier = Modifier.padding(10.dp)) {
                            Text(
                                text = "Legal Analysis:",
                                fontSize = 11.sp,
                                fontWeight = FontWeight.Bold,
                                color = PrimaryNavy
                            )
                            Spacer(modifier = Modifier.height(2.dp))
                            Text(
                                text = detail.explanationEn,
                                fontSize = 12.sp,
                                color = Color(0xFF334E68),
                                lineHeight = 17.sp
                            )
                            if (!detail.explanationBn.isNullOrBlank()) {
                                Spacer(modifier = Modifier.height(4.dp))
                                Text(
                                    text = detail.explanationBn,
                                    fontSize = 11.sp,
                                    color = Color(0xFF627D98),
                                    lineHeight = 16.sp
                                )
                            }
                        }
                    }
                }
            }
        }

        // Return button
        item {
            Button(
                onClick = onBackToDashboard,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(48.dp),
                shape = RoundedCornerShape(10.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = PrimaryNavy,
                    contentColor = Color.White
                )
            ) {
                Text("Return to Dashboard", fontWeight = FontWeight.Bold, fontSize = 14.sp)
            }
        }
    }
}

@Composable
private fun MetricItem(label: String, value: String, color: Color) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(text = value, fontSize = 16.sp, fontWeight = FontWeight.ExtraBold, color = color)
        Text(text = label, fontSize = 10.sp, color = Color(0xFF627D98))
    }
}
