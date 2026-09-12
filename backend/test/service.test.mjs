import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT } from 'jose';
import { createHandler, verifyGoogle, studyBody, UsageLimits } from '../src/worker.js';

const env = { EXTENSION_ID: 'bmhhhinalnmeinpnplpdpealkpndcahg', GOOGLE_CLIENT_ID: 'client-test',
  GOOGLE_CLIENT_SECRET: 'server-google-secret', OPENAI_API_KEY: 'server-openai-secret', GENERATION_ENABLED: 'true' };
const user = { sub: 'google-subject', email: 'student@example.com', email_verified: true, exp: Math.floor(Date.now()/1000) + 3600 };
const origin = 'chrome-extension://' + env.EXTENSION_ID;
const request = (path, body, extra = {}) => new Request('https://service.example' + path, {
  method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Authorization: 'Bearer test-token', ...extra }, body: JSON.stringify(body)
});
const storage = () => {
  const map = new Map(); let queue = Promise.resolve(), alarm;
  const api = {
    get: async key => structuredClone(map.get(key)),
    put: async (key, value) => { if (typeof key === 'object') for (const [k,v] of Object.entries(key)) map.set(k, structuredClone(v)); else map.set(key, structuredClone(value)); },
    delete: async key => map.delete(key), list: async ({prefix}) => new Map([...map].filter(([k]) => k.startsWith(prefix))),
    getAlarm: async () => alarm, setAlarm: async value => { alarm = value; }, deleteAll: async () => map.clear(),
    transaction: fn => { const next = queue.then(() => fn(api)); queue = next.catch(() => {}); return next; }
  }; return api;
};
function harness(overrides = {}) {
  const config = { ...env, ...overrides };
  const object = new UsageLimits({ storage: storage() }, config);
  config.LIMITS = { idFromName: name => name, get: () => ({ fetch: (url, options) => object.fetch(new Request(url, options)) }) };
  const waits = [];
  return { config, object, waits, ctx: { waitUntil: p => waits.push(p) } };
}
const reserve = (object, subject, lease) => object.fetch(request('/reserve', { kind: 'study', subject, lease, chars: 100 }));

test('server owns model, output limit, retention and all three exact response schemas', () => {
  for (const format of ['inventory', 'study', 'timing', undefined]) {
    const result = studyBody({ system: 'Instructions', prompt: 'Source', format });
    assert.equal(result.model, 'gpt-4.1-mini'); assert.equal(result.max_output_tokens, 8000);
    assert.equal(result.store, false); assert.equal(result.stream, true);
    if (format) { assert.equal(result.text.format.name, 'panolearn_' + format); assert.equal(result.text.format.strict, true); }
    else assert.equal(result.text, undefined);
  }
  for (const change of [{ model: 'expensive' }, { tools: [] }, { format: 'arbitrary' }, { prompt: 'a'.repeat(70001) }, { system: 'a'.repeat(20001) }]) {
    assert.throws(() => studyBody({ system: 'Notes', prompt: 'Lecture', ...change }));
  }
});

test('Google JWT verification rejects forged, expired, wrong-client and wrong-issuer tokens', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  async function token(changes = {}) {
    return new SignJWT({ ...user, iss: 'https://accounts.google.com', aud: env.GOOGLE_CLIENT_ID,
      iat: Math.floor(Date.now()/1000), ...changes }).setProtectedHeader({ alg: 'RS256' }).sign(privateKey);
  }
  assert.equal((await verifyGoogle(await token(), env, publicKey)).sub, user.sub);
  for (const changes of [{ exp: 10 }, { aud: 'another-client' }, { iss: 'https://attacker.example' }, { email_verified: false }, { azp: 'another-client' }]) {
    await assert.rejects(verifyGoogle(await token(changes), env, publicKey));
  }
  const { publicKey: otherKey } = await generateKeyPair('RS256');
  await assert.rejects(verifyGoogle(await token(), env, otherKey));
  await assert.rejects(verifyGoogle(undefined, env, publicKey));
});

test('unauthenticated and disallowed-origin requests cannot call OpenAI', async () => {
  const { config, ctx } = harness(); let calls = 0;
  const handle = createHandler({ verify: () => { throw new Error('invalid'); }, upstream: async () => { calls++; } });
  assert.equal((await handle(request('/v1/study', { system: '', prompt: 'Lecture' }), config, ctx)).status, 503);
  assert.equal((await handle(request('/v1/study', {}, { Origin: 'https://attacker.example' }), config, ctx)).status, 403);
  assert.equal(calls, 0);
});

test('missing bearer token is rejected by real verifier before any upstream call', async () => {
  const { config, ctx } = harness(); let calls = 0;
  const handle = createHandler({ upstream: async () => { calls++; } });
  const response = await handle(request('/v1/study', { system: '', prompt: 'Lecture' }, { Authorization: '' }), config, ctx);
  assert.equal(response.status, 401); assert.equal(calls, 0);
});

