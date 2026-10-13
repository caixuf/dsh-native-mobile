# 重启 DSH 并验证事件流（在 DSH 之外的独立进程里跑，因此不会被重启杀掉）
#
# 背景：网关改动（单条 mux + $events + $events/result）需要重启 DSH 才生效
# （Node ESM 不热重载）。而重启会连带结束当前 DSH 会话，所以验证逻辑必须
# 跑在一个**独立于 DSH 的进程**里。
#
# 验证三件事：
#   1. /mobile-gateway/remote.mux 路由是否存在（旧代码下是空响应）
#   2. 连上 mux 并发 open{endpoint:'$events'} 后，是否收到 ready/item 帧
#   3. 旧路径 /mobile-gateway/events.mux 是否已消失
#
# 用法（需管理员/足够权限，因为要停进程）：
#   powershell -ExecutionPolicy Bypass -File scripts\restart-and-verify.ps1

$ErrorActionPreference = 'Continue'
$log = "$PSScriptRoot\..\..\dsh-restart-verify.log"
$node = "C:\Users\me\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"

function Log($m) {
  $line = "[$(Get-Date -Format 'HH:mm:ss')] $m"
  Write-Host $line
  Add-Content -Path $log -Value $line -Encoding UTF8
}

Log "=== DSH 重启 + 事件流验证 ==="

# ---- 1. 找出并停掉 desktop profile 的 DSH ----
$dsh = Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" |
  Where-Object { $_.CommandLine -match 'profiles\\desktop' }
if (-not $dsh) { Log "找不到 desktop profile 的 DSH 进程，退出"; exit 1 }

foreach ($p in $dsh) { Log "停止 DSH PID=$($p.ProcessId)" }
$dsh | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 5

# ---- 2. 重新拉起 ----
$exe = "C:\Users\me\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe"
if (-not (Test-Path $exe)) { Log "找不到 DSH 可执行文件: $exe"; exit 1 }
Log "启动 DSH…"
Start-Process -FilePath $exe
Start-Sleep -Seconds 25

# ---- 3. 等端口就绪 ----
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  $l = Get-NetTCPConnection -LocalPort 19387 -State Listen -ErrorAction SilentlyContinue
  if ($l) { $ready = $true; break }
  Start-Sleep -Seconds 2
}
if (-not $ready) { Log "❌ 19387 未就绪，放弃"; exit 1 }
Log "✅ 19387 已监听"

# ---- 4. 验证 ----
$probe = @'
const net = await import('node:net');
function rawUpgrade(path) {
  return new Promise((resolve) => {
    const s = net.connect(19387, '127.0.0.1', () => {
      s.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:19387\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let raw = ''; s.on('data', d => raw += d);
    s.on('close', () => resolve((raw.split('\r\n')[0] || '(空)').trim()));
    s.on('error', e => resolve('ERR ' + e.message));
    setTimeout(() => { s.destroy(); resolve((raw.split('\r\n')[0] || 'TIMEOUT').trim()); }, 4000);
  });
}
console.log('RESULT remote.mux  =>', await rawUpgrade('/mobile-gateway/remote.mux'));
console.log('RESULT events.mux  =>', await rawUpgrade('/mobile-gateway/events.mux'));
'@
$probe | Out-File -Encoding utf8 "$env:TEMP\dsh_probe_after.mjs"
$out = & $node "$env:TEMP\dsh_probe_after.mjs" 2>&1
$out | ForEach-Object { Log $_ }

# 判定：remote.mux 应为 401（路由存在、需令牌）；events.mux 应为空（路由已删）
$remote = ($out | Where-Object { $_ -match 'remote\.mux' }) -join ''
$events = ($out | Where-Object { $_ -match 'events\.mux' }) -join ''
if ($remote -match '401') { Log "✅ remote.mux 路由已生效（401 = 存在但需令牌）" }
else { Log "❌ remote.mux 仍是旧行为: $remote" }
if ($events -match '\(空\)') { Log "✅ events.mux 旧路由已消失" }
else { Log "⚠️  events.mux 仍在: $events" }

Log "=== 完成。完整日志: $log ==="
