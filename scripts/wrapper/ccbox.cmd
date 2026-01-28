@echo off
REM ccbox wrapper launcher for Windows
REM Calls the PowerShell wrapper script

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0ccbox.ps1" %*
