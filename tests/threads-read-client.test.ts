import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ME_THREADS_FIELDS,
  REPLY_FIELDS,
  THREADS_READ_DEFAULT_LIMIT,
  THREADS_READ_MAX_LIMIT,
  ThreadsReadClient,
} from '../src/integrations/threads/threads-read-client';
import {
  THREADS_GRAPH_ORIGIN,
  ThreadsHttpTransportError,
  type HttpTransport,
  type HttpTransportRequest,
} from '../src/integrations/threads/oauth-client-http';
import {
  ThreadsOAuthError,
  ThreadsOAuthProviderError,
} from '../src/integrations/threads/oauth-client';

type RecordedCall = HttpTransportRequest;

function transportReturning(
  handler: (req: HttpTransportRequest) => { status: number; body: string },
): { transport: HttpTransport; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const transport: HttpTransport = (req) => {
    calls.push({ ...req });
    return Promise.resolve(handler(req));
  };
  return { transport, calls };
}

function makeClient(transport: HttpTransport): ThreadsReadClient {
  return new ThreadsReadClient({ transport });
}

test('listOwnThreads GETs /v1.0/me/threads with bounded limit, bearer header only', async () => {
  const { transport, calls } = transportReturning(() => ({
    status: 200,
    body: JSON.stringify({
      data: [
        { id: '111', has_replies: true, timestamp: '2026-11-15T10:00:00+0000', permalink: 'https://www.threads.net/@x/post/111' },
        { id: '222', has_replies: false },
      ],
    }),
  }));
  const page = await makeClient(transport).listOwnThreads('tok-read');
  assert.equal(page.items.length, 2);
  assert.deepEqual(page.items[0], {
    id: '111',
    hasReplies: true,
    timestamp: '2026-11-15T10:00:00+0000',
    permalink: 'https://www.threads.net/@x/post/111',
  });
  assert.deepEqual(page.items[1], { id: '222', hasReplies: false });
  assert.equal(page.hasNextPage, false);

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.method, 'GET');
  const url = new URL(call.url);
  assert.equal(url.origin, THREADS_GRAPH_ORIGIN);
  assert.equal(url.pathname, '/v1.0/me/threads');
  assert.equal(url.searchParams.get('fields'), ME_THREADS_FIELDS);
  assert.equal(url.searchParams.get('limit'), String(THREADS_READ_DEFAULT_LIMIT));
  // Token via Authorization header ONLY — never in the URL.
  assert.equal(url.searchParams.get('access_token'), null);
  assert.equal(call.headers['authorization'], 'Bearer tok-read');
  assert.equal(call.body, undefined);
});

test('listRepliesForMedia GETs /v1.0/{id}/replies with reply fields', async () => {
  const { transport, calls } = transportReturning(() => ({
    status: 200,
    body: JSON.stringify({
      data: [
        {
          id: '900',
          text: 'reply text UNTRUSTED',
          timestamp: '2026-11-15T11:00:00+0000',
          permalink: 'https://www.threads.net/@y/post/900',
          replied_to: { id: '111' },
          root_post: { id: '111' },
          is_reply_owned_by_me: false,
        },
      ],
    }),
  }));
  const page = await makeClient(transport).listRepliesForMedia('tok', '111', 10);
  assert.equal(page.items.length, 1);
  assert.deepEqual(page.items[0], {
    id: '900',
    text: 'reply text UNTRUSTED',
    timestamp: '2026-11-15T11:00:00+0000',
    permalink: 'https://www.threads.net/@y/post/900',
    repliedToId: '111',
    rootPostId: '111',
    isReplyOwnedByMe: false,
  });

  const call = calls[0]!;
  assert.equal(call.method, 'GET');
  const url = new URL(call.url);
  assert.equal(url.origin, THREADS_GRAPH_ORIGIN);
  assert.equal(url.pathname, '/v1.0/111/replies');
  assert.equal(url.searchParams.get('fields'), REPLY_FIELDS);
  assert.equal(url.searchParams.get('limit'), '10');
  assert.equal(url.searchParams.get('access_token'), null);
  assert.equal(call.headers['authorization'], 'Bearer tok');
});

test('listOwnReplies GETs /v1.0/me/replies', async () => {
  const { transport, calls } = transportReturning(() => ({
    status: 200,
    body: JSON.stringify({
      data: [{ id: '901', replied_to: { id: '555' }, root_post: { id: '555' }, is_reply_owned_by_me: true }],
    }),
  }));
  const page = await makeClient(transport).listOwnReplies('tok');
  assert.deepEqual(page.items, [
    { id: '901', repliedToId: '555', rootPostId: '555', isReplyOwnedByMe: true },
  ]);
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, '/v1.0/me/replies');
  assert.equal(url.searchParams.get('fields'), REPLY_FIELDS);
});

