# 从零构建 Android 工具链

本机已装好在 `C:\Users\me\Downloads\android-toolchain`，换机器时按下面走一遍。
全程不需要管理员权限，也不动系统 PATH。

```powershell
$root = 'C:\Users\<你>\Downloads\android-toolchain'
New-Item -ItemType Directory -Force -Path $root | Out-Null
```

## 1. JDK 17

AGP 8.7 要求 JDK 17。

```powershell
Invoke-WebRequest -Uri 'https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse?project=jdk' `
  -OutFile "$root\jdk17.zip"
Expand-Archive "$root\jdk17.zip" "$root\jdk-tmp"
Move-Item (Get-ChildItem "$root\jdk-tmp" -Directory)[0].FullName "$root\jdk17"
$env:JAVA_HOME = "$root\jdk17"
```

> **坑**：脚本里用 `$ErrorActionPreference='Stop'` 时，`java -version` 写 stderr 会被当成
> 终止性错误（`NativeCommandError`）从而中断脚本。把原生命令的输出重定向或临时放宽
> 错误策略。

## 2. Android SDK

```powershell
Invoke-WebRequest -Uri 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip' `
  -OutFile "$root\cmdline-tools.zip"
Expand-Archive "$root\cmdline-tools.zip" "$root\cmdline-tmp"
New-Item -ItemType Directory -Force -Path "$root\android-sdk\cmdline-tools" | Out-Null
Move-Item "$root\cmdline-tmp\cmdline-tools" "$root\android-sdk\cmdline-tools\latest"

$sdk = "$root\android-sdk"
$sdkmanager = (Get-ChildItem "$sdk\cmdline-tools" -Recurse -Filter sdkmanager.bat)[0].FullName
$env:ANDROID_SDK_ROOT = $sdk
(1..40 | ForEach-Object { 'y' }) | & $sdkmanager "--sdk_root=$sdk" --licenses
& $sdkmanager "--sdk_root=$sdk" 'platform-tools' 'platforms;android-35' 'build-tools;35.0.0'
```

> **坑**：`sdkmanager` 需要 JDK 才能跑，`JAVA_HOME` 必须先设好。
> `licenses` 子命令要交互输入，用管道喂 `y`；如果仍卡住，先跑一次不带参数的
> `sdkmanager --licenses` 手动确认。

## 3. Gradle

项目自带 wrapper，但**生成** wrapper 需要一份本地 Gradle：

```powershell
Invoke-WebRequest -Uri 'https://services.gradle.org/distributions/gradle-8.11.1-bin.zip' -OutFile "$root\gradle.zip"
Expand-Archive "$root\gradle.zip" "$root\gradle-tmp"
Move-Item (Get-ChildItem "$root\gradle-tmp" -Directory)[0].FullName "$root\gradle-8.11.1"

cd apps\android
& "$root\gradle-8.11.1\bin\gradle.bat" wrapper --gradle-version 8.11.1 --distribution-type bin
```

> **坑**：`gradle.bat` 会报 `JAVA_HOME is not set and no 'java' command could be found`。
> 同理，DSH 自带的 `node.cmd` 不能通过 PowerShell 的 `&` 传参，要直接用
> `runtime\primary-runtime\dependencies\node\bin\node.exe`。

## 4. local.properties

```properties
sdk.dir=C\:\\Users\\<你>\\Downloads\\android-toolchain\\android-sdk
```

已 gitignore——这是本机相关路径。

## 5. 编

```powershell
cd apps\android
.\gradlew.bat assembleDebug
# app\build\outputs\apk\debug\app-debug.apk
```

装到连着的手机：`& "$sdk\platform-tools\adb.exe" install -r app\build\outputs\apk\debug\app-debug.apk`

## 版本组合

| 组件 | 版本 | 说明 |
|---|---|---|
| Gradle | 8.11.1 | |
| AGP | 8.7.3 | 官方支持 compileSdk 35 |
| Kotlin | 2.0.21 | Compose 编译器插件随 Kotlin 2.0 内置 |
| compileSdk / targetSdk | 35 | 需要 `platforms;android-35` |
| Compose BOM | 2024.12.01 | |
| minSdk | 26 | `EncryptedSharedPreferences` 需要 |

`android-36` / `build-tools;36.0.0` 也装了，但本项目用的是 35；
若要升 compileSdk 请同步升 AGP，否则只是拿到一条「unsupported compileSdk」警告。