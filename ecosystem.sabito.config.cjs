// Optional persistent production service for hosts that suspend HTTP processes.
// Run ONLY on the production server with its existing server environment.
// No credentials are stored here. The database lock elects a single consumer
// even when the API's integrated supervisor is also running.
const path = require("node:path");
module.exports = {
  apps: [{
    name: "buzzbooster-sabito",
    script: path.join(__dirname, "dist-deploy/api-server/scripts/sabito-supervisor.mjs"),
    cwd: path.join(__dirname, "dist-deploy/api-server"),
    interpreter: process.execPath,
    exec_mode: "fork",
    instances: 1,
    autorestart: true,
    restart_delay: 3000,
    kill_timeout: 8000,
    time: true,
    env: { NODE_ENV: "production" },
  }],
};
