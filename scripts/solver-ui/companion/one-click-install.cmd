@echo off
setlocal
set "KISH_SOLVER_SFX_ROOT=%~dp0"
set "KISH_SOLVER_INSTALL_TMP=%TEMP%\KishPokerSolverInstall-%RANDOM%-%RANDOM%"
echo [KishPoker Solver Setup] Starting installer...
mkdir "%KISH_SOLVER_INSTALL_TMP%" >nul 2>&1

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%KISH_SOLVER_SFX_ROOT%one-click-install.ps1" -PayloadPath "%KISH_SOLVER_SFX_ROOT%payload.zip" -DestinationPath "%KISH_SOLVER_INSTALL_TMP%"
set "KISH_SOLVER_INSTALL_EXIT=%ERRORLEVEL%"

if exist "%KISH_SOLVER_INSTALL_TMP%" rmdir /s /q "%KISH_SOLVER_INSTALL_TMP%"
if not "%KISH_SOLVER_INSTALL_EXIT%"=="0" (
  echo.
  echo KishPoker Solver installation failed. Error code: %KISH_SOLVER_INSTALL_EXIT%
  echo See "%LOCALAPPDATA%\KishPoker\Solver\install.log" for details.
  if not "%KISH_SOLVER_INSTALL_UNATTENDED%"=="1" if not "%KISH_SOLVER_INSTALL_NO_BROWSER%"=="1" pause
)
exit /b %KISH_SOLVER_INSTALL_EXIT%
