param(
    [Parameter(Mandatory)][string]$Binary,
    [Parameter(Mandatory)][string]$ServerBinary,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [ValidateRange(1,2)][int]$Repeats = 2
)

$ErrorActionPreference = 'Stop'
. 'D:\CodexVideoTools\enter.ps1'
$workspace = 'O:\CodexWorkspaces\superServe-video-b4be'
Set-Location -LiteralPath $workspace
$binaryPath = (Resolve-Path -LiteralPath $Binary).Path
$serverPath = (Resolve-Path -LiteralPath $ServerBinary).Path
$outputPath = [IO.Path]::GetFullPath($OutputDirectory)
$artifactRoot = [IO.Path]::GetFullPath((Join-Path $workspace '.artifacts')) + '\'
if (!$outputPath.StartsWith($artifactRoot, [StringComparison]::OrdinalIgnoreCase) -or
    (Test-Path -LiteralPath $outputPath)) {
    throw '输出必须是本项目O盘.artifacts中的新目录'
}
if ((Get-PSDrive O).Free -lt 600MB) { throw 'O盘余量不足，停止实验' }
$null = New-Item -ItemType Directory -Path $outputPath
$cells = @()
foreach ($repeat in 1..$Repeats) {
    $matrix = @()
    foreach ($voters in @(1,3)) {
        foreach ($prefill in @(16,128)) {
            foreach ($rate in @(40,800)) {
                $matrix += [pscustomobject]@{ voters=$voters;prefill=$prefill;rate=$rate }
            }
        }
    }
    if ($repeat % 2 -eq 0) { [Array]::Reverse($matrix) }
    foreach ($cell in $matrix) {
        $name = "r$repeat-v$($cell.voters)-h$($cell.prefill)-q$($cell.rate)"
        $cellPath = Join-Path $outputPath $name
        $stdout = Join-Path $outputPath "$name.stdout.log"
        $stderr = Join-Path $outputPath "$name.stderr.log"
        $psi = [Diagnostics.ProcessStartInfo]::new($binaryPath)
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.RedirectStandardInput = $true
        $psi.Environment['VS_PROFILE_LOAD_SUPERVISED'] = '1'
        foreach ($argument in @($serverPath,$cellPath,"$($cell.voters)","$($cell.prefill)","$($cell.rate)")) {
            $psi.ArgumentList.Add($argument)
        }
        $probe = [Diagnostics.Process]::new()
        $probe.StartInfo = $psi
        $samples = [Collections.Generic.List[object]]::new()
        $lines = [Collections.Generic.List[string]]::new()
        $owned = @{}
        $phase = 'starting'
        try {
            $null = $probe.Start()
            $errors = $probe.StandardError.ReadToEndAsync()
            $next = $probe.StandardOutput.ReadLineAsync()
            $watch = [Diagnostics.Stopwatch]::StartNew()
            $done = $false
            while (!$done -or !$probe.HasExited) {
                if ($watch.Elapsed.TotalSeconds -gt 100) { throw '负载实验超过100秒，保留现场' }
                if (!$done -and $next.IsCompleted) {
                    $line = $next.GetAwaiter().GetResult()
                    if ($null -eq $line) { $done = $true }
                    else {
                        $lines.Add($line)
                        $event = $line | ConvertFrom-Json
                        if ($event.schema -ne 'profile-load-lifecycle-v1' -or $event.probe_pid -ne $probe.Id) {
                            throw '负载实验回执身份无效'
                        }
                        $phase = $event.phase
                        foreach ($processId in @($event.pids)) {
                            if (!$owned.ContainsKey([int]$processId)) {
                                $node = Get-Process -Id $processId -ErrorAction Stop
                                $identity = Get-CimInstance Win32_Process -Filter "ProcessId = $processId"
                                if ($identity.ExecutablePath -ne $serverPath) {
                                    throw '回执PID不属于指定服务程序'
                                }
                                $owned[[int]$processId] = [pscustomobject]@{process=$node;start=$node.StartTime.ToUniversalTime()}
                            }
                        }
                        if ($phase -eq 'processes') {
                            $probe.StandardInput.Write('1')
                            $probe.StandardInput.Flush()
                            $probe.StandardInput.Close()
                        }
                        $next = $probe.StandardOutput.ReadLineAsync()
                    }
                }
                foreach ($entry in @($owned.Values)) {
                    $node = $entry.process
                    $node.Refresh()
                    if (!$node.HasExited) {
                        $samples.Add([pscustomobject]@{
                            elapsed_ms=$watch.Elapsed.TotalMilliseconds;phase=$phase;kind='server';pid=$node.Id
                            cpu_total_ms=$node.TotalProcessorTime.TotalMilliseconds
                            working_set_bytes=$node.WorkingSet64;private_bytes=$node.PrivateMemorySize64
                            peak_working_set_bytes=$node.PeakWorkingSet64
                        })
                    }
                }
                $probe.Refresh()
                if (!$probe.HasExited) {
                    $samples.Add([pscustomobject]@{
                        elapsed_ms=$watch.Elapsed.TotalMilliseconds;phase=$phase;kind='probe';pid=$probe.Id
                        cpu_total_ms=$probe.TotalProcessorTime.TotalMilliseconds
                        working_set_bytes=$probe.WorkingSet64;private_bytes=$probe.PrivateMemorySize64
                        peak_working_set_bytes=$probe.PeakWorkingSet64
                    })
                }
                Start-Sleep -Milliseconds 20
            }
            $probe.WaitForExit()
            $lines | Set-Content -LiteralPath $stdout -Encoding utf8
            $errors.GetAwaiter().GetResult() | Set-Content -LiteralPath $stderr -Encoding utf8
            $samples | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $outputPath "$name.resources.json") -Encoding utf8
            if ($probe.ExitCode -ne 0) { throw "负载程序失败：$name" }
            $reportPath = Join-Path $cellPath 'report.json'
            $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
            if ($report.schema -ne 'profile-load-report-v1' -or !$report.correctness_passed -or
                $report.samples.Count -ne 192 -or $report.voters -ne $cell.voters -or
                $report.prefill_events -ne $cell.prefill -or $report.offered_rate -ne $cell.rate -or
                !$report.writer_barrier_before_final_reconciliation) {
                throw '负载报告未通过正确性或完整样本门'
            }
            if ($phase -ne 'reclaimed') { throw '缺少进程及端口回收回执' }
            foreach ($entry in @($owned.Values)) {
                $entry.process.Refresh()
                if (!$entry.process.HasExited) { throw '子进程未回收' }
            }
            $resourceSummary = @()
            foreach ($kind in @('server','probe')) {
                $selected = @($samples | Where-Object { $_.kind -eq $kind })
                $cpu = 0.0
                foreach ($group in @($selected | Group-Object pid)) {
                    $values = @($group.Group)
                    $cpu += $values[-1].cpu_total_ms - $values[0].cpu_total_ms
                }
                $measurement = @($selected | Where-Object { $_.phase -eq 'measure' })
                $resourceSummary += [ordered]@{
                    kind=$kind;sampled_cpu_delta_ms=$cpu;observations=$selected.Count
                    maximum_observed_working_set_per_process_bytes=($selected | Measure-Object working_set_bytes -Maximum).Maximum
                    measure_phase_observations=$measurement.Count
                    scope='采样覆盖准备、预填、测量和核对；20ms采样可能遗漏极短峰值，不作内核IO/线路字节或单请求成本'
                }
            }
            $cells += [ordered]@{
                name=$name;repeat=$repeat;voters=$cell.voters;prefill=$cell.prefill;offered_rate=$cell.rate
                report=$reportPath;outcomes=$report.outcomes;latency=$report.latency;resource_summary=$resourceSummary
                report_sha256=(Get-FileHash -LiteralPath $reportPath -Algorithm SHA256).Hash.ToLowerInvariant()
                correctness_passed=$true;reclaimed=$true
            }
            Write-Output "负载单元完成：$name"
        }
        finally {
            # 探针由本运行器创建；失败时回收其子树，覆盖尚未登记PID的启动窗口。
            if (!$probe.HasExited) { $probe.Kill($true);$probe.WaitForExit() }
            foreach ($entry in @($owned.Values)) {
                $node = $entry.process
                $node.Refresh()
                if (!$node.HasExited -and $node.Path -eq $serverPath -and $node.StartTime.ToUniversalTime() -eq $entry.start) {
                    $node.Kill();$node.WaitForExit()
                }
                $node.Dispose()
            }
            if (!(Test-Path -LiteralPath $stdout)) {
                $lines | Set-Content -LiteralPath $stdout -Encoding utf8
            }
            if (!(Test-Path -LiteralPath $stderr) -and $errors) {
                $errors.GetAwaiter().GetResult() | Set-Content -LiteralPath $stderr -Encoding utf8
            }
            $probe.Dispose()
        }
    }
}
[ordered]@{
    schema='profile-load-matrix-v1';physical_hosts=1;raft_groups=1;cells=$cells
    binary_sha256=(Get-FileHash -LiteralPath $binaryPath -Algorithm SHA256).Hash.ToLowerInvariant()
    server_sha256=(Get-FileHash -LiteralPath $serverPath -Algorithm SHA256).Hash.ToLowerInvariant()
    source_lock_sha256=(Get-FileHash -LiteralPath (Join-Path $workspace 'vedioServer\Cargo.lock') -Algorithm SHA256).Hash.ToLowerInvariant()
    production_capacity_claimed=$false;synthetic_data=$true
} | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath (Join-Path $outputPath 'matrix.json') -Encoding utf8
