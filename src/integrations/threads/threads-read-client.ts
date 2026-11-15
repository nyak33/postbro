/**
 * PB-P1 (slice): READ-ONLY Threads media/replies API client.
 *
 * Interim adapter per ADR-001: lives at src/integrations/threads/ until the
 * phased npm-workspaces migration moves it to packages/threads. Existing
 * src/ layout and runtime stay untouched.
 *
 * Scope (smallest meaningful read-only transport):
 * - GET /v1.0/me/threads?fields=...&limit=N        (own threads, eligibility)
 * - GET /v1.0/{id}/replies?fields=...&limit=N      (replies to one owned root)
 * - GET /v1.0/me/replies?fields=...&limit=N        (own replies)
 * NO POST/write methods. NO HTTP routes. NO DB access. No pagination
 * following in this slice (first page only; cursor handling lands with the
 * account-scoped ingestion task that owns safety review of multi-page reads).
 *
 * Security contract (mirrors oauth-client-http.ts):
 * - Transport is INJECTED (HttpTransport); tests never perform network I/O.
 * - Fixed allowlisted host https://graph.threads.net; redirects never
 *   followed (fetch transport uses redirect:'manual' and fails closed).
 * - Token travels ONLY in the Authorization header (Bearer); never as an
 *   access_token URL parameter, so request URLs carry no secrets.
 * - Bounded timeout, response body cap, and limit (1..100 per Meta docs).
 * - Media IDs are validated to safe numeric-string form before being placed
 *   in a URL path; anything else fails closed without a network call.
 * - Provider errors are sanitized: no response body text, URLs, tokens or
 *   account content in thrown errors or logs. Numeric Meta diagnostics only.
 * - This client NEVER marks scopes verified. Effective read capability was
 *   smoke-observed (see docs/tasks/PB-P1-threads-read-client.md) but granted
 *   scopes remain { verified: false, scopes: [] } — capability is checked
 *   per call by the provider response, never presumed.
 */

import {
  THREADS_API_VERSION,
  THREADS_GRAPH_ORIGIN,
  THREADS_HTTP_MAX_BODY_BYTES,
  THREADS_HTTP_TIMEOUT_MS,
  type HttpTransport,
  type HttpTransportRequest,
  fetchHttpTransport,
  ThreadsHttpTransportError,
} from './oauth-client-http';
import {
  ThreadsOAuthError,
  ThreadsOAuthProviderError,
  type ThreadsOAuthErrorKind,
} from './oauth-client';

export const THREADS_READ_MAX_LIMIT = 100;
export const THREADS_READ_DEFAULT_LIMIT = 25;

/** Bounds for transport overrides; invalid values fail closed to defaults. */
export const THREADS_READ_MIN_TIMEOUT_MS = 1_000;
export const THREADS_READ_MAX_TIMEOUT_MS = 30_000;
export const THREADS_READ_MIN_BODY_BYTES = 1024;
export const THREADS_READ_MAX_BODY_BYTES = 1024 * 1024;

/** Fields requested for own threads (GET /me/threads). */
export const ME_THREADS_FIELDS = 'id,has_replies,timestamp,permalink';
/**
 * Fields requested for replies (GET /{id}/replies and GET /me/replies).
 * replied_to / root_post / is_reply_owned_by_me are included where Meta
 * supports them; absent/uncertain ownership fields fail closed (undefined).
 */
export const REPLY_FIELDS =
  'id,text,timestamp,permalink,replied_to,root_post,is_reply_owned_by_me';

/** One owned thread (post) as returned by GET /me/threads. */
export interface ThreadsMediaSummary {
  id: string;
  hasReplies?: boolean;
  /** ISO-8601 timestamp string from the provider, kept verbatim. */
  timestamp?: string;
  permalink?: string;
}

