[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$taskRepo = Split-Path -Parent $PSScriptRoot
$taskScripts = Join-Path $taskRepo 'scripts'
. (Join-Path $taskScripts 'enable-autoload.ps1')
$taskAssertions = 0
function Assert-Registration([bool]$Value, [string]$Message) { if (-not $Value) { throw $Message }; $script:taskAssertions++ }
function Hash-RegistrationFile([string]$LiteralPath) {
    if (-not (Test-Path -LiteralPath $LiteralPath -PathType Leaf)) { return 'absent' }
    (Get-FileHash -LiteralPath $LiteralPath -Algorithm SHA256).Hash
}
function Invoke-FixtureCli($Context, [string[]]$CliArguments) {
    $taskResponse = Invoke-CnccAutoloadCli -Context $Context -Arguments $CliArguments
    if ($taskResponse.ExitCode -ne 0) { throw 'An isolated official CLI fixture command failed.' }
    $taskResponse
}
function Assert-FixtureRefused([scriptblock]$Action, [string]$Message) {
    $taskRefused = $false
    try { $null = & $Action } catch { $taskRefused = $true }
    Assert-Registration $taskRefused $Message
}
$taskNode = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$taskPythonCommand = (Get-Command python.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$taskPython = (& $taskPythonCommand -c 'import sys; print(sys.executable)').Trim()
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $taskPython -PathType Leaf)) { throw 'A real Python executable is required for the isolated fixture.' }
$taskFormalHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$taskFormalConfig = Join-Path $taskFormalHome 'config.toml'
$taskFormalHash = Hash-RegistrationFile $taskFormalConfig
$taskEnvironmentBefore = $env:CODEX_HOME
$taskBase = Assert-CnccSafePath (Join-Path ([IO.Path]::GetTempPath()) ('cncc-registration-test-' + [Guid]::NewGuid().ToString('N')))
if (-not (Test-CnccInside $taskBase ([IO.Path]::GetTempPath())) -or (Test-Path -LiteralPath $taskBase)) { throw 'Unsafe disposable test location.' }
$null = New-Item -ItemType Directory -Path $taskBase
Set-Content -LiteralPath (Join-Path $taskBase '.cncc-registration-test-owner') -Value $script:CnccId -Encoding UTF8
$taskInstall = Join-Path $taskBase 'installed with spaces'
$taskData = Join-Path $taskBase ('data ' + [char]0x6D4B + [char]0x8BD5)
$taskHome = Join-Path $taskBase 'isolated-codex-home'
$taskProfile = Join-Path $taskBase 'unlogged-profile'
$null = New-Item -ItemType Directory -Path (Join-Path $taskInstall 'app'), $taskData, $taskHome, $taskProfile
$taskRuntime = [ordered]@{files=@('Start-NestedConversations.ps1','Stop-NestedConversations.ps1','enhance-current.cjs','autoload-bootstrap.cjs');startScript='Start-NestedConversations.ps1';stopScript='Stop-NestedConversations.ps1';companionScript='enhance-current.cjs'}
foreach ($taskFile in $taskRuntime.files) { Set-Content -LiteralPath (Join-Path (Join-Path $taskInstall 'app') $taskFile) -Value '// inert fixture; never executed' -Encoding UTF8 }
$taskMarker = [ordered]@{schemaVersion=1;project=$script:CnccId;state='installed';installDir=$taskInstall;dataDir=$taskData;node=$taskNode;python=$taskPython;runtime=$taskRuntime}
$taskMarkerPath = Join-Path $taskInstall '.cncc-install.json'
$taskMarker | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $taskMarkerPath -Encoding UTF8
[ordered]@{schemaVersion=1;project=$script:CnccId} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskData '.cncc-data.json') -Encoding UTF8
$taskToml = @'
# Preserve this unrelated fixture comment.
model = "fixture-model-unchanged"
model_reasoning_effort = "low"

[mcp_servers.keep_fixture]
command = "fixture-command-never-executed"
args = ["retain-this"]

