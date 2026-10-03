// PM2: pm2 start /srv/medshop/backend/deploy/ecosystem.config.cjs && pm2 save
const ROOT = '/srv/medshop';

module.exports = {
  apps: [
    {
      name: 'medshop-api',
      cwd: `${ROOT}/backend`,
      script: 'dist/server.js',
      // One process: the minute scheduler (mail queue, reconcile) must not run twice.
      instances: 1,
      max_memory_restart: '700M',
      env: { NODE_ENV: 'production' },
      time: true,
    },
    {
      name: 'medshop-shop',
      cwd: `${ROOT}/frontend`,
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3000 -H 127.0.0.1',
      max_memory_restart: '600M',
      env: { NODE_ENV: 'production' },
      time: true,
    },
    {
      name: 'medshop-admin',
      cwd: `${ROOT}/admin`,
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3001 -H 127.0.0.1',
      max_memory_restart: '400M',
      env: { NODE_ENV: 'production' },
      time: true,
    },
  ],
};
