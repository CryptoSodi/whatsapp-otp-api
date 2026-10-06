#!/usr/bin/env bash
# Run once as root from the uploaded bootstrap directory. No existing app is restarted.
set -euo pipefail
base=/opt/whatsapp-otp-api
source_dir=$(cd "$(dirname "$0")" && pwd)
[[ $EUID -eq 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
[[ ! -e "$base" ]] || { echo 'OTP directory already exists; inspect it before provisioning again.' >&2; exit 1; }
[[ -s "$source_dir/deploy-key.pub" ]] || { echo 'Deployment public key is missing.' >&2; exit 1; }
for account in otpapi otpproxy; do
  if getent passwd "$account" >/dev/null; then echo "Account $account already exists; refusing to modify it." >&2; exit 1; fi
done
node_archive=node-v22.23.3-linux-x64.tar.xz
node_sha=df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de
caddy_archive=caddy_2.11.7_linux_amd64.tar.gz
curl --fail --silent --show-error --location --retry 2 "https://nodejs.org/dist/v22.23.3/$node_archive" -o "$source_dir/$node_archive"
printf '%s  %s\n' "$node_sha" "$source_dir/$node_archive" | sha256sum -c -
curl --fail --silent --show-error --location --retry 2 "https://github.com/caddyserver/caddy/releases/download/v2.11.7/$caddy_archive" -o "$source_dir/$caddy_archive"
curl --fail --silent --show-error --location --retry 2 https://github.com/caddyserver/caddy/releases/download/v2.11.7/caddy_2.11.7_checksums.txt -o "$source_dir/caddy-checksums.txt"
(cd "$source_dir" && grep " $caddy_archive\$" caddy-checksums.txt | sha512sum -c -)
install -d -m 0755 "$base" "$base/bin" "$base/config" "$base/runtime"
useradd --system --home-dir "$base/home" --shell /bin/bash otpapi
useradd --system --home-dir "$base/proxy-data" --shell /usr/sbin/nologin otpproxy
install -d -m 0755 "$base/home" "$base/home/.ssh"
install -d -o otpapi -g otpapi -m 0750 "$base/releases" "$base/deploy"
install -d -o otpapi -g otpapi -m 0700 "$base/data"
install -d -o otpproxy -g otpproxy -m 0700 "$base/proxy-data"
tar -xJf "$source_dir/$node_archive" -C "$base/runtime" --strip-components=1 --no-same-owner
tar -xzf "$source_dir/$caddy_archive" -C "$base/bin" caddy --no-same-owner
chmod 0755 "$base/bin/caddy"
install -m 0755 "$source_dir/deploy.sh" "$base/bin/"
install -m 0644 "$source_dir/extract.py" "$base/bin/"
install -m 0644 "$source_dir/Caddyfile" "$base/config/Caddyfile"
printf 'restrict,command="%s/bin/deploy.sh" %s\n' "$base" "$(cat "$source_dir/deploy-key.pub")" > "$base/home/.ssh/authorized_keys"
chmod 0644 "$base/home/.ssh/authorized_keys"
printf 'otpapi ALL=(root) NOPASSWD: /usr/bin/systemctl restart whatsapp-otp-api.service, /usr/bin/systemctl stop whatsapp-otp-api.service\n' > /etc/sudoers.d/whatsapp-otp-api
chmod 0440 /etc/sudoers.d/whatsapp-otp-api
visudo -cf /etc/sudoers.d/whatsapp-otp-api
install -m 0644 "$source_dir/whatsapp-otp-api.service" "$source_dir/whatsapp-otp-proxy.service" /etc/systemd/system/
"$base/bin/caddy" validate --config "$base/config/Caddyfile" --adapter caddyfile
systemd-analyze verify /etc/systemd/system/whatsapp-otp-api.service /etc/systemd/system/whatsapp-otp-proxy.service
systemctl daemon-reload
systemctl enable whatsapp-otp-api.service whatsapp-otp-proxy.service
echo 'Isolated OTP runtime and services installed; application and proxy are not started yet.'
"$base/runtime/bin/node" --version
"$base/bin/caddy" version
