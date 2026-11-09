#!/bin/sh
set -eu
root=/mnt/o/video-lab
test -f "$root/prepared"
test "$(stat -f -c %T "$root/data")" = ext2/ext3
test "$(sha256sum "$root/iggy-server" | cut -d' ' -f1)" = b3331f7b62fc84e3df5c2e6c739a9a5b39df1722eadada98eeab5427bf9719ae
test ! -e "$root/broker.env"
umask 077
password="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
cat >"$root/broker.env" <<EOF
IGGY_CONFIG_PATH=$root/config.toml
IGGY_PATH=$root/data
IGGY_HTTP_ENABLED=true
IGGY_HTTP_ADDRESS=0.0.0.0:8090
IGGY_NODE_ADVERTISED_ADDRESS=127.0.0.1
IGGY_TCP_ENABLED=false
IGGY_QUIC_ENABLED=false
IGGY_WEBSOCKET_ENABLED=false
IGGY_MEMORY_POOL_ENABLED=false
IGGY_SHARDING_CPU_ALLOCATION=1
IGGY_SHARDING_PIN_CORES=false
IGGY_LOGGING_FILE_ENABLED=false
IGGY_TELEMETRY_ENABLED=false
IGGY_ROOT_USERNAME=iggy-lab
IGGY_ROOT_PASSWORD=$password
EOF
cat >/etc/systemd/system/video-iggy.service <<EOF
[Unit]
Description=Fixed Iggy single-guest laboratory
[Service]
Type=exec
WorkingDirectory=$root
EnvironmentFile=$root/broker.env
ExecStart=$root/iggy-server
KillSignal=SIGINT
TimeoutStopSec=20s
KillMode=control-group
RuntimeMaxSec=10min
Restart=no
UMask=0077
StandardOutput=journal
StandardError=journal
EOF
systemd-analyze verify /etc/systemd/system/video-iggy.service
systemctl daemon-reload
systemctl start video-iggy.service
printf '%s\n' 'video-iggy-start-requested-v1'
