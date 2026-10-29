[CmdletBinding(SupportsShouldProcess = $true)]
param([string]$InstallDir, [string]$DataDir, [switch]$NoShortcut, [switch]$ReuseData)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\Common.ps1')
if (-not $InstallDir) { $InstallDir = Get-CnccDefaultInstallDir }
if (-not $DataDir) { $DataDir = Get-CnccDefaultDataDir }
$taskRepo = Split-Path -Parent $PSScriptRoot
$taskInstall = Assert-CnccSafePath $InstallDir
$taskData = Assert-CnccSafePath $DataDir
if ((Test-CnccInside $taskInstall $taskData) -or (Test-CnccInside $taskData $taskInstall)) { throw 'Program and data directories must be separate.' }
if ((Test-CnccInside $taskInstall $taskRepo) -or (Test-CnccInside $taskRepo $taskInstall) -or (Test-CnccInside $taskData $taskRepo) -or (Test-CnccInside $taskRepo $taskData)) { throw 'Install and data directories must be separate from the source repository.' }
if (Test-Path -LiteralPath $taskInstall) { throw 'The install directory already exists. No files were overwritten.' }
$taskDataExists = Test-Path -LiteralPath $taskData
if ($taskDataExists) {
    if (-not $ReuseData) { throw 'The data directory exists. Use -ReuseData to reuse this project data, or choose a new directory.' }
    $taskDataMarker = Join-Path $taskData '.cncc-data.json'
    $null = Assert-CnccSafePath $taskDataMarker
    if (-not (Test-Path -LiteralPath $taskDataMarker -PathType Leaf)) { throw 'Existing data has no project identity marker; it was preserved.' }
    $taskDataIdentity = Get-Content -LiteralPath $taskDataMarker -Raw | ConvertFrom-Json
    if ($taskDataIdentity.project -ne $script:CnccId -or $taskDataIdentity.schemaVersion -ne 1) { throw 'Existing data belongs to another project; it was preserved.' }
}
$taskManifest = Get-CnccRuntimeManifest $taskRepo
$taskMissing = @($taskManifest.files | Where-Object { -not (Test-Path -LiteralPath (Join-Path (Join-Path $taskRepo 'src') $_) -PathType Leaf) })
if ($taskMissing.Count -gt 0) { throw ('Runtime sources are not integrated: ' + ($taskMissing -join ', ')) }
$taskDeps = Get-CnccDependencies $taskRepo
$taskPackage = Get-Content -LiteralPath (Join-Path $taskRepo 'package.json') -Raw | ConvertFrom-Json
foreach ($taskRequired in @('package.json', 'package-lock.json', 'runtime-manifest.json', 'README.md', 'README.zh-CN.md', 'NOTICE.md', 'LICENSE', 'scripts\Start.ps1', 'scripts\Stop.ps1', 'scripts\lib\Common.ps1')) {
    $taskRequiredPath = Join-Path $taskRepo $taskRequired
    $null = Assert-CnccSafePath $taskRequiredPath
    if (-not (Test-Path -LiteralPath $taskRequiredPath -PathType Leaf)) { throw ('Required distribution file missing: ' + $taskRequired) }
}
foreach ($taskDirectory in @('scripts', 'docs')) {
    if (-not (Test-Path -LiteralPath (Join-Path $taskRepo $taskDirectory) -PathType Container)) { throw ('Required distribution directory missing: ' + $taskDirectory) }
    if (@(Get-ChildItem -LiteralPath (Join-Path $taskRepo $taskDirectory) -Recurse -Force | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }).Count -gt 0) { throw 'Distribution directories must not contain reparse points.' }
}
$taskShortcut = $null
if (-not $NoShortcut) {
    $taskDesktop = [Environment]::GetFolderPath('Desktop')
    if (-not $taskDesktop) { throw 'The desktop folder is unavailable. Use -NoShortcut.' }
    $taskShortcut = Join-Path $taskDesktop $script:CnccShortcutName
    $null = Assert-CnccSafePath $taskShortcut
    if (Test-Path -LiteralPath $taskShortcut) { throw 'The dedicated shortcut already exists; it was not changed.' }
}
[pscustomobject]@{ InstallDir = $taskInstall; DataDir = $taskData; ReuseData = $taskDataExists; Shortcut = $taskShortcut; RuntimeFiles = @($taskManifest.files).Count; NodeVersion = $taskDeps.NodeVersion; PythonVersion = $taskDeps.PythonVersion; PlaywrightVersion = $taskDeps.PlaywrightVersion } | Format-List
if (-not $PSCmdlet.ShouldProcess($taskInstall, 'Create a separate enhancement install and optional shortcut')) { return }
# Refuse existing directories above; no upgrade, replacement, official app edit, or auto-download occurs.
$null = New-Item -ItemType Directory -Path $taskInstall
$taskMarkerPath = Join-Path $taskInstall '.cncc-install.json'
$taskMarker = [ordered]@{ schemaVersion = 1; project = $script:CnccId; version = $taskPackage.version; state = 'installing'; installedAt = (Get-Date).ToString('o'); installDir = $taskInstall; dataDir = $taskData; node = $taskDeps.Node; python = $taskDeps.Python; shortcut = $taskShortcut; runtime = $taskManifest }
$taskMarker | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $taskMarkerPath -Encoding UTF8
try {
$null = New-Item -ItemType Directory -Path (Join-Path $taskInstall 'app')
$null = New-Item -ItemType Directory -Path (Join-Path $taskInstall 'node_modules')
Copy-Item -LiteralPath (Join-Path $taskRepo 'scripts') -Destination $taskInstall -Recurse
Copy-Item -LiteralPath (Join-Path $taskRepo 'docs') -Destination $taskInstall -Recurse
foreach ($taskFile in @('package.json', 'package-lock.json', 'runtime-manifest.json', 'README.md', 'README.zh-CN.md', 'NOTICE.md', 'LICENSE')) {
    Copy-Item -LiteralPath (Join-Path $taskRepo $taskFile) -Destination $taskInstall
}
foreach ($taskFile in $taskManifest.files) {
    $taskTarget = Join-Path (Join-Path $taskInstall 'app') $taskFile
    $taskParent = Split-Path -Parent $taskTarget
    if (-not (Test-Path -LiteralPath $taskParent)) { $null = New-Item -ItemType Directory -Path $taskParent -Force }
    Copy-Item -LiteralPath (Join-Path (Join-Path $taskRepo 'src') $taskFile) -Destination $taskTarget
}
foreach ($taskName in $taskDeps.DependencyDirs) { Copy-Item -LiteralPath (Join-Path (Join-Path $taskRepo 'node_modules') $taskName) -Destination (Join-Path $taskInstall 'node_modules') -Recurse }
if (-not $taskDataExists) {
    $null = New-Item -ItemType Directory -Path $taskData
    [ordered]@{ schemaVersion = 1; project = $script:CnccId; createdAt = (Get-Date).ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskData '.cncc-data.json') -Encoding UTF8
}
if ($taskShortcut) {
    $taskWsh = New-Object -ComObject WScript.Shell
    $taskLink = $taskWsh.CreateShortcut($taskShortcut)
    $taskShortcutDefinition = Get-CnccStartShortcutDefinition $taskInstall
    $taskLink.TargetPath = $taskShortcutDefinition.TargetPath
    $taskLink.Arguments = $taskShortcutDefinition.Arguments
    $taskLink.WorkingDirectory = $taskShortcutDefinition.WorkingDirectory
    $taskLink.Description = 'Codex Nested Conversations - independent runtime enhancement'
    $taskLink.WindowStyle = 7
    $taskLink.Save()
}
$taskMarker.state = 'installed'
$taskMarker | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $taskMarkerPath -Encoding UTF8
'Installed. The official app was not started. Use the dedicated shortcut when ready.'
} catch {
    $taskMarker.state = 'install_failed'
    $taskMarker | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $taskMarkerPath -Encoding UTF8 -ErrorAction SilentlyContinue
    throw ('Installation stopped. The marked partial install can be removed with scripts/uninstall.ps1 -InstallDir "' + $taskInstall + '". ' + $_.Exception.Message)
}
