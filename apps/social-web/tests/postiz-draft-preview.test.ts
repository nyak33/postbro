import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildPostizDraftPreview, PostizPreviewError,
  type PostizClientMapping, type VerifiedPostizIntegration,
  type ReadyPostizMedia,
} from '../src/postiz/draft-preview.js';

const CLIENT = '30000000-0000-4000-8000-000000000001';
const OTHER = '30000000-0000-4000-8000-000000000002';
const group = 'client-group-123';
const ids = {
  threads: 'postiz_threads_123',
  facebook: 'postiz_facebook_123',
  instagram: 'postiz_instagram_123',
};
const mapping: PostizClientMapping = {
  clientId: CLIENT,
  customerGroupId: group,
  integrationIds: { ...ids },
};
const integrations: VerifiedPostizIntegration[] = [
  { id: ids.threads, identifier: 'threads', disabled: false, customer: { id: group } },
  { id: ids.facebook, identifier: 'facebook', disabled: false, customer: { id: group } },
  { id: ids.instagram, identifier: 'instagram', disabled: false, customer: { id: group } },
];
const threadsContent = {
  id: '40000000-0000-4000-8000-000000000001',
  clientId: CLIENT,
  body: 'Business growth tip: know your customer.',
  surface: 'THREADS',
  scheduledFor: '2027-01-11T02:00:00.000Z',
  personaRevision: 2,
  contentRevision: 1,
  plan: 'STARTER'
};

test('offline Threads request is Postiz DRAFT only, with no schedule or publish type', () => {
  const draft = buildPostizDraftPreview(threadsContent, mapping, integrations);
  assert.equal(draft.type, 'draft');
  assert.equal(draft.date, '2027-01-11T02:00:00.000Z');
  assert.equal(draft.shortLink, false);
  assert.deepEqual(draft.tags, []);
  assert.deepEqual(draft.posts, [{
    integration: { id: ids.threads },
    value: [{ content: threadsContent.body, image: [] }],
    settings: { __type: 'threads' },
  }]);
  assert.equal(Object.keys(draft).length, 5);
  assert.ok(!JSON.stringify(draft).includes('schedule'));
});

test('FB/IG requires a ready image already uploaded in Postiz media library', () => {
  assert.throws(() => buildPostizDraftPreview(
    { ...threadsContent, surface: 'FB_IG' }, mapping, integrations
  ), /instagram_requires_media/);
  const media = [{ id: 'postiz_image_123',
    path: 'https://media.example.com/ready.jpg', status: 'ready' as const }];
  const result = buildPostizDraftPreview(
    { ...threadsContent, surface: 'FB_IG' }, mapping, integrations, media
  );
  assert.equal(result.type, 'draft');
  assert.equal(result.posts.length, 2);
  assert.deepEqual(result.posts.map(p => p.settings), [
    { __type: 'facebook' },
    { __type: 'instagram', post_type: 'post' }
  ]);
  assert.deepEqual(result.posts.map(p => p.integration.id), [
    ids.facebook, ids.instagram
  ]);
  assert.ok(result.posts.every(p => p.value[0]?.image.length === 1));
});

test('wrong tenant group, disabled channel, absent channel or provider mismatch fails closed', () => {
  for (const bad of [
    { ...mapping, clientId: OTHER },
    { ...mapping, customerGroupId: 'other-group' },
    { ...mapping, integrationIds: { ...ids, threads: 'not-an-integration' } },
  ]) {
    assert.throws(() => buildPostizDraftPreview(
      threadsContent, bad, integrations
    ));
  }
  const disabled = integrations.map(x =>
    x.identifier === 'threads' ? { ...x, disabled: true } : x);
  assert.throws(() => buildPostizDraftPreview(
    threadsContent, mapping, disabled
  ), /unverified_postiz_integration/);
  const spoofed = integrations.map(x =>
    x.identifier === 'threads' ? { ...x, identifier: 'facebook' as const } : x);
  assert.throws(() => buildPostizDraftPreview(
    threadsContent, mapping, spoofed
  ), /unverified_postiz_integration/);
  assert.throws(() => buildPostizDraftPreview(
    threadsContent, mapping, [...integrations, integrations[0]!]
  ), /unverified_postiz_integration/);
});

test('reject unsafe unready media, cross-tenant input and excessive Threads text', () => {
  const fb = { ...threadsContent, surface: 'FB_IG' };
  for (const item of [
    { id: 'postiz_image_123', path: 'http://media.example.com/file.jpg', status: 'ready' as const },
    { id: 'postiz_image_123', path: 'https://user:pass@media.example.com/file.jpg', status: 'ready' as const },
    { id: 'postiz_image_123', path: 'https://media.example.com/file.jpg', status: 'processing' as const },
  ]) {
    assert.throws(() => buildPostizDraftPreview(fb, mapping, integrations,
      [item as unknown as ReadyPostizMedia]));
  }
  assert.throws(() => buildPostizDraftPreview(
    { ...threadsContent, body: 'x'.repeat(501) }, mapping, integrations
  ), /threads_content_too_long/);
  assert.throws(() => buildPostizDraftPreview(
    { ...threadsContent, clientId: OTHER }, mapping, integrations
  ), PostizPreviewError);
});
