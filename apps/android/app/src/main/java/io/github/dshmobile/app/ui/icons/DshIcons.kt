package io.github.dshmobile.app.ui.icons

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp

/**
 * 自绘图标集。
 *
 * ## 为什么不直接用 Material Icons
 *
 * 逆向 MiniMax 移动端（`com.xproducer.yingshiai`）发现它 **527 个自有 drawable
 * 里有一套自建 UIKit，完全不用 Material Icons**。从 `res/drawable/uikit_*.xml`
 * 提取到的规范：
 *
 * | 项 | 值 |
 * |---|---|
 * | 网格 | **24×24**（即使命名带 `20`，画布仍是 24 网格） |
 * | 圆形按钮画布 | 32×32 |
 * | 描边图标 | `strokeWidth = 1.5`，`strokeLineCap = round`，`strokeLineJoin = round` |
 * | 填充图标 | 单条 path，`fillColor = #ff171717`（其 `gray_1000`） |
 * | 颜色 | **不设 `android:tint`**，直接引用语义色（如 `@color/icon_default_inverted`） |
 * | 命名 | `uikit_{语义}_{尺寸}ic`，语义在前（send / add / desktop / chats） |
 *
 * 规范背后的一致性原则：
 *  1. **网格统一** —— 所有图标视觉重量一致，混排不跳；
 *  2. **描边而非双色** —— 单色图标靠语义色着色，避免多色图标在暗色下失衡；
 *  3. **颜色由调用方给** —— 图标本身只定义形状，颜色走 Compose 主题，才能自动适配明暗。
 *
 * 这批图标按同一原则手绘 Path，直接放进 `res/drawable` 会被 Compose 复用，
 * 这里用 `ImageVector.Builder` 内联构建，省掉资源文件与 R 类。
 *
 * @see <a href="https://github.com/morluto/rea">REA</a> 用于逆向参考实现的工具
 */
object DshIcons {

    private inline fun icon(
        name: String,
        crossinline paths: androidx.compose.ui.graphics.vector.ImageVector.Builder.() -> Unit,
    ): ImageVector = ImageVector.Builder(
        name = name,
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f,
    ).apply { paths() }.build()

    /** 统一的描边参数（对齐上游 strokeWidth=1.5 + round cap/join）。 */
    private const val STROKE = 1.5f

    // ── 导航 / 动作 ─────────────────────────────────────────────────────────

    /** 极简双线菜单/抽屉图标（对齐 MiniMax uikit_menu_20ic） */
    val Menu: ImageVector by lazy {
        icon("Menu") {
            path(fill = null, stroke = SolidColor(Color.Black), strokeLineWidth = STROKE) {
                moveTo(4f, 8.5f); lineTo(20f, 8.5f)
                moveTo(4f, 15.5f); lineTo(14f, 15.5f)
            }
        }
    }

    /** 发送（右上方箭头）。上游是 32 圆形底 + 箭头，我们用同样几何但交给调用方配色。 */
    val Send: ImageVector by lazy {
        icon("Send") {
            path(fill = null, stroke = SolidColor(Color.Black), strokeLineWidth = STROKE) {
                moveTo(12f, 20f); lineTo(12f, 4f)
                moveTo(6f, 10f); lineTo(12f, 4f); lineTo(18f, 10f)
            }
        }
    }

    /** 加号 */
    val Add: ImageVector by lazy {
        icon("Add") {
            path(fill = SolidColor(Color.Black)) {
                moveTo(12f, 3f)
                curveTo(12.4f, 3f, 12.72f, 3.32f, 12.72f, 3.72f)
                lineTo(12.72f, 11.28f); lineTo(20.28f, 11.28f)
                curveTo(20.68f, 11.28f, 21f, 11.6f, 21f, 12f)
                curveTo(21f, 12.4f, 20.68f, 12.72f, 20.28f, 12.72f)
                lineTo(12.72f, 12.72f); lineTo(12.72f, 20.28f)
                curveTo(12.72f, 20.68f, 12.4f, 21f, 12f, 21f)
                curveTo(11.6f, 21f, 11.28f, 20.68f, 11.28f, 20.28f)
                lineTo(11.28f, 12.72f); lineTo(3.72f, 12.72f)
                curveTo(3.32f, 12.72f, 3f, 12.4f, 3f, 12f)
                curveTo(3f, 11.6f, 3.32f, 11.28f, 3.72f, 11.28f)
                lineTo(11.28f, 11.28f); lineTo(11.28f, 3.72f)
                curveTo(11.28f, 3.32f, 11.6f, 3f, 12f, 3f)
                close()
            }
        }
    }

