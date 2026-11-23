/**
 * PB-SOCIAL-005B — strictly offline Postiz DRAFT request builder.
 *
 * No network clients or POST functionality exist in this module.
 * It must be called only after the trusted content approval lookup.
 */
import type { Pool } from 'pg';
import { getTrustedApprovedContent } from '../content/trusted-workflow.js';
import { requireUuid } from '../http/tenant-store.js';

export class PostizPreviewError extends Error {
  constructor(message = 'postiz_draft_preview_unavailable') { super(message); }
}

type Provider = 'threads' | 'facebook' | 'instagram';
export interface VerifiedPostizIntegration {
  id: string;
  identifier: Provider;
  disabled: boolean;
  customer: { id: string } | null;
}

export interface PostizClientMapping {
  clientId: string;
  customerGroupId: string;
  integrationIds: Partial<Record<Provider, string>>;
}

export interface ReadyPostizMedia {
  id: string;
  path: string;
  status: 'ready';
}

export interface PostizCreateDraftPayload {
  type: 'draft';
  date: string;
  shortLink: false;
  tags: [];
  posts: Array<{
    integration: { id: string };
    value: Array<{ content: string; image: Array<{ id: string; path: string }> }>;
    settings: { __type: Provider; post_type?: 'post' };
  }>;
}

function safeId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,160}$/.test(value)) {
    throw new PostizPreviewError('unverified_postiz_integration');
  }
  return value;
}

function checkedMedia(input: readonly ReadyPostizMedia[]) {
  if (input.length > 10) throw new PostizPreviewError('invalid_postiz_media');
  return input.map(item => {
    if (!item || item.status !== 'ready') {
      throw new PostizPreviewError('media_not_ready');
    }
    const id = safeId(item.id);
    let url: URL;
    try {
      url = new URL(item.path);
    } catch {
      throw new PostizPreviewError('invalid_postiz_media');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
        url.port || !url.hostname.includes('.')) {
      throw new PostizPreviewError('invalid_postiz_media');
    }
    return { id, path: url.href };
  });
}

function activeIntegration(
  provider: Provider,
  mapping: PostizClientMapping,
  freshList: readonly VerifiedPostizIntegration[]
): VerifiedPostizIntegration {
  const configuredId = safeId(mapping.integrationIds[provider]);
  const matches = freshList.filter(item => item.id === configuredId);
  if (matches.length !== 1 || matches[0].identifier !== provider ||
      matches[0].disabled !== false ||
      matches[0].customer?.id !== mapping.customerGroupId) {
    throw new PostizPreviewError('unverified_postiz_integration');
  }
  return matches[0];
}

export function buildPostizDraftPreview(
  raw: Record<string, unknown>,
  mapping: PostizClientMapping,
  freshIntegrations: readonly VerifiedPostizIntegration[],
  media: readonly ReadyPostizMedia[] = []
): PostizCreateDraftPayload {
  if (!raw || requireUuid(raw.clientId) !== requireUuid(mapping.clientId) ||
      typeof mapping.customerGroupId !== 'string' ||
      !/^[a-zA-Z0-9_-]{3,160}$/.test(mapping.customerGroupId) ||
      !Array.isArray(freshIntegrations)) {
    throw new PostizPreviewError('postiz_tenant_mapping_invalid');
  }
  const body = raw.body;
  const surface = raw.surface;
  const proposedDate = raw.scheduledFor;
  if (typeof body !== 'string' || body.trim().length < 1 ||
      body.trim().length > 3000 ||
      (surface !== 'THREADS' && surface !== 'FB_IG') ||
      !Number.isSafeInteger(raw.personaRevision) ||
      !Number.isSafeInteger(raw.contentRevision) ||
      typeof proposedDate !== 'string' && !(proposedDate instanceof Date)) {
    throw new PostizPreviewError('invalid_approved_content');
  }
  const when = new Date(proposedDate);
  if (Number.isNaN(when.getTime())) throw new PostizPreviewError('invalid_approved_content');
  const attachments = checkedMedia(media);
  const targets: Provider[] = surface === 'THREADS'
    ? ['threads'] : ['facebook', 'instagram'];
  if (surface === 'THREADS' && body.length > 500) {
    throw new PostizPreviewError('threads_content_too_long');
  }
  if (surface === 'FB_IG' && attachments.length === 0) {
    throw new PostizPreviewError('instagram_requires_media');
  }
  const ids = targets.map(provider => activeIntegration(provider, mapping, freshIntegrations));
  if (new Set(ids.map(x => x.id)).size !== ids.length) {
    throw new PostizPreviewError('duplicate_postiz_integration');
  }

  return {
    type: 'draft',
    date: when.toISOString(),
    shortLink: false,
    tags: [],
    posts: ids.map(target => ({
      integration: { id: target.id },
      value: [{ content: body, image: attachments }],
      settings: target.identifier === 'instagram'
        ? { __type: 'instagram', post_type: 'post' }
        : { __type: target.identifier },
    })),
  };
}

/** DB-gated wrapper: returns ONLY a draft-shaped payload; never calls Postiz. */
export async function previewApprovedPostizDraft(
  pool: Pick<Pool, 'connect'>,
  contentDraftId: string,
  mapping: PostizClientMapping,
  freshIntegrations: readonly VerifiedPostizIntegration[],
  media: readonly ReadyPostizMedia[] = [],
): Promise<PostizCreateDraftPayload> {
  const approved = await getTrustedApprovedContent(pool, contentDraftId);
  if (!approved) throw new PostizPreviewError('content_not_approved');
  return buildPostizDraftPreview(approved, mapping, freshIntegrations, media);
}
