// ==UserScript==
// @name         ChatGPT System Prompt Injector
// @namespace    https://github.com/NoahTheGinger
// @author       NoahTheGinger & Gemini 4 Hydrogen & Claude 5.5 Opus
// @version      1.3.3
// @description  Inject a REAL, custom system/developer prompt in your ChatGPT conversations!
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-start
// @grant        none
// @license      MIT
// @downloadURL https://update.greasyfork.org/scripts/605986/ChatGPT%20System%20Prompt%20Injector.user.js
// @updateURL https://update.greasyfork.org/scripts/605986/ChatGPT%20System%20Prompt%20Injector.meta.js
// ==/UserScript==

(() => {
    'use strict';

    if (window.__CGPT_SYS_INJECTOR__)
        return;
    window.__CGPT_SYS_INJECTOR__ = true;

    const INJECT_ROLE = 'system';
    const STORAGE_PROMPT = 'cgpt_sys_prompt_text';
    const STORAGE_ENABLED = 'cgpt_sys_prompt_enabled';
    const STORAGE_TRACKED = 'cgpt_sys_prompt_tracked';
    const STORAGE_POSITION = 'cgpt_sys_prompt_position';
    const MAX_TRACKED = 200;
    const HOST_ID = 'cgpt-sys-prompt-host';

    // Where the floating button sits until it's dragged somewhere else (and where
    // right-clicking it puts it back): 56px from the top, 16px from the right.
    const DEFAULT_POSITION = {
        edgeX: 'right',
        offsetX: 16,
        edgeY: 'top',
        offsetY: 56
    };
    const PANEL_GAP = 6; // px between the button and the panel
    const DRAG_THRESHOLD = 4; // px the pointer has to travel before a press counts as a drag

    const SEND_PATH_RE = /^\/(?:backend-api|backend-anon|__codex-api|__codex-anon-api)\/f\/conversation$/;
    const HISTORY_PATH_RE = /^\/(?:backend-api|backend-anon|__codex-api|__codex-anon-api)\/conversations\/([0-9a-f-]+)$/i;

    const state = {
        prompt: readStorage(STORAGE_PROMPT, ''),
        enabled: readStorage(STORAGE_ENABLED, 'true') !== 'false',
        tracked: readJsonStorage(STORAGE_TRACKED, {}),
        status: 'Idle'
    };

    let statusEl = null;

    function readStorage(key, fallback) {
        try {
            const v = localStorage.getItem(key);
            return v === null ? fallback : v;
        } catch {
            return fallback;
        }
    }

    function writeStorage(key, val) {
        try {
            localStorage.setItem(key, val);
        } catch {}
    }

    function removeStorage(key) {
        try {
            localStorage.removeItem(key);
        } catch {}
    }

    function readJsonStorage(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            if (!raw)
                return fallback;
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : fallback;
        } catch {
            return fallback;
        }
    }

    function setStatus(text) {
        state.status = text;
        if (statusEl)
            statusEl.textContent = text;
    }

    function isTracked(convId) {
        return Boolean(convId && Object.prototype.hasOwnProperty.call(state.tracked, convId));
    }

    // cyrb53: a small, fast string hash. Lets us remember which prompt each
    // conversation received without storing the full text 200 times over.
    function hashPrompt(text) {
        let h1 = 0xdeadbeef;
        let h2 = 0x41c6ce57;
        for (let i = 0; i < text.length; i++) {
            const ch = text.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 2654435761);
            h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
    }

    function markTracked(convId, msgId, extra = {}) {
        if (!convId)
            return;
        const prev = state.tracked[convId] || {};
        state.tracked[convId] = {
            ...prev,
            msgId: msgId || prev.msgId || null,
            at: Date.now(),
            ...extra
        };
        const entries = Object.entries(state.tracked);
        if (entries.length > MAX_TRACKED) {
            entries.sort((a, b) => (a[1]?.at || 0) - (b[1]?.at || 0));
            state.tracked = Object.fromEntries(entries.slice(entries.length - MAX_TRACKED));
        }
        writeStorage(STORAGE_TRACKED, JSON.stringify(state.tracked));
    }

    function makeUuid() {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0;
            const v = c === 'x' ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        });
    }

    function makeSystemMessage(promptText) {
        return {
            id: makeUuid(),
            author: {
                role: INJECT_ROLE,
                name: null,
                metadata: {}
            },
            create_time: Date.now() / 1000,
            update_time: null,
            content: {
                content_type: 'text',
                parts: [promptText]
            },
            status: 'finished_successfully',
            end_turn: true,
            weight: 0,
            metadata: {},
            recipient: 'all',
            channel: null
        };
    }

    function extractHistoryMessages(data) {
        if (Array.isArray(data?.messages)) {
            return data.messages.map((m) => m?.message || m).filter(Boolean);
        }
        if (data?.mapping && typeof data.mapping === 'object') {
            return Object.values(data.mapping).map((n) => n?.message).filter(Boolean);
        }
        return [];
    }

    function checkHistoryResponse(data, urlConvId) {
        const cid = data?.conversation_id || urlConvId;
        if (!cid)
            return;

        const msgs = extractHistoryMessages(data);
        const rec = state.tracked[cid];
        const promptText = state.prompt.trim();

        const matchedById = Boolean(rec?.msgId && msgs.some((m) => m?.id === rec.msgId));
        const matchedByText = Boolean(
                promptText &&
                msgs.some(
                    (m) =>
                    (m?.author?.role === 'system' || m?.author?.role === 'developer') &&
                    Array.isArray(m?.content?.parts) &&
                    m.content.parts.some((p) => p === promptText)));

        if (matchedById || matchedByText) {
            const extra = {
                inHistory: true
            };
            // If we have no record of which prompt this chat got (e.g. it was sent
            // from another browser) but the current one is in history, note it.
            if (matchedByText && !rec?.promptHash)
                extra.promptHash = hashPrompt(promptText);
            markTracked(cid, rec?.msgId || 'history', extra);
            setStatus(`Verified in history (${cid.slice(0, 8)})`);
        } else if (rec) {
            setStatus(`Tracked locally (${cid.slice(0, 8)}; hidden in GET)`);
        } else {
            setStatus(`No injected prompt in history (${cid.slice(0, 8)})`);
        }
    }

    async function inspectSseStream(res, knownConvId, injectedMsgId, injectedHash, replacing) {
        if (!res.body)
            return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let convId = knownConvId || null;
        let echoedRole = null;
        let echoedPartsLen = null;
        let sawError = false;
        let sawDone = false;
        let finalized = false;

        // Decide (once) whether the injection landed. ChatGPT echoes the injected
        // message back right after the conversation_id (as a blank, hidden "system"
        // message) once it's saved into the conversation tree, so that echo is the
        // confirmation. We can't wait for the stream to end: ChatGPT's client
        // aborts the request itself after [DONE] (net::ERR_ABORTED), so the stream
        // never closes cleanly.
        const finalize = () => {
            if (finalized)
                return;
            finalized = true;
            const accepted = echoedRole !== null;
            const label = replacing ? 'Re-injected' : 'Injected';

            if (convId && (accepted || (sawDone && !sawError))) {
                markTracked(convId, injectedMsgId, {
                    echoedRole,
                    promptHash: injectedHash
                });
                const info = accepted ? `saved by ChatGPT (as hidden ${echoedRole})` : 'sent (no echo seen)';
                setStatus(`${label} (${convId.slice(0, 8)}): ${info}`);
                console.info('[SysPromptInjector]', {
                    convId,
                    injectedMsgId,
                    replacing,
                    echoedRole,
                    echoedPartsLen
                });
            } else if (sawError) {
                setStatus('Stream returned an error; will retry next message');
            } else if (convId && isTracked(convId) && state.tracked[convId]?.promptHash === injectedHash) {
                setStatus(`${label} (${convId.slice(0, 8)}): stream cut off early`);
            } else {
                setStatus('Prompt not confirmed; will retry next message');
            }
        };

        const handleLine = (line) => {
            if (!line.startsWith('data:'))
                return;
            const raw = line.slice(5).trim();
            if (raw === '[DONE]') {
                sawDone = true;
                finalize();
                return;
            }
            if (!raw || !raw.startsWith('{'))
                return;

            let obj;
            try {
                obj = JSON.parse(raw);
            } catch {
                return;
            }
            if (!obj || typeof obj !== 'object')
                return;

            if (obj.error) {
                sawError = true;
                return;
            }

            // New chat: the first event carrying a conversation_id is the
            // resume_conversation_token event, which arrives before the echo.
            if (!convId && typeof obj.conversation_id === 'string' && obj.conversation_id) {
                convId = obj.conversation_id;
                markTracked(convId, injectedMsgId, {
                    promptHash: injectedHash
                });
            }

            const candidates = [obj.v?.message, obj.input_message, obj.message];
            for (const msg of candidates) {
                if (msg && msg.id === injectedMsgId) {
                    echoedRole = msg.author?.role || 'unknown';
                    echoedPartsLen = Array.isArray(msg.content?.parts) ? msg.content.parts.length : 0;
                    finalize();
                }
            }
        };

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                buffer += decoder.decode(value, {
                    stream: true
                });
                const lines = buffer.split(/\r?\n/);
                buffer = lines.pop() ?? '';
                for (const line of lines)
                    handleLine(line);
            }
            buffer += decoder.decode();
            if (buffer) {
                for (const line of buffer.split(/\r?\n/))
                    handleLine(line);
            }
        } catch (err) {
            if (err?.name !== 'AbortError') {
                console.warn('[SysPromptInjector] SSE read failed:', err);
            }
        } finally {
            finalize();
        }
    }

    // Returns null (don't inject) or { replacing } where replacing=true means the
    // conversation already got a different prompt (it only changes the status label).
    function planInjection(body) {
        const promptText = state.prompt.trim();
        if (!state.enabled || !promptText)
            return null;
        if (!body || !Array.isArray(body.messages) || body.messages.length === 0)
            return null;

        const alreadyInBatch = body.messages.some(
                (m) => m?.author?.role === 'system' || m?.author?.role === 'developer');
        if (alreadyInBatch)
            return null;

        const cid = body.conversation_id || null;
        const isRootTurn = body.parent_message_id === 'client-created-root';

        if (!cid || isRootTurn)
            return {
                replacing: false
            };

        // A branch inherits whatever prompt its parent conversation had.
        const branchFrom = body.branching_from_conversation_id;
        if (!isTracked(cid) && branchFrom && isTracked(branchFrom)) {
            const parent = state.tracked[branchFrom];
            markTracked(cid, parent?.msgId, {
                promptHash: parent?.promptHash
            });
        }

        if (!isTracked(cid))
            return {
                replacing: false
            };

        // Same prompt as last time -> nothing to do. Different (or unrecorded) ->
        // send the current one.
        return state.tracked[cid]?.promptHash === hashPrompt(promptText) ? null : {
            replacing: true
        };
    }

    function resolveUrl(input) {
        const rawUrl =
            typeof input === 'string'
             ? input
             : input instanceof URL
             ? input.href
             : input && typeof input.url === 'string'
             ? input.url
             : '';
        if (!rawUrl)
            return null;
        try {
            return new URL(rawUrl, window.location.origin);
        } catch {
            return null;
        }
    }

    const origFetch = window.fetch;

    window.fetch = async function patchedFetch(input, init) {
        const urlObj = resolveUrl(input);
        if (!urlObj || urlObj.origin !== window.location.origin) {
            return origFetch.apply(this, arguments);
        }

        const inputIsRequest = typeof Request !== 'undefined' && input instanceof Request;
        const method = ((init && init.method) || (inputIsRequest ? input.method : 'GET')).toUpperCase();

        const historyMatch = method === 'GET' ? HISTORY_PATH_RE.exec(urlObj.pathname) : null;
        if (historyMatch) {
            const res = await origFetch.apply(this, arguments);
            if (res.ok && res.headers.get('content-type')?.toLowerCase().includes('application/json')) {
                res.clone().json().then((data) => checkHistoryResponse(data, historyMatch[1])).catch(() => {});
            }
            return res;
        }

        if (method === 'POST' && SEND_PATH_RE.test(urlObj.pathname)) {
            let injectedMsgId = null;
            let injectedHash = null;
            let replacing = false;
            let knownConvId = null;
            let nextInput = input;
            let nextInit = init;

            try {
                let bodyText = null;
                if (init && init.body !== undefined) {
                    if (typeof init.body === 'string')
                        bodyText = init.body;
                    else if (typeof Blob !== 'undefined' && init.body instanceof Blob)
                        bodyText = await init.body.text();
                } else if (inputIsRequest && input.body != null) {
                    bodyText = await input.clone().text();
                }

                if (typeof bodyText === 'string' && bodyText.trim().startsWith('{')) {
                    const bodyObj = JSON.parse(bodyText);
                    knownConvId = bodyObj.conversation_id || null;

                    const plan = planInjection(bodyObj);
                    if (plan) {
                        const promptText = state.prompt.trim();
                        replacing = plan.replacing;
                        const sysMsg = makeSystemMessage(promptText);
                        bodyObj.messages.unshift(sysMsg);
                        injectedMsgId = sysMsg.id;
                        injectedHash = hashPrompt(promptText);

                        const newBodyText = JSON.stringify(bodyObj);
                        if (inputIsRequest) {
                            nextInput = new Request(input, {
                                ...(init || {}),
                                body: newBodyText
                            });
                            nextInit = undefined;
                        } else {
                            nextInit = {
                                ...(init || {}),
                                body: newBodyText
                            };
                        }
                    } else if (state.enabled && knownConvId && isTracked(knownConvId)) {
                        setStatus(`Skipped (${knownConvId.slice(0, 8)} already has this prompt)`);
                    }
                }
            } catch (err) {
                console.warn('[SysPromptInjector] Request patch skipped:', err);
            }

            const res = injectedMsgId
                 ? (nextInit !== undefined ? await origFetch.call(this, nextInput, nextInit) : await origFetch.call(this, nextInput))
                 : await origFetch.apply(this, arguments);

            if (injectedMsgId) {
                const ct = (res.headers.get('content-type') || '').toLowerCase();
                if (!res.ok) {
                    setStatus(`Server returned HTTP ${res.status} (check console)`);
                    console.warn('[SysPromptInjector] Injection rejected or failed:', res.status);
                } else if (ct.includes('text/event-stream')) {
                    inspectSseStream(res.clone(), knownConvId, injectedMsgId, injectedHash, replacing);
                } else if (knownConvId) {
                    markTracked(knownConvId, injectedMsgId, {
                        promptHash: injectedHash
                    });
                    setStatus(`${replacing ? 'Re-injected' : 'Injected'} (${knownConvId.slice(0, 8)}; non-SSE ${res.status})`);
                }
            }

            return res;
        }

        return origFetch.apply(this, arguments);
    };

    // ---------------------------------------------------------------------------
    // Theme (light / dark)
    // ---------------------------------------------------------------------------

    const darkQuery =
        typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

    // ChatGPT puts its resolved theme ("dark" / "light") on <html>. When its
    // appearance setting is "System", that already mirrors the OS. If the class
    // isn't there (yet), fall back to the OS preference directly.
    function resolveTheme() {
        const cls = document.documentElement?.classList;
        if (cls?.contains('dark'))
            return 'dark';
        if (cls?.contains('light'))
            return 'light';
        return darkQuery?.matches ? 'dark' : 'light';
    }

    function applyTheme() {
        const host = document.getElementById(HOST_ID);
        if (!host)
            return;
        const theme = resolveTheme();
        if (host.dataset.theme !== theme)
            host.dataset.theme = theme;
    }

    function watchTheme() {
        if (darkQuery) {
            if (typeof darkQuery.addEventListener === 'function')
                darkQuery.addEventListener('change', applyTheme);
            else if (typeof darkQuery.addListener === 'function')
                darkQuery.addListener(applyTheme);
        }
        if (document.documentElement) {
            new MutationObserver(applyTheme).observe(document.documentElement, {
                attributes: true,
                attributeFilter: ['class']
            });
        }
    }

    // ---------------------------------------------------------------------------
    // Position & dragging
    // ---------------------------------------------------------------------------

    // The saved position is the button's distance from its nearest left/right and
    // top/bottom edges, so it stays in the same corner when the window resizes.
    function readPosition() {
        const p = readJsonStorage(STORAGE_POSITION, null);
        const valid =
            p &&
            (p.edgeX === 'left' || p.edgeX === 'right') &&
            (p.edgeY === 'top' || p.edgeY === 'bottom') &&
            Number.isFinite(p.offsetX) &&
            Number.isFinite(p.offsetY);
        if (!valid)
            return {
                ...DEFAULT_POSITION
            };
        return {
            edgeX: p.edgeX,
            offsetX: Math.max(0, p.offsetX),
            edgeY: p.edgeY,
            offsetY: Math.max(0, p.offsetY)
        };
    }

    let savedPosition = readPosition();
    let ui = null; // { host, toggleBtn, panel } of the mounted widget
    let dragPoint = null; // live { left, top } of the button while it's being dragged
    let lastPlaced = {
        left: 0,
        top: 0
    };
    let dragEndedAt = -Infinity;
    let buttonResizeObserver = null;

    function viewportSize() {
        const root = document.documentElement;
        return {
            vw: root?.clientWidth || window.innerWidth,
            vh: root?.clientHeight || window.innerHeight
        };
    }

    // When the range is inverted (widget bigger than the window), the lower bound
    // wins so the widget's top-left corner stays visible.
    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function resolvePosition(pos, bw, bh, vw, vh) {
        return {
            left: pos.edgeX === 'right' ? vw - bw - pos.offsetX : pos.offsetX,
            top: pos.edgeY === 'bottom' ? vh - bh - pos.offsetY : pos.offsetY
        };
    }

    function anchorPosition(left, top, bw, bh, vw, vh) {
        const fromRight = left + bw / 2 > vw / 2;
        const fromBottom = top + bh / 2 > vh / 2;
        return {
            edgeX: fromRight ? 'right' : 'left',
            offsetX: Math.max(0, Math.round(fromRight ? vw - bw - left : left)),
            edgeY: fromBottom ? 'bottom' : 'top',
            offsetY: Math.max(0, Math.round(fromBottom ? vh - bh - top : top))
        };
    }

    // Which way the panel opens from the button: toward the roomier side of the
    // screen (a button on the right half gets a panel extending left), and below
    // unless only above has the space.
    function choosePlacement(left, top, bw, bh, pw, ph, vw, vh) {
        const roomExtendingRight = vw - left; // panel's left edge lined up with the button's
        const roomExtendingLeft = left + bw; // panel's right edge lined up with the button's
        const leftward = left + bw / 2 > vw / 2;
        const align = leftward
             ? roomExtendingLeft >= pw || roomExtendingLeft >= roomExtendingRight ? 'right' : 'left'
             : roomExtendingRight >= pw || roomExtendingRight >= roomExtendingLeft ? 'left' : 'right';

        const roomBelow = vh - (top + bh + PANEL_GAP);
        const roomAbove = top - PANEL_GAP;
        const side = roomBelow >= ph || roomBelow >= roomAbove ? 'below' : 'above';
        return {
            align,
            side
        };
    }

    // Places the widget: the button goes to its saved spot (or under the pointer
    // mid-drag), then the button plus any open panel are kept on screen as one
    // unit. `rePlace` re-picks which way the panel opens; it's ignored mid-drag
    // so the panel never flips out from under the cursor.
    function layout(rePlace = false) {
        if (!ui)
            return;
        const { host, toggleBtn, panel } = ui;
        const { vw, vh } = viewportSize();
        const bw = toggleBtn.offsetWidth;
        const bh = toggleBtn.offsetHeight;

        let { left, top } = dragPoint || resolvePosition(savedPosition, bw, bh, vw, vh);
        left = clamp(left, 0, vw - bw);
        top = clamp(top, 0, vh - bh);

        let minX = 0;
        let minY = 0;
        let maxX = bw;
        let maxY = bh;
        if (!panel.hidden) {
            const pw = panel.offsetWidth;
            const ph = panel.offsetHeight;
            if (rePlace && !dragPoint) {
                const { align, side } = choosePlacement(left, top, bw, bh, pw, ph, vw, vh);
                panel.dataset.align = align;
                panel.dataset.side = side;
            }
            const px = panel.dataset.align === 'left' ? 0 : bw - pw;
            const py = panel.dataset.side === 'above' ?  - (PANEL_GAP + ph) : bh + PANEL_GAP;
            minX = Math.min(0, px);
            maxX = Math.max(bw, px + pw);
            minY = Math.min(0, py);
            maxY = Math.max(bh, py + ph);
        }

        left = clamp(left, -minX, vw - maxX);
        top = clamp(top, -minY, vh - maxY);
        host.style.left = `${Math.round(left)}px`;
        host.style.top = `${Math.round(top)}px`;
        lastPlaced = {
            left,
            top
        };
    }

    let layoutQueued = false;
    let queuedRePlace = false;

    function queueLayout(rePlace = false) {
        queuedRePlace = queuedRePlace || rePlace;
        if (layoutQueued)
            return;
        layoutQueued = true;
        requestAnimationFrame(() => {
            layoutQueued = false;
            const r = queuedRePlace;
            queuedRePlace = false;
            layout(r);
        });
    }

    function savePosition() {
        if (!ui)
            return;
        const { vw, vh } = viewportSize();
        const { toggleBtn } = ui;
        savedPosition = anchorPosition(
                lastPlaced.left,
                lastPlaced.top,
                toggleBtn.offsetWidth,
                toggleBtn.offsetHeight,
                vw,
                vh);
        writeStorage(STORAGE_POSITION, JSON.stringify(savedPosition));
    }

    function resetPosition() {
        savedPosition = {
            ...DEFAULT_POSITION
        };
        removeStorage(STORAGE_POSITION);
        layout(true);
    }

    // A press that ends a drag still fires a click (and touch can send a late
    // synthetic one); neither should open or close the panel.
    function clickFollowsDrag() {
        return performance.now() - dragEndedAt < 500;
    }

    // Makes `handle` drag the whole widget. A press that moves less than
    // DRAG_THRESHOLD stays a normal click. `ignore(e)` skips presses that land on
    // controls inside the handle (the checkbox in the panel header).
    function makeDragHandle(handle, ignore) {
        let drag = null;

        handle.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 || !e.isPrimary || !ui)
                return;
            if (ignore && ignore(e))
                return;
            dragEndedAt = -Infinity;
            const rect = ui.host.getBoundingClientRect();
            drag = {
                id: e.pointerId,
                startX: e.clientX,
                startY: e.clientY,
                grabX: e.clientX - rect.left,
                grabY: e.clientY - rect.top,
                moved: false
            };
            // Mouse only: keeps the press from selecting page text or pulling focus
            // out of the composer. Touch is handled by touch-action: none in the CSS.
            if (e.pointerType === 'mouse')
                e.preventDefault();
            try {
                handle.setPointerCapture(e.pointerId);
            } catch {}
        });

        handle.addEventListener('pointermove', (e) => {
            if (!drag || e.pointerId !== drag.id)
                return;
            if (!drag.moved) {
                if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_THRESHOLD)
                    return;
                drag.moved = true;
                ui.host.dataset.dragging = '';
            }
            dragPoint = {
                left: e.clientX - drag.grabX,
                top: e.clientY - drag.grabY
            };
            layout();
        });

        const endDrag = (e) => {
            if (!drag || e.pointerId !== drag.id)
                return;
            const { moved } = drag;
            drag = null;
            try {
                if (handle.hasPointerCapture(e.pointerId))
                    handle.releasePointerCapture(e.pointerId);
            } catch {}
            if (!moved)
                return;
            dragPoint = null;
            if (ui)
                delete ui.host.dataset.dragging;
            savePosition();
            dragEndedAt = performance.now();
        };

        handle.addEventListener('pointerup', endDrag);
        handle.addEventListener('pointercancel', endDrag);
        handle.addEventListener('lostpointercapture', endDrag);
    }

    // ---------------------------------------------------------------------------
    // UI
    // ---------------------------------------------------------------------------

    const UI_CSS = `
    :host {
      --btn-bg: #1f2937;
      --btn-bg-hover: #374151;
      --btn-fg: #f9fafb;
      --btn-border: rgba(255, 255, 255, 0.18);
      --btn-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
      --panel-bg: #111827;
      --panel-fg: #f9fafb;
      --panel-border: rgba(255, 255, 255, 0.16);
      --panel-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
      --input-bg: #1f2937;
      --input-bg-focus: #1f2937;
      --input-border: #374151;
      --input-border-hover: #4b5563;
      --placeholder: #6b7280;
      --muted: #9ca3af;
      --accent: #3b82f6;
      --focus-ring: rgba(59, 130, 246, 0.4);
      --save-bg: #2563eb;
      --save-bg-hover: #1d4ed8;
      --save-border: #1d4ed8;
      color-scheme: dark;
    }

    :host([data-theme="light"]) {
      --btn-bg: #ffffff;
      --btn-bg-hover: #f3f4f6;
      --btn-fg: #111827;
      --btn-border: rgba(0, 0, 0, 0.12);
      --btn-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
      --panel-bg: #ffffff;
      --panel-fg: #111827;
      --panel-border: rgba(0, 0, 0, 0.1);
      --panel-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
      --input-bg: #f9fafb;
      --input-bg-focus: #ffffff;
      --input-border: #d1d5db;
      --input-border-hover: #9ca3af;
      --placeholder: #9ca3af;
      --muted: #6b7280;
      --accent: #2563eb;
      --focus-ring: rgba(37, 99, 235, 0.25);
      --save-bg: #2563eb;
      --save-bg-hover: #1d4ed8;
      --save-border: #1d4ed8;
      color-scheme: light;
    }

    *, *::before, *::after { box-sizing: border-box; }
    [hidden] { display: none !important; }

    button { font-family: inherit; }

    button:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }

    .toggle {
      display: block;
      padding: 6px 10px;
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
      border-radius: 8px;
      border: 1px solid var(--btn-border);
      background: var(--btn-bg);
      color: var(--btn-fg);
      cursor: pointer;
      box-shadow: var(--btn-shadow);
      touch-action: none;
      user-select: none;
      -webkit-user-select: none;
      -webkit-touch-callout: none;
      -webkit-tap-highlight-color: transparent;
      transition: background-color 0.15s ease, opacity 0.15s ease;
    }
    .toggle:hover { background: var(--btn-bg-hover); }
    .toggle[data-active="false"] { opacity: 0.65; }

    .panel {
      position: absolute;
      width: 320px;
      max-width: calc(100vw - 16px);
      padding: 10px;
      border-radius: 10px;
      border: 1px solid var(--panel-border);
      background: var(--panel-bg);
      color: var(--panel-fg);
      box-shadow: var(--panel-shadow);
    }
    .panel[data-side="below"] { top: calc(100% + ${PANEL_GAP}px); }
    .panel[data-side="above"] { bottom: calc(100% + ${PANEL_GAP}px); }
    .panel[data-align="left"] { left: 0; }
    .panel[data-align="right"] { right: 0; }

    .top-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 8px;
      font-size: 12px;
      cursor: grab;
      touch-action: none;
      user-select: none;
      -webkit-user-select: none;
    }

    .grip {
      flex-shrink: 0;
      width: 10px;
      height: 14px;
      margin-right: 2px;
      color: var(--muted);
      background-image: radial-gradient(circle, currentColor 1.1px, transparent 1.5px);
      background-size: 5px 5px;
      opacity: 0.8;
    }

    :host([data-dragging]) .toggle,
    :host([data-dragging]) .top-row { cursor: grabbing; }

    .enable {
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      user-select: none;
    }
    .enable input {
      margin: 0;
      cursor: pointer;
      accent-color: var(--accent);
    }

    textarea {
      display: block;
      width: 100%;
      height: 130px;
      padding: 8px;
      border-radius: 6px;
      border: 1px solid var(--input-border);
      background: var(--input-bg);
      color: var(--panel-fg);
      caret-color: var(--accent);
      font-family: inherit;
      font-size: 12px;
      line-height: 1.45;
      resize: vertical;
      outline: none;
      transition: border-color 0.15s ease, box-shadow 0.15s ease, background-color 0.15s ease;
    }
    textarea::placeholder {
      color: var(--placeholder);
      opacity: 1;
    }
    textarea:hover { border-color: var(--input-border-hover); }
    textarea:focus {
      border-color: var(--accent);
      background: var(--input-bg-focus);
      box-shadow: 0 0 0 3px var(--focus-ring);
      /* Invisible normally; shows up as a real outline in Windows High Contrast mode */
      outline: 2px solid transparent;
    }

    .bottom-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: 8px;
      gap: 8px;
    }

    .status {
      min-width: 0;
      font-size: 11px;
      color: var(--muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .save {
      flex-shrink: 0;
      padding: 4px 10px;
      font-size: 12px;
      border-radius: 6px;
      border: 1px solid var(--save-border);
      background: var(--save-bg);
      color: #ffffff;
      cursor: pointer;
      transition: background-color 0.15s ease;
    }
    .save:hover { background: var(--save-bg-hover); }
  `;

    // Constructable stylesheets aren't blocked by the page's CSP; fall back to a
    // <style> element on engines that don't support them.
    function attachStyles(shadow) {
        try {
            if ('adoptedStyleSheets' in shadow && typeof CSSStyleSheet === 'function') {
                const sheet = new CSSStyleSheet();
                sheet.replaceSync(UI_CSS);
                shadow.adoptedStyleSheets = [sheet];
                return;
            }
        } catch {}
        const style = document.createElement('style');
        style.textContent = UI_CSS;
        shadow.appendChild(style);
    }

    function setPanelOpen(open) {
        if (!ui || ui.panel.hidden === !open)
            return;
        ui.panel.hidden = !open;
        layout(open);
    }

    // Pressing anywhere outside the widget closes an open panel. Uses the capture
    // phase so the page can't swallow the event first, and doesn't cancel it, so
    // the press still reaches whatever was clicked. Listening for pointerdown
    // (not click) means a text selection that starts inside the panel and is
    // released outside it doesn't count.
    function closePanelOnOutsidePress(e) {
        if (!ui || ui.panel.hidden || e.composedPath().includes(ui.host))
            return;
        setPanelOpen(false);
    }

    // Presses inside iframes (canvas previews and the like) never reach this
    // document, but they do move focus into the iframe, which blurs the window.
    // Switching to another app also blurs the window, which is why this checks
    // where focus went instead of closing on every blur.
    function closePanelOnIframeFocus() {
        setTimeout(() => {
            if (document.activeElement instanceof HTMLIFrameElement)
                setPanelOpen(false);
        }, 0);
    }

    function mountUI() {
        if (!document.body || document.getElementById(HOST_ID))
            return;

        const host = document.createElement('div');
        host.id = HOST_ID;
        host.dataset.theme = resolveTheme();
        // left/top are set by layout() right after the host is attached.
        Object.assign(host.style, {
            position: 'fixed',
            left: '0px',
            top: '0px',
            right: 'auto',
            bottom: 'auto',
            width: 'max-content',
            margin: '0',
            zIndex: '2147483647',
            fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif'
        });

        const shadow = host.attachShadow({
            mode: 'open'
        });
        attachStyles(shadow);

        const toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = 'toggle';
        toggleBtn.textContent = 'System Prompt';
        toggleBtn.title = 'Click to open/close · Drag to move · Right-click to reset position';

        const panel = document.createElement('div');
        panel.className = 'panel';
        panel.hidden = true;
        panel.dataset.align = 'right';
        panel.dataset.side = 'below';

        const topRow = document.createElement('div');
        topRow.className = 'top-row';

        const label = document.createElement('label');
        label.className = 'enable';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = state.enabled;
        const labelText = document.createElement('span');
        labelText.textContent = 'Enable system prompt';
        label.append(checkbox, labelText);

        const grip = document.createElement('span');
        grip.className = 'grip';
        grip.title = 'Drag to move';
        grip.setAttribute('aria-hidden', 'true');

        const textarea = document.createElement('textarea');
        textarea.placeholder = 'Enter system prompt (sent once per chat, and again if you change it)...';
        textarea.value = state.prompt;

        const bottomRow = document.createElement('div');
        bottomRow.className = 'bottom-row';

        statusEl = document.createElement('span');
        statusEl.className = 'status';
        statusEl.textContent = state.status;

        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'save';
        saveBtn.textContent = 'Save';

        const updateButtonAppearance = () => {
            const active = state.enabled && Boolean(state.prompt.trim());
            toggleBtn.dataset.active = String(active);
            toggleBtn.textContent = active ? 'System Prompt (On)' : 'System Prompt (Off)';
        };

        toggleBtn.addEventListener('click', () => {
            if (clickFollowsDrag())
                return;
            setPanelOpen(panel.hidden);
        });

        toggleBtn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            resetPosition();
        });

        checkbox.addEventListener('change', () => {
            state.enabled = checkbox.checked;
            writeStorage(STORAGE_ENABLED, String(state.enabled));
            updateButtonAppearance();
        });

        const persistPrompt = () => {
            state.prompt = textarea.value;
            writeStorage(STORAGE_PROMPT, state.prompt);
            updateButtonAppearance();
        };

        textarea.addEventListener('input', persistPrompt);
        saveBtn.addEventListener('click', () => {
            persistPrompt();
            setStatus('Saved');
        });

        // The button and the panel's header bar both move the widget.
        makeDragHandle(toggleBtn);
        makeDragHandle(topRow, (e) => Boolean(e.target?.closest?.('.enable')));

        topRow.append(label, grip);
        bottomRow.append(statusEl, saveBtn);
        panel.append(topRow, textarea, bottomRow);
        shadow.append(toggleBtn, panel);
        document.body.appendChild(host);

        ui = {
            host,
            toggleBtn,
            panel
        };
        updateButtonAppearance();
        layout(true);

        // Keeps a right-anchored button's right edge put when its label changes width.
        if (buttonResizeObserver) {
            buttonResizeObserver.disconnect();
            buttonResizeObserver.observe(toggleBtn);
        }
    }

    function initUI() {
        if (!document.body) {
            setTimeout(initUI, 50);
            return;
        }
        if (typeof ResizeObserver === 'function') {
            buttonResizeObserver = new ResizeObserver(() => queueLayout());
        }
        mountUI();
        watchTheme();
        window.addEventListener('resize', () => queueLayout(true));
        document.addEventListener('pointerdown', closePanelOnOutsidePress, true);
        window.addEventListener('blur', closePanelOnIframeFocus);
        const obs = new MutationObserver(() => {
            if (!document.getElementById(HOST_ID))
                mountUI();
        });
        obs.observe(document.body, {
            childList: true
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initUI, {
            once: true
        });
    } else {
        initUI();
    }
})();