    /** 放大镜 */
    val Search: ImageVector by lazy {
        icon("Search") {
            path(fill = null, stroke = SolidColor(Color.Black), strokeLineWidth = STROKE) {
                moveTo(10.5f, 4f)
                curveTo(13.54f, 4f, 16f, 6.46f, 16f, 9.5f)
                curveTo(16f, 12.54f, 13.54f, 15f, 10.5f, 15f)
                curveTo(7.46f, 15f, 5f, 12.54f, 5f, 9.5f)
                curveTo(5f, 6.46f, 7.46f, 4f, 10.5f, 4f)
                close()
                moveTo(15f, 15f); lineTo(20f, 20f)
            }
        }
    }

    /** 关闭 / 叉 */
    val Close: ImageVector by lazy {
        icon("Close") {
            path(fill = null, stroke = SolidColor(Color.Black), strokeLineWidth = STROKE) {
                moveTo(6f, 6f); lineTo(18f, 18f)
                moveTo(18f, 6f); lineTo(6f, 18f)
            }
        }
    }

    /** 刷新（同步）—— 逆时针弧线 + 箭头 */
    val Refresh: ImageVector by lazy {
        icon("Refresh") {
            path(fill = null, stroke = SolidColor(Color.Black), strokeLineWidth = STROKE) {
                moveTo(20f, 12f)
                curveTo(20f, 16.42f, 16.42f, 20f, 12f, 20f)
                curveTo(7.58f, 20f, 4f, 16.42f, 4f, 12f)
                curveTo(4f, 7.58f, 7.58f, 4f, 12f, 4f)
                curveTo(15.31f, 4f, 18.2f, 6.05f, 19.33f, 9f)
                moveTo(19.33f, 4.5f); lineTo(19.33f, 9f); lineTo(14.83f, 9f)
            }
        }
    }

    /** 返回箭头 */
    val ArrowBack: ImageVector by lazy {
        icon("ArrowBack") {
            path(fill = null, stroke = SolidColor(Color.Black), strokeLineWidth = STROKE) {
                moveTo(19f, 12f); lineTo(5f, 12f)
                moveTo(11f, 18f); lineTo(5f, 12f); lineTo(11f, 6f)
            }
        }
    }

    // ── 状态 / 可见性 ──────────────────────────────────────────────────────

    /** 眼睛（显示子代理会话） */
    val Eye: ImageVector by lazy {
        icon("Eye") {
            path(fill = null, stroke = SolidColor(Color.Black), strokeLineWidth = STROKE) {
                moveTo(2f, 12f)
                curveTo(2f, 12f, 5.5f, 5f, 12f, 5f)
                curveTo(18.5f, 5f, 22f, 12f, 22f, 12f)
                curveTo(22f, 12f, 18.5f, 19f, 12f, 19f)
                curveTo(5.5f, 19f, 2f, 12f, 2f, 12f)
                close()
                moveTo(12f, 15f)
                curveTo(13.66f, 15f, 15f, 13.66f, 15f, 12f)
                curveTo(15f, 10.34f, 13.66f, 9f, 12f, 9f)
                curveTo(10.34f, 9f, 9f, 10.34f, 9f, 12f)
                curveTo(9f, 13.66f, 10.34f, 15f, 12f, 15f)
                close()
            }
        }
    }

