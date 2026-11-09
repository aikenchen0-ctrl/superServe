param(
    [Parameter(Mandatory)][string]$ServiceBinary,
    [Parameter(Mandatory)][string]$BackupBinary,
    [Parameter(Mandatory)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
. 'D:\CodexVideoTools\enter.ps1'
$root = (Get-Location).Path
$out = [IO.Path]::GetFullPath($OutputDirectory)
if (!$out.StartsWith("$root\.artifacts\",[StringComparison]::OrdinalIgnoreCase) -or
    (Test-Path -LiteralPath $out)) { throw '画像进程演练须使用本工作区.artifacts下的新目录' }
$null = New-Item -ItemType Directory -Path $out
$catalog = Join-Path $out 'catalog.json'
$catalogText = '{"version":"backup-process-v1","assets":[],"items":[{"id":"video","domain":"video","tags":["rust"],"prior":0.7,"media_sha256":null},{"id":"document","domain":"document","tags":["storage"],"prior":0.4,"media_sha256":null},{"id":"service","domain":"service","tags":["planning"],"prior":0.2,"media_sha256":null}]}'
[IO.File]::WriteAllText($catalog,$catalogText,[Text.UTF8Encoding]::new($false))
$catalogHash = (Get-FileHash -LiteralPath $catalog).Hash.ToLowerInvariant()
$source = Join-Path $out 'events.jsonl'
$archive = Join-Path $out 'events.backup'
$restored = Join-Path $out 'restored.jsonl'
$token = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
try { $probe.Start(); $port = $probe.LocalEndpoint.Port } finally { $probe.Stop() }
$child = $null
$stdoutTask = $null
$stderrTask = $null
$phase = ''
function Start-Profile([string]$Log, [string]$Name) {
    $script:phase = $Name
    $start = [Diagnostics.ProcessStartInfo]::new($ServiceBinary)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($name in @($start.Environment.Keys | Where-Object { $_ -like 'VS_*' })) {
        $null = $start.Environment.Remove($name)
    }
    $start.Environment['VS_ROLE']='profile'
    $start.Environment['VS_BIND']="127.0.0.1:$port"
    $start.Environment['VS_CATALOG']=$catalog
    $start.Environment['VS_PROFILE_EVENT_LOG']=$Log
    $start.Environment['VS_SERVICE_TOKEN']=$token
    $script:child = [Diagnostics.Process]::Start($start)
    $script:stdoutTask = $script:child.StandardOutput.ReadToEndAsync()
    $script:stderrTask = $script:child.StandardError.ReadToEndAsync()
}
function Stop-Profile {
    if (!$script:child) { return }
    if (!$script:child.HasExited) { $script:child.Kill(); $script:child.WaitForExit() }
    $script:stdoutTask.GetAwaiter().GetResult() |
        Set-Content -LiteralPath (Join-Path $out "$script:phase-stdout.log") -Encoding utf8NoBOM
    $script:stderrTask.GetAwaiter().GetResult() |
        Set-Content -LiteralPath (Join-Path $out "$script:phase-stderr.log") -Encoding utf8NoBOM
    $script:child.Dispose()
    $script:child = $null
}
function Wait-Profile {
    $deadline = (Get-Date).AddSeconds(10)
    do {
        if ($script:child.HasExited) { throw '画像演练进程提前退出' }
        try {
            if ((Invoke-WebRequest "http://127.0.0.1:$port/healthz" -NoProxy -TimeoutSec 1).StatusCode -eq 200) { return }
        } catch { }
        if ((Get-Date) -gt $deadline) { throw '画像演练进程未就绪' }
        Start-Sleep -Milliseconds 50
    } while ($true)
}
function Request-Profile([string]$Path, [object]$Body) {
    $headers = @{Authorization="Bearer $token";'x-catalog-sha256'=$catalogHash}
    Invoke-RestMethod "http://127.0.0.1:$port$Path" -Method Post -Headers $headers `
        -ContentType 'application/json' -Body ($Body | ConvertTo-Json -Compress -Depth 5) -NoProxy -TimeoutSec 5
}
function Backup-Command([string[]]$Arguments, [string]$Name, [bool]$Success) {
    $output = @(& $BackupBinary @Arguments 2>&1) -join "`n"
    $exit = $LASTEXITCODE
    $output | Set-Content -LiteralPath (Join-Path $out "$Name.log") -Encoding utf8NoBOM
    if (($exit -eq 0) -ne $Success) { throw '备份CLI退出码与预期不符' }
    if ($Success) { return $output | ConvertFrom-Json }
}
try {
    Start-Profile $source 'initial'
    Wait-Profile
    $events = @(
        @{event_id='like-video';subject='synthetic-a';candidate_id='video';kind='like'},
        @{event_id='hide-document';subject='synthetic-a';candidate_id='document';kind='hide'},
        @{event_id='like-service';subject='synthetic-a';candidate_id='service';kind='like'},
        @{event_id='like-document';subject='synthetic-b';candidate_id='document';kind='like'}
    )
    foreach ($event in $events) {
        $null = Request-Profile '/internal/v1/profile/events' $event
    }
    $projection = Request-Profile '/internal/v1/profile/projection' @{
        subject='synthetic-a';domains=@('video','document','service')
    }
    $null = Backup-Command @('create',$catalog,$source,(Join-Path $out 'active.backup')) 'active-writer-rejected' $false
    if (Test-Path -LiteralPath (Join-Path $out 'active.backup')) { throw '活动写者被备份' }
    Stop-Profile
    $sourceHash = (Get-FileHash -LiteralPath $source).Hash.ToLowerInvariant()
    $receipt = Backup-Command @('create',$catalog,$source,$archive) 'create' $true
    $null = Backup-Command @('verify',$catalog,$archive,$receipt.archive_sha256,$out) 'verify' $true
    $null = Backup-Command @('restore',$catalog,$archive,$receipt.archive_sha256,$restored) 'restore' $true
    if ((Get-FileHash -LiteralPath $restored).Hash.ToLowerInvariant() -ne $sourceHash) {
        throw '恢复原始字节与源不一致'
    }
    Start-Profile $restored 'restore-refused'
    if (!$child.WaitForExit(10000) -or $child.ExitCode -eq 0) { throw '恢复副本意外允许作为写者启动' }
    Stop-Profile
    Start-Profile $source 'source-restart'
    Wait-Profile
    $again = Request-Profile '/internal/v1/profile/projection' @{
        subject='synthetic-a';domains=@('video','document','service')
    }
    # 到期是本次读取时钟，不能伪造两次完全相同；比较真实业务状态。
    foreach ($value in @($projection.profile,$again.profile)) {
        $null = $value.PSObject.Properties.Remove('expires_at')
    }
    if (($projection | ConvertTo-Json -Depth 10 -Compress) -cne ($again | ConvertTo-Json -Depth 10 -Compress)) {
        throw '原进程重启后跨域投影状态改变'
    }
    if ('document' -notin $again.profile.blocked_ids) { throw '隐藏事实丢失' }
    $duplicate = Request-Profile '/internal/v1/profile/events' $events[0]
    Stop-Profile
    if (!$duplicate.duplicate -or (Get-FileHash -LiteralPath $source).Hash.ToLowerInvariant() -ne $sourceHash) {
        throw '重启后的重复事件推进日志'
    }
    [ordered]@{
        schema='profile-backup-process-v1';passed=$true;subjects=2;events=4
        domains=@('video','document','service');active_writer_backup_rejected=$true
        raw_source_and_restore_equal=$true;restored_writer_start_rejected=$true
        original_source_restart_projection_equal=$true;projection_expiry_compared=$false
        hidden_document_preserved=$true;duplicate_after_restart_did_not_append=$true
        source_log_sha256=$sourceHash;archive_sha256=$receipt.archive_sha256
        archive_bytes=$receipt.archive_bytes;projection_sha256=$receipt.projection_sha256
        physical_hosts=1;synthetic_data=$true;after_ack_kill_not_power_loss=$true
        physical_cluster_or_cost_benchmark=$false
    } | ConvertTo-Json -Depth 5 |
        Set-Content -LiteralPath (Join-Path $out 'receipt.json') -Encoding utf8NoBOM
} finally {
    Stop-Profile
    $token = $null
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$port)
    try { $listener.Start() } finally { $listener.Stop() }
    [ordered]@{schema='profile-backup-process-cleanup-v1';child_reclaimed=$true;port_rebind_verified=$true} |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $out 'cleanup.json') -Encoding utf8NoBOM
}
Get-Content -LiteralPath (Join-Path $out 'receipt.json') -Raw
