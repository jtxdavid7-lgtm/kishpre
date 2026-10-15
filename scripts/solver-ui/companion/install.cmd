@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
set "KISH_SOLVER_INSTALL_EXIT=%ERRORLEVEL%"
if not "%KISH_SOLVER_INSTALL_EXIT%"=="0" (
  echo.
  echo Installation failed. See "%LOCALAPPDATA%\KishPoker\Solver\install.log" for details.
  if not "%KISH_SOLVER_INSTALL_UNATTENDED%"=="1" if not "%KISH_SOLVER_INSTALL_NO_BROWSER%"=="1" pause
)
exit /b %KISH_SOLVER_INSTALL_EXIT%