    /** 闭眼（隐藏子代理会话）—— 眼形 + 斜杠 */
    val EyeOff: ImageVector by lazy {
        icon("EyeOff") {
            path(fill = null, stroke = SolidColor(Color.Black), strokeLineWidth = STROKE) {
                moveTo(9.9f, 5.2f)
                curveTo(10.56f, 5.07f, 11.27f, 5f, 12f, 5f)
                curveTo(18.5f, 5f, 22f, 12f, 22f, 12f)
                curveTo(22f, 12f, 20.29f, 15.31f, 17.4f, 17.4f)
                moveTo(6.7f, 6.7f)
                curveTo(3.9f, 8.4f, 2f, 12f, 2f, 12f)
                curveTo(2f, 12f, 5.5f, 19f, 12f, 19f)
                curveTo(13.55f, 19f, 14.95f, 18.6f, 16.2f, 18f)
                moveTo(3f, 3f); lineTo(21f, 21f)
                moveTo(10f, 10f)
                curveTo(10f, 11.66f, 11.34f, 13f, 13f, 13f)
                curveTo(13.5f, 13f, 13.94f, 12.87f, 14.32f, 12.64f)
            }
        }
    }

    // ── 内容类型 ───────────────────────────────────────────────────────────

    /** 对话气泡（会话列表空态） */
    val ChatBubble: ImageVector by lazy {
        icon("ChatBubble") {
            path(fill = null, stroke = SolidColor(Color.Black), strokeLineWidth = STROKE) {
                moveTo(21f, 11.5f)
                curveTo(21f, 16.75f, 16.75f, 21f, 11.5f, 21f)
                curveTo(10.1f, 21f, 8.75f, 20.7f, 7.5f, 20.15f)
                lineTo(3f, 21.5f)
                curveTo(3.4f, 19.5f, 3.85f, 18.4f, 3.5f, 17f)
                curveTo(3.2f, 16.2f, 3f, 15.4f, 3f, 14.5f)
                curveTo(3f, 9.25f, 7.25f, 5f, 12.5f, 5f)
                curveTo(17.75f, 5f, 21f, 9.25f, 21f, 11.5f)
                close()
            }
        }
    }

    /** 显示器（电脑卡片）—— 几何取自上游 uikit_desktop_20_ic */
    val Desktop: ImageVector by lazy {
        icon("Desktop") {
            path(fill = SolidColor(Color.Black)) {
                moveTo(6f, 4.28f); lineTo(18f, 4.28f)
                curveTo(18.72f, 4.28f, 19.41f, 4.57f, 19.92f, 5.08f)
                curveTo(20.43f, 5.59f, 20.72f, 6.28f, 20.72f, 7f)
                lineTo(20.72f, 15.53f)
                curveTo(20.72f, 15.73f, 20.77f, 15.92f, 20.86f, 16.1f)
                lineTo(21.92f, 18.23f); lineTo(21.92f, 18.23f)
                curveTo(22.06f, 18.49f, 22.12f, 18.78f, 22.11f, 19.08f)
                curveTo(22.09f, 19.37f, 22f, 19.66f, 21.85f, 19.91f)
                curveTo(21.69f, 20.16f, 21.48f, 20.36f, 21.22f, 20.51f)
                curveTo(20.96f, 20.65f, 20.67f, 20.72f, 20.38f, 20.72f)
                lineTo(20.38f, 20.72f); lineTo(3.62f, 20.72f); lineTo(3.62f, 20.72f)
                curveTo(3.33f, 20.72f, 3.04f, 20.65f, 2.78f, 20.51f)
                curveTo(2.53f, 20.36f, 2.31f, 20.16f, 2.15f, 19.91f)
                curveTo(2f, 19.66f, 1.91f, 19.37f, 1.9f, 19.08f)
                curveTo(1.88f, 18.78f, 1.95f, 18.49f, 2.08f, 18.23f)
                lineTo(2.08f, 18.23f); lineTo(3.14f, 16.1f)
                curveTo(3.23f, 15.92f, 3.28f, 15.73f, 3.28f, 15.53f)
                lineTo(3.28f, 7f)
                curveTo(3.28f, 6.28f, 3.57f, 5.59f, 4.08f, 5.08f)
                curveTo(4.59f, 4.57f, 5.28f, 4.28f, 6f, 4.28f)
                close()
                moveTo(6f, 5.72f)
                curveTo(5.66f, 5.72f, 5.34f, 5.86f, 5.1f, 6.1f)
                curveTo(4.86f, 6.34f, 4.72f, 6.66f, 4.72f, 7f)
                lineTo(4.72f, 15.27f); lineTo(19.28f, 15.27f); lineTo(19.28f, 7f)
                curveTo(19.28f, 6.66f, 19.14f, 6.34f, 18.9f, 6.1f)
                curveTo(18.66f, 5.86f, 18.34f, 5.72f, 18f, 5.72f)
                close()
            }
        }
    }

