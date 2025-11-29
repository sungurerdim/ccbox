@echo off
net start com.docker.service >nul 2>&1
set PROJECT_PATH=%CD%
for %%I in ("%CD%") do set PROJECT_NAME=%%~nxI
set COMPOSE_FILE=D:\GitHub\claude_setup\claude-compose.yml

docker compose -f "%COMPOSE_FILE%" run --rm claude
if errorlevel 1 (
    echo.
    echo Claude Code hata ile sonlandi. Kod: %errorlevel%
    pause
)