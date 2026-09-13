# gryphon deployment and recovery contract

Gryphon is installed once per host and connected only to consuming services. In the initial six-service profile Saturn is its consumer. The signed release bundles its Node runtime. Bounded native HTTP transport supports the production jitless sandbox without the WebAssembly parser required by built-in fetch. The public proxy exposes only Telegram webhook POST routes; administration and service control use separate Unix sockets. Saturn sends typed installation and transient bot registration through Updater and never mounts the privileged socket. Gryphon owns bot/service tokens and identity bindings; ordinary infrastructure secrets remain in Volt. Current webhook and adapter addresses are discovered through Kernel. Persistent queues and deduplication history have size/count limits, completed payloads are cleared and capacity exhaustion applies backpressure.

## Trust and operator prerequisites

The selected deployment profile contains Kernel, Volt, Saturn, Updater, Neptune and Gryphon. Per-host helpers are reused when healthy; attaching a service does not silently downgrade or reinstall them. Operator control is available through connected service Settings and typed CLI actions. Jobs retain their identifiers across page reloads and must reach a verified terminal result.

Release manifests use detached RSA-PSS-SHA256 signatures with a per-project RSA key of at least 3072 bits. Keep Gryphon's private key only in GitHub Secrets and expose it only to the protected release-signing job. CI derives the public counterpart. Gryphon trust is pinned from inside the installer verified by Updater's exact-version bootstrap; Updater creates `/etc/exocortex/release-trust/gryphon.pem` before any Gryphon download and never replaces an existing mismatching key automatically. No `scp`, manual release-key fingerprint or public key downloaded beside a helper manifest is part of this trust path. Saturn also retains its Ed25519 installer signature. The six-service head bundles require Updater 0.4.3 or newer.

Populate actual Kernel/Volt coordinates, service tokens and the exact server-Nginx webhook proxy hop. Gryphon keeps its own mode-`0600` `/etc/gryphon/gryphon.env`; no consuming service may absorb it. Its Telegram webhook is public but authenticated by the Telegram transport contract; operator control remains on local authenticated sockets, so `OPERATOR_CIDR` is not an authentication mechanism. Gryphon runs no embedded Nginx and uses no coturn. Secrets must not appear in links, responses, browser persistence or logs. Crawler directives supplement authenticated access; they do not hide public data from an uncooperative crawler. Resolve service data and generated link origins through Kernel; bootstrap trust and local loopback helper endpoints are explicit exceptions.

## Recovery boundaries

Keep the Access Key and helper-recovery passphrase separately from their archives. Main-service recovery retains user settings and application data while preserving or requiring re-enrollment of external host trust. The encrypted helper profile is controlled by Updater and contains Neptune/Gryphon state and credentials plus Updater job/rollback history. It excludes executable files, release trust keys, systemd units and head deployment environments. Install trusted software and register target heads before restoring. The bounded helper archive fails explicitly at 128 MiB expanded or 10000 files; it never silently omits data.

## Acceptance evidence

The seven-area policy in .github/pre-push-gate.json is required after native CI verification. Public indexing is intentionally not applicable. For an uncommitted local review run the gate with --worktree after the native checks. Gate PASS checks policy/evidence/verification linkage; it is not a substitute for executing the integration scenarios.

Qualify the connected system with real HTTP Kernel→Volt authentication, clean archives/restores, PostgreSQL and pinned SFTP, independent Volt mirror, Windows folder synchronization, network interruption/replay, signed artifact rejection, private-edge negative cases and helper installation/reuse. Record PASS, FAIL and NOT_RUN separately. Production credentials, signed publication and actual deployment remain operator provisioning operations.

See [README](README.md) for service commands.