    /** 图片占位图标 */
    val Image: ImageVector by lazy {
        icon("Image") {
            path(fill = null, stroke = SolidColor(Color.Black), strokeLineWidth = STROKE) {
                moveTo(4f, 5f)
                curveTo(4f, 4.45f, 4.45f, 4f, 5f, 4f)
                lineTo(19f, 4f)
                curveTo(19.55f, 4f, 20f, 4.45f, 20f, 5f)
                lineTo(20f, 19f)
                curveTo(20f, 19.55f, 19.55f, 20f, 19f, 20f)
                lineTo(5f, 20f)
                curveTo(4.45f, 20f, 4f, 19.55f, 4f, 19f)
                close()
                moveTo(4f, 16f); lineTo(9f, 11f); lineTo(13f, 15f)
                moveTo(13f, 15f); lineTo(15.5f, 12.5f); lineTo(20f, 17f)
                // 小圆点表示"太阳"
                moveTo(15.5f, 8.5f)
                curveTo(15.78f, 8.5f, 16f, 8.28f, 16f, 8f)
                curveTo(16f, 7.72f, 15.78f, 7.5f, 15.5f, 7.5f)
                curveTo(15.22f, 7.5f, 15f, 7.72f, 15f, 8f)
                curveTo(15f, 8.28f, 15.22f, 8.5f, 15.5f, 8.5f)
                close()
            }
        }
    }

    /** 文件夹（工作区分组头） */
    val Folder: ImageVector by lazy {
        icon("Folder") {
            path(fill = null, stroke = SolidColor(Color.Black), strokeLineWidth = STROKE) {
                moveTo(3f, 6.5f)
                curveTo(3f, 5.67f, 3.67f, 5f, 4.5f, 5f)
                lineTo(9f, 5f); lineTo(11f, 7.5f)
                lineTo(19.5f, 7.5f)
                curveTo(20.33f, 7.5f, 21f, 8.17f, 21f, 9f)
                lineTo(21f, 18f)
                curveTo(21f, 18.83f, 20.33f, 19.5f, 19.5f, 19.5f)
                lineTo(4.5f, 19.5f)
                curveTo(3.67f, 19.5f, 3f, 18.83f, 3f, 18f)
                close()
            }
        }
    }

    /** 垃圾桶 */
    val Trash: ImageVector by lazy {
        icon("Trash") {
            path(fill = null, stroke = SolidColor(Color.Black), strokeLineWidth = STROKE) {
                moveTo(4f, 6.5f); lineTo(20f, 6.5f)
                moveTo(9.5f, 6.5f); lineTo(9.5f, 4.5f)
                curveTo(9.5f, 4.22f, 9.72f, 4f, 10f, 4f)
                lineTo(14f, 4f)
                curveTo(14.28f, 4f, 14.5f, 4.22f, 14.5f, 4.5f)
                lineTo(14.5f, 6.5f)
                moveTo(6.5f, 6.5f); lineTo(7.4f, 19.5f)
                curveTo(7.44f, 19.78f, 7.68f, 20f, 7.96f, 20f)
                lineTo(16.04f, 20f)
                curveTo(16.32f, 20f, 16.56f, 19.78f, 16.6f, 19.5f)
                lineTo(17.5f, 6.5f)
            }
        }
    }

    /** 停止（实心方块，运行中时显示） */
    val Stop: ImageVector by lazy {
        icon("Stop") {
            path(fill = SolidColor(Color.Black)) {
                moveTo(7f, 7f); lineTo(17f, 7f); lineTo(17f, 17f); lineTo(7f, 17f); close()
            }
        }
    }

    /** 对勾 */
    val Check: ImageVector by lazy {
        icon("Check") {
            path(fill = null, stroke = SolidColor(Color.Black), strokeLineWidth = STROKE) {
                moveTo(5f, 12.5f); lineTo(10f, 17.5f); lineTo(19f, 7f)
            }
        }
    }

