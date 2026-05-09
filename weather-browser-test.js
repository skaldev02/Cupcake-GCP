import { browser } from 'k6/browser';
import { check } from 'k6';

/**
 * k6 browser script aligned with ../weather (Vite app: mount fetch + Supabase log).
 * Target URL via APP_URL (Netlify, Cloud Run, ngrok, etc.).
 *
 * Load shape (browser-heavy):
 * - Default: ramping-vus — raises VUs gradually, then holds (avoids starting all
 *   browsers at once, which is slow and hard on CPU/RAM).
 * - Legacy: BROWSER_EXECUTOR=constant — original constant-vus behavior.
 *
 * Env:
 *   BROWSER_EXECUTOR   ramping | constant   (default: ramping)
 *   BROWSER_RAMP_UP    e.g. 30s, 1m         (default: min(30s, ~⅓ of total duration))
 *   BROWSER_DURATION   total scenario time   (e.g. 90s)
 *   BROWSER_VUS        peak / target VUs
 *   DEBUG_WEATHER_BROWSER  1 | true — log page console, errors, failed requests
 *     (use when Supabase writes fail under k6 but work in a normal browser).
 *   BROWSER_GOTO_TIMEOUT_MS  navigation timeout (default: 120000). Use higher on ngrok.
 *   BROWSER_WAIT_UNTIL       load | domcontentloaded | networkidle (default: load).
 *     Avoid networkidle for this app: it fetches Open-Meteo + Supabase on mount and
 *     may never go idle before the navigation timeout.
 *   BROWSER_BUTTON_READY_MS  max wait for the main button to become enabled (default: 180000).
 *
 * Do not use k6 sleep() inside this async browser flow — it blocks the event loop and
 * the UI can stay stuck on “Loading...”. Waits use page.waitForTimeout() instead.
 *
 * Each iteration clicks “Get random city weather” exactly 100 times (2 s pause
 * after each click). Raise BROWSER_DURATION / server duration so the scenario
 * can outlive one iteration.
 *
 * Example:
 *   k6 run -e APP_URL=https://kimberly-fossillike-harmoniously.ngrok-free.dev/ weather-browser-test.js
 *   k6 run -e APP_URL=https://bolt-sixth-testing.netlify.app/ weather-browser-test.js
 */

const APP_URL =
  __ENV.APP_URL || 'https://kimberly-fossillike-harmoniously.ngrok-free.dev/';
const BROWSER_VUS = parseInt(__ENV.BROWSER_VUS || '10', 10);
const BROWSER_DURATION = __ENV.BROWSER_DURATION || '90s';
const BROWSER_EXECUTOR = String(__ENV.BROWSER_EXECUTOR || 'ramping').toLowerCase().trim();
const BROWSER_RAMP_UP = (__ENV.BROWSER_RAMP_UP || '').trim();
const DEBUG_WEATHER_BROWSER = ['1', 'true', 'yes'].includes(
  String(__ENV.DEBUG_WEATHER_BROWSER || '').toLowerCase().trim(),
);
const BROWSER_GOTO_TIMEOUT_MS = Math.min(
  600000,
  Math.max(10000, parseInt(__ENV.BROWSER_GOTO_TIMEOUT_MS || '120000', 10)),
);
const BROWSER_WAIT_UNTIL = String(__ENV.BROWSER_WAIT_UNTIL || 'load')
  .toLowerCase()
  .trim();
const GOTO_WAIT_UNTIL =
  BROWSER_WAIT_UNTIL === 'domcontentloaded' || BROWSER_WAIT_UNTIL === 'networkidle'
    ? BROWSER_WAIT_UNTIL
    : 'load';
const BROWSER_BUTTON_READY_MS = Math.min(
  600000,
  Math.max(30000, parseInt(__ENV.BROWSER_BUTTON_READY_MS || '180000', 10)),
);

function appHostIsNgrok(url) {
  try {
    return new URL(url).hostname.toLowerCase().includes('ngrok');
  } catch {
    return false;
  }
}

/** Open-Meteo uses /forecast (no “weather” in URL); keep legacy + Supabase signals. */
function responseIndicatesWeatherPipeline(url, status) {
  if (status < 200 || status >= 300) return false;
  const u = url.toLowerCase();
  if (u.includes('open-meteo.com') && u.includes('forecast')) return true;
  if (u.includes('weather')) return true;
  if (u.includes('supabase') && (u.includes('/rest/v1') || u.includes('weather_logs')))
    return true;
  return false;
}

