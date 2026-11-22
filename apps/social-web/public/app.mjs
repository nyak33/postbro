/* global document */
/**
 * Standalone PostBro Social interface preview.
 * No fetch, storage, login, Meta API, Postiz API or live approvals.
 * The UI model is intentionally separate from the real server domain.
 */
import {
  STEPS, createPreviewState, choosePlan, saveBrandPreview,
  setHistoryDecision, draftPersonaPreview, editPersonaPreview,
  simulateApproval
} from './ui-state.mjs';

let state = createPreviewState();
const $ = (id) => document.getElementById(id);
const names = {
  BRAND_INTAKE: 'Brand intake',
  HISTORY_IMPORT: 'Optional history',
  PERSONA_DRAFT: 'Persona draft',
  PERSONA_REVIEW: 'Persona review',
  COMPLETE: 'Complete'
};

function status(message, isError = false) {
  const notice = $('notice');
  notice.textContent = message;
  notice.classList.toggle('error', isError);
}

function safely(action) {
  try {
    action();
  } catch (error) {
    status(error instanceof Error ? error.message : 'Unable to continue', true);
  }
}

function renderProgress() {
  const target = $('steps');
  const current = STEPS.indexOf(state.step);
  const pills = STEPS.map((name, index) => {
    const pill = document.createElement('span');
    pill.className = 'step' + (index === current ? ' active' : index < current ? ' done' : '');
    pill.textContent = names[name];
    if (index === current) pill.setAttribute('aria-current', 'step');
    return pill;
  });
  target.replaceChildren(...pills);
}

function render({ syncPersonaInputs = false } = {}) {
  $('plan').value = state.plan;
  $('planDescription').textContent = state.plan === 'GROWTH'
    ? 'Growth · 56 unique weekly content pieces.'
    : 'Starter · 35 unique weekly content pieces.';

  $('brandStatus').textContent = state.brand ? 'Saved in preview' : 'Not saved';
  $('saveHistory').disabled = !state.brand;
  $('historyStatus').textContent = state.historyDecisionRecorded
    ? 'Decision recorded · ' + (state.historyConsent ? 'Opted in' : 'No import')
    : 'Optional';
  $('genDraft').disabled = !state.historyDecisionRecorded;
  $('draftStatus').textContent = state.persona
    ? 'Local template draft · revision ' + state.persona.revision
    : 'No preview yet.';

  const p = state.persona;
  $('panelReview').hidden = !p;
  if (p) {
    $('revisionStatus').textContent = p.status === 'PREVIEW_APPROVED'
      ? 'Simulated approval · revision ' + p.revision
      : 'Draft · revision ' + p.revision;
    if (syncPersonaInputs) {
      $('personaSummary').value = p.summary;
      $('personaStyle').value = p.writingStyle;
      $('personaPillars').value = p.contentPillars;
    }
    $('approvePreview').disabled = p.status !== 'DRAFT';
    const traits = p.traits.map((item) => {
      const node = document.createElement('span');
      node.className = 'trait';
      node.textContent = item;
      return node;
    });
    $('traits').replaceChildren(...traits);
  } else {
    $('personaSummary').value = '';
    $('personaStyle').value = '';
    $('personaPillars').value = '';
    $('traits').replaceChildren();
  }

  $('panelComplete').hidden = !state.previewApproved;
  renderProgress();
}

$('plan').addEventListener('change', () => safely(() => {
  state = choosePlan(state, $('plan').value);
  render();
  status('Package selected for this local preview.');
}));

$('brandForm').addEventListener('submit', (event) => {
  event.preventDefault();
  safely(() => {
    const next = saveBrandPreview(state, {
      businessName: $('businessName').value,
      niche: $('niche').value,
      audience: $('audience').value,
      language: $('language').value,
      tone: $('tone').value,
      restrictions: $('restrictions').value,
      samplePosts: $('samplePosts').value
    });
    const changed = next !== state;
    state = next;
    if (changed) $('optedIn').checked = false;
    render();
    status(changed
      ? 'Brand profile saved in memory. Record your optional analysis decision.'
      : 'Brand profile is unchanged.');
  });
});

$('historyForm').addEventListener('submit', (event) => {
  event.preventDefault();
  safely(() => {
    state = setHistoryDecision(state, $('optedIn').checked);
    render();
    status(state.historyConsent
      ? 'Choice noted. No post history has been accessed or imported.'
      : 'Choice noted. You can proceed without importing posts.');
  });
});

$('genDraft').addEventListener('click', () => safely(() => {
  state = draftPersonaPreview(state);
  render({ syncPersonaInputs: true });
  status('A local template preview is ready for review. This is not an AI-generated persona.');
}));

$('personaEditForm').addEventListener('submit', (event) => {
  event.preventDefault();
  safely(() => {
    state = editPersonaPreview(state, state.persona?.revision, {
      summary: $('personaSummary').value,
      writingStyle: $('personaStyle').value,
      contentPillars: $('personaPillars').value
    });
    render({ syncPersonaInputs: true });
    status('Changes saved in this browser tab. Previous simulated approval invalidated.');
  });
});

$('approvePreview').addEventListener('click', () => safely(() => {
  const persona = state.persona;
  if (!persona) throw new Error('Generate a persona preview first');
  if ($('personaSummary').value.trim() !== persona.summary ||
      $('personaStyle').value.trim() !== persona.writingStyle ||
      $('personaPillars').value.trim() !== persona.contentPillars) {
    throw new Error('Save your edits before simulating approval.');
  }
  state = simulateApproval(state, persona.revision);
  render();
  status('Preview complete. No actual persona was approved or activated.');
}));

function clearPreview() {
  state = createPreviewState();
  $('brandForm').reset();
  $('historyForm').reset();
  $('personaEditForm').reset();
  render();
  status('Local preview cleared. Nothing was saved to a server.');
}

$('clearPreview').addEventListener('click', clearPreview);
$('restartPreview').addEventListener('click', clearPreview);

render();
