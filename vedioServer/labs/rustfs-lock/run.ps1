param(
    [ValidateSet("Baseline", "Patched")]
    [string]$Variant = "Patched",
    [switch]$UpstreamTests,
    [switch]$Offline,
    [string]$RegistryIndex = ""
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "../../..")).Path
$reference = Join-Path $root ".artifacts/upstream/rustfs"
$checkout = Join-Path $root ".artifacts/labs/rustfs-lock-cancel"
$patch = Join-Path $PSScriptRoot "acquisition-cancel.patch"
$fixture = Get-Content -LiteralPath (Join-Path $PSScriptRoot "fixture.json") -Raw | ConvertFrom-Json

function Invoke-GitChecked {
    param([string[]]$GitArgs)
    & git @GitArgs
    if ($LASTEXITCODE -ne 0) { throw "Git 操作失败，退出码：$LASTEXITCODE" }
}

if (-not (Test-Path -LiteralPath $checkout)) {
    if (-not (Test-Path -LiteralPath $reference)) {
        throw "缺少固定参考仓库：$reference；请先按 README 准备参考。"
    }
    Invoke-GitChecked -GitArgs @("clone", "--no-hardlinks", $reference, $checkout)
}
$head = & git -C $checkout rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $head -ne $fixture.revision) {
    throw "实验副本的提交不匹配；不会覆盖现有内容。"
}
$status = @(& git -C $checkout status --porcelain)
if ($LASTEXITCODE -ne 0) { throw "无法检查实验副本状态。" }
foreach ($line in $status) {
    if ($line -ne " M $($fixture.source_path)") {
        throw "实验副本包含未识别的修改：$line"
    }
}
if ((Get-FileHash -LiteralPath $patch -Algorithm SHA256).Hash.ToLowerInvariant() -ne $fixture.patch_sha256) {
    throw "补丁校验值不匹配。"
}
$source = Join-Path $checkout $fixture.source_path
$sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
if ($sourceHash -notin @($fixture.original_sha256, $fixture.patched_sha256)) {
    throw "目标源码包含未识别的修改；不会自动恢复。"
}

# 只切换已识别的本实验补丁，不恢复用户或其他任务的修改。
if ($Variant -eq "Baseline" -and $sourceHash -eq $fixture.patched_sha256) {
    Invoke-GitChecked -GitArgs @("-C", $checkout, "apply", "--reverse", "--check", $patch)
    Invoke-GitChecked -GitArgs @("-C", $checkout, "apply", "--reverse", $patch)
}
if ($Variant -eq "Patched" -and $sourceHash -eq $fixture.original_sha256) {
    Invoke-GitChecked -GitArgs @("-C", $checkout, "apply", "--check", $patch)
    Invoke-GitChecked -GitArgs @("-C", $checkout, "apply", $patch)
}
$actualHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
$expectedHash = if ($Variant -eq "Patched") { $fixture.patched_sha256 } else { $fixture.original_sha256 }
if ($actualHash -ne $expectedHash) { throw "切换后源码校验失败。" }

$compiler = & rustup run $fixture.toolchain rustc --version
if ($LASTEXITCODE -ne 0) { throw "请先安装实验工具链：rustup toolchain install $($fixture.toolchain) --profile minimal" }
$cargoArgs = @("+$($fixture.toolchain)", "test", "--locked")
if ($RegistryIndex) {
    $cargoArgs += @("--config", 'source.crates-io.replace-with="video-sparse"')
    $cargoArgs += @("--config", "source.video-sparse.registry=`"$RegistryIndex`"")
}
if ($Offline) { $cargoArgs += "--offline" }
if ($UpstreamTests) {
    $cargoArgs += @("--manifest-path", (Join-Path $checkout "Cargo.toml"), "-p", "rustfs-lock", "--lib")
    $cargoArgs += @("--target-dir", (Join-Path $PSScriptRoot "target"))
} else {
    $cargoArgs += @("--manifest-path", (Join-Path $PSScriptRoot "Cargo.toml"), "--test", "acquisition_cancel")
}
$suite = if ($UpstreamTests) { "upstream" } else { "cancel" }
$stamp = [DateTimeOffset]::UtcNow.ToString("yyyyMMddTHHmmssfffZ")
$log = Join-Path $root ".artifacts/rustfs-lock-$Variant-$suite-$stamp.log"
& cargo @cargoArgs *> $log
$testCode = $LASTEXITCODE
$receipt = [ordered]@{
    variant = $Variant
    suite = $suite
    upstream_revision = $head
    source_sha256 = $actualHash
    patch_sha256 = $fixture.patch_sha256
    compiler = $compiler
    cargo_arguments = $cargoArgs
    completed_at = [DateTimeOffset]::UtcNow.ToString("o")
    exit_code = $testCode
    log = $log
    log_sha256 = (Get-FileHash -LiteralPath $log -Algorithm SHA256).Hash.ToLowerInvariant()
}
$receipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$log.json" -Encoding utf8
Get-Content -LiteralPath $log -Tail 25
Write-Host "结果收据：$log.json"
# 原版预期失败也保留真实退出码，不将失败实验改记为成功。
exit $testCode
