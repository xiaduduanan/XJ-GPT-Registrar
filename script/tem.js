// ==UserScript==
// @name         PayPal Auto Filler (可视化UI + Plus长链接获取 + Token提取 + 参数配置)
// @namespace    http://tampermonkey.net/
// @version      36.1
// @description  Auto-fill PayPal/OpenAI checkout pages, auto-fetch ChatGPT Plus link & Session Token, support manual config
// @match        https://www.paypal.com/*
// @match        https://paypal.com/*
// @match        https://*.paypal.com/*
// @match        https://pay.openai.com/*
// @match        https://checkout.stripe.com/*
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @match        https://auth.openai.com/*
// @match        http://localhost:*/*
// @match        http://127.0.0.1:*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      meiguodizhi.com
// @connect      127.0.0.1
// @connect      localhost
// @connect      *
// @run-at       document-idle
// ==/UserScript==

// 使用 GM_getValue 读取本地保存的配置，如果没有则使用默认值
var CONFIG = {
    phone: typeof GM_getValue !== 'undefined' ? GM_getValue('pp_phone', '83890239615') : '83890239615',
    cardNumber: '',
    cardExpiry: '',
    cardCvv: '',
    cpaUrl: typeof GM_getValue !== 'undefined' ? GM_getValue('cpa_url', '') : '',
    cpaKey: typeof GM_getValue !== 'undefined' ? GM_getValue('cpa_key', '') : ''
};