[mcp_servers.keep_fixture.env]
PRIVATE_FIXTURE_VALUE = "dummy-not-a-real-credential"
'@
[IO.File]::WriteAllText((Join-Path $taskHome 'config.toml'), $taskToml, (New-Object Text.UTF8Encoding($false)))
$taskEnable = Join-Path $taskScripts 'enable-autoload.ps1'
$taskDisable = Join-Path $taskScripts 'disable-autoload.ps1'
$taskConfigPath = Join-Path $taskData 'autoload-config.json'
$taskContext = Initialize-CnccAutoloadRegistration $taskInstall $taskHome $taskProfile
try {
    $taskHash = Hash-RegistrationFile (Join-Path $taskHome 'config.toml')
    & $taskEnable -InstallDir $taskInstall -CodexHome $taskHome -ProfileDir $taskProfile -WhatIf
    & $taskDisable -InstallDir $taskInstall -CodexHome $taskHome -ProfileDir $taskProfile -WhatIf
    Assert-Registration ((Hash-RegistrationFile (Join-Path $taskHome 'config.toml')) -eq $taskHash) 'WhatIf modified the isolated global config.'
    Assert-Registration (-not (Test-Path -LiteralPath $taskConfigPath)) 'WhatIf created an autoload config.'
    Assert-Registration (-not (Test-Path -LiteralPath (Join-Path $taskData 'autoload-backups'))) 'WhatIf created private backups.'
    Assert-Registration ($env:CODEX_HOME -ceq $taskEnvironmentBefore) 'WhatIf changed the calling shell CODEX_HOME.'

    # Removing an absent registration must not invent a configuration or backup.
    & $taskDisable -InstallDir $taskInstall -CodexHome $taskHome -ProfileDir $taskProfile
    Assert-Registration ((Hash-RegistrationFile (Join-Path $taskHome 'config.toml')) -eq $taskHash) 'Missing-entry disable changed global settings.'
    Assert-Registration (-not (Test-Path -LiteralPath $taskConfigPath)) 'Missing-entry disable created project settings.'

    $taskKeepBefore = (Invoke-FixtureCli -Context $taskContext -CliArguments @('mcp','get','keep_fixture','--json')).Stdout
    & $taskEnable -InstallDir $taskInstall -CodexHome $taskHome -ProfileDir $taskProfile
    $taskEntry = Get-CnccAutoloadEntry $taskContext
    Assert-Registration (Test-CnccAutoloadEntryIdentity $taskContext $taskEntry) 'Official CLI readback differs from the exact project identity.'
    Assert-Registration $taskEntry.enabled 'The registered MCP server is disabled.'
    $taskConfig = Read-CnccAutoloadJson $taskConfigPath
    Assert-Registration $taskConfig.enabled 'Enabled was not recorded after CLI readback.'
    Assert-Registration ($taskConfig.registrationState -eq 'enabled') 'Registration state is not enabled.'
    Assert-Registration ($taskConfig.codexHome -eq $taskHome) 'The fixture registered against a different CODEX_HOME.'
    Assert-Registration ($taskConfig.profileDir -eq $taskProfile) 'The fixture recorded another profile.'
    Assert-Registration ($taskEntry.transport.args.Count -eq 1 -and $taskEntry.transport.args[0] -eq (Join-Path $taskInstall 'app\autoload-bootstrap.cjs')) 'Spaced script arguments were not preserved.'
    Assert-Registration ($taskEntry.transport.env.CNCC_AUTOLOAD_CONFIG -eq $taskConfigPath) 'Unicode/spaced environment value was not preserved.'
    Assert-Registration ((Invoke-FixtureCli -Context $taskContext -CliArguments @('mcp','get','keep_fixture','--json')).Stdout -ceq $taskKeepBefore) 'Another MCP entry changed.'
    $taskAfterEnable = Get-Content -LiteralPath (Join-Path $taskHome 'config.toml') -Raw
    Assert-Registration ($taskAfterEnable.Contains('model = "fixture-model-unchanged"') -and $taskAfterEnable.Contains('model_reasoning_effort = "low"')) 'Unrelated settings changed.'
    Assert-Registration ($taskAfterEnable.Contains('# Preserve this unrelated fixture comment.')) 'Unrelated TOML comment was lost.'
    $taskBackups = @(Get-ChildItem -LiteralPath (Join-Path $taskData 'autoload-backups') -Filter '*.toml' -File)
    Assert-Registration ($taskBackups.Count -eq 1) 'Enable did not take exactly one pre-change backup.'
    Assert-Registration ((Hash-RegistrationFile $taskBackups[0].FullName) -eq $taskHash) 'The backup does not preserve the exact original bytes.'
    Assert-Registration (Get-Acl -LiteralPath (Join-Path $taskData 'autoload-backups')).AreAccessRulesProtected 'Private backups still inherit the parent ACL.'

    $taskEnabledHash = Hash-RegistrationFile (Join-Path $taskHome 'config.toml')
    $taskConfigHash = Hash-RegistrationFile $taskConfigPath
    & $taskEnable -InstallDir $taskInstall -CodexHome $taskHome -ProfileDir $taskProfile
    Assert-Registration ((Hash-RegistrationFile (Join-Path $taskHome 'config.toml')) -eq $taskEnabledHash) 'Idempotent enable rewrote global settings.'
    Assert-Registration ((Hash-RegistrationFile $taskConfigPath) -eq $taskConfigHash) 'Idempotent enable rewrote project settings.'
    Assert-Registration (@(Get-ChildItem -LiteralPath (Join-Path $taskData 'autoload-backups') -Filter '*.toml' -File).Count -eq 1) 'Idempotent enable created an unnecessary backup.'
    & $taskDisable -InstallDir $taskInstall -CodexHome $taskHome -ProfileDir $taskProfile -WhatIf
    Assert-Registration ((Hash-RegistrationFile (Join-Path $taskHome 'config.toml')) -eq $taskEnabledHash) 'Disable WhatIf removed the active registration.'
    Assert-Registration ((Hash-RegistrationFile $taskConfigPath) -eq $taskConfigHash) 'Disable WhatIf changed enabled state.'

    $taskDisabledByUi = (Get-Content -LiteralPath (Join-Path $taskHome 'config.toml') -Raw -Encoding UTF8).Replace('[mcp_servers.codex_nested_autoload]', "[mcp_servers.codex_nested_autoload]`nenabled = false")
    [IO.File]::WriteAllText((Join-Path $taskHome 'config.toml'), $taskDisabledByUi, (New-Object Text.UTF8Encoding($false)))
    Assert-Registration (-not (Get-CnccAutoloadEntry $taskContext).enabled) 'The disabled-owned-entry fixture was not prepared.'
    & $taskEnable -InstallDir $taskInstall -CodexHome $taskHome -ProfileDir $taskProfile
    Assert-Registration (Get-CnccAutoloadEntry $taskContext).enabled 'Enable did not restore an exact owned disabled entry.'
    Assert-Registration ((Invoke-FixtureCli -Context $taskContext -CliArguments @('mcp','get','keep_fixture','--json')).Stdout -ceq $taskKeepBefore) 'Re-enabling changed another MCP entry.'
    Assert-Registration (@(Get-ChildItem -LiteralPath (Join-Path $taskData 'autoload-backups') -Filter '*.toml' -File).Count -eq 2) 'Re-enabling did not back up the disabled entry.'

    & $taskDisable -InstallDir $taskInstall -CodexHome $taskHome -ProfileDir $taskProfile
    Assert-Registration ($null -eq (Get-CnccAutoloadEntry $taskContext)) 'Owned entry remains after disable.'
    $taskConfig = Read-CnccAutoloadJson $taskConfigPath
    Assert-Registration (-not $taskConfig.enabled -and $taskConfig.registrationState -eq 'disabled') 'Disabled state was not recorded after readback.'
    Assert-Registration ((Invoke-FixtureCli -Context $taskContext -CliArguments @('mcp','get','keep_fixture','--json')).Stdout -ceq $taskKeepBefore) 'Disable changed another MCP entry.'
    Assert-Registration (@(Get-ChildItem -LiteralPath (Join-Path $taskData 'autoload-backups') -Filter '*.toml' -File).Count -eq 3) 'Disable did not back up the pre-removal global config.'
    $taskDisabledHash = Hash-RegistrationFile (Join-Path $taskHome 'config.toml')
    $taskDisabledConfigHash = Hash-RegistrationFile $taskConfigPath
    & $taskDisable -InstallDir $taskInstall -CodexHome $taskHome -ProfileDir $taskProfile
    Assert-Registration ((Hash-RegistrationFile (Join-Path $taskHome 'config.toml')) -eq $taskDisabledHash) 'Repeated disable rewrote global settings.'
    Assert-Registration ((Hash-RegistrationFile $taskConfigPath) -eq $taskDisabledConfigHash) 'Repeated disable rewrote project state.'

    # A foreign same-name entry must be rejected in both directions without writes.
    foreach ($taskForeignArgs in @(
        @('mcp','add','codex_nested_autoload','--',$taskPython,'foreign-fixture.py'),
        @('mcp','add','codex_nested_autoload','--env',('CNCC_AUTOLOAD_CONFIG=' + $taskConfigPath),'--env','PRIVATE_FIXTURE_VALUE=do-not-print-me','--',$taskNode,(Join-Path $taskInstall 'app\autoload-bootstrap.cjs'))
    )) {
        $null = Invoke-FixtureCli -Context $taskContext -CliArguments $taskForeignArgs
        $taskForeignHash = Hash-RegistrationFile (Join-Path $taskHome 'config.toml')
        $taskForeignDataHash = Hash-RegistrationFile $taskConfigPath
        $taskBackupCount = @(Get-ChildItem -LiteralPath (Join-Path $taskData 'autoload-backups') -File).Count
        Assert-FixtureRefused { & $taskEnable -InstallDir $taskInstall -CodexHome $taskHome -ProfileDir $taskProfile } 'Enable accepted a foreign same-name entry.'
        Assert-FixtureRefused { & $taskDisable -InstallDir $taskInstall -CodexHome $taskHome -ProfileDir $taskProfile } 'Disable removed a foreign same-name entry.'
        Assert-Registration ((Hash-RegistrationFile (Join-Path $taskHome 'config.toml')) -eq $taskForeignHash) 'A refused operation changed the foreign registration.'
        Assert-Registration ((Hash-RegistrationFile $taskConfigPath) -eq $taskForeignDataHash) 'A refused operation changed project state.'
        Assert-Registration (@(Get-ChildItem -LiteralPath (Join-Path $taskData 'autoload-backups') -File).Count -eq $taskBackupCount) 'A refused operation wrote a backup.'
        $null = Invoke-FixtureCli -Context $taskContext -CliArguments @('mcp','remove','codex_nested_autoload')
    }

    $taskBeforeMalformed = Hash-RegistrationFile $taskConfigPath
    $taskValidToml = [IO.File]::ReadAllBytes((Join-Path $taskHome 'config.toml'))
    [IO.File]::WriteAllText((Join-Path $taskHome 'config.toml'), '[invalid fixture', (New-Object Text.UTF8Encoding($false)))
    $taskMalformedHash = Hash-RegistrationFile (Join-Path $taskHome 'config.toml')
    Assert-FixtureRefused { & $taskEnable -InstallDir $taskInstall -CodexHome $taskHome -ProfileDir $taskProfile } 'Malformed global config was overwritten by enable.'
    Assert-FixtureRefused { & $taskDisable -InstallDir $taskInstall -CodexHome $taskHome -ProfileDir $taskProfile } 'Malformed global config was overwritten by disable.'
    Assert-Registration ((Hash-RegistrationFile (Join-Path $taskHome 'config.toml')) -eq $taskMalformedHash) 'Failed CLI inspection changed malformed global config.'
    Assert-Registration ((Hash-RegistrationFile $taskConfigPath) -eq $taskBeforeMalformed) 'Failed CLI inspection changed project state.'
    [IO.File]::WriteAllBytes((Join-Path $taskHome 'config.toml'), $taskValidToml)
    $taskBeforeProfile = Hash-RegistrationFile (Join-Path $taskHome 'config.toml')
    Assert-FixtureRefused { & $taskEnable -InstallDir $taskInstall -CodexHome $taskHome -ProfileDir (Join-Path $taskBase 'different-profile') } 'An explicit different profile silently reused the registration.'
    Assert-Registration ((Hash-RegistrationFile (Join-Path $taskHome 'config.toml')) -eq $taskBeforeProfile) 'Different-profile refusal changed the global config.'
    Assert-Registration ((Hash-RegistrationFile $taskConfigPath) -eq $taskBeforeMalformed) 'Different-profile refusal changed project state.'

    $taskBeforeInvalid = Hash-RegistrationFile (Join-Path $taskHome 'config.toml')
    $taskBeforeInvalidData = Hash-RegistrationFile $taskConfigPath
    $taskMarker.state = 'installing'
    $taskMarker | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $taskMarkerPath -Encoding UTF8
    Assert-FixtureRefused { & $taskEnable -InstallDir $taskInstall -CodexHome $taskHome -ProfileDir $taskProfile } 'An incomplete install registered automatic loading.'
    Assert-FixtureRefused { & $taskDisable -InstallDir $taskInstall -CodexHome $taskHome -ProfileDir $taskProfile } 'An incomplete install changed registration.'
    Assert-Registration ((Hash-RegistrationFile (Join-Path $taskHome 'config.toml')) -eq $taskBeforeInvalid) 'Invalid installation changed global config.'
    Assert-Registration ((Hash-RegistrationFile $taskConfigPath) -eq $taskBeforeInvalidData) 'Invalid installation changed project config.'
    Assert-Registration ($env:CODEX_HOME -ceq $taskEnvironmentBefore) 'Child CLI configuration leaked into the calling shell.'
    Assert-Registration ((Hash-RegistrationFile $taskFormalConfig) -eq $taskFormalHash) 'The real Codex configuration was modified.'
    Assert-Registration ((Get-Content -LiteralPath (Join-Path $taskBase '.cncc-registration-test-owner') -Raw).Trim() -eq $script:CnccId) 'The disposable fixture lost its ownership marker.'
    Send-CnccToRecycleBin $taskBase
    ('Passed ' + $taskAssertions + ' autoload registration assertions using the official CLI and an isolated CODEX_HOME. No official app was started.')
} catch {
    Write-Output ('Test stopped; its disposable fixture was retained: ' + $taskBase)
    throw
}
