module.exports = {
  apps: [{
    name: 'agent-hub',
    script: 'server.js',
    cwd: '/home/agentuser/agent-hub',
    instances: 1,
    autorestart: true,
    max_restarts: 10,
    env: {
      NODE_ENV: 'production'
    }
  }]
};
