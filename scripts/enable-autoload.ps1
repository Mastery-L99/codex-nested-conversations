[CmdletBinding(SupportsShouldProcess = $true)]
param([string]$InstallDir, [string]$CodexHome, [string]$ProfileDir)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\Common.ps1')
$script:CnccAutoloadName = 'codex_nested_autoload'

function Get-CnccAutoloadField($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    $taskProperty = $Object.PSObject.Properties[$Name]
    if ($null -ne $taskProperty) { return $taskProperty.Value }
    return $null
}

function Assert-CnccAutoloadNoLinks([string]$LiteralPath) {
    $taskCursor = Get-CnccFullPath $LiteralPath
    while ($taskCursor) {
        if (Test-Path -LiteralPath $taskCursor) {
            if (((Get-Item -LiteralPath $taskCursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Autoload registration refuses reparse paths.' }
        }
        $taskParent = Split-Path -Parent $taskCursor
        if ($taskParent -eq $taskCursor) { break }
        $taskCursor = $taskParent
    }
}

function Read-CnccAutoloadJson([string]$LiteralPath) {
    Assert-CnccAutoloadNoLinks $LiteralPath
    $taskFile = Get-Item -LiteralPath $LiteralPath -Force
    if ($taskFile.PSIsContainer -or $taskFile.Length -gt 65536) { throw 'Invalid autoload identity file.' }
    try { Get-Content -LiteralPath $LiteralPath -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { throw 'Autoload identity JSON could not be read.' }
}

function Initialize-CnccAutoloadRegistration([string]$InstallPath, [string]$HomePath, [string]$ProfilePath) {
    if (-not $InstallPath) { $InstallPath = Get-CnccDefaultInstallDir }
    $taskRoot = Get-CnccFullPath $InstallPath
    $taskInstalled = Read-CnccInstall $taskRoot
    if ($taskInstalled.state -ne 'installed') { throw 'Only a completed project installation can register automatic loading.' }
    $taskData = Assert-CnccSafePath $taskInstalled.dataDir
    $taskIdentity = Read-CnccAutoloadJson (Join-Path $taskData '.cncc-data.json')
    if ($taskIdentity.schemaVersion -ne 1 -or $taskIdentity.project -ne $script:CnccId) { throw 'The runtime data identity does not match this project.' }
    $taskScript = Join-Path (Join-Path $taskRoot 'app') 'autoload-bootstrap.cjs'
    if ($taskInstalled.runtime.files -notcontains 'autoload-bootstrap.cjs' -or -not (Test-Path -LiteralPath $taskScript -PathType Leaf)) { throw 'This installation does not include the autoload bootstrap.' }
    Assert-CnccAutoloadNoLinks $taskScript
    foreach ($taskExecutable in @($taskInstalled.node, $taskInstalled.python)) {
        if (-not [IO.Path]::IsPathRooted($taskExecutable) -or -not (Test-Path -LiteralPath $taskExecutable -PathType Leaf)) { throw 'Installed runtime dependencies are unavailable.' }
        Assert-CnccAutoloadNoLinks $taskExecutable
    }
    if ([IO.Path]::GetFileName($taskInstalled.node) -notmatch '^node\.exe$' -or [IO.Path]::GetFileName($taskInstalled.python) -notmatch '^(python(?:3(?:\.\d+)?)?|py)\.exe$') { throw 'The installed Node/Python executable identities do not match.' }
    if (-not $HomePath) { $HomePath = $env:CODEX_HOME }
    if (-not $HomePath) { $HomePath = Join-Path $env:USERPROFILE '.codex' }
    if (-not [IO.Path]::IsPathRooted($HomePath)) { throw 'CODEX_HOME must be an absolute existing directory.' }
    $taskHome = Get-CnccFullPath $HomePath
    if (-not (Test-Path -LiteralPath $taskHome -PathType Container) -or $taskHome -eq [IO.Path]::GetPathRoot($taskHome).TrimEnd('\') -or $taskHome -eq (Get-CnccFullPath $env:USERPROFILE)) { throw 'A dedicated existing CODEX_HOME is required.' }
    foreach ($taskProtected in @($env:WINDIR, $env:ProgramFiles, ${env:ProgramFiles(x86)}, (Join-Path $env:LOCALAPPDATA 'Packages'))) {
        if ($taskProtected -and (Test-CnccInside $taskHome $taskProtected)) { throw 'CODEX_HOME cannot be a system or official package directory.' }
    }
    Assert-CnccAutoloadNoLinks $taskHome
    if (Test-Path -LiteralPath (Join-Path $taskHome 'config.toml')) { Assert-CnccAutoloadNoLinks (Join-Path $taskHome 'config.toml') }
    if (-not $ProfilePath) { $ProfilePath = Join-Path $env:APPDATA 'Codex\web\Codex' }
    if (-not [IO.Path]::IsPathRooted($ProfilePath)) { throw 'The official profile location must be absolute.' }
    $taskProfile = Get-CnccFullPath $ProfilePath
    $taskConfigPath = Join-Path $taskData 'autoload-config.json'
    $taskExistingConfig = $null
    if (Test-Path -LiteralPath $taskConfigPath) {
        $taskExistingConfig = Read-CnccAutoloadJson $taskConfigPath
        foreach ($taskKey in @('installDir', 'dataDir', 'codexHome', 'profileDir')) {
            if (-not [IO.Path]::IsPathRooted([string](Get-CnccAutoloadField $taskExistingConfig $taskKey))) { throw 'Existing autoload registration paths are not absolute; they were preserved.' }
        }
        if ((Get-CnccAutoloadField $taskExistingConfig 'schemaVersion') -ne 1 -or (Get-CnccAutoloadField $taskExistingConfig 'project') -ne $script:CnccId -or
            (Get-CnccAutoloadField $taskExistingConfig 'enabled') -isnot [bool] -or
            (Get-CnccFullPath ([string](Get-CnccAutoloadField $taskExistingConfig 'installDir'))) -ne $taskRoot -or
            (Get-CnccFullPath ([string](Get-CnccAutoloadField $taskExistingConfig 'dataDir'))) -ne $taskData -or
            (Get-CnccFullPath ([string](Get-CnccAutoloadField $taskExistingConfig 'codexHome'))) -ne $taskHome -or
            (Get-CnccFullPath ([string](Get-CnccAutoloadField $taskExistingConfig 'profileDir'))) -ne $taskProfile) { throw 'Existing autoload data belongs to a different registration; it was preserved.' }
    }
    $taskPackages = @(Get-AppxPackage -Name OpenAI.Codex)
    if ($taskPackages.Count -ne 1 -or $taskPackages[0].PackageFamilyName -cne 'OpenAI.Codex_2p2nqsd0c76g0') { throw 'The installed official Codex package could not be identified uniquely.' }
    $taskCli = Join-Path $taskPackages[0].InstallLocation 'app\resources\codex.exe'
    if (-not (Test-Path -LiteralPath $taskCli -PathType Leaf)) { throw 'The official MCP configuration CLI is unavailable.' }
    [pscustomobject]@{ Install = $taskInstalled; InstallDir = $taskRoot; DataDir = $taskData; ScriptPath = $taskScript; ConfigPath = $taskConfigPath; CodexHome = $taskHome; ProfileDir = $taskProfile; Cli = $taskCli; ExistingConfig = $taskExistingConfig }
}

function ConvertTo-CnccAutoloadArgument([string]$Value) {
    $taskBuilder = New-Object Text.StringBuilder
    $null = $taskBuilder.Append('"')
    $taskSlashes = 0
    foreach ($taskCharacter in $Value.ToCharArray()) {
        if ($taskCharacter -eq '\') { $taskSlashes++; continue }
        if ($taskCharacter -eq '"') {
            $null = $taskBuilder.Append([char]'\', 2 * $taskSlashes + 1).Append('"')
        } else {
            $null = $taskBuilder.Append([char]'\', $taskSlashes).Append($taskCharacter)
        }
        $taskSlashes = 0
    }
    $null = $taskBuilder.Append([char]'\', 2 * $taskSlashes).Append('"')
    $taskBuilder.ToString()
}

function Invoke-CnccAutoloadCli($Context, [string[]]$Arguments) {
    $taskStart = New-Object Diagnostics.ProcessStartInfo
    $taskStart.FileName = $Context.Cli
    $taskStart.Arguments = (@($Arguments | ForEach-Object { ConvertTo-CnccAutoloadArgument $_ }) -join ' ')
    $taskStart.UseShellExecute = $false
    $taskStart.CreateNoWindow = $true
    $taskStart.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $taskStart.RedirectStandardOutput = $true
    $taskStart.RedirectStandardError = $true
    $taskStart.StandardOutputEncoding = [Text.Encoding]::UTF8
    $taskStart.StandardErrorEncoding = [Text.Encoding]::UTF8
    # This environment belongs only to the CLI child, never the calling shell.
    $taskStart.EnvironmentVariables['CODEX_HOME'] = $Context.CodexHome
    $taskProcess = New-Object Diagnostics.Process
    $taskProcess.StartInfo = $taskStart
    try {
        $null = $taskProcess.Start()
        $taskOut = $taskProcess.StandardOutput.ReadToEndAsync()
        $taskError = $taskProcess.StandardError.ReadToEndAsync()
        if (-not $taskProcess.WaitForExit(15000)) { $taskProcess.Kill(); throw 'The MCP configuration command timed out.' }
        [pscustomobject]@{ ExitCode = $taskProcess.ExitCode; Stdout = $taskOut.Result; Stderr = $taskError.Result }
    } finally { $taskProcess.Dispose() }
}

function Get-CnccAutoloadEntry($Context) {
    $taskResult = Invoke-CnccAutoloadCli -Context $Context -Arguments @('mcp', 'get', $script:CnccAutoloadName, '--json')
    if ($taskResult.ExitCode -eq 1 -and $taskResult.Stderr -match "(?m)^Error: No MCP server named 'codex_nested_autoload' found\.\s*$") { return $null }
    if ($taskResult.ExitCode -ne 0) { throw 'The MCP registration could not be inspected. No registration was changed.' }
    try { $taskResult.Stdout | ConvertFrom-Json } catch { throw 'The MCP registration response was invalid.' }
}

function Test-CnccAutoloadEntryIdentity($Context, $Entry) {
    if ($null -eq $Entry -or (Get-CnccAutoloadField $Entry 'name') -cne $script:CnccAutoloadName -or (Get-CnccAutoloadField $Entry 'enabled') -isnot [bool]) { return $false }
    $taskTransport = Get-CnccAutoloadField $Entry 'transport'
    if ((Get-CnccAutoloadField $taskTransport 'type') -cne 'stdio') { return $false }
    $taskCommand = [string](Get-CnccAutoloadField $taskTransport 'command')
    $taskArgs = @(Get-CnccAutoloadField $taskTransport 'args')
    if (-not [IO.Path]::IsPathRooted($taskCommand) -or (Get-CnccFullPath $taskCommand) -ne (Get-CnccFullPath $Context.Install.node) -or
        $taskArgs.Count -ne 1 -or $taskArgs[0] -isnot [string] -or -not [IO.Path]::IsPathRooted($taskArgs[0]) -or (Get-CnccFullPath $taskArgs[0]) -ne $Context.ScriptPath) { return $false }
    $taskEnv = Get-CnccAutoloadField $taskTransport 'env'
    if ($null -eq $taskEnv) { return $false }
    $taskEnvProperties = @($taskEnv.PSObject.Properties)
    if ($taskEnvProperties.Count -ne 1 -or $taskEnvProperties[0].Name -cne 'CNCC_AUTOLOAD_CONFIG' -or
        $taskEnvProperties[0].Value -isnot [string] -or -not [IO.Path]::IsPathRooted($taskEnvProperties[0].Value) -or (Get-CnccFullPath $taskEnvProperties[0].Value) -ne $Context.ConfigPath) { return $false }
    if (@(Get-CnccAutoloadField $taskTransport 'env_vars').Count -ne 0 -or $null -ne (Get-CnccAutoloadField $taskTransport 'cwd')) { return $false }
    foreach ($taskKey in @('disabled_reason', 'enabled_tools', 'disabled_tools', 'startup_timeout_sec', 'tool_timeout_sec')) {
        if ($null -ne (Get-CnccAutoloadField $Entry $taskKey)) { return $false }
    }
    return $true
}

function New-CnccAutoloadConfig($Context, [bool]$Enabled, [string]$RegistrationState) {
    [ordered]@{ schemaVersion = 1; project = $script:CnccId; enabled = $Enabled; installDir = $Context.InstallDir; dataDir = $Context.DataDir; codexHome = $Context.CodexHome; profileDir = $Context.ProfileDir; registeredServer = $script:CnccAutoloadName; registrationState = $RegistrationState; updatedAt = [DateTime]::UtcNow.ToString('o') }
}

function Write-CnccAutoloadConfig($Context, [bool]$Enabled, [string]$RegistrationState) {
    $taskTemporary = Join-Path $Context.DataDir ('.autoload-config-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    $taskJson = New-CnccAutoloadConfig $Context $Enabled $RegistrationState | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($taskTemporary, $taskJson, (New-Object Text.UTF8Encoding($true)))
    Move-Item -LiteralPath $taskTemporary -Destination $Context.ConfigPath -Force
}

function Backup-CnccAutoloadGlobalConfig($Context) {
    $taskBackupDir = Assert-CnccSafePath (Join-Path $Context.DataDir 'autoload-backups')
    $taskMarkerPath = Join-Path $taskBackupDir '.cncc-autoload-backup.json'
    if (Test-Path -LiteralPath $taskBackupDir) {
        $taskMarker = Read-CnccAutoloadJson $taskMarkerPath
        if ($taskMarker.schemaVersion -ne 1 -or $taskMarker.project -ne $script:CnccId) { throw 'The private backup directory has a different owner.' }
    } else {
        $null = New-Item -ItemType Directory -Path $taskBackupDir
        $taskAcl = Get-Acl -LiteralPath $taskBackupDir
        $taskAcl.SetAccessRuleProtection($true, $false)
        foreach ($taskSid in @([Security.Principal.WindowsIdentity]::GetCurrent().User, (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')), (New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))) {
            $taskRule = New-Object Security.AccessControl.FileSystemAccessRule($taskSid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit', [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
            $null = $taskAcl.AddAccessRule($taskRule)
        }
        Set-Acl -LiteralPath $taskBackupDir -AclObject $taskAcl
        [ordered]@{schemaVersion=1;project=$script:CnccId} | ConvertTo-Json | Set-Content -LiteralPath $taskMarkerPath -Encoding UTF8
    }
    $taskOriginal = Join-Path $Context.CodexHome 'config.toml'
    $taskName = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [Guid]::NewGuid().ToString('N')
    if (Test-Path -LiteralPath $taskOriginal -PathType Leaf) {
        Copy-Item -LiteralPath $taskOriginal -Destination (Join-Path $taskBackupDir ($taskName + '.toml'))
    } else {
        [ordered]@{schemaVersion=1;project=$script:CnccId;originalConfigExisted=$false} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskBackupDir ($taskName + '.json')) -Encoding UTF8
    }
}

function Enter-CnccAutoloadRegistrationMutex($Context) {
    $taskHash = [Security.Cryptography.SHA256]::Create()
    try { $taskKey = [BitConverter]::ToString($taskHash.ComputeHash([Text.Encoding]::UTF8.GetBytes(($script:CnccAutoloadName + '|' + $Context.CodexHome).ToLowerInvariant()))).Replace('-', '') } finally { $taskHash.Dispose() }
    $taskMutex = New-Object Threading.Mutex($false, ('Local\CnccRegistration-' + $taskKey.Substring(0, 32)))
    $taskHeld = $false
    try { $taskHeld = $taskMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $taskHeld = $true }
    if (-not $taskHeld) { $taskMutex.Dispose(); throw 'Another autoload registration operation is in progress.' }
    $taskMutex
}

# disable-autoload.ps1 imports the helpers without running enable.
if ($MyInvocation.InvocationName -eq '.') { return }
$taskContext = Initialize-CnccAutoloadRegistration $InstallDir $CodexHome $ProfileDir
if (-not $PSCmdlet.ShouldProcess($script:CnccAutoloadName, 'Register automatic loading for this installation')) { return }
$taskMutex = Enter-CnccAutoloadRegistrationMutex $taskContext
try {
    $taskEntry = Get-CnccAutoloadEntry $taskContext
    if ($null -ne $taskEntry -and -not (Test-CnccAutoloadEntryIdentity $taskContext $taskEntry)) { throw 'A different server already uses codex_nested_autoload. It was preserved.' }
    if ($null -ne $taskEntry -and $taskEntry.enabled -and $null -ne $taskContext.ExistingConfig -and $taskContext.ExistingConfig.enabled) { 'Automatic loading is already registered for this installation.'; return }
    $taskNeedsWrite = $null -eq $taskEntry -or -not $taskEntry.enabled
    if ($taskNeedsWrite) { Backup-CnccAutoloadGlobalConfig $taskContext }
    Write-CnccAutoloadConfig $taskContext $false 'pending'
    try {
        if ($taskNeedsWrite) {
            $taskResult = Invoke-CnccAutoloadCli -Context $taskContext -Arguments @('mcp', 'add', $script:CnccAutoloadName, '--env', ('CNCC_AUTOLOAD_CONFIG=' + $taskContext.ConfigPath), '--', $taskContext.Install.node, $taskContext.ScriptPath)
            if ($taskResult.ExitCode -ne 0) { throw 'The official CLI did not complete the autoload registration.' }
        }
        $taskReadback = Get-CnccAutoloadEntry $taskContext
        if (-not (Test-CnccAutoloadEntryIdentity $taskContext $taskReadback) -or -not $taskReadback.enabled) { throw 'The autoload registration readback did not match this installation.' }
        Write-CnccAutoloadConfig $taskContext $true 'enabled'
    } catch {
        Write-CnccAutoloadConfig $taskContext $false 'failed'
        throw 'Automatic loading was not enabled. The private backup was preserved; run disable-autoload.ps1 before uninstalling.'
    }
    'Automatic loading registered. No application or Windows startup setting was changed.'
} finally { $taskMutex.ReleaseMutex(); $taskMutex.Dispose() }
