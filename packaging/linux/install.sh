#!/bin/sh
set -eu

[ "$(id -u)" -eq 0 ] || { echo "Gryphon installation requires root." >&2; exit 2; }
[ -x /usr/bin/node ] || { echo "Node.js 24 or newer is required at /usr/bin/node." >&2; exit 3; }
node_major=$(/usr/bin/node -p 'Number(process.versions.node.split(".")[0])')
[ "$node_major" -ge 24 ] || { echo "Node.js 24 or newer is required." >&2; exit 3; }
[ -f dist/main.js ] && [ -f dist/cli.js ] && [ -f package.json ] || { echo "Run install.sh from an extracted Gryphon release." >&2; exit 4; }

getent group gryphon-clients >/dev/null 2>&1 || groupadd --system gryphon-clients
if ! id gryphon >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/gryphon --shell /usr/sbin/nologin --gid gryphon-clients gryphon
fi
usermod --gid gryphon-clients gryphon
install -d -o gryphon -g gryphon-clients -m 0700 /var/lib/gryphon
install -d -o root -g root -m 0755 /usr/local/lib/gryphon
install -d -o root -g root -m 0755 /usr/local/lib/gryphon/app
cp -R dist /usr/local/lib/gryphon/app/dist
install -o root -g root -m 0644 package.json /usr/local/lib/gryphon/app/package.json
install -d -o root -g root -m 0750 /etc/gryphon
install -d -o root -g gryphon-clients -m 0750 /etc/gryphon/clients
if [ ! -f /etc/gryphon/gryphon.env ]; then
  cat >/etc/gryphon/gryphon.env <<'EOF'
# Public HTTPS origin used when registering Telegram webhooks.
GRYPHON_PUBLIC_ORIGIN=
EOF
  chmod 0640 /etc/gryphon/gryphon.env
fi
install -o root -g root -m 0644 packaging/linux/gryphon.service /etc/systemd/system/gryphon.service
install -o root -g root -m 0755 packaging/linux/gryphonctl /usr/local/sbin/gryphon
systemctl daemon-reload
systemctl enable gryphon.service
