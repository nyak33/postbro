import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  STEPS, createPreviewState, choosePlan, saveBrandPreview,
  setHistoryDecision, draftPersonaPreview, editPersonaPreview,
  simulateApproval, getActivePersona
} from '../public/ui-state.mjs';

const brand = {
  businessName: 'Acme Coffee',
  niche: 'Specialty coffee',
  audience: 'Home brewers',
  language: 'English + Malay',
  tone: 'Warm and practical',
  restrictions: 'No invented claims',
  samplePosts: 'Fresh roast today.'
};

function createDraft() {
  let state = createPreviewState();
  state = saveBrandPreview(state, brand);
  state = setHistoryDecision(state, false);
  state = draftPersonaPreview(state);
  return state;
}

test('five-step flow and optional historical analysis default off', () => {
  const state = createPreviewState();
  assert.deepEqual(STEPS, [
    'BRAND_INTAKE', 'HISTORY_IMPORT', 'PERSONA_DRAFT',
    'PERSONA_REVIEW', 'COMPLETE'
  ]);
  assert.equal(state.historyConsent, false);
  assert.equal(state.historyDecisionRecorded, false);
  assert.equal(state.persona, null);
  assert.throws(() => draftPersonaPreview(state), /brand intake/i);
});

test('brand intake validates required values and trims fields', () => {
  assert.throws(() => saveBrandPreview(createPreviewState(), { ...brand, niche: ' ' }), /Niche is required/);
  const state = saveBrandPreview(createPreviewState(), { ...brand, businessName: '  Acme Coffee  ' });
  assert.equal(state.brand.businessName, 'Acme Coffee');
  assert.equal(state.step, 'HISTORY_IMPORT');
});

test('history consent requires explicit decision but never fetches', () => {
  const state = saveBrandPreview(createPreviewState(), brand);
  assert.throws(() => setHistoryDecision(state, 'yes'), /explicit/);
  assert.throws(() => draftPersonaPreview(state), /decision/);
  const opted = setHistoryDecision(state, true);
  assert.equal(opted.historyConsent, true);
  assert.equal(opted.historyDecisionRecorded, true);
  assert.equal(opted.step, 'PERSONA_DRAFT');
});

test('plan selection accepts only Starter or Growth', () => {
  const state = choosePlan(createPreviewState(), 'GROWTH');
  assert.equal(state.plan, 'GROWTH');
  assert.throws(() => choosePlan(state, 'FREE'), /Choose Starter or Growth/);
});

test('draft is explicitly a local template, not a real persona', () => {
  const state = createDraft();
  assert.equal(state.persona.source, 'LOCAL_TEMPLATE');
  assert.equal(state.persona.status, 'DRAFT');
  assert.match(state.persona.summary, /Acme Coffee/);
  assert.equal(state.step, 'PERSONA_REVIEW');
});

test('persona editing increments revision and invalidates simulated approval', () => {
  let state = createDraft();
  state = simulateApproval(state, 1);
  assert.equal(state.step, 'COMPLETE');
  assert.equal(state.persona.status, 'PREVIEW_APPROVED');
  state = editPersonaPreview(state, 1, {
    summary: 'Updated',
    writingStyle: 'Friendly',
    contentPillars: 'Education'
  });
  assert.equal(state.persona.status, 'DRAFT');
  assert.equal(state.persona.revision, 2);
  assert.equal(state.previewApproved, false);
  assert.throws(() => simulateApproval(state, 1), /Stale persona/);
});

test('brand or consent changes reset the draft without resetting revision history', () => {
  let state = createDraft();
  state = saveBrandPreview(state, { ...brand, tone: 'Formal' });
  assert.equal(state.persona, null);
  state = setHistoryDecision(state, false);
  state = draftPersonaPreview(state);
  assert.equal(state.persona.revision, 2);
  state = setHistoryDecision(state, true);
  assert.equal(state.persona, null);
  state = draftPersonaPreview(state);
  assert.equal(state.persona.revision, 3);
});

test('no local preview can resolve as an active production persona', () => {
  const state = simulateApproval(createDraft(), 1);
  assert.equal(state.previewApproved, true);
  assert.throws(getActivePersona, /real persona activation requires authenticated server approval/);
});

test('static interface removes demo endpoints, storage and unsafe HTML interpolation', () => {
  const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const script = readFileSync(new URL('../public/app.mjs', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  const joined = page + script;
  assert.match(page, /LOCAL PREVIEW/);
  assert.match(page, /type="module" src="\.\/app\.mjs"/);
  assert.match(page, /id="brandForm"/);
  assert.match(page, /id="historyForm"/);
  assert.match(page, /id="personaEditForm"/);
  assert.match(css, /max-width:\s*560px/);
  assert.doesNotMatch(joined, /\/api\/|x-postbro-demo-token|demo-session|localStorage|sessionStorage|fetch\s*\(/);
  assert.doesNotMatch(script, /\.innerHTML\s*=/);
});
