// PM2 ecosystem file — voir https://pm2.keymetrics.io/
module.exports = {
  apps: [
    {
      name: "buzzbooster-api",
      script: "./api-server/index.mjs",
      node_args: "--enable-source-maps",
      env: {
        NODE_ENV: "production",
        PORT: 8080,
      },
      max_memory_restart: "512M",
      autorestart: true,
      watch: false,
    },
  ],
};
