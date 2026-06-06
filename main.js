// ==UserScript==
// @name         Bilibili直播全屏+画质优化
// @namespace    https://github.com/tampermonkey
// @version      8.3.1
// @description  自动检测直播状态、开播后自动网页全屏、自动选择最高直播画质并保持、卡顿时自动刷新播放器
// @author       Tampermonkey用户
// @match        *://live.bilibili.com/*
// @grant        unsafeWindow
// @license      MIT
// @updateURL    https://github.com/4thHydrogen/OBS-bilibiliLive-Controller/blob/main/main.js
// @downloadURL  https://github.com/4thHydrogen/OBS-bilibiliLive-Controller/blob/main/main.js
// ==/UserScript==

(function autoHighestLiveQualityLikeDD1969() {
    'use strict';

    const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const QUALITY_DEBUG_LOG = false;
    const QUALITY_SWITCH_COOLDOWN_MS = 3000;
    let lastQualitySwitchAt = 0;

    function qualityDebug(...args) {
        if (!QUALITY_DEBUG_LOG) return;
        console.info('[BiliLiveQuality]', ...args);
    }

    function updateQualityDebugState(patch) {
        const previous = window.__biliLiveQualityDebug || {};
        const nextState = {
            ...previous,
            ...patch,
            updatedAt: new Date().toISOString()
        };
        window.__biliLiveQualityDebug = nextState;
        try {
            pageWindow.__biliLiveQualityDebug = nextState;
        } catch (error) {}
    }

    function getPlayerInfoSafely() {
        try {
            if (!pageWindow.livePlayer || !pageWindow.livePlayer.getPlayerInfo) return null;
            return pageWindow.livePlayer.getPlayerInfo();
        } catch (error) {
            updateQualityDebugState({ ready: false, lastError: error?.message || String(error) });
            return null;
        }
    }

    (async function () {
        await new Promise(resolve => {
            const timer = setInterval(() => {
                const playerInfo = getPlayerInfoSafely();
                if (
                    pageWindow.livePlayer &&
                    pageWindow.livePlayer.getPlayerInfo &&
                    playerInfo?.playurl &&
                    Array.isArray(playerInfo.qualityCandidates) &&
                    playerInfo.qualityCandidates[0] &&
                    pageWindow.livePlayer.switchQuality
                ) {
                    clearInterval(timer);
                    resolve();
                }
            }, 1000);
        });

        const initialPlayerInfo = getPlayerInfoSafely();
        if (!initialPlayerInfo?.playurl || !initialPlayerInfo.qualityCandidates?.[0]) return;

        const initialPathname = new URL(initialPlayerInfo.playurl).pathname;
        const highestQualityNumber = initialPlayerInfo.qualityCandidates[0].qn;
        const highestQualityLabel = initialPlayerInfo.qualityCandidates[0].desc || String(highestQualityNumber);

        setInterval(() => {
            const playerInfo = getPlayerInfoSafely();
            if (!playerInfo?.playurl) {
                updateQualityDebugState({ ready: false, playurlReady: false });
                return;
            }

            let currentPathname;
            try {
                currentPathname = new URL(playerInfo.playurl).pathname;
            } catch (error) {
                updateQualityDebugState({ ready: false, lastError: error?.message || String(error) });
                return;
            }

            const currentQualityNumber = playerInfo.quality;
            const shouldSwitch = currentPathname === initialPathname || currentQualityNumber !== highestQualityNumber;
            const now = Date.now();
            const skippedByCooldown = shouldSwitch && now - lastQualitySwitchAt < QUALITY_SWITCH_COOLDOWN_MS;
            updateQualityDebugState({
                ready: true,
                initialPathname,
                currentPathname,
                currentQn: currentQualityNumber,
                targetQn: highestQualityNumber,
                targetQualityLabel: highestQualityLabel,
                shouldSwitch,
                skippedByCooldown,
                lastSwitchAt: lastQualitySwitchAt || null
            });
            if (shouldSwitch && !skippedByCooldown) {
                qualityDebug('switchQuality invoked', {
                    currentPathname,
                    initialPathname,
                    currentQualityNumber,
                    highestQualityNumber
                });
                try {
                    pageWindow.livePlayer.switchQuality(highestQualityNumber);
                    lastQualitySwitchAt = now;
                } catch (error) {
                    updateQualityDebugState({ lastError: error?.message || String(error) });
                }
            }
        }, 1000);
    })();
})();

