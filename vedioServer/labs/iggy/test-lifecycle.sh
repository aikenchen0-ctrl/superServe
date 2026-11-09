#!/usr/bin/env bash
set -euo pipefail
lab="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$lab/lifecycle.sh"
pending=()
cleanup() {
  local child
  for child in "${pending[@]}"; do
    if iggy_child_pending "$child"; then
      kill -KILL "$child" 2>/dev/null || true
      iggy_wait_child "$child" 3 || true
    fi
  done
}
trap cleanup EXIT

sleep 0.1 & child=$!; pending+=("$child"); iggy_register_child "$child"
iggy_wait_child "$child" 3
[[ "$IGGY_CHILD_STATUS" == 0 ]]
printf '%s\n' '正常退出及真实退出码：通过'

bash --noprofile --norc -c 'exit 7' & child=$!; pending+=("$child"); iggy_register_child "$child"
sleep 0.1
iggy_wait_child "$child" 2
[[ "$IGGY_CHILD_STATUS" == 7 ]]
printf '%s\n' '调用前已退出且非零状态：通过'

sleep 20 & child=$!; pending+=("$child"); iggy_register_child "$child"
start=$SECONDS
if iggy_wait_child "$child" 1; then
  printf '%s\n' '仍在运行的子进程被误判为已退出。' >&2
  exit 1
else
  [[ "$?" == 124 && -z "$IGGY_CHILD_STATUS" ]]
fi
[[ $((SECONDS-start)) -lt 5 ]]
iggy_stop_child "$child" KILL 3
[[ "$IGGY_CHILD_STATUS" == 137 ]]
printf '%s\n' '等待超时不宣称成功及强杀回收：通过'

bash --noprofile --norc -c 'kill -STOP $$; exec sleep 20' & child=$!; pending+=("$child"); iggy_register_child "$child"
sleep 0.1
if iggy_wait_child "$child" 1; then exit 1; else [[ "$?" == 124 ]]; fi
iggy_stop_child "$child" KILL 3
[[ "$IGGY_CHILD_STATUS" == 137 ]]
printf '%s\n' '停止态子进程不会触发无限wait：通过'

if iggy_wait_child 99999999 1; then exit 1; else [[ "$?" == 2 ]]; fi
if iggy_wait_child 0 1; then exit 1; else [[ "$?" == 2 ]]; fi
if iggy_register_child 99999999; then exit 1; else [[ "$?" == 2 ]]; fi
printf '%s\n' '非子进程和无效身份拒绝：通过'

for code in 124 127; do
  bash --noprofile --norc -c "exit $code" & child=$!; pending+=("$child"); iggy_register_child "$child"
  sleep 0.1
  iggy_wait_child "$child" 2
  [[ "$IGGY_CHILD_STATUS" == "$code" ]]
done
printf '%s\n' '真实退出码124和127不与监督器状态混淆：通过'

if iggy_require_data_filesystem /mnt/c/forbidden; then exit 1; else [[ "$?" == 2 ]]; fi
printf '%s\n' 'C盘数据目录拒绝：通过'

# 用声明过的测试替身验证分类分支，不把它写成实际Linux文件系统运行。
(
  timeout() { shift 2; "$@"; }
  stat() { printf '%s\n' 9p; }
  if iggy_require_data_filesystem /mnt/o/absent-test-root; then exit 1; else [[ "$?" == 2 ]]; fi
  stat() { printf '%s\n' ext2/ext3; }
  iggy_require_data_filesystem /mnt/o/absent-test-root
)
printf '%s\n' '共享盘拒绝和原生文件系统分类：通过，仅分类替身'
printf '%s\n' '{"schema":"iggy-lifecycle-check-v1","passed":true,"cases":8,"real_iggy_server_run":false,"filesystem_classification_mocked":true,"kernel_uninterruptible_wait_simulated":false}'
