# Gryphon

> Documentation authority: the workspace-wide [Part 00](https://github.com/psewdon1m-exocortex/general/blob/main/PART_00_SYSTEM_UNIFICATION_SPECIFICATION.md)
> and its applicable Parts are normative. This repository documents
> Gryphon-specific details only; a conflict is corrected here and a material
> implementation difference follows the Part 00 divergence protocol.

## Required pre-push gate

After native checks and before every push, complete the checks required by
[Part 06 — Unified acceptance checklist](https://github.com/psewdon1m-exocortex/general/blob/main/PART_06_UNIFIED_ACCEPTANCE_CHECKLIST.md) and run the versioned policy in
`.github/pre-push-gate.json` through `scripts/pre-push-gate.py`. CI repeats the
gate on `main`. Security is always reviewed; backup/restore, updater, embedded
Documentation and affected technical docs are reviewed when relevant. Apply
SEO/GEO checks to intentionally public/indexable surfaces and concealment,
crawler and probe-resistance checks to private or authenticated surfaces.
Every area requires `PASS` evidence or a reasoned `N/A`.

## Required pre-release known-problem gate

Before a service-qualified release is finalized, evaluate every active ID in
[Part 12](https://github.com/psewdon1m-exocortex/general/blob/main/PART_12_KNOWN_DEPLOYMENT_AND_OPERATIONS_PROBLEMS.md) against the exact candidate. Retain
`known-problems-report.json` bound to the service revision, qualified tag,
immutable central-documentation revision and catalog digest. Missing, stale,
failed, unknown or unsupported `N/A` evidence blocks publication. This is a
normative release requirement; until the repository workflow generates and
enforces that report, the release pipeline remains an implementation gap.

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

For the initial six-service deployment, Saturn Settings can install Gryphon and
register a bot through typed, authenticated Updater operations. The bot token is
transient input; only Gryphon retains its protected copy. The privileged CLI
provides the same bot registration operation:

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

- `18380`: public webhook listener; publish only through the single
  server-managed Nginx at `GRYPHON_PUBLIC_ORIGIN`. Gryphon does not ship or run
  an embedded Nginx. Telegram webhook traffic is ordinary HTTPS, so coturn is
  not used.
- `/run/gryphon/client.sock`: authenticated, service-scoped status, linking and notifications.
- `/run/gryphon-admin/admin.sock`: local operator CLI and typed Updater operations; service containers
  never mount this socket.
- service adapters: allow only Gryphon and require their per-service bearer token.

Persistent state and generated secret copies live under `GRYPHON_DATA_DIR`. Back up the SQLite database and `secrets/` together. Bot and service tokens are never returned by status or admin responses.

## Native Linux service and updates

Release tags use `gryphon-vMAJOR.MINOR.PATCH` and the version sequence starts
at `0.0.1`. A plain `v0.0.1`-style tag runs verification-only CI and cannot
publish or mutate a release. The release workflow produces
runtime-labelled archives plus `exocortex.gryphon.release.v1` manifests. For a
first installation, use Saturn Settings → Bot connection → Install Gryphon.
Gryphon's private signing key remains only in GitHub Secrets; the protected
release job signs the manifest and publishes the public counterpart. The
exact-version Updater bootstrap verifies its own signed installer before
accepting Gryphon's pinned public key from inside that installer. It creates
`/etc/exocortex/release-trust/gryphon.pem` and fails on an existing mismatching
key. Updater then verifies Gryphon's manifest before any archive download,
provisions the host daemon and connects Saturn. No `scp`, manual release-key
fingerprint or public key downloaded beside the helper manifest is used. A
healthy existing host instance is reused. Gryphon keeps its own mode-`0600`
`/etc/gryphon/gryphon.env`; provision Kernel URL/token so subsequent public and
adapter addresses are resolved through Kernel.

The CI workflow also accepts plain `v*` tags for verification-only evidence;
only the exact `gryphon-v*` namespace reaches the protected release job.
Legacy `gryphon-linux-v*` tags remain immutable historical records and no
longer trigger publication.

Subsequent updates are performed by Updater through
`/v1/components/gryphon-linux/check` and
`/v1/components/gryphon-linux/update`. Updater resolves
`repositories.gryphon.url` from Kernel Register, verifies the release signature and checksum,
atomically swaps the app directory, restarts Gryphon, checks the client socket,
and restores the previous directory if health does not recover.

## Verify

```powershell
corepack pnpm verify
```

The current six-service deployment, trust, recovery and acceptance contract is documented in [Deployment readiness](DEPLOYMENT_READINESS.md).
