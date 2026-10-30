# Switch AgenticCore Lite to Gemini (HQ and Outreach are not touched).
# Lite keeps its whole framework (tools, browser, approvals, budgets, Telegram); only the models
# change. A small local gateway (LiteLLM) on 127.0.0.1 translates the Claude engine's requests to
# Gemini, using the GEMINI_API_KEY in Lite's .env.
#
#   powershell -ExecutionPolicy Bypass -File C:\AgenticCoreHQ-Lite\scripts\lite-gemini.ps1
#   powershell -ExecutionPolicy Bypass -File C:\AgenticCoreHQ-Lite\scripts\lite-gemini.ps1 -Revert
#
# Models (Gemini ids are looked up from your account; set these in .env to force one):
#   LITE_GEMINI_MAIN   manager, talks with Fahad   newest gemini-3.8-flash   (thinking: medium)
#   LITE_GEMINI_HELPER helpers                     same as main              (thinking: medium)
#   LITE_GEMINI_SCOUT  scout + quick replies       newest gemini-3.5-flash   (thinking: low)
#   LITE_GEMINI_HARD   hard jobs (/model fable)    newest gemini-4 pro       (thinking: high)
param([switch]$Revert)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $Root '.env'
$gwDir = Join-Path $Root 'gateway'
$Port = '4123'
$GwTask = 'AgenticCore Lite Gateway'
$LiteLLMVersion = '1.106.6'

if (-not (Test-Path $envFile)) { throw "No .env in $Root. Run this from the Lite folder (C:\AgenticCoreHQ-Lite\scripts)." }
$lines = New-Object System.Collections.ArrayList
foreach ($l in (Get-Content $envFile)) { [void]$lines.Add($l) }
function Get-Val($key) { $l = $lines | Where-Object { $_ -like "$key=*" } | Select-Object -First 1; if ($l) { return $l.Substring($key.Length + 1) } else { return '' } }
function Set-Val($key, $value) {
  for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -like "$key=*") { $lines[$i] = "$key=$value"; return } }
  [void]$lines.Add("$key=$value")
}
function Remove-Val($key) { for ($i = $lines.Count - 1; $i -ge 0; $i--) { if ($lines[$i] -like "$key=*") { $lines.RemoveAt($i) } } }
function Save-Env { Set-Content -Path $envFile -Value $lines -Encoding ASCII }

if ((Get-Val 'HQ_LITE') -ne '1' -or (Get-Val 'HQ_OUTREACH') -eq '1') { throw 'This is only for the Lite bot. HQ and Outreach stay on Claude.' }
$task = Get-Val 'HQ_TASK'; if (-not $task) { $task = 'AgenticCore Lite' }
$MODEL_KEYS = @('HQ_MODEL', 'HQ_EFFORT', 'HQ_MODEL_HARD', 'HQ_HELPER_MODEL', 'HQ_HELPER_EFFORT', 'HQ_SCOUT_MODEL', 'HQ_SCOUT_EFFORT')

function Restart-Lite {
  Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
  $mine = Join-Path $Root 'src\index.js'
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*$mine*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-Sleep -Seconds 2
  Start-ScheduledTask -TaskName $task
  Write-Host "OK  '$task' restarted"
}

# ---------- Revert: back to Claude ----------
if ($Revert) {
  $backup = Get-Val 'CLAUDE_API_KEY_BACKUP'
  if (-not $backup) { throw 'No CLAUDE_API_KEY_BACKUP in .env: Lite was not switched by this script (nothing to revert).' }
  Set-Val 'ANTHROPIC_API_KEY' $backup
  foreach ($k in $MODEL_KEYS) { $old = Get-Val ('PRE_GEMINI_' + $k); Remove-Val $k; if ($old -and $old -ne '-') { Set-Val $k $old }; Remove-Val ('PRE_GEMINI_' + $k) }
  foreach ($k in @('ANTHROPIC_BASE_URL', 'HQ_ENGINE', 'HQ_FAST_MODEL', 'GATEWAY_KEY', 'CLAUDE_API_KEY_BACKUP')) { Remove-Val $k }
  Save-Env
  Stop-ScheduledTask -TaskName $GwTask -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $GwTask -Confirm:$false -ErrorAction SilentlyContinue
  Restart-Lite
  Write-Host "`nLite is back on Claude. The gateway is stopped (its folder $gwDir can be deleted)." -ForegroundColor Green
  return
}

Write-Host "`n=== AgenticCore Lite -> Gemini ===`n" -ForegroundColor Green

