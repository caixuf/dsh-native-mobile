package io.github.dshmobile.app.ui.components

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import java.util.Locale

/**
 * 语音识别录入状态。
 */
@Stable
class VoiceInputState(
    private val context: Context,
    val onResult: (String) -> Unit,
) {
    var isListening by mutableStateOf(false)
        private set

    var isCancelling by mutableStateOf(false)

    var liveTranscript by mutableStateOf("")
        private set

    var rmsLevel by mutableFloatStateOf(0f)
        private set

    var errorMessage by mutableStateOf<String?>(null)
        private set

    private var recognizer: SpeechRecognizer? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    fun isAvailable(): Boolean = SpeechRecognizer.isRecognitionAvailable(context)

    fun start() {
        errorMessage = null
        liveTranscript = ""
        isCancelling = false
        rmsLevel = 0f

        mainHandler.post {
            try {
                recognizer?.destroy()
                val sr = SpeechRecognizer.createSpeechRecognizer(context)
                sr.setRecognitionListener(object : RecognitionListener {
                    override fun onReadyForSpeech(params: Bundle?) {
                        isListening = true
                    }

                    override fun onBeginningOfSpeech() {}

                    override fun onRmsChanged(rmsdB: Float) {
                        rmsLevel = ((rmsdB + 2f) / 12f).coerceIn(0.1f, 1f)
                    }

                    override fun onBufferReceived(buffer: ByteArray?) {}

                    override fun onEndOfSpeech() {}

                    override fun onError(error: Int) {
                        isListening = false
                        // 忽略静音或未识别到匹配的静默错误，避免频繁打扰用户
                        if (error != SpeechRecognizer.ERROR_NO_MATCH && error != SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
                            errorMessage = when (error) {
                                SpeechRecognizer.ERROR_AUDIO -> "音频录制异常"
                                SpeechRecognizer.ERROR_CLIENT -> "语音客户端异常"
                                SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "缺少录音权限"
                                SpeechRecognizer.ERROR_NETWORK -> "网络不可用"
                                else -> "语音识别暂不可用"
                            }
                        }
                    }

                    override fun onResults(results: Bundle?) {
                        isListening = false
                        val matches = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                        val text = matches?.firstOrNull()?.trim().orEmpty()
                        if (text.isNotBlank()) {
                            liveTranscript = text
                            if (!isCancelling) {
                                onResult(text)
                            }
                        }
                    }

                    override fun onPartialResults(partialResults: Bundle?) {
                        val matches = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                        val text = matches?.firstOrNull()?.trim().orEmpty()
                        if (text.isNotBlank()) {
                            liveTranscript = text
                        }
                    }

                    override fun onEvent(eventType: Int, params: Bundle?) {}
                })
                recognizer = sr

                val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.CHINESE.toLanguageTag())
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, Locale.CHINESE.toLanguageTag())
                    putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                    putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
                }
                sr.startListening(intent)
                isListening = true
            } catch (e: Exception) {
                isListening = false
                errorMessage = e.message ?: "启动语音识别失败"
            }
        }
    }

    fun stop(cancel: Boolean = false) {
        isCancelling = cancel
        mainHandler.post {
            try {
                if (cancel) {
                    recognizer?.cancel()
                    liveTranscript = ""
                } else {
                    recognizer?.stopListening()
                    // 如果已经有部分识别文字且未取消，先提交已有部分
                    if (liveTranscript.isNotBlank()) {
                        onResult(liveTranscript)
                    }
                }
                isListening = false
            } catch (_: Exception) {
                isListening = false
            }
        }
    }

    fun destroy() {
        mainHandler.post {
            try {
                recognizer?.destroy()
                recognizer = null
                isListening = false
            } catch (_: Exception) {}
        }
    }
}

@Composable
fun rememberVoiceInputState(onResult: (String) -> Unit): VoiceInputState {
    val context = LocalContext.current
    val state = remember { VoiceInputState(context.applicationContext, onResult) }

    DisposableEffect(Unit) {
        onDispose { state.destroy() }
    }
    return state
}
