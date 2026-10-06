# WhatsApp OTP Sending API

A small, self-hosted Node.js API that delivers caller-supplied OTPs and custom text over WhatsApp. Your application generates, expires, and verifies the OTP. This service has no OTP generation, verification, or user database. `/send-otp` applies a fixed template; `/send-message` sends your supplied text.

The service uses Fastify 5, TypeScript, and **Baileys 7.0.0-rc14**, pinned in `package-lock.json`. Run it as one persistent process on a Linux VM such as Oracle Cloud, with one WhatsApp account. Vercel Functions are not the deployment target.

**Oracle endpoint:** `http://otp.sirfbazar.com`. The shared VM routes both sites through port 80; transport is currently HTTP. Pushes to `main` deploy automatically after CI passes. See the [Oracle operations guide](deploy/oracle/README.md) for domain routing, SSH access, and rollback. The Docker HTTPS instructions below remain available for standalone hosts.

## Quick start

Requires **Node.js 22.19+** (Node 22 LTS recommended) and npm. Node's built-in SQLite module is used for WhatsApp authentication and encryption keys; Node 22 may print an experimental-module warning.

```sh
npm ci
npm run setup
npm run build
npm start
```

`setup` creates `.env` with separate cryptographically random `API_KEY` and `ADMIN_KEY` values. It never overwrites an existing `.env`. These keys and the `data/` directory are ignored by Git. Read your keys locally from `.env`; do not put them in source control or client-side browser code.

For development, use `npm run dev` instead of the build/start commands. The HTTP listener defaults to `127.0.0.1:3000`.

## Link your WhatsApp account

Use a dedicated sender account. The **admin key** controls pairing and session resets; sending keys do not grant admin access.

**Pair in your browser:** open `http://otp.sirfbazar.com/pair` and enter `ADMIN_KEY`. The page displays the connection state, updates the QR automatically, and can request a phone-number pairing code. Scan through WhatsApp → Linked devices → Link a device. No Oracle login is needed.

If relinking is necessary, choose **Reset login and get a new QR** and confirm. Reset clears this API's saved WhatsApp identity and Signal keys; sending pauses until pairing finishes. It refuses to interrupt an active send or pairing request. Remove an old device entry from WhatsApp's Linked devices if it remains listed. Do not reset a connected account just to check its status.

The page keeps the key only in tab memory, sends it in an Authorization header, and clears it on Lock or page close. It uses no cookies or browser storage for authentication. The current Oracle endpoint is HTTP, so the key and pairing data are unencrypted in transit; HTTPS or the optional SSH tunnel below provides encrypted access. The page itself is public; all admin API calls still require `ADMIN_KEY`.

The following examples use Bash. Load the generated `.env` in a trusted local shell:

```sh
set -a
. ./.env
set +a
```

Check the connection:

```sh
curl --fail-with-body http://127.0.0.1:3000/admin/session \
  -H "Authorization: Bearer $ADMIN_KEY"
```

Wait for `{"state":"awaiting_pairing"}`, then choose **one** linking method:

**QR:** download an SVG and open it locally. On your phone choose WhatsApp → Linked devices → Link a device and scan it.

```sh
curl --fail-with-body http://127.0.0.1:3000/admin/qr \
  -H "Authorization: Bearer $ADMIN_KEY" -o whatsapp-qr.svg
```

QR codes expire; download again if necessary. Delete the SVG after linking. Do not commit or share pairing material.

**Pairing code:** supply the phone number of the **sender account**, including its country code. Enter the returned code in WhatsApp's linked-device flow using the phone-number linking option.

```sh
curl --fail-with-body http://127.0.0.1:3000/admin/pairing-code \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"phone":"+923001234567"}'
```

Check `/admin/session` again for `connected`. Session credentials persist across restarts, so normal restarts do not require re-linking. No live message is sent by linking or by the tests.

## Send an OTP

Only call this from your backend, after the user requests an OTP. Replace the example recipient with the intended recipient's number.

