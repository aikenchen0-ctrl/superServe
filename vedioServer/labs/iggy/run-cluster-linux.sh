#!/usr/bin/env bash
set -euo pipefail

lab="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$lab/lifecycle.sh"
iggy_require_runtime
[[ $# == 2 && -x "$1" && -f "$2" ]] ||
  { printf '%s\n' '用法：run-cluster-linux.sh <Linux Iggy二进制> <Windows Rust实验入口exe>' >&2; exit 2; }
broker="$(realpath "$1")"
probe="$(realpath "$2")"
source_root="${VS_IGGY_SOURCE_ROOT:?需要指定固定版本Iggy源码目录}"
source_root="$(realpath "$source_root")"
[[ "$(git -C "$source_root" rev-parse HEAD)" == 71f29618ba04917fded0ef5cd085c206fef0ee49 ]] ||
  { printf '%s\n' '反馈副本实验只接受已有0.9系固定源码，不作为0.10画像运行入口。' >&2; exit 2; }
run_root="${VS_IGGY_RUN_ROOT:?需要指定实验数据和收据的绝对父目录}"
native="${VS_IGGY_NATIVE_PREFIX:?需要指定隔离原生依赖路径}"
run_root="$(realpath -m "$run_root")"
native="$(realpath -m "$native")"
[[ "$run_root" == /mnt/o/* || "$run_root" == /mnt/d/* ]] ||
  { printf '%s\n' '实验收据只能写入O盘或D盘。' >&2; exit 2; }
[[ "$native" == /mnt/o/* || "$native" == /mnt/d/* ]] ||
  { printf '%s\n' '原生依赖只能从O盘或D盘读取。' >&2; exit 2; }
# 活跃数据、节点日志和服务副本也必须在显式指定的非C盘隔离目录。
storage_root="${VS_IGGY_STORAGE_ROOT:?需要指定位于O盘或D盘的节点数据目录}"
storage_root="$(realpath -m "$storage_root")"
[[ "$storage_root" == /mnt/o/* || "$storage_root" == /mnt/d/* ]] ||
  { printf '%s\n' '节点数据只能写入O盘或D盘。' >&2; exit 2; }
iggy_require_data_filesystem "$storage_root"
timeout --signal=TERM --kill-after=1s 5s mkdir -p "$run_root/tmp"
export TMPDIR="$run_root/tmp" TEMP="$run_root/tmp" TMP="$run_root/tmp"
run="$(timeout --signal=TERM --kill-after=1s 5s mktemp -d "$run_root/iggy-cluster-feedback-XXXXXXXX")"
timeout --signal=TERM --kill-after=1s 5s mkdir -p "$storage_root"
node_root="$(timeout --signal=TERM --kill-after=1s 5s mktemp -d "$storage_root/nodes-XXXXXXXX")"
printf '%s\n' "$node_root" >"$run/node-root.txt"
timeout --signal=TERM --kill-after=2s 20s cp "$broker" "$node_root/iggy-server"
broker="$node_root/iggy-server"
survivor="${VS_IGGY_SURVIVOR_ID:-1}"
[[ "$survivor" == 1 || "$survivor" == 2 ]] ||
  { printf '%s\n' '幸存入口只能为节点1或2。' >&2; exit 2; }
peer=$((3 - survivor))
printf '%s\n' "$survivor" >"$run/survivor-id.txt"
export LD_LIBRARY_PATH="$native/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export IGGY_CONFIG_PATH="$source_root/core/server/config.toml"
export IGGY_CLUSTER_ENABLED=true
export IGGY_CLUSTER_NAME="vs-feedback-$(basename "$run")"
export IGGY_CLUSTER_AUTH_ENABLED=true
export IGGY_CLUSTER_AUTH_SHARED_SECRET
IGGY_CLUSTER_AUTH_SHARED_SECRET="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
export IGGY_HTTP_ENABLED=true IGGY_TCP_ENABLED=false IGGY_QUIC_ENABLED=false IGGY_WEBSOCKET_ENABLED=false
export IGGY_MEMORY_POOL_ENABLED=false IGGY_SHARDING_CPU_ALLOCATION=0..1 IGGY_SHARDING_PIN_CORES=false
export IGGY_LOGGING_FILE_ENABLED=false IGGY_TELEMETRY_ENABLED=false
export IGGY_ROOT_USERNAME=iggy-lab
export IGGY_ROOT_PASSWORD
IGGY_ROOT_PASSWORD="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
export VS_LAB_IGGY_USERNAME="$IGGY_ROOT_USERNAME" VS_LAB_IGGY_PASSWORD="$IGGY_ROOT_PASSWORD"
export WSLENV="${WSLENV:+$WSLENV:}VS_LAB_IGGY_USERNAME/w:VS_LAB_IGGY_PASSWORD/w:VS_LAB_IGGY_ENDPOINT/w:VS_LAB_IGGY_CLUSTER_ENDPOINTS/w:VS_LAB_IGGY_STAGE/w"

# 同时保留九个临时端口后释放；上游名册要求声明TCP端口，即使客户端TCP已关闭。
mapfile -t ports < <(python3 -c 'import socket; ss=[socket.socket() for _ in range(9)]; [s.bind(("127.0.0.1",0)) for s in ss]; [print(s.getsockname()[1]) for s in ss]')
[[ ${#ports[@]} == 9 ]] || { printf '%s\n' '端口分配失败。' >&2; exit 1; }
http_ports=("${ports[@]:0:3}")
for index in 0 1 2; do
  export "IGGY_CLUSTER_NODES_${index}_NAME=vs-node-${index}"
  export "IGGY_CLUSTER_NODES_${index}_IP=127.0.0.1"
  export "IGGY_CLUSTER_NODES_${index}_REPLICA_ID=${index}"
  export "IGGY_CLUSTER_NODES_${index}_PORTS_HTTP=${http_ports[$index]}"
  export "IGGY_CLUSTER_NODES_${index}_PORTS_TCP_REPLICA=${ports[$((index+3))]}"
  export "IGGY_CLUSTER_NODES_${index}_PORTS_TCP=${ports[$((index+6))]}"
done
export VS_LAB_IGGY_CLUSTER_ENDPOINTS
printf -v VS_LAB_IGGY_CLUSTER_ENDPOINTS '["http://127.0.0.1:%s","http://127.0.0.1:%s","http://127.0.0.1:%s"]' "${http_ports[@]}"
printf '%s\n' "$VS_LAB_IGGY_CLUSTER_ENDPOINTS" >"$run/endpoints.json"

pids=("" "" "")
cleanup() {
  local pending=0 index pid
  for pid in "${pids[@]}"; do
    [[ -n "$pid" ]] || continue
    kill -KILL "$pid" 2>/dev/null || true
  done
  for index in 0 1 2; do
    pid="${pids[$index]}"
    [[ -n "$pid" ]] || continue
    if iggy_wait_child "$pid" 10 "$run/cleanup-pending-$index.log"; then
      pids[$index]=""
    else
      pending=1
    fi
  done
  if [[ "$pending" != 0 ]]; then
    printf '%s\n' '实验进程未回收；见cleanup-pending节点记录，不推断具体内核根因。' >&2
    return 1
  fi
}
trap 'status=$?; trap - EXIT; cleanup || status=1; exit "$status"' EXIT
trap 'exit 130' INT TERM
start_node() {
  local index="$1" phase="$2"
  timeout --signal=KILL 5s mkdir -p "$node_root/node-$index"
  IGGY_PATH="$node_root/node-$index/data" IGGY_HTTP_ADDRESS="127.0.0.1:${http_ports[$index]}" \
    "$broker" --replica-id "$index" >"$node_root/node-$index/$phase.log" 2>&1 &
  pids[$index]=$!
  iggy_register_child "${pids[$index]}"
  printf '%s %s %s\n' "$index" "${pids[$index]}" "$phase" >>"$run/processes.txt"
}
wait_node() {
  local index="$1" deadline=$((SECONDS + 45))
  while (( SECONDS < deadline )); do
    kill -0 "${pids[$index]}" 2>/dev/null ||
      { printf '节点提前退出：%s\n' "$index" >&2; return 1; }
    if curl --silent --fail --max-time 1 "http://127.0.0.1:${http_ports[$index]}/ping" >/dev/null; then return 0; fi
    sleep 0.2
  done
  printf '节点未在期限内监听：%s\n' "$index" >&2
  return 1
}
kill_node() {
  local index="$1"
  iggy_stop_child "${pids[$index]}" KILL 10 "$run/kill-pending-$index.log" || return $?
  pids[$index]=""
  [[ "$IGGY_CHILD_STATUS" == 137 ]] ||
    { printf '节点强杀状态不符：%s\n' "$IGGY_CHILD_STATUS" >&2; return 1; }
}
probe_phase() {
  local mode="$1" index="$2" stage="$3"
  export VS_LAB_IGGY_ENDPOINT="http://127.0.0.1:${http_ports[$index]}"
  export VS_LAB_IGGY_STAGE="$stage"
  timeout --signal=TERM --kill-after=2s 90s "$probe" "$mode" "$(wslpath -w "$run/contract")" >"$run/$stage.json"
}
printf '实验收据：%s\n' "$run"
sha256sum "$broker" "$probe" "$IGGY_CONFIG_PATH" >"$run/artifact-sha256.txt"
for index in 0 1 2; do start_node "$index" initial; done
for index in 0 1 2; do wait_node "$index"; done
probe_phase seed 0 seed
kill_node 0
probe_phase cluster-verify "$survivor" after-primary-loss
probe_phase cluster-append "$survivor" majority-append
probe_phase cluster-verify-extended "$survivor" majority-prefix
kill_node "$peer"
probe_phase quorum-loss "$survivor" quorum-loss
start_node "$peer" restore-quorum
wait_node "$peer"
probe_phase cluster-verify-extended "$survivor" restored-quorum
start_node 0 rejoin
wait_node 0
probe_phase cluster-verify-extended 0 rejoined-node
probe_phase cluster-verify-extended "$peer" restored-node
# 清理失败不能留下成功汇总；不无限等待io_uring或挂载文件系统的不可中断线程。
cleanup
trap - EXIT
for index in 0 1 2; do
  mkdir -p "$run/node-$index"
  timeout --signal=TERM --kill-after=2s 20s cp "$node_root/node-$index/"*.log "$run/node-$index/"
done
printf '%s\n' '{"passed":true,"cluster_processes":3,"primary_loss":true,"majority_append":true,"quorum_loss_no_ack":true,"restored_prefix":true,"physical_cluster_tested":false}' >"$run/summary.json"
cat "$run/summary.json"
printf '%s\n' '三节点同机实验完成；未证明物理多机、容量扩展、断电或三低收益。'
