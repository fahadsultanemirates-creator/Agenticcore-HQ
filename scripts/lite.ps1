# AgenticCore Lite - the cost-effective second bot, installed next to HQ.
# Same code and rules as HQ, cheaper models and smaller spending caps, its own
# Telegram bot, folder, memory, browser window and background task.
# Run once, in PowerShell as Administrator, while logged in with Remote Desktop:
#   powershell -ExecutionPolicy Bypass -File C:\AgenticCoreHQ\scripts\lite.ps1
# Safe to run again: it updates the code and keeps what is already set.
# The Outreach edition (the field team for the outreach plan) installs the same way:
#   powershell -ExecutionPolicy Bypass -File C:\AgenticCoreHQ\scripts\lite.ps1 -Edition outreach
# The Mini edition (very cheap, Gemini Flash Lite, lean tools: no Supabase / Netlify / GitHub):
#   powershell -ExecutionPolicy Bypass -File C:\AgenticCoreHQ\scripts\lite.ps1 -Edition mini
# then switch it to Gemini:  powershell -ExecutionPolicy Bypass -File C:\AgenticCoreHQ-Mini\scripts\lite-gemini.ps1
param([ValidateSet('lite', 'outreach', 'mini')][string]$Edition = 'lite')

$ErrorActionPreference = 'Stop'
$Hq = Split-Path -Parent $PSScriptRoot
$E = @{
  lite = @{ Folder = "$Hq-Lite"; Name = 'AgenticCore Lite'; Port = '9223'; Budget = '10'; Job = '1.5'; Extra = @{} }
  outreach = @{ Folder = "$Hq-Outreach"; Name = 'AgenticCore Outreach'; Port = '9224'; Budget = '15'; Job = '8'
    Extra = @{ HQ_OUTREACH = '1'; HQ_MANAGER_NO_BROWSER = '1'; OUTREACH_EMAIL_ACCOUNTS = ''; OUTREACH_EMAIL_PER_ACCOUNT = '8'
      OUTREACH_RESEARCH_TIME = '03:00'; OUTREACH_REPORT_TIME = '10:00'; OUTREACH_EVENING_TIME = '20:30' } }
  mini = @{ Folder = "$Hq-Mini"; Name = 'AgenticCore Mini'; Port = '9225'; Budget = '10'; Job = '3'
    Extra = @{ GATEWAY_PORT = '4124'; NETLIFY_TOKEN = ''; SUPABASE_TOKEN_1 = ''; SUPABASE_TOKEN_2 = ''; SUPABASE_TOKEN_3 = ''; GH_TOKEN = ''
      LITE_GEMINI_MAIN = 'gemini-3.5-flash-lite'; LITE_GEMINI_HELPER = 'gemini-3.5-flash-lite'; LITE_GEMINI_SCOUT = 'gemini-3.1-flash-lite'; LITE_GEMINI_HARD = 'gemini-3.8-flash'
      LITE_GEMINI_MAIN_EFFORT = 'medium'; LITE_GEMINI_HELPER_EFFORT = 'low'; LITE_GEMINI_SCOUT_EFFORT = 'low'; LITE_GEMINI_HARD_EFFORT = 'medium' } }
}[$Edition]
$Lite = $E.Folder
$BotName = $E.Name
Write-Host "`n=== $BotName ($Lite) ===`n" -ForegroundColor Green

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Host 'Please run PowerShell as Administrator (right-click > Run as administrator).' -ForegroundColor Red; exit 1 }
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
$hqEnv = Join-Path $Hq '.env'
if (-not (Test-Path $hqEnv)) { throw 'HQ is not set up yet (no .env in ' + $Hq + '). Run setup.ps1 first.' }

# ---------- 1. Code (a second copy of the same repository) ----------
if (Test-Path (Join-Path $Lite '.git')) {
  Write-Host 'Updating the Lite copy ...'
  git -C $Lite pull --ff-only
} else {
  $origin = (git -C $Hq remote get-url origin).Trim()
  Write-Host "Copying the code to $Lite ..."
  git clone $origin $Lite
}
Set-Location $Lite
npm install --omit=dev --no-audit --no-fund | Out-Host

