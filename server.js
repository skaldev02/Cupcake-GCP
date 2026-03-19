const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

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

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

let activeTest = null;

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({
    type: 'status',
    running: activeTest !== null,
    config: activeTest ? activeTest.config : null,
  }));
});

app.get('/api/status', (_req, res) => {
  res.json({ running: activeTest !== null });
});

app.post('/api/start', (req, res) => {
  if (activeTest) return res.status(409).json({ error: 'A test is already running.' });

  const { url, vus, duration } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required.' });

  const vuCount = Math.max(1, parseInt(vus) || 100);
  const dur = duration || '5m';
  const config = { url, vus: vuCount, duration: dur };

  const k6 = spawn(K6_BIN, [
    'run',
    '-e', `BASE_URL=${url}`,
    '-e', `TOTAL_VUS=${vuCount}`,
    '-e', `TEST_DURATION=${dur}`,
    path.join(__dirname, 'test.js'),
  ]);

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

app.post('/api/stop', (_req, res) => {
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`K6 Load Tester running at http://localhost:${PORT}`);
});
