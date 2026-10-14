import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// ── 正式签名凭据 ────────────────────────────────────────────────────────────
//
// 从 `apps/android/keystore.properties` 读取（该文件**已在 .gitignore 中**，
// 绝不提交）。仓库里只放 `keystore.properties.example` 作为模板。
//
// 为什么做成「读不到就回退 debug 签名」：
// 别人 clone 这个开源仓库后没有我们的私钥，若硬性要求 keystore 会让
// `assembleRelease` 直接失败。回退后他们能出一条可安装的包，
// 只是不能覆盖安装我们签名的版本 —— 这是开源项目的常规做法。
val keystorePropsFile = rootProject.file("keystore.properties")
val keystoreProps = Properties().apply {
    if (keystorePropsFile.exists()) {
        keystorePropsFile.inputStream().use { load(it) }
    }
}
val hasReleaseSigning = keystoreProps.getProperty("storeFile")?.isNotBlank() == true

// 🔴 交付包防线（2026-10-14 真实事故后加入）
//
// ## 事故
//
// `dist-apk/dsh-mobile-v0.2.0.apk` 被交付时**实际是 debug 签名**
// （`CN=Android Debug` / `ec048588…`），而 v0.1.0~v0.1.2 用的是正式签名
// （`CN=DSH Native Mobile` / `912ff2b9…`）。
//
// 后果：Android 发现签名不一致会**强制卸载重装** → **App 全部数据被清空**
// → 用户表现为「登录态保不住、每次都要重新登录配对」。
//
// 根因是这个「读不到 keystore 就静默回退 debug 签名」的分支：它让一条
// debug 包**看起来像**正式发布包，谁都无法从文件名分辨。
//
// ## 现在的规则
//
// - 打 `-PrequireReleaseSigning=true`（发版脚本会带）时，**没有正式签名就直接报错**，
//   绝不静默降级 —— 宁可构建失败，也不要交出会清空用户数据的包。
// - 普通 `assembleRelease`（如 clone 开源仓库的人）仍允许回退，但会在日志里
//   **大声警告**签名不一致的问题。
val requireReleaseSigning = (project.findProperty("requireReleaseSigning") as String?) == "true"
if (requireReleaseSigning && !hasReleaseSigning) {
    throw GradleException(
        "缺少正式签名：apps/android/keystore.properties 不存在或 storeFile 为空。\n" +
            "用 debug 签名交付会让已安装用户被强制卸载重装、数据清空。\n" +
            "请补齐 keystore.properties，或去掉 -PrequireReleaseSigning=true。",
    )
}
if (!hasReleaseSigning) {
    logger.warn(
        "⚠️ 未配置正式签名，release 将回退到 **debug 签名**。" +
            "该产物【不能】用于覆盖安装正式版用户 —— 会导致签名冲突并清空其数据。",
    )
}

android {
    namespace = "io.github.dshmobile.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.dshmobile.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 5
        versionName = "0.2.1"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            // 有正式 keystore 就用它；否则回退 debug 签名（见文件顶部说明）。
            signingConfig = if (hasReleaseSigning) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}")
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.ui)
    implementation(libs.androidx.ui.graphics)
    implementation(libs.androidx.ui.tooling.preview)
    implementation(libs.androidx.material3)
    implementation(libs.androidx.material.icons.extended)
    implementation(libs.androidx.navigation.compose)

    implementation(libs.androidx.datastore.preferences)
    implementation(libs.androidx.security.crypto)

    implementation(libs.androidx.camera.core)
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)
    implementation(libs.zxing.core)

    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)

    debugImplementation(libs.androidx.ui.tooling)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
}