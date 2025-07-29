// ==UserScript==
// @name         Easy ChatGPT Markdown Exporter
// @namespace    https://github.com/NoahTheGinger/Userscripts/
// @version      1.5.2
// @description  Export ChatGPT conversations (incl. thoughts, tool calls & custom instructions) to clean Markdown.
// @author       NoahTheGinger
// @note         Original development assistance from Gemini 2.5 Pro in AI Studio, and a large logic fix for tool calls by o3 (high reasoning effort) in OpenAI's Chat Playground, and button logic fixed by Grok 4 via API
// @match        https://chat.openai.com/*
// @match        https://chatgpt.com/*
// @grant        none
// @require      https://cdn.jsdelivr.net/npm/sentinel-js@0.0.7/dist/sentinel.min.js
// @license      MIT
// ==/UserScript==

(function () {
  "use strict";

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
    const { content, metadata, author } = msg;

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
    for (let i = 0; i < nodes.length; ) {
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
    const btn = document.getElementById("simplified-markdown-exporter-button");
    if (btn) {
      btn.textContent = "Exporting...";
      btn.disabled = true;
    }
    try {
      const id = getChatIdFromUrl();
      if (!id) return alert("No conversation ID found.");
      const raw = await fetchConversation(id);
      const md = conversationToMarkdown(processConversation(raw));
      downloadFile(`${sanitizeFilename(raw.title)}.md`, md);
    } catch (e) {
      console.error(e);
      alert("Export failed – see console.");
    } finally {
      if (btn) {
        btn.textContent = "Export";
        btn.disabled = false;
      }
    }
  }

  /* button */
  function createButton() {
    const b = document.createElement("button");
    b.id = "simplified-markdown-exporter-button";
    b.textContent = "Export";
    b.className = "btn relative btn-neutral rounded-md px-3 py-1.5 text-sm font-medium transition-colors duration-150";
    b.style.backgroundColor = "var(--bg-elevated-secondary)";
    b.style.border = "1px solid var(--border-light)";
    b.style.cursor = "pointer";
    b.style.display = "inline-flex";
    b.style.alignItems = "center";
    b.style.justifyContent = "center";
    b.style.lineHeight = "1.5";
    b.addEventListener("click", handleExport);
    return b;
  }

  function init() {
    // This selector targets the container for the buttons on the right side of the composer.
    sentinel.on("div[data-testid='composer-trailing-actions'] > .ms-auto", (buttonContainer) => {
      if (document.getElementById("simplified-markdown-exporter-button")) {
        return;
      }

      const newButton = createButton();
      // The first element in this container is the dictate button's span.
      const referenceNode = buttonContainer.firstChild;

      if (referenceNode) {
        // Insert our button before the first existing button.
        buttonContainer.insertBefore(newButton, referenceNode);
      } else {
        // Fallback if the container is somehow empty when found.
        buttonContainer.appendChild(newButton);
      }
    });
  }

  init();
})();
