# AgenticCore HQ — stage 2 setup: video tool, the AgenticCore browser and
# Netlify / Supabase access. Run once, in PowerShell as Administrator, while
# logged in to the VPS with Remote Desktop (after scripts\update.ps1):
#   powershell -ExecutionPolicy Bypass -File C:\AgenticCoreHQ\scripts\stage2.ps1
# Safe to run again: it keeps what is already set unless you type something new.

$ErrorActionPreference = 'Stop'
$Dir = Split-Path -Parent $PSScriptRoot
Set-Location $Dir
Write-Host "`n=== AgenticCore HQ — stage 2 ($Dir) ===`n" -ForegroundColor Green

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Host 'Please run PowerShell as Administrator (right-click > Run as administrator).' -ForegroundColor Red; exit 1 }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')

# ---------- 1. ffmpeg (video tool) ----------
$ffDir = Join-Path $Dir 'tools\ffmpeg'
$ffExe = Get-ChildItem -Path $ffDir -Recurse -Filter ffmpeg.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if ($ffExe) { Write-Host "OK  ffmpeg ($($ffExe.FullName))" }
else {
  Write-Host 'Installing ffmpeg (video tool) ...'
  $zip = Join-Path $env:TEMP 'ffmpeg.zip'
  Invoke-WebRequest -Uri 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -OutFile $zip -UseBasicParsing
  New-Item -ItemType Directory -Force $ffDir | Out-Null
  Expand-Archive -Path $zip -DestinationPath $ffDir -Force
  Remove-Item $zip -Force
  $ffExe = Get-ChildItem -Path $ffDir -Recurse -Filter ffmpeg.exe | Select-Object -First 1
  if (-not $ffExe) { throw 'ffmpeg did not install. Run this script again.' }
  Write-Host "OK  ffmpeg ($($ffExe.FullName))"
}
$ffBin = $ffExe.DirectoryName
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
if ($machinePath -notlike "*$ffBin*") { [Environment]::SetEnvironmentVariable('Path', "$machinePath;$ffBin", 'Machine') }

# ---------- 2. Netlify / Supabase tokens (saved in .env) ----------
$envFile = Join-Path $Dir '.env'
if (-not (Test-Path $envFile)) { throw 'No .env found — run scripts\setup.ps1 first.' }
$envLines = [System.Collections.ArrayList]@(Get-Content $envFile)
function Get-EnvValue($key) {
  $l = $envLines | Where-Object { $_ -like "$key=*" } | Select-Object -First 1
  if ($l) { return $l.Substring($key.Length + 1) } else { return '' }
}
function Set-EnvValue($key, $value) {
  for ($i = 0; $i -lt $envLines.Count; $i++) { if ($envLines[$i] -like "$key=*") { $envLines[$i] = "$key=$value"; return } }
  [void]$envLines.Add("$key=$value")
}
function Ask-Secret($label) {
  $s = Read-Host -AsSecureString $label
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b).Trim() } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
function Have($key) { if (Get-EnvValue $key) { return ' [already set — press Enter to keep]' } else { return ' [press Enter to skip]' } }

Write-Host "`nTokens are typed here only (hidden as you type) and saved in $envFile."
Write-Host 'Netlify: app.netlify.com > your avatar > User settings > Applications > Personal access tokens > New access token.'
$v = Ask-Secret ('Netlify personal access token' + (Have 'NETLIFY_TOKEN'))
if ($v) { Set-EnvValue 'NETLIFY_TOKEN' $v }

Write-Host "`nSupabase: log in to each account at supabase.com/dashboard > your avatar > Account preferences > Access Tokens > Generate new token."
foreach ($n in 1, 2, 3) {
  $v = Ask-Secret ("Supabase account $n access token" + (Have "SUPABASE_TOKEN_$n"))
  if ($v) { Set-EnvValue "SUPABASE_TOKEN_$n" $v }
  if (Get-EnvValue "SUPABASE_TOKEN_$n") {
    $old = Get-EnvValue "SUPABASE_LABEL_$n"
    $hint = if ($old) { " [now: $old — Enter keeps it]" } else { '' }
    $label = Read-Host "  A name for Supabase account $n, e.g. 'Estate + PK' or 'Agency'$hint"
    if ($label) { Set-EnvValue "SUPABASE_LABEL_$n" ($label -replace '[\r\n=]', ' ') }
  }
}
if (-not (Get-EnvValue 'HQ_BROWSER_CDP')) { Set-EnvValue 'HQ_BROWSER_CDP' 'http://127.0.0.1:9222' }
Set-Content -Path $envFile -Value $envLines -Encoding UTF8
icacls $envFile /inheritance:r /grant:r 'Administrators:F' 'SYSTEM:F' | Out-Null
Write-Host 'Saved.'

# ---------- 3. The AgenticCore browser (Edge, its own profile) ----------
$edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw 'Microsoft Edge was not found on this VPS.' }
$profileDir = Join-Path $Dir 'browser-profile'
$downloads = Join-Path $Dir 'workspace\downloads'
New-Item -ItemType Directory -Force $profileDir, $downloads | Out-Null
# Downloads go straight into the bot's workspace, without a "Save as" box.
$prefsDir = Join-Path $profileDir 'Default'
$prefs = Join-Path $prefsDir 'Preferences'
if (-not (Test-Path $prefs)) {
  New-Item -ItemType Directory -Force $prefsDir | Out-Null
  $json = @{ download = @{ default_directory = $downloads; prompt_for_download = $false; directory_upgrade = $true }; savefile = @{ default_directory = $downloads } } | ConvertTo-Json -Depth 4
  Set-Content -Path $prefs -Value $json -Encoding UTF8
}
$browserArgs = "--remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir=`"$profileDir`" --no-first-run --no-default-browser-check --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling --restore-last-session"
$me = "$env:USERDOMAIN\$env:USERNAME"
$btask = 'AgenticCore Browser'
Unregister-ScheduledTask -TaskName $btask -Confirm:$false -ErrorAction SilentlyContinue
$baction = New-ScheduledTaskAction -Execute $edge -Argument $browserArgs
$btrigger = New-ScheduledTaskTrigger -AtLogOn -User $me
$bset = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $btask -Action $baction -Trigger $btrigger -Settings $bset -User $me -RunLevel Limited | Out-Null
Write-Host "OK  'AgenticCore Browser' starts whenever $me logs in to the VPS"

$up = $false
try { $up = (Invoke-WebRequest 'http://127.0.0.1:9222/json/version' -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch { }
$sites = 'https://www.facebook.com/ https://web.whatsapp.com/ https://publish.buffer.com/ https://app.netlify.com/ https://supabase.com/dashboard'
if (-not $up) { Start-Process -FilePath $edge -ArgumentList "$browserArgs $sites" }
else { Start-Process -FilePath $edge -ArgumentList "--user-data-dir=`"$profileDir`" $sites" }

# ---------- 4. Restart the bot so it picks up the new tools ----------
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*src*index.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Stop-ScheduledTask -TaskName 'AgenticCore HQ' -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName 'AgenticCore HQ'

Write-Host "`nDone." -ForegroundColor Green
Write-Host 'Now, in the Edge window that just opened (this is the AgenticCore browser):'
Write-Host '  1. Log in to Facebook, scan the WhatsApp Web QR code with your phone, log in to Buffer (and Netlify / Supabase if you like).'
Write-Host '  2. Leave the window open. Minimise it if you want — never close it.'
Write-Host '  3. Close Remote Desktop with the X at the top. Do NOT use Sign out (that would close the browser).'
Write-Host 'Then send /browser to the bot in Telegram — it should say the browser is running.'
