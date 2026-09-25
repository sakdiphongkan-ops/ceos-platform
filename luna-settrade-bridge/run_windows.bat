@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  py -3 -m venv .venv
  if errorlevel 1 (
    echo Python 3 is required. Install Python 3.10+ from python.org.
    exit /b 1
  )
  ".venv\Scripts\python.exe" -m pip install --upgrade pip
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt
)

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo Created .env from .env.example.
  echo Fill in the SETTRADE credentials and LUNA_GATEWAY_KEY, then run this file again.
  exit /b 0
)

".venv\Scripts\python.exe" bridge.py
endlocal
