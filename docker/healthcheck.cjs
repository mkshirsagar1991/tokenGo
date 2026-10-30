'use strict';
// Dependency-free container health probe (the slim runtime image has no curl/wget).
//
//   node docker/healthcheck.cjs [path]
//
// Path (first match wins): argv[2], $HEALTHCHECK_PATH, default /api/v1/health/ready.
// Port: $HEALTHCHECK_PORT, else $PORT, else 3000.
// Exit 0 = healthy. A 2xx is healthy; with HEALTHCHECK_ACCEPT_REDIRECT=true a 3xx is too (used by the admin web app, whose
// home page redirects to its sign-in page). Anything else, a timeout or a connection error is unhealthy (exit 1).
const http = require('node:http');

const path = process.argv[2] || process.env.HEALTHCHECK_PATH || '/api/v1/health/ready';
const port = Number(process.env.HEALTHCHECK_PORT || process.env.PORT || 3000);
const acceptRedirect = process.env.HEALTHCHECK_ACCEPT_REDIRECT === 'true';

const req = http.get({ host: '127.0.0.1', port, path, timeout: 2500, headers: { accept: 'application/json' } }, (res) => {
  res.resume();
  const ok = (res.statusCode >= 200 && res.statusCode < 300) || (acceptRedirect && res.statusCode >= 300 && res.statusCode < 400);
  process.exit(ok ? 0 : 1);
});
req.on('timeout', () => req.destroy(new Error('timeout')));
req.on('error', () => process.exit(1));
