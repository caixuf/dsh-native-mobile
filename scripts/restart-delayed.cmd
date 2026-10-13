@echo off
REM Delayed DSH restart + event-stream verification.
REM Runs detached so the restart cannot kill it.
REM NOTE: ASCII only. cmd.exe reads .cmd as ANSI, so non-ASCII comments
REM would be executed as commands (this file was hit by that bug once).
REM NOTE: no `timeout` -- it fails in a non-interactive context.
powershell -NoProfile -Command "Start-Sleep -Seconds 60"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart-and-verify.ps1"
