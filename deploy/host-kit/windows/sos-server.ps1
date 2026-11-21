# sos-server.ps1 - runs an SOS: Classic community server on this PC and keeps it registered and healthy.
# Windows PowerShell 5.1 compatible. Settings come from server.cfg (next to this script).
#   -DryRun   check settings, find the game and the Steam account, resolve the backend; change nothing, register nothing
#   -Cleanup  only remove leftovers of a previous run (host DLL, logs, Engine.ini changes) and exit
param([switch]$DryRun, [switch]$Cleanup)
$ErrorActionPreference = 'Stop'
$Here = $PSScriptRoot
$AppId = '802240'
$StateFile = Join-Path $Here 'state.json'

function Say($m) { Write-Host ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) }
function Fail($m) { Write-Host ''; Write-Host "ERROR: $m" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- 1. settings
function Read-Cfg($path) {
  $c = @{ Name = ''; Region = 'EU'; MaxPlayers = '16'; Port = '7777'; Backend = 'sos.joltora.com:7781'
          GameFolder = ''; CommunityKey = ''; ShowWindow = '0' }
  if (-not (Test-Path $path)) { Fail "server.cfg not found next to the script ($path)" }
  foreach ($line in (Get-Content -LiteralPath $path)) {
    $t = $line.Trim()
    if ($t -eq '' -or $t.StartsWith('#')) { continue }
    $i = $t.IndexOf('=')
    if ($i -lt 1) { continue }
    $c[$t.Substring(0, $i).Trim()] = $t.Substring($i + 1).Trim()
  }
  return $c
}
$Cfg = Read-Cfg (Join-Path $Here 'server.cfg')
$Port = 0; $Max = 0
if ($Cfg.Name.Length -lt 3 -or $Cfg.Name.Length -gt 48) { Fail 'Name in server.cfg must be 3 to 48 characters.' }
if (-not [int]::TryParse($Cfg.Port, [ref]$Port) -or $Port -lt 1024 -or $Port -gt 65535) { Fail 'Port in server.cfg must be 1024 to 65535.' }
if (-not [int]::TryParse($Cfg.MaxPlayers, [ref]$Max) -or $Max -lt 2 -or $Max -gt 16) { Fail 'MaxPlayers in server.cfg must be 2 to 16.' }
if ($Cfg.Region -eq '') { $Cfg.Region = 'EU' }
$BackendHost = $Cfg.Backend; $BackendPort = 7781
if ($Cfg.Backend.Contains(':')) {
  $BackendHost = $Cfg.Backend.Substring(0, $Cfg.Backend.LastIndexOf(':'))
  if (-not [int]::TryParse($Cfg.Backend.Substring($Cfg.Backend.LastIndexOf(':') + 1), [ref]$BackendPort)) { Fail 'Backend in server.cfg must be host:port.' }
}

# ---------------------------------------------------------------- 2. game and Steam
function Get-SteamPath {
  $p = $null
  try { $p = (Get-ItemProperty -Path 'HKCU:\Software\Valve\Steam' -ErrorAction Stop).SteamPath } catch { }
  if (-not $p) { try { $p = (Get-ItemProperty -Path 'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam' -ErrorAction Stop).InstallPath } catch { } }
  if ($p) { return ($p -replace '/', '\') }
  return $null
}
function Find-Game($steam) {
  if ($Cfg.GameFolder -ne '') { return $Cfg.GameFolder }
  if (-not $steam) { return $null }
  $libs = @($steam)
  $vdf = Join-Path $steam 'steamapps\libraryfolders.vdf'
  if (Test-Path $vdf) {
    foreach ($l in (Get-Content -LiteralPath $vdf)) {
      if ($l -match '^\s*"path"\s+"([^"]+)"') { $libs += ($Matches[1] -replace '\\\\', '\') }
    }
  }
  foreach ($lib in ($libs | Select-Object -Unique)) {
    $mf = Join-Path $lib "steamapps\appmanifest_$AppId.acf"
    if (-not (Test-Path $mf)) { continue }
    $dir = 'SOS Test Server'
    foreach ($l in (Get-Content -LiteralPath $mf)) { if ($l -match '^\s*"installdir"\s+"([^"]+)"') { $dir = $Matches[1] } }
    return (Join-Path $lib "steamapps\common\$dir")
  }
  return $null
}
# SteamID64 of the most recent Steam user, or '0'. Used only as the host id; never printed.
function Get-SteamId($steam) {
  if (-not $steam) { return '0' }
  $f = Join-Path $steam 'config\loginusers.vdf'
  if (-not (Test-Path $f)) { return '0' }
  $cur = $null; $best = '0'; $bestTs = [int64]-1; $recent = $null
  foreach ($l in (Get-Content -LiteralPath $f)) {
    if ($l -match '^\s*"(\d{17})"\s*$') { $cur = $Matches[1]; $ts = [int64]0
      continue }
    if (-not $cur) { continue }
    if ($l -match '^\s*"MostRecent"\s+"1"') { $recent = $cur }
    if ($l -match '^\s*"Timestamp"\s+"(\d+)"') { $t = [int64]$Matches[1]; if ($t -gt $bestTs) { $bestTs = $t; $best = $cur } }
  }
  if ($recent) { return $recent }
  return $best
}

$Steam = Get-SteamPath
$Game = Find-Game $Steam
if ($Cfg.GameFolder -eq '' -and -not $Game) { Fail "SOS: Classic not found. You must own and install SOS: Classic (Steam app $AppId), or set GameFolder in server.cfg." }
$Win64 = if ($Game) { Join-Path $Game 'SOS\Binaries\Win64' } else { '' }
$Exe = Join-Path $Win64 'SOS-Win64-Shipping.exe'
if (-not (Test-Path -LiteralPath $Exe)) { Fail "SOS-Win64-Shipping.exe not found under '$Win64'. You must own and install SOS: Classic (Steam app $AppId)." }
$EngineIni = Join-Path $env:LOCALAPPDATA 'SOS\Saved\Config\WindowsClient\Engine.ini'
$KitDll = Join-Path $Here 'sos_host\version.dll'
$KitIni = Join-Path $Here 'sos_host\sos_host.ini'
$SteamId = Get-SteamId $Steam
$HostId = $SteamId
$HostIds = @($SteamId, '0') | Select-Object -Unique

# ---------------------------------------------------------------- helpers
function Get-Sha($p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash }
function Remove-Quiet($p) { if (Test-Path -LiteralPath $p) { try { Remove-Item -LiteralPath $p -Force -ErrorAction Stop } catch { Say "could not remove $p ($($_.Exception.Message))" } } }

# HTTP call that never throws on a non-2xx status: returns @{ Code; Body; Json } (Code 0 = no connection).
function Invoke-Http($method, $url, $headers, $json) {
  $r = @{ Code = 0; Body = ''; Json = $null }
  try {
    $a = @{ Uri = $url; Method = $method; UseBasicParsing = $true; TimeoutSec = 20; Headers = $headers }
    if ($json) { $a.Body = [Text.Encoding]::UTF8.GetBytes($json); $a.ContentType = 'application/json; charset=utf-8' }
    $w = Invoke-WebRequest @a
    $r.Code = [int]$w.StatusCode; $r.Body = $w.Content
  } catch {
    $resp = $_.Exception.Response
    if ($resp) {
      $r.Code = [int]$resp.StatusCode
      try { $sr = New-Object IO.StreamReader($resp.GetResponseStream()); $r.Body = $sr.ReadToEnd(); $sr.Close() } catch { }
    }
  }
  if ($r.Body) { try { $r.Json = $r.Body | ConvertFrom-Json } catch { } }
  return $r
}

# ---------------------------------------------------------------- 6/7/10. install and cleanup
$Backup = @{ Dll = Join-Path $Win64 'version.dll.ogsos-backup'; Ini = "$EngineIni.ogsos-backup"
             IniNone = "$EngineIni.ogsos-none"; AppId = Join-Path $Win64 'steam_appid.txt.ogsos-created' }
function Invoke-Cleanup {
  $dll = Join-Path $Win64 'version.dll'
  if ((Test-Path -LiteralPath $dll) -and (Test-Path -LiteralPath $KitDll) -and ((Get-Sha $dll) -eq (Get-Sha $KitDll))) { Remove-Quiet $dll }
  if ((Test-Path -LiteralPath $Backup.Dll) -and -not (Test-Path -LiteralPath $dll)) { Move-Item -LiteralPath $Backup.Dll -Destination $dll -Force }
  Remove-Quiet (Join-Path $Win64 'sos_host.ini'); Remove-Quiet (Join-Path $Win64 'sos_host.log')
  Get-ChildItem -LiteralPath $Win64 -Filter 'sos_game_*.log' -ErrorAction SilentlyContinue | ForEach-Object { Remove-Quiet $_.FullName }
  if (Test-Path -LiteralPath $Backup.AppId) { Remove-Quiet (Join-Path $Win64 'steam_appid.txt'); Remove-Quiet $Backup.AppId }
  if (Test-Path -LiteralPath $Backup.Ini) { Move-Item -LiteralPath $Backup.Ini -Destination $EngineIni -Force }
  elseif (Test-Path -LiteralPath $Backup.IniNone) { Remove-Quiet $EngineIni; Remove-Quiet $Backup.IniNone }
}

# Engine.ini: replace the [Outpost*] sections, keep everything else.
function Write-EngineIni($base, $ip, $bport) {
  New-Item -ItemType Directory -Force -Path (Split-Path $EngineIni) | Out-Null
  if (Test-Path -LiteralPath $EngineIni) { Copy-Item -LiteralPath $EngineIni -Destination $Backup.Ini -Force }
  else { Set-Content -LiteralPath $Backup.IniNone -Value 'no original' }
  $mine = '^\[(OutpostKeyValueStore|OutpostIdentity|OutpostAppPersistence|OutpostIAP|OutpostStorefront|OutpostLeaderboards|OutpostLogReceiver|OutpostStreams|OutpostStreamClient|OutpostMatchmakingClient)\]\s*$'
  $keep = New-Object Collections.Generic.List[string]; $skip = $false
  if (Test-Path -LiteralPath $EngineIni) {
    foreach ($l in (Get-Content -LiteralPath $EngineIni)) {
      if ($l -match '^\[') { $skip = ($l.Trim() -match $mine) }
      if (-not $skip) { $keep.Add($l) }
    }
  }
  $add = @('', '[OutpostKeyValueStore]', "EndpointClient=`"$base/kv/`"", "EndpointClientFallback=`"$base/kv/`"", "EndpointServer=`"$base/kv/`"",
    '', '[OutpostIdentity]', "Endpoint=`"$base`"", '', '[OutpostAppPersistence]', "Endpoint=`"$base`"",
    '', '[OutpostLeaderboards]', "Endpoint=`"$base`"", '', '[OutpostLogReceiver]', "Endpoint=`"$base`"",
    '', '[OutpostStreams]', "EmbedEndpoint=`"$base`"",
    '', '[OutpostStreamClient]', "StreamEndpoint=$ip", "StreamPort=$bport", 'StreamSSL=False', 'StreamPath=/ws/stream',
    '', '[OutpostMatchmakingClient]', 'MatchmakingSSL=False', "MatchmakingPort=$bport", "MatchmakingEndpoint=$ip", "MatchmakingApi=`"$base/api`"")
  [IO.File]::WriteAllText($EngineIni, ((($keep + $add) -join "`r`n") + "`r`n"), (New-Object Text.UTF8Encoding($false)))
}
function Install-Host {
  $dll = Join-Path $Win64 'version.dll'
  if ((Test-Path -LiteralPath $dll) -and ((Get-Sha $dll) -ne (Get-Sha $KitDll))) { Move-Item -LiteralPath $dll -Destination $Backup.Dll -Force }
  Copy-Item -LiteralPath $KitDll -Destination $dll -Force
  $ini = (Get-Content -LiteralPath $KitIni) -replace '^Port=.*$', "Port=$Port"
  Set-Content -LiteralPath (Join-Path $Win64 'sos_host.ini') -Value $ini -Encoding ASCII
  $appid = Join-Path $Win64 'steam_appid.txt'
  if (-not (Test-Path -LiteralPath $appid)) { Set-Content -LiteralPath $appid -Value $AppId -Encoding ASCII; Set-Content -LiteralPath $Backup.AppId -Value 'created' }
}

# ---------------------------------------------------------------- host token (HS512 JWT keyed with the session token)
function ConvertTo-B64Url([byte[]]$b) { [Convert]::ToBase64String($b).TrimEnd('=').Replace('+', '-').Replace('/', '_') }
function New-HostJwt($sid, $token, $hid) {
  $u = New-Object Text.UTF8Encoding($false)
  $now = [int64][Math]::Floor(([DateTime]::UtcNow - [DateTime]'1970-01-01').TotalSeconds)
  $h = ConvertTo-B64Url $u.GetBytes('{"typ":"JWT","alg":"HS512"}')
  $c = ConvertTo-B64Url $u.GetBytes(('{{"sub":"{0}","id":"{1}","user-id":"{1}","account-id":"{1}","roles":["user+session"],"iat":{2},"exp":{3}}}' -f $sid, $hid, $now, ($now + 86400)))
  $hmac = New-Object Security.Cryptography.HMACSHA512(, $u.GetBytes($token))
  $sig = ConvertTo-B64Url $hmac.ComputeHash($u.GetBytes("$h.$c"))
  return "$h.$c.$sig"
}

# ---------------------------------------------------------------- 4. backend address
$ip = $null
try { $ip = ([Net.Dns]::GetHostAddresses($BackendHost) | Where-Object { $_.AddressFamily -eq 'InterNetwork' } | Select-Object -First 1).ToString() } catch { }
if (-not $ip) { Fail "Cannot resolve the backend '$BackendHost' to an IPv4 address. Check Backend in server.cfg and your internet connection." }
$BaseUrl = "http://${ip}:$BackendPort"

if ($Cleanup) { Invoke-Cleanup; Say 'Leftovers removed.'; exit 0 }

# ---------------------------------------------------------------- 5. register
$Saved = $null
if (Test-Path -LiteralPath $StateFile) { try { $Saved = Get-Content -Raw -LiteralPath $StateFile | ConvertFrom-Json } catch { $Saved = $null } }
function Invoke-Register {
  $body = @{ name = $Cfg.Name; region = $Cfg.Region; port = $Port; maxPlayers = $Max; hostIds = @($HostIds) }
  if ($Cfg.CommunityKey -ne '') { $body.key = $Cfg.CommunityKey }
  if ($script:Saved -and $script:Saved.sessionId -and $script:Saved.sessionToken) { $body.sessionId = $script:Saved.sessionId; $body.sessionToken = $script:Saved.sessionToken }
  return (Invoke-Http 'POST' "$BaseUrl/api/community/register" @{} ($body | ConvertTo-Json -Compress -Depth 4))
}
function Get-ErrText($r) { if ($r.Json -and $r.Json.error) { return [string]$r.Json.error } else { return "HTTP $($r.Code)" } }

Say "Server '$($Cfg.Name)' ($($Cfg.Region), max $Max players), UDP port $Port"
Say "Game folder: $Game"
Say ("Steam account: " + $(if ($SteamId -ne '0') { 'found' } else { 'not found (using anonymous host id)' }))
Say "Backend: $($Cfg.Backend) -> $BaseUrl"
if ($DryRun) {
  Say 'Dry run: would register, write Engine.ini sections, install version.dll + sos_host.ini into'
  Say "  $Win64"
  Say "  Engine.ini: $EngineIni"
  Say "  kit DLL present: $(Test-Path -LiteralPath $KitDll), kit ini present: $(Test-Path -LiteralPath $KitIni)"
  Say 'Dry run finished, nothing was changed.'
  exit 0
}
if (-not (Test-Path -LiteralPath $KitDll) -or -not (Test-Path -LiteralPath $KitIni)) { Fail 'sos_host\version.dll or sos_host.ini is missing from the kit folder.' }

$reg = Invoke-Register
if ($Saved -and ($reg.Code -eq 401 -or ($reg.Code -eq 403 -and "$($reg.Body)" -match 'ip-mismatch'))) {
  Say 'Saved registration was rejected; registering fresh.'
  Remove-Quiet $StateFile; $Saved = $null; $reg = Invoke-Register
}
if ($reg.Code -eq 409) { Fail 'A previous registration of this server is still alive. Wait about 10 minutes and start again, or restore the old state.json.' }
if ($reg.Code -eq 403 -and "$($reg.Body)" -match 'key-required') { Fail 'This backend needs a community key: set CommunityKey in server.cfg.' }
if ($reg.Code -ne 200 -or -not $reg.Json -or -not $reg.Json.sessionId) {
  if ($reg.Code -eq 0) { Fail "Cannot reach the backend at $BaseUrl." }
  Fail "Registration failed: $(Get-ErrText $reg)"
}
$SessionId = [string]$reg.Json.sessionId; $SessionToken = [string]$reg.Json.sessionToken
$Saved = [pscustomobject]@{ sessionId = $SessionId; sessionToken = $SessionToken }
$Saved | ConvertTo-Json | Set-Content -LiteralPath $StateFile -Encoding ASCII
Say "Registered, session $($SessionId.Substring(0, [Math]::Min(8, $SessionId.Length)))"
if ($reg.Json.note) { Say "Backend note: $($reg.Json.note)" }

# ---------------------------------------------------------------- watchdog helpers
function Get-Status {
  $r = Invoke-Http 'GET' "$BaseUrl/api/community/status/$SessionId" @{} $null
  if ($r.Code -eq 200) { return $r.Json } else { return $null }
}
function Test-Listening {
  $f = Join-Path $Win64 'sos_host.log'
  try {
    $fs = [IO.File]::Open($f, 'Open', 'Read', 'ReadWrite'); $sr = New-Object IO.StreamReader($fs)
    $t = $sr.ReadToEnd(); $sr.Close()
    return ($t -match 'Listening with')
  } catch { return $false }
}
function Start-Game {
  Get-ChildItem -LiteralPath $Win64 -Filter 'sos_game_*.log' -ErrorAction SilentlyContinue | ForEach-Object { Remove-Quiet $_.FullName }
  Remove-Quiet (Join-Path $Win64 'sos_host.log')
  $jwt = New-HostJwt $SessionId $SessionToken $HostId
  $env:SOS_HOST_BACKEND = "$BaseUrl/api"; $env:SOS_HOST_SESSION = $SessionId; $env:SOS_HOST_TOKEN = $SessionToken
  $env:SteamAppId = $AppId; $env:SteamGameId = $AppId
  $style = if ($Cfg.ShowWindow -eq '1') { 'Normal' } else { 'Hidden' }
  $args2 = @("LaCuna?game=SUR?listen?AuthToken=$jwt", "-SESSION_ID=$SessionId", "-SESSION_TOKEN=$SessionToken", '-nullrhi', '-nosound', '-unattended', '-log')
  Say 'Starting the game...'
  return (Start-Process -FilePath $Exe -ArgumentList $args2 -WorkingDirectory $Win64 -WindowStyle $style -PassThru)
}
# Only ever stops the process this script started, by PID.
function Stop-Game($p) {
  if ($p -and -not $p.HasExited) {
    try { Stop-Process -Id $p.Id -Force -ErrorAction Stop; [void]$p.WaitForExit(15000) } catch { }
  }
}

# ---------------------------------------------------------------- 6-10. run
$Proc = $null
try {
  Invoke-Cleanup                       # leftovers of a crashed run: restore originals first
  Write-EngineIni $BaseUrl $ip $BackendPort
  Install-Host
  Say 'Host files installed. Keep this window open; press Ctrl+C to stop the server.'
  $lastBeat = Get-Date; $lastLine = ''; $probeFailSince = $null; $hinted = $false
  while ($true) {
    $Proc = Start-Game
    $start = Get-Date; $listening = $false; $reason = 'exited'; $endedAt = $null
    while (-not $Proc.HasExited) {
      Start-Sleep -Seconds 15
      if ($Proc.HasExited) { break }
      $up = [int]((Get-Date) - $start).TotalSeconds
      # heartbeat: renew the registration every 4 minutes
      if (((Get-Date) - $lastBeat).TotalSeconds -ge 240) {
        $lastBeat = Get-Date
        $rr = Invoke-Register
        if ($rr.Code -ne 200) { Say "Renewing the registration failed ($(Get-ErrText $rr)); will retry." }
      }
      $st = Get-Status
      if ($st) {
        $line = "listed=$(if ($st.listed) { 'yes' } else { 'no' }) probe=$($st.probe) players=$($st.players) lobby=$($st.state)"
        if ($line -ne $lastLine) { Say "Status: $line"; $lastLine = $line }
        if (-not $st.listed -and "$($st.probe)" -eq 'failed') {
          if (-not $probeFailSince) { $probeFailSince = Get-Date }
          if (-not $hinted -and ((Get-Date) - $probeFailSince).TotalSeconds -gt 120) {
            $hinted = $true
            Say "The backend cannot reach UDP $Port on your public IP: forward UDP $Port on your router to this PC and allow SOS-Win64-Shipping.exe through Windows Firewall."
          }
        } else { $probeFailSince = $null; $hinted = $false }
      }
      if (-not $listening) {
        if (Test-Listening) {
          $listening = $true; Say "Game is listening after ${up}s"
          if ($st -and ("$($st.state)" -eq 'started' -or "$($st.state)" -eq 'ended')) {
            $rs = Invoke-Http 'POST' "$BaseUrl/api/session/$SessionId/reset" @{ Authorization = "Token $SessionToken" } $null
            Say "Lobby reset (HTTP $($rs.Code))"
          }
        } elseif ($up -gt 300) { $reason = "no 'Listening with' after ${up}s"; break }
        continue
      }
      if ($st -and "$($st.state)" -eq 'ended') {
        # Let the post-game show finish: recycle once nobody is connected (last 'Players alive=A connected=C' line), min 20 s, cap 300 s.
        if (-not $endedAt) { $endedAt = Get-Date }
        $g = ((Get-Date) - $endedAt).TotalSeconds
        $last = Get-Content -LiteralPath (Join-Path $Win64 'sos_host.log') -ErrorAction SilentlyContinue | Where-Object { $_ -match 'Players alive=' } | Select-Object -Last 1
        if ($g -ge 300 -or ($g -ge 20 -and $last -match 'connected=0')) { $reason = 'match ended'; break }
      }
      if ($up -gt 600) {
        $seen = if ($st) { $st.lastSeenSec } else { $null }
        if ($null -eq $seen -or $seen -gt 300) {
          Start-Sleep -Seconds 60              # a backend restart must not kill the game: check twice
          $st = Get-Status; $seen = if ($st) { $st.lastSeenSec } else { $null }
          if ($null -ne $seen -and $seen -gt 300) { $reason = "no backend poll for ${seen}s (hang)"; break }
        }
      }
      if ($up -gt 79200 -and $st -and "$($st.state)" -eq 'waiting' -and [int]$st.players -eq 0) { $reason = 'daily restart (fresh host token)'; break }
    }
    Say "Game stopped: $reason"
    Stop-Game $Proc
    Start-Sleep -Seconds 5
  }
} finally {
  Say 'Stopping...'
  Stop-Game $Proc
  if ($SessionId) {
    [void](Invoke-Http 'POST' "$BaseUrl/api/community/unregister" @{ Authorization = "Token $SessionToken" } (@{ sessionId = $SessionId } | ConvertTo-Json -Compress))
  }
  Invoke-Cleanup
  Say 'Server stopped'
}
