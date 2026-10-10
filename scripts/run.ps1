# Keeps AgenticCore HQ running (started by the "AgenticCore HQ" scheduled task).
$Dir = Split-Path -Parent $PSScriptRoot
Set-Location $Dir
# Fresh search path on every start, so newly installed tools (ffmpeg) are found.
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine')
New-Item -ItemType Directory -Force (Join-Path $Dir 'logs') | Out-Null
while ($true) {
  & node src/index.js *>> (Join-Path $Dir 'logs\service.log')
  Start-Sleep -Seconds 10
}
