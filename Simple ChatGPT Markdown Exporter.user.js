// ==UserScript==
// @name         Simple ChatGPT Markdown Exporter
// @namespace    https://github.com/NoahTheGinger/Userscripts/
// @version      1.2
// @description  A lightweight userscript to export ChatGPT conversations, including model thoughts, to a clean Markdown file.
// @author       NoahTheGinger & Gemini 2.5 Pro
// @match        https://chat.openai.com/c/*
// @match        https://chat.openai.com/g/*/c/*
// @match        https://chatgpt.com/c/*
// @match        https://chatgpt.com/g/*/c/*
// @grant        none
// @require      https://cdn.jsdelivr.net/npm/sentinel-js@0.0.7/dist/sentinel.min.js
// @license      MIT
// ==/UserScript==

(function() {
    'use strict';

    // --- 1. API and Data Fetching Logic ---

    /**
     * Retrieves the authentication token for the API.
     * @returns {Promise<string>} The access token.
     */
    async function getAccessToken() {
        const resp = await fetch('/api/auth/session');
        if (!resp.ok) {
            throw new Error('Failed to fetch session. You may need to log in again.');
        }
        const data = await resp.json();
        if (!data.accessToken) {
            throw new Error('Could not find access token in session.');
        }
        return data.accessToken;
    }

    /**
     * Gets the current conversation ID from the URL, supporting both standard and Custom GPT chats.
     * @returns {string|null} The chat ID or null if not found.
     */
    function getChatIdFromUrl() {
        // This regex finds the UUID following "/c/" regardless of what precedes it (e.g., "/g/.../").
        const match = window.location.pathname.match(/\/c\/([a-zA-Z0-9-]+)/);
        return match ? match[1] : null;
    }

    /**
     * Fetches the full conversation data from the API.
     * @param {string} chatId The ID of the conversation to fetch.
     * @returns {Promise<object>} The raw conversation data.
     */
    async function fetchConversation(chatId) {
        const accessToken = await getAccessToken();
        const apiUrl = new URL(location.href).origin;
        const response = await fetch(`${apiUrl}/backend-api/conversation/${chatId}`, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        if (!response.ok) {
            throw new Error(`Network response was not ok: ${response.statusText}`);
        }
        return response.json();
    }

    // --- 2. Data Processing and Markdown Conversion ---

    /**
     * Processes the raw API data into a structured format.
     * @param {object} rawData - The raw conversation data from the API.
     * @returns {{title: string, conversationNodes: Array<object>}}
     */
    function processConversation(rawData) {
        const title = rawData.title || 'ChatGPT Conversation';
        const startNodeId = rawData.current_node;
        if (!startNodeId) throw new Error('Failed to find the starting node of the conversation.');

        const conversationNodes = [];
        let currentNodeId = startNodeId;
        while (currentNodeId) {
            const node = rawData.mapping[currentNodeId];
            // Exclude system messages, which are not part of the visible conversation
            if (!node || !node.message || node.message.author?.role === 'system') {
                currentNodeId = node?.parent;
                continue;
            }
            conversationNodes.unshift(node);
            currentNodeId = node.parent;
        }

        return { title, conversationNodes };
    }

    /**
     * Converts a message's content object to a Markdown string.
     * @param {object} content - The content object from a message.
     * @param {object} metadata - The metadata object for the message.
     * @returns {string} The formatted content string.
     */
    function transformContent(content, metadata) {
        if (!content) return '[No content]';

        switch (content.content_type) {
            case 'text':
                return content.parts?.join('\n') || '';
            case 'code':
                const language = metadata?.language || '';
                return '```' + language + '\n' + (content.text || '') + '\n```';
            case 'thoughts':
                if (!content.thoughts || content.thoughts.length === 0) return '';
                let thoughtsMarkdown = '<details>\n<summary>View Thoughts</summary>\n\n';
                content.thoughts.forEach(thought => {
                    const summary = thought.summary.replace(/</g, '<').replace(/>/g, '>');
                    const thoughtContent = thought.content.replace(/\n/g, '\n> '); // Blockquote the content
                    thoughtsMarkdown += `**${summary}**\n\n> ${thoughtContent}\n\n`;
                });
                thoughtsMarkdown += '</details>';
                return thoughtsMarkdown;
            case 'reasoning_recap':
                return ''; // Ignore the "Thought for X seconds" message for a cleaner export.
            case 'multimodal_text':
                return (content.parts?.map(part => {
                    if (typeof part === 'string') return part;
                    if (part.content_type === 'image_asset_pointer') return '![Image]';
                    if (part.content_type === 'code') return '```\n' + (part.text || '') + '\n```';
                    return `[Unsupported content: ${part.content_type}]`;
                }).join('\n')) || '';
            default:
                return `[Unsupported content type: ${content.content_type}]`;
        }
    }

    /**
     * Converts the entire processed conversation into a single Markdown string.
     * @param {object} conversation - The processed conversation object.
     * @returns {string} The complete conversation in Markdown format.
     */
    function conversationToMarkdown(conversation) {
        const { title, conversationNodes } = conversation;
        let markdown = `# ${title}\n\n`;
        let i = 0;

        while (i < conversationNodes.length) {
            const node = conversationNodes[i];
            const message = node.message;

            if (!message || message.recipient !== 'all') {
                i++;
                continue;
            }

            const authorRole = message.author.role;

            if (authorRole === 'user') {
                const content = transformContent(message.content, message.metadata);
                markdown += `#### User:\n\n${content}\n\n---\n\n`;
                i++;
            } else if (authorRole === 'assistant') {
                markdown += `#### Assistant:\n\n`;
                // An assistant's turn can be multiple messages (thoughts, then final response).
                // We loop to gather all parts of this single turn.
                let turnEnded = false;
                while (i < conversationNodes.length && !turnEnded) {
                    const assistantNode = conversationNodes[i];
                    const assistantMessage = assistantNode.message;

                    if (!assistantMessage || assistantMessage.author.role !== 'assistant') {
                        break; // Moved to the next user turn
                    }

                    const content = transformContent(assistantMessage.content, assistantMessage.metadata);
                    if (content) {
                        markdown += `${content}\n\n`;
                    }

                    turnEnded = assistantMessage.end_turn;
                    i++;
                }
                markdown += `---\n\n`;
            } else {
                // Skip other roles like 'tool' for this simplified script
                i++;
            }
        }

        return markdown;
    }


    // --- 3. UI and Export Trigger ---

    /**
     * Sanitizes a string for use as a filename, preserving spaces.
     * @param {string} name - The string to sanitize.
     * @returns {string} The sanitized filename.
     */
    function sanitizeFilename(name) {
        // Remove characters that are invalid in filenames on most OSes.
        return name.replace(/[\/\?<>\\:\*\|"]/g, '-');
    }

    /**
     * Triggers the download of a file.
     * @param {string} filename - The desired name of the file.
     * @param {string} content - The content of the file.
     */
    function downloadFile(filename, content) {
        const blob = new Blob([content], { type: 'text/markdown;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    /**
     * The main function to handle the export process.
     */
    async function handleExport() {
        const button = document.getElementById('simplified-markdown-exporter-button');
        if (button) {
            button.textContent = 'Exporting...';
            button.disabled = true;
        }

        try {
            const chatId = getChatIdFromUrl();
            if (!chatId) {
                alert('Could not find conversation ID. Please ensure you are inside a chat.');
                return;
            }

            const rawData = await fetchConversation(chatId);
            const processedData = processConversation(rawData);
            const markdownContent = conversationToMarkdown(processedData);
            const filename = `${sanitizeFilename(processedData.title)}.md`;
            downloadFile(filename, markdownContent);

        } catch (error) {
            console.error('ChatGPT Markdown Exporter Error:', error);
            alert(`Failed to export conversation: ${error.message}. Check the console for more details.`);
        } finally {
             if (button) {
                 button.textContent = 'Export Markdown';
                 button.disabled = false;
             }
        }
    }

    /**
     * Creates and returns the export button element.
     * @returns {HTMLButtonElement}
     */
    function createExportButton() {
        const button = document.createElement('button');
        button.id = 'simplified-markdown-exporter-button';
        button.textContent = 'Export Markdown';

        // Basic styling to match the page's aesthetic
        button.className = 'btn relative btn-neutral';
        button.style.margin = '0 8px'; // Add some space

        button.addEventListener('click', handleExport);
        return button;
    }

    /**
     * Injects the button into the page when the target element is available.
     */
    function initialize() {
        // Use SentinelJS to wait for the prompt form's action buttons to appear
        sentinel.on('form > div > div:last-child > div', (div) => {
            // Check if the button is already there to prevent duplicates
            if (document.getElementById('simplified-markdown-exporter-button')) {
                return;
            }
            // Add the button next to the "Regenerate" button
            div.appendChild(createExportButton());
        });
    }

    initialize();
})();
