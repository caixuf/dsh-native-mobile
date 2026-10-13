# 公网访问：FRP 隧道 + Caddy 白名单

手机在家外面也能连上电脑上的 DSH，走的是「家里主动拨出 → 你的公网 VPS → Caddy 终止 TLS → FRP 隧道 → DSH」。

```
手机 ──HTTPS──▶ https://203.0.113.10:2444
                  │
                  ▼
        VPS 上的 Caddy（终止 TLS，路径白名单）
                  │  只有 /mobile-gateway/* 能过去
                  ▼
        127.0.0.1:2443  ← frps 的隧道端口，只绑回环
                  │
                  ▼
        （FRP 多路复用，走 7000 的控制连接）
                  │
                  ▼
        家里 frpc ──▶ 127.0.0.1:19387（DSH webserver）
```

## 为什么必须绕这一圈

DSH 的 `/api` **没有认证层**，只有一道 Host/Origin 栅栏，而栅栏判的是**请求的 Host 头**。
FRP 的 TCP 隧道原样透传 Host，所以直接把 DSH 端口整体转发出去的话，公网上任何人都可以：

```
GET http://<你的地址>/api/session.list
Host: 127.0.0.1:19387        ← 自己编一个
```

栅栏一看是回环，直接放行 —— 拿到的是**未鉴权的完整 `/api`**，等价于完全控制这台电脑上的 DSH。

所以整条链路是按「公网只能碰到网关、碰不到 `/api`」来设计的。

## 三层收敛

**1. 路径白名单（结构性，不依赖运行时判断）**

Caddy 只放行这五个面，其余一律 404：

| 路径 | 用途 | 鉴权 |
|---|---|---|
| `/mobile-gateway/health` | 探活 | 公开（只回服务名与实例名） |
| `/mobile-gateway/pair` | 配对 | 一次性配对码 |
| `/mobile-gateway/api/*` | 一问一答 | 设备令牌 |
| `/mobile-gateway/events.mux` | 下行事件流 | 设备令牌 |
| `/mobile-gateway/events.host` | 下行事件流 | 设备令牌 |

`/api` **根本不在列表里**，所以公网上伪造 Host 也碰不到——这条不靠任何检查生效。

**2. 管理面显式封死（这条特别容易被漏）**

`/mobile-gateway/manage` 在 DSH 侧是「回环才放行」。但走完 FRP 隧道后，DSH 看到的对端是
**本机的 frpc 进程（127.0.0.1）**——那道守卫会**形同虚设**，公网来的请求照样通过。
所以必须在 Caddy 层显式 `respond 404`。

**3. 不改写 Host（两道闸不设同一条依赖）**

上游看到的是 `203.0.113.10:2444`，不在 DSH 的 `trustedHosts` 里。
万一白名单哪天漏了，DSH 自己的栅栏还会再拒一次。

**4. 隧道端口绑回环（纵深）**

frps 配了 `proxyBindAddr = "127.0.0.1"`，所以 `2443` **公网连不上**（实测 `curl` 返回 `000`）。
即便有人找到隧道端口，也只能经 Caddy 的白名单进来。

## 实测结果

```
PASS  gateway health                     HTTP 404   ← 已通到 DSH（网关待 DSH 重启注册）
PASS  /api/session.list (未鉴权!)         HTTP 404   ← 关键：公网打不到
PASS  /api/respond                       HTTP 404
PASS  /api/events.mux                    HTTP 404
PASS  管理面板 manage                     HTTP 404
PASS  管理面板 manage/api/state           HTTP 404
PASS  /                                  HTTP 404
PASS  /anything                          HTTP 404
PASS  https://203.0.113.10:2443/         000       ← 隧道端口公网不可达
```

## 端口清单

| 端口 | 在哪 | 作用 | 对公网 |
|---|---|---|---|
| 7000 | VPS | frp bindPort（隧道控制连接） | 开（需正确令牌） |
| 2443 | VPS **仅回环** | FRP 隧道落地 | 不开、也连不上 |
| 2444 | VPS | Caddy 终止 TLS，公网唯一入口 | 开 |
| 19387 | 家里 | DSH webserver（仅本机） | 不暴露 |

## 组件与文件

**VPS**（Ubuntu 24.04，上海）
- `/usr/local/bin/frps`，systemd `frps.service`
- `/etc/frp/frps.toml`（0600，含共享令牌）
- `/etc/caddy/acli.d/sites/dsh-mobile.caddy` ← 走 ACLI 的官方扩展点，**没碰主 Caddyfile**
- UFW 放行 7000 / 2444

**家里**（Windows）
- `C:\Users\me\Downloads\android-toolchain\frpc.exe`
- `C:\Users\me\Downloads\android-toolchain\frpc.toml`（由 VPS 生成，令牌不经过命令行）
- 开机启动：`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\dsh-mobile-tunnel.cmd`

