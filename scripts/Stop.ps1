[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\Common.ps1')
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskInstall = Read-CnccInstall $taskRoot
$taskEnvBefore = @{}
foreach ($taskName in @('CNCC_DATA_DIR', 'CNCC_SETTINGS_DIR', 'CNCC_NODE', 'CNCC_PYTHON')) { $taskEnvBefore[$taskName] = [Environment]::GetEnvironmentVariable($taskName, 'Process') }
try {
Set-CnccEnvironment $taskInstall
& (Join-Path (Join-Path $taskRoot 'app') $taskInstall.runtime.stopScript)
if (-not $?) { throw 'The enhancement stop script failed.' }
} finally {
    foreach ($taskName in $taskEnvBefore.Keys) { [Environment]::SetEnvironmentVariable($taskName, $taskEnvBefore[$taskName], 'Process') }
}
