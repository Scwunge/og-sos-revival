@echo off
rem Starts an SOS: Classic community server. Edit server.cfg first.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0sos-server.ps1" %*
if errorlevel 1 (
  echo.
  echo The server script reported an error ^(see above^).
  pause
)
