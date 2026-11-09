param(
    [Parameter(Mandatory)][string]$WasmBindgen,
    [Parameter(Mandatory)][string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
. 'D:/CodexVideoTools/enter.ps1' -KeepLocation
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$resolvedOutput = [IO.Path]::GetFullPath($OutputDirectory)
if ($resolvedOutput.StartsWith('C:', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Wasm产物目录必须位于非C盘'
}
if (Test-Path -LiteralPath $resolvedOutput) { throw 'Wasm产物目录必须尚不存在' }
$toolVersion = & $WasmBindgen --version
if ($LASTEXITCODE -ne 0 -or $toolVersion.Trim() -ne 'wasm-bindgen 0.2.130') {
    throw '绑定工具必须为wasm-bindgen 0.2.130，与Cargo固定版本一致'
}
Push-Location -LiteralPath $workspace
try {
    & cargo build --config 'source.crates-io.replace-with="rsproxy"' `
        --config 'source.rsproxy.registry="sparse+https://rsproxy.cn/index/"' `
        --offline --locked -p vs-playback-web --target wasm32-unknown-unknown --release
    if ($LASTEXITCODE -ne 0) { throw 'Rust WebAssembly构建失败' }
    $null = New-Item -ItemType Directory -Path $resolvedOutput
    $inputModule = Join-Path $env:CARGO_TARGET_DIR 'wasm32-unknown-unknown/release/vs_playback_web.wasm'
    & $WasmBindgen $inputModule --out-dir $resolvedOutput --out-name playback --target web --no-typescript
    if ($LASTEXITCODE -ne 0) { throw 'WebAssembly公开绑定生成失败' }
    Get-ChildItem -LiteralPath $resolvedOutput -File | ForEach-Object {
        [pscustomobject]@{
            文件 = $_.FullName
            字节 = $_.Length
            指纹 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
} finally {
    Pop-Location
}
