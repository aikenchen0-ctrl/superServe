param(
    [Parameter(Mandatory)][string]$Sysroot,
    [Parameter(Mandatory)][string]$NdkRoot,
    [Parameter(Mandatory)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
. 'D:\CodexVideoTools\enter.ps1'
$sysrootPath = [IO.Path]::GetFullPath($Sysroot)
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (!$sysrootPath.StartsWith('O:\', [StringComparison]::OrdinalIgnoreCase) -or
    $sysrootPath -match '\s' -or !$output.StartsWith('O:\', [StringComparison]::OrdinalIgnoreCase) -or
    (Test-Path -LiteralPath $output)) { throw 'sysroot须在O盘无空白路径，输出须为O盘新目录' }
if ((Get-PSDrive O).Free -lt 1GB) { throw 'O盘低于1GiB构建保护线' }
if (!(Test-Path -LiteralPath (Join-Path $sysrootPath 'lib/rustlib/aarch64-linux-android/lib'))) {
    throw '缺少与当前Rust编译器配对的Android标准库；本脚本不安装目标'
}
$toolchain = Join-Path $NdkRoot 'toolchains/llvm/prebuilt/windows-x86_64/bin'
$linker = Join-Path $toolchain 'aarch64-linux-android24-clang.cmd'
$readelf = Join-Path $toolchain 'llvm-readelf.exe'
if (!(Test-Path -LiteralPath $linker) -or !(Test-Path -LiteralPath $readelf)) {
    throw '缺少Android NDK arm64/API24链接器和ELF检查工具'
}
$null = New-Item -ItemType Directory -Path $output
$env:CARGO_BUILD_JOBS = '1'
$env:CARGO_TARGET_DIR = 'O:\CodexVideoBuild\native-cross\target'
$env:CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER = $linker
$env:CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS = "--sysroot $sysrootPath"
& cargo build --manifest-path (Join-Path $PSScriptRoot 'Cargo.toml') --lib --target aarch64-linux-android `
    --locked --offline --config 'source.crates-io.replace-with="video-rsproxy"' `
    --config 'source.video-rsproxy.registry="sparse+https://rsproxy.cn/index/"' `
    2>&1 | Tee-Object -FilePath (Join-Path $output 'build.log')
if ($LASTEXITCODE -ne 0) { throw 'Android交叉构建失败，不以宿主库替代' }
$library = Join-Path $env:CARGO_TARGET_DIR 'aarch64-linux-android/debug/libvs_playback_native.so'
& $readelf -h -d $library | Set-Content -LiteralPath (Join-Path $output 'elf.txt') -Encoding utf8NoBOM
if ($LASTEXITCODE -ne 0) { throw 'Android ELF读取失败' }
& $readelf -l $library | Set-Content -LiteralPath (Join-Path $output 'segments.txt') -Encoding utf8NoBOM
if ($LASTEXITCODE -ne 0) { throw 'Android ELF加载段读取失败' }
$header = Get-Content -LiteralPath (Join-Path $output 'elf.txt') -Raw
$loads = @(Get-Content -LiteralPath (Join-Path $output 'segments.txt') |
    Where-Object { $_ -match '^\s*LOAD\s' })
if ($header -notmatch 'Machine:\s+AArch64' -or $header -notmatch 'Type:\s+DYN' -or
    $loads.Count -eq 0 -or @($loads | Where-Object { $_ -notmatch '0x4000\s*$' }).Count -ne 0) {
    throw 'Android制品不是预期AArch64动态库或加载段不是16KiB对齐'
}
Copy-Item -LiteralPath $library -Destination (Join-Path $output 'libvs_playback_native.so')
[ordered]@{
    schema='native-android-cross-build-v1';passed=$true;target='aarch64-linux-android';api_level=24
    library_sha256=(Get-FileHash -LiteralPath $library).Hash.ToLowerInvariant()
    bytes=(Get-Item -LiteralPath $library).Length
    load_segment_alignment_bytes=16384
    android_runtime_or_device_verified=$false;performance_claimed=$false
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'receipt.json') -Encoding utf8NoBOM
Get-Content -LiteralPath (Join-Path $output 'receipt.json') -Raw
