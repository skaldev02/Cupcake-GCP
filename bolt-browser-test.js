import { browser } from 'k6/browser';
import { check, sleep } from 'k6';


const APP_URL = __ENV.APP_URL || 'https://bolt-fifth-testing.netlify.app/';
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
    let backendCallDetected = false;

    page.on('response', (res) => {
      if (
        res.url().includes('perplexity-logs') &&
        res.status() >= 200 &&
        res.status() < 300
      ) {
        backendCallDetected = true;
      }
    });

    await page.goto(APP_URL, { waitUntil: 'networkidle' });

    sleep(3);

    const checkBtn = page.getByRole('button', {
      name: 'Check connection',
    });

    await checkBtn.waitFor({ state: 'visible', timeout: 10000 });
    await checkBtn.click();

    sleep(3);

    const promptInput = page.getByPlaceholder(
      'Reply with one short friendly sentence.',
    );

    await promptInput.waitFor({ state: 'visible', timeout: 10000 });

    await promptInput.fill('Hello! This is a load test message.');

    const singleTestBtn = page.getByRole('button', {
      name: 'Run single test',
    });

    await singleTestBtn.click();

    sleep(5);

    const startLoadBtn = page.getByRole('button', {
      name: 'Start load test',
    });

    await startLoadBtn.waitFor({ state: 'visible', timeout: 10000 });
    await startLoadBtn.click();

    const start = Date.now();
    while (!backendCallDetected && Date.now() - start < 20000) {
      sleep(0.5);
    }

    check(backendCallDetected, {
      'Backend API triggered': (v) => v === true,
    });

    sleep(10);
  } finally {
    await page.close();
  }
}

// k6 browser module has a known bug where the default summary generator
// hangs for up to 120 s after browser tests. A custom export that returns
// immediately is the recommended workaround.
export function handleSummary(data) {
  const checks  = data.metrics.checks;
  const passes  = checks ? checks.values.passes : 0;
  const fails   = checks ? checks.values.fails   : 0;
  const iters   = data.metrics.iterations ? data.metrics.iterations.values.count : 0;
  return {
    stdout: [
      '',
      '── Browser Test Summary ──────────────────────',
      `  Iterations  : ${iters}`,
      `  Checks ✓    : ${passes}`,
      `  Checks ✗    : ${fails}`,
      '──────────────────────────────────────────────',
      '',
    ].join('\n'),
  };
};