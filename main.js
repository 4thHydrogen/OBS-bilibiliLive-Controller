// ==UserScript==
// @name         Bilibili直播自动刷新+网页全屏+OBS控制（稳定版6.5）
// @namespace    https://github.com/tampermonkey
// @version      6.5
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

    let videoFullscreenTriggered = false; // 视频全屏触发标志
    let liveFullscreenTriggered = false; // 直播全屏触发标志
    let lastVideoElement = null; // 上一个视频元素引用
    let initializedFullscreenAfterReload = false; // 重载后初始化全屏标志

    let obsController = null; // OBS 控制器实例
    let isObsConnected = false; // OBS 连接状态标志
    let isCheckingObs = false; // OBS 检查中标志（防止重复检查）

    // 全屏触发频率检测
    let fullscreenTriggerCount = 0;
    let fullscreenTriggerStartTime = 0;
    const FULLSCREEN_TRIGGER_LIMIT = 4; // 1分钟内最多触发5次
    const FULLSCREEN_TRIGGER_WINDOW = 30000; // 时间窗口：1分钟

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

                    } catch (error) {}
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
            if (this.reconnectAttempts < this.maxReconnectAttempts) {
                this.reconnectAttempts++;
                setTimeout(() => {
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
                this.ws.close();
            }
            this.authenticated = false;
            this.pendingRequests.clear();
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
            } catch (error) {}

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
        } catch {}
    }

    // 添加全屏样式
    function addFullscreenStyles() {
        // 避免重复添加
        if (document.getElementById('bilibili-fullscreen-styles')) return;

        const style = document.createElement('style');
        style.id = 'bilibili-fullscreen-styles';
        style.textContent = `
            .hide-aside-area #web-player__bottom-bar__container,
            .hide-aside-area .web-player-icon-roomStatus,
            .hide-aside-area .web-player-controller-wrap {
                display: none !important;
            }
            .hide-aside-area .basic-player {
                height: 100vh !important;
            }
            /* 隐藏小黄车提示 */
            #shop-popover-vm {
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
        console.log(`[全屏保险] 触发次数: ${fullscreenTriggerCount}/${FULLSCREEN_TRIGGER_LIMIT}`);

        // 如果超过限制，清空缓存并刷新页面
        if (fullscreenTriggerCount >= FULLSCREEN_TRIGGER_LIMIT) {
            console.log('[全屏保险] 触发过于频繁，清空缓存并刷新页面');
            // 清空 sessionStorage 和 localStorage
            sessionStorage.clear();
            localStorage.clear();
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
            console.log('[礼物面板] 已隐藏');
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
            console.log('[小黄车提示] 已隐藏');
        }
    }

    // 触发直播全屏
    function triggerLiveFullscreen() {
        // 检查触发频率
        checkFullscreenTriggerRate();

        // 防止重复触发
        if (liveFullscreenTriggered) return;
        const player = document.getElementById('live-player');
        if (player) triggerDoubleClick(player);
        // 添加隐藏侧边栏的类
        document.body.classList.add('hide-aside-area');
        liveFullscreenTriggered = true;

        // 关闭礼物面板
        closeGiftPopover();
    }

    // 等待元素出现
    function waitForElement(selector, callback, interval = 500, maxTries = 40) {
        let tries = 0;
        const timer = setInterval(() => {
            const el = document.querySelector(selector);
            if (el) {
                clearInterval(timer);
                callback(el);
            } else if (++tries >= maxTries) {
                clearInterval(timer);
            }
        }, interval);
    }

    /****************************************************
     * 🔧 修改区域：全屏初始化逻辑（基于 video 出现）
     ****************************************************/
    // 在页面重载后初始化全屏
    // function initializeFullscreenAfterReload() {
    //     // 防止重复初始化
    //     if (initializedFullscreenAfterReload) return;
    //     initializedFullscreenAfterReload = true;

    //     console.log("[全屏初始化] 等待 video 元素出现…");

    //     // 等待 video 元素出现后触发全屏
    //     waitForElement("#live-player video", () => {
    //         console.log("[全屏初始化] 找到 video，触发网页全屏");
    //         setTimeout(() => {
    //             triggerLiveFullscreen();
    //         }, 1000);
    //     }, 500, 80);
    // }
    /****************************************************/

    /*** 核心检测逻辑（保持不变） ***/
    // 检查直播状态并执行相应操作
    async function checkLive() {
        const roomId = parseRoomIdFromUrl();
        if (!roomId) return;

        // 获取直播状态
        const isLive = await fetchLiveStatus(roomId);

        // 如果未开播
        if (!isLive) {
            // 重置所有标志
            videoFullscreenTriggered = false;
            liveFullscreenTriggered = false;
            lastVideoElement = null;
            initializedFullscreenAfterReload = false;

            // 移除全屏样式
            document.body.classList.remove('hide-aside-area');

            // 停止 OBS 录制
            await checkAndControlOBS();
            return;
        }

        const video = document.querySelector('#live-player video'); // 获取视频元素

        // 如果视频元素不存在，刷新页面
        if (!video) {
            location.reload();
            return;
        }

        // 如果视频元素发生变化，重置标志
        if (video !== lastVideoElement) {
            lastVideoElement = video;
            videoFullscreenTriggered = false;
            liveFullscreenTriggered = false;
            initializedFullscreenAfterReload = false;
        }

        // 初始化全屏
        initializeFullscreenAfterReload();
    }

    // 检查是否已全屏
    function isFullscreen() {
        // 检查 CSS 类（主要判断依据）
        const hasClass = document.body.classList.contains('hide-aside-area');
        if (!hasClass) return false;
        
        // 尝试多种播放器选择器
        const playerSelectors = ['.basic-player', '#live-player', '#web-player__bottom-bar__container'];
        let player = null;
        for (const selector of playerSelectors) {
            player = document.querySelector(selector);
            if (player) break;
        }
        
        if (!player) return false;
        
        // 检查播放器高度是否接近全屏（允许一定误差）
        const playerHeight = parseInt(getComputedStyle(player).height);
        const windowHeight = window.innerHeight;
        const heightDiff = Math.abs(playerHeight - windowHeight);
        const isFullHeight = heightDiff < 50; // 允许50px误差
        
        return isFullHeight;
    }

    // 定时检测并确保全屏
    function checkAndEnsureFullscreen() {
        const video = document.querySelector('#live-player video');
        console.log('进行全屏检测');
        if (!video) return; // 没有视频元素时不检测

        if (!isFullscreen()) {
            console.log('[全屏检测] 检测到未全屏，触发全屏');
            // 重置标志，允许再次触发
            liveFullscreenTriggered = false;
            triggerLiveFullscreen();
        }
    }

    // 检测视频是否卡顿
    let lastVideoTime = 0;
    let stuckCounter = 0;

    function detectVideoStuck() {
        const video = document.querySelector('#live-player video');
        if (!video) return;

        const currentTime = video.currentTime;

        // 如果视频在播放但时间没变
        if (currentTime === lastVideoTime && !video.paused && !video.ended) {
            stuckCounter++;
            console.log(`[卡顿检测] 疑似卡顿 ${stuckCounter}/3`);

            // 连续3次检测都卡住，确认卡顿
            if (stuckCounter >= 3) {
                console.log('[卡顿检测] 确认视频卡顿，刷新页面');
                location.reload();
            }
        } else {
            // 正常播放，重置计数器
            if (stuckCounter > 0) {
                console.log('[卡顿检测] 视频恢复正常');
            }
            stuckCounter = 0;
        }

        lastVideoTime = currentTime;
    }

    /*** 主入口 ***/
    // 初始化脚本
    function initScript() {
        console.log('[Bilibili自动刷新] v6.5 启动');

        // 添加全屏样式
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', addFullscreenStyles);
        } else {
            addFullscreenStyles();
        }

        // 定时检查直播状态
        setInterval(checkLive, CHECK_INTERVAL);
        // 定时检测全屏状态（每5秒检测一次）
        setInterval(checkAndEnsureFullscreen, 5000);
        // 定时检测视频卡顿（每3秒检测一次）
        setInterval(detectVideoStuck, 3000);
    }

    // 启动脚本
    initScript();
})();
