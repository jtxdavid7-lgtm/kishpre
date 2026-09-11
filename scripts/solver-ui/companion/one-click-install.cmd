@echo off
setlocal
set "KISH_SOLVER_SFX_ROOT=%~dp0"
set "KISH_SOLVER_INSTALL_TMP=%TEMP%\KishPokerSolverInstall-%RANDOM%-%RANDOM%"
mkdir "%KISH_SOLVER_INSTALL_TMP%" >nul 2>&1

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath (Join-Path $env:KISH_SOLVER_SFX_ROOT 'payload.zip') -DestinationPath $env:KISH_SOLVER_INSTALL_TMP -Force; & (Join-Path $env:KISH_SOLVER_INSTALL_TMP 'install.ps1')"
set "KISH_SOLVER_INSTALL_EXIT=%ERRORLEVEL%"

if exist "%KISH_SOLVER_INSTALL_TMP%" rmdir /s /q "%KISH_SOLVER_INSTALL_TMP%"
if not "%KISH_SOLVER_INSTALL_EXIT%"=="0" (
  echo.
  echo KishPoker Solver installation failed. Error code: %KISH_SOLVER_INSTALL_EXIT%
)
exit /b %KISH_SOLVER_INSTALL_EXIT%
