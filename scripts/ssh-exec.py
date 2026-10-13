#!/usr/bin/env python3
"""
对远程 VPS 执行命令 / 上传文件的最小工具（供部署 dsh-mobile-gateway 公网入口时使用）。

凭据一律从环境变量读，**不写进文件、不进仓库**：

    set DSH_SSH_HOST=203.0.113.10
    set DSH_SSH_USER=root
    set DSH_SSH_PASSWORD=...
    python scripts/ssh-exec.py "uname -a"
    python scripts/ssh-exec.py --put local.conf:/etc/frp/frps.toml

Windows PowerShell 用 `$env:DSH_SSH_PASSWORD='...'`。
"""

from __future__ import annotations

import argparse
import os
import sys

import paramiko


def connect() -> paramiko.SSHClient:
    host = os.environ["DSH_SSH_HOST"]
    user = os.environ.get("DSH_SSH_USER", "root")
    # 优先用密钥（这台 VPS 关掉了密码认证）；没有密钥时才回落到密码。
    key_path = os.environ.get("DSH_SSH_KEY")
    password = os.environ.get("DSH_SSH_PASSWORD")

    kwargs: dict = {}
    if key_path:
        key = paramiko.Ed25519Key.from_private_key_file(key_path)
        kwargs["pkey"] = key
    elif password:
        kwargs["password"] = password
    else:
        raise SystemExit("需要 DSH_SSH_KEY（私钥路径）或 DSH_SSH_PASSWORD")

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        host,
        port=int(os.environ.get("DSH_SSH_PORT", "22")),
        username=user,
        timeout=20,
        banner_timeout=30,
        auth_timeout=30,
        look_for_keys=False,
        allow_agent=False,
        **kwargs,
    )
    return client


def run(command: str) -> int:
    client = connect()
    try:
        _stdin, stdout, stderr = client.exec_command(command, get_pty=False)
        out = stdout.read().decode("utf-8", "replace")
        err = stderr.read().decode("utf-8", "replace")
        code = stdout.channel.recv_exit_status()
        # ⚠️ 必须显式指定 encoding：中文 Windows 的控制台默认 GBK，
        # 远端输出里只要有一个 ✅/❌/→ 之类字符，sys.stdout.write 就会抛
        # UnicodeEncodeError 把整个脚本打断（实测踩过：脚本其实跑成功了，
        # 却在打印 ✅ 时崩掉，看起来像失败）。
        if out:
            _write(sys.stdout, out)
        if err:
            _write(sys.stderr, err)
        return code
    finally:
        client.close()


def _write(stream, text: str) -> None:
    """按流自身的编码写出，必要时降级替换，绝不因编码问题抛异常。"""
    enc = getattr(stream, "encoding", None) or "utf-8"
    try:
        stream.write(text)
    except UnicodeEncodeError:
        stream.write(text.encode(enc, "replace").decode(enc, "replace"))
    stream.flush()


def run_script(local: str) -> int:
    """把本地 shell 脚本喂给远端 `bash -s`。多行脚本别内联进命令行——引号会被吃掉。"""
    with open(local, "r", encoding="utf-8") as handle:
        script = handle.read()
    client = connect()
    try:
        _stdin, stdout, stderr = client.exec_command("bash -s", get_pty=False)
        stdout.channel.sendall(script.encode("utf-8"))
        stdout.channel.shutdown_write()
        out = stdout.read().decode("utf-8", "replace")
        err = stderr.read().decode("utf-8", "replace")
        code = stdout.channel.recv_exit_status()
        if out:
            _write(sys.stdout, out)
        if err:
            _write(sys.stderr, err)
        return code
    finally:
        client.close()


def _split_put(spec: str) -> tuple[str, str]:
    """拆 `LOCAL:REMOTE`。

    ⚠️ 不能直接 `partition(':')` —— Windows 绝对路径自带盘符
    （`C:\\Users\\...`），第一个冒号会把路径切成 `C` 和 `\\Users\\...`，
    表现为 `FileNotFoundError: 'C'`（实测踩过）。

    规则：**从右往左**找那个「后面不含盘符」的冒号，
    即用 `rsplit(':', 1)`，并要求右侧部分不含 `\\`（远端路径是 POSIX）。
    """
    left, sep, right = spec.rpartition(":")
    if not sep:
        return spec, ""
    # 右段像 Windows 盘符（如 `C:\...`）说明整体没有分隔符
    if len(right) >= 2 and right[1] in ":\\/":
        return spec, ""
    return left, right


def get(remote: str, local: str) -> int:
    client = connect()
    try:
        with client.open_sftp() as sftp:
            sftp.get(remote, local)
        print(f"downloaded {remote} -> {local}")
        return 0
    finally:
        client.close()


def put(local: str, remote: str) -> int:
    client = connect()
    try:
        with client.open_sftp() as sftp:
            sftp.put(local, remote)
        print(f"uploaded {local} -> {remote}")
        return 0
    finally:
        client.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="DSH VPS 远程执行器")
    parser.add_argument("command", nargs="?", help="要在远端执行的 shell 命令")
    parser.add_argument("--script", metavar="LOCAL_SH", help="把本地 shell 脚本喂给远端 bash -s")
    parser.add_argument("--put", metavar="LOCAL:REMOTE", help="上传文件，如 conf/frps.toml:/etc/frp/frps.toml")
    parser.add_argument("--get", metavar="REMOTE:LOCAL", help="下载文件（凭据类文件推荐走这条，不经过命令行）")
    args = parser.parse_args()

    # 兜底：中文 Windows 的控制台默认 GBK，远端输出含 ✅/❌/→ 等字符会
    # 直接抛 UnicodeEncodeError 把脚本打断。这里统一改成 errors='replace'，
    # 保证「命令失败」和「打印失败」能被区分开。
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except Exception:
            pass

    if args.put:
        local, remote = _split_put(args.put)
        if not remote:
            parser.error("--put 需要 LOCAL:REMOTE 形式")
        return put(local, remote)
    if args.get:
        remote, local = _split_put(args.get)
        if not local:
            parser.error("--get 需要 REMOTE:LOCAL 形式")
        return get(remote, local)
    if args.script:
        return run_script(args.script)
    if not args.command:
        parser.error("需要给出命令、--script 或 --put")
    return run(args.command)


if __name__ == "__main__":
    raise SystemExit(main())