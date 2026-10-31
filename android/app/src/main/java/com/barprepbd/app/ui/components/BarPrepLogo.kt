package com.barprepbd.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Balance
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.barprepbd.app.ui.theme.GoldAccent
import com.barprepbd.app.ui.theme.PrimaryNavy

@Composable
fun BarPrepLogo(
    modifier: Modifier = Modifier,
    isDarkBackground: Boolean = false,
    showTagline: Boolean = true
) {
    Row(
        modifier = modifier,
        verticalAlignment = Alignment.CenterVertically
    ) {
        // Logo Icon Box
        Box(
            modifier = Modifier
                .size(42.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(if (isDarkBackground) GoldAccent else PrimaryNavy),
            contentAlignment = Alignment.Center
        ) {
            Icon(
                imageVector = Icons.Default.Balance,
                contentDescription = "BarPrep BD Emblem",
                tint = if (isDarkBackground) PrimaryNavy else GoldAccent,
                modifier = Modifier.size(26.dp)
            )
        }

        Spacer(modifier = Modifier.width(12.dp))

        Column {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "BarPrep",
                    fontSize = 20.sp,
                    fontWeight = FontWeight.Bold,
                    color = if (isDarkBackground) Color.White else PrimaryNavy
                )
                Spacer(modifier = Modifier.width(4.dp))
                Text(
                    text = "BD",
                    fontSize = 20.sp,
                    fontWeight = FontWeight.ExtraBold,
                    color = GoldAccent
                )
            }
            if (showTagline) {
                Text(
                    text = "Practice Smart. Become an Advocate.",
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Medium,
                    color = if (isDarkBackground) Color.White.copy(alpha = 0.75f) else Color(0xFF627D98)
                )
            }
        }
    }
}
