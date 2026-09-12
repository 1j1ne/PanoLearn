import { createRemoteJWKSet, jwtVerify } from 'jose';
import schemas from '../../study-schema.js';

const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

export async function verifyGoogle(token, env, keys = googleKeys) {
  if (!env.GOOGLE_CLIENT_ID || typeof token !== 'string' || token.length > 16000) fail(401, 'Please sign in with Google.');
  let payload;
  try {
    ({ payload } = await jwtVerify(token, keys, {
      algorithms: ['RS256'], audience: env.GOOGLE_CLIENT_ID,
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      requiredClaims: ['sub', 'exp', 'iat', 'email', 'email_verified'], clockTolerance: 5
    }));
  } catch { fail(401, 'Your session expired or could not be verified. Sign in again.'); }
  if (!payload.sub || payload.email_verified !== true || typeof payload.email !== 'string' ||
      (payload.azp && payload.azp !== env.GOOGLE_CLIENT_ID)) fail(401, 'Google account could not be verified.');
  return payload;
}

export function studyBody(body) {
  if (!body || typeof body.system !== 'string' || typeof body.prompt !== 'string' ||
      !body.prompt.trim() || body.prompt.length > 70000 || body.system.length > 20000 ||
      Object.keys(body).some(key => !['system', 'prompt', 'format'].includes(key))) fail(400, 'Invalid study request.');
  let format;
  try { format = schemas.studyResponseFormat(body.format); } catch { fail(400, 'Invalid response format.'); }
  return { model: 'gpt-4.1-mini', max_output_tokens: 8000, store: false, stream: true,
    ...(format ? { text: { format } } : {}), instructions: body.system, input: body.prompt };
}

async function readJSON(request, maxBytes) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) fail(415, 'JSON is required.');
  if (Number(request.headers.get('Content-Length')) > maxBytes) fail(413, 'Request is too large.');
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'Request body is required.');
  let size = 0, text = '';
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) fail(413, 'Request is too large.');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(text); } catch { fail(400, 'Invalid JSON request.'); }
}

async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
function limits(env) {
  // A single daily object atomically enforces user AND app-wide budgets.
  return env.LIMITS.get(env.LIMITS.idFromName(new Date().toISOString().slice(0, 10)));
}
async function reserve(stub, data) {
  const response = await stub.fetch('https://limits/reserve', { method: 'POST', body: JSON.stringify(data) });
  if (!response.ok) fail(429, (await response.json()).error.message);
}

export function createHandler({ verify = verifyGoogle, upstream = fetch } = {}) {
  return async function handle(request, env, ctx) {
    const origin = request.headers.get('Origin');
    const allowed = 'chrome-extension://' + env.EXTENSION_ID;
    const headers = { 'Access-Control-Allow-Origin': allowed, 'Vary': 'Origin', 'Cache-Control': 'no-store',
      'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type' };
    const withHeaders = response => {
      const result = new Response(response.body, response);
      for (const [key, value] of Object.entries(headers)) result.headers.set(key, value);
      return result;
    };
    try {
      if (!/^[a-p]{32}$/.test(env.EXTENSION_ID || '') || !env.GOOGLE_CLIENT_ID) fail(503, 'PanoLearn service setup is incomplete.');
      if (origin !== allowed) fail(403, 'Origin is not allowed.');
      if (request.method === 'OPTIONS') return withHeaders(new Response(null, { status: 204 }));
      if (request.method !== 'POST') fail(405, 'Method not allowed.');
      const path = new URL(request.url).pathname;
      if (!['/auth/exchange', '/v1/study'].includes(path)) fail(404, 'Not found.');
      if (path === '/auth/exchange') {
        if (!env.GOOGLE_CLIENT_SECRET) fail(503, 'Google sign-in is not configured.');
        const stub = limits(env);
        // Daily salted IP hash; the raw address is never persisted by this code.
        const day = new Date().toISOString().slice(0, 10);
        const subject = await digest(day + ':' + (request.headers.get('CF-Connecting-IP') || 'unknown'));
        await reserve(stub, { kind: 'auth', subject });
        const body = await readJSON(request, 12000);
        if (typeof body.code !== 'string' || !body.code || body.code.length > 4000 ||
            !/^[A-Za-z0-9._~-]{43,128}$/.test(body.verifier || '') || !/^[a-f0-9]{64}$/.test(body.nonce || '')) fail(400, 'Invalid sign-in request.');
        const response = await upstream('https://oauth2.googleapis.com/token', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'authorization_code', code: body.code,
            code_verifier: body.verifier, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
            redirect_uri: `https://${env.EXTENSION_ID}.chromiumapp.org/google` }), signal: AbortSignal.timeout(20000)
        });
        if (!response.ok) fail(401, 'Google sign-in could not finish. Please try again.');
        const data = await response.json();
        const user = await verify(data.id_token, env);
        if (user.nonce !== body.nonce) fail(401, 'Sign-in could not be verified. Please try again.');
        return withHeaders(json({ token: data.id_token, expiresAt: user.exp * 1000, email: user.email }));
      }
      if (env.GENERATION_ENABLED !== 'true' || !env.OPENAI_API_KEY) fail(503, 'PanoLearn generation is temporarily unavailable.');
      const token = request.headers.get('Authorization')?.match(/^Bearer ([^\s]+)$/)?.[1];
      const user = await verify(token, env);
      const body = studyBody(await readJSON(request, 400000));
      const stub = limits(env), lease = crypto.randomUUID();
      const subject = await digest(user.sub);
      await reserve(stub, { kind: 'study', subject, lease, chars: body.instructions.length + body.input.length });
      const release = () => stub.fetch('https://limits/release', { method: 'POST', body: JSON.stringify({ lease }) });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 170000);
      let streaming = false;
      try {
        const response = await upstream('https://api.openai.com/v1/responses', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.OPENAI_API_KEY },
          body: JSON.stringify(body), signal: controller.signal
        });
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          fail(response.status === 429 ? 429 : 502, response.status === 429
            ? 'The study service is busy. Please try again later.' : 'Generation could not finish. Please try again later.');
        }
        const { readable, writable } = new TransformStream();
        // Stream unchanged so existing summary parsing and progress behavior remain intact.
        ctx.waitUntil(response.body.pipeTo(writable).catch(() => { controller.abort(); }).finally(async () => {
          clearTimeout(timeout); await release();
        }));
        streaming = true;
        return withHeaders(new Response(readable, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } }));
      } finally {
        if (!streaming) { clearTimeout(timeout); await release(); }
      }
    } catch (error) {
      // Never return provider errors, credentials, transcripts or stack traces.
      return withHeaders(json({ error: { message: error instanceof HttpError ? error.message : 'PanoLearn is temporarily unavailable. Please try again.' } }, error instanceof HttpError ? error.status : 503));
    }
  };
}
export default { fetch: createHandler() };

