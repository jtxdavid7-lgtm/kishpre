@echo off
setlocal
cd /d "%~dp0"

start "KishPoker Local Preview" cmd /k "npm.cmd run dev -- --host 127.0.0.1 --port 4173 --strictPort"
timeout /t 2 /nobreak >nul
start "" "http://localhost:4173/?tool=gto"

endlocal
