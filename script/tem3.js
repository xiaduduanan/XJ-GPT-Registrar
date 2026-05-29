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
// @grant        unsafeWindow
// @connect      meiguodizhi.com
// @connect      127.0.0.1
// @connect      localhost
// @connect      *
// @run-at       document-idle
// ==/UserScript==
// 使用 GM_getValue 读取本地保存的配置，如果没有则使用默认值
var CONFIG = {
    phone: typeof GM_getValue !== 'undefined' ? GM_getValue('pp_phone', '3502234709') : '3502234709',
    cardNumber: typeof GM_getValue !== 'undefined' ? GM_getValue('pp_cardNumber', '5436103552508504') : '5436103552508504',
    cardExpiry: typeof GM_getValue !== 'undefined' ? GM_getValue('pp_cardExpiry', '05 / 29') : '05 / 29',
    cardCvv: typeof GM_getValue !== 'undefined' ? GM_getValue('pp_cardCvv', '717') : '717',
    localApiBase: typeof GM_getValue !== 'undefined' ? GM_getValue('pp_email_manage_api_base', 'http://175.178.66.87:8000') : 'http://175.178.66.87:8000',
    outlookPlusApiKey: '',
    chatGptLoginEmail: '',
    chatGptEmailVerificationCode: ''
};

