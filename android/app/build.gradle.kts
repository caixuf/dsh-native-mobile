plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "io.github.dshmobile.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.dshmobile.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 103
        versionName = "1.0.3"
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    sourceSets {
        getByName("main") {
            assets.srcDirs("src/main/assets")
        }
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    // 审批中继：原生 WebSocket
    implementation(libs.okhttp)

    // 协议契约测试跑在 JVM 上（org.json 之类的 Android 平台类在这里是抛异常的桩，
    // 所以契约逻辑刻意做成零依赖纯 Kotlin —— 见 MiniJson.kt 的说明）。
    testImplementation(libs.junit)
}
