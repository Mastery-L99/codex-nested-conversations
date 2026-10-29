[CmdletBinding()]
param([switch]$CheckOnly,[switch]$Quiet)
$ErrorActionPreference='Stop'
$taskEnvBefore=@{CNCC_NODE=$env:CNCC_NODE;CNCC_PYTHON=$env:CNCC_PYTHON;CNCC_DATA_DIR=$env:CNCC_DATA_DIR}
$taskData=if($env:CNCC_DATA_DIR){[IO.Path]::GetFullPath($env:CNCC_DATA_DIR)}else{$PSScriptRoot}
$taskMutex=New-Object System.Threading.Mutex($false,'Local\CodexNativeNestedConversationsLauncher')
$taskMutexHeld=$false
try {
    try {$taskMutexHeld=$taskMutex.WaitOne(15000)} catch [System.Threading.AbandonedMutexException] {$taskMutexHeld=$true}
    if(-not $taskMutexHeld){throw '另一个启动操作正在进行，请稍后再试。'}
$taskPackages=@(Get-AppxPackage -Name OpenAI.Codex)
if($taskPackages.Count -ne 1){throw '无法唯一找到已安装的官方 Codex。'}
$taskExe=Join-Path $taskPackages[0].InstallLocation 'app\ChatGPT.exe'
$taskNode=if($env:CNCC_NODE){$env:CNCC_NODE}else{(Get-Command node.exe -ErrorAction Stop).Source}
$taskPython=if($env:CNCC_PYTHON){$env:CNCC_PYTHON}else{(Get-Command python.exe -ErrorAction Stop).Source}
$env:CNCC_NODE=$taskNode
$env:CNCC_PYTHON=$taskPython
$env:CNCC_DATA_DIR=$taskData
$taskScript=Join-Path $PSScriptRoot 'enhance-current.cjs'
foreach($taskRequired in @($taskExe,$taskNode,$taskPython,$taskScript,(Join-Path $PSScriptRoot 'runtime-main.cjs'),(Join-Path $PSScriptRoot 'event-index.cjs'),(Join-Path $PSScriptRoot 'preload-relay.cjs'),(Join-Path $PSScriptRoot 'host-events.js'),(Join-Path $PSScriptRoot 'nested-ui.js'),(Join-Path $PSScriptRoot 'cascade-actions.js'),(Join-Path $PSScriptRoot 'sync-relations.py'),(Join-Path $PSScriptRoot 'open-local-chat.py'),(Join-Path $PSScriptRoot 'chat-is-archived.py'))){
    if(-not(Test-Path -LiteralPath $taskRequired -PathType Leaf)){throw ('缺少文件：'+$taskRequired)}
}
$taskMain=@(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" | Where-Object {$_.ExecutablePath -eq $taskExe -and $_.CommandLine -notmatch '(?:^|\s)--type='})
$taskListening=@(Get-NetTCPConnection -State Listen -LocalPort 9347 -ErrorAction SilentlyContinue)
if($CheckOnly){
    [ordered]@{state='checked_no_action';packageVersion=[string]$taskPackages[0].Version;mainProcessCount=$taskMain.Count;temporaryEndpointListening=($taskListening.Count -gt 0)} | ConvertTo-Json
    exit 0
}
if($taskMain.Count -gt 1){throw '检测到多个官方主进程，请先核对现有窗口。'}
if($taskMain.Count -eq 1 -and ($taskListening.Count -eq 0 -or @($taskListening|Where-Object {$_.OwningProcess -ne $taskMain[0].ProcessId -or $_.LocalAddress -notin @('127.0.0.1','::1')}).Count -gt 0)){
    throw 'Codex 正在普通模式运行。请先在 Codex 的“文件”菜单选择“退出”，然后再次运行本入口。现有聊天会保留。'
}
if($taskMain.Count -eq 0){
    if($taskListening.Count -gt 0){throw '临时端口已被其他程序占用，未启动。'}
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace NestedLauncher {
 [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IApplicationActivationManager {
  [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appId, [MarshalAs(UnmanagedType.LPWStr)] string arguments, uint options, out uint processId);
 }
 public static class Launcher {
  public static uint Activate() {
   object raw=Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")));
   try { uint pid; int hr=((IApplicationActivationManager)raw).ActivateApplication("OpenAI.Codex_2p2nqsd0c76g0!App","--remote-debugging-address=127.0.0.1 --remote-debugging-port=9347",2,out pid); Marshal.ThrowExceptionForHR(hr);return pid; }
   finally {Marshal.FinalReleaseComObject(raw);}
  }
 }
}
'@
    $taskLaunched=[NestedLauncher.Launcher]::Activate()
    $taskDeadline=(Get-Date).AddSeconds(30)
    do {
        Start-Sleep -Milliseconds 400
        $taskListening=@(Get-NetTCPConnection -State Listen -LocalPort 9347 -ErrorAction SilentlyContinue)
    }while($taskListening.Count -eq 0 -and (Get-Date) -lt $taskDeadline)
    if($taskListening.Count -eq 0){throw '已打开原 Codex，界面增强入口尚未响应；没有创建新环境。'}
}
# Only this task's companion is reused. The official installation and shortcuts are untouched.
$taskCompanion=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {$_.ExecutablePath -eq $taskNode -and $_.CommandLine -like ('*'+$taskScript+'*')})
$taskOtherCompanion=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {$_.ExecutablePath -eq $taskNode -and $_.CommandLine -match '[\\/]enhance-current\.cjs(?:"|\s|$)' -and $_.CommandLine -notlike ('*'+$taskScript+'*')})
if($taskOtherCompanion.Count -gt 0){throw '已有一版嵌套增强正在运行。当前窗口可继续使用，请先从原增强入口停止后再切换版本。'}
if($taskCompanion.Count -eq 0){
    if(-not(Test-Path -LiteralPath $taskData)){New-Item -ItemType Directory -Path $taskData -Force|Out-Null}
    $taskStop=Join-Path $taskData 'stop-request.json'
    if(Test-Path -LiteralPath $taskStop){
        $taskStopResolved=[IO.Path]::GetFullPath($taskStop)
        if([IO.Path]::GetDirectoryName($taskStopResolved) -ne [IO.Path]::GetFullPath($taskData)){throw 'Unexpected stop flag location.'}
        Move-Item -LiteralPath $taskStopResolved -Destination (Join-Path $taskData ('stop-request.'+(Get-Date -Format 'yyyyMMdd-HHmmss-fff')+'.completed.json'))
    }
    Start-Process -FilePath $taskNode -ArgumentList ('"'+$taskScript+'"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
}
$taskStatusDeadline=(Get-Date).AddSeconds(15)
$taskReady=$false
do {
    Start-Sleep -Milliseconds 400
    try {
        $taskStatus=Get-Content -LiteralPath (Join-Path $taskData 'runtime-status.json') -Raw | ConvertFrom-Json
        $taskOwner=Get-CimInstance Win32_Process -Filter ('ProcessId='+$taskStatus.processId)
        $taskReady=($taskStatus.state -eq 'running' -and $taskOwner.ExecutablePath -eq $taskNode -and $taskOwner.CommandLine -like ('*'+$taskScript+'*') -and @($taskStatus.diagnostics|Where-Object {$_.installed}).Count -gt 0)
    }catch{$taskReady=$false}
}while(-not $taskReady -and (Get-Date) -lt $taskStatusDeadline)
if(-not $taskReady){throw '原 Codex 保持运行，嵌套列表尚未确认加载，请查看运行记录。'}
'原 Codex 已加载嵌套列表。'
} catch {
    $taskFailure=$_.Exception.Message
    if($CheckOnly){throw}
    if(Test-Path -LiteralPath $taskData){[ordered]@{state='startup_failed';time=(Get-Date).ToString('o');message=$taskFailure} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskData 'start-status.json') -Encoding UTF8}
    if($Quiet){
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show($taskFailure,'Codex 嵌套对话',[System.Windows.Forms.MessageBoxButtons]::OK,[System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
    } else {throw}
} finally {
    if($taskMutexHeld){$taskMutex.ReleaseMutex()}
    $taskMutex.Dispose()
    foreach($taskKey in $taskEnvBefore.Keys){[Environment]::SetEnvironmentVariable($taskKey,$taskEnvBefore[$taskKey],'Process')}
}
