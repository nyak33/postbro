/**
 * PB-SOCIAL-003B: a separate, non-deployed portal API.
 * This module is intentionally not imported in the existing Threads backend.
 */
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import {
  verifySocialIdentity, SocialUnauthorizedError,
  type SupabaseAuthOptions,
} from '../security/supabase-auth.js';
import { SocialSsoBridge, SocialSsoError, type SocialSsoOptions } from '../security/oidc-bridge.js';
import {
  listTenantClients, getTenantClient, saveTenantBrand, saveTenantHistory,
  getPersonaReviewRequests, submitPersonaReviewRequest,
} from './tenant-store.js';
import {
  listCustomerContent, listCustomerContentDecisions,
  submitCustomerContentDecision,
} from '../content/customer-store.js';

export interface PortalDependencies {
  pool: Pick<Pool, 'connect'>;
  auth: SupabaseAuthOptions;
  sso?: SocialSsoOptions;
  publicDir?: string;
}

function validatePublicAuth(config: SupabaseAuthOptions): URL {
  const url = new URL(config.url);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.supabase.co') ||
      url.username || url.password || url.port || url.search || url.hash ||
      (url.pathname !== '/' && url.pathname !== '') ||
      typeof config.publishableKey !== 'string' ||
      !config.publishableKey.startsWith('sb_publishable_')) {
    throw new Error('invalid_supabase_configuration');
  }
  return url;
}

