import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createPostizReadOnlyTransport, verifyPostizClientChannels,
  PostizPreflightError, type PostizReadOnlyTransport, type PostizReadFetch,
} from '../src/postiz/read-only-preflight.js';
import {
  buildPostizDraftPreview, type PostizClientMapping,
} from '../src/postiz/draft-preview.js';

const clientId = '30000000-0000-4000-8000-000000000001';
const groupId = 'customer_alpha_001';
const mapping: PostizClientMapping = {
  clientId, customerGroupId: groupId,
  integrationIds: {
    threads: 'threads_channel_001',
    facebook: 'facebook_channel_001',
    instagram: 'instagram_channel_001',
  },
};
const channels = [
  { id: 'threads_channel_001', identifier: 'threads', disabled: false,
    customer: { id: groupId }, name: 'Untrusted profile information' },
  { id: 'facebook_channel_001', identifier: 'facebook', disabled: false,
    customer: { id: groupId } },
  { id: 'instagram_channel_001', identifier: 'instagram', disabled: false,
    customer: { id: groupId } },
];
const fixture = (
  groups: unknown = [{ id: groupId, name: 'Client A' }],
  integrations: unknown = channels,
): PostizReadOnlyTransport => ({
  async groups() { return groups; },
  async integrations() { return integrations; },
});

test('verify exact grouped Threads channel and return only safe metadata', async () => {
  const verified = await verifyPostizClientChannels(mapping, 'THREADS', fixture());
  assert.deepEqual(verified, [{
    id: 'threads_channel_001', identifier: 'threads',
    disabled: false, customer: { id: groupId }
  }]);
  assert.equal(JSON.stringify(verified).includes('Untrusted profile'), false);
  const body = buildPostizDraftPreview({
    clientId, body: 'Safe draft', surface: 'THREADS',
    scheduledFor: '2027-01-11T01:00:00.000Z',
    personaRevision: 1, contentRevision: 1,
  }, mapping, verified);
  assert.equal(body.type, 'draft');
  assert.equal(body.posts[0]?.settings.__type, 'threads');
});
test('verify matching Facebook and Instagram group with ready media', async () => {
  const verified = await verifyPostizClientChannels(mapping, 'FB_IG', fixture());
  assert.deepEqual(verified.map(item => item.identifier), ['facebook', 'instagram']);
  const body = buildPostizDraftPreview({
    clientId, body: 'Safe visual draft', surface: 'FB_IG',
    scheduledFor: '2027-01-11T01:00:00.000Z',
    personaRevision: 1, contentRevision: 1,
  }, mapping, verified, [{
    id: 'ready_media_001', path: 'https://media.example.com/image.jpg', status: 'ready',
  }]);
  assert.equal(body.type, 'draft');
  assert.equal(body.posts.length, 2);
});
test('missing group, ungrouped, disabled, swapped, duplicated and cross-group fail closed', async () => {
  const wrong = { ...mapping, customerGroupId: 'customer_beta_002' };
  const failures: Array<[PostizClientMapping, PostizReadOnlyTransport]> = [
    [mapping, fixture([])],
    [wrong, fixture()],
    [mapping, fixture([{ id: groupId }, { id: groupId }])],
    [mapping, fixture(undefined, channels.map(x => x.id === 'threads_channel_001'
      ? { ...x, customer: null } : x))],
    [mapping, fixture(undefined, channels.map(x => x.id === 'threads_channel_001'
      ? { ...x, disabled: true } : x))],
    [mapping, fixture(undefined, channels.map(x => x.id === 'threads_channel_001'
      ? { ...x, identifier: 'facebook' } : x))],
    [mapping, fixture(undefined, [...channels, channels[0]])],
    [mapping, fixture(undefined, channels.map(x => x.id === 'threads_channel_001'
      ? { ...x, customer: { id: 'customer_beta_002' } } : x))],
  ];
  for (const [input, transport] of failures) {
    await assert.rejects(verifyPostizClientChannels(input, 'THREADS', transport),
      PostizPreflightError);
  }
  await assert.rejects(verifyPostizClientChannels(mapping, 'FB_IG',
    fixture(undefined, channels.filter(x => x.identifier !== 'instagram'))),
  PostizPreflightError);
});
test('transport makes only two fixed GET requests and cannot POST', async () => {
  const calls: Array<{ path: string; method: string; redirect: string }> = [];
  const mockFetch: PostizReadFetch = async (url, request) => {
    const parsed = new URL(url);
    calls.push({ path: parsed.pathname + parsed.search,
      method: request.method, redirect: request.redirect });
    assert.equal(request.headers.Accept, 'application/json');
    assert.equal(request.headers.Authorization.length > 0, true);
    assert.equal(request.signal.aborted, false);
    return { ok: true, json: async () =>
      parsed.pathname.endsWith('/groups') ? [{ id: groupId }] : channels };
  };
  const transport = createPostizReadOnlyTransport(
    'https://postiz.example.test/public/v1', 'TEST_ONLY_OPAQUE_PLACEHOLDER', mockFetch,
  );
  const verified = await verifyPostizClientChannels(mapping, 'THREADS', transport);
  assert.equal(verified.length, 1);
  assert.deepEqual(calls, [
    { path: '/public/v1/groups', method: 'GET', redirect: 'error' },
    { path: '/public/v1/integrations?group=customer_alpha_001',
      method: 'GET', redirect: 'error' },
  ]);
});
test('insecure API roots and upstream errors are rejected without leaking details', async () => {
  const fetcher: PostizReadFetch = async () => { throw new Error('Untrusted upstream error'); };
  for (const endpoint of [
    'http://postiz.example.test', 'https://user:pass@postiz.example.test',
    'https://postiz.example.test/custom-path',
    'https://postiz.example.test/?api_key=unsafe',
  ]) {
    assert.throws(() => createPostizReadOnlyTransport(endpoint, 'placeholder', fetcher),
      /invalid_postiz_api_root/);
  }
  const transport = createPostizReadOnlyTransport(
    'https://postiz.example.test', 'placeholder', fetcher,
  );
  const failure = await verifyPostizClientChannels(mapping, 'THREADS', transport)
    .then(() => null, error => error);
  assert.equal(failure?.message, 'postiz_read_unavailable');
  assert.equal(failure?.message.includes('Untrusted'), false);
});
