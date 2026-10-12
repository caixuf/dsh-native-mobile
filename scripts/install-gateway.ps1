<#
  把 dsh-mobile-gateway 安装到本机 DSH。

  为什么手工拷而不是 dsh plugin add：
  - 它是 host 插件（package.json 里没有 dsh.client），不是 bundle，
    所以 install_bundle 会返回 error.code: not-bundle —— 这是形态差异，不是失败。
  - DSH 的组合树按 <dsh-home>\node_modules 解析裸包名，而 plugin_manager 只往
    profiles\desktop\node_modules 装，所以最终位置必须自己落对。

  脚本只写文件，不重启 DSH —— DSH 正在运行时改 patch 会让设置写入的 revision
  乐观锁错位，必须由使用者在合适时机重启（见 README 的「启用」一节）。
#>
param(
  [string]$DshHome = "$env:USERPROFILE\.dsh",
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$pkgName = 'dsh-mobile-gateway'
$src = Join-Path $PSScriptRoot '..\packages\dsh-mobile-gateway'
$dst = Join-Path $DshHome ('node_modules\' + $pkgName)
$patch = Join-Path $DshHome 'cordis.patch.yml'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Info($m) { Write-Host ('==> ' + $m) }

if ($Uninstall) {
  if (Test-Path $dst) { Remove-Item $dst -Recurse -Force; Info ('已移除 ' + $dst) }
  Info '请手动从 patch 文件里删除 mobile-gateway 那一段'
  exit 0
}

if (-not (Test-Path $src)) { throw ('找不到源目录：' + $src) }

Info ('复制插件到 ' + $dst)
if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item -Path (Join-Path $src '*') -Destination $dst -Recurse -Force -Exclude 'node_modules', 'test'

Info '安装运行时依赖（ws / qrcode）'
$runtime = 'C:\Users\me\AppData\Local\Programs\DeepSeek Harness\resources\runtime'
$node = Join-Path $runtime 'primary-runtime\dependencies\node\bin\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $node) { throw '找不到 node 可执行文件' }
$pnpm = Join-Path $runtime 'pnpm\bin\pnpm.cjs'
if (-not (Test-Path $pnpm)) { throw '找不到 DSH 自带的 pnpm.cjs' }

& $node $pnpm install --dir $dst --ignore-workspace --node-linker=hoisted --prod --ignore-scripts 2>&1 |
  Select-Object -Last 6

Info ('注册到机器级 patch：' + $patch)
$content = [System.IO.File]::ReadAllText($patch)
if ($content -match 'id: mobile-gateway') {
  Info '注册行已存在，跳过'
} else {
  $lines = @(
    '',
    '- insert:',
    ('    - id: mobile-gateway'),
    ('      name: ' + $pkgName),
    '      # config:',
    "      #   publicBaseUrl: ''   # 配了公网地址，管理面板才会出二维码",
    ''
  )
  $next = ($content.TrimEnd() + "`n") + ($lines -join "`n")
  [System.IO.File]::WriteAllText($patch, $next, $utf8)
  Info '已追加 mobile-gateway 注册行'
}

Info '完成。重启 DSH 后生效。'
Info '管理面板：http://127.0.0.1:<DSH 端口>/mobile-gateway/manage'