test('limits are clamped to [1, 100]; non-integer falls back to default', async () => {
  const { transport, calls } = transportReturning(() => ({ status: 200, body: '{"data":[]}' }));
  const client = makeClient(transport);
  await client.listOwnThreads('tok', 1000);
  await client.listOwnThreads('tok', 0);
  await client.listOwnThreads('tok', 3.7);
  const limits = calls.map((c) => new URL(c.url).searchParams.get('limit'));
  assert.deepEqual(limits, [String(THREADS_READ_MAX_LIMIT), String(THREADS_READ_DEFAULT_LIMIT), String(THREADS_READ_DEFAULT_LIMIT)]);
});

test('unsafe mediaId fails closed WITHOUT any network call', async () => {
  const { transport, calls } = transportReturning(() => ({ status: 200, body: '{}' }));
  const client = makeClient(transport);
  for (const bad of ['', 'abc', '12/34', '11?x=1', '1'.repeat(40), '-1', '1.5']) {
    await assert.rejects(
      () => client.listRepliesForMedia('tok', bad),
      (e: unknown) => e instanceof ThreadsOAuthError,
    );
  }
  assert.equal(calls.length, 0);
});

test('all methods are GET-only: no POST/write surface exists', async () => {
  const { transport, calls } = transportReturning(() => ({ status: 200, body: '{"data":[]}' }));
  const client = makeClient(transport);
  await client.listOwnThreads('tok');
  await client.listRepliesForMedia('tok', '1');
  await client.listOwnReplies('tok');
  assert.ok(calls.every((c) => c.method === 'GET'));
  assert.ok(calls.every((c) => c.body === undefined));
  // No write-shaped methods on the public surface.
  const surface = Object.getOwnPropertyNames(ThreadsReadClient.prototype);
  assert.ok(surface.every((name) => !/create|post|publish|reply|delete|send/i.test(name)));
});

test('401 maps token_expired; 403 maps permission_denied; 5xx provider_unavailable', async () => {
  const cases: Array<[number, string]> = [
    [401, 'token_expired'],
    [403, 'permission_denied'],
    [500, 'provider_unavailable'],
    [400, 'unknown'],
  ];
  for (const [status, kind] of cases) {
    const { transport } = transportReturning(() => ({ status, body: '' }));
    await assert.rejects(
      () => makeClient(transport).listOwnThreads('tok'),
      (e: unknown) => e instanceof ThreadsOAuthProviderError && e.kind === kind,
    );
  }
});

test('provider error envelope carries numeric diagnostics only, never messages/body', async () => {
  const { transport } = transportReturning(() => ({
    status: 403,
    body: JSON.stringify({
      error: {
        message: 'SECRET_PERMISSION_DETAIL reply text SECRET_TEXT',
        type: 'OAuthException',
        code: 200,
        error_subcode: 1234,
        fbtrace_id: 'SECRET_TRACE',
      },
    }),
  }));
  await assert.rejects(
    () => makeClient(transport).listRepliesForMedia('SENSITIVE-TOKEN', '111'),
    (e: unknown) => {
      assert.ok(e instanceof ThreadsOAuthProviderError);
      assert.equal(e.kind, 'permission_denied');
      assert.equal(e.providerStatus, 403);
      assert.equal(e.providerErrorCode, 200);
      assert.equal(e.providerErrorSubcode, 1234);
      const serialized = JSON.stringify(e);
      assert.equal(serialized.includes('SECRET_PERMISSION_DETAIL'), false);
      assert.equal(serialized.includes('SECRET_TEXT'), false);
      assert.equal(serialized.includes('SECRET_TRACE'), false);
      assert.equal(serialized.includes('SENSITIVE-TOKEN'), false);
      return true;
    },
  );
});

test('malformed JSON and non-object bodies fail closed as malformed_response', async () => {
  for (const body of ['not-json', '[1,2]', '"str"', '', '<html>SECRET</html>']) {
    const { transport } = transportReturning(() => ({ status: 200, body }));
    await assert.rejects(
      () => makeClient(transport).listOwnThreads('tok'),
      (e: unknown) => {
        assert.ok(e instanceof ThreadsOAuthProviderError);
        assert.equal(e.providerFailureReason, 'malformed_response');
        assert.equal(JSON.stringify(e).includes('SECRET'), false);
        return true;
      },
    );
  }
});

test('non-array data field fails closed as malformed_response', async () => {
  const { transport } = transportReturning(() => ({
    status: 200,
    body: JSON.stringify({ data: { id: '1' } }),
  }));
  await assert.rejects(
    () => makeClient(transport).listOwnThreads('tok'),
    (e: unknown) => e instanceof ThreadsOAuthProviderError && e.providerFailureReason === 'malformed_response',
  );
});

test('empty results: data [] and missing data both yield empty page, no error', async () => {
  for (const body of ['{"data":[]}', '{}']) {
    const { transport } = transportReturning(() => ({ status: 200, body }));
    const page = await makeClient(transport).listOwnReplies('tok');
    assert.deepEqual(page, { items: [], hasNextPage: false });
  }
});

