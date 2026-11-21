# hero-tv step 1 in one go (HERO_TV.md 8.5). Run on the owner's PC, in the owner's interactive desktop session.
#   A. tar the hero-tv backend files, scp them to OVH, rebuild ogsos-backend:hero, recreate :7783 (project ogsos-hero
#      only, never ogsos), and check that a Classic client gets the live KV rev (feedback key on, no Fame weights key). Stops here if not.
#   B. tools\hero_client_capture.ps1: real client in the menus on :7783 for -Seconds, normal close, Engine.ini put back.
#   C. Fetch the backend's http.jsonl / ws.jsonl.
# Everything goes to dist\hero-capture-<utc stamp>\ (git-ignored) with one summary.txt.
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\step1_all.ps1 -Server <vps-ip>:7783 -SshHost <vps-ssh-alias> [-Seconds 120]
# -OnlyA: just the :7783 rebuild and checks, non-interactive (no desktop or Engine.ini needed); exit 0 = checks OK.
# -OnlyC [-OutDir <folder>]: just fetch the :7783 backend logs, non-interactive; exit 0 = both fetched.
param(
  [Parameter(Mandatory)][string]$Server,     # <vps-ip>:7783
  [Parameter(Mandatory)][string]$SshHost,    # ssh host or alias of the VPS, key auth, no prompt
  [int]$Seconds = 120,
  [string]$Container = 'ogsos-hero-backend-hero-1',
  [switch]$OnlyA,
  [switch]$OnlyC,
  [string]$OutDir = ''
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot
$start = (Get-Date).ToUniversalTime()
$out = if ($OutDir) { $OutDir } else { Join-Path $repo ($(if ($OnlyA) { 'dist\hero-stepA-' } elseif ($OnlyC) { 'dist\hero-stepC-' } else { 'dist\hero-capture-' }) + $start.ToString('yyyyMMdd-HHmmss')) }
New-Item -ItemType Directory -Force $out | Out-Null
$summary = Join-Path $out 'summary.txt'
function Note($m) { $l = "$((Get-Date).ToUniversalTime().ToString('HH:mm:ss'))Z $m"; Write-Host $l; Add-Content $summary $l }
# Native commands run through Start-Process with file redirects: PowerShell 5 pipes mangle binary output and
# turn stderr into terminating errors under 'Stop'.
function Run($exe, [string]$argLine, $name) {
  $o = Join-Path $out "$name.out.txt"; $e = Join-Path $out "$name.err.txt"
  $p = Start-Process -FilePath $exe -ArgumentList $argLine -NoNewWindow -Wait -PassThru -RedirectStandardOutput $o -RedirectStandardError $e
  if ((Get-Item $e).Length -eq 0) { Remove-Item $e }
  return $p.ExitCode
}

try {
  Note "step1_all start $($start.ToString('o')) user $env:USERNAME session $((Get-Process -Id $PID).SessionId) server $Server"
  # B needs the owner's desktop and the owner's Engine.ini; fail before touching OVH if either is missing.
  if (-not $OnlyA -and -not $OnlyC -and (Get-Process -Id $PID).SessionId -eq 0) { Note 'ABORT: running in session 0; start this as an interactive task in the owner''s desktop session'; exit 2 }
  $ini = Join-Path $env:LOCALAPPDATA 'SOS\Saved\Config\WindowsClient\Engine.ini'
  if (-not $OnlyA -and -not $OnlyC -and -not (Test-Path $ini)) { Note "ABORT: no SOS Engine.ini for user $env:USERNAME ($ini); run as the owner"; exit 2 }

  # ---------- A. ssh route: the given host/alias. BatchMode = never a prompt. ----------
  $common = '-o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15'
  $routes = @(@{ name = "ssh $SshHost"; opts = $common; target = $SshHost })
  $ssh = $null; $cFail = $false
  foreach ($r in $routes) {
    $rc = Run 'ssh' "$($r.opts) $($r.target) true" 'A0-ssh-probe'
    Note "ssh probe via $($r.name): exit $rc"
    if ($rc -eq 0) { $ssh = $r; break }
  }
  if (-not $ssh) { Note 'ABORT: no ssh route to OVH works without a prompt (see A0-ssh-probe.err.txt)'; exit 3 }

  if ($OnlyC) { $bExit = 'skipped' } else {
  # ---------- A. stage tar + remote script ----------
  $tar = Join-Path $out 'herotv-stage.tar'
  $rc = Run "$env:SystemRoot\System32\tar.exe" ("-cf `"$tar`" --exclude __pycache__ -C `"$repo`" server data/kv data/kv-classic data/cosmetics.json " +
    '.dockerignore deploy/classic-backend/Dockerfile deploy/classic-backend/compose.hero.yaml tools/stream_test.js') 'A1-tar'
  if ($rc -ne 0) { Note "ABORT: tar exit $rc (A1-tar.err.txt)"; exit 3 }
  Note "stage tar $([math]::Round((Get-Item $tar).Length / 1KB)) KB"
  $remote = Join-Path $out 'herotv-step1-remote.sh'
  $bash = @'
#!/bin/bash
# Written by tools/step1_all.ps1. Touches only /opt/ogsos/stage-herotv, image ogsos-backend:hero and project ogsos-hero.
set -euo pipefail
S=/opt/ogsos/stage-herotv; T=/tmp/herotv-stage.tar; E=$S/deploy/classic-backend/.env.hero
keep=''
if [ -f "$E" ]; then keep=$(mktemp); cp -a "$E" "$keep"; fi
rm -rf "$S"; mkdir -p "$S"; tar -xf "$T" -C "$S"; rm -f "$T"
if [ -n "$keep" ]; then mv "$keep" "$E"; chmod 600 "$E"; echo "kept the existing .env.hero"; fi
cd "$S"
rev=$(tr -d '\r\n ' < data/kv-classic/live-rev.txt)
# Test deploy only: turn the web feedback panels on in the staged KV copy (the committed KV leaves them off until the
# embed pages are checked in the game's CEF). Fame weights are never in the KV (HERO_TV.md 8.6).
f=data/kv-classic/runtime-$rev.json
node -e "const fs=require('fs');const f=process.argv[1];const j=JSON.parse(fs.readFileSync(f,'utf8'));j.UE_CLIENT_FEEDBACK_TYPE='excelsior';fs.writeFileSync(f,JSON.stringify(j,null,2))" "$f"
echo "CHECK stage live-rev=$rev"
docker build -t ogsos-backend:hero -f deploy/classic-backend/Dockerfile .
docker compose -f deploy/classic-backend/compose.hero.yaml up -d --no-build --force-recreate
got=''
for i in $(seq 1 30); do
  got=$(curl -s -m 3 -H 'app-id: sostest' http://127.0.0.1:7783/kv/live-rev.txt | tr -d '\r\n ' || true)
  [ "$got" = "$rev" ] && break; sleep 1
done
fb=$(curl -s -m 5 -H 'app-id: sostest' "http://127.0.0.1:7783/kv/runtime-$rev.json" | grep -c 'UE_CLIENT_FEEDBACK_TYPE' || true)
wt=$(curl -s -m 5 -H 'app-id: sostest' "http://127.0.0.1:7783/kv/runtime-$rev.json" | grep -c 'UE_CLIENT_FAME_WEIGHTINGS' || true)
echo "CHECK :7783 live-rev=$got (want $rev)"
echo "CHECK :7783 FEEDBACK_TYPE keys=$fb (want 1), FAME_WEIGHTINGS keys=$wt (want 0)"
docker ps --filter name=ogsos-hero --format 'CONTAINER {{.Names}} {{.Image}} {{.Status}} {{.Ports}}'
[ "$got" = "$rev" ] && [ "$fb" = 1 ] && [ "$wt" = 0 ] || { echo 'CHECK FAILED: :7783'; exit 4; }
echo 'CHECKS OK'
'@
  [IO.File]::WriteAllText($remote, $bash.Replace("`r`n", "`n"))
  $rc = Run 'scp' "$($ssh.opts) `"$tar`" `"$remote`" $($ssh.target):/tmp/" 'A2-scp'
  if ($rc -ne 0) { Note "ABORT: scp exit $rc (A2-scp.err.txt)"; exit 3 }
  $rc = Run 'ssh' "$($ssh.opts) $($ssh.target) bash /tmp/herotv-step1-remote.sh" 'A3-rebuild'
  Get-Content (Join-Path $out 'A3-rebuild.out.txt') | Where-Object { $_ -match '^(CHECK|CONTAINER|kept)' } | ForEach-Object { Note "  $_" }
  if ($rc -ne 0) { Note "STOP: rebuild or checks failed, exit $rc (A3-rebuild.out.txt / .err.txt). B and C not run."; exit 4 }
  Note 'A done: :7783 rebuilt, Classic KV served as expected'
  if ($OnlyA) { Note "STEP A OK; results in $out"; exit 0 }

  # ---------- B. real client in the menus ----------
  $capture = Join-Path $PSScriptRoot 'hero_client_capture.ps1'
  & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File $capture -Server $Server -Seconds $Seconds -OutDir $out -NoBackendLogs
  $bExit = $LASTEXITCODE
  Note "B done: capture exit $bExit"
  }

  # ---------- C. backend logs (B never fetches them when run from here) ----------
  foreach ($f in 'http.jsonl', 'ws.jsonl') {
    $rc = Run 'ssh' "$($ssh.opts) $($ssh.target) docker exec $Container cat /logs/$f" "C-backend-$f"
    $got = Join-Path $out "C-backend-$f.out.txt"
    $dst = Join-Path $out "backend-$f"
    if ($rc -eq 0 -and (Get-Item $got).Length -gt 0) { Move-Item $got $dst -Force; Note "C: backend $f fetched ($([math]::Round((Get-Item $dst).Length / 1KB)) KB)" }
    else { Note "C: backend $f NOT fetched (exit $rc)"; $cFail = $true }
  }
  if (-not $OnlyC) { Note "capture window for the backend logs: t >= $($start.ToString('o'))" }
  Note "STEP1 FINISHED (B exit $bExit); results in $out"
  if ($cFail) { exit 5 }
} catch {
  Note "ERROR: $($_.Exception.Message) at line $($_.InvocationInfo.ScriptLineNumber)"
  exit 1
}
