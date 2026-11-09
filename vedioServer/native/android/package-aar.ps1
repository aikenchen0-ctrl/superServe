param(
    [Parameter(Mandatory)][string]$InputsManifest,
    [Parameter(Mandatory)][string]$KotlinHome,
    [Parameter(Mandatory)][string]$AndroidBuildTools,
    [Parameter(Mandatory)][string]$ReadElf,
    [Parameter(Mandatory)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
. 'D:\CodexVideoTools\enter.ps1'
$root = (Get-Location).Path
$out = [IO.Path]::GetFullPath($OutputDirectory)
if (!$out.StartsWith("$root\.artifacts\", [StringComparison]::OrdinalIgnoreCase) -or
    $out -eq (Join-Path $root '.artifacts') -or
    (Test-Path -LiteralPath $out)) { throw 'AAR草稿须使用当前工作区.artifacts下的新目录' }
if ((Get-PSDrive O).Free -lt 512MB) { throw 'O盘低于512MiB保护线' }
$manifest = Get-Content -LiteralPath $InputsManifest -Raw | ConvertFrom-Json
if ($manifest.schema -ne 'android-aar-inputs-v1' -or
    $manifest.media3_version -ne '1.11.1' -or $manifest.jna_version -ne '5.19.1') {
    throw '固定AAR输入清单版本无效'
}
$required = @('consumer_jar','rust_library','native_receipt','cross_target','generated_kotlin',
    'host_library','jna_aar','jna_android_jar','jna_android_native','jna_host_jar',
    'media3_exoplayer','media3_common','guava','kotlin_stdlib','android_sdk')
$files = @{}
foreach ($name in $required) {
    $inputFile = $manifest.files.$name
    if (!$inputFile -or ![IO.Path]::IsPathFullyQualified($inputFile.path) -or
        ($name -notin @('android_sdk','kotlin_stdlib') -and
            !$inputFile.path.StartsWith('O:\', [StringComparison]::OrdinalIgnoreCase)) -or
        (Get-FileHash -LiteralPath $inputFile.path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $inputFile.sha256) {
        throw "固定AAR输入缺失或摘要不符：$name"
    }
    $files[$name] = $inputFile.path
}
$native = Get-Content -LiteralPath $files.native_receipt -Raw | ConvertFrom-Json
if (!$native.passed -or $native.target -ne 'aarch64-linux-android' -or $native.api_level -ne 24 -or
    $native.library_sha256 -ne $manifest.files.rust_library.sha256) {
    throw 'Rust Android制品与交叉构建收据不匹配'
}
$cross = Get-Content -LiteralPath $files.cross_target -Raw | ConvertFrom-Json
$kotlin = @($cross.files | Where-Object { $_.path -eq 'org\superserve\playback\vs_playback_native.kt' })
if (!$cross.passed -or $kotlin.Count -ne 1 -or
    $kotlin[0].sha256 -ne $manifest.files.generated_kotlin.sha256) {
    throw 'Rust Android制品和生成Kotlin接口缺少一致性证据'
}
foreach ($tool in @($ReadElf,(Join-Path $AndroidBuildTools 'lib/d8.jar'),
    (Join-Path $KotlinHome 'lib/kotlin-compiler.jar'))) {
    if (!(Test-Path -LiteralPath $tool -PathType Leaf)) { throw '缺少固定ELF/DEX/Kotlin工具' }
}
$d8Jar = Join-Path $AndroidBuildTools 'lib/d8.jar'
$d8VersionText = @(& java -classpath $d8Jar com.android.tools.r8.D8 --version 2>&1) -join "`n"
if ($LASTEXITCODE -ne 0 -or $d8VersionText -notmatch '^D8 (\d+\.\d+\.\d+)') {
    throw '无法确认D8版本，不尝试转DEX'
}
$d8Version = $Matches[1]
if ([version]$d8Version -lt [version]'8.6.17') {
    throw 'Kotlin2.1至少需要D8/R8 8.6.17，旧工具成功退出不能代替元数据兼容'
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$null = New-Item -ItemType Directory -Path $out
$jnaExtracted = Join-Path $out 'jna-input'
[IO.Compression.ZipFile]::ExtractToDirectory($files.jna_aar,$jnaExtracted)
if ((Get-FileHash -LiteralPath (Join-Path $jnaExtracted 'classes.jar')).Hash.ToLowerInvariant() -ne
    $manifest.files.jna_android_jar.sha256 -or
    (Get-FileHash -LiteralPath (Join-Path $jnaExtracted 'jni/arm64-v8a/libjnidispatch.so')).Hash.ToLowerInvariant() -ne
    $manifest.files.jna_android_native.sha256) {
    throw 'JNA class和原生库不是同一固定Android AAR的内容'
}
$stage = Join-Path $out 'stage'
$null = New-Item -ItemType Directory -Path $stage
$jni = Join-Path $stage 'jni/arm64-v8a'
$licenses = Join-Path $stage 'META-INF/superserve'
$null = New-Item -ItemType Directory -Force -Path $jni,$licenses
Copy-Item -LiteralPath $files.consumer_jar -Destination (Join-Path $stage 'classes.jar')
Copy-Item -LiteralPath $files.rust_library -Destination (Join-Path $jni 'libvs_playback_native.so')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'aar/AndroidManifest.xml') -Destination $stage
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'aar/consumer-rules.pro') -Destination (Join-Path $stage 'proguard.txt')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'aar/NOTICE.txt') -Destination $licenses
Copy-Item -LiteralPath 'LICENSE' -Destination (Join-Path $licenses 'project-MIT.txt')
foreach ($license in @('vedioServer/native/LICENSE-MPL-2.0','vedioServer/native/NOTICE.txt',
    'vedioServer/LICENSES/media3-Apache-2.0.txt','vedioServer/LICENSES/media3-NOTICE.txt')) {
    $name = if ($license -eq 'vedioServer/native/NOTICE.txt') { 'native-NOTICE.txt' } else { Split-Path $license -Leaf }
    Copy-Item -LiteralPath $license -Destination (Join-Path $licenses $name)
}
# ZIP只含固定项目文件，路径排序和时间固定；不对目录先检查后覆盖旧坐标。
function New-FixedZip([string]$Directory, [string]$Destination) {
    $stream = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew)
    try {
        $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $true)
        try {
            foreach ($path in @(Get-ChildItem -LiteralPath $Directory -Recurse -File | Sort-Object FullName)) {
                $relative = [IO.Path]::GetRelativePath($Directory,$path.FullName).Replace('\','/')
                $entry = $zip.CreateEntry($relative,[IO.Compression.CompressionLevel]::Optimal)
                $entry.LastWriteTime = [DateTimeOffset]::new(2000,1,1,0,0,0,[TimeSpan]::Zero)
                $source = [IO.File]::OpenRead($path.FullName)
                $target = $entry.Open()
                try { $source.CopyTo($target) } finally { $target.Dispose(); $source.Dispose() }
            }
        } finally { $zip.Dispose() }
    } finally { $stream.Dispose() }
}
function Test-Arm64([string]$Library, [string]$Label) {
    $lines = @(& $ReadElf -h -l $Library 2>&1)
    if ($LASTEXITCODE -ne 0) { throw '原生库ELF读取失败' }
    $lines | Set-Content -LiteralPath (Join-Path $out "$Label-elf.txt") -Encoding utf8NoBOM
    $text = $lines -join "`n"
    $loads = @($lines | Where-Object { $_ -match '^\s*LOAD\s' })
    if ($text -notmatch 'Machine:\s+AArch64' -or $text -notmatch 'Type:\s+DYN' -or
        !$loads.Count -or @($loads | Where-Object { $_ -notmatch '0x4000\s*$' }).Count) {
        throw 'Rust或JNA arm64库不符合16KiB加载段边界'
    }
}
Test-Arm64 $files.rust_library 'rust'
Test-Arm64 $files.jna_android_native 'jna'
$aar = Join-Path $out 'superserve-playback-local.aar'
New-FixedZip $stage $aar
$repeat = Join-Path $out 'same-input-check.aar'
New-FixedZip $stage $repeat
if ((Get-FileHash -LiteralPath $aar).Hash -cne (Get-FileHash -LiteralPath $repeat).Hash) {
    throw '同输入AAR封装字节不一致'
}
$unpacked = Join-Path $out 'unpacked'
[IO.Compression.ZipFile]::ExtractToDirectory($aar,$unpacked)
[xml]$androidManifest = Get-Content -LiteralPath (Join-Path $unpacked 'AndroidManifest.xml') -Raw
if ($androidManifest.manifest.package -ne 'org.superserve.playback' -or
    $androidManifest.manifest.'uses-sdk'.GetAttribute('minSdkVersion','http://schemas.android.com/apk/res/android') -ne '24' -or
    $androidManifest.manifest.'uses-permission' -or $androidManifest.manifest.application) {
    throw 'AAR清单意外增加权限或应用入口'
}
if ((Get-FileHash -LiteralPath (Join-Path $unpacked 'classes.jar')).Hash.ToLowerInvariant() -ne
    $manifest.files.consumer_jar.sha256) { throw 'AAR class并非已验消费者' }
$archive = [IO.Compression.ZipFile]::OpenRead((Join-Path $unpacked 'classes.jar'))
try {
    $classNames = @($archive.Entries.FullName)
    foreach ($requiredClass in @('org/superserve/playback/NativeTimeBufferControl.class',
        'org/superserve/playback/NativePlayer.class',
        'org/superserve/playback/media3/RustTimeLoadControl.class')) {
        if ($requiredClass -notin $classNames) { throw 'AAR缺少公开消费者类型' }
    }
    if (@($classNames | Where-Object { $_ -match '^com/sun/jna/|^androidx/media3/|VerifyMedia3|VerifyBinding|\.dll$|\.so$' }).Count) {
        throw 'AAR class意外夹带依赖、测试或宿主原生库'
    }
} finally { $archive.Dispose() }
$cp = @((Join-Path $unpacked 'classes.jar'),$files.media3_exoplayer,$files.media3_common,
    $files.jna_android_jar,$files.guava,$files.android_sdk) -join ';'
& java -classpath "$KotlinHome/lib/*" org.jetbrains.kotlin.cli.jvm.K2JVMCompiler `
    -kotlin-home $KotlinHome (Join-Path $PSScriptRoot 'tests/ConsumePackagedAar.kt') `
    -classpath $cp -d (Join-Path $out 'consumer.jar') 2>&1 |
    Tee-Object -FilePath (Join-Path $out 'consume-compile.log')
if ($LASTEXITCODE -ne 0) { throw '从封装AAR提取的公开接口不可消费' }
$hostDirectory = Join-Path $out 'host'
$null = New-Item -ItemType Directory -Path $hostDirectory
Copy-Item -LiteralPath $files.host_library -Destination (Join-Path $hostDirectory 'vs_playback_native.dll')
$hostClassPath = @((Join-Path $out 'consumer.jar'),(Join-Path $unpacked 'classes.jar'),
    $files.jna_host_jar,$files.kotlin_stdlib,$files.android_sdk,
    $files.media3_exoplayer,$files.media3_common,$files.guava) -join ';'
& java '--enable-native-access=ALL-UNNAMED' "-Djna.library.path=$hostDirectory" `
    "-Djava.io.tmpdir=$env:TEMP" -classpath $hostClassPath `
    org.superserve.playback.consumer.ConsumePackagedAarKt 2>&1 |
    Tee-Object -FilePath (Join-Path $out 'consume-host.log')
if ($LASTEXITCODE -ne 0) { throw '封装class与同版宿主Rust库调用失败' }
$dex = Join-Path $out 'dex'
$null = New-Item -ItemType Directory -Path $dex
$d8Lines = @(& java -Xmx512m "-Djava.io.tmpdir=$env:TEMP" -classpath $d8Jar `
    com.android.tools.r8.D8 --release --min-api 24 --output $dex --lib $files.android_sdk `
    --classpath $files.media3_exoplayer --classpath $files.media3_common --classpath $files.guava `
    (Join-Path $out 'consumer.jar') (Join-Path $unpacked 'classes.jar') `
    $files.jna_android_jar $files.kotlin_stdlib 2>&1)
$d8Exit = $LASTEXITCODE
Set-Content -LiteralPath (Join-Path $out 'd8.log') -Value ($d8Lines -join "`n") -Encoding utf8NoBOM
if ($d8Exit -ne 0 -or ($d8Lines -join "`n") -match 'error occurred when parsing kotlin metadata|Unexpected error.*kotlin.Metadata') {
    throw 'AAR消费者和JNA Android依赖转DEX失败或Kotlin元数据不兼容'
}
$dexFile = Join-Path $dex 'classes.dex'
$bytes = [IO.File]::ReadAllBytes($dexFile)
if ($bytes.Length -lt 112 -or [Text.Encoding]::ASCII.GetString($bytes,0,4) -ne "dex`n") {
    throw 'D8没有产生有效DEX头'
}
$sourceRoot = Join-Path $out 'source-stage'
$null = New-Item -ItemType Directory -Path $sourceRoot
# 当前未提交的真实源码快照，只复制本项目已知目录；不冒称HEAD的可发布制品。
$sourceFiles = @(
    (Get-Item -LiteralPath 'LICENSE'),
    (Get-Item -LiteralPath 'vedioServer/Cargo.toml'),
    (Get-Item -LiteralPath 'vedioServer/Cargo.lock'),
    (Get-Item -LiteralPath 'vedioServer/rust-toolchain.toml'),
    (Get-Item -LiteralPath 'vedioServer/THIRD_PARTY.md'),
    (Get-ChildItem -LiteralPath 'vedioServer/LICENSES' -File),
    (Get-ChildItem -LiteralPath 'vedioServer/crates/vs-core' -Recurse -File),
    (Get-ChildItem -LiteralPath 'vedioServer/native' -Recurse -File)
) | ForEach-Object { $_ }
foreach ($sourceFile in $sourceFiles) {
    $relative = [IO.Path]::GetRelativePath($root,$sourceFile.FullName)
    $destination = Join-Path $sourceRoot $relative
    $null = New-Item -ItemType Directory -Force -Path (Split-Path $destination -Parent)
    Copy-Item -LiteralPath $sourceFile.FullName -Destination $destination
}
New-FixedZip $sourceRoot (Join-Path $out 'sources.zip')
[ordered]@{
    schema='android-aar-dependencies-v1';stage='local-draft-not-published'
    self_artifact='superserve-playback-local.aar';min_sdk=24;abis=@('arm64-v8a')
    dependencies=@(
        @{coordinate='androidx.media3:media3-exoplayer:1.11.1';type='aar';bundled=$false},
        @{coordinate='net.java.dev.jna:jna:5.19.1@aar';type='aar';bundled=$false},
        @{coordinate='org.jetbrains.kotlin:kotlin-stdlib:2.1.21';type='jar';bundled=$false}
    )
    maven_or_gradle_metadata_published=$false;transitive_resolution_tested=$false
    app_must_limit_abis=$true;consumer_rules='proguard.txt';r8_rules_tested=$false
    source_archive='sources.zip';source_checkout_dirty=$true
} | ConvertTo-Json -Depth 6 |
    Set-Content -LiteralPath (Join-Path $out 'dependencies.json') -Encoding utf8NoBOM
Get-Content -LiteralPath (Join-Path $PSScriptRoot 'aar/NOTICE.txt') -Raw |
    Set-Content -LiteralPath (Join-Path $out 'HANDOFF.txt') -Encoding utf8NoBOM
[ordered]@{
    schema='android-aar-local-draft-v1';passed=$true;stage='local-draft-not-published'
    aar_sha256=(Get-FileHash -LiteralPath $aar).Hash.ToLowerInvariant()
    aar_bytes=(Get-Item -LiteralPath $aar).Length
    sources_sha256=(Get-FileHash -LiteralPath (Join-Path $out 'sources.zip')).Hash.ToLowerInvariant()
    same_inputs_packaged_twice_equal=$true
    consumer_compiled_from_extracted_aar=$true;packaged_class_host_call=$true
    android_jna_version='5.19.1';rust_and_jna_arm64_load_alignment=16384
    jna_aar_classes_and_native_same_input=$true
    d8_version=$d8Version;d8_log_lines=$d8Lines.Count
    d8_warning_lines=@($d8Lines | Where-Object { $_ -match '^Warning:' }).Count
    dex_generated=$true;dex_sha256=(Get-FileHash -LiteralPath $dexFile).Hash.ToLowerInvariant()
    dex_bytes=$bytes.Length;dex_scope='consumer+own-bindings+JNA-Android+Kotlin；Media3仅classpath，非完整应用'
    media3_version='1.11.1';abi='arm64-v8a';min_sdk=24
    published=$false;candidate_event_created=$false;gradle_agp_or_r8_verified=$false
    android_runtime_or_device_verified=$false;three_low_claimed=$false
    source_checkout_dirty=$true;compatibility_baseline='unknown'
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $out 'receipt.json') -Encoding utf8NoBOM
Get-Content -LiteralPath (Join-Path $out 'receipt.json') -Raw
