#!/usr/bin/env python3
"""
真机端到端测试：用 adb 驱动手机完成登录，并在电脑侧验证令牌真的落库了。

这是本项目的教训补齐 —— 之前一直是「改完就发版」，从没在真机上验证过
登录这条链路，导致用户反复试错。这里把验证固化成脚本：

  1. 手机 ping + HTTPS 自检（网络与证书）
  2. 清空 App 数据，从零开始
  3. 唤醒屏幕并解锁（息屏时 tap 会全部落空，先确保 mWakefulness=Awake）
  4. 用 uiautomator dump 拿到真实控件坐标，按 label 定位而不是硬编码像素
  5. 逐个输入框填值、点登录
  6. 校验：App 内部存储有记录 **且** 网关侧能看到这台设备

用法：
  python scripts/device-e2e.py --password <密码> [--base https://203.0.113.10:2444]
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

ADB = r"C:\Users\me\Downloads\android-toolchain\android-sdk\platform-tools\adb.exe"
PKG = "io.github.dshmobile.app"
PKG_LABEL = "dshmobile.app"
USER = "dsh"

PASS = 0
FAIL = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  ok   {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name} {detail}")


SERIAL = None


def adb(*args: str, timeout: int = 60) -> str:
    """跑 adb 并返回 stdout（去空行）。失败不抛，调用方自己判。"""
    cmd = [ADB] + (["-s", SERIAL] if SERIAL else []) + list(args)
    proc = subprocess.run(
        cmd, capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=timeout,
    )
    return (proc.stdout or "").strip()


def sh(command: str, timeout: int = 30) -> str:
    """在手机 shell 里跑命令。"""
    return adb("shell", command, timeout=timeout)


# ---- 1. 网络自检 ---------------------------------------------------------

def check_network(base: str) -> None:
    host = re.sub(r"^https?://", "", base).split(":")[0]
    print("\n[1] 网络自检（用手机自己的网络）")

    ping = sh("ping -c 2 -W 3 " + host)
    reachable = "2 received" in ping or "1 received" in ping
    check(f"手机能 ping 通 {host}", reachable, ping.replace("\n", " ")[-90:])

    https = sh(
        f"curl -sS -o /dev/null -w '%{{http_code}} %{{time_total}}' --max-time 20 "
        f"{base}/mobile-gateway/health"
    )
    parts = https.split()
    check(f"手机能 HTTPS 访问网关（证书可信）", parts and parts[0] == "200",
          f"返回={https!r}")


# ---- 2. 从零开始 ---------------------------------------------------------

def reset_app() -> None:
    """从零开始。

    ⚠️ 不用 `pm clear`：realme（以及不少国产 ROM）禁止 shell 身份执行
    CLEAR_APP_USER_DATA，会抛 SecurityException。改用卸载重装，效果一样且人人可用。
    """
    print("\n[2] 卸载后重装（pm clear 在 realme 上被系统拦）")
    adb("shell", "am", "force-stop", PKG)
    out = adb("uninstall", PKG)
    check("卸载旧版", "Success" in out, out)
    adb("logcat", "-c")
    apk = Path(r"C:\Users\me\Downloads\aiwork\dsh-native-mobile\apps\android\app\build\outputs\apk\debug\app-debug.apk")
    if not apk.exists():
        check("APK 存在", False, str(apk))
        return
    out = adb("install", str(apk))
    check("安装 APK", "Success" in out, out)


def wake_up() -> None:
    """屏幕息屏时所有 tap 都会落空，必须先确保 Awake 并解锁。"""
    print("\n[3] 唤醒屏幕")
    adb("shell", "input", "keyevent", "KEYCODE_WAKEUP")
    time.sleep(0.6)
    adb("shell", "input", "keyevent", "KEYCODE_MENU")  # 多数机型用 MENU 解锁无密码锁屏
    time.sleep(0.6)
    adb("shell", "wm", "dismiss-keyguard")
    time.sleep(0.8)
    awake = "mWakefulness=Awake" in sh("dumpsys power | grep mWakefulness")
    check("屏幕已唤醒", awake, sh("dumpsys power | grep mWakefulness")[:80])
    if not awake:
        print("      ⚠️ 屏幕没醒，需要你手动点亮并解锁后重跑")


# ---- 4. 用 uiautomator 定位控件 -------------------------------------------

def dump_ui() -> str:
    """把当前界面的控件树 dump 到 stdout。"""
    adb("shell", "uiautomator", "dump", "/sdcard/ui.xml", timeout=40)
    xml = sh("cat /sdcard/ui.xml", timeout=40)
    # 偶尔会带 "UI hierchary dumped to: ..." 前缀，只取 XML 部分
    start = xml.find("<?xml")
    return xml[start:] if start >= 0 else xml


def find_center(xml: str, needle: str, exact: bool = False) -> tuple[int, int] | None:
    """按 text / content-desc 找控件中心点。找不到返回 None。

    用控件树定位而不是硬编码坐标 —— 硬编码会因为键盘弹起后布局位移而点错位置。
    """
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return None
    for node in root.iter("node"):
        text = node.get("text", "")
        desc = node.get("content-desc", "")
        hay = f"{text} {desc}"
        hit = (hay.strip() == needle) if exact else (needle in hay)
        if hit:
            bounds = node.get("bounds", "")
            m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", bounds)
            if m:
                x1, y1, x2, y2 = map(int, m.groups())
                return (x1 + x2) // 2, (y1 + y2) // 2
    return None


def find_editable(xml: str, hint: str) -> tuple[int, int] | None:
    """按 hint 找输入框 —— **已废弃，Compose 不导出 hint**。保留仅为兼容旧 XML。

    🔴 实测记录（省得后人再踩）：Compose 的 OutlinedTextField 在 uiautomator
    里是**一个** EditText 节点，**没有 hint / content-desc 属性** —— hint 是
    Compose 自己画上去的。所以「按 hint 找」永远找不到；早前按 label（「密码」）
    找更糟，那是另一个 Text 节点，tap 上去焦点进不去，内容被填进上一个框。

    现在改用 `find_editables()` 按顺序取。
    """
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return None
    for node in root.iter("node"):
        if "EditText" not in node.get("class", ""):
            continue
        h = node.get("hint", "") or node.get("content-desc", "")
        if hint and hint in h:
            return _center(node)
    return None


def _center(node) -> tuple[int, int] | None:
    m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", node.get("bounds", ""))
    if not m:
        return None
    x1, y1, x2, y2 = map(int, m.groups())
    return (x1 + x2) // 2, (y1 + y2) // 2


def find_editables(xml: str) -> list[dict]:
    """按控件树顺序列出所有可编辑框。

    配对页的顺序是固定的：电脑地址 → 账号 → 密码。
    密码框有 `password="true"` 标记可作交叉校验。
    """
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return []
    out = []
    for node in root.iter("node"):
        if "EditText" not in node.get("class", ""):
            continue
        center = _center(node)
        if not center:
            continue
        out.append({
            "center": center,
            "text": node.get("text", ""),
            "password": node.get("password", "false") == "true",
            "bounds": node.get("bounds", ""),
        })
    return out


def tap(xy: tuple[int, int]) -> None:
    adb("shell", "input", "tap", str(xy[0]), str(xy[1]))
    time.sleep(0.7)


def type_text(value: str) -> None:
    """input text 的空格要写成 %s；':' '/' 等符号 Android 的 input text 能直接传。"""
    adb("shell", "input", "text", value.replace(" ", "%s"))
    time.sleep(0.5)


def keyboard_shown() -> bool:
    """软键盘是否可见。

    ⚠️ 只能在键盘**确实弹出**时按 BACK。之前无脑发 KEYCODE_BACK，
    键盘没弹的情况下会直接把 Activity 退回桌面 —— 脚本自己把 App 关掉，
    还误判成「App 崩了」，白排查半天。
    """
    return "mInputShown=true" in sh("dumpsys input_method | grep mInputShown")


def dismiss_keyboard() -> None:
    if keyboard_shown():
        adb("shell", "input", "keyevent", "KEYCODE_BACK")
        time.sleep(0.8)


# ---- 5. 走一遍登录 -------------------------------------------------------

def do_login(base: str, username: str, password: str) -> None:
    print("\n[4] 走登录流程（uiautomator 定位，不硬编码坐标）")

    # 从首页点「配对电脑」
    xml = dump_ui()
    btn = find_center(xml, "配对电脑")
    check("找到「配对电脑」按钮", btn is not None, xml[-200:])
    if not btn:
        return
    tap(btn)
    time.sleep(1.2)

    # 三个输入框按**控件树顺序**取：电脑地址 → 账号 → 密码。
    # （Compose 不导出 hint，按 label 找会 tap 到文字上，焦点进不去。）
    xml = dump_ui()
    fields = find_editables(xml)
    check("找到 3 个输入框", len(fields) >= 3, f"只找到 {len(fields)} 个")
    check("第 3 个是密码框（password=true）",
          len(fields) >= 3 and fields[2]["password"],
          str([f["password"] for f in fields]))

    values = [base, username, password]
    for i, value in enumerate(values):
        if i >= len(fields):
            break
        tap(fields[i]["center"])
        # 清空（账号框预填 dsh）
        adb("shell", "input", "keyevent", "KEYCODE_MOVE_END")
        for _ in range(40):
            adb("shell", "input", "keyevent", "KEYCODE_DEL")
        type_text(value)
        dismiss_keyboard()
        time.sleep(0.4)

    # 回读校验：三个框里真的有内容（防止又填错位置）
    xml = dump_ui()
    after = find_editables(xml)
    texts = [f["text"] for f in after[:3]]
    check("地址框有内容", bool(texts and texts[0]), str(texts))
    check("密码框有内容", len(texts) >= 3 and bool(texts[2]), str(texts))

    # 收完键盘后重新 dump 再找按钮
    dismiss_keyboard()
    xml = dump_ui()
    login_btn = find_center(xml, "登录")
    check("找到「登录」按钮", login_btn is not None, xml[-260:])
    if login_btn:
        tap(login_btn)
        time.sleep(5.0)


# ---- 6. 校验 -------------------------------------------------------------

def verify_stored() -> None:
    print("\n[5] 校验 1/3：设备记录真的落盘了")
    xml = sh(f"cat /data/data/{PKG}/shared_prefs/dsh_hosts.xml 2>/dev/null")
    check("存储文件存在", "<map" in xml, f"len={len(xml)} {xml[:80]}")
    # 光有密钥集不算数 —— 早期版本的 bug 就是只有 keyset、没有 hosts。
    check("里面有 hosts 记录", 'name="hosts"' in xml, xml[:160])


def verify_ui_reached_sessions() -> None:
    print("\n[5] 校验 2/3：界面真的到了会话列表")
    xml = dump_ui()
    # 会话列表页的标志：标题「会话」+ 至少有若干行，或明确的空态文案
    has_title = "会话" in xml
    rows = len(re.findall(r'class="android\.widget\.(TextView|Button)"[^>]*text="[^"]{2,}"', xml))
    connected = "未连接" not in xml
    check("页面标题含「会话」", has_title, xml[-200:])
    check("不再是「未连接」状态", connected, xml[-200:])
    print(f"      （可点击文本节点约 {rows} 个）")


def verify_gateway_sees_device() -> None:
    print("\n[5] 校验 3/3：网关侧能看到这台设备")
    state = sh(f"curl -s --max-time 10 http://127.0.0.1:19387/mobile-gateway/manage/api/state")
    try:
        data = json.loads(state)
    except json.JSONDecodeError:
        check("网关管理接口可读", False, state[:120])
        return
    devices = data.get("devices") or []
    check("网关记录到至少一台设备", len(devices) >= 1,
          f"devices={len(devices)}")
    for d in devices[-3:]:
        print(f"      · {d.get('name')}  id={d.get('id')}")


# ---- 截图 ----------------------------------------------------------------

def screenshot(name: str) -> None:
    """用 exec-out 直传二进制；`adb shell cat` 会把 PNG 管道搞坏。"""
    shot = Path(rf"C:\Users\me\AppData\Local\Temp\{name}.png")
    cmd = [ADB] + (["-s", SERIAL] if SERIAL else []) + ["exec-out", "screencap", "-p"]
    proc = subprocess.run(cmd, capture_output=True, timeout=60)
    if proc.stdout[:4] == b"\x89PNG":
        shot.write_bytes(proc.stdout)
        print(f"      截图: {shot}")
    else:
        print(f"      ⚠️ 截图失败（拿到 {proc.stdout[:16]!r}）")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--password", required=True)
    parser.add_argument("--base", default="https://203.0.113.10:2444")
    parser.add_argument("--user", default=USER)
    parser.add_argument("--serial", help="目标设备 serial，省略则用 adb 默认设备")
    args = parser.parse_args()

    print("=" * 64)
    print("DSH 移动端 真机端到端测试")
    print(f"目标: {args.base}")
    print("=" * 64)

    global SERIAL
    if args.serial:
        SERIAL = args.serial
        print(f"目标设备: {SERIAL}")

    check_network(args.base)
    reset_app()
    wake_up()
    adb("shell", "am", "start", "-n", f"{PKG}/.MainActivity")
    time.sleep(2.5)
    do_login(args.base, args.user, args.password)
    screenshot("e2e-01-after-login")

    verify_stored()
    verify_ui_reached_sessions()
    verify_gateway_sees_device()
    screenshot("e2e-02-final")

    print("\n" + "=" * 64)
    print(f"结果：{PASS} 通过 / {FAIL} 失败")
    print("截图：C:\\Users\\me\\AppData\\Local\\Temp\\e2e-01-after-login.png")
    print("      C:\\Users\\me\\AppData\\Local\\Temp\\e2e-02-final.png")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())