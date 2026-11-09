#!/usr/bin/env bash
set -euo pipefail

# 构建固定上游服务端；所有新工具链、缓存、临时文件和产物必须放在O盘或D盘。
lab="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$lab/../../.." && pwd)"
case "${VS_IGGY_VERSION:-server-0.10.0}" in
  server-0.10.0)
    revision=91e0206367aad2d30259f7d45203832b08ae84e7
    toolchain=1.99.1 ;;
  server-0.9.0-rc.1)
    revision=71f29618ba04917fded0ef5cd085c206fef0ee49
    toolchain=1.98.0 ;;
  *) printf '%s\n' '只接受已固定的0.10.0或历史0.9.0-rc.1源码版本。' >&2; exit 2 ;;
esac
prefix="$(realpath -m "${VS_IGGY_TOOLCHAIN_PREFIX:?需要指定位于O盘或D盘的隔离工具链目录}")"
build_root="$(realpath -m "${VS_IGGY_BUILD_ROOT:?需要指定位于O盘或D盘的隔离构建目录}")"

require_workspace_volume() {
  local path
  path="$(realpath -m "$1")"
  [[ "$path" == /mnt/o/* || "$path" == /mnt/d/* ]] ||
    { printf '拒绝在O盘或D盘以外写入：%s\n' "$path" >&2; exit 2; }
}

require_workspace_volume "$prefix"
require_workspace_volume "$build_root"
native="${VS_IGGY_NATIVE_PREFIX:-$prefix/native}"
target="${VS_IGGY_TARGET_DIR:-$build_root/target}"
receipt_root="${VS_IGGY_RECEIPT_ROOT:-$root/.artifacts/iggy-profile-sharding}"
require_workspace_volume "$native"
require_workspace_volume "$target"
require_workspace_volume "$receipt_root"

export CARGO_HOME="$(realpath -m "$prefix/cargo")"
export RUSTUP_HOME="$(realpath -m "$prefix/rustup")"
export CARGO_TARGET_DIR="$(realpath -m "$target")"
require_workspace_volume "$CARGO_HOME"
require_workspace_volume "$RUSTUP_HOME"
require_workspace_volume "$build_root/source"
export CARGO_INCREMENTAL=0
export CARGO_PROFILE_DEV_DEBUG=0
export CARGO_PROFILE_DEV_INCREMENTAL=false
export TEMP="$build_root/tmp"
export TMP="$TEMP"
export TMPDIR="$TEMP"
require_workspace_volume "$TEMP"
mkdir -p "$TEMP" "$receipt_root"
export PATH="$CARGO_HOME/bin:$PATH"
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] ||
  { printf '%s\n' '本实验需要x86_64 Linux。' >&2; exit 2; }
[[ -x "$CARGO_HOME/bin/rustup" && -x "$CARGO_HOME/bin/cargo" ]] ||
  { printf '%s\n' '缺少隔离工具链，请设置VS_IGGY_TOOLCHAIN_PREFIX。' >&2; exit 2; }
rustup run "$toolchain" rustc --version
if [[ -x "$prefix/native/usr/bin/protoc" ]]; then
  export PROTOC="$prefix/native/usr/bin/protoc"
  export PROTOC_INCLUDE="$prefix/native/usr/include"
  export LD_LIBRARY_PATH="$prefix/native/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  export PATH="$prefix/native/usr/bin:$PATH"
  export PKG_CONFIG_PATH="$prefix/native/usr/lib/x86_64-linux-gnu/pkgconfig:$prefix/native/usr/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
  export PKG_CONFIG_LIBDIR="$prefix/native/usr/lib/x86_64-linux-gnu/pkgconfig:$prefix/native/usr/share/pkgconfig"
fi
export PATH="$native/usr/bin:$PATH"
export LD_LIBRARY_PATH="$native/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export PKG_CONFIG_PATH="$native/usr/lib/x86_64-linux-gnu/pkgconfig"
export PKG_CONFIG_SYSROOT_DIR="$native"

source="$build_root/source"
mkdir -p "$build_root"
exec 9>"$build_root/build.lock"
flock -n 9 || { printf '%s\n' '另一构建正在使用此目录。' >&2; exit 2; }
if [[ ! -d "$source" ]]; then
  git clone --quiet --no-hardlinks --no-checkout "$root/.artifacts/upstream/iggy" "$source"
  git -C "$source" -c core.autocrlf=false checkout --quiet --detach "$revision"
fi
cd "$source"
[[ "$(git rev-parse HEAD)" == "$revision" && -z "$(git status --porcelain)" ]] ||
  { printf '%s\n' '隔离源码提交不匹配或存在修改，停止构建。' >&2; exit 1; }
lock_hash="$(sha256sum Cargo.lock | cut -d ' ' -f1)"
export IGGY_CI_BUILD=true
export CARGO_NET_GIT_FETCH_WITH_CLI=true
jobs="${VS_IGGY_BUILD_JOBS:-2}"
[[ "$jobs" =~ ^[1-9][0-9]*$ ]] ||
  { printf '%s\n' '并发编译数无效。' >&2; exit 2; }
command=(cargo "+$toolchain" build --locked --bin iggy-server --no-default-features --jobs "$jobs")
registry="${VS_IGGY_REGISTRY_INDEX:-sparse+https://rsproxy.cn/index/}"
[[ "$registry" =~ ^sparse\+https://[a-zA-Z0-9./_-]+/$ ]] ||
  { printf '%s\n' '仅接受不含凭证的HTTPS稀疏索引。' >&2; exit 2; }
command+=(--config 'source.crates-io.replace-with="iggy-lab"'
  --config "source.iggy-lab.registry=\"$registry\"")
receipt_dir="$(mktemp -d "$receipt_root/iggy-build-XXXXXXXX")"
printf '构建日志：%s/build.log\n' "$receipt_dir"
set +e
timeout --signal=TERM --kill-after=15s 20m "${command[@]}" >"$receipt_dir/build.log" 2>&1
status=$?
set -e
[[ "$(sha256sum Cargo.lock | cut -d ' ' -f1)" == "$lock_hash" ]] ||
  { printf '%s\n' '构建改变了上游锁文件。' >&2; exit 1; }
if [[ "$status" != 0 ]]; then
  tail -n 30 "$receipt_dir/build.log"
  printf '构建未通过，退出码：%s\n' "$status" >&2
  exit "$status"
fi
printf '固定提交：%s\n' "$revision"
printf '服务二进制：%s\n' "$CARGO_TARGET_DIR/debug/iggy-server"
sha256sum "$CARGO_TARGET_DIR/debug/iggy-server" Cargo.lock
