# Builds the client mod with MinGW-w64 gcc: build\xinput1_3.dll (stable loader) and build\sos_client_core.dll (the mod).
# Usage: .\build.ps1 [-Gcc path\to\gcc.exe] [-CoreVersion N]   (CoreVersion is the build number the core reports)
param([string]$Gcc = 'gcc', [int]$CoreVersion = 1)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
New-Item -ItemType Directory -Force build | Out-Null
& $Gcc -shared -O2 -Wall -Wextra -DSOS_CORE "-DSOS_CORE_VERSION=$CoreVersion" -o build\sos_client_core.dll sos_client.c ed25519.c `
    -static -static-libgcc -s `
    -lkernel32 -luser32 -lgdi32 -lwinhttp -lws2_32 -ld3d11 -ldxgi -ldxguid
if ($LASTEXITCODE -ne 0) { throw "gcc (core) failed ($LASTEXITCODE)" }
& $Gcc -shared -O2 -Wall -Wextra -o build\xinput1_3.dll loader.c ed25519.c xinput1_3.def `
    -static -static-libgcc -s '-Wl,--enable-stdcall-fixup' -lkernel32
if ($LASTEXITCODE -ne 0) { throw "gcc (loader) failed ($LASTEXITCODE)" }
Copy-Item sos_client.ini build\sos_client.ini -Force
Get-Item build\xinput1_3.dll, build\sos_client_core.dll | Select-Object Name, Length
