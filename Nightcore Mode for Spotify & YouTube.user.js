// ==UserScript==
// @name         Nightcore Mode for Spotify & YouTube
// @namespace    https://github.com/NoahTheGinger
// @version      1.0.0
// @description  Nightcore mode for Spotify, YouTube, and YouTube Music: faster playback with rising pitch. Draggable, minimizable panel that remembers its position.
// @author       NoahTheGinger, ChatGPT 6.1 Sol, Claude 5.5 Opus
// @license      MIT
// @match        https://open.spotify.com/*
// @match        https://*.youtube.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
    'use strict';

    // ==========================================
    // SHARED CONFIGURATION
    // ==========================================

    const DEFAULT_SPEED = 1.25;

    const SPEEDS = [
        1.05, 1.10, 1.15, 1.20,
        1.25, 1.30, 1.35, 1.40,
        1.45, 1.50, 1.75, 2.00
    ];

    // Where the panel sits horizontally until the user drags it.
    const DEFAULT_RIGHT = 20;

    // Minimum gap kept between the panel and screen edges.
    const EDGE_MARGIN = 4;

    // Pointer must move this far before a press becomes a drag.
    const DRAG_THRESHOLD = 4;

    const onSpotify = location.hostname === 'open.spotify.com';

    // Spotify's player lives in the top window, so skip its frames.
    // YouTube must keep running inside frames for /embed players,
    // which is why this isn't a @noframes line in the header.
    if (onSpotify && window.self !== window.top) return;

    // ==========================================
    // SITE ADAPTERS
    // ==========================================

    // Everything that differs between sites lives in these two
    // functions. Each one returns the same set of properties:
    //
    //   name                    Label for the console message.
    //   panelId                 Id of the floating panel.
    //   enableKey, speedKey,
    //   uiKey                   localStorage keys.
    //   enabledByDefault        State before the first toggle.
    //   checkInterval           Monitor period in milliseconds.
    //   defaultBottom           Panel offset until it is dragged.
    //   isPlaybackPage()        Should the panel show on this page?
    //   shouldControl(media)    Should this element be sped up?
    //   getPlayers()            The elements to act on right now.
    //   scan()                  Monitor fallback for finding players.
    //   restoreRate(media,
    //               original)   Undo the speed change.
    //   init()                  Hooks specific to the site.

    // ------------------------------------------
    // Spotify
    // ------------------------------------------

    function createSpotifySite() {
        // Every media element Spotify has played. Spotify may
        // create a fresh element per track and keep it outside
        // the DOM, so querySelector alone can't be trusted to
        // find the player.
        const players = new Set();

        function register(media) {
            if (!(media instanceof HTMLMediaElement)) return;

            players.add(media);
            attachMediaListeners(media);
            applyNightcore(media);
        }

        return {
            name: 'Spotify',
            panelId: 'spotify-nightcore-controller',

            enableKey: 'spotify-nightcore-enabled-v1',
            speedKey: 'spotify-nightcore-speed-v1',
            uiKey: 'spotify-nightcore-ui-v1',

            enabledByDefault: true,
            checkInterval: 500,
            defaultBottom: 100,

            isPlaybackPage() {
                return true;
            },

            shouldControl(media) {
                // Canvas / looping-visual previews run as separate
                // muted, looping players. Leave those alone.
                return !(media.loop && media.muted);
            },

            getPlayers() {
                return players;
            },

            scan() {
                // Fallback for elements that were already playing
                // before the hook was installed.
                for (const media of document.querySelectorAll(
                    'video, audio'
                )) {
                    register(media);
                }

                // Forget elements that have been emptied and are
                // idle. They re-register if they ever play again.
                for (const media of players) {
                    if (media.readyState === 0 && media.paused) {
                        players.delete(media);
                    }
                }
            },

            restoreRate(media) {
                // Spotify keeps defaultPlaybackRate in sync with
                // the speed it wants (1x for music), so it is the
                // right value to return to.
                if (media.playbackRate !== 0) {
                    media.playbackRate = media.defaultPlaybackRate;
                }
            },

            init() {
                // Catch every element the moment Spotify starts
                // playing it, before any audio is heard at normal
                // speed. This is why the script runs at
                // document-start.
                const nativePlay = HTMLMediaElement.prototype.play;

                HTMLMediaElement.prototype.play = function (...args) {
                    register(this);

                    return nativePlay.apply(this, args);
                };
            }
        };
    }

    // ------------------------------------------
    // YouTube and YouTube Music
    // ------------------------------------------

    function createYouTubeSite() {
        const onYouTubeMusic = location.hostname === 'music.youtube.com';

        function isPlaybackPage() {
            if (onYouTubeMusic) return true;

            // Regular YouTube playback pages.
            if (/^\/(watch|shorts|live|embed)(\/|$)/.test(
                location.pathname
            )) {
                return true;
            }

            // Support YouTube's floating miniplayer.
            return !!document.querySelector(
                'ytd-miniplayer[active] video'
            );
        }

        function getMedia() {
            // Prefer the actual YouTube player rather
            // than preview videos in feeds or thumbnails.

            const selectors = [
                '#movie_player video.html5-main-video',
                '#movie_player audio',
                'ytmusic-player video',
                'ytmusic-player audio',
                'ytd-player video.html5-main-video',
                'ytd-miniplayer video',
                'video.html5-main-video'
            ];

            for (const selector of selectors) {
                const media = document.querySelector(selector);

                if (media) return media;
            }

            // YouTube Music may use another HTML media
            // element depending on its player implementation.
            if (onYouTubeMusic) {
                const mediaElements =
                    document.querySelectorAll('video, audio');

                // Prefer an actively playing element.
                for (const media of mediaElements) {
                    if (!media.paused && !media.ended) {
                        return media;
                    }
                }

                return mediaElements[0] || null;
            }

            return null;
        }

        function onNavigation() {
            updatePanel();

            // YouTube loads its player asynchronously.
            // Retry as the new page/song initializes.
            for (const delay of [
                0, 100, 300, 750, 1500, 2500
            ]) {
                setTimeout(() => {
                    updatePanel();

                    if (enabled) {
                        applyToAll();
                    }
                }, delay);
            }
        }

        return {
            name: onYouTubeMusic ? 'YouTube Music' : 'YouTube',
            panelId: 'yt-nightcore-controller',

            enableKey: 'nightcore-enabled-v3',
            speedKey: 'nightcore-speed-v3',
            uiKey: 'nightcore-ui-v1',

            enabledByDefault: false,
            checkInterval: 300,
            defaultBottom: 90,

            isPlaybackPage,

            shouldControl(media) {
                return isPlaybackPage() && media === getMedia();
            },

            getPlayers() {
                const media = getMedia();

                return media ? [media] : [];
            },

            scan() {
                const media = getMedia();

                if (media) {
                    attachMediaListeners(media);
                }
            },

            restoreRate(media, original) {
                // Restore the playback speed from before
                // Nightcore was enabled.
                media.playbackRate = original?.rate ?? 1;
            },

            init() {
                const navigationEvents = [
                    'yt-navigate-finish',
                    'yt-page-data-updated',
                    'ytmusic-navigate-finish',
                    'ytmusic-page-data-updated'
                ];

                for (const eventName of navigationEvents) {
                    document.addEventListener(
                        eventName,
                        onNavigation
                    );
                }

                // Notice when YouTube replaces a video/audio
                // element without reloading the page.
                const observer = new MutationObserver(mutations => {
                    if (!enabled) return;

                    for (const mutation of mutations) {
                        for (const node of mutation.addedNodes) {
                            if (node.nodeType !== 1) continue;

                            const isMedia =
                                node.matches?.('video, audio') ||
                                node.querySelector?.('video, audio');

                            if (isMedia) {
                                applyToAll();
                                return;
                            }
                        }
                    }
                });

                // Observe the document itself: at document-start
                // there may be no <html> element to observe yet.
                observer.observe(document, {
                    childList: true,
                    subtree: true
                });
            }
        };
    }

    const site = onSpotify
        ? createSpotifySite()
        : createYouTubeSite();

    // ==========================================
    // SETTINGS STORAGE
    // ==========================================

    // Settings live in localStorage, so they survive new tabs and
    // browser restarts. localStorage is per origin, which means
    // Spotify, YouTube, and YouTube Music each remember their own
    // on/off state, speed, and panel layout.

    function readSetting(key) {
        try {
            return localStorage.getItem(key);
        } catch {
            return null;
        }
    }

    function writeSetting(key, value) {
        try {
            localStorage.setItem(key, String(value));
        } catch {
            // Storage blocked; settings just won't persist.
        }
    }

    const storedEnabled = readSetting(site.enableKey);

    // After the first toggle, the last state is remembered.
    let enabled = storedEnabled === null
        ? site.enabledByDefault
        : storedEnabled === 'true';

    const storedSpeed = Number(readSetting(site.speedKey));

    let speed = SPEEDS.includes(storedSpeed)
        ? storedSpeed
        : DEFAULT_SPEED;

    // ==========================================
    // PANEL STATE STORAGE
    // ==========================================

    function loadUi() {
        try {
            const parsed = JSON.parse(
                readSetting(site.uiKey) || '{}'
            );

            return {
                minimized: parsed.minimized === true,
                left: Number.isFinite(parsed.left)
                    ? parsed.left
                    : null,
                top: Number.isFinite(parsed.top)
                    ? parsed.top
                    : null
            };
        } catch {
            return { minimized: false, left: null, top: null };
        }
    }

    function saveUi() {
        writeSetting(site.uiKey, JSON.stringify(ui));
    }

    const ui = loadUi();

    // Elements we've attached listeners to.
    const watchedMedia = new WeakSet();

    // Remember original settings for restoration.
    const originalSettings = new WeakMap();

    // ==========================================
    // PITCH CONTROL
    // ==========================================

    function setPitchPreservation(media, preserve) {
        if ('preservesPitch' in media) {
            media.preservesPitch = preserve;
        }

        // Compatibility with older implementations.
        if ('mozPreservesPitch' in media) {
            media.mozPreservesPitch = preserve;
        }

        if ('webkitPreservesPitch' in media) {
            media.webkitPreservesPitch = preserve;
        }
    }

    // ==========================================
    // NIGHTCORE ENGINE
    // ==========================================

    function applyNightcore(media) {
        if (!enabled || !site.shouldControl(media)) return;

        attachMediaListeners(media);

        // Save settings before modifying the player.
        if (!originalSettings.has(media)) {
            originalSettings.set(media, {
                rate: media.playbackRate,
                pitch: media.preservesPitch
            });
        }

        // Critical: allow pitch to rise with speed.
        if (media.preservesPitch !== false) {
            setPitchPreservation(media, false);
        }

        // Spotify sets playbackRate to 0 while it rebuffers
        // streamed audio, then restores it afterwards. Leave
        // that alone, or playback would never pause to buffer.
        if (media.playbackRate === 0) return;

        // Maintain the desired Nightcore speed.
        if (Math.abs(media.playbackRate - speed) > 0.001) {
            media.playbackRate = speed;
        }
    }

    function applyToAll() {
        for (const media of site.getPlayers()) {
            applyNightcore(media);
        }
    }

    function disableNightcore() {
        for (const media of site.getPlayers()) {
            const original = originalSettings.get(media);

            // Restore normal pitch behavior.
            setPitchPreservation(
                media,
                original?.pitch ?? true
            );

            site.restoreRate(media, original);

            originalSettings.delete(media);
        }
    }

    // ==========================================
    // PLAYER EVENT MONITORING
    // ==========================================

    function attachMediaListeners(media) {
        if (watchedMedia.has(media)) return;

        watchedMedia.add(media);

        // These events catch new songs, source changes,
        // playback starts, rebuffering, and the site
        // resetting the speed.
        const events = [
            'loadstart',
            'loadedmetadata',
            'canplay',
            'playing',
            'ratechange',
            'emptied'
        ];

        for (const eventName of events) {
            media.addEventListener(eventName, () => {
                applyNightcore(media);
            });
        }
    }

    // ==========================================
    // FLOATING CONTROL PANEL
    // ==========================================

    const panel = document.createElement('div');
    panel.id = site.panelId;

    panel.style.cssText = `
        position: fixed;
        right: ${DEFAULT_RIGHT}px;
        bottom: ${site.defaultBottom}px;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        background: #181818;
        border: 1px solid #555;
        box-shadow: 0 4px 18px #0009;
        font: 14px Arial, sans-serif;
        touch-action: none;
        user-select: none;
        -webkit-user-select: none;
    `;

    // Expanded layout: grip | toggle | speed | minimize
    const full = document.createElement('div');

    full.style.cssText = `
        display: flex;
        align-items: center;
        gap: 8px;
    `;

    const grip = document.createElement('div');
    grip.textContent = '⠿';
    grip.title = 'Drag to move';

    grip.style.cssText = `
        cursor: grab;
        color: #aaa;
        font: 20px/1 Arial, sans-serif;
        padding: 0 2px;
    `;

    const toggle = document.createElement('button');

    toggle.style.cssText = `
        border: none;
        border-radius: 8px;
        padding: 10px 14px;
        color: white;
        font: bold 13px Arial, sans-serif;
        cursor: pointer;
        white-space: nowrap;
    `;

    const selector = document.createElement('select');

    selector.style.cssText = `
        padding: 9px;
        background: #303030;
        color: white;
        border: 1px solid #666;
        border-radius: 8px;
        font: 13px Arial, sans-serif;
        cursor: pointer;
    `;

    for (const value of SPEEDS) {
        const option = document.createElement('option');

        option.value = String(value);
        option.textContent = `${value.toFixed(2)}x`;

        selector.appendChild(option);
    }

    selector.value = String(speed);

    const minimizeButton = document.createElement('button');
    minimizeButton.textContent = '–';
    minimizeButton.title = 'Minimize';

    minimizeButton.style.cssText = `
        border: none;
        border-radius: 8px;
        width: 32px;
        padding: 8px 0;
        background: #303030;
        color: white;
        font: bold 16px Arial, sans-serif;
        cursor: pointer;
    `;

    full.append(grip, toggle, selector, minimizeButton);

    // Minimized layout: a single draggable moon.
    const mini = document.createElement('div');
    mini.textContent = '🌙';

    mini.style.cssText = `
        align-items: center;
        justify-content: center;
        width: 40px;
        height: 40px;
        border-radius: 50%;
        color: white;
        font-size: 20px;
        cursor: grab;
    `;

    panel.append(full, mini);

    // ------------------------------------------
    // Appearance
    // ------------------------------------------

    function updateButton() {
        toggle.textContent = enabled
            ? '🌙 Nightcore ON'
            : '🌙 Nightcore OFF';

        const color = enabled ? '#8b36cf' : '#555';

        toggle.style.background = color;
        mini.style.background = color;

        mini.title = `Nightcore ${enabled ? 'ON' : 'OFF'}` +
            ' (click to expand, drag to move)';
    }

    function applyMinimized() {
        full.style.display = ui.minimized ? 'none' : 'flex';
        mini.style.display = ui.minimized ? 'flex' : 'none';

        panel.style.padding = ui.minimized ? '5px' : '10px';
        panel.style.borderRadius = ui.minimized ? '999px' : '12px';
    }

    // ------------------------------------------
    // Positioning
    // ------------------------------------------

    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), Math.max(min, max));
    }

    function applyPosition() {
        // Never dragged: stay at the default corner offset.
        if (ui.left === null || ui.top === null) {
            panel.style.left = 'auto';
            panel.style.top = 'auto';
            panel.style.right = `${DEFAULT_RIGHT}px`;
            panel.style.bottom = `${site.defaultBottom}px`;
            return;
        }

        let left = ui.left;
        let top = ui.top;

        const width = panel.offsetWidth;
        const height = panel.offsetHeight;

        // Keep the panel on screen (e.g. smaller window,
        // rotated phone). The stored position is left alone
        // so it returns if the screen gets bigger again.
        if (width && height) {
            const root = document.documentElement;

            left = clamp(
                left,
                EDGE_MARGIN,
                root.clientWidth - width - EDGE_MARGIN
            );

            top = clamp(
                top,
                EDGE_MARGIN,
                window.innerHeight - height - EDGE_MARGIN
            );
        }

        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
    }

    function setMinimized(value) {
        ui.minimized = value;

        applyMinimized();
        applyPosition();
        saveUi();
    }

    // ------------------------------------------
    // Dragging (mouse, touch, and pen)
    // ------------------------------------------

    let drag = null;

    panel.addEventListener('pointerdown', event => {
        if (event.pointerType === 'mouse' && event.button !== 0) {
            return;
        }

        // Buttons and the dropdown keep their normal behavior.
        if (event.target.closest('button, select')) return;

        const rect = panel.getBoundingClientRect();

        drag = {
            id: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            offsetX: event.clientX - rect.left,
            offsetY: event.clientY - rect.top,
            moved: false,
            wasMinimized: ui.minimized
        };

        try {
            panel.setPointerCapture(event.pointerId);
        } catch {
            // Capture is a nicety, not a requirement.
        }
    });

    panel.addEventListener('pointermove', event => {
        if (!drag || event.pointerId !== drag.id) return;

        if (!drag.moved) {
            const distance = Math.hypot(
                event.clientX - drag.startX,
                event.clientY - drag.startY
            );

            if (distance < DRAG_THRESHOLD) return;

            drag.moved = true;
            grip.style.cursor = 'grabbing';
            mini.style.cursor = 'grabbing';
        }

        const root = document.documentElement;

        ui.left = clamp(
            event.clientX - drag.offsetX,
            EDGE_MARGIN,
            root.clientWidth - panel.offsetWidth - EDGE_MARGIN
        );

        ui.top = clamp(
            event.clientY - drag.offsetY,
            EDGE_MARGIN,
            window.innerHeight - panel.offsetHeight - EDGE_MARGIN
        );

        applyPosition();

        event.preventDefault();
    });

    function endDrag(event) {
        if (!drag || event.pointerId !== drag.id) return;

        const finished = drag;
        drag = null;

        try {
            panel.releasePointerCapture(event.pointerId);
        } catch {
            // Already released.
        }

        grip.style.cursor = 'grab';
        mini.style.cursor = 'grab';

        if (finished.moved) {
            saveUi();
        } else if (
            finished.wasMinimized &&
            event.type === 'pointerup'
        ) {
            // A plain click on the minimized moon expands it.
            setMinimized(false);
        }
    }

    panel.addEventListener('pointerup', endDrag);
    panel.addEventListener('pointercancel', endDrag);

    window.addEventListener('resize', applyPosition);

    // ------------------------------------------
    // Controls
    // ------------------------------------------

    toggle.addEventListener('click', () => {
        enabled = !enabled;

        writeSetting(site.enableKey, enabled);

        updateButton();

        if (enabled) {
            applyToAll();
        } else {
            disableNightcore();
        }
    });

    selector.addEventListener('change', () => {
        speed = Number(selector.value);

        writeSetting(site.speedKey, speed);

        if (enabled) {
            applyToAll();
        }
    });

    minimizeButton.addEventListener('click', () => {
        setMinimized(true);
    });

    function updatePanel() {
        if (!document.body) return;

        // Restore panel if the site replaces page elements.
        if (!panel.isConnected) {
            document.body.appendChild(panel);
        }

        const shouldShow = site.isPlaybackPage();

        panel.style.display = shouldShow ? 'flex' : 'none';

        // Position can only be measured while visible.
        if (shouldShow && !drag) {
            applyPosition();
        }
    }

    // ==========================================
    // CONTINUOUS PLAYLIST MONITOR
    // ==========================================

    // This is the fallback for sites that reset playback speed or
    // pitch without any event we can catch. It also keeps the panel
    // alive when a single-page app rebuilds its layout.

    setInterval(() => {
        updatePanel();

        if (!site.isPlaybackPage()) return;

        site.scan();

        if (enabled) {
            applyToAll();
        }
    }, site.checkInterval);

    // Recheck immediately upon returning to the tab.
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && enabled) {
            applyToAll();
        }
    });

    // ==========================================
    // INITIALIZATION
    // ==========================================

    site.init();

    updateButton();
    applyMinimized();
    applyPosition();
    updatePanel();

    if (enabled) {
        applyToAll();
    }

    // At document-start there is usually no <body> yet.
    document.addEventListener('DOMContentLoaded', updatePanel);

    console.log(
        `🌙 Nightcore Mode initialized on ${site.name}!`,
        {
            enabled,
            speed,
            minimized: ui.minimized
        }
    );

})();