(function() {
    'use strict';

    // 全局运行状态：'RUNNING', 'PAUSED', 'STOPPED'
    var STATE = 'RUNNING';
    var currentOutlookAccount = null;
    var emailVerificationStartedAt = 0;
    var emailVerificationAutoFillRunning = false;

    // ========== 1. 悬浮窗及日志/进度系统 ==========
    var logBox, progressBar, progressText, stepDesc;
    function initUI() {
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
            #pp-btn-login { width:100% !important; margin-top:5px !important; padding:8px !important; border:none !important; border-radius:4px !important; cursor:pointer !important; font-weight:bold !important; background:#10a37f !important; color:#fff !important; transition:0.2s !important; display:none; font-size: 13px !important; font-family:sans-serif !important; }

            #pp-btn-login:disabled, #pp-btn-getlink:disabled, #pp-btn-copytoken:disabled, .pp-btn:disabled { opacity: 0.6 !important; cursor: not-allowed !important; }
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
                    <button id="pp-btn-login">🔐 跳转 ChatGPT 登录页</button>
                    <button id="pp-btn-getlink">🚀 自动获取 Plus 链接并跳转</button>
                    <button id="pp-btn-copytoken">📋 一键提取 Token 复制到剪贴板</button>
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
        var btnLogin = document.getElementById('pp-btn-login');
        var btnGetLink = document.getElementById('pp-btn-getlink');
        var btnCopyToken = document.getElementById('pp-btn-copytoken');
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
        if (window.location.host.includes('chatgpt.com')) {
            // 显示功能按钮
            btnLogin.style.setProperty('display', 'block', 'important');
            btnGetLink.style.setProperty('display', 'block', 'important');
            btnCopyToken.style.setProperty('display', 'block', 'important');

            btnLogin.addEventListener('click', async function() {
                if (STATE === 'STOPPED') return;
                btnLogin.disabled = true;
                try {
                    updateProgress(20, 'Claiming Outlook account...');
                    var account = await claimOutlookAccount();
                    log('Using Outlook account: ' + account.email);
                } catch (e) {
                    btnLogin.disabled = false;
                    updateProgress(0, '领取 Outlook 邮箱失败，请检查本地服务/号池');
                    log('领取 Outlook 邮箱失败，请检查本地服务/号池: ' + e.message);
                    return;
                }
                log('🔐 正在跳转 ChatGPT 登录页...');
                updateProgress(100, '正在跳转 ChatGPT 登录页...');
                window.location.href = 'https://chatgpt.com/auth/login';
            });

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

        // ====== 暂停/中止 按钮事件 ======
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

    function normalizeLocalApiBase() {
        return String(CONFIG.localApiBase || 'http://127.0.0.1:8000').replace(/\/+$/, '');
    }

    function parseStoredOutlookAccount(raw) {
        if (!raw) return null;
        try {
            var account = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (account && account.email) {
                return {
                    id: account.id || account.account_id || null,
                    account_id: account.account_id || account.id || null,
                    email: String(account.email),
                    claim_token: account.claim_token || '',
                    caller_id: account.caller_id || '',
                    task_id: account.task_id || '',
                    claimed_at: account.claimed_at || '',
                };
            }
        } catch (e) {}
        return null;
    }

    function loadCurrentOutlookAccount() {
        if (currentOutlookAccount && currentOutlookAccount.email) return currentOutlookAccount;
        if (typeof GM_getValue === 'undefined') return null;
        currentOutlookAccount = parseStoredOutlookAccount(GM_getValue('pp_current_outlook_account', null));
        return currentOutlookAccount;
    }

    function saveCurrentOutlookAccount(account) {
        currentOutlookAccount = {
            id: account.id || account.account_id || null,
            account_id: account.account_id || account.id || null,
            email: String(account.email),
            claim_token: account.claim_token || '',
            caller_id: account.caller_id || '',
            task_id: account.task_id || '',
            claimed_at: account.claimed_at || '',
        };
        if (typeof GM_setValue !== 'undefined') {
            GM_setValue('pp_current_outlook_account', JSON.stringify(currentOutlookAccount));
        }
        return currentOutlookAccount;
    }

    function clearCurrentOutlookAccount() {
        currentOutlookAccount = null;
        if (typeof GM_setValue !== 'undefined') {
            GM_setValue('pp_current_outlook_account', '');
        }
    }

    function parseStoredPlusMarkPending(raw) {
        if (!raw) return null;
        try {
            var pending = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (pending && pending.email) {
                return {
                    id: pending.id || pending.account_id || pending.mailbox_id || null,
                    account_id: pending.account_id || pending.mailbox_id || pending.id || null,
                    mailbox_id: pending.mailbox_id || pending.account_id || pending.id || null,
                    email: String(pending.email),
                    caller_id: pending.caller_id || '',
                    submitted_at: pending.submitted_at || '',
                    submitted_ts: Number(pending.submitted_ts || 0),
                    expired_logged: !!pending.expired_logged,
                };
            }
        } catch (e) {}
        return null;
    }

    function loadPlusMarkPending() {
        if (typeof GM_getValue === 'undefined') return null;
        return parseStoredPlusMarkPending(GM_getValue('pp_plus_mark_pending', null));
    }

    function savePlusMarkPending(pending) {
        if (typeof GM_setValue !== 'undefined') {
            GM_setValue('pp_plus_mark_pending', JSON.stringify(pending || {}));
        }
        return pending;
    }

    function clearPlusMarkPending() {
        if (typeof GM_setValue !== 'undefined') {
            GM_setValue('pp_plus_mark_pending', '');
        }
    }

    function savePlusMarkPendingFromCurrentAccount() {
        var account = loadCurrentOutlookAccount();
        if (!account || !account.email) {
            log('未找到当前 Outlook 邮箱，无法保存 Plus 待确认状态');
            return false;
        }
        var pending = savePlusMarkPending({
            id: account.id,
            account_id: account.account_id || account.id,
            mailbox_id: account.account_id || account.id,
            email: account.email,
            caller_id: account.caller_id || '',
            submitted_at: new Date().toISOString(),
            submitted_ts: Date.now() / 1000,
            expired_logged: false,
        });
        log('已保存 Plus 状态待确认: ' + pending.email);
        return true;
    }

    function saveEmailVerificationStartedAt(ts) {
        emailVerificationStartedAt = ts || (Date.now() / 1000);
        if (typeof GM_setValue !== 'undefined') {
            GM_setValue('pp_email_verification_started_at', String(emailVerificationStartedAt));
        }
        return emailVerificationStartedAt;
    }

    function loadEmailVerificationStartedAt() {
        if (emailVerificationStartedAt) return emailVerificationStartedAt;
        if (typeof GM_getValue !== 'undefined') {
            var raw = parseFloat(GM_getValue('pp_email_verification_started_at', '0'));
            if (raw > 0) emailVerificationStartedAt = raw;
        }
        return emailVerificationStartedAt;
    }

    function parseEmailVerificationResendState(raw) {
        if (!raw) return null;
        try {
            var state = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (!state || !state.email) return null;
            return {
                email: String(state.email),
                mailbox_id: state.mailbox_id || state.account_id || state.id || null,
                started_at: Number(state.started_at || 0),
                resend_count: Math.max(0, parseInt(state.resend_count || 0, 10) || 0),
                last_resend_at: Number(state.last_resend_at || 0),
            };
        } catch (e) {}
        return null;
    }

    function loadEmailVerificationResendState(account, startedAt) {
        if (typeof GM_getValue === 'undefined') return null;
        var state = parseEmailVerificationResendState(GM_getValue('pp_email_verification_resend_state', null));
        if (!state) return null;

        var accountEmail = account && account.email ? String(account.email).toLowerCase() : '';
        if (accountEmail && String(state.email).toLowerCase() !== accountEmail) return null;

        var mailboxId = getNumericOutlookAccountId(account);
        if (mailboxId && state.mailbox_id && String(state.mailbox_id) !== String(mailboxId)) return null;

        if (startedAt && state.started_at && Math.abs(Number(startedAt) - Number(state.started_at)) > 2) return null;
        return state;
    }

    function saveEmailVerificationResendState(account, startedAt, resendCount, lastResendAt) {
        var state = {
            email: account && account.email ? String(account.email) : '',
            mailbox_id: getNumericOutlookAccountId(account),
            started_at: Number(startedAt || 0),
            resend_count: Math.max(0, parseInt(resendCount || 0, 10) || 0),
            last_resend_at: Number(lastResendAt || 0),
        };
        if (typeof GM_setValue !== 'undefined') {
            GM_setValue('pp_email_verification_resend_state', JSON.stringify(state));
        }
        return state;
    }

    function clearEmailVerificationResendState() {
        if (typeof GM_setValue !== 'undefined') {
            GM_setValue('pp_email_verification_resend_state', '');
        }
    }

    function buildQuery(params) {
        var pairs = [];
        Object.keys(params || {}).forEach(function(key) {
            var value = params[key];
            if (value === undefined || value === null || value === '') return;
            pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
        });
        return pairs.length ? '?' + pairs.join('&') : '';
    }

    function externalApiJson(method, path, payload, timeoutMs) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest === 'undefined') {
                reject(new Error('GM_xmlhttpRequest is unavailable'));
                return;
            }

            var httpMethod = String(method || 'GET').toUpperCase();
            var headers = { 'Accept': 'application/json' };
            if (CONFIG.outlookPlusApiKey) headers['X-API-Key'] = CONFIG.outlookPlusApiKey;
            var url = normalizeLocalApiBase() + path;
            var data = undefined;
            if (httpMethod === 'GET') {
                url += buildQuery(payload || {});
            } else {
                headers['Content-Type'] = 'application/json';
                data = JSON.stringify(payload || {});
            }

            GM_xmlhttpRequest({
                method: httpMethod,
                url: url,
                headers: headers,
                data: data,
                timeout: timeoutMs || 20000,
                onload: function(r) {
                    var data = null;
                    try {
                        data = JSON.parse(r.responseText || '{}');
                    } catch (e) {
                        reject(new Error('Local API returned invalid JSON: HTTP ' + r.status));
                        return;
                    }

                    if (r.status < 200 || r.status >= 300 || data.ok === false || data.success === false) {
                        var detail = data.error || data.message || data.code || JSON.stringify(data).slice(0, 500) || r.responseText || 'Local API returned failure';
                        reject(new Error('HTTP ' + r.status + ' ' + detail));
                        return;
                    }
                    resolve(data);
                },
                onerror: function() {
                    reject(new Error('Local API request failed'));
                },
                ontimeout: function() {
                    reject(new Error('Local API request timeout'));
                },
            });
        });
    }

    function parseEmailManageMailbox(raw) {
        var mailbox = (raw && (raw.mailbox || raw.account || raw.item)) || raw;
        if (!mailbox || !mailbox.email) return null;
        return saveCurrentOutlookAccount({
            id: mailbox.id || mailbox.mailbox_id || mailbox.account_id,
            account_id: mailbox.id || mailbox.mailbox_id || mailbox.account_id,
            email: mailbox.email,
            claim_token: '',
            caller_id: 'emailManage-mailbox',
            task_id: '',
            claimed_at: mailbox.claimed_at || new Date().toISOString(),
        });
    }

    async function claimOutlookAccount() {
        try {
            var mailboxData = await externalApiJson('POST', '/api/mailboxes/claim', {}, 20000);
            var mailboxAccount = parseEmailManageMailbox(mailboxData);
            if (mailboxAccount && mailboxAccount.email) {
                log('emailManage mailbox selected: ' + mailboxAccount.email + ', id=' + mailboxAccount.account_id);
                return mailboxAccount;
            }
            throw new Error('emailManage claim returned no mailbox');
        } catch (e) {
            log('领取 emailManage 邮箱失败，尝试本项目 Outlook pool fallback: ' + e.message);
        }

        try {
            var data = await externalApiJson('POST', '/api/outlook/pool/claim', {}, 20000);
            var claimed = data && data.account;
            if (claimed && claimed.email) {
                var account = saveCurrentOutlookAccount({
                    id: claimed.id,
                    account_id: claimed.id,
                    email: claimed.email,
                    claim_token: '',
                    caller_id: 'outlook-pool',
                    task_id: '',
                    claimed_at: claimed.claimed_at || new Date().toISOString(),
                });
                log('Outlook pool account selected: ' + account.email + ', id=' + account.account_id);
                return account;
            }
            throw new Error((data && data.error) || 'Outlook pool returned no account');
        } catch (e) {
            log('领取 Outlook 号池账号失败，尝试 direct fallback: ' + e.message);
        }

        var account = saveCurrentOutlookAccount({
            id: 'direct',
            account_id: 'direct',
            email: 'ArtaLioi368326@hotmail.com',
            claim_token: '',
            caller_id: 'emailManage-direct',
            task_id: '',
            claimed_at: new Date().toISOString(),
        });
        log('emailManage direct account selected');
        return account;
    }

    async function ensureOutlookAccount() {
        var account = loadCurrentOutlookAccount();
        if (account && account.caller_id === 'emailManage-direct' && normalizeLocalApiBase().includes('175.178.66.87')) {
            clearCurrentOutlookAccount();
            account = null;
        }
        if (account && account.email && account.claimed_at) return account;
        if (account && account.email) clearCurrentOutlookAccount();
        return await claimOutlookAccount();
    }

    function getNumericOutlookAccountId(account) {
        var rawId = account && (account.account_id || account.id);
        if (rawId === undefined || rawId === null || rawId === '') return null;
        if (!/^\d+$/.test(String(rawId))) return null;
        return parseInt(rawId, 10);
    }

    async function findOutlookPoolIdByEmail(email) {
        if (!email) return null;
        var data = await externalApiJson('GET', '/api/outlook/pool', {
            q: email,
            limit: 20,
        }, 20000);
        var target = String(email).toLowerCase();
        var items = Array.isArray(data && data.items) ? data.items : [];
        var row = items.find(function(item) {
            return item && String(item.email || '').toLowerCase() === target;
        });
        return row && row.id ? parseInt(row.id, 10) : null;
    }

    async function markOutlookAccountPlusCreated(account) {
        if (!account || !account.email) {
            log('未找到当前 Outlook 邮箱，跳过 GPT Plus 状态更新');
            return false;
        }

        try {
            var rowId = getNumericOutlookAccountId(account);
            if (rowId) {
                try {
                    await externalApiJson('POST', '/api/mailboxes/' + encodeURIComponent(String(rowId)) + '/flags', {
                        is_registered_gpt: true,
                        is_plus: true,
                    }, 20000);
                    log('✅ 已更新 emailManage 邮箱状态为 GPT 已注册 / Plus 已开通: ' + account.email);
                    return true;
                } catch (e) {
                    log('emailManage flags 更新失败，尝试本项目 Outlook pool fallback: ' + e.message);
                }
            }

            if (!rowId) rowId = await findOutlookPoolIdByEmail(account.email);
            if (!rowId) {
                log('未在号池中找到当前邮箱，无法标记 GPT Plus: ' + account.email);
                return false;
            }

            var data = await externalApiJson('PATCH', '/api/outlook/pool/' + encodeURIComponent(String(rowId)), {
                status: 'used',
                has_gptplus: true,
            }, 20000);
            saveCurrentOutlookAccount(Object.assign({}, account, {
                id: rowId,
                account_id: rowId,
            }));
            log('✅ 已更新邮箱 GPT 状态为已创建 Plus: ' + ((data && data.item && data.item.email) || account.email));
            return true;
        } catch (e) {
            log('❌ 更新邮箱 GPT Plus 状态失败: ' + e.message);
            return false;
        }
    }

    async function markCurrentOutlookAccountPlusCreated() {
        return await markOutlookAccountPlusCreated(loadCurrentOutlookAccount());
    }

    function containsPaidPlanSignal(value, parentKey, depth) {
        if (depth > 8 || value === null || value === undefined) return false;
        var key = String(parentKey || '').toLowerCase();
        var paidWords = ['plus', 'pro', 'team', 'enterprise', 'business'];
        if (typeof value === 'boolean') {
            return value === true && (
                key.includes('plus') ||
                key.includes('paid') ||
                key.includes('subscriber') ||
                key.includes('subscription')
            );
        }
        if (typeof value === 'string') {
            var text = value.toLowerCase();
            var keyLooksRelevant = key.includes('plan') || key.includes('subscription') || key.includes('sku') || key.includes('product') || key.includes('account');
            return keyLooksRelevant && paidWords.some(function(word) {
                return text.includes(word);
            }) && !text.includes('free');
        }
        if (Array.isArray(value)) {
            return value.some(function(item) {
                return containsPaidPlanSignal(item, parentKey, depth + 1);
            });
        }
        if (typeof value === 'object') {
            return Object.keys(value).some(function(childKey) {
                return containsPaidPlanSignal(value[childKey], childKey, depth + 1);
            });
        }
        return false;
    }

    async function hasChatGptPaidPlanFromApi() {
        var endpoints = [
            '/backend-api/accounts/check/v4-2023-04-27',
            '/backend-api/settings/user',
        ];
        for (var i = 0; i < endpoints.length; i++) {
            try {
                var response = await fetch(endpoints[i], { credentials: 'include' });
                if (!response || !response.ok) continue;
                var data = await response.json();
                if (containsPaidPlanSignal(data, '', 0)) return true;
            } catch (e) {}
        }
        return false;
    }

    function hasVisiblePlusSuccessSignal() {
        var href = String(window.location.href || '').toLowerCase();
        if (
            (href.includes('success') || href.includes('complete')) &&
            (href.includes('payment') || href.includes('checkout') || href.includes('subscription') || href.includes('plus'))
        ) {
            return true;
        }
        var text = ((document.body && document.body.innerText) || '').slice(0, 12000).toLowerCase();
        var signals = [
            'payment successful',
            'payment complete',
            'subscription active',
            'you are now subscribed',
            "you're now subscribed",
            'welcome to chatgpt plus',
            'plus is active',
            '付款成功',
            '订阅已激活',
            '已开通 plus',
            'plus 已开通',
        ];
        return signals.some(function(signal) {
            return text.includes(signal);
        });
    }

    async function checkAndMarkPendingPlusIfReady() {
        var pending = loadPlusMarkPending();
        if (!pending || !pending.email) return false;

        var submittedTs = pending.submitted_ts || (pending.submitted_at ? Date.parse(pending.submitted_at) / 1000 : 0);
        var ageSeconds = submittedTs ? (Date.now() / 1000 - submittedTs) : 0;
        if (ageSeconds > 6 * 60 * 60) {
            if (!pending.expired_logged) {
                pending.expired_logged = true;
                savePlusMarkPending(pending);
                log('Plus 待确认状态已超过 6 小时，暂不自动标记: ' + pending.email);
            }
            return false;
        }

        var success = false;
        if (window.location.host.includes('chatgpt.com') || window.location.host.includes('chat.openai.com')) {
            success = await hasChatGptPaidPlanFromApi();
        }
        if (!success) success = hasVisiblePlusSuccessSignal();
        if (!success) {
            log('Plus 待确认中，尚未检测到成功信号: ' + pending.email);
            return false;
        }

        var marked = await markOutlookAccountPlusCreated(pending);
        if (marked) {
            clearPlusMarkPending();
            log('已清除 Plus 待确认状态: ' + pending.email);
        }
        return marked;
    }

    function stripHtmlForOtp(text) {
        var raw = String(text || '');
        if (!raw) return '';
        return raw
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&amp;/gi, '&')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&#(\d+);/g, function(_, n) { return String.fromCharCode(parseInt(n, 10)); })
            .replace(/\s+/g, ' ')
            .trim();
    }

    function extractSixDigitOtpFromText(text) {
        var normalized = stripHtmlForOtp(text);
        if (!normalized) return '';

        var keywords = ['验证码', '临时', 'temporary', 'verification', 'verify', 'code', 'otp'];
        var lower = normalized.toLowerCase();
        for (var i = 0; i < keywords.length; i++) {
            var keyword = keywords[i].toLowerCase();
            var pos = lower.indexOf(keyword);
            while (pos !== -1) {
                var start = Math.max(0, pos - 80);
                var end = Math.min(normalized.length, pos + keyword.length + 160);
                var nearby = normalized.slice(start, end).match(/\b\d{6}\b/);
                if (nearby) return nearby[0];
                pos = lower.indexOf(keyword, pos + keyword.length);
            }
        }

        var first = normalized.match(/\b\d{6}\b/);
        return first ? first[0] : '';
    }

    async function fetchOutlookOtpFromLatestMessage(email) {
        var account = loadCurrentOutlookAccount() || {};
        if (!account.account_id && !account.id) {
            throw new Error('missing emailManage mailbox id');
        }

        var mailboxId = account.account_id || account.id;
        var messages = await externalApiJson('GET', '/api/mailboxes/' + encodeURIComponent(String(mailboxId)) + '/messages', {
            limit: 10,
            after_claim: 'true',
        }, 20000);
        if (!Array.isArray(messages) || !messages.length) {
            throw new Error('emailManage returned no messages');
        }

        var latest = messages[0];
        var messageId = latest && latest.id;
        if (!messageId) {
            throw new Error('latest message did not include id');
        }

        var detail = await externalApiJson('GET', '/api/messages/' + encodeURIComponent(String(messageId)), {}, 20000);
        var sourceText = [
            detail && detail.subject,
            detail && detail.text_body,
            detail && detail.html_body,
            detail && detail.code,
            latest && latest.subject,
            latest && latest.code,
        ].filter(Boolean).join(' ');
        var otp = extractSixDigitOtpFromText(sourceText);
        if (!otp) {
            throw new Error('emailManage messages detail fallback found no 6-digit otp');
        }
        log('Outlook OTP source: emailManage messages detail fallback, message_id=' + messageId);
        return otp;
    }

    function extractOtpFromEmailManageMessages(messages, afterTs) {
        for (var i = 0; i < messages.length; i++) {
            var item = messages[i] || {};
            if (afterTs && !isEmailManageMessageFresh(item, afterTs)) continue;
            var sourceText = [
                item.subject,
                item.text_body,
                item.html_body,
                item.body,
                item.preview,
                item.code,
            ].filter(Boolean).join(' ');
            var otp = extractSixDigitOtpFromText(sourceText);
            if (otp) return otp;
        }
        return '';
    }

    function isEmailManageMessageFresh(message, afterTs) {
        if (!message || !afterTs) return true;
        var rawTs = message.sent_at || message.sentAt || message.received_at || message.receivedAt ||
            message.created_at || message.createdAt || message.date || message.receivedDateTime || '';
        if (!rawTs) return true;
        var sentMs = Date.parse(rawTs);
        if (!sentMs) return true;
        return sentMs / 1000 >= afterTs - 5;
    }

    async function logEmailManageMailboxStatus(mailboxId) {
        try {
            var mailboxData = await externalApiJson('GET', '/api/mailboxes', {}, 20000);
            var mailboxes = Array.isArray(mailboxData) ? mailboxData :
                (Array.isArray(mailboxData && mailboxData.items) ? mailboxData.items :
                (Array.isArray(mailboxData && mailboxData.mailboxes) ? mailboxData.mailboxes : []));
            if (!mailboxes.length) return;
            var mailbox = mailboxes.find(function(item) {
                return item && String(item.id) === String(mailboxId);
            });
            if (!mailbox) return;
            log('emailManage mailbox status: id=' + mailboxId +
                ', status=' + (mailbox.status || '-') +
                ', latest_code=' + (mailbox.latest_code || '-') +
                ', last_error=' + (mailbox.last_error || '-'));
        } catch (e) {}
    }

    async function fetchEmailManageMailboxOtp(email, afterTs, maxWait, pollInterval) {
        var account = loadCurrentOutlookAccount() || {};
        var mailboxId = getNumericOutlookAccountId(account);
        if (!mailboxId) {
            throw new Error('missing numeric emailManage mailbox id');
        }

        var deadline = Date.now() + maxWait * 1000;
        var lastError = '';
        while (Date.now() < deadline) {
            if (STATE === 'STOPPED') throw new Error('STOPPED_BY_USER');

            try {
                await externalApiJson('POST', '/api/mailboxes/' + encodeURIComponent(String(mailboxId)) + '/sync', {}, 30000);
            } catch (e) {
                lastError = e.message;
                log('emailManage mailbox sync failed: ' + e.message);
                await logEmailManageMailboxStatus(mailboxId);
            }

            try {
                var codeData = await externalApiJson('GET', '/api/mailboxes/' + encodeURIComponent(String(mailboxId)) + '/code', {}, 20000);
                var message = (codeData && (codeData.message || codeData.item || codeData.mail)) || codeData;
                var codeOtp = String((message && (message.code || message.otp || message.latest_code)) || '').replace(/\D/g, '');
                if (codeOtp && codeOtp.length === 6 && isEmailManageMessageFresh(message, afterTs)) {
                    log('Outlook OTP source: emailManage mailbox code endpoint, email=' + email + ', id=' + mailboxId);
                    return codeOtp;
                }
            } catch (eCode) {
                lastError = eCode.message;
            }

            try {
                var messages = await externalApiJson('GET', '/api/mailboxes/' + encodeURIComponent(String(mailboxId)) + '/messages', {
                    limit: 10,
                    after_claim: 'true',
                }, 20000);
                var messageItems = Array.isArray(messages) ? messages :
                    (Array.isArray(messages && messages.items) ? messages.items :
                    (Array.isArray(messages && messages.messages) ? messages.messages : []));
                if (messageItems.length) {
                    var otp = extractOtpFromEmailManageMessages(messageItems, afterTs);
                    if (otp) {
                        log('Outlook OTP source: emailManage mailbox messages, email=' + email + ', id=' + mailboxId);
                        return otp;
                    }
                }
            } catch (e2) {
                lastError = e2.message;
            }

            await safeWait(pollInterval * 1000);
        }

        throw new Error('emailManage mailbox OTP not found' + (lastError ? ': ' + lastError : ''));
    }

    async function fetchOutlookOtp(email, options) {
        options = options || {};
        var afterTs = loadEmailVerificationStartedAt() || (Date.now() / 1000);
        var maxWait = options.maxWait || 60;
        var pollInterval = options.pollInterval || 3;

        if (STATE === 'STOPPED') throw new Error('STOPPED_BY_USER');

        var account = loadCurrentOutlookAccount() || {};
        if (getNumericOutlookAccountId(account)) {
            return await fetchEmailManageMailboxOtp(email, afterTs, maxWait, pollInterval);
        }

        try {
            var data = await externalApiJson('POST', '/api/direct/latest-code', {
                after_ts: afterTs,
                max_wait: maxWait,
                poll_interval: pollInterval,
                settle_seconds: 2,
            }, (maxWait + 10) * 1000);
            var otp = String((data && data.otp) || '').replace(/\D/g, '');
            if (otp) {
                log('Outlook OTP source: emailManage direct latest-code, email=' + ((data && data.email) || email));
                return otp;
            }
            throw new Error('emailManage direct latest-code returned empty otp');
        } catch (e) {
            if (normalizeLocalApiBase().includes('175.178.66.87')) throw e;
            log('emailManage direct 取码失败，尝试本项目 Outlook fallback: ' + e.message);
        }

        var localData = await externalApiJson('POST', '/api/outlook/latest-otp', {
            email: email,
            after_ts: afterTs,
            max_wait: maxWait,
            poll_interval: pollInterval,
        }, (maxWait + 10) * 1000);
        var localOtp = String((localData && localData.otp) || '').replace(/\D/g, '');
        if (!localOtp) {
            throw new Error('local outlook latest-otp returned empty otp');
        }
        log('Outlook OTP source: local outlook pool, email=' + ((localData && localData.email) || email));
        return localOtp;
    }

    let chatGptLoginClicked = false;

    function findVisibleChatGptLoginButton() {
        const buttons = Array.from(document.querySelectorAll('button[data-testid="login-button"]'));
        for (const btn of buttons) {
            const rect = btn.getBoundingClientRect();
            if (btn.disabled || rect.width <= 0 || rect.height <= 0) continue;
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const topEl = document.elementFromPoint(cx, cy);
            if (topEl && (topEl === btn || btn.contains(topEl))) return btn;
        }
        return null;
    }

    function dispatchMouseLikeEvent(target, type, x, y) {
        const eventInit = {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            button: 0,
            buttons: type === 'mouseup' || type === 'click' ? 0 : 1,
        };
        let event;
        if (type.startsWith('pointer') && typeof PointerEvent !== 'undefined') {
            event = new PointerEvent(type, {
                ...eventInit,
                pointerId: 1,
                pointerType: 'mouse',
                isPrimary: true,
            });
        } else {
            event = new MouseEvent(type, eventInit);
        }
        target.dispatchEvent(event);
    }

    function robustClickElement(el) {
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.focus({ preventScroll: true });
        const rect = el.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const target = document.elementFromPoint(x, y) || el;

        dispatchMouseLikeEvent(target, 'pointerover', x, y);
        dispatchMouseLikeEvent(target, 'pointerenter', x, y);
        dispatchMouseLikeEvent(target, 'mouseover', x, y);
        dispatchMouseLikeEvent(target, 'mouseenter', x, y);
        dispatchMouseLikeEvent(target, 'pointerdown', x, y);
        dispatchMouseLikeEvent(target, 'mousedown', x, y);
        dispatchMouseLikeEvent(target, 'pointerup', x, y);
        dispatchMouseLikeEvent(target, 'mouseup', x, y);
        dispatchMouseLikeEvent(target, 'click', x, y);
        el.click();
    }

    function isChatGptLoginFlowStarted(beforeHref) {
        if (window.location.href !== beforeHref) return true;
        if (document.querySelector('input[type="email"], input[name="email"], input#email')) return true;
        if (document.querySelector('[role="dialog"] input[type="email"], [data-testid*="login"] input')) return true;
        return false;
    }

    function fallbackToChatGptLogin(beforeHref) {
        if (STATE === 'STOPPED' || isChatGptLoginFlowStarted(beforeHref)) return;

        const loginLink = document.querySelector(
            'a[href*="/auth/login"], a[href*="auth.openai.com"], a[href*="/log-in"], a[href*="/login"]'
        );
        if (loginLink && loginLink.href) {
            log('ChatGPT 登录按钮点击无页面变化，改为跳转登录链接: ' + loginLink.href);
            window.location.assign(loginLink.href);
            return;
        }

        log('ChatGPT 登录按钮点击无页面变化，改为跳转 /auth/login');
        window.location.assign('https://chatgpt.com/auth/login');
    }

    async function autoClickChatGptLoginButton() {
        if (chatGptLoginClicked || STATE === 'STOPPED') return;

        const clickIfReady = () => {
            if (chatGptLoginClicked || STATE === 'STOPPED') return true;
            const btn = findVisibleChatGptLoginButton();
            if (!btn) return false;
            chatGptLoginClicked = true;
            const beforeHref = window.location.href;
            robustClickElement(btn);
            setTimeout(() => fallbackToChatGptLogin(beforeHref), 1200);
            updateProgress(100, '已自动点击登录按钮，请手动输入账号密码');
            log('✅ 已自动点击 ChatGPT 登录按钮');
            return true;
        };

        if (clickIfReady()) return;
        updateProgress(15, '正在等待 ChatGPT 登录按钮渲染...');

        await new Promise((resolve) => {
            const timeoutMs = 15000;
            let done = false;

            const finish = (message) => {
                if (done) return;
                done = true;
                observer.disconnect();
                clearInterval(intervalId);
                clearTimeout(timeoutId);
                if (message) log(message);
                resolve();
            };

            const observer = new MutationObserver(() => {
                if (clickIfReady()) finish();
            });

            observer.observe(document.documentElement || document.body, {
                childList: true,
                subtree: true,
                attributes: true,
            });

            const intervalId = setInterval(() => {
                if (STATE === 'STOPPED') {
                    finish('ChatGPT 登录按钮等待已中止');
                    return;
                }
                if (clickIfReady()) finish();
            }, 500);

            const timeoutId = setTimeout(() => {
                updateProgress(10, '未找到登录按钮，可能已登录或页面结构变化');
                finish('未找到 ChatGPT 登录按钮，可能已登录或页面结构变化');
            }, timeoutMs);
        });
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

            // 构造 Payload
            const payload = {
                plan_name: "chatgptplusplan",
                billing_details: { country: "US", currency: "USD" },
                cancel_url: "https://chatgpt.com/#pricing",
                promo_campaign: { promo_campaign_id: "plus-1-month-free", is_coupon_from_query_param: false },
                checkout_ui_mode: "hosted",
            };

            // 发送请求
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

    function getVisibleChatGptEmailInput() {
        var inputs = Array.from(document.querySelectorAll('input#email, input[name="email"], input[type="email"]'));
        return inputs.find(function(input) {
            var rect = input.getBoundingClientRect();
            return !input.disabled && rect.width > 0 && rect.height > 0;
        }) || null;
    }

    function findChatGptContinueButton() {
        var emailInput = getVisibleChatGptEmailInput();
        var form = emailInput ? emailInput.closest('form') : null;
        var btn = form ? form.querySelector('button[type="submit"]') : null;
        if (!btn && form) btn = form.querySelector('button');

        if (!btn) {
            btn = document.querySelector('form input#email, form input[name="email"], form input[type="email"]')
                ?.closest('form')
                ?.querySelector('button[type="submit"], button');
        }

        if (!btn) return null;
        var rect = btn.getBoundingClientRect();
        if (btn.disabled || rect.width <= 0 || rect.height <= 0) return null;
        return btn;
    }

    function fillChatGptEmailInput(emailInput, email) {
        emailInput.scrollIntoView({ block: 'center', inline: 'center' });
        emailInput.focus();
        emailInput.click();
        var inputWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : (emailInput.ownerDocument && emailInput.ownerDocument.defaultView ? emailInput.ownerDocument.defaultView : window);
        var ns = Object.getOwnPropertyDescriptor(inputWindow.HTMLInputElement.prototype, 'value').set;
        ns.call(emailInput, email);
        emailInput.setAttribute('value', email);
        emailInput.dispatchEvent(new inputWindow.InputEvent('beforeinput', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertText',
            data: email,
        }));
        emailInput.dispatchEvent(new inputWindow.InputEvent('input', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertText',
            data: email,
        }));
        emailInput.dispatchEvent(new inputWindow.Event('change', { bubbles: true }));
    }

    async function autoFillChatGptLoginEmail() {
        var maxWait = 15000;
        var waited = 0;
        var step = 300;
        var emailFilled = false;
        var account;
        var loginEmail;

        try {
            account = await ensureOutlookAccount();
            loginEmail = account.email;
            log('Using Outlook account for ChatGPT login: ' + loginEmail);
        } catch (e) {
            updateProgress(0, '领取 Outlook 邮箱失败，请检查本地服务/号池');
            log('领取 Outlook 邮箱失败，请检查本地服务/号池: ' + e.message);
            return false;
        }

        while (waited < maxWait) {
            if (STATE === 'STOPPED') return false;

            var emailInput = getVisibleChatGptEmailInput();

            if (emailInput && (!emailFilled || emailInput.value !== loginEmail)) {
                fillChatGptEmailInput(emailInput, loginEmail);
                emailFilled = emailInput.value === loginEmail;
                updateProgress(45, '已填写 ChatGPT 邮箱，等待继续按钮...');
                log('✅ 已填写 ChatGPT 邮箱: ' + loginEmail + '，当前输入框值: ' + emailInput.value);
            }

            var continueBtn = findChatGptContinueButton();
            if (emailInput && emailInput.value === loginEmail && continueBtn) {
                await safeWait(800);
                if (emailInput.value !== loginEmail) {
                    emailFilled = false;
                    continue;
                }
                var verificationStartedAt = saveEmailVerificationStartedAt(Date.now() / 1000);
                saveEmailVerificationResendState(account, verificationStartedAt, 0, 0);
                robustClickElement(continueBtn);
                updateProgress(100, '已填写 ChatGPT 邮箱并点击继续');
                log('✅ 已点击邮箱表单的继续按钮');
                return true;
            }

            await safeWait(step);
            waited += step;
        }

        updateProgress(10, '未找到 ChatGPT 邮箱输入框或继续按钮');
        log('未找到 ChatGPT 邮箱输入框或继续按钮');
        return false;
    }

    function setElementTextLikeInput(el, value) {
        if (!el) return false;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.click();
        var elWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : (el.ownerDocument && el.ownerDocument.defaultView ? el.ownerDocument.defaultView : window);

        if (!('value' in el)) {
            try {
                el.focus();
                elWindow.document.execCommand('selectAll', false, null);
                elWindow.document.execCommand('insertText', false, value);
            } catch (e) {}

            for (var i = 0; i < value.length; i++) {
                var ch = value[i];
                el.dispatchEvent(new elWindow.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: ch, code: 'Digit' + ch }));
                el.dispatchEvent(new elWindow.KeyboardEvent('keypress', { bubbles: true, cancelable: true, key: ch, code: 'Digit' + ch }));
                el.dispatchEvent(new elWindow.InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: ch }));
                el.dispatchEvent(new elWindow.InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: ch }));
                el.dispatchEvent(new elWindow.KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: ch, code: 'Digit' + ch }));
            }
            el.dispatchEvent(new elWindow.Event('change', { bubbles: true }));
            return true;
        }

        el.focus();
        if ('value' in el) {
            var proto = el instanceof HTMLTextAreaElement ? elWindow.HTMLTextAreaElement.prototype : elWindow.HTMLInputElement.prototype;
            var setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            var lastValue = el.value;
            if (setter) setter.call(el, '');
            else el.value = '';
            if (el._valueTracker) el._valueTracker.setValue(lastValue);
            el.dispatchEvent(new elWindow.Event('input', { bubbles: true }));

            for (var j = 0; j < value.length; j++) {
                var nextValue = value.slice(0, j + 1);
                var ch2 = value[j];
                el.dispatchEvent(new elWindow.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: ch2, code: 'Digit' + ch2 }));
                el.dispatchEvent(new elWindow.InputEvent('beforeinput', {
                    bubbles: true,
                    cancelable: true,
                    inputType: 'insertText',
                    data: ch2,
                }));
                lastValue = el.value;
                if (setter) setter.call(el, nextValue);
                else el.value = nextValue;
                if (el._valueTracker) el._valueTracker.setValue(lastValue);
                el.dispatchEvent(new elWindow.InputEvent('input', {
                    bubbles: true,
                    cancelable: true,
                    inputType: 'insertText',
                    data: ch2,
                }));
                el.dispatchEvent(new elWindow.KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: ch2, code: 'Digit' + ch2 }));
            }
            el.dispatchEvent(new elWindow.Event('change', { bubbles: true }));
            return el.value === value;
        }

        try {
            el.dispatchEvent(new elWindow.InputEvent('beforeinput', {
                bubbles: true,
                cancelable: true,
                inputType: 'insertText',
                data: value,
            }));
            el.dispatchEvent(new elWindow.InputEvent('input', {
                bubbles: true,
                cancelable: true,
                inputType: 'insertText',
                data: value,
            }));
        } catch (e) {
            el.dispatchEvent(new elWindow.Event('input', { bubbles: true }));
        }
        el.dispatchEvent(new elWindow.Event('change', { bubbles: true }));
        return true;
    }

    function forceFillOtpInput(input, code) {
        if (!input) return false;
        var pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : (input.ownerDocument && input.ownerDocument.defaultView ? input.ownerDocument.defaultView : window);
        var setter = Object.getOwnPropertyDescriptor(pageWindow.HTMLInputElement.prototype, 'value')?.set;

        input.scrollIntoView({ block: 'center', inline: 'center' });
        input.focus();
        input.click();

        var oldValue = input.value;
        if (setter) setter.call(input, '');
        else input.value = '';
        input.setAttribute('value', '');
        if (input._valueTracker) input._valueTracker.setValue(oldValue);
        input.dispatchEvent(new pageWindow.Event('input', { bubbles: true }));

        for (var i = 0; i < code.length; i++) {
            var ch = code[i];
            var next = code.slice(0, i + 1);
            input.dispatchEvent(new pageWindow.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: ch, code: 'Digit' + ch }));
            input.dispatchEvent(new pageWindow.InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: ch }));
            oldValue = input.value;
            if (setter) setter.call(input, next);
            else input.value = next;
            input.setAttribute('value', next);
            if (input._valueTracker) input._valueTracker.setValue(oldValue);
            input.dispatchEvent(new pageWindow.InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: ch }));
            input.dispatchEvent(new pageWindow.KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: ch, code: 'Digit' + ch }));
        }

        input.dispatchEvent(new pageWindow.Event('change', { bubbles: true }));
        input.blur();
        input.focus();
        log('验证码 input 当前 value=' + input.value + ', attr=' + input.getAttribute('value'));
        return input.value === code;
    }

    function findEmailVerificationCodeInput() {
        var inputs = Array.from(document.querySelectorAll(
            'input#_r_5_-code, input[name="code"], input[autocomplete="one-time-code"], input[inputmode="numeric"]'
        ));
        return inputs.find(function(el) {
            var rect = el.getBoundingClientRect();
            return !el.disabled && rect.width > 0 && rect.height > 0;
        }) || null;
    }

    function getCurrentOtpValue() {
        var primary = findEmailVerificationCodeInput();
        if (primary && primary.value) return primary.value.replace(/\D/g, '');
        return '';
    }

    function findEmailVerificationCodeTarget() {
        var primary = findEmailVerificationCodeInput();
        if (primary) return primary;
        return null;
    }

    function fillSplitOtpInputs(code) {
        var primary = findEmailVerificationCodeInput();
        if (primary) {
            return forceFillOtpInput(primary, code);
        }
        log('未找到真实验证码 input[name="code"]，不会填 div 兜底');
        return false;
    }

    function isEmailVerificationResendButton(btn) {
        if (!btn) return false;
        var text = (btn.textContent || '').trim().toLowerCase();
        var name = (btn.getAttribute('name') || '').toLowerCase();
        var value = (btn.getAttribute('value') || '').toLowerCase();
        var rect = btn.getBoundingClientRect();
        return !btn.disabled && btn.getAttribute('aria-disabled') !== 'true' && rect.width > 0 && rect.height > 0 && (
            (name === 'intent' && value === 'resend') ||
            value === 'resend' ||
            text.includes('重新发送电子邮件') ||
            text.includes('重新发送') ||
            text.includes('resend email') ||
            text.includes('resend')
        );
    }

    function isEmailVerificationSubmitButton(btn) {
        if (!btn || isEmailVerificationResendButton(btn)) return false;
        var text = (btn.textContent || '').trim();
        var rect = btn.getBoundingClientRect();
        var value = (btn.getAttribute('value') || '').toLowerCase();
        return !btn.disabled && btn.getAttribute('aria-disabled') !== 'true' && rect.width > 0 && rect.height > 0 && (
            value === 'continue' ||
            value === 'verify' ||
            text.includes('继续') ||
            text.toLowerCase().includes('continue') ||
            text.includes('验证') ||
            text.toLowerCase().includes('verify')
        );
    }

    function findEmailVerificationResendButton() {
        var buttons = Array.from(document.querySelectorAll('button[type="submit"], button'));
        return buttons.find(function(btn) {
            return isEmailVerificationResendButton(btn);
        }) || null;
    }

    function findEmailVerificationSubmitButton() {
        var codeInput = findEmailVerificationCodeInput();
        var form = null;
        if (codeInput) {
            var formId = codeInput.getAttribute('form');
            form = formId ? document.getElementById(formId) : codeInput.closest('form');
        }
        var formButtons = form ? Array.from(form.querySelectorAll('button[type="submit"], button')) : [];
        var formButton = formButtons.find(function(btn) {
            return isEmailVerificationSubmitButton(btn);
        }) || null;
        if (formButton) return formButton;

        var buttons = Array.from(document.querySelectorAll('button[type="submit"], button'));
        return buttons.find(function(btn) {
            return isEmailVerificationSubmitButton(btn);
        }) || null;
    }

    function describeEmailVerificationElement(el) {
        if (!el) return 'missing';
        var rect = el.getBoundingClientRect();
        return [
            el.tagName.toLowerCase(),
            el.id ? '#' + el.id : '',
            el.name ? '[name="' + el.name + '"]' : '',
            el.getAttribute('type') ? '[type="' + el.getAttribute('type') + '"]' : '',
            el.disabled ? 'disabled' : 'enabled',
            Math.round(rect.width) + 'x' + Math.round(rect.height),
        ].filter(Boolean).join('');
    }

    function describeEmailVerificationButton(btn) {
        if (!btn) return 'missing';
        var rect = btn.getBoundingClientRect();
        return [
            'text="' + (btn.textContent || '').trim() + '"',
            btn.name ? '[name="' + btn.name + '"]' : '',
            btn.value ? '[value="' + btn.value + '"]' : '',
            btn.disabled ? 'disabled' : 'enabled',
            btn.getAttribute('aria-disabled') === 'true' ? 'aria-disabled=true' : '',
            Math.round(rect.width) + 'x' + Math.round(rect.height),
        ].filter(Boolean).join(', ');
    }

    async function autoFillEmailVerificationCodeWithResend() {
        if (emailVerificationAutoFillRunning) {
            log('邮箱验证码自动处理已在运行，本次 runScript 跳过，避免重复点击重新发送');
            return false;
        }
        emailVerificationAutoFillRunning = true;
        try {
            return await autoFillEmailVerificationCodeWithResendInner();
        } finally {
            emailVerificationAutoFillRunning = false;
        }
    }

    async function autoFillEmailVerificationCodeWithResendInner() {
        var nowSeconds = Date.now() / 1000;
        var startedAt = loadEmailVerificationStartedAt();
        if (!startedAt || nowSeconds - startedAt > 15 * 60) {
            startedAt = saveEmailVerificationStartedAt(nowSeconds);
        }
        var pageEnteredAt = nowSeconds;

        var account;
        try {
            account = await ensureOutlookAccount();
            updateProgress(20, '正在轮询 Outlook 验证码...');
            log('Email verification mailbox: ' + account.email + ', started_at=' + startedAt);
        } catch (e) {
            updateProgress(0, '领取 Outlook 邮箱失败，请手动输入验证码');
            log('领取 Outlook 邮箱失败，请手动输入验证码: ' + e.message);
            return false;
        }

        var maxWait = 180000;
        var waited = 0;
        var step = 300;
        var resendAfterSeconds = 90;
        var maxResends = 1;
        var minPageWaitBeforeResend = 20;
        var resendState = loadEmailVerificationResendState(account, startedAt);
        var resendCount = resendState ? resendState.resend_count : 0;
        if (!resendState) saveEmailVerificationResendState(account, startedAt, resendCount, 0);
        var code = '';
        var codeFilled = false;
        var otpFetchInFlight = null;
        var otpPollGeneration = 0;
        var nextOtpPollAt = 0;
        var lastOtpError = '';
        var lastDiagnostics = '';
        var resendMissingLoggedFor = -1;

        while (waited < maxWait) {
            if (STATE === 'STOPPED') return false;

            var input = findEmailVerificationCodeTarget();
            var submitBtn = findEmailVerificationSubmitButton();
            var resendBtn = findEmailVerificationResendButton();
            var currentValue = getCurrentOtpValue();
            var currentStartedAt = loadEmailVerificationStartedAt() || startedAt;
            var elapsedFromEmailStart = Date.now() / 1000 - currentStartedAt;
            var elapsedOnPage = Date.now() / 1000 - pageEnteredAt;

            var diagnostics = 'Email verification 状态: input=' + describeEmailVerificationElement(input) +
                ', submit=' + describeEmailVerificationButton(submitBtn) +
                ', resend=' + describeEmailVerificationButton(resendBtn) +
                ', resendCount=' + resendCount +
                ', lastOtpError=' + (lastOtpError || '-');
            if (diagnostics !== lastDiagnostics) {
                log(diagnostics);
                lastDiagnostics = diagnostics;
            }

            if (!code && currentValue.length === 6) {
                code = currentValue;
                codeFilled = true;
                log('检测到页面已有 6 位验证码，准备提交: ' + code);
            }

            if (!code && !otpFetchInFlight && Date.now() >= nextOtpPollAt) {
                var pollGeneration = otpPollGeneration;
                otpFetchInFlight = fetchOutlookOtp(account.email, { maxWait: 2, pollInterval: 1 })
                    .then(function(found) {
                        if (pollGeneration !== otpPollGeneration) return;
                        var normalized = String(found || '').replace(/\D/g, '');
                        if (normalized.length === 6) {
                            code = normalized;
                            codeFilled = false;
                            lastOtpError = '';
                            updateProgress(55, '已获取 Outlook 验证码，准备填入页面...');
                            log('Fetched Outlook OTP for ' + account.email + ': ' + code);
                        } else if (normalized) {
                            lastOtpError = '忽略非 6 位验证码: ' + normalized;
                        }
                    })
                    .catch(function(e) {
                        if (pollGeneration !== otpPollGeneration) return;
                        lastOtpError = e && e.message ? e.message : String(e);
                    })
                    .then(function() {
                        if (pollGeneration !== otpPollGeneration) return;
                        otpFetchInFlight = null;
                        nextOtpPollAt = Date.now() + 5000;
                    });
            }

            if (code && !codeFilled) {
                codeFilled = fillSplitOtpInputs(code);
                if (!codeFilled && input) {
                    codeFilled = setElementTextLikeInput(input, code);
                }
                if (codeFilled) {
                    updateProgress(65, '已填写邮箱验证码，等待确认按钮...');
                    log('已填写邮箱验证码: ' + code + '，当前页面值: ' + getCurrentOtpValue());
                }
            }

            if (codeFilled && submitBtn && getCurrentOtpValue() === code) {
                await safeWait(800);
                if (getCurrentOtpValue() !== code) {
                    codeFilled = false;
                    continue;
                }
                robustClickElement(submitBtn);
                updateProgress(100, '已填写验证码并点击确认按钮');
                log('已点击邮箱验证码确认按钮');
                return true;
            }

            if (!code && elapsedFromEmailStart >= resendAfterSeconds && elapsedOnPage >= minPageWaitBeforeResend && resendCount < maxResends) {
                if (resendBtn) {
                    robustClickElement(resendBtn);
                    resendCount++;
                    otpPollGeneration++;
                    otpFetchInFlight = null;
                    code = '';
                    codeFilled = false;
                    startedAt = saveEmailVerificationStartedAt(Date.now() / 1000);
                    saveEmailVerificationResendState(account, startedAt, resendCount, startedAt);
                    nextOtpPollAt = 0;
                    resendMissingLoggedFor = -1;
                    updateProgress(35, '90 秒未收到验证码，已点击重新发送电子邮件 (' + resendCount + '/' + maxResends + ')');
                    log('90 秒未收到 6 位验证码，已点击重新发送电子邮件，resendCount=' + resendCount);
                    await safeWait(1000);
                } else if (resendMissingLoggedFor !== resendCount) {
                    resendMissingLoggedFor = resendCount;
                    log('90 秒未收到验证码，但未找到可点击的重新发送电子邮件按钮');
                }
            }

            await safeWait(step);
            waited += step;
        }

        updateProgress(10, '邮箱验证码未自动完成，请手动处理');
        log('邮箱验证码自动处理超时；最后状态: ' + (lastDiagnostics || '无可见候选元素') + ', lastOtpError=' + (lastOtpError || '-'));
        return false;
    }

    async function autoFillEmailVerificationCode() {
        return await autoFillEmailVerificationCodeWithResend();
    }

    function randomChatGptFullName() {
        var firstNames = ['James', 'Michael', 'Daniel', 'David', 'Ryan', 'Kevin', 'Brian', 'Jason', 'Eric', 'Mark'];
        var lastNames = ['Smith', 'Johnson', 'Brown', 'Davis', 'Miller', 'Wilson', 'Moore', 'Taylor', 'Anderson', 'Thomas'];
        return firstNames[Math.floor(Math.random() * firstNames.length)] + ' ' + lastNames[Math.floor(Math.random() * lastNames.length)];
    }

    function normalizeMatchText(text) {
        return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    }

    function textMatchesAny(text, matchers) {
        var normalized = normalizeMatchText(text);
        return matchers.some(function(matcher) {
            return normalized.includes(normalizeMatchText(matcher));
        });
    }

    function findInputByVisibleLabel(labelText) {
        var matchers = Array.isArray(labelText) ? labelText : [labelText];
        var labels = Array.from(document.querySelectorAll('label'));
        for (var i = 0; i < labels.length; i++) {
            var label = labels[i];
            if (!textMatchesAny(label.textContent || '', matchers)) continue;

            var forId = label.getAttribute('for');
            if (forId) {
                var byId = document.getElementById(forId);
                if (byId && 'value' in byId) return byId;
            }

            var nested = label.querySelector('input, textarea');
            if (nested) return nested;

            var wrapper = label.closest('div');
            for (var depth = 0; wrapper && depth < 4; depth++) {
                var nearby = wrapper.querySelector('input, textarea');
                if (nearby) return nearby;
                wrapper = wrapper.parentElement;
            }
        }
        return null;
    }

    function queryVisibleInputByAttrs(matchers) {
        var inputs = Array.from(document.querySelectorAll('input, textarea'));
        return inputs.find(function(el) {
            if (!el || el.disabled || !('value' in el)) return false;
            var rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return false;
            var haystack = [
                el.id,
                el.name,
                el.getAttribute('autocomplete'),
                el.getAttribute('aria-label'),
                el.getAttribute('placeholder'),
                el.getAttribute('data-testid'),
                el.getAttribute('type'),
            ].filter(Boolean).join(' ');
            return textMatchesAny(haystack, matchers);
        }) || null;
    }

    function getVisibleInputFromCandidates(candidates) {
        for (var i = 0; i < candidates.length; i++) {
            var el = candidates[i];
            if (!el || el.disabled || !('value' in el)) continue;
            var rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) return el;
        }
        return null;
    }

    function findAboutYouFullNameInput() {
        return getVisibleInputFromCandidates([
            findInputByVisibleLabel(['全名', 'full name', 'name']),
            document.querySelector('input[name="name"]'),
            document.querySelector('input[name="fullName"]'),
            document.querySelector('input[name="full_name"]'),
            document.querySelector('input[name="full-name"]'),
            document.querySelector('input[autocomplete="name"]'),
            queryVisibleInputByAttrs(['full name', 'full_name', 'full-name', 'name', '全名']),
            document.querySelector('input[aria-label*="全名"]'),
            document.querySelector('input[placeholder*="全名"]'),
        ]);
    }

    function findAboutYouAgeInput() {
        return getVisibleInputFromCandidates([
            findInputByVisibleLabel(['年龄', 'age', 'birthday', 'birth date', 'date of birth', '出生日期', '生日']),
            document.querySelector('input[name="age"]'),
            document.querySelector('input[name="birthday"]'),
            document.querySelector('input[name="birthdate"]'),
            document.querySelector('input[name="birth_date"]'),
            document.querySelector('input[name="dateOfBirth"]'),
            document.querySelector('input[name="date_of_birth"]'),
            queryVisibleInputByAttrs(['age', 'birthday', 'birthdate', 'birth date', 'date of birth', '出生日期', '生日', '年龄']),
            document.querySelector('input[aria-label*="年龄"]'),
            document.querySelector('input[placeholder*="年龄"]'),
            document.querySelector('input[inputmode="numeric"]'),
            document.querySelector('input[type="number"]'),
            document.querySelector('input[type="date"]'),
        ]);
    }

    function isAboutYouSubmitButton(btn, allowDisabled) {
        if (!btn) return false;
        var text = (btn.textContent || '').trim();
        var normalizedText = normalizeMatchText(text);
        var rect = btn.getBoundingClientRect();
        var actionName = btn.getAttribute('data-dd-action-name') || '';
        var name = btn.getAttribute('name') || '';
        var testId = btn.getAttribute('data-testid') || '';
        var attrText = normalizeMatchText([actionName, name, testId].join(' '));
        var enabled = !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
        if ((!allowDisabled && !enabled) || rect.width <= 0 || rect.height <= 0) return false;
        return (
            attrText.includes('continue') ||
            attrText.includes('submit') ||
            normalizedText.includes('continue') ||
            normalizedText.includes('next') ||
            normalizedText.includes('done') ||
            normalizedText.includes('complete account creation') ||
            normalizedText.includes('complete account setup') ||
            normalizedText.includes('完成帐户创建') ||
            normalizedText.includes('完成账户创建') ||
            normalizedText.includes('完成') ||
            normalizedText.includes('继续')
        );
    }

    function findAboutYouFormRoot(nameInput, ageInput) {
        var roots = [nameInput, ageInput].filter(Boolean).map(function(input) {
            return input.closest('form') || input.closest('main') || input.closest('[role="main"]') || input.closest('section') || input.closest('div');
        }).filter(Boolean);
        return roots[0] || document;
    }

    function findAboutYouSubmitButton(nameInput, ageInput, allowDisabled) {
        var root = findAboutYouFormRoot(nameInput, ageInput);
        var scopedButtons = Array.from(root.querySelectorAll ? root.querySelectorAll('button[type="submit"], button') : []);
        var btn = scopedButtons.find(function(candidate) {
            return isAboutYouSubmitButton(candidate, allowDisabled);
        });
        if (btn) return btn;

        var buttons = Array.from(document.querySelectorAll('button[type="submit"], button'));
        return buttons.find(function(candidate) {
            return isAboutYouSubmitButton(candidate, allowDisabled);
        }) || null;
    }

    function describeAboutYouElement(el) {
        if (!el) return 'missing';
        var rect = el.getBoundingClientRect();
        return [
            el.tagName.toLowerCase(),
            el.id ? '#' + el.id : '',
            el.name ? '[name="' + el.name + '"]' : '',
            el.getAttribute('type') ? '[type="' + el.getAttribute('type') + '"]' : '',
            el.disabled ? 'disabled' : 'enabled',
            Math.round(rect.width) + 'x' + Math.round(rect.height),
        ].filter(Boolean).join('');
    }

    function describeAboutYouButton(btn) {
        if (!btn) return 'missing';
        var rect = btn.getBoundingClientRect();
        return [
            'text="' + (btn.textContent || '').trim() + '"',
            btn.disabled ? 'disabled' : 'enabled',
            btn.getAttribute('aria-disabled') === 'true' ? 'aria-disabled=true' : '',
            Math.round(rect.width) + 'x' + Math.round(rect.height),
        ].filter(Boolean).join(', ');
    }

    function getAboutYouAgeValue(ageInput) {
        var type = normalizeMatchText(ageInput && ageInput.getAttribute('type'));
        var attrs = normalizeMatchText([
            ageInput && ageInput.name,
            ageInput && ageInput.id,
            ageInput && ageInput.getAttribute('aria-label'),
            ageInput && ageInput.getAttribute('placeholder'),
        ].filter(Boolean).join(' '));
        if (type === 'date' || attrs.includes('birthday') || attrs.includes('birthdate') || attrs.includes('date of birth')) {
            return '2003-01-01';
        }
        return '23';
    }

    async function autoFillAboutYou() {
        var maxWait = 15000;
        var waited = 0;
        var step = 300;
        var fullName = randomChatGptFullName();
        var age = '23';
        var lastDiagnostics = '';
        var filled = false;

        while (waited < maxWait) {
            if (STATE === 'STOPPED') return false;

            var nameInput = findAboutYouFullNameInput();
            var ageInput = findAboutYouAgeInput();
            var ageValue = ageInput ? getAboutYouAgeValue(ageInput) : age;

            if (nameInput && ageInput && !filled) {
                var nameOk = setElementTextLikeInput(nameInput, fullName);
                var ageOk = setElementTextLikeInput(ageInput, ageValue);
                filled = nameOk && ageOk && nameInput.value === fullName && ageInput.value === ageValue;
                if (filled) {
                    updateProgress(65, '已填写全名和年龄，等待完成按钮...');
                    log('✅ 已填写 About You: ' + fullName + ', age=' + age);
                }
            }

            var btn = findAboutYouSubmitButton(nameInput, ageInput, false);
            var diagnosticBtn = btn || findAboutYouSubmitButton(nameInput, ageInput, true);
            var diagnostics = 'About You 状态: name=' + describeAboutYouElement(nameInput) +
                ', age/birthday=' + describeAboutYouElement(ageInput) +
                ', submit=' + describeAboutYouButton(diagnosticBtn);
            if (diagnostics !== lastDiagnostics) {
                log(diagnostics);
                lastDiagnostics = diagnostics;
            }

            if (filled && btn && nameInput && ageInput && nameInput.value === fullName && ageInput.value === ageValue) {
                await safeWait(800);
                if (nameInput.value !== fullName || ageInput.value !== ageValue) {
                    filled = false;
                    continue;
                }
                robustClickElement(btn);
                updateProgress(100, '已填写资料并点击完成帐户创建');
                log('✅ 已点击完成帐户创建按钮');
                return true;
            }

            await safeWait(step);
            waited += step;
        }

        updateProgress(10, '未找到全名/年龄输入框或完成按钮');
        log('未找到 About You 全名/年龄输入框或完成按钮；最后状态: ' + (lastDiagnostics || '无可见候选元素'));
        return false;
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
                            zip: (a.Zip_Code || a.zip || '10001').substring(0, 5),
                            cvv2: a.CVV2,
                            expires: a.Expires,
                            card:a.Credit_Card_Number
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
                    return await clickBtnAsync(retries + 1);
                }
                return false;
            }
            log('正在点击按钮: ' + btn.textContent.trim());
            btn.click();
            return true;
        } else {
            log('未找到提交按钮，重试中... (' + retries + ')');
            if (retries < 12) {
                await safeWait(800);
                return await clickBtnAsync(retries + 1);
            }
            return false;
        }
    }

    // ========== 3. 主逻辑控制器 ==========
    async function runScript() {
        var host = window.location.host;
        var path = window.location.pathname;

        try {
            if (
                host.includes('chatgpt.com') ||
                host.includes('chat.openai.com') ||
                host.includes('pay.openai.com') ||
                host.includes('checkout.stripe.com') ||
                host.includes('paypal.com')
            ) {
                await checkAndMarkPendingPlusIfReady();
            }

            // ============================================
            // -- 场景〇：ChatGPT主站 (等待点击按钮获取链接) --
            // ============================================
            if (host.includes('chatgpt.com') || host.includes('auth.openai.com')) {
                if (host.includes('auth.openai.com') && path.includes('/about-you')) {
                    updateProgress(10, '正在等待全名和年龄输入框...');
                    await autoFillAboutYou();
                    return;
                }
                if (host.includes('auth.openai.com') && path.includes('/email-verification')) {
                    updateProgress(10, '正在等待邮箱验证码输入区域...');
                    await autoFillEmailVerificationCode();
                    return;
                }
                if (document.querySelector('input#email, input[name="email"], input[type="email"]') || path.includes('/auth/login') || path.includes('/log-in')) {
                    updateProgress(10, '正在等待 ChatGPT 邮箱输入框...');
                    await autoFillChatGptLoginEmail();
                    return;
                }
                updateProgress(10, '已就绪，可点击“跳转 ChatGPT 登录页”');
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
                var stripeSubmitted = await clickBtnAsync();
                if (stripeSubmitted) {
                    savePlusMarkPendingFromCurrentAccount();
                    await checkAndMarkPendingPlusIfReady();
                } else {
                    log('未确认已点击最终提交按钮，跳过 GPT Plus 状态更新');
                }

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
                fill('cardNumber', addr.card);
                fill('cardExpiry', addr.expires);
                fill('cardCvv', addr.cvv2);
                fill('password', password);
                fill('firstName', 'James');
                fill('lastName', 'Smith');
                fill('billingLine1', addr.street);
                fill('billingCity', addr.city);
                fill('billingPostalCode', addr.zip);
                fillSelect('billingState', addr.state);

                updateProgress(90, '信息填充完毕，准备提交付款...');
                await safeWait(1200);
                var paypalSubmitted = await clickBtnAsync();
                if (paypalSubmitted) {
                    savePlusMarkPendingFromCurrentAccount();
                    await checkAndMarkPendingPlusIfReady();
                } else {
                    log('未确认已点击最终提交按钮，跳过 GPT Plus 状态更新');
                }

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

    var lastRunRouteKey = '';
    var routeRunTimer = null;

    function currentRouteKey() {
        return window.location.host + window.location.pathname;
    }

    function scheduleRunScript(reason) {
        var routeKey = currentRouteKey();
        if (reason !== 'initial' && routeKey === lastRunRouteKey) return;
        lastRunRouteKey = routeKey;

        if (routeRunTimer) clearTimeout(routeRunTimer);
        routeRunTimer = setTimeout(function() {
            if (reason !== 'initial') {
                log('检测到页面路径变化，重新匹配任务: ' + window.location.pathname);
            }
            runScript();
        }, 150);
    }

    function installLocationChangeWatcher() {
        var pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        var pageHistory = pageWindow.history || history;
        var notify = function(reason) {
            setTimeout(function() {
                scheduleRunScript(reason);
            }, 0);
        };

        ['pushState', 'replaceState'].forEach(function(method) {
            var original = pageHistory[method];
            if (typeof original !== 'function') return;
            pageHistory[method] = function() {
                var result = original.apply(this, arguments);
                notify(method);
                return result;
            };
        });

        pageWindow.addEventListener('popstate', function() {
            notify('popstate');
        });
    }

    // 初始化UI并运行脚本
    initUI();
    installLocationChangeWatcher();
    scheduleRunScript('initial');

})();
