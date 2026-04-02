(function () {
  const $ = (s) => document.getElementById(s);

  const BOLT_DEFAULT = 'https://bolt-fifth-testing.netlify.app/';
  const TOKEN_KEY = 'k6_tester_token';

  const ui = {
    authBar:    $('authTokenBar'),
    accessTok:  $('inputAccessToken'),
    saveToken:  $('btnSaveToken'),
    modeHttp:   $('modeHttp'),
    modeBrowser:$('modeBrowser'),
    modeHint:   $('modeHint'),
    url:        $('inputUrl'),
    vus:        $('inputVUs'),
    dur:        $('inputDuration'),
    start:      $('btnStart'),
    stop:       $('btnStop'),
    clear:      $('btnClear'),
    pill:       $('statusPill'),
    pillText:   $('statusText'),
    con:        $('console'),
    sVUs:       $('sVUs'),
    sReqs:      $('sReqs'),
    sReqsLbl:   $('sReqsLbl'),
    sTime:      $('sTime'),
  };

  let testMode = 'http';
  let running  = false;
  let serverAuth = { authEnabled: false, bearer: false, basic: false };
  let started  = null;
  let ticker   = null;
  let reqs     = 0;
  let lastVUs  = 0;
  let ws;

  function storedToken() {
    return (sessionStorage.getItem(TOKEN_KEY) || '').trim();
  }

  function authFetchHeaders(contentJson) {
    const h = {};
    if (contentJson) h['Content-Type'] = 'application/json';
    const t = storedToken();
    if (t) h.Authorization = `Bearer ${t}`;
    return h;
  }

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let base = `${proto}//${location.host}`;
    const t = storedToken();
    if (t) base += `?token=${encodeURIComponent(t)}`;
    return base;
  }

  /* ── WebSocket ── */
  function connect() {
    if (ws) {
      try { ws.onclose = null; } catch (_) {}
      try { ws.close(); } catch (_) {}
      ws = null;
    }
    ws = new WebSocket(wsUrl());
    ws.onopen    = () => log('Connected to server.', 'ok');
    ws.onclose   = () => {
      if (serverAuth.authEnabled && serverAuth.bearer && !storedToken()) {
        log('WebSocket needs an access token — paste it above and click Save.', 'err');
        return;
      }
      log('Connection lost. Reconnecting...', 'err');
      setTimeout(connect, 2000);
    };
    ws.onmessage = (e) => handle(JSON.parse(e.data));
  }

  function handle(msg) {
    switch (msg.type) {
      case 'status':
        setRunning(msg.running);
        break;

      case 'started':
        reqs = 0; lastVUs = 0;
        ui.sVUs.textContent  = '0';
        ui.sReqs.textContent = '0';
        clearConsole();
        {
          const m = msg.config.mode === 'browser' ? 'browser' : 'http';
          ui.sReqsLbl.textContent = m === 'browser' ? 'Iterations' : 'Requests';
          log(
            `Test started  mode: ${m}  URL: ${msg.config.url}  VUs: ${msg.config.vus}  Duration: ${msg.config.duration}`,
            'ok',
          );
        }
        started = Date.now();
        setRunning(true);
        startTicker();
        break;

      case 'log':
        appendRaw(msg.text);
        parseStats(msg.text);
        break;

      case 'done':
        stopTicker();
        log(`Test finished  exit code: ${msg.code}  total time: ${fmtMs(msg.elapsed)}`, msg.code === 0 ? 'ok' : 'err');
        setRunning(false);
        break;

      case 'stopped':
        stopTicker();
        log('Test stopped by user.', 'err');
        setRunning(false);
        break;

      case 'error':
        log(`ERROR: ${msg.message}`, 'err');
        setRunning(false);
        break;
    }
  }

  /* ── k6 output parsing ── */
  function parseStats(text) {
    // k6 progress lines: "running (1m30.5s), 050/100 VUs, 423 complete and 0 interrupted iterations"
    const vu = text.match(/(\d+)\/\d+ VUs/);
    if (vu) { lastVUs = parseInt(vu[1]); ui.sVUs.textContent = lastVUs; }

    const iter = text.match(/(\d+) complete/);
    if (iter) { reqs = parseInt(iter[1]); ui.sReqs.textContent = reqs.toLocaleString(); }

    // k6 final summary: "http_reqs....: 1234"
    const httpReqs = text.match(/http_reqs[\s.]*:\s*(\d+)/);
    if (httpReqs) { reqs = parseInt(httpReqs[1]); ui.sReqs.textContent = reqs.toLocaleString(); }
  }

  /* ── elapsed timer ── */
  function startTicker() {
    stopTicker();
    ticker = setInterval(() => {
      if (!started) return;
      ui.sTime.textContent = fmtMs(Date.now() - started);
    }, 500);
  }
  function stopTicker() { clearInterval(ticker); ticker = null; }

  function fmtMs(ms) {
    const s = Math.floor(ms / 1000);
    return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
  }

  /* ── console helpers ── */
  function clearConsole() {
    ui.con.innerHTML = '';
  }

  function log(text, cls) {
    const el = document.createElement('div');
    el.className = 'log-line' + (cls ? ` ${cls}` : '');
    const t = new Date().toLocaleTimeString();
    el.innerHTML = `<span class="ts">[${t}]</span>${esc(text)}`;
    ui.con.appendChild(el);
    ui.con.scrollTop = ui.con.scrollHeight;
  }

  function appendRaw(text) {
    const empty = ui.con.querySelector('.console-empty');
    if (empty) empty.remove();

    const lines = text.split('\n');
    for (const ln of lines) {
      if (!ln.trim()) continue;
      const el = document.createElement('div');
      el.className = 'log-line';
      el.textContent = ln;
      ui.con.appendChild(el);
    }
    ui.con.scrollTop = ui.con.scrollHeight;
  }

  function esc(t) { const d = document.createElement('span'); d.textContent = t; return d.innerHTML; }

  /* ── state ── */
  function setRunning(v) {
    running = v;
    ui.start.disabled = v;
    ui.stop.disabled  = !v;
    ui.url.disabled   = v;
    ui.vus.disabled   = v;
    ui.dur.disabled   = v;
    ui.modeHttp.disabled = v;
    ui.modeBrowser.disabled = v;
    ui.pill.classList.toggle('running', v);
    ui.pillText.textContent = v ? 'Running' : 'Idle';
  }

  function applyModeUI() {
    const browser = testMode === 'browser';
    ui.modeHttp.classList.toggle('active', !browser);
    ui.modeBrowser.classList.toggle('active', browser);
    ui.modeHint.textContent = browser
      ? 'Chromium drives the Bolt app: connection check, single test, load test, and verifies a perplexity-logs API call. Requires k6 with the browser module.'
      : 'GET requests to a base URL with staged ramp-up.';
    ui.sReqsLbl.textContent = browser ? 'Iterations' : 'Requests';
    ui.url.placeholder = browser ? BOLT_DEFAULT : 'https://example.com';
  }

  function switchMode(next) {
    if (running || next === testMode) return;
    const prev = testMode;
    testMode = next;
    if (next === 'browser') {
      const u = ui.url.value.trim();
      if (!u || u === 'https://example.com') ui.url.value = BOLT_DEFAULT;
      if (prev === 'http' && parseInt(ui.vus.value, 10) === 100) ui.vus.value = '10';
      if (prev === 'http' && ui.dur.value === '5m') ui.dur.value = '90s';
    } else {
      if (ui.url.value.trim() === BOLT_DEFAULT) ui.url.value = '';
      if (prev === 'browser' && parseInt(ui.vus.value, 10) === 10) ui.vus.value = '100';
      if (prev === 'browser' && ui.dur.value === '90s') ui.dur.value = '5m';
    }
    applyModeUI();
  }

  ui.modeHttp.onclick = () => switchMode('http');
  ui.modeBrowser.onclick = () => switchMode('browser');

  /* ── actions ── */
  ui.start.onclick = async () => {
    const url = ui.url.value.trim();
    if (!url) { log('Enter a target URL.', 'err'); ui.url.focus(); return; }
    try { new URL(url); } catch { log('Invalid URL format.', 'err'); ui.url.focus(); return; }

    ui.start.disabled = true;
    const defaultVus = testMode === 'browser' ? 10 : 100;
    const body = {
      url,
      vus: parseInt(ui.vus.value, 10) || defaultVus,
      duration: ui.dur.value,
      mode: testMode === 'browser' ? 'browser' : 'http',
    };
    try {
      const res = await fetch('/api/start', {
        method: 'POST',
        headers: authFetchHeaders(true),
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
    } catch (e) {
      log(`Failed to start: ${e.message}`, 'err');
      ui.start.disabled = false;
    }
  };

  ui.stop.onclick = async () => {
    ui.stop.disabled = true;
    try {
      const res = await fetch('/api/stop', { method: 'POST', headers: authFetchHeaders(false) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
    } catch (e) {
      log(`Failed to stop: ${e.message}`, 'err');
      ui.stop.disabled = false;
    }
  };

  ui.clear.onclick = () => {
    clearConsole();
    reqs = 0; lastVUs = 0;
    ui.sVUs.textContent = '0'; ui.sReqs.textContent = '0'; ui.sTime.textContent = '0s';
  };

  ui.saveToken.onclick = () => {
    sessionStorage.setItem(TOKEN_KEY, ui.accessTok.value.trim());
    log('Access token saved.', 'ok');
    connect();
    fetch('/api/status', { headers: authFetchHeaders(false) })
      .then((r) => {
        if (r.status === 401) {
          log('Unauthorized — paste the server access token and click Save.', 'err');
          throw new Error('401');
        }
        return r.json();
      })
      .then((d) => setRunning(d.running))
      .catch(() => {});
  };

  async function boot() {
    applyModeUI();
    try {
      const cfg = await fetch('/api/auth/config').then((r) => r.json());
      serverAuth = {
        authEnabled: Boolean(cfg.authEnabled),
        bearer: Boolean(cfg.bearer),
        basic: Boolean(cfg.basic),
      };
      if (cfg.authEnabled && cfg.bearer) {
        ui.authBar.classList.remove('hidden');
        ui.accessTok.value = storedToken();
      } else {
        ui.authBar.classList.add('hidden');
      }
      if (cfg.authEnabled && cfg.basic && !cfg.bearer) {
        log(
          'Server uses HTTP Basic auth only; this app does not collect a password. Use APP_ACCESS_TOKEN in .env and paste the token above after redeploy, or call the API with Basic Auth.',
          'err',
        );
      }
    } catch (_) {
      ui.authBar.classList.add('hidden');
    }
    connect();
    fetch('/api/status', { headers: authFetchHeaders(false) })
      .then((r) => {
        if (r.status === 401) {
          log('Unauthorized — paste the server access token and click Save.', 'err');
          throw new Error('401');
        }
        return r.json();
      })
      .then((d) => setRunning(d.running))
      .catch(() => {});
  }

  boot();
})();
