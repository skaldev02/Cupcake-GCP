import { browser } from 'k6/browser';
import { check, sleep } from 'k6';

/**
 * k6 browser script for identical Weather UIs (Netlify + Cloud Run).
 * Target URL via APP_URL (same app, different hosts).
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
 *
 * Example:
 *   k6 run -e APP_URL=https://bolt-sixth-testing.netlify.app/ weather-browser-test.js
 */

const APP_URL = __ENV.APP_URL || 'https://bolt-sixth-testing.netlify.app/';
const BROWSER_VUS = parseInt(__ENV.BROWSER_VUS || '10', 10);
const BROWSER_DURATION = __ENV.BROWSER_DURATION || '90s';
const BROWSER_EXECUTOR = String(__ENV.BROWSER_EXECUTOR || 'ramping').toLowerCase().trim();
const BROWSER_RAMP_UP = (__ENV.BROWSER_RAMP_UP || '').trim();

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

export default async function () {
  const page = await browser.newPage();

  try {
    let weatherApiCalled = false;

    page.on('response', (res) => {
      if (
        res.url().toLowerCase().includes('weather') &&
        res.status() >= 200 &&
        res.status() < 300
      ) {
        weatherApiCalled = true;
      }
    });

    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 60000 });

    sleep(2);

    const weatherBtn = page.getByRole('button', {
      name: /get random city weather/i,
    });

    await weatherBtn.waitFor({ state: 'visible', timeout: 10000 });

    for (let i = 0; i < 100; i++) {
      await weatherBtn.click();
      sleep(2);
    }

    const start = Date.now();
    while (!weatherApiCalled && Date.now() - start < 15000) {
      sleep(0.5);
    }

    check(weatherApiCalled, {
      'Weather API triggered': (v) => v === true,
    });

    sleep(3);
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
