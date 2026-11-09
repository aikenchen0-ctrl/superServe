#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  printf '%s\n' '需要参数：输出JSONL路径、采样间隔毫秒。' >&2
  exit 2
fi
output="$1"
interval_ms="$2"
[[ "$interval_ms" =~ ^[1-9][0-9]*$ ]] || { printf '%s\n' '采样间隔必须为正整数毫秒。' >&2; exit 2; }
[[ -n "${VS_LAB_ACCESS_KEY:-}" && -n "${VS_LAB_SECRET_KEY:-}" && -n "${VS_LAB_ENDPOINTS:-}" ]] || {
  printf '%s\n' '缺少实验凭证或端点环境变量。' >&2
  exit 2
}
mkdir -p "$(dirname "$output")"
export NO_PROXY="127.0.0.1,localhost"
export no_proxy="$NO_PROXY"

while :; do
  unix_ms="$(date +%s%3N)"
  IFS=',' read -r -a endpoints <<<"$VS_LAB_ENDPOINTS"
  for index in "${!endpoints[@]}"; do
    endpoint="${endpoints[$index]}"
    body_file="$(mktemp)"
    status="000"
    if status="$(curl --silent --show-error --max-time 2 --output "$body_file" --write-out '%{http_code}' \
      --aws-sigv4 'aws:amz:us-east-1:s3' --user "$VS_LAB_ACCESS_KEY:$VS_LAB_SECRET_KEY" \
      "$endpoint/rustfs/admin/v3/top/locks?count=10000" 2>/dev/null)"; then
      :
    else
      status="000"
    fi
    python3 - "$output" "$unix_ms" "$index" "$endpoint" "$status" "$body_file" <<'PY'
import json
import pathlib
import sys

output, unix_ms, node, endpoint, status, body_file = sys.argv[1:]
path = pathlib.Path(output)
body = pathlib.Path(body_file).read_text(encoding="utf-8", errors="replace")
record = {
    "schema": "rustfs-top-locks-sample-v1",
    "unix_ms": int(unix_ms),
    "node": int(node),
    "endpoint": endpoint,
    "http_status": int(status),
    "total": None,
    "truncated": None,
    "locks": [],
}
if status == "200":
    try:
        payload = json.loads(body)
        record["total"] = payload.get("total")
        record["truncated"] = payload.get("truncated")
        for lock in payload.get("locks", []):
            record["locks"].append({
                "resource": lock.get("resource"),
                "type": lock.get("type"),
                "owner": lock.get("owner"),
                "ttl_secs": lock.get("ttl_secs"),
                "elapsed_secs": lock.get("elapsed_secs"),
            })
    except (TypeError, ValueError):
        record["parse_error"] = "invalid_json"
elif status != "000":
    record["error"] = "admin_request_failed"
else:
    record["error"] = "transport_failed"
with path.open("a", encoding="utf-8") as stream:
    json.dump(record, stream, ensure_ascii=False, separators=(",", ":"))
    stream.write("\n")
PY
    rm -f "$body_file"
  done
  sleep "$(awk -v ms="$interval_ms" 'BEGIN { printf "%.3f", ms / 1000 }')"
done
