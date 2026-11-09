#!/usr/bin/env bash
set -euo pipefail

variant="${1:-}"
[[ $# == 1 && ( "$variant" == baseline || "$variant" == patched ) ]] ||
  { printf '%s\n' '需要参数 baseline 或 patched。' >&2; exit 2; }
lab="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$lab/../../.." && pwd)"
mapfile -t fixture < <(python3 - "$lab/fixture.json" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as stream:
    data = json.load(stream)
for key in ("revision", "source_path", "original_lf_sha256", "patched_lf_sha256", "patch_sha256", "toolchain"):
    print(data[key])
PY
)
[[ ${#fixture[@]} == 6 ]] || { printf '%s\n' '实验清单读取失败。' >&2; exit 1; }
revision="${fixture[0]}"
source_path="${fixture[1]}"
toolchain="${fixture[5]}"
prefix="$HOME/.cache/superServe/rustfs-linux-toolchain"
export CARGO_HOME="$prefix/cargo"
export RUSTUP_HOME="$prefix/rustup"
export PATH="$CARGO_HOME/bin:$PATH"
if [[ -x "$prefix/native/usr/bin/protoc" ]]; then
  export PROTOC="$prefix/native/usr/bin/protoc"
  export PROTOC_INCLUDE="$prefix/native/usr/include"
  export LD_LIBRARY_PATH="$prefix/native/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi
rustc="$(rustup run "$toolchain" rustc --version)"
protoc_version="$("${PROTOC:-protoc}" --version 2>/dev/null || printf 'not-installed')"
build_root="$HOME/.cache/superServe/rustfs-build/$revision"
source="$build_root/source"
mkdir -p "$build_root"
exec 9>"$build_root/build.lock"
flock -n 9 || { printf '%s\n' '另一轮实验正在使用此构建目录。' >&2; exit 2; }

[[ "$(sha256sum "$lab/acquisition-cancel.patch" | cut -d ' ' -f1)" == "${fixture[4]}" ]] ||
  { printf '%s\n' '候选补丁指纹已变化，需要先更新实验清单。' >&2; exit 1; }
if [[ ! -d "$source" ]]; then
  git clone --quiet --no-hardlinks --no-checkout "$root/.artifacts/upstream/rustfs" "$source"
  git -C "$source" -c core.autocrlf=false checkout --quiet --detach "$revision"
fi
cd "$source"
[[ "$(git rev-parse HEAD)" == "$revision" ]] ||
  { printf '%s\n' '隔离源码提交不匹配。' >&2; exit 1; }
git diff --cached --quiet ||
  { printf '%s\n' '隔离源码存在暂存修改，停止自动切换。' >&2; exit 1; }
[[ -z "$(git ls-files --others --exclude-standard)" ]] ||
  { printf '%s\n' '隔离源码存在额外文件，停止自动切换。' >&2; exit 1; }
changed="$(git diff --name-only)"
[[ -z "$changed" || "$changed" == "$source_path" ]] ||
  { printf '%s\n' '隔离源码存在本实验之外的修改。' >&2; exit 1; }
current="$(sha256sum "$source_path" | cut -d ' ' -f1)"
case "$current" in
  "${fixture[2]}"|"${fixture[3]}") ;;
  *) printf '%s\n' '源码不属于已知原版或补丁版，拒绝覆盖。' >&2; exit 1 ;;
esac
if [[ "$variant" == baseline && "$current" == "${fixture[3]}" ]]; then
  git apply --reverse --check "$lab/acquisition-cancel.patch"
  git apply --reverse "$lab/acquisition-cancel.patch"
elif [[ "$variant" == patched && "$current" == "${fixture[2]}" ]]; then
  git apply --check "$lab/acquisition-cancel.patch"
  git apply "$lab/acquisition-cancel.patch"
fi
source_hash="$(sha256sum "$source_path" | cut -d ' ' -f1)"
expected_source="${fixture[2]}"
[[ "$variant" == baseline ]] || expected_source="${fixture[3]}"
[[ "$source_hash" == "$expected_source" ]] ||
  { printf '%s\n' '切换后的源码指纹不符合目标变体。' >&2; exit 1; }
lock_hash="$(sha256sum Cargo.lock | cut -d ' ' -f1)"

# 两个变体使用相同的 S3 构建配置；调试构建只验证正确性。
export CARGO_TARGET_DIR="$build_root/target"
export CARGO_PROFILE_DEV_DEBUG=0
export CARGO_PROFILE_DEV_INCREMENTAL=false
export CARGO_NET_GIT_FETCH_WITH_CLI=true
jobs="${VS_LAB_BUILD_JOBS:-6}"
[[ "$jobs" =~ ^[1-9][0-9]*$ ]] || { printf '%s\n' '并发编译数不合法。' >&2; exit 2; }
registry="${VS_LAB_REGISTRY_INDEX:-}"
command=(cargo "+$toolchain" build --locked --package rustfs --bin rustfs --no-default-features --jobs "$jobs")
if [[ -n "$registry" ]]; then
  [[ "$registry" =~ ^sparse\+https://[a-zA-Z0-9./_-]+/$ ]] ||
    { printf '%s\n' '仅接受不含凭证的 HTTPS 稀疏索引。' >&2; exit 2; }
  command+=(--config 'source.crates-io.replace-with="video-sparse"'
    --config "source.video-sparse.registry=\"$registry\"")
fi
mkdir -p "$root/.artifacts/storage-builds"
receipt_dir="$(mktemp -d "$root/.artifacts/storage-builds/$variant-XXXXXXXX")"
run_id="$(basename "$receipt_dir")"
binary_dir="$build_root/binaries/$run_id"
mkdir -p "$binary_dir"
printf '构建日志：%s/build.log\n' "$receipt_dir"
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
set +e
timeout --signal=TERM --kill-after=30s 45m "${command[@]}" >"$receipt_dir/build.log" 2>&1
status=$?
set -e
binary=""
if [[ $status == 0 ]]; then
  cp "$CARGO_TARGET_DIR/debug/rustfs" "$binary_dir/rustfs"
  binary="$binary_dir/rustfs"
  "$binary" --version >"$receipt_dir/version.txt"
fi
python3 - "$receipt_dir" "$variant" "$revision" "$source_hash" "$lock_hash" \
  "$rustc" "$started" "$status" "$binary" "$registry" "$protoc_version" "${command[@]}" <<'PY'
import datetime, hashlib, json, pathlib, sys
directory, variant, revision, source, lock, rustc, started, status, binary, registry, protoc, *command = sys.argv[1:]
def digest(path):
    with open(path, "rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()
receipt = {
    "variant": variant, "revision": revision, "source_sha256": source,
    "cargo_lock_sha256": lock, "rustc": rustc, "protoc": protoc, "command": command,
    "started_at": started, "finished_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "exit_code": int(status), "binary": binary or None,
    "binary_sha256": digest(binary) if binary else None,
    "build_log_sha256": digest(pathlib.Path(directory) / "build.log"),
    "registry_index": registry or "crates.io",
    "profile": {"name": "dev", "debug": 0, "incremental": False, "default_features": False},
    "performance_evidence": False, "production_approved": False,
}
with open(pathlib.Path(directory) / "receipt.json", "w", encoding="utf-8") as stream:
    json.dump(receipt, stream, ensure_ascii=False, indent=2)
    stream.write("\n")
print(json.dumps(receipt, ensure_ascii=False))
PY
exit "$status"
