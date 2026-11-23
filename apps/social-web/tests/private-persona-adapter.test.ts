import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import {
  PrivatePersonaAdapterError,
  createPrivatePersonaCliRunner,
  prepareExternalPersonaDraft,
  type PersonaBrandInput,
  type PersonaCliRunner,
} from '../src/persona/private-cli-adapter.js';

const SESSION = 'session_abcdef1234567890';
const PERSONA = 'persona_abcdef1234567890';

const brand: PersonaBrandInput = {
  businessName: 'Acme Coffee',
  niche: 'Specialty coffee',
  audience: 'Home brewers',
  language: 'English + Malay',
  tone: 'Warm and practical',
  restrictions: 'No invented health or origin claims',
  samplePosts: 'Freshly roasted coffee today.',
};

function mockRunner(
  calls: string[][],
  options: { patchReady?: boolean; corrupt?: string; reject?: boolean } = {},
): PersonaCliRunner {
  return async args => {
    calls.push([...args]);
    const cmd = args[0] + ' ' + args[1];
    if (options.reject) throw new Error('sensitive CLI error: should be redacted');
    if (options.corrupt === cmd) return '{malformed-json';
    if (cmd === 'session create') {
      return JSON.stringify({ session: { id: SESSION } });
    }
    if (cmd === 'session patch') {
      const json = args.indexOf('--json');
      assert.ok(json > 0);
      const patch = JSON.parse(args[json + 1] ?? '{}');
      assert.deepEqual(patch.capabilities, ['content', 'engagement']);
      assert.equal(patch.identity.niche, brand.niche);
      assert.equal(patch.voice.language, brand.language);
      assert.deepEqual(patch.examples, [brand.samplePosts]);
      return JSON.stringify({
        sessionId: SESSION,
        status: { ready: options.patchReady ?? true }
      });
    }
    if (cmd === 'persona finalize') {
      return JSON.stringify({
        persona: {
          schemaVersion: '1.0',
          id: PERSONA,
          version: 1,
          base: {
            identity: { summary: brand.businessName + ' — ' + brand.niche,
              niche: brand.niche, audience: brand.audience },
            capabilities: ['content', 'engagement'],
            voice: { tone: brand.tone, language: brand.language },
            contentBehavior: { style: 'Educational, useful and audience-first content.' },
            engagementBehavior: {},
            examples: [brand.samplePosts]
          },
          contexts: [],
          learnedPreferences: []
        }
      });
    }
    throw new Error('unexpected command: ' + cmd);
  };
}

test('private CLI adapter uses Quick create/patch/finalize and cleans ephemeral files', async () => {
  const calls: string[][] = [];
  const draft = await prepareExternalPersonaDraft(brand, mockRunner(calls));
  assert.equal(draft.source, 'EXTERNAL_ENGINE');
  assert.equal(draft.enginePersonaId, PERSONA);
  assert.equal(draft.engineVersion, 1);
  assert.match(draft.proposal.summary, /Acme Coffee/);
  assert.match(draft.proposal.writingStyle, /English \+ Malay/);
  assert.equal(draft.proposal.contentPillars, brand.niche);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(x => x.slice(0, 2)), [
    ['session', 'create'],
    ['session', 'patch'],
    ['persona', 'finalize']
  ]);
  const dirs = calls.map(args => args[args.indexOf('--data-dir') + 1]);
  assert.ok(dirs.every(x => typeof x === 'string' && x.includes('postbro-persona-')));
  assert.ok(dirs.every(x => x === dirs[0]));
  assert.equal(existsSync(dirs[0] as string), false);
  assert.equal('status' in draft, false);
  assert.equal('approvedAt' in draft, false);
});

test('rejects invalid and oversized brand inputs without invoking private CLI', async () => {
  const calls: string[][] = [];
  for (const invalid of [
    { ...brand, businessName: '' },
    { ...brand, niche: ' ' },
    { ...brand, audience: ''.padEnd(1001, 'x') },
    { ...brand, restrictions: ''.padEnd(1001, 'x') },
    { ...brand, tone: '' },
  ]) {
    await assert.rejects(
      () => prepareExternalPersonaDraft(invalid, mockRunner(calls)),
      PrivatePersonaAdapterError,
    );
  }
  assert.equal(calls.length, 0);
});

test('untrusted CLI errors and malformed output fail closed, with temporary cleanup', async () => {
  for (const options of [
    { reject: true },
    { corrupt: 'session create' },
    { corrupt: 'session patch' },
    { corrupt: 'persona finalize' },
    { patchReady: false },
  ]) {
    const calls: string[][] = [];
    const error = await prepareExternalPersonaDraft(brand, mockRunner(calls, options))
      .then(() => null, err => err);
    assert.ok(error instanceof PrivatePersonaAdapterError);
    assert.equal(error.message, 'Private Persona Engine draft is unavailable');
    const dirs = calls.map(args => args[args.indexOf('--data-dir') + 1])
      .filter((x): x is string => typeof x === 'string');
    assert.ok(dirs.every(d => !existsSync(d)));
  }
});

test('private CLI executable requires an absolute trusted compiled cli.js location', () => {
  for (const location of [
    'cli.js', './dist/src/cli.js', '/tmp/untrusted.js',
    '/tmp/cli.js', '/tmp/other/dist/server.js'
  ]) {
    assert.throws(() => createPrivatePersonaCliRunner(location),
      PrivatePersonaAdapterError);
  }
});

test('concurrent draft generations never share a temporary JSON FileStore', async () => {
  const callsA: string[][] = [];
  const callsB: string[][] = [];
  await Promise.all([
    prepareExternalPersonaDraft(brand, mockRunner(callsA)),
    prepareExternalPersonaDraft(brand, mockRunner(callsB)),
  ]);
  const dirA = callsA[0]?.[callsA[0].indexOf('--data-dir') + 1];
  const dirB = callsB[0]?.[callsB[0].indexOf('--data-dir') + 1];
  assert.ok(dirA && dirB);
  assert.notEqual(dirA, dirB);
  assert.equal(existsSync(dirA), false);
  assert.equal(existsSync(dirB), false);
});
