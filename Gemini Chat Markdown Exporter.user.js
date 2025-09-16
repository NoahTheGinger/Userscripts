// ==UserScript==
// @name         Gemini Chat Markdown Exporter (Thoughts Included)
// @namespace    https://github.com/NoahTheGinger/Userscripts/
// @version      0.3.2
// @description  Export the current Gemini chat (/app/:chatId) to Markdown via internal batchexecute RPC, ordered oldest→newest, with Thoughts content only when present (Gemini 2.5 Pro).
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
        return (title || 'Gemini Chat').replace(/[<>:"/\\|?\*]/g, '_').replace(/\s+/g, '_');
    }
    function downloadFile(filename, mime, content) {
        const blob = content instanceof Blob ? content : new Blob([content], {
            type: mime
        });
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
        return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    }

    // ---------------------------
    // Page state helpers
    // ---------------------------
    function getChatIdFromUrl() {
        const m = location.pathname.match(/\/app\/([a-z0-9]+)/i);
        return m ? m[1] : null;
    }
    function getLang() {
        return document.documentElement.lang || 'en';
    }
    function getAtToken() {
        const input = $('input[name="at"]');
        if (input?.value)
            return input.value;

        const html = document.documentElement.innerHTML;
        let m = html.match(/"SNlM0e":"([^"]+)"/);
        if (m)
            return m[1];
        try {
            if (window.WIZ_global_data?.SNlM0e)
                return window.WIZ_global_data.SNlM0e;
        } catch {}
        return null;
    }

    // ---------------------------
    // Batchexecute calls
    // ---------------------------
    async function fetchConversationPayload(chatId) {
        const at = getAtToken();
        if (!at)
            throw new Error('Could not find anti-CSRF token "at" on the page.');
        const convKey = chatId.startsWith('c_') ? chatId : `c_${chatId}`;

        const innerArgs = JSON.stringify([convKey, 1000, null, 1, [0], [4], null, 1]);
        const fReq = [
            [
                ["hNvQHb", innerArgs, null, "generic"]
            ]
        ];
        const params = new URLSearchParams({
            rpcids: 'hNvQHb',
            'source-path': `/app/${chatId}`,
            hl: getLang(),
            rt: 'c'
        });
        const body = new URLSearchParams({
            'f.req': JSON.stringify(fReq),
            at
        });
        const res = await fetch(`/_/BardChatUi/data/batchexecute?${params.toString()}`, {
            method: 'POST',
            headers: {
                'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
                'x-same-domain': '1',
                'accept': '*/*'
            },
            body: body.toString() + '&'
        });
        if (!res.ok) {
            const t = await res.text().catch(() => '');
            throw new Error(`batchexecute failed: ${res.status} ${res.statusText}${t ? `\n${t.slice(0, 300)}` : ''}`);
        }
        return res.text();
    }

    async function fetchConversationTitle(chatId) {
        const at = getAtToken();
        if (!at)
            return null;

        try {
            const fReq = [
                [
                    ["MaZiqc", null, null, "generic"]
                ]
            ];
            const params = new URLSearchParams({
                rpcids: 'MaZiqc',
                'source-path': `/app/${chatId}`,
                hl: getLang(),
                rt: 'c'
            });
            const body = new URLSearchParams({
                'f.req': JSON.stringify(fReq),
                at
            });
            const res = await fetch(`/_/BardChatUi/data/batchexecute?${params.toString()}`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
                    'x-same-domain': '1',
                    'accept': '*/*'
                },
                body: body.toString() + '&'
            });

            if (!res.ok)
                return null;
            const text = await res.text();
            const payloads = parseBatchExecute(text, 'MaZiqc');

            // Look for the conversation with our chatId
            const fullChatId = chatId.startsWith('c_') ? chatId : `c_${chatId}`;
            for (const payload of payloads) {
                const convList = findConversationList(payload);
                if (convList) {
                    for (const conv of convList) {
                        if (Array.isArray(conv) && conv[0] === fullChatId && typeof conv[1] === 'string') {
                            return conv[1];
                        }
                    }
                }
            }
        } catch (e) {
            console.log('[Gemini Exporter] Could not fetch title:', e);
        }
        return null;
    }

    function findConversationList(node) {
        // MaZiqc response contains an array of conversations like:
        // [["c_xxx", "Title", null, ...], ["c_yyy", "Another Title", ...], ...]
        if (Array.isArray(node)) {
            // Check if this looks like a conversation list
            if (node.length > 0 && Array.isArray(node[0]) &&
                typeof node[0][0] === 'string' && node[0][0].startsWith('c_') &&
                typeof node[0][1] === 'string') {
                return node;
            }
            // Recurse
            for (const child of node) {
                const result = findConversationList(child);
                if (result)
                    return result;
            }
        }
        return null;
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

        for (let i = 0; i < lines.length; ) {
            const lenStr = lines[i++];
            const len = parseInt(lenStr, 10);
            if (!isFinite(len))
                break;
            const jsonLine = lines[i++] || '';
            let segment;
            try {
                segment = JSON.parse(jsonLine);
            } catch {
                continue;
            }
            if (Array.isArray(segment)) {
                for (const entry of segment) {
                    if (Array.isArray(entry) && entry[0] === 'wrb.fr' && entry[1] === targetRpcId) {
                        const s = entry[2];
                        if (typeof s === 'string') {
                            try {
                                const inner = JSON.parse(s);
                                payloads.push(inner);
                            } catch {
                                // ignore
                            }
                        }
                    }
                }
            }
        }
        return payloads;
    }

    // ---------------------------
    // Conversation extraction (block-based, with Thoughts)
    // ---------------------------
    function isUserMessageNode(node) {
        return (
            Array.isArray(node) &&
            node.length >= 2 &&
            Array.isArray(node[0]) &&
            node[0].length >= 1 &&
            node[0].every(p => typeof p === 'string') &&
            (node[1] === 2 || node[1] === 1));
    }

    function getUserTextFromNode(userNode) {
        try {
            return userNode[0].join('\n');
        } catch {
            return '';
        }
    }

    function isAssistantNode(node) {
        return (
            Array.isArray(node) &&
            node.length >= 2 &&
            typeof node[0] === 'string' &&
            node[0].startsWith('rc_') &&
            Array.isArray(node[1]) &&
            typeof node[1][0] === 'string');
    }

    function isAssistantContainer(node) {
        return (
            Array.isArray(node) &&
            node.length >= 1 &&
            Array.isArray(node[0]) &&
            node[0].length >= 1 &&
            isAssistantNode(node[0][0]));
    }

    function getAssistantNodeFromContainer(container) {
        try {
            return container[0][0];
        } catch {
            return null;
        }
    }

    function getAssistantTextFromNode(assistantNode) {
        try {
            return assistantNode[1][0] || '';
        } catch {
            return '';
        }
    }

    function extractReasoningFromAssistantNode(assistantNode) {
        if (!Array.isArray(assistantNode))
            return null;
        for (let k = assistantNode.length - 1; k >= 0; k--) {
            const child = assistantNode[k];
            if (Array.isArray(child)) {
                if (
                    child.length >= 2 &&
                    Array.isArray(child[1]) &&
                    child[1].length >= 1 &&
                    Array.isArray(child[1][0]) &&
                    child[1][0].length >= 1 &&
                    child[1][0].every(x => typeof x === 'string')) {
                    const txt = child[1][0].join('\n\n').trim();
                    if (txt)
                        return txt;
                }
                if (
                    Array.isArray(child[0]) &&
                    child[0].length >= 1 &&
                    child[0].every(x => typeof x === 'string')) {
                    const txt = child[0].join('\n\n').trim();
                    if (txt)
                        return txt;
                }
            }
        }
        return null;
    }

    function isTimestampPair(arr) {
        return Array.isArray(arr) && arr.length === 2 && typeof arr[0] === 'number' && typeof arr[1] === 'number' && arr[0] > 1_600_000_000;
    }

    function cmpTimestampAsc(a, b) {
        if (!a.tsPair && !b.tsPair)
            return 0;
        if (!a.tsPair)
            return -1;
        if (!b.tsPair)
            return 1;
        if (a.tsPair[0] !== b.tsPair[0])
            return a.tsPair[0] - b.tsPair[0];
        return a.tsPair[1] - b.tsPair[1];
    }

    function detectBlock(node) {
        if (!Array.isArray(node))
            return null;
        let userNode = null;
        let assistantContainer = null;
        let tsCandidate = null;

        for (const child of node) {
            if (isUserMessageNode(child) && !userNode)
                userNode = child;
            if (isAssistantContainer(child) && !assistantContainer)
                assistantContainer = child;
            if (isTimestampPair(child)) {
                if (!tsCandidate || child[0] > tsCandidate[0] || (child[0] === tsCandidate[0] && child[1] > tsCandidate[1])) {
                    tsCandidate = child;
                }
            }
        }
        if (userNode && assistantContainer) {
            const assistantNode = getAssistantNodeFromContainer(assistantContainer);
            if (!assistantNode)
                return null;
            const userText = getUserTextFromNode(userNode);
            const assistantText = getAssistantTextFromNode(assistantNode);
            const thoughtsText = extractReasoningFromAssistantNode(assistantNode);
            return {
                userText,
                assistantText,
                thoughtsText: thoughtsText || null,
                tsPair: tsCandidate || null
            };
        }
        return null;
    }

    function extractBlocksFromPayloadRoot(root) {
        const blocks = [];
        const seenComposite = new Set();

        function scan(node) {
            if (!Array.isArray(node))
                return;
            const block = detectBlock(node);
            if (block) {
                const key = JSON.stringify([
                            block.userText,
                            block.assistantText,
                            block.thoughtsText || '',
                            block.tsPair?.[0] || 0,
                            block.tsPair?.[1] || 0
                        ]);
                if (!seenComposite.has(key)) {
                    seenComposite.add(key);
                    blocks.push(block);
                }
            }
            for (const child of node)
                scan(child);
        }
        scan(root);
        return blocks;
    }

    function extractAllBlocks(payloads) {
        let blocks = [];
        for (const p of payloads) {
            const b = extractBlocksFromPayloadRoot(p);
            blocks = blocks.concat(b);
        }
        const withIndex = blocks.map((b, i) => ({
                    ...b,
                    _i: i
                }));
        withIndex.sort((a, b) => {
            const c = cmpTimestampAsc(a, b);
            return c !== 0 ? c : a._i - b._i;
        });
        return withIndex.map(({
                _i,
                ...rest
            }) => rest);
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
            if (u)
                blockParts.push(`#### User:\n${u}`);
            if (t)
                blockParts.push(`#### Thoughts:\n${t}`);
            if (a)
                blockParts.push(`#### Assistant:\n${a}`);

            // Join parts of this block with dividers between them
            if (blockParts.length > 0) {
                parts.push(blockParts.join('\n\n---\n\n'));
                // Add divider after the entire block except for the last one
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
        if ($('#gemini-export-btn'))
            return;
        document.body.appendChild(createExportButton());
    }

    // ---------------------------
    // Main export flow
    // ---------------------------
    async function doExport() {
        try {
            const chatId = getChatIdFromUrl();
            if (!chatId) {
                alert('Open a chat at /app/:chatId before exporting.');
                return;
            }

            // Fetch conversation data
            const raw = await fetchConversationPayload(chatId);
            const payloads = parseBatchExecute(raw);
            if (!payloads.length)
                throw new Error('No conversation payloads found in batchexecute response.');

            const blocks = extractAllBlocks(payloads);
            if (!blocks.length)
                throw new Error('Could not extract any User/Assistant message pairs.');

            // Try to fetch the actual conversation title
            let title = await fetchConversationTitle(chatId);
            if (!title) {
                // Fallback to document title or default
                title = document.title?.trim() || 'Gemini Chat';
                // Remove common prefixes/suffixes
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
