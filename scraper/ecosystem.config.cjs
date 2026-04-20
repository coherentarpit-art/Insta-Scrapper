/**
 * PM2: continuous queue worker on a server (e.g. GCP VM).
 *
 *   cd scraper && npm ci && cp .env.example .env   # then edit .env
 *   pm2 start ecosystem.config.cjs
 *   pm2 save && pm2 startup
 *
 * Logs: pm2 logs insta-queue-worker
 */
module.exports = {
  apps: [
    {
      name: 'insta-queue-worker',
      cwd: __dirname,
      script: 'queue-crawler.js',
      args: 'start --concurrency 1',
      instances: 1,
      autorestart: true,
      max_restarts: 100,
      min_uptime: '15s',
      exp_backoff_restart_delay: 3000,
    },
  ],
};
