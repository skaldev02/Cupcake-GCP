const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const PORT = process.env.PORT || 3000;
const BIND_HOST = process.env.BIND_HOST || '0.0.0.0';
const AUTH_ENABLED = (process.env.AUTH_ENABLED || 'false').toLowerCase() === 'true';
const AUTH_USERNAME = process.env.AUTH_USERNAME || '';
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || '';
const APP_ACCESS_TOKEN = process.env.APP_ACCESS_TOKEN || '';

function findK6() {
  const wellKnown = process.platform === 'win32'
    ? ['C:\\Program Files\\k6\\k6.exe', 'C:\\Program Files (x86)\\k6\\k6.exe']
    : ['/usr/bin/k6', '/usr/local/bin/k6', '/snap/bin/k6'];
  for (const p of wellKnown) {
    if (fs.existsSync(p)) return p;
  }
  try {
    const cmd = process.platform === 'win32' ? 'where k6' : 'which k6';
    return execSync(cmd, { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
  } catch { /* not on PATH */ }
  return 'k6';
}

const K6_BIN = findK6();
console.log(`k6 binary: ${K6_BIN}`);

let activeTest = null;

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

function safeCompare(a, b) {
  const aBuf = Buffer.from(String(a));
  const bBuf = Buffer.from(String(b));
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function parseBasicAuth(headerValue) {
  if (!headerValue || !headerValue.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(headerValue.slice(6), 'base64').toString('utf8');
    const splitIndex = decoded.indexOf(':');
    if (splitIndex < 0) return null;
    return {
      username: decoded.slice(0, splitIndex),
      password: decoded.slice(splitIndex + 1),
    };
  } catch {
    return null;
  }
}

function bearerOk(authHeader) {
  if (!APP_ACCESS_TOKEN || !authHeader || !authHeader.startsWith('Bearer ')) return false;
  const token = authHeader.slice(7).trim();
  return Boolean(token && safeCompare(token, APP_ACCESS_TOKEN));
}

function basicOk(authHeader) {
  if (!AUTH_USERNAME || !AUTH_PASSWORD) return false;
  const basic = parseBasicAuth(authHeader || '');
  return Boolean(basic &&
    safeCompare(basic.username, AUTH_USERNAME) &&
    safeCompare(basic.password, AUTH_PASSWORD));
}

/** Browser WebSockets cannot set Authorization; allow ?token= same as Bearer. */
function queryTokenOk(urlPath, hostHeader) {
  if (!APP_ACCESS_TOKEN || !urlPath) return false;
  try {
    const u = new URL(urlPath, `http://${hostHeader || 'localhost'}`);
    const q = u.searchParams.get('token');
    return Boolean(q && safeCompare(q, APP_ACCESS_TOKEN));
  } catch {
    return false;
  }
}

function isAuthorizedHttp(headers) {
  if (!AUTH_ENABLED) return true;
  const authHeader = headers.authorization || '';
  if (bearerOk(authHeader)) return true;
  if (basicOk(authHeader)) return true;
  return false;
}

function isAuthorizedWs(req) {
  if (!AUTH_ENABLED) return true;
  const authHeader = req.headers.authorization || '';
  if (bearerOk(authHeader)) return true;
  if (basicOk(authHeader)) return true;
  if (queryTokenOk(req.url, req.headers.host)) return true;
  return false;
}

function sendUnauthorizedHttp(res) {
  if (AUTH_USERNAME && AUTH_PASSWORD) {
    res.set('WWW-Authenticate', 'Basic realm="k6-load-tester"');
  }
  res.status(401).json({
    error: AUTH_USERNAME && AUTH_PASSWORD
      ? 'Unauthorized. Use Basic credentials, or Bearer token if configured.'
      : 'Unauthorized. Send Authorization: Bearer <token> (set APP_ACCESS_TOKEN on the server).',
  });
}

function requireApiAuth(req, res, next) {
  if (!isAuthorizedHttp(req.headers)) return sendUnauthorizedHttp(res);
  next();
}

app.get('/api/auth/config', (_req, res) => {
  res.json({
    authEnabled: AUTH_ENABLED,
    bearer: Boolean(APP_ACCESS_TOKEN),
    basic: Boolean(AUTH_USERNAME && AUTH_PASSWORD),
  });
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({
    type: 'status',
    running: activeTest !== null,
    config: activeTest ? activeTest.config : null,
  }));
});

server.on('upgrade', (request, socket, head) => {
  if (!isAuthorizedWs(request)) {
    const challenge = (AUTH_USERNAME && AUTH_PASSWORD)
      ? 'WWW-Authenticate: Basic realm="k6-load-tester"\r\n'
      : '';
    socket.write(
      'HTTP/1.1 401 Unauthorized\r\n' +
      challenge +
      'Connection: close\r\n\r\n'
    );
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

app.get('/api/status', requireApiAuth, (_req, res) => {
  res.json({ running: activeTest !== null });
});

app.post('/api/start', requireApiAuth, (req, res) => {
  if (activeTest) return res.status(409).json({ error: 'A test is already running.' });

  const { url, vus, duration, mode } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required.' });

  const browserMode = mode === 'browser';
  const vuCount = Math.max(1, parseInt(vus) || (browserMode ? 10 : 100));
  const dur = duration || (browserMode ? '90s' : '5m');
  const config = { url, vus: vuCount, duration: dur, mode: browserMode ? 'browser' : 'http' };

  const scriptFile = browserMode ? 'bolt-browser-test.js' : 'test.js';
  const envForK6 = { ...process.env };
  if (browserMode && envForK6.K6_BROWSER_HEADLESS === undefined) {
    envForK6.K6_BROWSER_HEADLESS = 'true';
  }

  const k6Args = browserMode
    ? [
        'run',
        '-e', `APP_URL=${url}`,
        '-e', `BROWSER_VUS=${vuCount}`,
        '-e', `BROWSER_DURATION=${dur}`,
        path.join(__dirname, scriptFile),
      ]
    : [
        'run',
        '-e', `BASE_URL=${url}`,
        '-e', `TOTAL_VUS=${vuCount}`,
        '-e', `TEST_DURATION=${dur}`,
        path.join(__dirname, scriptFile),
      ];

  const k6 = spawn(K6_BIN, k6Args, { cwd: __dirname, env: envForK6 });

  activeTest = { config, process: k6, startedAt: Date.now() };

  broadcast({ type: 'started', config });

  const forwardOutput = (chunk, isStderr) => {
    const text = chunk.toString();
    broadcast({ type: 'log', text, ts: Date.now(), stderr: isStderr });
  };

  k6.stdout.on('data', (d) => forwardOutput(d, false));
  k6.stderr.on('data', (d) => forwardOutput(d, true));

  k6.on('error', (err) => {
    broadcast({ type: 'error', message: `k6 failed to start: ${err.message}` });
    activeTest = null;
  });

  k6.on('close', (code) => {
    const elapsed = activeTest ? Date.now() - activeTest.startedAt : 0;
    activeTest = null;
    broadcast({ type: 'done', code, elapsed });
  });

  res.json({ ok: true, config });
});

app.post('/api/stop', requireApiAuth, (_req, res) => {
  if (!activeTest) return res.status(409).json({ error: 'No test is running.' });

  const proc = activeTest.process;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t']);
  } else {
    proc.kill('SIGINT');
  }

  broadcast({ type: 'stopped' });
  res.json({ ok: true });
});

server.listen(PORT, BIND_HOST, () => {
  if (AUTH_ENABLED) {
    console.log('Authentication: ENABLED');
    if (AUTH_USERNAME && AUTH_PASSWORD) console.log(' - Basic Auth username/password is active');
    if (APP_ACCESS_TOKEN) console.log(' - Bearer token authentication is active');
  } else {
    console.log('Authentication: DISABLED');
  }
  const displayHost = BIND_HOST === '0.0.0.0' ? 'localhost' : BIND_HOST;
  console.log(`K6 Load Tester running at http://${displayHost}:${PORT} (bind ${BIND_HOST})`);
});
