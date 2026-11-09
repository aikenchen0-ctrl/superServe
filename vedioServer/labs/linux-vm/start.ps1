param(
    [string]$RuntimeRoot = 'O:\CodexVideoBuild\linux-runtime'
)
$ErrorActionPreference = 'Stop'
. 'D:\CodexVideoTools\enter.ps1'
if (!$RuntimeRoot.StartsWith('O:\', [StringComparison]::OrdinalIgnoreCase)) {
    throw '虚拟机运行目录须位于O盘'
}
if ((Get-PSDrive O).Free -lt 4GB) { throw 'O盘不足4GiB，拒绝启动虚拟盘' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$run = Join-Path $RuntimeRoot "run-$stamp"
$null = New-Item -ItemType Directory -Path $run
$seed = Join-Path $run 'seed'
$null = New-Item -ItemType Directory -Path $seed
$qemu = Join-Path $RuntimeRoot 'qemu/qemu-system-x86_64.exe'
$image = Join-Path $RuntimeRoot 'debian-13-genericcloud-amd64-20261103-2651.qcow2'
$overlay = Join-Path $run 'guest.qcow2'
$key = Join-Path $run 'id_ed25519'
foreach ($port in @(18080,18022,18090)) {
    $reservation = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$port)
    try { $reservation.Start() }
    finally { $reservation.Stop() }
}
& ssh-keygen -t ed25519 -N '' -f $key -q
if ($LASTEXITCODE -ne 0) { throw '临时SSH密钥生成失败' }
$public = (Get-Content -LiteralPath "$key.pub" -Raw).Trim()
$userData = @"
#cloud-config
disable_root: false
ssh_pwauth: false
users:
  - default
  - name: root
    ssh_authorized_keys:
      - $public
runcmd:
  - [ sh, -c, "echo video-cloud-init-ready-v1 > /root/video-ready" ]
"@
$userData | Set-Content -LiteralPath (Join-Path $seed 'user-data') -Encoding utf8NoBOM
"instance-id: video-$stamp`nlocal-hostname: video-lab" |
    Set-Content -LiteralPath (Join-Path $seed 'meta-data') -Encoding utf8NoBOM
'' | Set-Content -LiteralPath (Join-Path $seed 'vendor-data') -Encoding utf8NoBOM
"version: 2`nethernets:`n  all:`n    match:`n      name: en*`n    dhcp4: true" |
    Set-Content -LiteralPath (Join-Path $seed 'network-config') -Encoding utf8NoBOM
Copy-Item -LiteralPath 'D:\CodexBuildCaches\superServe-b4be-video-20261106\iggy-target\debug\iggy-server' -Destination (Join-Path $seed 'iggy-server')
Copy-Item -LiteralPath '.artifacts/upstream/iggy/core/server/config.toml' -Destination (Join-Path $seed 'config.toml')
if ((Get-FileHash -LiteralPath (Join-Path $seed 'iggy-server')).Hash.ToLowerInvariant() -ne
    'b3331f7b62fc84e3df5c2e6c739a9a5b39df1722eadada98eeab5427bf9719ae') { throw '历史broker制品摘要不符' }
& (Join-Path $RuntimeRoot 'qemu/qemu-img.exe') create -f qcow2 -F qcow2 -b $image $overlay 6G
if ($LASTEXITCODE -ne 0) { throw '新虚拟磁盘创建失败' }
$server = Start-Process -FilePath (Get-Command python).Source -WindowStyle Hidden -PassThru `
    -ArgumentList @((Join-Path $PSScriptRoot 'serve-seed.py'),$seed,'18080') `
    -RedirectStandardOutput (Join-Path $run 'seed.stdout.log') `
    -RedirectStandardError (Join-Path $run 'seed.stderr.log')
try {
    $arguments = @(
        '-accel','tcg,thread=multi','-machine','q35','-cpu','max','-smp','2','-m','1536',
        '-drive',"file=$overlay,if=virtio,format=qcow2",
        '-netdev','user,id=net0,hostfwd=tcp:127.0.0.1:18022-:22,hostfwd=tcp:127.0.0.1:18090-:8090',
        '-device','virtio-net-pci,netdev=net0',
        '-smbios','type=1,serial=ds=nocloud;s=http://10.0.2.2:18080/',
        '-display','none','-serial',("file:"+(Join-Path $run 'serial.log')),
        '-monitor','none','-no-reboot'
    )
    $quoted = @($arguments | ForEach-Object { '"' + $_.Replace('"','\"') + '"' })
    $vm = Start-Process -FilePath $qemu -ArgumentList $quoted -WorkingDirectory $run `
        -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $run 'qemu.stdout.log') `
        -RedirectStandardError (Join-Path $run 'qemu.stderr.log')
    $receipt = [ordered]@{
        schema='video-linux-vm-launch-v1';run=$run;vm_pid=$vm.Id
        vm_started_utc=$vm.StartTime.ToUniversalTime().ToString('o')
        seed_pid=$server.Id;seed_started_utc=$server.StartTime.ToUniversalTime().ToString('o')
        key=$key;ssh_port=18022;broker_port=18090
        physical_hosts=1;software_emulation=$true
        no_wsl_docker_or_system_configuration_changed=$true
    }
    $receipt | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $run 'launch.json') -Encoding utf8NoBOM
    $receipt | ConvertTo-Json
} catch {
    if (!$server.HasExited) { $server.Kill(); $server.WaitForExit() }
    throw
}
