/* global document, URL, fetch, window */
/*
 * PB-SOCIAL-003B: staged invite-only login + tenant-scoped onboarding.
 * Only Supabase project URL and publishable key are public. Access tokens
 * are kept in this JS module's memory, never in cookies or browser storage.
 */
const $ = id => document.getElementById(id);
let config = null;
let session = null;
let ssoEnabled = false;
let emailForVerification = '';
let clients = [];
let chosenClientId = null;
let personaReviews = [];
let customerContent = [];

function status(message, isError = false) {
  const node = $('portalMessage');
  node.textContent = message;
  node.classList.toggle('error', isError);
}

function resetSession(message) {
  session = null;
  clients = [];
  chosenClientId = null;
  personaReviews = [];
  customerContent = [];
  $('workspace').hidden = true;
  $('loginPanel').hidden = false;
  $('signOut').hidden = true;
  $('verifyForm').hidden = true;
  $('otp').value = '';
  if (message) status(message);
}

function authUrl(path) {
  if (!config) throw new Error('Portal configuration is unavailable.');
  return new URL('/auth/v1/' + path, config.supabaseUrl);
}

async function authCall(path, body) {
  const response = await fetch(authUrl(path), {
    method: 'POST',
    headers: {
      apikey: config.publishableKey,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body),
    redirect: 'error',
    cache: 'no-store'
  });
  if (!response.ok) throw new Error('Verification could not be completed.');
  return response.json();
}

