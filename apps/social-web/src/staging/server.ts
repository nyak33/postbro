/**
 * Isolated PostBro Social staging process. NO production imports, migrations,
 * outbound emails, database writes or network checks during startup.
 *
 * This executable is NOT part of root src/index.ts or any live service.
 */
import { Pool } from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSocialPortalApp } from '../http/portal.js';
import { parseSocialStageConfig } from './config.js';

export async function startSocialStaging(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = parseSocialStageConfig(env);
  const pool = new Pool(config.databasePool);
  const app = buildSocialPortalApp({
    pool,
    auth: {
      url: config.supabaseUrl,
      publishableKey: config.publishableKey,
    },
  });

  // This is process liveness, NOT proof of database/SMTP/Auth readiness.
  app.get('/social/health', async () => ({
    status: 'configured',
    service: 'postbro-social-staging',
    check: 'process_only',
  }));

  let shuttingDown = false;
  const stop = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await app.close();
    } finally {
      await pool.end();
    }
  };

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch {
    await stop().catch(() => undefined);
    throw new Error('Social staging failed to bind loopback listener');
  }

  // Do not expose URLs, credentials or signed tokens in logs.
  process.stdout.write('PostBro Social staging is listening on loopback only\n');
  process.once('SIGINT', () => {
    void stop().then(() => { process.exitCode = 0; })
      .catch(() => { process.exitCode = 1; });
  });
  process.once('SIGTERM', () => {
    void stop().then(() => { process.exitCode = 0; })
      .catch(() => { process.exitCode = 1; });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void startSocialStaging().catch(() => {
    process.stderr.write('PostBro Social staging startup refused: invalid config or bind failure\n');
    process.exitCode = 1;
  });
}