test('streaming sends only server key upstream and releases active lease when finished', async () => {
  const { config, ctx, waits, object } = harness(); let sent;
  const handle = createHandler({ verify: async () => user, upstream: async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses'); sent = options;
    return new Response('data: {"type":"response.completed"}\n\n');
  } });
  const response = await handle(request('/v1/study', { system: 'Instructions', prompt: 'Transcript', format: 'study' }), config, ctx);
  assert.equal(response.status, 200); assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal(await response.text(), 'data: {"type":"response.completed"}\n\n'); await Promise.all(waits);
  assert.equal(sent.headers.Authorization, 'Bearer server-openai-secret');
  assert.equal((await object.storage.list({ prefix: 'lease:' })).size, 0);
  assert.equal((await object.storage.get('daily')).requests, 1);
});

test('provider failures are sanitized and still consume quota', async () => {
  const { config, ctx, object } = harness();
  const handle = createHandler({ verify: async () => user, upstream: async () => new Response('SECRET: server-openai-secret', { status: 401 }) });
  const response = await handle(request('/v1/study', { system: '', prompt: 'Transcript' }), config, ctx);
  assert.equal(response.status, 502); assert.ok(!(await response.text()).includes('secret'));
  assert.equal((await object.storage.get('daily')).requests, 1);
  assert.equal((await object.storage.list({ prefix: 'lease:' })).size, 0);
});

test('usage reservations are atomic across parallel requests and persistent across instances', async () => {
  const { object } = harness({ USER_DAILY_REQUESTS: '2' });
  const responses = await Promise.all([1,2,3].map(i => reserve(object, 'u', String(i))));
  assert.deepEqual(responses.map(r => r.status), [200,200,429]);
  const restarted = new UsageLimits({ storage: object.storage }, { ...env, USER_DAILY_REQUESTS: '2' });
  assert.equal((await reserve(restarted, 'u', '4')).status, 429);
  assert.equal((await reserve(restarted, 'other-user', '5')).status, 200);
});

test('global limits hold across different accounts and zero disables spending', async () => {
  const { object } = harness({ GLOBAL_DAILY_REQUESTS: '1' });
  assert.equal((await reserve(object, 'one', '1')).status, 200);
  assert.equal((await reserve(object, 'two', '2')).status, 429);
  const { object: disabled } = harness({ GLOBAL_DAILY_REQUESTS: '0' });
  assert.equal((await reserve(disabled, 'one', '1')).status, 429);
});

test('input and concurrency limits reject excess work', async () => {
  const { object } = harness({ USER_DAILY_INPUT_CHARS: '150' });
  assert.equal((await reserve(object, 'u', '1')).status, 200);
  assert.equal((await reserve(object, 'u', '2')).status, 429);
  const { object: concurrent } = harness();
  for (let i=0; i<3; i++) assert.equal((await reserve(concurrent, 'u', String(i))).status, 200);
  assert.equal((await reserve(concurrent, 'u', 'four')).status, 429);
  await concurrent.fetch(request('/release', { lease: '0' }));
  assert.equal((await reserve(concurrent, 'u', 'five')).status, 200);
  await concurrent.alarm(); assert.equal(await concurrent.storage.get('daily'), undefined);
});

test('PKCE exchange fixes redirect URI and does not disclose Google secret/access token', async () => {
  const { config, ctx } = harness(); const nonce = 'a'.repeat(64); let form;
  const handle = createHandler({ verify: async () => ({ ...user, nonce }), upstream: async (url, options) => {
    assert.equal(url, 'https://oauth2.googleapis.com/token'); form = options.body;
    return Response.json({ id_token: 'google-id-token', access_token: 'private-access-token' });
  } });
  const response = await handle(request('/auth/exchange', { code: 'code', verifier: 'v'.repeat(64), nonce }), config, ctx);
  assert.equal(response.status, 200);
  assert.equal(form.get('redirect_uri'), `https://${env.EXTENSION_ID}.chromiumapp.org/google`);
  assert.equal(form.get('code_verifier'), 'v'.repeat(64));
  const text = await response.text(); assert.ok(!text.includes('private-access-token') && !text.includes(env.GOOGLE_CLIENT_SECRET));
  const mismatch = createHandler({ verify: async () => ({ ...user, nonce: 'wrong' }), upstream: async () => Response.json({ id_token: 'token' }) });
  assert.equal((await mismatch(request('/auth/exchange', { code: 'code', verifier: 'v'.repeat(64), nonce }), config, ctx)).status, 401);
});

test('kill switch, oversized bodies and arbitrary parameters never call the provider', async () => {
  const { config, ctx } = harness(); let calls = 0;
  const handle = createHandler({ verify: async () => user, upstream: async () => { calls++; } });
  assert.equal((await handle(request('/v1/study', {}), { ...config, GENERATION_ENABLED: 'false' }, ctx)).status, 503);
  assert.equal((await handle(request('/v1/study', { system: '', prompt: 'a'.repeat(400001) }), config, ctx)).status, 413);
  assert.equal((await handle(request('/v1/study', { system: '', prompt: 'source', model: 'other' }), config, ctx)).status, 400);
  assert.equal(calls, 0);
});
