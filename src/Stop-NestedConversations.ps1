$ErrorActionPreference='Stop'
$taskData=if($env:CNCC_DATA_DIR){[IO.Path]::GetFullPath($env:CNCC_DATA_DIR)}else{$PSScriptRoot}
Set-Content -LiteralPath (Join-Path $taskData 'stop-request.json') -Value '{}' -Encoding UTF8
$taskDeadline=(Get-Date).AddSeconds(10)
do {
    Start-Sleep -Milliseconds 300
    try {$taskStatus=Get-Content -LiteralPath (Join-Path $taskData 'runtime-status.json') -Raw|ConvertFrom-Json} catch {$taskStatus=$null}
}while($taskStatus.state -ne 'stopped_ui_restored' -and (Get-Date) -lt $taskDeadline)
if($taskStatus.state -eq 'stopped_ui_restored') {'界面增强已停止，原列表已恢复。'} else {throw '停止尚未确认，请核对运行记录。'}
