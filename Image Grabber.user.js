// ==UserScript==
// @name         Image Grabber
// @namespace    https://github.com/NoahTheGinger
// @author       NoahTheGinger & Claude Opus 5.5
// @version      1.1.0
// @description  Menu entry opens a dashboard of every image on the page. Tap the ones you want, then save them to Photos or Files. On desktop, also restores right-click > Save image as on sites that block it.
// @match        *://*/*
// @noframes
// @run-at       document-start
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      *
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';
  if (window.top !== window.self) return;

  const HOST_ID = 'img-grabber-host';
  const SMALL_PX = 200;      // "Hide small" threshold (longest side)
  const CONCURRENCY = 4;     // parallel downloads while preparing
  const LAZY_ATTRS = ['data-src', 'data-original', 'data-lazy-src', 'data-lazy', 'data-full', 'data-hi-res-src'];
  const IMG_URL = /\.(jpe?g|png|gif|webp|avif|bmp|svg|heic|heif)(?:[?#]|$)/i;
  const SKIP_TAGS = new Set(['script', 'style', 'meta', 'link', 'noscript', 'path', 'title', 'head']);
  const EXT = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
    'image/avif': 'avif', 'image/heic': 'heic', 'image/bmp': 'bmp', 'image/svg+xml': 'svg',
  };

  let items = [];          // {url, thumb, w, sel, state, blob, mime, dims, nw, nh, el, badge, hidden}
  let ui = {};
  let lastHref = '';
  let active = 0;
  const queue = [];

  GM_registerMenuCommand('🖼️ Image Grabber', openDashboard);

  // ───────────────────── desktop: right-click > "Save image as…" ─────────────────────
  // Many sites lay a transparent element over photos, or cancel the context menu, so the browser's own
  // "Save image as…" never reaches the <img>. On right-click we find the picture under the cursor, take
  // whatever covers it out of the hit test for a moment, and stop the site's handlers from cancelling the
  // menu. The browser's normal menu then opens on the real image. Mouse devices only (not iOS).

  const DESKTOP = matchMedia('(hover: hover) and (pointer: fine)').matches;
  const RC_KEY = 'rightClickSave';
  const RC_MIN_SIDE = 80;   // displayed px; smaller images (UI icons) are left alone
  let rcOn = true;
  let rcMenuId = null;
  let rcTimer = 0;
  let patched = [];

  function neutralize(el, value) {
    patched.push({
      el,
      v: el.style.getPropertyValue('pointer-events'),
      p: el.style.getPropertyPriority('pointer-events'),
    });
    el.style.setProperty('pointer-events', value, 'important');
  }

  function restore() {
    clearTimeout(rcTimer);
    for (const { el, v, p } of patched.reverse()) {
      if (v) el.style.setProperty('pointer-events', v, p);
      else el.style.removeProperty('pointer-events');
    }
    patched = [];
  }

  const bigEnough = (el) => {
    const r = el.getBoundingClientRect();
    return Math.min(r.width, r.height) >= RC_MIN_SIDE;
  };

  // True if there is a real picture under the cursor; also clears whatever covers it.
  function primeAt(x, y) {
    const stack = document.elementsFromPoint(x, y);
    if (!stack.length || stack[0].id === HOST_ID) return false; // our own dashboard: leave it alone
    let img = stack.find((el) => el.localName === 'img' && bigEnough(el));
    let above = [];
    if (img) {
      above = stack.slice(0, stack.indexOf(img)).filter((el) => !el.contains(img));
    } else {
      // An <img> with pointer-events:none never shows up in elementsFromPoint, so check geometry instead
      let best = Infinity;
      for (const el of document.images) {
        const r = el.getBoundingClientRect();
        if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
        if (Math.min(r.width, r.height) < RC_MIN_SIDE) continue;
        const cs = getComputedStyle(el);
        if (cs.pointerEvents !== 'none' || cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
        if (!stack[0].contains(el)) continue; // something else is on top of it
        if (r.width * r.height < best) { best = r.width * r.height; img = el; }
      }
    }
    if (!img) return false;
    restore();
    above.slice(0, 12).forEach((el) => { if (el.style) neutralize(el, 'none'); });
    if (getComputedStyle(img).pointerEvents === 'none') neutralize(img, 'auto');
    rcTimer = setTimeout(restore, 5000); // failsafe
    return true;
  }

  function onMouseDown(e) {
    if (rcOn && (e.button === 2 || (e.button === 0 && e.ctrlKey))) primeAt(e.clientX, e.clientY);
  }

  function onContextMenu(e) {
    if (!rcOn) return;
    if (!patched.length && !primeAt(e.clientX, e.clientY)) return;
    e.stopImmediatePropagation(); // sites that call preventDefault() to block the menu never see the event
    setTimeout(restore, 80);
  }

  function registerToggle() {
    if (rcMenuId != null && typeof GM_unregisterMenuCommand === 'function') {
      try { GM_unregisterMenuCommand(rcMenuId); } catch (e) { /* ignore */ }
    }
    rcMenuId = GM_registerMenuCommand('Right-click save: ' + (rcOn ? 'ON' : 'OFF'), () => {
      rcOn = !rcOn;
      try { GM_setValue(RC_KEY, rcOn); } catch (e) { /* ignore */ }
      if (!rcOn) restore();
      registerToggle();
    });
  }

  if (DESKTOP) {
    try { rcOn = GM_getValue(RC_KEY, true) !== false; } catch (e) { /* default: on */ }
    registerToggle();
    window.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('contextmenu', onContextMenu, true);
  }

  // ───────────────────────── finding images ─────────────────────────

  const abs = (u) => { try { return new URL(u, location.href).href; } catch (e) { return null; } };

  // Largest candidate in a srcset (handles Instagram's "url 640w,url 750w" with no spaces after commas)
  function bestSrcset(srcset) {
    const re = /(?:^|,)\s*(\S+?)\s+([\d.]+)([wx])(?=\s*(?:,|$))/g;
    let m, best = null, top = -1;
    while ((m = re.exec(srcset))) {
      const score = m[3] === 'w' ? +m[2] : +m[2] * 1000;
      if (score > top) { top = score; best = { url: m[1], w: m[3] === 'w' ? +m[2] : 0 }; }
    }
    if (!best) {
      const first = srcset.trim().split(/\s+/)[0];
      if (first) best = { url: first.replace(/,$/, ''), w: 0 };
    }
    return best;
  }

  function collect() {
    const map = new Map();
    const add = (raw, o) => {
      const url = raw && abs(String(raw).trim());
      if (!url || !/^(https?:|data:image\/|blob:)/i.test(url)) return;
      if (!map.has(url)) map.set(url, { url, thumb: (o && o.thumb) || url, w: (o && o.w) || 0 });
    };

    const visit = (root) => {
      let els;
      try { els = root.querySelectorAll('*'); } catch (e) { return; }
      for (const el of els) {
        const tag = el.localName;
        if (SKIP_TAGS.has(tag)) continue;
        if (el.shadowRoot) visit(el.shadowRoot);

        if (tag === 'img') {
          const cur = el.currentSrc || el.src || '';
          const thumb = cur && !cur.startsWith('data:') ? cur : undefined;
          const ss = el.getAttribute('srcset') || el.getAttribute('data-srcset');
          const best = ss && bestSrcset(ss);
          if (best) {
            add(best.url, { w: best.w, thumb });
          } else {
            add(cur);
            LAZY_ATTRS.forEach((a) => add(el.getAttribute(a)));
          }
        } else if (tag === 'video') {
          add(el.poster);
        } else if (tag === 'image') {
          add(el.getAttribute('href') || el.getAttribute('xlink:href'));
        } else if (tag === 'a') {
          const href = el.getAttribute('href');
          if (href && IMG_URL.test(href)) add(href);
        } else if (tag === 'iframe') {
          try { if (el.contentDocument) visit(el.contentDocument); } catch (e) { /* cross-origin */ }
        }

        try {
          const bg = getComputedStyle(el).backgroundImage;
          if (bg && bg !== 'none') {
            for (const m of bg.matchAll(/url\((["']?)(.*?)\1\)/g)) add(m[2]);
          }
        } catch (e) { /* ignore */ }
      }
    };

    visit(document);
    document.querySelectorAll('meta[property="og:image"],meta[name="twitter:image"]').forEach((m) => add(m.content));
    document.querySelectorAll('link[rel="image_src"]').forEach((l) => add(l.href));
    return [...map.values()];
  }

  // ───────────────────────── fetching + preparing ─────────────────────────

  function gmGet(url, type) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: type,
        timeout: 30000,
        onload: (r) => {
          const res = r.response;
          if (r.status >= 400 || !res) return reject(new Error('HTTP ' + r.status));
          if (typeof res.size === 'number' && typeof res.type === 'string') return resolve(res);
          if (Object.prototype.toString.call(res) === '[object ArrayBuffer]') return resolve(new Blob([res]));
          reject(new Error('unsupported response'));
        },
        onerror: reject,
        ontimeout: reject,
      });
    });
  }

  async function getBlob(url) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 20000);
      const r = await fetch(url, { signal: ctl.signal });
      clearTimeout(t);
      if (r.ok) { const b = await r.blob(); if (b.size) return b; }
    } catch (e) { /* fall through to GM request */ }
    for (const type of ['blob', 'arraybuffer']) {
      try { const b = await gmGet(url, type); if (b && b.size) return b; } catch (e) { /* try next */ }
    }
    throw new Error('unreachable');
  }

  async function sniff(blob, url) {
    try {
      const b = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
      const s = (i, n) => String.fromCharCode(...b.slice(i, i + n));
      if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
      if (s(1, 3) === 'PNG') return 'image/png';
      if (s(0, 3) === 'GIF') return 'image/gif';
      if (s(0, 4) === 'RIFF' && s(8, 4) === 'WEBP') return 'image/webp';
      if (s(4, 4) === 'ftyp') return /avif|avis/.test(s(8, 4)) ? 'image/avif' : 'image/heic';
      if (s(0, 2) === 'BM') return 'image/bmp';
    } catch (e) { /* ignore */ }
    if (/svg/i.test(blob.type) || /\.svg(?:[?#]|$)/i.test(url)) return 'image/svg+xml';
    return blob.type && blob.type.startsWith('image/') ? blob.type : 'image/jpeg';
  }

  function toJpeg(bmp) {
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(bmp, 0, 0);
    return new Promise((res) => c.toBlob((b) => res(b), 'image/jpeg', 0.95));
  }

  async function prepare(it) {
    let blob = await getBlob(it.url);
    let mime = await sniff(blob, it.url);
    let bmp = null;
    if (mime !== 'image/svg+xml') { try { bmp = await createImageBitmap(blob); } catch (e) { /* undecodable */ } }
    if (bmp) it.dims = bmp.width + '×' + bmp.height;
    // iOS Photos only takes JPEG/PNG/GIF reliably, so convert WebP/AVIF/HEIC/BMP
    if (bmp && !/^image\/(jpeg|png|gif)$/.test(mime)) {
      const jpg = await toJpeg(bmp);
      if (jpg) { blob = jpg; mime = 'image/jpeg'; }
    }
    if (bmp && bmp.close) bmp.close();
    it.blob = blob;
    it.mime = mime;
  }

  function pump() {
    while (active < CONCURRENCY && queue.length) {
      const it = queue.shift();
      if (!it.sel) { it.state = 'idle'; updateCard(it); continue; }
      active++;
      prepare(it)
        .then(() => { it.state = 'ready'; })
        .catch(() => { it.state = 'error'; })
        .finally(() => { active--; updateCard(it); refresh(); pump(); });
    }
  }

  function setSel(it, on) {
    it.sel = on;
    if (on && (it.state === 'idle' || it.state === 'error')) {
      it.state = 'loading';
      queue.push(it);
      pump();
    }
    updateCard(it);
  }

  // ───────────────────────── saving ─────────────────────────

  function fileName(it, n, pad) {
    let base = '';
    if (/^https?:/i.test(it.url)) {
      try { base = decodeURIComponent(new URL(it.url).pathname.split('/').pop() || ''); } catch (e) { /* ignore */ }
    }
    base = base.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[^\w-]+/g, '_').slice(0, 50) || 'image';
    const host = location.hostname.replace(/^www\./, '');
    return host + '_' + String(n + 1).padStart(pad, '0') + '_' + base + '.' + (EXT[it.mime] || 'jpg');
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function download(file) {
    const u = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = u;
    a.download = file.name;
    ui.root.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 60000);
  }

  // The first await in here is navigator.share itself, so the tap's user activation is still valid.
  async function save() {
    const sel = chosen().filter((i) => i.state === 'ready');
    if (!sel.length) return;
    const pad = String(sel.length).length;
    const files = sel.map((it, n) => new File([it.blob], fileName(it, n, pad), { type: it.mime }));
    if (!DESKTOP && navigator.canShare && navigator.canShare({ files })) {
      try {
        await navigator.share({ files });
        toast('Shared');
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    toast(DESKTOP ? 'Downloading ' + files.length + (files.length === 1 ? ' file' : ' files') + '…' : 'Share sheet unavailable. Downloading files instead.');
    for (const f of files) { download(f); await sleep(500); }
  }

  // ───────────────────────── dashboard UI ─────────────────────────

  const h = (tag, props, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    kids.flat().forEach((c) => el.append(c));
    return el;
  };

  const CSS = `
    *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
    [hidden]{display:none!important}
    .app{position:absolute;inset:0;display:flex;flex-direction:column;background:#0b0b0d;color:#f2f2f7;
      font:15px/1.3 -apple-system,system-ui,sans-serif}
    header{display:flex;align-items:center;gap:6px;padding:calc(env(safe-area-inset-top,0px) + 10px) 12px 8px}
    header strong{font-size:17px}
    .count{opacity:.6;font-size:13px;margin-left:4px}
    .sp{flex:1}
    button{font:inherit;color:inherit;background:#2c2c2e;border:0;border-radius:10px;padding:0 14px;min-height:40px}
    button.ic{width:40px;padding:0;font-size:18px}
    .tools{display:flex;gap:8px;align-items:center;padding:0 12px 8px;font-size:14px}
    .tools button{min-height:34px;font-size:14px}
    .tools label{margin-left:auto;display:flex;align-items:center;gap:6px}
    .grid{flex:1;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;display:grid;
      grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:6px;padding:6px 12px;align-content:start}
    .empty{grid-column:1/-1;padding:40px 12px;text-align:center;opacity:.6}
    .card{position:relative;aspect-ratio:1;background:#1c1c1e;border-radius:10px;overflow:hidden;
      outline:3px solid transparent;outline-offset:-3px}
    .card img{width:100%;height:100%;object-fit:cover;display:block}
    .card.sel{outline-color:#0a84ff}
    .card.busy img{opacity:.45}
    .card.bad img{opacity:.35}
    .card.bad::after{content:"Couldn't fetch. Tap Open, then long-press to save.";position:absolute;inset:0;
      display:grid;place-items:center;padding:8px;text-align:center;font-size:12px;pointer-events:none}
    .tick{position:absolute;top:6px;right:6px;width:24px;height:24px;border-radius:50%;background:rgba(0,0,0,.45);
      border:2px solid #fff;color:transparent;display:grid;place-items:center;font-size:13px}
    .sel .tick{background:#0a84ff;border-color:#0a84ff;color:#fff}
    .meta{position:absolute;left:0;right:0;bottom:0;display:flex;justify-content:space-between;gap:4px;
      padding:16px 7px 5px;background:linear-gradient(transparent,rgba(0,0,0,.72));font-size:11px}
    .meta a{color:#fff;text-decoration:none}
    footer{padding:8px 12px calc(env(safe-area-inset-bottom,0px) + 10px);background:#151517;border-top:1px solid #2c2c2e}
    .primary{width:100%;min-height:48px;background:#0a84ff;color:#fff;font-weight:600;font-size:16px}
    .primary:disabled{background:#2c2c2e;color:#8e8e93}
    .hint{font-size:11px;opacity:.55;text-align:center;margin-top:6px}
    .toast{position:absolute;left:50%;bottom:116px;transform:translateX(-50%);background:rgba(0,0,0,.85);
      padding:8px 14px;border-radius:20px;font-size:13px;opacity:0;pointer-events:none;transition:opacity .2s;
      max-width:90%;text-align:center}
    .toast.show{opacity:1}
  `;

  function applyCss(root) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
    } catch (e) {
      root.append(h('style', {}, CSS));
    }
  }

  function buildUI() {
    const host = document.createElement('div');
    host.id = HOST_ID;
    Object.assign(host.style, { position: 'fixed', inset: '0', zIndex: '2147483647' });
    const root = host.attachShadow({ mode: 'open' });
    applyCss(root);

    ui = { host, root };
    ui.count = h('span', { class: 'count' });
    ui.grid = h('main', { class: 'grid' });
    ui.save = h('button', { class: 'primary', onclick: save });
    ui.small = h('input', { type: 'checkbox', checked: '', onchange: () => { applyFilter(); refresh(); } });
    ui.toast = h('div', { class: 'toast' });

    root.append(
      h('div', { class: 'app' },
        h('header', {},
          h('strong', {}, 'Images'), ui.count, h('span', { class: 'sp' }),
          h('button', { class: 'ic', 'aria-label': 'Rescan page', onclick: merge }, '↻'),
          h('button', { class: 'ic', 'aria-label': 'Close', onclick: close }, '✕')),
        h('div', { class: 'tools' },
          h('button', { onclick: () => selectAll(true) }, 'Select all'),
          h('button', { onclick: () => selectAll(false) }, 'Clear'),
          h('label', {}, ui.small, 'Hide small')),
        ui.grid,
        h('footer', {}, ui.save,
          h('div', { class: 'hint' }, 'Save opens the share sheet: Save Image for Photos, or Save to Files.')),
        ui.toast));
    document.documentElement.append(host);
  }

  function makeCard(it) {
    const img = h('img', { src: it.thumb, alt: '', decoding: 'async' });
    img.addEventListener('load', () => { it.nw = img.naturalWidth; it.nh = img.naturalHeight; updateCard(it); applyFilter(); });
    img.addEventListener('error', () => { it.broken = true; });
    it.badge = h('span', {});
    const open = h('a', {
      href: it.url, target: '_blank', rel: 'noopener noreferrer',
      onclick: (e) => e.stopPropagation(),
    }, 'Open');
    const card = h('div', { class: 'card', onclick: () => { setSel(it, !it.sel); refresh(); } },
      img, h('div', { class: 'tick' }, '✓'), h('div', { class: 'meta' }, it.badge, open));
    it.el = card;
    updateCard(it);
    return card;
  }

  function updateCard(it) {
    if (!it.el) return;
    it.el.classList.toggle('sel', !!it.sel);
    it.el.classList.toggle('busy', it.state === 'loading');
    it.el.classList.toggle('bad', it.state === 'error');
    const real = Math.max(it.nw || 0, it.nh || 0);
    it.badge.textContent = it.dims || (it.w > real ? it.w + 'w' : it.nw ? it.nw + '×' + it.nh : '');
  }

  const chosen = () => items.filter((i) => i.sel && !i.hidden);

  function applyFilter() {
    const hide = ui.small && ui.small.checked;
    let shown = 0;
    for (const it of items) {
      const size = Math.max(it.w || 0, it.nw || 0, it.nh || 0);
      it.hidden = !!hide && size > 0 && size < SMALL_PX;
      if (it.el) it.el.hidden = it.hidden;
      if (!it.hidden) shown++;
    }
    if (ui.count) ui.count.textContent = shown + ' of ' + items.length;
  }

  function refresh() {
    if (!ui.save) return;
    const sel = chosen();
    const ready = sel.filter((i) => i.state === 'ready').length;
    const loading = sel.filter((i) => i.state === 'loading').length;
    const failed = sel.filter((i) => i.state === 'error').length;
    const b = ui.save;
    if (!sel.length) { b.disabled = true; b.textContent = 'Tap images to select'; }
    else if (loading) { b.disabled = true; b.textContent = 'Preparing ' + ready + ' of ' + sel.length + '…'; }
    else if (!ready) { b.disabled = true; b.textContent = "Couldn't fetch. Use Open on each image."; }
    else {
      b.disabled = false;
      b.textContent = 'Save ' + ready + (ready === 1 ? ' image' : ' images') + (failed ? ' (' + failed + ' failed)' : '');
    }
  }

  function selectAll(on) {
    items.forEach((it) => { if (!on || !it.hidden) setSel(it, on); });
    refresh();
  }

  function render() {
    ui.grid.replaceChildren();
    if (!items.length) {
      ui.grid.append(h('div', { class: 'empty' }, 'No images found. Scroll the page so they load, then tap ↻.'));
    }
    items.forEach((it) => ui.grid.append(makeCard(it)));
    applyFilter();
    refresh();
  }

  function toast(msg) {
    if (!ui.toast) return;
    ui.toast.textContent = msg;
    ui.toast.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => ui.toast.classList.remove('show'), 2200);
  }

  // Re-scan and keep everything found earlier on this page (carousel slides that left the DOM stay in the list)
  function merge() {
    const have = new Set(items.map((i) => i.url));
    const fresh = collect()
      .filter((c) => !have.has(c.url))
      .map((c) => Object.assign(c, { sel: false, state: 'idle' }));
    items = items.concat(fresh);
    render();
    toast(fresh.length ? fresh.length + ' new found' : 'Nothing new');
  }

  function close() {
    if (ui.host) ui.host.remove();
    ui = {};
  }

  function openDashboard() {
    if (lastHref && lastHref !== location.href) items = []; // different page (SPA navigation): start fresh
    lastHref = location.href;
    if (!document.getElementById(HOST_ID)) buildUI();
    merge();
  }
})();