function setting(env, name, fallback) {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid quota configuration');
  return value;
}

export class UsageLimits {
  constructor(ctx, env) { this.storage = ctx.storage; this.env = env; }
  async fetch(request) {
    const body = await request.json();
    const now = Date.now();
    if (new URL(request.url).pathname === '/release') {
      await this.storage.delete('lease:' + body.lease);
      return json({ ok: true });
    }
    // Persistent alarms remove counters and hashed identifiers after at most 48 hours.
    if (!await this.storage.getAlarm()) await this.storage.setAlarm(now + 48 * 3600000);
    return this.storage.transaction(async tx => {
      if (body.kind === 'auth') {
        const minute = Math.floor(now / 60000);
        const key = 'auth:' + body.subject;
        let entry = await tx.get(key);
        if (entry?.minute !== minute) entry = { minute, count: 0 };
        let global = await tx.get('auth-global');
        if (global?.minute !== minute) global = { minute, count: 0 };
        if (entry.count >= 20 || global.count >= 200) return json({ error: { message: 'Too many sign-in attempts. Please wait a minute.' } }, 429);
        entry.count++; global.count++;
        await tx.put({ [key]: entry, 'auth-global': global });
        return json({ ok: true });
      }
      const daily = await tx.get('daily') || { requests: 0, chars: 0 };
      const key = 'user:' + body.subject;
      const user = await tx.get(key) || { requests: 0, chars: 0 };
      const active = await tx.list({ prefix: 'lease:' });
      let total = 0, personal = 0;
      for (const [key, lease] of active) {
        if (lease.until <= now) await tx.delete(key);
        else { total++; if (lease.subject === body.subject) personal++; }
      }
      if (personal >= 3 || total >= 20) return json({ error: { message: 'Generation is busy. Wait for current notes to finish before retrying.' } }, 429);
      if (user.requests >= setting(this.env, 'USER_DAILY_REQUESTS', 40) || user.chars + body.chars > setting(this.env, 'USER_DAILY_INPUT_CHARS', 600000)) {
        return json({ error: { message: 'You have reached your daily study limit. It resets at midnight UTC.' } }, 429);
      }
      if (daily.requests >= setting(this.env, 'GLOBAL_DAILY_REQUESTS', 300) || daily.chars + body.chars > setting(this.env, 'GLOBAL_DAILY_INPUT_CHARS', 4000000)) {
        return json({ error: { message: 'PanoLearn has reached its daily service limit. Please return after midnight UTC.' } }, 429);
      }
      daily.requests++; daily.chars += body.chars;
      user.requests++; user.chars += body.chars;
      await tx.put({ daily, [key]: user, ['lease:' + body.lease]: { subject: body.subject, until: now + 180000 } });
      // Never refund attempts: retries/failures may still incur provider charges.
      return json({ ok: true });
    });
  }
  async alarm() { await this.storage.deleteAll(); }
}
