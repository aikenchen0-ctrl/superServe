param(
    [Parameter(Mandatory)][string]$InputsManifest,
    [Parameter(Mandatory)][string]$KotlinHome,
    [Parameter(Mandatory)][string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
. 'D:\CodexVideoTools\enter.ps1'
$root = (Get-Location).Path
$out = [IO.Path]::GetFullPath($OutputDirectory)
$manifest = [IO.Path]::GetFullPath($InputsManifest)
$kotlin = [IO.Path]::GetFullPath($KotlinHome)

if (!$out.StartsWith("$root\.artifacts\", [StringComparison]::OrdinalIgnoreCase) -or
    (Test-Path -LiteralPath $out) -or
    !$manifest.StartsWith('O:\', [StringComparison]::OrdinalIgnoreCase) -or
    !$kotlin.StartsWith('C:\', [StringComparison]::OrdinalIgnoreCase)) {
    throw '验证须使用O盘新证据目录、O盘固定依赖清单和本机只读Kotlin工具链'
}
if ((Get-PSDrive O).Free -lt 1GB) { throw 'O盘低于1GiB保护线' }

$inputs = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
if ($inputs.schema -ne 'media3-consumer-inputs-v1' -or
    !$inputs.jna.path -or !$inputs.jna.sha256) {
    throw 'Media3输入清单缺少固定JNA身份'
}
$null = New-Item -ItemType Directory -Path $out
$nativeOutput = Join-Path $out 'native'
$consumerOutput = Join-Path $out 'media3'
$nativeVerifier = Join-Path $PSScriptRoot '..\verify.ps1'
$consumerVerifier = Join-Path $PSScriptRoot 'verify.ps1'

$env:CARGO_BUILD_JOBS = '1'
& $nativeVerifier `
    -OutputDirectory $nativeOutput `
    -KotlinCompiler (Join-Path $kotlin 'bin\kotlinc.bat') `
    -JnaJar $inputs.jna.path `
    -JnaSha256 $inputs.jna.sha256
if ($LASTEXITCODE -ne 0) { throw '当前Rust源码的UniFFI生成或宿主验收失败' }

& $consumerVerifier `
    -InputsManifest $manifest `
    -GeneratedDirectory (Join-Path $nativeOutput 'generated') `
    -KotlinHome $kotlin `
    -OutputDirectory $consumerOutput
if ($LASTEXITCODE -ne 0) { throw 'Media3当前消费者验收失败' }

$nativeReceiptPath = Join-Path $nativeOutput 'receipt.json'
$consumerReceiptPath = Join-Path $consumerOutput 'receipt.json'
$nativeReceipt = Get-Content -LiteralPath $nativeReceiptPath -Raw | ConvertFrom-Json
$consumerReceipt = Get-Content -LiteralPath $consumerReceiptPath -Raw | ConvertFrom-Json
if (!$nativeReceipt.passed -or !$consumerReceipt.passed -or
    $nativeReceipt.library_sha256 -cne $consumerReceipt.library_sha256) {
    throw '绑定和消费者使用的Rust库摘要不一致'
}

[ordered]@{
    schema = 'current-native-media3-consumer-v1'
    passed = $true
    generated_from_current_native_source = $true
    native_binding_receipt = 'native/receipt.json'
    media3_consumer_receipt = 'media3/receipt.json'
    rust_library_sha256 = $nativeReceipt.library_sha256
    consumer_jar_sha256 = $consumerReceipt.consumer_jar_sha256
    media3_scenario_groups = $consumerReceipt.scenario_groups
    android_device_or_network_verified = $false
    scope = '固定UniFFI生成物、Windows宿主绑定调用及Media3发布类；不代表Android设备网络或真机播放'
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $out 'receipt.json') -Encoding utf8NoBOM

Get-Content -LiteralPath (Join-Path $out 'receipt.json') -Raw
