// ==UserScript==
// @name         Clear Scrape — intelligent page scraper
// @namespace    https://github.com/NoahTheGinger/Userscripts
// @author       NoahTheGinger & ChatGPT 6.1 Sol (Max)
// @version      1.0.3
// @description  Detect tables and repeated cards, pick a region, crawl pagination, and export clean CSV, JSON, Markdown or HTML. No external services.
// @match        http://*/*
// @match        https://*/*
// @run-at       document-idle
// @noframes
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @grant        GM.getTab
// @grant        GM.saveTab
// @grant        GM.registerMenuCommand
// @license      MIT
// @downloadURL https://update.greasyfork.org/scripts/601802/Clear%20Scrape%20%E2%80%94%20intelligent%20page%20scraper.user.js
// @updateURL https://update.greasyfork.org/scripts/601802/Clear%20Scrape%20%E2%80%94%20intelligent%20page%20scraper.meta.js
// ==/UserScript==

/* Clear Scrape 1.0.3 — original, dependency-free implementation. */
(() => {
  'use strict';
  const VERSION = 1;
  const PREFIX = 'clear-scrape:v1:';
  const DISPLAY_KEY = PREFIX + 'display-hidden';
  const HOST_ID = 'clear-scrape-ui';
  const SKIP = 'script,style,noscript,template,svg,canvas,iframe,button,input,select,textarea,[hidden],[aria-hidden="true"]';
  const TABLE = 'table,[role="table"],[role="grid"],[role="treegrid"]';
  const BLOCK = 'div,section,article,ul,ol,dl,p,h1,h2,h3,h4,h5,h6,address,table';
  const DEFAULTS = { delay: 1200, timeout: 30000, settle: 800, maxPages: 0, maxRows: 0,
    dedupe: true, links: true, images: false, provenance: false, csvSafe: true, autoDownload: false, format: 'csv' };
  let job, tabInfo, tabKey, host, shadow, candidates = [], live = null;
  let panelOpen = false, uiHidden = false, busy = false, generation = 0, pickerCleanup = null, highlightTimer;
  let rowKeys = new Set(), saving = Promise.resolve(), checkpointFailed = false, previewPage = 0;
  const $ = id => shadow?.getElementById(id);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const normalize = value => String(value ?? '').replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n')
    .split('\n').map(s => s.replace(/[\t\f\v ]+/g, ' ').trim()).filter(Boolean).join('\n').trim();
  const flat = value => normalize(value).replace(/\s+/g, ' ');
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const css = value => CSS.escape(String(value));
  const query = (root, selector) => { try { return root.querySelector(selector); } catch { return null; } };
  const queryAll = (root, selector) => { try { return [...root.querySelectorAll(selector)]; } catch { return []; } };
  const owned = el => el === host || el?.getRootNode?.() === shadow;
  function visible(el) {
    if (!(el instanceof Element) || owned(el) || el.closest('[hidden],[aria-hidden="true"],script,style,template')) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
      && (el.getClientRects().length > 0 || (style.display === 'contents' && [...el.children].some(visible)));
  }
  function text(el) { return el && visible(el) ? normalize(el.innerText ?? el.textContent) : ''; }
  function safeURL(raw, base = document.baseURI, images = false) {
    try { const u = new URL(raw, base); return (images ? ['http:', 'https:'] : ['http:', 'https:', 'mailto:', 'tel:']).includes(u.protocol) ? u.href : ''; }
    catch { return ''; }
  }
  function urls(el, images = false) {
    const nodes = [...(el.matches(images ? 'img' : 'a[href]') ? [el] : []), ...queryAll(el, images ? 'img' : 'a[href]')];
    return [...new Set(nodes.filter(visible).map(n => safeURL(images ? (n.currentSrc || n.getAttribute('src') || n.getAttribute('data-src')) : n.getAttribute('href'), document.baseURI, images)).filter(Boolean))].join('\n');
  }
  function stableClasses(el) {
    return [...el.classList].filter(c => c.length < 65 && !/^(?:active|selected|disabled|odd|even|first|last|hover|focus|is-|has-|css-|sc-|ng-|v-|js-)/i.test(c)
      && !/\d{3,}|[a-f\d]{10,}|[:/\[\]]/i.test(c));
  }
  function usefulClasses(el) {
    return stableClasses(el).filter(c => !/^(?:flex|grid|block|inline|hidden|relative|absolute|text-|font-|bg-|p[trblxy]?-|m[trblxy]?-|gap-|w-|h-|items-|justify-|col-|row-|rounded|border|shadow|overflow)/.test(c));
  }
  function segment(el) {
    if (el.id && !/\d{5,}|^[a-f\d-]{20,}$/i.test(el.id)) return '#' + css(el.id);
    for (const attr of ['data-testid', 'data-test', 'data-qa', 'itemprop']) {
      const v = el.getAttribute(attr); if (v && v.length < 90) return el.localName + '[' + attr + '="' + css(v) + '"]';
    }
    return el.localName + usefulClasses(el).slice(0, 2).map(c => '.' + css(c)).join('');
  }
  function selectorFor(el, root = document) {
    if (el === root) return ':scope';
    const unique = s => queryAll(root, s).length === 1 && query(root, s) === el;
    let node = el, path = '';
    for (let depth = 0; node && node !== root && depth < 12; depth++, node = node.parentElement) {
      let part = segment(node);
      path = part + (path ? ' > ' + path : '');
      if (unique(path)) return path;
      const siblings = node.parentElement ? [...node.parentElement.children].filter(n => n.localName === node.localName) : [];
      if (siblings.length > 1) {
        part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
        path = part + (path.includes(' > ') ? path.slice(path.indexOf(' > ')) : '');
        if (unique(path)) return path;
      }
      if (node.parentElement === root) break;
    }
    return path;
  }
  function rootSelectors(el) {
    const selectors = [selectorFor(el)];
    const s = segment(el);
    if (!selectors.includes(s) && queryAll(document, s).length === 1) selectors.push(s);
    return selectors;
  }
  const human = s => flat(s).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).slice(0, 90);
  function labelFor(el, index) {
    const explicit = el.getAttribute('data-label') || el.getAttribute('aria-label') || el.getAttribute('itemprop');
    if (explicit) return human(explicit);
    if (el.matches('dd') && el.previousElementSibling?.matches('dt')) return flat(text(el.previousElementSibling));
    if (/^H[1-6]$/.test(el.tagName)) return 'Title';
    if (el.matches('time')) return 'Date';
    if (el.matches('address')) return 'Address';
    const cls = usefulClasses(el).find(c => !/^(?:card|item|entry|content|wrapper|container|body|row|cell)$/i.test(c));
    return cls ? human(cls.replace(/^(?:card|item|entry|product|result)[_-]/, '')) : (el.matches('a') ? 'Link' : 'Field ' + (index + 1));
  }
  function sameDataKey(row) {
    return JSON.stringify(Object.keys(row).sort().filter(k => row[k] !== '').map(k => [k, row[k]]));
  }
  function fingerprint(rows) {
    const s = rows.map(sameDataKey).sort().join('\u001e');
    let a = 2166136261, b = 5381;
    for (let i = 0; i < s.length; i++) { a = Math.imul(a ^ s.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ s.charCodeAt(i); }
    return rows.length + ':' + s.length + ':' + (a >>> 0).toString(36) + ':' + (b >>> 0).toString(36);
  }
  function freshJob() {
    return { version: VERSION, origin: location.origin, title: document.title || location.hostname, started: new Date().toISOString(),
      status: 'idle', message: 'Choose a data region to begin.', recipe: null, next: null, options: { ...DEFAULTS },
      columns: [], records: [], pages: [], signatures: [], pending: null, filename: location.hostname.replace(/[^\w.-]/g, '_') + '-scrape' };
  }

  // Tables: expand row/column spans before resolving multi-line column headers.
  function readTable(root, kind = 'table') {
    const aria = kind === 'aria';
    const rows = queryAll(root, aria ? '[role="row"]' : 'tr').filter(r => visible(r)
      && (aria ? r.closest('[role="table"],[role="grid"],[role="treegrid"]') === root : r.closest('table') === root)
      && !r.closest('tfoot'));
    const grid = [], headerFlags = [];
    rows.forEach((row, ri) => {
      grid[ri] ||= [];
      const cells = (aria ? queryAll(row, '[role="cell"],[role="gridcell"],[role="columnheader"],[role="rowheader"]')
        .filter(c => c.closest('[role="row"]') === row) : [...row.cells]).filter(visible);
      headerFlags[ri] = !!row.closest('thead') || (cells.length > 0 && cells.every(c => aria ? c.getAttribute('role') === 'columnheader' : c.tagName === 'TH'));
      let ci = 0;
      for (const cell of cells) {
        while (grid[ri][ci]) ci++;
        const rsRaw = cell.getAttribute(aria ? 'aria-rowspan' : 'rowspan');
        const remaining = rows.slice(ri).filter(r => r.parentElement === row.parentElement).length;
        const rs = rsRaw === '0' ? remaining : Math.max(1, Math.min(1000, parseInt(rsRaw, 10) || 1));
        const cs = Math.max(1, Math.min(1000, parseInt(cell.getAttribute(aria ? 'aria-colspan' : 'colspan'), 10) || 1));
        for (let y = ri; y < Math.min(rows.length, ri + rs); y++) {
          grid[y] ||= [];
          for (let x = ci; x < ci + cs; x++) grid[y][x] = cell;
        }
        ci += cs;
      }
    });
    let headers = 0;
    while (headers < rows.length && headerFlags[headers]) headers++;
    const width = Math.max(0, ...grid.map(r => r.length));
    const columns = [];
    for (let ci = 0; ci < width; ci++) {
      const names = [...new Set(grid.slice(0, headers).map(r => text(r[ci])).filter(Boolean))];
      const label = names.join(' / ') || 'Column ' + (ci + 1);
      columns.push({ key: 'c' + ci, label, kind: 'text' });
      if (job.options.links && grid.slice(headers).some(r => r[ci] && urls(r[ci]))) columns.push({ key: 'c' + ci + ':url', label: label + ' URL', kind: 'url' });
      if (job.options.images && grid.slice(headers).some(r => r[ci] && urls(r[ci], true))) columns.push({ key: 'c' + ci + ':image', label: label + ' Image URL', kind: 'image' });
    }
    const result = grid.slice(headers).map(row => Object.fromEntries(columns.map(c => {
      const cell = row[parseInt(c.key.slice(1), 10)];
      return [c.key, cell ? (c.kind === 'url' ? urls(cell) : c.kind === 'image' ? urls(cell, true) : text(cell)) : ''];
    }))).filter(r => Object.values(r).some(Boolean));
    return { columns, rows: result, nodes: rows.slice(headers), root };
  }

  function atoms(record) {
    const fields = [];
    function walk(node, depth = 0) {
      if (depth > 12 || fields.length >= 90 || !visible(node) || node.matches(SKIP) || node.matches('dt')) return;
      const children = [...node.children].filter(c => !c.matches(SKIP) && visible(c));
      if (node.matches('img')) { if (job.options.images) fields.push({ node, attr: 'src' }); return; }
      const directText = normalize([...node.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join(' '));
      const atomic = !children.length || (node.matches('h1,h2,h3,h4,h5,h6,p,address,time,dd,a,li') && !query(node, BLOCK));
      if (atomic && text(node)) {
        fields.push({ node, attr: 'text' });
        if (job.options.links && urls(node)) fields.push({ node, attr: 'url' });
        if (job.options.images && urls(node, true)) fields.push({ node, attr: 'src' });
        return;
      }
      if (directText) fields.push({ node, attr: 'own' });
      for (const child of children) walk(child, depth + 1);
    }
    walk(record);
    return fields;
  }
  function cardFields(records) {
    const fields = new Map();
    for (const record of records.slice(0, 18)) {
      for (const atom of atoms(record)) {
        const sel = atom.node === record ? ':scope' : selectorFor(atom.node, record);
        let label = labelFor(atom.node, fields.size);
        const dt = atom.node.matches('dd') && atom.node.previousElementSibling?.matches('dt') ? flat(text(atom.node.previousElementSibling)) : '';
        const key = 'f:' + (dt ? 'definition:' + dt : sel) + ':' + atom.attr;
        if (atom.attr === 'url') label += ' URL';
        if (atom.attr === 'src') label += ' Image URL';
        if (!fields.has(key)) fields.set(key, { key, label, selector: sel, definition: dt, attr: atom.attr,
          kind: atom.attr === 'url' ? 'url' : atom.attr === 'src' ? 'image' : 'text' });
      }
    }
    return [...fields.values()];
  }
  function readCards(root, recipe, fields = null) {
    let records = (recipe.single ? [root] : queryAll(root, recipe.rows || ':scope > *')).filter(n => visible(n) && !n.matches(SKIP));
    if (recipe.rowTag) records = records.filter(n => n.localName === recipe.rowTag);
    const columns = fields || [...new Map([...(recipe.fields || []), ...cardFields(records)].map(f => [f.key, f])).values()];
    // Keep the original names when a temporarily absent field changes discovery order.
    if (!fields && recipe.fields) for (const column of columns) {
      const original = recipe.fields.find(f => f.key === column.key);
      if (original) column.label = original.label;
    }
    const result = records.map(record => Object.fromEntries(columns.map(f => {
      let node;
      if (f.definition) node = queryAll(record, 'dd').find(n => n.previousElementSibling?.matches('dt') && flat(text(n.previousElementSibling)) === f.definition);
      else node = f.selector === ':scope' ? record : query(record, f.selector);
      const value = !node || !visible(node) ? '' : f.attr === 'url' ? urls(node) : f.attr === 'src' ? urls(node, true)
        : f.attr === 'own' ? normalize([...node.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join(' ')) : text(node);
      return [f.key, value];
    }))).filter(r => Object.values(r).some(Boolean));
    return { root, columns, rows: result, nodes: records };
  }
  function recipeFor(root, kind, records = []) {
    const recipe = { kind, roots: rootSelectors(root) };
    if (kind === 'list') {
      const common = records.length ? usefulClasses(records[0]).filter(c => records.every(r => r.classList.contains(c))).slice(0, 2) : [];
      recipe.rowTag = records[0]?.localName || '';
      recipe.rows = ':scope > ' + (recipe.rowTag || '*') + common.map(c => '.' + css(c)).join('');
      recipe.fields = cardFields(records);
    }
    return recipe;
  }
  function readRecipe(recipe = job.recipe) {
    if (!recipe) return null;
    const root = recipe.roots.map(s => queryAll(document, s)).find(nodes => nodes.length === 1 && visible(nodes[0]))?.[0];
    if (!root) return null;
    const data = recipe.kind === 'list' ? readCards(root, recipe) : readTable(root, recipe.kind);
    // Header changes indicate a different table at a brittle position selector.
    if (recipe.headers?.length) {
      const names = data.columns.filter(c => c.kind === 'text').map(c => c.label);
      const matches = names.filter((n, i) => n === recipe.headers[i]).length;
      if (matches / Math.max(names.length, recipe.headers.length) < 0.6) return null;
    }
    return data;
  }
  function describe(root, kind) {
    const caption = query(root, 'caption');
    const heading = root.getAttribute('aria-label') || (caption && text(caption)) || root.closest('section,article')?.querySelector('h1,h2,h3')?.innerText;
    return flat(heading || (kind === 'table' ? 'Table' : kind === 'aria' ? 'ARIA grid' : 'Repeated ' + (root.matches('ul,ol') ? 'list' : 'cards')) + (root.id ? ' · ' + root.id : '')).slice(0, 100);
  }
  function structure(node) { return node.localName + ':' + [...node.children].filter(n => !n.matches(SKIP)).slice(0, 12).map(n => n.localName).join(','); }
  function detect(scope = document.body) {
    const found = [], seen = new Set();
    function add(root, kind, records = []) {
      if (!visible(root)) return;
      const recipe = recipeFor(root, kind, records);
      const key = recipe.roots[0] + '|' + (recipe.rows || kind);
      if (seen.has(key)) return;
      seen.add(key);
      const data = kind === 'list' ? readCards(root, recipe) : readTable(root, kind);
      if (!data.rows.length || (!data.columns.length)) return;
      if (kind === 'list' && (data.rows.length < 2 || data.columns.length > 80)) return;
      const chars = data.rows.reduce((n, row) => n + Object.values(row).join('').length, 0) / data.rows.length;
      if (kind === 'list' && chars < 5) return;
      const columns = data.columns.filter(c => c.kind === 'text').length;
      const semantic = kind !== 'list' ? 65 : root.matches('ul,ol,[role="list"]') ? 18 : records[0]?.matches('article,[itemtype]') ? 24 : 0;
      const score = semantic + Math.log2(data.rows.length + 1) * 9 + Math.min(columns, 8) * 4
        + (root.closest('main,[role="main"]') ? 12 : 0) - (root.closest('nav,header,footer,aside,[role="navigation"]') ? 80 : 0)
        - (chars > 1800 ? 50 : 0) - (columns > 30 ? 20 : 0);
      if (kind !== 'list') recipe.headers = data.columns.filter(c => c.kind === 'text').map(c => c.label);
      found.push({ recipe, data, root, label: describe(root, kind), score });
    }
    for (const root of [...(scope.matches?.(TABLE) ? [scope] : []), ...queryAll(scope, TABLE)]) {
      add(root, root.matches('table') ? 'table' : 'aria');
    }
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT);
    let node = scope, visited = 0;
    while (node && visited++ < 16000) {
      if (node !== host && !node.closest?.(TABLE) && node.children.length >= 2 && node.children.length <= 3000 && !node.matches(SKIP)
        && !node.closest?.('nav,header,footer,[role="navigation"]')) {
        const children = [...node.children].filter(c => !c.matches(SKIP) && visible(c));
        if (children.length >= 2) {
          const groups = new Map();
          for (const child of children) {
            const key = structure(child);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(child);
          }
          for (const group of groups.values()) {
            if (group.length < 2 || group[0].matches('br,hr,option,dt,dd,th,td,tr')) continue;
            if (group.every(n => !text(n) && !query(n, 'img'))) continue;
            add(node, 'list', group);
          }
          // A shared semantic class tolerates optional fields that alter child shape.
          const classGroups = new Map();
          for (const child of children) for (const cls of usefulClasses(child).slice(0, 3)) {
            const key = child.localName + '.' + cls;
            if (!classGroups.has(key)) classGroups.set(key, []);
            classGroups.get(key).push(child);
          }
          for (const group of classGroups.values()) if (group.length >= 2) add(node, 'list', group);
        }
      }
      node = walker.nextNode();
    }
    const signatures = new Set();
    return found.sort((a, b) => b.score - a.score).filter(c => {
      const sig = fingerprint(c.data.rows);
      if (signatures.has(sig)) return false;
      signatures.add(sig); return true;
    }).slice(0, 45);
  }

  // Next controls are resolved afresh on every page; their changing href is never frozen.
  function disabled(el) {
    if (!el || !visible(el)) return true;
    for (let n = el, depth = 0; n && depth < 4; n = n.parentElement, depth++) {
      if (n.matches(':disabled,[disabled],[inert],[aria-disabled="true"],[data-disabled="true"],.disabled,.is-disabled')) return true;
    }
    return getComputedStyle(el).pointerEvents === 'none';
  }
  function controlLabel(el) { return flat(el.getAttribute('aria-label') || el.getAttribute('title') || el.value || el.innerText || el.textContent).slice(0, 150); }
  function paginationContext(el) { return el.closest('nav,[role="navigation"],[class*="pagina"],[class*="pager"],[aria-label*="page" i]'); }
  function numericNext() {
    const current = queryAll(document, '[aria-current="page"],.pagination .active,.pagination .current,.pager .active').find(visible);
    if (!current) return null;
    const number = Number(flat(current.textContent));
    if (!Number.isFinite(number)) return null;
    const context = paginationContext(current) || current.parentElement?.parentElement;
    return queryAll(context || document, 'a,button,[role="button"]').find(n => visible(n) && Number(flat(n.textContent)) === number + 1) || null;
  }
  function autoNext() {
    const scored = [];
    for (const el of queryAll(document, 'a,button,[role="button"],input[type="button"],input[type="submit"]')) {
      if (!visible(el) || owned(el)) continue;
      const label = controlLabel(el), lower = label.toLowerCase();
      if (/\b(?:previous|prev|back|last|first|checkout|submit|delete|remove|buy)\b/i.test(lower)) continue;
      let score = (el.getAttribute('rel') || '').split(/\s+/).includes('next') ? 110 : 0;
      if (/^(?:next(?:\s+(?:page|results?))?|older(?:\s+(?:posts?|results?))?|load\s+more(?:\s+\w+)?|show\s+more(?:\s+\w+)?|view\s+more(?:\s+\w+)?|more\s+results?)[\s›»→>]*$/i.test(label)) score += 75;
      if (/^(?:›|»|→|>)$/.test(label) && paginationContext(el)) score += 50;
      if (score && paginationContext(el)) score += 18;
      if (score) scored.push({ el, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.el || numericNext();
  }
  function nextRecipe(el) {
    const label = controlLabel(el);
    const selectors = [];
    for (const attr of ['aria-label', 'title', 'data-testid', 'data-test']) {
      const value = el.getAttribute(attr);
      if (value && !/^\d+$/.test(value)) selectors.push(el.localName + '[' + attr + '="' + css(value) + '"]');
    }
    if ((el.getAttribute('rel') || '').split(/\s+/).includes('next')) selectors.unshift('[rel~="next"]');
    selectors.push(selectorFor(el));
    return { mode: 'picked', selectors, label, numeric: /^\d+$/.test(label), tag: el.localName };
  }
  function resolveNext() {
    if (!job.next || job.next.mode === 'auto') return autoNext();
    if (job.next.numeric) return numericNext();
    for (const selector of job.next.selectors) {
      const hits = queryAll(document, selector).filter(visible);
      const stable = !/:nth-|\s>\s/.test(selector) && /[#.\[]/.test(selector);
      const match = hits.find(n => controlLabel(n) === job.next.label) || (hits.length === 1 && (stable || !job.next.label) ? hits[0] : null);
      if (match) return match;
    }
    return queryAll(document, 'a,button,[role="button"],input[type="button"],input[type="submit"]').find(n => visible(n) && controlLabel(n) === job.next.label) || null;
  }
  function navigationURL(el) {
    const anchor = el?.closest('a[href]');
    const raw = anchor?.getAttribute('href');
    if (!raw || raw.startsWith('#') || /^javascript:/i.test(raw)) return '';
    return safeURL(raw);
  }

  // Checkpoint before navigation. A tab token prevents separate tabs merging results.
  async function save() {
    const copy = JSON.parse(JSON.stringify(job));
    saving = saving.catch(() => {}).then(async () => {
      await GM.setValue(PREFIX + 'session:' + tabKey + ':' + copy.origin, copy);
      if (copy.records.length) await GM.setValue(PREFIX + 'recent:' + copy.origin, tabKey);
    });
    try { await saving; checkpointFailed = false; }
    catch (error) {
      checkpointFailed = true; job.status = 'paused'; job.message = 'Could not save the checkpoint. Export your results before continuing.'; render();
      throw new Error('Checkpoint failed: ' + error.message);
    }
  }
  function mergeColumns(columns) {
    for (const column of columns) if (!job.columns.some(c => c.key === column.key)) job.columns.push({ ...column, name: column.label, enabled: true });
  }
  function rebuildKeys() { rowKeys = new Set(job.records.map(r => sameDataKey(r.values))); }
  async function collect(data, skipSeen = true) {
    if (!data?.rows.length) throw new Error('No readable rows in this region. Rescan or pick the region again.');
    const signature = fingerprint(data.rows);
    if (skipSeen && job.signatures.includes(signature)) return { repeated: true, added: 0 };
    mergeColumns(data.columns);
    if (job.recipe?.kind === 'list') job.recipe.fields = data.columns;
    let added = 0;
    const page = job.pages.length + 1, capturedAt = new Date().toISOString();
    for (const values of data.rows) {
      const key = sameDataKey(values);
      if (job.options.dedupe && rowKeys.has(key)) continue;
      if (job.options.maxRows && job.records.length >= job.options.maxRows) break;
      rowKeys.add(key);
      job.records.push({ values, source: { url: location.href, page, capturedAt } }); added++;
    }
    job.signatures.push(signature);
    job.pages.push({ url: location.href, title: document.title, rows: data.rows.length, added, capturedAt });
    job.pending = null; live = data; previewPage = Math.max(0, Math.ceil(job.records.length / 8) - 1);
    await save(); render(true);
    return { repeated: false, added };
  }
  async function stop(message, status = 'done') {
    job.status = status; job.message = message; job.pending = null; generation++;
    await save(); render();
    if (status === 'done' && job.options.autoDownload && job.records.length) download();
  }
  function active(token) { return token === generation && job.status === 'running'; }
  async function waitForData(token, before = '', started = performance.now()) {
    let last = '', since = 0;
    while (active(token) && performance.now() - started < job.options.timeout) {
      const data = readRecipe();
      if (data?.rows.length) {
        const sig = fingerprint(data.rows);
        if (sig !== before) {
          if (sig !== last) { last = sig; since = performance.now(); }
          const loading = data.root.matches('[aria-busy="true"]') || !!data.root.closest('[aria-busy="true"]');
          if (!loading && performance.now() - since >= job.options.settle && performance.now() - started >= job.options.delay) return data;
        } else { last = ''; since = 0; }
      } else { last = ''; since = 0; }
      await sleep(220);
    }
    return null;
  }
  async function crawl() {
    if (busy || !job.recipe) return;
    busy = true;
    const token = ++generation;
    job.status = 'running'; job.message = 'Reading the selected region…'; render();
    try {
      await save();
      let data;
      if (job.pending) {
        if (job.pending.expectedURL && location.href !== job.pending.fromURL && new URL(location.href).pathname !== new URL(job.pending.expectedURL).pathname) {
          await stop('Navigation reached an unexpected page. Check the region before resuming.', 'paused'); return;
        }
        data = await waitForData(token, job.pending.signature);
        if (!active(token)) return;
        if (!data) { await stop('No changed data arrived before the timeout. Results are saved; increase the timeout or check Next.', 'paused'); return; }
      } else {
        data = await waitForData(token);
        if (!active(token)) return;
        if (!data) { await stop('The saved data region is missing or empty. Rescan or pick it again.', 'paused'); return; }
      }
      while (active(token)) {
        const collected = await collect(data);
        if (!active(token)) return;
        if (collected.repeated && job.pending) { await stop('Stopped: this data page was already collected.'); return; }
        if (job.options.maxPages && job.pages.length >= job.options.maxPages) { await stop('Reached the page limit.'); return; }
        if (job.options.maxRows && job.records.length >= job.options.maxRows) { await stop('Reached the row limit.'); return; }
        // Let transiently disabled/loading pagination controls settle before deciding it is the last page.
        let next = resolveNext();
        if (!next || disabled(next)) {
          await sleep(Math.max(700, job.options.settle));
          if (!active(token)) return;
          next = resolveNext();
        }
        if (!next || disabled(next)) { await stop('Finished: no enabled Next / Load more control remains.'); return; }
        const targetURL = navigationURL(next);
        if (targetURL && new URL(targetURL).origin !== job.origin) { await stop('Next points to another website. Select a same-site pagination control.', 'paused'); return; }
        let form = next.closest('form');
        if (form && next.matches('input[type="submit"],button:not([type]),button[type="submit"]') && new URL(form.action || location.href, location.href).origin !== job.origin) {
          await stop('The pagination form points to another website.', 'paused'); return;
        }
        const before = fingerprint(data.rows);
        job.pending = { signature: before, fromURL: location.href, expectedURL: targetURL, at: Date.now() };
        job.message = 'Saved ' + job.records.length + ' records. Loading the next page…';
        await save(); render();
        await sleep(job.options.delay);
        if (!active(token)) return;
        // Resolve once more in case React replaced the control during the delay.
        next = resolveNext();
        if (!next || disabled(next)) { await stop('Finished: the Next control is no longer available.'); return; }
        const finalURL = navigationURL(next);
        form = next.closest('form');
        if ((finalURL && new URL(finalURL).origin !== job.origin)
          || (form && next.matches('input[type="submit"],button:not([type]),button[type="submit"]') && new URL(form.action || location.href, location.href).origin !== job.origin)) {
          await stop('Next now points to another website. Check the pagination control.', 'paused'); return;
        }
        if (finalURL !== job.pending.expectedURL) { job.pending.expectedURL = finalURL; await save(); }
        if (!active(token)) return;
        // Native navigation is forced into this tab, including links with target=_blank.
        const anchor = next.closest('a[href]');
        const oldTarget = anchor?.getAttribute('target');
        if (anchor) anchor.setAttribute('target', '_self');
        const oldFormTarget = form?.getAttribute('target');
        if (form) form.setAttribute('target', '_self');
        next.click();
        setTimeout(() => {
          if (anchor?.isConnected) oldTarget === null ? anchor.removeAttribute('target') : anchor.setAttribute('target', oldTarget);
          if (form?.isConnected) oldFormTarget === null ? form.removeAttribute('target') : form.setAttribute('target', oldFormTarget);
        }, 100);
        data = await waitForData(token, before);
        if (!active(token)) return;
        if (!data) { await stop('Next produced no changed data before the timeout. Your results are saved.', 'paused'); return; }
        if (job.signatures.includes(fingerprint(data.rows))) { await stop('Finished: pagination returned a previously collected data page.'); return; }
      }
    } catch (error) {
      job.status = 'paused'; job.message = error.message; generation++; render();
      if (!checkpointFailed) { try { await save(); } catch { /* Export still works from memory. */ } }
    } finally { busy = false; render(); }
  }
  async function pause() {
    generation++; job.status = 'paused'; job.message = 'Paused. Your collected results are saved.';
    await save(); render();
  }

  // All exports are built from plain values; website HTML is never copied into the output.
  function exportColumns() {
    const used = new Map();
    const columns = job.columns.filter(c => c.enabled).map(c => ({ ...c }));
    if (job.options.provenance) columns.push({ key: '$source', name: 'Source URL', kind: 'url' }, { key: '$page', name: 'Source Page', kind: 'text' });
    for (const c of columns) {
      const base = flat(c.name) || c.label || 'Field';
      let name = base, i = 1;
      while (used.has(name)) name = base + ' (' + (++i) + ')';
      used.set(name, true); c.outputName = name;
    }
    return columns;
  }
  function exportRows(columns) {
    return job.records.map(record => columns.map(c => c.key === '$source' ? record.source.url : c.key === '$page' ? String(record.source.page) : record.values[c.key] || ''));
  }
  function markdownValue(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_{}\[\]()#+.!|~-])/g, '\\$1');
  }
  function buildExport(format = job.options.format) {
    const columns = exportColumns(), rows = exportRows(columns);
    if (!columns.length) throw new Error('Select at least one export column.');
    const names = columns.map(c => c.outputName), timestamp = new Date().toISOString();
    const headingIndex = Math.max(0, columns.findIndex(c => /^(?:title|name|full name|company|product|heading)$/i.test(c.name) && c.kind === 'text'));
    const heading = row => flat(row[headingIndex]).slice(0, 160) || 'Record';
    if (format === 'csv') {
      const quote = value => {
        const s = String(value);
        const safe = job.options.csvSafe && /^[\s\u0000-\u0020]*[=+\-@]/.test(s) ? "'" + s : s;
        return '"' + safe.replace(/"/g, '""') + '"';
      };
      return { content: '\uFEFF' + [names, ...rows].map(row => row.map(quote).join(',')).join('\r\n') + '\r\n', mime: 'text/csv;charset=utf-8', ext: 'csv' };
    }
    if (format === 'json') return { content: JSON.stringify(rows.map(row => Object.fromEntries(names.map((name, i) => [name, row[i]]))), null, 2) + '\n', mime: 'application/json;charset=utf-8', ext: 'json' };
    if (format === 'md') {
      const lines = ['# ' + markdownValue(job.title), '', '> ' + rows.length + ' records · Exported ' + timestamp, ''];
      rows.forEach((row, index) => {
        lines.push('## ' + String(index + 1).padStart(3, '0') + ' · ' + markdownValue(heading(row)), '');
        columns.forEach((column, ci) => { if (row[ci]) lines.push('- **' + markdownValue(column.outputName) + ':** ' + markdownValue(row[ci]).replace(/\n/g, '\n  ')); });
        lines.push('', '---', '');
      });
      return { content: lines.join('\n'), mime: 'text/markdown;charset=utf-8', ext: 'md' };
    }
    if (format === 'html') {
      const cards = rows.map((row, index) => '<article><div class="number">RECORD ' + String(index + 1).padStart(3, '0') + '</div><h2>' + esc(heading(row)) + '</h2><dl>' + columns.map((column, ci) => {
        if (!row[ci]) return '';
        const value = column.kind === 'url' || column.kind === 'image' ? row[ci].split('\n').map(s => {
          const url = safeURL(s); return url ? '<a href="' + esc(url) + '" rel="noreferrer noopener">' + esc(s) + '</a>' : esc(s);
        }).join('<br>') : esc(row[ci]);
        return '<div><dt>' + esc(column.outputName) + '</dt><dd>' + value + '</dd></div>';
      }).join('') + '</dl></article>').join('\n');
      return { ext: 'html', mime: 'text/html;charset=utf-8', content: '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src \'none\'; base-uri \'none\'; form-action \'none\'"><title>' + esc(job.title) + '</title><style>'
        + 'body{margin:0;background:#f5f6fa;color:#182535;font:15px/1.6 system-ui,sans-serif}main{max-width:1080px;margin:auto;padding:56px 24px}.eyebrow,.number{font-size:11px;letter-spacing:.16em;font-weight:700;color:#4b66ae}h1{font-size:clamp(28px,5vw,44px);line-height:1.15;letter-spacing:-.04em;margin:12px 0}header p{color:#627087;margin:12px 0 32px}.records{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:20px}article{background:white;border:1px solid #e0e5ee;border-radius:16px;padding:28px;break-inside:avoid}h2{font-size:21px;line-height:1.3;margin:10px 0 22px;overflow-wrap:anywhere}dl{margin:0}dl>div{display:grid;grid-template-columns:minmax(100px,30%) minmax(0,1fr);gap:16px;border-top:1px solid #edf0f5;padding:11px 0}dt{color:#657289;font-size:13px}dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}a{color:#3156a6;text-underline-offset:3px}footer{margin-top:32px;color:#7a8596;font-size:12px}@media print{body{background:white}main{padding:0}.records{display:block}article{margin:0 0 18px}a{color:inherit}}'
        + '</style></head><body><main><header><div class="eyebrow">CLEAR SCRAPE / COLLECTION</div><h1>' + esc(job.title) + '</h1><p>' + rows.length + ' records · Exported ' + esc(timestamp) + '</p></header><section class="records">' + cards + '</section><footer>Collected from ' + esc(job.origin) + ' · Clear Scrape 1.0.3</footer></main></body></html>\n' };
    }
    throw new Error('Unknown export format.');
  }
  function download() {
    try {
      if (!job.records.length) throw new Error('Capture some records first.');
      const result = buildExport();
      const blob = new Blob([result.content], { type: result.mime }), url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = (job.filename.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 120) || 'scrape') + '.' + result.ext;
      anchor.style.display = 'none'; shadow.append(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      job.message = 'Export requested: ' + job.records.length + ' records as ' + result.ext.toUpperCase() + '.'; render();
    } catch (error) { job.message = error.message; render(); }
  }

  function glow(el, duration = 1800) {
    clearTimeout(highlightTimer);
    const overlay = $('outline');
    if (!el) { overlay.hidden = true; return; }
    const r = el.getBoundingClientRect();
    Object.assign(overlay.style, { top: Math.max(0, r.top) + 'px', left: Math.max(0, r.left) + 'px', width: Math.max(0, Math.min(innerWidth, r.right) - Math.max(0, r.left)) + 'px', height: Math.max(0, Math.min(innerHeight, r.bottom) - Math.max(0, r.top)) + 'px' });
    overlay.hidden = false;
    if (duration) highlightTimer = setTimeout(() => { overlay.hidden = true; }, duration);
  }
  function choose(candidate) {
    if (job.records.length && JSON.stringify(candidate.recipe) !== JSON.stringify(job.recipe)) {
      job.message = 'Clear the current collection before switching regions. Export it first if needed.'; renderCandidates(); render(); return;
    }
    if (JSON.stringify(candidate.recipe) !== JSON.stringify(job.recipe)) job.columns = [];
    job.recipe = candidate.recipe; live = candidate.data;
    mergeColumns(live.columns);
    job.message = 'Selected ' + candidate.label + ': ' + live.rows.length + ' rows.';
    previewPage = 0; save().catch(() => {}); render(true); glow(candidate.root);
  }
  function scan() {
    if (job.status === 'running') return;
    job.message = 'Looking for tables and repeated records…'; render();
    setTimeout(() => {
      candidates = detect();
      renderCandidates();
      if (!job.recipe && candidates.length) choose(candidates[0]);
      else { live = readRecipe(); job.message = candidates.length ? candidates.length + ' data regions found. Choose one below.' : 'No strong candidates found. Use Pick region for repeated records or Pick element for exact content.'; render(true); }
    }, 30);
  }
  function inferRegion(target) {
    const table = target.closest(TABLE);
    if (table) {
      const kind = table.matches('table') ? 'table' : 'aria', recipe = recipeFor(table, kind), data = readTable(table, kind);
      recipe.headers = data.columns.filter(c => c.kind === 'text').map(c => c.label);
      return { recipe, data, root: table, label: describe(table, kind) };
    }
    const choices = [];
    function consider(root, records) {
      const recipe = recipeFor(root, 'list', records), data = readCards(root, recipe);
      if (data.rows.length < 2) return;
      const semantic = records[0]?.matches('article,li,[role="listitem"],[itemtype]') ? 35 : usefulClasses(records[0]).length ? 14 : 0;
      const score = semantic + Math.min(data.columns.length, 9) * 4 + Math.log2(data.rows.length + 1) * 5
        + (root.matches('ul,ol,[role="list"]') ? 15 : 0) - (data.columns.length > 30 ? 50 : 0);
      choices.push({ recipe, data, root, label: describe(root, 'list'), score });
    }
    let current = target;
    for (let i = 0; current?.parentElement && i < 8; i++, current = current.parentElement) {
      const parent = current.parentElement;
      const sibs = [...parent.children].filter(n => n.localName === current.localName && visible(n));
      const cls = usefulClasses(current);
      const similar = sibs.filter(n => structure(n) === structure(current) || (cls.length && cls.some(c => n.classList.contains(c))));
      if (similar.length >= 2 && similar.some(n => text(n).length > 4)) {
        consider(parent, similar);
      }
    }
    const children = [...target.children].filter(visible);
    if (children.length >= 2) {
      const groups = new Map();
      for (const child of children) { const key = structure(child); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(child); }
      for (const group of groups.values()) if (group.length >= 2) consider(target, group);
    }
    return choices.sort((a, b) => b.score - a.score)[0] || null;
  }
  function pickedElement(target) {
    if (!visible(target) || target === document.body || target === document.documentElement) return null;
    const recipe = recipeFor(target, 'list', [target]);
    recipe.single = true; recipe.rows = ':scope';
    const data = readCards(target, recipe);
    return data.rows.length ? { recipe, data, root: target, label: 'Selected element · ' + target.localName + (target.id ? ' #' + target.id : '') } : null;
  }
  function pick(mode) {
    if (job.status === 'running' || uiHidden) return;
    pickerCleanup?.();
    const wasOpen = panelOpen; panelOpen = false; render(); $('launcher').hidden = true;
    $('hint').hidden = false;
    $('hint').textContent = mode === 'next' ? 'Click Next / Load more on the page · Esc cancels'
      : mode === 'element' ? 'Click the exact content to scrape · ↑ selects parent · ↓ selects child · Esc cancels'
      : 'Click one record or a table · ↑ selects parent · ↓ selects child · Esc cancels';
    let hovered = null, underPointer = null;
    const move = event => {
      if (event.composedPath().includes(host)) return;
      underPointer = event.target; hovered = mode === 'next' ? (event.target.closest('a,button,[role="button"],input[type="button"],input[type="submit"]') || event.target) : event.target;
      glow(hovered, 0);
    };
    const block = event => { if (!event.composedPath().includes(host)) { event.preventDefault(); event.stopImmediatePropagation(); } };
    const finish = () => {
      for (const event of ['pointerdown', 'mousedown', 'mouseup', 'pointerup']) window.removeEventListener(event, block, true);
      window.removeEventListener('mousemove', move, true); window.removeEventListener('click', click, true); window.removeEventListener('keydown', key, true);
      $('hint').hidden = true; glow(null); pickerCleanup = null; panelOpen = wasOpen; render();
    };
    const click = event => {
      if (event.composedPath().includes(host)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (!hovered) move(event);
      const target = hovered; finish();
      if (!target) return;
      if (mode === 'next') {
        if (target === document.body || target === document.documentElement) { job.message = 'Select the actual pagination button or link.'; render(); return; }
        job.next = nextRecipe(target); job.message = 'Next control selected: ' + (controlLabel(target) || target.localName) + '.';
        save().catch(() => {}); render(); glow(target);
      } else {
        const candidate = mode === 'element' ? pickedElement(target) : inferRegion(target);
        if (candidate) { candidates.unshift(candidate); choose(candidate); renderCandidates(); }
        else { job.message = mode === 'element' ? 'No readable data in that element. Try selecting a text block or a larger parent.' : 'No repeated records around that element. Use Pick element to scrape exactly the content you click.'; render(); }
      }
    };
    const key = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); finish(); }
      if (mode !== 'next' && hovered && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (event.key === 'ArrowUp' && hovered.parentElement) hovered = hovered.parentElement;
        if (event.key === 'ArrowDown') hovered = (hovered.contains(underPointer) && underPointer !== hovered ? [...hovered.children].find(n => n.contains(underPointer)) : hovered.firstElementChild) || hovered;
        glow(hovered, 0);
      }
    };
    for (const event of ['pointerdown', 'mousedown', 'mouseup', 'pointerup']) window.addEventListener(event, block, true);
    window.addEventListener('mousemove', move, true); window.addEventListener('click', click, true); window.addEventListener('keydown', key, true);
    pickerCleanup = finish;
  }

  const UI_CSS = `
    :host{all:initial;color-scheme:light}#panel,#launcher,#hint{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;line-height:1.45;color:#253044}
    *{box-sizing:border-box} [hidden]{display:none!important}button,input,select{font:inherit}button{cursor:pointer}button:disabled{cursor:default;opacity:.45}button,input,select,summary{outline-offset:3px}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #4665d8}button{border:1px solid #dce2ef;background:white;color:#36435b;border-radius:9px;padding:9px 12px;font-weight:600;transition:background .15s}button:hover:not(:disabled){background:#f0f3fc}.primary{background:#3e56d2;border-color:#3e56d2;color:white}.primary:hover:not(:disabled){background:#3148bf}.ghost{border:0;background:transparent}.danger{color:#b64450}input:not([type=checkbox]),select{width:100%;min-width:0;border:1px solid #dce2ef;border-radius:8px;background:#fff;color:#253044;padding:8px 10px}input[type=checkbox]{accent-color:#435bd2;flex:none;margin:0}label{color:#65718a;font-size:11px;line-height:1.5}label>input:not([type=checkbox]),label>select{margin-top:5px}h2{font-size:12px;font-weight:700;letter-spacing:.01em;margin:0 0 12px}.muted{color:#78839a;font-size:11px;line-height:1.6}.row{display:flex;align-items:center;gap:8px}.row>*{min-width:0}.row .grow{flex:1}.stack{display:grid;gap:10px}.check{display:flex;align-items:center;gap:8px;color:#55627a;font-size:12px}.section{padding:18px 22px;border-bottom:1px solid #edf0f6}.tag{font-size:10px;padding:3px 7px;background:#eef1ff;color:#4d60b7;border-radius:5px}.eyebrow{font-size:10px;letter-spacing:.12em;color:#8190b0;font-weight:700}.step{color:#9ba9c7;margin-right:8px;font-weight:500}.small{padding:6px 9px;font-size:11px}#launcher{position:fixed;right:22px;bottom:22px;z-index:2147483647;background:#26365a;color:white;border:1px solid #4c5c80;border-radius:14px;padding:12px 17px;box-shadow:0 7px 24px #17213b30;display:flex;align-items:center;gap:9px}#launcher span:first-child{color:#b6c9ff;font-size:19px}#panel{position:fixed;right:18px;top:18px;bottom:18px;width:min(460px,calc(100vw - 36px));z-index:2147483647;background:#fff;border:1px solid #dfe5f0;border-radius:18px;box-shadow:0 20px 90px #1c2a5133;display:flex;flex-direction:column;overflow:hidden}#top{padding:19px 22px;border-bottom:1px solid #edf0f6;display:flex;align-items:center;gap:12px}.brand-icon{width:35px;height:35px;border-radius:11px;background:#eef1ff;color:#445ad1;display:grid;place-items:center;font-size:22px}.brand{font-size:16px;letter-spacing:-.03em;font-weight:700}#content{overflow:auto;flex:1;scrollbar-width:thin}#stats{display:grid;grid-template-columns:repeat(3,1fr);padding:16px 22px;background:#fafbfe;border-bottom:1px solid #edf0f6}#stats strong{font-size:22px;font-weight:650;letter-spacing:-.04em;display:block}#stats span{font-size:10px;color:#8893a9;letter-spacing:.04em}#status{border-left:3px solid #ccd5f8;margin:0;font-size:12px;line-height:1.65;color:#5f6c87;padding:0 0 0 10px;overflow-wrap:anywhere}#state{margin-left:auto}#nextInfo{max-width:230px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.two{display:grid;grid-template-columns:1fr 1fr;gap:10px}details>summary{cursor:pointer;color:#60708f;font-size:12px;font-weight:600}details[open]>summary{margin-bottom:12px}#columns{display:grid;gap:7px;max-height:190px;overflow:auto;padding:2px}#columns input:not([type=checkbox]){padding:6px 8px;font-size:11px}#previewWrap{overflow:auto;max-height:245px;border:1px solid #e3e8f3;border-radius:9px;margin-top:10px}table{border-collapse:collapse;font-size:11px;min-width:100%;text-align:left}th,td{padding:9px 10px;border-bottom:1px solid #edf0f6;border-right:1px solid #edf0f6;max-width:230px;min-width:100px;vertical-align:top;white-space:pre-wrap;overflow-wrap:anywhere}th{background:#f6f8fd;color:#62708b;position:sticky;top:0;font-weight:600}td{color:#39465e}#previewEmpty{padding:24px;text-align:center;font-size:12px;color:#8692aa}#bottom{padding:10px 22px;display:flex;align-items:center;justify-content:space-between;border-top:1px solid #edf0f6;color:#8a95ab;font-size:10px}#outline{position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #5873ed;border-radius:5px;background:#5d78ef14;box-shadow:0 0 0 3px #5873ed20}#hint{position:fixed;z-index:2147483647;top:20px;left:50%;transform:translateX(-50%);background:#26365a;color:white;box-shadow:0 5px 24px #12203c40;border-radius:12px;padding:13px 20px;pointer-events:none;font-size:13px;max-width:85vw;text-align:center}#start{flex:1}#previewLabel{font-size:10px;color:#8090a9}#notice{padding:10px 12px;background:#f4f6fd;border-radius:8px;font-size:11px;color:#71809b;line-height:1.6}`;
  function mount() {
    host = document.createElement('div'); host.id = HOST_ID;
    host.style.cssText = 'all:initial!important;position:fixed!important;z-index:2147483647!important;inset:0!important;pointer-events:none!important;';
    shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>${UI_CSS}#panel{bottom:86px}#panel,#launcher{pointer-events:auto}</style>
      <button id="launcher" title="Open Clear Scrape (Alt+Shift+S)" aria-label="Open Clear Scrape" aria-expanded="false" aria-controls="panel"><span>▦</span> Clear Scrape</button>
      <section id="panel" aria-label="Clear Scrape control panel" hidden>
        <div id="top"><div class="brand-icon">▦</div><div><div class="brand">Clear Scrape</div><div class="muted">A little structure. A lot less busywork.</div></div><button id="minimize" class="ghost" style="margin-left:auto" title="Minimize" aria-label="Minimize panel">−</button></div>
        <div id="stats"><div><strong id="rowCount">0</strong><span>RECORDS SAVED</span></div><div><strong id="pageCount">0</strong><span>PAGES</span></div><div><strong id="columnCount">0</strong><span>COLUMNS</span></div></div>
        <div id="content">
          <div class="section"><div class="row" style="margin-bottom:9px"><div class="eyebrow">YOUR COLLECTION</div><span class="tag" id="state">Ready</span></div><p id="status" role="status" aria-live="polite"></p></div>
          <div class="section stack"><h2 style="margin:0"><span class="step">01</span>Find the right data</h2><button id="scan">Detect data</button><div class="row"><button id="pickRegion" class="grow">Pick region ↗</button><button id="pickElement" class="grow">Pick element ↗</button></div><div class="muted">Pick region finds a table or similar records. Pick element selects exactly the content you click.</div><select id="regions" aria-label="Detected data regions"><option value="">Detect or pick a region</option></select><div class="row"><span id="regionInfo" class="muted grow">Tables, grids, lists &amp; repeated cards</span><button id="highlight" class="ghost small">Highlight</button></div></div>
          <div class="section stack"><h2 style="margin:0"><span class="step">02</span>Collect &amp; crawl</h2><div class="row"><button id="autoNext" class="small">Auto Next</button><button id="pickNext" class="small">Pick Next ↗</button><span class="muted grow" id="nextInfo"></span></div><div class="row"><button id="capture" class="grow">Capture page</button><button id="start" class="primary">Start crawl</button><button id="pause" hidden>Pause</button></div><details><summary>Crawl settings</summary><div class="stack"><div class="two"><label>Delay between pages (ms)<input id="delay" type="number" min="200" step="100"></label><label>Page timeout (ms)<input id="timeout" type="number" min="3000" step="1000"></label><label>Maximum pages · 0 = all<input id="maxPages" type="number" min="0" step="1"></label><label>Maximum rows · 0 = all<input id="maxRows" type="number" min="0" step="1"></label></div><label class="check"><input type="checkbox" id="dedupe">Skip identical records</label><label class="check"><input type="checkbox" id="links">Include link URL columns</label><label class="check"><input type="checkbox" id="images">Include image URL columns</label><div class="muted">Keep this tab open. Delay and timeout can be increased for slower pages.</div></div></details></div>
          <div class="section stack"><div class="row"><h2 class="grow" style="margin:0"><span class="step">03</span>Review the collection</h2><span id="previewLabel"></span></div><div id="previewWrap"><div id="previewEmpty">Choose a region to preview its records.</div></div><div class="row"><button id="previewPrev" class="small" aria-label="Previous preview page">←</button><button id="previewNext" class="small" aria-label="Next preview page">→</button><span class="muted grow">8 records per preview</span><button id="clear" class="ghost small danger">Clear results</button></div><details><summary>Choose &amp; rename columns</summary><div id="columns"></div></details></div>
          <div class="section stack"><h2 style="margin:0"><span class="step">04</span>Take it with you</h2><label>File name<input id="filename" type="text" spellcheck="false"></label><div class="row"><select id="format" class="grow" aria-label="Export format"><option value="csv">CSV · Excel friendly</option><option value="json">JSON · records array</option><option value="md">Markdown · record sections</option><option value="html">HTML · styled record cards</option></select><button id="export" class="primary">Download</button></div><label class="check"><input id="provenance" type="checkbox">Include source URL &amp; page</label><label class="check"><input id="csvSafe" type="checkbox">Protect CSV cells from spreadsheet formulas</label><label class="check"><input id="autoDownload" type="checkbox">Download automatically when crawl finishes</label></div>
          <div class="section"><details><summary>Advanced · CSS selectors &amp; recovery</summary><div class="stack"><label>Region CSS selector<input id="rootCSS" type="text" placeholder="#results or table.data" spellcheck="false"></label><label>Repeated row selector · relative to region<input id="rowCSS" type="text" placeholder=":scope > article.card" spellcheck="false"></label><button id="applyCSS">Use selectors</button><button id="recover">Recover last saved run on this site</button><div id="notice">Extraction reads rendered DOM content. Virtualized grids expose only mounted rows. Closed shadow roots and embedded frames are outside this script's scope.</div></div></details></div>
        </div><div id="bottom"><span>LOCAL EXTRACTION · NO API KEY</span><span>Alt + Shift + S &nbsp; / &nbsp; v1.0.3</span></div>
      </section><div id="outline" hidden></div><div id="hint" hidden></div>`;
    document.documentElement.append(host);
    const on = (id, event, fn) => $(id).addEventListener(event, async e => { try { await fn(e); } catch (error) { job.message = error.message; render(); } });
    on('launcher', 'click', () => toggle()); on('minimize', 'click', () => toggle(false));
    on('scan', 'click', scan); on('pickRegion', 'click', () => pick('region')); on('pickElement', 'click', () => pick('element')); on('pickNext', 'click', () => pick('next'));
    on('regions', 'change', e => { const item = candidates[Number(e.target.value)]; if (item) choose(item); });
    on('highlight', 'click', () => { const data = readRecipe(); if (data) { data.root.scrollIntoView({ block: 'center', behavior: 'smooth' }); setTimeout(() => glow(data.root), 350); } });
    on('autoNext', 'click', async () => { job.next = { mode: 'auto' }; job.message = resolveNext() ? 'Automatic Next detection enabled.' : 'No obvious Next control found. Use Pick Next.'; await save(); render(); });
    on('capture', 'click', async () => { const result = await collect(readRecipe()); job.message = result.repeated ? 'This exact data page is already saved.' : 'Captured ' + result.added + ' new records.'; await save(); render(); });
    on('start', 'click', crawl); on('pause', 'click', pause); on('export', 'click', download);
    on('previewPrev', 'click', () => { previewPage = Math.max(0, previewPage - 1); renderPreview(); });
    on('previewNext', 'click', () => { previewPage++; renderPreview(); });
    on('clear', 'click', async () => {
      if (job.records.length && !confirm('Clear ' + job.records.length + ' collected records? Download them first if you need a copy.')) return;
      generation++; job.records = []; job.pages = []; job.signatures = []; job.pending = null; job.status = 'idle'; job.columns = []; rowKeys.clear();
      live = readRecipe(); if (live) mergeColumns(live.columns); previewPage = 0; job.message = 'Collection cleared. Ready to capture.'; await save(); render(true);
    });
    for (const id of ['delay', 'timeout', 'maxPages', 'maxRows']) on(id, 'change', async e => {
      const min = id === 'delay' ? 200 : id === 'timeout' ? 3000 : 0;
      job.options[id] = Math.min(3600000, Math.max(min, Number(e.target.value) || min)); e.target.value = job.options[id]; await save();
    });
    for (const id of ['dedupe', 'links', 'images', 'provenance', 'csvSafe', 'autoDownload']) on(id, 'change', async e => {
      if (['links', 'images'].includes(id) && job.records.length) { e.target.checked = job.options[id]; job.message = 'Clear the collection before changing extraction fields.'; render(); return; }
      job.options[id] = e.target.checked;
      if (['links', 'images'].includes(id)) {
        if (job.recipe?.kind === 'list') { const d = readRecipe(); if (d) job.recipe.fields = cardFields(d.nodes); }
        job.columns = []; live = readRecipe(); if (live) mergeColumns(live.columns); render(true);
      }
      await save();
    });
    on('filename', 'change', async e => { job.filename = e.target.value || 'scrape'; await save(); });
    on('format', 'change', async e => { job.options.format = e.target.value; await save(); });
    on('applyCSS', 'click', () => {
      const selector = $('rootCSS').value.trim();
      let roots; try { roots = [...document.querySelectorAll(selector)]; } catch { throw new Error('Invalid region CSS selector.'); }
      if (roots.length !== 1) throw new Error('The region selector must match exactly one element; found ' + roots.length + '.');
      const root = roots[0], kind = root.matches('table') ? 'table' : root.matches(TABLE) ? 'aria' : 'list';
      const recipe = recipeFor(root, kind);
      if (kind === 'list') {
        recipe.rows = $('rowCSS').value.trim() || ':scope > *';
        recipe.single = recipe.rows === ':scope';
        let rows; try { rows = recipe.single ? [root] : [...root.querySelectorAll(recipe.rows)]; } catch { throw new Error('Invalid row CSS selector.'); }
        recipe.rowTag = ''; recipe.fields = cardFields(rows);
      }
      recipe.roots = [selector];
      const data = kind === 'list' ? readCards(root, recipe) : readTable(root, kind);
      if (!data.rows.length) throw new Error('No records found with those selectors.');
      choose({ recipe, data, root, label: 'Custom region' });
    });
    on('recover', 'click', recover);
    document.addEventListener('keydown', e => { if (e.altKey && e.shiftKey && e.code === 'KeyS') { e.preventDefault(); toggle(); } });
  }
  function toggle(force) {
    if (uiHidden) return;
    panelOpen = typeof force === 'boolean' ? force : !panelOpen;
    render(); if (panelOpen && !job.recipe && !candidates.length) scan();
  }
  async function toggleDisplay() {
    // Cancel the picker as well as its overlays so the hidden UI cannot intercept page clicks.
    pickerCleanup?.();
    clearTimeout(highlightTimer);
    $('outline').hidden = true; $('hint').hidden = true;
    panelOpen = false; uiHidden = !uiHidden;
    render();
    await GM.setValue(DISPLAY_KEY, uiHidden);
  }
  function renderCandidates() {
    const select = $('regions');
    select.replaceChildren();
    if (!candidates.length) select.add(new Option(job.recipe ? 'Saved / custom region selected' : 'Detect or pick a region', ''));
    candidates.forEach((c, i) => select.add(new Option((i + 1) + '. ' + c.label + ' · ' + c.data.rows.length + ' rows × ' + c.data.columns.length + ' fields', String(i))));
    const index = candidates.findIndex(c => JSON.stringify(c.recipe) === JSON.stringify(job.recipe));
    if (index >= 0) select.value = String(index);
    else if (job.recipe && candidates.length) { select.add(new Option('Saved / custom region selected', 'saved')); select.value = 'saved'; }
  }
  function renderColumns() {
    const container = $('columns'); container.replaceChildren();
    job.columns.forEach(column => {
      const row = document.createElement('div'); row.className = 'row';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = column.enabled;
      checkbox.setAttribute('aria-label', 'Export ' + column.name);
      const input = document.createElement('input'); input.type = 'text'; input.value = column.name; input.setAttribute('aria-label', 'Column name: ' + column.name);
      input.addEventListener('change', () => { column.name = flat(input.value) || column.label; save().catch(() => {}); renderPreview(); });
      checkbox.addEventListener('change', () => { column.enabled = checkbox.checked; save().catch(() => {}); renderPreview(); });
      row.append(checkbox, input); container.append(row);
    });
  }
  function renderPreview() {
    const columns = job.columns.filter(c => c.enabled);
    const all = job.records.length ? job.records.map(r => r.values) : live?.rows || [];
    const max = Math.max(0, Math.ceil(all.length / 8) - 1); previewPage = Math.min(max, Math.max(0, previewPage));
    const rows = all.slice(previewPage * 8, previewPage * 8 + 8), wrap = $('previewWrap'); wrap.replaceChildren();
    $('previewLabel').textContent = all.length ? (job.records.length ? 'SAVED' : 'LIVE PREVIEW') + ' · ' + (previewPage * 8 + 1) + '–' + Math.min(all.length, previewPage * 8 + 8) : '';
    $('previewPrev').disabled = previewPage === 0; $('previewNext').disabled = previewPage === max;
    if (!rows.length || !columns.length) { const el = document.createElement('div'); el.id = 'previewEmpty'; el.textContent = 'Choose a region to preview its records.'; wrap.append(el); return; }
    const table = document.createElement('table'), thead = table.createTHead(), tr = thead.insertRow(), body = table.createTBody();
    columns.forEach(c => { const th = document.createElement('th'); th.textContent = c.name; tr.append(th); });
    for (const values of rows) { const row = body.insertRow(); columns.forEach(c => { const td = row.insertCell(); const value = values[c.key] || ''; td.textContent = value.length > 600 ? value.slice(0, 600) + '…' : value; td.title = value; }); }
    wrap.append(table);
  }
  function render(full = false) {
    if (!shadow) return;
    host.hidden = uiHidden;
    host.style.setProperty('display', uiHidden ? 'none' : 'block', 'important');
    $('panel').hidden = uiHidden || !panelOpen; $('launcher').hidden = uiHidden || !!pickerCleanup;
    $('launcher').setAttribute('aria-expanded', String(!uiHidden && panelOpen));
    const launcherLabel = panelOpen ? 'Close Clear Scrape' : 'Open Clear Scrape';
    $('launcher').setAttribute('aria-label', launcherLabel);
    $('launcher').title = launcherLabel + ' (Alt+Shift+S)';
    $('rowCount').textContent = job.records.length.toLocaleString(); $('pageCount').textContent = job.pages.length.toLocaleString(); $('columnCount').textContent = job.columns.filter(c => c.enabled).length;
    $('state').textContent = ({ idle: 'Ready', running: 'Collecting', paused: 'Paused', done: 'Finished' })[job.status] || 'Ready';
    $('status').textContent = job.message;
    const running = job.status === 'running';
    for (const id of ['scan', 'regions', 'pickRegion', 'pickElement', 'pickNext', 'autoNext', 'applyCSS', 'clear', 'recover', 'links', 'images', 'dedupe']) $(id).disabled = running;
    $('start').hidden = running; $('pause').hidden = !running;
    $('start').disabled = !job.recipe || busy; $('capture').disabled = running || !job.recipe || busy;
    $('start').textContent = job.status === 'paused' ? 'Resume crawl' : 'Start crawl';
    $('export').disabled = !job.records.length;
    const next = resolveNext(); $('nextInfo').textContent = next ? (disabled(next) ? 'Disabled: ' : 'Ready: ') + (controlLabel(next) || next.localName) : 'No Next found';
    $('nextInfo').title = $('nextInfo').textContent;
    $('regionInfo').textContent = job.recipe ? (job.recipe.single ? 'Selected element' : job.recipe.kind === 'list' ? 'Repeated records' : job.recipe.kind === 'aria' ? 'ARIA table / grid' : 'HTML table') + (live ? ' · ' + live.rows.length + ' visible records' : ' · saved selector') : 'Tables, grids, lists & repeated cards';
    if (full) {
      for (const id of ['delay', 'timeout', 'maxPages', 'maxRows']) $(id).value = job.options[id];
      for (const id of ['dedupe', 'links', 'images', 'provenance', 'csvSafe', 'autoDownload']) $(id).checked = job.options[id];
      $('filename').value = job.filename; $('format').value = job.options.format;
      $('rootCSS').value = job.recipe?.roots[0] || ''; $('rowCSS').value = job.recipe?.rows || '';
      renderCandidates(); renderColumns(); renderPreview();
    }
  }
  async function recover() {
    const key = await GM.getValue(PREFIX + 'recent:' + location.origin, '');
    const saved = key && await GM.getValue(PREFIX + 'session:' + key + ':' + location.origin, null);
    if (!saved || saved.origin !== location.origin) throw new Error('No saved run found for this site.');
    if (job.records.length && !confirm('Replace this tab\'s collection with the last saved run?')) return;
    job = saved; job.status = 'paused'; job.pending = null; job.options = { ...DEFAULTS, ...job.options }; generation++;
    job.message = 'Recovered ' + job.records.length + ' saved records. Review the region before resuming.';
    rebuildKeys(); live = readRecipe(); await save(); render(true);
  }
  async function boot() {
    if (document.getElementById(HOST_ID)) return;
    tabInfo = await GM.getTab();
    uiHidden = await GM.getValue(DISPLAY_KEY, false) === true;
    tabKey = tabInfo.clearScrapeToken || (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2));
    tabInfo.clearScrapeToken = tabKey; await GM.saveTab(tabInfo);
    const stored = await GM.getValue(PREFIX + 'session:' + tabKey + ':' + location.origin, null);
    job = stored?.version === VERSION && stored.origin === location.origin ? stored : freshJob();
    job.options = { ...DEFAULTS, ...job.options };
    if (job.status === 'running' && !job.pending) { job.status = 'paused'; job.message = 'Page reloaded. Review the selected region, then resume.'; }
    rebuildKeys(); mount(); live = readRecipe(); render(true);
    GM.registerMenuCommand('Toggle Clear Scrape display', () => toggleDisplay().catch(error => console.error('[Clear Scrape]', error)));
    if (job.status === 'running' && job.pending) crawl();
  }
  boot().catch(error => console.error('[Clear Scrape]', error));
})();
