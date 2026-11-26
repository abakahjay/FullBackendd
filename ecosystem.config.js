// PM2 process file: `npx pm2 start ecosystem.config.js` (Render runs `node app.js` itself and
// doesn't need this). One process; app.js is not cluster-safe yet because the rate-limit
// counters, Socket.IO rooms and some caches live in memory (see PRODUCTION_AUDIT.md).
module.exports = {
    apps: [
        {
            name: 'fullbackendd',
            script: 'app.js',
            instances: 1,
            exec_mode: 'fork',
            // Restart before a slow leak takes the box down (Render's free/starter plans have 512 MB).
            max_memory_restart: process.env.PM2_MAX_MEMORY || '450M',
            // app.js exits(1) when Mongo is unreachable at boot; back off instead of a tight loop.
            exp_backoff_restart_delay: 1000,
            max_restarts: 50,
            // app.js drains connections on SIGTERM with its own 10s hard stop.
            kill_timeout: 12000,
            env: { NODE_ENV: 'production' },
            time: true,
        },
    ],
};
