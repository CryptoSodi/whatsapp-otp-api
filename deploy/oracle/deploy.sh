#!/usr/bin/env bash
# Forced SSH command. The deployment key can update this application only.
set -euo pipefail
umask 0027
base=/opt/whatsapp-otp-api
command=${SSH_ORIGINAL_COMMAND:-}
if [[ ! "$command" =~ ^deploy\ ([0-9a-f]{40})$ ]]; then
  echo 'Only deploy <40-character commit SHA> is allowed.' >&2
  exit 2
fi
revision=${BASH_REMATCH[1]}
exec 9>"$base/deploy/deployment.lock"
flock -w 300 9
stage=$(mktemp -d "$base/releases/.incoming.XXXXXXXX")
archive=$(mktemp "$base/deploy/.archive.XXXXXXXX")
previous=$(readlink -f "$base/deploy/current" 2>/dev/null || true)
switched=false
finished=false
cleanup() {
  local result=$?
  if [[ "$finished" != true && "$switched" == true ]]; then
    if [[ "$previous" == "$base/releases/"* && -d "$previous" ]]; then
      ln -sfn "$previous" "$base/deploy/current.next"
      mv -Tf "$base/deploy/current.next" "$base/deploy/current"
      sudo -n /usr/bin/systemctl restart whatsapp-otp-api.service || true
      echo 'Deployment failed; restored the previous release.' >&2
    else
      sudo -n /usr/bin/systemctl stop whatsapp-otp-api.service || true
    fi
  fi
  rm -f -- "$archive"
  if [[ "$stage" == "$base/releases/.incoming."* ]]; then rm -rf -- "$stage"; fi
  exit "$result"
}
trap cleanup EXIT
# Bound archive size and upload time. Truncated archives fail validation below.
timeout 180 head -c 209715200 > "$archive"
python3 "$base/bin/extract.py" "$archive" "$stage" "$revision"
"$base/runtime/bin/node" --check "$stage/dist/server.js"
release="$base/releases/$revision-$(date -u +%Y%m%d%H%M%S)"
mv "$stage" "$release"
ln -sfn "$release" "$base/deploy/current.next"
mv -Tf "$base/deploy/current.next" "$base/deploy/current"
switched=true
sudo -n /usr/bin/systemctl restart whatsapp-otp-api.service
for attempt in {1..45}; do
  pid=$(/usr/bin/systemctl show whatsapp-otp-api.service -p MainPID --value)
  if [[ "$pid" != 0 ]] && [[ "$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)" == "$release" ]] && curl --max-time 2 --fail --silent http://127.0.0.1:3300/health >/dev/null; then
    finished=true
    printf '%s\n' "$revision" > "$base/deploy/deployed-revision"
    echo "Deployed $revision; health check passed."
    break
  fi
  sleep 2
done
[[ "$finished" == true ]] || exit 1
# Preserve the new and previous releases plus recent history (at least five total).
python3 - "$base/releases" "$release" "$previous" <<'PY'
import pathlib, re, shutil, sys
root = pathlib.Path(sys.argv[1]).resolve()
keep = {pathlib.Path(p).resolve() for p in sys.argv[2:] if p}
releases = sorted((p for p in root.iterdir() if p.is_dir() and not p.is_symlink() and re.fullmatch(r'[0-9a-f]{40}-[0-9]{14}', p.name)), key=lambda p: p.stat().st_mtime, reverse=True)
keep.update(releases[:5])
for path in releases:
    if path not in keep and path.resolve().parent == root:
        shutil.rmtree(path)
PY
