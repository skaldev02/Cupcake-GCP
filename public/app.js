(function () {
  const $ = (s) => document.getElementById(s);

  const BOLT_DEFAULT = 'https://bolt-fifth-testing.netlify.app/';
  const WEATHER_DEFAULT = 'https://bolt-sixth-testing.netlify.app/';
  const WEATHER_PRESETS = [
    'https://bolt-sixth-testing.netlify.app/',
    'https://weather-app-us-28149829298.us-central1.run.app',
    'https://weather-app-ca-28149829298.northamerica-northeast2.run.app',
  ];
  const TOKEN_KEY = 'k6_tester_token';

  /** Must stay in sync with server.js scriptByScenario */
  const K6_SCRIPT_LABEL = {
    http: 'test.js',
    bolt: 'bolt-browser-test.js',
    weather: 'weather-browser-test.js',
    custom: '(K6_CUSTOM_BROWSER_SCRIPT on server)',
  };

  const ui = {
    authBar: $('authTokenBar'),
    accessTok: $('inputAccessToken'),
    saveToken: $('btnSaveToken'),
    modeCustomWrap: $('modeCustomWrap'),
    scriptName: $('scriptName'),
    urlPresets: $('urlPresets'),
    url: $('inputUrl'),
    vus: $('inputVUs'),
    dur: $('inputDuration'),
    start: $('btnStart'),
    stop: $('btnStop'),
    clear: $('btnClear'),
    pill: $('statusPill'),
    pillText: $('statusText'),
    con: $('console'),
    sVUs: $('sVUs'),
    sReqs: $('sReqs'),
    sReqsLbl: $('sReqsLbl'),
    sTime: $('sTime'),
  };

  let scenario = 'http';
  let customBrowserEnabled = false;
  let running = false;
  let serverAuth = { authEnabled: false, bearer: false, basic: false };
  let started = null;
  let ticker = null;
  let reqs = 0;
  let lastVUs = 0;
  let ws;

  function scenarioRadios() {
    return document.querySelectorAll('input[name="scenario"]');
  }

  /** Native radio group — only one checked; this is what we POST. */
  function getCheckedScenario() {
    const el = document.querySelector('input[name="scenario"]:checked');
    const s = el && el.value ? String(el.value).toLowerCase().trim() : 'http';
    return ['http', 'bolt', 'weather', 'custom'].includes(s) ? s : 'http';
  }

  function isBrowser(s) {
    return s !== 'http';
  }

  function normalizeUrl(u) {
    return (u || '').trim().replace(/\/$/, '');
  }

  function isBoltDefaultUrl() {
    return normalizeUrl(ui.url.value) === normalizeUrl(BOLT_DEFAULT);
  }

  function isWeatherPresetUrl() {
    const u = normalizeUrl(ui.url.value);
    return (
      u === normalizeUrl(WEATHER_DEFAULT) ||
      WEATHER_PRESETS.some((p) => u === normalizeUrl(p))
    );
  }

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

  function fillUrlPresets() {
    ui.urlPresets.innerHTML = '';
    const seen = new Set();
    [BOLT_DEFAULT, WEATHER_DEFAULT, ...WEATHER_PRESETS].forEach((u) => {
      const v = u.trim();
      const key = normalizeUrl(v).toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      const opt = document.createElement('option');
      opt.value = v;
      ui.urlPresets.appendChild(opt);
    });
  }

  /* ── WebSocket ── */
  function connect() {
    if (ws) {
      try { ws.onclose = null; } catch (_) {}
      try { ws.close(); } catch (_) {}
      ws = null;
    }
    ws = new WebSocket(wsUrl());
    ws.onopen = () => log('Connected to server.', 'ok');
    ws.onclose = () => {
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
        ui.sVUs.textContent = '0';
        ui.sReqs.textContent = '0';
        clearConsole();
        {
          const sc = msg.config.scenario || 'http';
          ui.sReqsLbl.textContent = isBrowser(sc) ? 'Iterations' : 'Requests';
          const script = msg.config.script ? `  k6: ${msg.config.script}` : '';
          log(
            `Test started  scenario: ${sc}${script}  URL: ${msg.config.url}  VUs: ${msg.config.vus}  Duration: ${msg.config.duration}`,
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
    const vu = text.match(/(\d+)\/\d+ VUs/);
    if (vu) { lastVUs = parseInt(vu[1]); ui.sVUs.textContent = lastVUs; }

    const iter = text.match(/(\d+) complete/);
    if (iter) { reqs = parseInt(iter[1]); ui.sReqs.textContent = reqs.toLocaleString(); }

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
    ui.stop.disabled = !v;
    ui.url.disabled = v;
    ui.vus.disabled = v;
    ui.dur.disabled = v;
    for (const r of scenarioRadios()) {
      r.disabled = v;
    }
    ui.pill.classList.toggle('running', v);
    ui.pillText.textContent = v ? 'Running' : 'Idle';
  }

  function applyModeUI() {
    for (const r of scenarioRadios()) {
      r.checked = r.value === scenario;
    }

    const hints = {};
    if (ui.modeHint) ui.modeHint.textContent = '';

    if (ui.scriptName) {
      ui.scriptName.textContent = K6_SCRIPT_LABEL[scenario] || K6_SCRIPT_LABEL.http;
    }

    ui.sReqsLbl.textContent = isBrowser(scenario) ? 'Iterations' : 'Requests';

    if (scenario === 'http') {
      ui.url.placeholder = 'https://example.com';
    } else if (scenario === 'bolt') {
      ui.url.placeholder = BOLT_DEFAULT;
    } else if (scenario === 'weather') {
      ui.url.placeholder = WEATHER_DEFAULT;
    } else {
      ui.url.placeholder = 'https://your-app.example.com/';
    }
  }

  function switchScenario(next) {
    if (running || next === scenario) return;
    if (next === 'custom' && (!customBrowserEnabled || ui.modeCustomWrap.classList.contains('hidden'))) {
      return;
    }

    const prev = scenario;
    scenario = next;

    const u = ui.url.value.trim();
    const looksEmpty = !u || u === 'https://example.com';

    if (scenario === 'bolt') {
      if (looksEmpty || isWeatherPresetUrl()) ui.url.value = BOLT_DEFAULT;
      if (prev === 'http' && parseInt(ui.vus.value, 10) === 100) ui.vus.value = '10';
      if (prev === 'http' && ui.dur.value === '5m') ui.dur.value = '90s';
    } else if (scenario === 'weather') {
      if (looksEmpty || isBoltDefaultUrl()) ui.url.value = WEATHER_DEFAULT;
      if (prev === 'http' && parseInt(ui.vus.value, 10) === 100) ui.vus.value = '10';
      if (prev === 'http' && ui.dur.value === '5m') ui.dur.value = '90s';
    } else if (scenario === 'custom') {
      if (prev === 'http' && parseInt(ui.vus.value, 10) === 100) ui.vus.value = '10';
      if (prev === 'http' && ui.dur.value === '5m') ui.dur.value = '90s';
    } else {
      /* http */
      if (isBoltDefaultUrl() || isWeatherPresetUrl()) ui.url.value = '';
      if ((prev === 'bolt' || prev === 'weather' || prev === 'custom') && parseInt(ui.vus.value, 10) === 10) {
        ui.vus.value = '100';
      }
      if ((prev === 'bolt' || prev === 'weather' || prev === 'custom') && ui.dur.value === '90s') {
        ui.dur.value = '5m';
      }
    }

    applyModeUI();
  }

  const modeToggleEl = document.querySelector('.mode-toggle');
  if (modeToggleEl) {
    modeToggleEl.addEventListener('change', (e) => {
      const t = e.target;
      if (!(t instanceof HTMLInputElement) || t.name !== 'scenario' || !t.checked) return;
      const next = String(t.value || '').toLowerCase();
      if (next === scenario) return;
      switchScenario(next);
    });
  }

  /* ── actions ── */
  ui.start.onclick = async () => {
    const runScenario = getCheckedScenario();
    scenario = runScenario;
    applyModeUI();

    const url = ui.url.value.trim();
    if (!url) { log('Enter a target URL.', 'err'); ui.url.focus(); return; }
    try { new URL(url); } catch { log('Invalid URL format.', 'err'); ui.url.focus(); return; }

    ui.start.disabled = true;
    const defaultVus = isBrowser(runScenario) ? 10 : 100;
    const body = {
      url,
      vus: parseInt(ui.vus.value, 10) || defaultVus,
      duration: ui.dur.value,
      scenario: runScenario,
      mode: isBrowser(runScenario) ? 'browser' : 'http',
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
    fillUrlPresets();
    try {
      const cfg = await fetch('/api/auth/config').then((r) => r.json());
      serverAuth = {
        authEnabled: Boolean(cfg.authEnabled),
        bearer: Boolean(cfg.bearer),
        basic: Boolean(cfg.basic),
      };
      customBrowserEnabled = Boolean(cfg.customBrowserEnabled);
      ui.modeCustomWrap.classList.toggle('hidden', !customBrowserEnabled);
      if (scenario === 'custom' && !customBrowserEnabled) {
        scenario = 'http';
      }

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
      ui.modeCustomWrap.classList.add('hidden');
    }
    applyModeUI();
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