/** Fixed load: 100 UI clicks per VU iteration. */
const WEATHER_BUTTON_CLICKS = 100;
const WEATHER_CLICK_PAUSE_SEC = 2;

function parseK6DurationSeconds(s) {
  const m = String(s || '').match(/^(\d+)(s|m|h)$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const u = m[2].toLowerCase();
  if (u === 'h') return n * 3600;
  if (u === 'm') return n * 60;
  return n;
}

function secondsLabel(sec) {
  const s = Math.max(1, Math.floor(sec));
  return `${s}s`;
}

/** Ramp stage duration + hold at target; total duration ≈ sum of stages. */
function buildRampStages(vus, totalDurStr, rampDurStr) {
  const total = parseK6DurationSeconds(totalDurStr) ?? 90;
  const parsedRamp = rampDurStr ? parseK6DurationSeconds(rampDurStr) : null;
  let ramp =
    parsedRamp != null
      ? parsedRamp
      : Math.min(30, Math.max(5, Math.floor(total / 3)));
  const maxRamp = Math.max(5, total - 5);
  ramp = Math.min(ramp, maxRamp);
  const hold = Math.max(1, total - ramp);
  return [
    { duration: secondsLabel(ramp), target: vus },
    { duration: secondsLabel(hold), target: vus },
  ];
}

const browserScenarioOpts = {
  browser: {
    type: 'chromium',
  },
};

/** Let in-flight browser iterations finish when a stage or test ends. */
const gracefulStop = '120s';

const scenarios =
  BROWSER_EXECUTOR === 'constant'
    ? {
        ui_flow: {
          executor: 'constant-vus',
          vus: BROWSER_VUS,
          duration: BROWSER_DURATION,
          gracefulStop,
          options: browserScenarioOpts,
        },
      }
    : {
        ui_flow: {
          executor: 'ramping-vus',
          startVUs: 0,
          stages: buildRampStages(BROWSER_VUS, BROWSER_DURATION, BROWSER_RAMP_UP),
          gracefulStop,
          gracefulRampDown: '60s',
          options: browserScenarioOpts,
        },
      };

export const options = {
  scenarios,
  thresholds: {
    checks: ['rate==1.0'],
  },
};

/**
 * ../weather App.tsx: first paint runs useEffect → fetch; button shows "Loading..."
 * and is disabled until the request finishes.
 */
async function waitForWeatherButtonReady(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await page.evaluate(() => {
      function visible(el) {
        return !!(
          el &&
          el.offsetParent !== null &&
          typeof el.getClientRects === 'function' &&
          el.getClientRects().length > 0
        );
      }
      const t = document.querySelector('[data-testid="weather-refresh-button"]');
      if (t && !t.disabled && visible(t)) return true;
      for (const b of document.querySelectorAll('button')) {
        const txt = (b.innerText || b.textContent || '')
          .replace(/\s+/g, ' ')
          .trim();
        if (!b.disabled && visible(b) && /get random city weather/i.test(txt)) {
          return true;
        }
      }
      return false;
    });
    if (ok) return;
    await page.waitForTimeout(200);
  }
  let snapshot = null;
  try {
    snapshot = await page.evaluate(() => ({
      title: document.title,
      href: location.href,
      hasTestBtn: !!document.querySelector('[data-testid="weather-refresh-button"]'),
      buttons: [...document.querySelectorAll('button')].slice(0, 8).map((b) => ({
        disabled: b.disabled,
        text: (b.innerText || b.textContent || '').slice(0, 140),
      })),
    }));
  } catch {
    snapshot = { error: 'page closed or unreachable' };
  }
  console.error(`[weather-browser] Button-ready timeout. Snapshot: ${JSON.stringify(snapshot)}`);
  throw new Error(
    'Weather button did not become clickable — see stderr snapshot (ngrok interstitial, wrong host, or fetch never finishing).',
  );
}

