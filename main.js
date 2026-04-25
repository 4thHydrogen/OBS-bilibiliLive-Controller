 // ==UserScript==
// @name         Bilibili直播自动刷新+网页全屏
// @namespace    https://github.com/tampermonkey
// @version      7.3
// @description  自动刷新未播放直播、直播开播后自动网页全屏、卡顿自动刷新播放器
// @author       Tampermonkey用户
// @match        *://live.bilibili.com/*
// @inject-into  page
// @grant        none
// @license      MIT
// @updateURL    https://github.com/4thHydrogen/OBS-bilibiliLive-Controller/blob/main/main.js
// @downloadURL  https://github.com/4thHydrogen/OBS-bilibiliLive-Controller/blob/main/main.js
// ==/UserScript==

(function () {
    'use strict';

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

    function log(...args) {
        if (DEBUG_LOG) console.log(...args);
    }

    function parseRoomIdFromUrl() {
        const m = location.pathname.match(/^\/(\d+)(?:\/|$)/);
        return m ? Number(m[1]) : null;
    }

    function fetchLiveStatus(roomId) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        return fetch(`https://api.live.bilibili.com/room/v1/Room/room_init?id=${roomId}`, { signal: controller.signal })
            .then(res => { clearTimeout(timeoutId); return res.json(); })
            .then(data => {
                const isLive = data?.data?.live_status === 1;
                log('[直播状态] API返回:', isLive ? '直播中' : '未开播');
                return { success: true, isLive };
            })
            .catch(e => {
                clearTimeout(timeoutId);
                log('[直播状态] 请求失败:', e.message);
                return { success: false, isLive: false };
            });
    }

    // CSS 全屏样式
    function addFullscreenStyles() {
        if (document.getElementById('bilibili-fullscreen-styles')) return;
        const style = document.createElement('style');
        style.id = 'bilibili-fullscreen-styles';
        style.textContent = `
            .hide-aside-area {
                overflow: hidden !important;
            }
            .hide-aside-area #web-player__bottom-bar__container,
            .hide-aside-area .web-player-icon-roomStatus,
            .hide-aside-area .web-player-icon-feedback,
            .hide-aside-area #aside-area-vm,
            .hide-aside-area .chat-history-panel,
            .hide-aside-area .control-panel-ctnr,
            .hide-aside-area .side-bar-cntr,
            .hide-aside-area .side-bar-popup-cntr,
            .hide-aside-area #gift-control-vm,
            .hide-aside-area .gift-control-section {
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
                z-index: 9999 !important;
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
        // 全屏频率保险
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
        // 关闭礼物面板
        try { localStorage.setItem('FULLSCREEN-GIFT-PANEL-SHOW', '0'); } catch (e) {}
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
        return video && !video.paused && video.readyState >= 2 && video.currentTime > 0;
    }

    // 尝试全屏（直播中时调用）
    function tryFullscreen() {
        if (!wasLive) return;
        const video = getCachedVideo();
        if (!video) return;
        // 视频元素变化时重置
        if (video !== lastVideoElement) {
            lastVideoElement = video;
            liveFullscreenTriggered = false;
        }
        enterFullscreen();
    }

    // 核心检测
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
                // API 连续失败时用 DOM 降级检测
                if (consecutiveApiFailures >= MAX_API_FAILURES && !wasLive) {
                    const v = document.querySelector('#live-player video');
                    if (v && v.readyState >= 2 && !v.paused) {
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

            // 初次开播 → 刷新页面
            if (!wasLive && !hasReloadedForLive) {
                log('[checkLive] 初次开播，刷新');
                wasLive = true;
                hasReloadedForLive = true;
                sessionStorage.setItem('wasLive', 'true');
                sessionStorage.setItem('hasReloadedForLive', 'true');
                location.reload();
                return;
            }

            wasLive = true;
            sessionStorage.setItem('wasLive', 'true');

            // 开播但无画面则刷新
            if (!isVideoPlaying()) {
                log('[视频状态] 开播但无画面，刷新');
                cachedVideoElement = null;
                location.reload();
                return;
            }

            // 立即尝试全屏
            tryFullscreen();
        } finally {
            isCheckingLive = false;
        }
    }

    // 播放器刷新功能 - 使用官方刷新按钮而非整页刷新
    function refreshPlayer() {
        log('[播放器刷新] 尝试使用官方刷新按钮');

        const livePlayer = document.getElementById('live-player');
        if (!livePlayer) {
            log('[播放器刷新] 未找到播放器容器');
            return false;
        }

        // 步骤1：触发鼠标移动事件显示控制栏
        const rect = livePlayer.getBoundingClientRect();
        const mouseMoveEvent = new MouseEvent('mousemove', {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: rect.width / 2,
            clientY: rect.height - 30
        });
        livePlayer.dispatchEvent(mouseMoveEvent);

        // 步骤2：等待控制栏渲染后点击刷新按钮
        setTimeout(() => {
            const leftArea = document.querySelector('.left-area');
            if (!leftArea) {
                log('[播放器刷新] 未找到控制栏');
                return false;
            }

            const icons = leftArea.querySelectorAll('.icon');
            log('[播放器刷新] 找到', icons.length, '个控制按钮');

            // 刷新按钮是第2个icon（索引1）
            if (icons.length >= 2) {
                const reloadBtn = icons[1];
                log('[播放器刷新] 点击刷新按钮');
                reloadBtn.click();
                return true;
            } else {
                log('[播放器刷新] 未找到刷新按钮');
                return false;
            }
        }, 100);

        return true;
    }

    // 卡顿检测
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

        let bufferAhead = 0;
        if (video.buffered.length > 0) {
            bufferAhead = video.buffered.end(video.buffered.length - 1) - currentTime;
        }

        if (progress === 0 || (ratio < 0.5 && ratio > 0) || (video.readyState < 3 && bufferAhead < 2)) {
            stallCounter++;
            log('[卡顿] 异常', stallCounter, '/5');
            if (stallCounter >= 1) {
                log('[卡顿] 持续卡顿，尝试刷新播放器');
                cachedVideoElement = null;

                // 使用官方刷新按钮刷新播放器
                refreshPlayer();

                // 重置卡顿计数器
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

    // 主循环
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
                for (const m of mutations) {
                    if (m.type !== 'childList') continue;
                    for (const nodes of [m.addedNodes, m.removedNodes]) {
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
        log('[脚本] v7.1 启动');

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => { addFullscreenStyles(); setupObservers(); });
        } else {
            addFullscreenStyles();
            setupObservers();
        }

        // 页面加载后立即检查直播状态
        setTimeout(checkLive, 1000);
        mainLoopTimer = setInterval(mainLoop, 1000);
    }

    initScript();
})();