# ---------- 1. Gemini key and models ----------
$gkey = Get-Val 'GEMINI_API_KEY'
if (-not $gkey) {
  $s = Read-Host -AsSecureString 'Gemini API key (Google AI Studio), hidden as you type'
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { $gkey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b).Trim() } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
  if (-not $gkey) { throw 'Lite on Gemini needs a Gemini API key.' }
  Set-Val 'GEMINI_API_KEY' $gkey
}
Write-Host 'Looking up your Gemini models ...'
$all = @()
$url = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200'
$resp = Invoke-RestMethod -Uri $url -Headers @{ 'x-goog-api-key' = $gkey } -TimeoutSec 30
$all = @($resp.models | Where-Object { $_.supportedGenerationMethods -contains 'generateContent' } | ForEach-Object { $_.name -replace '^models/', '' })
$skip = 'tts|image|audio|live|embed|vision|learnlm|aqa|lite'
function Pick($envKey, $pattern) {
  $forced = Get-Val $envKey
  if ($forced) { return $forced }
  $m = @($all | Where-Object { $_ -match $pattern -and $_ -notmatch $skip } | Sort-Object { $_.Length }, { $_ })
  if ($m.Count) { return $m[0] } else { return '' }
}
$main = Pick 'LITE_GEMINI_MAIN' '^gemini-3\.8-flash'
$scout = Pick 'LITE_GEMINI_SCOUT' '^gemini-3\.5-flash'
$hard = Pick 'LITE_GEMINI_HARD' '^gemini-4(\.\d+)?-pro'
$helper = Get-Val 'LITE_GEMINI_HELPER'; if (-not $helper) { $helper = $main }
$missing = @()
if (-not $main) { $missing += 'main (gemini-3.8-flash)' }
if (-not $scout) { $missing += 'scout (gemini-3.5-flash)' }
if (-not $hard) { $missing += 'hard (gemini-4 pro)' }
if ($missing.Count) {
  Write-Host ('Gemini models your key can use: ' + ($all -join ', ')) -ForegroundColor Yellow
  throw ('Not found: ' + ($missing -join ', ') + '. Put the right id in .env (LITE_GEMINI_MAIN / LITE_GEMINI_SCOUT / LITE_GEMINI_HARD) and run this again.')
}
Write-Host "OK  main   $main (thinking medium)"
Write-Host "OK  helper $helper (thinking medium)"
Write-Host "OK  scout  $scout (thinking low)"
Write-Host "OK  hard   $hard (thinking high)"

# ---------- 2. Python + LiteLLM (the gateway) ----------
New-Item -ItemType Directory -Force -Path $gwDir | Out-Null
$venvPy = Join-Path $gwDir 'venv\Scripts\python.exe'
if (-not (Test-Path $venvPy)) {
  $py = $null
  foreach ($c in @('py', 'python')) {
    $cmd = Get-Command $c -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source -notlike '*WindowsApps*') { $py = $cmd.Source; break }
  }
  if (-not $py) {
    Write-Host 'Installing Python 3.12 (needed by the gateway) ...'
    $inst = Join-Path $env:TEMP 'python-3.12.10-amd64.exe'
    Invoke-WebRequest 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe' -OutFile $inst -UseBasicParsing
    Start-Process -FilePath $inst -ArgumentList '/quiet InstallAllUsers=1 PrependPath=1 Include_test=0' -Wait
    $py = 'C:\Program Files\Python312\python.exe'
    if (-not (Test-Path $py)) { throw 'Python did not install. Install Python 3.12 from python.org, then run this again.' }
  }
  Write-Host 'Creating the gateway environment ...'
  if ((Split-Path -Leaf $py) -eq 'py.exe') { & $py -3 -m venv (Join-Path $gwDir 'venv') } else { & $py -m venv (Join-Path $gwDir 'venv') }
  if (-not (Test-Path $venvPy)) { throw 'Could not create the Python environment for the gateway.' }
}
Write-Host "Installing LiteLLM $LiteLLMVersion (a few minutes the first time) ..."
& $venvPy -m pip install --disable-pip-version-check -q "litellm[proxy]==$LiteLLMVersion"
if ($LASTEXITCODE -ne 0) { throw 'pip install litellm failed (see the messages above).' }
Write-Host 'OK  LiteLLM installed'

# ---------- 3. Gateway settings ----------
$gwKey = Get-Val 'GATEWAY_KEY'
if (-not $gwKey) { $gwKey = 'sk-gw-' + ([guid]::NewGuid().ToString('N')) }
function Entry($alias, $model, $effort) {
  return "  - model_name: $alias`n    litellm_params:`n      model: gemini/$model`n      api_key: os.environ/GEMINI_API_KEY`n      reasoning_effort: $effort`n"
}
$yaml = "model_list:`n"
$yaml += Entry 'gemini-main' $main 'medium'
$yaml += Entry 'gemini-helper' $helper 'medium'
$yaml += Entry 'gemini-scout' $scout 'low'
$yaml += Entry 'gemini-hard' $hard 'high'
# Safety net: any Claude model name that reaches the gateway still lands on Gemini.
$yaml += Entry 'claude-haiku-5-5' $scout 'low'
$yaml += Entry 'claude-sonnet-5-5' $main 'medium'
$yaml += Entry 'claude-opus-5-5' $hard 'high'
$yaml += Entry 'claude-fable-5-1' $hard 'high'
$yaml += "litellm_settings:`n  drop_params: true`n  num_retries: 2`n  request_timeout: 600`ngeneral_settings:`n  master_key: os.environ/GATEWAY_KEY`n"
Set-Content -Path (Join-Path $gwDir 'config.yaml') -Value $yaml -Encoding ASCII

