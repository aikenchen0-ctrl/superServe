param(
    [Parameter(Mandatory)][string]$OutputDirectory,
    [string]$KotlinCompiler,
    [string]$JnaJar,
    [string]$JnaSha256
)
$ErrorActionPreference = 'Stop'
. 'D:\CodexVideoTools\enter.ps1'
$root = (Get-Location).Path
$out = [IO.Path]::GetFullPath($OutputDirectory)
if (!$out.StartsWith("$root\.artifacts\", [StringComparison]::OrdinalIgnoreCase) -or
    (Test-Path -LiteralPath $out)) { throw '绑定验收须使用当前工作区.artifacts下的新目录' }
if ((Get-PSDrive O).Free -lt 1GB) { throw 'O盘低于1GiB保护线' }
if ([bool]$KotlinCompiler -ne [bool]$JnaJar -or [bool]$JnaJar -ne [bool]$JnaSha256) {
    throw 'Kotlin验收须同时指定编译器、JNA文件和固定SHA256'
}
$null = New-Item -ItemType Directory -Path $out
$env:CARGO_BUILD_JOBS = '1'
$cache = @('--locked','--offline','--config','source.crates-io.replace-with="video-rsproxy"',
    '--config','source.video-rsproxy.registry="sparse+https://rsproxy.cn/index/"')
$manifest = Join-Path $PSScriptRoot 'Cargo.toml'
$serverLock = (Get-FileHash -LiteralPath 'vedioServer/Cargo.lock').Hash
& cargo build --manifest-path $manifest --lib --bin playback-bindgen --features bindgen @cache `
    2>&1 | Tee-Object -FilePath (Join-Path $out 'build.log')
if ($LASTEXITCODE -ne 0) { throw '绑定构建失败，不自动下载或升级依赖' }
& cargo test --manifest-path $manifest --lib @cache `
    2>&1 | Tee-Object -FilePath (Join-Path $out 'rust.log')
if ($LASTEXITCODE -ne 0) { throw '绑定Rust回归失败' }
$generator = Join-Path $env:CARGO_TARGET_DIR 'debug/playback-bindgen.exe'
$library = Join-Path $env:CARGO_TARGET_DIR 'debug/vs_playback_native.dll'
$generated = Join-Path $out 'generated'
& $generator generate $library --language kotlin --language swift --language python `
    --config (Join-Path $PSScriptRoot 'bindings.toml') --out-dir $generated --no-format `
    2>&1 | Tee-Object -FilePath (Join-Path $out 'generate.log')
if ($LASTEXITCODE -ne 0) { throw '外语生成失败' }
Copy-Item -LiteralPath $library -Destination (Join-Path $generated 'vs_playback_native.dll')
$oldPython = $env:PYTHONDONTWRITEBYTECODE
try {
    $env:PYTHONDONTWRITEBYTECODE = '1'
    & python (Join-Path $PSScriptRoot 'tests/verify_binding.py') $generated `
        2>&1 | Tee-Object -FilePath (Join-Path $out 'python.log')
    if ($LASTEXITCODE -ne 0) { throw '实际Python绑定调用失败' }
} finally { $env:PYTHONDONTWRITEBYTECODE = $oldPython }
if ($KotlinCompiler) {
    if (!(Test-Path -LiteralPath $KotlinCompiler -PathType Leaf) -or
        !(Test-Path -LiteralPath $JnaJar -PathType Leaf) -or
        !$JnaJar.StartsWith('O:\', [StringComparison]::OrdinalIgnoreCase) -or
        (Get-FileHash -LiteralPath $JnaJar).Hash.ToLowerInvariant() -ne $JnaSha256.ToLowerInvariant()) {
        throw 'Kotlin编译器或O盘JNA输入与固定摘要不符'
    }
    $jar = Join-Path $out 'binding-test.jar'
    & $KotlinCompiler (Join-Path $generated 'org/superserve/playback/vs_playback_native.kt') `
        (Join-Path $PSScriptRoot 'tests/VerifyBinding.kt') -classpath $JnaJar -include-runtime -d $jar `
        2>&1 | Tee-Object -FilePath (Join-Path $out 'kotlin-build.log')
    if ($LASTEXITCODE -ne 0) { throw 'Kotlin编译失败' }
    & java "--enable-native-access=ALL-UNNAMED" "-Djna.library.path=$generated" `
        "-Djava.io.tmpdir=$env:TEMP" -classpath "$jar;$JnaJar" VerifyBindingKt `
        2>&1 | Tee-Object -FilePath (Join-Path $out 'kotlin-run.log')
    if ($LASTEXITCODE -ne 0) { throw '实际Kotlin绑定调用失败' }
}
if ((Get-FileHash -LiteralPath 'vedioServer/Cargo.lock').Hash -cne $serverLock) {
    throw '服务端锁文件发生意外变化'
}
[ordered]@{
    schema='native-binding-host-verification-v1';passed=$true
    rust_tests=$true;python_dll_invocation=$true;kotlin_jvm_invocation=[bool]$KotlinCompiler
    swift_generated_only=$true;android_ios_devices_verified=$false
    server_lock_unchanged=$true
    library_sha256=(Get-FileHash -LiteralPath $library).Hash.ToLowerInvariant()
    native_lock_sha256=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'Cargo.lock')).Hash.ToLowerInvariant()
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $out 'receipt.json') -Encoding utf8NoBOM
Get-Content -LiteralPath (Join-Path $out 'receipt.json') -Raw
