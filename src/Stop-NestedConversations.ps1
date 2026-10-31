$ErrorActionPreference='Stop'
$taskData=if($env:CNCC_DATA_DIR){[IO.Path]::GetFullPath($env:CNCC_DATA_DIR)}else{$PSScriptRoot}
$taskStopRequest=[Guid]::NewGuid().ToString()
@{requestId=$taskStopRequest;requestedAt=(Get-Date).ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskData 'stop-request.json') -Encoding UTF8
$taskDeadline=(Get-Date).AddSeconds(10)
do {
    Start-Sleep -Milliseconds 300
    try {$taskStatus=Get-Content -LiteralPath (Join-Path $taskData 'runtime-status.json') -Raw|ConvertFrom-Json} catch {$taskStatus=$null}
    $taskState=if($taskStatus -and $taskStatus.PSObject.Properties['state']){$taskStatus.state}else{''}
    $taskAck=if($taskStatus -and $taskStatus.PSObject.Properties['stopRequestId']){$taskStatus.stopRequestId}else{''}
}while(($taskState -ne 'stopped_ui_restored' -or $taskAck -ne $taskStopRequest) -and $taskState -ne 'stop_incomplete' -and (Get-Date) -lt $taskDeadline)
if($taskState -eq 'stopped_ui_restored' -and $taskAck -eq $taskStopRequest) {'界面增强已停止，原列表已恢复。'} else {throw '停止恢复尚未完成，请保留当前程序文件并核对运行记录。'}