# ---------- 2. Settings: HQ's keys + the Lite bot token + cheaper models ----------
$liteEnv = Join-Path $Lite '.env'
$lines = [System.Collections.ArrayList]@()
$fresh = -not (Test-Path $liteEnv)
if ($fresh) { foreach ($l in (Get-Content $hqEnv)) { [void]$lines.Add($l) } } else { foreach ($l in (Get-Content $liteEnv)) { [void]$lines.Add($l) } }
function Get-Val($key) { $l = $lines | Where-Object { $_ -like "$key=*" } | Select-Object -First 1; if ($l) { return $l.Substring($key.Length + 1) } else { return '' } }
function Set-Val($key, $value) {
  for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -like "$key=*") { $lines[$i] = "$key=$value"; return } }
  [void]$lines.Add("$key=$value")
}
function Ask-Secret($label) {
  $s = Read-Host -AsSecureString $label
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b).Trim() } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

$hqToken = ''
$t = Get-Content $hqEnv | Where-Object { $_ -like 'TELEGRAM_BOT_TOKEN=*' } | Select-Object -First 1
if ($t) { $hqToken = $t.Substring(19) }
$hint = if ($fresh) { '' } else { ' [press Enter to keep the current one]' }
$otherTokens = @($hqToken)
foreach ($other in "$Hq-Lite", "$Hq-Outreach", "$Hq-Mini") {
  $oe = Join-Path $other '.env'
  if (($other -ne $Lite) -and (Test-Path $oe)) { $t2 = Get-Content $oe | Where-Object { $_ -like 'TELEGRAM_BOT_TOKEN=*' } | Select-Object -First 1; if ($t2) { $otherTokens += $t2.Substring(19) } }
}
Write-Host "`nThe $BotName bot's token from @BotFather is typed here only (hidden as you type)."
$tok = Ask-Secret ("Telegram token of the NEW $BotName bot" + $hint)
if ($tok) {
  if ($otherTokens -contains $tok) { throw "That token belongs to another of your bots. Paste the token of the new $BotName bot (from @BotFather)." }
  Set-Val 'TELEGRAM_BOT_TOKEN' $tok
} elseif ($fresh) { throw "The $BotName bot needs its own Telegram token." }

if ($fresh) {
  $preset = [ordered]@{
    HQ_NAME = $BotName; HQ_LITE = '1'; HQ_TASK = $BotName; HQ_BROWSER_TASK = "$BotName Browser"
    HQ_MODEL = 'claude-sonnet-5-5'; HQ_EFFORT = 'medium'
    HQ_HELPER_MODEL = 'claude-sonnet-5-5'; HQ_HELPER_EFFORT = 'medium'
    HQ_SCOUT_MODEL = 'claude-haiku-5-5'; HQ_SCOUT_EFFORT = 'low'
    OPENAI_MODEL = 'gpt-6.1-sol'; OPENAI_REASONING = 'medium'
    GEMINI_MODEL = 'gemini-3.8-flash'; GEMINI_THINKING = 'low'
    XAI_MODEL = 'grok-4.7'; XAI_REASONING = 'low'
    DAILY_BUDGET_USD = $E.Budget; JOB_BUDGET_USD = $E.Job
    HQ_WORKSPACE = "$Lite\workspace"; HQ_BROWSER_CDP = "http://127.0.0.1:$($E.Port)"
  }
  foreach ($k in $preset.Keys) { Set-Val $k $preset[$k] }
  foreach ($k in $E.Extra.Keys) { Set-Val $k $E.Extra[$k] }
  if ($Edition -eq 'mini') {
    # Same Gemini keys as Lite (free ones first, then the paid one), if Lite has them.
    $liteEnvFile = Join-Path "$Hq-Lite" '.env'
    if (Test-Path $liteEnvFile) {
      foreach ($l in (Get-Content $liteEnvFile)) { if ($l -match '^(GEMINI_API_KEY|GEMINI_KEY_[A-Za-z0-9_]+)=(.+)$') { Set-Val $Matches[1] $Matches[2] } }
    }
  }
  for ($i = $lines.Count - 1; $i -ge 0; $i--) { if ($lines[$i] -like 'HQ_DATA=*' -or $lines[$i] -like 'HQ_LOGS=*') { $lines.RemoveAt($i) } }
}
Set-Content -Path $liteEnv -Value $lines -Encoding UTF8
icacls $liteEnv /inheritance:r /grant:r 'Administrators:F' 'SYSTEM:F' | Out-Null
Write-Host 'Saved.'

