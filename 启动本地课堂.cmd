@echo off
"%~dp0.venv\Scripts\python.exe" "%~dp0scripts\start_classroom_preview.py" --open
if errorlevel 1 (
  pause
  exit /b 1
)
