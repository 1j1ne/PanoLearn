const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto').webcrypto;
const source = fs.readFileSync(require('node:path').join(__dirname, '../auth.js'), 'utf8');
function setup({ badState = false, cancelled = false, httpError = false } = {}) {
  const session = {}, removed = [], requests = []; let authorize, accessLevel;
  const context = vm.createContext({ URL, URLSearchParams, AbortSignal, TextEncoder, Uint8Array, crypto, btoa,
    PANOLEARN_SERVICE: { apiBaseUrl: 'https://service.example', googleClientId: 'client-test' },
    chrome: { identity: {
      getRedirectURL: path => 'https://extension.chromiumapp.org/' + path,
      launchWebAuthFlow: async options => {
        authorize = new URL(options.url);
        if (cancelled) throw new Error('User cancelled');
        return 'https://extension.chromiumapp.org/google?code=test-code&state=' + (badState ? 'wrong' : authorize.searchParams.get('state'));
      }
    }, storage: {
      session: { get: async () => session, set: async data => Object.assign(session, data),
        remove: async key => delete session[key], setAccessLevel: async value => { accessLevel = value.accessLevel; } },
      local: { remove: async keys => removed.push(...keys) }
    } },
    fetch: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return httpError ? { ok: false, json: async () => ({ error: { message: 'Sign-in failed' } }) }
        : { ok: true, json: async () => ({ token: 'google-id-token', email: 'student@example.com', expiresAt: Date.now() + 3600000 }) };
    }
  });
  vm.runInContext(source, context);
  return { context, session, removed, requests, authorization: () => authorize, access: () => accessLevel };
}

test('Google login uses state, nonce and PKCE; returns status without exposing token', async () => {
  const h = setup(); const result = await h.context.signIn();
  const auth = h.authorization();
  assert.equal(auth.origin, 'https://accounts.google.com');
  assert.equal(auth.searchParams.get('response_type'), 'code');
  assert.equal(auth.searchParams.get('scope'), 'openid email');
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  const sent = h.requests[0]; assert.equal(sent.url, 'https://service.example/auth/exchange');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sent.body.verifier));
  assert.equal(Buffer.from(hash).toString('base64url'), auth.searchParams.get('code_challenge'));
  assert.equal(sent.body.nonce, auth.searchParams.get('nonce'));
  assert.equal(result.signedIn, true); assert.equal(result.token, undefined);
  assert.equal(h.access(), 'TRUSTED_CONTEXTS');
  assert.equal(h.session.plAccount.token, 'google-id-token');
  assert.deepEqual(h.removed, ['openaiApiKey', 'apiKey']);
  assert.equal((await h.context.requireSession()).token, 'google-id-token');
  await h.context.signOut();
  await assert.rejects(h.context.requireSession(), /Sign in with Google/);
});

test('cancelled or state-mismatched login does not exchange a code or remove old keys', async () => {
  for (const options of [{ cancelled: true }, { badState: true }]) {
    const h = setup(options); await assert.rejects(h.context.signIn());
    assert.equal(h.requests.length, 0); assert.equal(h.removed.length, 0);
    assert.equal(h.session.plAccount, undefined);
  }
});

test('failed exchange does not create session and concurrent sign-ins share one flow', async () => {
  const failed = setup({ httpError: true }); await assert.rejects(failed.context.signIn(), /Sign-in failed/);
  assert.equal(failed.session.plAccount, undefined); assert.equal(failed.removed.length, 0);
  const h = setup(); await Promise.all([h.context.signIn(), h.context.signIn()]);
  assert.equal(h.requests.length, 1);
});

test('unconfigured backend fails closed before Google login', async () => {
  const h = setup(); h.context.PANOLEARN_SERVICE.apiBaseUrl = '';
  await assert.rejects(h.context.signIn(), /not configured/);
  assert.equal(h.authorization(), undefined); assert.equal(h.requests.length, 0);
});
