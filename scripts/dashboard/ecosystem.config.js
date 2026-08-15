module.exports = {
  apps: [
    {
      name: 'agenthub-dashboard',
      cwd: '/home/agentuser/agent-hub',
      script: 'scripts/dashboard/server.js',
      env: {
        PORT: 3005,
        AGENTHUB_BASE: 'http://127.0.0.1:8100',
        AGENTHUB_TOKEN: process.env.AGENTHUB_TOKEN
      },
      max_memory_restart: '200M',
      autorestart: true
    }
  ]
};
