/**
 * PB-SOCIAL-004B: an isolated, testable adapter to the separately installed
 * PRIVATE Persona Engine CLI. No private source is copied into PostBro.
 *
 * This is not a web route and cannot activate personas or publish content.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_CLI_OUTPUT = 256_000;

export class PrivatePersonaAdapterError extends Error {
  constructor() {
    super('Private Persona Engine draft is unavailable');
  }
}

export interface PersonaBrandInput {
  businessName: string;
  niche: string;
  audience: string;
  language: string;
  tone: string;
  restrictions: string;
  samplePosts?: string;
}

export interface SafeExternalPersonaDraft {
  source: 'EXTERNAL_ENGINE';
  proposal: {
    summary: string;
    writingStyle: string;
    contentPillars: string;
  };
  // Stored only by a future privileged worker; NEVER return this to clients.
  engineRecord: Record<string, unknown>;
  enginePersonaId: string;
  engineVersion: number;
}

export type PersonaCliRunner = (args: readonly string[]) => Promise<string>;

function ensureText(value: unknown, max: number, required = true): string {
  if (typeof value !== 'string') throw new PrivatePersonaAdapterError();
  const cleaned = value.trim();
  if (cleaned.length > max || (required && cleaned.length === 0)) {
    throw new PrivatePersonaAdapterError();
  }
  return cleaned;
}

function validatedBrand(raw: PersonaBrandInput) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PrivatePersonaAdapterError();
  }
  return {
    businessName: ensureText(raw.businessName, 200),
    niche: ensureText(raw.niche, 1000),
    audience: ensureText(raw.audience, 1000),
    language: ensureText(raw.language, 1000),
    tone: ensureText(raw.tone, 1000),
    restrictions: ensureText(raw.restrictions, 1000, false),
    samplePosts: ensureText(raw.samplePosts ?? '', 1000, false),
  };
}

function parseObject(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Raw provider/CLI errors must never be propagated.
  }
  throw new PrivatePersonaAdapterError();
}

function mustObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PrivatePersonaAdapterError();
  }
  return raw as Record<string, unknown>;
}

function strictSessionId(obj: Record<string, unknown>): string {
  const session = mustObject(obj.session);
  const id = session.id;
  if (typeof id !== 'string' ||
      !/^session_[a-zA-Z0-9_-]{8,128}$/.test(id)) {
    throw new PrivatePersonaAdapterError();
  }
  return id;
}

/** Safe only for trusted server-side configuration, never arbitrary user paths. */
export function createPrivatePersonaCliRunner(cliPath: string): PersonaCliRunner {
  if (!path.isAbsolute(cliPath) || path.basename(cliPath) !== 'cli.js' ||
      !cliPath.endsWith(path.join('dist', 'src', 'cli.js'))) {
    throw new PrivatePersonaAdapterError();
  }

  return async (args: readonly string[]): Promise<string> => {
    // No shell, no inherited provider API secrets or env files.
    try {
      const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], {
        shell: false,
        windowsHide: true,
        timeout: 12_000,
        maxBuffer: MAX_CLI_OUTPUT,
        env: { NODE_ENV: 'production' },
      });
      return stdout;
    } catch {
      throw new PrivatePersonaAdapterError();
    }
  };
}

/**
 * Convert brand intake into the private engine's Quick PersonaPatch contract.
 * The engine does not invoke an LLM; this is structured persona compilation,
 * not a generated commercial content strategy or an approved active persona.
 */
export async function prepareExternalPersonaDraft(
  rawBrand: PersonaBrandInput,
  runner: PersonaCliRunner,
): Promise<SafeExternalPersonaDraft> {
  const brand = validatedBrand(rawBrand);
  const summary = ensureText(`${brand.businessName} — ${brand.niche}`, 1000);
  const writingStyle = ensureText(`${brand.tone} (${brand.language})`, 1000);
  const contentPillars = ensureText(brand.niche, 1000);

  // mkdtemp creates a private unique location. Each call is isolated from
  // other clients, and state is deleted even after a CLI exception.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'postbro-persona-'));
  try {
    const created = parseObject(await runner([
      'session', 'create', '--name', brand.businessName,
      '--mode', 'quick', '--data-dir', dir
    ]));
    const sessionId = strictSessionId(created);

    const patch = {
      identity: {
        summary,
        niche: brand.niche,
        audience: brand.audience,
      },
      capabilities: ['content', 'engagement'],
      voice: { language: brand.language, tone: brand.tone },
      contentBehavior: {
        style: 'Educational, useful and audience-first content.'
      },
      boundaries: brand.restrictions,
      examples: brand.samplePosts ? [brand.samplePosts] : [],
    };

    const patched = parseObject(await runner([
      'session', 'patch', sessionId, '--json',
      JSON.stringify(patch), '--data-dir', dir
    ]));
    if (patched.sessionId !== sessionId ||
        mustObject(patched.status).ready !== true) {
      throw new PrivatePersonaAdapterError();
    }

    const finalized = parseObject(await runner([
      'persona', 'finalize', sessionId, '--data-dir', dir
    ]));
    const persona = mustObject(finalized.persona);
    const base = mustObject(persona.base);
    const identity = mustObject(base.identity);
    const voice = mustObject(base.voice);
    mustObject(base.contentBehavior);
    mustObject(base.engagementBehavior);
    if (!Array.isArray(base.capabilities) ||
        !base.capabilities.includes('content') ||
        !base.capabilities.includes('engagement') ||
        !Array.isArray(base.examples) ||
        !Array.isArray(persona.contexts) ||
        !Array.isArray(persona.learnedPreferences)) {
      throw new PrivatePersonaAdapterError();
    }
    if (persona.schemaVersion !== '1.0' ||
        typeof persona.id !== 'string' ||
        !/^persona_[a-zA-Z0-9_-]{8,128}$/.test(persona.id) ||
        !Number.isSafeInteger(persona.version) ||
        (persona.version as number) < 1 ||
        identity.summary !== summary ||
        identity.niche !== brand.niche ||
        identity.audience !== brand.audience ||
        voice.tone !== brand.tone ||
        voice.language !== brand.language) {
      throw new PrivatePersonaAdapterError();
    }

    return {
      source: 'EXTERNAL_ENGINE',
      proposal: { summary, writingStyle, contentPillars },
      engineRecord: structuredClone(persona),
      enginePersonaId: persona.id,
      engineVersion: persona.version as number,
    };
  } catch {
    throw new PrivatePersonaAdapterError();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
