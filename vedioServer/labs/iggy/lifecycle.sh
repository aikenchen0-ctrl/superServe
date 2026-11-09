#!/usr/bin/env bash
# 生命周期顺序参考固定Iggy harness/handle/common.rs；不是服务端实现。
# 共享等待只管理本Shell的直接子进程，不按进程名查杀或重启全局WSL。

declare -A IGGY_OWNED_CHILDREN=()

iggy_register_child() {
  local target="$1" owned
  [[ "$target" =~ ^[1-9][0-9]*$ ]] || return 2
  for owned in $(jobs -p); do
    if [[ "$owned" == "$target" ]]; then
      IGGY_OWNED_CHILDREN["$target"]=1
      return 0
    fi
  done
  printf '%s\n' '只允许登记本Shell创建的直接子进程。' >&2
  return 2
}

iggy_child_pending() {
  local target="$1" owned
  for owned in $(jobs -pr) $(jobs -ps); do
    if [[ "$owned" == "$target" ]]; then return 0; fi
  done
  return 1
}

iggy_wait_child() {
  local target="$1" seconds="$2" diagnostic="${3:-}" timer finished="" status=0
  [[ "$target" =~ ^[1-9][0-9]*$ && "$seconds" =~ ^[1-9][0-9]*$ && "$seconds" -le 120 ]] ||
    { printf '%s\n' '子进程身份或等待期限无效。' >&2; return 2; }
  [[ -n "${IGGY_OWNED_CHILDREN[$target]:-}" ]] ||
    { printf '%s\n' '目标未登记为本轮直接子进程。' >&2; return 2; }
  # jobs区分已退出、运行及停止的直接子进程；不把停止态误当可立即wait。
  if ! iggy_child_pending "$target"; then
    if wait "$target" 2>/dev/null; then status=0; else status=$?; fi
    IGGY_CHILD_STATUS="$status"
    unset 'IGGY_OWNED_CHILDREN[$target]'
    return 0
  fi
  sleep "$seconds" &
  timer=$!
  if wait -n -f -p finished "$target" "$timer" 2>/dev/null; then status=0; else status=$?; fi
  if [[ "${finished:-}" == "$target" ]]; then
    kill "$timer" 2>/dev/null || true
    wait "$timer" 2>/dev/null || true
    IGGY_CHILD_STATUS="$status"
    unset 'IGGY_OWNED_CHILDREN[$target]'
    return 0
  fi
  # 处理子进程在登记watchdog前刚好退出的竞争；此时wait只读取缓存状态。
  if ! iggy_child_pending "$target"; then
    kill "$timer" 2>/dev/null || true
    wait "$timer" 2>/dev/null || true
    if wait "$target" 2>/dev/null; then status=0; else status=$?; fi
    IGGY_CHILD_STATUS="$status"
    unset 'IGGY_OWNED_CHILDREN[$target]'
    return 0
  fi
  kill "$timer" 2>/dev/null || true
  wait "$timer" 2>/dev/null || true
  IGGY_CHILD_STATUS=""
  if [[ -n "$diagnostic" ]]; then
    printf 'pid=%s; timeout_seconds=%s; reclaimed=false\n' "$target" "$seconds" >"$diagnostic"
  fi
  printf '子进程未在期限内退出，不能宣称已回收：%s\n' "$target" >&2
  return 124
}

iggy_stop_child() {
  local target="$1" signal="$2" seconds="$3" diagnostic="${4:-}"
  [[ "$signal" == INT || "$signal" == KILL ]] ||
    { printf '%s\n' '仅允许实验所需的INT或KILL信号。' >&2; return 2; }
  [[ "$target" =~ ^[1-9][0-9]*$ && -n "${IGGY_OWNED_CHILDREN[$target]:-}" ]] ||
    { printf '%s\n' '拒绝向未登记子进程发送信号。' >&2; return 2; }
  if iggy_child_pending "$target"; then
    kill "-$signal" "$target" 2>/dev/null || true
  fi
  iggy_wait_child "$target" "$seconds" "$diagnostic"
}

iggy_require_runtime() {
  [[ "$(uname -s)" == Linux && ( "${BASH_VERSINFO[0]}" -gt 5 ||
     ( "${BASH_VERSINFO[0]}" -eq 5 && "${BASH_VERSINFO[1]}" -ge 1 ) ) ]] ||
    { printf '%s\n' '真实Iggy实验需要Linux及Bash 5.1以上。' >&2; return 2; }
}

iggy_require_data_filesystem() {
  local directory="$1" existing filesystem
  [[ "$directory" == /mnt/o/* || "$directory" == /mnt/d/* ]] ||
    { printf '%s\n' '节点数据只能位于显式非C盘实验根目录。' >&2; return 2; }
  existing="$directory"
  while [[ ! -e "$existing" && "$existing" != / ]]; do
    existing="${existing%/*}"
    [[ -n "$existing" ]] || existing=/
  done
  filesystem="$(timeout --signal=KILL 3s stat -f -c %T "$existing")" ||
    { printf '%s\n' '无法在期限内核对节点数据文件系统，拒绝启动。' >&2; return 2; }
  case "$filesystem" in
    ext2/ext3|xfs|btrfs) ;;
    *)
      printf '节点数据文件系统未通过本轮准入：%s；不在挂载共享盘重跑已有等待反例。\n' "$filesystem" >&2
      return 2 ;;
  esac
  printf '节点数据文件系统：%s；该检查不证明实际物理故障域或WSL根盘位置。\n' "$filesystem"
}
