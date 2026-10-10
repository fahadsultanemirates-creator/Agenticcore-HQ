# Update AgenticCore HQ to the latest code and restart it. Run as Administrator:
#   powershell -ExecutionPolicy Bypass -File C:\AgenticCoreHQ\scripts\update.ps1
$ErrorActionPreference = 'Stop'
$Dir = Split-Path -Parent $PSScriptRoot
Set-Location $Dir
# Pick up Node/Git even in a window opened before they were installed.
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
# Which copy is this (AgenticCore HQ or AgenticCore Lite)? The task name is in .env.
$task = 'AgenticCore HQ'
$envFile = Join-Path $Dir '.env'
if (Test-Path $envFile) { $l = Get-Content $envFile | Where-Object { $_ -like 'HQ_TASK=*' } | Select-Object -First 1; if ($l) { $task = $l.Substring(8).Trim() } }
git pull --ff-only
npm install --omit=dev --no-audit --no-fund | Out-Host
Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
# Stop only this copy's bot (older versions ran "node src/index.js" without a folder: that was always HQ).
$mine = Join-Path $Dir 'src\index.js'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
  $_.CommandLine -like "*$mine*" -or ($task -eq 'AgenticCore HQ' -and $_.CommandLine -match '\s"?src[\\/]index\.js')
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-ScheduledTask -TaskName $task
Write-Host "Updated and restarted ($task)." -ForegroundColor Green
