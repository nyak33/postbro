/**
 * PB-SOCIAL-005D: read-only tenant/channel preflight for future Postiz drafts.
 * No POST, PUT, PATCH, DELETE, upload, publish, scheduling or key logging.
 * The caller must provide operator-controlled mappings and secret credentials.
 */
import { requireUuid } from '../http/tenant-store.js';
import type { PostizClientMapping, VerifiedPostizIntegration } from './draft-preview.js';

type Provider = 'threads' | 'facebook' | 'instagram';
export type SocialSurface = 'THREADS' | 'FB_IG';

export class PostizPreflightError extends Error {
  constructor(message = 'postiz_readonly_preflight_failed') { super(message); }
}

export interface PostizReadOnlyTransport {
  groups(): Promise<unknown>;
  integrations(groupId: string): Promise<unknown>;
  /** GET /public/v1/me returns the Postiz organization bound to this API credential. */
  me?(): Promise<unknown>;
}

export type PostizReadFetch = (
  url: string,
  init: {
    method: 'GET';
    redirect: 'error';
    headers: { Authorization: string; Accept: 'application/json' };
    signal: AbortSignal;
  },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

function identifier(value: unknown, minimum = 3): string {
  if (typeof value !== 'string' || value.length < minimum ||
      value.length > 160 || !/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new PostizPreflightError('invalid_postiz_identifier');
  }
  return value;
}

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 1000 ||
      value.some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry))) {
    throw new PostizPreflightError('invalid_postiz_read_response');
  }
  return value as Record<string, unknown>[];
}

/** TLS only, with fixed GET-only paths; never serialize or log credentials. */
export function createPostizReadOnlyTransport(
  apiRoot: string, authorization: string, fetcher: PostizReadFetch,
): PostizReadOnlyTransport {
  let base: URL;
  try { base = new URL(apiRoot); }
  catch { throw new PostizPreflightError('invalid_postiz_api_root'); }
  if (base.protocol !== 'https:' || !!base.username || !!base.password ||
      !!base.search || !!base.hash ||
      !['/', '/public/v1', '/public/v1/'].includes(base.pathname) ||
      !base.hostname.includes('.') ||
      typeof authorization !== 'string' || !authorization.trim() ||
      typeof fetcher !== 'function') {
    throw new PostizPreflightError('invalid_postiz_api_root');
  }
  async function get(path: string): Promise<unknown> {
    const url = new URL('/public/v1/' + path, base.origin);
    try {
      const response = await fetcher(url.href, {
        method: 'GET', redirect: 'error',
        headers: { Authorization: authorization, Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new PostizPreflightError('postiz_read_unavailable');
      return await response.json();
    } catch {
      // No leaking provider headers, response bodies, URLs, or internal errors.
      throw new PostizPreflightError('postiz_read_unavailable');
    }
  }
  return {
    me: () => get('me'),
    groups: () => get('groups'),
    integrations: groupId => get('integrations?group=' +
      encodeURIComponent(identifier(groupId))),
  };
}

/** Only verified, active, group-scoped channel metadata is returned. */
export async function verifyPostizClientChannels(
  mapping: PostizClientMapping,
  surface: SocialSurface,
  transport: PostizReadOnlyTransport,
): Promise<VerifiedPostizIntegration[]> {
  requireUuid(mapping.clientId);
  const groupId = identifier(mapping.customerGroupId);
  if (surface !== 'THREADS' && surface !== 'FB_IG') {
    throw new PostizPreflightError('invalid_postiz_surface');
  }
  const targets: Provider[] = surface === 'THREADS'
    ? ['threads'] : ['facebook', 'instagram'];
  const required = new Map<Provider, string>();
  for (const provider of targets) {
    required.set(provider, identifier(mapping.integrationIds[provider], 8));
  }
  if (new Set(required.values()).size !== required.size) {
    throw new PostizPreflightError('duplicate_postiz_integration');
  }
  const groups = rows(await safeRead(() => transport.groups()));
  if (groups.filter(group => group.id === groupId).length !== 1) {
    throw new PostizPreflightError('postiz_customer_group_missing');
  }
  const fresh = rows(await safeRead(() => transport.integrations(groupId)));
  const matches: VerifiedPostizIntegration[] = [];
  for (const [provider, integrationId] of required.entries()) {
    const selected = fresh.filter(entry => entry.id === integrationId);
    if (selected.length !== 1) {
      throw new PostizPreflightError('unverified_postiz_integration');
    }
    const item = selected[0]!;
    const customer = item.customer;
    if (item.identifier !== provider || item.disabled !== false ||
        !customer || typeof customer !== 'object' || Array.isArray(customer) ||
        (customer as Record<string, unknown>).id !== groupId) {
      throw new PostizPreflightError('unverified_postiz_integration');
    }
    matches.push({
      id: integrationId, identifier: provider, disabled: false,
      customer: { id: groupId },
    });
  }
  return matches;
}

async function safeRead(call: () => Promise<unknown>): Promise<unknown> {
  try { return await call(); }
  catch { throw new PostizPreflightError('postiz_read_unavailable'); }
}
