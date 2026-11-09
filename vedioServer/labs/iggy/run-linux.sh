#!/usr/bin/env bash
set -euo pipefail

lab="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$lab/lifecycle.sh"
iggy_require_runtime
[[ $# == 2 && -x "$1" && -f "$2" ]] ||
  { printf '%s\n' '用法：run-linux.sh <Linux Iggy二进制> <Windows Rust实验入口exe>' >&2; exit 2; }
broker="$(realpath "$1")"
probe="$(realpath "$2")"
source_root="${VS_IGGY_SOURCE_ROOT:?需要指定固定版本Iggy源码目录}"
source_root="$(realpath "$source_root")"
[[ "$(git -C "$source_root" rev-parse HEAD)" == 71f29618ba04917fded0ef5cd085c206fef0ee49 ]] ||
  { printf '%s\n' '反馈重启实验只接受已有0.9系固定源码，不作为0.10运行入口。' >&2; exit 2; }
run_root="${VS_IGGY_RUN_ROOT:?需要指定实验数据和收据的绝对父目录}"
run_root="$(realpath -m "$run_root")"
native="${VS_IGGY_NATIVE_PREFIX:?需要指定隔离原生依赖路径}"
native="$(realpath -m "$native")"
[[ "$run_root" == /mnt/o/* || "$run_root" == /mnt/d/* ]] ||
  { printf '%s\n' '实验数据只能写入O盘或D盘。' >&2; exit 2; }
[[ "$native" == /mnt/o/* || "$native" == /mnt/d/* ]] ||
  { printf '%s\n' '原生依赖只能从O盘或D盘读取。' >&2; exit 2; }
storage_root="$(realpath -m "${VS_IGGY_STORAGE_ROOT:?需要显式指定Linux原生文件系统的非C盘节点数据目录}")"
iggy_require_data_filesystem "$storage_root"
timeout --signal=KILL 5s mkdir -p "$run_root/tmp" "$storage_root"
export TMPDIR="$run_root/tmp" TEMP="$run_root/tmp" TMP="$run_root/tmp"
run="$(timeout --signal=KILL 5s mktemp -d "$run_root/iggy-feedback-XXXXXXXX")"
node_root="$(timeout --signal=KILL 5s mktemp -d "$storage_root/node-XXXXXXXX")"
printf '%s\n' "$node_root" >"$run/node-root.txt"
timeout --signal=KILL 20s cp "$broker" "$node_root/iggy-server"
broker="$node_root/iggy-server"
restart_mode="${VS_IGGY_RESTART_MODE:-sigint}"
[[ "$restart_mode" == sigint || "$restart_mode" == sigkill ]] ||
  { printf '%s\n' '重启模式只能为sigint或sigkill。' >&2; exit 2; }
printf '%s\n' "$restart_mode" >"$run/restart-mode.txt"
export LD_LIBRARY_PATH="$native/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
export IGGY_CONFIG_PATH="$source_root/core/server/config.toml"
export IGGY_PATH="$node_root/data"
export IGGY_HTTP_ENABLED=true
export IGGY_HTTP_ADDRESS="127.0.0.1:$port"
export IGGY_TCP_ENABLED=false IGGY_QUIC_ENABLED=false IGGY_WEBSOCKET_ENABLED=false
export IGGY_MEMORY_POOL_ENABLED=false IGGY_SHARDING_CPU_ALLOCATION=1 IGGY_SHARDING_PIN_CORES=false
export IGGY_LOGGING_FILE_ENABLED=false IGGY_TELEMETRY_ENABLED=false
export IGGY_ROOT_USERNAME=iggy-lab
export IGGY_ROOT_PASSWORD
IGGY_ROOT_PASSWORD="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
export VS_LAB_IGGY_ENDPOINT="http://127.0.0.1:$port"
export VS_LAB_IGGY_USERNAME="$IGGY_ROOT_USERNAME"
export VS_LAB_IGGY_PASSWORD="$IGGY_ROOT_PASSWORD"
# 仅传递本轮凭证给Windows实验入口；不写入检查点或终端输出。
export WSLENV="${WSLENV:+$WSLENV:}VS_LAB_IGGY_ENDPOINT/w:VS_LAB_IGGY_USERNAME/w:VS_LAB_IGGY_PASSWORD/w"
pid=""
cleanup() {
  if [[ -n "$pid" ]]; then
    if ! iggy_stop_child "$pid" KILL 10 "$run/cleanup-pending.log"; then
      printf '%s\n' '实验清理未完成，不产生成功汇总。' >&2
      return 1
    fi
    pid=""
  fi
}
trap 'status=$?; trap - EXIT; cleanup || status=1; exit "$status"' EXIT
trap 'exit 130' INT TERM
start() {
  local phase="$1"
  local deadline=$((SECONDS + 30))
  "$broker" >"$node_root/$phase-server.log" 2>&1 &
  pid=$!
  iggy_register_child "$pid"
  while (( SECONDS < deadline )); do
    kill -0 "$pid" 2>/dev/null ||
      { printf '%s\n' 'Iggy提前退出，日志保留在节点目录。' >&2; return 1; }
    if curl --silent --fail --max-time 1 "$VS_LAB_IGGY_ENDPOINT/ping" >/dev/null; then
      return 0
    fi
    sleep 0.1
  done
  printf '%s\n' 'Iggy未在启动期限内就绪。' >&2
  return 1
}
stop() {
  iggy_stop_child "$pid" INT 30 "$run/stop-pending.log" || return $?
  pid=""
  [[ "$IGGY_CHILD_STATUS" == 0 ]] ||
    { printf 'Iggy正常退出失败，退出码：%s\n' "$IGGY_CHILD_STATUS" >&2; return 1; }
}
printf '实验收据：%s\n' "$run"
sha256sum "$broker" "$probe" "$IGGY_CONFIG_PATH" >"$run/artifact-sha256.txt"
start before
timeout --signal=TERM --kill-after=2s 90s "$probe" seed "$(wslpath -w "$run/contract")" >"$run/seed.json"
if [[ "$restart_mode" == sigkill ]]; then
  # 强杀发生在确认及首次快照之后，不能宣称为确认瞬间断电。
  iggy_stop_child "$pid" KILL 10 "$run/kill-pending.log"
  pid=""
  [[ "$IGGY_CHILD_STATUS" == 137 ]] ||
    { printf '%s\n' '强杀退出状态不符。' >&2; exit 1; }
else
  stop
fi
start after
timeout --signal=TERM --kill-after=2s 90s "$probe" verify "$(wslpath -w "$run/contract")" >"$run/verify.json"
stop
cleanup
trap - EXIT
printf '%s\n' '{"schema":"iggy-restart-lifecycle-v1","passed":true,"processes_reclaimed":true,"physical_cluster_tested":false}' >"$run/lifecycle.json"
cat "$run/seed.json" "$run/verify.json"
printf '进程重启验证完成，模式：%s；未模拟断电、跨机或分区故障。\n' "$restart_mode"
