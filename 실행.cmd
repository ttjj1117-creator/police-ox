@echo off
cd /d "%~dp0"
python -m http.server 5173 --bind 127.0.0.1 --directory dist
pause
