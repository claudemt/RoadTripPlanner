@echo off
setlocal
cd /d "%~dp0"
if not defined AMAP_ROUTE_HOST set "AMAP_ROUTE_HOST=127.0.0.1"
if not defined ROADTRIP_REQUIRE_USER_EMAIL set "ROADTRIP_REQUIRE_USER_EMAIL=false"
if not defined ROADTRIP_FALLBACK_USER_EMAIL set "ROADTRIP_FALLBACK_USER_EMAIL=local@example.test"
echo Building publishable web app...
call npm --prefix app run build
if errorlevel 1 (
  echo Web build failed.
  pause
  exit /b 1
)
echo Starting RoadTripPlanner on http://127.0.0.1:6137 ...
start "" "http://127.0.0.1:6137"
node app\server\route-render-server.js
pause