/** One reply as returned by the replies endpoints. */
export interface ThreadsReplySummary {
  id: string;
  /** Reply text is UNTRUSTED third-party content; never logged. */
  text?: string;
  timestamp?: string;
  permalink?: string;
  /** Provider media id of the parent this reply replied to, when present. */
  repliedToId?: string;
  /** Provider media id of the conversation root, when present. */
  rootPostId?: string;
  /**
   * Provider-reported ownership flag. undefined when Meta did not return it
   * or returned an unusable value — callers must treat undefined as
   * "ownership unknown" and fail closed (never assume ownership).
   */
  isReplyOwnedByMe?: boolean;
}

/** First page of a read-only listing. */
export interface ThreadsReadPage<T> {
  items: T[];
  /**
   * true when the provider returned a paging.cursors.after token. This slice
   * does NOT follow cursors; the flag exists so the future ingestion task
   * knows more pages exist. Never contains the cursor value itself.
   */
  hasNextPage: boolean;
}

export interface ThreadsReadClientOptions {
  /** Injected transport; defaults to the production fetch transport. */
  transport?: HttpTransport;
  timeoutMs?: number;
  maxBodyBytes?: number;
}

/**
 * Read-only Threads media/replies client. The access token is supplied per
 * call by the caller (sourced from the existing secure stored account
 * token); the client holds no token state and there is NO env-based token.
 */
export class ThreadsReadClient {
  private readonly transport: HttpTransport;
  private readonly timeoutMs: number;
  private readonly maxBodyBytes: number;

  constructor(options: ThreadsReadClientOptions = {}) {
    this.transport = options.transport ?? fetchHttpTransport;
    this.timeoutMs = clampTimeoutMs(options.timeoutMs);
    this.maxBodyBytes = clampMaxBodyBytes(options.maxBodyBytes);
  }

  /** GET /v1.0/me/threads — the caller-owned account's threads. */
  async listOwnThreads(
    accessToken: string,
    limit: number = THREADS_READ_DEFAULT_LIMIT,
  ): Promise<ThreadsReadPage<ThreadsMediaSummary>> {
    const url = this.buildUrl(`${THREADS_API_VERSION}/me/threads`, ME_THREADS_FIELDS, limit);
    const body = await this.getJson(accessToken, url);
    const items = this.parseDataArray(body).map(parseMediaSummary).filter(nonNull);
    return { items, hasNextPage: detectNextPage(body) };
  }

  /**
   * GET /v1.0/{mediaId}/replies — replies to one owned root thread.
   * mediaId must be a numeric-string provider ID previously returned by
   * listOwnThreads for THIS account; anything else fails closed.
   */
  async listRepliesForMedia(
    accessToken: string,
    mediaId: string,
    limit: number = THREADS_READ_DEFAULT_LIMIT,
  ): Promise<ThreadsReadPage<ThreadsReplySummary>> {
    if (!isSafeMediaId(mediaId)) {
      throw new ThreadsOAuthError('mediaId must be a numeric provider id');
    }
    const url = this.buildUrl(`${THREADS_API_VERSION}/${mediaId}/replies`, REPLY_FIELDS, limit);
    const body = await this.getJson(accessToken, url);
    const items = this.parseDataArray(body).map(parseReplySummary).filter(nonNull);
    return { items, hasNextPage: detectNextPage(body) };
  }

  /** GET /v1.0/me/replies — the caller-owned account's own replies. */
  async listOwnReplies(
    accessToken: string,
    limit: number = THREADS_READ_DEFAULT_LIMIT,
  ): Promise<ThreadsReadPage<ThreadsReplySummary>> {
    const url = this.buildUrl(`${THREADS_API_VERSION}/me/replies`, REPLY_FIELDS, limit);
    const body = await this.getJson(accessToken, url);
    const items = this.parseDataArray(body).map(parseReplySummary).filter(nonNull);
    return { items, hasNextPage: detectNextPage(body) };
  }