```sh
curl --fail-with-body http://127.0.0.1:3000/send-otp \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"phone":"+923001234567","otp":"001234"}'
```

The recipient receives: `Your verification code is 001234. Do not share this code.`

HTTP `200`:

```json
{
  "status": "submitted",
  "messageId": "WHATSAPP_MESSAGE_ID",
  "requestId": "req-1"
}
```

`submitted` means Baileys completed its submission operation. It is **not a recipient delivery/read receipt**. This API does not expose delivery tracking or webhooks.

- `phone`: international format with `+`, followed by 7-15 digits; no spaces or punctuation. It must identify a WhatsApp user, not a group.
- `otp`: a **string** of 4-10 ASCII digits. Leading zeros are preserved. Numbers, extra fields, and custom message text are rejected.
- OTP request bodies are limited to 2 KiB. The default global send limit is 30 valid, authenticated requests per minute, shared with custom messages. This protects the service; it is **not a WhatsApp-approved sending allowance**.
- One submission is processed at a time. Concurrent submissions receive `429 SENDER_BUSY`; there is no delayed queue.
- No automatic OTP resubmission, message retry cache, durable message store, or idempotency guarantee. Repeating a successful request sends another message. Coordinate retries in your application.
- A `502/504 SEND_UNCONFIRMED` can occur after WhatsApp accepted a message. **Do not blindly retry it**; your application owns resend and expiry decisions.

### Optional single-URL sending

Set `URL_SEND_KEY` to a separate random secret (32-256 letters, digits, underscores or hyphens) to enable GET sending. It must differ from both existing keys. Leave it unset to disable both GET sending routes.

```text
http://otp.sirfbazar.com/send-otp?key=YOUR_URL_SEND_KEY&phone=%2B923074000106&otp=123456
```

Replace `otp` with the caller-generated code. `%2B` encodes the phone number's `+`. This sends the same fixed verification template as POST; arbitrary messages are not accepted. It shares POST's rate limit. HEAD and marked prefetch requests cannot send messages. Opening or refreshing the URL submits another request; unmarked link previews can also call it, so keep the complete URL private and do not embed it in pages or share it with preview services. The URL key and OTP can appear in browser history and infrastructure logs even though this application does not log them. The current Oracle origin is HTTP; use encrypted transport for real credentials and OTPs. POST remains available for backend integrations.

## Send custom text

Use `POST /send-message` with the same `API_KEY` bearer authentication:

```sh
curl --fail-with-body http://otp.sirfbazar.com/send-message \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"phone":"+923074000106","message":"Hello from Sirfbazar!"}'
```

Or use a single URL with the same `URL_SEND_KEY`:

```text
http://otp.sirfbazar.com/send-message?key=YOUR_URL_SEND_KEY&phone=%2B923074000106&message=Hello%20from%20Sirfbazar%21
```

The message must be non-blank text of at most 1,000 Unicode characters. Spaces, newlines, emojis, and WhatsApp formatting markers are preserved; no OTP template is added. URL-encode custom text, including `&`, `+`, `#`, and newlines, with `URLSearchParams` or `encodeURIComponent`. For example, a newline becomes `%0A`. POST is easier for longer text and accepts a request body up to 16 KiB. Do not expose keys in frontend JavaScript.

All four sending routes share one rate limit and the same single-send guard. They return the same `submitted` response and error behavior. GET keeps the same private-link restrictions described above. Text is never written to the application's request logs or session database.

### Routes

| Method | Route                 | Authorization                      | Purpose                                                 |
| ------ | --------------------- | ---------------------------------- | ------------------------------------------------------- |
| POST   | `/send-otp`           | API key                            | Send the supplied OTP                                   |
| GET    | `/send-otp`           | URL key in query                   | Optional URL-based OTP send                             |
| POST   | `/send-message`       | API key                            | Send custom text                                        |
| GET    | `/send-message`       | URL key in query                   | Optional URL-based custom text send                     |
| GET    | `/health`             | Public                             | Process liveness, independent of WhatsApp               |
| GET    | `/ready`              | API key                            | HTTP 200 when connected, otherwise 503                  |
| GET    | `/admin/session`      | Admin key                          | Connection state                                        |
| GET    | `/admin/qr`           | Admin key                          | Current pairing QR as SVG                               |
| POST   | `/admin/pairing-code` | Admin key                          | Pair sender account using `{"phone":"+..."}`            |
| POST   | `/admin/reset`        | Admin key                          | Clear login with `{"confirm":"RESET_WHATSAPP_SESSION"}` |
| GET    | `/pair`               | Public page; admin key for actions | Browser pairing and session controls                    |

