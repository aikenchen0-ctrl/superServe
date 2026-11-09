param(
    [Parameter(Mandatory)][string]$LaunchFile,
    [string]$InputVideo = 'O:\CodexWorkspaces\superServe-video-b4be\.artifacts\playback\browser-20261107\source.mp4'
)
$ErrorActionPreference = 'Stop'
. 'D:\CodexVideoTools\enter.ps1'
$root = (Get-Location).Path
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$evidence = Join-Path $root ".artifacts\consumption-iggy-$stamp"
$null = New-Item -ItemType Directory -Path $evidence
$snapshot = Join-Path $env:CARGO_TARGET_DIR 'debug\examples\snapshot_feedback.exe'
$replay = Join-Path $env:CARGO_TARGET_DIR 'debug\examples\replay_consumption.exe'
if (!(Test-Path -LiteralPath $snapshot) -or !(Test-Path -LiteralPath $replay)) {
    throw '须先构建snapshot_feedback、replay_consumption和播放验收目标'
}
$endpoint = 'http://127.0.0.1:18090'
$vm = $null
$previousWriter = $env:VS_TEST_PLAYBACK_IGGY_WRITER_TOKEN
$previousReader = $env:VS_TEST_PLAYBACK_IGGY_READER_TOKEN
$previousSnapshot = $env:VS_FEEDBACK_IGGY_TOKEN
$private = Join-Path $evidence 'feedback.json'
$browserDirectory = Join-Path $evidence 'browser'

