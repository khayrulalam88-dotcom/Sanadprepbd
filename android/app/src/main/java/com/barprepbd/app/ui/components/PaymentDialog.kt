package com.barprepbd.app.ui.components

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.widget.Toast
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material.icons.filled.Receipt
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import com.barprepbd.app.data.model.SubscriptionPackage
import com.barprepbd.app.ui.theme.GoldAccent
import com.barprepbd.app.ui.theme.PrimaryNavy
import com.barprepbd.app.ui.theme.SuccessGreen

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PaymentDialog(
    selectedPackage: SubscriptionPackage,
    onDismiss: () -> Unit,
    onSubmitPayment: (method: String, senderNumber: String, trxId: String, amount: Int) -> Unit
) {
    val context = LocalContext.current
    var selectedMethod by remember { mutableStateOf("bKash") }
    var senderNumber by remember { mutableStateOf("") }
    var trxId by remember { mutableStateOf("") }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var isSubmitting by remember { mutableStateOf(false) }

    val paymentNumber = "01712607777"

    fun copyToClipboard(text: String, label: String) {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = ClipData.newPlainText(label, text)
        clipboard.setPrimaryClip(clip)
        Toast.makeText(context, "$label copied: $text", Toast.LENGTH_SHORT).show()
    }

    Dialog(onDismissRequest = onDismiss) {
        Card(
            modifier = Modifier
                .fillMaxWidth()
                .wrapContentHeight(),
            shape = RoundedCornerShape(20.dp),
            colors = CardDefaults.cardColors(containerColor = Color.White),
            elevation = CardDefaults.cardElevation(8.dp)
        ) {
            Column(
                modifier = Modifier
                    .padding(20.dp)
                    .verticalScroll(rememberScrollState())
            ) {
                // Title
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column {
                        Text(
                            text = "Manual Payment Verification",
                            fontSize = 18.sp,
                            fontWeight = FontWeight.Bold,
                            color = PrimaryNavy
                        )
                        Text(
                            text = "bKash / Nagad Personal Send Money",
                            fontSize = 12.sp,
                            color = Color(0xFF627D98)
                        )
                    }
                }

                Spacer(modifier = Modifier.height(14.dp))

                // Package Summary Pill
                Surface(
                    color = Color(0xFFF0F4F8),
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Row(
                        modifier = Modifier.padding(12.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column {
                            Text(
                                text = selectedPackage.nameEn,
                                fontWeight = FontWeight.Bold,
                                color = PrimaryNavy,
                                fontSize = 14.sp
                            )
                            Text(
                                text = "Payable Amount",
                                fontSize = 11.sp,
                                color = Color(0xFF627D98)
                            )
                        }
                        Text(
                            text = "৳${selectedPackage.price}",
                            fontWeight = FontWeight.ExtraBold,
                            color = PrimaryNavy,
                            fontSize = 20.sp
                        )
                    }
                }

                Spacer(modifier = Modifier.height(16.dp))

                // Method Selector Tabs
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    // bKash Tab
                    Box(
                        modifier = Modifier
                            .weight(1f)
                            .clip(RoundedCornerShape(10.dp))
                            .border(
                                width = if (selectedMethod == "bKash") 2.dp else 1.dp,
                                color = if (selectedMethod == "bKash") Color(0xFFD12053) else Color(0xFFCBD2D9),
                                shape = RoundedCornerShape(10.dp)
                            )
                            .background(if (selectedMethod == "bKash") Color(0xFFFFF0F5) else Color.White)
                            .clickable { selectedMethod = "bKash" }
                            .padding(vertical = 10.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            text = "bKash",
                            fontWeight = FontWeight.Bold,
                            color = if (selectedMethod == "bKash") Color(0xFFD12053) else Color(0xFF486581),
                            fontSize = 14.sp
                        )
                    }

                    // Nagad Tab
                    Box(
                        modifier = Modifier
                            .weight(1f)
                            .clip(RoundedCornerShape(10.dp))
                            .border(
                                width = if (selectedMethod == "Nagad") 2.dp else 1.dp,
                                color = if (selectedMethod == "Nagad") Color(0xFFF37021) else Color(0xFFCBD2D9),
                                shape = RoundedCornerShape(10.dp)
                            )
                            .background(if (selectedMethod == "Nagad") Color(0xFFFFF5EB) else Color.White)
                            .clickable { selectedMethod = "Nagad" }
                            .padding(vertical = 10.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            text = "Nagad",
                            fontWeight = FontWeight.Bold,
                            color = if (selectedMethod == "Nagad") Color(0xFFF37021) else Color(0xFF486581),
                            fontSize = 14.sp
                        )
                    }
                }

                Spacer(modifier = Modifier.height(14.dp))

                // Instruction & Number Card with Copy Button
                Surface(
                    shape = RoundedCornerShape(12.dp),
                    border = BorderStroke(1.dp, Color(0xFFE2E8F0)),
                    color = Color(0xFFF8FAFC),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(modifier = Modifier.padding(14.dp)) {
                        Text(
                            text = "1. Open $selectedMethod App & select 'Send Money'",
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Medium,
                            color = Color(0xFF334E68)
                        )
                        Spacer(modifier = Modifier.height(6.dp))
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Column {
                                Text(
                                    text = "$selectedMethod Number:",
                                    fontSize = 11.sp,
                                    color = Color(0xFF627D98)
                                )
                                Text(
                                    text = paymentNumber,
                                    fontSize = 17.sp,
                                    fontWeight = FontWeight.ExtraBold,
                                    color = PrimaryNavy
                                )
                            }
                            FilledTonalButton(
                                onClick = { copyToClipboard(paymentNumber, "$selectedMethod Number") },
                                colors = ButtonDefaults.filledTonalButtonColors(
                                    containerColor = Color(0xFFE2E8F0),
                                    contentColor = PrimaryNavy
                                ),
                                contentPadding = PaddingValues(horizontal = 10.dp, vertical = 6.dp)
                            ) {
                                Icon(
                                    imageVector = Icons.Default.ContentCopy,
                                    contentDescription = "Copy",
                                    modifier = Modifier.size(14.dp)
                                )
                                Spacer(modifier = Modifier.width(4.dp))
                                Text("Copy", fontSize = 12.sp, fontWeight = FontWeight.Bold)
                            }
                        }
                    }
                }

                Spacer(modifier = Modifier.height(16.dp))

                // Form Inputs
                OutlinedTextField(
                    value = senderNumber,
                    onValueChange = { senderNumber = it },
                    label = { Text("Sender Mobile Number") },
                    placeholder = { Text("e.g. 017XXXXXXXX") },
                    leadingIcon = {
                        Icon(Icons.Default.PhoneAndroid, contentDescription = null, tint = PrimaryNavy)
                    },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    shape = RoundedCornerShape(10.dp)
                )

                Spacer(modifier = Modifier.height(12.dp))

                OutlinedTextField(
                    value = trxId,
                    onValueChange = { trxId = it },
                    label = { Text("Transaction ID (TrxID)") },
                    placeholder = { Text("e.g. BK8291X7Y9") },
                    leadingIcon = {
                        Icon(Icons.Default.Receipt, contentDescription = null, tint = PrimaryNavy)
                    },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    shape = RoundedCornerShape(10.dp)
                )

                if (errorMessage != null) {
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = errorMessage!!,
                        color = MaterialTheme.colorScheme.error,
                        fontSize = 12.sp
                    )
                }

                Spacer(modifier = Modifier.height(18.dp))

                // Action Buttons
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    OutlinedButton(
                        onClick = onDismiss,
                        modifier = Modifier
                            .weight(1f)
                            .height(46.dp),
                        shape = RoundedCornerShape(10.dp)
                    ) {
                        Text("Cancel", color = Color(0xFF486581))
                    }

                    Button(
                        onClick = {
                            if (senderNumber.trim().length < 11) {
                                errorMessage = "Please enter valid 11-digit mobile number."
                                return@Button
                            }
                            if (trxId.trim().length < 6) {
                                errorMessage = "Please enter valid Transaction ID (TrxID)."
                                return@Button
                            }
                            errorMessage = null
                            isSubmitting = true
                            onSubmitPayment(selectedMethod, senderNumber.trim(), trxId.trim(), selectedPackage.price)
                        },
                        modifier = Modifier
                            .weight(1.4f)
                            .height(46.dp),
                        shape = RoundedCornerShape(10.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = PrimaryNavy,
                            contentColor = Color.White
                        ),
                        enabled = !isSubmitting
                    ) {
                        if (isSubmitting) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(20.dp),
                                color = Color.White,
                                strokeWidth = 2.dp
                            )
                        } else {
                            Text("Submit Verification", fontSize = 13.sp, fontWeight = FontWeight.Bold)
                        }
                    }
                }

                Spacer(modifier = Modifier.height(14.dp))

                // WhatsApp Support Option
                OutlinedButton(
                    onClick = {
                        val waUrl = "https://wa.me/8801671819027?text=" + java.net.URLEncoder.encode(
                            "Hello BarPrep BD Support, I need help with my payment for ${selectedPackage.nameEn} (৳${selectedPackage.price}).",
                            "UTF-8"
                        )
                        val intent = android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(waUrl))
                        context.startActivity(intent)
                    },
                    modifier = Modifier.fillMaxWidth().height(42.dp),
                    shape = RoundedCornerShape(10.dp),
                    border = BorderStroke(1.dp, Color(0xFF25D366))
                ) {
                    Text(
                        text = "WhatsApp Support (+8801671819027)",
                        color = Color(0xFF128C7E),
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold
                    )
                }
            }
        }
    }
}
