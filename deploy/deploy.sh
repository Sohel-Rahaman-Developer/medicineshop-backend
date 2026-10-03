#!/usr/bin/env bash
# As the medshop user: bash /srv/medshop/backend/deploy/deploy.sh   (first time: run it from a copy of this file)
# Clones or pulls main, installs, checks, builds and reloads all three apps. Stops at the first failure.
set -euo pipefail

ROOT=/srv/medshop
API_URL=https://medapi.trackcloud.in/api/v1

sync() {
  local dir=$ROOT/$1 repo=$2
  if [ -d "$dir/.git" ]; then git -C "$dir" pull --ff-only origin main; else git clone "git@github-$1:Sohel-Rahaman-Developer/$repo.git" "$dir"; fi
}

sync backend medicineshop-backend
sync frontend medicineshop-frontend
sync admin medicineshop-admin

test -f "$ROOT/backend/.env" || { echo "Missing $ROOT/backend/.env — copy deploy/env.production.example and fill it"; exit 1; }

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
sleep 3
curl -fsS http://127.0.0.1:5000/health >/dev/null && echo "API up"
curl -fsS -o /dev/null http://127.0.0.1:3000/login && echo "Shop app up"
curl -fsS -o /dev/null http://127.0.0.1:3001/ && echo "Admin up"
