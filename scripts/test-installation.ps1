[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\Common.ps1')
$taskRepo = Split-Path -Parent $PSScriptRoot
$taskManifest = Get-CnccRuntimeManifest $taskRepo
$null = Get-CnccDependencies $taskRepo
foreach ($taskFile in $taskManifest.files) {
    if (-not (Test-Path -LiteralPath (Join-Path (Join-Path $taskRepo 'src') $taskFile) -PathType Leaf)) { throw ('Runtime source missing: ' + $taskFile) }
}
$taskBase = Assert-CnccSafePath (Join-Path ([IO.Path]::GetTempPath()) ('cncc-install-test-' + [Guid]::NewGuid().ToString('N')))
if (-not (Test-CnccInside $taskBase ([IO.Path]::GetTempPath())) -or (Test-Path -LiteralPath $taskBase)) { throw 'Unsafe test directory.' }
$null = New-Item -ItemType Directory -Path $taskBase
Set-Content -LiteralPath (Join-Path $taskBase '.cncc-test-owner') -Value $script:CnccId -Encoding UTF8
$taskInstall = Join-Path $taskBase 'program'
$taskData = Join-Path $taskBase 'data'
$taskAssertions = 0
function Assert-Test([bool]$Value, [string]$Message) { if (-not $Value) { throw $Message }; $script:taskAssertions++ }
function Get-TestHash([string]$LiteralPath) {
    $taskStream = [IO.File]::OpenRead($LiteralPath)
    $taskHasher = [Security.Cryptography.SHA256]::Create()
    try { [BitConverter]::ToString($taskHasher.ComputeHash($taskStream)).Replace('-', '') }
    finally { $taskHasher.Dispose(); $taskStream.Dispose() }
}
try {
    # This test never calls the runtime Start/Stop scripts and never creates a shortcut.
    $taskShortcutRoot = Join-Path $taskBase ('shortcut fixture with spaces ' + [char]0x6D4B + [char]0x8BD5)
    $taskDefinition = Get-CnccStartShortcutDefinition $taskShortcutRoot
    $taskExpectedTarget = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $taskScriptPath = Join-Path $taskShortcutRoot 'scripts\Start.ps1'
    $taskExpectedArguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $taskScriptPath + '"'
    $taskLegacyArguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $taskScriptPath + '"'
    Assert-Test ($taskDefinition.TargetPath -eq $taskExpectedTarget) 'The shortcut targets a different executable.'
    Assert-Test ($taskDefinition.Arguments -ceq $taskExpectedArguments) 'The new shortcut is missing its exact hidden-window arguments.'
    Assert-Test ($taskDefinition.WorkingDirectory -eq $taskShortcutRoot) 'The shortcut working directory does not match its installation.'
    Assert-Test (Test-CnccStartShortcutIdentity $taskShortcutRoot $taskExpectedTarget $taskExpectedArguments) 'The current hidden shortcut is not recognized.'
    Assert-Test (Test-CnccStartShortcutIdentity $taskShortcutRoot $taskExpectedTarget $taskLegacyArguments) 'The exact former project shortcut is not recognized.'
    Assert-Test (Test-CnccStartShortcutIdentity $taskShortcutRoot $taskExpectedTarget.ToLowerInvariant() $taskExpectedArguments) 'Executable path casing changed shortcut identity.'
    $taskForeignRoot = Join-Path $taskBase 'different program'
    $taskForeignArguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $taskForeignRoot 'scripts\Start.ps1') + '"'
    Assert-Test (-not (Test-CnccStartShortcutIdentity $taskShortcutRoot $taskExpectedTarget $taskForeignArguments)) 'A shortcut to a different installation was accepted.'
    Assert-Test (-not (Test-CnccStartShortcutIdentity $taskShortcutRoot (Join-Path $taskBase 'other.exe') $taskExpectedArguments)) 'A shortcut to a different executable was accepted.'
    $taskExtraArguments = $taskExpectedArguments + ' -Command extra'
    $taskVisibleArguments = $taskExpectedArguments.Replace('-WindowStyle Hidden', '-WindowStyle Normal')
    $taskIncompleteArguments = '-NoProfile -WindowStyle Hidden -File "' + $taskScriptPath + '"'
    $taskReorderedArguments = '-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File "' + $taskScriptPath + '"'
    Assert-Test (-not (Test-CnccStartShortcutIdentity $taskShortcutRoot $taskExpectedTarget $taskExtraArguments)) 'Additional shortcut commands were accepted.'
    Assert-Test (-not (Test-CnccStartShortcutIdentity $taskShortcutRoot $taskExpectedTarget $taskVisibleArguments)) 'An altered window style was accepted.'
    Assert-Test (-not (Test-CnccStartShortcutIdentity $taskShortcutRoot $taskExpectedTarget $taskIncompleteArguments)) 'A non-project argument set was accepted.'
    Assert-Test (-not (Test-CnccStartShortcutIdentity $taskShortcutRoot $taskExpectedTarget $taskReorderedArguments)) 'Reordered shortcut arguments were accepted.'
    Assert-Test (-not (Test-CnccStartShortcutIdentity $taskShortcutRoot $taskExpectedTarget $null)) 'Empty shortcut arguments were accepted.'
    Assert-Test (-not (Test-CnccStartShortcutIdentity $taskShortcutRoot $null $taskExpectedArguments)) 'An empty shortcut target was accepted.'
    & (Join-Path $PSScriptRoot 'install.ps1') -InstallDir $taskInstall -DataDir $taskData -NoShortcut -WhatIf
    Assert-Test (-not (Test-Path -LiteralPath $taskInstall)) 'Install WhatIf wrote program files.'
    Assert-Test (-not (Test-Path -LiteralPath $taskData)) 'Install WhatIf wrote runtime data.'
    & (Join-Path $PSScriptRoot 'install.ps1') -InstallDir $taskInstall -DataDir $taskData -NoShortcut
    $taskInstalled = Read-CnccInstall $taskInstall
    Assert-Test ($taskInstalled.state -eq 'installed') 'Installation did not complete.'
    Assert-Test (-not $taskInstalled.shortcut) 'The test installation created a shortcut.'
    Assert-Test ($taskInstalled.dataDir -eq $taskData) 'The installation used a different data directory.'
    Assert-Test (Test-Path -LiteralPath (Join-Path $taskInstall 'LICENSE') -PathType Leaf) 'The installed MIT license is missing.'
    Assert-Test ((Get-TestHash (Join-Path $taskRepo 'LICENSE')) -eq (Get-TestHash (Join-Path $taskInstall 'LICENSE'))) 'The installed license differs from the release.'
    Assert-Test (Test-Path -LiteralPath (Join-Path $taskInstall 'README.zh-CN.md') -PathType Leaf) 'The installed Chinese README is missing.'
    Assert-Test ((Get-TestHash (Join-Path $taskRepo 'README.zh-CN.md')) -eq (Get-TestHash (Join-Path $taskInstall 'README.zh-CN.md'))) 'The installed Chinese README differs from the release.'
    foreach ($taskFile in $taskManifest.files) {
        $taskOriginal = Get-TestHash (Join-Path (Join-Path $taskRepo 'src') $taskFile)
        $taskCopy = Get-TestHash (Join-Path (Join-Path $taskInstall 'app') $taskFile)
        Assert-Test ($taskOriginal -eq $taskCopy) ('Installed source differs: ' + $taskFile)
    }
    $taskSavedEnvironment = @{}
    foreach ($taskKey in @('CNCC_DATA_DIR', 'CNCC_NODE', 'CNCC_PYTHON')) { $taskSavedEnvironment[$taskKey] = [Environment]::GetEnvironmentVariable($taskKey, 'Process') }
    try {
        Set-CnccEnvironment $taskInstalled
        Assert-Test ($env:CNCC_DATA_DIR -eq $taskData) 'Runtime data environment does not match the install manifest.'
        Assert-Test ($env:CNCC_NODE -eq $taskInstalled.node) 'Node environment does not match the install manifest.'
        Assert-Test ($env:CNCC_PYTHON -eq $taskInstalled.python) 'Python environment does not match the install manifest.'
    } finally {
        foreach ($taskKey in $taskSavedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($taskKey, $taskSavedEnvironment[$taskKey], 'Process') }
    }
    $taskRefused = $false
    try { & (Join-Path $PSScriptRoot 'install.ps1') -InstallDir $taskInstall -DataDir $taskData -NoShortcut -ReuseData } catch { $taskRefused = $true }
    Assert-Test $taskRefused 'A second installation overwrote an existing program directory.'
    Set-Content -LiteralPath (Join-Path $taskData 'preserved-test.txt') -Value 'private fixture: preserve on uninstall' -Encoding UTF8
    $taskDataHash = Get-TestHash (Join-Path $taskData 'preserved-test.txt')
    & (Join-Path $PSScriptRoot 'uninstall.ps1') -InstallDir $taskInstall -WhatIf
    Assert-Test (Test-Path -LiteralPath $taskInstall) 'Uninstall WhatIf removed the program directory.'
    Assert-Test ((Get-TestHash (Join-Path $taskData 'preserved-test.txt')) -eq $taskDataHash) 'Uninstall WhatIf changed runtime data.'
    & (Join-Path $PSScriptRoot 'uninstall.ps1') -InstallDir $taskInstall
    Assert-Test (-not (Test-Path -LiteralPath $taskInstall)) 'Uninstall did not recycle the test program directory.'
    Assert-Test ((Get-TestHash (Join-Path $taskData 'preserved-test.txt')) -eq $taskDataHash) 'Uninstall changed preserved data.'
    $taskRefused = $false
    try { & (Join-Path $PSScriptRoot 'install.ps1') -InstallDir $taskInstall -DataDir $taskData -NoShortcut } catch { $taskRefused = $true }
    Assert-Test $taskRefused 'Existing data was silently reused without -ReuseData.'
    & (Join-Path $PSScriptRoot 'install.ps1') -InstallDir $taskInstall -DataDir $taskData -NoShortcut -ReuseData
    Assert-Test ((Get-TestHash (Join-Path $taskData 'preserved-test.txt')) -eq $taskDataHash) 'Reinstallation changed preserved data.'
    Assert-Test ((Read-CnccInstall $taskInstall).state -eq 'installed') 'Reinstallation did not complete.'
    & (Join-Path $PSScriptRoot 'uninstall.ps1') -InstallDir $taskInstall
    Assert-Test (-not (Test-Path -LiteralPath $taskInstall)) 'The reinstalled test program remains.'
    if ((Get-Content -LiteralPath (Join-Path $taskBase '.cncc-test-owner') -Raw).Trim() -ne $script:CnccId) { throw 'The disposable test directory lost its ownership marker.' }
    if ($env:CNCC_TEST_RECYCLE_SCRIPT) {
        $taskRecycler = [IO.Path]::GetFullPath($env:CNCC_TEST_RECYCLE_SCRIPT)
        if (-not (Test-Path -LiteralPath $taskRecycler -PathType Leaf)) { throw 'The explicitly selected test recycler is missing.' }
        $taskRecyclerHost = if ($env:CNCC_TEST_RECYCLE_HOST) { $env:CNCC_TEST_RECYCLE_HOST } else { 'pwsh.exe' }
        $taskHostCommand = Get-Command $taskRecyclerHost -CommandType Application -ErrorAction Stop | Select-Object -First 1
        & $taskHostCommand.Source -NoProfile -File $taskRecycler -LiteralPath $taskBase
        if ($LASTEXITCODE -ne 0) { throw 'The explicitly selected test recycler failed.' }
        if (Test-Path -LiteralPath $taskBase) { throw 'The selected test recycler left the test directory behind.' }
    } else {
        Send-CnccToRecycleBin $taskBase
    }
    'Passed ' + $taskAssertions + ' installation assertions. No official app was started; no shortcuts were created.'
} catch {
    Write-Output ('Test stopped. Disposable files were retained for inspection: ' + $taskBase)
    throw
}