# The gateway runner: reads the keys from .env at start, so keys never sit in the task or the yaml.
$runner = @"
`$ErrorActionPreference = 'Stop'
`$envFile = '$envFile'
foreach (`$l in (Get-Content `$envFile)) {
  if (`$l -like 'GEMINI_API_KEY=*') { `$env:GEMINI_API_KEY = `$l.Substring(15) }
  if (`$l -like 'GATEWAY_KEY=*') { `$env:GATEWAY_KEY = `$l.Substring(12) }
}
`$env:PYTHONIOENCODING = 'utf-8'
`$log = '$gwDir\gateway.log'
& '$gwDir\venv\Scripts\litellm.exe' --config '$gwDir\config.yaml' --host 127.0.0.1 --port $Port *>> `$log
"@
Set-Content -Path (Join-Path $gwDir 'run-gateway.ps1') -Value $runner -Encoding ASCII

# ---------- 4. Gateway task (starts with the VPS, restarts if it stops) ----------
Unregister-ScheduledTask -TaskName $GwTask -Confirm:$false -ErrorAction SilentlyContinue
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $gwDir 'run-gateway.ps1') + '"')
$trigger = New-ScheduledTaskTrigger -AtStartup
$set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $GwTask -Action $action -Trigger $trigger -Settings $set -User 'SYSTEM' -RunLevel Highest | Out-Null

# ---------- 5. Lite settings (old values kept for -Revert) ----------
if (-not (Get-Val 'CLAUDE_API_KEY_BACKUP')) {
  Set-Val 'CLAUDE_API_KEY_BACKUP' (Get-Val 'ANTHROPIC_API_KEY')
  foreach ($k in $MODEL_KEYS) { $v = Get-Val $k; if (-not $v) { $v = '-' }; Set-Val ('PRE_GEMINI_' + $k) $v }
}
Set-Val 'GATEWAY_KEY' $gwKey
Set-Val 'ANTHROPIC_API_KEY' $gwKey
Set-Val 'ANTHROPIC_BASE_URL' "http://127.0.0.1:$Port"
Set-Val 'HQ_ENGINE' 'gemini'
Set-Val 'HQ_MODEL' 'gemini-main'
Set-Val 'HQ_EFFORT' 'medium'
Set-Val 'HQ_HELPER_MODEL' 'gemini-helper'
Set-Val 'HQ_HELPER_EFFORT' 'medium'
Set-Val 'HQ_SCOUT_MODEL' 'gemini-scout'
Set-Val 'HQ_SCOUT_EFFORT' 'low'
Set-Val 'HQ_MODEL_HARD' 'gemini-hard'
Set-Val 'HQ_FAST_MODEL' 'gemini-scout'
Save-Env

# ---------- 6. Start the gateway, check it, restart Lite ----------
Stop-ScheduledTask -TaskName $GwTask -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='litellm.exe'" | Where-Object { $_.CommandLine -like "*$gwDir*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-ScheduledTask -TaskName $GwTask
Write-Host 'Starting the gateway ...'
$up = $false
for ($i = 0; $i -lt 40 -and -not $up; $i++) {
  Start-Sleep -Seconds 3
  try { $up = (Invoke-WebRequest "http://127.0.0.1:$Port/health/liveliness" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch { }
}
if (-not $up) { throw "The gateway did not start. Look at $gwDir\gateway.log (send it to Claude), or run this script with -Revert to go back to Claude." }
Write-Host 'OK  gateway running on 127.0.0.1 (local only)'
try {
  $body = '{"model":"gemini-main","max_tokens":50,"messages":[{"role":"user","content":"Reply with the word ready."}]}'
  $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/v1/messages" -Method Post -Body $body -ContentType 'application/json' -Headers @{ 'x-api-key' = $gwKey; 'anthropic-version' = '2023-06-01' } -TimeoutSec 120
  Write-Host ('OK  Gemini answered: ' + (($r.content | Where-Object { $_.type -eq 'text' } | Select-Object -First 1).text))
} catch {
  Write-Host ('Gemini test call failed: ' + $_.Exception.Message) -ForegroundColor Yellow
  Write-Host 'Check the Gemini key and its billing/credit in Google AI Studio, then run this again.' -ForegroundColor Yellow
}
Restart-Lite

Write-Host "`nDone. Lite now runs on Gemini; HQ and Outreach are unchanged." -ForegroundColor Green
Write-Host 'In Telegram, send /models to the Lite bot and give it a small task to test.'
Write-Host 'Note: the $ amounts in /cost are only estimates on Gemini - the real bill is in Google AI Studio (set a spend limit there).'
Write-Host "Back to Claude any time:  powershell -ExecutionPolicy Bypass -File $Root\scripts\lite-gemini.ps1 -Revert"