test('entries without usable id are dropped; uncertain ownership stays undefined', async () => {
  const { transport } = transportReturning(() => ({
    status: 200,
    body: JSON.stringify({
      data: [
        { id: '1', is_reply_owned_by_me: 'yes-STRING' },
        { no_id: true },
        { id: null },
        { id: 42, is_reply_owned_by_me: true },
        'garbage-entry',
      ],
    }),
  }));
  const page = await makeClient(transport).listOwnReplies('tok');
  assert.deepEqual(page.items, [
    // 'yes-STRING' is not a boolean -> ownership unknown -> key absent.
    { id: '1' },
    { id: '42', isReplyOwnedByMe: true },
  ]);
});

test('numeric media ids are accepted and stringified', async () => {
  const { transport } = transportReturning(() => ({
    status: 200,
    body: JSON.stringify({ data: [{ id: 987, has_replies: true }] }),
  }));
  const page = await makeClient(transport).listOwnThreads('tok');
  assert.deepEqual(page.items, [{ id: '987', hasReplies: true }]);
});

test('hasNextPage true only when paging.cursors.after exists; cursor value never surfaced', async () => {
  const { transport } = transportReturning(() => ({
    status: 200,
    body: JSON.stringify({
      data: [{ id: '1' }],
      paging: { cursors: { after: 'SECRET_CURSOR_VALUE', before: 'SECRET_BEFORE' }, next: 'https://graph.threads.net/SECRET_NEXT_URL' },
    }),
  }));
  const page = await makeClient(transport).listOwnThreads('tok');
  assert.equal(page.hasNextPage, true);
  const serialized = JSON.stringify(page);
  assert.equal(serialized.includes('SECRET_CURSOR_VALUE'), false);
  assert.equal(serialized.includes('SECRET_NEXT_URL'), false);
  assert.equal(serialized.includes('SECRET_BEFORE'), false);
});

test('no next page when paging is absent or malformed', async () => {
  const bodies = [
    '{"data":[]}',
    '{"data":[],"paging":{}}',
    '{"data":[],"paging":{"cursors":{}}}',
    '{"data":[],"paging":{"cursors":{"after":""}}}',
    '{"data":[],"paging":"garbage"}',
  ];
  for (const body of bodies) {
    const { transport } = transportReturning(() => ({ status: 200, body }));
    const page = await makeClient(transport).listOwnThreads('tok');
    assert.equal(page.hasNextPage, false, body);
  }
});

test('transport timeout maps provider_unavailable with safe failureReason, no leaks', async () => {
  const failing: HttpTransport = (req) =>
    Promise.reject(new ThreadsHttpTransportError('timeout', `timed out for ${req.url}`));
  await assert.rejects(
    () => makeClient(failing).listOwnThreads('SENSITIVE-TOKEN-SENTINEL'),
    (e: unknown) => {
      assert.ok(e instanceof ThreadsOAuthProviderError);
      assert.equal(e.kind, 'provider_unavailable');
      assert.equal(e.providerFailureReason, 'timeout');
      const serialized = JSON.stringify(e);
      assert.equal(serialized.includes('SENSITIVE-TOKEN-SENTINEL'), false);
      assert.equal(serialized.includes('graph.threads.net'), false);
      assert.equal(serialized.includes('timed out for'), false);
      return true;
    },
  );
});

test('arbitrary transport failure is wrapped sanitized (network detail never leaks)', async () => {
  const failing: HttpTransport = () =>
    Promise.reject(new Error('dns boom token=SECRET detail'));
  await assert.rejects(
    () => makeClient(failing).listOwnReplies('tok'),
    (e: unknown) => {
      assert.ok(e instanceof ThreadsOAuthProviderError);
      assert.equal(e.kind, 'provider_unavailable');
      assert.equal(JSON.stringify(e).includes('SECRET'), false);
      assert.equal(JSON.stringify(e).includes('dns boom'), false);
      return true;
    },
  );
});

test('empty access token fails closed before any network call', async () => {
  const { transport, calls } = transportReturning(() => ({ status: 200, body: '{}' }));
  const client = makeClient(transport);
  await assert.rejects(
    () => client.listOwnThreads(''),
    (e: unknown) => e instanceof ThreadsOAuthProviderError && e.kind === 'revoked',
  );
  assert.equal(calls.length, 0);
});

test('client never exposes or mutates granted scopes (read slice keeps scopes unverified)', () => {
  const client = makeClient(() => Promise.resolve({ status: 200, body: '{}' }));
  const surface = Object.getOwnPropertyNames(ThreadsReadClient.prototype);
  assert.equal(surface.includes('getGrantedScopes'), false);
  assert.equal((client as unknown as Record<string, unknown>)['grantedScopes'], undefined);
});

test('request bounds: timeout and body cap are passed to the transport', async () => {
  const { transport, calls } = transportReturning(() => ({ status: 200, body: '{"data":[]}' }));
  await new ThreadsReadClient({ transport, timeoutMs: 1234, maxBodyBytes: 4096 }).listOwnThreads('tok');
  assert.equal(calls[0]!.timeoutMs, 1234);
  assert.equal(calls[0]!.maxBodyBytes, 4096);
});