/** ngrok free HTML often shows “Visit Site”; header alone is not always enough. */
async function tryDismissHostedInterstitial(page) {
  for (let i = 0; i < 4; i++) {
    const clicked = await page.evaluate(() => {
      const body = document.body;
      if (!body) return false;
      const blob = (body.innerText || body.textContent || '').toLowerCase();
      if (!blob.includes('ngrok') && !blob.includes('you are about to visit')) {
        return false;
      }
      const nodes = [...document.querySelectorAll('a, button')];
      for (const el of nodes) {
        const t = (el.textContent || '').trim();
        if (/^visit site$/i.test(t) || /^continue$/i.test(t)) {
          el.click();
          return true;
        }
      }
      return false;
    });
    if (clicked) {
      await page.waitForTimeout(2500);
      return;
    }
    await page.waitForTimeout(400);
  }
}

async function resolveWeatherButton(page) {
  const hasTestId = await page.evaluate(
    () => !!document.querySelector('[data-testid="weather-refresh-button"]'),
  );
  if (hasTestId) {
    return page.locator('[data-testid="weather-refresh-button"]');
  }
  return page.getByRole('button', { name: /get random city weather/i });
}

export default async function () {
  const page = await browser.newPage();

  try {
    let weatherApiCalled = false;

    if (DEBUG_WEATHER_BROWSER) {
      page.on('console', (msg) => {
        console.log(`[weather-browser] console.${msg.type()}: ${msg.text()}`);
      });
      page.on('pageerror', (err) => {
        console.log(`[weather-browser] pageerror: ${String(err)}`);
      });
      page.on('requestfailed', (req) => {
        const f = req.failure();
        console.log(
          `[weather-browser] requestfailed: ${req.url()} — ${f ? f.errorText : 'unknown'}`,
        );
      });
    }

    page.on('response', (res) => {
      const u = res.url();
      const st = res.status();
      if (responseIndicatesWeatherPipeline(u, st)) {
        weatherApiCalled = true;
      }
      if (DEBUG_WEATHER_BROWSER) {
        const low = u.toLowerCase();
        if ((low.includes('supabase') || low.includes('/rest/v1')) && st >= 400) {
          console.log(`[weather-browser] HTTP ${st} ${u}`);
        }
      }
    });

    if (appHostIsNgrok(APP_URL)) {
      await page.setExtraHTTPHeaders({
        'ngrok-skip-browser-warning': 'true',
      });
    }

    await page.goto(APP_URL, {
      waitUntil: GOTO_WAIT_UNTIL,
      timeout: BROWSER_GOTO_TIMEOUT_MS,
    });

    await page.waitForTimeout(500);
    await tryDismissHostedInterstitial(page);

    await waitForWeatherButtonReady(page, BROWSER_BUTTON_READY_MS);
    const weatherBtn = await resolveWeatherButton(page);
    await weatherBtn.waitFor({ state: 'visible', timeout: 15000 });

    for (let i = 0; i < WEATHER_BUTTON_CLICKS; i++) {
      await waitForWeatherButtonReady(page, BROWSER_BUTTON_READY_MS);
      await weatherBtn.click();
      await page.waitForTimeout(WEATHER_CLICK_PAUSE_SEC * 1000);
    }

    const start = Date.now();
    while (!weatherApiCalled && Date.now() - start < 15000) {
      await page.waitForTimeout(500);
    }

    check(weatherApiCalled, {
      'Weather API triggered': (v) => v === true,
    });

    await page.waitForTimeout(3000);
  } finally {
    await page.close();
  }
}

export function handleSummary(data) {
  const checks = data.metrics.checks;
  const passes = checks ? checks.values.passes : 0;
  const fails = checks ? checks.values.fails : 0;
  const iters = data.metrics.iterations ? data.metrics.iterations.values.count : 0;
  const shape =
    BROWSER_EXECUTOR === 'constant'
      ? `constant-vus  ${BROWSER_VUS} VUs × ${BROWSER_DURATION}`
      : `ramping-vus → ${BROWSER_VUS} VUs  (${BROWSER_DURATION} total${
          BROWSER_RAMP_UP ? `, ramp ${BROWSER_RAMP_UP}` : ', auto ramp'
        })`;
  return {
    stdout: [
      '',
      '── Weather Browser Test Summary ───────────────',
      `  Load shape  : ${shape}`,
      `  Iterations  : ${iters}`,
      `  Checks ✓    : ${passes}`,
      `  Checks ✗    : ${fails}`,
      '──────────────────────────────────────────────',
      '',
    ].join('\n'),
  };
}
