package io.github.dshmobile.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// ════════════════════════════════════════════════════════════════════════════
// 设计语言：逆向自两个真实参照物
//
// 【A】MiniMax 移动端（com.xproducer.yingshiai v4.20.4）
//     反编译 assets/chatcore_android/**/*.css，提取到 2184 个 CSS 变量、
//     228 个颜色变量。它的 UI 是内嵌 Next.js（shadcn/ui 体系），
//     所以设计系统**完整暴露在 CSS 里**——这是最硬的一手素材。
//
// 【B】DSH Web 客户端（app.asar → @deepseek-ai/dsh-client-ui-theme）
//     目标：让手机端**看起来就是同一个产品**，而不是"另一个 App"。
//
// ── A 提取到的原始 token ────────────────────────────────────────────────────
//   蓝阶  25 #f5fbff · 50 #e5f5ff · 75 #c4e7ff · 100 #93d2ff · 200 #68c0ff
//        300 #3daeff · 400 #0094fc · 500 #0077d9 · 600 #005fb8
//        700 #004b96 · 800 #00244d · 900 #001226 · 1000 #000c14
//   主按钮蓝 #0060df（hover #6fb3fc）    状态蓝 rgba(0,120,255,.102)
//   圆角  4 8 12 16 20 24 32 px · 基准 .625rem=10px · pill 999px
//   字号  14px(主力,61次) 12(31) 16(25) 13(15) 20(12) 11(10) 18(10) 17(9)
//   字体  系统栈：-apple-system … "PingFang SC","miui","Hiragino Sans GB"
//   卡片  亮 #fff · 暗 oklch(.145 0 0) ≈ #252525（**不是纯黑**，是抬升灰）
//   阴影  几乎不用；靠 --opacity_black_1_8 的极淡黑色叠加分层
//   聊天  --chat-list-width:792px · --chat-input-height:110/146px
//
// ── B 提取到的原始 token ────────────────────────────────────────────────────
//   主色 #3964fe/#4176e6   正文 #151517   底 #f9fafb
//   成功 #22c55e  警示 #f59e0b  边框 #e5e5e5
//
// 两条原则：
//   1. 视觉改动**只在这里做**，别到各 Screen 散着写颜色。
//   2. 它俩都是"蓝主色 + 中性灰阶 + 1px 边框分层"，所以我们统一走这套。
// ════════════════════════════════════════════════════════════════════════════

// ── 蓝阶（源自 MiniMax，亮度分段对齐它的 25/50/75/100/200/300/400/500/600/700）──
private val Blue025 = Color(0xFFF5FBFF)
private val Blue050 = Color(0xFFE5F5FF)
private val Blue075 = Color(0xFFC4E7FF)
private val Blue100 = Color(0xFF93D2FF)
private val Blue200 = Color(0xFF68C0FF)
private val Blue300 = Color(0xFF3DAEFF)
private val Blue400 = Color(0xFF0094FC)
private val Blue500 = Color(0xFF0077D9)   // MiniMax blue_500
private val Blue550 = Color(0xFF0060DF)   // MiniMax 按钮主蓝
private val Blue600 = Color(0xFF005FB8)
private val Blue700 = Color(0xFF004B96)

// ── DSH 品牌蓝（Web 端），与上面对齐成同一族 ─────────────────────────────────
private val DshBlue = Color(0xFF3964FE)

// ── 中性阶：MiniMax 用 oklch 无彩色阶；DSH Web 端是纯灰不带蓝调 ──────────────
// 关键：两端都**不用 slate 偏蓝灰**，之前那版用了，是"廉价感"的一大来源。
private val N0 = Color(0xFFFFFFFF)
private val N25 = Color(0xFFFAFAFA)
private val N50 = Color(0xFFF5F5F5)   // MiniMax gray_75
private val N75 = Color(0xFFF5F6F7)
private val N100 = Color(0xFFF1F3F5)
private val N150 = Color(0xFFEDEEF2)
private val N200 = Color(0xFFE5E5E5)  // 边框主色
private val N300 = Color(0xFFD4D4D4)
private val N400 = Color(0xFFA9ACB5)
private val N500 = Color(0xFF717182)  // muted-foreground
private val N600 = Color(0xFF52525E)

