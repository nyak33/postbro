import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';

import { parseConfig } from './config';
import {
  registerThreadsAuthRoutes,
  type ThreadsAuthRouteDeps,
} from './modules/auth/routes';
import { registerLegalRoutes } from './modules/legal/routes';

type DefaultLoggerOptions = NonNullable<Extract<FastifyServerOptions['logger'], object>>;

export type AppLoggerOption = boolean | DefaultLoggerOptions;

export interface BuildAppOptions {
  logger?: AppLoggerOption;
  env?: NodeJS.ProcessEnv;
  /**
   * When provided (with pool, signing secret and OAuth client), enables
   * GET /auth/threads/start. Omitted by default so the app and /health run
   * without database or Meta configuration.
   */
  threadsAuth?: ThreadsAuthRouteDeps;
}

/**
 * Serialize the request URL for logs WITHOUT any query string. OAuth
 * credentials (`?code=`, `?state=`, `?link=`) and any future sensitive
 * parameters travel in query strings and must never reach log sinks.
 * Route handling is unaffected: this only rewrites the serialized `url`
 * field of the request log object; request.raw.url stays intact.
 */
function sanitizeUrlForLog(rawUrl: string | undefined): string | undefined {
  if (rawUrl === undefined) {
    return undefined;
  }
  const q = rawUrl.indexOf('?');
  return q === -1 ? rawUrl : rawUrl.slice(0, q);
}

function sanitizeReqForLog(request: {
  method?: string;
  raw?: { url?: string };
  headers?: { host?: string };
}): { method: string | undefined; url: string | undefined; host: string | undefined } {
  return {
    method: request.method,
    url: sanitizeUrlForLog(request.raw?.url),
    host: request.headers?.host,
  };
}

function buildLoggerOption(logger: AppLoggerOption | undefined): AppLoggerOption {
  if (logger === undefined || logger === false) {
    return logger ?? false;
  }
  const base: DefaultLoggerOptions =
    typeof logger === 'object' && logger !== null ? logger : {};
  const baseSerializers =
    typeof base.serializers === 'object' && base.serializers !== null ? base.serializers : {};
  return {
    ...base,
    serializers: {
      ...baseSerializers,
      // Fastify's req serializer signature is generic and
      // contravariance-hostile; our implementation reads only three safe
      // structural fields, so a narrowing cast is applied at the boundary.
      req: sanitizeReqForLog as never,
    },
  };
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const config = parseConfig(options.env ?? process.env);
  const app = Fastify({ logger: buildLoggerOption(options.logger) });

  app.get('/health', async () => ({
    status: 'ok',
    service: 'postbro',
    timestamp: new Date().toISOString(),
    timezone: config.appTimezone,
  }));

  registerLegalRoutes(app);

  if (options.threadsAuth) {
    registerThreadsAuthRoutes(app, options.threadsAuth);
  }

  return app;
}