async function clientApi(method, path, body) {
  if (!session?.accessToken && !ssoEnabled) throw new Error('Sign in again to continue.');
  if (session?.accessToken && Date.now() > session.expiresAt) {
    resetSession('Your sign-in has expired. Please sign in again.');
    throw new Error('Session expired.');
  }
  const response = await fetch('/api/social' + path, {
    method,
    headers: {
      ...(session?.accessToken ? { authorization: 'Bearer ' + session.accessToken } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error',
    cache: 'no-store'
  });
  if (response.status === 401) {
    resetSession('Your sign-in is no longer valid. Please sign in again.');
    throw new Error('Session expired.');
  }
  if (response.status === 404) throw new Error('Client not found or changes are not permitted.');
  if (!response.ok) throw new Error('Unable to complete this request. Please check your access and try again.');
  return response.json();
}

function currentClient() {
  return clients.find(client => client.id === chosenClientId) || null;
}

function setFormValue(id, value) {
  $(id).value = typeof value === 'string' ? value : '';
}

function safeReviewDraft(client) {
  const draft = client?.personaDraft;
  if (!draft || typeof draft !== 'object' ||
      draft.source !== 'EXTERNAL_ENGINE') return null;
  const proposal = draft.proposal && typeof draft.proposal === 'object'
    ? draft.proposal : draft;
  const fields = ['summary', 'writingStyle', 'contentPillars'];
  if (!fields.every(field => typeof proposal[field] === 'string' &&
      proposal[field].trim().length > 0 && proposal[field].length <= 1000)) return null;
  return {
    summary: proposal.summary,
    writingStyle: proposal.writingStyle,
    contentPillars: proposal.contentPillars
  };
}

function renderClient() {
  const client = currentClient();
  if (!client) {
    $('workspace').hidden = true;
    return;
  }
  $('workspace').hidden = false;
  for (const key of ['businessName', 'niche', 'audience', 'language',
    'tone', 'restrictions', 'samplePosts']) {
    setFormValue(key, client[key]);
  }
  $('historyConsent').checked = client.historyConsent === true;
  $('profileStatus').textContent = 'Package: ' + client.plan + ' · Status: ' + client.status;
  const draft = safeReviewDraft(client);
  const canReview = client.status === 'PERSONA_REVIEW' &&
    Number.isSafeInteger(client.personaRevision) && client.personaRevision >= 1 &&
    draft !== null;
  $('personaReviewPanel').hidden = !canReview;
  if (canReview) {
    $('reviewSummary').value = draft.summary;
    $('reviewStyle').value = draft.writingStyle;
    $('reviewPillars').value = draft.contentPillars;
    const existing = personaReviews.find(row => row.personaRevision === client.personaRevision);
    $('personaReviewForm').hidden = !!existing;
    $('personaReviewStatus').textContent = existing
      ? (existing.decision === 'APPROVE'
        ? 'Approval request recorded. Awaiting trusted processing. Nothing is activated.'
        : 'Change request recorded. Awaiting a revised persona.')
      : 'Draft revision ' + client.personaRevision + ' · No decision submitted yet.';
  }
  $('personaStatus').textContent = canReview
    ? 'An externally generated Persona V1 draft is ready for your review.'
    : client.status === 'READY'
      ? 'An approved persona exists. Changing brand details will invalidate it.'
      : 'No reviewable external Persona Engine draft is available yet.';
}

function renderClients() {
  const select = $('clientSelect');
  const entries = clients.map(client => {
    const option = document.createElement('option');
    option.value = client.id;
    option.textContent = client.businessName || 'Unnamed client profile';
    return option;
  });
  select.replaceChildren(...entries);
  if (!clients.find(client => client.id === chosenClientId)) {
    chosenClientId = clients[0]?.id || null;
  }
  if (chosenClientId) select.value = chosenClientId;
  renderClient();
}

async function loadPersonaReviews() {
  const id = chosenClientId;
  if (!id) { personaReviews = []; return; }
  const response = await clientApi('GET', '/clients/' + encodeURIComponent(id) + '/persona/reviews');
  if (!Array.isArray(response.reviews)) throw new Error('Invalid persona review response.');
  if (id === chosenClientId) {
    personaReviews = response.reviews;
    renderClient();
  }
}

function renderContentQueue() {
  const queue = $('contentQueue');
  const items = customerContent.map(item => {
    const card = document.createElement('article');
    card.className = 'card';
    const label = document.createElement('p');
    const date = new Date(item.scheduledFor);
    label.className = 'muted';
    label.textContent = item.surface + ' · ' +
      (Number.isNaN(date.getTime()) ? 'Date unavailable' : date.toLocaleString('en-MY', {
        timeZone: 'Asia/Kuala_Lumpur'
      })) + ' MYT · ' + item.status;
    const body = document.createElement('p');
    body.textContent = item.body;
    card.append(label, body);
    if (item.reviewDecision) {
      const pending = document.createElement('p');
      pending.className = 'muted';
      pending.textContent = item.reviewDecision === 'APPROVE'
        ? 'Approval requested. Not sent to Postiz.'
        : 'Changes requested; revision required.';
      card.append(pending);
    } else if (item.status === 'IN_REVIEW') {
      const comment = document.createElement('textarea');
      comment.placeholder = 'What should be changed? (required when requesting changes)';
      comment.maxLength = 1000;
      comment.rows = 2;
      const approve = document.createElement('button');
      approve.type = 'button';
      approve.textContent = 'Approve content';
      const requestChanges = document.createElement('button');
      requestChanges.type = 'button';
      requestChanges.textContent = 'Request changes';
      requestChanges.className = 'ghost';
      const send = async decision => {
        const note = comment.value.trim();
        if (decision === 'REQUEST_CHANGES' && !note) {
          status('Enter your requested changes before submitting.', true);
          return;
        }
        approve.disabled = true;
        requestChanges.disabled = true;
        try {
          const result = await clientApi('POST', '/content/' +
            encodeURIComponent(item.id) + '/reviews', {
              expectedRevision: item.contentRevision,
              decision,
              ...(decision === 'REQUEST_CHANGES' ? { comment: note } : {})
            });
          if (!result.review || result.scheduled !== false) {
            throw new Error('Unexpected approval response.');
          }
          await loadContentQueue();
          status('Decision recorded. Nothing has been scheduled or published.');
        } catch (error) {
          status(error instanceof Error ? error.message : 'Approval request failed.', true);
        } finally {
          approve.disabled = false;
          requestChanges.disabled = false;
        }
      };
      approve.addEventListener('click', () => { void send('APPROVE'); });
      requestChanges.addEventListener('click', () => { void send('REQUEST_CHANGES'); });
      card.append(comment, approve, requestChanges);
    }
    return card;
  });
  queue.replaceChildren(...items);
  $('contentQueueStatus').textContent = customerContent.length
    ? customerContent.length + ' content piece(s) available for your organization.'
    : 'No content drafts assigned yet.';
}

async function loadContentQueue() {
  const id = chosenClientId;
  if (!id) { customerContent = []; renderContentQueue(); return; }
  const response = await clientApi('GET',
    '/clients/' + encodeURIComponent(id) + '/content');
  if (!Array.isArray(response.content)) throw new Error('Invalid content response.');
  if (id === chosenClientId) {
    customerContent = response.content;
    renderContentQueue();
  }
}

async function loadClients() {
  const result = await clientApi('GET', '/clients');
  if (!Array.isArray(result.clients)) throw new Error('Invalid server response.');
  clients = result.clients;
  $('loginPanel').hidden = true;
  $('signOut').hidden = false;
  renderClients();
  if (chosenClientId) {
    await loadPersonaReviews();
    await loadContentQueue();
  }
  status(clients.length
    ? 'Signed in. Your private business profile is ready.'
    : 'Signed in, but no client is assigned to your account. Contact PostBro.');
}

async function saveClient(method, path, payload) {
  const result = await clientApi(method, path, payload);
  if (!result.client || result.client.id !== chosenClientId) {
    throw new Error('Invalid server response.');
  }
  clients = clients.map(client => client.id === chosenClientId ? result.client : client);
  renderClients();
  await loadPersonaReviews();
  await loadContentQueue();
}

$('loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!config) { status('Portal has not been configured.', true); return; }
  const email = $('loginEmail').value.trim().toLowerCase();
  const button = $('requestOtp');
  button.disabled = true;
  try {
    // Never auto-create a new Auth user. Agency onboarding is by invitation.
    await authCall('otp', { email, create_user: false });
    emailForVerification = email;
    $('verifyForm').hidden = false;
    status('If this address has an invitation, you can enter its email verification code.');
  } catch {
    // Do not reveal whether an account exists or which provider check failed.
    emailForVerification = email;
    $('verifyForm').hidden = false;
    status('If you have an invitation, check your email for a code, or contact PostBro.');
  } finally {
    button.disabled = false;
  }
});

$('verifyForm').addEventListener('submit', async event => {
  event.preventDefault();
  const token = $('otp').value.trim();
  if (!/^[0-9]{6,8}$/.test(token)) {
    status('Enter the 6–8 digit code from your email.', true);
    return;
  }
  try {
    const result = await authCall('verify', {
      type: 'email', email: emailForVerification, token
    });
    if (!result || typeof result.access_token !== 'string' ||
        !Number.isFinite(Number(result.expires_in)) || Number(result.expires_in) <= 0) {
      throw new Error('Invalid authentication result.');
    }
    // In-memory access token only. No refresh token is stored or persisted.
    session = {
      accessToken: result.access_token,
      expiresAt: Date.now() + Number(result.expires_in) * 1000 - 20_000
    };
    $('otp').value = '';
    await loadClients(); // Server verifies token and enforces RLS again.
  } catch {
    resetSession();
    status('Sign-in failed or this account has no permission. Request another code.', true);
  }
});

$('clientSelect').addEventListener('change', () => {
  chosenClientId = $('clientSelect').value;
  personaReviews = [];
  customerContent = [];
  renderClient();
  renderContentQueue();
  void loadPersonaReviews().catch(() =>
    status('Unable to load persona review history. Try again.', true));
  void loadContentQueue().catch(() =>
    status('Unable to load content queue. Try again.', true));
});

$('brandForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!currentClient()) return;
  const body = {};
  for (const key of ['businessName', 'niche', 'audience', 'language',
    'tone', 'restrictions', 'samplePosts']) {
    body[key] = $(key).value;
  }
  try {
    await saveClient('PUT', '/clients/' + encodeURIComponent(chosenClientId) + '/brand', body);
    status('Brand profile saved. A previous persona approval, if any, was invalidated.');
  } catch (error) {
    status(error instanceof Error ? error.message : 'Save failed.', true);
  }
});