Connection states: `connecting`, `awaiting_pairing`, `connected`, `reconnecting`, `logged_out`, `error`, `stopped`.

Errors have the shape `{"error":{"code":"...","message":"..."}}`; handled route errors also include `requestId`.

| HTTP            | Code                           | Meaning                                                    |
| --------------- | ------------------------------ | ---------------------------------------------------------- |
| 400 / 413 / 415 | `INVALID_REQUEST`              | Invalid input, oversized body, or unsupported content type |
| 401             | `UNAUTHORIZED`                 | Wrong or missing bearer key                                |
| 422             | `NOT_ON_WHATSAPP`              | Recipient lookup reports no WhatsApp account               |
| 429             | `RATE_LIMITED` / `SENDER_BUSY` | Request was not submitted; wait before retrying            |
| 503             | `WHATSAPP_UNAVAILABLE`         | Disconnected before sending; request was not submitted     |
| 502             | `LOOKUP_FAILED`                | Recipient lookup failed before sending                     |
| 502 / 504       | `SEND_UNCONFIRMED`             | Submission result is uncertain                             |
| 409 / 502       | Pairing-specific code          | Pairing not ready, busy, unavailable or failed             |

## Oracle Linux / Ubuntu VM deployment

Docker Engine and its Compose plugin must already be installed on the VM. The Node base image supports `linux/amd64` and `linux/arm64`; CI builds and smoke-tests both architectures. Node does not need to be installed directly on the host when using Docker.

1. Clone this repository onto the VM. For this private repository, use GitHub CLI, a deploy key, or your existing authenticated Git setup.
2. Generate `.env`. With Node installed, use `npm run setup`. With Docker only, run the setup script in a temporary container from the project directory:

   ```sh
   docker run --rm --user "$(id -u):$(id -g)" \
     -v "$PWD:/work" -w /work node:22-bookworm-slim node scripts/setup.mjs
   ```

3. Start the service:

   ```sh
   docker compose up -d --build
   docker compose logs -f api
   ```

The API runs as a non-root user with a read-only container filesystem, a persistent session volume, a process lock, and automatic restart. Port 3000 binds to **host localhost only**. Run a single replica; do not share an account between separate deployments. The process lock protects a shared local session directory, not separately copied credentials.

### HTTPS for application access

Point a DNS hostname to the VM's public IP and set `API_DOMAIN=otp.yourdomain.com` in `.env`. Allow inbound TCP ports **80 and 443** in the Oracle security list/network security group and the Linux firewall. Keep SSH restricted to your administration IP. Do not expose port 3000.

```sh
docker compose -f compose.yaml -f compose.https.yaml up -d --build
```

Caddy obtains and renews HTTPS certificates. The supplied configuration exposes sending/health routes, `/pair`, its script, and the four authenticated admin routes (`session`, `qr`, `pairing-code`, `reset`). Unlisted routes return 404. Use `https://otp.yourdomain.com/pair` to manage pairing in your browser.

For optional private access from your computer, create an SSH tunnel:

```sh
ssh -N -L 3000:127.0.0.1:3000 YOUR_SSH_USER@YOUR_VM_IP
```

Then use the localhost pairing commands above with the **VM's admin key**. If local port 3000 is occupied, use `-L 3001:127.0.0.1:3000` and call port 3001 locally. The QR SVG is downloaded to your computer, where you can open it.

### Persistence, logout and recovery

