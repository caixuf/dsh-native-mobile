/**
 * Gradle 可执行文件解析（跨平台，Windows 本机 + Linux CI 共用）。
 *
 * ## 为什么要有这个模块
 *
 * 原来 `build-apk.mjs` / `test-android.mjs` 各自硬编码了本机的
 * `C:\Users\20247\Downloads\android-toolchain\gradle-8.11.1\bin\gradle.bat`，
 * 找不到就退回 PATH 上的 `gradle`。这在 GitHub Actions 的 ubuntu runner 上
 * 会直接失败（runner 上既没有那个 Windows 路径，也没有全局 gradle）。
 *
 * 现在按优先级解析：
 *   1. `GRADLE_BIN` 环境变量（显式覆盖，保留给特殊环境）
 *   2. 仓库自带的 wrapper（`android/gradlew` / `android/gradlew.bat`）
 *      —— CI 与换机器场景应当走这条，自带版本锁定，不依赖系统装了什么
 *   3. 本机固定安装目录（Windows 开发机）
 *   4. PATH 上的 `gradle`
 *
 * wrapper 之所以排在本地固定路径前面：wrapper 的版本由
 * `gradle/wrapper/gradle-wrapper.properties` 锁定，判断依据可复现；
 * 而本机那份安装目录是"恰好这台机器上有"，换一台就没了。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.resolve(here, '..', '..');
export const androidDir = path.join(rootDir, 'android');

const defaultWinGradle = 'C:\\Users\\20247\\Downloads\\android-toolchain\\gradle-8.11.1\\bin\\gradle.bat';
const defaultWinJava = 'C:\\Users\\20247\\Downloads\\android-toolchain\\jdk17';

/** 返回 `{ bin, kind }`；`kind` 用于日志与排障（wrapper / local / path / env）。 */
export function resolveGradle() {
  if (process.env.GRADLE_BIN) {
    return { bin: process.env.GRADLE_BIN, kind: 'env' };
  }

  const wrapper = path.join(androidDir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
  if (fs.existsSync(wrapper)) {
    return { bin: wrapper, kind: 'wrapper' };
  }

  if (process.platform === 'win32' && fs.existsSync(defaultWinGradle)) {
    return { bin: defaultWinGradle, kind: 'local' };
  }

  return { bin: 'gradle', kind: 'path' };
}

/** JAVA_HOME 只在需要时补：显式设置了就尊重，否则用本机固定 JDK。 */
export function resolveJavaHome() {
  if (process.env.JAVA_HOME) return process.env.JAVA_HOME;
  if (process.platform === 'win32' && fs.existsSync(defaultWinJava)) return defaultWinJava;
  return undefined;
}

/** 拼一份可直接交给 execSync 的环境变量。 */
export function gradleEnv() {
  const javaHome = resolveJavaHome();
  return { ...process.env, ...(javaHome ? { JAVA_HOME: javaHome } : {}) };
}
