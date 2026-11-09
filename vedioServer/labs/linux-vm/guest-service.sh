#!/bin/sh
set -eu
stage="${1:?need explicit stage directory}"
case "$stage" in /root/video-service-*) ;; *) exit 2 ;; esac
cd "$stage"
sha256sum -c artifacts.sha256
chmod 700 ./vs-service ./processes-test
mkdir -p "$stage/tmp"
export TMPDIR="$stage/tmp" TEMP="$stage/tmp" TMP="$stage/tmp"
export VS_TEST_SERVICE_BINARY="$stage/vs-service"
ldd ./vs-service > dependencies.txt
uname -a > environment.txt
stat -f -c %T . >> environment.txt
systemctl --version >> environment.txt
# 先实际运行目标Linux测试，不用systemd状态代替测试。
timeout --signal=KILL 120s ./processes-test --test-threads=1 --nocapture > processes.log 2>&1
test ! -e /etc/systemd/system/superserve-api.service
test ! -e /etc/superserve
test ! -e /opt/superserve
mkdir -p /etc/superserve /opt/superserve/releases
digest="$(sha256sum ./vs-service | cut -d' ' -f1)"
mkdir "/opt/superserve/releases/$digest"
install -m 755 ./vs-service "/opt/superserve/releases/$digest/vs-service"
ln -s "releases/$digest" /opt/superserve/current
install -m 644 ./catalog.json /etc/superserve/catalog.json
install -m 644 ./superserve-api.service /etc/systemd/system/superserve-api.service
umask 077
token="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
cat >/etc/superserve/api.env <<EOF
VS_BIND=127.0.0.1:8080
VS_ROLE=api
VS_CATALOG=/etc/superserve/catalog.json
VS_SERVICE_TOKEN=$token
VS_LEARNING_JOURNAL=/var/lib/superserve-api/learning.jsonl
VS_LEARNING_SOURCE_ID=api-guest-1
RUST_LOG=vs_service=info
EOF
printf 'Authorization: Bearer %s\n' "$token" >"$stage/request.headers"
cleanup() {
  systemctl stop superserve-api.service 2>/dev/null || true
  rm -f "$stage/request.headers"
}
trap cleanup EXIT
systemd-analyze verify /etc/systemd/system/superserve-api.service >unit-verify.log 2>&1
systemctl daemon-reload
for cycle in 1 2; do
  systemctl start superserve-api
  ready=false
  for i in $(seq 1 100); do
    if curl --fail --silent --max-time 2 -H @"$stage/request.headers" \
        http://127.0.0.1:8080/readyz >"ready-$cycle.json"; then
      ready=true
      break
    fi
    sleep 0.1
  done
  test "$ready" = true
  printf '{"request_id":"systemd-%s","subject":"viewer","domains":["video","article","service"],"limit":3}\n' "$cycle" >request.json
  curl --fail --silent --max-time 5 -D "feed-$cycle.headers" \
    -H @"$stage/request.headers" -H 'Content-Type: application/json' \
    --data-binary @request.json http://127.0.0.1:8080/v1/feed >"feed-$cycle.json"
  grep -qi '^x-learning-decision-id:' "feed-$cycle.headers"
  cp /var/lib/superserve-api/learning.jsonl "before-stop-$cycle.jsonl"
  systemctl show superserve-api -p MainPID -p DynamicUser -p Type -p User >"active-$cycle.txt"
  systemctl stop superserve-api
  test "$(systemctl show superserve-api -p ExecMainStatus --value)" = 0
  test "$(systemctl show superserve-api -p MainPID --value)" = 0
  test "$(systemctl show superserve-api -p ActiveState --value)" = inactive
  cmp "before-stop-$cycle.jsonl" /var/lib/superserve-api/learning.jsonl
  systemctl show superserve-api -p MainPID -p ExecMainCode -p ExecMainStatus -p Result -p ActiveState >"stopped-$cycle.txt"
  cp /var/lib/superserve-api/learning.jsonl "after-stop-$cycle.jsonl"
done
python3 - <<'PY'
import hashlib, json, pathlib, socket
p = pathlib.Path(".")
first = p.joinpath("after-stop-1.jsonl").read_bytes()
second = p.joinpath("after-stop-2.jsonl").read_bytes()
assert second.startswith(first) and len(second) > len(first)
assert len(first.splitlines()) == 1 and len(second.splitlines()) == 2
for i in (1, 2):
    body = json.loads(p.joinpath(f"feed-{i}.json").read_text())
    assert len(body["items"]) == 3
    assert {v["domain"] for v in body["items"]} == {"video", "article", "service"}
s = socket.socket()
s.bind(("127.0.0.1", 8080))
s.close()
receipt = {
    "schema": "linux-service-systemd-v1", "passed": True,
    "cycles": 2, "committed_decisions": 2, "normal_exit_codes": [0, 0],
    "shared_journal_prefix_preserved": True, "port_reclaimed": True,
    "journal_sha256": hashlib.sha256(second).hexdigest(),
    "service_sha256": hashlib.sha256(p.joinpath("vs-service").read_bytes()).hexdigest(),
    "dynamic_user_template_used": True, "unit_verified": True,
    "physical_hosts": 1, "software_emulation": True,
    "production_or_performance_verified": False,
}
p.joinpath("receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
PY
journalctl -u superserve-api --no-pager -o cat >service.journal.log
test "$(grep -c service_shutdown_completed service.journal.log)" -eq 2
test "$(grep -c service_shutdown_incomplete service.journal.log || true)" -eq 0
cat receipt.json
