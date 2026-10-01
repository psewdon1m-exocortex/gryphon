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

Gryphon is the single Telegram transport gateway for Exocortex services. It owns adapter provider tokens, webhooks, update deduplication, Telegram identity bindings, service connections, callback buttons and outbound delivery. Chronos, Saturn and Mastermind expose authenticated internal command endpoints and do not talk to Telegram directly.

One adapter is paired to one Telegram account with a single `/link CODE` issued in Updater TUI. Each service owner then selects a paired adapter in that service's Settings. Selecting it grants the paired account access to the service; several services may select the same adapter. A service owner can revoke that service's binding without disconnecting the adapter or changing access to other services.

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

Use `sudo updater tui` on the host to install, check and update the shared Gryphon instance and to register an adapter. None of these host operations selects a consuming service. Updater uses its own scoped Kernel release-source connection, with the configured Gryphon fallback during a Kernel outage. Enter the adapter alias and Telegram provider token in the TUI. Updater sends the token only to Gryphon's root-only admin socket. Gryphon verifies the adapter with Telegram, registers the webhook and stores its protected token copy. The TUI displays a short-lived `/link CODE`; send it to the adapter from the Telegram account that should own it. The TUI adapter list shows when pairing is complete.

Each service installer provisions one service credential under
`/etc/gryphon/clients/<service>.token` and mounts the same file read-only into
that service. In Chronos, Saturn or Mastermind Settings, **Link service function** lists paired adapters and stores only the selected adapter, the fixed service command prefix and the service command endpoint URL. The service connection receives the paired Telegram identity automatically. No second `/link` is needed. If a service binding is later revoked in Settings, **Link Telegram account** restores the paired identity for that service.

Existing service bindings remain in place during upgrade. When all existing connections to an adapter use the same Telegram identity, Gryphon pairs that adapter automatically. If they disagree, the operator must pair it in the TUI before adding a new service connection. Deploy Gryphon and Updater before updating the service interfaces; older service clients may still request service-level link codes, which the new Gryphon rejects.

Services publish their user-facing commands through the authenticated client
socket:

```http
PUT /v1/service/command-catalog
Authorization: Bearer <service token>
Content-Type: application/json

{
  "schema": "exocortex.telegram.command-catalog.v1",
  "commands": [
    {
      "name": "drop",
      "adapterCommand": "drop",
      "description": "Create a Drop Point code"
    }
  ]
}
```

Command names are unique per Telegram bot. Gryphon rejects collisions with
`409 command_conflict` without replacing the previous catalog. `start`,
`help`, `services`, `link` and `cancel` are Gryphon commands and cannot be
claimed by a service. Telegram's native command menu and `/help` are generated
from this catalog and scoped to the services linked in the current private
chat.

The primary commands are `/timer`, `/active`, `/today`, `/week`, `/month`,
`/stop`, `/undo`, `/retype` and `/backfill` for Chronos, plus `/drop`,
`/drop_status` and `/drop_revoke` for Saturn. Legacy service-prefixed forms
remain available as hidden compatibility aliases.
Use `/services` to inspect bindings; `/status` remains a hidden alias for that
Gryphon command during migration.

Adapters can return `replyKeyboard` on a `send_message` action. Gryphon stores
each button route against the bot, service connection, Telegram user and
private chat, then sends Telegram a persistent reply keyboard. Button text is
never trusted without that scoped mapping and a live service binding. An
adapter can also return `expectInput` with an adapter command and expiry. The
next non-command message from that same user and chat is routed to the pending
command; `/cancel`, unlink, disconnect and expiry clear it. Both interaction
states survive Gryphon restarts because they are stored in SQLite.

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
first installation, use the signed release's `bootstrap.sh` on an empty host
or `sudo updater tui` → Gryphon → Install Gryphon. Both paths install or reuse
one host Updater and one Gryphon daemon; neither requires a registered service
or Kernel connection for local process health. The `0.1.7` release declares
`hostDependencyProtocol: 1` for this headless contract. Older archives are
rejected by new host installers.
Gryphon's private signing key remains only in GitHub Secrets; the protected
release job signs the manifest and publishes the public counterpart. The
exact-version Updater bootstrap verifies its own signed installer before
accepting Gryphon's pinned public key from inside that installer. It creates
`/etc/exocortex/release-trust/gryphon.pem` and fails on an existing mismatching
key. Updater then verifies Gryphon's manifest before any archive download,
provisions the host daemon. Saturn and other consumers supply their own client
credentials when installed. No `scp`, manual release-key
fingerprint or public key downloaded beside the helper manifest is used. A
healthy existing host instance is reused. Gryphon keeps its own mode-`0600`
`/etc/gryphon/gryphon.env`. Kernel discovery and Telegram bot linking can be
configured later; the daemon stays healthy while they are pending.

The CI workflow also accepts plain `v*` tags for verification-only evidence;
only the exact `gryphon-v*` namespace reaches the protected release job.
Legacy `gryphon-linux-v*` tags remain immutable historical records and no
longer trigger publication.

Subsequent checks and updates are performed through `sudo updater tui` for the one shared host instance. Updater resolves
`repositories.gryphon.url` through Updater's own scoped Kernel connection, or
the Gryphon URL saved in root TUI when that connection is unavailable. It verifies the release signature and checksum,
atomically swaps the app directory and verified systemd unit, restarts Gryphon,
checks the client socket, and restores both previous versions if health does
not recover. The unit preserves `/run/gryphon` across restarts so connected
service containers retain the live client socket mount.

## Verify

```powershell
corepack pnpm verify
```

The current six-service deployment, trust, recovery and acceptance contract is documented in [Deployment readiness](DEPLOYMENT_READINESS.md).
