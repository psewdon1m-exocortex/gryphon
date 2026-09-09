# Gryphon

Gryphon is the single Telegram transport gateway for Exocortex services. It owns bot tokens, webhooks, update deduplication, service-scoped identity bindings, callback buttons and outbound delivery. Chronos and Saturn expose authenticated internal command adapters and do not talk to Telegram directly.

One service connection selects one bot. Different services may use the same token (one shared Telegram receiver) or different tokens (independent receivers). A binding belongs to the service connection, not globally to the bot, so the same Telegram account can link Chronos without automatically gaining access to Saturn.

## Run locally

Node.js 24 or newer is required because the state store uses the built-in SQLite module.

```powershell
corepack pnpm install
corepack pnpm build
$env:GRYPHON_PUBLIC_ORIGIN = "https://telegram.example.com"
node dist/main.js
```

For the supplied production Compose files, create the shared private service
network once before starting the projects:

```powershell
docker network create exocortex-services
```

The public listener accepts only Telegram webhooks. Services use an authenticated, service-scoped Unix socket for status, linking and notifications. Administrative operations use a different Unix socket (or Windows named pipe) and are intentionally not exposed over TCP.

Put bot and service tokens in owner-readable files. The same service token must be mounted in the target service and passed to `connect`:

```powershell
node dist/cli.js connect chronos `
  --bot-token-file C:\secrets\shared-bot.token `
  --service-token-file C:\secrets\chronos.token `
  --adapter http://chronos:18280/api/internal/gryphon/command

node dist/cli.js connect saturn `
  --bot-token-file C:\secrets\shared-bot.token `
  --service-token-file C:\secrets\saturn.token `
  --adapter http://saturn:3000/internal/gryphon/command
```

Using another bot token for the second command creates another bot runtime. Reusing the same token reuses the existing runtime regardless of the supplied alias.

When Gryphon runs through Compose, invoke the CLI in a one-off container that
shares the daemon socket. For example, if operator-managed tokens live below
`/etc/gryphon` on the host:

```sh
docker compose run --rm --no-deps \
  -v /etc/gryphon:/operator-secrets:ro \
  --entrypoint node gryphon dist/cli.js connect chronos \
  --bot-token-file /operator-secrets/bots/shared.token \
  --service-token-file /operator-secrets/clients/chronos.token \
  --adapter http://chronos:18280/api/internal/gryphon/command
```

## Bind through the CLI

```powershell
node dist/cli.js link issue chronos
node dist/cli.js link issue saturn
node dist/cli.js status
```

For Compose, replace `node dist/cli.js` with
`docker compose run --rm --no-deps --entrypoint node gryphon dist/cli.js`; link
and status commands need no secret-file mount.

The issue command prints a short-lived `/link CODE` command. Send it to the selected bot in a private chat. Codes are single-use and service-scoped. To remove one binding and let the service revoke identity-scoped access before it disappears:

```powershell
node dist/cli.js link revoke chronos
```

After linking, use `/chronos`, `/chronos status`, `/saturn drop`, or the compact forms `/chronos_status` and `/saturn_drop`. `/status` shows binding state for all services connected to that bot.

## Network boundaries

- `18380`: public webhook listener; publish only behind HTTPS at `GRYPHON_PUBLIC_ORIGIN`.
- `/run/gryphon/client.sock`: authenticated, service-scoped status, linking and notifications.
- admin socket: local operator CLI only.
- service adapters: allow only Gryphon and require their per-service bearer token.

Persistent state and generated secret copies live under `GRYPHON_DATA_DIR`. Back up the SQLite database and `secrets/` together. Bot and service tokens are never returned by status or admin responses.

## Native Linux service and updates

Release tags use `gryphon-linux-vX.Y.Z`. The release workflow produces
runtime-labelled archives plus `exocortex.gryphon.release.v1` manifests. For a
first installation, extract an archive and run `packaging/linux/install.sh` as
root, then set `GRYPHON_PUBLIC_ORIGIN` in `/etc/gryphon/gryphon.env` and start
`gryphon.service`.

Subsequent updates are performed by Updater through
`/v1/components/gryphon-linux/check` and
`/v1/components/gryphon-linux/update`. Updater resolves
`repositories.gryphon.url` from Kernel Register, verifies the release checksum,
atomically swaps the app directory, restarts Gryphon, checks the client socket,
and restores the previous directory if health does not recover.

## Verify

```powershell
corepack pnpm verify
```
