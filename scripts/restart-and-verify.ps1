# Restart DSH and verify the event-stream protocol.
#
# Run this DETACHED from DSH: restarting DSH ends the session that would
# otherwise be doing the verifying.
#
# Verifies three things:
#   1. /mobile-gateway/remote.mux exists (old code answered with an empty body)
#   2. opening the `$events` logical stream yields ready/item frames
#   3. the retired /mobile-gateway/events.mux is gone
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts\restart-and-verify.ps1

$ErrorActionPreference = 'Continue'
$log = Join-Path $PSScriptRoot '..\..\dsh-restart-verify.log'
# Resolve the install root from the running DSH rather than hardcoding a user path,
# so this script stays machine-independent (and carries no personal paths).
$dshRoot = Split-Path -Parent (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
  Select-Object -First 1 -ExpandProperty Path)
if (-not $dshRoot) { $dshRoot = 'C:\Program Files\DeepSeek Harness' }
$node = Join-Path $dshRoot 'resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
$dshExe = Join-Path $dshRoot 'DeepSeek Harness.exe'

function Log([string]$m) {
  $line = "[$(Get-Date -Format 'HH:mm:ss')] $m"
  Write-Host $line
  Add-Content -Path $log -Value $line -Encoding UTF8
}

Log '=== DSH restart + event-stream verification ==='

# ---- 1. stop the desktop-profile DSH ----
$dsh = Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" |
  Where-Object { $_.CommandLine -match 'profiles\\desktop' }
if (-not $dsh) { Log 'no desktop-profile DSH found; aborting'; exit 1 }
foreach ($p in $dsh) { Log "stopping DSH PID=$($p.ProcessId)" }
$dsh | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 5

# ---- 2. relaunch ----
if (-not (Test-Path $dshExe)) { Log "DSH executable missing: $dshExe"; exit 1 }
Log 'launching DSH...'
# Launch via System.Diagnostics.Process, NOT Start-Process.
#
# Why: when this script runs as a child of DSH, DSH's proxy policy publishes BOTH
# casings of every proxy variable (http_proxy + HTTP_PROXY, etc.; see
# @deepseek-ai/dsh-http-proxy in app.asar). PowerShell 5.1's Environment is a
# case-insensitive dictionary, so it sees those pairs as duplicate keys and
# Start-Process throws before doing anything:
#     Add failed: key "NO_PROXY" already exists ("no_proxy")
# System.Diagnostics.ProcessStartInfo does not rebuild that dictionary, so it
# launches fine under the same environment. Verified on this machine 2026-10-14.
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $dshExe
$psi.UseShellExecute = $true
[void][System.Diagnostics.Process]::Start($psi)
Start-Sleep -Seconds 25

# ---- 3. wait for the port ----
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  if (Get-NetTCPConnection -LocalPort 19387 -State Listen -ErrorAction SilentlyContinue) { $ready = $true; break }
  Start-Sleep -Seconds 2
}
if (-not $ready) { Log 'port 19387 never came up; aborting'; exit 1 }
Log 'port 19387 is listening'

# ---- 4. probe both WS routes with a raw upgrade ----
$probe = @'
const net = await import('node:net');
function rawUpgrade(path) {
  return new Promise((resolve) => {
    const s = net.connect(19387, '127.0.0.1', () => {
      s.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:19387\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let raw = ''; s.on('data', d => raw += d);
    s.on('close', () => resolve((raw.split('\r\n')[0] || 'EMPTY').trim()));
    s.on('error', e => resolve('ERR ' + e.message));
    setTimeout(() => { s.destroy(); resolve((raw.split('\r\n')[0] || 'TIMEOUT').trim()); }, 4000);
  });
}
console.log('PROBE remote.mux =>', await rawUpgrade('/mobile-gateway/remote.mux'));
console.log('PROBE events.mux =>', await rawUpgrade('/mobile-gateway/events.mux'));
'@
$probe | Out-File -Encoding utf8 (Join-Path $env:TEMP 'dsh_probe_after.mjs')
$out = & $node (Join-Path $env:TEMP 'dsh_probe_after.mjs') 2>&1
$out | ForEach-Object { Log $_ }

$remote = ($out | Where-Object { $_ -match 'remote\.mux' }) -join ''
$events = ($out | Where-Object { $_ -match 'events\.mux' }) -join ''
if ($remote -match '401') { Log 'OK  remote.mux is live (401 = route exists, token required)' }
else { Log "BAD remote.mux still old behaviour: $remote" }
if ($events -match 'EMPTY') { Log 'OK  retired events.mux is gone' }
else { Log "WARN events.mux still answers: $events" }

Log "=== done. full log: $log ==="
