// ==UserScript==
// @name         ChatGPT Markdown & JSON Exporter
// @namespace    https://github.com/NoahTheGinger/
// @note         Based on ChatGPT Exporter by pionxzh, but for exporting conversations as Markdown or JSON from the current conversation page.
// @version      1.1.0
// @description  Export ChatGPT conversations to Markdown or JSON format
// @author       NoahTheGinger and Claude 4 Sonnet as the Cursor Agent
// @match        https://chat.openai.com/*
// @match        https://chatgpt.com/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // Configuration
    const API_MAPPING = {
        "https://chat.openai.com": "https://chat.openai.com/backend-api",
        "https://chatgpt.com": "https://chatgpt.com/backend-api"
    };

    const baseUrl = new URL(location.href).origin;
    const apiUrl = API_MAPPING[baseUrl];

    // Utility functions
    function sanitizeFilename(title) {
        return title.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_');
    }

    function downloadFile(filename, type, content) {
        const blob = content instanceof Blob ? content : new Blob([content], { type });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    function standardizeLineBreaks(text) {
        return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    }

    function getCurrentTimestamp() {
        return new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    }

    // API functions
    function getChatIdFromUrl() {
        const match = location.pathname.match(/^\/(?:share|c|g\/[a-z0-9-]+\/c)\/([a-z0-9-]+)/i);
        if (match) return match[1];
        return null;
    }

    function isSharePage() {
        return location.pathname.startsWith("/share") && !location.pathname.endsWith("/continue");
    }

    function getPageAccessToken() {
        try {
            return window.__remixContext?.state?.loaderData?.root?.clientBootstrap?.session?.accessToken || null;
        } catch {
            return null;
        }
    }

    async function getAccessToken() {
        const pageAccessToken = getPageAccessToken();
        if (pageAccessToken) return pageAccessToken;

        try {
            const response = await fetch(`${baseUrl}/api/auth/session`);
            if (!response.ok) throw new Error(response.statusText);
            const session = await response.json();
            return session.accessToken;
        } catch (error) {
            throw new Error('Unable to get access token: ' + error.message);
        }
    }

    async function fetchConversation(chatId) {
        if (isSharePage()) {
            // For share pages, get conversation from page data
            try {
                if (window.__NEXT_DATA__?.props?.pageProps?.serverResponse?.data) {
                    return JSON.parse(JSON.stringify(window.__NEXT_DATA__.props.pageProps.serverResponse.data));
                }
                if (window.__remixContext?.state?.loaderData?.["routes/share.$shareId.($action)"]?.serverResponse?.data) {
                    return JSON.parse(JSON.stringify(window.__remixContext.state.loaderData["routes/share.$shareId.($action)"].serverResponse.data));
                }
            } catch (error) {
                throw new Error('Cannot access share page conversation data');
            }
        }

        const accessToken = await getAccessToken();
        const url = `${apiUrl}/conversation/${chatId}`;

        const response = await fetch(url, {
            headers: {
                "Authorization": `Bearer ${accessToken}`,
                "X-Authorization": `Bearer ${accessToken}`,
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch conversation: ${response.statusText}`);
        }

        return response.json();
    }

    // Conversation processing
    function processConversation(conversation) {
        const title = conversation.title || "ChatGPT Conversation";
        const createTime = conversation.create_time;
        const updateTime = conversation.update_time;

        // Find the conversation path
        const mapping = conversation.mapping;
        let currentNodeId = conversation.current_node;

        // If no current_node, find the last node
        if (!currentNodeId) {
            const nodes = Object.values(mapping);
            const leafNodes = nodes.filter(node => !node.children || node.children.length === 0);
            if (leafNodes.length > 0) {
                currentNodeId = leafNodes[0].id;
            }
        }

        if (!currentNodeId) {
            throw new Error("Failed to find conversation nodes");
        }

        // Extract conversation path
        const conversationNodes = [];
        let nodeId = currentNodeId;

        while (nodeId && mapping[nodeId]) {
            const node = mapping[nodeId];
            if (node.message &&
                node.message.author.role !== "system" &&
                node.message.content.content_type !== "model_editable_context" &&
                node.message.content.content_type !== "user_editable_context") {
                conversationNodes.unshift(node);
            }
            nodeId = node.parent;
        }

        return {
            id: conversation.id || getChatIdFromUrl(),
            title,
            createTime,
            updateTime,
            conversationNodes
        };
    }

    function transformAuthor(author) {
        switch (author.role) {
            case "assistant":
                return "Assistant";
            case "user":
                return "User";
            case "tool":
                return `Plugin${author.name ? ` (${author.name})` : ""}`;
            default:
                return author.role;
        }
    }

    function transformContent(content, metadata) {
        switch (content.content_type) {
            case "text":
                return content.parts?.join("\n") || "";
            case "code":
                return `\`\`\`\n${content.text}\n\`\`\``;
            case "multimodal_text":
                return content.parts?.map(part => {
                    if (typeof part === "string") return part;
                    if (part.content_type === "image_asset_pointer") {
                        return `![image](${part.asset_pointer})`;
                    }
                    if (part.content_type === "audio_transcription") {
                        return `[audio] ${part.text}`;
                    }
                    return "[Unsupported content]";
                }).join("\n") || "";
            case "execution_output":
                if (metadata?.aggregate_result?.messages) {
                    const images = metadata.aggregate_result.messages
                        .filter(msg => msg.message_type === "image")
                        .map(msg => `![image](${msg.image_url})`);
                    if (images.length > 0) return images.join("\n");
                }
                return `\`\`\`\n${content.text}\n\`\`\``;
            case "tether_quote":
                return `> ${content.title || content.text || ""}`;
            case "tether_browsing_display": {
                const metadataList = metadata?._cite_metadata?.metadata_list;
                if (Array.isArray(metadataList) && metadataList.length > 0) {
                    return metadataList.map(({title, url}) => `> [${title}](${url})`).join("\n");
                }
                return "";
            }
            default:
                return null;
        }
    }

    function conversationToMarkdown(conversation) {
        const { id, title, createTime, updateTime, conversationNodes } = conversation;

        const content = conversationNodes.map(({ message }) => {
            if (!message || !message.content) return null;
            if (message.recipient !== "all") return null;

            // Skip tool messages except for specific types
            if (message.author.role === "tool" &&
                message.content.content_type !== "multimodal_text" &&
                !(message.content.content_type === "execution_output" &&
                  message.metadata?.aggregate_result?.messages?.some(msg => msg.message_type === "image"))) {
                return null;
            }

            const author = transformAuthor(message.author);
            const messageContent = transformContent(message.content, message.metadata);

            // Skip messages with unsupported content
            if (messageContent === null || messageContent === "[Unsupported Content]" || messageContent.trim() === "") {
                return null;
            }

            return `#### ${author}:\n${messageContent}`;
        }).filter(Boolean).join("\n\n");

        const markdown = `# ${title}\n\n${content}`;
        return markdown;
    }

    // Export functions
    async function exportToMarkdown() {
        try {
            // Check if conversation exists
            if (!document.querySelector('[data-testid^="conversation-turn-"]')) {
                alert("Please start a conversation first");
                return;
            }

            const chatId = getChatIdFromUrl();
            if (!chatId) {
                alert("Unable to determine chat ID");
                return;
            }

            console.log("Fetching conversation...");
            const rawConversation = await fetchConversation(chatId);
            console.log("Processing conversation...");
            const conversation = processConversation(rawConversation);
            console.log("Converting to markdown...");
            const markdown = conversationToMarkdown(conversation);

            const safeTitle = sanitizeFilename(conversation.title);
            const timestamp = getCurrentTimestamp();
            const fileName = `${safeTitle}_${timestamp}.md`;

            downloadFile(fileName, "text/markdown", standardizeLineBreaks(markdown));
            console.log("Markdown export completed successfully!");

        } catch (error) {
            console.error("Markdown export failed:", error);
            alert(`Markdown export failed: ${error.message}`);
        }
    }

    async function exportToJSON() {
        try {
            // Check if conversation exists
            if (!document.querySelector('[data-testid^="conversation-turn-"]')) {
                alert("Please start a conversation first");
                return;
            }

            const chatId = getChatIdFromUrl();
            if (!chatId) {
                alert("Unable to determine chat ID");
                return;
            }

            console.log("Fetching conversation...");
            const rawConversation = await fetchConversation(chatId);

            // Use the raw conversation data directly - this is the official OpenAI JSON structure
            const jsonContent = JSON.stringify(rawConversation, null, 2);

            const safeTitle = sanitizeFilename(rawConversation.title || "ChatGPT Conversation");
            const timestamp = getCurrentTimestamp();
            const fileName = `${safeTitle}_${timestamp}.json`;

            downloadFile(fileName, "application/json", jsonContent);
            console.log("JSON export completed successfully!");

        } catch (error) {
            console.error("JSON export failed:", error);
            alert(`JSON export failed: ${error.message}`);
        }
    }

    function showExportDialog() {
        // Create modal dialog
        const modal = document.createElement("div");
        modal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.5);
            z-index: 10000;
            display: flex;
            align-items: center;
            justify-content: center;
        `;

        const dialog = document.createElement("div");
        dialog.style.cssText = `
            background: white;
            border-radius: 8px;
            padding: 24px;
            min-width: 300px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        `;

        dialog.innerHTML = `
            <h3 style="margin: 0 0 16px 0; color: #333; font-size: 18px;">Choose Export Format</h3>
            <p style="margin: 0 0 20px 0; color: #666; font-size: 14px;">Select the format you'd like to export this conversation in:</p>
            <div style="display: flex; gap: 12px; justify-content: flex-end;">
                <button id="export-markdown-btn" style="
                    background: #10a37f;
                    color: white;
                    border: none;
                    border-radius: 6px;
                    padding: 8px 16px;
                    font-size: 14px;
                    cursor: pointer;
                    transition: background-color 0.2s;
                ">Markdown (.md)</button>
                <button id="export-json-btn" style="
                    background: #2563eb;
                    color: white;
                    border: none;
                    border-radius: 6px;
                    padding: 8px 16px;
                    font-size: 14px;
                    cursor: pointer;
                    transition: background-color 0.2s;
                ">JSON (.json)</button>
                <button id="export-cancel-btn" style="
                    background: #6b7280;
                    color: white;
                    border: none;
                    border-radius: 6px;
                    padding: 8px 16px;
                    font-size: 14px;
                    cursor: pointer;
                    transition: background-color 0.2s;
                ">Cancel</button>
            </div>
        `;

        modal.appendChild(dialog);
        document.body.appendChild(modal);

        // Add event listeners
        const markdownBtn = dialog.querySelector("#export-markdown-btn");
        const jsonBtn = dialog.querySelector("#export-json-btn");
        const cancelBtn = dialog.querySelector("#export-cancel-btn");

        markdownBtn.addEventListener("mouseenter", () => {
            markdownBtn.style.background = "#0d9568";
        });
        markdownBtn.addEventListener("mouseleave", () => {
            markdownBtn.style.background = "#10a37f";
        });

        jsonBtn.addEventListener("mouseenter", () => {
            jsonBtn.style.background = "#1d4ed8";
        });
        jsonBtn.addEventListener("mouseleave", () => {
            jsonBtn.style.background = "#2563eb";
        });

        cancelBtn.addEventListener("mouseenter", () => {
            cancelBtn.style.background = "#4b5563";
        });
        cancelBtn.addEventListener("mouseleave", () => {
            cancelBtn.style.background = "#6b7280";
        });

        markdownBtn.addEventListener("click", () => {
            document.body.removeChild(modal);
            exportToMarkdown();
        });

        jsonBtn.addEventListener("click", () => {
            document.body.removeChild(modal);
            exportToJSON();
        });

        cancelBtn.addEventListener("click", () => {
            document.body.removeChild(modal);
        });

        // Close on background click
        modal.addEventListener("click", (e) => {
            if (e.target === modal) {
                document.body.removeChild(modal);
            }
        });

        // Close on Escape key
        const handleEscape = (e) => {
            if (e.key === "Escape") {
                document.body.removeChild(modal);
                document.removeEventListener("keydown", handleEscape);
            }
        };
        document.addEventListener("keydown", handleEscape);
    }

    // UI injection
    function createExportButton() {
        const button = document.createElement("button");
        button.textContent = "Export";
        button.title = "Export conversation to Markdown or JSON";
        button.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            z-index: 1000;
            background: #10a37f;
            color: white;
            border: none;
            border-radius: 6px;
            padding: 8px 12px;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            transition: background-color 0.2s;
        `;

        button.addEventListener("mouseenter", () => {
            button.style.background = "#0d9568";
        });

        button.addEventListener("mouseleave", () => {
            button.style.background = "#10a37f";
        });

        button.addEventListener("click", showExportDialog);

        return button;
    }

    // Initialize
    function init() {
        // Wait for page to load
        if (document.readyState !== 'loading') {
            addButton();
        } else {
            document.addEventListener('DOMContentLoaded', addButton);
        }
    }

    function addButton() {
        // Remove existing button if present
        const existingButton = document.getElementById('chatgpt-export-btn');
        if (existingButton) {
            existingButton.remove();
        }

        // Create and add new button
        const button = createExportButton();
        button.id = 'chatgpt-export-btn';
        document.body.appendChild(button);
    }

    // Start the script
    init();

    // Re-add button when navigating between conversations
    let currentUrl = location.href;
    setInterval(() => {
        if (location.href !== currentUrl) {
            currentUrl = location.href;
            setTimeout(addButton, 1000); // Delay to ensure page has loaded
        }
    }, 1000);

})();