private val D950 = Color(0xFF111113)
private val D900 = Color(0xFF151517)   // DSH Web 正文色
private val D850 = Color(0xFF1A1A1A)
private val D800 = Color(0xFF202023)
private val D750 = Color(0xFF252527)   // MiniMax --card 暗色 ≈ #252525
private val D700 = Color(0xFF2C2C2E)
private val D600 = Color(0xFF3C3C3D)   // 暗色下的边框
private val D500 = Color(0xFF525256)
private val D300 = Color(0xFF8A8D96)

// ── 语义色（MiniMax 红/绿/黄 + DSH Web 绿）──────────────────────────────────
private val Success = Color(0xFF22C55E)   // DSH Web #22c55e
private val SuccessSoft = Color(0xFF4ED082) // MiniMax green_200
private val Warning = Color(0xFFE09900)   // MiniMax yellow_500
private val WarningBright = Color(0xFFF7AD31)
private val Danger = Color(0xFFE31937)    // MiniMax red_500
private val DangerBright = Color(0xFFF73646)

// ── 亮色方案 ───────────────────────────────────────────────────────────────
private val LightColors = lightColorScheme(
    primary = Blue550,
    onPrimary = N0,
    primaryContainer = Blue050,
    onPrimaryContainer = Blue700,

    secondary = N600,
    onSecondary = N0,
    secondaryContainer = N100,
    onSecondaryContainer = D900,

    tertiary = Warning,
    onTertiary = N0,
    tertiaryContainer = Color(0xFFFFF9ED),
    onTertiaryContainer = Color(0xFF311908),

    background = N50,
    onBackground = D900,
    surface = N0,                    // 卡片纯白（MiniMax --card: #fff）
    onSurface = D900,
    surfaceVariant = N100,
    onSurfaceVariant = N500,
    surfaceContainerLowest = N0,
    surfaceContainerLow = N25,
    surfaceContainer = N50,
    surfaceContainerHigh = N75,
    surfaceContainerHighest = N100,

    outline = N300,
    outlineVariant = N200,            // 边框主色
    inverseSurface = D900,
    inverseOnSurface = N0,

    error = Danger,
    onError = N0,
    errorContainer = Color(0xFFFEEDEE), // MiniMax red_50
    onErrorContainer = Color(0xFF140003),

    scrim = Color(0x33000000),        // MiniMax --opacity_black_1_20 ≈ .2，这里略重一点便于阅读
)

// ── 暗色方案 ───────────────────────────────────────────────────────────────
private val DarkColors = darkColorScheme(
    primary = Blue200,
    onPrimary = Color(0xFF001226),
    primaryContainer = Blue700,
    onPrimaryContainer = Blue075,

    secondary = D300,
    onSecondary = D950,
    secondaryContainer = D700,
    onSecondaryContainer = Color(0xFFEDEEF2),

    tertiary = WarningBright,
    onTertiary = Color(0xFF311908),
    tertiaryContainer = Color(0xFF3C2A10),
    onTertiaryContainer = Color(0xFFFFF9ED),

    background = D950,
    onBackground = Color(0xFFE5E5E5),
    surface = D850,
    onSurface = Color(0xFFE5E5E5),
    surfaceVariant = D700,
    onSurfaceVariant = D300,
    surfaceContainerLowest = D950,
    surfaceContainerLow = D900,
    surfaceContainer = D850,
    surfaceContainerHigh = D800,
    surfaceContainerHighest = D750,

    outline = D600,
    outlineVariant = D700,
    inverseSurface = N0,
    inverseOnSurface = D900,

    error = DangerBright,
    onError = Color(0xFF3C1F1B),
    errorContainer = Color(0xFF570C0C),
    onErrorContainer = Color(0xFFFEF2F2),

    scrim = Color(0x66000000),
)

// ── 排版体系 ───────────────────────────────────────────────────────────────
// MiniMax 的字号分布（按 CSS 出现频次）：14px(61) 12(31) 16(25) 13(15)
// 20(12) 11(10) 18(10) 17(9) —— **14 是绝对主力**。
//
// 手机上 12px 中文偏小，所以下限抬到 13；但**保持 14 为主力**这个比例，
// 否则会退回"标题巨大、正文很小"的通用 App 观感。
private val FontStack = FontFamily.SansSerif

