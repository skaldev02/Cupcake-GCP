import http from 'k6/http';
import { check, sleep } from 'k6';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const BASE_URL  = __ENV.BASE_URL  || 'http://localhost';
const TOTAL_VUS = parseInt(__ENV.TOTAL_VUS || '100', 10);
const DURATION  = __ENV.TEST_DURATION || '5m';

function toSeconds(d) {
  const m = d.match(/^(\d+)(s|m|h)$/);
  if (!m) return 300;
  const n = parseInt(m[1]);
  return m[2] === 'h' ? n * 3600 : m[2] === 'm' ? n * 60 : n;
}

function fmt(s) {
  return s >= 60 ? `${Math.floor(s / 60)}m` : `${s}s`;
}

const secs = toSeconds(DURATION);

const stages = secs <= 60
  ? [
      { duration: fmt(Math.ceil(secs * 0.3)),  target: Math.ceil(TOTAL_VUS * 0.5) },
      { duration: fmt(Math.ceil(secs * 0.5)),  target: TOTAL_VUS },
      { duration: fmt(Math.ceil(secs * 0.2)),  target: 0 },
    ]
  : [
      { duration: fmt(Math.ceil(secs * 0.10)), target: Math.ceil(TOTAL_VUS * 0.25) },
      { duration: fmt(Math.ceil(secs * 0.10)), target: Math.ceil(TOTAL_VUS * 0.50) },
      { duration: fmt(Math.ceil(secs * 0.10)), target: Math.ceil(TOTAL_VUS * 0.75) },
      { duration: fmt(Math.ceil(secs * 0.15)), target: TOTAL_VUS },
      { duration: fmt(Math.ceil(secs * 0.30)), target: TOTAL_VUS },
      { duration: fmt(Math.ceil(secs * 0.10)), target: Math.ceil(TOTAL_VUS * 0.50) },
      { duration: fmt(Math.ceil(secs * 0.10)), target: Math.ceil(TOTAL_VUS * 0.25) },
      { duration: fmt(Math.ceil(secs * 0.05)), target: 0 },
    ];

export const options = {
  stages,
  thresholds: {
    http_req_duration: ['p(95)<8000'],
    http_req_failed:   ['rate<0.10'],
    checks:            ['rate>0.90'],
  },
};

export function setup() {
  console.log(`TARGET  : ${BASE_URL}`);
  console.log(`VUs     : ${TOTAL_VUS}`);
  console.log(`DURATION: ${DURATION}`);
  return {};
}

const UA = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) Chrome/125.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4) Safari/605.1.15',
];

export default function () {
  const res = http.get(BASE_URL, {
    headers: { 'User-Agent': UA[Math.floor(Math.random() * UA.length)] },
    timeout: '30s',
  });

  check(res, {
    'status 2xx': (r) => r.status >= 200 && r.status < 300,
    'body not empty': (r) => r.body && r.body.length > 0,
  });

  sleep(1 + Math.random() * 2);
};
