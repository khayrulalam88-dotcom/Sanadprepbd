package com.barprepbd.app.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Balance
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.barprepbd.app.data.model.Subject
import com.barprepbd.app.ui.theme.GoldAccent
import com.barprepbd.app.ui.theme.PrimaryNavy
import com.barprepbd.app.ui.theme.SuccessGreen
import com.barprepbd.app.ui.viewmodel.BarPrepUiState

@Composable
fun PracticeScreen(
    state: BarPrepUiState
) {
    var selectedSubjectId by remember { mutableStateOf<String?>(state.subjects.firstOrNull()?.id ?: "sub_crpc") }
    val practiceAnswers = remember { mutableStateMapOf<String, Int>() }

    val activeSubject = state.subjects.find { it.id == selectedSubjectId }

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFFF5F7FA))
            .padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
        contentPadding = PaddingValues(vertical = 16.dp)
    ) {
        // Title
        item {
            Column {
                Text(
                    text = "Subject-Wise MCQ Practice",
                    fontSize = 18.sp,
                    fontWeight = FontWeight.Bold,
                    color = PrimaryNavy
                )
                Text(
                    text = "Select any of the 7 Bar Council subjects for instant statutory feedback",
                    fontSize = 12.sp,
                    color = Color(0xFF627D98)
                )
            }
        }

        // Horizontal Subject Selector Chips
        item {
            LazyRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                contentPadding = PaddingValues(vertical = 4.dp)
            ) {
                items(state.subjects) { subject ->
                    val isSelected = subject.id == selectedSubjectId
                    Surface(
                        modifier = Modifier.clickable { selectedSubjectId = subject.id },
                        shape = RoundedCornerShape(20.dp),
                        color = if (isSelected) PrimaryNavy else Color.White,
                        border = BorderStroke(
                            1.dp,
                            if (isSelected) PrimaryNavy else Color(0xFFCBD2D9)
                        )
                    ) {
                        Text(
                            text = "${subject.nameEn.split(",").firstOrNull() ?: subject.nameEn} (${subject.marks})",
                            fontSize = 12.sp,
                            fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Medium,
                            color = if (isSelected) Color.White else PrimaryNavy,
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp)
                        )
                    }
                }
            }
        }

        // Subject Details Card
        item {
            activeSubject?.let { sub ->
                Surface(
                    color = Color.White,
                    shape = RoundedCornerShape(12.dp),
                    border = BorderStroke(1.dp, Color(0xFFE2E8F0)),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Row(
                        modifier = Modifier.padding(14.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Box(
                            modifier = Modifier
                                .size(40.dp)
                                .clip(RoundedCornerShape(8.dp))
                                .background(Color(0xFFF0F4F8)),
                            contentAlignment = Alignment.Center
                        ) {
                            Icon(Icons.Default.Balance, contentDescription = null, tint = PrimaryNavy)
                        }
                        Spacer(modifier = Modifier.width(12.dp))
                        Column(modifier = Modifier.weight(1f)) {
                            Text(text = sub.nameEn, fontSize = 14.sp, fontWeight = FontWeight.Bold, color = PrimaryNavy)
                            Text(text = "${sub.nameBn} • Total ${sub.marks} Marks", fontSize = 12.sp, color = Color(0xFF627D98))
                        }
                    }
                }
            }
        }

        // Practice Questions
        val filteredQuestions = state.examQuestions.filter {
            selectedSubjectId == null || it.subjectId == selectedSubjectId
        }.ifEmpty { state.examQuestions }

        items(filteredQuestions) { q ->
            val userSelected = practiceAnswers[q.id]
            val hasAnswered = userSelected != null

            Card(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(14.dp),
                colors = CardDefaults.cardColors(containerColor = Color.White),
                border = BorderStroke(1.dp, Color(0xFFE2E8F0))
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    q.legalReference?.let { ref ->
                        Surface(
                            color = Color(0xFFFEF3C7),
                            shape = RoundedCornerShape(4.dp),
                            modifier = Modifier.padding(bottom = 8.dp)
                        ) {
                            Text(
                                text = ref,
                                fontSize = 10.sp,
                                fontWeight = FontWeight.Bold,
                                color = Color(0xFFB45309),
                                modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp)
                            )
                        }
                    }

                    Text(
                        text = q.textEn,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Bold,
                        color = PrimaryNavy,
                        lineHeight = 20.sp
                    )

                    Spacer(modifier = Modifier.height(4.dp))

                    Text(
                        text = q.textBn,
                        fontSize = 12.sp,
                        color = Color(0xFF627D98),
                        lineHeight = 17.sp
                    )

                    Spacer(modifier = Modifier.height(14.dp))

                    // Options with instant evaluation
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        q.options.forEachIndexed { optIdx, optText ->
                            val isCorrectChoice = optIdx == q.correctOptionIndex
                            val isUserChoice = userSelected == optIdx

                            val optBg = when {
                                !hasAnswered -> Color.White
                                isCorrectChoice -> Color(0xFFF0FDF4)
                                isUserChoice -> Color(0xFFFEF2F2)
                                else -> Color.White
                            }

                            val optBorder = when {
                                !hasAnswered -> Color(0xFFCBD2D9)
                                isCorrectChoice -> SuccessGreen
                                isUserChoice -> Color(0xFFC62828)
                                else -> Color(0xFFE2E8F0)
                            }

                            Surface(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clip(RoundedCornerShape(10.dp))
                                    .clickable(enabled = !hasAnswered) {
                                        practiceAnswers[q.id] = optIdx
                                    },
                                shape = RoundedCornerShape(10.dp),
                                color = optBg,
                                border = BorderStroke(1.dp, optBorder)
                            ) {
                                Row(
                                    modifier = Modifier.padding(10.dp),
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Box(
                                        modifier = Modifier
                                            .size(26.dp)
                                            .clip(CircleShape)
                                            .background(
                                                when {
                                                    !hasAnswered -> Color(0xFFF0F4F8)
                                                    isCorrectChoice -> SuccessGreen
                                                    isUserChoice -> Color(0xFFC62828)
                                                    else -> Color(0xFFF0F4F8)
                                                }
                                            ),
                                        contentAlignment = Alignment.Center
                                    ) {
                                        Text(
                                            text = ('A'.code + optIdx).toChar().toString(),
                                            fontSize = 11.sp,
                                            fontWeight = FontWeight.Bold,
                                            color = if (hasAnswered && (isCorrectChoice || isUserChoice)) Color.White else PrimaryNavy
                                        )
                                    }

                                    Spacer(modifier = Modifier.width(10.dp))

                                    Text(
                                        text = optText,
                                        fontSize = 13.sp,
                                        color = if (hasAnswered && isCorrectChoice) SuccessGreen else Color(0xFF334E68),
                                        fontWeight = if (hasAnswered && isCorrectChoice) FontWeight.Bold else FontWeight.Normal,
                                        modifier = Modifier.weight(1f)
                                    )

                                    if (hasAnswered && isCorrectChoice) {
                                        Icon(Icons.Default.CheckCircle, contentDescription = null, tint = SuccessGreen, modifier = Modifier.size(18.dp))
                                    } else if (hasAnswered && isUserChoice) {
                                        Icon(Icons.Default.Cancel, contentDescription = null, tint = Color(0xFFC62828), modifier = Modifier.size(18.dp))
                                    }
                                }
                            }
                        }
                    }

                    // Explanation Box upon answering
                    if (hasAnswered) {
                        Spacer(modifier = Modifier.height(12.dp))
                        Surface(
                            color = Color(0xFFF8FAFC),
                            shape = RoundedCornerShape(8.dp),
                            border = BorderStroke(1.dp, Color(0xFFE2E8F0)),
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Column(modifier = Modifier.padding(10.dp)) {
                                Text(
                                    text = "Statutory Authority:",
                                    fontSize = 11.sp,
                                    fontWeight = FontWeight.Bold,
                                    color = PrimaryNavy
                                )
                                Spacer(modifier = Modifier.height(2.dp))
                                Text(
                                    text = q.explanationEn,
                                    fontSize = 12.sp,
                                    color = Color(0xFF334E68),
                                    lineHeight = 17.sp
                                )
                                if (!q.explanationBn.isNullOrBlank()) {
                                    Spacer(modifier = Modifier.height(4.dp))
                                    Text(
                                        text = q.explanationBn,
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
        }
    }
}