`data/session.sqlite` locally, or `/app/data/session.sqlite` in Docker, stores WhatsApp credentials, encryption keys, and recipient mappings. **It never stores OTP request bodies.** Treat the database and its SQLite companion files as account credentials. Files use restricted Unix permissions; protect VM disks and backups too.

Transient disconnects reconnect with capped exponential backoff. Logout, account rejection, invalid sessions, or another client replacing this connection stop automatic reconnection and require operator attention. Stop conflicting deployments first. If re-linking is required, use the confirmed reset action on `/pair`. Reset disconnects the old socket and replaces credentials atomically; stale callbacks cannot write into the fresh authentication state. For manual recovery with a backup, stop the service before moving its database and any `-wal` and `-shm` companions. Never alter the database externally while the service is running.

`docker compose down` preserves the session volume. **`docker compose down -v` deletes it** and requires account re-linking. The service does not offer a remote logout/delete-session endpoint.

HTTP health checks measure process liveness. Monitor `/ready` separately for WhatsApp connectivity; an unavailable WhatsApp session should trigger operator attention, not an endless container restart loop.

## Configuration

| Variable               | Default                      | Meaning                                                                                |
| ---------------------- | ---------------------------- | -------------------------------------------------------------------------------------- |
| `API_KEY`              | Required                     | 32-256 letters/digits/underscores/hyphens; backend send credential                     |
| `ADMIN_KEY`            | Required                     | Separate key with the same format; account pairing credential                          |
| `URL_SEND_KEY`         | Unset (disabled)             | Separate key enabling URL-based OTP and custom-text sending; never an admin credential |
| `HOST`                 | `127.0.0.1`                  | HTTP bind address; Compose sets `0.0.0.0` inside the container                         |
| `PORT`                 | `3000`                       | HTTP port                                                                              |
| `DATA_DIR`             | `./data`                     | Private session directory; Compose sets `/app/data`                                    |
| `OTP_MESSAGE_TEMPLATE` | Default verification message | Fixed server-side text containing exactly one `{otp}`, maximum 1000 characters         |
| `SEND_TIMEOUT_MS`      | `20000`                      | Submission deadline, 1000-60000 ms                                                     |
| `RATE_LIMIT_MAX`       | `30`                         | Global send requests per minute, stored in memory and reset on process restart         |
| `LOG_LEVEL`            | `info`                       | `info`, `warn`, `error`, or `silent`                                                   |
| `API_DOMAIN`           | Example hostname             | Only used by the optional HTTPS Compose configuration                                  |

Requests, raw URLs, tokens, QR data, phone numbers, and message bodies are not logged. Baileys logging is disabled; third-party `console` output is suppressed because libsignal can print session keys. Logs retain request IDs, route names, status codes, and connection state changes. History synchronization required by Baileys runs internally, but this application does not store or expose chats or incoming messages.

## Checks

```sh
npm run check
npm run smoke
npm run format:check
npm audit --omit=dev
```

Tests use a fake WhatsApp socket, never contact recipients, and cover authentication, validation, leading-zero OTPs, rate limits, log privacy, session persistence, timeouts, reconnection and logout handling. CI additionally builds containers and runs `/health` checks on AMD64 and ARM64. A real WhatsApp account must be paired to validate actual message delivery.

## Upstream limitations

Baileys is an **unofficial WhatsApp client**. Account restrictions, logouts, and upstream protocol changes can interrupt service. Its maintainers discourage automated messaging, and v7 uses a release-candidate version. Use an alternative delivery channel for essential authentication.

The pinned version includes the fix for [GHSA-qvv5-jq5g-4cgg](https://github.com/advisories/GHSA-qvv5-jq5g-4cgg); this does not guarantee absence of other vulnerabilities. Review updates and test pairing/sending/restarts before upgrading. See the [Baileys README](https://github.com/WhiskeySockets/Baileys), [migration guide](https://github.com/WhiskeySockets/baileys.wiki-site/blob/main/docs/migration/to-v7.0.0.md), and [release notes](https://github.com/WhiskeySockets/Baileys/releases).
