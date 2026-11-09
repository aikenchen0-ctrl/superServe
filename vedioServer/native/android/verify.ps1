param(
    [Parameter(Mandatory)][string]$InputsManifest,
    [Parameter(Mandatory)][string]$GeneratedDirectory,
    [Parameter(Mandatory)][string]$KotlinHome,
    [Parameter(Mandatory)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
. 'D:\CodexVideoTools\enter.ps1'
$root = (Get-Location).Path
$out = [IO.Path]::GetFullPath($OutputDirectory)
$generated = [IO.Path]::GetFullPath($GeneratedDirectory)
if (!$out.StartsWith("$root\.artifacts\", [StringComparison]::OrdinalIgnoreCase) -or
    (Test-Path -LiteralPath $out) -or
    !$generated.StartsWith('O:\', [StringComparison]::OrdinalIgnoreCase)) {
    throw '消费者验收须使用O盘生成绑定及当前工作区.artifacts下的新输出目录'
}
if ((Get-PSDrive O).Free -lt 512MB) { throw 'O盘低于512MiB保护线' }
$inputs = Get-Content -LiteralPath $InputsManifest -Raw | ConvertFrom-Json
if ($inputs.schema -ne 'media3-consumer-inputs-v1') { throw '消费者输入清单版本无效' }
$names = @('exoplayer','common','jna','guava','android')
$classPath = @()
foreach ($name in $names) {
    $entry = $inputs.$name
    if (!$entry -or ![IO.Path]::IsPathFullyQualified($entry.path) -or
        ($name -ne 'android' -and !$entry.path.StartsWith('O:\', [StringComparison]::OrdinalIgnoreCase)) -or
        (Get-FileHash -LiteralPath $entry.path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256) {
        throw "消费者输入缺失或摘要错误：$name"
    }
    $classPath += $entry.path
}
$binding = Join-Path $generated 'org/superserve/playback/vs_playback_native.kt'
$library = Join-Path $generated 'vs_playback_native.dll'
$compiler = Join-Path $KotlinHome 'lib/kotlin-compiler.jar'
foreach ($path in @($binding,$library,$compiler)) {
    if (!(Test-Path -LiteralPath $path -PathType Leaf)) { throw '缺少生成绑定、同版宿主库或Kotlin编译器' }
}
$null = New-Item -ItemType Directory -Path $out
$source = Join-Path $PSScriptRoot 'src/org/superserve/playback/media3/RustTimeLoadControl.kt'
$test = Join-Path $PSScriptRoot 'tests/VerifyMedia3.kt'
$classpathArgument = $classPath -join ';'
# 直接调用编译器主类，避免Windows批处理把分号分隔的classpath拆成源文件。
& java -classpath "$KotlinHome/lib/*" org.jetbrains.kotlin.cli.jvm.K2JVMCompiler `
    -kotlin-home $KotlinHome $binding $source -classpath $classpathArgument `
    -d (Join-Path $out 'consumer.jar') 2>&1 |
    Tee-Object -FilePath (Join-Path $out 'compile.log')
if ($LASTEXITCODE -ne 0) { throw '真实Media3消费者发布接口编译失败' }
& java -classpath "$KotlinHome/lib/*" org.jetbrains.kotlin.cli.jvm.K2JVMCompiler `
    -kotlin-home $KotlinHome $binding $source $test -classpath $classpathArgument `
    -include-runtime -d (Join-Path $out 'consumer-test.jar') 2>&1 |
    Tee-Object -FilePath (Join-Path $out 'test-compile.log')
if ($LASTEXITCODE -ne 0) { throw '真实Media3消费者测试编译失败' }
$lines = @(& java '--enable-native-access=ALL-UNNAMED' "-Djna.library.path=$generated" `
    "-Djava.io.tmpdir=$env:TEMP" -classpath "$out/consumer-test.jar;$classpathArgument" `
    org.superserve.playback.media3.VerifyMedia3Kt 2>&1)
$code = $LASTEXITCODE
$lines | Set-Content -LiteralPath (Join-Path $out 'run.log') -Encoding utf8NoBOM
if ($code -ne 0) { throw 'Media3真实类至Rust的宿主调用失败' }
$receipts = @($lines | Where-Object { $_ -match '^\{"schema":"media3-native-time-consumer-v1"' })
if ($receipts.Count -ne 1) { throw '缺少唯一消费者回执' }
$receipt = $receipts[0] | ConvertFrom-Json
if (!$receipt.passed -or !$receipt.actual_default_load_control -or !$receipt.actual_rust_dll -or
    $receipt.scenario_groups -ne 13 -or $receipt.android_player_or_device_verified) {
    throw '消费者回执不符合当前宿主范围'
}
$receipt | Add-Member -NotePropertyName library_sha256 `
    -NotePropertyValue (Get-FileHash -LiteralPath $library).Hash.ToLowerInvariant()
$receipt | Add-Member -NotePropertyName consumer_jar_sha256 `
    -NotePropertyValue (Get-FileHash -LiteralPath (Join-Path $out 'consumer.jar')).Hash.ToLowerInvariant()
$receipt | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $out 'receipt.json') -Encoding utf8NoBOM
Get-Content -LiteralPath (Join-Path $out 'receipt.json') -Raw
