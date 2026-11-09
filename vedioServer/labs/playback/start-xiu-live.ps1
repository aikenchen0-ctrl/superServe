param(
    [Parameter(Mandatory)][string]$XiuBinary,
    [Parameter(Mandatory)][string]$Ffmpeg,
    [Parameter(Mandatory)][string]$InputVideo,
    [Parameter(Mandatory)][string]$OutputRoot,
    [ValidateRange(30, 900)][int]$DurationSeconds = 180
)

$ErrorActionPreference = 'Stop'
$XiuBinary = (Resolve-Path -LiteralPath $XiuBinary).Path
$Ffmpeg = (Resolve-Path -LiteralPath $Ffmpeg).Path
$InputVideo = (Resolve-Path -LiteralPath $InputVideo).Path
$expected = 'b7c0bf5f4802a58885d5af298f0be831b6e2555f20a6308add45a64579a64960'
$actual = (Get-FileHash -LiteralPath $XiuBinary -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw '直播实验只接受已验证的Xiu v0.13.0固定Windows发布物' }
if ([IO.Path]::GetExtension($Ffmpeg) -ne '.exe') { throw '请指定原生ffmpeg.exe' }
if (Test-Path -LiteralPath $OutputRoot) { throw '直播实验目录必须尚不存在' }
$null = New-Item -ItemType Directory -Path $OutputRoot
$OutputRoot = (Resolve-Path -LiteralPath $OutputRoot).Path
function Get-FreePort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    return $port
}
$rtmpPort = Get-FreePort
do { $hlsPort = Get-FreePort } while ($rtmpPort -eq $hlsPort)
$server = $null
$publisher = $null
try {
    $server = Start-Process -FilePath $XiuBinary -ArgumentList @(
        '--rtmp', "$rtmpPort", '--hls', "$hlsPort", '--log', 'warn'
    ) -WorkingDirectory $OutputRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $OutputRoot 'xiu.stdout.log') `
        -RedirectStandardError (Join-Path $OutputRoot 'xiu.stderr.log')
    $deadline = [DateTime]::UtcNow.AddSeconds(8)
    do {
        if ($server.HasExited) { throw 'Xiu直播进程提前退出' }
        try {
            $socket = [Net.Sockets.TcpClient]::new()
            $socket.Connect([Net.IPAddress]::Loopback, $rtmpPort)
            break
        } catch {
            if ([DateTime]::UtcNow -ge $deadline) { throw '直播推流端口启动超时' }
            Start-Sleep -Milliseconds 50
        } finally { if ($socket) { $socket.Dispose() } }
    } while ($true)
    $publisher = Start-Process -FilePath $Ffmpeg -ArgumentList @(
        '-hide_banner', '-loglevel', 'error', '-re', '-stream_loop', '-1',
        '-i', ('"' + $InputVideo + '"'), '-t', "$DurationSeconds", '-c', 'copy',
        '-f', 'flv', "rtmp://127.0.0.1:$rtmpPort/live/lab"
    ) -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $OutputRoot 'publish.stdout.log') `
        -RedirectStandardError (Join-Path $OutputRoot 'publish.stderr.log')
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        if ($server.HasExited -or $publisher.HasExited) { throw '直播清单就绪前进程退出' }
        try {
            $response = Invoke-WebRequest "http://127.0.0.1:$hlsPort/live/lab/lab.m3u8" -TimeoutSec 1 -NoProxy
            $content = if ($response.Content -is [byte[]]) {
                [Text.Encoding]::UTF8.GetString($response.Content)
            } else { [string]$response.Content }
            if ($content.StartsWith('#EXTM3U') -and $content.Contains('#EXTINF:')) { break }
        } catch {}
        if ([DateTime]::UtcNow -ge $deadline) { throw '直播清单未在限定时间内产生片段' }
        Start-Sleep -Milliseconds 100
    } while ($true)
    $receipt = [ordered]@{
        schema = 'xiu-live-launch-v1'
        release_tag = 'v0.13.0'
        source_commit = 'dffca6e682a6e444b090ff2b700c191453f1082d'
        binary_sha256 = $actual
        source_sha256 = (Get-FileHash -LiteralPath $InputVideo -Algorithm SHA256).Hash.ToLowerInvariant()
        xiu_process_id = $server.Id
        xiu_started_utc = $server.StartTime.ToUniversalTime().ToString('O')
        publisher_process_id = $publisher.Id
        publisher_started_utc = $publisher.StartTime.ToUniversalTime().ToString('O')
        publisher_max_seconds = $DurationSeconds
        hls_port = $hlsPort
        rtmp_port = $rtmpPort
        output_root = $OutputRoot
        scope = '隔离开发环境的普通HLS直播；发布源有时限，Xiu需按进程号停止；不作为公网或低延迟直播批准'
    }
    $receipt | ConvertTo-Json | Out-File (Join-Path $OutputRoot 'launch.json') -Encoding utf8
    $receipt | ConvertTo-Json
} catch {
    foreach ($process in @($publisher, $server)) {
        if ($process -and !$process.HasExited) { Stop-Process -Id $process.Id -ErrorAction SilentlyContinue }
    }
    throw
}
