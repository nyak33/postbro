import type { FastifyInstance } from 'fastify';

import {
  renderDataDeletionPage,
  renderPrivacyPage,
  renderTermsPage,
} from './pages';

/**
 * Public, unauthenticated legal pages required for Meta App Review.
 * No cookies, no tracking, no database access, no configuration required.
 */
export function registerLegalRoutes(app: FastifyInstance): void {
  app.get('/privacy', async (_request, reply) => {
    return reply.type('text/html; charset=utf-8').send(renderPrivacyPage());
  });

  app.get('/terms', async (_request, reply) => {
    return reply.type('text/html; charset=utf-8').send(renderTermsPage());
  });

  app.get('/data-deletion', async (_request, reply) => {
    return reply.type('text/html; charset=utf-8').send(renderDataDeletionPage());
  });
}