## 排查

```powershell
# 家里：看隧道
Get-Process frpc
& "C:\Users\me\Downloads\android-toolchain\frpc.exe" -c "C:\Users\me\Downloads\android-toolchain\frpc.toml"
```

```bash
# VPS：看隧道与反代
tail -20 /var/log/frps.log
ss -tlnp | grep -E '2443|2444'
curl -sk -o /dev/null -w '%{http_code}\n' https://203.0.113.10:2444/mobile-gateway/health
```

## 踩过的坑

**腾讯云安全组 vs UFW 是两层。** 只改 UFW 不改安全组，端口在公网依然不通，
表现是「连接超时 + 服务端一条日志都没有」（包在云网络层就被丢了，压根到不了应用）。
这次 `frpc login failed: session shutdown` 就是这么来的。

**Caddyfile 里有 `admin off`。** 管理 API（:2019）关着，`systemctl reload caddy` 必然失败
（`dial tcp 127.0.0.1:2019: connect: connection refused`），只能 `systemctl restart caddy`。

**Linux 不允许 `0.0.0.0:2443` 与 `127.0.0.1:2443` 重叠绑定。** Caddy 和 frps 想用同一个端口会
`EADDRINUSE`。所以错开：Caddy 用 2444，frps 隧道用 2443。

**TOML：表头之后的键属于该表。** frpc 配置里把 `log.level` 写在 `[[proxies]]` 后面，
会被解析成 proxy 的字段，报 `unknown field "log"`。全局键必须写在任何表头**之前**。

**Defender 会拦 frp**：`PUA:Win32/FRProxy`（Low，未执行）。frp 是隧道工具，Defender 的
「潜在不需要应用」定义正好覆盖这类能力，属于已知误报。加单文件排除即可：

```powershell
Add-MpPreference -ExclusionPath "C:\Users\me\Downloads\android-toolchain\frpc.exe"
```

加完还要 `Unblock-File`，否则「来自网络」标记也会拦。

**不要用 `systemctl status` 排查崩溃循环的服务**：它的输出会把 SSH 通道写满，导致调用方看起来
「卡死」。用 `systemctl is-active --quiet` 或直接看日志文件。

**判断可达性前先绕开本机代理。** 这台机器全局设了 `HTTP_PROXY/HTTPS_PROXY=127.0.0.1:7897`，
`curl` 会自动走代理，响应里那句 `HTTP/1.1 200 Connection established` 就是 CONNECT 握手。
带着代理做的可达性观测会**同时失真两个方向**：把连不通的目标看成连得通，
也把真实的失败路径（`curl` 返回码 `000`）掩盖掉。凡是判断「某地址通不通」，
一律加 `--noproxy '*'`，或换一个网络 vantage（VPS 上没有代理环境）复测。

## 顺带修的：example.com 的证书签不下来

不属于本项目，但在这台机器上顺手处理了，留档以免复发。

**根因**：主 Caddyfile 的 `:80` 只声明了 `http://203.0.113.10 {}`——**按 IP 匹配**。
而 443 侧的站点块写的是 `example.com, www.example.com { ... }`（无显式 `http://` 前缀）。
ACME HTTP-01 验证带 `Host: example.com` 打到 `:80` 时匹配不到那个按 IP 的块，
被 308 跳走，**挑战令牌从未被应答过**，证书因此永远签不下来。

**修法**（走 ACLI 的 `sites/` 扩展点，没碰主 Caddyfile）：

```
/etc/caddy/acli.d/sites/acme-http.caddy

http://example.com, http://www.example.com {
}
```

空块，不放任何业务路由——只让 Caddy 把 `/.well-known/acme-challenge/` 挂到 `:80`，
其他请求照旧 308 跳 HTTPS。验证：改动前 `Host: example.com` 返回 308，改动后返回 200。

**遗留**：`example.com` 的 DNS 里有两条 A 记录（`203.0.113.10` 与 `198.51.100.7`）。
后者服务已到期待下线，用户会手动删除；删掉之后验证请求只会落到本机，证书即可签发。
在删掉之前该域名约有一半概率失败。

**过程中的两处自我更正**（留着当教训）：

1. 一开始判断「`example.com` 的 DNS 没指向这台 VPS」——**错的**。DNS 一直指着它，
   只是同时还有另一条指向一台已经半停机的机器。
2. 中途观测到 `198.51.100.9`（`Server: TencentEdgeOne`，返回 418）一度让我以为
   域名前面还挂着 CDN——**也是代理造成的假象**。用 8.8.8.8 / 114.114.114.114 /
   223.5.5.5 三个解析器交叉查询，结论一致：**没有 CNAME，只有两条 A 记录**。

教训是一样的：先用正确的 vantage 把事实钉死，再下结论。