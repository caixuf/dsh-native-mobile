package io.github.dshmobile.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 主机记录归并逻辑测试。
 *
 * 🔴 真实问题（2026-10-14，实机 + 用户反馈）：
 *
 * 同一台电脑在主机列表里堆成**两条同名 `desktop`**。
 * 根因：`upsert` 只按本机随机 UUID `id` 去重，而服务端每次登录/配对
 * 都签发**新的 deviceId** —— 换个地址登录一次就多一条。
 *
 * 用户确认的期望：**同一台电脑只留一条，地址取最近用的**
 * （按电脑身份归并，公网/内网地址视为同一台机器）。
 *
 * 这里把归并键的判定抽成纯函数测试（`HostStore` 本体依赖 Android Context，
 * 不适合直接单测）。
 */
class HostDedupeTest {

    /** 与 HostStore.sameMachineAs 等价的纯逻辑。 */
    private fun sameMachine(a: HostRecord, b: HostRecord): Boolean {
        val x = a.instanceName.trim().lowercase()
        val y = b.instanceName.trim().lowercase()
        if (x.isNotEmpty() && y.isNotEmpty()) return x == y
        return norm(a.baseUrl) == norm(b.baseUrl)
    }

    private fun norm(u: String) = u.trim().trimEnd('/').lowercase()

    /** 与 HostStore.dedupe 等价的纯逻辑：按 lastUsedAt 降序，每组留第一条。 */
    private fun dedupe(records: List<HostRecord>): List<HostRecord> {
        val best = LinkedHashMap<String, HostRecord>()
        for (r in records.sortedByDescending { it.lastUsedAt }) {
            val key = if (r.instanceName.isNotBlank()) {
                "n:" + r.instanceName.trim().lowercase()
            } else {
                "u:" + norm(r.baseUrl)
            }
            if (!best.containsKey(key)) best[key] = r
        }
        return best.values.toList()
    }

    private fun host(
        label: String,
        baseUrl: String,
        instanceName: String,
        lastUsedAt: Long,
        id: String = label,
    ) = HostRecord(
        id = id,
        label = label,
        baseUrl = baseUrl,
        token = "tok-$id",
        deviceId = "dev-$id",
        instanceName = instanceName,
        lastUsedAt = lastUsedAt,
    )

    // ── 归并键 ──────────────────────────────────────────────────────────────

    @Test
    fun `same instance name means same machine even on different addresses`() {
        // 用户的实际场景：同一台电脑，公网地址 vs 局域网地址
        val pub = host("desktop", "https://203.0.113.10:2444", "desktop", 1_000)
        val lan = host("desktop", "http://10.0.2.2:19387", "desktop", 2_000)
        assertTrue("同一 profile 名应视为同一台电脑，与地址无关", sameMachine(pub, lan))
    }

    @Test
    fun `different instance name means different machines`() {
        val a = host("desktop", "https://a.example:2444", "desktop", 1_000)
        val b = host("laptop", "https://b.example:2444", "laptop", 2_000)
        assertTrue("不同 profile 名是不同电脑", !sameMachine(a, b))
    }

    @Test
    fun `instance name comparison ignores case and spaces`() {
        val a = host("desktop", "https://a.example:2444", " Desktop ", 1_000)
        val b = host("desktop", "https://b.example:2444", "desktop", 2_000)
        assertTrue("大小写与空白不应影响判定", sameMachine(a, b))
    }

    @Test
    fun `falls back to url when instance name missing`() {
        val a = host("x", "https://a.example:2444/", "", 1_000)
        val b = host("x", "https://a.example:2444", "", 2_000)
        assertTrue("电脑名缺失时同地址视为同一台", sameMachine(a, b))
    }

    @Test
    fun `different urls with no instance name are different`() {
        val a = host("x", "https://a.example:2444", "", 1_000)
        val b = host("y", "https://b.example:2444", "", 2_000)
        assertTrue("电脑名缺失且地址不同 → 两台", !sameMachine(a, b))
    }

    // ── 归并结果 ────────────────────────────────────────────────────────────

    @Test
    fun `dedupe keeps exactly one record per machine`() {
        val list = listOf(
            host("desktop", "https://pub.example:2444", "desktop", 1_000, id = "old"),
            host("desktop", "http://10.0.2.2:19387", "desktop", 3_000, id = "new"),
        )
        val out = dedupe(list)
        assertEquals("同一台电脑应只留一条", 1, out.size)
        assertEquals("应保留最近使用的那条", "new", out[0].id)
        assertEquals("地址应是最新的", "http://10.0.2.2:19387", out[0].baseUrl)
    }

    @Test
    fun `dedupe preserves distinct machines`() {
        val list = listOf(
            host("desktop", "https://a:2444", "desktop", 1_000),
            host("laptop", "https://b:2444", "laptop", 2_000),
            host("phone", "https://c:2444", "phone", 3_000),
        )
        assertEquals(3, dedupe(list).size)
    }

    @Test
    fun `dedupe collapses many duplicates of the same machine`() {
        // 早期版本每次登录都新增，实测同一台机器能积多条
        val list = (1..8).map {
            host("desktop", "https://h$it:2444", "desktop", it * 1_000L, id = "d$it")
        }
        val out = dedupe(list)
        assertEquals(1, out.size)
        assertEquals("d8", out[0].id)
    }

    @Test
    fun `dedupe on empty or single list is a no-op`() {
        assertEquals(0, dedupe(emptyList()).size)
        val one = listOf(host("a", "https://a:2444", "desktop", 1_000))
        assertEquals(1, dedupe(one).size)
        assertEquals("a", dedupe(one)[0].id)
    }

    @Test
    fun `dedupe does not lose the newest token`() {
        // 保留的必须是最近那条，否则 token 会指向已失效的旧设备
        val list = listOf(
            host("desktop", "https://old:2444", "desktop", 1_000, id = "old"),
            host("desktop", "https://new:2444", "desktop", 5_000, id = "new"),
            host("desktop", "https://mid:2444", "desktop", 3_000, id = "mid"),
        )
        val out = dedupe(list)
        assertEquals("new", out[0].id)
        assertEquals("token 必须与保留记录一致", "tok-new", out[0].token)
    }
}
