@echo off
setlocal DisableDelayedExpansion
set "TASKLIGHT_PYTHON="
for %%I in (python.exe python3.exe) do (
    if not defined TASKLIGHT_PYTHON if not "%%~$PATH:I"=="" (
        "%%~$PATH:I" -c "import sys; sys.exit(sys.version_info[0] != 3)" >nul 2>&1
        if not errorlevel 1 set "TASKLIGHT_PYTHON=%%~$PATH:I"
    )
)
if not defined TASKLIGHT_PYTHON (
    >&2 echo TaskLight requires python or python3 on PATH.
    exit /b 1
)
pushd "%~dp0.." || exit /b 1
"%TASKLIGHT_PYTHON%" -m bridge.room %*
set "TASKLIGHT_STATUS=%ERRORLEVEL%"
popd
exit /b %TASKLIGHT_STATUS%
