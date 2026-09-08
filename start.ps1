param([string]$Python = 'python')
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (!(Test-Path '.venv/Scripts/python.exe')) {
    & $Python -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Could not create Python virtual environment. Python 3.12+ is required.' }
}
$runtime = Join-Path $PSScriptRoot '.venv/Scripts/python.exe'
& $runtime -m pip install -r requirements.txt
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
if (!(Test-Path '.env')) { Copy-Item '.env.example' '.env' }
Write-Host 'Open http://127.0.0.1:8000 ; press Ctrl+C to stop.'
& $runtime -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