private val Tight = LineHeightStyle(
    alignment = LineHeightStyle.Alignment.Center,
    trim = LineHeightStyle.Trim.None,
)

private fun style(
    size: Int,
    line: Int,
    weight: FontWeight = FontWeight.Normal,
    tracking: Double = 0.0,
) = TextStyle(
    fontFamily = FontStack,
    fontWeight = weight,
    fontSize = size.sp,
    lineHeight = line.sp,
    letterSpacing = tracking.sp,
    lineHeightStyle = Tight,
)

private val DshTypography = Typography(
    displaySmall = style(30, 36, FontWeight.SemiBold, -0.4),
    headlineMedium = style(25, 31, FontWeight.SemiBold, -0.3),
    headlineSmall = style(21, 27, FontWeight.SemiBold, -0.2),
    titleLarge = style(19, 25, FontWeight.SemiBold, -0.1),
    titleMedium = style(16, 22, FontWeight.Medium),
    titleSmall = style(15, 21, FontWeight.Medium),
    bodyLarge = style(16, 24),
    bodyMedium = style(14, 22),     // ← 主力（对齐 MiniMax 14px）
    bodySmall = style(13, 19),      // ← 次要（MiniMax 12px 上抬一档，中文可读）
    labelLarge = style(14, 19, FontWeight.Medium),
    labelMedium = style(13, 17, FontWeight.Medium),
    labelSmall = style(12, 16),     // 时间戳/计数
)

// ── 形状 ───────────────────────────────────────────────────────────────────
// MiniMax：4 8 12 16 20 24 32 px · 基准 10px · pill 999
// Compose 的 Shapes 只有 5 档，把 5 个槽位映射到它最常用的 4/8/12/16/20
private val DshShapes = Shapes(
    extraSmall = RoundedCornerShape(4.dp),
    small = RoundedCornerShape(8.dp),
    medium = RoundedCornerShape(12.dp),
    large = RoundedCornerShape(16.dp),
    extraLarge = RoundedCornerShape(20.dp),
)

/**
 * 间距与尺度。
 *
 * 之前各 Screen 里散着硬编码 12/16/24.dp，导致同类元素在不同页差 4px ——
 * 这种"不齐"比配色难看得多，是廉价感的主要来源。
 *
 * 另附 MiniMax 的两个关键尺度（它对聊天页有明确约束，值得借鉴）：
 *   - 会话/聊天内容最大宽度 792px（手机上退化为 100%）
 *   - 输入区高度 110px（英文）/ 146px（中文）—— 中文要多 36px，因为换行更多
 */
@Immutable
data class DshMetrics(
    val xxs: Dp = 2.dp,
    val xs: Dp = 4.dp,
    val sm: Dp = 8.dp,
    val md: Dp = 12.dp,
    val lg: Dp = 16.dp,
    val xl: Dp = 20.dp,
    val xxl: Dp = 28.dp,
    /** 屏幕左右安全边距，全局统一 */
    val gutter: Dp = 16.dp,
    /** 列表项之间的间隙 */
    val listGap: Dp = 10.dp,
    /** 触控目标下限（可访问性） */
    val tapTarget: Dp = 48.dp,
    /** 内容最大宽度（对齐 MiniMax 792px 的意图：长文本不铺满整行） */
    val contentMaxWidth: Dp = 720.dp,
)

val LocalDshMetrics = staticCompositionLocalOf { DshMetrics() }

object DshTheme {
    val m: DshMetrics
        @Composable @ReadOnlyComposable get() = LocalDshMetrics.current

    /** 品牌蓝（MiniMax 主按钮蓝 #0060df） */
    val brand: Color
        @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.primary

    /** DSH Web 端的品牌蓝，用于需要与 Web 端呼应的位置 */
    val dshBlue: Color
        @Composable @ReadOnlyComposable get() = DshBlue

    /** 极淡的黑色叠加（MiniMax 不用阴影，用它分层） */
    val overlayWeak: Color
        @Composable @ReadOnlyComposable get() =
            if (isSystemInDarkTheme()) Color(0x14FFFFFF) else Color(0x14000000)

