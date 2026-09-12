# PanoLearn publisher-funded service (1.9.0)

Implemented locally; not deployed. Do not submit the existing 1.8.15 store draft as the Google-sign-in version. The currently installed extension has not been replaced while service setup is incomplete.

## What is preserved

The study prompts, topic/example reconciliation, KaTeX, collapsible topics, timeline links and PDF UI are unchanged. Only authentication and API transport change. `../study-schema.js` is shared between extension validation and the backend, preserving the exact structured output schemas.

## Google setup (required next)

1. Create a project at https://console.cloud.google.com/ and open Google Auth Platform. Configure branding, audience and a public support email. Use External for students outside your organization. While in Testing, add test users; production availability must be configured before public launch.
2. Create an OAuth client of type **Web application**. Its authorized redirect URI must be exactly:
   `https://bmhhhinalnmeinpnplpdpealkpndcahg.chromiumapp.org/google`
3. The extension requests only `openid email`. Record the public client ID. Enter the client secret directly into Cloudflare secret storage below; do not put it in the extension, chat, screenshots, store listing or version control.
4. For unpacked testing, obtain this item's public key from the Chrome Web Store Package page and use the manifest `key` field so the unpacked extension has the same ID. The key is a public extension identity key, NOT a Google or OpenAI secret. Alternatively create a separate test OAuth client, redirect URI and backend for the unpacked ID. Do not loosen allowed origins.

## Cloudflare setup

From `backend/`, install dependencies with `npm ci`, then authenticate Wrangler to your Cloudflare account with `npx wrangler login`. No deployment or account login has been performed automatically.

Set secrets using the interactive commands (paste each value at its prompt, never in a shell command):

```sh
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Use your publisher OpenAI key with appropriate project permissions. This service does not retrieve the old key from your browser. Review Cloudflare's plan requirements for Workers and SQLite Durable Objects before deploying; no paid plan has been purchased.

Set `GOOGLE_CLIENT_ID` in `wrangler.toml`. Keep `GENERATION_ENABLED = "false"` for initial deployment. Run `npm run check`, then `npm run deploy`. Note the actual HTTPS worker URL. From the extension root run:

```sh
python3 scripts/configure-service.py --url https://YOUR-DEPLOYED-WORKER-ORIGIN --google-client-id YOUR-CLIENT-ID.apps.googleusercontent.com
```

This configures only public values, adds the exact backend host permission, and keeps the backend's Google client ID consistent. The manifest requests `identity` plus `storage`; Chrome 116+ is required. All extension JS is bundled locally.

## Limits and spending

In `wrangler.toml`, launch defaults are 40 API requests and 600,000 input characters per user per UTC day, 300 requests and 4,000,000 input characters globally per day, with 3 concurrent requests per user and 20 globally. One summary can consume multiple requests for evidence, compression, writing and timing. A long lecture may exceed a user's daily limit; these are usage ceilings, not a promised number of summaries.

The server fixes `gpt-4.1-mini`, a maximum of 8,000 output tokens per request, no tools and `store:false`. It rejects client overrides and counts failed attempts conservatively. Limits are enforced with atomic Durable Object transactions and persist through restarts. They bound usage, not an exact currency amount; review limits against your budget and current provider pricing before enabling. Multiple Google accounts can bypass an individual quota, so the global cap also applies. Set `GENERATION_ENABLED = "false"` and redeploy for an emergency stop. Already dispatched calls can still finish and incur charges.

## Verify before enabling public access

- `node --test tests/*.test.cjs` and `python3 tests/release_test.py` from the extension root; `npm test` and `npm run check` from backend.
- Reload the extension with the correct stable ID and public service config. Sign in with an authorized Google test user; cancellation must remain signed out. The callback must use the exact registered URI.
- Confirm no key-entry field, and no key or Google token in page/content-script messages. Session tokens are in trusted Chrome session storage only.
- Set generation enabled only when OAuth verification, both secrets, budgets and deployment are ready. Generate from the synthetic fixture in `docs/publishing/REVIEWER-INSTRUCTIONS.md`, then test an authorized real lecture, source links and PDF. This incurs your API charges.
- Verify expired/wrong-audience tokens are rejected, two accounts get separate limits, and global caps block both. Test quota failures using a separate staging service; do not exhaust production quotas.
- Sign out and reopen the popup; generation must require sign-in. Local sign-out removes the session, not the Google token at the issuer; that token expires normally (about one hour). There is no refresh token or permanent account database.
- Publish the updated `privacy.html`, update store identity/hosting disclosures and reviewer access, and run `python3 scripts/build-release.py`. It deliberately refuses to package missing service configuration. Backend files, secrets and dependencies are never included in the extension ZIP.

## Data flow and retention

The extension sends an authorization code with PKCE to `/auth/exchange`. The backend exchanges it at Google with the secret and fixed redirect URI, verifies JWT signature, issuer, audience, expiry, verified email and nonce, and returns the short-lived ID token. Google access/refresh tokens are not retained or sent to the extension. Every `/v1/study` request re-verifies the signed identity token. CORS allows only the configured extension; CORS is not treated as authentication.

Selected transcript text/title and intermediate notes flow through Cloudflare to OpenAI over HTTPS. Application code does not log or store lecture content or secrets. Daily usage records contain hashed Google subject IDs, counts and temporary concurrency leases. Authentication rate limiting uses daily salted IP hashes. Durable Object alarms delete these records within 48 hours. Hosting and model providers have their own retention policies; `store:false` does not promise zero provider retention. Wrangler observability is disabled; verify deployed account logging settings before publication.

Official references: [Chrome identity](https://developer.chrome.com/docs/extensions/reference/api/identity), [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect), [Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/), [OpenAI authentication](https://developers.openai.com/api/reference/overview).
