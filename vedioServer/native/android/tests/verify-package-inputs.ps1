param(
    [Parameter(Mandatory)][string]$InputsManifest,
    [Parameter(Mandatory)][string]$ExistingOutput,
    [Parameter(Mandatory)][string]$KotlinHome,
    [Parameter(Mandatory)][string]$OldAndroidBuildTools,
    [Parameter(Mandatory)][string]$ReadElf,
    [Parameter(Mandatory)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
. 'D:\CodexVideoTools\enter.ps1'
$root = (Get-Location).Path
$out = [IO.Path]::GetFullPath($OutputDirectory)
if (!$out.StartsWith("$root\.artifacts\",[StringComparison]::OrdinalIgnoreCase) -or
    (Test-Path -LiteralPath $out)) { throw '反例验收需要本工作区.artifacts下的新目录' }
$null = New-Item -ItemType Directory -Path $out
$packager = Join-Path $PSScriptRoot '../package-aar.ps1'
$parameters = @{
    KotlinHome=$KotlinHome; AndroidBuildTools=$OldAndroidBuildTools; ReadElf=$ReadElf
}
function Expect-Failure([string]$Manifest, [string]$Destination, [string]$Message) {
    $rejected = $false
    try { & $packager @parameters -InputsManifest $Manifest -OutputDirectory $Destination }
    catch {
        if (!$_.Exception.Message.Contains($Message)) { throw }
        $rejected = $true
    }
    if (!$rejected) { throw '应拒绝的打包输入被接受' }
}
$aar = Join-Path $ExistingOutput 'superserve-playback-local.aar'
$before = (Get-FileHash -LiteralPath $aar).Hash
Expect-Failure $InputsManifest $ExistingOutput '新目录'
if ((Get-FileHash -LiteralPath $aar).Hash -cne $before) { throw '拒绝覆盖后原制品变化' }
$oldOut = Join-Path $out 'old-d8-rejected'
Expect-Failure $InputsManifest $oldOut '8.6.17'
if (Test-Path -LiteralPath $oldOut) { throw '不兼容D8仍产生输出' }
$changed = Get-Content -LiteralPath $InputsManifest -Raw | ConvertFrom-Json
$changed.files.rust_library.sha256 = '0' * 64
$changedPath = Join-Path $out 'changed-input.json'
$changed | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $changedPath -Encoding utf8NoBOM
$changedOut = Join-Path $out 'changed-hash-rejected'
Expect-Failure $changedPath $changedOut '摘要不符'
if (Test-Path -LiteralPath $changedOut) { throw '错误摘要仍产生输出' }
$changed = Get-Content -LiteralPath $InputsManifest -Raw | ConvertFrom-Json
$changed.files.rust_library.path = $changed.files.host_library.path
$changed.files.rust_library.sha256 = $changed.files.host_library.sha256
$changedPath = Join-Path $out 'host-instead-android.json'
$changed | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $changedPath -Encoding utf8NoBOM
$changedOut = Join-Path $out 'host-replacement-rejected'
Expect-Failure $changedPath $changedOut '交叉构建收据'
if (Test-Path -LiteralPath $changedOut) { throw '宿主库替代仍产生输出' }
[ordered]@{
    schema='android-aar-input-rejections-v1';passed=$true;cases=4
    existing_output_unchanged=$true;old_d8_rejected=$true;tampered_input_rejected=$true
    host_library_instead_android_rejected=$true;rejected_cases_create_no_output=$true
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $out 'receipt.json') -Encoding utf8NoBOM
Get-Content -LiteralPath (Join-Path $out 'receipt.json') -Raw
