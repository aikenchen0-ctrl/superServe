param(
    [Parameter(Mandatory)][string]$InputsManifest,
    [Parameter(Mandatory)][string]$KotlinHome,
    [Parameter(Mandatory)][string]$BuildTools,
    [Parameter(Mandatory)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
. 'D:\CodexVideoTools\enter.ps1'
$root = (Get-Location).Path
$out = [IO.Path]::GetFullPath($OutputDirectory)
if (!$out.StartsWith("$root\.artifacts\",[StringComparison]::OrdinalIgnoreCase) -or
    (Test-Path -LiteralPath $out)) { throw '应用构建须使用本工作区.artifacts下的新目录' }
if ((Get-PSDrive O).Free -lt 512MB) { throw 'O盘不足512MiB' }
$inputs = Get-Content -LiteralPath $InputsManifest -Raw | ConvertFrom-Json
if ($inputs.schema -ne 'android-player-app-inputs-v1') { throw '应用输入版本无效' }
$files = @{}
foreach ($entry in $inputs.files.PSObject.Properties) {
    if (![IO.Path]::IsPathFullyQualified($entry.Value.path) -or
        ($entry.Name -notin @('android','kotlin') -and
            !$entry.Value.path.StartsWith('O:\',[StringComparison]::OrdinalIgnoreCase)) -or
        (Get-FileHash -LiteralPath $entry.Value.path).Hash.ToLowerInvariant() -ne $entry.Value.sha256) {
        throw "应用输入摘要或位置无效：$($entry.Name)"
    }
    $files[$entry.Name] = $entry.Value.path
}
foreach ($resource in $inputs.resources) {
    if (!$resource.path.StartsWith('O:\',[StringComparison]::OrdinalIgnoreCase) -or
        !(Test-Path -LiteralPath $resource.path -PathType Container)) {
        throw '发布资源目录必须是O盘固定输入'
    }
    $actual = @(Get-ChildItem -LiteralPath $resource.path -Recurse -File)
    if ($actual.Count -ne @($resource.files).Count) { throw '发布资源文件数改变' }
    foreach ($item in $resource.files) {
        $path = [IO.Path]::GetFullPath((Join-Path $resource.path $item.relative))
        if (!$path.StartsWith($resource.path.TrimEnd('\','/')+'\',[StringComparison]::OrdinalIgnoreCase) -or
            (Get-FileHash -LiteralPath $path).Hash.ToLowerInvariant() -ne $item.sha256) {
            throw '发布资源路径或摘要无效'
        }
    }
}
$d8Jar = Join-Path $BuildTools 'lib/d8.jar'
$d8Text = @(& java -classpath $d8Jar com.android.tools.r8.D8 --version 2>&1) -join "`n"
if ($LASTEXITCODE -ne 0 -or $d8Text -notmatch '^D8 (\d+\.\d+\.\d+)') { throw 'D8版本无法核实' }
$d8Version = $Matches[1]
if ([version]$d8Version -lt [version]'8.6.17') { throw 'Kotlin2.1需要D8至少8.6.17' }
$null = New-Item -ItemType Directory -Path $out
$assets = Join-Path $out 'assets'
$null = New-Item -ItemType Directory -Path $assets
Copy-Item -LiteralPath $files.video -Destination (Join-Path $assets 'source.mp4')
$licenses = Join-Path $assets 'licenses'
$sourceArchive = Join-Path $assets 'source'
$null = New-Item -ItemType Directory -Path $licenses,$sourceArchive
foreach ($license in @('LICENSE','vedioServer/native/LICENSE-MPL-2.0',
    'vedioServer/native/NOTICE.txt','vedioServer/LICENSES/media3-Apache-2.0.txt',
    'vedioServer/LICENSES/media3-NOTICE.txt','vedioServer/LICENSES/jna-5.19.1-LICENSE.txt',
    'vedioServer/LICENSES/jna-5.19.1-Apache-2.0.txt')) {
    Copy-Item -LiteralPath $license -Destination (Join-Path $licenses (Split-Path $license -Leaf))
}
Copy-Item -LiteralPath $files.native_sources -Destination (Join-Path $sourceArchive 'native-sources.zip')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'src/org/superserve/playback/lab/PlaybackLabActivity.kt') `
    -Destination $sourceArchive
foreach ($name in @('guava','kotlin','jna')) {
    $jar = [IO.Compression.ZipFile]::OpenRead($files[$name])
    try {
        foreach ($entry in $jar.Entries) {
            if ($entry.FullName -match '(?i)(LICENSE|NOTICE|COPYING)' -and !$entry.FullName.EndsWith('/')) {
                $destination = Join-Path $licenses ($name+'-'+$entry.FullName.Replace('/','-'))
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$destination,$false)
            }
        }
    } finally { $jar.Dispose() }
}
$aapt = Join-Path $BuildTools 'aapt2.exe'
$gen = Join-Path $out 'generated'
$compiled = @()
foreach ($resource in $inputs.resources) {
    $zip = Join-Path $out "$($compiled.Count)-resources.zip"
    & $aapt compile --dir $resource.path -o $zip
    if ($LASTEXITCODE -ne 0) { throw 'Android发布资源编译失败' }
    $compiled += $zip
}
$resourceApk = Join-Path $out 'resources.apk'
$arguments = @('link','-I',$files.android,'--manifest',(Join-Path $PSScriptRoot 'AndroidManifest.xml'),
    '--min-sdk-version','24','--target-sdk-version','35','--version-code','1',
    '--version-name','local-lab','--auto-add-overlay','--java',$gen,'--extra-packages',
    'androidx.media3.exoplayer:androidx.annotation.experimental:com.sun.jna',
    '-A',$assets,'-0','mp4','-0','so','-o',$resourceApk)
foreach ($zip in $compiled) { $arguments += @('-R',$zip) }
& $aapt @arguments 2>&1 | Set-Content -LiteralPath (Join-Path $out 'aapt-link.log') -Encoding utf8NoBOM
if ($LASTEXITCODE -ne 0) { throw 'Android清单和资源链接失败，见aapt-link.log' }
$resourceClasses = Join-Path $out 'resource-classes'
$null = New-Item -ItemType Directory -Path $resourceClasses
$sources = @(Get-ChildItem -LiteralPath $gen -Recurse -File -Filter '*.java' | ForEach-Object FullName)
& javac --release 8 -classpath $files.android -d $resourceClasses @sources `
    2>&1 | Tee-Object -FilePath (Join-Path $out 'resource-javac.log')
if ($LASTEXITCODE -ne 0) { throw 'Android R类编译失败' }
$rJar = Join-Path $out 'resources.jar'
& jar --create --file $rJar -C $resourceClasses .
if ($LASTEXITCODE -ne 0) { throw 'Android R类封装失败' }
$jars = @($inputs.program_jars | ForEach-Object { $files.$_ })
$classPath = (@($jars)+@($files.android,$rJar)) -join ';'
$appJar = Join-Path $out 'app.jar'
& java -classpath "$KotlinHome/lib/*" org.jetbrains.kotlin.cli.jvm.K2JVMCompiler `
    -kotlin-home $KotlinHome (Join-Path $PSScriptRoot 'src/org/superserve/playback/lab/PlaybackLabActivity.kt') `
    -classpath $classPath -d $appJar 2>&1 | Tee-Object -FilePath (Join-Path $out 'kotlin.log')
if ($LASTEXITCODE -ne 0) { throw '实验Activity编译失败' }
$dex = Join-Path $out 'dex'
$null = New-Item -ItemType Directory -Path $dex
$d8Lines = @(& java -Xmx512m "-Djava.io.tmpdir=$env:TEMP" -classpath $d8Jar `
    com.android.tools.r8.D8 --release --min-api 24 --lib $files.android --output $dex `
    $appJar $rJar @jars 2>&1)
$d8Exit = $LASTEXITCODE
Set-Content -LiteralPath (Join-Path $out 'd8.log') -Value ($d8Lines -join "`n") -Encoding utf8NoBOM
if ($d8Exit -ne 0 -or ($d8Lines -join "`n") -match 'error occurred when parsing kotlin metadata|Unexpected error.*kotlin.Metadata') {
    throw '完整实验应用DEX编译失败或Kotlin元数据不兼容'
}
$raw = Join-Path $out 'raw.apk'
Copy-Item -LiteralPath $resourceApk -Destination $raw
$apk = [IO.Compression.ZipFile]::Open($raw,[IO.Compression.ZipArchiveMode]::Update)
try {
    # Windows AAPT2可能为嵌套assets保留反斜杠；签名前统一ZIP规范路径。
    foreach ($entry in @($apk.Entries | Where-Object { $_.FullName.Contains('\') })) {
        $normalized = $entry.FullName.Replace('\','/')
        if ($apk.GetEntry($normalized)) { throw 'APK资源规范化发生重名，拒绝覆盖' }
        if ($entry.Length -gt 8MB) { throw '嵌套实验资产超出路径规范化预算' }
        $memory = [IO.MemoryStream]::new()
        $source = $entry.Open()
        try { $source.CopyTo($memory) } finally { $source.Dispose() }
        $entry.Delete()
        $replacement = $apk.CreateEntry($normalized,[IO.Compression.CompressionLevel]::Optimal)
        $target = $replacement.Open()
        try { $memory.Position=0; $memory.CopyTo($target) } finally { $target.Dispose(); $memory.Dispose() }
    }
    $entries = @{
        'classes.dex' = Join-Path $dex 'classes.dex'
        'lib/arm64-v8a/libvs_playback_native.so' = $files.rust
        'lib/arm64-v8a/libjnidispatch.so' = $files.jna_native
    }
    foreach ($name in $entries.Keys) {
        $level = if ($name.EndsWith('.so')) { [IO.Compression.CompressionLevel]::NoCompression } else {
            [IO.Compression.CompressionLevel]::Optimal
        }
        $null = [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($apk,$entries[$name],$name,$level)
    }
} finally { $apk.Dispose() }
$aligned = Join-Path $out 'aligned.apk'
& (Join-Path $BuildTools 'zipalign.exe') -P 16 -f 4 $raw $aligned
if ($LASTEXITCODE -ne 0) { throw 'APK原生ZIP对齐失败' }
$key = Join-Path $out 'lab-private.p12'
$previous = $env:VS_LAB_KEY_PASSWORD
try {
    $env:VS_LAB_KEY_PASSWORD = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24))
    & keytool -genkeypair -keystore $key -storetype PKCS12 -storepass:env VS_LAB_KEY_PASSWORD `
        -keypass:env VS_LAB_KEY_PASSWORD -alias lab -keyalg RSA -keysize 2048 -validity 2 `
        -dname 'CN=SuperServe Local Lab' 2>&1 |
        Tee-Object -FilePath (Join-Path $out 'keytool.log')
    if ($LASTEXITCODE -ne 0) { throw '临时实验签名创建失败' }
    $signed = Join-Path $out 'playback-lab.apk'
    & java '--enable-native-access=ALL-UNNAMED' -jar (Join-Path $BuildTools 'lib/apksigner.jar') sign --ks $key --ks-key-alias lab `
        --ks-pass env:VS_LAB_KEY_PASSWORD --key-pass env:VS_LAB_KEY_PASSWORD --out $signed $aligned
    if ($LASTEXITCODE -ne 0) { throw '实验APK签名失败' }
} finally { $env:VS_LAB_KEY_PASSWORD = $previous }
& java '--enable-native-access=ALL-UNNAMED' -jar (Join-Path $BuildTools 'lib/apksigner.jar') verify --verbose $signed |
    Set-Content -LiteralPath (Join-Path $out 'signature.txt') -Encoding utf8NoBOM
if ($LASTEXITCODE -ne 0) { throw '实验APK签名核验失败' }
& (Join-Path $BuildTools 'zipalign.exe') -c -P 16 -v 4 $signed |
    Set-Content -LiteralPath (Join-Path $out 'alignment.txt') -Encoding utf8NoBOM
if ($LASTEXITCODE -ne 0) { throw '签名后APK对齐核验失败' }
& $aapt dump badging $signed | Set-Content -LiteralPath (Join-Path $out 'badging.txt') -Encoding utf8NoBOM
if ($LASTEXITCODE -ne 0) { throw '签名APK结构读取失败' }
$badging = Get-Content -LiteralPath (Join-Path $out 'badging.txt') -Raw
if ($badging -notmatch "package: name='org.superserve.playback.lab'" -or
    $badging -match 'uses-permission:' -or $badging -notmatch "native-code: 'arm64-v8a'") {
    throw 'APK包名、权限或ABI超出本地实验边界'
}
$archive = [IO.Compression.ZipFile]::OpenRead($signed)
try {
    if (@($archive.Entries | Where-Object { $_.FullName.Contains('\') }).Count -ne 0 -or
        !$archive.GetEntry('assets/source/native-sources.zip') -or
        !$archive.GetEntry('assets/source/PlaybackLabActivity.kt') -or
        !$archive.GetEntry('assets/licenses/LICENSE-MPL-2.0')) {
        throw '签名APK源码/许可资产路径不正确'
    }
} finally { $archive.Dispose() }
[ordered]@{
    schema='android-player-lab-apk-v1';passed=$true
    package='org.superserve.playback.lab';sha256=(Get-FileHash -LiteralPath $signed).Hash.ToLowerInvariant()
    bytes=(Get-Item -LiteralPath $signed).Length;apk_signature_verified=$true
    apk_native_zip_alignment=16384;min_sdk=24;target_sdk=35;abi='arm64-v8a'
    local_asset_only=$true;network_permission=$false
    source_and_license_assets_included=$true
    d8_version=$d8Version;d8_log_lines=$d8Lines.Count
    gradle_agp_or_r8_verified=$false;device_run_verified=$false;production_admitted=$false
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $out 'receipt.json') -Encoding utf8NoBOM
Get-Content -LiteralPath (Join-Path $out 'receipt.json') -Raw
