// ==UserScript==
// @name         Khan Academy Recon (Unipath)
// @namespace    https://unipath.app/
// @version      0.1.0
// @description  Phase 0 recon — captures KA network traffic to localStorage for one-shot inspection. No remote calls.
// @match        https://*.khanacademy.org/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'ka-recon-events';
  const MAX_REQ_BODY = 4000;
  const MAX_RESP_BODY = 8000;
  const MAX_EVENTS = 2000;

  const load = () => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    } catch {
      return [];
    }
  };

  const save = (events) => {
    if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
  };

  const record = (entry) => {
    const events = load();
    events.push({ ...entry, ts: Date.now() });
    save(events);
  };

  const truncate = (text, max) => {
    if (text == null) return null;
    const s = typeof text === 'string' ? text : String(text);
    return s.length > max ? s.slice(0, max) + '…[truncated]' : s;
  };

  // --- fetch hook ---
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input?.url || '';
    const isKA = url.includes('khanacademy.org');

    if (!isKA) return origFetch.apply(this, arguments);

    const method = (init && init.method) || (typeof input !== 'string' && input?.method) || 'GET';
    const reqBody = init && init.body ? truncate(init.body, MAX_REQ_BODY) : null;

    let response;
    try {
      response = await origFetch.apply(this, arguments);
    } catch (err) {
      record({ type: 'fetch', url, method, reqBody, error: String(err) });
      throw err;
    }

    let respBody = null;
    try {
      respBody = truncate(await response.clone().text(), MAX_RESP_BODY);
    } catch {}

    record({
      type: 'fetch',
      url,
      method,
      reqBody,
      respBody,
      status: response.status,
    });
    return response;
  };

  // --- XHR hook (KA still uses XHR in some flows) ---
  const OrigXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new OrigXHR();
    let _url = '';
    let _method = '';
    let _reqBody = null;

    const origOpen = xhr.open;
    xhr.open = function (method, url) {
      _method = method;
      _url = url;
      return origOpen.apply(xhr, arguments);
    };

    const origSend = xhr.send;
    xhr.send = function (body) {
      _reqBody = body ? truncate(body, MAX_REQ_BODY) : null;
      xhr.addEventListener('loadend', () => {
        if (!_url.includes('khanacademy.org')) return;
        let respBody = null;
        try {
          respBody = truncate(xhr.responseText, MAX_RESP_BODY);
        } catch {}
        record({
          type: 'xhr',
          url: _url,
          method: _method,
          reqBody: _reqBody,
          respBody,
          status: xhr.status,
        });
      });
      return origSend.apply(xhr, arguments);
    };

    return xhr;
  }
  PatchedXHR.prototype = OrigXHR.prototype;
  window.XMLHttpRequest = PatchedXHR;

  // --- console-exposed controls ---
  window.kaReconExport = function () {
    const data = load();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = `ka-recon-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    console.log(`[KA Recon] exported ${data.length} events`);
  };

  window.kaReconClear = function () {
    save([]);
    console.log('[KA Recon] cleared');
  };

  window.kaReconCount = function () {
    const n = load().length;
    console.log(`[KA Recon] ${n} events captured`);
    return n;
  };

  console.log(
    '[KA Recon] active. Commands: kaReconCount(), kaReconExport(), kaReconClear()'
  );
})();
