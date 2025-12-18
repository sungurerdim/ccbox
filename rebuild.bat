@echo off
set "PKG_NAME=git+https://github.com/sungurerdim/ccbox.git"

start "" powershell -NoExit -Command "pip install --force-reinstall %PKG_NAME%; ccbox clean -f; pause"
