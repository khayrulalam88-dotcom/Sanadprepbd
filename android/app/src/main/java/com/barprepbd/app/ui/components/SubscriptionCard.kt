package com.barprepbd.app.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.barprepbd.app.data.model.SubscriptionPackage
import com.barprepbd.app.ui.theme.GoldAccent
import com.barprepbd.app.ui.theme.PrimaryNavy
import com.barprepbd.app.ui.theme.SuccessGreen

@Composable
fun SubscriptionCard(
    subscriptionPackage: SubscriptionPackage,
    isCurrentPlan: Boolean = false,
    onSelectPlan: (SubscriptionPackage) -> Unit,
    modifier: Modifier = Modifier
) {
    val isPopular = subscriptionPackage.id == "pkg_exam_pass" || subscriptionPackage.id == "package_b"

    Card(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = Color.White),
        border = BorderStroke(
            width = if (isPopular) 2.dp else 1.dp,
            color = if (isPopular) GoldAccent else Color(0xFFE2E8F0)
        ),
        elevation = CardDefaults.cardElevation(defaultElevation = if (isPopular) 4.dp else 1.dp)
    ) {
        Column(modifier = Modifier.padding(20.dp)) {
            // Header with badge
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column {
                    Text(
                        text = subscriptionPackage.nameEn,
                        fontSize = 18.sp,
                        fontWeight = FontWeight.Bold,
                        color = PrimaryNavy
                    )
                    Text(
                        text = subscriptionPackage.nameBn,
                        fontSize = 12.sp,
                        color = Color(0xFF627D98)
                    )
                }

                if (isPopular) {
                    Surface(
                        color = GoldAccent.copy(alpha = 0.15f),
                        shape = RoundedCornerShape(20.dp),
                        border = BorderStroke(1.dp, GoldAccent)
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Icon(
                                imageVector = Icons.Default.Star,
                                contentDescription = null,
                                tint = GoldAccent,
                                modifier = Modifier.size(12.dp)
                            )
                            Spacer(modifier = Modifier.width(4.dp))
                            Text(
                                text = "POPULAR",
                                fontSize = 10.sp,
                                fontWeight = FontWeight.Bold,
                                color = PrimaryNavy
                            )
                        }
                    }
                }
            }

            Spacer(modifier = Modifier.height(14.dp))

            // Pricing
            Row(verticalAlignment = Alignment.Bottom) {
                Text(
                    text = "৳${subscriptionPackage.price}",
                    fontSize = 32.sp,
                    fontWeight = FontWeight.ExtraBold,
                    color = PrimaryNavy
                )
                Spacer(modifier = Modifier.width(6.dp))
                Text(
                    text = if (subscriptionPackage.validityDays > 0) "/ ${subscriptionPackage.validityDays} days" else "/ Until Exam Day",
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Medium,
                    color = Color(0xFF627D98),
                    modifier = Modifier.padding(bottom = 4.dp)
                )
            }

            Text(
                text = subscriptionPackage.description,
                fontSize = 13.sp,
                color = Color(0xFF486581),
                modifier = Modifier.padding(vertical = 10.dp)
            )

            HorizontalDivider(color = Color(0xFFF0F4F8), thickness = 1.dp)

            Spacer(modifier = Modifier.height(12.dp))

            // Features list
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                subscriptionPackage.features.forEach { feature ->
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Icon(
                            imageVector = Icons.Default.CheckCircle,
                            contentDescription = null,
                            tint = SuccessGreen,
                            modifier = Modifier.size(16.dp)
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            text = feature,
                            fontSize = 13.sp,
                            color = Color(0xFF334E68)
                        )
                    }
                }
            }

            Spacer(modifier = Modifier.height(18.dp))

            // Action Button
            Button(
                onClick = { onSelectPlan(subscriptionPackage) },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(48.dp),
                shape = RoundedCornerShape(10.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (isPopular) GoldAccent else PrimaryNavy,
                    contentColor = if (isPopular) PrimaryNavy else Color.White
                ),
                enabled = !isCurrentPlan
            ) {
                Text(
                    text = if (isCurrentPlan) "Active Plan" else "Enroll with bKash / Nagad",
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Bold
                )
            }
        }
    }
}
