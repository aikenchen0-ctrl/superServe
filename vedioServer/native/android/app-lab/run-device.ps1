param(
    [Parameter(Mandatory)][string]$Serial,
    [Parameter(Mandatory)][string]$Apk,
    [Parameter(Mandatory)][string]$ApkSha256,
    [Parameter(Mandatory)][string]$Adb,
    [Parameter(Mandatory)][string]$LeaseRecord,
    [Parameter(Mandatory)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
. 'D:\CodexVideoTools\enter.ps1'
$root = (Get-Location).Path
$out = [IO.Path]::GetFullPath($OutputDirectory)
if (!$out.StartsWith("$root\.artifacts\",[StringComparison]::OrdinalIgnoreCase) -or
    (Test-Path -LiteralPath $out) -or
    (Get-FileHash -LiteralPath $Apk).Hash.ToLowerInvariant() -ne $ApkSha256.ToLowerInvariant()) {
    throw '设备实验输出或APK固定摘要无效'
}
$package = 'org.superserve.playback.lab'
$lease = Get-Content -LiteralPath $LeaseRecord -Raw | ConvertFrom-Json
if ($lease.serial -ne $Serial -or $lease.status -ne 'active' -or
    [DateTimeOffset]::Parse($lease.expires_at) -le [DateTimeOffset]::UtcNow.AddSeconds(90)) {
    throw '需要当前设备至少还有90秒的有效独占租约；由调用方负责释放'
}
$lease = $null
$existing = @(& $Adb -s $Serial shell pm path $package)
if ($existing -match '^package:') { throw '设备已有同包名应用，拒绝覆盖或卸载' }
$null = New-Item -ItemType Directory -Path $out
$installed = $false
$receipts = @()
function Capture-Screen([string]$Path) {
    $start = [Diagnostics.ProcessStartInfo]::new($Adb)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($value in @('-s',$Serial,'exec-out','screencap','-p')) { $start.ArgumentList.Add($value) }
    $process = [Diagnostics.Process]::Start($start)
    $errorTask = $process.StandardError.ReadToEndAsync()
    $file = [IO.File]::Open($Path,[IO.FileMode]::CreateNew)
    try {
        $process.StandardOutput.BaseStream.CopyTo($file)
        if (!$process.WaitForExit(10000) -or $process.ExitCode -ne 0) { throw '设备截图失败' }
        $null = $errorTask.GetAwaiter().GetResult()
    } finally { $file.Dispose(); $process.Dispose() }
}
try {
    & $Adb -s $Serial install -t $Apk 2>&1 |
        Tee-Object -FilePath (Join-Path $out 'install.log')
    if ($LASTEXITCODE -ne 0) {
        $stillAbsent = @(& $Adb -s $Serial shell pm path $package)
        $running = @(& $Adb -s $Serial shell pidof $package)
        [ordered]@{
            schema='android-player-install-not-completed-v1';device_run_verified=$false
            package_absent=!($stillAbsent -match '^package:');process_absent=!($running -match '^\d')
            automatic_retry=$false;system_settings_changed=$false
        } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $out 'installation-failed.json') -Encoding utf8NoBOM
        throw '实验APK安装失败，不重试或绕过设备安装保护'
    }
    $installed = $true
    foreach ($mode in @('baseline','rust')) {
        $runId = "$mode-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
        & $Adb -s $Serial shell am start -W -n "$package/.PlaybackLabActivity" `
            --es run_id $runId --es mode $mode 2>&1 |
            Set-Content -LiteralPath (Join-Path $out "$mode-start.log") -Encoding utf8NoBOM
        if ($LASTEXITCODE -ne 0) { throw '实验Activity启动失败' }
        Start-Sleep -Milliseconds 1500
        Capture-Screen (Join-Path $out "$mode-screen.png")
        $deadline = (Get-Date).AddSeconds(30)
        do {
            $raw = @(& $Adb -s $Serial shell run-as $package cat "files/$runId.json" 2>$null) -join "`n"
            if ($LASTEXITCODE -eq 0 -and $raw.StartsWith('{')) { break }
            if ((Get-Date) -gt $deadline) { throw '真机未返回有界实验收据' }
            Start-Sleep -Milliseconds 250
        } while ($true)
        $raw | Set-Content -LiteralPath (Join-Path $out "$mode-result.json") -Encoding utf8NoBOM
        $receipt = $raw | ConvertFrom-Json
        if ($receipt.schema -ne 'android-player-device-v1' -or $receipt.mode -ne $mode) {
            throw '真机收据身份无效'
        }
        $receipts += $receipt
        if (!$receipt.passed) {
            $pidText = @(& $Adb -s $Serial shell pidof $package) -join ''
            if ($pidText -match '^\d+$') {
                & $Adb -s $Serial logcat -d "--pid=$pidText" -t 200 |
                    Set-Content -LiteralPath (Join-Path $out "$mode-process.log") -Encoding utf8NoBOM
            }
            throw '真机播放未通过，保留本包结果及有限进程日志'
        }
        & $Adb -s $Serial shell am force-stop $package
        if ($LASTEXITCODE -ne 0) { throw '实验模式之间无法回收本应用进程' }
    }
    [ordered]@{
        schema='android-player-device-run-v1';passed=$true
        apk_sha256=$ApkSha256;results=$receipts
        local_asset_only=$true;network_or_three_low_verified=$false
    } | ConvertTo-Json -Depth 8 |
        Set-Content -LiteralPath (Join-Path $out 'receipt.json') -Encoding utf8NoBOM
} finally {
    if ($installed) {
        & $Adb -s $Serial shell am force-stop $package
        & $Adb -s $Serial uninstall $package 2>&1 |
            Set-Content -LiteralPath (Join-Path $out 'uninstall.log') -Encoding utf8NoBOM
        $uninstallCode = $LASTEXITCODE
        $remaining = @(& $Adb -s $Serial shell pm path $package)
        $process = @(& $Adb -s $Serial shell pidof $package)
        $cleaned = $uninstallCode -eq 0 -and !($remaining -match '^package:') -and
            !($process -match '^\d')
        [ordered]@{
            schema='android-player-device-cleanup-v1';package_removed=$cleaned
            only_lab_package_changed=$true;system_settings_changed=$false
        } | ConvertTo-Json |
            Set-Content -LiteralPath (Join-Path $out 'cleanup.json') -Encoding utf8NoBOM
        if (!$cleaned) { throw '实验应用尚未确认清理，不能报告完成' }
    }
}
Get-Content -LiteralPath (Join-Path $out 'receipt.json') -Raw
