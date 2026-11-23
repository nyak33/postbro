import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  verifyPostizDraftReceipt, PostizDispatchError,
} from '../src/postiz/draft-dispatch.js';
import {
  buildPostizDraftPreview, type PostizClientMapping,
  type VerifiedPostizIntegration,
} from '../src/postiz/draft-preview.js';

const clientId = '30000000-0000-4000-8000-000000000001';
const group = 'group-client-001';
const mapping: PostizClientMapping = {
  clientId, customerGroupId: group,
  integrationIds: { threads: 'threads_001234', facebook: 'facebook_00123', instagram: 'instagram_0012' }
};
const integrations: VerifiedPostizIntegration[] = [
  { id: 'threads_001234', identifier: 'threads', customer: { id: group }, disabled: false },
  { id: 'facebook_00123', identifier: 'facebook', customer: { id: group }, disabled: false },
  { id: 'instagram_0012', identifier: 'instagram', customer: { id: group }, disabled: false }
];
const raw = {
  clientId, body: 'Draft for testing', surface: 'THREADS',
  scheduledFor: '2027-01-11T01:00:00.000Z', personaRevision: 1, contentRevision: 1
};
test('mock Postiz API receipt confirms exact channel only, never a publish payload', () => {
  const payload = buildPostizDraftPreview(raw, mapping, integrations);
  assert.equal(payload.type, 'draft');
  const mockPostizResponse = [{ postId: 'postiz_draft_123', integration: 'threads_001234' }];
  assert.deepEqual(verifyPostizDraftReceipt(payload, mockPostizResponse), mockPostizResponse);
});
test('unexpected, duplicate or missing provider confirmations are not trusted', () => {
  const fb = buildPostizDraftPreview(
    { ...raw, surface: 'FB_IG' }, mapping, integrations,
    [{ id: 'ready_media_001', path: 'https://uploads.example.com/image.jpg', status: 'ready' }]
  );
  for (const invalid of [
    [], [{ postId: 'draft_001', integration: 'facebook_00123' }],
    [{ postId: 'draft_001', integration: 'facebook_00123' },
      { postId: 'draft_002', integration: 'other_group_001' }],
    [{ postId: 'draft_001', integration: 'facebook_00123' },
      { postId: 'draft_001', integration: 'instagram_0012' }],
    [{ postId: 'draft_001', integration: 'facebook_00123' },
      { postId: 'draft_002', integration: 'facebook_00123' }],
  ]) {
    assert.throws(() => verifyPostizDraftReceipt(fb, invalid), PostizDispatchError);
  }
});
