// ==UserScript==
// @name         Copilot Conversation Exporter
// @author       NoahTheGinger
// @namespace    https://github.com/NoahTheGinger/Userscripts/
// @version      0.3.2
// @description  Export Copilot chats as nicely formatted Markdown files.
// @match        https://copilot.microsoft.com/*
// @license      MIT
// @grant        none
// @downloadURL  https://update.greasyfork.org/scripts/532612/Copilot%20Conversation%20Exporter.user.js
// @updateURL    https://update.greasyfork.org/scripts/532612/Copilot%20Conversation%20Exporter.meta.js
// ==/UserScript==

(function () {
  'use strict';

  /* ----------------------------------------------------------
     Return BOTH a pretty header and a safe filename
  ---------------------------------------------------------- */
  function getConversationTitles() {
    let raw = '';

    // Sidebar selected conversation
    const selected = document.querySelector('[role="option"][aria-selected="true"]');
    if (selected) {
      raw =
        selected.querySelector('p')?.textContent.trim() ||
        (selected.getAttribute('aria-label') || '').split(',').slice(1).join(',').trim();
    }

    // <title> fallback
    if (!raw) {
      raw = (document.title || '')
        .replace(/^\s*Microsoft[_\s-]*Copilot.*$/i, '')
        .replace(/\s*[-–|]\s*Copilot.*$/i, '')
        .trim();
    }

    if (!raw) raw = 'Copilot Conversation';

    // Header: keep spaces, drop only forbidden chars
    const header = raw.replace(/[\\/:*?"<>|]/g, '').trim();

    // File name: stricter – spaces→underscores etc.
    const file = header
      .replace(/\s+/g, '_')
      .substring(0, 100)
      .toLowerCase(); // optional lower-casing

    return { header, file };
  }

  /* (unchanged) nodeToMarkdown … */
  function nodeToMarkdown(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.tagName.toLowerCase();
    let md = '';

    switch (tag) {
      case 'br':
        return '\n';
      case 'p':
        return Array.from(node.childNodes).map(nodeToMarkdown).join('').trim() + '\n\n';
      case 'ul':
        Array.from(node.children).forEach(li => (md += '- ' + nodeToMarkdown(li).trim() + '\n'));
        return '\n' + md + '\n';
      case 'li':
        return Array.from(node.childNodes).map(nodeToMarkdown).join('');
      case 'strong':
      case 'b':
        return '**' + Array.from(node.childNodes).map(nodeToMarkdown).join('').trim() + '**';
      case 'em':
      case 'i':
        return '_' + Array.from(node.childNodes).map(nodeToMarkdown).join('').trim() + '_';
      case 'a':
        const href = node.getAttribute('href') || '';
        return `[${Array.from(node.childNodes).map(nodeToMarkdown).join('').trim()}](${href})`;
      case 'img':
        return `![${node.getAttribute('alt') || ''}](${node.getAttribute('src') || ''})`;
      default:
        return Array.from(node.childNodes).map(nodeToMarkdown).join('');
    }
  }

  /* ----------------------------------------------------------
     Export logic – header & filename switched
  ---------------------------------------------------------- */
  function exportConversation() {
    const messages = document.querySelectorAll(
      '[data-content="user-message"], [data-content="ai-message"]'
    );
    if (!messages.length) {
      alert('No conversation messages found!');
      return;
    }

    const { header, file } = getConversationTitles();
    let mdOutput = `# ${header}\n\n`;

    messages.forEach(msg => {
      const role = msg.getAttribute('data-content') === 'user-message' ? 'User' : 'Copilot';
      let contentMarkdown = nodeToMarkdown(msg).trim();
      if (role === 'Copilot') contentMarkdown = contentMarkdown.replace(/^Copilot said\s*/i, '');
      mdOutput += `**${role}:**\n\n${contentMarkdown}\n\n---\n\n`;
    });

    const blob = new Blob([mdOutput], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: `${file}.md` });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /* (unchanged) add button */
  function addExportButton() {
    const btn = Object.assign(document.createElement('button'), { textContent: 'Export Chat (MD)' });
    Object.assign(btn.style, {
      position: 'fixed',
      bottom: '10px',
      right: '10px',
      zIndex: '10000',
      padding: '8px 10px',
      background: '#28a745',
      color: '#fff',
      border: 'none',
      borderRadius: '5px',
      cursor: 'pointer',
      fontSize: '12px',
    });
    btn.addEventListener('click', exportConversation);
    document.body.appendChild(btn);
  }

  window.addEventListener('load', addExportButton);
})();
