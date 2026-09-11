@echo off
setlocal
set "SOLVER_UI_HOST=127.0.0.1"
set "SOLVER_UI_PORT=8788"
set "SOLVER_UI_DATA_ROOT=%LOCALAPPDATA%\KishPoker\Solver\runs-v1"
set "POSTFLOP_SOLVER_ROOT=%~dp0engine"
set "POSTFLOP_SOLVER_BINARY=%~dp0engine\gg_fulltree_direct_pack.exe"
set "SOLVER_UI_ALLOWED_ORIGINS=https://kishpoker.cn,https://www.kishpoker.cn,http://localhost:5173,http://127.0.0.1:5173"
if not exist "%LOCALAPPDATA%\KishPoker\Solver" mkdir "%LOCALAPPDATA%\KishPoker\Solver"
"%~dp0node.exe" "%~dp0app\server.mjs" >> "%LOCALAPPDATA%\KishPoker\Solver\companion.log" 2>&1
