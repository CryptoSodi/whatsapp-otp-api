# Oracle deployment

Production URL: **https://otp.sirfbazar.com**.

This VM also runs an existing application on port 80 and a GitHub runner for another repository. The OTP deployment uses its own systemd units and private Node runtime. It does not use or restart the other application's PM2 process, runner, or system Node installation.

## Layout

- `/opt/whatsapp-otp-api/runtime`: private Node 22 runtime, root-managed.
- `/opt/whatsapp-otp-api/bin`: root-managed deploy helper, safe archive extractor, Caddy binary, and firewall helper.
- `/opt/whatsapp-otp-api/releases`: immutable application releases containing compiled JS and Linux production dependencies.
- `/opt/whatsapp-otp-api/deploy/current`: symlink to the active release.
- `/opt/whatsapp-otp-api/data`: persistent WhatsApp session database; never part of a release.
- `/etc/whatsapp-otp-api.env`: private server environment; never part of a release.
- `whatsapp-otp-api.service`: API on **127.0.0.1:3300**, running as `otpapi`.
- `whatsapp-otp-proxy.service`: HTTPS on **443 only**, running as `otpproxy`.
- `whatsapp-otp-firewall.service`: adds/removes only the dedicated TCP 443 allow rule.

The proxy obtains and renews certificates using TLS-ALPN on port 443. DNS must point `otp.sirfbazar.com` at this VM, and Oracle's ingress rules must allow TCP 443. Keep the DNS record unproxied for this certificate challenge. Port 80 is reserved for the existing application; always use the HTTPS URL directly.

Admin routes remain private. To reach them, tunnel local port 3300 to the VM's port 3300:

```sh
ssh -i /path/to/oci.key -N -L 3300:127.0.0.1:3300 ubuntu@193.122.227.40
```

## Automatic deployment

Every push to **main** runs the CI checks, then deploys the exact tested commit. Pull requests and other branches run checks without deployment. A push superseded before the deploy job begins may be skipped in favor of the latest main commit. A deployment already in progress is allowed to finish.

GitHub-hosted runners build the application and Linux production dependencies. The VM only extracts and starts the artifact, avoiding compilation on its small shared CPU/memory budget. The deployment key is a dedicated SSH key with a forced command, no terminal, and no forwarding. Its only sudo privileges are restarting/stopping `whatsapp-otp-api.service`.

Repository configuration:

- Secret `ORACLE_OTP_SSH_KEY`: dedicated deployment private key.
- Variable `ORACLE_OTP_HOST`: production server address.
- Variable `ORACLE_OTP_KNOWN_HOSTS`: pinned SSH host public key, obtained over the existing trusted connection.

Deployment uses an exclusive lock, validates the archive and commit SHA, switches the release symlink, and restarts **only the OTP API**. It checks that the running process belongs to the new release and `/health` returns success. A failed start restores the previous release automatically. At least five recent releases are retained. The WhatsApp session and environment remain outside all releases, so they survive updates.

Expect a brief OTP API interruption and WhatsApp reconnection during each release. An in-flight send can have an uncertain outcome; do not blindly retry. Monitor `/ready` separately from the deployment's process health check.

Host files under `/etc` and `/opt/whatsapp-otp-api/bin`, the runtime, firewall, and proxy configuration are managed separately by the administrator. Pushing changes to the application does not grant CI permission to replace those files or alter other services.

## Operations

```sh
sudo systemctl status whatsapp-otp-api whatsapp-otp-proxy --no-pager
sudo journalctl -u whatsapp-otp-api -n 50 --no-pager
cat /opt/whatsapp-otp-api/deploy/deployed-revision
curl --fail https://otp.sirfbazar.com/health
```

Manual rollback: select a known-good directory inside `/opt/whatsapp-otp-api/releases`, update the `deploy/current` symlink while holding `deploy/deployment.lock`, then restart only `whatsapp-otp-api.service`. No database rollback is performed automatically. Back up the private session database and environment separately, and preserve compatibility when changing the authentication schema.

Resource caps limit the API to 384 MiB memory and 60% of one CPU, and the proxy to 128 MiB and 30% of one CPU. If the OTP workload grows, move it to a larger/dedicated VM rather than removing limits on this shared server.
