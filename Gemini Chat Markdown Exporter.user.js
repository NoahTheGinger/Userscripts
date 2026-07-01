// ==UserScript==
// @name         Gemini Chat Markdown Exporter (Thoughts Included)
// @namespace    https://github.com/NoahTheGinger/Userscripts/
// @version      0.4.3
// @description  Export the current Gemini chat to Markdown via internal batchexecute RPC (with Thoughts content when present).
// @author       NoahTheGinger
// @match        https://gemini.google.com/*
// @grant        none
// @run-at       document-end
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    // ---------------------------
    // Utilities
    // ---------------------------
    function $(sel, root = document) {
        return root.querySelector(sel);
    }

    function getCurrentTimestamp() {
        return new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    }

    function sanitizeFilename(title) {
        return (title || 'Gemini Chat')
            .replace(/[<>:"/\\|?*]/g, '_')
            .replace(/\s+/g, '_');
    }

    function downloadFile(filename, mime, content) {
        const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');

        a.href = url;
        a.download = filename;

        document.body.appendChild(a);
        a.click();
        a.remove();

        URL.revokeObjectURL(url);
    }

    function stdLB(text) {
        return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    }

    // ---------------------------
    // Page state helpers
    // ---------------------------
    /**
     * Detect route and build the correct source-path and account-aware RPC base.
     * Supports:
     *   - /app/:chatId
     *   - /gem/:gemId/:chatId
     *   - /u/:index/app/:chatId
     *   - /u/:index/gem/:gemId/:chatId
     *
     * Returns:
     *   {
     *     kind: 'app'|'gem',
     *     chatId: string,
     *     gemId?: string,
     *     userIndex?: string,
     *     basePrefix: '' | '/u/:index',
     *     sourcePath: string
     *   }
     * or null when not on a conversation page.
     */
    function getRouteFromUrl() {
        const path = location.pathname.replace(/\/+$/, '');
        const segs = path.split('/').filter(Boolean);

        if (segs.length === 0) return null;

        let basePrefix = '';
        let userIndex = null;
        let i = 0;

        // Optional "/u/:index" prefix.
        if (segs[0] === 'u' && /^\d+$/.test(segs[1] || '')) {
            userIndex = segs[1];
            basePrefix = `/u/${userIndex}`;
            i = 2;
        }

        // /app/:chatId
        if (segs[i] === 'app' && segs[i + 1]) {
            const chatId = segs[i + 1];
            return {
                kind: 'app',
                chatId,
                userIndex,
                basePrefix,
                sourcePath: `${basePrefix}/app/${chatId}`
            };
        }

        // /gem/:gemId/:chatId
        if (segs[i] === 'gem' && segs[i + 1] && segs[i + 2]) {
            const gemId = segs[i + 1];
            const chatId = segs[i + 2];
            return {
                kind: 'gem',
                gemId,
                chatId,
                userIndex,
                basePrefix,
                sourcePath: `${basePrefix}/gem/${gemId}/${chatId}`
            };
        }

        return null;
    }

    function getLang() {
        return document.documentElement.lang || 'en';
    }

    function getAtToken() {
        const input = $('input[name="at"]');
        if (input?.value) return input.value;

        const html = document.documentElement.innerHTML;
        let m = html.match(/"SNlM0e":"([^"]+)"/);
        if (m) return m[1];

        try {
            if (window.WIZ_global_data?.SNlM0e) {
                return window.WIZ_global_data.SNlM0e;
            }
        } catch {
            // ignore
        }

        return null;
    }

    function getBatchUrl(route) {
        const prefix = route.basePrefix || '';
        return `${prefix}/_/BardChatUi/data/batchexecute`;
    }

    // ---------------------------
    // Batchexecute calls
    // ---------------------------
    async function fetchConversationPayload(route) {
        const at = getAtToken();
        if (!at) {
            throw new Error('Could not find anti-CSRF token "at" on the page.');
        }

        const chatId = route.chatId;
        const convKey = chatId.startsWith('c_') ? chatId : `c_${chatId}`;

        // Keep a large page size so long histories export in one go.
        // Aligning shape with current RPC: [convKey, pageSize, null, 1, [1], [4], null, 1]
        const innerArgs = JSON.stringify([convKey, 1000, null, 1, [1], [4], null, 1]);
        const fReq = [[['hNvQHb', innerArgs, null, 'generic']]];

        const params = new URLSearchParams({
            rpcids: 'hNvQHb',
            'source-path': route.sourcePath,
            hl: getLang(),
            rt: 'c'
        });

        const body = new URLSearchParams({
            'f.req': JSON.stringify(fReq),
            at
        });

        const res = await fetch(`${getBatchUrl(route)}?${params.toString()}`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
                'x-same-domain': '1',
                'accept': '*/*'
            },
            body: body.toString() + '&'
        });

        if (!res.ok) {
            const t = await res.text().catch(() => '');
            throw new Error(
                `batchexecute failed: ${res.status} ${res.statusText}` +
                `${t ? `\n${t.slice(0, 300)}` : ''}`
            );
        }

        return res.text();
    }

    async function fetchConversationTitle(route) {
        const at = getAtToken();
        if (!at) return null;

        const fullChatId = route.chatId.startsWith('c_') ? route.chatId : `c_${route.chatId}`;

        // Try the argument patterns seen in Gem pages first, then fallback.
        const tryArgsList = [
            JSON.stringify([13, null, [0, null, 1]]),
            JSON.stringify([200, null, [0, null, 1]]),
            null
        ];

        for (const innerArgs of tryArgsList) {
            try {
                const fReq = [[['MaZiqc', innerArgs, null, 'generic']]];

                const params = new URLSearchParams({
                    rpcids: 'MaZiqc',
                    'source-path': route.sourcePath,
                    hl: getLang(),
                    rt: 'c'
                });

                const body = new URLSearchParams({
                    'f.req': JSON.stringify(fReq),
                    at
                });

                const res = await fetch(`${getBatchUrl(route)}?${params.toString()}`, {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: {
                        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
                        'x-same-domain': '1',
                        'accept': '*/*'
                    },
                    body: body.toString() + '&'
                });

                if (!res.ok) continue;

                const text = await res.text();
                const payloads = parseBatchExecute(text, 'MaZiqc');

                for (const payload of payloads) {
                    const title = findTitleInPayload(payload, fullChatId);
                    if (title) return title;
                }
            } catch {
                // Try next argument pattern.
            }
        }

        return null;
    }

    function findTitleInPayload(root, fullChatId) {
        let found = null;

        (function walk(node) {
            if (found) return;

            if (Array.isArray(node)) {
                if (
                    node.length >= 2 &&
                    typeof node[0] === 'string' &&
                    node[0] === fullChatId &&
                    typeof node[1] === 'string' &&
                    node[1].trim()
                ) {
                    found = node[1].trim();
                    return;
                }

                for (const child of node) walk(child);
            }
        })(root);

        return found;
    }

    // ---------------------------
    // Google batchexecute parser
    // ---------------------------
    function parseBatchExecute(text, targetRpcId = 'hNvQHb') {
        if (text.startsWith(")]}'\n")) {
            const nl = text.indexOf('\n');
            text = nl >= 0 ? text.slice(nl + 1) : '';
        }

        const lines = text.split('\n').filter(l => l.trim().length > 0);
        const payloads = [];

        for (let i = 0; i < lines.length;) {
            const lenStr = lines[i++];
            const len = parseInt(lenStr, 10);

            // Google batchexecute normally uses length-prefixed JSON lines.
            // We do not need the length value, but checking it helps keep alignment.
            if (!isFinite(len)) break;

            const jsonLine = lines[i++] || '';
            let segment;

            try {
                segment = JSON.parse(jsonLine);
            } catch {
                continue;
            }

            if (Array.isArray(segment)) {
                for (const entry of segment) {
                    if (
                        Array.isArray(entry) &&
                        entry[0] === 'wrb.fr' &&
                        entry[1] === targetRpcId
                    ) {
                        const s = entry[2];

                        if (typeof s === 'string') {
                            try {
                                const inner = JSON.parse(s);
                                payloads.push(inner);
                            } catch {
                                // ignore malformed inner payload
                            }
                        }
                    }
                }
            }
        }

        return payloads;
    }

    // ---------------------------
    // Conversation extraction
    // More resilient against Gemini payload shape drift
    // ---------------------------
    const EXPORTER_DEBUG = false;

    function collectStrings(node, out = []) {
        if (typeof node === 'string') {
            out.push(node);
        } else if (Array.isArray(node)) {
            for (const child of node) {
                collectStrings(child, out);
            }
        }

        return out;
    }

    function cleanStrings(node) {
        return collectStrings(node)
            .map(s => s.trim())
            .filter(Boolean);
    }

    function looksLikeInternalId(s) {
        return /^(?:c_|rc_|r_)[A-Za-z0-9_-]{6,}$/.test(String(s || '').trim());
    }

    function isUserMessageNode(node, loose = false) {
        if (!Array.isArray(node)) return false;
        if (node.length < 2) return false;
        if (!Array.isArray(node[0])) return false;
        if (typeof node[1] !== 'number') return false;

        // Strict mode matches known user role markers.
        // Loose mode is only used as a fallback.
        if (!loose && node[1] !== 1 && node[1] !== 2) return false;
        if (loose && (node[1] < 0 || node[1] > 9)) return false;

        return cleanStrings(node[0]).some(Boolean);
    }

    function getUserTextFromNode(userNode) {
        try {
            return cleanStrings(userNode[0])
                .filter(s => !looksLikeInternalId(s))
                .join('\n')
                .trim();
        } catch {
            return '';
        }
    }

    function looksLikeAssistantId(id) {
        if (typeof id !== 'string') return false;

        return (
            id.startsWith('rc_') ||
            id.startsWith('r_') ||
            /^response[_-]/i.test(id)
        );
    }

    function isAssistantNode(node) {
        if (!Array.isArray(node)) return false;
        if (node.length < 2) return false;
        if (typeof node[0] !== 'string') return false;
        if (!Array.isArray(node[1])) return false;

        if (looksLikeAssistantId(node[0])) return true;

        // Fallback shape: some response-ish nodes may not use rc_,
        // but still have a substantial markdown/text payload at [1][0].
        const direct = typeof node[1]?.[0] === 'string' ? node[1][0].trim() : '';

        return (
            direct.length > 20 &&
            /[\s\n.,!?`*_#]/.test(direct) &&
            !looksLikeInternalId(node[0]) &&
            !node[0].startsWith('c_')
        );
    }

    function getAssistantTextFromNode(assistantNode) {
        try {
            const primary = assistantNode?.[1]?.[0];

            if (typeof primary === 'string') {
                return primary;
            }

            if (Array.isArray(primary)) {
                const joined = cleanStrings(primary)
                    .filter(s => !looksLikeInternalId(s))
                    .join('\n\n')
                    .trim();

                if (joined) return joined;
            }

            // Last-ditch fallback for changed/nested response payloads.
            return cleanStrings(assistantNode?.[1] || [])
                .filter(s => !looksLikeInternalId(s))
                .join('\n\n')
                .trim();
        } catch {
            return '';
        }
    }

    function findThoughtCandidate(node) {
        if (!Array.isArray(node)) return null;

        // Preserve the known Thoughts shape from the original script.
        if (
            node.length >= 2 &&
            Array.isArray(node[1]) &&
            node[1].length >= 1 &&
            Array.isArray(node[1][0]) &&
            node[1][0].length >= 1 &&
            node[1][0].every(x => typeof x === 'string')
        ) {
            const txt = node[1][0].join('\n\n').trim();
            if (txt) return txt;
        }

        if (
            Array.isArray(node[0]) &&
            node[0].length >= 1 &&
            node[0].every(x => typeof x === 'string')
        ) {
            const txt = node[0].join('\n\n').trim();
            if (txt) return txt;
        }

        // Search from the end first because Thoughts-like metadata tends
        // to live after the main assistant response.
        for (let i = node.length - 1; i >= 0; i--) {
            const found = findThoughtCandidate(node[i]);
            if (found) return found;
        }

        return null;
    }

    function extractReasoningFromAssistantNode(assistantNode, assistantText = '') {
        if (!Array.isArray(assistantNode)) return null;

        const normalize = s => stdLB(String(s || '')).trim();
        const assistantNorm = normalize(assistantText);

        // Avoid scanning [0] id and [1] main answer first.
        for (let k = assistantNode.length - 1; k >= 2; k--) {
            const txt = findThoughtCandidate(assistantNode[k]);

            if (txt && normalize(txt) !== assistantNorm) {
                return txt;
            }
        }

        return null;
    }

    function isTimestampPair(arr) {
        return (
            Array.isArray(arr) &&
            arr.length === 2 &&
            typeof arr[0] === 'number' &&
            typeof arr[1] === 'number' &&
            arr[0] > 1_600_000_000
        );
    }

    function cmpTimestampAsc(a, b) {
        if (!a.tsPair && !b.tsPair) return 0;
        if (!a.tsPair) return -1;
        if (!b.tsPair) return 1;

        if (a.tsPair[0] !== b.tsPair[0]) {
            return a.tsPair[0] - b.tsPair[0];
        }

        return a.tsPair[1] - b.tsPair[1];
    }

    function findAll(root, predicate, out = []) {
        if (!Array.isArray(root)) return out;

        if (predicate(root)) out.push(root);

        for (const child of root) {
            findAll(child, predicate, out);
        }

        return out;
    }

    function findMaxTimestamp(root) {
        let best = null;

        (function walk(node) {
            if (!Array.isArray(node)) return;

            if (isTimestampPair(node)) {
                if (
                    !best ||
                    node[0] > best[0] ||
                    (node[0] === best[0] && node[1] > best[1])
                ) {
                    best = node;
                }
            }

            for (const child of node) {
                walk(child);
            }
        })(root);

        return best;
    }

    function blockFromScope(scope, order, looseUser = false) {
        const users = findAll(scope, n => isUserMessageNode(n, looseUser));
        const assistants = findAll(scope, isAssistantNode);

        if (!users.length || !assistants.length) return null;

        const userNode = users[0];

        // Prefer an assistant node with visible text, otherwise keep one
        // with Thoughts content, otherwise first assistant-like node.
        let assistantNode = assistants.find(a => getAssistantTextFromNode(a).trim());

        if (!assistantNode) {
            assistantNode = assistants.find(a => extractReasoningFromAssistantNode(a));
        }

        if (!assistantNode) {
            assistantNode = assistants[0];
        }

        const userText = getUserTextFromNode(userNode);
        const assistantText = getAssistantTextFromNode(assistantNode);
        const thoughtsText = extractReasoningFromAssistantNode(assistantNode, assistantText);

        if (!userText && !assistantText && !thoughtsText) return null;

        return {
            userText,
            assistantText,
            thoughtsText: thoughtsText || null,
            tsPair: findMaxTimestamp(scope),
            _order: order
        };
    }

    function extractByTurnContainers(root, looseUser = false) {
        const containers = [];

        function scan(node) {
            if (!Array.isArray(node)) {
                return {
                    hasUser: false,
                    hasAssistant: false,
                    hasBoth: false
                };
            }

            const selfUser = isUserMessageNode(node, looseUser);
            const selfAssistant = isAssistantNode(node);

            let hasUser = selfUser;
            let hasAssistant = selfAssistant;
            let childHasBoth = false;

            for (const child of node) {
                const flags = scan(child);

                hasUser = hasUser || flags.hasUser;
                hasAssistant = hasAssistant || flags.hasAssistant;
                childHasBoth = childHasBoth || flags.hasBoth;
            }

            const hasBoth = hasUser && hasAssistant;

            // Minimal enclosing container: contains both a user and assistant,
            // but none of its children already contains both.
            if (hasBoth && !childHasBoth && !selfUser && !selfAssistant) {
                containers.push(node);
            }

            return {
                hasUser,
                hasAssistant,
                hasBoth
            };
        }

        scan(root);

        return containers
            .map((scope, i) => blockFromScope(scope, i, looseUser))
            .filter(Boolean);
    }

    function collectMessageNodes(root, looseUser = false, out = []) {
        if (!Array.isArray(root)) return out;

        if (isUserMessageNode(root, looseUser)) {
            out.push({
                kind: 'user',
                node: root
            });
        } else if (isAssistantNode(root)) {
            out.push({
                kind: 'assistant',
                node: root
            });
        }

        for (const child of root) {
            collectMessageNodes(child, looseUser, out);
        }

        return out;
    }

    function extractBySequentialWalk(root, looseUser = false) {
        const items = collectMessageNodes(root, looseUser);
        const blocks = [];
        const pairedUsers = new WeakSet();

        let currentUser = null;
        let order = 0;

        for (const item of items) {
            if (item.kind === 'user') {
                currentUser = item.node;
                continue;
            }

            if (item.kind === 'assistant' && currentUser && !pairedUsers.has(currentUser)) {
                const userText = getUserTextFromNode(currentUser);
                const assistantText = getAssistantTextFromNode(item.node);
                const thoughtsText = extractReasoningFromAssistantNode(item.node, assistantText);

                if (userText || assistantText || thoughtsText) {
                    blocks.push({
                        userText,
                        assistantText,
                        thoughtsText: thoughtsText || null,
                        tsPair: null,
                        _order: order++
                    });

                    pairedUsers.add(currentUser);
                }
            }
        }

        return blocks;
    }

    function dedupeBlocks(blocks) {
        const seen = new Set();
        const out = [];

        for (const block of blocks) {
            const key = JSON.stringify([
                block.userText || '',
                block.assistantText || '',
                block.thoughtsText || '',
                block.tsPair?.[0] || 0,
                block.tsPair?.[1] || 0
            ]);

            if (!seen.has(key)) {
                seen.add(key);
                out.push(block);
            }
        }

        return out;
    }

    function extractBlocksFromPayloadRoot(root) {
        const strictContainers = extractByTurnContainers(root, false);
        const strictSequential = extractBySequentialWalk(root, false);

        // Container mode is more precise, but if it only found one giant
        // conversation wrapper while sequential found many turns, use sequential.
        if (
            strictContainers.length &&
            !(strictContainers.length === 1 && strictSequential.length > 1)
        ) {
            return strictContainers;
        }

        if (strictSequential.length) {
            return strictSequential;
        }

        // Fallback for changed user-role markers.
        const looseContainers = extractByTurnContainers(root, true);
        const looseSequential = extractBySequentialWalk(root, true);

        if (
            looseContainers.length &&
            !(looseContainers.length === 1 && looseSequential.length > 1)
        ) {
            return looseContainers;
        }

        return looseSequential;
    }

    function collectExtractionDiagnostics(payloads) {
        const d = {
            payloadCount: payloads.length,
            userNodesStrict: 0,
            userNodesLoose: 0,
            assistantNodes: 0,
            timestampPairs: 0
        };

        function walk(node) {
            if (!Array.isArray(node)) return;

            if (isUserMessageNode(node, false)) d.userNodesStrict++;
            if (isUserMessageNode(node, true)) d.userNodesLoose++;
            if (isAssistantNode(node)) d.assistantNodes++;
            if (isTimestampPair(node)) d.timestampPairs++;

            for (const child of node) {
                walk(child);
            }
        }

        for (const p of payloads) {
            walk(p);
        }

        return d;
    }

    function extractAllBlocks(payloads) {
        let blocks = [];

        for (let pIndex = 0; pIndex < payloads.length; pIndex++) {
            const extracted = extractBlocksFromPayloadRoot(payloads[pIndex]);

            blocks = blocks.concat(
                extracted.map((b, i) => ({
                    ...b,
                    _payloadIndex: pIndex,
                    _i: blocks.length + i
                }))
            );
        }

        blocks = dedupeBlocks(blocks);

        blocks.sort((a, b) => {
            const c = cmpTimestampAsc(a, b);
            if (c !== 0) return c;

            return (a._payloadIndex - b._payloadIndex) || (a._i - b._i);
        });

        return blocks.map(({ _payloadIndex, _i, _order, ...rest }) => rest);
    }

    // ---------------------------
    // Markdown formatter
    // With dividers between blocks
    // ---------------------------
    function blocksToMarkdown(blocks, title = 'Gemini Chat') {
        const parts = [];

        for (let i = 0; i < blocks.length; i++) {
            const blk = blocks[i];

            const u = (blk.userText || '').trim();
            const a = (blk.assistantText || '').trim();
            const t = (blk.thoughtsText || '').trim();

            const blockParts = [];

            if (u) {
                blockParts.push(`#### User:\n${u}`);
            }

            if (t) {
                blockParts.push(`#### Thoughts:\n${t}`);
            }

            if (a) {
                blockParts.push(`#### Assistant:\n${a}`);
            }

            if (blockParts.length > 0) {
                parts.push(blockParts.join('\n\n---\n\n'));

                if (i < blocks.length - 1) {
                    parts.push('---');
                }
            }
        }

        return `# ${title}\n\n${parts.join('\n\n')}\n`;
    }

    // ---------------------------
    // Button UI
    // ---------------------------
    function createExportButton() {
        const btn = document.createElement('button');

        btn.id = 'gemini-export-btn';
        btn.textContent = 'Export';
        btn.title = 'Export current Gemini chat to Markdown';

        Object.assign(btn.style, {
            position: 'fixed',
            bottom: '20px',
            right: '20px',
            zIndex: 100000,
            background: '#1a73e8',
            color: '#fff',
            border: 'none',
            borderRadius: '6px',
            padding: '10px 14px',
            fontSize: '14px',
            fontWeight: '600',
            cursor: 'pointer',
            boxShadow: '0 2px 8px rgba(0,0,0,0.15)'
        });

        btn.onmouseenter = () => {
            btn.style.background = '#1558c0';
        };

        btn.onmouseleave = () => {
            btn.style.background = '#1a73e8';
        };

        btn.onclick = doExport;

        return btn;
    }

    function injectButton() {
        if ($('#gemini-export-btn')) return;
        document.body.appendChild(createExportButton());
    }

    // ---------------------------
    // Main export flow
    // ---------------------------
    async function doExport() {
        try {
            const route = getRouteFromUrl();

            if (!route || !route.chatId) {
                alert('Open a chat at /app/:chatId or /gem/:gemId/:chatId before exporting.');
                return;
            }

            // Fetch title in parallel so MaZiqc is no longer skipped merely
            // because block extraction fails.
            const titlePromise = fetchConversationTitle(route).catch(err => {
                console.warn('[Gemini Exporter] Title fetch failed:', err);
                return null;
            });

            const raw = await fetchConversationPayload(route);
            const titleFromRpc = await titlePromise;

            const payloads = parseBatchExecute(raw);
            const diagnostics = collectExtractionDiagnostics(payloads);
            const blocks = extractAllBlocks(payloads);

            window.__geminiExporterDebug = {
                route,
                diagnostics,
                payloadCount: payloads.length,
                blockCount: blocks.length,
                payloads,
                blocks
            };

            if (EXPORTER_DEBUG) {
                console.info('[Gemini Exporter] Diagnostics:', window.__geminiExporterDebug);
            }

            if (!payloads.length) {
                throw new Error('No conversation payloads found in batchexecute response.');
            }

            if (!blocks.length) {
                throw new Error(
                    'Could not extract any User/Assistant message pairs. ' +
                    `Diagnostics: ${JSON.stringify(diagnostics)}. ` +
                    'Open DevTools and inspect window.__geminiExporterDebug.'
                );
            }

            let title = titleFromRpc;

            if (!title) {
                title = document.title?.trim() || 'Gemini Chat';

                if (title.includes(' - Gemini')) {
                    title = title.split(' - Gemini')[0].trim();
                }

                if (title === 'Gemini' || title === 'Google Gemini') {
                    title = 'Gemini Chat';
                }
            }

            const md = stdLB(blocksToMarkdown(blocks, title));
            const filename = `${sanitizeFilename(title)}_${getCurrentTimestamp()}.md`;

            downloadFile(filename, 'text/markdown', md);
        } catch (err) {
            console.error('[Gemini Exporter] Error:', err);
            alert(`Export failed: ${err?.message || err}`);
        }
    }

    // ---------------------------
    // Boot
    // ---------------------------
    function init() {
        injectButton();

        let lastHref = location.href;

        setInterval(() => {
            if (location.href !== lastHref) {
                lastHref = location.href;
                setTimeout(injectButton, 800);
            }
        }, 1000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
