# Real-client capture against a test backend (HERO_TV.md 8.5), run in the owner's desktop session.
# Builds the join file for -Server, starts SOS: Classic through it, leaves it in the menus for -Seconds,
# closes it the normal way (WM_CLOSE, kill only as a fallback) and checks Engine.ini was put back.
# Everything lands in dist\hero-capture-<utc stamp>\ (git-ignored): client.log, summary.txt, screenshots,
# and the backend's http.jsonl / ws.jsonl if ssh to -SshHost works without a prompt.
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\hero_client_capture.ps1 -Server <vps-ip>:7783 [-SshHost <vps-ssh-alias>] [-Seconds 120]
param(
  [Parameter(Mandatory)][string]$Server,   # <vps-ip>:7783
  [int]$Seconds = 120,
  [string]$Container = 'ogsos-hero-backend-hero-1',
  [string]$SshHost = '',          # ssh host/alias of the test backend's machine; empty = do not fetch backend logs
  [string]$OutDir = '',          # step1_all.ps1 passes its own capture folder (summary.txt is shared)
  [switch]$NoBackendLogs          # step1_all.ps1 fetches them itself with the ssh options that worked
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot
$start = (Get-Date).ToUniversalTime()
$out = if ($OutDir) { $OutDir } else { Join-Path $repo ("dist\hero-capture-" + $start.ToString('yyyyMMdd-HHmmss')) }
New-Item -ItemType Directory -Force $out | Out-Null
$summary = Join-Path $out 'summary.txt'
function Note($m) { $l = "$((Get-Date).ToUniversalTime().ToString('HH:mm:ss'))Z $m"; Write-Host $l; Add-Content $summary $l }
function Shot($name) {
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $b = [Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object Drawing.Bitmap $b.Width, $b.Height
    $g = [Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
    $bmp.Save((Join-Path $out "$name.png"), [Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()
    Note "screenshot $name.png"
  } catch { Note "screenshot $name failed: $($_.Exception.Message)" }
}

Note "start $($start.ToString('o')) server $Server"
$ini = Join-Path $env:LOCALAPPDATA 'SOS\Saved\Config\WindowsClient\Engine.ini'
$backup = "$ini.ogsos-join-backup"
$clientLog = Join-Path $env:LOCALAPPDATA 'SOS\Saved\Logs\SOS.log'
if (Get-Process 'SOS-Win64-Shipping' -ErrorAction SilentlyContinue) { Note 'ABORT: SOS is already running'; exit 2 }
if (-not (Get-Process 'steam' -ErrorAction SilentlyContinue)) { Note 'ABORT: Steam is not running (the game needs it signed in)'; exit 2 }
if (-not (Test-Path $ini)) { Note "ABORT: no Engine.ini at $ini"; exit 2 }
if (Test-Path $backup) { Note "ABORT: $backup already exists (an earlier join run never restored). Check it by hand first."; exit 2 }
Copy-Item $ini (Join-Path $out 'Engine.ini.before')

# 1. Join file, made by the same generator players get (falls back to the same substitution if node is missing).
$join = Join-Path $out 'Join hero.cmd'
if (Get-Command node -ErrorAction SilentlyContinue) {
  & node (Join-Path $repo 'tools\make_join_file.js') --server $Server --out $join | Out-Null
} else {
  $tpl = [IO.File]::ReadAllText((Join-Path $repo 'tools\join_classic.template.cmd'))
  [IO.File]::WriteAllText($join, ($tpl.Replace('__SERVER__', $Server) -replace '\r?\n', "`r`n"))
}
if (-not (Test-Path $join)) { Note 'ABORT: join file was not written'; exit 2 }
Note "join file $join"

# 2. Launch through it. <NUL makes the join file's "pause on error" return instead of hanging the task.
$cmd = Start-Process -FilePath $env:ComSpec -ArgumentList "/c `"`"$join`" <NUL`"" -PassThru
$game = $null
for ($i = 0; $i -lt 90 -and -not $game; $i++) { Start-Sleep 1; $game = Get-Process 'SOS-Win64-Shipping' -ErrorAction SilentlyContinue | Select-Object -First 1 }
if (-not $game) {
  Note 'game did not start within 90 s'
  if (-not $cmd.HasExited) { Stop-Process -Id $cmd.Id -Force }
} else {
  Note "game started pid $($game.Id); staying in the menus for $Seconds s (no input is sent)"
  $marks = @{}; $marks[30] = 'menu-030s'; $marks[[int]($Seconds * 0.6)] = 'menu-mid'; $marks[$Seconds - 5] = 'menu-end'
  for ($s = 1; $s -le $Seconds; $s++) {
    Start-Sleep 1
    if ($game.HasExited) { Note "game exited by itself after $s s (code $($game.ExitCode))"; break }
    if ($marks.ContainsKey($s)) { Shot $marks[$s] }
  }
  # 3. Normal close: WM_CLOSE to the main window is the same as the window's X (UE4 runs its exit path).
  if (-not $game.HasExited) {
    [void]$game.CloseMainWindow()
    if ($game.WaitForExit(60000)) { Note 'game closed cleanly (WM_CLOSE)' }
    else { Note 'game ignored WM_CLOSE for 60 s, killing it'; Stop-Process -Id $game.Id -Force; [void]$game.WaitForExit(15000) }
  }
}

# 4. The join file restores Engine.ini once the game exits. Make sure it did.
if (-not $cmd.WaitForExit(30000)) { Note 'join window still open after 30 s, closing it'; Stop-Process -Id $cmd.Id -Force }
Start-Sleep 2
if (Test-Path $backup) { Copy-Item $backup $ini -Force; Remove-Item $backup -Force; Note 'Engine.ini restored by this script (join file did not)' }
$same = (Get-FileHash $ini).Hash -eq (Get-FileHash (Join-Path $out 'Engine.ini.before')).Hash
Note ("Engine.ini back to the pre-test file: $same" + $(if (Select-String -Path $ini -Pattern ':7783|=7783' -Quiet) { ' (WARNING: still mentions 7783)' } else { '' }))

# 5. Client log and the lines that matter for KV / Stream / Fame / embeds.
if (Test-Path $clientLog) {
  Copy-Item $clientLog (Join-Path $out 'client.log')
  Add-Content $summary "`r`n--- client.log matches ---"
  Select-String -Path $clientLog -Pattern 'KeyValue|LogOutpostKV|FAME|FEEDBACK|Fame|Feedback|Stream|Embed|hero|CEF|WebBrowser|Leaderboard|Json|Error|Warning' |
    Select-Object -First 600 | ForEach-Object { Add-Content $summary $_.Line }
  Note 'client log copied'
} else { Note "no client log at $clientLog" }

# 6. Backend logs (best effort, no prompts). If this fails, the leader copies them on the server instead.
foreach ($f in $(if ($NoBackendLogs -or -not $SshHost) { @() } else { 'http.jsonl', 'ws.jsonl' })) {
  $dst = Join-Path $out "backend-$f"
  & $env:ComSpec /c "ssh -o BatchMode=yes -o ConnectTimeout=10 $SshHost docker exec $Container cat /logs/$f > `"$dst`" 2>NUL"
  if ($LASTEXITCODE -eq 0 -and (Test-Path $dst) -and (Get-Item $dst).Length -gt 0) { Note "backend $f fetched" }
  else { Note "backend $f NOT fetched (ssh exit $LASTEXITCODE)"; Remove-Item $dst -ErrorAction SilentlyContinue }
}
Note "done; results in $out"
