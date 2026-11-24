@echo off
setlocal
pushd "%~dp0" || exit /b 1

where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo npm is required to start OpenBot Local on this computer.
  goto :failed
)

if not exist "node_modules\.bin\biome.exe" if not exist "node_modules\.bin\biome.cmd" (
  call npm.cmd exec --yes --package=bun@1.4.3 -- bun install --frozen-lockfile
  if errorlevel 1 goto :failed
)

call npm.cmd exec --yes --package=bun@1.4.3 -- bun run local:build
if errorlevel 1 goto :failed
call npm.cmd exec --yes --package=bun@1.4.3 -- bun run local:start
if errorlevel 1 goto :failed
popd
exit /b 0

:failed
popd
pause
exit /b 1
