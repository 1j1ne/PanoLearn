// Each frame retains captures so the sidebar can request them after loading.
(function () {
  'use strict';
  const captures = new Map();
  let scanTimer = null;
  function announce() {
    chrome.runtime.sendMessage({ type: 'PL_FRAME_READY', pageUrl: location.href }).catch(() => {});
  }
  function send(capture) {
    chrome.runtime.sendMessage({ type: 'PL_TRANSCRIPT', ...capture }).catch(() => {});
  }
  function scanLoadedCaptions() {
    scanTimer = null;
    if (!/(^|\.)panopto\.com$/i.test(location.hostname)) return;
    const text = PanoLearnTranscript.readPanoptoCaptions(document);
    if (!text || text.length > 2000000) return;
    const key = location.href + '|loaded-caption-list';
    if (captures.get(key)?.text === text) return;
    const capture = { key, text, pageUrl: location.href, label: document.title || location.hostname,
      track: 'Loaded caption list (check beginning and ending)' };
    captures.set(key, capture);
    send(capture);
  }
  function scheduleScan() {
    if (scanTimer === null) scanTimer = setTimeout(scanLoadedCaptions, 300);
  }
  function observeCaptions() {
    scanLoadedCaptions();
    const observer = new MutationObserver(records => {
      // Sidebar updates must not trigger a capture/render loop.
      if (records.some(record => !(record.target.nodeType === 1 ? record.target : record.target.parentElement)
        ?.closest('#pl-panel, #pl-tab'))) scheduleScan();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }
  window.addEventListener('message', event => {
    const data = event.data;
    if (event.source !== window || data?.source !== 'PanoLearnSniffer') return;
    if (typeof data.payload !== 'string' || data.payload.length > 2000000 || data.pageUrl !== location.href) return;
    let url;
    try { url = new URL(data.url, location.href); } catch (_) { return; }
    const text = PanoLearnTranscript.normalize(data.payload);
    if (!text) return;
    const key = location.href + '|' + url.href;
    const capture = { key, text, pageUrl: location.href, label: document.title || location.hostname, track: url.pathname + url.search };
    captures.set(key, capture);
    if (captures.size > 30) captures.delete(captures.keys().next().value);
    send(capture);
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.type === 'PL_SEEK_PLAYER') {
      if (message.pageUrl !== location.href || !Number.isFinite(message.seconds) || message.seconds < 0) {
        respond({ ok: false, error: 'The lecture has changed.' });
        return;
      }
      const rows = Array.from(document.querySelectorAll('.event-tab-list li[id^="UserCreatedTranscript-"]'));
      let closest = null;
      let distance = Infinity;
      for (const row of rows) {
        const time = PanoLearnTranscript.parseTime(row.querySelector('.event-time')?.textContent);
        if (time !== null && Math.abs(time - message.seconds) < distance) {
          closest = row;
          distance = Math.abs(time - message.seconds);
        }
      }
      if (closest && distance <= 1) {
        // Use Panopto's own caption action so lecture video and slides stay synchronized.
        closest.click();
        respond({ ok: true });
        return;
      }
      respond({ ok: false, error: 'No matching caption is loaded for this time.' });
      return;
    }
    if (message.type === 'PL_REPLAY') {
      announce();
      scanLoadedCaptions();
      for (const capture of captures.values()) {
        if (capture.pageUrl === location.href) send(capture);
      }
    }
  });
  announce();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observeCaptions, { once: true });
  else observeCaptions();
  window.postMessage({ source: 'PanoLearnCaptureReady' }, '*');
})();