    /** 警告三角 */
    val Warning: ImageVector by lazy {
        icon("Warning") {
            path(fill = null, stroke = SolidColor(Color.Black), strokeLineWidth = STROKE) {
                moveTo(12f, 4f); lineTo(21f, 19.5f); lineTo(3f, 19.5f); close()
                moveTo(12f, 10f); lineTo(12f, 14f)
                moveTo(12f, 16.8f); lineTo(12f, 16.9f)
            }
        }
    }

    /** 复制（剪贴板卡片） */
    val Copy: ImageVector by lazy {
        icon("Copy") {
            path(fill = null, stroke = SolidColor(Color.Black), strokeLineWidth = STROKE) {
                moveTo(9f, 9f)
                curveTo(9f, 7.9f, 9.9f, 7f, 11f, 7f)
                lineTo(18f, 7f)
                curveTo(19.1f, 7f, 20f, 7.9f, 20f, 9f)
                lineTo(20f, 18f)
                curveTo(20f, 19.1f, 19.1f, 20f, 18f, 20f)
                lineTo(11f, 20f)
                curveTo(9.9f, 20f, 9f, 19.1f, 9f, 18f)
                close()
                moveTo(6f, 15f)
                curveTo(4.9f, 15f, 4f, 14.1f, 4f, 13f)
                lineTo(4f, 6f)
                curveTo(4f, 4.9f, 4.9f, 4f, 6f, 4f)
                lineTo(13f, 4f)
                curveTo(14.1f, 4f, 15f, 4.9f, 15f, 6f)
            }
        }
    }

    /** 向下箭头 (展开) */
    val ChevronDown: ImageVector by lazy {
        icon("ChevronDown") {
            path(fill = null, stroke = SolidColor(Color.Black), strokeLineWidth = STROKE) {
                moveTo(6f, 9f); lineTo(12f, 15f); lineTo(18f, 9f)
            }
        }
    }

    /** 向上箭头 (收起) */
    val ChevronUp: ImageVector by lazy {
        icon("ChevronUp") {
            path(fill = null, stroke = SolidColor(Color.Black), strokeLineWidth = STROKE) {
                moveTo(6f, 15f); lineTo(12f, 9f); lineTo(18f, 15f)
            }
        }
    }

    /** 终端命令提示符 */
    val Terminal: ImageVector by lazy {
        icon("Terminal") {
            path(fill = null, stroke = SolidColor(Color.Black), strokeLineWidth = STROKE) {
                moveTo(4f, 17f); lineTo(10f, 12f); lineTo(4f, 7f)
                moveTo(12f, 17f); lineTo(20f, 17f)
            }
        }
    }

    /** 代码尖括号 */
    val Code: ImageVector by lazy {
        icon("Code") {
            path(fill = null, stroke = SolidColor(Color.Black), strokeLineWidth = STROKE) {
                moveTo(16f, 18f); lineTo(22f, 12f); lineTo(16f, 6f)
                moveTo(8f, 6f); lineTo(2f, 12f); lineTo(8f, 18f)
            }
        }
    }

    /** AI 闪烁星星 / Sparkles */
    val Sparkles: ImageVector by lazy {
        icon("Sparkles") {
            path(fill = null, stroke = SolidColor(Color.Black), strokeLineWidth = STROKE) {
                moveTo(12f, 3f); lineTo(14.5f, 9.5f); lineTo(21f, 12f); lineTo(14.5f, 14.5f); lineTo(12f, 21f); lineTo(9.5f, 14.5f); lineTo(3f, 12f); lineTo(9.5f, 9.5f); close()
            }
        }
    }

    /** CPU / 硬件算力 */
    val Cpu: ImageVector by lazy {
        icon("Cpu") {
            path(fill = null, stroke = SolidColor(Color.Black), strokeLineWidth = STROKE) {
                moveTo(6f, 6f); lineTo(18f, 6f); lineTo(18f, 18f); lineTo(6f, 18f); close()
                moveTo(9f, 9f); lineTo(15f, 9f); lineTo(15f, 15f); lineTo(9f, 15f); close()
                moveTo(9f, 3f); lineTo(9f, 6f)
                moveTo(15f, 3f); lineTo(15f, 6f)
                moveTo(9f, 18f); lineTo(9f, 21f)
                moveTo(15f, 18f); lineTo(15f, 21f)
                moveTo(3f, 9f); lineTo(6f, 9f)
                moveTo(3f, 15f); lineTo(6f, 15f)
                moveTo(18f, 9f); lineTo(21f, 9f)
                moveTo(18f, 15f); lineTo(21f, 15f)
            }
        }
    }

