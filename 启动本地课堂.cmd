@echo off
"%~dp0.venv\Scripts\python.exe" "%~dp0scripts\start_classroom_preview.py"
if errorlevel 1 (
  pause
  exit /b 1
)
start "" "http://127.0.0.1:8014/classroom/"
