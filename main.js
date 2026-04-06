// ==UserScript==
// @name         Bilibili直播自动刷新+网页全屏+OBS控制
// @namespace    https://github.com/tampermonkey
// @version      6.7
// @description  自动刷新未播放直播、直播开播后自动网页全屏，OBS自动控制录制（修复长时间运行后不全屏）
// @author       Tampermonkey用户
// @match        *://live.bilibili.com/*
// @grant        GM_xmlhttpRequest
// @connect      api.live.bilibili.com
// @connect      127.0.0.1
// @connect      localhost
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    const CHECK_INTERVAL = 10000; // 检查间隔时间（毫秒）
    const OBS_PORT = 4455; // OBS WebSocket 端口
    const OBS_PASSWORD = '123123'; // OBS WebSocket 密码
    const DEBUG_LOG = false; // 日志开关：true=开启日志，false=关闭日志

    let liveFullscreenTriggered = false; // 直播全屏触发标志
    let lastVideoElement = null; // 上一个视频元素引用

    let obsController = null; // OBS 控制器实例
    let isObsConnected = false; // OBS 连接状态标志
    let isCheckingObs = false; // OBS 检查中标志（防止重复检查）
    let isCheckingLive = false; // 直播状态检查中标志（防止重复检查）

    // 开播检测
    let wasLive = sessionStorage.getItem('wasLive') === 'true'; // 上次检测是否正在直播
    let hasReloadedForLive = sessionStorage.getItem('hasReloadedForLive') === 'true'; // 本次开播是否已经刷新过页面

    // 全屏触发频率检测
    let fullscreenTriggerCount = 0;
    let fullscreenTriggerStartTime = 0;
    const FULLSCREEN_TRIGGER_LIMIT = 4; // 1分钟内最多触发5次
    const FULLSCREEN_TRIGGER_WINDOW = 30000; // 时间窗口：1分钟

    // DOM 元素缓存
    let cachedVideoElement = null; // 缓存的视频元素
    let cachedPlayerElement = null; // 缓存的播放器元素
    let lastWindowHeight = window.innerHeight; // 缓存窗口高度

    // MutationObserver 实例
    let videoObserver = null;
    let playerObserver = null;
    let resizeListener = null; // resize 事件监听器引用

    /*** OBS 控制器类（保持原样） ***/
    class OBSController {
        constructor() {
            this.ws = null; // WebSocket 连接对象
            this.authenticated = false; // 认证状态
            this.messageId = 1; // 消息ID计数器
            this.pendingRequests = new Map(); // 待处理请求映射表
            this.reconnectAttempts = 0; // 重连尝试次数
            this.maxReconnectAttempts = 1; // 最大重连尝试次数
            this.reconnectInterval = 3000; // 重连间隔时间（毫秒）
            this.authSalt = null; // 认证盐值
            this.authChallenge = null; // 认证挑战值
            this.reconnectTimer = null; // 重连定时器ID
        }

        async connect(port = OBS_PORT, password = OBS_PASSWORD) { // 连接到 OBS WebSocket
            return new Promise((resolve, reject) => {
                // 如果已经连接，直接返回成功
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    resolve(true);
                    return;
                }

                this.ws = new WebSocket(`ws://127.0.0.1:${port}`); // 创建新的 WebSocket 连接

                const timeout = setTimeout(() => { // 设置连接超时（3秒）
                    this.ws.close();
                    reject(new Error('连接超时（3秒）'));
                }, 3000);

                // 连接打开事件处理
                this.ws.onopen = () => {
                    clearTimeout(timeout);
                    this.reconnectAttempts = 0;
                };

                // 消息接收事件处理
                this.ws.onmessage = async (event) => {
                    try {
                        const message = JSON.parse(event.data);

                        // 处理 Hello 消息（op: 0）
                        if (message.op === 0) {
                            // 如果需要认证，保存盐值和挑战值
                            if (message.d.authentication) {
                                this.authSalt = message.d.authentication.salt;
                                this.authChallenge = message.d.authentication.challenge;
                            }

                            // 构建识别消息
                            const identifyMsg = {
                                op: 1,
                                d: {
                                    rpcVersion: 1,
                                    eventSubscriptions: (1 << 0) | (1 << 1)
                                }
                            };

                            // 如果需要认证，计算认证响应
                            if (password && this.authSalt && this.authChallenge) {
                                try {
                                    const authResponse = await this.calculateAuthResponse(password);
                                    identifyMsg.d.authentication = authResponse;
                                } catch (error) {
                                    reject(new Error(`认证计算失败`));
                                    return;
                                }
                            }

                            this.ws.send(JSON.stringify(identifyMsg)); // 发送识别消息
                        }
                        // 处理识别成功消息（op: 2）
                        else if (message.op === 2) {
                            this.authenticated = true;
                            clearTimeout(timeout);
                            resolve(true);
                        }
                        // 处理请求响应（op: 7）
                        else if (message.op === 7) {
                            this.handleRequestResponse(message.d);
                        }

                    } catch (error) {
                        log('[OBS] 消息处理错误:', error.message);
                    }
                };

                // 连接错误事件处理
                this.ws.onerror = () => {
                    clearTimeout(timeout);
                    this.handleReconnect(port, password, reject);
                };

                // 连接关闭事件处理
                this.ws.onclose = () => {
                    clearTimeout(timeout);
                    if (!this.authenticated) {
                        this.handleReconnect(port, password, reject);
                    }
                };
            });
        }

        // 计算 OBS 认证响应
        async calculateAuthResponse(password) {
            const encoder = new TextEncoder();
            // 计算密钥哈希：密码 + 盐值
            const secretData = encoder.encode(password + this.authSalt);
            const secretHash = await crypto.subtle.digest('SHA-256', secretData);
            const secretBase64 = btoa(String.fromCharCode(...new Uint8Array(secretHash)));

            // 计算认证哈希：密钥 + 挑战值
            const authData = encoder.encode(secretBase64 + this.authChallenge);
            const authHash = await crypto.subtle.digest('SHA-256', authData);
            return btoa(String.fromCharCode(...new Uint8Array(authHash)));
        }

        // 处理重连逻辑
        handleReconnect(port, password, reject) {
            // 清理之前的重连定时器
            if (this.reconnectTimer) {
                clearTimeout(this.reconnectTimer);
                this.reconnectTimer = null;
            }

            if (this.reconnectAttempts < this.maxReconnectAttempts) {
                this.reconnectAttempts++;
                this.reconnectTimer = setTimeout(() => {
                    this.reconnectTimer = null;
                    this.connect(port, password).catch(reject);
                }, this.reconnectInterval);
            } else {
                reject(new Error(`连接失败`));
            }
        }

        // 发送请求到 OBS
        async sendRequest(requestType, data = {}) {
            return new Promise((resolve, reject) => {
                if (!this.authenticated || !this.ws || this.ws.readyState !== WebSocket.OPEN) { // 检查连接状态
                    reject(new Error('WebSocket未连接或未认证'));
                    return;
                }

                // 生成消息ID
                const messageId = this.messageId++;
                // 构建请求消息
                const message = {
                    op: 6,
                    d: {
                        requestType,
                        requestId: messageId.toString(),
                        ...data
                    }
                };

                // 保存待处理请求
                this.pendingRequests.set(messageId, { resolve, reject });

                // 设置请求超时（3秒）
                const timeout = setTimeout(() => {
                    this.pendingRequests.delete(messageId);
                    reject(new Error('请求超时'));
                }, 3000);

                this.pendingRequests.get(messageId).timeout = timeout;
                // 发送请求
                this.ws.send(JSON.stringify(message));
            });
        }

        // 处理 OBS 响应
        handleRequestResponse(response) {
            const requestId = parseInt(response.requestId);
            const pending = this.pendingRequests.get(requestId);

            if (pending) {
                clearTimeout(pending.timeout);
                this.pendingRequests.delete(requestId);

                // 根据请求状态决定 resolve 还是 reject
                if (response.requestStatus.result) {
                    pending.resolve(response.responseData || response.requestStatus.responseData);
                } else {
                    pending.reject(new Error(response.requestStatus.comment || '请求失败'));
                }
            }
        }

        // 获取 OBS 录制状态
        async getRecordStatus() {
            try {
                const response = await this.sendRequest('GetRecordStatus');
                const isRecording = response.outputActive === true;

                return { outputActive: isRecording };
            } catch (error) {
                throw error;
            }
        }

        // 停止 OBS 录制
        async stopRecording() {
            return await this.sendRequest('StopRecord');
        }

        // 关闭 OBS 连接
        close() {
            if (this.ws) {
                // 清理所有事件监听器，防止内存泄漏
                this.ws.onopen = null;
                this.ws.onmessage = null;
                this.ws.onerror = null;
                this.ws.onclose = null;
                this.ws.close();
                this.ws = null;
            }
            // 清理重连定时器
            if (this.reconnectTimer) {
                clearTimeout(this.reconnectTimer);
                this.reconnectTimer = null;
            }
            this.authenticated = false;
            this.pendingRequests.clear();
            this.authSalt = null;
            this.authChallenge = null;
        }
    }

    // 检查并控制 OBS 录制状态
    async function checkAndControlOBS() {
        // 防止重复检查
        if (isCheckingObs) return;
        isCheckingObs = true;

        try {
            // 如果未连接，尝试连接
            if (!isObsConnected || !obsController) {
                // 确保关闭旧实例再创建新实例
                if (obsController) {
                    obsController.close();
                }
                obsController = new OBSController();
                try {
                    await obsController.connect();
                    isObsConnected = true;
                } catch (error) {
                    isObsConnected = false;
                    isCheckingObs = false;
                    return;
                }
            }

            try {
                // 获取录制状态
                const status = await obsController.getRecordStatus();
                // 如果正在录制，则停止录制
                if (status.outputActive) {
                    await obsController.stopRecording();
                }
            } catch (error) {
                log('[OBS] 停止录制失败:', error.message);
            }

        } catch (error) {
            // 发生错误时关闭连接
            if (obsController) obsController.close();
            isObsConnected = false;
            obsController = null;
        } finally {
            isCheckingObs = false;
        }
    }

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

    // 获取直播状态
    function fetchLiveStatus(roomId) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: "GET",
                url: `https://api.live.bilibili.com/room/v1/Room/room_init?id=${roomId}`,
                onload: (res) => {
                    try {
                        const data = JSON.parse(res.responseText);
                        // live_status 为 1 表示正在直播
                        resolve(data?.data?.live_status === 1);
                    } catch {
                        resolve(false);
                    }
                },
                onerror: () => resolve(false),
            });
        });
    }

    // 触发双击事件
    function triggerDoubleClick(el) {
        try {
            el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
        } catch (err) {
            log('[双击事件] 触发失败:', err.message);
        }
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
            if (!roomId) return;

            // 获取直播状态
            const isLive = await fetchLiveStatus(roomId);

        // 如果未开播
        if (!isLive) {
            // 重置所有标志
            liveFullscreenTriggered = false;
            lastVideoElement = null;
            hasReloadedForLive = false; // 重置开播刷新标志

            // 移除全屏样式
            document.body.classList.remove('hide-aside-area');

            // 停止 OBS 录制
            await checkAndControlOBS();

            wasLive = false;
            sessionStorage.setItem('wasLive', 'false');
            sessionStorage.removeItem('hasReloadedForLive'); // 清除已刷新标志，下次开播可再次触发
            return;
        }

        // 检测从非直播状态变为直播状态（初次开播）
        if (isLive && !wasLive && !hasReloadedForLive) {
            log('[开播检测] 初次开播，刷新页面');
            hasReloadedForLive = true;
            sessionStorage.setItem('hasReloadedForLive', 'true');
            sessionStorage.setItem('wasLive', 'true');
            location.reload();
            return;
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

    // 获取缓存的播放器元素
    function getCachedPlayer() {
        if (cachedPlayerElement && document.contains(cachedPlayerElement)) {
            return cachedPlayerElement;
        }
        const playerSelectors = ['.basic-player', '#live-player', '#web-player__bottom-bar__container'];
        for (const selector of playerSelectors) {
            cachedPlayerElement = document.querySelector(selector);
            if (cachedPlayerElement) break;
        }
        return cachedPlayerElement;
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
                // 清理缓存
                cachedVideoElement = null;
                cachedPlayerElement = null;
                sessionStorage.clear();
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

    // 页面可见性标志
    let isPageVisible = true;

    // 监听页面可见性变化
    document.addEventListener('visibilitychange', () => {
        isPageVisible = document.visibilityState === 'visible';
        log(`[页面可见性] ${isPageVisible ? '可见' : '隐藏'}`);
    });

    // 合并的主循环函数（每5秒执行一次）
    function mainLoop() {
        // 页面隐藏时跳过大部分检查（节省资源）
        if (!isPageVisible) {
            // 后台时只执行最小限度的检查
            if (mainLoopCounter % 30 === 0) {
                log('[主循环] 后台模式：检查直播状态');
                checkLive();
            }
            mainLoopCounter++;
            return;
        }

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
            cachedPlayerElement = null;
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
            if (playerObserver) {
                playerObserver.disconnect();
                playerObserver = null;
            }
            // 移除 resize 监听器
            if (resizeListener) {
                window.removeEventListener('resize', resizeListener);
                resizeListener = null;
            }
            // 关闭 OBS 连接
            if (obsController) {
                obsController.close();
                obsController = null;
            }
            // 停止主循环定时器
            if (mainLoopTimer) {
                clearInterval(mainLoopTimer);
                mainLoopTimer = null;
            }
            // 清除缓存的 DOM 元素引用
            cachedVideoElement = null;
            cachedPlayerElement = null;
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
