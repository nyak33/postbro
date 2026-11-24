/**
 * PB-SOCIAL-006D — trusted-only Postiz organization binding.
 *
 * A Postiz group is NOT an org security boundary. Never accept a browser-
 * submitted organization ID as authorization, and never issue Postiz writes
 * without a fresh authenticated /public/v1/me check on the same credential.
 * This file has no public routes, credential storage or Postiz write requests.
 */
import type { Pool } from 'pg';
import { requireUuid } from '../http/tenant-store.js';
import { verifyPostizClientChannels, type PostizReadOnlyTransport, type SocialSurface } from './read-only-preflight.js';
import type { PostizClientMapping, VerifiedPostizIntegration } from './draft-preview.js';

export class PostizOrganizationLinkError extends Error {
  constructor() { super('postiz_organization_link_unavailable'); }
}

const ID = /^[a-zA-Z0-9_-]{3,160}$/;

export interface VerifiedPostizOrganizationLink {
  clientId: string;
  postizInstanceOrigin: string;
  postizOrganizationId: string;
  postizCustomerGroupId: string;
}

export function validatedPostizOrigin(value: unknown): string {
  if (typeof value !== 'string') throw new PostizOrganizationLinkError();
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        url.pathname !== '/' || url.hash || url.search || !url.hostname.includes('.') ||
        url.origin !== value) throw new PostizOrganizationLinkError();
    return url.origin;
  } catch {
    throw new PostizOrganizationLinkError();
  }
}

function identifier(raw: unknown): string {
  if (typeof raw !== 'string' || !ID.test(raw)) {
    throw new PostizOrganizationLinkError();
  }
  return raw;
}

/** Do not call from browser/customer routes: this reads private links via a trusted DB connection. */
export async function loadVerifiedPostizOrganizationLink(
  pool: Pick<Pool, 'connect'>,
  clientId: string,
  expectedInstanceOrigin: string,
): Promise<VerifiedPostizOrganizationLink> {
  requireUuid(clientId);
  const origin = validatedPostizOrigin(expectedInstanceOrigin);
  const db = await pool.connect();
  try {
    const found = await db.query<{
      client_id: string; postiz_instance_origin: string;
      postiz_organization_id: string; postiz_customer_group_id: string;
    }>(
      `SELECT client_id, postiz_instance_origin, postiz_organization_id,
         postiz_customer_group_id
       FROM postbro_social.postiz_organization_links
       WHERE client_id=$1 AND postiz_instance_origin=$2 AND state='VERIFIED'`,
      [clientId, origin]
    );
    const row = found.rows[0];
    if (!row || row.client_id !== clientId ||
        row.postiz_instance_origin !== origin) throw new PostizOrganizationLinkError();
    return {
      clientId,
      postizInstanceOrigin: origin,
      postizOrganizationId: identifier(row.postiz_organization_id),
      postizCustomerGroupId: identifier(row.postiz_customer_group_id),
    };
  } catch {
    throw new PostizOrganizationLinkError();
  } finally {
    db.release();
  }
}

/**
 * Prove that the current authenticated Postiz credential belongs to the
 * expected org. This does NOT prove the logged-in Supabase person owns the org:
 * an operator must separately verify BOTH memberships before provisioning link.
 */
export async function verifyPostizOrganizationIdentity(
  link: VerifiedPostizOrganizationLink,
  configuredPostizOrigin: string,
  transport: PostizReadOnlyTransport,
): Promise<{ organizationId: string }> {
  requireUuid(link.clientId);
  const configuredOrigin = validatedPostizOrigin(configuredPostizOrigin);
  if (validatedPostizOrigin(link.postizInstanceOrigin) !== configuredOrigin ||
      !ID.test(link.postizOrganizationId) || !ID.test(link.postizCustomerGroupId) ||
      typeof transport.me !== 'function') {
    throw new PostizOrganizationLinkError();
  }
  let result: unknown;
  try { result = await transport.me(); }
  catch { throw new PostizOrganizationLinkError(); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new PostizOrganizationLinkError();
  }
  const org = (result as Record<string, unknown>).organization;
  if (!org || typeof org !== 'object' || Array.isArray(org) ||
      (org as Record<string, unknown>).id !== link.postizOrganizationId) {
    throw new PostizOrganizationLinkError();
  }
  return { organizationId: link.postizOrganizationId };
}

/**
 * Trusted worker gate: only a private VERIFIED org link plus fresh Postiz
 * /me, groups and integration reads can produce a tenant-safe draft mapping.
 * This function is never exposed to the browser and never dispatches posts.
 */
export async function verifyPostizClientMappingForWorker(
  pool: Pick<Pool, 'connect'>,
  clientId: string,
  expectedPostizOrigin: string,
  integrationIds: PostizClientMapping['integrationIds'],
  surface: SocialSurface,
  transport: PostizReadOnlyTransport,
): Promise<{ mapping: PostizClientMapping; integrations: VerifiedPostizIntegration[] }> {
  const link = await loadVerifiedPostizOrganizationLink(pool, clientId, expectedPostizOrigin);
  await verifyPostizOrganizationIdentity(link, expectedPostizOrigin, transport);
  const mapping: PostizClientMapping = {
    clientId: link.clientId,
    customerGroupId: link.postizCustomerGroupId,
    integrationIds,
  };
  const integrations = await verifyPostizClientChannels(mapping, surface, transport);
  return { mapping, integrations };
}
