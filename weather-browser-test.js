import { browser } from 'k6/browser';
import { check, sleep } from 'k6';

/**
 * k6 browser script for identical Weather UIs (Netlify + Cloud Run).
 * Target URL via APP_URL (same app, different hosts).
 *
 * Example:
 *   k6 run -e APP_URL=https://bolt-sixth-testing.netlify.app/ weather-browser-test.js
 */

const APP_URL = __ENV.APP_URL || 'https://bolt-sixth-testing.netlify.app/';
const BROWSER_VUS = parseInt(__ENV.BROWSER_VUS || '10', 10);
const BROWSER_DURATION = __ENV.BROWSER_DURATION || '90s';

export const options = {
  scenarios: {
    ui_flow: {
      executor: 'constant-vus',
      vus: BROWSER_VUS,
      duration: BROWSER_DURATION,
      options: {
        browser: {
          type: 'chromium',
        },
      },
    },
  },
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

    for (let i = 0; i < 3; i++) {
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
  return {
    stdout: [
      '',
      '── Weather Browser Test Summary ───────────────',
      `  Iterations  : ${iters}`,
      `  Checks ✓    : ${passes}`,
      `  Checks ✗    : ${fails}`,
      '──────────────────────────────────────────────',
      '',
    ].join('\n'),
  };
}
