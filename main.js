 // ==UserScript==
// @name         Bilibili直播自动刷新+网页全屏
// @namespace    https://github.com/tampermonkey
// @version      6.9
// @description  自动刷新未播放直播、直播开播后自动网页全屏（修复长时间运行后不全屏）
// @author       Tampermonkey用户
// @match        *://live.bilibili.com/*
// @grant        GM_xmlhttpRequest
// @connect      api.live.bilibili.com
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    const DEBUG_LOG = false; // 日志开关：true=开启日志，false=关闭日志

    let liveFullscreenTriggered = false; // 直播全屏触发标志
    let lastVideoElement = null; // 上一个视频元素引用
    let isCheckingLive = false; // 直播状态检查中标志（防止重复检查）
    let consecutiveApiFailures = 0; // API 连续失败计数
    const MAX_API_FAILURES = 6; // 连续失败超过此数后启用 DOM 降级检测
    let consecutiveOfflineCount = 0; // 连续检测到未开播的次数
    const OFFLINE_CONFIRM_THRESHOLD = 3; // 连续 N 次未开播才确认下播（防止 API 抖动）

    // 开播检测
    let wasLive = sessionStorage.getItem('wasLive') === 'true'; // 上次检测是否正在直播
    let hasReloadedForLive = sessionStorage.getItem('hasReloadedForLive') === 'true'; // 本次开播是否已经刷新过页面
    let reloadAttemptTime = 0; // 上次尝试 reload 的时间戳（用于重试）
    const RELOAD_RETRY_INTERVAL = 15000; // reload 重试间隔（15秒）

    // 全屏触发频率检测
    let fullscreenTriggerCount = 0;
    let fullscreenTriggerStartTime = 0;
    const FULLSCREEN_TRIGGER_LIMIT = 4; // 1分钟内最多触发5次
    const FULLSCREEN_TRIGGER_WINDOW = 30000; // 时间窗口：1分钟

    // DOM 元素缓存
    let cachedVideoElement = null; // 缓存的视频元素
    let lastWindowHeight = window.innerHeight; // 缓存窗口高度

    // MutationObserver 实例
    let videoObserver = null;
    let resizeListener = null; // resize 事件监听器引用

    /*** 工具函数 ***/
    // 日志输出函数（受 DEBUG_LOG 开关控制）
    function log(...args) {
        if (DEBUG_LOG) {
            console.log(...args);
        }
    }

    // 从 URL 中解析房间号
    function parseRoomIdFromUrl() {
        const m = location.pathname.match(/^\/(\d+)(?:\/|$)/);
        return m ? Number(m[1]) : null;
    }

    // 获取直播状态（带超时处理）
    function fetchLiveStatus(roomId) {
        return new Promise((resolve) => {
            let timeoutId = null;

            const request = GM_xmlhttpRequest({
                method: "GET",
                url: `https://api.live.bilibili.com/room/v1/Room/room_init?id=${roomId}`,
                onload: (res) => {
                    if (timeoutId) clearTimeout(timeoutId);
                    try {
                        const data = JSON.parse(res.responseText);
                        const isLive = data?.data?.live_status === 1;
                        log('[直播状态检测] API返回:', isLive ? '直播中' : '未开播', '原始数据:', data?.data?.live_status);
                        resolve({ success: true, isLive });
                    } catch (e) {
                        log('[直播状态检测] 解析响应失败:', e.message);
                        resolve({ success: false, isLive: false, error: 'parse_error' });
                    }
                },
                onerror: (err) => {
                    if (timeoutId) clearTimeout(timeoutId);
                    log('[直播状态检测] 请求失败');
                    resolve({ success: false, isLive: false, error: 'network_error' });
                },
                ontimeout: () => {
                    log('[直播状态检测] 请求超时');
                    resolve({ success: false, isLive: false, error: 'timeout' });
                }
            });

            // 5秒超时
            timeoutId = setTimeout(() => {
                try {
                    request.abort();
                } catch (e) {}
                log('[直播状态检测] 强制超时');
                resolve({ success: false, isLive: false, error: 'forced_timeout' });
            }, 5000);
        });
    }

    // 添加全屏样式
    function addFullscreenStyles() {
        // 避免重复添加
        if (document.getElementById('bilibili-fullscreen-styles')) return;

        const style = document.createElement('style');
        style.id = 'bilibili-fullscreen-styles';
        style.textContent = `
            /* 全屏时隐藏侧边栏和其他元素 */
            .hide-aside-area #web-player__bottom-bar__container,
            .hide-aside-area .web-player-icon-roomStatus,
            .hide-aside-area .web-player-icon-feedback,
            .hide-aside-area #aside-area-vm,
            .hide-aside-area .chat-history-panel,
            .hide-aside-area .control-panel-ctnr,
            .hide-aside-area .side-bar-cntr {
                display: none !important;
            }
            /* 播放器占满整个窗口 */
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
            /* 隐藏小黄车提示 */
            #shop-popover-vm {
                display: none !important;
            }
            /* 隐藏礼物控制区 */
            .hide-aside-area #gift-control-vm,
            .hide-aside-area .gift-control-section {
                display: none !important;
            }
        `;
        document.head.appendChild(style);
    }

    // 检查全屏触发频率
    function checkFullscreenTriggerRate() {
        const now = Date.now();

        // 如果时间窗口已过，重置计数器
        if (now - fullscreenTriggerStartTime > FULLSCREEN_TRIGGER_WINDOW) {
            fullscreenTriggerCount = 0;
            fullscreenTriggerStartTime = now;
        }

        fullscreenTriggerCount++;
        log(`[全屏保险] 触发次数: ${fullscreenTriggerCount}/${FULLSCREEN_TRIGGER_LIMIT}`);

        // 如果超过限制，清空缓存并刷新页面
        if (fullscreenTriggerCount >= FULLSCREEN_TRIGGER_LIMIT) {
            log('[全屏保险] 触发过于频繁，清空缓存并刷新页面');
            // 保存开播检测状态
            const savedWasLive = sessionStorage.getItem('wasLive');
            const savedHasReloaded = sessionStorage.getItem('hasReloadedForLive');
            // 清空 sessionStorage 和 localStorage
            sessionStorage.clear();
            localStorage.clear();
            // 恢复开播检测状态
            if (savedWasLive) sessionStorage.setItem('wasLive', savedWasLive);
            if (savedHasReloaded) sessionStorage.setItem('hasReloadedForLive', savedHasReloaded);
            // 强制刷新页面（不使用缓存）
            location.reload(true);
        }
    }

    // 关闭礼物面板
    function closeGiftPopover() {
        // 设置 localStorage 关闭礼物面板
        try {
            localStorage.setItem('FULLSCREEN-GIFT-PANEL-SHOW', '0');
        } catch (e) {}

        // 查找礼物面板并添加隐藏类
        const giftPanel = document.getElementById('gift-control-vm');
        if (giftPanel) {
            giftPanel.classList.add('hide-gift-panel');
            log('[礼物面板] 已隐藏');
        }

        // 同时隐藏 fullscreen-container 中的礼物面板
        const fullscreenContainer = document.getElementById('fullscreen-container');
        if (fullscreenContainer) {
            fullscreenContainer.classList.add('gift-panel-hidden');
        }

        // 隐藏小黄车提示窗口
        const shopPopover = document.getElementById('shop-popover-vm');
        if (shopPopover) {
            shopPopover.style.display = 'none';
            log('[小黄车提示] 已隐藏');
        }
    }

    // 触发直播全屏（使用CSS强制全屏）
    function triggerLiveFullscreen() {
        // 检查触发频率
        checkFullscreenTriggerRate();

        // 防止重复触发
        if (liveFullscreenTriggered) return;

        log('[全屏触发] 使用CSS强制全屏');

        // 添加全屏类，通过CSS强制全屏效果
        document.body.classList.add('hide-aside-area');

        // 同时尝试原生全屏API（视频元素）
        const video = document.querySelector('video');
        if (video && document.fullscreenEnabled) {
            video.requestFullscreen?.().catch((err) => {
                log('[全屏触发] 原生API失败（正常现象）:', err.message);
            });
        }

        liveFullscreenTriggered = true;

        // 关闭礼物面板
        closeGiftPopover();
    }

    /*** 全屏控制模块 ***/
    // 独立的检查并触发全屏的函数（每5秒执行一次）
    function checkAndTriggerFullscreen() {
        // 如果未开播，不执行全屏化
        if (!wasLive) {
            log('[全屏模块] 未开播，跳过全屏检查');
            return;
        }

        const video = getCachedVideo();

        // 如果视频元素不存在，跳过
        if (!video) {
            log('[全屏模块] 视频元素不存在，跳过');
            return;
        }

        // 如果视频元素发生变化，重置标志
        if (video !== lastVideoElement) {
            log('[全屏模块] 视频元素变化，重置全屏标志');
            lastVideoElement = video;
            liveFullscreenTriggered = false;
        }

        // 检查当前是否真的全屏
        const currentlyFullscreen = isFullscreen();

        if (!currentlyFullscreen) {
            log('[全屏模块] 未全屏，触发全屏');
            // 重置标志，允许重新触发全屏
            liveFullscreenTriggered = false;
            triggerFullscreenOnce();
        }
    }

    /*** 核心检测逻辑 ***/
    // 检查直播状态并执行相应操作
    async function checkLive() {
        // 防止重复检查
        if (isCheckingLive) return;
        isCheckingLive = true;

        try {
            const roomId = parseRoomIdFromUrl();
            if (!roomId) {
                log('[checkLive] 无法获取房间号');
                return;
            }

            log('[checkLive] 开始检查直播状态，房间号:', roomId);

            // 获取直播状态
            const result = await fetchLiveStatus(roomId);

            // 如果检测失败（网络错误等），保持当前状态
            if (!result.success) {
                consecutiveApiFailures++;
                log('[checkLive] 直播状态检测失败，保持当前状态:', wasLive ? '直播' : '未开播',
                    `连续失败: ${consecutiveApiFailures}/${MAX_API_FAILURES}`);

                // API 连续失败多次，使用 DOM 降级检测
                if (consecutiveApiFailures >= MAX_API_FAILURES && !wasLive) {
                    const video = document.querySelector('#live-player video');
                    if (video && video.readyState >= 2 && !video.paused) {
                        log('[checkLive] API 持续失败但检测到视频正在播放，视为开播');
                        result.success = true;
                        result.isLive = true;
                    }
                }

                if (!result.success) return;
            } else {
                consecutiveApiFailures = 0;
            }

            const isLive = result.isLive;
            log('[checkLive] 直播状态:', isLive ? '直播中' : '未开播', '之前状态:', wasLive ? '直播' : '未开播');

        // 如果未开播
        if (!isLive) {
            consecutiveOfflineCount++;
            log('[checkLive] 检测到未开播，连续计数:', consecutiveOfflineCount, '/', OFFLINE_CONFIRM_THRESHOLD);

            // 需要连续多次检测到未开播才确认下播（防止 API 抖动导致状态误重置）
            if (consecutiveOfflineCount >= OFFLINE_CONFIRM_THRESHOLD) {
                log('[checkLive] 确认下播，执行下播处理');

                // 重置所有标志
                liveFullscreenTriggered = false;
                lastVideoElement = null;
                hasReloadedForLive = false;
                consecutiveOfflineCount = 0;

                // 移除全屏样式
                document.body.classList.remove('hide-aside-area');

                wasLive = false;
                sessionStorage.setItem('wasLive', 'false');
                sessionStorage.removeItem('hasReloadedForLive');
            }
            return;
        }

        // 直播中，重置下播计数器
        consecutiveOfflineCount = 0;

        // 检测从非直播状态变为直播状态（初次开播）
        if (isLive && !wasLive && !hasReloadedForLive) {
            log('[开播检测] 初次开播，刷新页面');
            wasLive = true;
            hasReloadedForLive = true;
            reloadAttemptTime = Date.now();
            sessionStorage.setItem('hasReloadedForLive', 'true');
            sessionStorage.setItem('wasLive', 'true');
            location.reload();
            return;
        }

        // reload 重试：如果之前尝试过 reload 但页面没有真正刷新
        if (hasReloadedForLive && reloadAttemptTime > 0) {
            const elapsed = Date.now() - reloadAttemptTime;
            if (elapsed > RELOAD_RETRY_INTERVAL) {
                log('[开播检测] reload 似乎未生效，重试');
                reloadAttemptTime = Date.now();
                location.reload();
                return;
            }
        }

        wasLive = isLive;
        sessionStorage.setItem('wasLive', isLive ? 'true' : 'false');

        // 注：全屏逻辑已移到独立的 checkAndTriggerFullscreen 函数中
        } finally {
            isCheckingLive = false;
        }
    }

    // 获取缓存的视频元素（带自动更新）
    function getCachedVideo() {
        if (cachedVideoElement && document.contains(cachedVideoElement)) {
            return cachedVideoElement;
        }
        cachedVideoElement = document.querySelector('#live-player video');
        return cachedVideoElement;
    }

    // 检查是否已全屏（简化版）
    function isFullscreen() {
        // 优先使用浏览器原生全屏API
        if (document.fullscreenElement) {
            return true;
        }

        // 检查 CSS 类（CSS强制全屏模式）
        const hasClass = document.body.classList.contains('hide-aside-area');
        if (hasClass) {
            return true;
        }

        return false;
    }

    // 全屏触发（简化版：只触发一次，不重复检查）
    function triggerFullscreenOnce() {
        const video = getCachedVideo();
        if (!video) return;

        log('[全屏触发] 触发网页全屏');
        triggerLiveFullscreen();
    }

    // 检测视频是否卡顿或断断续续
    let lastCheckTime = Date.now();
    let lastVideoTime = 0;
    let stallCounter = 0;

    function detectVideoStuck() {
        const video = getCachedVideo();
        if (!video || video.paused || video.ended) return;

        const now = Date.now();
        const currentTime = video.currentTime;
        const timeProgress = currentTime - lastVideoTime; // 实际播放进度
        const expectedProgress = (now - lastCheckTime) / 1000; // 应该播放的进度
        const progressRatio = timeProgress / expectedProgress; // 播放比例

        // 检测指标：
        // 1. 完全卡住（时间为0）
        const isStuck = timeProgress === 0;
        // 2. 断断续续（播放比例<50%，说明卡顿严重）
        const isStuttering = progressRatio < 0.5 && progressRatio > 0;
        // 3. 缓冲不足（readyState<3且缓冲落后）
        let bufferAhead = 0;
        if (video.buffered.length > 0) {
            bufferAhead = video.buffered.end(video.buffered.length - 1) - currentTime;
        }
        const bufferLow = video.readyState < 3 && bufferAhead < 2;

        if (isStuck || isStuttering || bufferLow) {
            stallCounter++;
            log(`[卡顿检测] 异常计数 ${stallCounter}/5`,
                isStuck ? '[完全卡住]' : '',
                isStuttering ? '[断断续续]' : '',
                bufferLow ? '[缓冲不足]' : '');

            // 连续5次检测异常，刷新页面
            if (stallCounter >= 5) {
                log('[卡顿检测] 检测到持续卡顿，清理缓存并刷新页面');
                // 保存开播状态（防止 reload 后触发重复刷新）
                const savedWasLive = sessionStorage.getItem('wasLive');
                const savedHasReloaded = sessionStorage.getItem('hasReloadedForLive');
                // 清理缓存
                cachedVideoElement = null;
                sessionStorage.clear();
                // 恢复开播状态
                if (savedWasLive) sessionStorage.setItem('wasLive', savedWasLive);
                if (savedHasReloaded) sessionStorage.setItem('hasReloadedForLive', savedHasReloaded);
                location.reload();
            }
        } else {
            // 正常播放，重置计数器
            if (stallCounter > 0) {
                log('[卡顿检测] 播放恢复正常');
            }
            stallCounter = 0;
        }

        lastCheckTime = now;
        lastVideoTime = currentTime;
    }

    // 主循环计数器
    let mainLoopCounter = 0;
    const LIVE_CHECK_INTERVAL = 10; // 直播状态检查间隔
    const STUCK_CHECK_INTERVAL = 5; // 视频卡顿检测间隔
    const FULLSCREEN_CHECK_INTERVAL = 5; // 全屏状态检查间隔

    // 监听页面可见性变化
    document.addEventListener('visibilitychange', () => {
        // 页面从后台切回前台时，立即检查直播状态
        if (document.visibilityState === 'visible') {
            log('[页面可见性] 从后台恢复，立即检查直播状态');
            checkLive();
        }
    });

    // 合并的主循环函数（每1秒执行一次）
    function mainLoop() {
        mainLoopCounter++;

        // 计数器归零，防止溢出
        if (mainLoopCounter > 2000) {
            mainLoopCounter = 1;
        }

        log(`[主循环] 第 ${mainLoopCounter} 次执行`);

        // 检查直播状态
        if (mainLoopCounter % LIVE_CHECK_INTERVAL === 0) {
            log('[主循环] 触发直播状态检查');
            checkLive();
        }

        // 检查并触发全屏
        if (mainLoopCounter % FULLSCREEN_CHECK_INTERVAL === 0) {
            checkAndTriggerFullscreen();
        }

        // 检查视频卡顿
        if (mainLoopCounter % STUCK_CHECK_INTERVAL === 0) {
            detectVideoStuck();
        }
    }

    // 设置 MutationObserver 监听 DOM 变化
    function setupObservers() {
        // 监听视频元素变化
        const livePlayer = document.getElementById('live-player');
        if (livePlayer && !videoObserver) {
            videoObserver = new MutationObserver((mutations) => {
                // 快速返回：如果缓存的视频元素仍然有效，无需处理
                if (cachedVideoElement && document.contains(cachedVideoElement)) {
                    return;
                }

                // 检查是否有 VIDEO 元素变化
                for (const mutation of mutations) {
                    if (mutation.type !== 'childList') continue;

                    // 检查添加的节点
                    const addedNodes = mutation.addedNodes;
                    for (let i = 0; i < addedNodes.length; i++) {
                        if (addedNodes[i].nodeName === 'VIDEO') {
                            cachedVideoElement = null;
                            log('[DOM观察] 视频元素添加，清除缓存');
                            return; // 发现后立即返回
                        }
                    }

                    // 检查移除的节点
                    const removedNodes = mutation.removedNodes;
                    for (let i = 0; i < removedNodes.length; i++) {
                        if (removedNodes[i].nodeName === 'VIDEO') {
                            cachedVideoElement = null;
                            log('[DOM观察] 视频元素移除，清除缓存');
                            return; // 发现后立即返回
                        }
                    }
                }
            });

            videoObserver.observe(livePlayer, {
                childList: true
                // 移除 subtree: true 以减少性能开销
            });
        }

        // 监听窗口大小变化，清除全屏缓存
        resizeListener = () => {
            lastWindowHeight = window.innerHeight;
        };
        window.addEventListener('resize', resizeListener, { passive: true });

        // 页面卸载时清理资源，防止内存泄漏
        window.addEventListener('beforeunload', () => {
            log('[页面卸载] 清理资源');
            // 断开 MutationObserver
            if (videoObserver) {
                videoObserver.disconnect();
                videoObserver = null;
            }
            // 移除 resize 监听器
            if (resizeListener) {
                window.removeEventListener('resize', resizeListener);
                resizeListener = null;
            }
            // 停止主循环定时器
            if (mainLoopTimer) {
                clearInterval(mainLoopTimer);
                mainLoopTimer = null;
            }
            // 清除缓存的 DOM 元素引用
            cachedVideoElement = null;
            lastVideoElement = null;
        });
    }

    /*** 主入口 ***/
    // 主循环定时器引用（用于可能的清理）
    let mainLoopTimer = null;

    /*** 主入口 ***/
    function initScript() {
        log('[Bilibili自动刷新] v6.7-optimized 启动');

        // 添加全屏样式
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                addFullscreenStyles();
                setupObservers();
            });
        } else {
            addFullscreenStyles();
            setupObservers();
        }

        // 使用单一主循环替代多个 setInterval
        mainLoopTimer = setInterval(mainLoop, 1000); // 每1秒执行一次
    }

    //  启动脚本
    initScript();
})();
