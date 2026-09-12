// Runs at document_start in the MAIN world of every supported frame.
(function () {
  'use strict';
  const pending = new Map();
  const matches = url => /caption|transcript|GenerateSRT|subtitle|DeliveryInfo/i.test(url || '');
  function relay(url, payload) {
    if (typeof payload !== 'string' || !payload.trim() || payload.length > 2000000) return;
    const entry = { source: 'PanoLearnSniffer', url: String(url), payload, pageUrl: location.href };
    pending.set(String(url), entry);
    if (pending.size > 30) pending.delete(pending.keys().next().value);
    window.postMessage(entry, '*');
  }
  window.addEventListener('message', event => {
    if (event.source === window && event.data?.source === 'PanoLearnCaptureReady') {
      for (const entry of pending.values()) window.postMessage(entry, '*');
    }
  });
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const url = args[0] instanceof Request ? args[0].url : String(args[0] || '');
    const promise = originalFetch.apply(this, args);
    if (matches(url)) promise.then(response => {
      if (response.ok) response.clone().text().then(text => relay(url, text)).catch(() => {});
    }).catch(() => {});
    return promise;
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._plUrl = String(url || '');
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    if (matches(this._plUrl)) this.addEventListener('load', function () {
      if (this.status < 200 || this.status >= 300) return;
      try {
        if (this.responseType === 'json') relay(this._plUrl, JSON.stringify(this.response));
        else if (!this.responseType || this.responseType === 'text') relay(this._plUrl, this.responseText);
      } catch (_) { /* Ignore binary responses. */ }
    }, { once: true });
    return originalSend.apply(this, args);
  };
})();
