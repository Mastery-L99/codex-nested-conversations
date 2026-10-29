Set-StrictMode -Version 2.0
$script:CnccId = 'codex-nested-conversations'
$script:CnccShortcutName = 'Codex Nested Conversations.lnk'

function Get-CnccDefaultInstallDir {
    if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is unavailable.' }
    Join-Path $env:LOCALAPPDATA 'CodexNestedConversations'
}

function Get-CnccDefaultDataDir {
    if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is unavailable.' }
    Join-Path $env:LOCALAPPDATA 'CodexNestedConversationsData'
}

function Get-CnccFullPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'A non-empty path is required.' }
    [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar)
}

function Test-CnccInside([string]$Path, [string]$Parent) {
    $taskPath = Get-CnccFullPath $Path
    $taskParent = Get-CnccFullPath $Parent
    $taskPath.Equals($taskParent, [StringComparison]::OrdinalIgnoreCase) -or
        $taskPath.StartsWith($taskParent + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-CnccSafePath([string]$Path) {
    $taskPath = Get-CnccFullPath $Path
    $taskRoot = [IO.Path]::GetPathRoot($taskPath).TrimEnd([IO.Path]::DirectorySeparatorChar)
    if ($taskPath -eq $taskRoot) { throw 'Drive roots are not allowed.' }
    foreach ($taskBase in @($env:USERPROFILE, $env:LOCALAPPDATA, $env:APPDATA, $env:WINDIR, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if ($taskBase -and $taskPath.Equals((Get-CnccFullPath $taskBase), [StringComparison]::OrdinalIgnoreCase)) {
            throw 'A dedicated project directory is required.'
        }
    }
    foreach ($taskProtected in @((Join-Path $env:USERPROFILE '.codex'), (Join-Path $env:LOCALAPPDATA 'Packages'), $env:WINDIR, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if ($taskProtected -and (Test-CnccInside $taskPath $taskProtected)) { throw 'Official, profile, and system directories are protected.' }
    }
    $taskCursor = $taskPath
    while ($taskCursor) {
        if (Test-Path -LiteralPath $taskCursor) {
            $taskItem = Get-Item -LiteralPath $taskCursor -Force
            if (($taskItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse points are not allowed.' }
        }
        $taskParent = Split-Path -Parent $taskCursor
        if ($taskParent -eq $taskCursor) { break }
        $taskCursor = $taskParent
    }
    $taskPath
}

function Get-CnccRuntimeManifest([string]$RepoRoot) {
    $taskManifest = Get-Content -LiteralPath (Join-Path $RepoRoot 'runtime-manifest.json') -Raw | ConvertFrom-Json
    if ($taskManifest.schemaVersion -ne 1 -or @($taskManifest.files).Count -eq 0) { throw 'Invalid runtime manifest.' }
    $taskSource = Get-CnccFullPath (Join-Path $RepoRoot 'src')
    foreach ($taskFile in $taskManifest.files) {
        if ($taskFile -isnot [string] -or $taskFile -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]*\.(cjs|js|py|ps1)$' -or ($taskFile -split '/') -contains '..') { throw 'The runtime manifest contains an invalid source path.' }
        $taskResolved = Get-CnccFullPath (Join-Path $taskSource $taskFile)
        if (-not (Test-CnccInside $taskResolved $taskSource)) { throw 'Runtime sources must remain inside src.' }
        $null = Assert-CnccSafePath $taskResolved
    }
    foreach ($taskEntry in @($taskManifest.startScript, $taskManifest.stopScript, $taskManifest.companionScript)) {
        if ($taskManifest.files -notcontains $taskEntry) { throw 'Runtime entrypoints must be listed in the file manifest.' }
    }
    $taskManifest
}

function Get-CnccDependencies([string]$RepoRoot) {
    $taskNode = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $taskNode) { throw 'Node.js 22+ is required. Install it yourself and rerun.' }
    $taskNodeVersion = (& $taskNode.Source -p 'process.versions.node').Trim()
    if ($LASTEXITCODE -ne 0 -or [int]($taskNodeVersion.Split('.')[0]) -lt 22) { throw 'Node.js 22+ is required.' }
    $taskPython = $null
    foreach ($taskName in @('python.exe', 'python3.exe', 'py.exe')) {
        $taskCommand = Get-Command $taskName -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $taskCommand -or $taskCommand.Source -like '*\Microsoft\WindowsApps\python*.exe') { continue }
        $taskArguments = @('-c', 'import sys; print(sys.executable); print(sys.version_info.major); print(sys.version_info.minor)')
        if ($taskName -eq 'py.exe') { $taskArguments = @('-3') + $taskArguments }
        try {
            $taskOutput = @(& $taskCommand.Source @taskArguments 2>$null)
            if ($LASTEXITCODE -ne 0 -or $taskOutput.Count -ne 3) { continue }
            $taskCandidate = [pscustomobject]@{ path = [string]$taskOutput[0]; major = [int]$taskOutput[1]; minor = [int]$taskOutput[2] }
            if ($taskCandidate.major -eq 3 -and $taskCandidate.minor -ge 10 -and (Test-Path -LiteralPath $taskCandidate.path -PathType Leaf)) { $taskPython = $taskCandidate; break }
        } catch { continue }
    }
    if (-not $taskPython) { throw 'Python 3.10+ is required. Install it yourself and rerun.' }
    $taskNpm = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $taskNpm) { throw 'npm is required. Install it yourself and rerun.' }
    $taskDependencyDirs = @('playwright', 'playwright-core')
    foreach ($taskName in $taskDependencyDirs) {
        $taskDirectory = Join-Path $RepoRoot ('node_modules\' + $taskName)
        if (-not (Test-Path -LiteralPath (Join-Path $taskDirectory 'package.json') -PathType Leaf)) { throw 'Public npm dependencies are missing. Run npm ci --ignore-scripts in the repository, then retry.' }
        $null = Assert-CnccSafePath $taskDirectory
        if (@(Get-ChildItem -LiteralPath $taskDirectory -Recurse -Force | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }).Count -gt 0) { throw 'Dependency directories must not contain reparse points.' }
    }
    $taskPlaywrightVersion = (& $taskNode.Source -e "const{createRequire}=require('node:module');const p=require('node:path');console.log(createRequire(p.join(process.argv[1],'package.json'))('playwright/package.json').version)" $RepoRoot).Trim()
    $taskDeclared = (Get-Content -LiteralPath (Join-Path $RepoRoot 'package.json') -Raw | ConvertFrom-Json).dependencies.playwright
    if ($LASTEXITCODE -ne 0 -or $taskPlaywrightVersion -ne $taskDeclared) { throw 'Installed Playwright does not match package.json. Run npm ci --ignore-scripts.' }
    [pscustomobject]@{ Node = $taskNode.Source; NodeVersion = $taskNodeVersion; Python = $taskPython.path; PythonVersion = ('3.' + $taskPython.minor); Npm = $taskNpm.Source; PlaywrightVersion = $taskPlaywrightVersion; DependencyDirs = $taskDependencyDirs }
}

function Read-CnccInstall([string]$InstallDir) {
    $taskRoot = Assert-CnccSafePath $InstallDir
    $taskMarker = Join-Path $taskRoot '.cncc-install.json'
    if (-not (Test-Path -LiteralPath $taskMarker -PathType Leaf)) { throw 'The project installation marker is missing; no files were changed.' }
    $taskInstall = Get-Content -LiteralPath $taskMarker -Raw | ConvertFrom-Json
    if ($taskInstall.project -ne $script:CnccId -or $taskInstall.schemaVersion -ne 1 -or -not (Get-CnccFullPath $taskInstall.installDir).Equals($taskRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'The installation identity does not match; no files were changed.' }
    foreach ($taskEntry in @($taskInstall.runtime.startScript, $taskInstall.runtime.stopScript, $taskInstall.runtime.companionScript)) {
        if ($taskEntry -isnot [string] -or $taskEntry -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]*\.(cjs|js|py|ps1)$' -or ($taskEntry -split '/') -contains '..' -or $taskInstall.runtime.files -notcontains $taskEntry) { throw 'Invalid installed runtime entrypoint.' }
        $taskEntryPath = Assert-CnccSafePath (Join-Path (Join-Path $taskRoot 'app') $taskEntry)
        if (-not (Test-CnccInside $taskEntryPath (Join-Path $taskRoot 'app'))) { throw 'The installed runtime entrypoint escaped the app directory.' }
    }
    $taskInstall
}

function Set-CnccEnvironment($Install) {
    $env:CNCC_DATA_DIR = Get-CnccFullPath $Install.dataDir
    $env:CNCC_NODE = $Install.node
    $env:CNCC_PYTHON = $Install.python
}

function Get-CnccStartShortcutDefinition([string]$InstallDir, [switch]$LegacyNoHidden) {
    $taskRoot = Get-CnccFullPath $InstallDir
    $taskWindowArgument = if ($LegacyNoHidden) { '' } else { '-WindowStyle Hidden ' }
    [pscustomobject]@{
        TargetPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
        Arguments = '-NoProfile -ExecutionPolicy Bypass ' + $taskWindowArgument + '-File "' + (Join-Path $taskRoot 'scripts\Start.ps1') + '"'
        WorkingDirectory = $taskRoot
    }
}

function Test-CnccStartShortcutIdentity([string]$InstallDir, [string]$TargetPath, [string]$Arguments) {
    $taskCurrent = Get-CnccStartShortcutDefinition $InstallDir
    if (-not $TargetPath.Equals($taskCurrent.TargetPath, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    if ($Arguments.Equals($taskCurrent.Arguments, [StringComparison]::Ordinal)) { return $true }
    # Accept only the exact former project entry, with the same executable and script path.
    $taskLegacy = Get-CnccStartShortcutDefinition $InstallDir -LegacyNoHidden
    $Arguments.Equals($taskLegacy.Arguments, [StringComparison]::Ordinal)
}

function Send-CnccToRecycleBin([string]$LiteralPath) {
    $taskPath = Assert-CnccSafePath $LiteralPath
    $taskItem = Get-Item -LiteralPath $taskPath -Force
    if ($taskItem.PSIsContainer -and @(Get-ChildItem -LiteralPath $taskPath -Recurse -Force | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }).Count -gt 0) { throw 'The directory contains a reparse point; recycling stopped.' }
    Add-Type -AssemblyName Microsoft.VisualBasic
    if ($taskItem.PSIsContainer) {
        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($taskPath, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin, [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)
    } else {
        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($taskPath, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin, [Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)
    }
    if (Test-Path -LiteralPath $taskPath) { throw 'The path remains after the Recycle Bin operation. Stopped.' }
}
