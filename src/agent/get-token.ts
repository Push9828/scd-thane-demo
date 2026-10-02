import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const domain = process.env.COGNITO_DOMAIN?.replace(/\/$/, '');
const clientId = process.env.COGNITO_CLIENT_ID;
if (!domain?.startsWith('https://') || !clientId) {
  throw new Error('COGNITO_DOMAIN (https://...) and COGNITO_CLIENT_ID are required');
}

const redirectUri = 'http://localhost:8765/callback';
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const state = randomBytes(16).toString('hex');
const authorize = new URL(`${domain}/oauth2/authorize`);
for (const [key, value] of Object.entries({
  response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
  scope: 'conference/attend', code_challenge_method: 'S256',
  code_challenge: challenge, state,
})) authorize.searchParams.set(key, value);

let finish!: (token: string) => void;
let fail!: (error: Error) => void;
const tokenPromise = new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; });
const server = createServer((request, response) => {
  void (async () => {
    const callback = new URL(request.url ?? '/', redirectUri);
    if (callback.pathname !== '/callback') {
      response.writeHead(404).end('Not found');
      return;
    }
    if (callback.searchParams.get('state') !== state) throw new Error('OAuth state mismatch');
    const code = callback.searchParams.get('code');
    if (!code) throw new Error(callback.searchParams.get('error') ?? 'Missing authorization code');

    const tokenResponse = await fetch(`${domain}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', client_id: clientId,
        code, redirect_uri: redirectUri, code_verifier: verifier,
      }),
    });
    const data = await tokenResponse.json() as { access_token?: string; error?: string };
    if (!tokenResponse.ok || !data.access_token) throw new Error(data.error ?? 'Token exchange failed');
    response.writeHead(200, { 'content-type': 'text/plain' }).end('Signed in. Copy the access token from your terminal.');
    finish(data.access_token);
  })().catch(error => {
    response.writeHead(400, { 'content-type': 'text/plain' }).end('Sign-in failed. See the terminal.');
    fail(error instanceof Error ? error : new Error(String(error)));
  });
});

try {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(8765, 'localhost', resolve);
  });
  const timeout = setTimeout(() => fail(new Error('Sign-in timed out after five minutes')), 300_000);
  try {
    console.log(`Open this URL and sign in as the demo attendee:\n${authorize.toString()}\n`);
    const accessToken = await tokenPromise;
    const payload = accessToken.split('.')[1];
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      iss?: string; aud?: string; client_id?: string; scope?: string; sub?: string;
    };
    console.log(`CONFERENCE_ACCESS_TOKEN="${accessToken}"`);
    console.log(`JWT_ISSUER="${claims.iss ?? ''}"`);
    console.log(`JWT_AUDIENCE="${claims.aud ?? claims.client_id ?? ''}"`);
    console.log(`Token scope: ${claims.scope ?? '(none)'}`);
    console.log(`Attendee sub: ${claims.sub ?? '(none)'}`);
  } finally {
    clearTimeout(timeout);
  }
} finally {
  if (server.listening) server.close();
}
