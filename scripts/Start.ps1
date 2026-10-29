[CmdletBinding()]
param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\Common.ps1')
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskInstall = Read-CnccInstall $taskRoot
if ($taskInstall.state -ne 'installed') { throw 'Installation is incomplete. Use the repository uninstaller to remove the marked partial install, then retry.' }
Set-CnccEnvironment $taskInstall
$taskStart = Join-Path (Join-Path $taskRoot 'app') $taskInstall.runtime.startScript
$taskArgs = @{}
if ($CheckOnly) { $taskArgs.CheckOnly = $true }
& $taskStart @taskArgs
if (-not $?) { throw 'The enhancement launcher failed.' }
