// PM2: MEDSHOP_ROOT=~/test/pharma pm2 startOrReload deploy/ecosystem.config.cjs && pm2 save
// Ports and folder come from the environment so it can share a server with other apps.
const os = require('node:os');
const ROOT = process.env.MEDSHOP_ROOT || '/srv/medshop';
// Load balancing: PM2 cluster mode shares the API port between workers, round robin. Two on a server with 2+ CPUs and
// 2 GB+ memory, else one; MEDSHOP_API_INSTANCES overrides. The minute scheduler runs on one worker (a lease in the DB).
const API_INSTANCES = Number(process.env.MEDSHOP_API_INSTANCES) || (os.cpus().length >= 2 && os.totalmem() >= 2 * 1024 ** 3 ? 2 : 1);
const SHOP_PORT = process.env.MEDSHOP_SHOP_PORT || '3300';
const ADMIN_PORT = process.env.MEDSHOP_ADMIN_PORT || '3301';

module.exports = {
  apps: [
    {
      name: 'pharma-api',
      cwd: `${ROOT}/backend`,
      script: 'dist/server.js',
      // PORT comes from backend/.env.
      exec_mode: 'cluster',
      instances: API_INSTANCES,
      // A new worker gets traffic once it says it is listening; the old one has 12 s to finish its requests.
      wait_ready: true,
      listen_timeout: 20_000,
      kill_timeout: 12_000,
      max_memory_restart: '700M',
      env: { NODE_ENV: 'production', API_WORKERS: String(API_INSTANCES) },
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
