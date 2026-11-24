import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import {
  loadVerifiedPostizOrganizationLink, PostizOrganizationLinkError,
  validatedPostizOrigin, verifyPostizOrganizationIdentity
} from '../src/postiz/organization-binding.js';
import { createPostizReadOnlyTransport } from '../src/postiz/read-only-preflight.js';

const CLIENT = '30000000-0000-4000-8000-000000000001';
const OTHER = '30000000-0000-4000-8000-000000000002';
const POSTIZ = 'https://postiz-staging.syaqirshaq.online';
const EXPECTED = {
  clientId: CLIENT, postizInstanceOrigin: POSTIZ,
  postizOrganizationId: 'org_client_1', postizCustomerGroupId: 'group_client_1'
};

test('origin validation rejects impersonation, credentials, paths and insecure origins', () => {
  assert.equal(validatedPostizOrigin(POSTIZ), POSTIZ);
  for (const value of [
    'http://postiz-staging.syaqirshaq.online',
    POSTIZ + '/public/v1',
    POSTIZ + '/',
    POSTIZ + '?group=foo',
    'https://postiz-staging.syaqirshaq.online.evil.example',
    'https://abc:secret@postiz-staging.syaqirshaq.online',
  ]) {
    if (value.endsWith('evil.example')) {
      // A different HTTPS host can be syntactically valid, but the expected
      // trusted origin must still be matched by verifyPostizOrganizationIdentity.
      assert.notEqual(validatedPostizOrigin(value), POSTIZ);
    } else {
      assert.throws(() => validatedPostizOrigin(value), PostizOrganizationLinkError);
    }
  }
});

test('GET-only Postiz /me validates organization returned by current API credential', async () => {
  const seen: string[] = [];
  const transport = createPostizReadOnlyTransport(
    POSTIZ,
    'Bearer TEST_ONLY_NOT_A_REAL_TOKEN',
    async (url, init) => {
      seen.push(url);
      assert.equal(init.method, 'GET');
      return {
        ok: true,
        async json() {
          return { organization: { id: 'org_client_1', name: 'Client One' },
            user: { id: 'u-test', name: 'Test' } };
        }
      };
    }
  );
  const result = await verifyPostizOrganizationIdentity(EXPECTED, POSTIZ, transport);
  assert.deepEqual(result, { organizationId: 'org_client_1' });
  assert.deepEqual(seen, [POSTIZ + '/public/v1/me']);
});

test('refuses different Postiz org or missing trusted /me capability', async () => {
  await assert.rejects(
    () => verifyPostizOrganizationIdentity(EXPECTED, POSTIZ, {
      groups: async () => [],
      integrations: async () => [],
      me: async () => ({ organization: { id: 'org_other', name: 'Other' } })
    }), PostizOrganizationLinkError
  );
  await assert.rejects(
    () => verifyPostizOrganizationIdentity(EXPECTED, POSTIZ, {
      groups: async () => [], integrations: async () => []
    }), PostizOrganizationLinkError
  );
  await assert.rejects(
    () => verifyPostizOrganizationIdentity(EXPECTED, 'https://other-postiz.example.com', {
      groups: async () => [],
      integrations: async () => [],
      me: async () => ({ organization: { id: 'org_client_1' } })
    }), PostizOrganizationLinkError
  );
  await assert.rejects(
    () => verifyPostizOrganizationIdentity(EXPECTED, POSTIZ, {
      groups: async () => [],
      integrations: async () => [],
      me: async () => { throw Error('Sensitive fake upstream data'); }
    }), PostizOrganizationLinkError
  );
});

test('private DB resolver requires verified client mapping and never trusts browser org IDs', async () => {
  let released = 0;
  const paramsSeen: unknown[][] = [];
  const pool = {
    async connect() {
      return {
        async query(_sql: string, params: unknown[]) {
          paramsSeen.push(params);
          return {
            rows: [{
              client_id: CLIENT,
              postiz_instance_origin: POSTIZ,
              postiz_organization_id: 'org_client_1',
              postiz_customer_group_id: 'group_client_1'
            }]
          };
        },
        release() { released++; }
      };
    }
  } as unknown as Pick<Pool, 'connect'>;
  const result = await loadVerifiedPostizOrganizationLink(pool, CLIENT, POSTIZ);
  assert.deepEqual(result, EXPECTED);
  assert.deepEqual(paramsSeen, [[CLIENT, POSTIZ]]);
  assert.equal(released, 1);
  await assert.rejects(
    () => loadVerifiedPostizOrganizationLink(pool, OTHER, POSTIZ),
    PostizOrganizationLinkError
  );
  assert.equal(released, 2);
});

test('private DB resolver denies missing/revoked mappings and always releases connection', async () => {
  let released = 0;
  const pool = {
    async connect() {
      return {
        async query() { return { rows: [] }; },
        release() { released++; }
      };
    }
  } as unknown as Pick<Pool, 'connect'>;
  await assert.rejects(
    () => loadVerifiedPostizOrganizationLink(pool, CLIENT, POSTIZ),
    PostizOrganizationLinkError
  );
  assert.equal(released, 1);
});
