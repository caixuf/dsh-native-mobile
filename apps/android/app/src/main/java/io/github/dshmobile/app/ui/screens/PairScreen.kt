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
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.TabRowDefaults
import androidx.compose.material3.TabRowDefaults.tabIndicatorOffset
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import io.github.dshmobile.app.ui.DshTheme
import io.github.dshmobile.app.ui.components.ConnectionDot
import io.github.dshmobile.app.ui.components.DshIcon
import io.github.dshmobile.app.ui.icons.DshIcons
import java.util.concurrent.Executors

/**
 * 配对页输入框。
 * 标签固定在上方，值区只放输入内容。
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
 * 6 位数字配对码独立卡槽输入组件（对齐 MiniMax 极简连接体验）。
 */
@Composable
private fun PinInputBoxes(
    pin: String,
    onPinChange: (String) -> Unit,
    length: Int = 6,
    modifier: Modifier = Modifier,
) {
    val focusRequester = remember { FocusRequester() }

    Box(modifier = modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        // 捕获真实输入事件的隐藏输入框
        BasicTextField(
            value = pin,
            onValueChange = { input ->
                val filtered = input.filter { it.isDigit() }.take(length)
                onPinChange(filtered)
            },
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Number,
                imeAction = ImeAction.Done,
            ),
            modifier = Modifier
                .size(1.dp)
                .alpha(0.01f)
                .focusRequester(focusRequester),
        )

        // 6 个独立展示的圆角卡槽
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .clickable { focusRequester.requestFocus() }
                .padding(vertical = 6.dp),
        ) {
            for (i in 0 until length) {
                val digit = pin.getOrNull(i)?.toString() ?: ""
                val isFocused = pin.length == i || (i == length - 1 && pin.length == length)

                Surface(
                    shape = RoundedCornerShape(10.dp),
                    color = MaterialTheme.colorScheme.surface,
                    border = androidx.compose.foundation.BorderStroke(
                        if (isFocused) 2.dp else 1.dp,
                        if (isFocused) MaterialTheme.colorScheme.primary
                        else MaterialTheme.colorScheme.outlineVariant,
                    ),
                    modifier = Modifier.size(width = 44.dp, height = 52.dp),
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Text(
                            text = digit,
                            style = MaterialTheme.typography.titleLarge.copy(
                                fontWeight = FontWeight.Bold,
                                fontSize = 22.sp,
                                fontFamily = FontFamily.Monospace,
                            ),
                            color = MaterialTheme.colorScheme.onSurface,
                        )
                    }
                }
            }
        }
    }
}

/**
 * 配对 / 连接页。
 *
 * 支持两种首选方式：
 *  1. **6位数字配对码**（极速连接，无需复杂密码，对齐 MiniMax 交互）；
 *  2. **账号密码登录**（持久管理密码）。
 */
