# Update AgenticCore HQ to the latest code and restart it. Run as Administrator:
#   powershell -ExecutionPolicy Bypass -File C:\AgenticCoreHQ\scripts\update.ps1
$ErrorActionPreference = 'Stop'
$Dir = Split-Path -Parent $PSScriptRoot
Set-Location $Dir
# Pick up Node/Git even in a window opened before they were installed.
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
git pull --ff-only
npm install --omit=dev --no-audit --no-fund | Out-Host
Stop-ScheduledTask -TaskName 'AgenticCore HQ' -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*src*index.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-ScheduledTask -TaskName 'AgenticCore HQ'
Write-Host 'Updated and restarted.' -ForegroundColor Green
