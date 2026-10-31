$ErrorActionPreference = 'Stop'
$taskRoot = Join-Path ([IO.Path]::GetTempPath()) ('cncc-wrapper-env-' + [Guid]::NewGuid().ToString('N'))
$taskProgram = Join-Path $taskRoot 'program'
$taskData = Join-Path $taskRoot 'data'
$taskRepo = Split-Path -Parent $PSScriptRoot
$taskOriginal = @{}
foreach ($taskKey in @('CNCC_DATA_DIR','CNCC_SETTINGS_DIR','CNCC_NODE','CNCC_PYTHON')) { $taskOriginal[$taskKey] = [Environment]::GetEnvironmentVariable($taskKey,'Process') }
try {
    $null = New-Item -ItemType Directory -Path (Join-Path $taskProgram 'scripts\lib'),(Join-Path $taskProgram 'app'),$taskData -Force
    foreach ($taskFile in @('Start.ps1','Stop.ps1')) { Copy-Item -LiteralPath (Join-Path $taskRepo ('scripts\'+$taskFile)) -Destination (Join-Path $taskProgram 'scripts') }
    Copy-Item -LiteralPath (Join-Path $taskRepo 'scripts\lib\Common.ps1') -Destination (Join-Path $taskProgram 'scripts\lib')
    $taskRuntime = @{files=@('Start-NestedConversations.ps1','Stop-NestedConversations.ps1','enhance-current.cjs');startScript='Start-NestedConversations.ps1';stopScript='Stop-NestedConversations.ps1';companionScript='enhance-current.cjs'}
    @{schemaVersion=1;project='codex-nested-conversations';state='installed';installDir=$taskProgram;dataDir=$taskData;node='fixture-node';python='fixture-python';runtime=$taskRuntime} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $taskProgram '.cncc-install.json') -Encoding UTF8
    $taskDummy = @'
param([switch]$CheckOnly)
$fixture=Get-Content -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) '.cncc-install.json') -Raw | ConvertFrom-Json
if($env:CNCC_DATA_DIR -ne $fixture.dataDir -or $env:CNCC_SETTINGS_DIR -ne $fixture.dataDir -or $env:CNCC_NODE -ne 'fixture-node' -or $env:CNCC_PYTHON -ne 'fixture-python'){throw 'Wrapper did not configure its own child environment'}
if($env:CNCC_TEST_THROW -eq '1'){throw 'Synthetic child failure'}
'Synthetic runtime only; no app was opened.'
'@
    foreach ($taskFile in @('Start-NestedConversations.ps1','Stop-NestedConversations.ps1')) { Set-Content -LiteralPath (Join-Path $taskProgram ('app\'+$taskFile)) -Value $taskDummy -Encoding UTF8 }
    $taskAssertions = 0
    foreach ($taskCommand in @('Start.ps1','Stop.ps1')) {
        foreach ($taskFail in @($false,$true)) {
            $env:CNCC_DATA_DIR='original-data';$env:CNCC_SETTINGS_DIR='original-settings';$env:CNCC_NODE='original-node';$env:CNCC_PYTHON='original-python'
            $env:CNCC_TEST_THROW=if($taskFail){'1'}else{'0'}
            $taskCaught=$false
            try { & (Join-Path $taskProgram ('scripts\'+$taskCommand)) } catch { $taskCaught=$true }
            if($taskCaught -ne $taskFail){throw 'Unexpected synthetic runtime outcome'}
            foreach ($taskPair in @(@('CNCC_DATA_DIR','original-data'),@('CNCC_SETTINGS_DIR','original-settings'),@('CNCC_NODE','original-node'),@('CNCC_PYTHON','original-python'))) {
                if([Environment]::GetEnvironmentVariable($taskPair[0],'Process') -ne $taskPair[1]){throw ('Wrapper leaked '+$taskPair[0])};$taskAssertions++
            }
        }
    }
    'Passed '+$taskAssertions+' wrapper environment assertions. No official app or profile was accessed.'
} finally {
    foreach ($taskKey in $taskOriginal.Keys) { [Environment]::SetEnvironmentVariable($taskKey,$taskOriginal[$taskKey],'Process') }
    [Environment]::SetEnvironmentVariable('CNCC_TEST_THROW',$null,'Process')
    if (Test-Path -LiteralPath $taskRoot) {
        if(-not [IO.Path]::GetFileName($taskRoot).StartsWith('cncc-wrapper-env-')){throw 'Unexpected fixture path'}
        Add-Type -AssemblyName Microsoft.VisualBasic
        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($taskRoot,[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin,[Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)
    }
}
