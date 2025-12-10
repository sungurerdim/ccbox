@echo off
docker desktop start
for %%i in ("%CD%") do set "DIRNAME=%%~nxi"
docker run -it --rm -e CLAUDE_CONFIG_DIR=/home/node/.claude -v "%CD%:/home/node/%DIRNAME%" -w "/home/node/%DIRNAME%" -v "%USERPROFILE%/.claude:/home/node/.claude" claude-code:latest %*
