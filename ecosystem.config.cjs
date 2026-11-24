// pm2 process file:  pm2 start ecosystem.config.cjs
// One instance only: storage, caches and Prev/Next pages live in this one process.
module.exports = {
  apps: [
    {
      name: 'xp-bot',
      script: 'dist/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      // Back off if it keeps crashing on start (bad token, bad data) instead of looping.
      exp_backoff_restart_delay: 2000,
      max_memory_restart: '512M',
      // Lets the bot finish storage writes before pm2 kills it.
      kill_timeout: 12000,
      env: { NODE_ENV: 'production' },
      time: true,
    },
  ],
};
