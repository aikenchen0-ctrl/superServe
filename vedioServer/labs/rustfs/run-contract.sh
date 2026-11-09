#!/usr/bin/env bash
set -euo pipefail

# 仅启动本轮独立四进程，保留日志，退出时回收所拥有的进程。
if [[ $# -lt 2 || $# -gt 3 ]]; then
  printf '%s\n' '需要参数：RustFS二进制、Rust探针，以及模式contract/recovery/measure/read-matrix/cancel-lifecycle/direct-cancel/cancel-soak/multipart。' >&2
  exit 2
fi
binary="$(realpath "$1")"
probe="$(realpath "$2")"
mode="${3:-contract}"
[[ "$mode" == contract || "$mode" == recovery || "$mode" == measure || "$mode" == read-matrix || "$mode" == cancel-lifecycle || "$mode" == direct-cancel || "$mode" == cancel-soak || "$mode" == multipart ]] ||
  { printf '%s\n' '实验模式必须为contract、recovery、measure、read-matrix、cancel-lifecycle、direct-cancel、cancel-soak或multipart。' >&2; exit 2; }
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
[[ -x "$binary" && -f "$probe" ]] || { printf '%s\n' '二进制或探针不存在。' >&2; exit 2; }
for port in 19300 19301 19302 19303; do
  if ss -H -ltn "sport = :$port" | grep -q .; then
    printf '实验端口已占用：%s\n' "$port" >&2
    exit 2
  fi
done
mkdir -p "$root/.artifacts/storage-runs"
run_dir="$(mktemp -d "$root/.artifacts/storage-runs/contract-XXXXXXXX")"
random="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
export VS_LAB_ACCESS_KEY="lab${random:0:20}"
export VS_LAB_SECRET_KEY="$random"
export VS_LAB_BUCKET="video-lab-${random:0:20}"
export VS_LAB_ENDPOINTS="http://127.0.0.1:19300,http://127.0.0.1:19301,http://127.0.0.1:19302,http://127.0.0.1:19303"
all_endpoints="$VS_LAB_ENDPOINTS"
export VS_LAB_PHASE=contract
# 数据种子与凭证独立，收据可以公开种子以重建期望字节。
seed_original="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
seed_degraded="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
export NO_PROXY="127.0.0.1,localhost"
export no_proxy="$NO_PROXY"
# WSL 启动 Windows 探针时，显式传递独立实验环境。
export WSLENV="${WSLENV:+$WSLENV:}VS_LAB_ACCESS_KEY:VS_LAB_SECRET_KEY:VS_LAB_BUCKET:VS_LAB_ENDPOINTS:VS_LAB_PHASE:VS_LAB_SEED:VS_LAB_RECEIPT:NO_PROXY"
pids=()
sampler_pid=""
stop_sampler() {
  [[ -n "$sampler_pid" ]] || return 0
  local result=0
  if kill -0 "$sampler_pid" 2>/dev/null; then
    kill -TERM "$sampler_pid"
  fi
  wait "$sampler_pid" || result=$?
  sampler_pid=""
  printf '{"schema":"storage-resource-sampler-v1","exit_code":%s,"complete":%s,"clock_ticks_per_second":%s}\n' \
    "$result" "$([[ $result -eq 0 ]] && echo true || echo false)" "$(getconf CLK_TCK)" >"$run_dir/sampler.json"
  return "$result"
}
bucket_created=false
recovery_complete=false
graceful_restarts=0
hard_kills=0
cleanup() {
  status=$?
  trap - EXIT INT TERM
  stop_sampler || status=1
  if $bucket_created; then
    if [[ "$mode" == recovery ]]; then
      VS_LAB_PHASE=cleanup VS_LAB_SEED="$seed_original" "$probe" >"$run_dir/cleanup-original.json" 2>"$run_dir/cleanup-original.log" || status=1
      VS_LAB_PHASE=cleanup VS_LAB_SEED="$seed_degraded" "$probe" >"$run_dir/cleanup-degraded.json" 2>"$run_dir/cleanup-degraded.log" || status=1
    fi
    # 桶只在本轮成功创建后才尝试删除；非空时由服务拒绝，不递归清空。
    curl --silent --show-error --max-time 5 --fail \
      --aws-sigv4 "aws:amz:us-east-1:s3" --user "$VS_LAB_ACCESS_KEY:$VS_LAB_SECRET_KEY" \
      -X DELETE "http://127.0.0.1:19300/$VS_LAB_BUCKET" >"$run_dir/bucket-cleanup.log" 2>&1 || status=1
  fi
  for pid in "${pids[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
  for _ in {1..50}; do
    running=false
    for pid in "${pids[@]}"; do if kill -0 "$pid" 2>/dev/null; then running=true; fi; done
    $running || break
    sleep 0.1
  done
  for pid in "${pids[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || true; fi
    wait "$pid" 2>/dev/null || true
  done
  if [[ "$mode" == recovery ]]; then
    passed=false
    if [[ $status -eq 0 ]] && $recovery_complete; then passed=true; fi
    printf '{"schema":"storage-recovery-run-v1","passed":%s,"graceful_restarts":%s,"single_process_kills":%s,"performance_claim":false,"physical_fault_domain_tested":false}\n' \
      "$passed" "$graceful_restarts" "$hard_kills" >"$run_dir/recovery.json"
  fi
  printf '实验日志：%s\n' "$run_dir"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
"$binary" --version >"$run_dir/version.txt"
python3 - "$run_dir" "$binary" "$probe" "${BASH_SOURCE[0]}" "$mode" "$root/vedioServer/labs/rustfs/sample-processes.sh" <<'PY'
import datetime, hashlib, json, pathlib, sys
directory, binary, probe, runner, mode, sampler = sys.argv[1:]
def fingerprint(path):
    path = pathlib.Path(path).resolve()
    with path.open("rb") as stream:
        value = hashlib.file_digest(stream, "sha256").hexdigest()
    return {"path": str(path), "sha256": value}
provenance = {
    "schema": "storage-contract-inputs-v1",
    "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "mode": mode, "binary": fingerprint(binary), "probe": fingerprint(probe),
    "runner": fingerprint(runner), "physical_fault_domains": False,
    "topology": "single-host-four-processes",
}
if mode == "cancel-soak":
    provenance["sampler"] = fingerprint(sampler)
with (pathlib.Path(directory) / "inputs.json").open("w", encoding="utf-8") as stream:
    json.dump(provenance, stream, ensure_ascii=False, indent=2)
    stream.write("\n")
PY
grep -Fxq 'rustfs 1.0.4' "$run_dir/version.txt" &&
  grep -Eq '^git commit +: 46337942d55f3a8e6a97b147ca98d9ea8115555d$' "$run_dir/version.txt" ||
  { printf '%s\n' '运行版本或提交不匹配固定参考。' >&2; exit 1; }
volumes=()
for index in 0 1 2 3; do
  mkdir -p "$run_dir/node$index"
  volumes+=("http://127.0.0.1:$((19300 + index))$run_dir/node$index")
done
cd "$run_dir"
start_node() {
  local index="$1"
  RUSTFS_ADDRESS="127.0.0.1:$((19300 + index))" \
  RUSTFS_ACCESS_KEY="$VS_LAB_ACCESS_KEY" RUSTFS_SECRET_KEY="$VS_LAB_SECRET_KEY" \
  RUSTFS_ERASURE_SET_DRIVE_COUNT=4 RUSTFS_STORAGE_CLASS_STANDARD=EC:2 \
  RUSTFS_UNSAFE_BYPASS_DISK_CHECK=true RUSTFS_CONSOLE_ENABLE=false \
  RUSTFS_OBJECT_LOCK_DIAG_ENABLE=true \
  RUSTFS_FTPS_ENABLE=false RUSTFS_WEBDAV_ENABLE=false \
  RUSTFS_OBS_LOGGER_LEVEL=warn RUSTFS_OBS_LOG_STDOUT_ENABLED=true \
    "$binary" "${volumes[@]}" >>"$run_dir/node$index.log" 2>&1 &
  pids[$index]=$!
}
wait_ready() {
  local ready=false
  for _ in {1..60}; do
    ready=true
    for index in "${!pids[@]}"; do
      curl --silent --max-time 1 --fail "http://127.0.0.1:$((19300 + index))/health/ready" >/dev/null || ready=false
    done
    $ready && return 0
    for pid in "${pids[@]}"; do
      kill -0 "$pid" 2>/dev/null || { printf '%s\n' '存储进程提前退出，请查实验日志。' >&2; return 1; }
    done
    sleep 1
  done
  printf '%s\n' '集群未在启动预算内就绪。' >&2
  return 1
}
stop_all_gracefully() {
  for pid in "${pids[@]}"; do kill -TERM "$pid"; done
  local running=false
  for _ in {1..200}; do
    running=false
    for pid in "${pids[@]}"; do if kill -0 "$pid" 2>/dev/null; then running=true; fi; done
    $running || break
    sleep 0.1
  done
  if $running; then printf '%s\n' '优雅停机超时，恢复阶段不予通过。' >&2; return 1; fi
  for pid in "${pids[@]}"; do
    wait "$pid" || { printf '%s\n' '优雅停机返回非零状态。' >&2; return 1; }
  done
  pids=()
}
restart_all() {
  stop_all_gracefully
  for index in 0 1 2 3; do start_node "$index"; done
  wait_ready
  graceful_restarts=$((graceful_restarts + 1))
}
run_phase() {
  local phase="$1" seed="$2" name="$3"
  printf '验证阶段：%s\n' "$name"
  VS_LAB_PHASE="$phase" VS_LAB_SEED="$seed" "$probe" | tee "$run_dir/$name.json"
}
for index in 0 1 2 3; do start_node "$index"; done
wait_ready
curl --silent --show-error --max-time 10 --fail \
  --aws-sigv4 "aws:amz:us-east-1:s3" --user "$VS_LAB_ACCESS_KEY:$VS_LAB_SECRET_KEY" \
  -X PUT "http://127.0.0.1:19300/$VS_LAB_BUCKET" >"$run_dir/bucket-create.log"
bucket_created=true
if [[ "$mode" == contract ]]; then
  "$probe" | tee "$run_dir/receipt.json"
elif [[ "$mode" == multipart ]]; then
  probe_status=0
  "$probe" >"$run_dir/multipart.json" 2>"$run_dir/multipart-error.log" || probe_status=$?
  # 列举仅限本轮独立桶；最终对象清理与未完成分段清理分别验收。
  curl --silent --show-error --max-time 10 --fail \
    --aws-sigv4 "aws:amz:us-east-1:s3" --user "$VS_LAB_ACCESS_KEY:$VS_LAB_SECRET_KEY" \
    "http://127.0.0.1:19300/$VS_LAB_BUCKET?uploads" >"$run_dir/multipart-list.xml"
  python3 - "$run_dir/multipart-list.xml" >"$run_dir/multipart-cleanup.json" <<'PY'
import json, sys, xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
count = sum(node.tag.rsplit("}", 1)[-1] == "Upload" for node in root.iter())
truncated = any(node.tag.rsplit("}", 1)[-1] == "IsTruncated" and (node.text or "").lower() == "true" for node in root.iter())
passed = count == 0 and not truncated
print(json.dumps({"schema": "s3-multipart-cleanup-v1", "incomplete_uploads": count,
                  "listing_truncated": truncated, "passed": passed}))
sys.exit(0 if passed else 1)
PY
  [[ "$probe_status" -eq 0 ]] || exit "$probe_status"
elif [[ "$mode" == measure ]]; then
  VS_LAB_PHASE=measure "$probe" | tee "$run_dir/measurement.json"
elif [[ "$mode" == read-matrix || "$mode" == cancel-lifecycle || "$mode" == direct-cancel || "$mode" == cancel-soak ]]; then
  if [[ "$mode" == cancel-soak ]]; then
    bash "$root/vedioServer/labs/rustfs/sample-processes.sh" "${pids[@]}" >"$run_dir/resources.tsv" 2>"$run_dir/sampler.log" &
    sampler_pid=$!
  fi
  if VS_LAB_PHASE="$mode" "$probe" 2>"$run_dir/$mode.log" | tee "$run_dir/$mode.json"; then
    stop_sampler
  else
    stop_sampler || true
    # 仅重启本轮拥有的实验集群；补救清理永远不改写失败收据或退出码。
    restart_all
    VS_LAB_PHASE=cleanup-owned VS_LAB_RECEIPT="$(wslpath -w "$run_dir/$mode.json")" \
      "$probe" >"$run_dir/restart-cleanup.json"
    exit 1
  fi
else
  # 缺失对象必须失败；恢复检查不能偷偷补写而得到假阳性。
  if run_phase verify "$seed_original" missing-object; then
    printf '%s\n' '只读验证错误接受了缺失对象。' >&2
    exit 1
  fi
  grep -Fq '"error":"storage_NotFound"' "$run_dir/missing-object.json"
  run_phase prepare "$seed_original" prepared
  restart_all
  run_phase verify "$seed_original" restarted
  kill -KILL "${pids[3]}"
  wait "${pids[3]}" 2>/dev/null || true
  unset 'pids[3]'
  hard_kills=$((hard_kills + 1))
  if curl --silent --max-time 1 --fail http://127.0.0.1:19303/health/ready >/dev/null 2>&1; then
    printf '%s\n' '故障节点仍可访问，不能验收降级阶段。' >&2
    exit 1
  fi
  export VS_LAB_ENDPOINTS="${all_endpoints%,*}"
  run_phase verify "$seed_original" degraded-read
  run_phase prepare "$seed_degraded" degraded-write
  start_node 3
  wait_ready
  export VS_LAB_ENDPOINTS="$all_endpoints"
  run_phase verify "$seed_degraded" rejoined
  restart_all
  run_phase verify "$seed_original" final-original
  run_phase verify "$seed_degraded" final-degraded
  recovery_complete=true
fi