    /** 任务清单 / 剪贴板 */
    val TaskList: ImageVector by lazy {
        icon("TaskList") {
            path(fill = null, stroke = SolidColor(Color.Black), strokeLineWidth = STROKE) {
                moveTo(9f, 5f); lineTo(15f, 5f)
                moveTo(9f, 3f); lineTo(15f, 3f); curveTo(15.55f, 3f, 16f, 3.45f, 16f, 4f); lineTo(16f, 6f); curveTo(16f, 6.55f, 15.55f, 7f, 15f, 7f); lineTo(9f, 7f); curveTo(8.45f, 7f, 8f, 6.55f, 8f, 6f); lineTo(8f, 4f); curveTo(8f, 3.45f, 8.45f, 3f, 9f, 3f); close()
                moveTo(7f, 5f); lineTo(5f, 5f); curveTo(4.45f, 5f, 4f, 5.45f, 4f, 6f); lineTo(4f, 20f); curveTo(4f, 20.55f, 4.45f, 21f, 5f, 21f); lineTo(19f, 21f); curveTo(19.55f, 21f, 20f, 20.55f, 20f, 20f); lineTo(20f, 6f); curveTo(20f, 5.45f, 19.55f, 5f, 19f, 5f); lineTo(17f, 5f)
                moveTo(8f, 11f); lineTo(16f, 11f)
                moveTo(8f, 15f); lineTo(14f, 15f)
            }
        }
    }

    /** 二维码 */
    val QrCode: ImageVector by lazy {
        icon("QrCode") {
            path(fill = null, stroke = SolidColor(Color.Black), strokeLineWidth = STROKE) {
                moveTo(3f, 3f); lineTo(9f, 3f); lineTo(9f, 9f); lineTo(3f, 9f); close()
                moveTo(15f, 3f); lineTo(21f, 3f); lineTo(21f, 9f); lineTo(15f, 9f); close()
                moveTo(3f, 15f); lineTo(9f, 15f); lineTo(9f, 21f); lineTo(3f, 21f); close()
                moveTo(14f, 14f); lineTo(16f, 14f); lineTo(16f, 16f); lineTo(14f, 16f); close()
                moveTo(18f, 14f); lineTo(21f, 14f); lineTo(21f, 17f); lineTo(18f, 17f); close()
                moveTo(14f, 18f); lineTo(18f, 18f); lineTo(18f, 21f); lineTo(14f, 21f); close()
            }
        }
    }

    /** 更多操作（三个水平圆点） */
    val MoreHorizontal: ImageVector by lazy {
        icon("MoreHorizontal") {
            path(fill = SolidColor(Color.Black)) {
                moveTo(6.5f, 12f); curveTo(6.5f, 12.83f, 5.83f, 13.5f, 5f, 13.5f); curveTo(4.17f, 13.5f, 3.5f, 12.83f, 3.5f, 12f); curveTo(3.5f, 11.17f, 4.17f, 10.5f, 5f, 10.5f); curveTo(5.83f, 10.5f, 6.5f, 11.17f, 6.5f, 12f); close()
                moveTo(13.5f, 12f); curveTo(13.5f, 12.83f, 12.83f, 13.5f, 12f, 13.5f); curveTo(11.17f, 13.5f, 10.5f, 12.83f, 10.5f, 12f); curveTo(10.5f, 11.17f, 11.17f, 10.5f, 12f, 10.5f); curveTo(12.83f, 10.5f, 13.5f, 11.17f, 13.5f, 12f); close()
                moveTo(20.5f, 12f); curveTo(20.5f, 12.83f, 19.83f, 13.5f, 19f, 13.5f); curveTo(18.17f, 13.5f, 17.5f, 12.83f, 17.5f, 12f); curveTo(17.5f, 11.17f, 18.17f, 10.5f, 19f, 10.5f); curveTo(19.83f, 10.5f, 20.5f, 11.17f, 20.5f, 12f); close()
            }
        }
    }
}
