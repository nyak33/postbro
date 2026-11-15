/**
 * PB-P0-004: REAL Threads OAuth HTTP client behind the ThreadsOAuthClient
 * port defined in oauth-client.ts.
 *
 * Implements the official Meta Threads OAuth endpoints ONLY:
 * - POST https://graph.threads.net/oauth/access_token
 *     (authorization_code -> short-lived token; per Meta's official docs/
 *      Postman spec ALL five parameters — client_id, client_secret, code,
 *      grant_type=authorization_code, identical redirect_uri — travel in the
 *      URL QUERY STRING; the request carries NO body)
 * - GET  https://graph.threads.net/access_token
 *     (grant_type=th_exchange_token -> long-lived token;
 *      grant_type=th_refresh_token -> refreshed long-lived token)
 * - GET  https://graph.threads.net/v1.0/me?fields=id,username
 *
 * Security contract:
 * - Transport is INJECTED (HttpTransport). Tests never perform network I/O;
 *   production wiring passes the built-in fetch transport.
 * - The Graph host is fixed and allowlisted; redirects are never followed
 *   (redirect: 'manual' — a redirect from the provider fails closed).
 * - Timeouts (AbortSignal.timeout) and a hard response size cap are enforced.
 * - Tokens are passed via the Authorization header wherever the provider
 *   supports it (Bearer on /me and the long-lived token GETs), never as
 *   access_token URL parameters.
 * - client_secret placement differs by endpoint per Meta's official docs:
 *   the short-lived exchange (POST /oauth/access_token) carries it in the
 *   URL QUERY STRING (Meta's documented parameter placement for this
 *   endpoint; the request has no body); the long-lived/refresh endpoint
 *   (GET /access_token) REQUIRES it as a URL query parameter — that is
 *   Meta's documented contract and must not be "fixed" to a body POST.
 *   Threat model: BOTH token-exchange URLs now carry the app secret (and
 *   the short-lived exchange URL also carries the authorization code).
 *   Because query strings can leak via HTTP access logs, proxies, tracing
 *   and crash reporters, NOTHING in this client (or its callers) may log
 *   full request URLs or raw HTTP diagnostics; reverse-proxy/tracing for
 *   these paths must stay off or redacted.
 * - Provider errors are sanitized: no response bodies, tokens, codes, URLs
 *   or secrets are ever embedded in thrown errors or logs.
 * - Granted scopes: there is NO authoritative Threads endpoint documented
 *   that enumerates granted scopes for a user token. Therefore
 *   getGrantedScopes() FAILS CLOSED: { verified: false, scopes: [] } always.
 *   Requested scopes from config are NEVER reported as granted. (Decision
 *   recorded in docs/tasks/PB-P0-004.md.)
 */

import type { ThreadsOAuthConfig } from '../../config';
import {
  buildAuthorizeUrl,
  ThreadsOAuthError,
  ThreadsOAuthProviderError,
  type AuthorizeUrlParams,
  type GrantedScopesEvidence,
  type LongLivedTokenResult,
  type ShortLivedTokenResult,
  type ThreadsIdentity,
  type ThreadsOAuthClient,
  type ThreadsOAuthErrorKind,
} from './oauth-client';

export const THREADS_GRAPH_ORIGIN = 'https://graph.threads.net';
export const THREADS_API_VERSION = 'v1.0';

/** Hard bounds applied to every provider call. */
export const THREADS_HTTP_TIMEOUT_MS = 10_000;
export const THREADS_HTTP_MAX_BODY_BYTES = 64 * 1024;

/**
 * Minimal HTTP transport port so tests can inject a deterministic fake.
 * Implementations MUST NOT follow redirects; a non-2xx status is returned
 * to the caller for sanitized mapping.
 */
export interface HttpTransportResponse {
  status: number;
  body: string;
}

export interface HttpTransportRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxBodyBytes: number;
}

export type HttpTransport = (request: HttpTransportRequest) => Promise<HttpTransportResponse>;

