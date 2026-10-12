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
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import java.util.concurrent.Executors

/**
 * 配对页：手输地址+配对码，或扫码。
 *
 * 二维码内容是 `<base>/mobile-gateway/pair#<配对码>`，扫一次地址和码就都填好了。
 */
@Composable
fun PairScreen(
    busy: Boolean,
    onPair: (baseUrl: String, code: String, deviceName: String) -> Unit,
    deviceName: String,
) {
    var baseUrl by remember { mutableStateOf("") }
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
            "在电脑上打开 DSH 的「移动网关」面板（http://127.0.0.1:端口/mobile-gateway/manage），点「刷新配对码」。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Spacer(Modifier.height(4.dp))

        OutlinedTextField(
            value = baseUrl,
            onValueChange = { baseUrl = it.trim(); probe = null },
            label = { Text("电脑地址") },
            placeholder = { Text("http://192.168.1.10:19387") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )

        OutlinedTextField(
            value = code,
            onValueChange = { code = it.uppercase() },
            label = { Text("配对码") },
            placeholder = { Text("dshm1.XXXX-XXXX-XXXX-XXXX") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )

        if (probe != null) {
            Text(
                "网关可达：$probe",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.secondary,
            )
        }

        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Button(
                onClick = { scanning = true },
                enabled = !busy,
                modifier = Modifier.weight(1f),
            ) { Text("扫码") }
            Button(
                onClick = { onPair(baseUrl, code, deviceName) },
                enabled = !busy && baseUrl.isNotBlank() && code.length >= 16,
                modifier = Modifier.weight(1f),
            ) {
                if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                else Text("配对")
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