// ==UserScript==
// @name         Easy ChatGPT Markdown Exporter
// @namespace    https://github.com/NoahTheGinger/Userscripts/
// @version      1.5
// @description  Export ChatGPT conversations (incl. thoughts, tool calls & custom instructions) to clean Markdown.
// @author       NoahTheGinger
// @note         Original development assistance from Gemini 2.5 Pro in AI Studio, and a large logic fix for tool calls by o3 (high reasoning effort) in OpenAI's Chat Playground
// @match        https://chat.openai.com/*
// @match        https://chatgpt.com/*
// @grant        none
// @require      https://cdn.jsdelivr.net/npm/sentinel-js@0.0.7/dist/sentinel.min.js
// @license      MIT
// ==/UserScript==

(function() {
    'use strict';

    /* ---------- 1. authentication & fetch ---------- */

    async function getAccessToken() {
        const r = await fetch("/api/auth/session");
        if (!r.ok) throw new Error("Not authorised – log-in again");
        const j = await r.json();
        if (!j.accessToken) throw new Error("No access token");
        return j.accessToken;
    }

    function getChatIdFromUrl() {
        const m = location.pathname.match(/\/c\/([a-zA-Z0-9-]+)/);
        return m ? m[1] : null;
    }

    async function fetchConversation(id) {
        const token = await getAccessToken();
        const resp = await fetch(`${location.origin}/backend-api/conversation/${id}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!resp.ok) throw new Error(resp.statusText);
        return resp.json();
    }

    /* ---------- 2. processing & markdown ---------- */

    function processConversation(raw) {
        const title = raw.title || "ChatGPT Conversation";
        const nodes = [];
        let cur = raw.current_node;
        while (cur) {
            const n = raw.mapping[cur];
            if (n && n.message && n.message.author?.role !== "system") nodes.unshift(n);
            cur = n?.parent;
        }
        return { title, nodes };
    }

    /* message --> markdown */
    function transformMessage(msg) {
        if (!msg || !msg.content) return "";
        const { content, metadata } = msg;

        switch (content.content_type) {
            case "text":
                return content.parts?.join("\n") || "";

            case "code": { // tool-call or normal snippet
                const raw = content.text || "";
                const looksJson = raw.trim().startsWith("{") && raw.trim().endsWith("}");
                const lang =
                    content.language ||
                    metadata?.language ||
                    (looksJson ? "json" : "") ||
                    "txt";

                const header = looksJson ? "**Tool Call:**\n" : "";
                return `${header}\`\`\`${lang}\n${raw}\n\`\`\``;
            }

            case "thoughts":
                return content.thoughts
                    .map(
                        t =>
                        `**${t.summary}**\n\n> ${t.content.replace(/\n/g, "\n> ")}`
                    )
                    .join("\n\n");

            case "multimodal_text":
                return (
                    content.parts
                    ?.map(p => {
                        if (typeof p === "string") return p;
                        if (p.content_type === "image_asset_pointer") return "![Image]";
                        if (p.content_type === "code")
                            return `\`\`\`\n${p.text || ""}\n\`\`\``;
                        return `[Unsupported: ${p.content_type}]`;
                    })
                    .join("\n") || ""
                );

                /* noise we always skip */
            case "model_editable_context":
            case "reasoning_recap":
                return "";
            default:
                return `[Unsupported content type: ${content.content_type}]`;
        }
    }

    /* whole conversation --> markdown */
    function conversationToMarkdown({ title, nodes }) {
        let md = `# ${title}\n\n`;

        /* prepend custom instructions (user_editable_context) --------- */
        const idx = nodes.findIndex(
            n => n.message?.content?.content_type === "user_editable_context"
        );
        if (idx > -1) {
            const ctx = nodes[idx].message.content;
            md += "### User Editable Context:\n\n";
            if (ctx.user_profile)
                md += `**About User:**\n\`\`\`\n${ctx.user_profile}\n\`\`\`\n\n`;
            if (ctx.user_instructions)
                md += `**About GPT:**\n\`\`\`\n${ctx.user_instructions}\n\`\`\`\n\n`;
            md += "---\n\n";
            nodes.splice(idx, 1); // remove so we don’t re-process it
        }

        /* main loop --------------------------------------------------- */
        for (let i = 0; i < nodes.length;) {
            const n = nodes[i];
            const m = n.message;
            if (!m || m.recipient !== "all") {
                i++;
                continue;
            }

            if (m.author.role === "user") {
                md += `### User:\n\n${transformMessage(m)}\n\n---\n\n`;
                i++;
                continue;
            }

            if (m.author.role === "assistant") {
                /* gather reasoning (thoughts & tool-call code) ------------- */
                if (m.content.content_type !== "text") {
                    md += "### Thoughts:\n\n";
                    while (
                        i < nodes.length &&
                        ["assistant", "tool"].includes(nodes[i].message.author.role) &&
                        nodes[i].message.content.content_type !== "text"
                    ) {
                        const chunk = transformMessage(nodes[i].message);
                        if (chunk) md += `${chunk}\n\n`;
                        i++;
                    }
                    md += "---\n\n";
                    continue;
                }

                /* final assistant reply ------------------------------------ */
                md += `### ChatGPT:\n\n${transformMessage(m)}\n\n---\n\n`;
                i++;
                continue;
            }

            /* tool messages that slipped through and weren’t handled */
            if (m.author.role === "tool") {
                const chunk = transformMessage(m);
                if (chunk) md += `### Thoughts:\n\n${chunk}\n\n---\n\n`;
            }
            i++;
        }

        return md.trimEnd();
    }


    /* ---------- 3. UI / download ---------- */

    const sanitizeFilename = s => s.replace(/[\/\\?<>:*|"]/g, "-");

    function downloadFile(name, data) {
        const url = URL.createObjectURL(
            new Blob([data], { type: "text/markdown;charset=utf-8" })
        );
        const a = Object.assign(document.createElement("a"), {
            href: url,
            download: name
        });
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    /* export action */
    async function handleExport() {
        const btn = document.getElementById("easy-markdown-exporter-button");
        if (btn) {
            btn.textContent = "Exporting...";
            btn.disabled = true;
            btn.style.cursor = 'not-allowed';
            btn.style.opacity = '0.5';
        }
        try {
            const id = getChatIdFromUrl();
            if (!id) {
                alert("Cannot export: No conversation ID found in URL.");
                return;
            };
            const raw = await fetchConversation(id);
            const md = conversationToMarkdown(processConversation(raw));
            downloadFile(`${sanitizeFilename(raw.title)}.md`, md);
        } catch (e) {
            console.error(e);
            alert("Export failed – see browser console for details.");
        } finally {
            if (btn) {
                btn.textContent = "Export Markdown";
                btn.disabled = false;
                btn.style.cursor = 'pointer';
                btn.style.opacity = '1';
            }
        }
    }

    /* button */
    function createButton() {
        const button = document.createElement("button");
        button.id = "easy-markdown-exporter-button";
        button.textContent = "Export Markdown";

        // Apply styles for a cleaner, more integrated look
        Object.assign(button.style, {
            backgroundColor: 'var(--token-main-surface-secondary)',
            color: 'var(--token-text-primary)',
            border: '1px solid var(--token-border-medium)',
            borderRadius: '8px',
            padding: '7px 12px',
            fontSize: '14px',
            cursor: 'pointer',
            marginRight: '8px',
            lineHeight: '1.25',
            transition: 'background-color 0.2s ease-in-out',
        });

        // Add hover effects for better user feedback
        button.addEventListener('mouseover', () => {
            if (!button.disabled) {
                button.style.backgroundColor = 'var(--token-surface-tertiary)';
            }
        });
        button.addEventListener('mouseout', () => {
            if (!button.disabled) {
                button.style.backgroundColor = 'var(--token-main-surface-secondary)';
            }
        });

        button.addEventListener("click", handleExport);
        return button;
    }

    function init() {
        // SentinelJS waits for the composer's action buttons to appear and injects our button
        sentinel.on('form [data-testid="composer-trailing-actions"]', (div) => {
            // Check if our button is already there to prevent duplicates
            if (document.getElementById("easy-markdown-exporter-button")) {
                return;
            }
            // Add the button before the other actions (like the send button)
            div.prepend(createButton());
        });
    }

    init();
})();
