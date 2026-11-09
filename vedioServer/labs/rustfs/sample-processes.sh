#!/usr/bin/env bash
set -euo pipefail
shopt -s nullglob

# 只接收运行器拥有的四个 PID；用启动时钟识别复用，不读进程环境或凭证。
[[ $# -eq 4 ]] || { printf '%s\n' '需要四个本轮存储进程 PID。' >&2; exit 2; }
pids=("$@")
for pid in "${pids[@]}"; do
  [[ "$pid" =~ ^[1-9][0-9]*$ && -r "/proc/$pid/stat" ]] ||
    { printf '%s\n' '进程参数无效或进程不可读。' >&2; exit 2; }
done
births=()
read_stat() {
  local line
  line="$(<"/proc/$1/stat")"
  # comm 可包含空格和括号；右侧最后一个括号才是字段边界。
  read -r -a fields <<<"${line##*) }"
  [[ ${#fields[@]} -ge 22 ]]
}
for pid in "${pids[@]}"; do
  read_stat "$pid"
  births+=("${fields[19]}")
done
trap 'exit 0' INT TERM
printf 'unix_ms\tuptime_seconds\tnode\tpid\tstart_ticks\tcpu_ticks\trss_kib\thwm_kib\tos_threads\topen_fds\tread_bytes\twrite_bytes\trchar\twchar\n'
for ((sample=0; sample<540; sample++)); do
  wall="${EPOCHREALTIME/./}"
  wall="${wall:0:13}"
  read -r uptime _ </proc/uptime
  for node in "${!pids[@]}"; do
    pid="${pids[$node]}"
    [[ -r "/proc/$pid/stat" && -r "/proc/$pid/fd" ]] ||
      { printf '观测进程已退出或不可读：节点 %s\n' "$node" >&2; exit 1; }
    read_stat "$pid"
    [[ "${fields[19]}" == "${births[$node]}" ]] ||
      { printf 'PID 已复用：节点 %s\n' "$node" >&2; exit 1; }
    cpu=$((${fields[11]} + ${fields[12]}))
    status="$(awk '
      $1=="VmRSS:" {rss=$2; a=1}
      $1=="VmHWM:" {hwm=$2; b=1}
      $1=="Threads:" {threads=$2; c=1}
      END {if (!(a && b && c)) exit 1; printf "%s\t%s\t%s", rss,hwm,threads}
    ' "/proc/$pid/status")"
    io="$(awk '
      $1=="read_bytes:" {rb=$2; a=1}
      $1=="write_bytes:" {wb=$2; b=1}
      $1=="rchar:" {rc=$2; c=1}
      $1=="wchar:" {wc=$2; d=1}
      END {if (!(a && b && c && d)) exit 1; printf "%s\t%s\t%s\t%s", rb,wb,rc,wc}
    ' "/proc/$pid/io")"
    fds=("/proc/$pid/fd/"*)
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$wall" "$uptime" "$node" "$pid" "${births[$node]}" "$cpu" "$status" "${#fds[@]}" "$io"
  done
  sleep 1
done
printf '%s\n' '观测达到安全时限，不能视为完整采样。' >&2
exit 1
