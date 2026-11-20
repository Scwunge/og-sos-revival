# Usage: .\run.ps1 <ScriptName.java> <args...>
param([Parameter(Mandatory=$true)][string]$Script, [Parameter(ValueFromRemainingArguments=$true)][string[]]$Rest)
Set-Location 'E:\Tools\ghidra_12.2_PUBLIC'
$env:JAVA_HOME='E:\Tools\jdk-21.0.13.1+2'; $env:GHIDRA_HEADLESS_MAXMEM='16G'
& '.\support\analyzeHeadless.bat' 'E:\Tools\ghidra-projects' 'SOS' -process 'SOS-Win64-Shipping.exe' -noanalysis -readOnly -scriptPath 'E:\OG-SOS-Revival\tools\ghidra' -postScript $Script @Rest