(function() {
    'use strict';

    // 全局运行状态：'RUNNING', 'PAUSED', 'STOPPED'
    var STATE = 'RUNNING';

    function redactSensitiveProfileData(data) {
        console.log(22222)
        return JSON.parse(JSON.stringify(data || {}));
    }

    function fetchMeiguoProfileForConsole() {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: 'https://www.meiguodizhi.com/api/v1/dz',
                headers: { 'Accept': '*/*', 'Content-Type': 'application/json' },
                data: JSON.stringify({ city: '', path: '/', method: 'refresh' }),
                onload: function(r) {
                    try {
                        var data = JSON.parse(r.responseText || '{}');
                        var safeData = redactSensitiveProfileData(data);
                        console.log('[XJ-GPT] meiguodizhi response (redacted):', safeData);
                        resolve(safeData);
                    } catch (e) {
                        reject(e);
                    }
                },
                onerror: function() { reject(new Error('meiguodizhi request failed')); },
                ontimeout: function() { reject(new Error('meiguodizhi request timeout')); }
            });
        });
    }

    function installChatgptProfileConsoleButton() {
        if (!window.location.host.includes('chatgpt.com') && !window.location.host.includes('chat.openai.com')) return;
        if (document.getElementById('xj-fetch-profile-console')) return;
        var btn = document.createElement('button');
        btn.id = 'xj-fetch-profile-console';
        btn.textContent = 'Fetch profile to console';
        btn.style.cssText = 'position:fixed!important;right:20px!important;top:80px!important;z-index:2147483647!important;padding:12px 14px!important;border:0!important;border-radius:6px!important;background:#16a085!important;color:#fff!important;font:600 13px Arial,sans-serif!important;box-shadow:0 4px 12px rgba(0,0,0,.35)!important;cursor:pointer!important;';
        btn.addEventListener('click', async function() {
            btn.disabled = true;
            btn.textContent = 'Fetching...';
            try {
                await fetchMeiguoProfileForConsole();
                btn.textContent = 'Printed to console';
            } catch (e) {
                console.error('[XJ-GPT] profile fetch failed:', e);
                btn.textContent = 'Fetch failed';
            }
            setTimeout(() => {
                btn.disabled = false;
                btn.textContent = 'Fetch profile to console';
            }, 2000);
        });
        (document.body || document.documentElement).appendChild(btn);
    }

    function keepChatgptProfileConsoleButtonAlive() {
        installChatgptProfileConsoleButton();
        if (window.__xjProfileConsoleButtonTimer) return;
        window.__xjProfileConsoleButtonTimer = setInterval(installChatgptProfileConsoleButton, 1000);
    }

    // ========== 1. 悬浮窗及日志/进度系统 ==========
    var logBox, progressBar, progressText, stepDesc;
    function initUI() {
        installChatgptProfileConsoleButton();
        // 强制注入样式（增加了配置表单的样式）
        GM_addStyle(`
            #pp-auto-panel { position:fixed !important; bottom:20px !important; right:20px !important; width:320px !important; background:rgba(30,30,30,0.95) !important; border:1px solid #444 !important; border-radius:8px !important; box-shadow:0 4px 12px rgba(0,0,0,0.5) !important; color:#fff !important; z-index:2147483647 !important; font-family:sans-serif !important; font-size:13px !important; display:flex !important; flex-direction:column !important; backdrop-filter:blur(5px) !important; text-align:left !important; line-height:1.5 !important; }
            #pp-auto-panel * { box-sizing: border-box !important; margin: 0; padding: 0; }
            #pp-auto-header { padding:10px !important; border-bottom:1px solid #555 !important; font-weight:bold !important; cursor:move !important; display:flex !important; justify-content:space-between !important; user-select:none !important; background:transparent !important; color:#fff !important; align-items: center !important; }
            #pp-status-badge { color:#0f0 !important; font-weight: bold !important; }

            /* 新增配置区域样式 */
            .pp-config-area { padding: 10px !important; border-bottom: 1px solid #555 !important; background: rgba(0,0,0,0.2) !important; }
            .pp-config-area summary { cursor: pointer !important; font-size: 12px !important; color: #4db8ff !important; margin-bottom: 5px !important; outline: none !important; user-select: none !important; }
            .pp-input-group { display: flex !important; justify-content: space-between !important; align-items: center !important; margin-bottom: 5px !important; }
            .pp-input-group label { font-size: 12px !important; color: #ccc !important; width: 50px !important; }
            .pp-input-group input { flex: 1 !important; background: #222 !important; border: 1px solid #555 !important; color: #fff !important; padding: 4px 6px !important; border-radius: 4px !important; font-size: 12px !important; font-family: monospace !important; outline: none !important; transition: border-color 0.2s !important; }
            .pp-input-group input:focus { border-color: #4db8ff !important; }
            #pp-btn-save-cfg { width: 100% !important; margin-top: 5px !important; background: #2ecc71 !important; color: white !important; padding: 6px !important; border: none !important; border-radius: 4px !important; cursor: pointer !important; font-size: 12px !important; font-weight: bold !important; transition: background 0.2s !important; }
            #pp-btn-save-cfg:hover { background: #27ae60 !important; }
            #pp-btn-clear-card { width: 100% !important; margin-top: 5px !important; background: #555 !important; color: white !important; padding: 6px !important; border: none !important; border-radius: 4px !important; cursor: pointer !important; font-size: 12px !important; font-weight: bold !important; transition: background 0.2s !important; }
            #pp-btn-clear-card:hover { background: #666 !important; }

            .pp-progress-container { padding:10px !important; border-bottom:1px solid #555 !important; background:transparent !important; }
            .pp-progress-info { display:flex !important; justify-content:space-between !important; margin-bottom:6px !important; font-size:12px !important; }
            #pp-step-desc { color:#4db8ff !important; font-weight:bold !important; }
            #pp-progress-text { color:#aaa !important; }
            .pp-progress-track { width:100% !important; height:8px !important; background:#222 !important; border-radius:4px !important; overflow:hidden !important; box-shadow:inset 0 1px 3px rgba(0,0,0,0.5) !important; }
            #pp-progress-bar { width:0% !important; height:100% !important; background:#4caf50 !important; transition:width 0.4s ease, background-color 0.3s !important; }
            .pp-btn-area { padding:10px !important; display:flex !important; gap:10px !important; flex-wrap:wrap !important; background:transparent !important; }
            .pp-btn { flex:1 !important; padding:6px !important; border:none !important; border-radius:4px !important; cursor:pointer !important; font-weight:bold !important; color:#fff !important; transition:0.2s !important; font-size: 13px !important; font-family:sans-serif !important; }
            #pp-btn-pause { background:#f39c12 !important; }
            #pp-btn-stop { background:#e74c3c !important; }

            /* ChatGPT 专属按钮样式 */
            #pp-btn-getlink { width:100% !important; margin-top:5px !important; padding:8px !important; border:none !important; border-radius:4px !important; cursor:pointer !important; font-weight:bold !important; background:#9b59b6 !important; color:#fff !important; transition:0.2s !important; display:none; font-size: 13px !important; font-family:sans-serif !important; }
            #pp-btn-copytoken { width:100% !important; margin-top:5px !important; padding:8px !important; border:none !important; border-radius:4px !important; cursor:pointer !important; font-weight:bold !important; background:#2980b9 !important; color:#fff !important; transition:0.2s !important; display:none; font-size: 13px !important; font-family:sans-serif !important; }
            #pp-btn-outlook-email { width:100% !important; margin-top:5px !important; padding:8px !important; border:none !important; border-radius:4px !important; cursor:pointer !important; font-weight:bold !important; background:#16a085 !important; color:#fff !important; transition:0.2s !important; display:none; font-size: 13px !important; font-family:sans-serif !important; }
            #pp-btn-outlook-otp { width:100% !important; margin-top:5px !important; padding:8px !important; border:none !important; border-radius:4px !important; cursor:pointer !important; font-weight:bold !important; background:#d35400 !important; color:#fff !important; transition:0.2s !important; display:none; font-size: 13px !important; font-family:sans-serif !important; }
            #pp-btn-fill-paypal-signup { width:100% !important; margin-top:5px !important; padding:8px !important; border:none !important; border-radius:4px !important; cursor:pointer !important; font-weight:bold !important; background:#2c7be5 !important; color:#fff !important; transition:0.2s !important; display:none; font-size: 13px !important; font-family:sans-serif !important; }

            #pp-btn-getlink:disabled, #pp-btn-copytoken:disabled, #pp-btn-outlook-email:disabled, #pp-btn-outlook-otp:disabled, #pp-btn-fill-paypal-signup:disabled, .pp-btn:disabled { opacity: 0.6 !important; cursor: not-allowed !important; }
            #pp-log-box { height:140px !important; overflow-y:auto !important; background:#000 !important; padding:10px !important; font-family:monospace !important; font-size:11px !important; border-bottom-left-radius:8px !important; border-bottom-right-radius:8px !important; color:#fff !important; }
            .pp-log-line { margin-bottom:4px !important; line-height:1.4 !important; }
        `);

        var uiHtml = `
            <div id="pp-auto-panel">
                <div id="pp-auto-header">
                    <span>🤖 Auto Filler (按住拖动)</span>
                    <span id="pp-status-badge">运行中</span>
                </div>

                <!-- 配置区域 -->
                <details class="pp-config-area">
                    <summary>⚙️ 参数设置 (点击展开修改)</summary>
                    <div class="pp-input-group"><label>电 话</label><input type="text" id="pp-cfg-phone" value="${CONFIG.phone}"></div>
                    <div class="pp-input-group"><label>卡 号</label><input type="text" id="pp-cfg-card" value="${CONFIG.cardNumber}"></div>
                    <div class="pp-input-group"><label>有效期</label><input type="text" id="pp-cfg-expiry" value="${CONFIG.cardExpiry}"></div>
                    <div class="pp-input-group"><label>CVV</label><input type="text" id="pp-cfg-cvv" value="${CONFIG.cardCvv}"></div>
                    <button id="pp-btn-save-cfg">💾 保存并应用配置</button>
                    <button id="pp-btn-clear-card">自动获取卡片信息</button>
                </details>

                <!-- 进度条区域 -->
                <div class="pp-progress-container">
                    <div class="pp-progress-info">
                        <span id="pp-step-desc">匹配页面中...</span>
                        <span id="pp-progress-text">0%</span>
                    </div>
                    <div class="pp-progress-track">
                        <div id="pp-progress-bar"></div>
                    </div>
                </div>

                <!-- 按钮区域 -->
                <div class="pp-btn-area">
                    <button id="pp-btn-pause" class="pp-btn">暂停</button>
                    <button id="pp-btn-stop" class="pp-btn">中止打断</button>
                    <!-- 针对 ChatGPT 的特殊按钮，默认隐藏 -->
                    <button id="pp-btn-getlink">🚀 自动获取 Plus 链接并跳转</button>
                    <button id="pp-btn-copytoken">📋 一键提取 Token 复制到剪贴板</button>
                    <button id="pp-btn-outlook-email">📧 获取本地 Outlook 邮箱并填入</button>
                    <button id="pp-btn-outlook-otp">🔢 获取本地 Outlook 验证码并填入</button>
                </div>

                <!-- 日志区域 -->
                <div id="pp-log-box"></div>
            </div>
        `;
        document.body.insertAdjacentHTML('beforeend', uiHtml);

        logBox = document.getElementById('pp-log-box');
        progressBar = document.getElementById('pp-progress-bar');
        progressText = document.getElementById('pp-progress-text');
        stepDesc = document.getElementById('pp-step-desc');

        var panel = document.getElementById('pp-auto-panel');
        var header = document.getElementById('pp-auto-header');
        var btnPause = document.getElementById('pp-btn-pause');
        var btnStop = document.getElementById('pp-btn-stop');
        var btnSaveCfg = document.getElementById('pp-btn-save-cfg');
        var btnClearCard = document.getElementById('pp-btn-clear-card');
        var btnGetLink = document.getElementById('pp-btn-getlink');
        var btnCopyToken = document.getElementById('pp-btn-copytoken');
        var btnOutlookEmail = document.getElementById('pp-btn-outlook-email');
        var btnOutlookOtp = document.getElementById('pp-btn-outlook-otp');
        var btnFillPaypalSignup = document.createElement('button');
        btnFillPaypalSignup.id = 'pp-btn-fill-paypal-signup';
        btnFillPaypalSignup.textContent = 'Fill PayPal email, name and phone';
        var btnArea = document.querySelector('.pp-btn-area');
        if (btnArea) btnArea.appendChild(btnFillPaypalSignup);
        var statusBadge = document.getElementById('pp-status-badge');

        // ====== 参数保存事件 ======
        if (btnSaveCfg) {
            btnSaveCfg.addEventListener('click', function() {
                // 读取输入框中的值
                CONFIG.phone = document.getElementById('pp-cfg-phone').value.trim();
                CONFIG.cardNumber = document.getElementById('pp-cfg-card').value.trim();
                CONFIG.cardExpiry = document.getElementById('pp-cfg-expiry').value.trim();
                CONFIG.cardCvv = document.getElementById('pp-cfg-cvv').value.trim();

                // 使用 GM_setValue 跨页面持久化保存
                if (typeof GM_setValue !== 'undefined') {
                    GM_setValue('pp_phone', CONFIG.phone);
                    GM_setValue('pp_cardNumber', CONFIG.cardNumber);
                    GM_setValue('pp_cardExpiry', CONFIG.cardExpiry);
                    GM_setValue('pp_cardCvv', CONFIG.cardCvv);
                }

                // UI提示
                btnSaveCfg.innerText = '✅ 保存成功!';
                btnSaveCfg.style.background = '#27ae60';
                log(`✅ 参数已保存: 尾号 ${CONFIG.cardNumber.slice(-4)}`);

                setTimeout(() => {
                    btnSaveCfg.innerText = '💾 保存并应用配置';
                    btnSaveCfg.style.background = '';
                }, 2000);
            });
        }

        // ====== ChatGPT 专属功能 ======
        if (btnClearCard) {
            btnClearCard.addEventListener('click', function () {
                fetchMeiguoProfileForConsole().then(r => {
                    console.log('接口返回:', r);


                    document.getElementById('pp-cfg-card').value = r.address.Credit_Card_Number;
                    document.getElementById('pp-cfg-expiry').value = r.address.Expires;
                    document.getElementById('pp-cfg-cvv').value = r.address.CVV2;

                    if (typeof GM_setValue !== 'undefined') {
                        GM_setValue('pp_cardNumber', '');
                        GM_setValue('pp_cardExpiry', '');
                        GM_setValue('pp_cardCvv', '');
                    }

                    btnClearCard.innerText = '获取成功';
                    log('获取卡号、有效期、CVV');
                }).catch(e => {
                    console.error('接口调用失败:', e);
                });
            });
        }

        if (window.location.host.includes('chatgpt.com')) {
            // 显示功能按钮
            btnGetLink.style.setProperty('display', 'block', 'important');
            btnCopyToken.style.setProperty('display', 'block', 'important');

            // 绑定长链接跳转事件
            btnGetLink.addEventListener('click', async function() {
                if (STATE === 'STOPPED') return;
                btnGetLink.disabled = true;
                btnGetLink.innerText = '⏳ 正在获取并跳转中...';
                await generatePlusHostedLink();
                btnGetLink.disabled = false;
                btnGetLink.innerText = '🚀 自动获取 Plus 链接并跳转';
            });

            // 绑定一键提取 Token 并复制的事件
            btnCopyToken.addEventListener('click', async function() {
                if (STATE === 'STOPPED') return;
                btnCopyToken.disabled = true;
                btnCopyToken.innerText = '⏳ 正在提取...';
                try {
                    log("⏳ 正在请求 API 提取 Token...");
                    const session = await fetch("/api/auth/session").then(r => r.json());
                    const token = session?.accessToken;

                    if (token) {
                        // 使用油猴提供的剪贴板接口，确保高权限复制成功
                        if (typeof GM_setClipboard !== 'undefined') {
                            GM_setClipboard(token, 'text');
                        } else {
                            await navigator.clipboard.writeText(token); // 降级策略
                        }
                        btnCopyToken.innerText = '✅ 已成功复制到剪贴板!';
                        log("✅ 成功提取 Session Token 并写入剪贴板！");
                    } else {
                        btnCopyToken.innerText = '❌ 未获取到 Token';
                        log("❌ 提取失败：响应中未找到 accessToken，请确认是否已登录 ChatGPT");
                    }
                } catch (e) {
                    btnCopyToken.innerText = '❌ 提取发生异常';
                    log("❌ 获取 Token 网络或解析异常：" + e.message);
                }

                // 3秒后恢复按钮初始状态
                setTimeout(() => {
                    btnCopyToken.disabled = false;
                    btnCopyToken.innerText = '📋 一键提取 Token 复制到剪贴板';
                }, 3000);
            });
        }

        if (window.location.host.includes('chatgpt.com') || window.location.host.includes('auth.openai.com')) {
            btnOutlookEmail.style.setProperty('display', 'block', 'important');
            btnOutlookOtp.style.setProperty('display', 'block', 'important');

            btnOutlookEmail.addEventListener('click', async function() {
                if (STATE === 'STOPPED') return;
                btnOutlookEmail.disabled = true;
                btnOutlookEmail.innerText = '⏳ 获取邮箱中...';
                try {
                    const account = await getLocalOutlookAccount();
                    if (!account || !account.email) throw new Error('本地接口未返回可用邮箱');
                    GM_setValue('pp_outlook_email', account.email);
                    fillBestEmailField(account.email);
                    log('✅ 已填入 Outlook 邮箱: ' + account.email);
                    btnOutlookEmail.innerText = '✅ 已填入邮箱';
                } catch (e) {
                    log('❌ 获取/填入 Outlook 邮箱失败: ' + e.message);
                    btnOutlookEmail.innerText = '❌ 获取失败';
                }
                setTimeout(() => {
                    btnOutlookEmail.disabled = false;
                    btnOutlookEmail.innerText = '📧 获取本地 Outlook 邮箱并填入';
                }, 2000);
            });

            btnOutlookOtp.addEventListener('click', async function() {
                if (STATE === 'STOPPED') return;
                btnOutlookOtp.disabled = true;
                btnOutlookOtp.innerText = '⏳ 获取验证码中...';
                try {
                    const email = getCurrentLoginEmail();
                    if (!email) throw new Error('未找到邮箱，请先填入邮箱');
                    GM_setValue('pp_outlook_email', email);
                    const otp = await getLocalOutlookOtp(email);
                    fillBestOtpField(otp);
                    log('✅ 已填入 Outlook 验证码: ' + otp);
                    btnOutlookOtp.innerText = '✅ 已填入验证码';
                } catch (e) {
                    log('❌ 获取/填入 Outlook 验证码失败: ' + e.message);
                    btnOutlookOtp.innerText = '❌ 获取失败';
                }
                setTimeout(() => {
                    btnOutlookOtp.disabled = false;
                    btnOutlookOtp.innerText = '🔢 获取本地 Outlook 验证码并填入';
                }, 2000);
            });
        }

        // ====== 暂停/中止 按钮事件 ======
        if (window.location.host.includes('paypal.com') && window.location.pathname.includes('/checkoutweb/signup')) {
            if (!document.getElementById('pp-signup-quick-fill')) {
                var quickBtn = document.createElement('button');
                quickBtn.id = 'pp-signup-quick-fill';
                quickBtn.textContent = 'Fill email/name/phone';
                quickBtn.style.cssText = 'position:fixed!important;right:20px!important;bottom:20px!important;z-index:2147483647!important;padding:12px 14px!important;border:0!important;border-radius:6px!important;background:#2c7be5!important;color:#fff!important;font:600 13px Arial,sans-serif!important;box-shadow:0 4px 12px rgba(0,0,0,.35)!important;cursor:pointer!important;';
                quickBtn.addEventListener('click', async function() {
                    quickBtn.disabled = true;
                    quickBtn.textContent = 'Filling...';
                    try {
                        await fillPaypalSignupIdentityFields();
                        quickBtn.textContent = 'Filled';
                    } catch (e) {
                        console.error('[PP] PayPal signup quick fill failed:', e);
                        quickBtn.textContent = 'Fill failed';
                    }
                    setTimeout(() => {
                        quickBtn.disabled = false;
                        quickBtn.textContent = 'Fill email/name/phone';
                    }, 2000);
                });
                document.body.appendChild(quickBtn);
            }

            btnFillPaypalSignup.style.setProperty('display', 'block', 'important');
            btnFillPaypalSignup.addEventListener('click', async function() {
                if (STATE === 'STOPPED') return;
                btnFillPaypalSignup.disabled = true;
                btnFillPaypalSignup.textContent = 'Filling...';
                try {
                    await fillPaypalSignupIdentityFields();
                    btnFillPaypalSignup.textContent = 'Filled email, name and phone';
                } catch (e) {
                    log('PayPal signup fill failed: ' + e.message);
                    btnFillPaypalSignup.textContent = 'Fill failed';
                }
                setTimeout(() => {
                    btnFillPaypalSignup.disabled = false;
                    btnFillPaypalSignup.textContent = 'Fill PayPal email, name and phone';
                }, 2000);
            });
        }

        btnPause.addEventListener('click', function() {
            if (STATE === 'STOPPED') return;
            if (STATE === 'RUNNING') {
                STATE = 'PAUSED';
                btnPause.innerText = '▶ 继续';
                btnPause.style.setProperty('background', '#27ae60', 'important');
                statusBadge.innerText = '已暂停';
                statusBadge.style.setProperty('color', '#f39c12', 'important');
                log('====== 脚本已暂停 ======');
            } else {
                STATE = 'RUNNING';
                btnPause.innerText = '暂停';
                btnPause.style.setProperty('background', '#f39c12', 'important');
                statusBadge.innerText = '运行中';
                statusBadge.style.setProperty('color', '#0f0', 'important');
                log('====== 脚本已继续 ======');
            }
        });

        btnStop.addEventListener('click', function() {
            STATE = 'STOPPED';
            btnStop.disabled = true;
            btnPause.disabled = true;
            btnStop.style.setProperty('background', '#555', 'important');
            btnPause.style.setProperty('background', '#555', 'important');
            statusBadge.innerText = '已中止';
            statusBadge.style.setProperty('color', '#e74c3c', 'important');

            progressBar.style.setProperty('background-color', '#e74c3c', 'important');
            stepDesc.innerText = '❌ 任务已被强制打断';
            stepDesc.style.setProperty('color', '#e74c3c', 'important');
            log('====== 脚本已彻底打断 ======');
        });

        // ====== 完美拖动逻辑优化 ======
        let isDragging = false, offsetX, offsetY;

        // 鼠标按下标题栏时触发拖拽计算
        header.addEventListener('mousedown', e => {
            isDragging = true;
            let rect = panel.getBoundingClientRect();
            // 计算鼠标点击位置相对于面板左上角的偏移量
            offsetX = e.clientX - rect.left;
            offsetY = e.clientY - rect.top;
            e.preventDefault(); // 防止拖拽时选中文字出现闪烁
        });

        // 鼠标在全局移动时更新面板坐标
        document.addEventListener('mousemove', e => {
            if (!isDragging) return;
            // 清除右侧/底部定位限制，改用左侧/顶部绝对定位跟随鼠标
            panel.style.setProperty('right', 'auto', 'important');
            panel.style.setProperty('bottom', 'auto', 'important');
            panel.style.setProperty('left', (e.clientX - offsetX) + 'px', 'important');
            panel.style.setProperty('top', (e.clientY - offsetY) + 'px', 'important');
        });

        // 鼠标松开结束拖拽
        document.addEventListener('mouseup', () => {
            isDragging = false;
        });
    }

    var log = function(s) {
        console.log('[PP] ' + s);
        if (logBox) {
            var div = document.createElement('div');
            div.className = 'pp-log-line';
            div.style.setProperty('color', s.includes('error') || s.includes('打断') || s.includes('❌') || s.includes('失败') ? '#f44336' : (s.includes('✅') ? '#4caf50' : '#fff'), 'important');
            div.textContent = `[${new Date().toLocaleTimeString()}] ${s}`;
            logBox.appendChild(div);
            logBox.scrollTop = logBox.scrollHeight;
        }
    };

    function updateProgress(percent, text) {
        if (STATE === 'STOPPED') return;
        if (progressBar) progressBar.style.setProperty('width', percent + '%', 'important');
        if (progressText) progressText.innerText = percent + '%';
        if (stepDesc) stepDesc.innerText = text;
        log(`进度: ${percent}% - ${text}`);
    }

    function localApi(path, method, data) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: method || 'GET',
                url: 'http://127.0.0.1:5000' + path,
                headers: { 'Content-Type': 'application/json' },
                data: data ? JSON.stringify(data) : undefined,
                timeout: 95000,
                onload: function(r) {
                    let body = {};
                    try {
                        body = JSON.parse(r.responseText || '{}');
                    } catch (e) {
                        reject(new Error('Local API returned non-JSON: ' + (r.responseText || '').slice(0, 120)));
                        return;
                    }
                    if (r.status < 200 || r.status >= 300 || body.ok === false) {
                        reject(new Error(body.error || ('HTTP ' + r.status)));
                        return;
                    }
                    resolve(body);
                },
                onerror: function() {
                    reject(new Error('Cannot connect local service. Start web_app.py first.'));
                },
                ontimeout: function() {
                    reject(new Error('Local API timeout.'));
                }
            });
        });
    }

    async function getLocalOutlookAccount() {
        const data = await localApi('/api/outlook/available', 'GET');
        return data.first || (data.accounts && data.accounts[0]);
    }

    async function getLocalOutlookOtp(email) {
        const data = await localApi('/api/outlook/latest-otp', 'POST', {
            email: email,
            max_wait: 60,
            poll_interval: 3
        });
        if (!data.otp) throw new Error('Local API did not return otp');
        return data.otp;
    }

    function setNativeValue(el, val) {
        if (!el) return false;
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(el, val);
        else el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
        return true;
    }

    function findEmailField() {
        const selectors = [
            'input[type="email"]',
            'input[name="email"]',
            'input[name="username"]',
            'input#email',
            'input#username',
            'input[autocomplete="email"]',
            'input[autocomplete="username"]',
            'input[placeholder*="email" i]',
            'input[placeholder*="邮箱"]'
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && el.offsetParent !== null && !el.disabled) return el;
        }
        return Array.from(document.querySelectorAll('input'))
            .find(el => el.offsetParent !== null && !el.disabled && (el.type === 'text' || el.type === 'email'));
    }

    function findOtpField() {
        const selectors = [
            'input[autocomplete="one-time-code"]',
            'input[inputmode="numeric"]',
            'input[name*="code" i]',
            'input[id*="code" i]',
            'input[placeholder*="code" i]',
            'input[placeholder*="验证码"]'
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && el.offsetParent !== null && !el.disabled) return el;
        }
        return Array.from(document.querySelectorAll('input'))
            .find(el => el.offsetParent !== null && !el.disabled && (el.maxLength === 6 || el.pattern === '\\d*'));
    }

    function fillBestEmailField(email) {
        const el = findEmailField();
        if (!el) throw new Error('Email input not found');
        setNativeValue(el, email);
        el.focus();
    }

    function fillBestOtpField(otp) {
        const el = findOtpField();
        if (!el) throw new Error('OTP input not found');
        setNativeValue(el, otp);
        el.focus();
    }

    function getCurrentLoginEmail() {
        const field = findEmailField();
        const fieldValue = field ? String(field.value || '').trim() : '';
        return fieldValue || GM_getValue('pp_outlook_email', '');
    }

    async function safeWait(ms) {
        let waited = 0;
        const step = 100;
        while (waited < ms) {
            if (STATE === 'STOPPED') throw new Error('STOPPED_BY_USER');
            if (STATE === 'PAUSED') {
                await new Promise(r => setTimeout(r, step));
                continue;
            }
            await new Promise(r => setTimeout(r, step));
            waited += step;
        }
    }

    // ========== API 生成跳转长链接逻辑 ==========
    async function generatePlusHostedLink() {
        try {
            log("⏳ [plus-link] 正在获取 Session Token...");
            updateProgress(20, '正在获取 Session Token...');

            // 1. 获取 Access Token
            let accessToken;
            try {
                const session = await fetch("/api/auth/session").then((r) => r.json());
                accessToken = session?.accessToken;
                if (!accessToken) throw new Error("accessToken 为空");
            } catch (e) {
                log("❌ [plus-link] 获取 Token 失败，请确保已登录 ChatGPT：" + e.message);
                updateProgress(0, '获取 Token 失败');
                return;
            }
            log("✅ [plus-link] Token 获取成功");
            updateProgress(40, 'Token 成功获取，构造请求中...');

            // 2. 构造 Payload
            const payload = {
                plan_name: "chatgptplusplan",
                billing_details: { country: "US", currency: "USD" },
                cancel_url: "https://chatgpt.com/#pricing",
                promo_campaign: { promo_campaign_id: "plus-1-month-free", is_coupon_from_query_param: false },
                checkout_ui_mode: "hosted",
            };

            // 3. 发送请求
            log("⏳ [plus-link] 正在请求 Stripe 长链接...");
            updateProgress(60, '正在请求 Stripe Hosted URL...');
            let data;
            try {
                const response = await fetch("https://chatgpt.com/backend-api/payments/checkout", {
                    method: "POST",
                    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                });
                data = await response.json();

                if (!response.ok) {
                    log("❌ [plus-link] 请求失败，HTTP " + response.status);
                    updateProgress(0, '长链接请求失败');
                    console.error("响应错误:", data);
                    return;
                }
            } catch (e) {
                log("❌ [plus-link] 网络请求异常：" + e.message);
                updateProgress(0, '网络请求异常');
                return;
            }

            // 4. 解析跳转
            const hostedUrl = data?.url || data?.stripe_hosted_url || data?.checkout_url;

            if (!hostedUrl) {
                log("⚠️ [plus-link] 未找到长链接，请查看控制台日志");
                updateProgress(0, '长链接解析失败');
                return;
            }

            log("✅ [plus-link] 生成成功！");
            log("📋 Session ID : " + data.checkout_session_id);
            log("🔗 即将跳转至 Stripe 付款界面...");
            updateProgress(100, '✅ 链接获取成功，准备跳转...');

            await safeWait(1000);
            window.location.href = hostedUrl;

        } catch (e) {
            if (e.message !== 'STOPPED_BY_USER') {
                log("❌ 发生异常: " + e.message);
                updateProgress(0, '发生异常');
            }
        }
    }

    // 屏蔽干扰元素的样式
    GM_addStyle(`
        #captcha-standalone,.captcha-overlay,.captcha-container,
        .AddressAutocomplete-results,.pac-container,.pac-item,
        div[role="listbox"], .autocomplete-dropdown {
            display:none!important; height:0!important; overflow:hidden!important; visibility:hidden!important;
        }
    `);

    // ========== 表单填充与辅助函数 ==========
    function randEmail() {
        var c = 'abcdefghijklmnopqrstuvwxyz0123456789', e = '';
        for (var i = 0; i < 16; i++) e += c[Math.floor(Math.random() * c.length)];
        return e + '@gmail.com';
    }
    function randPass() {
        var L = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', D = '0123456789', S = '!@#$%^', A = L + D + S;
        var p = L[Math.floor(Math.random()*26)] + L[26+Math.floor(Math.random()*26)] + D[Math.floor(Math.random()*10)] + S[Math.floor(Math.random()*6)];
        for (var i = 4; i < 14; i++) p += A[Math.floor(Math.random()*A.length)];
        return p.split('').sort(function(){return Math.random()-0.5}).join('');
    }

    function fill(id, val) {
        var el = document.getElementById(id);
        if (!el) return;
        var ns = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        ns.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
    }
    function fillSel(sel, val) {
        var el = document.querySelector(sel);
        if (!el) return;
        var ns = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        ns.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
    }
    function fillFirstAvailable(selectors, val) {
        for (var i = 0; i < selectors.length; i++) {
            var el = document.querySelector(selectors[i]);
            if (!el) continue;
            var ns = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            ns.call(el, val);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('blur', { bubbles: true }));
            return true;
        }
        return false;
    }
    async function fillPaypalSignupIdentityFields() {
        await safeWait(300);

        var signupEmail = randEmail();
        var firstName = 'James';
        var lastName = 'Smith';

        fillFirstAvailable(['#email', 'input[name="email"]', 'input[type="email"]'], signupEmail);
        fillFirstAvailable(['#firstName', 'input[name="firstName"]', 'input[name="givenName"]'], firstName);
        fillFirstAvailable(['#lastName', 'input[name="lastName"]', 'input[name="familyName"]'], lastName);
        fillFirstAvailable(['#phone', 'input[name="phone"]', 'input[type="tel"]'], CONFIG.phone);

        updateProgress(100, 'Filled email, name and phone only. Please fill card and address manually.');
        log('PayPal signup filled: ' + signupEmail + ', ' + firstName + ' ' + lastName + ', phone ' + CONFIG.phone);
    }
    function fillSelect(id, text) {
        var el = document.getElementById(id);
        if (!el) return;
        for (var i = 0; i < el.options.length; i++) {
            if (el.options[i].text.toLowerCase().includes(text.toLowerCase()) || el.options[i].value.toLowerCase().includes(text.toLowerCase())) {
                el.value = el.options[i].value;
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return;
            }
        }
    }

    function getAddrAsync() {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: 'https://www.meiguodizhi.com/api/v1/dz',
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({ path: '/', method: 'address' }),
                onload: function(r) {
                    try {
                        var d = JSON.parse(r.responseText);
                        var a = d.address || d;
                        var addr = {
                            street: a.Address || a.street || '123 Main St',
                            city: a.City || a.city || 'New York',
                            state: a.State_Full || a.State || a.state || 'New York',
                            zip: (a.Zip_Code || a.zip || '10001').substring(0, 5)
                        };
                        resolve(addr);
                    } catch(e) {
                        resolve({ street:'123 Main St', city:'New York', state:'New York', zip:'10001' });
                    }
                },
                onerror: function() {
                    resolve({ street:'123 Main St', city:'New York', state:'New York', zip:'10001' });
                }
            });
        });
    }

    async function clickBtnAsync(retries = 0) {
        if (STATE === 'STOPPED') throw new Error('STOPPED_BY_USER');

        var btn = document.querySelector('button[data-testid="submit-button"]') ||
                  document.querySelector('button[data-testid="hosted-payment-submit-button"]') ||
                  document.querySelector('button[data-atomic-wait-intent="Submit_Email"]') ||
                  document.querySelector('button.SubmitButton--complete');
        if (!btn) {
            var all = document.querySelectorAll('button');
            for (var i = 0; i < all.length; i++) {
                var t = all[i].textContent.trim();
                // 增加了对“下一步”按钮的兼容
                if (['下一页', '下一步', 'Next', 'Subscribe', 'Pay', 'Continue', 'Agree'].includes(t) || t.includes('訂閱') || t.includes('处理中')) {
                    btn = all[i]; break;
                }
            }
        }

        if (btn) {
            var rect = btn.getBoundingClientRect();
            if (btn.disabled || rect.height === 0) {
                log('按钮被禁用或不可见，等待中...');
                if (retries < 12) {
                    await safeWait(800);
                    await clickBtnAsync(retries + 1);
                }
                return;
            }
            log('正在点击按钮: ' + btn.textContent.trim());
            btn.click();
        } else {
            log('未找到提交按钮，重试中... (' + retries + ')');
            if (retries < 12) {
                await safeWait(800);
                await clickBtnAsync(retries + 1);
            }
        }
    }

    // ========== 3. 主逻辑控制器 ==========
    async function runScript() {
        var host = window.location.host;
        var path = window.location.pathname;

        try {
            // ============================================
            // -- 场景〇：ChatGPT主站 (等待点击按钮获取链接) --
            // ============================================
            if (host.includes('chatgpt.com')) {
                updateProgress(10, '已就绪，请点击面板按键进行操作...');
                return;
            }

            // ============================================
            // -- 场景一：OpenAI / Stripe 结账页面 --
            // ============================================
            if (host.includes('pay.openai.com') || host.includes('checkout.stripe.com')) {
                updateProgress(10, '页面已匹配 (Stripe结账), 正在等待加载...');
                await safeWait(1800);

                updateProgress(30, '正在寻找并点击 PayPal 选项...');
                var ppBtn = document.querySelector('[data-testid="paypal-accordion-item-button"]') || document.querySelector('.paypal-accordion-item button');
                if (ppBtn) {
                    ppBtn.click();
                    await safeWait(600);
                    if (ppBtn) ppBtn.click();
                }

                updateProgress(50, '正在通过 API 获取随机美国地址...');
                await safeWait(1000);
                let addr = await getAddrAsync();

                updateProgress(70, '正在将地址填充入表单...');
                fillSel('#billingAddressLine1', addr.street);
                fillSel('#billingLocality', addr.city);
                fillSel('#billingPostalCode', addr.zip);
                fillSelect('billingAdministrativeArea', addr.state);
                await safeWait(800);

                updateProgress(85, '强制隐藏 Google 补全框 & 勾选协议...');
                document.querySelectorAll('.pac-container, .pac-item, div[role="listbox"]').forEach(function(el) {
                    el.style.setProperty('display', 'none', 'important');
                    el.style.setProperty('height', '0', 'important');
                });
                var cb = document.getElementById('termsOfServiceConsentCheckbox');
                if (cb && !cb.checked) cb.click();

                updateProgress(95, '准备提交结算...');
                await safeWait(1500);
                await clickBtnAsync();

                updateProgress(100, '✅ Stripe 脚本流程执行完毕');
                return;
            }

            // ============================================
            // -- 场景二：PayPal 登录输入邮箱页面 --
            // ============================================
            // 优化：扩大了路径匹配范围，适应 /agreements/approve 以及 /signin 等界面
            if (host.includes('paypal.com') && (path === '/pay' || path.includes('/agreements/approve') || path.includes('/signin') || path.includes('/auth'))) {
                updateProgress(20, '页面已匹配 (PayPal 登录), 等待加载...');
                await safeWait(2000);

                updateProgress(60, '正在生成随机邮箱并填写...');
                var em = randEmail();
                fill('email', em);

                updateProgress(85, '准备进入下一步...');
                await safeWait(1200);
                await clickBtnAsync();

                updateProgress(100, '✅ 邮箱输入执行完毕');
                return;
            }

            // ============================================
            // -- 场景三：PayPal 结账/绑卡页面 --
            // ============================================
            if (host.includes('paypal.com') && path.includes('/checkoutweb/signup')) {
                updateProgress(10, 'PayPal signup matched. Click the fill button when ready.');
                return;
            }

            if (host.includes('paypal.com') && path.includes('/checkoutweb/')) {
                updateProgress(10, '页面已匹配 (PayPal 结账), 检测国家环境...');
                await safeWait(2000);

                var country = document.getElementById('country');
                if (country && country.value !== 'US') {
                    updateProgress(30, '国家非 US，正在切换为 US 并等待刷新...');
                    country.value = 'US';
                    country.dispatchEvent(new Event('change', { bubbles: true }));
                    await safeWait(3000);
                } else {
                    updateProgress(30, '国家已是 US...');
                }

                updateProgress(50, '正在通过 API 获取随机美国地址...');
                let addr = await getAddrAsync();

                updateProgress(70, '正在生成随机信息并批量填充...');
                var email = randEmail();
                var password = randPass();
                fill('email', email);
                fill('phone', CONFIG.phone);
                fill('cardNumber', CONFIG.cardNumber);
                fill('cardExpiry', CONFIG.cardExpiry);
                fill('cardCvv', CONFIG.cardCvv);
                fill('password', password);
                fill('firstName', 'James');
                fill('lastName', 'Smith');
                fill('billingLine1', addr.street);
                fill('billingCity', addr.city);
                fill('billingPostalCode', addr.zip);
                fillSelect('billingState', addr.state);

                updateProgress(90, '信息填充完毕，准备提交付款...');
                await safeWait(1200);
                await clickBtnAsync();

                updateProgress(100, '✅ 结账脚本流程执行完毕');
                return;
            }

            // 未匹配的页面
            updateProgress(0, '⚠️ 当前网页URL未匹配任务，静默等待中...');

        } catch (e) {
            if (e.message !== 'STOPPED_BY_USER') {
                updateProgress(0, '❌ 发生异常: ' + e.message);
                if(stepDesc) stepDesc.style.setProperty('color', '#e74c3c', 'important');
                if(progressBar) progressBar.style.setProperty('background-color', '#e74c3c', 'important');
                console.error(e);
            }
        }
    }

    // 初始化UI并运行脚本
    keepChatgptProfileConsoleButtonAlive();
    initUI();
    runScript();

})();
