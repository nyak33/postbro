/**
 * First-party OAuth authorization UI for the PostBro Social pilot.
 * Supabase is the issuer. This module is not an OAuth server.
 * Opt-in only; no customer self-signup or DB writes.
 * Short-lived IdP sessions are held in a bounded process-local map; browser
 * receives only an opaque host-only cookie. Restart requires reauthentication.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { verifySocialIdentity, type SupabaseAuthOptions } from '../security/supabase-auth.js';

export interface ConsentOptions {
  origin: string;
  clients: Array<{ id: string; name: string; redirectUri: string }>;
  pilotEmails: string[];
}

const COOKIE = '__Host-pb_idp';
const ID = /^[A-Za-z0-9_-]{16,180}$/;
const EMAIL = /^[^\s@]{1,128}@[^\s@]{1,190}$/;
const HANDLE = /^[A-Za-z0-9_-]{43}$/;
const SCOPES = new Set(['openid', 'email', 'profile']);
const TTL = 30 * 60 * 1000;
const error = () => new Error('invalid_consent_configuration');
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error();
  return value as Record<string, unknown>;
}
function validUrl(raw: unknown): URL {
  if (typeof raw !== 'string') throw error();
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      url.hash || url.search || !url.hostname.includes('.')) throw error();
  return url;
}
export function validateConsentOptions(options: ConsentOptions): ConsentOptions {
  try {
    const url = validUrl(options.origin);
    if (url.origin !== options.origin || !Array.isArray(options.clients) ||
        options.clients.length < 1 || options.clients.length > 4 ||
        !Array.isArray(options.pilotEmails) || !options.pilotEmails.length ||
        options.pilotEmails.length > 20) throw error();
    const clients = options.clients.map(input => {
      const row = object(input);
      const redirect = validUrl(row.redirectUri);
      if (typeof row.id !== 'string' || !ID.test(row.id) ||
          typeof row.name !== 'string' || !row.name.trim() || row.name.length > 80 ||
          redirect.href !== row.redirectUri ||
          !['/settings', '/api/social/sso/callback'].includes(redirect.pathname)) throw error();
      return { id: row.id, name: row.name, redirectUri: redirect.href };
    });
    const emails = options.pilotEmails.map(email => {
      if (typeof email !== 'string' || !EMAIL.test(email) || email.length > 320) throw error();
      return email.toLowerCase();
    });
    if (new Set(clients.map(c => c.id)).size !== clients.length ||
        new Set(clients.map(c => c.redirectUri)).size !== clients.length) throw error();
    return { origin: url.origin, clients, pilotEmails: emails };
  } catch { throw error(); }
}
export function parseConsentEnv(env: NodeJS.ProcessEnv): ConsentOptions | undefined {
  const flag = env.SOCIAL_PRELAUNCH_CONSENT_ENABLED;
  if (!flag || flag === 'false') return undefined;
  if (flag !== 'true') throw error();
  try {
    return validateConsentOptions({
      origin: env.SOCIAL_PRELAUNCH_CONSENT_ORIGIN ?? '',
      clients: JSON.parse(env.SOCIAL_PRELAUNCH_CONSENT_CLIENTS_JSON ?? '[]'),
      pilotEmails: (env.SOCIAL_PRELAUNCH_CONSENT_PILOT_EMAILS ?? '').split(',').map(e => e.trim())
    });
  } catch { throw error(); }
}
function readHandle(req: FastifyRequest): string | undefined {
  const h = req.headers.cookie;
  if (typeof h !== 'string' || h.length > 10000) return;
  const matches = h.split(';').map(s => s.trim()).filter(s => s.startsWith(COOKIE + '='));
  if (matches.length !== 1) return;
  const value = matches[0]!.slice(COOKIE.length + 1);
  return HANDLE.test(value) ? value : undefined;
}
function setCookie(reply: FastifyReply, value: string, age: number) {
  reply.header('set-cookie', COOKIE + '=' + value +
    '; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=' + age);
}

type Session = { token: string; userId: string; expiresAt: number };
type Pending = { handle: string; uri: string; expiresAt: number };

export function registerConsentRoutes(app: FastifyInstance, auth: SupabaseAuthOptions,
    options: ConsentOptions, publicDir: string): void {
  const config = validateConsentOptions(options);
  const sessions = new Map<string, Session>();
  const pending = new Map<string, Pending>();
  const sends = new Map<string, number>();
  const attempts = new Map<string, { count: number; until: number }>();
  function sweep() {
    const now = Date.now();
    for (const [id, s] of sessions) if (s.expiresAt <= now) sessions.delete(id);
    for (const [id, p] of pending) if (p.expiresAt <= now) pending.delete(id);
  }
  function safeRedirect(value: unknown, expected?: string): string {
    if (typeof value !== 'string' || value.length > 5000) throw error();
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port) throw error();
    const target = url.origin + url.pathname;
    if (!config.clients.some(c => c.redirectUri === target) ||
        (expected && target !== expected)) throw error();
    const keys = [...url.searchParams.keys()];
    if (url.searchParams.has('code') === url.searchParams.has('error') ||
        keys.some(key => !['code', 'state', 'error', 'error_description', 'error_uri'].includes(key)) ||
        new Set(keys).size !== keys.length) throw error();
    return url.href;
  }
  async function upstream(endpoint: string, method: 'GET' | 'POST', token?: string,
      payload?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      apikey: auth.publishableKey, accept: 'application/json',
      'content-type': 'application/json', origin: config.origin,
      referer: config.origin + '/oauth/consent',
      ...(token ? { authorization: 'Bearer ' + token } : {})
    };
    try {
      const response = await (auth.fetcher ?? fetch)(new URL('/auth/v1/' + endpoint, auth.url), {
        method, headers, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(8000),
        ...(payload ? { body: JSON.stringify(payload) } : {})
      });
      if (!response.ok) throw error();
      return object(await response.json());
    } catch { throw error(); }
  }
  async function session(req: FastifyRequest) {
    sweep();
    const handle = readHandle(req);
    const found = handle ? sessions.get(handle) : undefined;
    if (!handle || !found) return null;
    try {
      const user = await verifySocialIdentity('Bearer ' + found.token, auth);
      if (user.userId !== found.userId) throw error();
      return { handle, ...found };
    } catch { sessions.delete(handle); return null; }
  }
  function guarded(req: FastifyRequest, reply: FastifyReply): boolean {
    if (req.headers.origin !== config.origin ||
        !req.headers['content-type']?.startsWith('application/json')) {
      reply.code(403).send({ error: 'invalid_origin' }); return false;
    }
    return true;
  }
  function requestId(data: Record<string, unknown>): string {
    if (typeof data.authorizationId !== 'string' || !ID.test(data.authorizationId)) throw error();
    return data.authorizationId;
  }
  app.get('/oauth/consent', async (_req, reply) => {
    reply.header('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    return reply.type('text/html; charset=utf-8').send(readFileSync(path.join(publicDir, 'consent.html')));
  });
  app.get('/oauth/consent.mjs', async (_req, reply) =>
    reply.type('text/javascript; charset=utf-8').send(readFileSync(path.join(publicDir, 'consent.mjs'))));
  app.post('/api/social/consent/otp', async (req, reply) => {
    if (!guarded(req, reply)) return;
    const data = object(req.body); requestId(data);
    const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
    // Always return the same answer, even if an address is not on the pilot allowlist.
    if (config.pilotEmails.includes(email) && (sends.get(email) ?? 0) <= Date.now()) {
      sends.set(email, Date.now() + 60000);
      try { await upstream('otp', 'POST', undefined, { email, create_user: false }); }
      catch { /* No upstream bodies or account enumeration. */ }
    }
    return { accepted: true };
  });
  app.post('/api/social/consent/verify', async (req, reply) => {
    if (!guarded(req, reply)) return;
    const data = object(req.body); requestId(data);
    const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
    if (!config.pilotEmails.includes(email) || typeof data.code !== 'string' ||
        !/^[0-9]{6,8}$/.test(data.code)) return reply.code(401).send({ error: 'sign_in_failed' });
    const prior = attempts.get(email);
    const next = prior && prior.until > Date.now() ? prior : { count: 0, until: Date.now() + 600000 };
    if (next.count >= 5) return reply.code(429).send({ error: 'try_later' });
    next.count++; attempts.set(email, next);
    try {
      const result = await upstream('verify', 'POST', undefined, { type: 'email', email, token: data.code });
      if (typeof result.access_token !== 'string' || result.access_token.length < 20 ||
          result.access_token.length > 4096 || typeof result.expires_in !== 'number' ||
          !Number.isFinite(result.expires_in) || result.expires_in < 60) throw error();
      const user = await verifySocialIdentity('Bearer ' + result.access_token, auth);
      const maxAge = Math.min(TTL, result.expires_in * 1000 - 30000);
      sweep();
      const old = readHandle(req); if (old) sessions.delete(old);
      if (sessions.size >= 64) throw error();
      const handle = randomBytes(32).toString('base64url');
      sessions.set(handle, { token: result.access_token, userId: user.userId, expiresAt: Date.now() + maxAge });
      attempts.delete(email);
      setCookie(reply, handle, Math.floor(maxAge / 1000));
      return { authenticated: true };
    } catch { return reply.code(401).send({ error: 'sign_in_failed' }); }
  });
  app.post('/api/social/consent/details', async (req, reply) => {
    if (!guarded(req, reply)) return;
    const id = requestId(object(req.body));
    const current = await session(req);
    if (!current) return reply.code(401).send({ error: 'sign_in_required' });
    const data = await upstream('oauth/authorizations/' + id, 'GET', current.token);
    if (typeof data.redirect_url === 'string' && data.authorization_id === undefined) {
      return { redirect: safeRedirect(data.redirect_url) };
    }
    const client = object(data.client); const user = object(data.user);
    const known = config.clients.find(c => c.id === client.id && c.redirectUri === data.redirect_uri);
    const scopes = typeof data.scope === 'string' ? data.scope.trim().split(/\s+/) : [];
    if (data.authorization_id !== id || user.id !== current.userId || !known ||
        !scopes.length || !scopes.every(scope => SCOPES.has(scope))) throw error();
    if (!pending.has(id) && pending.size >= 128) throw error();
    pending.set(id, { handle: current.handle, uri: known.redirectUri, expiresAt: Date.now() + 300000 });
    return { app: known.name, scopes };
  });
  app.post('/api/social/consent/decision', async (req, reply) => {
    if (!guarded(req, reply)) return;
    const data = object(req.body); const id = requestId(data);
    const current = await session(req);
    if (!current) return reply.code(401).send({ error: 'sign_in_required' });
    const item = pending.get(id);
    if (!item || item.handle !== current.handle || item.expiresAt <= Date.now() ||
        (data.action !== 'approve' && data.action !== 'deny')) throw error();
    // Consume before the upstream action; no automatic retry after ambiguity.
    pending.delete(id);
    const result = await upstream('oauth/authorizations/' + id + '/consent', 'POST', current.token, { action: data.action });
    return { redirect: safeRedirect(result.redirect_url, item.uri) };
  });
  app.post('/api/social/consent/logout', async (req, reply) => {
    if (!guarded(req, reply)) return;
    const handle = readHandle(req); if (handle) sessions.delete(handle);
    setCookie(reply, '', 0); return reply.code(204).send();
  });
  app.addHook('onClose', async () => { sessions.clear(); pending.clear(); sends.clear(); attempts.clear(); });
}
