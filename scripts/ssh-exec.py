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
        if out:
            sys.stdout.write(out)
        if err:
            sys.stderr.write(err)
        return code
    finally:
        client.close()


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
            sys.stdout.write(out)
        if err:
            sys.stderr.write(err)
        return code
    finally:
        client.close()


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

    if args.put:
        local, _, remote = args.put.partition(":")
        if not remote:
            parser.error("--put 需要 LOCAL:REMOTE 形式")
        return put(local, remote)
    if args.get:
        remote, _, local = args.get.partition(":")
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