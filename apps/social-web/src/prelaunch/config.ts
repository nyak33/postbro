/**
 * PB-SOCIAL-003C: fail-closed configuration for the isolated Social portal.
 *
 * Deliberately uses a distinct SOCIAL_PRELAUNCH_* environment namespace.
 * NEVER silently falls back to live DATABASE_URL or existing PostBro config.
 * No secrets or connection strings are returned in thrown errors.
 */
import type { PoolConfig } from 'pg';
import { parseConsentEnv, type ConsentOptions } from '../http/oauth-consent.js';
import { validateSocialSsoOptions, type SocialSsoOptions } from '../security/oidc-bridge.js';

export interface SocialPrelaunchConfig {
  projectRef: string;
  supabaseUrl: string;
  publishableKey: string;
  databasePool: PoolConfig;
  sso?: SocialSsoOptions;
  consent?: ConsentOptions;
  host: '127.0.0.1' | '::1';
  port: number;
}

const PROJECT_REF = /^[a-z0-9]{20}$/;
// The owner chose to dogfood on this existing active Supabase project only.
const APPROVED_SHARED_PROJECT_REF = 'nqjlgalyjxifzisitzfa';

function configError(): never {
  throw new Error('Invalid or incomplete isolated Social prelaunch configuration');
}

function projectOrigin(value: string, ref: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return configError();
  }
  if (url.origin !== `https://${ref}.supabase.co` ||
      url.pathname !== '/' || url.search || url.hash ||
      url.username || url.password) {
    return configError();
  }
  return url.origin;
}

function databaseOptions(raw: string, ref: string): PoolConfig {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return configError();
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.password || !url.username || url.search || url.hash ||
      !['/postgres', '/postgres/'].includes(url.pathname)) {
    return configError();
  }

  const direct = url.hostname === `db.${ref}.supabase.co`;
  const pooler = url.hostname.endsWith('.pooler.supabase.com') &&
    decodeURIComponent(url.username) === `postgres.${ref}`;

  // For direct connection, both superuser and scoped server role are possible.
  // Session pooler URLs must name the intended project via postgres.<ref>.
  if (!direct && !pooler) return configError();

  const port = url.port ? Number(url.port) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return configError();

  return {
    host: url.hostname,
    port,
    database: 'postgres',
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ssl: {
      rejectUnauthorized: true,
      servername: url.hostname,
    },
    max: 3,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
  };
}

export function parseSocialPrelaunchConfig(
  env: NodeJS.ProcessEnv,
): SocialPrelaunchConfig {
  const projectRef = (env.SOCIAL_PRELAUNCH_PROJECT_REF ?? '').trim();
  // Explicit operator acknowledgement: this is a shared active cloud project.
  if (env.SOCIAL_PRELAUNCH_SHARED_PROJECT_CONFIRM !== 'postbro-core') return configError();
  const supabaseUrl = env.SOCIAL_PRELAUNCH_SUPABASE_URL ?? '';
  const publishableKey = env.SOCIAL_PRELAUNCH_PUBLISHABLE_KEY ?? '';
  const connectionString = env.SOCIAL_PRELAUNCH_DATABASE_URL ?? '';

  if (!PROJECT_REF.test(projectRef) ||
      projectRef !== APPROVED_SHARED_PROJECT_REF ||
      !publishableKey.startsWith('sb_publishable_') ||
      publishableKey.length < 30 ||
      !connectionString || !supabaseUrl) return configError();

  const url = projectOrigin(supabaseUrl, projectRef);
  const databasePool = databaseOptions(connectionString, projectRef);

  const host = env.SOCIAL_PRELAUNCH_HOST ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1') return configError();

  const portText = env.SOCIAL_PRELAUNCH_PORT ?? '3201';
  if (!/^[0-9]+$/.test(portText)) return configError();
  const port = Number(portText);
  // Never collide with the known live PostBro API port 3000.
  if (!Number.isSafeInteger(port) || port < 1024 ||
      port > 65535 || port === 3000 || port === 5432) return configError();

  let sso: SocialSsoOptions | undefined;
  const ssoFlag = env.SOCIAL_PRELAUNCH_SSO_ENABLED;
  if (ssoFlag && ssoFlag !== 'true' && ssoFlag !== 'false') return configError();
  if (ssoFlag === 'true') {
    try {
      sso = validateSocialSsoOptions({
        supabaseUrl: url,
        clientId: env.SOCIAL_PRELAUNCH_SSO_CLIENT_ID ?? '',
        clientSecret: env.SOCIAL_PRELAUNCH_SSO_CLIENT_SECRET ?? '',
        callbackUrl: env.SOCIAL_PRELAUNCH_SSO_CALLBACK_URL ?? '',
        cookieKey: env.SOCIAL_PRELAUNCH_SSO_COOKIE_KEY ?? '',
      });
    } catch { return configError(); }
  }

  let consent: ConsentOptions | undefined;
  try { consent = parseConsentEnv(env); } catch { return configError(); }
  if (consent && sso && consent.origin !== new URL(sso.callbackUrl).origin) return configError();

  return {
    projectRef,
    supabaseUrl: url,
    ...(consent ? { consent } : {}),
    ...(sso ? { sso } : {}),
    publishableKey,
    databasePool,
    host,
    port,
  };
}
