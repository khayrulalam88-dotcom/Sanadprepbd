package com.barprepbd.app.data.api

import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.util.concurrent.TimeUnit

object ApiClient {
    // 10.0.2.2 is the special alias to host localhost in Android Emulator
    private const val DEFAULT_EMULATOR_BASE_URL = "http://10.0.2.2:3000/"
    
    // Live Cloud Deployment fallback
    private const val CLOUD_BASE_URL = "https://ais-dev-mezezf6ja6ylkc5vcz7d46-755882170928.asia-northeast1.run.app/"

    private var currentBaseUrl = DEFAULT_EMULATOR_BASE_URL

    private var authToken: String? = null
    private var sessionId: String? = null

    fun setAuthToken(token: String?, session: String? = null) {
        authToken = token
        sessionId = session
    }

    fun setCustomBaseUrl(url: String) {
        currentBaseUrl = if (url.endsWith("/")) url else "$url/"
        retrofitInstance = null
        apiServiceInstance = null
    }

    private val okHttpClient: OkHttpClient by lazy {
        val logging = HttpLoggingInterceptor().apply {
            level = HttpLoggingInterceptor.Level.BODY
        }

        OkHttpClient.Builder()
            .addInterceptor { chain ->
                val requestBuilder = chain.request().newBuilder()
                    .addHeader("Content-Type", "application/json")
                    .addHeader("Accept", "application/json")

                authToken?.let {
                    requestBuilder.addHeader("Authorization", "Bearer $it")
                }
                sessionId?.let {
                    requestBuilder.addHeader("X-Session-ID", it)
                }

                chain.proceed(requestBuilder.build())
            }
            .addInterceptor(logging)
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .build()
    }

    private var retrofitInstance: Retrofit? = null

    private fun getRetrofit(): Retrofit {
        if (retrofitInstance == null) {
            retrofitInstance = Retrofit.Builder()
                .baseUrl(currentBaseUrl)
                .client(okHttpClient)
                .addConverterFactory(GsonConverterFactory.create())
                .build()
        }
        return retrofitInstance!!
    }

    private var apiServiceInstance: BarPrepApiService? = null

    val service: BarPrepApiService
        get() {
            if (apiServiceInstance == null) {
                apiServiceInstance = getRetrofit().create(BarPrepApiService::class.java)
            }
            return apiServiceInstance!!
        }
}
