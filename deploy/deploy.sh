#!/usr/bin/env bash
# bash deploy.sh — clones or pulls main, installs, builds and reloads the three apps; stops at the first failure.
# Shared server: MEDSHOP_ROOT=~/test/pharma MEDSHOP_API_PORT=5300 MEDSHOP_SHOP_PORT=3300 MEDSHOP_ADMIN_PORT=3301 bash deploy.sh
set -euo pipefail

export MEDSHOP_ROOT=${MEDSHOP_ROOT:-/srv/medshop}
export MEDSHOP_SHOP_PORT=${MEDSHOP_SHOP_PORT:-3300}
export MEDSHOP_ADMIN_PORT=${MEDSHOP_ADMIN_PORT:-3301}
API_PORT=${MEDSHOP_API_PORT:-5300}
API_URL=${MEDSHOP_API_URL:-https://medapi.trackcloud.in/api/v1}
# gh-pharma-<repo> host aliases (one deploy key each), or plain github.com when the account key can read all three
GH_HOST=${MEDSHOP_GH_HOST:-alias}
ROOT=$MEDSHOP_ROOT

sync() {
  local dir=$ROOT/$1 repo=$2 host
  host=$([ "$GH_HOST" = alias ] && echo "gh-pharma-$1" || echo "$GH_HOST")
  if [ -d "$dir/.git" ]; then git -C "$dir" pull --ff-only origin main; else git clone "git@$host:Sohel-Rahaman-Developer/$repo.git" "$dir"; fi
}

mkdir -p "$ROOT/backups"
sync backend medicineshop-backend
sync frontend medicineshop-frontend
sync admin medicineshop-admin

test -f "$ROOT/backend/.env" || { echo "Missing $ROOT/backend/.env — copy deploy/env.production.example and fill it"; exit 1; }
grep -q "^PORT=$API_PORT$" "$ROOT/backend/.env" || { echo "backend/.env must say PORT=$API_PORT"; exit 1; }

cd "$ROOT/backend"
npm ci
npm run build

for app in frontend admin; do
  cd "$ROOT/$app"
  echo "NEXT_PUBLIC_API_BASE_URL=$API_URL" > .env.production.local
  npm ci
  npm run build
done

pm2 startOrReload "$ROOT/backend/deploy/ecosystem.config.cjs" --update-env
pm2 save
sleep 4
curl -fsS "http://127.0.0.1:$API_PORT/health" >/dev/null && echo "API up on $API_PORT"
curl -fsS -o /dev/null "http://127.0.0.1:$MEDSHOP_SHOP_PORT/login" && echo "Shop app up on $MEDSHOP_SHOP_PORT"
curl -fsS -o /dev/null "http://127.0.0.1:$MEDSHOP_ADMIN_PORT/" && echo "Admin up on $MEDSHOP_ADMIN_PORT"
