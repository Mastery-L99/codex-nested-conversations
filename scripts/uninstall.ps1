[CmdletBinding(SupportsShouldProcess = $true)]
param([string]$InstallDir)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\Common.ps1')
if (-not $InstallDir) { $InstallDir = Get-CnccDefaultInstallDir }
$taskRoot = Assert-CnccSafePath $InstallDir
$taskInstall = Read-CnccInstall $taskRoot
$taskData = Assert-CnccSafePath $taskInstall.dataDir
if ((Test-CnccInside $taskRoot $taskData) -or (Test-CnccInside $taskData $taskRoot)) { throw 'Installation data overlaps the application directory. Stopped.' }
$taskCompanion = Get-CnccFullPath (Join-Path (Join-Path $taskRoot 'app') $taskInstall.runtime.companionScript)
if (-not (Test-CnccInside $taskCompanion (Join-Path $taskRoot 'app'))) { throw 'Invalid companion path.' }
$taskProcessPattern = '(?i)(?:^|[\s"])' + [Regex]::Escape($taskCompanion) + '(?=[\s"]|$)'
function Get-ProjectCompanions { @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match $taskProcessPattern }) }
$taskShortcut = $null
if ($taskInstall.shortcut) {
    $taskExpected = Join-Path ([Environment]::GetFolderPath('Desktop')) $script:CnccShortcutName
    if (-not (Get-CnccFullPath $taskInstall.shortcut).Equals((Get-CnccFullPath $taskExpected), [StringComparison]::OrdinalIgnoreCase)) { throw 'The recorded shortcut is outside the project-owned location.' }
    $taskShortcut = Assert-CnccSafePath $taskInstall.shortcut
    if (Test-Path -LiteralPath $taskShortcut) {
        $taskLink = (New-Object -ComObject WScript.Shell).CreateShortcut($taskShortcut)
        if (-not (Test-CnccStartShortcutIdentity -InstallDir $taskInstall.installDir -TargetPath $taskLink.TargetPath -Arguments $taskLink.Arguments)) { throw 'The dedicated shortcut was changed. It was preserved.' }
    }
}
[pscustomobject]@{ RecycleProgramDirectory = $taskRoot; RecycleShortcut = $taskShortcut; PreservedDataDirectory = $taskData; CompanionCount = @(Get-ProjectCompanions).Count } | Format-List
if (-not $PSCmdlet.ShouldProcess($taskRoot, 'Stop this enhancement and recycle its program directory; retain project data')) { return }
if (@(Get-ProjectCompanions).Count -gt 0) {
    & (Join-Path $taskRoot 'scripts\Stop.ps1')
    $taskDeadline = (Get-Date).AddSeconds(10)
    while (@(Get-ProjectCompanions).Count -gt 0 -and (Get-Date) -lt $taskDeadline) { Start-Sleep -Milliseconds 250 }
    if (@(Get-ProjectCompanions).Count -gt 0) { throw 'The companion is still running. Uninstall stopped without deleting the program.' }
}
if ($taskShortcut -and (Test-Path -LiteralPath $taskShortcut)) { Send-CnccToRecycleBin $taskShortcut }
Send-CnccToRecycleBin $taskRoot
'Uninstalled to the Recycle Bin. Project data was retained. Restart the official app normally to close its temporary debug endpoint.'
