#!/usr/bin/env bash
set -euo pipefail

# 工具链仅写入实验前缀，不修改用户默认 Rust 或终端配置。
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] ||
  { printf '%s\n' '本实验需要 x86_64 Linux。' >&2; exit 2; }
toolchain=1.99.0
prefix="$HOME/.cache/superServe/rustfs-linux-toolchain"
export CARGO_HOME="$prefix/cargo"
export RUSTUP_HOME="$prefix/rustup"
export PATH="$CARGO_HOME/bin:$PATH"
mkdir -p "$prefix/bootstrap"

if [[ ! -x "$CARGO_HOME/bin/rustup" ]]; then
  cd "$prefix/bootstrap"
  installer_url=https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init
  curl --silent --show-error --proto '=https' --tlsv1.2 --fail --location --retry 2 \
    --connect-timeout 15 --max-time 180 "$installer_url" -o rustup-init.download
  curl --silent --show-error --proto '=https' --tlsv1.2 --fail --location --retry 2 \
    --connect-timeout 15 --max-time 60 "$installer_url.sha256" -o rustup-init.sha256
  read -r expected _ < rustup-init.sha256 || [[ -n "${expected:-}" ]]
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] ||
    { printf '%s\n' '官方安装器校验值格式不正确。' >&2; exit 1; }
  printf '%s  rustup-init.download\n' "$expected" | sha256sum --check -
  chmod +x rustup-init.download
  ./rustup-init.download -y --no-modify-path --profile minimal \
    --default-toolchain "$toolchain"
elif ! rustup run "$toolchain" rustc --version >/dev/null 2>&1; then
  rustup toolchain install "$toolchain" --profile minimal
fi

rustup run "$toolchain" rustc --version
rustup run "$toolchain" cargo --version
printf 'Linux 实验工具链目录：%s\n' "$prefix"
