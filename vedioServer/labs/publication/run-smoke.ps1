$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$run = Join-Path $root ('.artifacts/immutable-publication/' + [Guid]::NewGuid().ToString('N'))
$published = Join-Path $run 'published'
New-Item -ItemType Directory -Path $published | Out-Null
$media = (Resolve-Path (Join-Path $root 'vedioServer/target/debug/examples/publish_media.exe')).Path
$catalog = (Resolve-Path (Join-Path $root 'vedioServer/target/debug/examples/publish_catalog.exe')).Path
$probe = (Resolve-Path (Join-Path $root 'vedioServer/target/debug/examples/fs_publication_probe.exe')).Path
$inputFile = Join-Path $root 'vedioServer/examples/profile-log/original-catalog.json'
$catalogFile = Join-Path $root 'vedioServer/examples/publication/catalog.json'
$conflicting = Join-Path $root 'vedioServer/examples/publication/conflicting-catalog.json'
$hash = (Get-FileHash -LiteralPath $inputFile -Algorithm SHA256).Hash.ToLowerInvariant()
$inputBytes = (Get-Item -LiteralPath $inputFile).Length
$completed = $false
try {
    & $media $published $inputFile $hash $inputBytes 'application/octet-stream' > (Join-Path $run 'media-created.json') 2> (Join-Path $run 'media-created-error.log')
    if ($LASTEXITCODE -ne 0) { throw '媒体创建失败。' }
    & $media $published $inputFile $hash $inputBytes 'application/octet-stream' > (Join-Path $run 'media-reused.json') 2> (Join-Path $run 'media-reused-error.log')
    if ($LASTEXITCODE -ne 0) { throw '媒体复用失败。' }
    & $catalog $published $catalogFile > (Join-Path $run 'catalog-created.json') 2> (Join-Path $run 'catalog-created-error.log')
    if ($LASTEXITCODE -ne 0) { throw '目录发布失败。' }
    & $catalog $published $catalogFile > (Join-Path $run 'catalog-reused.json') 2> (Join-Path $run 'catalog-reused-error.log')
    if ($LASTEXITCODE -ne 0) { throw '目录重试失败。' }
    & $catalog $published $conflicting > (Join-Path $run 'conflict-output.log') 2> (Join-Path $run 'conflict-error.log')
    if ($LASTEXITCODE -ne 1) { throw '同名目录版本未拒绝重绑。' }
    & $media $published $inputFile ('0' * 64) $inputBytes 'application/octet-stream' > (Join-Path $run 'bad-hash-output.log') 2> (Join-Path $run 'bad-hash-error.log')
    if ($LASTEXITCODE -ne 1) { throw '错误媒体散列未拒绝发布。' }
    & $probe > (Join-Path $run 'fs-probe.json') 2> (Join-Path $run 'fs-probe-error.log')
    if ($LASTEXITCODE -ne 0) { throw 'Fs上游语义探针失败。' }
    $first = Get-Content -LiteralPath (Join-Path $run 'media-created.json') -Raw | ConvertFrom-Json
    $second = Get-Content -LiteralPath (Join-Path $run 'media-reused.json') -Raw | ConvertFrom-Json
    $release = Get-Content -LiteralPath (Join-Path $run 'catalog-created.json') -Raw | ConvertFrom-Json
    $retry = Get-Content -LiteralPath (Join-Path $run 'catalog-reused.json') -Raw | ConvertFrom-Json
    if (-not $first.created -or $second.created -or -not $first.verified -or
        -not $second.verified -or -not $release.release_created -or $retry.release_created) {
        throw '发布及复用收据不符。'
    }
    $object = Join-Path $published ("media/$hash")
    if ((Get-FileHash -LiteralPath $object -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash -or
        (Get-FileHash -LiteralPath $inputFile -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash -or
        (Test-Path -LiteralPath (Join-Path $published ('media/' + ('0' * 64))))) {
        throw '源文件、发布内容或失败残留不符。'
    }
    $marker = Get-Content -LiteralPath (Join-Path $published 'releases/publication-example-v1.json') -Raw | ConvertFrom-Json
    if ($marker.catalog_sha256 -ne $release.release.catalog_sha256) { throw '冲突发布改变了版本。' }
    $completed = $true
} finally {
    $inputs = @(
        $media,$catalog,$probe,$PSCommandPath,$inputFile,$catalogFile,$conflicting,
        (Join-Path $root 'vedioServer/crates/vs-service/src/publication.rs'),
        (Join-Path $root 'vedioServer/crates/vs-service/src/upstream/atomic_create.rs'),
        (Join-Path $root 'vedioServer/crates/vs-core/src/catalog.rs'),
        (Join-Path $root 'vedioServer/Cargo.lock')
    ) | ForEach-Object {
        [ordered]@{path=$_;sha256=(Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant()}
    }
    [ordered]@{
        schema='immutable-publication-smoke-v1';completed=$completed
        inputs=$inputs;source_unchanged=$completed;bad_hash_rejected=$completed
        existing_version_preserved=$completed;backend='local-filesystem'
        live_production_data_used=$false;physical_cluster_tested=$false
        timestamp_utc=[DateTime]::UtcNow.ToString('o')
        scope='合成字节夹具；无真实视频首帧、网络或生产吞吐收益结论。'
    } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $run 'run.json') -Encoding utf8NoBOM
    Write-Output "不可变发布收据：$run"
}
