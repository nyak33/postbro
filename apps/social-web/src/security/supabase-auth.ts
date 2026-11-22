/**
 * Supabase Auth identity-verification boundary for the forthcoming client portal.
 *
 * This is NOT wired into production. No user/org ID from a request body is
 * trusted. A supplied Bearer token is sent to Supabase Auth's /user endpoint
 * to obtain the verified immutable auth.users.id on every authorized request.
 * An unverified decoded JWT, user_metadata or Postiz identity is never accepted.
 */
export interface VerifiedSocialIdentity {
  userId: string;
}

export interface SupabaseAuthOptions {
  url: string;
  publishableKey: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

export class SocialUnauthorizedError extends Error {
  constructor() {
    super('unauthorized');
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BEARER_RE = /^Bearer ([A-Za-z0-9._~+/-]{20,4096}={0,2})$/;

export function extractSocialBearer(authorization: string | undefined): string {
  if (!authorization || typeof authorization !== 'string') {
    throw new SocialUnauthorizedError();
  }
  const match = BEARER_RE.exec(authorization);
  if (!match?.[1]) {
    throw new SocialUnauthorizedError();
  }
  return match[1];
}

function allowedSupabaseAuthEndpoint(urlString: string): URL {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error('Invalid Supabase URL');
  }

  // Never forward client Bearer tokens to an arbitrary or attacker-selected URL.
  if (url.protocol !== 'https:' ||
      !url.hostname.endsWith('.supabase.co') ||
      url.username || url.password || url.port ||
      (url.pathname !== '/' && url.pathname !== '') ||
      url.search || url.hash) {
    throw new Error('Invalid Supabase URL');
  }
  return new URL('/auth/v1/user', url);
}

/**
 * Verify a live Supabase Auth token. Never infer identity from JWT payloads,
 * caller-provided org IDs, usernames, email addresses or user_metadata.
 * The server must use a fixed trusted URL/key from protected configuration.
 */
export async function verifySocialIdentity(
  authorizationHeader: string | undefined,
  config: SupabaseAuthOptions,
): Promise<VerifiedSocialIdentity> {
  const token = extractSocialBearer(authorizationHeader);
  const endpoint = allowedSupabaseAuthEndpoint(config.url);
  if (typeof config.publishableKey !== 'string' ||
      !config.publishableKey.startsWith('sb_publishable_') ||
      config.publishableKey.length < 20) {
    throw new Error('Supabase publishable key is not configured');
  }
  const fetcher = config.fetcher ?? fetch;
  const timeoutMs = Math.max(500, Math.min(config.timeoutMs ?? 5000, 10000));
  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: 'GET',
      headers: {
        authorization: 'Bearer ' + token,
        apikey: config.publishableKey,
        accept: 'application/json',
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
  } catch {
    // Do not propagate errors containing credentials or raw HTTP arguments.
    throw new SocialUnauthorizedError();
  }

  if (!response.ok) {
    throw new SocialUnauthorizedError();
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new SocialUnauthorizedError();
  }
  if (typeof data !== 'object' || !data ||
      !('id' in data) || typeof data.id !== 'string' ||
      !UUID_RE.test(data.id)) {
    throw new SocialUnauthorizedError();
  }
  return { userId: data.id };
}
