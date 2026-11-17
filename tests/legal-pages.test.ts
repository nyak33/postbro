import assert from 'node:assert/strict';
import test from 'node:test';

import { buildApp } from '../src/app';

const ROUTES = ['/privacy', '/terms', '/data-deletion'] as const;

test('legal pages return 200 text/html without authentication or configuration', async () => {
  const app = buildApp({ logger: false });

  try {
    for (const url of ROUTES) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 200, `${url} should return 200`);
      const contentType = response.headers['content-type'];
      assert.ok(
        typeof contentType === 'string' && contentType.startsWith('text/html'),
        `${url} should return text/html, got ${String(contentType)}`,
      );
      assert.ok(response.body.includes('<html lang="en">'), `${url} should declare lang`);
      assert.ok(response.body.includes('viewport'), `${url} should be responsive`);
    }
  } finally {
    await app.close();
  }
});

test('legal pages set no cookies and require no login', async () => {
  const app = buildApp({ logger: false });

  try {
    for (const url of ROUTES) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.headers['set-cookie'], undefined, `${url} must not set cookies`);
      // No redirect to a login page and no auth challenge.
      assert.notEqual(response.statusCode, 401);
      assert.notEqual(response.statusCode, 403);
      assert.equal(response.headers['www-authenticate'], undefined);
    }
  } finally {
    await app.close();
  }
});

test('legal pages cross-link each other and show the support contact', async () => {
  const app = buildApp({ logger: false });

  try {
    for (const url of ROUTES) {
      const response = await app.inject({ method: 'GET', url });
      for (const link of ROUTES) {
        assert.ok(response.body.includes(`href="${link}"`), `${url} should link to ${link}`);
      }
      assert.ok(
        response.body.includes('postbro33@gmail.com'),
        `${url} should show the support email`,
      );
      assert.ok(
        response.body.includes('17 November 2026'),
        `${url} should show the effective date`,
      );
    }
  } finally {
    await app.close();
  }
});

test('privacy page carries required disclosures and no unverifiable claims', async () => {
  const app = buildApp({ logger: false });

  try {
    const response = await app.inject({ method: 'GET', url: '/privacy' });
    const body = response.body;
    assert.ok(body.includes('Supabase'), 'discloses database processor');
    assert.ok(body.includes('encrypted'), 'discloses token encryption');
    assert.ok(body.includes('not yet been independently verified'), 'Postiz claims stay unverified');
    assert.ok(!body.includes('Packtica'), 'must not mention Packtica');
    assert.ok(body.includes('AI-generated replies'), 'states AI replies are not sent');
    assert.ok(body.includes('not live'), 'states AI drafting is not live');
    assert.ok(body.includes('does not currently operate an automatic data-purge job'));
  } finally {
    await app.close();
  }
});

test('data-deletion page carries the manual-process instructions', async () => {
  const app = buildApp({ logger: false });

  try {
    const response = await app.inject({ method: 'GET', url: '/data-deletion' });
    const body = response.body;
    assert.ok(body.includes('PostBro Data Deletion Request'), 'exact subject line present');
    assert.ok(body.includes('handled manually'), 'manual process stated');
    assert.ok(body.includes('without undue delay'), 'no fixed SLA promised');
    assert.ok(body.includes('Never send passwords'), 'secret-safety instruction present');
    assert.ok(
      body.includes('There is currently no automated deletion pipeline'),
      'states deletion is manual',
    );
  } finally {
    await app.close();
  }
});

test('terms page carries authorised-use and Meta-terms clauses', async () => {
  const app = buildApp({ logger: false });

  try {
    const response = await app.inject({ method: 'GET', url: '/terms' });
    const body = response.body;
    assert.ok(body.includes('Authorised use only'));
    assert.ok(body.includes('Meta'), 'references Meta platform terms');
    assert.ok(body.includes('unsolicited bulk messaging'), 'anti-spam clause present');
  } finally {
    await app.close();
  }
});