$('historyForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!currentClient()) return;
  try {
    await saveClient('PUT', '/clients/' + encodeURIComponent(chosenClientId) + '/history', {
      optedIn: $('historyConsent').checked
    });
    status('Analysis preference saved. No historical posts were accessed.');
  } catch (error) {
    status(error instanceof Error ? error.message : 'Unable to save preference.', true);
  }
});

async function submitPersonaReview(decision) {
  const client = currentClient();
  const draft = safeReviewDraft(client);
  if (!client || !draft || client.status !== 'PERSONA_REVIEW') {
    status('No externally generated persona draft is ready.', true);
    return;
  }
  const changes = {
    summary: $('reviewSummary').value.trim(),
    writingStyle: $('reviewStyle').value.trim(),
    contentPillars: $('reviewPillars').value.trim()
  };
  if (Object.values(changes).some(value => value.length === 0 || value.length > 1000)) {
    status('Complete all persona fields before submitting.', true);
    return;
  }
  const changed = Object.keys(changes).some(field => changes[field] !== draft[field]);
  if (decision === 'APPROVE' && changed) {
    status('You changed the draft. Use Request changes instead of approval.', true);
    return;
  }
  if (decision === 'REQUEST_CHANGES' && !changed) {
    status('Edit at least one persona field to request changes.', true);
    return;
  }
  $('requestPersonaChanges').disabled = true;
  $('approvePersona').disabled = true;
  try {
    const response = await clientApi(
      'POST', '/clients/' + encodeURIComponent(client.id) + '/persona/reviews',
      {
        expectedRevision: client.personaRevision,
        decision,
        ...(decision === 'REQUEST_CHANGES' ? { suggestedChanges: changes } : {})
      }
    );
    if (!response.review || response.activated !== false) {
      throw new Error('Unexpected review response.');
    }
    await loadPersonaReviews();
    status(decision === 'APPROVE'
      ? 'Approval request recorded. Persona is NOT active until trusted processing.'
      : 'Changes requested. The Persona Engine must prepare a new revision.');
  } catch (error) {
    status(error instanceof Error ? error.message : 'Review request failed.', true);
  } finally {
    $('requestPersonaChanges').disabled = false;
    $('approvePersona').disabled = false;
  }
}

