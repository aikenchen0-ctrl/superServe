param(
    [string]$ToolRoot = 'O:\CodexVideoBuild\linux-cross'
)
$ErrorActionPreference = 'Stop'
. 'D:\CodexVideoTools\enter.ps1'
$root = [IO.Path]::GetFullPath($ToolRoot)
if (!$root.StartsWith('O:\',[StringComparison]::OrdinalIgnoreCase) -or $root -match '\s') {
    throw '独立交叉工具及构建目录须位于O盘且不含空白'
}
if ((Get-PSDrive O).Free -lt 2GB) { throw 'O盘低于2GiB构建保护线' }
$sysroot = Join-Path $root 'rust-std-1.96.0-x86_64-unknown-linux-gnu/rust-std-x86_64-unknown-linux-gnu'
foreach ($file in @('cargo-zigbuild/cargo-zigbuild.exe','zig-x86_64-windows-0.15.2/zig.exe')) {
    if (!(Test-Path -LiteralPath (Join-Path $root $file) -PathType Leaf)) { throw "缺少固定构建工具：$file" }
}
if (!(Test-Path -LiteralPath (Join-Path $sysroot 'lib/rustlib/x86_64-unknown-linux-gnu/lib'))) {
    throw '缺少O盘Linux标准库sysroot；本脚本不安装或下载工具'
}
$lock = (Get-FileHash -LiteralPath 'vedioServer/Cargo.lock').Hash
$env:CARGO_BUILD_JOBS = '1'
$env:CARGO_TARGET_DIR = Join-Path $root 'target'
$env:CARGO_ZIGBUILD_ZIG_PATH = Join-Path $root 'zig-x86_64-windows-0.15.2/zig.exe'
$env:CARGO_ZIGBUILD_CACHE_DIR = Join-Path $root 'wrappers'
$env:ZIG_GLOBAL_CACHE_DIR = Join-Path $root 'zig-cache'
$env:ZIG_LOCAL_CACHE_DIR = Join-Path $root 'zig-local-cache'
$env:CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS = "--sysroot $sysroot"
$env:PATH = (Join-Path $root 'cargo-zigbuild')+';'+(Join-Path $root 'zig-x86_64-windows-0.15.2')+';'+$env:PATH
cargo zigbuild --manifest-path vedioServer/Cargo.toml -p vs-service --bin vs-service --test processes `
    --target x86_64-unknown-linux-gnu.2.36 --locked --offline `
    --config 'source.crates-io.replace-with="video-rsproxy"' `
    --config 'source.video-rsproxy.registry="sparse+https://rsproxy.cn/index/"'
if ($LASTEXITCODE -ne 0) { throw 'Linux交叉构建失败；不自动下载、切换target或回退C盘' }
if ((Get-FileHash -LiteralPath 'vedioServer/Cargo.lock').Hash -cne $lock) { throw '业务锁文件意外改变' }
$binary = Join-Path $env:CARGO_TARGET_DIR 'x86_64-unknown-linux-gnu/debug/vs-service'
[pscustomobject]@{
    schema='linux-service-cross-build-v1'
    service=$binary
    sha256=(Get-FileHash -LiteralPath $binary).Hash.ToLowerInvariant()
    cargo_lock_sha256=$lock.ToLowerInvariant()
    linux_executed=$false
} | ConvertTo-Json
