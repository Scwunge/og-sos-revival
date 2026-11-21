# Builds version.dll (the sos_host proxy) with MinGW-w64 gcc.
# Usage: .\build.ps1 [-Gcc path\to\gcc.exe]
param([string]$Gcc = 'gcc')
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
New-Item -ItemType Directory -Force build | Out-Null
& $Gcc -shared -O2 -Wall -Wextra -o build\version.dll sos_host.c version.def `
    -static -static-libgcc -s '-Wl,--enable-stdcall-fixup' -lkernel32 -lwinhttp
if ($LASTEXITCODE -ne 0) { throw "gcc failed ($LASTEXITCODE)" }
Copy-Item sos_host.ini build\sos_host.ini -Force
Get-Item build\version.dll | Select-Object FullName, Length