(function maximizerAndRefreshLogic() {
    'use strict';

    const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const DEBUG_LOG = false;

    // 开播状态
    let wasLive = sessionStorage.getItem('wasLive') === 'true';
    let hasReloadedForLive = sessionStorage.getItem('hasReloadedForLive') === 'true';

    // 全屏控制
    let liveFullscreenTriggered = false;
    let lastVideoElement = null;
    let fullscreenTriggerCount = 0;
    let fullscreenTriggerStartTime = 0;
    const FULLSCREEN_TRIGGER_LIMIT = 4;
    const FULLSCREEN_TRIGGER_WINDOW = 30000;

    // 检测容错
    let isCheckingLive = false;
    let consecutiveApiFailures = 0;
    let consecutiveOfflineCount = 0;
    const MAX_API_FAILURES = 6;
    const OFFLINE_CONFIRM_THRESHOLD = 3;

    // DOM 缓存
    let cachedVideoElement = null;
    let videoObserver = null;
    let mainLoopTimer = null;
    let noVideoRecoveryCount = 0;

    const NO_VIDEO_REFRESH_THRESHOLD = 3;
    const VISIBILITY_PROPS = ['visibilityState', 'hidden', 'webkitVisibilityState', 'webkitHidden'];
    let originalVisibilityDescriptors = null;

    function log(...args) {
        if (DEBUG_LOG) console.log(...args);
    }

    function applyVisibilityHijack(enable) {
        try {
            const proto = pageWindow.Document.prototype;
            if (enable) {
                if (!originalVisibilityDescriptors) {
                    originalVisibilityDescriptors = {};
                    for (const prop of VISIBILITY_PROPS) {
                        originalVisibilityDescriptors[prop] = Object.getOwnPropertyDescriptor(proto, prop);
                    }
                }
                const visibleDesc = { configurable: true, enumerable: true, get: () => 'visible' };
                const hiddenDesc = { configurable: true, enumerable: true, get: () => false };
                Object.defineProperty(proto, 'visibilityState', visibleDesc);
                Object.defineProperty(proto, 'hidden', hiddenDesc);
                Object.defineProperty(proto, 'webkitVisibilityState', visibleDesc);
                Object.defineProperty(proto, 'webkitHidden', hiddenDesc);
            } else if (originalVisibilityDescriptors) {
                for (const prop of VISIBILITY_PROPS) {
                    if (originalVisibilityDescriptors[prop]) {
                        Object.defineProperty(proto, prop, originalVisibilityDescriptors[prop]);
                    } else {
                        delete proto[prop];
                    }
                }
            }
        } catch (error) {
            log('[画质守护] 可见性劫持失败:', error.message);
        }
    }

    function parseRoomIdFromUrl() {
        const match = location.pathname.match(/^\/(\d+)(?:\/|$)/);
        return match ? Number(match[1]) : null;
    }

    function fetchLiveStatus(roomId) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        return fetch(`https://api.live.bilibili.com/room/v1/Room/room_init?id=${roomId}`, { signal: controller.signal })
            .then(res => {
                clearTimeout(timeoutId);
                return res.json();
            })
            .then(data => {
                const isLive = data?.data?.live_status === 1;
                log('[直播状态] API返回:', isLive ? '直播中' : '未开播');
                return { success: true, isLive };
            })
            .catch(error => {
                clearTimeout(timeoutId);
                log('[直播状态] 请求失败:', error.message);
                return { success: false, isLive: false };
            });
    }

    function addFullscreenStyles() {
        if (document.getElementById('bili-live-maximizer-style')) return;
        const style = document.createElement('style');
        style.id = 'bili-live-maximizer-style';
        style.textContent = `
            body.hide-aside-area {
                overflow: hidden !important;
            }
            .hide-aside-area .web-player-loading {
                opacity: 0 !important;
            }
            .hide-aside-area #head-info-vm,
            .hide-aside-area #sections-vm,
            .hide-aside-area #activity-vm,
            .hide-aside-area #rank-list-vm,
            .hide-aside-area #web-player__bottom-bar__container,
            .hide-aside-area .web-player-icon-roomStatus,
            .hide-aside-area .web-player-icon-feedback,
            .hide-aside-area #aside-area-vm,
            .hide-aside-area .chat-history-panel,
            .hide-aside-area .control-panel-ctnr,
            .hide-aside-area .side-bar-cntr,
            .hide-aside-area .side-bar-popup-cntr,
            .hide-aside-area #gift-control-vm,
            .hide-aside-area .gift-control-section,
            .hide-aside-area .link-navbar-ctnr {
                display: none !important;
            }
            .hide-aside-area #player-ctnr,
            .hide-aside-area #live-player,
            .hide-aside-area .live-player-ctnr,
            .hide-aside-area .fullscreen-container-paddingbox,
            .hide-aside-area #fullscreen-container {
                width: 100vw !important;
                height: 100vh !important;
                position: fixed !important;
                top: 0 !important;
                left: 0 !important;
                z-index: 2147483647 !important;
            }
            #shop-popover-vm { display: none !important; }
        `;
        document.head.appendChild(style);
    }

    function isFullscreen() {
        return !!document.fullscreenElement || document.body.classList.contains('hide-aside-area');
    }

    function enterFullscreen() {
        if (liveFullscreenTriggered || isFullscreen()) return;

        const now = Date.now();
        if (now - fullscreenTriggerStartTime > FULLSCREEN_TRIGGER_WINDOW) {
            fullscreenTriggerCount = 0;
            fullscreenTriggerStartTime = now;
        }
        fullscreenTriggerCount++;
        if (fullscreenTriggerCount >= FULLSCREEN_TRIGGER_LIMIT) {
            log('[全屏保险] 触发过频，清缓存刷新');
            const sw = sessionStorage.getItem('wasLive');
            const sh = sessionStorage.getItem('hasReloadedForLive');
            sessionStorage.clear();
            localStorage.clear();
            if (sw) sessionStorage.setItem('wasLive', sw);
            if (sh) sessionStorage.setItem('hasReloadedForLive', sh);
            location.reload();
            return;
        }

        log('[全屏] CSS 强制全屏');
        document.body.classList.add('hide-aside-area');
        liveFullscreenTriggered = true;
        try {
            localStorage.setItem('FULLSCREEN-GIFT-PANEL-SHOW', '0');
        } catch (error) {}
        const shop = document.getElementById('shop-popover-vm');
        if (shop) shop.style.display = 'none';
    }

    function exitFullscreen() {
        liveFullscreenTriggered = false;
        lastVideoElement = null;
        document.body.classList.remove('hide-aside-area');
    }

    function getCachedVideo() {
        if (cachedVideoElement && document.contains(cachedVideoElement)) return cachedVideoElement;
        cachedVideoElement = document.querySelector('#live-player video');
        return cachedVideoElement;
    }

    function isVideoPlaying() {
        const video = getCachedVideo();
        return !!(video && !video.paused && !video.ended && video.readyState >= 2);
    }

    function getLivePlayer() {
        return pageWindow.livePlayer || null;
    }

    function tryFullscreen() {
        if (!wasLive) return;
        const video = getCachedVideo();
        if (!video) return;
        if (video !== lastVideoElement) {
            lastVideoElement = video;
            liveFullscreenTriggered = false;
        }
        enterFullscreen();
    }

    async function checkLive() {
        if (isCheckingLive) return;
        isCheckingLive = true;
        try {
            const roomId = parseRoomIdFromUrl();
            if (!roomId) return;

            const result = await fetchLiveStatus(roomId);
            if (!result.success) {
                consecutiveApiFailures++;
                log('[checkLive] 失败', consecutiveApiFailures, '/', MAX_API_FAILURES);
                if (consecutiveApiFailures >= MAX_API_FAILURES && !wasLive) {
                    const video = document.querySelector('#live-player video');
                    if (video && video.readyState >= 2 && !video.paused) {
                        log('[checkLive] DOM 降级检测到视频播放，视为开播');
                        result.success = true;
                        result.isLive = true;
                        consecutiveApiFailures = 0;
                    }
                }
                if (!result.success) return;
            } else {
                consecutiveApiFailures = 0;
            }

            const isLive = result.isLive;
            log('[checkLive]', isLive ? '直播中' : '未开播', '之前:', wasLive ? '直播' : '未开播');

            if (!isLive) {
                consecutiveOfflineCount++;
                if (consecutiveOfflineCount >= OFFLINE_CONFIRM_THRESHOLD) {
                    log('[checkLive] 确认下播');
                    exitFullscreen();
                    wasLive = false;
                    hasReloadedForLive = false;
                    consecutiveOfflineCount = 0;
                    sessionStorage.setItem('wasLive', 'false');
                    sessionStorage.removeItem('hasReloadedForLive');
                }
                return;
            }

            consecutiveOfflineCount = 0;
            const isStandardPlayer = !!document.getElementById('live-player');

            if (!wasLive && !hasReloadedForLive) {
                wasLive = true;
                hasReloadedForLive = true;
                sessionStorage.setItem('wasLive', 'true');
                sessionStorage.setItem('hasReloadedForLive', 'true');

                if (!isStandardPlayer) {
                    log('[checkLive] 非标准播放器页面，直接进入全屏');
                    enterFullscreen();
                    return;
                }

                if (isVideoPlaying()) {
                    log('[checkLive] 视频已在播放，直接进入全屏');
                    noVideoRecoveryCount = 0;
                    tryFullscreen();
                    return;
                }

                log('[checkLive] 初次开播但视频仍在初始化，等待播放器就绪');
            }

            wasLive = true;
            sessionStorage.setItem('wasLive', 'true');

            if (isStandardPlayer && !isVideoPlaying()) {
                noVideoRecoveryCount++;
                log('[视频状态] 开播但无画面，等待恢复:', noVideoRecoveryCount);
                cachedVideoElement = null;
                if (noVideoRecoveryCount >= NO_VIDEO_REFRESH_THRESHOLD) {
                    refreshPlayer();
                    noVideoRecoveryCount = 0;
                }
                return;
            }

            noVideoRecoveryCount = 0;
            if (isStandardPlayer) {
                tryFullscreen();
            } else {
                enterFullscreen();
            }
        } finally {
            isCheckingLive = false;
        }
    }

    let isRefreshing = false;

    function refreshPlayer() {
        if (isRefreshing) return;
        isRefreshing = true;
        log('[播放器刷新] 尝试刷新播放器');

        const player = getLivePlayer();
        if (player && typeof player.refresh === 'function') {
            log('[播放器刷新] 使用 livePlayer.refresh()');
            player.refresh();
        } else if (player && typeof player.reload === 'function') {
            log('[播放器刷新] 使用 livePlayer.reload()');
            player.reload();
        } else {
            log('[播放器刷新] livePlayer 不可用，整页刷新');
            cachedVideoElement = null;
            location.reload();
        }

        isRefreshing = false;
    }

    let lastCheckTime = Date.now();
    let lastVideoTime = 0;
    let stallCounter = 0;

    function detectVideoStuck() {
        const video = getCachedVideo();
        if (!video || video.paused || video.ended) return;

        const now = Date.now();
        const currentTime = video.currentTime;
        const progress = currentTime - lastVideoTime;
        const expected = (now - lastCheckTime) / 1000;
        const ratio = progress / expected;

        if (progress === 0 || (ratio < 0.2 && ratio > 0)) {
            stallCounter++;
            log('[卡顿] 异常', stallCounter, '/5');
            if (stallCounter >= 1) {
                log('[卡顿] 持续卡顿，尝试刷新播放器');
                cachedVideoElement = null;
                refreshPlayer();
                stallCounter = 0;
                lastCheckTime = Date.now();
                lastVideoTime = 0;
            }
        } else {
            stallCounter = 0;
        }

        lastCheckTime = now;
        lastVideoTime = currentTime;
    }

    let mainLoopCounter = 0;

    function mainLoop() {
        mainLoopCounter++;
        if (mainLoopCounter > 2000) mainLoopCounter = 1;
        if (DEBUG_LOG && mainLoopCounter % 10 === 0) log('[主循环]', mainLoopCounter);

        if (mainLoopCounter % 10 === 0) checkLive();
        if (mainLoopCounter % 5 === 0) tryFullscreen();
        if (mainLoopCounter % 2 === 0 && wasLive) detectVideoStuck();
    }

    function setupObservers() {
        const livePlayer = document.getElementById('live-player');
        if (livePlayer && !videoObserver) {
            videoObserver = new MutationObserver((mutations) => {
                if (cachedVideoElement && document.contains(cachedVideoElement)) return;
                for (const mutation of mutations) {
                    if (mutation.type !== 'childList') continue;
                    for (const nodes of [mutation.addedNodes, mutation.removedNodes]) {
                        for (let i = 0; i < nodes.length; i++) {
                            if (nodes[i].nodeName === 'VIDEO') {
                                cachedVideoElement = null;
                                return;
                            }
                        }
                    }
                }
            });
            videoObserver.observe(livePlayer, { childList: true });
        }

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                log('[可见性] 恢复，立即检查');
                checkLive();
            }
        });

        window.addEventListener('beforeunload', () => {
            if (videoObserver) videoObserver.disconnect();
            if (mainLoopTimer) clearInterval(mainLoopTimer);
        });
    }

    function initScript() {
        log('[脚本] v8.3 启动');
        applyVisibilityHijack(true);

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                addFullscreenStyles();
                setupObservers();
            });
        } else {
            addFullscreenStyles();
            setupObservers();
        }

        setTimeout(checkLive, 1000);
        mainLoopTimer = setInterval(mainLoop, 1000);
    }

    initScript();
})();
