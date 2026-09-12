importScripts('service-config.js', 'study-schema.js', 'auth.js');

// Relay frame captures and make authenticated requests from the extension origin.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (['PL_SIGN_IN', 'PL_SIGN_OUT', 'PL_AUTH_STATUS'].includes(message.type)) {
    if (sender.url !== chrome.runtime.getURL('popup.html')) return;
    const action = message.type === 'PL_SIGN_IN' ? signIn : message.type === 'PL_SIGN_OUT' ? signOut : authStatus;
    action().then(respond, error => respond({ error: error.message }));
    return true;
  }
  if (sender.tab?.id == null) return;
  const tabId = sender.tab.id;
  if (message.type === 'PL_EXPORT_PDF' && sender.frameId === 0) {
    exportPDF(message).then(() => respond({ ok: true }), error => respond({ error: error.message }));
    return true;
  }
  if (message.type === 'PL_SEEK' && sender.frameId === 0) {
    if (!Number.isFinite(message.seconds) || message.seconds < 0 || !Number.isInteger(message.frameId) || !message.documentId) {
      respond({ ok: false, error: 'Invalid timeline destination.' });
      return;
    }
    chrome.tabs.sendMessage(tabId, { type: 'PL_SEEK_PLAYER', seconds: message.seconds, pageUrl: message.pageUrl },
      { documentId: message.documentId })
      .then(result => respond(result), () => respond({ ok: false, error: 'This lecture frame has changed. Generate notes for the current lecture.' }));
    return true;
  }
  if (message.type === 'PL_FRAME_READY') {
    chrome.tabs.sendMessage(tabId, {
      type: 'PL_FRAME_RESET', frameId: sender.frameId, documentId: sender.documentId, pageUrl: message.pageUrl
    }, { frameId: 0 }).catch(() => {});
  }
  if (message.type === 'PL_TRANSCRIPT' && typeof message.text === 'string' && message.text.length <= 2000000) {
    chrome.tabs.sendMessage(tabId, {
      type: 'PL_CAPTURED', key: message.key, text: message.text,
      label: message.label, track: message.track, pageUrl: message.pageUrl,
      frameId: sender.frameId, documentId: sender.documentId
    }, { frameId: 0 }).catch(() => {});
  }
  if (message.type === 'PL_REQUEST_CAPTURES' && sender.frameId === 0) {
    chrome.tabs.sendMessage(tabId, { type: 'PL_REPLAY' }).catch(() => {});
  }
  if (message.type === 'PANOPTO_DETECTED') {
    chrome.action.setBadgeText({ text: '●', tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#1a6b4a', tabId });
  }
  if (message.type === 'PL_OPENAI' && sender.frameId === 0) {
    // Bound the keepalive to this request; long generations must survive worker idling.
    const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
    callOpenAI(message).then(text => respond({ text }), error => respond({ error: error.message }))
      .finally(() => clearInterval(keepAlive));
    return true;
  }
});

async function callOpenAI(message) {
  if (typeof message.system !== 'string' || typeof message.prompt !== 'string' || message.prompt.length > 70000) {
    throw new Error('Invalid study request.');
  }
  studyResponseFormat(message.format); // Reject unknown formats before sending.
  const { token } = await requireSession();
  const response = await fetch(serviceURL('/v1/study'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ system: message.system, prompt: message.prompt, format: message.format }),
    signal: AbortSignal.timeout(180000)
  });
  if (!response.ok) {
    if (response.status === 401) { await signOut(); throw new Error('Your session expired. Sign in with Google in the extension popup.'); }
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || 'HTTP ' + response.status);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', text = '', complete = false;
  function process(line) {
    if (!line.startsWith('data: ')) return;
    const event = JSON.parse(line.slice(6));
    if (event.type === 'error') throw new Error(event.message || 'Generation failed.');
    if (event.type === 'response.failed') throw new Error(event.response?.error?.message || 'Generation failed.');
    if (event.type === 'response.incomplete') {
      const reason = event.response?.incomplete_details?.reason;
      throw new Error(reason === 'max_output_tokens'
        ? 'Output was too long. Choose fewer sections and retry.'
        : 'OpenAI could not complete this response. Please retry.');
    }
    if (event.type === 'response.refusal.done') throw new Error(event.refusal || 'OpenAI declined this request.');
    if (event.type === 'response.output_text.delta') text += event.delta;
    if (event.type === 'response.completed') complete = true;
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      lines.forEach(process);
      if (done) break;
    }
    if (buffer.trim()) process(buffer);
  } finally { await reader.cancel().catch(() => {}); }
  if (!complete) throw new Error('Connection interrupted. Please generate again.');
  if (!text) throw new Error('Empty response from OpenAI.');
  return text;
}

async function exportPDF(message) {
  if (!message.result || typeof message.result !== 'object' || Array.isArray(message.result)) throw new Error('No notes to export.');
  const key = 'plPdf:' + crypto.randomUUID();
  await chrome.storage.session.set({ [key]: { result: message.result, pageUrl: message.pageUrl, lectures: message.lectures || [] } });
  try { await chrome.tabs.create({ url: chrome.runtime.getURL('print.html') + '#' + encodeURIComponent(key) }); }
  catch (error) { await chrome.storage.session.remove(key); throw error; }
}

