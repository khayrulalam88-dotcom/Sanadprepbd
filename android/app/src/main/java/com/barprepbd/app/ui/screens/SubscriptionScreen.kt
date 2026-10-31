package com.barprepbd.app.ui.screens

import android.widget.Toast
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Security
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.barprepbd.app.data.model.SubscriptionPackage
import com.barprepbd.app.ui.components.PaymentDialog
import com.barprepbd.app.ui.components.SubscriptionCard
import com.barprepbd.app.ui.theme.GoldAccent
import com.barprepbd.app.ui.theme.PrimaryNavy
import com.barprepbd.app.ui.viewmodel.BarPrepUiState

@Composable
fun SubscriptionScreen(
    state: BarPrepUiState,
    onSubmitPayment: (SubscriptionPackage, String, String, String, (Boolean, String) -> Unit) -> Unit
) {
    val context = LocalContext.current
    var selectedPackageForPayment by remember { mutableStateOf<SubscriptionPackage?>(null) }

    LazyColumn(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFFF5F7FA))
            .padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
        contentPadding = PaddingValues(vertical = 16.dp)
    ) {
        // Header
        item {
            Column {
                Text(
                    text = "Subscription Passes",
                    fontSize = 20.sp,
                    fontWeight = FontWeight.Bold,
                    color = PrimaryNavy
                )
                Text(
                    text = "Choose the right preparation plan for Bangladesh Bar Council MCQ",
                    fontSize = 12.sp,
                    color = Color(0xFF627D98)
                )
            }
        }

        // Trust & Security Notice
        item {
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
                    Icon(
                        imageVector = Icons.Default.Security,
                        contentDescription = null,
                        tint = GoldAccent,
                        modifier = Modifier.size(28.dp)
                    )
                    Spacer(modifier = Modifier.width(12.dp))
                    Column {
                        Text(
                            text = "Manual bKash & Nagad Verification",
                            fontSize = 13.sp,
                            fontWeight = FontWeight.Bold,
                            color = PrimaryNavy
                        )
                        Text(
                            text = "Send Money to 01712607777. Subscriptions are activated securely by administrators.",
                            fontSize = 11.sp,
                            color = Color(0xFF627D98),
                            lineHeight = 16.sp
                        )
                    }
                }
            }
        }

        // Subscription Package Cards
        items(state.packages) { pkg ->
            SubscriptionCard(
                subscriptionPackage = pkg,
                isCurrentPlan = state.userProfile?.subscriptionPlan?.contains(pkg.nameEn) == true,
                onSelectPlan = { selected ->
                    selectedPackageForPayment = selected
                }
            )
        }
    }

    // Payment Dialog
    selectedPackageForPayment?.let { pkg ->
        PaymentDialog(
            selectedPackage = pkg,
            onDismiss = { selectedPackageForPayment = null },
            onSubmitPayment = { method, senderNumber, trxId, _ ->
                onSubmitPayment(pkg, method, senderNumber, trxId) { success, msg ->
                    selectedPackageForPayment = null
                    Toast.makeText(context, msg, Toast.LENGTH_LONG).show()
                }
            }
        )
    }
}