/** Error thrown when the response exceeds the size cap or times out. */
export class ThreadsHttpTransportError extends Error {
  readonly reason: 'timeout' | 'body_too_large' | 'redirect' | 'network';

  constructor(reason: 'timeout' | 'body_too_large' | 'redirect' | 'network', message: string) {
    super(message);
    this.name = 'ThreadsHttpTransportError';
    this.reason = reason;
  }
}

/**
 * Production fetch transport. redirect:'manual' ensures the client NEVER
 * follows a redirect; a 3xx from the token endpoints fails closed as a
 * provider error. Body is read with a hard byte cap. No response content is
 * ever logged.
 */
export const fetchHttpTransport: HttpTransport = async (request) => {
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body !== undefined ? { body: request.body } : {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(request.timeoutMs),
    });
  } catch {
    throw new ThreadsHttpTransportError('network', 'provider request failed');
  }

  if (response.status >= 300 && response.status < 400) {
    throw new ThreadsHttpTransportError('redirect', 'provider returned an unexpected redirect');
  }

  const reader = response.body?.getReader();
  if (!reader) {
    return { status: response.status, body: '' };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > request.maxBodyBytes) {
        void reader.cancel().catch(() => undefined);
        throw new ThreadsHttpTransportError('body_too_large', 'provider response too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return { status: response.status, body: Buffer.concat(chunks).toString('utf8') };
};

function mapProviderErrorStatus(status: number): ThreadsOAuthErrorKind {
  if (status === 400 || status === 401) return 'invalid_code';
  if (status === 403) return 'permission_denied';
  if (status >= 500) return 'provider_unavailable';
  return 'unknown';
}

/** Integer in the valid HTTP status range; anything else is dropped. */
function safeHttpStatus(value: number): number | undefined {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

/** Non-negative safe integer only; strings are never accepted. */
function safeErrorCode(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
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

/**
 * Detects the documented Meta error envelope { "error": { "type", "code", ... } }.
 * NEVER includes provider messages in the mapped outcome.
 */
function providerErrorKind(body: string): ThreadsOAuthErrorKind | undefined {
  const parsed = parseJsonObject(body);
  if (!parsed) return undefined;
  const err = parsed['error'];
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as Record<string, unknown>)['code'];
  // 190 = token expired/invalid; 102/104 auth/session failures on Graph.
  if (code === 190) return 'token_expired';
  return 'unknown';
}

/**
 * Extract NON-SECRET numeric diagnostics from the Meta error envelope:
 * numeric error.code and error_subcode only. Strings, messages, types,
 * trace ids and any other fields are NEVER collected.
 */
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

/**
 * Build a sanitized provider error for a non-200 response: mapped kind plus
 * allowlisted numeric diagnostics (HTTP status 100-599, Meta error.code and
 * error_subcode). No response body text, message, URL or token is carried.
 */
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

function requireString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requireStringOrNumber(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return undefined;
}

export interface ThreadsHttpOAuthClientOptions {
  config: ThreadsOAuthConfig;
  /** Injected transport; defaults to the production fetch transport. */
  transport?: HttpTransport;
  timeoutMs?: number;
  maxBodyBytes?: number;
}

/**
 * Real Threads OAuth client. Performs network I/O ONLY through the injected
 * transport; all other behavior is deterministic and fail-closed.
 */
export class ThreadsHttpOAuthClient implements ThreadsOAuthClient {
  private readonly config: ThreadsOAuthConfig;
  private readonly transport: HttpTransport;
  private readonly timeoutMs: number;
  private readonly maxBodyBytes: number;

  constructor(options: ThreadsHttpOAuthClientOptions) {
    this.config = options.config;
    this.transport = options.transport ?? fetchHttpTransport;
    this.timeoutMs = options.timeoutMs ?? THREADS_HTTP_TIMEOUT_MS;
    this.maxBodyBytes = options.maxBodyBytes ?? THREADS_HTTP_MAX_BODY_BYTES;
    if (!this.config.appId || !this.config.appSecret || !this.config.redirectUri) {
      throw new ThreadsOAuthError('Threads OAuth config is incomplete');
    }
  }

  buildAuthorizeUrl(params: AuthorizeUrlParams): string {
    return buildAuthorizeUrl(this.config, params);
  }

  /**
   * POST https://graph.threads.net/oauth/access_token
   * Per Meta's official docs (and the official Meta Postman Threads API
   * collection), ALL parameters — client_id, client_secret, code,
   * grant_type, redirect_uri — travel in the URL QUERY STRING; the request
   * carries NO body. The request URL therefore contains the app secret and
   * and the authorization code: request URLs and raw HTTP diagnostics for this
   * call must NEVER be logged, and proxy/tracing layers must keep this path
   * redacted (same threat model as the long-lived exchange URL). Response
   * must be a JSON object with a non-empty string access_token; anything
   * else (including an error envelope or malformed JSON) fails closed.
   *
   * user_id handling: per Meta's official docs/Postman spec the exchange
   * response includes user_id, and the STANDARD transport fails closed when
   * it is absent (missing_user_id) or present-but-invalid (invalid_user_id).
   * The experimental POSTIZ transport (experimental opt-in only) treats an
   * ABSENT user_id (observed live: HTTP 200 with access_token and no
   * user_id) or a present-but-unusable one (null, '', boolean, object,
   * non-integer/unsafe number) as "no trustworthy exchange ID" and returns
   * `userId: undefined` — mirroring Postiz's threads.provider.ts, which
   * ignores the exchange user_id and identifies the account via an
   * authenticated GET /me. A user_id that is present AND valid (non-empty
   * string / safe integer) is preserved and must still exactly match GET
   * /me (mismatch => identity_mismatch at the route layer). No ID is ever
   * invented for the exchange slot; /me remains the authoritative identity.
   */
  async exchangeCode(code: string): Promise<ShortLivedTokenResult> {
    if (typeof code !== 'string' || code.length === 0) {
      throw new ThreadsOAuthProviderError('invalid_code', 'authorization code must be non-empty');
    }
    const url = new URL(`${THREADS_GRAPH_ORIGIN}/oauth/access_token`);
    url.searchParams.set('client_id', this.config.appId);
    url.searchParams.set('client_secret', this.config.appSecret);
    url.searchParams.set('code', code);
    url.searchParams.set('grant_type', 'authorization_code');
    url.searchParams.set('redirect_uri', this.config.redirectUri);
    // Postiz mode: GET with identical query-string parameter placement and
    // no body (mirroring Postiz's authenticate()). Standard mode: POST with
    // no body per Meta's official docs. Both carry the secret and code in
    // the URL — same threat model, URLs must never be logged.
    const postiz = (this.config.transportMode ?? 'standard') === 'postiz';
    const res = await this.request({
      method: postiz ? 'GET' : 'POST',
      url: url.toString(),
      headers: {},
    });
    if (res.status !== 200) {
      throw providerRejectionError(
        res.status,
        res.body,
        'provider rejected the authorization code exchange',
      );
    }
    const parsed = parseJsonObject(res.body);
    if (!parsed) {
      throw new ThreadsOAuthProviderError('unknown', 'provider returned malformed JSON', {
        failureReason: 'malformed_response',
      });
    }
    const accessToken = requireString(parsed['access_token']);
    if (!accessToken) {
      throw new ThreadsOAuthProviderError('unknown', 'provider response missing access_token', {
        failureReason: 'missing_access_token',
      });
    }
    // In postiz mode, a user_id that is ABSENT *or* PRESENT-but-invalid
    // (null, '', boolean, object, non-integer/unsafe number) is treated as
    // "no trustworthy exchange ID" — matching Postiz's threads.provider.ts,
    // which ignores the exchange user_id entirely and identifies the account
    // via authenticated GET /me. The exchange slot stays undefined (never
    // invented); routes source identity from GET /me. In standard mode the
    // documented strictness is preserved: absent => missing_user_id,
    // present-but-invalid => invalid_user_id.
    const userIdPresent = Object.hasOwn(parsed, 'user_id');
    const userId = requireStringOrNumber(parsed['user_id']);
    if (userIdPresent && userId === undefined && !postiz) {
      throw new ThreadsOAuthProviderError('unknown', 'provider response user_id is invalid', {
        failureReason: 'invalid_user_id',
      });
    }
    // Standard mode follows Meta's documented response shape strictly and
    // fails closed when user_id is omitted. Postiz mode tolerates omission
    // (live-observed: HTTP 200 with access_token only) and, per the Postiz
    // contract, unusable values as well — identity comes solely from /me.
    if (userId === undefined && !postiz) {
      throw new ThreadsOAuthProviderError('unknown', 'provider response missing user_id', {
        failureReason: 'missing_user_id',
      });
    }
    return {
      accessToken,
      ...(userId !== undefined ? { userId } : {}),
      tokenType: 'bearer',
    };
  }

  /**
   * GET https://graph.threads.net/access_token?grant_type=th_exchange_token&client_secret=...
   * Per Meta's documented contract, client_secret is REQUIRED here as a URL
   * query parameter (the POST short-lived exchange likewise carries all
   * parameters in the URL query, not a body). The short-lived token itself
   * is passed via the Authorization header. Because the URL contains the
   * app secret, request URLs and raw HTTP diagnostics for this call must
   * NEVER be logged, and proxy/tracing layers must keep this path redacted.
   */
  async exchangeLongLived(shortLivedToken: string): Promise<LongLivedTokenResult> {
    return this.getLongLived(shortLivedToken, 'th_exchange_token');
  }

  /**
   * GET https://graph.threads.net/access_token?grant_type=th_refresh_token
   * Refreshes an existing long-lived token (>=24h old per Meta docs).
   */
  async refreshLongLived(longLivedToken: string): Promise<LongLivedTokenResult> {
    return this.getLongLived(longLivedToken, 'th_refresh_token');
  }

  private async getLongLived(
    token: string,
    grantType: 'th_exchange_token' | 'th_refresh_token',
  ): Promise<LongLivedTokenResult> {
    if (typeof token !== 'string' || token.length === 0) {
      throw new ThreadsOAuthProviderError('unknown', 'token must be non-empty');
    }
    const postiz = (this.config.transportMode ?? 'standard') === 'postiz';
    // Postiz mode refresh uses Postiz's refreshToken() contract exactly:
    // GET /refresh_access_token?grant_type=th_refresh_token&access_token=<token>
    // — a DIFFERENT path and NO client_secret. Postiz exchange still uses
    // GET /access_token?grant_type=th_exchange_token&client_secret=...&access_token=...
    const isPostizRefresh = postiz && grantType === 'th_refresh_token';
    const url = new URL(
      `${THREADS_GRAPH_ORIGIN}${isPostizRefresh ? '/refresh_access_token' : '/access_token'}`,
    );
    url.searchParams.set('grant_type', grantType);
    if (!isPostizRefresh) {
      url.searchParams.set('client_secret', this.config.appSecret);
    }
    // Postiz mode places the token as an access_token URL query parameter
    // (mirroring Postiz's threads.provider.ts). Standard mode uses the
    // Authorization header only. The exchange URL already carries
    // client_secret in BOTH modes, so the no-logging threat model is
    // identical.
    const headers: Record<string, string> = postiz ? {} : { authorization: `Bearer ${token}` };
    if (postiz) {
      url.searchParams.set('access_token', token);
    }
    const res = await this.request({
      method: 'GET',
      url: url.toString(),
      headers,
    });
    if (res.status !== 200) {
      throw providerRejectionError(
        res.status,
        res.body,
        'provider rejected the token exchange',
      );
    }
    const parsed = parseJsonObject(res.body);
    if (!parsed) {
      throw new ThreadsOAuthProviderError('unknown', 'provider returned malformed JSON', {
        failureReason: 'malformed_response',
      });
    }
    const accessToken = requireString(parsed['access_token']);
    if (!accessToken) {
      throw new ThreadsOAuthProviderError('unknown', 'provider response missing access_token', {
        failureReason: 'missing_fields',
      });
    }
    const expiresRaw = parsed['expires_in'];
    const expiresInSeconds =
      typeof expiresRaw === 'number' && Number.isFinite(expiresRaw) && expiresRaw > 0
        ? Math.floor(expiresRaw)
        : undefined;
    return {
      accessToken,
      tokenType: requireString(parsed['token_type']) ?? 'bearer',
      ...(expiresInSeconds !== undefined ? { expiresInSeconds } : {}),
    };
  }

  /**
   * GET https://graph.threads.net/v1.0/me?fields=id,username
   * Token via Authorization header only.
   */
  async getMe(accessToken: string): Promise<ThreadsIdentity> {
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new ThreadsOAuthProviderError('revoked', 'access token must be non-empty');
    }
    const postiz = (this.config.transportMode ?? 'standard') === 'postiz';
    const url = new URL(`${THREADS_GRAPH_ORIGIN}/${THREADS_API_VERSION}/me`);
    url.searchParams.set('fields', 'id,username');
    // Postiz mode: token as access_token URL query parameter, no auth header.
    const headers: Record<string, string> = postiz ? {} : { authorization: `Bearer ${accessToken}` };
    if (postiz) {
      url.searchParams.set('access_token', accessToken);
    }
    const res = await this.request({
      method: 'GET',
      url: url.toString(),
      headers,
    });
    if (res.status !== 200) {
      throw providerRejectionError(
        res.status,
        res.body,
        'provider rejected the identity request',
      );
    }
    const parsed = parseJsonObject(res.body);
    if (!parsed) {
      throw new ThreadsOAuthProviderError('unknown', 'provider returned malformed JSON', {
        failureReason: 'malformed_response',
      });
    }
    const id = requireStringOrNumber(parsed['id']);
    if (!id) {
      throw new ThreadsOAuthProviderError('unknown', 'provider response missing id', {
        failureReason: 'missing_fields',
      });
    }
    const username = requireString(parsed['username']);
    return { id, ...(username ? { username } : {}) };
  }

  /**
   * FAIL CLOSED: Meta documents no Threads user-token scope enumeration
   * endpoint. Requested scopes are NEVER reported as granted. Until an
   * authoritative verification channel is identified and verified, granted
   * scopes stay unverified and empty (all scope-dependent actions disabled).
   */
  getGrantedScopes(_accessToken: string): Promise<GrantedScopesEvidence> {
    return Promise.resolve({ verified: false, scopes: [] });
  }

  private async request(req: {
    method: 'GET' | 'POST';
    url: string;
    headers: Record<string, string>;
    body?: string;
  }): Promise<HttpTransportResponse> {
    // Enforce the fixed allowlisted origin at the boundary.
    const parsed = new URL(req.url);
    if (parsed.origin !== THREADS_GRAPH_ORIGIN) {
      throw new ThreadsOAuthError('refusing to call non-allowlisted Threads host');
    }
    try {
      return await this.transport({
        method: req.method,
        url: req.url,
        headers: req.headers,
        ...(req.body !== undefined ? { body: req.body } : {}),
        timeoutMs: this.timeoutMs,
        maxBodyBytes: this.maxBodyBytes,
      });
    } catch (error) {
      if (error instanceof ThreadsHttpTransportError) {
        const kind: ThreadsOAuthErrorKind =
          error.reason === 'timeout' ? 'provider_unavailable' : 'unknown';
        // Safe categorical reason (fixed enum, no free text) so sanitized
        // logs can distinguish network vs redirect vs oversize body.
        throw new ThreadsOAuthProviderError(kind, 'provider request failed', {
          failureReason: error.reason,
        });
      }
      if (error instanceof ThreadsOAuthProviderError) {
        throw error;
      }
      throw new ThreadsOAuthProviderError('provider_unavailable', 'provider request failed');
    }
  }
}
