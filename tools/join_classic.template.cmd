@echo off
rem OG SOS Revival: double-click to play SOS: Classic on the __SERVER__ server.
rem Needs: Steam running and signed in, SOS: Classic installed and started once through Steam.
rem Points your Classic config at the server, starts the game, and puts your settings back when
rem the game closes. It never changes the game files. Made by tools/make_join_file.js.
setlocal
set "OGSOS_SERVER=__SERVER__"
set "OGSOS_SELF=%~f0"
title OG SOS Classic - keep this window open while you play
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s = [IO.File]::ReadAllText($env:OGSOS_SELF); iex $s.Substring($s.LastIndexOf('#' + 'PS-START'))"
if errorlevel 1 pause
exit /b
#PS-START
$ErrorActionPreference = 'Stop'
$AppId = '802240'
$server = $env:OGSOS_SERVER
$hostName, $port = $server.Split(':')
if (-not $port) { $port = '7781' }
$base = "http://${hostName}:$port"

function Fail($msg) { Write-Host ''; Write-Host "PROBLEM: $msg" -ForegroundColor Red; Write-Host ''; exit 1 }

# --- find SOS: Classic through Steam's library folders ---
function Find-Classic {
  if ($env:OGSOS_GAME_DIR) { return $env:OGSOS_GAME_DIR }
  $steam = $null
  try { $steam = (Get-ItemProperty 'HKCU:\Software\Valve\Steam').SteamPath -replace '/', '\' } catch {}
  if (-not $steam) { $steam = 'C:\Program Files (x86)\Steam' }
  $libs = @($steam)
  $vdf = Join-Path $steam 'steamapps\libraryfolders.vdf'
  if (Test-Path $vdf) {
    foreach ($m in [regex]::Matches((Get-Content $vdf -Raw), '"path"\s+"([^"]+)"')) { $libs += $m.Groups[1].Value -replace '\\\\', '\' }
  }
  foreach ($lib in $libs) {
    $acf = Join-Path $lib "steamapps\appmanifest_$AppId.acf"
    if (Test-Path $acf) {
      $d = [regex]::Match((Get-Content $acf -Raw), '"installdir"\s+"([^"]+)"')
      if ($d.Success) { return Join-Path $lib "steamapps\common\$($d.Groups[1].Value)" }
    }
  }
  return $null
}

$game = Find-Classic
if (-not $game) { Fail 'SOS: Classic is not installed. Install it from Steam (it is free), start it once, close it, then run this again.' }
# OGSOS_GAME_DIR / OGSOS_INI / OGSOS_EXE / OGSOS_NO_LAUNCH / OGSOS_TEST are for tools/join_file_test.js only.
$exe = if ($env:OGSOS_EXE) { $env:OGSOS_EXE } else { Join-Path $game 'SOS\Binaries\Win64\SOS-Win64-Shipping.exe' }
if (-not (Test-Path $exe)) { Fail "SOS: Classic was not found at $exe. Verify the game files in Steam." }

$ini = if ($env:OGSOS_INI) { $env:OGSOS_INI } else { Join-Path $env:LOCALAPPDATA 'SOS\Saved\Config\WindowsClient\Engine.ini' }
if (-not (Test-Path $ini)) { Fail 'Start SOS: Classic once through Steam, close it, then run this again (its config file does not exist yet).' }
if (-not $env:OGSOS_TEST -and (Get-Process 'SOS-Win64-Shipping' -ErrorAction SilentlyContinue)) { Fail 'SOS is already running. Close it first.' }

# --- back up the config (an old backup means the last run never restored: keep that one) ---
$backup = "$ini.ogsos-join-backup"
if (-not (Test-Path $backup)) { Copy-Item $ini $backup }

# --- point the config at the server (same keys as launcher/launcher.js) ---
$want = [ordered]@{
  OutpostKeyValueStore     = [ordered]@{ EndpointClient = "`"$base/kv/`""; EndpointClientFallback = "`"$base/kv/`""; EndpointServer = "`"$base/kv/`"" }
  OutpostIdentity          = [ordered]@{ Endpoint = "`"$base`"" }
  OutpostAppPersistence    = [ordered]@{ Endpoint = "`"$base`"" }
  OutpostIAP               = [ordered]@{ Endpoint = "`"$base`"" }
  OutpostStorefront        = [ordered]@{ Endpoint = "`"$base`"" }
  OutpostLeaderboards      = [ordered]@{ Endpoint = "`"$base`"" }
  OutpostLogReceiver       = [ordered]@{ Endpoint = "`"$base`"" }
  OutpostStreams           = [ordered]@{ EmbedEndpoint = "`"$base`"" }
  OutpostMatchmakingClient = [ordered]@{ MatchmakingSSL = 'False'; MatchmakingPort = $port; MatchmakingEndpoint = $hostName; MatchmakingApi = "`"$base/api`"" }
}
$out = New-Object System.Collections.Generic.List[string]
$done = @{}
function Add-Missing($sec) {
  if (-not $sec -or -not $want.Contains($sec)) { return }
  foreach ($k in $want[$sec].Keys) { if (-not $done[$sec].Contains($k)) { $out.Add("$k=$($want[$sec][$k])") } }
}
$section = $null
foreach ($line in [regex]::Split([IO.File]::ReadAllText($backup), '\r?\n')) {
  $s = [regex]::Match($line, '^\s*\[(.+)\]\s*$')
  if ($s.Success) {
    $trailing = @()
    while ($out.Count -and $out[$out.Count - 1].Trim() -eq '') { $trailing += $out[$out.Count - 1]; $out.RemoveAt($out.Count - 1) }
    Add-Missing $section
    foreach ($t in $trailing) { $out.Add($t) }
    $section = $s.Groups[1].Value
    $done[$section] = New-Object System.Collections.Generic.HashSet[string]
    $out.Add($line); continue
  }
  $kv = [regex]::Match($line, '^\s*([^=;]+?)\s*=')
  if ($section -and $want.Contains($section) -and $kv.Success -and $want[$section].Contains($kv.Groups[1].Value)) {
    $k = $kv.Groups[1].Value; $out.Add("$k=$($want[$section][$k])"); [void]$done[$section].Add($k); continue
  }
  $out.Add($line)
}
Add-Missing $section
foreach ($sec in $want.Keys) {
  if (-not $done.Contains($sec)) { $out.Add(''); $out.Add("[$sec]"); foreach ($k in $want[$sec].Keys) { $out.Add("$k=$($want[$sec][$k])") } }
}
[IO.File]::WriteAllText($ini, ($out -join "`r`n"), (New-Object Text.UTF8Encoding $false))
if ($env:OGSOS_NO_LAUNCH) { exit 0 }

function Restore-Config {
  Copy-Item $backup $ini -Force
  Remove-Item $backup -Force
  Write-Host 'Your SOS settings are restored.'
}

# --- start the game directly (SteamAppId tells Steam which game this is) and wait for it ---
Write-Host "Starting SOS: Classic on $server ..."
Write-Host 'Keep this window open. When you close the game, your settings are put back.'
$env:SteamAppId = $AppId; $env:SteamGameId = $AppId
try {
  $p = Start-Process -FilePath $exe -ArgumentList '-log' -WorkingDirectory (Split-Path $exe) -PassThru
  $p.WaitForExit()
} catch {
  Restore-Config
  Fail "Could not start the game: $($_.Exception.Message)"
}
Restore-Config
