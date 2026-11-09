#!/usr/bin/env bash
set -euo pipefail

# 只解包构建工具，不安装系统包、不执行包维护脚本。
grep -q '^VERSION_ID="24.04"$' /etc/os-release &&
  [[ "$(dpkg --print-architecture)" == amd64 ]] ||
  { printf '%s\n' '本工具包固定用于 Ubuntu 24.04 amd64。' >&2; exit 2; }
prefix="$HOME/.cache/superServe/rustfs-linux-toolchain"
version=3.21.12-8.2ubuntu0.4
packages=(protobuf-compiler libprotoc32t64 libprotobuf32t64 libprotobuf-dev)
mkdir -p "$prefix/native-packages" "$prefix/native"
cd "$prefix/native-packages"
for package in "${packages[@]}"; do
  apt-get download "$package=$version"
  archive="${package}_${version}_amd64.deb"
  [[ -f "$archive" ]] || { printf '工具包缺失：%s\n' "$archive" >&2; exit 1; }
  dpkg-deb --extract "$archive" "$prefix/native"
done
sha256sum ./*.deb
LD_LIBRARY_PATH="$prefix/native/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
  "$prefix/native/usr/bin/protoc" --version
