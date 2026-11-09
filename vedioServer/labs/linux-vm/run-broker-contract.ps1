param(
    [Parameter(Mandatory)][string]$LaunchFile,
    [switch]$ResumeSeed
)
$ErrorActionPreference = 'Stop'
. 'D:\CodexVideoTools\enter.ps1'
$launch = Get-Content -LiteralPath $LaunchFile -Raw | ConvertFrom-Json
if ($launch.schema -ne 'video-linux-vm-launch-v1' -or
    !$launch.run.StartsWith('O:\CodexVideoBuild\linux-runtime\run-',[StringComparison]::OrdinalIgnoreCase)) {
    throw '需要本轮O盘虚拟机收据'
}
$run = $launch.run
$attempt = Join-Path $run ('verification-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
$null = New-Item -ItemType Directory -Path $attempt
$probe = Join-Path $env:CARGO_TARGET_DIR 'debug/examples/iggy_feedback_contract.exe'
if (!(Test-Path -LiteralPath $probe)) { throw '缺少已构建Rust真实反馈探针' }
$sshArgs = @('-F','NUL','-o','BatchMode=yes','-o','ConnectTimeout=5',
    '-o','StrictHostKeyChecking=yes','-o',"UserKnownHostsFile=$run/known_hosts",
    '-i',$launch.key,'-p',"$($launch.ssh_port)",'root@127.0.0.1')
function Invoke-Guest([string]$Command) {
    $text = @(& ssh @sshArgs $Command 2>&1)
    if ($LASTEXITCODE -ne 0) { throw ('来宾命令失败：'+($text -join "`n")) }
    return ($text -join "`n")
}
function Run-Probe([string]$Phase, [string]$Target, [string]$Label) {
    $start = [Diagnostics.ProcessStartInfo]::new($probe)
    $start.WorkingDirectory = (Get-Location).Path
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.ArgumentList.Add($Phase)
    $start.ArgumentList.Add($Target)
    $start.Environment['VS_LAB_IGGY_ENDPOINT'] = 'http://127.0.0.1:18090'
    $start.Environment['VS_LAB_IGGY_USERNAME'] = 'iggy-lab'
    $start.Environment['VS_LAB_IGGY_PASSWORD'] = $password
    $child = [Diagnostics.Process]::Start($start)
    $output = $child.StandardOutput.ReadToEndAsync()
    $errors = $child.StandardError.ReadToEndAsync()
    try {
        if (!$child.WaitForExit(90000)) { $child.Kill(); $child.WaitForExit(); throw '真实反馈探针超过90秒' }
        $body = $output.GetAwaiter().GetResult()
        $errorText = $errors.GetAwaiter().GetResult()
        $body | Set-Content -LiteralPath (Join-Path $attempt "$Label.json") -Encoding utf8NoBOM
        $errorText | Set-Content -LiteralPath (Join-Path $attempt "probe-$Label.stderr.log") -Encoding utf8NoBOM
        if ($child.ExitCode -ne 0) { throw "真实反馈探针失败：$Phase；见本轮错误日志" }
        return $body | ConvertFrom-Json
    } finally { $child.Dispose() }
}
function Wait-Broker {
    $deadline = (Get-Date).AddSeconds(30)
    do {
        try {
            $response = Invoke-WebRequest 'http://127.0.0.1:18090/ping' -NoProxy -TimeoutSec 2
            if ($response.StatusCode -eq 200) { return }
        } catch { }
        if ((Get-Date) -gt $deadline) { throw '真实broker未在期限内就绪' }
        Start-Sleep -Milliseconds 200
    } while ($true)
}
$password = Invoke-Guest "sed -n 's/^IGGY_ROOT_PASSWORD=//p' /mnt/o/video-lab/broker.env"
if ($password -notmatch '^[0-9a-f]{48}$') { throw '来宾临时凭据格式无效' }
$completed = $false
try {
    $null = Invoke-Guest 'systemctl reset-failed video-iggy; systemctl start video-iggy'
    Wait-Broker
    if ($ResumeSeed) {
        $seed = Get-Content -LiteralPath (Join-Path $run 'seed.json') -Raw | ConvertFrom-Json
        if (!$seed.passed -or $seed.phase -ne 'seed' -or $seed.backend -ne 'real-iggy-singleton' -or
            !(Test-Path -LiteralPath (Join-Path $run 'contract/checkpoint.json'))) {
            throw '仅允许从明确成功且有检查点的seed恢复，不能重发未知写入'
        }
    } else {
        if (Test-Path -LiteralPath (Join-Path $run 'contract')) { throw '已有检查点，须显式恢复seed，不自动重写' }
        $seed = Run-Probe 'seed' (Join-Path $run 'contract') 'seed'
        $seed | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $run 'seed.json') -Encoding utf8NoBOM
    }
    $before = Invoke-Guest 'systemctl show video-iggy -p MainPID -p ActiveState -p SubState'
    $null = Invoke-Guest 'systemctl stop video-iggy; test "$(systemctl show video-iggy -p ExecMainStatus --value)" = 0; test "$(systemctl show video-iggy -p ActiveState --value)" = inactive'
    $normal = Invoke-Guest 'systemctl show video-iggy -p MainPID -p ActiveState -p SubState -p ExecMainStatus -p Result'
    $null = Invoke-Guest 'systemctl start video-iggy'
    Wait-Broker
    $normalTarget = Join-Path $attempt 'normal-contract'
    $null = New-Item -ItemType Directory -Path $normalTarget
    foreach ($name in @('checkpoint.json','before.json')) {
        Copy-Item -LiteralPath (Join-Path $run "contract/$name") -Destination (Join-Path $normalTarget $name)
    }
    $verified = Run-Probe 'verify' $normalTarget 'normal-verify'
    $null = Invoke-Guest 'systemctl kill --kill-whom=main --signal=SIGKILL video-iggy; for i in $(seq 1 100); do test "$(systemctl show video-iggy -p MainPID --value)" = 0 && break; sleep 0.1; done; test "$(systemctl show video-iggy -p MainPID --value)" = 0; test "$(systemctl show video-iggy -p ExecMainCode --value)" = 2; test "$(systemctl show video-iggy -p ExecMainStatus --value)" = 9'
    $killed = Invoke-Guest 'systemctl show video-iggy -p MainPID -p ActiveState -p SubState -p ExecMainCode -p ExecMainStatus -p Result'
    $null = Invoke-Guest 'systemctl reset-failed video-iggy; systemctl start video-iggy'
    Wait-Broker
    $killedTarget = Join-Path $attempt 'killed-contract'
    $null = New-Item -ItemType Directory -Path $killedTarget
    foreach ($name in @('checkpoint.json','before.json')) {
        Copy-Item -LiteralPath (Join-Path $run "contract/$name") -Destination (Join-Path $killedTarget $name)
    }
    $recovered = Run-Probe 'verify' $killedTarget 'killed-verify'
    $null = Invoke-Guest 'systemctl stop video-iggy; test "$(systemctl show video-iggy -p ExecMainStatus --value)" = 0; test "$(systemctl show video-iggy -p MainPID --value)" = 0'
    $journal = Invoke-Guest 'journalctl -u video-iggy --no-pager -o cat -n 300'
    $journal | Set-Content -LiteralPath (Join-Path $attempt 'broker.journal.log') -Encoding utf8NoBOM
    [ordered]@{
        schema='iggy-linux-vm-restart-v1';passed=$true;physical_hosts=1;verification_directory=$attempt
        broker_binary_sha256='b3331f7b62fc84e3df5c2e6c739a9a5b39df1722eadada98eeab5427bf9719ae'
        guest_root_native_filesystem=$true;host_runtime_root=$run
        normal_stop_state=$normal;before=$before;forced_stop_state=$killed
        seed=$seed;normal_recovery=$verified;forced_recovery=$recovered
        normal_stop_zero_verified=$true;main_pid_reclaimed=$true
        kill_after_ack_not_power_failure=$true;software_emulation=$true
        real_physical_cluster_or_performance_verified=$false
    } | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $attempt 'broker-restart-receipt.json') -Encoding utf8NoBOM
    $completed = $true
    Get-Content -LiteralPath (Join-Path $attempt 'broker-restart-receipt.json') -Raw
} finally {
    $password = $null
    if (!$completed) {
        try { $null = Invoke-Guest 'systemctl stop video-iggy' } catch { Write-Warning '来宾broker未确认停止，须回收本轮虚拟机' }
    }
}
