(function () {
  'use strict';
  const signIn = document.getElementById('sign-in-btn');
  const signOut = document.getElementById('sign-out-btn');
  const feedback = document.getElementById('save-feedback');
  const status = document.getElementById('account-status');
  document.getElementById('extension-version').textContent = 'PanoLearn v' + chrome.runtime.getManifest().version;
  async function update(type) {
    signIn.disabled = signOut.disabled = true;
    feedback.textContent = type === 'PL_SIGN_IN' ? 'Opening Google sign-in…' : '';
    feedback.className = 'save-feedback save-feedback--visible';
    try {
      const result = await chrome.runtime.sendMessage({ type });
      if (!result || result.error) throw new Error(result?.error || 'Could not contact PanoLearn.');
      status.textContent = result.signedIn ? 'Signed in as ' + result.email : 'Sign in to generate study notes.';
      signIn.hidden = result.signedIn;
      signOut.hidden = !result.signedIn;
      document.getElementById('status-dot').classList.toggle('status-dot--active', result.signedIn);
      feedback.textContent = '';
    } catch (error) {
      feedback.textContent = error.message;
      feedback.className = 'save-feedback save-feedback--error';
    } finally { signIn.disabled = signOut.disabled = false; }
  }
  signIn.addEventListener('click', () => update('PL_SIGN_IN'));
  signOut.addEventListener('click', () => update('PL_SIGN_OUT'));
  update('PL_AUTH_STATUS');
})();
