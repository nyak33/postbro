import assert from 'node:assert/strict';
import { test } from 'node:test';

// A tiny DOM contract fake: exercises the real browser controller without
// installing a browser framework or touching the network.
function element() {
  const handlers = new Map();
  return {
    value: '',
    textContent: '',
    className: '',
    hidden: false,
    disabled: false,
    children: [],
    handlers,
    classList: { toggle() {} },
    setAttribute() {},
    replaceChildren(...children) { this.children = children; },
    addEventListener(type, fn) { handlers.set(type, fn); },
    reset() {}
  };
}

test('real UI controller preserves unsaved edits and requires saving before approval', async () => {
  const elements = new Map();
  globalThis.document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    createElement() { return element(); }
  };
  const $ = (id) => globalThis.document.getElementById(id);
  const fire = (id, type) => {
    const fn = $(id).handlers.get(type);
    assert.ok(fn, 'handler for ' + id + ' / ' + type);
    fn({ preventDefault() {} });
  };

  try {
    await import('../public/app.mjs');
    const values = {
      businessName: 'Acme',
      niche: 'Coffee',
      audience: 'Home brewers',
      language: 'English',
      tone: 'Warm',
      restrictions: 'No fake claims',
      samplePosts: 'Fresh coffee today'
    };
    for (const [key, value] of Object.entries(values)) $(key).value = value;

    fire('brandForm', 'submit');
    assert.equal($('saveHistory').disabled, false);
    assert.match($('notice').textContent, /Brand profile saved/);

    fire('historyForm', 'submit');
    assert.equal($('genDraft').disabled, false);

    fire('genDraft', 'click');
    assert.equal($('panelReview').hidden, false);
    const original = $('personaSummary').value;
    assert.match(original, /Acme/);

    $('personaSummary').value = 'An improved summary not yet saved';
    $('plan').value = 'GROWTH';
    fire('plan', 'change');
    assert.equal($('personaSummary').value, 'An improved summary not yet saved');

    fire('approvePreview', 'click');
    assert.match($('notice').textContent, /Save your edits/);
    assert.equal($('panelComplete').hidden, true);

    fire('personaEditForm', 'submit');
    assert.match($('revisionStatus').textContent, /revision 2/);
    fire('approvePreview', 'click');
    assert.equal($('panelComplete').hidden, false);
    assert.match($('notice').textContent, /No actual persona/);

    fire('clearPreview', 'click');
    assert.equal($('panelComplete').hidden, true);
    assert.equal($('panelReview').hidden, true);
  } finally {
    delete globalThis.document;
  }
});