/** Configure this standalone instance only after a reviewed staging rollout. */
export function buildSocialPortalApp(deps: PortalDependencies): FastifyInstance {
  const auth = validatePublicAuth(deps.auth);
  if (deps.sso && new URL(deps.sso.supabaseUrl).origin !== auth.origin) {
    throw new Error('invalid_sso_project');
  }
  const sso = deps.sso ? new SocialSsoBridge(deps.sso) : null;
  const ssoOrigin = deps.sso ? new URL(deps.sso.callbackUrl).origin : null;
  const app = Fastify({ logger: false, bodyLimit: 12_000 });
  const publicDir = deps.publicDir ?? fileURLToPath(new URL('../../../public/', import.meta.url));

  app.addHook('onSend', async (_request, reply, body) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    return body;
  });

  const assets = [
    { route: '/social/', filename: 'portal.html', contentType: 'text/html; charset=utf-8' },
    { route: '/social/styles.css', filename: 'styles.css', contentType: 'text/css; charset=utf-8' },
    { route: '/social/portal.mjs', filename: 'portal.mjs', contentType: 'text/javascript; charset=utf-8' },
  ];

  for (const file of assets) {
    app.get(file.route, async (_request, reply) => {
      reply.header('content-type', file.contentType);
      reply.header('content-security-policy',
        "default-src 'none'; script-src 'self'; style-src 'self'; " +
        "connect-src 'self' " + auth.origin + "; base-uri 'none'; " +
        "object-src 'none'; frame-ancestors 'none'; form-action 'self'");
      return reply.send(readFileSync(path.join(publicDir, file.filename)));
    });
  }

  app.get('/api/social/config', async () => ({
    supabaseUrl: auth.origin,
    publishableKey: deps.auth.publishableKey,
    ...(sso ? { ssoEnabled: true } : {}),
  }));

  if (sso) {
    app.get('/api/social/sso/start', async (_request, reply) => {
      const started = sso.start();
      return reply.header('set-cookie', started.cookie).redirect(started.redirect, 302);
    });

    app.get('/api/social/sso/callback', async (request, reply) => {
      try {
        const loginCookie = await sso.callback(request.query, request.headers.cookie);
        const bearer = sso.bearerFromCookie(loginCookie);
        if (!bearer) throw new SocialSsoError();
        // An OAuth token is not an identity until Supabase Auth verifies it.
        await verifySocialIdentity(bearer, deps.auth);
        return reply.header('set-cookie', [sso.clearFlow(), loginCookie]).redirect('/social/', 302);
      } catch {
        return reply.header('set-cookie', [sso.clearFlow(), sso.clearLogin()])
          .code(401).send({ error: 'sso_unavailable' });
      }
    });

    app.get('/api/social/sso/session', async request => {
      const bearer = sso.bearerFromCookie(request.headers.cookie);
      if (!bearer) throw new SocialUnauthorizedError();
      await verifySocialIdentity(bearer, deps.auth);
      return { authenticated: true };
    });

    app.post('/api/social/sso/logout', async (request, reply) => {
      if (!ssoOrigin || request.headers.origin !== ssoOrigin) {
        return reply.code(403).send({ error: 'invalid_origin' });
      }
      return reply.header('set-cookie', sso.clearLogin()).code(204).send();
    });
  }

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof SocialUnauthorizedError) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (error instanceof Error && error.message.startsWith('invalid_')) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    if (error instanceof Error && 'statusCode' in error &&
        typeof error.statusCode === 'number' &&
        error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    return reply.code(503).send({ error: 'temporarily_unavailable' });
  });

  const identity = async (request: FastifyRequest): Promise<string> => {
    // Explicit Bearer always takes precedence: never downgrade bad Bearer auth
    // to a cookie. OTP-only API clients keep their previous behavior.
    let bearer = request.headers.authorization;
    if (!bearer && sso) {
      bearer = sso.bearerFromCookie(request.headers.cookie) ?? undefined;
      if (bearer && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
        // SameSite is not a sufficient CSRF defense against sibling subdomains.
        if (!ssoOrigin || request.headers.origin !== ssoOrigin) {
          throw new SocialUnauthorizedError();
        }
      }
    }
    const verified = await verifySocialIdentity(bearer, deps.auth);
    return verified.userId;
  };

  app.get('/api/social/clients', async request => {
    const user = await identity(request);
    return { clients: await listTenantClients(deps.pool, user) };
  });

  app.get<{ Params: { id: string } }>('/api/social/clients/:id', async (request, reply) => {
    const user = await identity(request);
    const client = await getTenantClient(deps.pool, user, request.params.id);
    if (!client) return reply.code(404).send({ error: 'not_found' });
    return { client };
  });

  app.put<{ Params: { id: string } }>('/api/social/clients/:id/brand', async (request, reply) => {
    const user = await identity(request);
    const client = await saveTenantBrand(deps.pool, user, request.params.id, request.body);
    if (!client) return reply.code(404).send({ error: 'not_found' });
    return { client };
  });

  app.put<{ Params: { id: string } }>('/api/social/clients/:id/history', async (request, reply) => {
    const user = await identity(request);
    const client = await saveTenantHistory(deps.pool, user, request.params.id, request.body);
    if (!client) return reply.code(404).send({ error: 'not_found' });
    return { client };
  });

  // Review requests are an immutable client intent. They do not activate
  // personas; a separate trusted adapter must process approved EXTERNAL_ENGINE drafts.
  app.get<{ Params: { id: string } }>('/api/social/clients/:id/persona/reviews', async (request) => {
    const user = await identity(request);
    const reviews = await getPersonaReviewRequests(deps.pool, user, request.params.id);
    return { reviews };
  });

  app.post<{ Params: { id: string } }>('/api/social/clients/:id/persona/reviews', async (request, reply) => {
    const user = await identity(request);
    const review = await submitPersonaReviewRequest(
      deps.pool, user, request.params.id, request.body
    );
    if (!review) return reply.code(404).send({ error: 'review_unavailable' });
    return reply.code(201).send({ review, activated: false });
  });

  // Customer content approval is a recorded request, not a Postiz action.
  app.get<{ Params: { id: string } }>('/api/social/clients/:id/content', async request => {
    const user = await identity(request);
    const content = await listCustomerContent(deps.pool, user, request.params.id);
    return { content };
  });

  app.get<{ Params: { id: string } }>('/api/social/content/:id/reviews', async request => {
    const user = await identity(request);
    const reviews = await listCustomerContentDecisions(deps.pool, user, request.params.id);
    return { reviews };
  });

  app.post<{ Params: { id: string } }>('/api/social/content/:id/reviews', async (request, reply) => {
    const user = await identity(request);
    const review = await submitCustomerContentDecision(
      deps.pool, user, request.params.id, request.body
    );
    if (!review) return reply.code(404).send({ error: 'content_review_unavailable' });
    return reply.code(201).send({ review, scheduled: false });
  });

  return app;
}