# Start Lite with what HQ already knows about Fahad (profile and memory), once.
$ws = Join-Path $Lite 'workspace'
New-Item -ItemType Directory -Force (Join-Path $ws 'memory'), (Join-Path $ws 'downloads') | Out-Null
foreach ($f in 'CLAUDE.md', 'memory\notes.md') {
  $src = Join-Path $Hq "workspace\$f"; $dst = Join-Path $ws $f
  if ((Test-Path $src) -and -not (Test-Path $dst)) { Copy-Item $src $dst }
}

# ---------- 3. Lite's own browser window (port 9223, own profile) ----------
$edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw 'Microsoft Edge was not found on this VPS.' }
$port = ((Get-Val 'HQ_BROWSER_CDP') -replace '.*:(\d+).*', '$1'); if ($port -notmatch '^\d+$') { $port = $E.Port }
$profileDir = Join-Path $Lite 'browser-profile'
$downloads = Join-Path $ws 'downloads'
$prefsDir = Join-Path $profileDir 'Default'
$prefs = Join-Path $prefsDir 'Preferences'
if (-not (Test-Path $prefs)) {
  New-Item -ItemType Directory -Force $prefsDir | Out-Null
  $json = @{ download = @{ default_directory = $downloads; prompt_for_download = $false; directory_upgrade = $true }; savefile = @{ default_directory = $downloads } } | ConvertTo-Json -Depth 4
  Set-Content -Path $prefs -Value $json -Encoding UTF8
}
$browserArgs = "--remote-debugging-port=$port --remote-debugging-address=127.0.0.1 --user-data-dir=`"$profileDir`" --no-first-run --no-default-browser-check --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling --restore-last-session"
$me = "$env:USERDOMAIN\$env:USERNAME"
$btask = Get-Val 'HQ_BROWSER_TASK'; if (-not $btask) { $btask = "$BotName Browser" }
Unregister-ScheduledTask -TaskName $btask -Confirm:$false -ErrorAction SilentlyContinue
$bset = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $btask -Action (New-ScheduledTaskAction -Execute $edge -Argument $browserArgs) -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $me) -Settings $bset -User $me -RunLevel Limited | Out-Null
Write-Host "OK  '$btask' starts whenever $me logs in to the VPS"
$up = $false
try { $up = (Invoke-WebRequest "http://127.0.0.1:$port/json/version" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch { }
$sites = 'https://www.facebook.com/ https://web.whatsapp.com/'
if ($Edition -eq 'outreach') { $sites = 'https://mail.google.com/ https://www.facebook.com/ https://web.whatsapp.com/' }
if (-not $up) { Start-Process -FilePath $edge -ArgumentList "$browserArgs $sites" }

# ---------- 4. Lite's background task (starts with the VPS) ----------
$task = Get-Val 'HQ_TASK'; if (-not $task) { $task = $BotName }
Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
$mine = Join-Path $Lite 'src\index.js'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*$mine*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Lite\scripts\run.ps1`"" -WorkingDirectory $Lite
$set = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $task -Action $action -Trigger (New-ScheduledTaskTrigger -AtStartup) -Settings $set -User 'SYSTEM' -RunLevel Highest | Out-Null
Start-ScheduledTask -TaskName $task

Write-Host "`nDone. $BotName is running next to HQ." -ForegroundColor Green
if (-not $up) {
  Write-Host "A new Edge window opened: this is the $BotName browser (separate from the others)."
  if ($Edition -eq 'outreach') { Write-Host '  Log in there to the NEW outreach accounts only: Gmail, Facebook and WhatsApp Business (scan the QR with the new phone).' }
  Write-Host '  1. Log in to Facebook and scan the WhatsApp Web QR code with your phone.'
  Write-Host '  2. Minimise it - never close it. Close Remote Desktop with the X, not Sign out.'
}
Write-Host "In Telegram, press Start on the $BotName bot and send /help. It should also say `"$BotName is online`"."
if ($Edition -eq 'mini') { Write-Host "Next, switch Mini to Gemini Flash Lite:  powershell -ExecutionPolicy Bypass -File $Lite\scripts\lite-gemini.ps1" -ForegroundColor Yellow }
if ($Edition -eq 'outreach') { Write-Host "Then set the sending Gmail accounts: notepad $Lite\.env  ->  OUTREACH_EMAIL_ACCOUNTS=a@gmail.com,b@gmail.com  and run update.ps1 below." }
Write-Host "Update it later:  powershell -ExecutionPolicy Bypass -File $Lite\scripts\update.ps1"