function Invoke-Guest([string]$Command) {
    $text = @(& ssh -F NUL -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=yes `
        -o "UserKnownHostsFile=$($vm.run)/known_hosts" -i $vm.key -p "$($vm.ssh_port)" `
        root@127.0.0.1 "set -eu; $Command" 2>&1)
    if ($LASTEXITCODE -ne 0) { throw '本轮Linux来宾命令失败；不重发反馈消息' }
    return ($text -join "`n")
}
function Wait-Broker {
    $deadline = (Get-Date).AddSeconds(45)
    do {
        try {
            if ((Invoke-WebRequest "$endpoint/ping" -NoProxy -TimeoutSec 2).StatusCode -eq 200) { return }
        } catch { }
        if ((Get-Date) -gt $deadline) { throw '真实broker未在期限内就绪' }
        Start-Sleep -Milliseconds 200
    } while ($true)
}
function Login([string]$Username, [string]$Password) {
    $body = @{username=$Username;password=$Password} | ConvertTo-Json -Compress
    $response = Invoke-RestMethod "$endpoint/users/login" -Method Post -ContentType 'application/json' `
        -Body $body -NoProxy -TimeoutSec 10
    if (!$response.access_token.token) { throw '真实broker未返回令牌' }
    return $response.access_token.token
}
function Create-Resource([string]$Path, [object]$Body) {
    Invoke-RestMethod "$endpoint$Path" -Method Post -ContentType 'application/json' `
        -Headers @{Authorization="Bearer $admin"} -Body ($Body | ConvertTo-Json -Depth 20 -Compress) `
        -NoProxy -TimeoutSec 10
}
function Export-Evidence([string]$Label, [string]$Token) {
    $metadata = Invoke-RestMethod "$endpoint/streams/$($config.stream_id)/topics/$($config.topic_id)?consistency=linearizable" `
        -Headers @{Authorization="Bearer $Token"} -NoProxy -TimeoutSec 10
    if ($metadata.created_at -ne $integration.feedback_readiness.topic_created_at -or
        $metadata.partitions[0].created_at -ne $integration.feedback_readiness.partition_created_at -or
        $metadata.messages_count -ne 3 -or $metadata.partitions[0].messages_count -ne 3 -or
        $metadata.options.durability.value -ne 'persisted' -or !$metadata.options.durability.explicit) {
        throw '恢复后的主题身份、消息数或持久策略改变'
    }
    $metadata | ConvertTo-Json -Depth 20 |
        Set-Content -LiteralPath (Join-Path $evidence "$Label-topic.json") -Encoding utf8NoBOM
    $env:VS_FEEDBACK_IGGY_TOKEN = $Token
    & $snapshot $private 0 3 (Join-Path $evidence "$Label.json") --raw-evidence `
        2> (Join-Path $evidence "$Label.stderr.log") |
        Set-Content -LiteralPath (Join-Path $evidence "$Label-receipt.json") -Encoding utf8NoBOM
    if ($LASTEXITCODE -ne 0) { throw "重启后原始快照失败：$Label；不重发写入" }
    $original = Get-Content -LiteralPath (Join-Path $browserDirectory 'raw-evidence.json') -Raw | ConvertFrom-Json
    $restored = Get-Content -LiteralPath (Join-Path $evidence "$Label.json") -Raw | ConvertFrom-Json
    # captured_at是本次采集时间，不要求相同；全部坐标、消息ID、偏移及原始载荷必须完全一致。
    foreach ($field in @('schema','source_id','data_kind','stream_id','topic_id','partition_id','start_offset','end_offset_exclusive','messages')) {
        $before = ConvertTo-Json -InputObject $original.$field -Depth 20 -Compress
        $after = ConvertTo-Json -InputObject $restored.$field -Depth 20 -Compress
        if ($before -cne $after) { throw "恢复后原始消息不一致：$field" }
    }
    $digest = (Get-FileHash -LiteralPath (Join-Path $evidence "$Label.json")).Hash.ToLowerInvariant()
    [ordered]@{
        schema='consumption-replay-v1';evidence=@{path="$Label.json";sha256=$digest}
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $evidence "$Label-replay.json") -Encoding utf8NoBOM
    & $replay (Join-Path $evidence "$Label-replay.json") (Join-Path $evidence "$Label-report.json") `
        2> (Join-Path $evidence "$Label-replay.stderr.log") |
        Set-Content -LiteralPath (Join-Path $evidence "$Label-replay-receipt.json") -Encoding utf8NoBOM
    if ($LASTEXITCODE -ne 0) { throw '恢复后消费重建失败' }
    $originalReport = Get-Content -LiteralPath (Join-Path $browserDirectory 'consumption-report.json') -Raw | ConvertFrom-Json
    $report = Get-Content -LiteralPath (Join-Path $evidence "$Label-report.json") -Raw | ConvertFrom-Json
    foreach ($field in @('schema','data_kind','coverage','interactions','scope')) {
        if ((ConvertTo-Json -InputObject $originalReport.$field -Depth 30 -Compress) -cne
            (ConvertTo-Json -InputObject $report.$field -Depth 30 -Compress)) {
            throw "恢复后消费重建不一致：$field"
        }
    }
}
try {
    # 复用已清理的单来宾，不复制虚拟机，不连接远程或启动C盘WSL。
    $vm = (& "$root\vedioServer\labs\linux-vm\resume.ps1" -LaunchFile $LaunchFile | Out-String) | ConvertFrom-Json
    $activeLaunch = Join-Path $vm.attempt 'launch.json'
    $deadline = (Get-Date).AddSeconds(120)
    do {
        & ssh -F NUL -o BatchMode=yes -o ConnectTimeout=2 -o StrictHostKeyChecking=yes `
            -o "UserKnownHostsFile=$($vm.run)/known_hosts" -i $vm.key -p "$($vm.ssh_port)" `
            root@127.0.0.1 true 2>$null
        if ($LASTEXITCODE -eq 0) { break }
        if ((Get-Date) -gt $deadline) { throw 'Linux来宾SSH未在期限内就绪' }
        Start-Sleep -Milliseconds 500
    } while ($true)
    $password = Invoke-Guest "sed -n 's/^IGGY_ROOT_PASSWORD=//p' /mnt/o/video-lab/broker.env"
    if ($password -notmatch '^[0-9a-f]{48}$') { throw '来宾实验凭据无效' }
    $null = Invoke-Guest 'test "$(sha256sum /mnt/o/video-lab/iggy-server | cut -d" " -f1)" = b3331f7b62fc84e3df5c2e6c739a9a5b39df1722eadada98eeab5427bf9719ae; if systemctl is-failed --quiet video-iggy; then systemctl reset-failed video-iggy; fi; systemctl start video-iggy'
    Wait-Broker
    $admin = Login 'iggy-lab' $password
    $runId = "playback-$stamp"
    $stream = Create-Resource '/streams' @{name=$runId}
    $topic = Create-Resource "/streams/$($stream.id)/topics" @{
        name='consumption';partitions_count=1;compression_algorithm='none'
        message_expiry=[ulong]::MaxValue;max_topic_size=[ulong]::MaxValue
        options=@{durability='persisted';consumer_offset_durability='persisted'
            segment_size='1 MiB';preallocate_segments='false'}
    }
    $roles = @{}
    foreach ($role in @('writer','reader')) {
        $secret = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
        $permissions = @{
            global=@{manage_servers=$false;read_servers=$false;manage_users=$false;read_users=$false
                manage_streams=$false;read_streams=$false;manage_topics=$false;read_topics=$false
                poll_messages=$false;send_messages=$false}
            streams=@{"$($stream.id)"=@{manage_stream=$false;read_stream=$false;manage_topics=$false
                read_topics=$false;poll_messages=$false;send_messages=$false
                topics=@{"$($topic.id)"=@{manage_topic=$false;read_topic=$true
                    poll_messages=($role -eq 'reader');send_messages=($role -eq 'writer')}}}}
        }
        $null = Create-Resource '/users' @{username="$runId-$role";password=$secret;status='active';permissions=$permissions}
        $roles[$role] = @{username="$runId-$role";password=$secret}
    }
    $config = [ordered]@{
        endpoint=$endpoint;stream_id=$stream.id;topic_id=$topic.id
        partition_id=$topic.partitions[0].id;source_id='playback-lab'
        data_kind='synthetic';operation_timeout_ms=5000
    }
    $config | ConvertTo-Json | Set-Content -LiteralPath $private -Encoding utf8NoBOM
    $env:VS_TEST_PLAYBACK_IGGY_WRITER_TOKEN = Login $roles.writer.username $roles.writer.password
    $env:VS_TEST_PLAYBACK_IGGY_READER_TOKEN = Login $roles.reader.username $roles.reader.password
    $messages = "$endpoint/streams/$($stream.id)/topics/$($topic.id)/messages"
    $body = @{partitioning=@{kind='partition_id';value=[Convert]::ToBase64String([BitConverter]::GetBytes([uint32]$config.partition_id))}
        messages=@(@{id='1';payload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('forbidden'))})}
    $deniedWrite = Invoke-WebRequest $messages -Method Post -ContentType 'application/json' `
        -Headers @{Authorization="Bearer $env:VS_TEST_PLAYBACK_IGGY_READER_TOKEN"} `
        -Body ($body | ConvertTo-Json -Depth 10 -Compress) -NoProxy -SkipHttpErrorCheck -TimeoutSec 10
    if ($deniedWrite.StatusCode -ne 403) { throw '只读者追加没有按权限拒绝' }
    $admin = $null
    & "$PSScriptRoot\run-consumption-browser.ps1" -InputVideo $InputVideo `
        -FeedbackConfig $private -EvidenceDirectory $browserDirectory |
        Tee-Object -FilePath (Join-Path $evidence 'browser-run.log')
    $integration = Get-Content -LiteralPath (Join-Path $browserDirectory 'integration-receipt.json') -Raw | ConvertFrom-Json
    if (!$integration.passed -or $integration.message_backend -ne 'real-iggy-singleton' -or
        $integration.batches -ne 3 -or $integration.client_body_bytes -ne $integration.reconstructed_body_bytes) {
        throw '实际浏览器和真实消息链路证据不完整'
    }
    # 有数据后验证实际读取继承，不把刚创建空分区的暂不可用当权限拒绝或放宽成成功。
    $inheritedRead = Invoke-WebRequest "$($messages)?consumer_id=1&partition_id=$($config.partition_id)&kind=offset&value=0&count=1&auto_commit=false" `
        -Headers @{Authorization="Bearer $env:VS_TEST_PLAYBACK_IGGY_WRITER_TOKEN"} `
        -NoProxy -SkipHttpErrorCheck -TimeoutSec 10
    [ordered]@{
        schema='playback-iggy-permissions-v1';writer_poll_status=[int]$inheritedRead.StatusCode
        reader_append_status=[int]$deniedWrite.StatusCode
        writer_read_topic_implies_poll=$true;strict_write_only_claimed=$false
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $evidence 'permissions.json') -Encoding utf8NoBOM
    if ($inheritedRead.StatusCode -ne 200 -or ($inheritedRead.Content | ConvertFrom-Json).count -ne 1) {
        throw '写者元数据读取继承未得到实际消息读取证据'
    }
    # 后续只读快照；播放进程已回收，不在broker恢复期间重试写入。
    $states = @()
    foreach ($mode in @('normal','killed')) {
        if ($mode -eq 'normal') {
            $null = Invoke-Guest 'systemctl stop video-iggy; test "$(systemctl show video-iggy -p ExecMainStatus --value)" = 0; test "$(systemctl show video-iggy -p MainPID --value)" = 0'
        } else {
            $null = Invoke-Guest 'systemctl kill --kill-whom=main --signal=SIGKILL video-iggy; for i in $(seq 1 100); do test "$(systemctl show video-iggy -p MainPID --value)" = 0 && break; sleep 0.1; done; test "$(systemctl show video-iggy -p MainPID --value)" = 0; test "$(systemctl show video-iggy -p ExecMainCode --value)" = 2; test "$(systemctl show video-iggy -p ExecMainStatus --value)" = 9'
        }
        $states += [ordered]@{mode=$mode;state=(Invoke-Guest 'systemctl show video-iggy -p MainPID -p ExecMainCode -p ExecMainStatus -p Result')}
        $null = Invoke-Guest 'if systemctl is-failed --quiet video-iggy; then systemctl reset-failed video-iggy; fi; systemctl start video-iggy'
        Wait-Broker
        $reader = Login $roles.reader.username $roles.reader.password
        Export-Evidence $mode $reader
    }
    $null = Invoke-Guest 'systemctl stop video-iggy; test "$(systemctl show video-iggy -p ExecMainStatus --value)" = 0; test "$(systemctl show video-iggy -p MainPID --value)" = 0'
    [ordered]@{
        schema='playback-real-iggy-recovery-v1';passed=$true;physical_hosts=1;software_emulation=$true
        broker_binary_sha256='b3331f7b62fc84e3df5c2e6c739a9a5b39df1722eadada98eeab5427bf9719ae'
        browser_integration=$integration;recovery_states=$states;recovery_messages_equal=$true
        recovery_projection_equal=$true;capture_timestamps_preserved=$true;topic_identity_preserved=$true
        writer_can_poll_due_to_read_topic=$true;strict_write_only_claimed=$false
        reader_append_forbidden=$true;recovered_messages=3
        recovery_read_only=$true;fresh_reader_login_after_each_restart=$true
        after_ack_kill_not_power_loss=$true;physical_cluster_or_native_devices_verified=$false
        production_or_three_low_claimed=$false;active_launch=$activeLaunch
    } | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $evidence 'receipt.json') -Encoding utf8NoBOM
} finally {
    $env:VS_TEST_PLAYBACK_IGGY_WRITER_TOKEN = $previousWriter
    $env:VS_TEST_PLAYBACK_IGGY_READER_TOKEN = $previousReader
    $env:VS_FEEDBACK_IGGY_TOKEN = $previousSnapshot
    $password = $null; $admin = $null; $roles = $null; $reader = $null; $secret = $null
    if ($vm) {
        & "$root\vedioServer\labs\linux-vm\stop.ps1" -LaunchFile (Join-Path $vm.attempt 'launch.json')
        foreach ($port in @(18080,18022,18090)) {
            $probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$port)
            try { $probe.Start() } finally { $probe.Stop() }
        }
        Copy-Item -LiteralPath (Join-Path $vm.attempt 'cleanup.json') -Destination (Join-Path $evidence 'cleanup.json')
    }
}
Get-Content -LiteralPath (Join-Path $evidence 'receipt.json') -Raw
