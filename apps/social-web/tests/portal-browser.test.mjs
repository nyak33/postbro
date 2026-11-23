import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { test } from 'node:test';

const html = readFileSync(new URL('../public/portal.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../public/portal.mjs', import.meta.url), 'utf8');

test('login portal does not include secret tokens, embedded external scripts or unsafe HTML', () => {
  assert.match(html, /Invite-only access/);
  assert.match(html, /id="loginForm"/);
  assert.match(html, /id="verifyForm"/);
  assert.match(html, /id="brandForm"/);
  assert.match(html, /id="historyForm"/);
  assert.match(html, /src="\.\/portal\.mjs"/);
  assert.doesNotMatch(html + script, /service_role|sb_secret_|localStorage|sessionStorage|document\.cookie/);
  assert.doesNotMatch(script, /\.innerHTML\s*=|insertAdjacentHTML\s*\(|eval\s*\(/);
  assert.doesNotMatch(script, /\/api\/demo-session|x-postbro-demo-token/);
});

test('OTP login is opt-in and cannot self-register users', () => {
  assert.match(script, /create_user:\s*false/);
  assert.match(script, /type:\s*'email'/);
  assert.match(script, /authCall\('otp'/);
  assert.match(script, /authCall\('verify'/);
  assert.doesNotMatch(script, /create_user:\s*true|signUp|createUser/);
});

test('browser sessions are memory-only and data routes demand Bearer token', () => {
  assert.match(script, /let session = null/);
  assert.match(script, /authorization:\s*'Bearer '/);
  assert.match(script, /resetSession/);
  assert.doesNotMatch(script, /refresh_token/);
});

test('client persona review is visible only for a trusted engine draft', () => {
  assert.match(html, /id="personaReviewPanel"/);
  assert.match(html, /id="requestPersonaChanges"/);
  assert.match(html, /id="approvePersona"/);
  assert.match(script, /draft\.source !== 'EXTERNAL_ENGINE'/);
  assert.match(script, /client\.personaRevision/);
  assert.match(script, /'\/persona\/reviews'/);
  assert.match(script, /response\.activated !== false/);
  assert.match(html + script, /NOT active|not activate|Nothing is activated/);
});

test('client review is not an automatic publishing or persona activation route', () => {
  assert.doesNotMatch(script, new RegExp(['/api/postiz', '/api/publish', '/api/persona/activate'].join('|')));
  assert.doesNotMatch(script, /\.innerHTML\s*=|insertAdjacentHTML\s*\(/);
  assert.doesNotMatch(script, /localStorage|sessionStorage|document\.cookie/);
});

test('customer content queue is reviewed explicitly and never scheduled from browser', () => {
  assert.match(html, /id="contentQueue"/);
  assert.match(html, /Content approval queue/);
  assert.match(script, /function renderContentQueue/);
  assert.match(script, /'REQUEST_CHANGES'/);
  assert.match(script, /'APPROVE'/);
  assert.match(script, /result\.scheduled !== false/);
  assert.match(script, /document\.createElement\('article'\)/);
  assert.doesNotMatch(script, /\.innerHTML\s*=|insertAdjacentHTML\s*\(/);
  assert.doesNotMatch(script, /\/public\/v1\/posts|'schedule'|type:\s*'now'/);
});
