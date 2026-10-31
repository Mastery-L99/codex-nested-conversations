[CmdletBinding(SupportsShouldProcess = $true)]
param([string]$InstallDir, [string]$CodexHome, [string]$ProfileDir)
$ErrorActionPreference = 'Stop'
$taskDisableInstallDir = $InstallDir
$taskDisableCodexHome = $CodexHome
$taskDisableProfileDir = $ProfileDir
$taskDisableCmdlet = $PSCmdlet
. (Join-Path $PSScriptRoot 'enable-autoload.ps1')
$taskContext = Initialize-CnccAutoloadRegistration $taskDisableInstallDir $taskDisableCodexHome $taskDisableProfileDir
if (-not $taskDisableCmdlet.ShouldProcess($script:CnccAutoloadName, 'Remove only this installation automatic-loading registration')) { return }
$taskMutex = Enter-CnccAutoloadRegistrationMutex $taskContext
try {
    $taskEntry = Get-CnccAutoloadEntry $taskContext
    if ($null -ne $taskEntry -and -not (Test-CnccAutoloadEntryIdentity $taskContext $taskEntry)) { throw 'A different server uses codex_nested_autoload. It and the project configuration were preserved.' }
    if ($null -ne $taskEntry) {
        Backup-CnccAutoloadGlobalConfig $taskContext
        $taskResult = Invoke-CnccAutoloadCli -Context $taskContext -Arguments @('mcp', 'remove', $script:CnccAutoloadName)
        if ($taskResult.ExitCode -ne 0) { throw 'The official CLI did not complete removal. The enabled state was preserved.' }
        if ($null -ne (Get-CnccAutoloadEntry $taskContext)) { throw 'The registration still exists after removal. The enabled state was preserved.' }
    }
    if ($null -ne $taskEntry -or $null -ne $taskContext.ExistingConfig) {
        if ($null -ne $taskEntry -or $taskContext.ExistingConfig.enabled -or (Get-CnccAutoloadField $taskContext.ExistingConfig 'registrationState') -ne 'disabled') {
            Write-CnccAutoloadConfig $taskContext $false 'disabled'
        }
    }
    'Automatic loading is unregistered for this installation. The official app was left running.'
} finally { $taskMutex.ReleaseMutex(); $taskMutex.Dispose() }
