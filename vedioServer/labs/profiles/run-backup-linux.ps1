param(
    [Parameter(Mandatory)][string]$LaunchFile,
    [Parameter(Mandatory)][string]$LinuxTestBinary,
    [Parameter(Mandatory)][string]$LinuxCliBinary,
    [Parameter(Mandatory)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
. 'D:\CodexVideoTools\enter.ps1'
$root = (Get-Location).Path
$out = [IO.Path]::GetFullPath($OutputDirectory)
if (!$out.StartsWith("$root\.artifacts\",[StringComparison]::OrdinalIgnoreCase) -or
    (Test-Path -LiteralPath $out)) { throw 'Linux备份演练须使用新的本工作区证据目录' }
foreach ($path in @($LinuxTestBinary,$LinuxCliBinary)) {
    if (!$path.StartsWith('O:\',[StringComparison]::OrdinalIgnoreCase) -or
        !(Test-Path -LiteralPath $path -PathType Leaf)) { throw 'Linux制品必须是已存在O盘文件' }
}
$null = New-Item -ItemType Directory -Path $out
$testHash = (Get-FileHash -LiteralPath $LinuxTestBinary).Hash.ToLowerInvariant()
$cliHash = (Get-FileHash -LiteralPath $LinuxCliBinary).Hash.ToLowerInvariant()
$vm = (& (Join-Path $PSScriptRoot '../linux-vm/resume.ps1') -LaunchFile $LaunchFile | Out-String) | ConvertFrom-Json
$ssh = @('-F','NUL','-o','BatchMode=yes','-o','ConnectTimeout=3','-o','StrictHostKeyChecking=yes',
    '-o',"UserKnownHostsFile=$($vm.run)/known_hosts",'-i',$vm.key,'-p',"$($vm.ssh_port)",'root@127.0.0.1')
$guest = '/opt/video-lab/profile-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff')
try {
    $deadline = (Get-Date).AddSeconds(120)
    do {
        & ssh @ssh true 2>$null
        if ($LASTEXITCODE -eq 0) { break }
        if ((Get-Date) -gt $deadline) { throw 'Linux来宾SSH未就绪' }
        Start-Sleep -Milliseconds 500
    } while ($true)
    & ssh @ssh "set -eu; test ! -e '$guest'; mkdir -p '$guest'"
    if ($LASTEXITCODE -ne 0) { throw 'Linux演练目录不可用' }
    $scp = @('-F','NUL','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',
        '-o',"UserKnownHostsFile=$($vm.run)/known_hosts",'-i',$vm.key,'-P',"$($vm.ssh_port)")
    & scp @scp $LinuxTestBinary "root@127.0.0.1:$guest/backup-test"
    if ($LASTEXITCODE -ne 0) { throw 'Linux测试制品复制失败' }
    & scp @scp $LinuxCliBinary "root@127.0.0.1:$guest/profile-backup"
    if ($LASTEXITCODE -ne 0) { throw 'Linux CLI制品复制失败' }
    $command = "set -eu; cd '$guest'; echo '$testHash  backup-test' | sha256sum -c -; echo '$cliHash  profile-backup' | sha256sum -c -; chmod 755 backup-test profile-backup; mkdir tmp; TMPDIR=`"`$PWD/tmp`" ./backup-test --test-threads=1; TMPDIR=`"`$PWD/tmp`" VS_TEST_PROFILE_BACKUP=`"`$PWD/profile-backup`" ./backup-test independent_cli_ --ignored --nocapture --test-threads=1; test -z `"`$(ls -A tmp)`""
    $lines = @(& ssh @ssh $command 2>&1)
    $code = $LASTEXITCODE
    $lines | Set-Content -LiteralPath (Join-Path $out 'tests.log') -Encoding utf8NoBOM
    if ($code -ne 0) { throw 'Linux真实来宾测试失败，日志保留，不自动重试' }
    $text = $lines -join "`n"
    if ($text -notmatch 'test result: ok\. 10 passed; 0 failed; 1 ignored;' -or
        $text -notmatch 'test result: ok\. 1 passed; 0 failed; 0 ignored;' -or
        $text -notmatch '"schema":"profile-backup-cli-contract-v1"') {
        throw '缺少完整Linux常规和显式CLI测试摘要'
    }
    [ordered]@{
        schema='profile-backup-linux-v1';passed=$true;ordinary_tests=10;explicit_cli_tests=1
        test_sha256=$testHash;cli_sha256=$cliHash;guest_directory=$guest
        physical_hosts=1;software_emulation=$true;existing_guest_reused=$true
        unix_permissions_and_symlink_tests=$true;not_physical_cluster_or_power_loss=$true
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $out 'receipt.json') -Encoding utf8NoBOM
} finally {
    & (Join-Path $PSScriptRoot '../linux-vm/stop.ps1') -LaunchFile (Join-Path $vm.attempt 'launch.json')
    Copy-Item -LiteralPath (Join-Path $vm.attempt 'cleanup.json') -Destination (Join-Path $out 'cleanup.json')
    foreach ($port in @(18080,18022,18090)) {
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$port)
        try { $listener.Start() } finally { $listener.Stop() }
    }
}
Get-Content -LiteralPath (Join-Path $out 'receipt.json') -Raw
