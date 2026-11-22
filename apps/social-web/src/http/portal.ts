/**
 * PB-SOCIAL-003B: a separate, non-deployed portal API.
 * This module is intentionally not imported in the existing Threads backend.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';
import {
  verifySocialIdentity, SocialUnauthorizedError,
  type SupabaseAuthOptions,
} from '../security/supabase-auth';
import {
  listTenantClients, getTenantClient, saveTenantBrand, saveTenantHistory,
} from './tenant-store';

export interface PortalDependencies {
  pool: Pick<Pool, 'connect'>;
  auth: SupabaseAuthOptions;
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
  const app = Fastify({ logger: false, bodyLimit: 12_000 });
  const publicDir = deps.publicDir ?? path.resolve(__dirname, '../../../public');

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
  }));

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof SocialUnauthorizedError) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (error instanceof Error && error.message.startsWith('invalid_')) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    return reply.code(503).send({ error: 'temporarily_unavailable' });
  });

  const identity = async (header: string | undefined): Promise<string> => {
    const verified = await verifySocialIdentity(header, deps.auth);
    return verified.userId;
  };

  app.get('/api/social/clients', async request => {
    const user = await identity(request.headers.authorization);
    return { clients: await listTenantClients(deps.pool, user) };
  });

  app.get<{ Params: { id: string } }>('/api/social/clients/:id', async (request, reply) => {
    const user = await identity(request.headers.authorization);
    const client = await getTenantClient(deps.pool, user, request.params.id);
    if (!client) return reply.code(404).send({ error: 'not_found' });
    return { client };
  });

  app.put<{ Params: { id: string } }>('/api/social/clients/:id/brand', async (request, reply) => {
    const user = await identity(request.headers.authorization);
    const client = await saveTenantBrand(deps.pool, user, request.params.id, request.body);
    if (!client) return reply.code(404).send({ error: 'not_found' });
    return { client };
  });

  app.put<{ Params: { id: string } }>('/api/social/clients/:id/history', async (request, reply) => {
    const user = await identity(request.headers.authorization);
    const client = await saveTenantHistory(deps.pool, user, request.params.id, request.body);
    if (!client) return reply.code(404).send({ error: 'not_found' });
    return { client };
  });

  return app;
}
