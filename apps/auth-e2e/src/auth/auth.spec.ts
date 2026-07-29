import axios from 'axios';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

type FederationSchemaResponse = {
  data: { _service: { sdl: string } };
  errors?: unknown[];
};

describe('GET /auth/health', () => {
  it('reports that the application and database are healthy', async () => {
    const res = await axios.get('/auth/health');

    expect(res.status).toBe(200);
    expect(res.data).toEqual({ status: 'ok' });
  });
});

type JwksResponse = {
  keys: Array<Record<string, unknown>>;
};

describe('GET /auth/.well-known/jwks.json', () => {
  it('publishes only public access-token verification keys', async () => {
    const res = await axios.get<JwksResponse>('/auth/.well-known/jwks.json');
    const [key] = res.data.keys;

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(key).toEqual({
      alg: 'RS256',
      e: expect.any(String),
      kid: expect.any(String),
      kty: 'RSA',
      n: expect.any(String),
      use: 'sig',
    });
  });
});
describe('POST /auth', () => {
  it('serves the committed Federation 2 subgraph schema', async () => {
    const res = await axios.post<FederationSchemaResponse>('/auth', {
      query: 'query SubgraphSchema { _service { sdl } }',
    });
    const snapshot = await readFile(
      resolve(process.cwd(), 'apps/auth/schema.graphql'),
      'utf8',
    );
    const sdl = snapshot.slice(snapshot.indexOf('\n\n') + 2).trim();

    expect(res.status).toBe(200);
    expect(res.data.errors).toBeUndefined();
    expect(res.data.data._service.sdl.trim()).toBe(sdl);
    expect(sdl).toContain('https://specs.apollo.dev/federation/v2.12');
  });

  it('does not expose inline traces before the gateway is trusted', async () => {
    const res = await axios.post<{ extensions?: { ftv1?: string } }>(
      '/auth',
      { query: 'query Typename { __typename }' },
      { headers: { 'apollo-federation-include-trace': 'ftv1' } },
    );

    expect(res.status).toBe(200);
    expect(res.data.extensions?.ftv1).toBeUndefined();
  });
});
