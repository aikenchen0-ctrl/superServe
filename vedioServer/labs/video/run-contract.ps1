param(
    [string]$Ffmpeg = 'ffmpeg',
    [string]$Ffprobe = 'ffprobe',
    [string]$OutputRoot
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$repository = Split-Path -Parent $workspace
$suffix = if ($IsWindows -or $env:OS -eq 'Windows_NT') { '.exe' } else { '' }
$publisher = Join-Path $workspace "target/debug/examples/publish_video$suffix"
$server = Join-Path $workspace "target/debug/vs-service$suffix"
if (!(Test-Path -LiteralPath $publisher) -or !(Test-Path -LiteralPath $server)) {
    throw '请先构建vs-service服务及publish_video示例'
}
if (!$OutputRoot) {
    $runName = 'run-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
    $OutputRoot = Join-Path $repository ".artifacts/video/$runName"
}
if (Test-Path -LiteralPath $OutputRoot) {
    throw '实验输出目录必须尚不存在，避免覆盖历史收据'
}
$null = New-Item -ItemType Directory -Path $OutputRoot
$OutputRoot = (Resolve-Path $OutputRoot).Path
$root = Join-Path $OutputRoot 'published'
$null = New-Item -ItemType Directory -Path $root
$source = Join-Path $workspace 'crates/vs-service/tests/fixtures/mp4/h264-aac-tail.mp4'
$sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash

$publicationText = & $publisher $root $source 'video-contract-v1' 'clip' 2> (Join-Path $OutputRoot 'publish.stderr.log')
if ($LASTEXITCODE -ne 0) { throw '视频发布命令失败' }
$publication = ($publicationText -join "`n") | ConvertFrom-Json
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
$start.Environment['VS_CATALOG_RELEASE'] = 'video-contract-v1'
$start.Environment['VS_STORAGE'] = 'fs'
$start.Environment['VS_MEDIA_ROOT'] = $root
$process = [Diagnostics.Process]::Start($start)
$stdout = $process.StandardOutput.ReadToEndAsync()
$stderr = $process.StandardError.ReadToEndAsync()

try {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ($true) {
        if ($process.HasExited) { throw '视频服务提前退出' }
        try {
            $ready = Invoke-RestMethod "$base/readyz" -Headers $headers -TimeoutSec 2 -NoProxy
            if ($ready.catalog_sha256) { break }
        } catch {
            if ([DateTime]::UtcNow -ge $deadline) { throw '视频服务就绪超时' }
        }
        if ([DateTime]::UtcNow -ge $deadline) { throw '视频服务就绪响应未包含目录指纹' }
        Start-Sleep -Milliseconds 25
    }
    $body = @{ request_id = 'video-contract'; domains = @('video'); limit = 1; profile = $null } | ConvertTo-Json
    $recommendations = Invoke-RestMethod "$base/v1/recommendations" -Method Post -Headers $headers `
        -ContentType 'application/json' -Body $body -TimeoutSec 5 -NoProxy
    if ($recommendations.items[0].media_path -ne $publication.media_path) {
        throw '推荐返回的媒体路径与发布收据不符'
    }
    $recommendations | ConvertTo-Json -Depth 12 | Out-File (Join-Path $OutputRoot 'recommendations.json') -Encoding utf8
    $rangeHeaders = @{
        Authorization = $headers.Authorization
        Range = 'bytes=0-' + ($publication.prepared.output_media_offset - 1)
    }
    $prefixPath = Join-Path $OutputRoot 'metadata-prefix.bin'
    $prefix = Invoke-WebRequest "$base$($publication.media_path)" -Headers $rangeHeaders `
        -OutFile $prefixPath -PassThru -TimeoutSec 5 -NoProxy
    if ($prefix.StatusCode -ne 206 -or (Get-Item -LiteralPath $prefixPath).Length -ne $publication.prepared.output_media_offset) {
        throw '播放索引前缀Range读取不符'
    }
    $download = Join-Path $OutputRoot 'http.mp4'
    $null = Invoke-WebRequest "$base$($publication.media_path)" -Headers $headers `
        -OutFile $download -TimeoutSec 5 -NoProxy
    $downloadHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $download).Hash.ToLowerInvariant()
    if ($downloadHash -ne $publication.prepared.asset.sha256) { throw 'HTTP视频散列不符' }

    foreach ($entry in @(@{ Name = 'source'; Path = $source }, @{ Name = 'http'; Path = $download })) {
        $probeText = & $Ffprobe -v error -show_streams -show_format -of json $entry.Path `
            2> (Join-Path $OutputRoot "$($entry.Name)-probe.stderr.log")
        if ($LASTEXITCODE -ne 0) { throw '独立视频探测失败' }
        ($probeText -join "`n") | Out-File (Join-Path $OutputRoot "$($entry.Name)-probe.json") -Encoding utf8
        $framePath = Join-Path $OutputRoot "$($entry.Name).framehash"
        & $Ffmpeg -hide_banner -loglevel error -xerror -n -i $entry.Path -map 0:v:0 -map 0:a:0 `
            -f framehash -hash sha256 $framePath 2> (Join-Path $OutputRoot "$($entry.Name)-decode.stderr.log")
        if ($LASTEXITCODE -ne 0) { throw '独立音视频解码失败' }
    }
    $sourceFrames = @(Get-Content -LiteralPath (Join-Path $OutputRoot 'source.framehash') |
        Where-Object { $_ -and !$_.StartsWith('#') })
    $httpFrames = @(Get-Content -LiteralPath (Join-Path $OutputRoot 'http.framehash') |
        Where-Object { $_ -and !$_.StartsWith('#') })
    if ($sourceFrames.Count -eq 0 -or ($sourceFrames -join "`n") -cne ($httpFrames -join "`n")) {
        throw 'HTTP读回与源文件的解码帧散列不同'
    }
    $frontText = & $publisher $root $download 'video-contract-front-v1' 'clip' `
        2> (Join-Path $OutputRoot 'front-publish.stderr.log')
    if ($LASTEXITCODE -ne 0) { throw '前置索引视频重试失败' }
    $front = ($frontText -join "`n") | ConvertFrom-Json
    if ($front.prepared.repacked -or $front.media.created -or $front.media.sha256 -ne $downloadHash) {
        throw '前置视频未保持字节不变和对象复用'
    }
    $fragmented = Join-Path $OutputRoot 'fragmented.mp4'
    & $Ffmpeg -hide_banner -loglevel error -n -i $source -map 0 -c copy `
        -movflags +frag_keyframe+empty_moov+default_base_moof $fragmented `
        2> (Join-Path $OutputRoot 'fragmented-generate.stderr.log')
    if ($LASTEXITCODE -ne 0) { throw '分片输入对照生成失败' }
    $null = & $publisher $root $fragmented 'unsupported-v1' 'clip' `
        2> (Join-Path $OutputRoot 'fragmented-rejection.stderr.log')
    if ($LASTEXITCODE -eq 0 -or (Test-Path -LiteralPath (Join-Path $root 'releases/unsupported-v1.json'))) {
        throw '不支持的分片输入意外发布'
    }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash -ne $sourceHash) {
        throw '处理过程修改了源视频'
    }
    $receipt = [ordered]@{
        schema = 'mp4-http-decode-contract-v1'
        source_bytes = (Get-Item -LiteralPath $source).Length
        output_bytes = $publication.prepared.asset.bytes
        output_sha256 = $downloadHash
        metadata_prefix_bytes = $publication.prepared.output_media_offset
        decoded_frame_records = $sourceFrames.Count
        video_frame_records = @($sourceFrames | Where-Object { $_ -match '^0,' }).Count
        audio_frame_records = @($sourceFrames | Where-Object { $_ -match '^1,' }).Count
        decoded_rows_identical = $true
        full_http_sha256_verified = $true
        prefix_range_status = $prefix.StatusCode
        front_loaded_input_byte_identical = $true
        fragmented_input_rejected = $true
        service_port = $port
        service_stopped = $false
        scope = '本机合成H264/AAC点播样本；不代表真实设备、浏览器播放器、性能收益或物理集群通过'
    }
} finally {
    if (!$process.HasExited) { $process.Kill() }
    if (!$process.WaitForExit(5000)) { throw '视频实验进程未能退出' }
    $stdout.GetAwaiter().GetResult() | Out-File (Join-Path $OutputRoot 'service.stdout.log') -Encoding utf8
    $stderr.GetAwaiter().GetResult() | Out-File (Join-Path $OutputRoot 'service.stderr.log') -Encoding utf8
    $process.Dispose()
}
$receipt.service_stopped = $true
$receipt | ConvertTo-Json -Depth 10 | Out-File (Join-Path $OutputRoot 'receipt.json') -Encoding utf8
$receipt | ConvertTo-Json -Depth 10
Write-Output "验证输出目录：$OutputRoot"
