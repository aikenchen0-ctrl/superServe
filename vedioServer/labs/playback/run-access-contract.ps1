param(
    [Parameter(Mandatory)][string]$Server,
    [Parameter(Mandatory)][string]$PublicationRoot,
    [Parameter(Mandatory)][string]$Ffmpeg,
    [Parameter(Mandatory)][string]$OutputRoot
)

$ErrorActionPreference = 'Stop'
$Server = (Resolve-Path -LiteralPath $Server).Path
$PublicationRoot = (Resolve-Path -LiteralPath $PublicationRoot).Path
$Ffmpeg = (Resolve-Path -LiteralPath $Ffmpeg).Path
if ([IO.Path]::GetExtension($Ffmpeg) -ne '.exe') { throw '请指定原生ffmpeg.exe' }
if (Test-Path -LiteralPath $OutputRoot) { throw '验证输出目录必须尚不存在' }
$null = New-Item -ItemType Directory -Path $OutputRoot
$OutputRoot = (Resolve-Path -LiteralPath $OutputRoot).Path
$serviceToken = [Guid]::NewGuid().ToString('N')
$key = [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
$encodedKey = [Convert]::ToBase64String($key).TrimEnd('=').Replace('+','-').Replace('/','_')
$headers = @{ Authorization = "Bearer $serviceToken" }
$started = @()
$result = $null
function Get-FreePort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    return $port
}
try {
    foreach ($role in @('api', 'media')) {
        $port = Get-FreePort
        $start = [Diagnostics.ProcessStartInfo]::new($Server)
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        foreach ($name in @($start.Environment.Keys)) {
            if ($name.StartsWith('VS_')) { $null = $start.Environment.Remove($name) }
        }
        foreach ($entry in @{
            VS_ROLE=$role
            VS_BIND="127.0.0.1:$port"
            VS_SERVICE_TOKEN=$serviceToken
            VS_PUBLICATION_ROOT=$PublicationRoot
            VS_CATALOG_RELEASE='browser-lab-v1'
            VS_MEDIA_ROOT=$PublicationRoot
            VS_STORAGE='fs'
            VS_PLAYBACK_SIGNING_KEY=$encodedKey
            VS_PLAYBACK_AUDIENCE='access-contract'
        }.GetEnumerator()) { $start.Environment[$entry.Key] = $entry.Value }
        if ($role -eq 'media') { $start.Environment['VS_DELIVERY_OBSERVATION'] = '1' }
        $process = [Diagnostics.Process]::Start($start)
        $entry = @{
            Role=$role; Process=$process; Port=$port
            Stdout=$process.StandardOutput.ReadToEndAsync()
            Stderr=$process.StandardError.ReadToEndAsync()
        }
        $started += $entry
        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        do {
            if ($process.HasExited) { throw '授权合约服务提前退出' }
            try {
                $ready = Invoke-RestMethod "http://127.0.0.1:$port/readyz" -Headers $headers -TimeoutSec 1 -NoProxy
                if ($ready.ready) { break }
            } catch {}
            if ([DateTime]::UtcNow -ge $deadline) { throw '授权合约服务就绪超时' }
            Start-Sleep -Milliseconds 50
        } while ($true)
    }
    $api = "http://127.0.0.1:$($started[0].Port)"
    $media = "http://127.0.0.1:$($started[1].Port)"
    $at = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $payload = @{
        candidate_id='clip'; ttl_seconds=120
        profile=@{
            subject='contract-viewer'; version='contract-v1'; scopes=@('video')
            expires_at=($at + 600); interests=@(); blocked_ids=@(); denied_tags=@()
        }
    }
    $grant = Invoke-RestMethod "$api/internal/v1/playback/grants" -Method Post -Headers $headers `
        -ContentType 'application/json' -Body ($payload | ConvertTo-Json -Depth 5) -TimeoutSec 5 -NoProxy
    & $Ffmpeg -hide_banner -loglevel error -xerror -n -i ($media + $grant.media_path) -t 3 `
        -map 0:v:0 -map 0:a:0 -f framehash -hash sha256 (Join-Path $OutputRoot 'decoded.framehash') `
        2> (Join-Path $OutputRoot 'decode.stderr.log')
    if ($LASTEXITCODE -ne 0) { throw '独立媒体进程的签名HLS解码失败' }
    $records = @(Get-Content -LiteralPath (Join-Path $OutputRoot 'decoded.framehash') |
        Where-Object { $_ -and !$_.StartsWith('#') })
    if (!$records.Count) { throw '独立解码没有得到媒体记录' }
    $rootHash = $grant.media_path.Split('/')[4]
    $legacy = Invoke-WebRequest "$media/v1/media/$rootHash/index.m3u8" -NoProxy -TimeoutSec 3 -SkipHttpErrorCheck
    if ([int]$legacy.StatusCode -ne 401) { throw '内部媒体路径被匿名放行' }
    $payload.ttl_seconds = 1
    $short = Invoke-RestMethod "$api/internal/v1/playback/grants" -Method Post -Headers $headers `
        -ContentType 'application/json' -Body ($payload | ConvertTo-Json -Depth 5) -TimeoutSec 5 -NoProxy
    Start-Sleep -Seconds 2
    $expired = Invoke-WebRequest ($media + $short.media_path) -TimeoutSec 3 -NoProxy -SkipHttpErrorCheck
    if ([int]$expired.StatusCode -ne 401) { throw '过期播放凭据没有拒绝' }
    $metrics = Invoke-RestMethod "$media/v1/metrics" -Headers $headers -TimeoutSec 3 -NoProxy
    if ($metrics.delivery.active_bodies -ne 0) { throw '授权媒体响应体没有回收' }
    $result = [ordered]@{
        schema='playback-access-process-contract-v1'
        api_process_id=$started[0].Process.Id
        media_process_id=$started[1].Process.Id
        decoded_records=$records.Count
        service_headers_used_for_media=$false
        anonymous_internal_media_status=[int]$legacy.StatusCode
        expired_grant_status=[int]$expired.StatusCode
        delivery=$metrics.delivery
        process_cleanup_completed=$false
        scope='同机两个独立Rust服务进程和FFmpeg；非物理多机、移动原生SDK或用户登录验证'
    }
} finally {
    foreach ($entry in $started) {
        $process = $entry.Process
        if (!$process.HasExited) { $process.Kill() }
        if (!$process.WaitForExit(5000)) { throw '授权实验进程没有退出' }
        $entry.Stdout.GetAwaiter().GetResult() | Out-File (Join-Path $OutputRoot "$($entry.Role).stdout.log") -Encoding utf8
        $entry.Stderr.GetAwaiter().GetResult() | Out-File (Join-Path $OutputRoot "$($entry.Role).stderr.log") -Encoding utf8
        $process.Dispose()
    }
}
$result.process_cleanup_completed = $true
$result | ConvertTo-Json -Depth 8 | Out-File (Join-Path $OutputRoot 'receipt.json') -Encoding utf8
$result | ConvertTo-Json -Depth 8
