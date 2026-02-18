@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
set "VENCORD_USER_DATA_DIR=%~dp0"
set "VENCORD_DEV_INSTALL=1"

set "COUNT=0"
set "DISCORD_PATH="

for %%B in ("%LOCALAPPDATA%" "%PROGRAMFILES%" "%PROGRAMFILES(X86)%") do (
  if exist "%%~fB" (
    for /d %%D in ("%%~fB\Discord*") do (
      if exist "%%~fD\Update.exe" (
        set /a COUNT+=1
        set "CANDIDATE_!COUNT!=%%~fD"
      )
    )
  )
)

if "%COUNT%"=="0" goto :fallbackPicker
if "%COUNT%"=="1" (
  set "DISCORD_PATH=!CANDIDATE_1!"
  goto :foundPath
)

echo.
echo Found multiple Discord installs:
for /L %%I in (1,1,%COUNT%) do (
  echo   [%%I] !CANDIDATE_%%I!
)

:chooseInstall
echo.
set /p CHOICE=Choose install number to patch: 
if not defined CHOICE goto :chooseInstall
echo %CHOICE%| findstr /r "^[0-9][0-9]*$" >nul || (
  echo Invalid choice.
  goto :chooseInstall
)
if %CHOICE% LSS 1 (
  echo Invalid choice.
  goto :chooseInstall
)
if %CHOICE% GTR %COUNT% (
  echo Invalid choice.
  goto :chooseInstall
)
set "DISCORD_PATH=!CANDIDATE_%CHOICE%!"
goto :foundPath

:fallbackPicker
echo.
echo Could not auto-detect any Discord install automatically.
echo Falling back to installer picker...
"%~dp0VencordInstallerCli.exe" --install
goto :done

:foundPath
echo.
echo Using Discord path: "%DISCORD_PATH%"
"%~dp0VencordInstallerCli.exe" --install --location "%DISCORD_PATH%"

:done
if errorlevel 1 (
  echo.
  echo Install failed.
  echo If prompted for path in another script version, use the full folder path:
  echo C:\Users\YourUser\AppData\Local\Discord
) else (
  echo.
  echo Install complete. Fully restart Discord.
)
pause