    val online: Color
        @Composable @ReadOnlyComposable get() = Success

    val offline: Color
        @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.onSurfaceVariant

    // ── Markdown 专用 token ────────────────────────────────────────────────
    // 正文尺寸沿用 DSH Web 的 `--dsh-content-font-size:14px` / `line-height:22px`，
    // 这组比例在中文下可读性最好。
    val markdownSize
        @Composable @ReadOnlyComposable get() = 14.5.sp
    val markdownLineHeight
        @Composable @ReadOnlyComposable get() = 22.sp

    /** Markdown 正文色：比 `onSurface` 略降一档，长文不刺眼。 */
    val markdownBody: Color
        @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.onSurface

    /** 代码块底色。用 `surfaceContainerHigh`，与整体底色拉开但不突兀。 */
    val codeBg: Color
        @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.surfaceContainerHigh

    /** 代码文字色。 */
    val codeText: Color
        @Composable @ReadOnlyComposable get() = MaterialTheme.colorScheme.onSurface

    /**
     * 代码块文字样式：等宽 + 略小字号。
     *
     * 单独做成 token 是因为代码块与正文是**两套排版**（Web 端同样如此）：
     * 正文 14/22，代码 13/20 且等宽 —— 等宽字体天然显得更大，不缩一点会挤。
     */
    val codeTextStyle: TextStyle
        @Composable @ReadOnlyComposable get() = TextStyle(
            fontFamily = FontFamily.Monospace,
            fontSize = 13.sp,
            lineHeight = 20.sp,
        )

    /** 链接色：跟随主色，但略深一点以满足对比度。 */
    val markdownLink: Color
        @Composable @ReadOnlyComposable get() =
            if (isSystemInDarkTheme()) Blue200 else Blue600
}

/**
 * 主题偏好模式：跟随系统 / 浅色模式 / 深色模式。
 */
enum class ThemeMode(val label: String) {
    System("跟随系统"),
    Light("浅色"),
    Dark("深色"),
}

object ThemePreferences {
    var currentMode: ThemeMode by mutableStateOf(ThemeMode.System)
}

@Composable
fun DshMobileTheme(
    themeMode: ThemeMode = ThemePreferences.currentMode,
    darkTheme: Boolean = when (themeMode) {
        ThemeMode.System -> isSystemInDarkTheme()
        ThemeMode.Light -> false
        ThemeMode.Dark -> true
    },
    content: @Composable () -> Unit,
) {
    CompositionLocalProvider(LocalDshMetrics provides DshMetrics()) {
        MaterialTheme(
            colorScheme = if (darkTheme) DarkColors else LightColors,
            typography = DshTypography,
            shapes = DshShapes,
            content = content,
        )
    }
}

/**
 * 具有微妙光照层次与深度的工作区壁纸底衬。
 *
 * 对齐高端 AI Studio 界面（非单调平面白/黑板）：
 * 顶部环境光晕 + 右下极弱氛围辅光 + 统一背景分层。
 */
@Composable
fun AmbientWallpaper(
    modifier: Modifier = Modifier,
    content: @Composable BoxScope.() -> Unit,
) {
    val isDark = isSystemInDarkTheme()
    val bgBase = MaterialTheme.colorScheme.background
    val brandGlow = MaterialTheme.colorScheme.primary.copy(alpha = if (isDark) 0.08f else 0.045f)
    val secondaryGlow = MaterialTheme.colorScheme.secondary.copy(alpha = if (isDark) 0.04f else 0.025f)

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(bgBase)
            .drawBehind {
                // 顶部中心柔和辐射光晕
                drawRect(
                    brush = Brush.radialGradient(
                        colors = listOf(brandGlow, Color.Transparent),
                        center = Offset(size.width * 0.5f, -size.height * 0.1f),
                        radius = size.width * 0.95f,
                    )
                )
                // 底部次级漫反射氛围
                drawRect(
                    brush = Brush.radialGradient(
                        colors = listOf(secondaryGlow, Color.Transparent),
                        center = Offset(size.width * 0.85f, size.height * 0.9f),
                        radius = size.width * 0.8f,
                    )
                )
            },
        content = content,
    )
}