@Composable
fun PairScreen(
    busy: Boolean,
    error: String?,
    onLogin: (baseUrl: String, username: String, password: String, deviceName: String) -> Unit,
    onPair: (baseUrl: String, code: String, deviceName: String) -> Unit,
    deviceName: String,
    onBack: (() -> Unit)? = null,
) {
    var selectedTab by remember { mutableIntStateOf(0) } // 0: 6位数字配对, 1: 账号密码
    var baseUrl by remember { mutableStateOf("") }
    var pin by remember { mutableStateOf("") }
    var username by remember { mutableStateOf("dsh") }
    var password by remember { mutableStateOf("") }
    var scanning by remember { mutableStateOf(false) }
    var probe by remember { mutableStateOf<String?>(null) }

    val context = LocalContext.current
    val scannerExecutor = remember { Executors.newSingleThreadExecutor() }

    DisposableEffect(Unit) {
        onDispose { scannerExecutor.shutdown() }
    }

    if (onBack != null) {
        androidx.activity.compose.BackHandler(onBack = onBack)
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .imePadding()
            .padding(horizontal = DshTheme.m.xl, vertical = DshTheme.m.lg),
    ) {
        // 返回按钮
        if (onBack != null) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .clickable { onBack() }
                    .padding(vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = onBack) {
                    DshIcon(
                        DshIcons.ArrowBack,
                        contentDescription = "返回",
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        size = 22.dp,
                    )
                }
                Spacer(Modifier.width(4.dp))
                Text(
                    "返回主机列表",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(Modifier.height(DshTheme.m.sm))
        } else {
            Spacer(Modifier.height(DshTheme.m.md))
        }

        // ── 品牌区 ──
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier
                    .size(46.dp)
                    .background(
                        MaterialTheme.colorScheme.primaryContainer,
                        RoundedCornerShape(14.dp),
                    ),
                contentAlignment = Alignment.Center,
            ) {
                DshIcon(
                    DshIcons.Desktop,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                    size = 25.dp,
                )
            }
            Spacer(Modifier.width(DshTheme.m.md))
            Column {
                Text(
                    "连接你的电脑",
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onBackground,
                )
                Text(
                    "手机作为遥控器，在本地电脑上执行工作流",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        Spacer(Modifier.height(DshTheme.m.lg))

        // ── 模式切换 TabRow ──
        TabRow(
            selectedTabIndex = selectedTab,
            containerColor = MaterialTheme.colorScheme.surfaceContainer,
            contentColor = MaterialTheme.colorScheme.primary,
            indicator = { tabPositions ->
                TabRowDefaults.SecondaryIndicator(
                    modifier = Modifier.tabIndicatorOffset(tabPositions[selectedTab]),
                    color = MaterialTheme.colorScheme.primary,
                )
            },
        ) {
            Tab(
                selected = selectedTab == 0,
                onClick = { selectedTab = 0 },
                text = {
                    Text(
                        "6位数字配对",
                        style = MaterialTheme.typography.labelLarge,
                        fontWeight = if (selectedTab == 0) FontWeight.Bold else FontWeight.Normal,
                    )
                },
            )
            Tab(
                selected = selectedTab == 1,
                onClick = { selectedTab = 1 },
                text = {
                    Text(
                        "账号密码登录",
                        style = MaterialTheme.typography.labelLarge,
                        fontWeight = if (selectedTab == 1) FontWeight.Bold else FontWeight.Normal,
                    )
                },
            )
        }

        Spacer(Modifier.height(DshTheme.m.lg))

        // ── 电脑主机地址 ──
        PairField(
            value = baseUrl,
            onValueChange = { baseUrl = it; probe = null },
            label = "电脑网关地址",
            placeholder = "http://192.168.x.x:2444 或 https://...",
            keyboardType = KeyboardType.Uri,
            imeAction = ImeAction.Next,
            monospace = true,
        )

        // 探测结果
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

        Spacer(Modifier.height(DshTheme.m.md))

        // ── 选项卡 0：6位数字配对 ──
        if (selectedTab == 0) {
            Text(
                "电脑端 6 位数字配对码",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(6.dp))

            PinInputBoxes(
                pin = pin,
                onPinChange = { pin = it },
                length = 6,
            )

            Spacer(Modifier.height(8.dp))
            Text(
                "在电脑运行网关并在管理面板查看 6 位数配对码，或使用下方扫码",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
            )

            Spacer(Modifier.height(DshTheme.m.lg))

            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedButton(
                    onClick = { scanning = true },
                    enabled = !busy,
                    shape = MaterialTheme.shapes.medium,
                    modifier = Modifier
                        .weight(1f)
                        .height(48.dp),
                ) {
                    DshIcon(
                        DshIcons.QrCode,
                        contentDescription = null,
                        size = 18.dp,
                    )
                    Spacer(Modifier.width(6.dp))
                    Text("扫码配对")
                }

                Button(
                    onClick = { onPair(baseUrl.trim(), pin.trim(), deviceName) },
                    enabled = !busy && baseUrl.isNotBlank() && (pin.length == 6 || pin.length >= 16),
                    shape = MaterialTheme.shapes.medium,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.primary,
                        contentColor = MaterialTheme.colorScheme.onPrimary,
                    ),
                    modifier = Modifier
                        .weight(1.3f)
                        .height(48.dp),
                ) {
                    if (busy) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(18.dp),
                            strokeWidth = 2.dp,
                            color = MaterialTheme.colorScheme.onPrimary,
                        )
                        Spacer(Modifier.width(DshTheme.m.sm))
                        Text("正在配对…")
                    } else {
                        Text("立即配对", fontWeight = FontWeight.SemiBold)
                    }
                }
            }
        } else {
            // ── 选项卡 1：账号密码登录 ──
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

            Spacer(Modifier.height(DshTheme.m.lg))

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
                    .height(48.dp),
            ) {
                if (busy) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(18.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onPrimary,
                    )
                    Spacer(Modifier.width(DshTheme.m.sm))
                    Text("正在连接…")
                } else {
                    Text("登录并连接", fontWeight = FontWeight.SemiBold)
                }
            }
        }

        // 错误提示条
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

        // 扫码弹层
        if (scanning) {
            QrScannerSheet(
                onResult = { raw ->
                    scanning = false
                    val target = io.github.dshmobile.app.net.PairingClient.parsePairingTarget(raw)
                    if (target != null) {
                        baseUrl = target.baseUrl
                        if (target.code.isNotBlank()) {
                            pin = target.code
                            selectedTab = 0
                        }
                    } else {
                        if (raw.startsWith("dshm") || raw.startsWith("DSHM") || raw.all { it.isDigit() }) {
                            pin = raw
                            selectedTab = 0
                        } else {
                            baseUrl = raw.trim()
                        }
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