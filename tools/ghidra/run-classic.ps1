# Same as run.ps1, but queries the SOS: Classic project (Steam app 802240).
# One-time setup: copy "...\steamapps\common\SOS Test Server\SOS\Binaries\Win64\SOS-Win64-Shipping.exe"
# to E:\Tools\ghidra-projects\input\SOS-Classic-Shipping.exe (the "(x86)" path breaks analyzeHeadless.bat),
# then import + analyze once into the separate project "SOS-Classic":
#   analyzeHeadless.bat E:\Tools\ghidra-projects SOS-Classic -import E:\Tools\ghidra-projects\input\SOS-Classic-Shipping.exe
# Usage: .\run-classic.ps1 <ScriptName.java> <args...>
param([Parameter(Mandatory=$true)][string]$Script, [Parameter(ValueFromRemainingArguments=$true)][string[]]$Rest)
$scripts = $PSScriptRoot
Set-Location 'E:\Tools\ghidra_12.2_PUBLIC'
$env:JAVA_HOME='E:\Tools\jdk-21.0.13.1+2'; $env:GHIDRA_HEADLESS_MAXMEM='16G'
& '.\support\analyzeHeadless.bat' 'E:\Tools\ghidra-projects' 'SOS-Classic' -process 'SOS-Classic-Shipping.exe' -noanalysis -readOnly -scriptPath $scripts -postScript $Script @Rest
