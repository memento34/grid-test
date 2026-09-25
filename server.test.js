import test from 'node:test';
import assert from 'node:assert/strict';

test('login protects grid writes with a session and CSRF token', async () => {
  process.env.DASHBOARD_PASSWORD = 'test-only-secret';
  delete process.env.OKX_API_KEY;
  delete process.env.OKX_SECRET_KEY;
  delete process.env.OKX_PASSPHRASE;
  const { createServer } = await import('../server.js');
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const before = await fetch(base + '/api/bots');
    assert.equal(before.status, 401);
    const login = await fetch(base + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test-only-secret' })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const bootstrap = await fetch(base + '/api/bootstrap', { headers: { Cookie: cookie } });
    const settings = await bootstrap.json();
    assert.equal(settings.loggedIn, true);
    const noCsrf = await fetch(base + '/api/bots', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.equal(noCsrf.status, 403);
    const noCredentials = await fetch(base + '/api/bots', {
      method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': settings.csrf, 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.equal(noCredentials.status, 503);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
