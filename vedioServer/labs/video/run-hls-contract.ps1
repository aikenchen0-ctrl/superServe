param(
    [string]$Ffmpeg = 'ffmpeg',
    [string]$InputVideo,
    [ValidateRange(1, 6)][int]$TargetSeconds = 2,
    [switch]$ObserveDelivery,
    [string]$OutputRoot
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$Ffmpeg = (Get-Command $Ffmpeg -CommandType Application -ErrorAction Stop).Source
if ([IO.Path]::GetExtension($Ffmpeg) -in @('.cmd', '.bat')) {
    throw 'HLS验证需要原生FFmpeg可执行文件；请用-Ffmpeg指定ffmpeg.exe，避免批处理破坏HTTP头换行'
}
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$repository = Split-Path -Parent $workspace
$suffix = if ($IsWindows -or $env:OS -eq 'Windows_NT') { '.exe' } else { '' }
$publisher = Join-Path $workspace "target/debug/examples/publish_hls$suffix"
$server = Join-Path $workspace "target/debug/vs-service$suffix"
if (!(Test-Path -LiteralPath $publisher) -or !(Test-Path -LiteralPath $server)) {
    throw '请先构建vs-service与publish_hls示例'
}
if (!$OutputRoot) {
    $OutputRoot = Join-Path $repository ('.artifacts/hls/run-' + (Get-Date -Format 'yyyyMMdd-HHmmss') +
        '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
}
if (Test-Path -LiteralPath $OutputRoot) { throw '实验目录必须尚不存在' }
$null = New-Item -ItemType Directory -Path $OutputRoot
$OutputRoot = (Resolve-Path $OutputRoot).Path
$root = Join-Path $OutputRoot 'published'
$null = New-Item -ItemType Directory -Path $root
$source = Join-Path $OutputRoot 'source.mp4'
if ($InputVideo) {
    Copy-Item -LiteralPath $InputVideo -Destination $source -ErrorAction Stop
} else {
    & $Ffmpeg -hide_banner -loglevel error -n -f lavfi -i testsrc2=size=160x96:rate=12 `
        -f lavfi -i sine=frequency=440:sample_rate=24000 -t 8 -map 0:v:0 -map 1:a:0 `
        -map_metadata -1 -c:v libx264 -preset medium -crf 30 -pix_fmt yuv420p -threads 1 `
        -g 24 -keyint_min 24 -sc_threshold 0 -flags +cgop -c:a aac -b:a 32k $source
    if ($LASTEXITCODE -ne 0) { throw '独立视频生成失败' }
}
$text = & $publisher $root $source 'hls-contract-v1' 'clip' $TargetSeconds `
    2> (Join-Path $OutputRoot 'publish.stderr.log')
if ($LASTEXITCODE -ne 0) { throw 'HLS发布失败' }
$publication = ($text -join "`n") | ConvertFrom-Json
$publication | ConvertTo-Json -Depth 12 | Out-File (Join-Path $OutputRoot 'publication.json') -Encoding utf8

$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = $listener.LocalEndpoint.Port
$listener.Stop()
$base = "http://127.0.0.1:$port"
$token = [Guid]::NewGuid().ToString('N')
$headers = @{ Authorization = "Bearer $token" }
$start = [Diagnostics.ProcessStartInfo]::new($server)
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
foreach ($name in @($start.Environment.Keys)) {
    if ($name.StartsWith('VS_')) { $null = $start.Environment.Remove($name) }
}
$start.Environment['VS_ROLE'] = 'all'
$start.Environment['VS_BIND'] = "127.0.0.1:$port"
$start.Environment['VS_SERVICE_TOKEN'] = $token
$start.Environment['VS_PUBLICATION_ROOT'] = $root
$start.Environment['VS_CATALOG_RELEASE'] = 'hls-contract-v1'
$start.Environment['VS_STORAGE'] = 'fs'
$start.Environment['VS_MEDIA_ROOT'] = $root
if ($ObserveDelivery) { $start.Environment['VS_DELIVERY_OBSERVATION'] = '1' }
$process = [Diagnostics.Process]::Start($start)
$stdout = $process.StandardOutput.ReadToEndAsync()
$stderr = $process.StandardError.ReadToEndAsync()
try {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ($true) {
        if ($process.HasExited) { throw 'HLS服务提前退出' }
        try {
            $ready = Invoke-RestMethod "$base/readyz" -Headers $headers -TimeoutSec 2 -NoProxy
            if ($ready.catalog_sha256) { break }
        } catch {
            if ([DateTime]::UtcNow -ge $deadline) { throw 'HLS服务就绪超时' }
        }
        if ([DateTime]::UtcNow -ge $deadline) { throw 'HLS就绪缺少目录指纹' }
        Start-Sleep -Milliseconds 25
    }
    $recommendation = Invoke-RestMethod "$base/v1/recommendations" -Headers $headers -Method Post `
        -ContentType 'application/json' -TimeoutSec 5 -NoProxy `
        -Body '{"request_id":"hls-contract","domains":["video"],"limit":1,"profile":null}'
    if ($recommendation.items[0].media_path -ne $publication.media_path) { throw '推荐未绑定HLS入口' }
    $masterResponse = Invoke-WebRequest "$base$($publication.media_path)" -Headers $headers -TimeoutSec 5 -NoProxy
    if ($masterResponse.Headers['Content-Type'] -ne 'application/vnd.apple.mpegurl') { throw 'HLS清单类型错误' }
    $windowBytes = 0L
    foreach ($track in $publication.tracks) {
        foreach ($hash in @($track.init_sha256, $track.segments[0].sha256)) {
            $target = Join-Path $OutputRoot $hash
            $null = Invoke-WebRequest "$base/v1/media/$hash" -Headers $headers -OutFile $target -TimeoutSec 5 -NoProxy
            if ((Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash.ToLowerInvariant() -ne $hash) {
                throw '窗口媒体散列不符'
            }
            $windowBytes += (Get-Item -LiteralPath $target).Length
        }
    }
    foreach ($entry in @(@{ Name='source'; Path=$source }, @{ Name='hls'; Path="$base$($publication.media_path)" })) {
        $framePath = Join-Path $OutputRoot "$($entry.Name).framehash"
        if ($entry.Name -eq 'hls') {
            # 子资源有受限类型后缀；保持播放器默认扩展名检查，密钥不写入收据。
            & $Ffmpeg -hide_banner -loglevel error -xerror -n -copyts `
                -headers "Authorization: Bearer $token`r`n" -i $entry.Path `
                -map 0:v:0 -map 0:a:0 -f framehash -hash sha256 $framePath `
                2> (Join-Path $OutputRoot 'hls-decode.stderr.log')
        } else {
            & $Ffmpeg -hide_banner -loglevel error -xerror -n -copyts -i $entry.Path `
                -map 0:v:0 -map 0:a:0 -f framehash -hash sha256 $framePath `
                2> (Join-Path $OutputRoot 'source-decode.stderr.log')
        }
        if ($LASTEXITCODE -ne 0) { throw "独立解码失败：$($entry.Name)" }
    }
    $sourceRows = @(Get-Content (Join-Path $OutputRoot 'source.framehash') | Where-Object { $_ -and !$_.StartsWith('#') })
    $hlsRows = @(Get-Content (Join-Path $OutputRoot 'hls.framehash') | Where-Object { $_ -and !$_.StartsWith('#') })
    if ($sourceRows.Count -eq 0 -or $sourceRows.Count -ne $hlsRows.Count) {
        throw 'HLS与原片的解码记录数量不一致'
    }
    # 保留原时间戳，逐轨比较完整记录；独立音视频轨道的交错输出顺序不属于播放时间线。
    foreach ($streamId in @(0, 1)) {
        $pattern = "^$streamId,"
        $original = @($sourceRows | Where-Object { $_ -match $pattern })
        $decoded = @($hlsRows | Where-Object { $_ -match $pattern })
        if ($original.Count -eq 0 -or ($original -join "`n") -cne ($decoded -join "`n")) {
            throw "HLS与原片的解码时间线或帧内容不一致：轨道$streamId"
        }
    }
    $metrics = Invoke-RestMethod "$base/v1/metrics" -Headers $headers -TimeoutSec 5 -NoProxy
    $receipt = [ordered]@{
        schema='hls-http-decode-contract-v1'
        source_bytes=(Get-Item -LiteralPath $source).Length
        published_asset_bytes=$publication.catalog.release.asset_bytes
        first_audio_video_window_bytes=$windowBytes
        window_excludes_playlists_and_transport=$true
        target_seconds=$TargetSeconds
        video_segments=@(($publication.tracks | Where-Object kind -eq 'video').segments).Count
        audio_segments=@(($publication.tracks | Where-Object kind -eq 'audio').segments).Count
        decoded_records=$sourceRows.Count
        decoded_rows_identical=$true
        timestamp_policy='copyts逐轨完整记录；不重置不同输入的起始时间'
        delivery_observation_enabled=$ObserveDelivery.IsPresent
        delivery_metrics=$metrics.delivery
        service_port=$port
        service_stopped=$false
        scope='本机指定素材；窗口字节不是实际播放器过拉、首帧、CPU或网络收益'
    }
} finally {
    if (!$process.HasExited) { $process.Kill() }
    if (!$process.WaitForExit(5000)) { throw 'HLS实验进程未退出' }
    $stdout.GetAwaiter().GetResult() | Out-File (Join-Path $OutputRoot 'service.stdout.log') -Encoding utf8
    $stderr.GetAwaiter().GetResult() | Out-File (Join-Path $OutputRoot 'service.stderr.log') -Encoding utf8
    $process.Dispose()
}
$receipt.service_stopped = $true
$receipt | ConvertTo-Json -Depth 10 | Out-File (Join-Path $OutputRoot 'receipt.json') -Encoding utf8
$receipt | ConvertTo-Json -Depth 10
Write-Output "验证输出目录：$OutputRoot"
