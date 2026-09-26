param([string]$Python = 'python', [ValidateRange(1024,65535)][int]$Port = 8015)
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
& $runtime scripts/start_classroom_preview.py --port $Port --foreground
exit $LASTEXITCODE
