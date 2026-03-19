/**
 * k6 load test – Railway (4 regions/replicas), 50,000 total VUs.
 *
 * Goal:
 * - Simulate 50,000 concurrent users hitting the site.
 * - Distribute load evenly across 4 replicas (~12,500 per replica).
 *
 * Why replica awareness matters:
 * - Without it: each replica runs full 50k → total 200k users.
 * - That causes OOM, connection exhaustion, and unrealistic load.
 *
 * Environment Variables (Railway):
 * BASE_URL=https://startling-cheesecake-58af04.netlify.app
 * K6_REPLICA_COUNT=4
 * K6_REPLICA_INDEX=0 (0,1,2,3)
 * K6_LOG_EVERY_ITER=500
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const BASE_URL = __ENV.BASE_URL || 'http://35.190.58.193';

const REPLICA_COUNT = parseInt(__ENV.K6_REPLICA_COUNT || '1', 10);
const REPLICA_INDEX = parseInt(__ENV.K6_REPLICA_INDEX || '0', 10);

/**
 * TARGET LOAD
 */
const TOTAL_TARGET_VUS = 50000;
const perReplica = Math.max(1, Math.ceil(TOTAL_TARGET_VUS / REPLICA_COUNT));

export function setup() {
  console.log(
    `[K6] Script started | BASE_URL=${BASE_URL} | replica ${REPLICA_INDEX + 1}/${REPLICA_COUNT} | target VUs per replica=${perReplica}`
  );
  return {};
}

const PAGES = ['/'];

/**
 * Load pattern for TOTAL traffic
 */
const baseStages = [
  { duration: '3m', target: 5000 },
  { duration: '5m', target: 15000 },
  { duration: '5m', target: 30000 },
  { duration: '5m', target: 40000 },
  { duration: '10m', target: 50000 },
  { duration: '10m', target: 50000 },
  { duration: '5m', target: 30000 },
  { duration: '3m', target: 10000 },
  { duration: '3m', target: 0 },
];

/**
 * Scale stages for replicas
 */
const scaledStages =
  REPLICA_COUNT > 1
    ? baseStages.map((s) => ({
        duration: s.duration,
        target:
          s.target === 0
            ? 0
            : Math.max(
                1,
                Math.min(
                  perReplica,
                  Math.ceil((s.target / TOTAL_TARGET_VUS) * perReplica)
                )
              ),
      }))
    : baseStages;

export const options = {
  stages: scaledStages,
  thresholds: {
    http_req_duration: ['p(95)<8000'],
    http_req_failed: ['rate<0.05'],
    checks: ['rate>0.90'],
  },
};

/**
 * Random browsers
 */
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Safari/605.1.15',
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/**
 * Logging control
 */
const LOG_EVERY_ITER = parseInt(__ENV.K6_LOG_EVERY_ITER || '500', 10);

function safeDurationMs(response) {
  const t = response.timings;
  return t && typeof t.duration === 'number' ? t.duration : 0;
}

export default function () {
  const page = PAGES[Math.floor(Math.random() * PAGES.length)];
  const url = `${BASE_URL}${page}`;

  const shouldLogStart = __ITER % LOG_EVERY_ITER === 0;
  if (shouldLogStart) console.log(`[VU ${__VU}] REQUEST START | URL=${url}`);

  const response = http.get(url, {
    headers: {
      'User-Agent': getRandomUserAgent(),
      Accept: 'text/html,*/*',
    },
    timeout: '30s',
  });

  const statusOk = response.status === 200 || response.status === 304;
  const hasContent = response.body && response.body.length > 0;
  const checkPassed = statusOk && hasContent;

  check(response, {
    'status OK': (r) => statusOk,
    'has content': (r) => hasContent,
  });

  const durationMs = safeDurationMs(response);
  const bodyLen = response.body ? response.body.length : 0;

  const shouldLogComplete = shouldLogStart || !checkPassed;

  if (shouldLogComplete) {
    console.log(
      `[VU ${__VU}] REQUEST COMPLETE | URL=${url} | status=${response.status} | duration=${durationMs}ms | body_length=${bodyLen} | check=${checkPassed ? 'PASS' : 'FAIL'}`
    );
  }

  sleep(3 + Math.random() * 2);
};
