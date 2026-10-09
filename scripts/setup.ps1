# AgenticCore HQ — one-time setup on a Windows VPS.
# Run in PowerShell as Administrator:
#   powershell -ExecutionPolicy Bypass -File C:\AgenticCoreHQ\scripts\setup.ps1
# It installs Node.js, Git and GitHub CLI if missing, installs the bot, asks
# for your keys (typed here on the VPS, never shared), and starts the bot as a
# background task that also starts whenever the VPS reboots.

$ErrorActionPreference = 'Stop'
$Dir = Split-Path -Parent $PSScriptRoot
Set-Location $Dir
Write-Host "`n=== AgenticCore HQ setup ($Dir) ===`n" -ForegroundColor Green

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Host 'Please run PowerShell as Administrator (right-click > Run as administrator).' -ForegroundColor Red; exit 1 }

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
# Full search path (machine + user), so winget and freshly installed tools are found
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + (Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps')
}
Refresh-Path

function Install-Msi($url, $file) {
  $out = Join-Path $env:TEMP $file
  Write-Host "  downloading $url"
  Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing
  Start-Process msiexec.exe -ArgumentList "/i `"$out`" /qn /norestart" -Wait
}
# Direct downloads, used when winget is missing or fails
$Direct = @{
  node = {
    $lts = (Invoke-RestMethod 'https://nodejs.org/dist/index.json') | Where-Object { $_.lts } | Select-Object -First 1
    Install-Msi "https://nodejs.org/dist/$($lts.version)/node-$($lts.version)-x64.msi" 'node-lts.msi'
  }
  git = {
    $rel = Invoke-RestMethod 'https://api.github.com/repos/git-for-windows/git/releases/latest'
    $asset = $rel.assets | Where-Object { $_.name -like 'Git-*-64-bit.exe' } | Select-Object -First 1
    $out = Join-Path $env:TEMP 'git-setup.exe'
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $out -UseBasicParsing
    Start-Process $out -ArgumentList '/VERYSILENT /NORESTART' -Wait
  }
  gh = {
    $rel = Invoke-RestMethod 'https://api.github.com/repos/cli/cli/releases/latest'
    $asset = $rel.assets | Where-Object { $_.name -like '*windows_amd64.msi' } | Select-Object -First 1
    Install-Msi $asset.browser_download_url 'gh.msi'
  }
}
function Ensure($cmd, $id, $name) {
  if (Get-Command $cmd -ErrorAction SilentlyContinue) { Write-Host "OK  $name"; return }
  Write-Host "Installing $name ..."
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install --id $id -e --scope machine --accept-source-agreements --accept-package-agreements | Out-Host
    Refresh-Path
  }
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    Write-Host "  winget not available or it did not work - downloading $name directly"
    & $Direct[$cmd]
    Refresh-Path
  }
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "$name did not install. Close PowerShell, open it again as Administrator, and run this setup again." }
  Write-Host "OK  $name"
}
Ensure node 'OpenJS.NodeJS.LTS' 'Node.js'
Ensure git 'Git.Git' 'Git'
Ensure gh 'GitHub.cli' 'GitHub CLI'

Write-Host "`nInstalling the bot's packages ..."
npm install --omit=dev --no-audit --no-fund | Out-Host

# ---------- keys ----------
$envFile = Join-Path $Dir '.env'
$keep = $false
if (Test-Path $envFile) { $keep = (Read-Host 'A .env with your keys already exists. Keep it? (Y/n)') -notmatch '^[nN]' }
function Ask-Secret($label, [bool]$optional) {
  $hint = if ($optional) { ' (optional — press Enter to skip)' } else { '' }
  $s = Read-Host -AsSecureString ($label + $hint)
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b).Trim() } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
if (-not $keep) {
  Write-Host "`nKeys are typed here only (hidden as you type). They are saved in $envFile, readable only by Administrators."
  Write-Host 'Your Telegram user id: open Telegram, message @userinfobot, it replies with your id (numbers).'
  $tg = Ask-Secret 'Telegram bot token (from @BotFather)' $false
  $owner = Read-Host 'Your Telegram user id (numbers)'
  $anth = Ask-Secret 'Claude (Anthropic) API key' $false
  $oai = Ask-Secret 'OpenAI API key' $true
  $gem = Ask-Secret 'Gemini (Google AI Studio) API key' $true
  $xai = Ask-Secret 'xAI (Grok) API key' $true
  $gh = Ask-Secret 'GitHub fine-grained token for the repos HQ may work on' $true
  $budget = Read-Host 'Daily Claude spending cap in US$ (Enter = 30)'
  if (-not $budget) { $budget = '30' }
  $bash = 'C:\Program Files\Git\bin\bash.exe'
  $lines = @(
    "TELEGRAM_BOT_TOKEN=$tg", "TELEGRAM_OWNER_ID=$owner", "ANTHROPIC_API_KEY=$anth",
    'HQ_MODEL=claude-opus-5-5', 'HQ_MODEL_HARD=claude-fable-5-1', 'HQ_EFFORT=max',
    "OPENAI_API_KEY=$oai", "GEMINI_API_KEY=$gem", "XAI_API_KEY=$xai",
    'OPENAI_MODEL=', 'GEMINI_MODEL=', 'XAI_MODEL=',
    'OPENAI_REASONING=xhigh', 'GEMINI_THINKING=high', 'XAI_REASONING=high',
    'VOICE_UR=naksh', 'VOICE_EN=orion',
    "GH_TOKEN=$gh", "DAILY_BUDGET_USD=$budget", 'JOB_BUDGET_USD=8',
    "HQ_WORKSPACE=$Dir\workspace"
  )
  if (Test-Path $bash) { $lines += "CLAUDE_CODE_GIT_BASH_PATH=$bash" }
  Set-Content -Path $envFile -Value $lines -Encoding UTF8
  icacls $envFile /inheritance:r /grant:r 'Administrators:F' 'SYSTEM:F' | Out-Null
  Write-Host 'Saved.'
}

# Git over HTTPS uses the GitHub token through GitHub CLI (for the bot's own git commands).
$ghExe = (Get-Command gh).Source
git config --system credential.https://github.com.helper ''
git config --system --add credential.https://github.com.helper "!'$ghExe' auth git-credential"
git config --system user.name 'AgenticCore HQ'
git config --system user.email 'hq@agenticcore.local'

# ---------- background task ----------
$task = 'AgenticCore HQ'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*src*index.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Dir\scripts\run.ps1`"" -WorkingDirectory $Dir
$trigger = New-ScheduledTaskTrigger -AtStartup
$set = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Settings $set -User 'SYSTEM' -RunLevel Highest | Out-Null
Start-ScheduledTask -TaskName $task

Write-Host "`nDone. AgenticCore HQ is running in the background and starts with the VPS." -ForegroundColor Green
Write-Host 'Open Telegram, press Start on your bot, and send /help. (You should get an "online" message within a minute.)'
Write-Host "Logs: $Dir\logs\hq.log    Update later: scripts\update.ps1"
