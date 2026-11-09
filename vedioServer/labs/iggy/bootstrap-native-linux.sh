#!/usr/bin/env bash
set -euo pipefail

# 仅解包实验原生依赖，不调用系统安装或更新命令。
prefix="${VS_IGGY_NATIVE_PREFIX:?需要指定隔离原生依赖绝对路径}"
prefix="$(realpath -m "$prefix")"
[[ "$prefix" == /mnt/o/* || "$prefix" == /mnt/d/* ]] ||
  { printf '%s\n' '原生依赖只能写入O盘或D盘。' >&2; exit 2; }
mkdir -p "$prefix/packages"
mkdir -p "$prefix/tmp"
export TMPDIR="$prefix/tmp" TEMP="$prefix/tmp" TMP="$prefix/tmp"
cd "$prefix/packages"
timeout --kill-after=5s 120s apt-get download \
  pkgconf pkgconf-bin libpkgconf3 libhwloc-dev libhwloc15 libnuma-dev libnuma1 libudev-dev libudev1
sha256sum ./*.deb
for package in ./*.deb; do
  dpkg-deb --extract "$package" "$prefix"
done
