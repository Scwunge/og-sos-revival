# Builds a release of the SOS: Classic client mod into dist\ (gitignored):
#   dist\OG-SOS-Mod-v<Version>.zip            what players download (Nexus)
#   dist\NEXUS_DESCRIPTION.txt                BBCode page text
#   dist\SHA256SUMS.txt                       hashes of every file
#   dist\update-server\                       manifest.json, manifest.sig, core-<N>.dll for the backend's data\mod
# Keep -CoreVersion increasing between releases: the loader refuses a lower number than the installed core.
# Needs the signing key at %USERPROFILE%\.ogsos\update-signing.key (tools\mod_update.js keygen).
param([string]$Version = '1.0.0', [int]$CoreVersion = 1)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$mod = Join-Path $repo 'mod\sos_client'
$dist = Join-Path $repo 'dist'
$stage = Join-Path $dist "OG-SOS-Mod-v$Version"
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force $stage | Out-Null
& (Join-Path $mod 'build.ps1') -CoreVersion $CoreVersion | Out-Null
$b = Join-Path $mod 'build'
Copy-Item "$b\xinput1_3.dll", "$b\sos_client_core.dll" $stage
Copy-Item (Join-Path $mod 'sos_client.ini') $stage
foreach ($f in 'README.txt', 'CHANGELOG.txt') { Copy-Item (Join-Path $mod "release\$f") $stage }
$upd = Join-Path $dist 'update-server'
if (Test-Path $upd) { Remove-Item -Recurse -Force $upd }
node (Join-Path $repo 'tools\mod_update.js') sign "$b\sos_client_core.dll" $CoreVersion $upd "OG-SOS-Mod $Version"
if ($LASTEXITCODE -ne 0) { throw 'signing failed' }
Copy-Item "$upd\manifest.json" "$stage\sos_client_core.manifest"
Copy-Item "$upd\manifest.sig" "$stage\sos_client_core.sig"
node (Join-Path $repo 'tools\mod_update.js') verify "$stage\sos_client_core.manifest" "$stage\sos_client_core.sig"
if ($LASTEXITCODE -ne 0) { throw 'verify failed' }
Copy-Item (Join-Path $mod 'release\NEXUS_DESCRIPTION.txt') $dist -Force
$zip = Join-Path $dist "OG-SOS-Mod-v$Version.zip"
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path "$stage\*" -DestinationPath $zip
$lines = @()
foreach ($f in (Get-ChildItem $stage -File) + (Get-Item $zip) + (Get-ChildItem $upd -File)) {
    $lines += ('{0}  {1}' -f (Get-FileHash $f.FullName -Algorithm SHA256).Hash.ToLower(), $f.FullName.Substring($dist.Length + 1))
}
$lines | Set-Content (Join-Path $dist 'SHA256SUMS.txt') -Encoding ascii
$lines
