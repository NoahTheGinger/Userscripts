// ==UserScript==
// @name         LinkedIn Conversation to Markdown Exporter
// @namespace    https://github.com/NoahTheGinger
// @version      1.1.0
// @description  Exports the currently open LinkedIn conversation as a clean Markdown file from the userscript manager menu.
// @author       NoahTheGinger & Claude 5 Sonnet
// @match        https://www.linkedin.com/messaging/*
// @run-at       document-idle
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  let exportInProgress = false;

  /* --------------------------- DOM helpers ---------------------------- */

  function findThreadEl() {
    return (
      document.querySelector('.scaffold-layout__detail .msg-thread') ||
      document.querySelector('.msg-thread')
    );
  }

  function findMessageListEl(threadEl) {
    return threadEl.querySelector('.msg-s-message-list');
  }

  function getSelfName() {
    const img = document.querySelector('.global-nav__me-photo');
    return img ? (img.getAttribute('alt') || '').trim() : '';
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function notify(text, title = 'LinkedIn Markdown Exporter') {
    if (typeof GM_notification === 'function') {
      GM_notification({
        title,
        text,
        timeout: 3500,
        silent: true,
      });
    }
  }

  /**
   * LinkedIn lazily loads older messages when the message list is scrolled
   * toward the top. Keep requesting older history until the number of
   * rendered messages stops changing.
   */
  async function loadFullHistory(threadEl, onProgress) {
    const listEl = findMessageListEl(threadEl);
    if (!listEl) return;

    let lastCount = -1;
    let stableRounds = 0;
    const maxIterations = 60;

    for (let i = 0; i < maxIterations; i++) {
      const count = threadEl.querySelectorAll(
        '.msg-s-message-list__event'
      ).length;

      if (count === lastCount) {
        stableRounds += 1;

        if (stableRounds >= 2) {
          break;
        }
      } else {
        stableRounds = 0;
      }

      lastCount = count;

      if (onProgress) {
        onProgress(count);
      }

      listEl.scrollTop = 0;
      listEl.dispatchEvent(new Event('scroll', { bubbles: true }));

      await sleep(350);
    }
  }

  /* ------------------------- Content extraction ------------------------ */

  function getPreciseTime(messageEl) {
    /*
     * Self-sent messages contain a delivery-status element with a title
     * similar to:
     *
     *     Sent at 8/7/2026, 2:25 PM
     *
     * This supplies a per-message time even when LinkedIn visually groups
     * several consecutive messages under one timestamp.
     */
    const indicator = messageEl.querySelector('[title^="Sent at"]');

    if (!indicator) {
      return null;
    }

    const title = indicator.getAttribute('title') || '';
    const match = title.match(/Sent at .*?,\s*(.+)$/);

    return match ? match[1].trim() : null;
  }

  function getMessageText(messageEl) {
    const bodyEl = messageEl.querySelector(
      '.msg-s-event-listitem__body'
    );

    if (bodyEl) {
      const clone = bodyEl.cloneNode(true);

      clone
        .querySelectorAll('br')
        .forEach((br) => br.replaceWith('\n'));

      const text = clone.textContent.trim();

      if (text) {
        return text;
      }
    }

    /*
     * Fallback for non-text messages such as images, files, or shared
     * links. Remove message controls before inspecting the content.
     */
    const bubble = messageEl.querySelector(
      '.msg-s-event-listitem__message-bubble'
    );

    if (!bubble) {
      return '';
    }

    const clone = bubble.cloneNode(true);

    clone
      .querySelectorAll(
        [
          '.msg-s-event-listitem__actions-container',
          'button',
          '[role="menu"]',
          '[role="menuitem"]',
        ].join(', ')
      )
      .forEach((element) => element.remove());

    const parts = [];

    clone.querySelectorAll('img').forEach((img) => {
      const alt = (img.getAttribute('alt') || 'attachment').trim();
      const src = img.getAttribute('src') || '';

      if (src && !src.startsWith('data:')) {
        parts.push(`![${alt}](${src})`);
      }
    });

    clone.querySelectorAll('a[href]').forEach((link) => {
      const label = link.textContent.replace(/\s+/g, ' ').trim();
      const href = link.getAttribute('href');

      if (href && label) {
        parts.push(`[${label}](${href})`);
      }
    });

    if (parts.length) {
      return parts.join('\n\n');
    }

    return clone.textContent.replace(/\s+/g, ' ').trim();
  }

  function extractConversation(threadEl) {
    const events = threadEl.querySelectorAll(
      '.msg-s-message-list__event'
    );

    const items = [];
    const selfName = getSelfName();

    let currentDate = null;
    let currentTurn = null;

    events.forEach((messageEl) => {
      const dateEl = messageEl.querySelector(
        '.msg-s-message-list__time-heading'
      );

      if (dateEl) {
        const dateText = dateEl.textContent.trim();

        if (dateText && dateText !== currentDate) {
          currentDate = dateText;
          items.push({
            type: 'date',
            text: dateText,
          });
        }
      }

      const bubble = messageEl.querySelector(
        '.msg-s-event-listitem__message-bubble'
      );

      if (!bubble) {
        /*
         * Preserve system or notification rows as italicized notes rather
         * than silently dropping them.
         */
        const fallbackText = messageEl.textContent
          .replace(/\s+/g, ' ')
          .trim();

        if (fallbackText) {
          items.push({
            type: 'system',
            text: fallbackText,
          });
        }

        currentTurn = null;
        return;
      }

      const nameEl = messageEl.querySelector(
        '.msg-s-message-group__name'
      );

      const groupTimeEl = messageEl.querySelector(
        '.msg-s-message-group__timestamp'
      );

      const preciseTime = getPreciseTime(messageEl);

      const displayTime =
        preciseTime ||
        (groupTimeEl ? groupTimeEl.textContent.trim() : null);

      const content = getMessageText(messageEl);

      if (!content) {
        return;
      }

      if (nameEl) {
        const sender = nameEl.textContent.trim();

        currentTurn = {
          type: 'turn',
          sender,
          isSelf: Boolean(selfName && sender === selfName),
          time: displayTime,
          messages: [content],
          messageTimes: [displayTime],
        };

        items.push(currentTurn);
      } else if (currentTurn) {
        /*
         * LinkedIn omits the sender heading from consecutive messages in
         * the same visual group. Associate those messages with the most
         * recent speaker turn.
         */
        currentTurn.messages.push(content);
        currentTurn.messageTimes.push(displayTime);
      } else {
        /*
         * Defensive fallback in case LinkedIn renders a grouped message
         * without its preceding sender element.
         */
        currentTurn = {
          type: 'turn',
          sender: 'Unknown',
          isSelf: false,
          time: displayTime,
          messages: [content],
          messageTimes: [displayTime],
        };

        items.push(currentTurn);
      }
    });

    return items;
  }

  /* ----------------------------- Markdown ------------------------------ */

  function escapeInline(text) {
    return text.replace(/[\\`*_]/g, '\\$&');
  }

  function escapeBlock(text) {
    return text
      .split('\n')
      .map((line) =>
        line
          .replace(/\\/g, '\\\\')
          .replace(
            /^(\s{0,3})([#>*+-]|\d+\.)(\s|$)/,
            '$1\\$2$3'
          )
      )
      .join('\n');
  }

  function sanitizeFilename(name) {
    return name
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function renderMarkdown(items, participantTitle, conversationUrl) {
    const now = new Date();

    let markdown =
      `# LinkedIn Conversation with ` +
      `${escapeInline(participantTitle)}\n\n`;

    markdown += `- **Exported:** ${now.toLocaleString()}\n`;
    markdown += `- **Conversation URL:** ${conversationUrl}\n\n`;
    markdown += `---\n\n`;

    for (const item of items) {
      if (item.type === 'date') {
        markdown += `## ${escapeInline(item.text)}\n\n`;
        continue;
      }

      if (item.type === 'system') {
        markdown += `_${escapeInline(item.text)}_\n\n`;
        continue;
      }

      if (item.type !== 'turn') {
        continue;
      }

      const headerName = item.isSelf
        ? `${item.sender} (You)`
        : item.sender;

      const headerTime = item.time
        ? ` — ${item.time}`
        : '';

      markdown +=
        `### ${escapeInline(headerName)}` +
        `${headerTime}\n\n`;

      item.messages.forEach((message, index) => {
        const messageTime = item.messageTimes[index];

        /*
         * Show a separate time before a grouped message only when its exact
         * timestamp differs from the time in the speaker header.
         */
        if (
          index > 0 &&
          messageTime &&
          messageTime !== item.time
        ) {
          markdown += `*${messageTime}*  \n`;
        }

        markdown += `${escapeBlock(message)}\n\n`;
      });
    }

    return `${markdown.trim()}\n`;
  }

  function downloadMarkdown(filename, content) {
    const blob = new Blob([content], {
      type: 'text/markdown;charset=utf-8',
    });

    const objectUrl = URL.createObjectURL(blob);
    const downloadLink = document.createElement('a');

    downloadLink.href = objectUrl;
    downloadLink.download = filename;
    downloadLink.hidden = true;

    document.body.appendChild(downloadLink);
    downloadLink.click();

    requestAnimationFrame(() => {
      downloadLink.remove();
      URL.revokeObjectURL(objectUrl);
    });
  }

  /* ------------------------------ Export ------------------------------- */

  function getConversationTitle(threadEl) {
    const heading = threadEl.querySelector(
      '.msg-entity-lockup__entity-title'
    );

    if (heading?.textContent.trim()) {
      return heading.textContent.trim();
    }

    const documentTitle = document.title
      .replace(/^\(\d+\)\s*/, '')
      .replace(/\s*\|\s*LinkedIn$/, '')
      .trim();

    return documentTitle || 'LinkedIn Conversation';
  }

  async function exportCurrentConversation() {
    if (exportInProgress) {
      notify(
        'An export is already in progress. Please wait for it to finish.'
      );
      return;
    }

    const threadEl = findThreadEl();

    if (!threadEl) {
      window.alert(
        'No open LinkedIn conversation was found.\n\n' +
        'Open a conversation and run the export command again.'
      );
      return;
    }

    exportInProgress = true;

    try {
      console.info(
        '[LinkedIn Markdown Exporter] Loading full conversation history…'
      );

      await loadFullHistory(threadEl, (count) => {
        console.info(
          `[LinkedIn Markdown Exporter] ${count} message rows loaded…`
        );
      });

      /*
       * Confirm that the same thread still exists. This protects against
       * switching conversations while the exporter is loading history.
       */
      if (!threadEl.isConnected) {
        throw new Error(
          'The open conversation changed while history was loading.'
        );
      }

      const title = getConversationTitle(threadEl);
      const items = extractConversation(threadEl);

      if (!items.some((item) => item.type === 'turn')) {
        throw new Error(
          'No conversation messages were found in the open thread.'
        );
      }

      const markdown = renderMarkdown(
        items,
        title,
        window.location.href
      );

      const dateStamp = new Date()
        .toISOString()
        .slice(0, 10);

      const filename =
        sanitizeFilename(
          `LinkedIn - ${title} - ${dateStamp}`
        ) + '.md';

      downloadMarkdown(filename, markdown);

      console.info(
        `[LinkedIn Markdown Exporter] Exported "${filename}".`
      );

      notify(
        `Downloaded ${filename}`,
        'LinkedIn conversation exported'
      );
    } catch (error) {
      console.error(
        '[LinkedIn Markdown Exporter] Export failed:',
        error
      );

      window.alert(
        'The LinkedIn conversation could not be exported.\n\n' +
        `${error instanceof Error ? error.message : String(error)}\n\n` +
        'More details may be available in the browser console.'
      );
    } finally {
      exportInProgress = false;
    }
  }

  /* ------------------------- Menu registration ------------------------- */

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand(
      'Export current conversation as Markdown',
      exportCurrentConversation
    );
  } else {
    console.error(
      '[LinkedIn Markdown Exporter] ' +
      'GM_registerMenuCommand is unavailable. Check the userscript manager.'
    );
  }
})();
