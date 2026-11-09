param([Parameter(Mandatory)][string]$LaunchFile)
$ErrorActionPreference = 'Stop'
. 'D:\CodexVideoTools\enter.ps1'
$previous = Get-Content -LiteralPath $LaunchFile -Raw | ConvertFrom-Json
$runtime = 'O:\CodexVideoBuild\linux-runtime'
$run = [IO.Path]::GetFullPath($previous.run)
if ($previous.schema -ne 'video-linux-vm-launch-v1' -or
    !$run.StartsWith("$runtime\run-", [StringComparison]::OrdinalIgnoreCase) -or
    !(Test-Path -LiteralPath (Join-Path $run 'cleanup.json'))) {
    throw '只能恢复已清理的本实验O盘来宾'
}
if ((Get-PSDrive O).Free -lt 2GB) { throw 'O盘剩余空间不足2GiB' }
foreach ($port in @(18080,18022,18090)) {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$port)
    try { $listener.Start() } finally { $listener.Stop() }
}
$attempt = Join-Path $run ('resume-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
$null = New-Item -ItemType Directory -Path $attempt
$seed = Start-Process -FilePath (Get-Command python).Source -WindowStyle Hidden -PassThru `
    -ArgumentList @((Join-Path $PSScriptRoot 'serve-seed.py'),(Join-Path $run 'seed'),'18080') `
    -RedirectStandardOutput (Join-Path $attempt 'seed.stdout.log') `
    -RedirectStandardError (Join-Path $attempt 'seed.stderr.log')
try {
    $arguments = @(
        '-accel','tcg,thread=multi','-machine','q35','-cpu','max','-smp','2','-m','1536',
        '-drive',("file="+(Join-Path $run 'guest.qcow2')+",if=virtio,format=qcow2"),
        '-netdev','user,id=net0,hostfwd=tcp:127.0.0.1:18022-:22,hostfwd=tcp:127.0.0.1:18090-:8090',
        '-device','virtio-net-pci,netdev=net0',
        '-smbios','type=1,serial=ds=nocloud;s=http://10.0.2.2:18080/',
        '-display','none','-serial',("file:"+(Join-Path $attempt 'serial.log')),
        '-monitor','none','-no-reboot'
    )
    $quoted = @($arguments | ForEach-Object { '"' + $_.Replace('"','\"') + '"' })
    $vm = Start-Process -FilePath (Join-Path $runtime 'qemu/qemu-system-x86_64.exe') `
        -ArgumentList $quoted -WorkingDirectory $run -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $attempt 'qemu.stdout.log') `
        -RedirectStandardError (Join-Path $attempt 'qemu.stderr.log')
    $receipt = [ordered]@{
        schema='video-linux-vm-launch-v1';run=$run;attempt=$attempt;vm_pid=$vm.Id
        vm_started_utc=$vm.StartTime.ToUniversalTime().ToString('o')
        seed_pid=$seed.Id;seed_started_utc=$seed.StartTime.ToUniversalTime().ToString('o')
        key=$previous.key;ssh_port=18022;broker_port=18090
        physical_hosts=1;software_emulation=$true;resumed_existing_guest=$true
        no_wsl_docker_or_system_configuration_changed=$true
    }
    $receipt | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $attempt 'launch.json') -Encoding utf8NoBOM
    $receipt | ConvertTo-Json
} catch {
    if (!$seed.HasExited) { $seed.Kill(); $seed.WaitForExit() }
    throw
}
