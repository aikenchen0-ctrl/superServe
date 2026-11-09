param([Parameter(Mandatory)][string]$Matrix)

$ErrorActionPreference = 'Stop'
. 'D:\CodexVideoTools\enter.ps1'
$matrixPath = (Resolve-Path -LiteralPath $Matrix).Path
$root = Split-Path -Parent $matrixPath
$matrixValue = Get-Content -LiteralPath $matrixPath -Raw | ConvertFrom-Json
if ($matrixValue.schema -ne 'profile-load-matrix-v1' -or $matrixValue.production_capacity_claimed -ne $false) {
    throw '矩阵格式或实验边界无效'
}

function Check-Quantiles($actual, $values) {
    $ordered = @($values | Sort-Object)
    if ($ordered.Count -eq 0) {
        if ($null -ne $actual) { throw '空样本不能生成分位数' }
        return
    }
    if ($actual.samples -ne $ordered.Count -or $actual.max_ns -ne $ordered[-1]) {
        throw '分位数样本数或最大值不符'
    }
    foreach ($p in @(50,95,99)) {
        $expected = $ordered[[int][Math]::Ceiling($p * $ordered.Count / 100.0) - 1]
        if ($actual."p${p}_ns" -ne $expected) { throw '分位数与原始样本重算不符' }
    }
}

