[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\Common.ps1')
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskInstall = Read-CnccInstall $taskRoot
Set-CnccEnvironment $taskInstall
& (Join-Path (Join-Path $taskRoot 'app') $taskInstall.runtime.stopScript)
if (-not $?) { throw 'The enhancement stop script failed.' }
