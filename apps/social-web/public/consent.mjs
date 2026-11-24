/* global document, window, fetch, URL */
const $ = id => document.getElementById(id);
const id = new URL(window.location.href).searchParams.get('authorization_id');
let email = '';
let busy = false;
const message = text => { $('message').textContent = text; };
const show = panel => {
  for (const name of ['login', 'verify', 'approval']) $(name).hidden = name !== panel;
};
async function api(route, body = {}) {
  const response = await fetch('/api/social/consent/' + route, {
    method: 'POST', cache: 'no-store',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ authorizationId: id, ...body })
  });
  if (response.status === 401 && route === 'details') return { login: true };
  if (!response.ok) throw new Error('unavailable');
  if (response.status === 204) return {};
  return response.json();
}
function follow(url) {
  if (typeof url !== 'string') throw new Error('unavailable');
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password || target.hash) throw new Error('unavailable');
  window.location.replace(target.href);
}
async function details() {
  show('');
  if (!id || !/^[A-Za-z0-9_-]{16,180}$/.test(id)) {
    message('No valid authorization request. Start from Postiz or PostBro Social.'); return;
  }
  const result = await api('details');
  if (result.login) { show('login'); message('Sign in with your invited account.'); return; }
  if (result.redirect) { follow(result.redirect); return; }
  if (typeof result.app !== 'string' || !Array.isArray(result.scopes)) throw new Error('unavailable');
  $('appName').textContent = result.app;
  $('scopes').replaceChildren(...result.scopes.map(scope => {
    const li = document.createElement('li');
    li.textContent = scope === 'openid' ? 'Verify your identity' :
      scope === 'email' ? 'Email address' : 'Basic profile';
    return li;
  }));
  show('approval'); message('Review the requested permissions.');
}
async function run(work) {
  if (busy) return;
  busy = true;
  try { await work(); } catch { message('Unable to complete this request. Try again or restart sign-in from the application.'); }
  finally { busy = false; }
}
$('login').addEventListener('submit', event => {
  event.preventDefault(); void run(async () => {
    email = $('email').value.trim().toLowerCase();
    await api('otp', { email });
    show('verify'); message('If your account is invited, enter the email verification code.');
  });
});
$('verify').addEventListener('submit', event => {
  event.preventDefault(); void run(async () => {
    await api('verify', { email, code: $('code').value });
    $('code').value = ''; await details();
  });
});
for (const action of ['approve', 'deny']) {
  $(action).addEventListener('click', () => { void run(async () => {
    const result = await api('decision', { action }); follow(result.redirect);
  }); });
}
$('switchAccount').addEventListener('click', () => { void run(async () => {
  await api('logout'); show('login'); message('Sign in with another invited account.');
}); });
void run(details);
