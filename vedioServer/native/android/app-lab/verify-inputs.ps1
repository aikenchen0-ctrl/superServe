param(
    [Parameter(Mandatory)][string]$InputsManifest,
    [Parameter(Mandatory)][string]$ExistingBuild,
    [Parameter(Mandatory)][string]$KotlinHome,
    [Parameter(Mandatory)][string]$OldBuildTools,
    [Parameter(Mandatory)][string]$Adb,
    [Parameter(Mandatory)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
. 'D:\CodexVideoTools\enter.ps1'
$root = (Get-Location).Path
$out = [IO.Path]::GetFullPath($OutputDirectory)
if (!$out.StartsWith("$root\.artifacts\",[StringComparison]::OrdinalIgnoreCase) -or
    (Test-Path -LiteralPath $out)) { throw '反例验证须使用新的工作区证据目录' }
$null = New-Item -ItemType Directory -Path $out
$build = Join-Path $PSScriptRoot 'build.ps1'
$arguments = @{KotlinHome=$KotlinHome; BuildTools=$OldBuildTools}
function Expect-Error([scriptblock]$Action, [string]$Expected) {
    $rejected = $false
    try { & $Action } catch {
        if (!$_.Exception.Message.Contains($Expected)) { throw }
        $rejected = $true
    }
    if (!$rejected) { throw '无效实验输入未被拒绝' }
}
$apk = Join-Path $ExistingBuild 'playback-lab.apk'
$apkHash = (Get-FileHash -LiteralPath $apk).Hash.ToLowerInvariant()
Expect-Error { & $build @arguments -InputsManifest $InputsManifest -OutputDirectory $ExistingBuild } '新目录'
if ((Get-FileHash -LiteralPath $apk).Hash.ToLowerInvariant() -ne $apkHash) { throw '原APK被改变' }
$oldOut = Join-Path $out 'old-d8'
Expect-Error { & $build @arguments -InputsManifest $InputsManifest -OutputDirectory $oldOut } '8.6.17'
if (Test-Path -LiteralPath $oldOut) { throw '旧D8仍产生输出' }
$modified = Get-Content -LiteralPath $InputsManifest -Raw | ConvertFrom-Json
$modified.resources[0].files[0].sha256 = '0' * 64
$modifiedPath = Join-Path $out 'invalid-resource.json'
$modified | ConvertTo-Json -Depth 12 |
    Set-Content -LiteralPath $modifiedPath -Encoding utf8NoBOM
$invalidOut = Join-Path $out 'invalid-resource'
Expect-Error { & $build @arguments -InputsManifest $modifiedPath -OutputDirectory $invalidOut } '资源路径或摘要'
if (Test-Path -LiteralPath $invalidOut) { throw '错误资源仍产生输出' }
$lease = Join-Path $out 'expired-lease.json'
@{serial='not-a-real-device';status='active';expires_at='2000-01-01T00:00:00Z'} |
    ConvertTo-Json | Set-Content -LiteralPath $lease -Encoding utf8NoBOM
$deviceOut = Join-Path $out 'expired-lease'
Expect-Error {
    & (Join-Path $PSScriptRoot 'run-device.ps1') -Serial 'not-a-real-device' -Apk $apk `
        -ApkSha256 $apkHash -Adb $Adb -LeaseRecord $lease -OutputDirectory $deviceOut
} '有效独占租约'
if (Test-Path -LiteralPath $deviceOut) { throw '过期租约仍产生设备输出' }
[ordered]@{
    schema='android-player-input-rejections-v1';passed=$true;cases=4
    original_apk_unchanged=$true;old_d8_rejected=$true;resource_hash_rejected=$true
    expired_lease_rejected_before_adb=$true;device_access_performed=$false
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $out 'receipt.json') -Encoding utf8NoBOM
Get-Content -LiteralPath (Join-Path $out 'receipt.json') -Raw
