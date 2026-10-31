package com.barprepbd.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.barprepbd.app.ui.components.SessionRevokedDialog
import com.barprepbd.app.ui.screens.*
import com.barprepbd.app.ui.theme.BarPrepBDTheme
import com.barprepbd.app.ui.theme.GoldAccent
import com.barprepbd.app.ui.theme.PrimaryNavy
import com.barprepbd.app.ui.viewmodel.BarPrepViewModel

sealed class Screen(val route: String, val title: String, val icon: ImageVector) {
    object Dashboard : Screen("dashboard", "Home", Icons.Default.Home)
    object Practice : Screen("practice", "Practice", Icons.Default.AutoStories)
    object Subscriptions : Screen("subscriptions", "Plans", Icons.Default.WorkspacePremium)
    object History : Screen("history", "History", Icons.Default.History)
}

class MainActivity : ComponentActivity() {

    private val viewModel: BarPrepViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            BarPrepBDTheme {
                val uiState by viewModel.uiState.collectAsState()
                var currentTab by remember { mutableStateOf<Screen>(Screen.Dashboard) }

                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background
                ) {
                    when {
                        // Priority 1: Candidate is taking a timed exam (Full screen distraction-free)
                        uiState.activeExam != null -> {
                            ExamScreen(
                                state = uiState,
                                onSelectAnswer = { qId, opt -> viewModel.selectAnswer(qId, opt) },
                                onToggleFlag = { qId -> viewModel.toggleFlagQuestion(qId) },
                                onGoToQuestion = { idx -> viewModel.goToQuestion(idx) },
                                onSubmitExam = { viewModel.submitActiveExam() },
                                onCancelExam = { viewModel.submitActiveExam() }
                            )
                        }

                        // Priority 2: Viewing the graded exam result with statutory answers
                        uiState.latestResult != null -> {
                            ResultScreen(
                                result = uiState.latestResult!!,
                                onBackToDashboard = {
                                    viewModel.loadInitialData()
                                    currentTab = Screen.Dashboard
                                }
                            )
                        }

                        // Priority 3: Main Navigation Shell
                        else -> {
                            Scaffold(
                                bottomBar = {
                                    NavigationBar(
                                        containerColor = Color.White,
                                        tonalElevation = 8.dp
                                    ) {
                                        val items = listOf(
                                            Screen.Dashboard,
                                            Screen.Practice,
                                            Screen.Subscriptions,
                                            Screen.History
                                        )

                                        items.forEach { screen ->
                                            val isSelected = currentTab.route == screen.route
                                            NavigationBarItem(
                                                icon = {
                                                    Icon(
                                                        imageVector = screen.icon,
                                                        contentDescription = screen.title
                                                    )
                                                },
                                                label = {
                                                    Text(
                                                        text = screen.title,
                                                        fontSize = 11.sp
                                                    )
                                                },
                                                selected = isSelected,
                                                onClick = { currentTab = screen },
                                                colors = NavigationBarItemDefaults.colors(
                                                    selectedIconColor = PrimaryNavy,
                                                    selectedTextColor = PrimaryNavy,
                                                    indicatorColor = GoldAccent.copy(alpha = 0.25f),
                                                    unselectedIconColor = Color(0xFF627D98),
                                                    unselectedTextColor = Color(0xFF627D98)
                                                )
                                            )
                                        }
                                    }
                                }
                            ) { paddingValues ->
                                Surface(
                                    modifier = Modifier
                                        .fillMaxSize()
                                        .padding(paddingValues)
                                ) {
                                    when (currentTab) {
                                        Screen.Dashboard -> {
                                            DashboardScreen(
                                                state = uiState,
                                                onStartExam = { exam -> viewModel.startExam(exam) },
                                                onNavigateToSubscriptions = { currentTab = Screen.Subscriptions },
                                                onNavigateToPractice = { currentTab = Screen.Practice }
                                            )
                                        }
                                        Screen.Practice -> {
                                            PracticeScreen(state = uiState)
                                        }
                                        Screen.Subscriptions -> {
                                            SubscriptionScreen(
                                                state = uiState,
                                                onSubmitPayment = { pkg, method, sender, trx, onDone ->
                                                    viewModel.submitPayment(pkg, method, sender, trx, onDone)
                                                }
                                            )
                                        }
                                        Screen.History -> {
                                            HistoryScreen(
                                                state = uiState,
                                                onViewResult = { /* View past attempt */ }
                                            )
                                        }
                                    }
                                }
                            }
                        }
                    }

                    // Single active session revocation dialog overlay
                    if (uiState.isSessionRevoked) {
                        SessionRevokedDialog(
                            onReLogin = { viewModel.resetSessionRevoked() }
                        )
                    }
                }
            }
        }
    }
}
