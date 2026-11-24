/**
 * PB-SOCIAL-006C — opt-in OIDC/PKCE client for the isolated Social portal.
 *
 * No IdP settings are changed. Never log codes, bearer tokens, cookie contents,
 * upstream response bodies, or raw configuration. Tokens stay in encrypted,
 * host-only, HttpOnly cookies and are independently verified with Supabase Auth
 * on every tenant API request.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export interface SocialSsoOptions {
  supabaseUrl: string;
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  cookieKey: string; // 32 random bytes encoded as base64url. Server-only.
  fetcher?: typeof fetch;
}

const FLOW_COOKIE = '__Host-pb_social_oauth';
const LOGIN_COOKIE = '__Host-pb_social_login';
const FLOW_LIFETIME_MS = 10 * 60 * 1000;
const LOGIN_LIFETIME_MS = 30 * 60 * 1000;
const URLSAFE = /^[A-Za-z0-9_-]{43}$/;

interface StoredFlow { state: string; verifier: string; expiresAt: number }
interface StoredLogin { accessToken: string; expiresAt: number }

export class SocialSsoError extends Error {
  constructor() { super('sso_unavailable'); }
}

function origin(value: string, path: string): URL {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash ||
      u.port || u.pathname !== path) throw new SocialSsoError();
  return u;
}

export function validateSocialSsoOptions(input: SocialSsoOptions): SocialSsoOptions {
  try {
    const endpoint = origin(input.supabaseUrl, '/');
    if (!/^[a-z0-9]{20}\.supabase\.co$/.test(endpoint.hostname)) throw new Error();
    const callback = new URL(input.callbackUrl);
    if (callback.protocol !== 'https:' || callback.username || callback.password ||
        callback.hash || callback.search || callback.port ||
        callback.pathname !== '/api/social/sso/callback') throw new Error();
    if (!/^[A-Za-z0-9._:-]{6,180}$/.test(input.clientId) ||
        typeof input.clientSecret !== 'string' || input.clientSecret.length < 16) throw new Error();
    if (typeof input.cookieKey !== 'string' || !URLSAFE.test(input.cookieKey) ||
        Buffer.from(input.cookieKey, 'base64url').length !== 32) throw new Error();
    return input;
  } catch {
    throw new SocialSsoError();
  }
}

function cookie(header: string | undefined, name: string): string | null {
  if (typeof header !== 'string' || header.length > 10_000) return null;
  const entries = header.split(';').map(p => p.trim()).filter(p => p.startsWith(name + '='));
  if (entries.length !== 1) return null;
  const value = entries[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{30,4000}$/.test(value) ? value : null;
}

function cookieSet(name: string, value: string, ageSeconds: number): string {
  // __Host- prefix forbids Domain and requires Path=/ and Secure.
  return name + '=' + value + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + ageSeconds;
}

export class SocialSsoBridge {
  private readonly options: SocialSsoOptions;
  private readonly key: Buffer;

  constructor(options: SocialSsoOptions) {
    this.options = validateSocialSsoOptions(options);
    this.key = Buffer.from(options.cookieKey, 'base64url');
  }

  private seal(purpose: string, payload: object): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(purpose));
    const body = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')), cipher.final()
    ]);
    return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64url');
  }

  private unseal(purpose: string, input: string | null): unknown {
    if (!input) return null;
    try {
      const bytes = Buffer.from(input, 'base64url');
      if (bytes.length < 30 || bytes.length > 3000) return null;
      const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(purpose));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const value = Buffer.concat([
        decipher.update(bytes.subarray(28)), decipher.final()
      ]).toString('utf8');
      return JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }

  start(): { redirect: string; cookie: string } {
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
    const authorize = new URL('/auth/v1/oauth/authorize', this.options.supabaseUrl);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', this.options.clientId);
    authorize.searchParams.set('redirect_uri', this.options.callbackUrl);
    authorize.searchParams.set('scope', 'openid email profile');
    authorize.searchParams.set('state', state);
    authorize.searchParams.set('code_challenge', challenge);
    authorize.searchParams.set('code_challenge_method', 'S256');
    const sealed = this.seal(FLOW_COOKIE, {
      state, verifier, expiresAt: Date.now() + FLOW_LIFETIME_MS
    } satisfies StoredFlow);
    return { redirect: authorize.toString(), cookie: cookieSet(FLOW_COOKIE, sealed, 600) };
  }

  clearFlow(): string { return cookieSet(FLOW_COOKIE, '', 0); }
  clearLogin(): string { return cookieSet(LOGIN_COOKIE, '', 0); }

  async callback(query: unknown, cookies: string | undefined): Promise<string> {
    const flow = this.unseal(FLOW_COOKIE, cookie(cookies, FLOW_COOKIE)) as Partial<StoredFlow> | null;
    const p = query && typeof query === 'object' && !Array.isArray(query)
      ? query as Record<string, unknown> : {};
    if (!flow || (typeof flow.expiresAt !== 'number' || !Number.isFinite(flow.expiresAt)) || flow.expiresAt <= Date.now() ||
        typeof flow.state !== 'string' || !URLSAFE.test(flow.state) ||
        typeof flow.verifier !== 'string' || !URLSAFE.test(flow.verifier) ||
        typeof p.state !== 'string' || p.state !== flow.state ||
        typeof p.code !== 'string' || p.code.length < 8 || p.code.length > 2048 ||
        !/^[A-Za-z0-9._~+-]+$/.test(p.code) || p.error !== undefined) {
      throw new SocialSsoError();
    }

    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      code: p.code,
      redirect_uri: this.options.callbackUrl,
      code_verifier: flow.verifier,
    });
    let result: Response;
    try {
      result = await (this.options.fetcher ?? fetch)(
        new URL('/auth/v1/oauth/token', this.options.supabaseUrl),
        { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(6000) }
      );
      if (!result.ok) throw new SocialSsoError();
      const body: unknown = await result.json();
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SocialSsoError();
      const token = (body as Record<string, unknown>).access_token;
      const seconds = (body as Record<string, unknown>).expires_in;
      if (typeof token !== 'string' || token.length < 20 || token.length > 3000 ||
          typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 60) {
        throw new SocialSsoError();
      }
      const expiresAt = Date.now() + Math.min(seconds * 1000 - 30000, LOGIN_LIFETIME_MS);
      const encoded = this.seal(LOGIN_COOKIE, { accessToken: token, expiresAt } satisfies StoredLogin);
      if (encoded.length > 3800) throw new SocialSsoError();
      return cookieSet(LOGIN_COOKIE, encoded, Math.floor((expiresAt - Date.now()) / 1000));
    } catch {
      // Never bubble upstream response bodies, tokens, or HTTP arguments.
      throw new SocialSsoError();
    }
  }

  bearerFromCookie(header: string | undefined): string | null {
    const saved = this.unseal(LOGIN_COOKIE, cookie(header, LOGIN_COOKIE)) as Partial<StoredLogin> | null;
    if (!saved || typeof saved.accessToken !== 'string' ||
        saved.accessToken.length < 20 || saved.accessToken.length > 3000 ||
        (typeof saved.expiresAt !== 'number' || !Number.isFinite(saved.expiresAt)) || saved.expiresAt <= Date.now()) {
      return null;
    }
    return 'Bearer ' + saved.accessToken;
  }
}
