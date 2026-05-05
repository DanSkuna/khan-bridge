// ==UserScript==
// @name         Learning Platform Bridge (Unipath)
// @namespace    https://unipath.app/
// @version      1.0.0
// @description  Unified capture for Khan Academy and IXL. Auto-sends exercise activity to khan-bridge Worker. Install once, works on both sites.
// @match        https://*.khanacademy.org/*
// @match        https://*.ixl.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const PLATFORMS = [
    { source: 'khan', match: 'khanacademy.org', emoji: '🦦', color: '#9eff9e', label: 'KA' },
    { source: 'ixl',  match: 'ixl.com',         emoji: '🦊', color: '#ffd279', label: 'IXL' },
  ];

  const host = (location && location.hostname) || '';
  const platform = PLATFORMS.find((p) => host.includes(p.match));
  if (!platform) {
    console.warn('[Bridge] hostname did not match any known platform:', host);
    return;
  }

  const SOURCE = platform.source;
  const HOST_MATCH = platform.match;
  const WORKER_URL = 'https://khan-bridge.nuttarong1976.workers.dev';
  const SHARED_SECRET = '81e0006fed34ce0d08f1cbdc4415b70705739a5968b045843f2e47141572023d';
  const PENDING_KEY = `${SOURCE}-bridge-pending`;
  const STATS_KEY = `${SOURCE}-bridge-stats`;
  const FLUSH_AFTER_N = 5;
  const FLUSH_INTERVAL_MS = 10000;
  const MAX_PENDING = 500;
  const MAX_REQ_BODY = 4000;
  const MAX_RESP_BODY = 8000;
  const POST_TIMEOUT_MS = 5000;
  const LOG_PREFIX = `[${platform.label} Bridge]`;

  const loadJSON = (key, fallback) => {
    try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
    catch { return fallback; }
  };
  let pending = loadJSON(PENDING_KEY, []);
  let stats = loadJSON(STATS_KEY, { sent: 0, failed: 0, lastFlush: 0 });

  const persistPending = () => {
    if (pending.length > MAX_PENDING) pending = pending.slice(-MAX_PENDING);
    localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  };
  const persistStats = () => localStorage.setItem(STATS_KEY, JSON.stringify(stats));

  const truncate = (text, max) => {
    if (text == null) return null;
    const s = typeof text === 'string' ? text : String(text);
    return s.length > max ? s.slice(0, max) + '…[truncated]' : s;
  };

  const enqueue = (entry) => {
    pending.push({ source: SOURCE, ...entry, ts: Date.now() });
    persistPending();
    updateBadge();
    if (pending.length >= FLUSH_AFTER_N) flush();
  };

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input?.url || '';
    const isTarget = url.includes(HOST_MATCH);
    if (!isTarget) return origFetch.apply(this, arguments);

    const method = (init && init.method) || (typeof input !== 'string' && input?.method) || 'GET';
    const reqBody = init && init.body ? truncate(init.body, MAX_REQ_BODY) : null;

    let response;
    try {
      response = await origFetch.apply(this, arguments);
    } catch (err) {
      enqueue({ type: 'fetch', url, method, reqBody, error: String(err) });
      throw err;
    }
    let respBody = null;
    try { respBody = truncate(await response.clone().text(), MAX_RESP_BODY); } catch {}
    enqueue({ type: 'fetch', url, method, reqBody, respBody, status: response.status });
    return response;
  };

  const OrigXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new OrigXHR();
    let _url = '', _method = '', _reqBody = null;
    const origOpen = xhr.open;
    xhr.open = function (m, u) { _method = m; _url = u; return origOpen.apply(xhr, arguments); };
    const origSend = xhr.send;
    xhr.send = function (body) {
      _reqBody = body ? truncate(body, MAX_REQ_BODY) : null;
      xhr.addEventListener('loadend', () => {
        if (!_url.includes(HOST_MATCH)) return;
        let respBody = null;
        try { respBody = truncate(xhr.responseText, MAX_RESP_BODY); } catch {}
        enqueue({ type: 'xhr', url: _url, method: _method, reqBody: _reqBody, respBody, status: xhr.status });
      });
      return origSend.apply(xhr, arguments);
    };
    return xhr;
  }
  PatchedXHR.prototype = OrigXHR.prototype;
  window.XMLHttpRequest = PatchedXHR;

  let flushing = false;
  async function flush() {
    if (flushing || pending.length === 0) return;
    flushing = true;
    const batch = pending.slice(0, 100);
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
      const res = await origFetch(WORKER_URL + '/collect', {
        method: 'POST',
        headers: {
          'authorization': 'Bearer ' + SHARED_SECRET,
          'content-type': 'application/json',
        },
        body: JSON.stringify(batch),
        signal: ctrl.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) throw new Error('worker ' + res.status);
      pending = pending.slice(batch.length);
      stats.sent += batch.length;
      stats.lastFlush = Date.now();
      persistPending();
      persistStats();
      updateBadge();
    } catch (err) {
      stats.failed++;
      persistStats();
      console.warn(LOG_PREFIX, 'flush failed, retry next tick:', err.message || err);
    } finally {
      flushing = false;
    }
  }

  setInterval(flush, FLUSH_INTERVAL_MS);

  let badgeEl = null;
  function ensureBadge() {
    if (badgeEl) return badgeEl;
    if (!document.body) return null;
    badgeEl = document.createElement('div');
    badgeEl.id = 'unipath-bridge-badge';
    Object.assign(badgeEl.style, {
      position: 'fixed', bottom: '8px', right: '8px', zIndex: '99999',
      background: 'rgba(20,20,20,0.78)', color: platform.color,
      font: '11px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace',
      padding: '4px 8px', borderRadius: '6px',
      cursor: 'pointer', userSelect: 'none',
      boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
    });
    badgeEl.title = 'Click to flush now · Right-click to clear pending';
    badgeEl.addEventListener('click', () => flush());
    badgeEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (confirm('Clear all pending events?')) {
        pending = []; persistPending(); updateBadge();
      }
    });
    document.body.appendChild(badgeEl);
    return badgeEl;
  }
  function updateBadge() {
    const el = ensureBadge();
    if (!el) return;
    el.textContent = `${platform.emoji} ${platform.label}: ${stats.sent} sent · ${pending.length} pending`;
  }

  const init = () => {
    ensureBadge();
    updateBadge();
    if (pending.length > 0) flush();
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  const ns = `${SOURCE}Bridge`;
  window[ns + 'Status'] = () => {
    const s = { source: SOURCE, pending: pending.length, sent: stats.sent, failed: stats.failed, lastFlush: stats.lastFlush };
    console.log(LOG_PREFIX, s);
    return s;
  };
  window[ns + 'Flush'] = () => flush();
  window[ns + 'Clear'] = () => {
    pending = [];
    persistPending();
    updateBadge();
    console.log(LOG_PREFIX, 'cleared pending');
  };

  console.log(LOG_PREFIX, 'active. Worker:', WORKER_URL, '· Source:', SOURCE, '· Commands:', `${ns}Status(), ${ns}Flush(), ${ns}Clear()`);
})();
