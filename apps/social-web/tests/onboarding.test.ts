import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SocialOnboarding } from '../src/onboarding.js';
import type { BrandIntake, PersonaProposal } from '../src/onboarding.js';

const intake: BrandIntake = {
  businessName: 'Example Business',
  niche: 'Personal care',
  audience: 'Adults',
  language: 'Manglish',
  tone: 'Friendly',
  restrictions: ''
};
const persona: PersonaProposal = {
  summary: 'Friendly brand',
  writingStyle: 'Conversational',
  contentPillars: 'Education, updates'
};

function seeded() {
  const service = new SocialOnboarding();
  service.createClient('org-a', 'client-1', 'STARTER');
  service.saveIntake('org-a', 'client-1', intake);
  return service;
}

test('clients from other organizations cannot read or mutate client records', () => {
  const service = seeded();
  assert.throws(() => service.getClient('org-b', 'client-1'), /not found/);
  assert.throws(() => service.saveIntake('org-b', 'client-1', intake), /not found/);
  assert.throws(() => service.draftPersona('org-b', 'client-1', persona, 'EXTERNAL_ENGINE'), /not found/);
  assert.equal(service.listClients('org-b').length, 0);
  assert.equal(service.listClients('org-a').length, 1);
});

test('only STARTER or GROWTH plans are accepted', () => {
  const service = new SocialOnboarding();
  assert.throws(() => service.createClient('org-a', 'invalid', 'FREE' as never), /Invalid plan/);
});

test('five-client limit applies globally across organizations', () => {
  const service = new SocialOnboarding();
  for (let i = 0; i < 5; i++) service.createClient(`org-${i}`, `client-${i}`, 'GROWTH');
  assert.throws(() => service.createClient('org-6', 'client-6', 'STARTER'), /Five-client/);
});

test('history analysis defaults off and is an opt-in stub only', () => {
  const service = seeded();
  assert.equal(service.getClient('org-a', 'client-1').analyzePreviousPosts, false);
  service.setHistoryConsent('org-a', 'client-1', true);
  const item = service.getClient('org-a', 'client-1');
  assert.equal(item.analyzePreviousPosts, true);
  assert.equal(item.previousPostsFetched, false);
  assert.throws(() => service.setHistoryConsent('org-a', 'client-1', 'yes' as never), /boolean/);
});

test('draft requires brand intake and explicit approval', () => {
  const service = new SocialOnboarding();
  service.createClient('org-a', 'client-1', 'STARTER');
  assert.throws(() => service.draftPersona('org-a', 'client-1', persona, 'EXTERNAL_ENGINE'), /intake/);
  service.saveIntake('org-a', 'client-1', intake);
  service.draftPersona('org-a', 'client-1', persona, 'EXTERNAL_ENGINE');
  assert.throws(() => service.getActivePersona('org-a', 'client-1'), /not approved/);
  service.approvePersona('org-a', 'client-1', 1);
  assert.equal(service.getActivePersona('org-a', 'client-1').status, 'APPROVED');
});

test('editing invalidates approval; stale revision cannot be approved', () => {
  const service = seeded();
  service.draftPersona('org-a', 'client-1', persona, 'EXTERNAL_ENGINE');
  service.approvePersona('org-a', 'client-1', 1);
  const revision2 = service.editPersona('org-a', 'client-1', 1, {...persona, summary:'Changed'});
  assert.equal(revision2.revision, 2);
  assert.equal(revision2.status, 'DRAFT');
  assert.throws(() => service.getActivePersona('org-a', 'client-1'), /not approved/);
  assert.throws(() => service.approvePersona('org-a', 'client-1', 1), /Stale/);
  service.approvePersona('org-a', 'client-1', 2);
  assert.equal(service.getActivePersona('org-a', 'client-1').revision, 2);
});

test('changing intake or historical-data consent invalidates prior approval', () => {
  const service = seeded();
  service.draftPersona('org-a', 'client-1', persona, 'EXTERNAL_ENGINE');
  service.approvePersona('org-a', 'client-1', 1);
  service.setHistoryConsent('org-a', 'client-1', true);
  assert.throws(() => service.getActivePersona('org-a', 'client-1'), /not approved/);
  service.draftPersona('org-a', 'client-1', persona, 'EXTERNAL_ENGINE');
  service.approvePersona('org-a', 'client-1', 1);
  service.saveIntake('org-a', 'client-1', { ...intake, tone: 'Formal' });
  assert.throws(() => service.getActivePersona('org-a', 'client-1'), /not approved/);
});

test('mock persona is never activated for production use', () => {
  const service = seeded();
  service.draftPersona('org-a', 'client-1', persona, 'MOCK_PREVIEW');
  service.approvePersona('org-a', 'client-1', 1);
  assert.throws(() => service.getActivePersona('org-a', 'client-1'), /preview-only/);
});

test('objects returned to callers cannot mutate the service state', () => {
  const service = seeded();
  const client = service.getClient('org-a', 'client-1');
  if (!client.intake) throw new Error('missing intake');
  client.intake.businessName = 'Changed outside';
  assert.equal(service.getClient('org-a', 'client-1').intake?.businessName, 'Example Business');
  const draft = service.draftPersona('org-a', 'client-1', persona, 'EXTERNAL_ENGINE');
  draft.revision = 999;
  assert.equal(service.approvePersona('org-a', 'client-1', 1).revision, 1);
});

test('invalid draft and edits cannot partially mutate prior valid persona', () => {
  const service = seeded();
  service.draftPersona('org-a', 'client-1', persona, 'EXTERNAL_ENGINE');
  assert.throws(() => service.editPersona('org-a', 'client-1', 1, {
    ...persona,
    summary: ''
  }), /summary/);
  assert.equal(service.getClient('org-a', 'client-1').persona?.revision, 1);
});

test('identifier separator cannot be used to escape organization namespace', () => {
  const service = seeded();
  assert.throws(() => service.getClient('org-a::evil', 'client-1'), /Invalid organizationId/);
});
