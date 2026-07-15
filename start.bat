@echo off
setlocal
cd /d "%~dp0"
echo Starting RoadTripPlanner on http://127.0.0.1:6137 ...
start "" "http://127.0.0.1:6137"
node app\server\route-render-server.js
pause
