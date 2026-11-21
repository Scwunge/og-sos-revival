# build-kit.ps1 - packages the SOS: Classic community host kit.
#   .\build-kit.ps1 -Dll C:\path\to\version.dll -Version 1.0
# Output: deploy\host-kit\dist\sos-classic-host-kit-<version>\ and the matching .zip.
# The kit never contains game files. Packaging is refused if a secrets scan finds anything suspicious.
param(
  [Parameter(Mandatory = $true)][string]$Dll,
  [string]$Version = 'dev'
)
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^[A-Za-z0-9._-]+$') { throw "Version may only contain letters, digits, '.', '_' and '-'." }
if (-not (Test-Path -LiteralPath $Dll)) { throw "Dll not found: $Dll" }

$Kit = $PSScriptRoot
$Repo = (Resolve-Path (Join-Path $Kit '..\..')).Path
$Name = "sos-classic-host-kit-$Version"
$Dist = Join-Path $Kit 'dist'
$Out = Join-Path $Dist $Name
$Zip = Join-Path $Dist "$Name.zip"
$Utf8 = New-Object Text.UTF8Encoding($false)

if (Test-Path -LiteralPath $Out) { Remove-Item -LiteralPath $Out -Recurse -Force }
if (Test-Path -LiteralPath $Zip) { Remove-Item -LiteralPath $Zip -Force }
New-Item -ItemType Directory -Force -Path $Out | Out-Null

# Copy a text file with normalised line endings (LF or CRLF), optionally transforming the text first.
function Add-Text($src, $dst, $eol, $transform) {
  $text = [IO.File]::ReadAllText($src)
  if ($transform) { $text = & $transform $text }
  $text = ($text -replace "`r`n", "`n") -replace "`r", "`n"
  if ($eol -eq 'crlf') { $text = $text -replace "`n", "`r`n" }
  $target = Join-Path $Out $dst
  New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
  [IO.File]::WriteAllText($target, $text, $Utf8)
}
function Add-Binary($src, $dst) {
  $target = Join-Path $Out $dst
  New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
  Copy-Item -LiteralPath $src -Destination $target -Force
}

# ---- Dockerfile: the classic-host Dockerfile plus the community wrapper and the kit's host files.
$MakeDockerfile = {
  param($t)
  if ($t -notmatch '(?m)^USER ubuntu\s*$' -or $t -notmatch '(?m)^ENTRYPOINT .*$') { throw 'classic-host Dockerfile has an unexpected layout (USER/ENTRYPOINT lines not found).' }
  $add = "# --- community host kit additions ---`nCOPY community-host.sh /usr/local/bin/community-host.sh`nCOPY sos_host /kit/sos_host`nRUN chmod 755 /usr/local/bin/community-host.sh`nUSER ubuntu"
  $t = [regex]::Replace($t, '(?m)^USER ubuntu\s*$', $add)
  $t = [regex]::Replace($t, '(?m)^ENTRYPOINT .*$', 'ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/community-host.sh"]')
  return ($t -replace 'see docs/LINUX_HOST\.md', 'see README.md')
}

# ---- stage
Add-Text (Join-Path $Kit 'README.md') 'README.md' 'lf'
Add-Text (Join-Path $Repo 'LICENSE') 'LICENSE' 'lf'
Add-Text (Join-Path $Kit 'windows\Start Server.cmd') 'windows\Start Server.cmd' 'crlf'
Add-Text (Join-Path $Kit 'windows\sos-server.ps1') 'windows\sos-server.ps1' 'crlf'
Add-Text (Join-Path $Kit 'windows\server.cfg') 'windows\server.cfg' 'crlf'
Add-Binary $Dll 'windows\sos_host\version.dll'
Add-Text (Join-Path $Kit 'sos_host.ini') 'windows\sos_host\sos_host.ini' 'crlf'
Add-Text (Join-Path $Kit 'linux\compose.yaml') 'linux\compose.yaml' 'lf'
Add-Text (Join-Path $Kit 'linux\server.env.example') 'linux\server.env.example' 'lf'
Add-Text (Join-Path $Kit 'linux\community-host.sh') 'linux\community-host.sh' 'lf'
Add-Text (Join-Path $Repo 'deploy\classic-host\Dockerfile') 'linux\Dockerfile' 'lf' $MakeDockerfile
Add-Text (Join-Path $Repo 'deploy\classic-host\entrypoint.sh') 'linux\entrypoint.sh' 'lf'
Add-Binary $Dll 'linux\sos_host\version.dll'
Add-Text (Join-Path $Kit 'sos_host.ini') 'linux\sos_host\sos_host.ini' 'lf'

# ---- secrets scan (text files only)
$rules = [ordered]@{
  'RFC1918 10.x'     = '(?<![\d.])10\.\d{1,3}\.\d{1,3}\.\d{1,3}(?![\d])'
  'RFC1918 192.168'  = '(?<![\d.])192\.168\.\d{1,3}\.\d{1,3}(?![\d])'
  'RFC1918 172.16-31' = '(?<![\d.])172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}(?![\d])'
  'cobblegen'        = '(?i)cobblegen'
  'SteamID64'        = '(?<!\d)7656\d{13}(?!\d)'
  '48-hex string'    = '(?<![0-9a-fA-F])[0-9a-fA-F]{48}(?![0-9a-fA-F])'
}
$hits = @()
foreach ($f in (Get-ChildItem -LiteralPath $Out -Recurse -File | Where-Object { $_.Extension -ne '.dll' })) {
  $text = [IO.File]::ReadAllText($f.FullName)
  foreach ($k in $rules.Keys) {
    if ($text -match $rules[$k]) { $hits += "$($f.FullName.Substring($Out.Length + 1)): $k" }
  }
}
if ($hits.Count -gt 0) {
  Remove-Item -LiteralPath $Out -Recurse -Force
  throw ("Secrets scan failed, nothing packaged:`n  " + ($hits -join "`n  "))
}

# ---- checksums (LF, relative forward-slash paths)
$sums = foreach ($f in (Get-ChildItem -LiteralPath $Out -Recurse -File | Sort-Object FullName)) {
  '{0}  {1}' -f (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLower(), $f.FullName.Substring($Out.Length + 1).Replace('\', '/')
}
[IO.File]::WriteAllText((Join-Path $Out 'SHA256SUMS.txt'), (($sums -join "`n") + "`n"), $Utf8)

# ---- zip. Built with System.IO.Compression so entry names use '/' (Windows PowerShell 5.1's
# Compress-Archive writes backslashes, which unzip on Linux mishandles) and file bytes stay untouched.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$za = [IO.Compression.ZipFile]::Open($Zip, 'Create')
try {
  foreach ($f in (Get-ChildItem -LiteralPath $Out -Recurse -File | Sort-Object FullName)) {
    $entry = "$Name/" + $f.FullName.Substring($Out.Length + 1).Replace('\', '/')
    [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($za, $f.FullName, $entry, 'Optimal')
  }
} finally { $za.Dispose() }

Write-Host "Kit folder: $Out"
Write-Host "Zip:        $Zip"