$rows = @()
$combinations = @{}
$repeats = [Collections.Generic.HashSet[int]]::new()
foreach ($cell in $matrixValue.cells) {
    $reportPath = (Resolve-Path -LiteralPath $cell.report).Path
    if (!$reportPath.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw '报告不属于当前矩阵目录'
    }
    if ((Get-FileHash -LiteralPath $reportPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $cell.report_sha256) {
        throw '报告摘要不符'
    }
    $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
    if ($report.schema -ne 'profile-load-report-v1' -or !$report.correctness_passed -or
        $report.samples.Count -ne 192 -or $report.scheduled_requests -ne 192 -or
        !$report.writer_barrier_before_final_reconciliation -or $report.retries -ne 0 -or
        $report.production_capacity_claimed -ne $false) {
        throw '负载报告不满足当前事实和有界约束'
    }
    $combination = "$($cell.repeat):$($cell.voters):$($cell.prefill):$($cell.offered_rate)"
    if ($cell.repeat -notin @(1,2) -or $cell.voters -notin @(1,3) -or
        $cell.prefill -notin @(16,128) -or $cell.offered_rate -notin @(40,800)) {
        throw '矩阵含未声明的重复号或实验参数'
    }
    $null = $repeats.Add([int]$cell.repeat)
    if ($combinations.ContainsKey($combination)) { throw '矩阵含重复单元' }
    $combinations[$combination] = $true
    if ($report.voters -ne $cell.voters -or $report.prefill_events -ne $cell.prefill -or
        $report.offered_rate -ne $cell.offered_rate) { throw '矩阵与报告配置不符' }
    $outcomes = @{}
    $confirmed = @(0) * 16
    $unknown = @(0) * 16
    for ($i=0;$i -lt $report.samples.Count;$i++) {
        $sample = $report.samples[$i]
        if ($sample.sequence -ne $i -or
            $sample.planned_ns -ne [Math]::Floor($i * 1000000000.0 / $report.offered_rate)) {
            throw '计划请求序号或固定到达时间不符'
        }
        $outcome = [string]$sample.outcome
        if ($outcome -eq 'protocol_error') { throw '协议错误不能纳入有效矩阵' }
        if (!$outcomes.ContainsKey($outcome)) { $outcomes[$outcome]=0 }
        $outcomes[$outcome]++
        if ($outcome -eq 'client_dropped') {
            if ($null -ne $sample.status -or $null -ne $sample.service_ns -or
                $sample.request_bytes -ne 0 -or $sample.response_bytes -ne 0) {
                throw '客户端丢弃不能伪装实际HTTP请求'
            }
        } else {
            if ($null -eq $sample.service_ns -or $null -eq $sample.dispatch_lag_ns -or
                $sample.scheduled_elapsed_ns -ne ($sample.service_ns + $sample.dispatch_lag_ns)) {
                throw '计划起点、调度和服务耗时未闭合'
            }
        }
        if ($outcome -in @('new_confirmed','duplicate_confirmed','read_verified') -and $sample.status -ne 200) {
            throw '非200响应不能作为成功'
        }
        $subject = [int][Math]::Floor($i/3) % 16
        if ($i % 3 -eq 0) {
            if ($outcome -eq 'new_confirmed') { $confirmed[$subject]++ }
            if ($outcome.StartsWith('unknown')) { $unknown[$subject]++ }
        }
    }
    foreach ($key in $outcomes.Keys) {
        if ($report.outcomes.$key -ne $outcomes[$key]) { throw '结果分类与原始样本不符' }
    }
    if (@($report.outcomes.PSObject.Properties).Count -ne $outcomes.Count) { throw '报告含额外结果类别' }
    foreach ($kind in 0..2) {
        $name = @('new','duplicate','read')[$kind]
        $selected = @($report.samples | Where-Object { $_.sequence % 3 -eq $kind })
        Check-Quantiles $report.latency.$name.attempted_scheduled @($selected | Where-Object { $null -ne $_.service_ns } | ForEach-Object scheduled_elapsed_ns)
        Check-Quantiles $report.latency.$name.service @($selected | Where-Object { $null -ne $_.service_ns } | ForEach-Object service_ns)
        Check-Quantiles $report.latency.$name.verified_scheduled @($selected | Where-Object { $_.outcome -in @('new_confirmed','duplicate_confirmed','read_verified') } | ForEach-Object scheduled_elapsed_ns)
    }
    Check-Quantiles $report.dispatch_lag @($report.samples | Where-Object { $null -ne $_.dispatch_lag_ns } | ForEach-Object dispatch_lag_ns)
    $records = 0
    if ($report.final_projections.Count -ne 16) { throw '最终主体数不符' }
    for ($i=0;$i -lt 16;$i++) {
        $projection = $report.final_projections[$i]
        if ($projection.subject_index -ne $i -or $projection.before -ne $report.prefill_events/16 -or
            $projection.confirmed_new -ne $confirmed[$i] -or $projection.unknown_new -ne $unknown[$i] -or
            $projection.final_version -lt $projection.before+$confirmed[$i] -or
            $projection.final_version -gt $projection.before+$confirmed[$i]+$unknown[$i]) {
            throw '最终版本未落在确认与未知事件允许区间'
        }
        $records += $projection.final_version
    }
    if ($records -ne $report.final_events) { throw '最终主体版本之和与事件总数不符' }
    $outcomeCounts = [ordered]@{}
    foreach ($key in ($outcomes.Keys | Sort-Object)) { $outcomeCounts[$key]=$outcomes[$key] }
    $rows += [ordered]@{
        cell=$cell.name;voters=$report.voters;prefill=$report.prefill_events;offered_rate=$report.offered_rate
        outcomes=$outcomeCounts;new_p99_ms=$report.latency.new.verified_scheduled.p99_ns/1e6
        read_p99_ms=$report.latency.read.verified_scheduled.p99_ns/1e6
        dispatch_p99_ms=$report.dispatch_lag.p99_ns/1e6;correctness_recomputed=$true
    }
}
if ($rows.Count -ne 8 -and $rows.Count -ne 16) { throw '矩阵不完整，仅接受完整一轮或两轮' }
foreach ($repeat in $repeats) {
    foreach ($voters in @(1,3)) {
        foreach ($prefill in @(16,128)) {
            foreach ($rate in @(40,800)) {
                if (!$combinations.ContainsKey("${repeat}:${voters}:${prefill}:${rate}")) {
                    throw '矩阵缺少声明参数组合'
                }
            }
        }
    }
}
[ordered]@{
    schema='profile-load-independent-verification-v1';matrix=$matrixPath
    matrix_sha256=(Get-FileHash -LiteralPath $matrixPath -Algorithm SHA256).Hash.ToLowerInvariant()
    cells=$rows;raw_quantiles_recomputed=$true;versions_and_outcomes_recomputed=$true
    payload_bytes_not_wire_billing=$true;production_capacity_claimed=$false
} | ConvertTo-Json -Depth 12
