package io.github.dshmobile.app.ui.screens

import io.github.dshmobile.app.ui.icons.DshIcons

import io.github.dshmobile.app.ui.components.DshIcon

import io.github.dshmobile.app.ui.components.ConnectionDot

import io.github.dshmobile.app.ui.DshTheme

import androidx.compose.material3.ButtonDefaults

import androidx.compose.material3.Surface
import androidx.compose.material3.OutlinedTextFieldDefaults

import androidx.compose.ui.text.font.FontFamily

import androidx.compose.ui.text.input.VisualTransformation

import androidx.compose.foundation.rememberScrollState

import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.verticalScroll

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
 * 配对页的输入框。
 *
 * 为什么不用 M3 默认的 `OutlinedTextField` + 浮动 label：
 * 浮动 label 在有值时缩到框里、会跳动，中文场景下尤其明显（占位与标签都是中文）。
 * 这里改成**标签固定在上方**，值区只放输入内容 —— 更稳，也更像设置页。
 *
 * @param monospace 地址这类技术值用等宽字体，便于核对端口号。
 */
@Composable
private fun PairField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    placeholder: String,
    keyboardType: KeyboardType,
    imeAction: ImeAction,
    isPassword: Boolean = false,
    monospace: Boolean = false,
) {
    Column {
        Text(
            label,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(6.dp))
        OutlinedTextField(
            value = value,
            onValueChange = onValueChange,
            placeholder = {
                Text(
                    placeholder,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.55f),
                )
            },
            singleLine = true,
            visualTransformation = if (isPassword) PasswordVisualTransformation()
            else VisualTransformation.None,
            textStyle = MaterialTheme.typography.bodyMedium.copy(
                fontFamily = if (monospace) FontFamily.Monospace else FontFamily.SansSerif,
            ),
            keyboardOptions = KeyboardOptions(
                keyboardType = keyboardType,
                imeAction = imeAction,
                autoCorrectEnabled = false,
            ),
            shape = MaterialTheme.shapes.medium,
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = MaterialTheme.colorScheme.primary,
                unfocusedBorderColor = MaterialTheme.colorScheme.outlineVariant,
                focusedContainerColor = MaterialTheme.colorScheme.surface,
                unfocusedContainerColor = MaterialTheme.colorScheme.surface,
            ),
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

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
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .imePadding()
            .padding(horizontal = DshTheme.m.xl, vertical = DshTheme.m.lg),
    ) {
        Spacer(Modifier.height(DshTheme.m.md))

        // ── 品牌区：说清「这是什么」 ──
        // 文案对齐逆向 MiniMax 移动端的 `computer_use_hero_title`
        // （= 像你一样操作你的本地电脑）：先讲清价值，再要用户填东西。
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier
                    .size(44.dp)
                    .background(
                        MaterialTheme.colorScheme.primaryContainer,
                        RoundedCornerShape(13.dp),
                    ),
                contentAlignment = Alignment.Center,
            ) {
                DshIcon(
                    DshIcons.Desktop,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                    size = 24.dp,
                )
            }
            Spacer(Modifier.width(DshTheme.m.md))
            Column {
                Text(
                    "连接你的电脑",
                    style = MaterialTheme.typography.headlineSmall,
                    color = MaterialTheme.colorScheme.onBackground,
                )
                Text(
                    "用手机遥控电脑上的 DSH，干活还是在电脑上",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        Spacer(Modifier.height(DshTheme.m.xl))

        // ── 输入区 ──
        // 🔴 onValueChange 里**不要**对值做 trim()/uppercase() 变换。
        // 早前写成了 `code = it.uppercase()` / `baseUrl = it.trim()`，
        // 每次输入都重建字符串，导致部分输入法下粘贴失效、光标跳动。
        // 正确做法：值原样保存，提交时才规范化。
        PairField(
            value = baseUrl,
            onValueChange = { baseUrl = it; probe = null },
            label = "电脑地址",
            placeholder = "https://203.0.113.10:2444",
            keyboardType = KeyboardType.Uri,
            imeAction = ImeAction.Next,
            monospace = true,
        )

        Spacer(Modifier.height(DshTheme.m.md))

        PairField(
            value = username,
            onValueChange = { username = it },
            label = "账号",
            placeholder = "dsh",
            keyboardType = KeyboardType.Text,
            imeAction = ImeAction.Next,
        )

        Spacer(Modifier.height(DshTheme.m.md))

        PairField(
            value = password,
            onValueChange = { password = it },
            label = "密码",
            placeholder = "管理面板上显示的 12 位密码",
            keyboardType = KeyboardType.Password,
            imeAction = ImeAction.Done,
            isPassword = true,
        )

        // 地址探测结果：让用户填完地址就知道通没通，而不是直接点登录碰运气
        probe?.let {
            Spacer(Modifier.height(DshTheme.m.sm))
            Row(verticalAlignment = Alignment.CenterVertically) {
                ConnectionDot(connected = true, size = 6.dp)
                Spacer(Modifier.width(7.dp))
                Text(
                    "网关可达 · $it",
                    style = MaterialTheme.typography.labelMedium,
                    color = DshTheme.online,
                )
            }
        }

        // 🔴 早前根本没渲染 error：登录失败（TLS 拒绝、超时、密码错）时页面
        // 纹丝不动，用户只能干等。实测（公网 2444 端口）踩中过一次。
        if (error != null) {
            Spacer(Modifier.height(DshTheme.m.md))
            Surface(
                color = MaterialTheme.colorScheme.errorContainer,
                shape = MaterialTheme.shapes.small,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Row(
                    Modifier.padding(DshTheme.m.md),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    DshIcon(
                        DshIcons.Warning,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onErrorContainer,
                        size = 16.dp,
                    )
                    Spacer(Modifier.width(DshTheme.m.sm))
                    Text(
                        error,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onErrorContainer,
                    )
                }
            }
        }

        Spacer(Modifier.height(DshTheme.m.xl))

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
            shape = MaterialTheme.shapes.medium,
            colors = ButtonDefaults.buttonColors(
                containerColor = MaterialTheme.colorScheme.primary,
                contentColor = MaterialTheme.colorScheme.onPrimary,
            ),
            modifier = Modifier
                .fillMaxWidth()
                .height(50.dp),
        ) {
            if (busy) {
                CircularProgressIndicator(
                    modifier = Modifier.size(18.dp),
                    strokeWidth = 2.dp,
                    color = MaterialTheme.colorScheme.onPrimary,
                )
                Spacer(Modifier.width(DshTheme.m.sm))
                Text("正在连接电脑…", style = MaterialTheme.typography.labelLarge)
            } else {
                Text("连接", style = MaterialTheme.typography.labelLarge)
            }
        }

        Spacer(Modifier.height(DshTheme.m.md))

        // 备选入口：配对码 / 扫码，收在折叠区里，不占主流程
        var showAdvanced by remember { mutableStateOf(false) }
        TextButton(
            onClick = { showAdvanced = !showAdvanced },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(
                if (showAdvanced) "收起备选方式" else "用配对码 / 扫码（备选）",
                style = MaterialTheme.typography.labelMedium,
            )
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