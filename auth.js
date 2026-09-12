// Runs only in the extension service worker; tokens never reach content scripts.
function serviceURL(path) {
  const base = PANOLEARN_SERVICE.apiBaseUrl;
  if (!base || !PANOLEARN_SERVICE.googleClientId) throw new Error('PanoLearn sign-in is not configured yet. The publisher must finish service setup.');
  const url = new URL(base);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid PanoLearn service configuration.');
  return url.origin + path;
}
async function authStatus() {
  const { plAccount } = await chrome.storage.session.get('plAccount');
  const signedIn = Boolean(plAccount?.token && plAccount.expiresAt > Date.now() + 60000);
  return { signedIn, email: signedIn ? plAccount.email : '' };
}
async function requireSession() {
  serviceURL('/');
  const { plAccount } = await chrome.storage.session.get('plAccount');
  if (!plAccount?.token || plAccount.expiresAt <= Date.now() + 60000) throw new Error('Sign in with Google in the PanoLearn extension popup first.');
  return plAccount;
}
async function signOut() {
  await chrome.storage.session.remove('plAccount');
  return { signedIn: false, email: '' };
}
function randomAuthValue() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
}
let pendingSignIn;
function signIn() {
  if (!pendingSignIn) pendingSignIn = performSignIn().finally(() => { pendingSignIn = undefined; });
  return pendingSignIn;
}
async function performSignIn() {
  const endpoint = serviceURL('/auth/exchange');
  const redirect = chrome.identity.getRedirectURL('google');
  const verifier = randomAuthValue(), state = randomAuthValue(), nonce = randomAuthValue();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({ client_id: PANOLEARN_SERVICE.googleClientId, redirect_uri: redirect,
    response_type: 'code', scope: 'openid email', state, nonce, code_challenge: challenge,
    code_challenge_method: 'S256', prompt: 'select_account' }).toString();
  let callback;
  try { callback = await chrome.identity.launchWebAuthFlow({ url: url.href, interactive: true }); }
  catch { throw new Error('Google sign-in was cancelled or could not finish. Please try again.'); }
  const result = new URL(callback);
  if (result.origin + result.pathname !== redirect || result.searchParams.get('state') !== state) throw new Error('Sign-in could not be verified. Please try again.');
  const code = result.searchParams.get('code');
  if (result.searchParams.has('error') || !code) throw new Error('Google sign-in was not completed.');
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, verifier, nonce }), signal: AbortSignal.timeout(30000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Sign-in could not finish. Please try again.');
  if (typeof data.token !== 'string' || !Number.isFinite(data.expiresAt) || data.expiresAt <= Date.now()) throw new Error('Invalid sign-in response.');
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await chrome.storage.session.set({ plAccount: { token: data.token, expiresAt: data.expiresAt, email: data.email || '' } });
  // Remove obsolete customer-supplied keys only after a successful migration.
  await chrome.storage.local.remove(['openaiApiKey', 'apiKey']);
  return authStatus();
}
