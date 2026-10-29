[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\Common.ps1')
$taskRepo = Split-Path -Parent $PSScriptRoot
$taskSource = Join-Path $taskRepo 'src'
if (Test-Path -LiteralPath (Join-Path $taskRepo '.cncc-install.json') -PathType Leaf) {
    $null = Read-CnccInstall $taskRepo
    $taskSource = Join-Path $taskRepo 'app'
}
$taskProblems = 0
try {
    $taskDeps = Get-CnccDependencies $taskRepo
    [pscustomobject]@{ Node = $taskDeps.NodeVersion; Python = $taskDeps.PythonVersion; Playwright = $taskDeps.PlaywrightVersion } | Format-List
} catch { Write-Output $_.Exception.Message; $taskProblems++ }
try {
    $taskManifest = Get-CnccRuntimeManifest $taskRepo
    $taskMissing = @($taskManifest.files | Where-Object { -not (Test-Path -LiteralPath (Join-Path $taskSource $_) -PathType Leaf) })
    if ($taskMissing.Count -gt 0) { throw ('Runtime source files missing: ' + ($taskMissing -join ', ')) }
    'Runtime sources: present'
} catch { Write-Output $_.Exception.Message; $taskProblems++ }
try {
    $taskPackages = @(Get-AppxPackage -Name OpenAI.Codex)
    if ($taskPackages.Count -ne 1) { throw 'The official Codex package could not be uniquely located.' }
    'Official Codex package version: ' + $taskPackages[0].Version
} catch { Write-Output $_.Exception.Message; $taskProblems++ }
if ($taskProblems -gt 0) { 'Environment checks need attention. No application or account was changed.'; exit 1 }
'Environment checks passed. The official app was not started.'
