#!/bin/sh
set -eu
# 独立虚拟盘内安装运行依赖，不能作为物理多机或性能证据。
export DEBIAN_FRONTEND=noninteractive
mkdir -p /mnt/o/video-lab/data
cd /mnt/o/video-lab
curl --fail --max-time 60 "http://10.0.2.2:18080/iggy-server" -o iggy-server
curl --fail --max-time 10 "http://10.0.2.2:18080/config.toml" -o config.toml
echo 'b3331f7b62fc84e3df5c2e6c739a9a5b39df1722eadada98eeab5427bf9719ae  iggy-server' | sha256sum -c -
chmod 700 iggy-server
ldd iggy-server > dependencies-before.txt || true
timeout --signal=KILL 180s apt-get update
timeout --signal=KILL 180s apt-get install -y --no-install-recommends libhwloc15 libssl3t64
ldd iggy-server > dependencies-after.txt
uname -a > environment.txt
stat -f -c %T /mnt/o/video-lab/data >> environment.txt
printf '%s\n' 'video-guest-prepared-v1' >/mnt/o/video-lab/prepared
