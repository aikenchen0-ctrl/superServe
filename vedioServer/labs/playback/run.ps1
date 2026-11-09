param(
    [Parameter(Mandatory)][string]$InputVideo,
    [string]$TargetDirectory = $env:CARGO_TARGET_DIR,
    [ValidateRange(0, 65535)][int]$Port = 0,
    [ValidateRange(0, 65535)][int]$LivePort = 0,
    [string]$OutputRoot
)

$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
if (!$TargetDirectory) { $TargetDirectory = Join-Path $workspace 'target' }
$executable = Join-Path $TargetDirectory 'debug/examples/playback_lab.exe'
if (!(Test-Path -LiteralPath $executable)) {
    throw '请先构建vs-service的playback_lab示例，或指定-TargetDirectory'
}
$source = (Resolve-Path -LiteralPath $InputVideo).Path
if (!$OutputRoot) {
    $OutputRoot = Join-Path (Split-Path -Parent $workspace) (
        '.artifacts/playback/run-' + (Get-Date -Format 'yyyyMMdd-HHmmss') +
        '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
}
if (Test-Path -LiteralPath $OutputRoot) { throw '实验目录必须尚不存在' }
$null = New-Item -ItemType Directory -Path (Join-Path $OutputRoot 'published') -Force
$OutputRoot = (Resolve-Path -LiteralPath $OutputRoot).Path
$stdout = Join-Path $OutputRoot 'stdout.log'
$stderr = Join-Path $OutputRoot 'stderr.log'
$arguments = @(('"' + (Join-Path $OutputRoot 'published') + '"'), ('"' + $source + '"'), "$Port")
if ($LivePort) { $arguments += "$LivePort" }
$process = Start-Process -FilePath $executable -ArgumentList $arguments -WindowStyle Hidden `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
try {
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
        if ($process.HasExited) {
            throw ('播放实验提前退出：' + (Get-Content -LiteralPath $stderr -Raw))
        }
        $text = Get-Content -LiteralPath $stdout -Raw
        if ($text -match 'http://127\.0\.0\.1:\d+') { $url = $Matches[0]; break }
        if ([DateTime]::UtcNow -ge $deadline) { throw '播放实验启动超时' }
        Start-Sleep -Milliseconds 50
    } while ($true)
    $null = Invoke-RestMethod "$url/lab/config" -TimeoutSec 3 -NoProxy
    $receipt = [ordered]@{
        schema = 'browser-playback-launch-v1'
        url = $url
        process_id = $process.Id
        live_hls_port = if ($LivePort) { $LivePort } else { $null }
        source_sha256 = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
        output_root = $OutputRoot
        scope = '本机点播及可选普通HLS直播实验；不提供公网授权、推荐曝光或生产SLO保证'
    }
    $receipt | ConvertTo-Json | Out-File (Join-Path $OutputRoot 'launch.json') -Encoding utf8
    $receipt | ConvertTo-Json
} catch {
    if (!$process.HasExited) { Stop-Process -Id $process.Id -ErrorAction SilentlyContinue }
    throw
}