$('approvePersona').addEventListener('click', () => {
  void submitPersonaReview('APPROVE');
});
$('requestPersonaChanges').addEventListener('click', () => {
  void submitPersonaReview('REQUEST_CHANGES');
});

$('ssoSignIn').addEventListener('click', () => {
  if (ssoEnabled) window.location.assign('/api/social/sso/start');
});

$('signOut').addEventListener('click', async () => {
  if (ssoEnabled && !session?.accessToken) {
    try {
      await fetch('/api/social/sso/logout', { method: 'POST', cache: 'no-store' });
    } catch { /* Do not expose authentication internals. */ }
  }
  resetSession('Signed out of PostBro. Your shared identity provider may remain signed in.');
});

(async () => {
  try {
    const response = await fetch('/api/social/config', {
      headers: { accept: 'application/json' }, cache: 'no-store'
    });
    if (!response.ok) throw new Error('Cannot load configuration.');
    const data = await response.json();
    const url = new URL(data.supabaseUrl);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.supabase.co') ||
        typeof data.publishableKey !== 'string' ||
        !data.publishableKey.startsWith('sb_publishable_')) {
      throw new Error('Invalid portal configuration.');
    }
    config = data;
    ssoEnabled = data.ssoEnabled === true;
    $('ssoSignIn').hidden = !ssoEnabled;
    if (ssoEnabled) {
      const check = await fetch('/api/social/sso/session', {
        headers: { accept: 'application/json' }, cache: 'no-store'
      });
      if (check.status === 200) {
        await loadClients();
      } else if (check.status === 401) {
        // Existing Supabase IdP session handles the login silently when possible.
        // No Postiz cookies or credentials are read by PostBro.
        window.location.replace('/api/social/sso/start');
      } else {
        status('Shared login is temporarily unavailable. Try again.', true);
      }
    } else {
      status('Ready. Sign in with the email invited by PostBro.');
    }
  } catch {
    status('Portal configuration is unavailable. Contact the administrator.', true);
  }
})();
