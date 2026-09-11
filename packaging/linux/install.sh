#!/bin/sh
set -eu

[ "$(id -u)" -eq 0 ] || { echo "Gryphon installation requires root." >&2; exit 2; }
node_binary=./runtime/node
[ -x "$node_binary" ] || node_binary=/usr/bin/node
[ -x "$node_binary" ] || { echo "The signed release must include its Node.js runtime." >&2; exit 3; }
node_major=$("$node_binary" -p 'Number(process.versions.node.split(".")[0])')
[ "$node_major" -ge 24 ] || { echo "Node.js 24 or newer is required." >&2; exit 3; }
[ -f dist/main.js ] && [ -f dist/cli.js ] && [ -f package.json ] || { echo "Run install.sh from an extracted Gryphon release." >&2; exit 4; }
command -v flock >/dev/null 2>&1 || { echo "flock is required." >&2; exit 3; }
lock_dir=/run/lock
[ "${EXOCORTEX_PREPARED_HOST:-false}" != true ] || lock_dir=/run/exocortex
exec 9>"$lock_dir/gryphon-install.lock"
flock -x 9

getent group gryphon-clients >/dev/null 2>&1 || groupadd --system gryphon-clients
if ! id gryphon >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/gryphon --shell /usr/sbin/nologin --gid gryphon-clients gryphon
fi
[ "${EXOCORTEX_PREPARED_HOST:-false}" = true ] || usermod --gid gryphon-clients gryphon
install -d -o gryphon -g gryphon-clients -m 0700 /var/lib/gryphon
install -d -o root -g root -m 0755 /usr/local/lib/gryphon
install -d -o root -g root -m 0755 /usr/local/lib/gryphon/app
install -d -o root -g root -m 0755 /usr/local/lib/gryphon/app/dist
install -d -o root -g root -m 0755 /usr/local/lib/gryphon/app/runtime
install -o root -g root -m 0755 "$node_binary" /usr/local/lib/gryphon/app/runtime/node
cp -R dist/. /usr/local/lib/gryphon/app/dist/
find /usr/local/lib/gryphon/app/dist -type d -exec chmod 0755 {} +
find /usr/local/lib/gryphon/app/dist -type f -exec chmod 0644 {} +
install -o root -g root -m 0644 package.json /usr/local/lib/gryphon/app/package.json
install -d -o root -g gryphon-clients -m 0750 /etc/gryphon
install -d -o root -g gryphon-clients -m 0750 /etc/gryphon/clients
if [ ! -f /etc/gryphon/gryphon.env ]; then
  cat >/etc/gryphon/gryphon.env <<'EOF'
# Public HTTPS origin used when registering Telegram webhooks.
GRYPHON_PUBLIC_ORIGIN=
EOF
  chmod 0640 /etc/gryphon/gryphon.env
fi
if [ "${EXOCORTEX_PREPARED_HOST:-false}" = true ]; then
  install -o root -g root -m 0644 packaging/linux/gryphon.service /etc/exocortex/units/gryphon.service
  install -o root -g root -m 0755 packaging/linux/gryphonctl /usr/local/lib/gryphon/gryphonctl
else
  install -o root -g root -m 0644 packaging/linux/gryphon.service /etc/systemd/system/gryphon.service
  install -o root -g root -m 0755 packaging/linux/gryphonctl /usr/local/sbin/gryphon
fi
systemctl daemon-reload
systemctl enable gryphon.service