  private buildUrl(path: string, fields: string, limit: number): string {
    const safeLimit = normalizeLimit(limit);
    const url = new URL(`${THREADS_GRAPH_ORIGIN}/${path}`);
    url.searchParams.set('fields', fields);
    url.searchParams.set('limit', String(safeLimit));
    return url.toString();
  }

  /** Perform one sanitized GET and return the parsed body on HTTP 200. */
  private async getJson(accessToken: string, url: string): Promise<Record<string, unknown>> {
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new ThreadsOAuthProviderError('revoked', 'access token must be non-empty');
    }
    const res = await this.request({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (res.status !== 200) {
      throw providerRejectionError(res.status, res.body, 'provider rejected the read request');
    }
    const parsed = parseJsonObject(res.body);
    if (!parsed) {
      throw new ThreadsOAuthProviderError('unknown', 'provider returned malformed JSON', {
        failureReason: 'malformed_response',
      });
    }
    return parsed;
  }

  /**
   * data must be a PRESENT array; a missing property or non-array value
   * (including Meta-style HTTP-200 error envelopes) fails closed as
   * malformed — zero replies is ONLY a valid explicit `data: []`.
   */
  private parseDataArray(body: Record<string, unknown>): Record<string, unknown>[] {
    const data = body['data'];
    if (!Array.isArray(data)) {
      throw new ThreadsOAuthProviderError('unknown', 'provider returned malformed JSON', {
        failureReason: 'malformed_response',
      });
    }
    return data.filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === 'object' && entry !== null && !Array.isArray(entry),
    );
  }

  private async request(req: {
    method: 'GET';
    url: string;
    headers: Record<string, string>;
  }): Promise<{ status: number; body: string }> {
    // Enforce the fixed allowlisted origin at the boundary.
    if (new URL(req.url).origin !== THREADS_GRAPH_ORIGIN) {
      throw new ThreadsOAuthError('refusing to call non-allowlisted Threads host');
    }
    const transportReq: HttpTransportRequest = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      timeoutMs: this.timeoutMs,
      maxBodyBytes: this.maxBodyBytes,
    };
    try {
      return await this.transport(transportReq);
    } catch (error) {
      if (error instanceof ThreadsHttpTransportError) {
        const kind: ThreadsOAuthErrorKind =
          error.reason === 'timeout' ? 'provider_unavailable' : 'unknown';
        throw new ThreadsOAuthProviderError(kind, 'provider request failed', {
          failureReason: error.reason,
        });
      }
      throw new ThreadsOAuthProviderError('provider_unavailable', 'provider request failed');
    }
  }
}

// --- parsing helpers (conservative, fail closed) ----------------------------

function nonNull<T>(value: T | null): value is T {
  return value !== null;
}

function isSafeMediaId(value: string): boolean {
  // Meta media IDs are numeric strings; reject anything else before it
  // reaches a URL path (no traversal, no injection).
  return typeof value === 'string' && /^[0-9]{1,32}$/.test(value);
}

/**
 * Bounded timeout override: absent or invalid (non-integer, non-finite)
 * values fail closed to the shared default; valid values are clamped to
 * [THREADS_READ_MIN_TIMEOUT_MS, THREADS_READ_MAX_TIMEOUT_MS] so a caller can
 * never make provider reads unbounded.
 */
function clampTimeoutMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return THREADS_HTTP_TIMEOUT_MS;
  return Math.min(Math.max(Math.floor(value), THREADS_READ_MIN_TIMEOUT_MS), THREADS_READ_MAX_TIMEOUT_MS);
}

/** Bounded body-cap override; same fail-closed/clamped policy as the timeout. */
function clampMaxBodyBytes(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return THREADS_HTTP_MAX_BODY_BYTES;
  return Math.min(Math.max(Math.floor(value), THREADS_READ_MIN_BODY_BYTES), THREADS_READ_MAX_BODY_BYTES);
}

function normalizeLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1) return THREADS_READ_DEFAULT_LIMIT;
  return Math.min(limit, THREADS_READ_MAX_LIMIT);
}

function optString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return undefined;
}

function optBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function parseJsonObject(body: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return undefined;
}

/** Entries without a usable id are dropped (never synthesized). */
function parseMediaSummary(entry: Record<string, unknown>): ThreadsMediaSummary | null {
  const id = optId(entry['id']);
  if (!id) return null;
  const hasReplies = optBoolean(entry['has_replies']);
  const timestamp = optString(entry['timestamp']);
  const permalink = optString(entry['permalink']);
  return {
    id,
    ...(hasReplies !== undefined ? { hasReplies } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(permalink !== undefined ? { permalink } : {}),
  };
}

/** Entries without a usable id are dropped; uncertain ownership stays undefined. */
function parseReplySummary(entry: Record<string, unknown>): ThreadsReplySummary | null {
  const id = optId(entry['id']);
  if (!id) return null;
  const text = optString(entry['text']);
  const timestamp = optString(entry['timestamp']);
  const permalink = optString(entry['permalink']);
  const repliedTo = parseNestedId(entry['replied_to']);
  const rootPost = parseNestedId(entry['root_post']);
  const owned = optBoolean(entry['is_reply_owned_by_me']);
  return {
    id,
    ...(text !== undefined ? { text } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(permalink !== undefined ? { permalink } : {}),
    ...(repliedTo !== undefined ? { repliedToId: repliedTo } : {}),
    ...(rootPost !== undefined ? { rootPostId: rootPost } : {}),
    ...(owned !== undefined ? { isReplyOwnedByMe: owned } : {}),
  };
}

/** Meta returns replied_to / root_post as { "id": "..." } objects when present. */
function parseNestedId(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return optId((value as Record<string, unknown>)['id']);
}

/** True only when a paging.cursors.after token exists; the token is never read out. */
function detectNextPage(body: Record<string, unknown>): boolean {
  const paging = body['paging'];
  if (typeof paging !== 'object' || paging === null || Array.isArray(paging)) return false;
  const cursors = (paging as Record<string, unknown>)['cursors'];
  if (typeof cursors !== 'object' || cursors === null || Array.isArray(cursors)) return false;
  return optString((cursors as Record<string, unknown>)['after']) !== undefined;
}

// --- provider error mapping (sanitized; mirrors oauth-client-http) ----------

function mapProviderErrorStatus(status: number): ThreadsOAuthErrorKind {
  if (status === 401) return 'token_expired';
  if (status === 403) return 'permission_denied';
  if (status >= 500) return 'provider_unavailable';
  return 'unknown';
}

function safeHttpStatus(value: number): number | undefined {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

function safeErrorCode(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function providerErrorKind(body: string): ThreadsOAuthErrorKind | undefined {
  const parsed = parseJsonObject(body);
  if (!parsed) return undefined;
  const err = parsed['error'];
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as Record<string, unknown>)['code'];
  if (code === 190) return 'token_expired';
  return undefined;
}

function providerErrorDiagnostics(
  body: string,
): { errorCode?: number; errorSubcode?: number } | undefined {
  const parsed = parseJsonObject(body);
  if (!parsed) return undefined;
  const err = parsed['error'];
  if (typeof err !== 'object' || err === null) return undefined;
  const record = err as Record<string, unknown>;
  const errorCode = safeErrorCode(record['code']);
  const errorSubcode = safeErrorCode(record['error_subcode']);
  if (errorCode === undefined && errorSubcode === undefined) return undefined;
  return {
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(errorSubcode !== undefined ? { errorSubcode } : {}),
  };
}

function providerRejectionError(
  status: number,
  body: string,
  message: string,
): ThreadsOAuthProviderError {
  const safeStatus = safeHttpStatus(status);
  return new ThreadsOAuthProviderError(
    providerErrorKind(body) ?? mapProviderErrorStatus(status),
    message,
    {
      ...(safeStatus !== undefined ? { status: safeStatus } : {}),
      ...(providerErrorDiagnostics(body) ?? {}),
    },
  );
}
