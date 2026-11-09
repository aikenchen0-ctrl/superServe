param(
    [Parameter(Mandatory)][string]$RunDirectory,
    [Parameter(Mandatory)][string]$OutputFile
)

$ErrorActionPreference = 'Stop'
. 'D:\CodexVideoTools\enter.ps1'
$root = (Get-Location).Path
$run = [IO.Path]::GetFullPath($RunDirectory)
$output = [IO.Path]::GetFullPath($OutputFile)
$runsRoot = [IO.Path]::GetFullPath((Join-Path $root '.artifacts/storage-runs'))
if (!$run.StartsWith($runsRoot.TrimEnd('\','/') + '\', [StringComparison]::OrdinalIgnoreCase) -or
    !$output.StartsWith($runsRoot.TrimEnd('\','/') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'RunDirectory and OutputFile must stay under .artifacts/storage-runs'
}
if (!(Test-Path -LiteralPath (Join-Path $run 'cancel-soak.json') -PathType Leaf)) {
    throw 'cancel-soak.json is required'
}
$nodeLogs = @(Get-ChildItem -LiteralPath $run -Filter 'node*.log' -File | Sort-Object Name)
if (!$nodeLogs.Count) { throw 'node logs are required' }
$soak = Get-Content -LiteralPath (Join-Path $run 'cancel-soak.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$phases = @($soak.phases | ForEach-Object {
        [PSCustomObject]@{ name = [string]$_.phase; cycle = $_.cycle; start_ms = [int64]$_.unix_ms }
    } | Sort-Object start_ms)
if (!$phases.Count) { throw 'cancel-soak phases are required' }
$phaseWindows = @($phases)
if ($phases[-1].name -eq 'finished') {
    # finished 是探针写入的终止标记，不是一个有明确结束时间的持续窗口。
    # 其后的指标通常由服务停机时的 exporter 刷出，不能伪装成 finished 阶段采样。
    $phaseWindows += [PSCustomObject]@{
        name = 'after_finished_marker'
        cycle = $null
        start_ms = [int64]$phases[-1].start_ms
    }
}

$metricNames = @(
    'rustfs_remote_lock_rpc_detached_total',
    'rustfs_remote_lock_rpc_late_completions_total',
    'rustfs_remote_lock_late_releases_total',
    'rustfs_remote_lock_request_suppressed_total'
)

function Get-Phase([int64]$UnixMilliseconds) {
    $selected = @($phaseWindows | Where-Object { $_.start_ms -le $UnixMilliseconds } | Select-Object -Last 1)
    if ($selected.Count) { return $selected[0] }
    return [PSCustomObject]@{ name = 'before_prepare'; cycle = $null; start_ms = $null }
}

function Convert-OtelTime([string]$Value) {
    $format = 'yyyy-MM-dd HH:mm:ss.ffffff'
    $styles = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
    return [DateTimeOffset]::ParseExact($Value.Trim(), $format, [Globalization.CultureInfo]::InvariantCulture, $styles)
}

function Convert-Record($Record, [string]$Node) {
    $converted = @()
    if ($null -eq $Record -or $metricNames -notcontains $Record.name -or $null -eq $Record.end_ms) {
        return $converted
    }
    foreach ($item in $Record.points | Where-Object { $null -ne $_.value }) {
        $labels = @($item.labels.Keys | Sort-Object | ForEach-Object { "$_=$($item.labels[$_])" }) -join ','
        $phase = Get-Phase $Record.end_ms
        $converted += [PSCustomObject]@{
            node = $Node
            metric = $Record.name
            labels = $labels
            value = [double]$item.value
            end_ms = [int64]$Record.end_ms
            phase = $phase.name
            cycle = $phase.cycle
        }
    }
    return $converted
}

$points = @()
foreach ($log in $nodeLogs) {
    $record = $null
    $point = $null
    foreach ($line in Get-Content -LiteralPath $log.FullName -Encoding UTF8) {
        if ($line -match '^Metric #') {
            $points += @(Convert-Record $record $log.BaseName)
            $record = [ordered]@{ name = $null; end_ms = $null; points = @() }
            $point = $null
            continue
        }
        if ($null -eq $record) { continue }
        if ($line -match '^\s*Name\s+:\s+(.+)$') {
            $record.name = $Matches[1].Trim()
            continue
        }
        if ($line -match '^\s*EndTime\s+:\s+(.+)$') {
            $record.end_ms = (Convert-OtelTime $Matches[1]).ToUnixTimeMilliseconds()
            continue
        }
        if ($line -match '^\s*DataPoint #') {
            $point = [ordered]@{ value = $null; labels = [ordered]@{} }
            $record.points += $point
            continue
        }
        if ($null -ne $point -and $line -match '^\s*Value\s+:\s+([0-9]+(?:\.[0-9]+)?)$') {
            $point.value = [double]$Matches[1]
            continue
        }
        if ($null -ne $point -and $line -match '^\s*->\s+([^:]+):\s+(.*)$') {
            $point.labels[$Matches[1].Trim()] = $Matches[2].Trim()
        }
    }
    $points += @(Convert-Record $record $log.BaseName)
}

$rows = @()
$groups = @($points | Group-Object node,metric,labels)
foreach ($group in $groups) {
    $ordered = @($group.Group | Sort-Object end_ms)
    $previous = 0.0
    foreach ($phase in $phaseWindows) {
        $samples = @($ordered | Where-Object { $_.phase -eq $phase.name })
        if (!$samples.Count) { continue }
        $last = ($samples | Select-Object -Last 1).value
        $delta = $last - $previous
        if ($delta -lt 0) { $delta = $null }
        $rows += [PSCustomObject]@{
            node = $ordered[0].node
            metric = $ordered[0].metric
            labels = $ordered[0].labels
            phase = $phase.name
            cycle = $phase.cycle
            snapshots = $samples.Count
            cumulative_last = $last
            delta_from_previous_phase = $delta
        }
        $previous = $last
    }
}

$inputFiles = @((Join-Path $run 'cancel-soak.json')) + @($nodeLogs | ForEach-Object FullName)
$manifest = [ordered]@{}
foreach ($file in $inputFiles) {
    $manifest[(Split-Path -Leaf $file)] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
}
$summary = [ordered]@{
    schema = 'storage-cancel-soak-lock-metrics-phase-v1'
    run_directory = $run
    input_sha256 = $manifest
    phases = $phaseWindows
    metrics = $rows
    observed_metric_points = $points.Count
    active_lease_count = $null
    active_cleanup_task_count = $null
    resource_convergence_proven = $false
    interpretation = 'Only cumulative OTLP metric deltas are summarized. Active leases, active cleanup tasks, and final remote release state remain unknown.'
}
$parent = Split-Path -Parent $output
$null = New-Item -ItemType Directory -Force -Path $parent
$summary | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $output -Encoding utf8NoBOM
Get-Content -LiteralPath $output -Raw
