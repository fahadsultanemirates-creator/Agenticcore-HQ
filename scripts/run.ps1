# Keeps AgenticCore HQ running (started by the "AgenticCore HQ" scheduled task).
$Dir = Split-Path -Parent $PSScriptRoot
Set-Location $Dir
New-Item -ItemType Directory -Force (Join-Path $Dir 'logs') | Out-Null
while ($true) {
  & node src/index.js *>> (Join-Path $Dir 'logs\service.log')
  Start-Sleep -Seconds 10
}
