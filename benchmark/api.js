import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:3002';
const USERNAME = benchmark001;
const PASSWORD = PASSWORD;

export const options = {
  stages: [
    { duration: '10s', target: 10 },
    { duration: '20s', target: 10 },
    { duration: '10s', target: 0 },
  ],
};

export function setup() {
  if (!USERNAME || !PASSWORD) {
    throw new Error('USERNAME and PASSWORD environment variables are required');
  }

  const res = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({
      username: USERNAME,
      password: PASSWORD,
    }),
    {
      headers: {
        'Content-Type': 'application/json',
      },
    }
  );

  check(res, {
    'login status is 200': (r) => r.status === 200,
    'login returned token': (r) => {
      try {
        return !!r.json('token');
      } catch {
        return false;
      }
    },
  });

  if (res.status !== 200) {
    throw new Error(`Login failed: ${res.status} ${res.body}`);
  }

  return {
    token: res.json('token'),
    userId: res.json('id'),
  };
}

export default function (data) {
  const headers = {
    Authorization: `Bearer ${data.token}`,
  };

  const res = http.get(
    `${BASE_URL}/api/dm/conversations`,
    { headers }
  );

  check(res, {
    'conversations status is 200': (r) => r.status === 200,
  });

  sleep(1);
}
