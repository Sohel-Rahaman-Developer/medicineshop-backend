#!/usr/bin/env bash
# bash deploy.sh — pulls main, installs, builds and reloads the three apps; stops at the first failure.
# Shared server: MEDSHOP_ROOT=~/test/pharma MEDSHOP_API_PORT=5300 MEDSHOP_SHOP_PORT=3300 MEDSHOP_ADMIN_PORT=3301 bash deploy.sh
# MEDSHOP_BACKEND_PULLED=1 when a wrapper already pulled backend (so this script itself is the newest).
set -euo pipefail

export MEDSHOP_ROOT=${MEDSHOP_ROOT:-/srv/medshop}
export MEDSHOP_SHOP_PORT=${MEDSHOP_SHOP_PORT:-3300}
export MEDSHOP_ADMIN_PORT=${MEDSHOP_ADMIN_PORT:-3301}
API_PORT=${MEDSHOP_API_PORT:-5300}
API_URL=${MEDSHOP_API_URL:-https://medapi.trackcloud.in/api/v1}
# gh-pharma-<repo> host aliases (one deploy key each), or plain github.com when the account key can read all three
GH_HOST=${MEDSHOP_GH_HOST:-alias}
ROOT=$MEDSHOP_ROOT

step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$1"; }

sync() {
  local dir=$ROOT/$1 repo=$2 host
  host=$([ "$GH_HOST" = alias ] && echo "gh-pharma-$1" || echo "$GH_HOST")
  if [ -d "$dir/.git" ]; then git -C "$dir" pull -q --ff-only origin main; else git clone -q "git@$host:Sohel-Rahaman-Developer/$repo.git" "$dir"; fi
  echo "  $1: $(git -C "$dir" log -1 --format='%h %s' | cut -c1-90)"
}

mkdir -p "$ROOT/backups"
step "Pull code (GitHub main)"
if [ "${MEDSHOP_BACKEND_PULLED:-}" = 1 ]; then echo "  backend: $(git -C "$ROOT/backend" log -1 --format='%h %s' | cut -c1-90)"; else sync backend medicineshop-backend; fi
sync frontend medicineshop-frontend
sync admin medicineshop-admin

test -f "$ROOT/backend/.env" || { echo "Missing $ROOT/backend/.env — copy deploy/env.production.example and fill it"; exit 1; }
grep -q "^PORT=$API_PORT$" "$ROOT/backend/.env" || { echo "backend/.env must say PORT=$API_PORT"; exit 1; }

step "Backend (API) — install + build"
cd "$ROOT/backend"
npm ci --no-fund --loglevel=error
npm run build --silent

for app in frontend admin; do
  step "$([ "$app" = frontend ] && echo "Shop app" || echo "Admin") — install + build"
  cd "$ROOT/$app"
  echo "NEXT_PUBLIC_API_BASE_URL=$API_URL" > .env.production.local
  npm ci --no-fund --no-audit --loglevel=error
  npm run build --silent
done

step "Restart with PM2"
pm2 startOrReload "$ROOT/backend/deploy/ecosystem.config.cjs" --update-env
pm2 save

step "Health check"
sleep 4
curl -fsS "http://127.0.0.1:$API_PORT/health" >/dev/null && echo "  ✅ API up on $API_PORT"
curl -fsS -o /dev/null "http://127.0.0.1:$MEDSHOP_SHOP_PORT/login" && echo "  ✅ Shop app up on $MEDSHOP_SHOP_PORT"
curl -fsS -o /dev/null "http://127.0.0.1:$MEDSHOP_ADMIN_PORT/" && echo "  ✅ Admin up on $MEDSHOP_ADMIN_PORT"
echo
echo "Deployed: backend $(git -C "$ROOT/backend" rev-parse --short HEAD) · shop $(git -C "$ROOT/frontend" rev-parse --short HEAD) · admin $(git -C "$ROOT/admin" rev-parse --short HEAD)"
