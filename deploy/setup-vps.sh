#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 22.04 / 24.04 VPS, as root:  bash setup-vps.sh
set -euo pipefail

APP_USER=medshop
ROOT=/srv/medshop

apt-get update
apt-get -y upgrade
timedatectl set-timezone Asia/Kolkata
apt-get install -y curl git nginx certbot python3-certbot-nginx ufw fail2ban gnupg ca-certificates

# Node 24 LTS + PM2
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs
npm install -g pm2

# MongoDB Database Tools (mongodump / mongorestore for npm run backup)
. /etc/os-release
curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc | gpg --dearmor -o /usr/share/keyrings/mongodb-8.gpg
echo "deb [signed-by=/usr/share/keyrings/mongodb-8.gpg] https://repo.mongodb.org/apt/ubuntu ${VERSION_CODENAME}/mongodb-org/8.0 multiverse" > /etc/apt/sources.list.d/mongodb-org-8.0.list
apt-get update
apt-get install -y mongodb-database-tools

# Firewall: SSH + web only; the apps listen on 127.0.0.1 behind Nginx
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
systemctl enable --now fail2ban

# A user that owns the code and runs PM2 (no sudo)
id -u "$APP_USER" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "$APP_USER"
mkdir -p "$ROOT/backups"
chown -R "$APP_USER:$APP_USER" "$ROOT"
chmod 700 "$ROOT/backups"

# 2 GB swap: next build needs it on a 2-4 GB box
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# PM2 starts the apps again after a reboot
env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER"

# One read-only deploy key per repo (GitHub allows a key on one repo only), picked by host alias
sudo -u "$APP_USER" -H bash -s <<'KEYS'
mkdir -p ~/.ssh && chmod 700 ~/.ssh
for r in backend frontend admin; do
  test -f ~/.ssh/medshop-$r || ssh-keygen -t ed25519 -N "" -f ~/.ssh/medshop-$r -C medshop-vps-$r >/dev/null
  grep -q "Host github-$r" ~/.ssh/config 2>/dev/null || printf 'Host github-%s
  HostName github.com
  User git
  IdentityFile ~/.ssh/medshop-%s
  IdentitiesOnly yes
' "$r" "$r" >> ~/.ssh/config
  echo "== Deploy key for medicineshop-$r (GitHub → repo → Settings → Deploy keys, read-only):"
  cat ~/.ssh/medshop-$r.pub
done
chmod 600 ~/.ssh/config
ssh-keyscan github.com >> ~/.ssh/known_hosts 2>/dev/null
KEYS
echo
echo "Done. Add the three keys above on GitHub, then as $APP_USER run deploy.sh (copy it to the server the first time)."
