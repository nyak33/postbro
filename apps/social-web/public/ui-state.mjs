/**
 * Pure, browser-safe preview state for the PostBro Social onboarding UI.
 * This is deliberately NOT real authentication, persistence, persona approval,
 * a social API client, or a substitute for the server-side domain service.
 */
export const STEPS = Object.freeze([
  'BRAND_INTAKE', 'HISTORY_IMPORT', 'PERSONA_DRAFT',
  'PERSONA_REVIEW', 'COMPLETE'
]);

export const PLAN_OPTIONS = Object.freeze(['STARTER', 'GROWTH']);

export function createPreviewState() {
  return {
    plan: 'STARTER',
    brand: null,
    historyConsent: false,
    historyDecisionRecorded: false,
    step: 'BRAND_INTAKE',
    persona: null,
    revisionCounter: 0,
    previewApproved: false
  };
}

function clean(value, label, required = true) {
  if (typeof value !== 'string') throw new TypeError(label + ' must be text');
  const result = value.trim();
  if (required && !result) throw new Error(label + ' is required');
  if (result.length > 1000) throw new Error(label + ' is too long');
  return result;
}

export function choosePlan(state, plan) {
  if (!PLAN_OPTIONS.includes(plan)) throw new Error('Choose Starter or Growth');
  return { ...state, plan };
}

export function saveBrandPreview(state, fields) {
  if (!fields || typeof fields !== 'object') throw new Error('Brand details are required');
  const brand = {
    businessName: clean(fields.businessName, 'Business name'),
    niche: clean(fields.niche, 'Niche'),
    audience: clean(fields.audience, 'Audience'),
    language: clean(fields.language, 'Language'),
    tone: clean(fields.tone, 'Tone'),
    restrictions: clean(fields.restrictions || '', 'Restrictions', false),
    samplePosts: clean(fields.samplePosts || '', 'Sample posts', false)
  };
  const changed = JSON.stringify(brand) !== JSON.stringify(state.brand);
  if (!changed) return state;
  return {
    ...state, brand,
    historyConsent: false,
    historyDecisionRecorded: false,
    persona: null,
    previewApproved: false,
    step: 'HISTORY_IMPORT'
  };
}

export function setHistoryDecision(state, consent) {
  if (!state.brand) throw new Error('Complete brand intake first');
  if (typeof consent !== 'boolean') throw new Error('Consent must be explicit');
  const changed = !state.historyDecisionRecorded || state.historyConsent !== consent;
  if (!changed) return state;
  return {
    ...state,
    historyConsent: consent,
    historyDecisionRecorded: true,
    persona: null,
    previewApproved: false,
    step: 'PERSONA_DRAFT'
  };
}

export function draftPersonaPreview(state) {
  if (!state.brand) throw new Error('Complete brand intake first');
  if (!state.historyDecisionRecorded) throw new Error('Record the optional history decision first');
  const b = state.brand;
  const revision = state.revisionCounter + 1;
  return {
    ...state,
    revisionCounter: revision,
    persona: {
      revision,
      status: 'DRAFT',
      source: 'LOCAL_TEMPLATE',
      summary: b.businessName + ' creates ' + b.niche +
        ' content for ' + b.audience + '.',
      writingStyle: b.tone + ' in ' + b.language + '.',
      contentPillars: 'Helpful education, product context, community discussion.',
      traits: [
        'Language: ' + b.language,
        'Tone: ' + b.tone,
        'Audience: ' + b.audience,
        b.restrictions ? 'Avoid: ' + b.restrictions : 'No restrictions specified'
      ]
    },
    previewApproved: false,
    step: 'PERSONA_REVIEW'
  };
}

export function editPersonaPreview(state, expectedRevision, changes) {
  if (!state.persona || state.persona.revision !== expectedRevision) {
    throw new Error('Stale persona revision');
  }
  if (!changes || typeof changes !== 'object') throw new Error('Persona edits are required');
  const revision = state.revisionCounter + 1;
  return {
    ...state,
    revisionCounter: revision,
    persona: {
      ...state.persona,
      summary: clean(changes.summary, 'Summary'),
      writingStyle: clean(changes.writingStyle, 'Writing style'),
      contentPillars: clean(changes.contentPillars, 'Content pillars'),
      revision,
      status: 'DRAFT'
    },
    previewApproved: false,
    step: 'PERSONA_REVIEW'
  };
}

export function simulateApproval(state, expectedRevision) {
  if (!state.persona || state.persona.revision !== expectedRevision) {
    throw new Error('Stale persona revision');
  }
  if (state.persona.status !== 'DRAFT') throw new Error('Already reviewed');
  return {
    ...state,
    persona: { ...state.persona, status: 'PREVIEW_APPROVED' },
    previewApproved: true,
    step: 'COMPLETE'
  };
}

export function getActivePersona() {
  throw new Error('Preview-only: real persona activation requires authenticated server approval');
}
