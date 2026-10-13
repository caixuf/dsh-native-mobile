package io.github.dshmobile.app.ui.screens

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.ImeAction
import androidx.core.content.ContextCompat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import java.util.concurrent.Executors

/**
 * 配对 / 登录页。
 *
 * **主流程是账号密码**（用户反馈配对码要复制 22 位太麻烦）：
 * 电脑端管理面板显示账号与密码，手机上三个输入框填完点登录。
 *
 * 配对码与扫码收在「备选」折叠区，保留给不方便看密码的场景。
 */
@Composable
fun PairScreen(
    busy: Boolean,
    error: String?,
    onLogin: (baseUrl: String, username: String, password: String, deviceName: String) -> Unit,
    onPair: (baseUrl: String, code: String, deviceName: String) -> Unit,
    deviceName: String,
) {
    var baseUrl by remember { mutableStateOf("") }
    var username by remember { mutableStateOf("dsh") }
    var password by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var scanning by remember { mutableStateOf(false) }
    var probe by remember { mutableStateOf<String?>(null) }

    val context = LocalContext.current
    val scannerExecutor = remember { Executors.newSingleThreadExecutor() }

    DisposableEffect(Unit) {
        onDispose { scannerExecutor.shutdown() }
    }

    Column(
        modifier = Modifier.fillMaxSize().padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("配对电脑", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
        Text(
            "在电脑上打开 DSH 的「移动网关」面板，把上面的账号密码填进来就行。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Spacer(Modifier.height(4.dp))

        // 🔴 onValueChange 里**不要**对值做 trim()/uppercase() 变换。
        // 早前写成了 `code = it.uppercase()` / `baseUrl = it.trim()`，
        // 每次输入都重建字符串，导致部分输入法下粘贴失效、光标跳动。
        // 正确做法：值原样保存，提交时才规范化。
        OutlinedTextField(
            value = baseUrl,
            onValueChange = { baseUrl = it; probe = null },
            label = { Text("电脑地址") },
            placeholder = { Text("https://203.0.113.10:2444") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Uri,
                imeAction = ImeAction.Next,
                autoCorrectEnabled = false,
            ),
            modifier = Modifier.fillMaxWidth(),
        )

        OutlinedTextField(
            value = username,
            onValueChange = { username = it },
            label = { Text("账号") },
            placeholder = { Text("dsh") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Text,
                imeAction = ImeAction.Next,
                autoCorrectEnabled = false,
            ),
            modifier = Modifier.fillMaxWidth(),
        )

        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            label = { Text("密码") },
            placeholder = { Text("管理面板上显示的 12 位密码") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Password,
                imeAction = ImeAction.Done,
                autoCorrectEnabled = false,
            ),
            modifier = Modifier.fillMaxWidth(),
        )

        if (probe != null) {
            Text(
                "网关可达：$probe",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.secondary,
            )
        }

        // 🔴 早前根本没渲染 error：登录失败（TLS 拒绝、超时、密码错）时页面
        // 纹丝不动，用户只能干等。实测（公网 2444 端口）踩中过一次。
        if (error != null) {
            Text(
                error,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.fillMaxWidth(),
            )
        }

        Button(
            onClick = {
                onLogin(
                    baseUrl.trim(),
                    username.trim(),
                    password,
                    deviceName,
                )
            },
            enabled = !busy &&
                baseUrl.isNotBlank() &&
                username.isNotBlank() &&
                password.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
        ) {
            if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
            else Text("登录")
        }

        // 备选入口：配对码 / 扫码，收在折叠区里，不占主流程
        var showAdvanced by remember { mutableStateOf(false) }
        TextButton(onClick = { showAdvanced = !showAdvanced }) {
            Text(if (showAdvanced) "收起备选方式" else "用配对码 / 扫码（备选）")
        }

        if (showAdvanced) {
            OutlinedTextField(
                value = code,
                onValueChange = { code = it },
                label = { Text("配对码") },
                placeholder = { Text("dshm1.XXXX-XXXX-XXXX-XXXX") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(autoCorrectEnabled = false),
                modifier = Modifier.fillMaxWidth(),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedButton(
                    onClick = { scanning = true },
                    enabled = !busy,
                    modifier = Modifier.weight(1f),
                ) { Text("扫码") }
                Button(
                    onClick = { onPair(baseUrl.trim(), code.trim(), deviceName) },
                    enabled = !busy && baseUrl.isNotBlank() && code.length >= 16,
                    modifier = Modifier.weight(1f),
                ) { Text("配对") }
            }
        }

        if (scanning) {
            QrScannerSheet(
                onResult = { raw ->
                    scanning = false
                    val target = io.github.dshmobile.app.net.PairingClient.parsePairingTarget(raw)
                    if (target != null) {
                        baseUrl = target.baseUrl
                        if (target.code.isNotBlank()) code = target.code
                    } else {
                        // 只扫到码或只扫到裸地址，都接受。
                        if (raw.startsWith("dshm") || raw.startsWith("DSHM")) code = raw.uppercase() else baseUrl = raw.trim()
                    }
                },
                onCancel = { scanning = false },
                executor = scannerExecutor,
            )
        }
    }
}

@Composable
private fun QrScannerSheet(
    onResult: (String) -> Unit,
    onCancel: () -> Unit,
    executor: java.util.concurrent.Executor,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    var hasPermission by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED,
        )
    }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        hasPermission = granted
    }
    LaunchedEffect(Unit) {
        if (!hasPermission) launcher.launch(Manifest.permission.CAMERA)
    }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        if (hasPermission) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { ctx ->
                    val previewView = PreviewView(ctx)
                    val providerFuture = ProcessCameraProvider.getInstance(ctx)
                    providerFuture.addListener({
                        val provider = providerFuture.get()
                        val preview = Preview.Builder().build().also {
                            it.surfaceProvider = previewView.surfaceProvider
                        }
                        val analysis = ImageAnalysis.Builder()
                            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                            .build()
                        val reader = MultiFormatReader()
                        val hints = mapOf(DecodeHintType.TRY_HARDER to true)
                        var consumed = false
                        analysis.setAnalyzer(executor) { proxy: ImageProxy ->
                            if (consumed) {
                                proxy.close()
                                return@setAnalyzer
                            }
                            val decoded = decodeQr(proxy, reader, hints)
                            if (decoded != null) {
                                consumed = true
                                onResult(decoded)
                            }
                            proxy.close()
                        }
                        provider.unbindAll()
                        provider.bindToLifecycle(
                            lifecycleOwner,
                            CameraSelector.DEFAULT_BACK_CAMERA,
                            preview,
                            analysis,
                        )
                    }, ContextCompat.getMainExecutor(ctx))
                    previewView
                },
            )
            Box(
                Modifier
                    .align(Alignment.Center)
                    .size(240.dp)
                    .border(2.dp, Color.White, RoundedCornerShape(16.dp)),
            )
        } else {
            Text(
                "需要相机权限才能扫码，你也可以手动输入。",
                color = Color.White,
                modifier = Modifier.align(Alignment.Center).padding(24.dp),
            )
        }
        Button(
            onClick = onCancel,
            modifier = Modifier.align(Alignment.BottomCenter).padding(24.dp),
        ) { Text("返回") }
    }
}

private fun decodeQr(
    proxy: ImageProxy,
    reader: MultiFormatReader,
    hints: Map<DecodeHintType, Any>,
): String? = runCatching {
    val plane = proxy.planes[0]
    val bytes = ByteArray(plane.buffer.remaining())
    plane.buffer.get(bytes)
    val source = PlanarYUVLuminanceSource(
        bytes,
        plane.rowStride,
        proxy.height,
        0,
        0,
        proxy.width.coerceAtMost(plane.rowStride),
        proxy.height,
        false,
    )
    reader.reset()
    reader.decode(BinaryBitmap(HybridBinarizer(source)), hints)?.text
}.getOrNull()