@echo off
cd /d "%~dp0"

echo Building radar_backend.exe with PyInstaller...
py -m PyInstaller ^
  --onefile ^
  --name radar_backend ^
  --distpath ..\src-tauri\binaries ^
  --specpath build_tmp ^
  --workpath build_tmp ^
  --collect-all numpy ^
  --hidden-import numpy ^
  --hidden-import numpy.core ^
  --hidden-import numpy.lib ^
  server.py

if %ERRORLEVEL% equ 0 (
  echo.
  echo Done. Output: ..\src-tauri\binaries\radar_backend.exe
) else (
  echo.
  echo Build FAILED with error %ERRORLEVEL%
  exit /b %ERRORLEVEL%
)
