# Builds xinput1_3.dll (the sos_client proxy) with MinGW-w64 gcc.
# Usage: .\build.ps1 [-Gcc path\to\gcc.exe]
param([string]$Gcc = 'gcc')
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
New-Item -ItemType Directory -Force build | Out-Null
& $Gcc -shared -O2 -Wall -Wextra -o build\xinput1_3.dll sos_client.c xinput1_3.def `
    -static -static-libgcc -s '-Wl,--enable-stdcall-fixup' `
    -lkernel32 -luser32 -lgdi32 -lwinhttp -lws2_32 -ld3d11 -ldxgi -ldxguid
if ($LASTEXITCODE -ne 0) { throw "gcc failed ($LASTEXITCODE)" }
Copy-Item sos_client.ini build\sos_client.ini -Force
Get-Item build\xinput1_3.dll | Select-Object FullName, Length
