// PM2: MEDSHOP_ROOT=~/test/pharma pm2 startOrReload deploy/ecosystem.config.cjs && pm2 save
// Ports and folder come from the environment so it can share a server with other apps.
const ROOT = process.env.MEDSHOP_ROOT || '/srv/medshop';
const SHOP_PORT = process.env.MEDSHOP_SHOP_PORT || '3300';
const ADMIN_PORT = process.env.MEDSHOP_ADMIN_PORT || '3301';

module.exports = {
  apps: [
    {
      name: 'pharma-api',
      cwd: `${ROOT}/backend`,
      script: 'dist/server.js',
      // One process: the minute scheduler (mail queue, reconcile) must not run twice. PORT comes from backend/.env.
      instances: 1,
      max_memory_restart: '700M',
      env: { NODE_ENV: 'production' },
      time: true,
    },
    {
      name: 'pharma-shop',
      cwd: `${ROOT}/frontend`,
      script: 'node_modules/next/dist/bin/next',
      args: `start -p ${SHOP_PORT} -H 127.0.0.1`,
      max_memory_restart: '600M',
      env: { NODE_ENV: 'production' },
      time: true,
    },
    {
      name: 'pharma-admin',
      cwd: `${ROOT}/admin`,
      script: 'node_modules/next/dist/bin/next',
      args: `start -p ${ADMIN_PORT} -H 127.0.0.1`,
      max_memory_restart: '400M',
      env: { NODE_ENV: 'production' },
      time: true,
    },
  ],
};
