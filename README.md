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

First connect one or more Telegram bots to Gryphon from the privileged CLI. Bot
tokens stay in operator-owned files and are never sent to Chronos or Saturn:

```powershell
node dist/cli.js bot connect main
node dist/cli.js bot connect private
node dist/cli.js bot list
```

Each connect command prompts for the Telegram bot token without echoing it,
verifies the bot identity with Telegram and registers the webhook. Gryphon then
stores its own protected token copy; no operator-created token file is required.
Use `--bot-token-file PATH` only for non-interactive automation.

Each service installer provisions one service credential under
`/etc/gryphon/clients/<service>.token` and mounts the same file read-only into
that service. In Chronos or Saturn Settings, **Link service function** lists the
bots above and stores only the selected bot, the fixed service command prefix,
and the service adapter URL. Multiple services can select the same bot; each can
also select a different one.

When Gryphon runs through Compose, invoke the interactive CLI in a one-off
container that shares the daemon's private admin socket:

```sh
docker compose run --rm --no-deps \
  --entrypoint node gryphon dist/cli.js bot connect main
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

This second link is deliberately separate from connecting a bot to a service:
it authorizes one Telegram user to execute that service's commands. The issue
command prints a short-lived `/link CODE` command. Send it to the bot selected in
the service UI. Codes are single-use and service-scoped. To remove one user
binding and let the service revoke identity-scoped access before it disappears:

```powershell
node dist/cli.js link revoke chronos
```

After linking, use `/chronos`, `/chronos status`, `/saturn drop`, or the compact forms `/chronos_status` and `/saturn_drop`. `/status` shows binding state for all services connected to that bot.

## Network boundaries

- `18380`: public webhook listener; publish only behind HTTPS at `GRYPHON_PUBLIC_ORIGIN`.
- `/run/gryphon/client.sock`: authenticated, service-scoped status, linking and notifications.
- `/run/gryphon-admin/admin.sock`: local operator CLI only; service containers
  never mount this socket.
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
