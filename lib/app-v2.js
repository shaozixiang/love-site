    /* ============================================================
     * 💖 我们的专属小站（专属优化版）
     * - 界面全新设计（移动端优先、浪漫精致风）
     * - 图片默认直接显示（朋友圈九宫格 / 留言直显），不再点“查看图片”
     * - 列表一次拉取含图片数据，图片走浏览器缓存，不重复拉库
     * - 修复原站：板块假空白、刷新跳顶、定时器泄漏等逻辑问题
     * ============================================================ */

    // ---------- 配置 ----------
    const SUPABASE_URL = 'https://txeynuvttibnilvttieu.supabase.co';
    const SUPABASE_ANON_KEY = 'sb_publishable_Z8E9qPbi6F2NLzoQh9fhfw__goWiZZ4';
    const START_DATE = new Date(2023, 11, 12);
    const PAGE_LIMIT = 500;
    const MAP_LIMIT = 120;
    const ADMIN_LIMIT = 50;
    const SECTION_CACHE_MS = 90 * 1000;
    const AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000;
    const ONLINE_STATUS_INTERVAL_MS = 5 * 60 * 1000;
    const LOG_LOCAL_LIMIT = 300;
    // 重要动作尝试写云端日志（admin_logs 表 RLS 默认拒绝匿名写，失败静默、低频无噪音）；
    // 普通动作只存本机 localStorage，完整历史以本机为准。
    const LOG_REMOTE_ACTIONS = new Set([
        'admin_delete', 'admin_reset_pwd', 'admin_delete_user', 'admin_create_user',
        'admin_toggle_role', 'admin_set_permission', 'admin_toggle_visibility',
        'publish_feed', 'publish_message', 'publish_love', 'publish_memory',
        'publish_memo', 'publish_schedule', 'publish_countdown', 'publish_marker',
        'login', 'logout', 'login_failed', 'angry_on', 'angry_off', 'apology_submit',
        'apology_pass', 'apology_reject', 'update_avatar', 'change_password',
        'comment_feed', 'comment_message', 'like_feed', 'like_message',
        'unlike_feed', 'unlike_message', 'delete_comment_feed', 'delete_comment_message']);
    // 修复：状态变量用 var 并前置，避免任何时序下出现 TDZ；supabase 初始化失败不中断脚本（UI 仍可用）
    var bubbleClicked = 0, bubbleReplenishTimer = null, currentUser = '', isAdmin = false, storageMode = 'cloud',
        map = null, markers = [], currentTab = 'message';
    var currentUserInfo = null;
    var lastUserSyncError = null, lastPermissionError = null;
    var floatPhotos = [], bubbleEnabled = true, bubbleIntervalSec = 12,
        bubbleTimer = null, activeBubbleCount = 0;
    var currentPhotosList = [], currentPhotoIndex = -1;
    var touchStartX = 0, touchEndX = 0;
    var selectedFiles = [];
    var syncTimer = null, onlineStatusTimer = null, heartbeatInterval = null, lastActivityWrite = 0;
    var sectionLoadedAt = {}, failedSections = {};
    var sb = null;

    // ---------- 行为埋点（批量上报服务端 admin_logs，登录用户记 username，访客记 guest） ----------
    var __trackQueue = [], __trackTimer = null;
    function trackEvent(type, target, extra) {
        try {
            __trackQueue.push({ type: String(type || '').slice(0, 30), target: String(target || '').slice(0, 120), extra: extra || {}, ts: Date.now() });
            if (__trackQueue.length >= 5) flushTrack();
            else if (!__trackTimer) __trackTimer = setTimeout(flushTrack, 3000);
        } catch (e) {}
    }
    function flushTrack() {
        if (__trackTimer) { clearTimeout(__trackTimer); __trackTimer = null; }
        const events = __trackQueue.splice(0, 20);
        if (events.length === 0) return;
        fetch('/api/account', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json'},
            body: JSON.stringify({ action: 'track', sessionToken: getSessionToken() || '', page_url: location.href.slice(0, 120), events: events })
        }).catch(() => {});
    }
    window.addEventListener('beforeunload', function () {
        if (__trackQueue.length) {
            try { navigator.sendBeacon('/api/account', JSON.stringify({ action: 'track', events: __trackQueue.splice(0), page_url: location.href.slice(0, 120) })); } catch (e) {}
        }
    });

    // 板块英文名 → 中文（行为日志可读化）
    const SECTION_CN = { message: '留言板', gallery: '时光相册', memory: '回忆', love: '感动', memo: '待办', todo: '待办', travel: '旅行地图', angry: '生气模式'};
    function sectionCN(name) { return SECTION_CN[name] || name; }

    // 安全：所有数据库请求经服务端代理 /api/db 中转（未登录一律拒绝，封死匿名裸读）
    function dbProxyFetch(input, init) {
        var url = typeof input === 'string'? new URL(input, window.location.origin) : new URL(input.url);
        if (url.pathname.indexOf('/rest/v1/') >= 0) {
            var headers = new Headers(init ? init.headers : undefined);
            headers.set('X-Couple-Token', getSessionToken() || '');
            return fetch('/api/db'+ url.pathname + url.search, {
                method: init ? init.method : 'GET',
                headers: headers,
                body: init && init.body ? init.body : undefined
            });
        }
        return fetch(input, init);
    }
    function initSupabase() {
        if (sb || !window.supabase) return false;
        try { sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { fetch: dbProxyFetch } }); return true; } catch (e) { console.error('Supabase 初始化失败（网络或 CDN 问题），界面仍可打开：', e); return false; }
    }
    initSupabase();
    // 保险：若库因任何原因延迟就绪，轮询补初始化（内联后通常立即成功）
    if (!sb) { var _sbRetry = 0; (function waitSb() { if (sb) return; if (initSupabase()) return; if (_sbRetry++ < 50) setTimeout(waitSb, 400); })(); }
    var cacheStore = {};

    // ---------- 工具 ----------
    // P1-02：转义 & < > " '（含带引号属性上下文，杜绝存储型 XSS；与 app.js esc() 对齐）
    function escapeHtml(str) { return String(str == null ? '': str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
    // 旧数据兼容：v1 时代显示名带 👦/👧 等前缀 emoji，展示前统一剥离
    function stripNameEmoji(name) { return String(name == null ? '' : name).replace(/^[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}️\s]+/u, '').trim(); }
    // 媒体 CDN 容错：jsDelivr 主域名不通时自动换备用节点重试
    var IMG_CDNS = ['https://cdn.jsdelivr.net', 'https://fastly.jsdelivr.net', 'https://gcore.jsdelivr.net', 'https://testingcf.jsdelivr.net'];
    // 私有化：图片仓库转私有后，所有媒体统一改走 /api/img 代理（登录才能看，边缘缓存加速）
    function imgProxy(url) {
        var s = String(url || '');
        if (!s || s.indexOf('/api/img/') === 0) return s;
        var m = s.match(/^https:\/\/[^/]+\.jsdelivr\.net\/gh\/[^/@]+\/[^/@]+@[^/]+\/(.+)$/i);
        if (m) return '/api/img/'+ m[1];
        var m2 = s.match(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\/(.+)$/i);
        if (m2) return '/api/img/'+ m2[1];
        var m3 = s.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/blob\/[^/]+\/(.+)$/i);
        if (m3) return '/api/img/'+ m3[1];
        return s; // 本地 blob / 其他 → 原样
    }
    function bestImgSrc(url, n) {
        var m = String(url).match(/^https:\/\/[^/]+/);
        if (!m) return url;
        var idx = IMG_CDNS.indexOf(m[0]);
        if (idx < 0) return url;
        return url.replace(m[0], IMG_CDNS[(idx + (n || 1)) % IMG_CDNS.length]);
    }
    function tryFallback(el) {
        if (!el || !el.src) return;
        var tries = parseInt(el.getAttribute('data-fb') || '0', 10);
        if (tries >= IMG_CDNS.length - 1) return; // 所有节点都试过则停止
        el.setAttribute('data-fb', tries + 1);
        el.src = bestImgSrc(el.src, 1);
    }
    // Toast 轻提示（LUI 风格：图标按类型，剥离消息前导 emoji）
    function stripUiEmoji(s) { return String(s == null ? '': s).replace(/^[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}️\s]+/u, '').trim(); }
    function toast(msg, type) {
        var box = document.getElementById('toastBox');
        if (!box) return;
        var t = document.createElement('div');
        t.className = 'lui-toast '+ (type === 'success'? 'success': type === 'error'? 'error': type === 'warn'? 'warn': '');
        var iconId = type === 'success'? 'i-check-circle': type === 'error'? 'i-x-circle': type === 'warn'? 'i-alert': 'i-info';
        t.innerHTML = '<svg class="lui-icon"><use href="assets/icons.svg#'+ iconId + '"/></svg><span></span>';
        t.querySelector('span').textContent = stripUiEmoji(msg);
        box.appendChild(t);
        requestAnimationFrame(function () { t.classList.add('show'); });
        setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.remove(); }, 320); }, 2300);
    }
    // 背景滚动锁 + LUI 二次确认弹窗（删除/清空/改权限/重置密码统一走这里）
    function lockBackground() { try { document.body.style.overflow = 'hidden'; } catch (e) {} }
    function unlockBackground() { try { document.body.style.overflow = ''; } catch (e) {} }
    var __cmResolve = null;
    function luiConfirm(text, opts) {
        opts = opts || {};
        return new Promise(function (resolve) {
            var ov = document.getElementById('confirmModal');
            if (!ov) { resolve(window.confirm(text)); return; }
            document.getElementById('cmTitle').textContent = opts.title || '确认操作';
            document.getElementById('cmText').textContent = text;
            var okBtn = document.getElementById('cmOk');
            var icon = document.getElementById('cmIcon');
            var danger = opts.danger !== false;
            okBtn.textContent = opts.okText || (danger ? '确认删除': '确认');
            okBtn.className = 'lui-btn '+ (danger ? 'danger': 'primary');
            icon.innerHTML = '<svg class="lui-icon s20"><use href="assets/icons.svg#'+ (danger ? 'i-alert': 'i-check-circle') + '"/></svg>';
            icon.style.color = danger ? 'var(--red)': 'var(--rose)';
            __cmResolve = resolve;
            ov.style.display = 'flex';
            lockBackground();
        });
    }
    function __closeCm(result) {
        var ov = document.getElementById('confirmModal');
        if (ov) ov.style.display = 'none';
        unlockBackground();
        var r = __cmResolve; __cmResolve = null;
        if (r) r(result);
    }
    window.luiConfirm = luiConfirm;
    // 带超时的 fetch
    function fetchWithTimeout(url, ms) {
        var ctrl = new AbortController();
        var timer = setTimeout(function () { ctrl.abort(); }, ms || 15000);
        return fetch(url, { signal: ctrl.signal }).then(function (r) {
            clearTimeout(timer);
            if (!r.ok) throw new Error('bad status');
            return r;
        });
    }
    // 邮箱通知：对方有新动态/留言时，由服务端给"对方"的邮箱发邮件（不会发给发布者自己）
    async function notifyEvent(kind, detail) {
        try {
            await accountApi('notify', { kind, detail: detail ? String(detail).slice(0, 60) : ''});
        } catch (e) { console.warn('通知发送失败（不影响正常使用）:', e); }
    }
    async function openEmailModal() {
        let current = '';
        try {
            const cfg = await accountApi('getNotifyConfig');
            current = cfg.myEmail || (cfg.emails && cfg.emails[currentUser]) || '';
        } catch (e) {}
        document.getElementById('myEmailInput').value = current;
        document.getElementById('emailModal').style.display = 'flex';
    }
    async function saveMyEmail() {
        const email = document.getElementById('myEmailInput').value.trim();
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast('邮箱格式不正确', 'error'); return; }
        try {
            await accountApi('setMyEmail', { email });
            toast('邮箱已保存，对方有更新时会通知到这里', 'success');
            closeModalById('emailModal');
        } catch (e) { toast('保存失败：'+ e.message, 'error'); }
    }
    // 统一删除流程：询问 → 确认 → 成功/失败提示
    async function confirmAndDelete(message, doDelete, successMsg) {
        if (!window.confirm(message)) return false;
        try { await doDelete(); toast(successMsg || '删除成功', 'success'); return true; }
        catch (e) { console.error(e); toast('删除失败：'+ (e.message || '未知错误'), 'error'); return false; }
    }
    // 头像辅助：有头像图用图；无头像用首字母（LUI 圆头像，无 emoji）
    function authorAvatarHtml(author, displayName) {
        const u = (window.__usersCache || {})[author];
        const name = String(displayName || author || '?').trim();
        if (u && u.avatar) return `<img class="lui-avatar s32" src="${imgProxy(u.avatar)}" alt="">`;
        return `<span class="lui-avatar s32">${escapeHtml(name.charAt(0).toUpperCase() || '?')}</span>`;
    }
    // 下载图片：抓取为 blob → 触发保存（带 CDN 容错与失败降级）
    function downloadImage(src) {
        // 微信内置浏览器禁止自动下载，直接打开原图长按保存
        if (/MicroMessenger/i.test(navigator.userAgent || '')) {
            toast('已打开原图，长按图片即可保存', 'success');
            window.open(src, '_blank');
            return;
        }
        toast('⏳ 正在下载…');
        var a = document.createElement('a');
        a.download = 'love.png';
        var doSave = function (url) {
            return fetchWithTimeout(url).then(function (r) { return r.blob(); })
                .then(function (blob) {
                    var objUrl = URL.createObjectURL(blob);
                    a.href = objUrl;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    setTimeout(function () { URL.revokeObjectURL(objUrl); }, 8000);
                    toast('已保存到你的设备', 'success');
                });
        };
        doSave(src)
            .catch(function () { return doSave(bestImgSrc(src, 1)); })
            .catch(function () { return doSave(bestImgSrc(src, 2)); })
            .catch(function () { return doSave(bestImgSrc(src, 3)); })
            .catch(function () {
                toast('下载失败，已为你打开原图（长按可保存）', 'error');
                window.open(src, '_blank');
            });
    }
    function formatPrettyDate(dateStr) {
        if (!dateStr) return '';
        const p = String(dateStr).split('-');
        if (p.length === 3) return `${p[0]}年${parseInt(p[1])}月${parseInt(p[2])}日`;
        return dateStr;
    }
    function normalizeVisibility(v) { return v === 'couple_only'? 'couple_only': 'public'; }
    function isCoupleAccount(u = currentUser) { return u === 'boy'|| u === 'girl'; }
    function canViewRecord(r) { const v = normalizeVisibility(r && r.visibility); return v !== 'couple_only'|| isAdmin || isCoupleAccount(); }
    function authorDisplay(u) { return u; }
    function updateTogetherDays() {
        const diff = Math.floor((new Date() - START_DATE) / 86400000);
        const el = document.getElementById('togetherDaysDisplay');
        if (el) el.textContent = '已相爱 '+ diff + '天';
    }
    function downloadTextFile(name, content, mime) {
        const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    function addDanmaku(text) {
        if (!text) return;
        const dan = document.createElement('div');
        dan.className = 'danmaku';
        dan.innerText = text;
        dan.style.left = Math.random() * 70 + 15 + '%';
        dan.style.fontSize = (22 + Math.random() * 14) + 'px';
        dan.style.color = `hsl(${Math.random() * 20 + 340}, 75%, 50%)`;
        dan.style.animationDuration = (10 + Math.random() * 6) + 's';
        document.body.appendChild(dan);
        setTimeout(() => dan.remove(), 16000);
    }

    // ---------- 板块加载控制（失败可重试，杜绝假空白） ----------
    function shouldReloadSection(name, force = false) {
        if (force) return true;
        if (failedSections[name]) return true;
        return Date.now() - (sectionLoadedAt[name] || 0) > SECTION_CACHE_MS;
    }
    function markSectionLoaded(name) { sectionLoadedAt[name] = Date.now(); delete failedSections[name]; }
    function markSectionFailed(name) { failedSections[name] = true; }

    // ---------- 数据层 ----------
    function selectContentRows(table, columns, options = {}) {
        let query = sb.from(table).select(columns);
        query = query.is('deleted_at', null);
        if (!isAdmin && !isCoupleAccount()) query = query.or('visibility.is.null,visibility.eq.public');
        query = query.order(options.orderBy || 'created_at', { ascending: !!options.ascending });
        return query.limit(options.limit || PAGE_LIMIT);
    }

    // 安全（H2 存储型 XSS）：展示前统一转义用户可控的昵称/评论作者名。
    // 缓存中始终保留原始值，仅在返回展示时转义，保证可重复执行、不会多重转义。
    function sanitizeContentRows(rows) {
        return (rows || []).map(function (r) {
            if (!r || typeof r !== 'object') return r;
            if (r.author_name != null) r.author_name = escapeHtml(stripNameEmoji(String(r.author_name)));
            if (Array.isArray(r.comments)) {
                r.comments = r.comments.map(function (c) {
                    if (!c || typeof c !== 'object') return c;
                    const n = Object.assign({}, c);
                    if (n.authorName != null) n.authorName = escapeHtml(stripNameEmoji(String(n.authorName)));
                    if (n.author != null) n.author = escapeHtml(stripNameEmoji(String(n.author)));
                    return n;
                });
            }
            return r;
        });
    }

    // ---------- 离线缓存 + 增量同步（省流量核心） ----------
    // 设计：首次登录全量拉一次存本地；之后“秒开本地缓存 + 后台只拉新增记录”；
    // 图片 URL 不变走浏览器 HTTP 缓存，不重复下载；每 15 分钟全量对比兜底同步删除。
    function readLocalJSON(key) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
    // P2-08：localStorage 软上限——写失败时先清最老的 section 缓存再重试一次，避免写失败被静默吞掉
    var SECTION_CACHE_PREFIX = 'couple_cache_v2_';
    function evictOldestSectionCache() {
        try {
            var keys = [];
            for (var i = 0; i < localStorage.length; i++) {
                var k = localStorage.key(i);
                if (k && k.indexOf(SECTION_CACHE_PREFIX) === 0) keys.push(k);
            }
            if (!keys.length) return false;
            keys.sort(function (a, b) {
                var ta = 0, tb = 0;
                try { ta = JSON.parse(localStorage.getItem(a) || '{}').syncedAt || 0; } catch (e) {}
                try { tb = JSON.parse(localStorage.getItem(b) || '{}').syncedAt || 0; } catch (e) {}
                return String(ta).localeCompare(String(tb)); // 最老的在前
            });
            localStorage.removeItem(keys[0]);
            console.warn('本地缓存空间不足，已自动清理旧板块缓存:', keys[0]);
            return true;
        } catch (e) { return false; }
    }
    function writeLocalJSON(key, val) {
        var payload = JSON.stringify(val);
        try { localStorage.setItem(key, payload); return true; } catch (e) {
            if (key.indexOf(SECTION_CACHE_PREFIX) === 0 && evictOldestSectionCache()) {
                try { localStorage.setItem(key, payload); return true; } catch (e2) { return false; }
            }
            return false;
        }
    }
    function mergeRowsById(cached = [], incoming = []) {
        const map = new Map();
        for (const r of incoming) if (r && r.id) map.set(r.id, r);
        for (const r of cached) if (r && r.id && !map.has(r.id)) map.set(r.id, r);
        return Array.from(map.values()).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0)).slice(0, PAGE_LIMIT);
    }
    function sectionCacheKey(table) { return 'couple_cache_v2_'+ (currentUser || 'guest') + '_'+ table; }
    async function getCachedRows(table, columns, options = {}) {
        const cacheKey = sectionCacheKey(table);
        const cached = readLocalJSON(cacheKey) || { data: [], syncedAt: null, complete: false };
        if (options.force) {
            const { data } = await selectContentRows(table, columns, { limit: options.limit || PAGE_LIMIT });
            writeLocalJSON(cacheKey, { data: data || [], syncedAt: new Date().toISOString(), complete: true });
            return sanitizeContentRows(data || []);
        }
        // 修复：只有“完整快照”缓存才走增量（防止缓存不完整/损坏时永远拉不回旧数据）；否则全量重建
        if (cached.data && cached.data.length && cached.complete) {
            // 秒开缓存（0 流量），后台增量拉取新增记录
            try {
                let incQuery = sb.from(table).select(columns).is('deleted_at', null);
                if (!isAdmin && !isCoupleAccount()) incQuery = incQuery.or('visibility.is.null,visibility.eq.public');
                const inc = await incQuery.gt('created_at', cached.syncedAt).order('created_at', { ascending: false }).limit(options.limit || PAGE_LIMIT);
                if (inc.error) throw inc.error;
                const merged = mergeRowsById(cached.data, inc.data || []);
                writeLocalJSON(cacheKey, { data: merged, syncedAt: new Date().toISOString(), complete: true });
                return sanitizeContentRows(merged);
            } catch (e) { return sanitizeContentRows(cached.data); } // 网络失败/增量失败 → 离线用缓存
        }
        const { data } = await selectContentRows(table, columns, { limit: options.limit || PAGE_LIMIT });
        writeLocalJSON(cacheKey, { data: data || [], syncedAt: new Date().toISOString(), complete: true });
        return sanitizeContentRows(data || []);
    }

    // ---------- 上传 ----------
    async function compressImage(file, maxSizeMB = 2, maxWidth = 1280) {
        return new Promise((resolve) => {
            if (!file.type.startsWith('image/') || file.type === 'image/gif'|| file.size <= maxSizeMB * 1024 * 1024) { resolve(file); return; }
            const reader = new FileReader();
            reader.onload = function (e) {
                const img = new Image();
                img.onload = function () {
                    const canvas = document.createElement('canvas');
                    let width = img.width, height = img.height;
                    if (width > maxWidth) { height = height * maxWidth / width; width = maxWidth; }
                    canvas.width = width; canvas.height = height;
                    canvas.getContext('2d').drawImage(img, 0, 0, width, height);
                    canvas.toBlob(function (blob) { resolve(new File([blob], file.name, { type: 'image/jpeg', lastModified: Date.now() })); }, 'image/jpeg', 0.8);
                };
                img.onerror = () => resolve(file);
                img.src = e.target.result;
            };
            reader.onerror = () => resolve(file);
            reader.readAsDataURL(file);
        });
    }
    async function uploadToBucket(file, folder = 'common') {
        if (!file) return null;
        try {
            const isVideo = file.type.startsWith('video/');
            const isImage = file.type.startsWith('image/');
            // 服务端 Git Data 上传限额：图片 10MB、视频 30MB；图片先压缩到 1280px/JPEG 0.8
            if (isImage && file.size > 10 * 1024 * 1024) { toast('图片不能超过 10MB，请压缩后再传', 'error'); return null; }
            if (isVideo && file.size > 30 * 1024 * 1024) { toast('视频不能超过 30MB，请压缩后再传', 'error'); return null; }
            let uploadFile = file;
            if (isImage && !file.type.includes('gif')) {
                try { uploadFile = await compressImage(file, 8, 1280); } catch (e) { uploadFile = file; }
            }
            if (window.location.protocol === 'file:') { alert('本地直接打开不能上传图片：上传接口只在部署后存在。'); return null; }
            const formData = new FormData();
            formData.append('file', uploadFile, uploadFile.name || file.name || 'media');
            formData.append('folder', folder || 'common');
            formData.append('mediaType', isVideo ? 'video': (isImage ? 'image': 'file'));
            const response = await fetch('/api/upload-to-github', { method: 'POST', headers: { 'X-Couple-Token': getSessionToken() || ''}, body: formData });
            const result = await response.json().catch(() => ({}));
            if (!response.ok || !result.url) { alert('上传失败: '+ (result.error || 'GitHub 上传接口未返回链接')); return null; }
            return result.url;
        } catch (e) { alert('上传失败: '+ (e.message || '请确认网站已部署到 Cloudflare Pages')); return null; }
    }

    // ---------- 账号接口与权限 ----------
    function getSessionToken() { return localStorage.getItem('couple_session_token') || ''; }
    function setSession(u, t) { localStorage.setItem('couple_logged_user', u); localStorage.setItem('couple_session_token', t); try { document.cookie = 'couple_t='+ encodeURIComponent(t) + '; path=/; max-age=2592000; samesite=lax'+ (location.protocol === 'https:'? '; secure': ''); } catch (e) {} }
    function clearSession() { localStorage.removeItem('couple_logged_user'); localStorage.removeItem('couple_session_token'); try { document.cookie = 'couple_t=; path=/; max-age=0; samesite=lax'; } catch (e) {} }
    async function accountApi(action, payload = {}) {
        if (window.location.protocol === 'file:') throw new Error('账号安全接口只在部署后可用。');
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12000);
        let response;
        try {
            response = await fetch('/api/account', { method: 'POST', headers: { 'Content-Type': 'application/json'}, body: JSON.stringify({ action, sessionToken: getSessionToken(), ...payload }), signal: controller.signal });
        } catch (e) { if (e && e.name === 'AbortError') throw new Error('/api/account 超时，请刷新页面或检查网络。'); throw e; }
        finally { clearTimeout(timeout); }
        const responseText = await response.text();
        let result = {};
        try { result = responseText ? JSON.parse(responseText) : {}; } catch (e) { throw new Error(`/api/account 返回的不是 JSON。HTTP ${response.status}`); }
        if (!response.ok) throw new Error(result.error || `/api/account 请求失败，HTTP ${response.status}`);
        return result;
    }
    async function trashApi(action, table, id) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        let resp;
        try {
            resp = await fetch('/api/trash', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Couple-Token': getSessionToken() },
                body: JSON.stringify({ action, table, id: id || '', sessionToken: getSessionToken() }),
                signal: controller.signal
            });
        } catch (e) {
            clearTimeout(timeout);
            if (e && e.name === 'AbortError') throw new Error('/api/trash 超时，请检查网络后重试。');
            throw e;
        }
        clearTimeout(timeout);
        const txt = await resp.text();
        let result = {};
        try { result = txt ? JSON.parse(txt) : {}; } catch (_) { throw new Error('回收站返回格式错误'); }
        if (!resp.ok) throw new Error(result.error || ('请求失败 HTTP '+ resp.status));
        return result;
    }
    function normalizeUserInfo(username, info = {}) {
        return {
            avatar: info.avatar || '',
            permission: ['view', 'comment', 'full'].includes(info.permission) ? info.permission : 'full',
            role: (info.role === 'admin'|| username === 'admin') ? 'admin': 'user',
            last_active: info.last_active || '',
            is_online: info.is_online === true || info.is_online === 'true'};
    }
    function userArrayToMap(list = []) { const map = {}; (list || []).forEach(u => { if (u && u.username) map[u.username] = normalizeUserInfo(u.username, u); }); return map; }
    function normalizeUsers(users) { const n = {}; for (let [u, i] of Object.entries(users || {})) n[u] = normalizeUserInfo(u, i); return n; }
    function getCacheSafeUsers(users) { const n = normalizeUsers(users), c = {}; for (let [u, i] of Object.entries(n)) c[u] = { avatar: i.avatar, permission: i.permission, role: i.role }; return c; }
    function safeSetLocalStorage(key, value) { try { localStorage.setItem(key, value); return true; } catch (e) { console.warn('本地缓存写入失败，不影响云端数据:', e); try { localStorage.removeItem(key); } catch (_) {} return false; } }
    function cacheUsersLocally(users) { window.__usersCache = users; return safeSetLocalStorage('couple_users', JSON.stringify(getCacheSafeUsers(users))); }
    function loadCachedUsers(defaultUsers = {}) { try { const c = localStorage.getItem('couple_users'); const users = c ? normalizeUsers(JSON.parse(c)) : defaultUsers; window.__usersCache = users; return users; } catch (e) { console.warn('本地用户缓存读取失败:', e); try { localStorage.removeItem('couple_users'); } catch (_) {} return defaultUsers; } }
    async function forceRefreshUserData(options = {}) {
        const allowLocalFallback = options.allowLocalFallback !== false;
        try {
            let users = {};
            if (options.includeAll) {
                const r = await accountApi('listUsers');
                users = userArrayToMap(r.users || []);
                // 轻量用户列表不含头像，保留当前登录用户已有头像，避免顶部头像被清空
                const _prev = window.__usersCache && window.__usersCache[currentUser];
                if (_prev && users[currentUser] && !users[currentUser].avatar && _prev.avatar) users[currentUser].avatar = _prev.avatar;
            } else { const r = await accountApi('me'); if (r.user) users[r.user.username] = normalizeUserInfo(r.user.username, r.user); }
            lastUserSyncError = null; cacheUsersLocally(users);
            if (users[currentUser]) currentUserInfo = users[currentUser];
            return users;
        } catch (e) { lastUserSyncError = e; if (!allowLocalFallback) throw e; return loadCachedUsers({}); }
    }
    function loadUserData(options = {}) { return forceRefreshUserData(options); }
    async function hasPermission(required) {
        try {
            const users = await forceRefreshUserData({ allowLocalFallback: false });
            const info = users[currentUser];
            if (!info) return false;
            currentUserInfo = info;
            isAdmin = (currentUser === 'admin') || info.role === 'admin';
            updateAdminVisibility();
            if (isAdmin) return true;
            const levels = { 'view': 1, 'comment': 2, 'full': 3 };
            lastPermissionError = null;
            return (levels[info.permission || 'full'] || 3) >= (levels[required] || 0);
        } catch (e) { lastPermissionError = e; console.error('权限检查失败:', e); return false; }
    }
    async function requirePermission(required) {
        const ok = await hasPermission(required);
        if (!ok) { const labels = { view: '浏览', comment: '评论/点赞', full: '发布/修改'}; const extra = lastPermissionError ? '\n\n权限校验错误：'+ lastPermissionError.message : ''; alert(`当前账号没有“${labels[required] || required}”权限，请联系管理员调整权限${extra}`); }
        return ok;
    }
    async function requireAdmin() {
        try {
            const users = await forceRefreshUserData({ allowLocalFallback: false });
            const info = users[currentUser];
            if (info) currentUserInfo = info;
            isAdmin = !!(info && ((currentUser === 'admin') || info.role === 'admin'));
            updateAdminVisibility();
            if (!isAdmin) alert('无权限：只有管理员可以操作这里');
            return isAdmin;
        } catch (e) { alert('无法确认管理员权限，请检查 Supabase users 表和网络连接。错误：'+ e.message); return false; }
    }
    async function canDeleteRecord(table, id) {
        if (!(await hasPermission('full'))) { alert('删除内容需要“完整权限”，请联系管理员调整权限'); return false; }
        if (isAdmin) return true;
        try { const { data, error } = await sb.from(table).select('author').eq('id', id).maybeSingle(); if (!error && data && data.author === currentUser) return true; } catch (e) {}
        alert('只能删除自己发布的内容，或让管理员删除'); return false;
    }
    async function ensureCommentMutationAllowed(comment) {
        if (!(await hasPermission('comment'))) { alert('删除评论需要“评论/点赞”权限，请联系管理员调整权限'); return false; }
        if (isAdmin || (comment && comment.author === currentUser)) return true;
        alert('只能删除自己的评论，或让管理员删除'); return false;
    }
    function updateAdminVisibility() { const b = document.getElementById('adminEntryBtn'); if (b) b.style.display = isAdmin ? 'block': 'none'; }
    function loadCurrentUserAvatar() { if (!currentUser) return; const a = currentUserInfo && currentUserInfo.avatar; if (a) document.getElementById('userAvatarImg').src = a; }

    // ---------- 操作日志 ----------
    async function logAction(action, details = {}) {
        try {
            const envInfo = { user_agent: navigator.userAgent.substring(0, 100), platform: navigator.platform, language: navigator.language, screen_size: `${screen.width}x${screen.height}`, page_url: window.location.href.substring(0, 100), current_tab: currentTab || 'unknown'};
            const fullDetails = { ...envInfo, ...(typeof details === 'string'? { message: details } : details) };
            const logData = { action, user: currentUser || 'guest', details: JSON.stringify(fullDetails), created_at: new Date().toISOString() };
            try { let localLogs = JSON.parse(localStorage.getItem('admin_logs') || '[]'); localLogs.unshift(logData); if (localLogs.length > LOG_LOCAL_LIMIT) localLogs = localLogs.slice(0, LOG_LOCAL_LIMIT); localStorage.setItem('admin_logs', JSON.stringify(localLogs)); } catch (e) { console.error('保存本地日志失败:', e); }
            // 重要动作尝试写云端（表 RLS 若拒绝则静默失败一次，本会话不再重试，避免反复 401 噪音）
            if (LOG_REMOTE_ACTIONS.has(action) && sessionStorage.getItem('couple_remote_log_failed') !== '1') {
                try { await sb.from('admin_logs').insert(logData); } catch (e) { sessionStorage.setItem('couple_remote_log_failed', '1'); }
            }
        } catch (e) { console.error('记录日志失败:', e); }
    }
    function readLocalAdminLogs() { try { const l = JSON.parse(localStorage.getItem('admin_logs') || '[]'); return Array.isArray(l) ? l : []; } catch (e) { return []; } }
    function getLogKey(log) { if (!log) return ''; return [log.created_at || '', log.action || '', log.user || '', log.details || ''].join('|'); }
    function logEpoch(log) { const t = Date.parse(log && log.created_at); return isNaN(t) ? -1 : t; }
    function mergeAdminLogs(remoteLogs = [], localLogs = []) {
        // 云端为权威来源优先；同一条动作本地存一份(ISO 结尾 Z)、云端返回(+00:00)，格式/毫秒可能略有差异，
        // 旧实现用原始 created_at 字符串做 key，导致同一条日志去重失败、界面显示两条。
        // 改为：云端优先，按 动作+用户+详情+时间±2s 容差 归一化去重（详情不同视为不同动作，避免误删快速点赞等）。
        const DUP_WINDOW_MS = 2000;
        const items = []
            .concat((remoteLogs || []).map(l => ({ l, remote: true })))
            .concat((localLogs || []).map(l => ({ l, remote: false })))
            .map(x => ({ l: x.l, remote: x.remote, t: logEpoch(x.l) }))
            .sort((a, b) => (a.t - b.t) || (a.remote === b.remote ? 0 : (a.remote ? -1 : 1)));
        const kept = [];
        for (const cur of items) {
            const dup = kept.some(k => k.l.action === cur.l.action && k.l.user === cur.l.user &&
                (k.l.details || '') === (cur.l.details || '') &&
                k.t >= 0 && cur.t >= 0 && Math.abs(k.t - cur.t) <= DUP_WINDOW_MS);
            if (!dup) kept.push(cur);
        }
        return kept.map(x => x.l).sort((a, b) => logEpoch(b) - logEpoch(a)).slice(0, ADMIN_LIMIT);
    }
    async function getAdminLogs() {
        let logs = [];
        try { const { data, error } = await sb.from('admin_logs').select('action,user,details,created_at').order('created_at', { ascending: false }).limit(ADMIN_LIMIT); if (!error && data) logs = data; } catch (e) {}
        return mergeAdminLogs(logs, readLocalAdminLogs());
    }

    // ---------- 时光相册（朋友圈 · 图片直显） ----------
    function updateFilePreview() {
        const container = document.getElementById('selectedFilesPreview');
        if (!container) return;
        container.innerHTML = '';
        for (let i = 0; i < window.selectedFiles.length; i++) {
            const file = window.selectedFiles[i];
            const img = document.createElement('img');
            img.src = URL.createObjectURL(file);
            img.style.cssText = 'width:76px;height:76px;object-fit:cover;border-radius:12px;border:1px solid var(--line);cursor:pointer;';
            img.onclick = (function (idx) { return function () {
                window.selectedFiles.splice(idx, 1);
                updateFilePreview();
                const dt = new DataTransfer();
                for (let f of window.selectedFiles) dt.items.add(f);
                const fileInput = document.getElementById('fileInput');
                if (fileInput) fileInput.files = dt.files;
            }; })(i);
            container.appendChild(img);
        }
    }
    async function uploadFeed() {
        if (!(await requirePermission('full'))) return;
        const btn = document.getElementById('feedSubmitBtn');
        const fileInput = document.getElementById('fileInput');
        let files = [];
        if (fileInput && fileInput.files && fileInput.files.length > 0) files = Array.from(fileInput.files);
        else if (window.selectedFiles && window.selectedFiles.length > 0) files = window.selectedFiles;
        const descEl = document.getElementById('feedDesc');
        const desc = descEl ? descEl.value.trim() : '';
        if (files.length === 0 && !desc) { alert('请选择照片/视频或输入描述'); return; }
        if (btn) { btn.disabled = true; btn.innerText = '上传中...'; }
        let medias = [];
        for (let file of files) {
            const isVideo = file.type.startsWith('video/');
            const url = await uploadToBucket(new File([file.slice(0, file.size, file.type)], file.name, { type: file.type }), 'feeds');
            if (url) medias.push({ type: isVideo ? 'video': 'image', data: url });
        }
        const newFeed = { author: currentUser, author_name: authorDisplay(currentUser), description: desc, medias, comments: [], visibility: 'public'};
        try { await sb.from('feeds').insert(newFeed); logAction('publish_feed', { description: desc.substring(0, 50), media_count: medias.length }); } catch (e) { console.error(e); }
        if (fileInput) fileInput.value = '';
        window.selectedFiles = [];
        updateFilePreview();
        if (descEl) descEl.value = '';
        if (btn) { btn.disabled = false; btn.innerText = '发送动态'; }
        renderFeeds({ force: false });
        addDanmaku(`${authorDisplay(currentUser)} 发布了新动态！`);
        notifyEvent('feed', desc);
    }
    async function renderFeeds(options = {}) {
        if (!shouldReloadSection('gallery', options && options.force)) return;
        let feeds = [];
        try {
            const rows = await getCachedRows('feeds', 'id,description,author,author_name,created_at,comments,likes,visibility,medias', { limit: PAGE_LIMIT, force: options.force });
            feeds = (rows || []).map(f => ({
                id: f.id, medias: f.medias || [], desc: f.description || '', author: f.author,
                authorName: f.author_name, time: new Date(f.created_at).toLocaleString(),
                comments: f.comments || [], likes: f.likes || [], visibility: normalizeVisibility(f.visibility)
            }));
            feeds = feeds.filter(canViewRecord);
            markSectionLoaded('gallery');
        } catch (e) {
            markSectionFailed('gallery');
            document.getElementById('galleryContainer').innerHTML = '<div class="lui-empty"><div class="e-icon"><svg class="lui-icon"><use href="assets/icons.svg#i-alert"/></svg></div><div class="e-title">加载失败</div><div class="e-text">网络或服务暂时不可用</div><button class="lui-btn tonal sm" onclick="renderFeeds({force:true})">点击重试</button></div>';
            return;
        }
        if (!feeds.length) { document.getElementById('galleryContainer').innerHTML = '<div class="lui-empty"><div class="e-icon"><svg class="lui-icon"><use href="assets/icons.svg#i-photo"/></svg></div><div class="e-title">还没有动态</div><div class="e-text">写下第一条朋友圈，记录你们的日常</div></div>'; return; }
        let html = '';
        for (let feed of feeds) {
            const canDelete = isAdmin || feed.author === currentUser;
            // 图片九宫格：直接显示，不点按钮、不再二次查库
            let mediaHtml = '';
            const md = feed.medias || [];
            if (md.length) {
                const cells = md.map((media) => {
                    const url = media && media.data;
                    if (!url) return '';
                    if (media.type === 'video') {
                        return `<div class="lui-photo" onclick="openVideoModal('${imgProxy(url)}')"><video src="${imgProxy(url)}" data-source="相册" data-author="${escapeHtml(feed.authorName || feed.author)}" data-desc="${escapeHtml((feed.desc || '').slice(0, 40))}" preload="metadata" muted playsinline webkit-playsinline loading="lazy" referrerpolicy="no-referrer" onerror="tryFallback(this)"></video><span class="lui-video-badge"><svg class="lui-icon s14"><use href="assets/icons.svg#i-play"/></svg></span></div>`;
                    }
                    return `<div class="lui-photo" onclick="openImageModal('${imgProxy(url)}')"><img src="${imgProxy(url)}" data-source="相册" data-author="${escapeHtml(feed.authorName || feed.author)}" data-desc="${escapeHtml((feed.desc || '').slice(0, 40))}" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="tryFallback(this)"></div>`;
                }).join('');
                mediaHtml = `<div class="lui-media-grid" style="margin-top:10px;">${cells}</div>`;
            }
            let commentsHtml = `<div style="margin-top:10px; padding-top:10px; border-top:1px solid var(--line);">`;
            if (feed.comments && feed.comments.length) {
                for (let ci = 0; ci < feed.comments.length; ci++) {
                    const c = feed.comments[ci];
                    const canDel = isAdmin || c.author === currentUser;
                    commentsHtml += `<div style="font-size:13px; line-height:1.7; padding:3px 0;"><b>${c.authorName || c.author}</b> ${escapeHtml(c.content)}<span style="color:var(--ink-3); margin-left:6px; font-size:11px;">${c.time}</span>${canDel ? `<button class="lui-btn sm ghost" style="margin-left:6px; padding:2px 8px; min-height:26px;" onclick="deleteComment('${feed.id}',${ci})">删除</button>` : ''}</div>`;
                }
            }
            commentsHtml += `<div style="display:flex; gap:8px; margin-top:6px;"><input type="text" id="comment_input_${feed.id}" class="lui-input sm" placeholder="写评论…" style="flex:1;"><button class="lui-btn tonal sm" onclick="addFeedComment('${feed.id}', document.getElementById('comment_input_${feed.id}').value);document.getElementById('comment_input_${feed.id}').value=''">评论</button></div></div>`;
            const likes = feed.likes || [];
            const hasLiked = likes.includes(currentUser);
            const likeUsersHtml = likes.map(u => `<span class="lui-tag" style="margin-right:4px;">${escapeHtml(u)}</span>`).join('');
            const likeHtml = `<div style="display:flex; align-items:center; gap:10px; margin-top:10px;">
                <button class="lui-btn sm ${hasLiked ? 'primary': 'tonal'}" onclick="toggleFeedLike('${feed.id}')"><svg class="lui-icon s16"><use href="assets/icons.svg#${hasLiked ? 'i-heart-fill': 'i-heart'}"/></svg>${hasLiked ? '已赞': '点赞'} ${likes.length}</button>
                ${canDelete ? `<button class="lui-btn sm ghost" style="margin-left:auto;" onclick="deleteFeed('${feed.id}')"><svg class="lui-icon s16"><use href="assets/icons.svg#i-trash"/></svg></button>` : ''}
                ${adminVisCtrl('feed', feed.id, feed.visibility)}
            </div>${likes.length ? `<div style="margin-top:8px;">${likeUsersHtml}</div>` : ''}`;
            html += `<div class="lui-card" style="margin-bottom:12px;">
                <div style="display:flex; align-items:center; gap:10px;">${authorAvatarHtml(feed.author, feed.authorName)}<div style="flex:1; min-width:0;"><div style="font-size:14px; font-weight:600;">${feed.authorName}</div><div style="font-size:11px; color:var(--ink-3);">${feed.time}</div></div></div>
                ${feed.desc ? `<div style="margin-top:10px; font-size:15px; line-height:1.7;">${escapeHtml(feed.desc)}</div>` : ''}
                ${mediaHtml}${likeHtml}${commentsHtml}
            </div>`;
        }
        document.getElementById('galleryContainer').innerHTML = html;
        window.__justLikedFeed = null;
    }
    async function addFeedComment(feedId, content) {
        if (!(await requirePermission('comment'))) return;
        if (!content.trim()) return;
        const commentObj = { author: currentUser, authorName: authorDisplay(currentUser), content, time: new Date().toLocaleString() };
        try {
            const { data } = await sb.from('feeds').select('comments').eq('id', feedId).single();
            const currentComments = data ? (data.comments || []) : [];
            currentComments.unshift(commentObj);
            await sb.from('feeds').update({ comments: currentComments }).eq('id', feedId);
            logAction('comment_feed', { feed_id: feedId, content: content.substring(0, 50) });
        } catch (e) { console.error(e); }
        const inputEl = document.getElementById('comment_input_'+ feedId);
        const commentsContainer = inputEl ? inputEl.parentElement.parentElement : null;
        if (commentsContainer) {
            const firstComment = commentsContainer.querySelector('.comment-item');
            const newCommentDiv = document.createElement('div');
            newCommentDiv.style.cssText = 'font-size:13px; line-height:1.7; padding:3px 0;';
            newCommentDiv.innerHTML = `<strong>${commentObj.authorName}</strong> ${escapeHtml(commentObj.content)}<span style="color:var(--ink-3); margin-left:6px; font-size:11px;">${commentObj.time}</span><button class="lui-btn sm ghost" style="margin-left:6px; padding:2px 8px; min-height:26px;" onclick="deleteComment('${feedId}',0)">删除</button>`;
            if (firstComment) commentsContainer.insertBefore(newCommentDiv, firstComment);
            else commentsContainer.insertBefore(newCommentDiv, inputEl.parentElement);
        }
        inputEl.value = '';
        addDanmaku(`${authorDisplay(currentUser)} 评论了动态`);
    }
    async function deleteComment(feedId, commentIdx) {
        if (!(await luiConfirm('删除这条评论？删除后进入「回收站」，可恢复。', { okText: '删除评论'}))) return;
        try {
            const { data } = await sb.from('feeds').select('comments').eq('id', feedId).single();
            if (data) {
                const currentComments = data.comments || [];
                const deletedComment = currentComments[commentIdx];
                if (!(await ensureCommentMutationAllowed(deletedComment))) return;
                currentComments.splice(commentIdx, 1);
                await sb.from('feeds').update({ comments: currentComments }).eq('id', feedId);
                logAction('delete_comment_feed', { feed_id: feedId, comment_author: deletedComment ? deletedComment.author : 'unknown'});
            }
            toast('评论已删除', 'success');
        } catch (e) { console.error(e); toast('删除失败：'+ (e.message || '未知错误'), 'error'); }
        renderFeeds({ force: true });
    }
    async function deleteFeed(id) {
        if (!(await canDeleteRecord('feeds', id))) return;
        if (!(await luiConfirm('删除这条动态？删除后进入「回收站」，可恢复。', { okText: '删除动态'}))) return;
        try { await trashApi('delete','feeds',id); logAction('delete_feed', { feed_id: id }); toast('已移入回收站，可在后台恢复', 'success'); }
        catch (e) { console.error(e); toast('删除失败：'+ (e.message || '未知错误'), 'error'); }
        renderFeeds({ force: true });
    }
    async function toggleFeedLike(feedId) {
        if (!currentUser) { alert('请先登录'); return; }
        if (!(await requirePermission('comment'))) return;
        try {
            const { data, error } = await sb.from('feeds').select('likes').eq('id', feedId).single();
            if (error) throw error;
            const currentLikes = data ? (data.likes || []) : [];
            const hasLiked = currentLikes.includes(currentUser);
            if (hasLiked) { currentLikes.splice(currentLikes.indexOf(currentUser), 1); logAction('unlike_feed', { feed_id: feedId }); window.__justLikedFeed = null; }
            else { currentLikes.push(currentUser); logAction('like_feed', { feed_id: feedId }); window.__justLikedFeed = feedId; }
            const { error: updateError } = await sb.from('feeds').update({ likes: currentLikes }).eq('id', feedId);
            if (updateError) throw updateError;
            renderFeeds({ force: true });
        } catch (e) { console.error('点赞失败:', e); toast('操作失败：'+ (e.message || '未知错误') + '，已同步最新状态', 'error'); renderFeeds({ force: true }); }
    }

    // ---------- 留言板（图片直显） ----------
    async function addMessageWithPhoto() {
        if (!(await requirePermission('full'))) return;
        const content = document.getElementById('messageInput').value.trim();
        const fileInput = document.getElementById('messagePhotoInput');
        const file = fileInput.files[0];
        if (!content && !file) { alert('请写点内容或上传照片'); return; }
        const btn = document.getElementById('msgSubmitBtn');
        if (btn) { btn.disabled = true; btn.innerText = '上传中...'; }
        let photoUrl = null;
        if (file) photoUrl = await uploadToBucket(new File([file.slice(0, file.size, file.type)], file.name, { type: file.type }), 'messages');
        const newMsg = { author: currentUser, author_name: authorDisplay(currentUser), content: content || '', photo: photoUrl, comments: [], visibility: 'public'};
        try { await sb.from('messages').insert(newMsg); logAction('publish_message', { content: (content || '').substring(0, 50), has_photo: !!photoUrl }); } catch (e) { console.error(e); }
        document.getElementById('messageInput').value = '';
        fileInput.value = '';
        var _pn = document.getElementById('messagePhotoName'); if (_pn) _pn.textContent = '添加照片（可选）';
        document.getElementById('messagePhotoPreview').innerHTML = '';
        if (btn) { btn.disabled = false; btn.innerText = '发送留言'; }
        renderMessages({ force: false });
        addDanmaku(`${authorDisplay(currentUser)} 在留言板说了悄悄话`);
        notifyEvent('message', content);
    }
    async function renderMessages(options = {}) {
        if (!shouldReloadSection('message', options && options.force)) return;
        let msgs = [];
        try {
            const rows = await getCachedRows('messages', 'id,content,photo,author,author_name,created_at,comments,likes,visibility', { limit: PAGE_LIMIT, force: options.force });
            msgs = (rows || []).map(m => ({
                id: m.id, content: m.content || '', photo: m.photo, author: m.author,
                author_name: m.author_name, time: new Date(m.created_at).toLocaleString(),
                comments: m.comments || [], likes: m.likes || [], visibility: normalizeVisibility(m.visibility)
            }));
            msgs = msgs.filter(canViewRecord);
            markSectionLoaded('message');
        } catch (e) {
            markSectionFailed('message');
            document.getElementById('messageList').innerHTML = '<div class="lui-empty"><div class="e-icon"><svg class="lui-icon"><use href="assets/icons.svg#i-alert"/></svg></div><div class="e-title">加载失败</div><div class="e-text">网络或服务暂时不可用</div><button class="lui-btn tonal sm" onclick="renderMessages({force:true})">点击重试</button></div>';
            return;
        }
        const listEl = document.getElementById('messageList');
        const scrollTop = listEl ? listEl.scrollTop : 0;
        let html = msgs.map(m => {
            const canDelete = isAdmin || m.author === currentUser;
            // 留言图片直接显示（无“查看图片”按钮）
            const photoHtml = m.photo ? `<div class="lui-media-grid c2" style="margin-top:10px;"><div class="lui-photo" onclick="openImageModal('${imgProxy(m.photo)}')"><img src="${imgProxy(m.photo)}" data-source="留言板" data-author="${escapeHtml(m.author_name || m.author)}" data-desc="${escapeHtml((m.content || '').slice(0, 40))}" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="tryFallback(this)"></div></div>` : '';
            let commentsHtml = `<div style="margin-top:10px; padding-top:10px; border-top:1px solid var(--line);">`;
            if (m.comments && m.comments.length) {
                for (let ci = 0; ci < m.comments.length; ci++) {
                    const c = m.comments[ci];
                    const canDel = isAdmin || c.author === currentUser;
                    commentsHtml += `<div style="font-size:13px; line-height:1.7; padding:3px 0;"><b>${c.authorName || c.author}</b> ${escapeHtml(c.content)}<span style="color:var(--ink-3); margin-left:6px; font-size:11px;">${c.time}</span>${canDel ? `<button class="lui-btn sm ghost" style="margin-left:6px; padding:2px 8px; min-height:26px;" onclick="deleteMsgComment('${m.id}',${ci})">删除</button>` : ''}</div>`;
                }
            }
            commentsHtml += `<div style="display:flex; gap:8px; margin-top:6px;"><input type="text" id="msg_comment_input_${m.id}" class="lui-input sm" placeholder="回复悄悄话…" style="flex:1;"><button class="lui-btn tonal sm" onclick="addMsgComment('${m.id}', document.getElementById('msg_comment_input_${m.id}').value);document.getElementById('msg_comment_input_${m.id}').value=''">回复</button></div></div>`;
            const msgLikes = m.likes || [];
            const msgHasLiked = msgLikes.includes(currentUser);
            const msgLikeUsersHtml = msgLikes.map(u => `<span class="lui-tag" style="margin-right:4px;">${escapeHtml(u)}</span>`).join('');
            const msgLikeHtml = `<div style="display:flex; align-items:center; gap:10px; margin-top:10px;">
                <button class="lui-btn sm ${msgHasLiked ? 'primary': 'tonal'}" onclick="toggleMessageLike('${m.id}')"><svg class="lui-icon s16"><use href="assets/icons.svg#${msgHasLiked ? 'i-heart-fill': 'i-heart'}"/></svg>${msgHasLiked ? '已赞': '点赞'} ${msgLikes.length}</button>
                ${canDelete ? `<button class="lui-btn sm ghost" style="margin-left:auto;" onclick="deleteMsg('${m.id}')"><svg class="lui-icon s16"><use href="assets/icons.svg#i-trash"/></svg></button>` : ''}
                ${adminVisCtrl('message', m.id, m.visibility)}
            </div>${msgLikes.length ? `<div style="margin-top:8px;">${msgLikeUsersHtml}</div>` : ''}`;
            return `<div class="lui-card" style="margin-bottom:12px;">
                <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px;">${authorAvatarHtml(m.author, m.author_name)}<div style="flex:1; min-width:0;"><div style="font-size:13px; font-weight:600;">${m.author_name}</div><div style="font-size:11px; color:var(--ink-3);">${m.time}</div></div></div>
                <div style="font-size:15px; line-height:1.7;">${escapeHtml(m.content)}</div>${photoHtml}
                ${msgLikeHtml}${commentsHtml}
            </div>`;
        }).join('');
        listEl.innerHTML = html || '<div class="lui-empty"><div class="e-icon"><svg class="lui-icon"><use href="assets/icons.svg#i-message"/></svg></div><div class="e-title">还没有留言</div><div class="e-text">写下第一句悄悄话吧</div></div>';
        window.__justLikedMsg = null;
        if (listEl) listEl.scrollTop = scrollTop;
    }
    async function addMsgComment(msgId, content) {
        if (!(await requirePermission('comment'))) return;
        if (!content.trim()) return;
        const commentObj = { author: currentUser, authorName: authorDisplay(currentUser), content, time: new Date().toLocaleString() };
        try {
            const { data } = await sb.from('messages').select('comments').eq('id', msgId).single();
            const currentComments = data ? (data.comments || []) : [];
            currentComments.unshift(commentObj);
            await sb.from('messages').update({ comments: currentComments }).eq('id', msgId);
            logAction('comment_message', { msg_id: msgId, content: content.substring(0, 50) });
        } catch (e) { console.error(e); }
        const inputEl = document.getElementById('msg_comment_input_'+ msgId);
        const commentsContainer = inputEl ? inputEl.parentElement.parentElement : null;
        if (commentsContainer) {
            const firstComment = commentsContainer.querySelector('.comment-item');
            const newCommentDiv = document.createElement('div');
            newCommentDiv.style.cssText = 'font-size:13px; line-height:1.7; padding:3px 0;';
            newCommentDiv.innerHTML = `<strong>${commentObj.authorName}</strong> ${escapeHtml(commentObj.content)}<span style="color:var(--ink-3); margin-left:6px; font-size:11px;">${commentObj.time}</span><button class="lui-btn sm ghost" style="margin-left:6px; padding:2px 8px; min-height:26px;" onclick="deleteMsgComment('${msgId}',0)">删除</button>`;
            if (firstComment) commentsContainer.insertBefore(newCommentDiv, firstComment);
            else commentsContainer.insertBefore(newCommentDiv, inputEl.parentElement);
        }
        inputEl.value = '';
    }
    async function deleteMsgComment(msgId, commentIdx) {
        if (!(await luiConfirm('删除这条回复？删除后进入「回收站」，可恢复。', { okText: '删除回复'}))) return;
        try {
            const { data } = await sb.from('messages').select('comments').eq('id', msgId).single();
            if (data) {
                const currentComments = data.comments || [];
                const deletedComment = currentComments[commentIdx];
                if (!(await ensureCommentMutationAllowed(deletedComment))) return;
                currentComments.splice(commentIdx, 1);
                await sb.from('messages').update({ comments: currentComments }).eq('id', msgId);
                logAction('delete_comment_message', { msg_id: msgId, comment_author: deletedComment ? deletedComment.author : 'unknown'});
            }
            toast('回复已删除', 'success');
        } catch (e) { console.error(e); toast('删除失败：'+ (e.message || '未知错误'), 'error'); }
        renderMessages({ force: true });
    }
    async function deleteMsg(id) {
        if (!(await canDeleteRecord('messages', id))) return;
        if (!(await luiConfirm('删除这条留言？删除后进入「回收站」，可恢复。', { okText: '删除留言'}))) return;
        try { await trashApi('delete','messages',id); logAction('delete_message', { msg_id: id }); toast('已移入回收站，可在后台恢复', 'success'); }
        catch (e) { console.error(e); toast('删除失败：'+ (e.message || '未知错误'), 'error'); }
        renderMessages({ force: true });
    }
    async function toggleMessageLike(msgId) {
        if (!currentUser) { alert('请先登录'); return; }
        if (!(await requirePermission('comment'))) return;
        try {
            const { data, error } = await sb.from('messages').select('likes').eq('id', msgId).single();
            if (error) throw error;
            const currentLikes = data ? (data.likes || []) : [];
            const hasLiked = currentLikes.includes(currentUser);
            if (hasLiked) { currentLikes.splice(currentLikes.indexOf(currentUser), 1); logAction('unlike_message', { msg_id: msgId }); window.__justLikedMsg = null; }
            else { currentLikes.push(currentUser); logAction('like_message', { msg_id: msgId }); window.__justLikedMsg = msgId; }
            const { error: updateError } = await sb.from('messages').update({ likes: currentLikes }).eq('id', msgId);
            if (updateError) throw updateError;
            renderMessages({ force: true });
        } catch (e) { console.error('点赞失败:', e); toast('操作失败：'+ (e.message || '未知错误') + '，已同步最新状态', 'error'); renderMessages({ force: true }); }
    }

    // ---------- 感动的话 ----------
    async function addLove() {
        if (!(await requirePermission('full'))) return;
        const val = document.getElementById('loveInput').value.trim();
        if (!val) return;
        const privacy = document.querySelector('input[name="lovePrivacy"]:checked').value;
        const newLove = { author: currentUser, author_name: authorDisplay(currentUser), content: val, privacy, visibility: 'public'};
        try { await sb.from('loves').insert(newLove); logAction('publish_love', { content: val.substring(0, 50), privacy }); } catch (e) { console.error(e); }
        document.getElementById('loveInput').value = '';
        renderLoves({ force: false });
        addDanmaku(`${authorDisplay(currentUser)} 记录了感动的话`);
    }
    async function renderLoves(options = {}) {
        if (!shouldReloadSection('love', options && options.force)) return;
        let loves = [];
        try {
            const rows = await getCachedRows('loves', 'id,content,author,author_name,created_at,privacy,visibility', { limit: PAGE_LIMIT, force: options.force });
            loves = (rows || []).map(l => ({ id: l.id, content: l.content, author: l.author, authorName: l.author_name, time: new Date(l.created_at).toLocaleString(), privacy: l.privacy, visibility: normalizeVisibility(l.visibility) }));
            loves = loves.filter(canViewRecord);
            markSectionLoaded('love');
        } catch (e) { markSectionFailed('love'); document.getElementById('loveList').innerHTML = '<div class="lui-empty"><div class="e-icon"><svg class="lui-icon"><use href="assets/icons.svg#i-alert"/></svg></div><div class="e-title">加载失败</div><div class="e-text">网络或服务暂时不可用</div><button class="lui-btn tonal sm" onclick="renderLoves({force:true})">点击重试</button></div>'; return; }
        let html = loves.map(l => {
            if (l.privacy === 'private'&& l.author !== currentUser && !isAdmin) return '';
            const canDelete = isAdmin || l.author === currentUser;
            return `<div class="lui-card" style="margin-bottom:10px;"><div style="font-size:15px; line-height:1.7;">${escapeHtml(l.content)}${l.privacy === 'private'? '<span class="lui-tag red" style="margin-left:6px;"><svg class="lui-icon s12"><use href="assets/icons.svg#i-lock"/></svg> 私密</span>': ''}</div><div style="display:flex; align-items:center; gap:8px; margin-top:8px; font-size:12px; color:var(--ink-3);"><svg class="lui-icon s14"><use href="assets/icons.svg#i-quote"/></svg><span>${l.authorName}</span><span>·</span><span>${l.time}</span>${canDelete ? `<button class="lui-btn sm ghost" style="margin-left:auto; padding:2px 8px; min-height:26px;" onclick="deleteLove('${l.id}')">删除</button>` : ''}${adminVisCtrl('love', l.id, l.visibility)}</div></div>`;
        }).join('');
        document.getElementById('loveList').innerHTML = html || '<div class="lui-empty"><div class="e-icon"><svg class="lui-icon"><use href="assets/icons.svg#i-heart"/></svg></div><div class="e-title">暂无感动的话</div><div class="e-text">记下让你心动的瞬间</div></div>';
    }
    async function deleteLove(id) { if (!(await canDeleteRecord('loves', id))) return; if (!(await luiConfirm('删除这条感动的话？删除后进入「回收站」，可恢复。', { okText: '删除'}))) return; try { await trashApi('delete','loves',id); toast('已移入回收站，可在后台恢复', 'success'); } catch (e) { console.error(e); toast('删除失败', 'error'); } renderLoves({ force: true }); }

    // ---------- 一起做过的事 ----------
    async function addMemory() {
        if (!(await requirePermission('full'))) return;
        const val = document.getElementById('memoryInput').value.trim();
        if (!val) return;
        const newMemory = { author: currentUser, author_name: authorDisplay(currentUser), content: val, visibility: 'public'};
        try { await sb.from('memories').insert(newMemory); logAction('publish_memory', { content: val.substring(0, 50) }); } catch (e) { console.error(e); }
        document.getElementById('memoryInput').value = '';
        renderMemories({ force: false });
        addDanmaku(`${authorDisplay(currentUser)} 完成了新打卡`);
    }
    async function renderMemories(options = {}) {
        if (!shouldReloadSection('memory', options && options.force)) return;
        let mem = [];
        try {
            const rows = await getCachedRows('memories', 'id,content,author,author_name,created_at,visibility', { limit: PAGE_LIMIT, force: options.force });
            mem = (rows || []).map(m => ({ id: m.id, content: m.content, author: m.author, authorName: m.author_name, time: new Date(m.created_at).toLocaleString(), visibility: normalizeVisibility(m.visibility) }));
            mem = mem.filter(canViewRecord);
            markSectionLoaded('memory');
        } catch (e) { markSectionFailed('memory'); document.getElementById('memoryList').innerHTML = '<div class="lui-empty"><div class="e-icon"><svg class="lui-icon"><use href="assets/icons.svg#i-alert"/></svg></div><div class="e-title">加载失败</div><div class="e-text">网络或服务暂时不可用</div><button class="lui-btn tonal sm" onclick="renderMemories({force:true})">点击重试</button></div>'; return; }
        let html = mem.map(m => { const canDelete = isAdmin || m.author === currentUser; return `<div class="lui-card" style="margin-bottom:10px;"><div style="font-size:15px; line-height:1.7;"><svg class="lui-icon s14" style="color:var(--amber); margin-right:4px; vertical-align:-2px;"><use href="assets/icons.svg#i-sparkles"/></svg>${escapeHtml(m.content)}</div><div style="display:flex; align-items:center; gap:8px; margin-top:8px; font-size:12px; color:var(--ink-3);"><span>${m.authorName}</span><span>·</span><span>${m.time}</span>${canDelete ? `<button class="lui-btn sm ghost" style="margin-left:auto; padding:2px 8px; min-height:26px;" onclick="deleteMemory('${m.id}')">删除</button>` : ''}${adminVisCtrl('memory', m.id, m.visibility)}</div></div>`; }).join('');
        document.getElementById('memoryList').innerHTML = html || '<div class="lui-empty"><div class="e-icon"><svg class="lui-icon"><use href="assets/icons.svg#i-cake"/></svg></div><div class="e-title">暂无打卡记录</div><div class="e-text">一起完成的小事都会记在这里</div></div>';
    }
    async function deleteMemory(id) { if (!(await canDeleteRecord('memories', id))) return; if (!(await luiConfirm('删除这条回忆打卡？删除后进入「回收站」，可恢复。', { okText: '删除'}))) return; try { await trashApi('delete','memories',id); toast('已移入回收站，可在后台恢复', 'success'); } catch (e) { console.error(e); toast('删除失败', 'error'); } renderMemories({ force: true }); }

    // ---------- 待办备忘录 ----------
    async function addMemo() {
        if (!(await requirePermission('full'))) return;
        const content = document.getElementById('memoInput').value.trim();
        const priority = document.getElementById('memoPriority').value;
        if (!content) { alert('请输入待办内容'); return; }
        const newMemo = { author: currentUser, author_name: authorDisplay(currentUser), content, priority, done: false, visibility: 'public'};
        try { await sb.from('memos').insert(newMemo); logAction('publish_memo', { content: content.substring(0, 50), priority }); } catch (e) { console.error(e); }
        document.getElementById('memoInput').value = '';
        renderMemos({ force: false });
        addDanmaku(`${authorDisplay(currentUser)} 添加了待办事项`);
    }
    async function renderMemos(options = {}) {
        if (!shouldReloadSection('memo', options && options.force)) return;
        let memos = [];
        try {
            const rows = await getCachedRows('memos', 'id,content,priority,done,author,author_name,created_at,visibility', { limit: PAGE_LIMIT, force: options.force });
            memos = (rows || []).map(m => ({ id: m.id, content: m.content, priority: m.priority || 'normal', done: m.done || false, author: m.author, authorName: m.author_name, time: new Date(m.created_at).toLocaleString(), visibility: normalizeVisibility(m.visibility) }));
            memos = memos.filter(canViewRecord);
            markSectionLoaded('memo');
        } catch (e) { markSectionFailed('memo'); document.getElementById('memoList').innerHTML = '<div class="lui-empty"><div class="e-icon"><svg class="lui-icon"><use href="assets/icons.svg#i-alert"/></svg></div><div class="e-title">加载失败</div><div class="e-text">网络或服务暂时不可用</div><button class="lui-btn tonal sm" onclick="renderMemos({force:true})">点击重试</button></div>'; return; }
        const pc = { normal: 'var(--ink-3)', important: 'var(--amber)', urgent: 'var(--red)'};
        const pl = { normal: '普通', important: '重要', urgent: '紧急'};
        let html = memos.map(m => {
            const canDelete = isAdmin || m.author === currentUser;
            const strike = m.done ? 'done-strike': '';
            return `<div class="lui-card ${strike}" style="margin-bottom:10px; ${m.done ? 'opacity:0.6;': ''}"><div style="display:flex; align-items:center; gap:10px;"><span class="lui-switch"><input type="checkbox" ${m.done ? 'checked': ''} onchange="toggleMemoDone('${m.id}', this.checked)"><span class="track"></span></span><span style="flex:1; font-size:15px; ${m.done ? 'text-decoration:line-through;': ''}"><span class="lui-tag" style="margin-right:6px; color:${pc[m.priority] || pc.normal}; border:1px solid currentColor;">${pl[m.priority] || '普通'}</span><b>${escapeHtml(m.content)}</b></span>${canDelete ? `<button class="lui-btn sm ghost" onclick="deleteMemo('${m.id}')"><svg class="lui-icon s16"><use href="assets/icons.svg#i-trash"/></svg></button>` : ''}${adminVisCtrl('memo', m.id, m.visibility)}</div><div style="font-size:11px; color:var(--ink-3); margin-top:6px;">${m.authorName} · ${m.time}</div></div>`;
        }).join('');
        document.getElementById('memoList').innerHTML = html || '<div class="lui-empty"><div class="e-icon"><svg class="lui-icon"><use href="assets/icons.svg#i-check-square"/></svg></div><div class="e-title">暂无待办事项</div><div class="e-text">添加你们的计划吧</div></div>';
    }
    async function toggleMemoDone(id, done) {
        // 修复：勾选自己的待办只需“评论/点赞”权限即可（原要求 full 权限，低权限用户连自己的都勾不了）
        if (!(await hasPermission('comment'))) { alert('勾选待办需要“评论/点赞”权限，请联系管理员'); return; }
        if (!isAdmin) {
            try { const { data } = await sb.from('memos').select('author').eq('id', id).maybeSingle(); if (data && data.author !== currentUser) { alert('只能勾选自己发布的待办'); return; } } catch (e) {}
        }
        try { await sb.from('memos').update({ done }).eq('id', id); } catch (e) { console.error(e); } renderMemos({ force: true });
    }
    async function deleteMemo(id) { if (!(await canDeleteRecord('memos', id))) return; if (!(await luiConfirm('删除这条待办？删除后进入「回收站」，可恢复。', { okText: '删除'}))) return; try { await trashApi('delete','memos',id); toast('已移入回收站，可在后台恢复', 'success'); } catch (e) { console.error(e); toast('删除失败', 'error'); } renderMemos({ force: true }); }

    // ---------- 行程与纪念日 ----------
    async function addSchedule() {
        if (!(await requirePermission('full'))) return;
        const start = document.getElementById('scheduleStart').value;
        const end = document.getElementById('scheduleEnd').value;
        const title = document.getElementById('scheduleTitle').value.trim();
        if (!start || !title) { alert('请填写开始日期和行程标题'); return; }
        const newSchedule = { author: currentUser, author_name: authorDisplay(currentUser), title, start_date: start, end_date: end || start, visibility: 'public'};
        try { await sb.from('schedules').insert(newSchedule); logAction('publish_schedule', { title: title.substring(0, 50), start_date: start, end_date: end || start }); } catch (e) { console.error(e); }
        document.getElementById('scheduleStart').value = ''; document.getElementById('scheduleEnd').value = ''; document.getElementById('scheduleTitle').value = '';
        renderSchedules({ force: false });
        addDanmaku(`${authorDisplay(currentUser)} 添加了新行程`);
    }
    async function renderSchedules(options = {}) {
        if (!shouldReloadSection('todo-schedules', options && options.force)) return;
        let schedules = [];
        try {
            const rows = await getCachedRows('schedules', 'id,start_date,end_date,title,author,author_name,created_at,visibility', { limit: PAGE_LIMIT, force: options.force });
            schedules = (rows || []).map(s => ({ id: s.id, start: s.start_date, end: s.end_date, title: s.title, author: s.author, authorName: s.author_name, time: new Date(s.created_at).toLocaleString(), visibility: normalizeVisibility(s.visibility) }));
            schedules = schedules.filter(canViewRecord);
            markSectionLoaded('todo-schedules');
        } catch (e) { markSectionFailed('todo-schedules'); document.getElementById('scheduleList').innerHTML = '<div class="lui-empty"><div class="e-icon"><svg class="lui-icon"><use href="assets/icons.svg#i-alert"/></svg></div><div class="e-title">加载失败</div><div class="e-text">网络或服务暂时不可用</div><button class="lui-btn tonal sm" onclick="renderSchedules({force:true})">点击重试</button></div>'; return; }
        let html = schedules.map(s => {
            const canDelete = isAdmin || s.author === currentUser;
            let dateHtml = `<svg class="lui-icon s14" style="color:var(--rose); vertical-align:-2px; margin-right:4px;"><use href="assets/icons.svg#i-calendar"/></svg>${formatPrettyDate(s.start)}`;
            if (s.end && s.end !== s.start) dateHtml += ` ～ ${formatPrettyDate(s.end)}`;
            return `<div class="lui-card" style="margin-bottom:10px;"><div style="font-size:12px; color:var(--rose); margin-bottom:4px;">${dateHtml}</div><div style="font-size:15px; font-weight:600;">${escapeHtml(s.title)}</div><div style="display:flex; align-items:center; gap:8px; margin-top:8px; font-size:12px; color:var(--ink-3);"><span>${s.authorName}</span><span>·</span><span>${s.time}</span>${canDelete ? `<button class="lui-btn sm ghost" style="margin-left:auto; padding:2px 8px; min-height:26px;" onclick="deleteSchedule('${s.id}')">删除</button>` : ''}${adminVisCtrl('schedule', s.id, s.visibility)}</div></div>`;
        }).join('');
        document.getElementById('scheduleList').innerHTML = html || '<div class="lui-empty"><div class="e-icon"><svg class="lui-icon"><use href="assets/icons.svg#i-route"/></svg></div><div class="e-title">暂无行程</div><div class="e-text">添加你们的旅行计划吧</div></div>';
    }
    async function deleteSchedule(id) { if (!(await canDeleteRecord('schedules', id))) return; if (!(await luiConfirm('删除这条行程？删除后进入「回收站」，可恢复。', { okText: '删除'}))) return; try { await trashApi('delete','schedules',id); toast('已移入回收站，可在后台恢复', 'success'); } catch (e) { console.error(e); toast('删除失败', 'error'); } renderSchedules({ force: true }); }
    async function addCountdown() {
        if (!(await requirePermission('full'))) return;
        const name = document.getElementById('countdownName').value.trim();
        const date = document.getElementById('countdownDate').value;
        if (!name || !date) { alert('请填写名称和日期'); return; }
        const newCountdown = { author: currentUser, author_name: authorDisplay(currentUser), name, target_date: date, visibility: 'public'};
        try { await sb.from('countdowns').insert(newCountdown); logAction('publish_countdown', { name: name.substring(0, 50), target_date: date }); } catch (e) { console.error(e); }
        document.getElementById('countdownName').value = ''; document.getElementById('countdownDate').value = '';
        renderCountdowns({ force: false });
        addDanmaku(`${authorDisplay(currentUser)} 添加了纪念日`);
    }
    async function renderCountdowns(options = {}) {
        if (!shouldReloadSection('todo-countdowns', options && options.force)) return;
        let countdowns = [];
        try {
            const rows = await getCachedRows('countdowns', 'id,name,target_date,author,author_name,created_at,visibility', { limit: PAGE_LIMIT, force: options.force });
            countdowns = (rows || []).map(c => ({ id: c.id, name: c.name, date: c.target_date, author: c.author, authorName: c.author_name, time: new Date(c.created_at).toLocaleString(), visibility: normalizeVisibility(c.visibility) }));
            countdowns = countdowns.filter(canViewRecord);
            markSectionLoaded('todo-countdowns');
        } catch (e) { markSectionFailed('todo-countdowns'); document.getElementById('countdownList').innerHTML = '<div class="lui-empty"><div class="e-icon"><svg class="lui-icon"><use href="assets/icons.svg#i-alert"/></svg></div><div class="e-title">加载失败</div><div class="e-text">网络或服务暂时不可用</div><button class="lui-btn tonal sm" onclick="renderCountdowns({force:true})">点击重试</button></div>'; return; }
        const today = new Date(); today.setHours(0, 0, 0, 0);
        let html = '';
        for (let c of countdowns) {
            const canDelete = isAdmin || c.author === currentUser;
            const target = new Date(c.date); target.setHours(0, 0, 0, 0);
            const diff = Math.ceil((target - today) / (1000 * 60 * 60 * 24));
            const status = diff > 0 ? `还有 ${diff} 天` : diff === 0 ? '就是今天！': `已过 ${-diff} 天`;
            const stTag = diff >= 0 ? 'rose': '';
            html += `<div class="lui-card" style="margin-bottom:10px; display:flex; align-items:center; gap:10px;"><div style="flex:1; min-width:0;"><div style="font-size:15px; font-weight:600;">${escapeHtml(c.name)}</div><div style="font-size:11px; color:var(--ink-3); margin-top:2px;"><svg class="lui-icon s12" style="vertical-align:-1px; margin-right:3px;"><use href="assets/icons.svg#i-calendar"/></svg>${formatPrettyDate(c.date)}</div></div><span class="lui-tag ${stTag}">${status}</span>${canDelete ? `<button class="lui-btn sm ghost" onclick="deleteCountdown('${c.id}')"><svg class="lui-icon s16"><use href="assets/icons.svg#i-trash"/></svg></button>` : ''}${adminVisCtrl('countdown', c.id, c.visibility)}</div>`;
        }
        document.getElementById('countdownList').innerHTML = html || '<div class="lui-empty"><div class="e-icon"><svg class="lui-icon"><use href="assets/icons.svg#i-cake"/></svg></div><div class="e-title">暂无纪念日</div><div class="e-text">添加你们的特殊日子吧</div></div>';
    }
    async function deleteCountdown(id) { if (!(await canDeleteRecord('countdowns', id))) return; if (!(await luiConfirm('删除这个纪念日？删除后进入「回收站」，可恢复。', { okText: '删除'}))) return; try { await trashApi('delete','countdowns',id); toast('已移入回收站，可在后台恢复', 'success'); } catch (e) { console.error(e); toast('删除失败', 'error'); } renderCountdowns({ force: true }); }

    // ---------- 旅行地图 ----------
    // 底图为高德 GCJ-02，库内统一存 WGS-84，显示/落库时双向转换
    const GCJ_PI = 3.1415926535897932384626, GCJ_A = 6378245.0, GCJ_EE = 0.00669342162296594323;
    function gcjOutOfChina(lng, lat) { return (lng < 72.004 || lng > 137.8347) || (lat < 0.8293 || lat > 55.8271); }
    function gcjTLat(x, y) { let r = -100 + 2*x + 3*y + 0.2*y*y + 0.1*x*y + 0.2*Math.sqrt(Math.abs(x)); r += (20*Math.sin(6*x*GCJ_PI)+20*Math.sin(2*x*GCJ_PI))*2/3; r += (20*Math.sin(y*GCJ_PI)+40*Math.sin(y/3*GCJ_PI))*2/3; r += (160*Math.sin(y/12*GCJ_PI)+320*Math.sin(y*GCJ_PI/30))*2/3; return r; }
    function gcjTLng(x, y) { let r = 300 + x + 2*y + 0.1*x*x + 0.1*x*y + 0.1*Math.sqrt(Math.abs(x)); r += (20*Math.sin(6*x*GCJ_PI)+20*Math.sin(2*x*GCJ_PI))*2/3; r += (20*Math.sin(x*GCJ_PI)+40*Math.sin(x/3*GCJ_PI))*2/3; r += (150*Math.sin(x/12*GCJ_PI)+300*Math.sin(x/30*GCJ_PI))*2/3; return r; }
    function wgs84ToGcj02(lng, lat) {
        if (gcjOutOfChina(lng, lat)) return [lng, lat];
        let dLat = gcjTLat(lng-105, lat-35), dLng = gcjTLng(lng-105, lat-35);
        const radLat = lat/180*GCJ_PI; let magic = Math.sin(radLat); magic = 1-GCJ_EE*magic*magic;
        const sm = Math.sqrt(magic);
        dLat = (dLat*180)/((GCJ_A*(1-GCJ_EE))/(magic*sm)*GCJ_PI);
        dLng = (dLng*180)/(GCJ_A/sm*Math.cos(radLat)*GCJ_PI);
        return [lng+dLng, lat+dLat];
    }
    function gcj02ToWgs84(lng, lat) {
        if (gcjOutOfChina(lng, lat)) return [lng, lat];
        const g = wgs84ToGcj02(lng, lat);
        return [lng*2-g[0], lat*2-g[1]];
    }
    function mapPinIcon() {
        return L.divIcon({ className: 'lui-map-pin', iconSize: [28,36], iconAnchor: [14,34], popupAnchor: [0,-30],
            html: '<svg width="28" height="36" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z" fill="#C94C73" stroke="#fff" stroke-width="1.6"/><circle cx="12" cy="10" r="2.6" fill="#fff"/></svg>' });
    }
    function initMap() {
        if (map) return;
        const c0 = wgs84ToGcj02(116.4074, 39.9042);
        map = L.map('map').setView([c0[1], c0[0]], 5);
        L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', { subdomains: '1234', attribution: '&copy; 高德地图', maxZoom: 18 }).addTo(map);
        loadMarkers({ force: true });
        map.on('click', (e) => { const name = prompt('输入地点名称:', `记忆地点`); if (name) { const w = gcj02ToWgs84(e.latlng.lng, e.latlng.lat); addMarker(w[1], w[0], name); } });
    }
    async function loadMarkers(options = {}) {
        if (!shouldReloadSection('travel', options && options.force)) return;
        try {
            // 修复：按时间倒序取最新标记（原 ascending 会截掉最新标记）+ 缓存增量；真实表无 description 列
            const rows = await getCachedRows('travel_markers', 'id,lat,lng,name,author,author_name,created_at,visibility', { ascending: false, limit: MAP_LIMIT, force: options.force });
            markers = (rows || []).map(m => ({ id: m.id, lat: m.lat, lng: m.lng, name: m.name, author: m.author, authorName: m.author_name, time: new Date(m.created_at).toLocaleString(), visibility: normalizeVisibility(m.visibility) }));
            markers = markers.filter(canViewRecord);
            markSectionLoaded('travel');
        } catch (e) { markSectionFailed('travel'); renderMarkerList(); return; }
        if (map) {
            map.eachLayer(layer => { if (layer instanceof L.Marker) map.removeLayer(layer); });
            for (let m of markers) { const g = wgs84ToGcj02(m.lng, m.lat); L.marker([g[1], g[0]], { icon: mapPinIcon() }).addTo(map).bindPopup(`<b>${escapeHtml(m.name)}</b><br>${escapeHtml(m.authorName)} · ${escapeHtml(m.time || '')}`); }
        }
        renderMarkerList();
    }
    async function addMarker(lat, lng, name) {
        if (!(await requirePermission('full'))) return;
        const newMarker = { lat, lng, name, author: currentUser, author_name: authorDisplay(currentUser), visibility: 'public'};
        try { await sb.from('travel_markers').insert(newMarker); logAction('publish_marker', { name: name.substring(0, 50), lat, lng }); } catch (e) { console.error(e); }
        loadMarkers({ force: false });
        addDanmaku(`${authorDisplay(currentUser)} 标记了地点：${name}`);
    }
    function addMarkerFromInput() {
        const name = document.getElementById('markerName').value.trim();
        if (!name) { alert('请输入地点名称'); return; }
        if (map) { const c = map.getCenter(); const w = gcj02ToWgs84(c.lng, c.lat); addMarker(w[1], w[0], name); document.getElementById('markerName').value = ''; } else alert('地图未加载');
    }
    function renderMarkerList() {
        let html = '';
        for (let m of markers.slice().reverse()) {
            const canDelete = isAdmin || m.author === currentUser;
            html += `<div class="lui-card" style="margin-bottom:8px; display:flex; align-items:center; gap:10px;"><span class="lui-avatar s32" style="color:var(--rose);"><svg class="lui-icon s16"><use href="assets/icons.svg#i-map-pin"/></svg></span><div style="flex:1; min-width:0;"><div style="font-size:14px; font-weight:600;">${escapeHtml(m.name)}</div><div style="font-size:11px; color:var(--ink-3); margin-top:2px;">${escapeHtml(m.authorName)} · ${m.time}</div></div>${canDelete ? `<button class="lui-btn sm ghost" onclick="deleteMarker('${m.id}')"><svg class="lui-icon s16"><use href="assets/icons.svg#i-trash"/></svg></button>` : ''}${adminVisCtrl('marker', m.id, m.visibility)}</div>`;
        }
        document.getElementById('markerList').innerHTML = html || '<div class="lui-empty"><div class="e-icon"><svg class="lui-icon"><use href="assets/icons.svg#i-map-pin"/></svg></div><div class="e-title">暂无标记</div><div class="e-text">点击地图添加回忆地点</div></div>';
    }
    async function deleteMarker(id) { if (!(await canDeleteRecord('travel_markers', id))) return; if (!(await luiConfirm('删除这个地点标记？删除后进入「回收站」，可恢复。', { okText: '删除'}))) return; try { await trashApi('delete','travel_markers',id); toast('已移入回收站，可在后台恢复', 'success'); } catch (e) { console.error(e); toast('删除失败', 'error'); } loadMarkers({ force: true }); }

    // ---------- 生气模式 ----------
    async function toggleAngryMode() {
        if (!(await requirePermission('full'))) return;
        try {
            const { data } = await sb.from('angry_mode').select('id,enabled,by').limit(1).maybeSingle();
            const mode = data || { enabled: false, by: ''};
            if (mode.enabled) {
                await sb.from('angry_mode').update({ enabled: false, by: ''}).eq('id', mode.id);
                logAction('angry_off', {});
                document.getElementById('angryBtn').innerText = '取消生气模式';
                document.getElementById('angryStatus').textContent = '当前状态：没有生气，开开心心~';
                sessionStorage.removeItem('couple_angry_silent');
                alert('已取消生气模式');
            } else {
                if (mode.id) await sb.from('angry_mode').update({ enabled: true, by: currentUser }).eq('id', mode.id);
                else await sb.from('angry_mode').insert({ enabled: true, by: currentUser });
                logAction('angry_on', {});
                document.getElementById('angryBtn').innerText = '取消生气模式';
                document.getElementById('angryStatus').textContent = '生气模式已开启';
                alert('生气模式已开启');
            }
        } catch (e) {
            // 云端不可用时降级为本地状态（同时尝试补救落库，避免跨设备失效）
            try { const { data: existing } = await sb.from('angry_mode').select('id,enabled,by').limit(1).maybeSingle(); if (existing) await sb.from('angry_mode').update({ enabled: true, by: currentUser }).eq('id', existing.id); else await sb.from('angry_mode').insert({ enabled: true, by: currentUser }); } catch (_) {}
            const mode = JSON.parse(localStorage.getItem('couple_angry') || '{"enabled":false,"by":""}');
            if (mode.enabled) { localStorage.setItem('couple_angry', JSON.stringify({ enabled: false, by: ''})); document.getElementById('angryBtn').innerText = '启用生气模式'; document.getElementById('angryStatus').textContent = '当前状态：没有生气，开开心心~'; }
            else { localStorage.setItem('couple_angry', JSON.stringify({ enabled: true, by: currentUser })); document.getElementById('angryBtn').innerText = '取消生气模式'; document.getElementById('angryStatus').textContent = '生气模式已开启'; }
        }
        loadAngryData();
    }
    // 修复：apologies 表以真实列（id,content,created_at,status）操作，零报错；
    // 升级提示：在 Supabase SQL Editor 执行下面 SQL 加列后，可启用云端记录作者信息（告诉我即可切换）
    //   ALTER TABLE public.apologies ADD COLUMN IF NOT EXISTS author text;
    //   ALTER TABLE public.apologies ADD COLUMN IF NOT EXISTS author_name text;
    async function loadAngryData() {
        let mode = { enabled: false, by: ''};
        let ap = [];
        try {
            const { data: modeData } = await sb.from('angry_mode').select('id,enabled,by').limit(1).maybeSingle();
            if (modeData) mode = modeData;
            const { data: apData } = await sb.from('apologies').select('id,content,created_at,status').is('deleted_at', null).order('created_at', { ascending: false }).limit(PAGE_LIMIT);
            const cloudItems = (apData || []).map(a => ({ id: a.id, content: a.content, from: '', fromName: '', ts: new Date(a.created_at).getTime(), time: new Date(a.created_at).toLocaleString(), status: a.status || 'pending'}));
            // 合并本地兜底记录（换设备前/离线提交的道歉不丢，含发送人信息）
            const localItems = (JSON.parse(localStorage.getItem('couple_apologies') || '[]')).map(a => ({ ...a, ts: a.ts || Date.now() }));
            const seen = new Set(); ap = [];
            for (const item of [...cloudItems, ...localItems]) { const k = String(item.id); if (seen.has(k)) continue; seen.add(k); ap.push(item); }
            ap.sort((x, y) => (y.ts || 0) - (x.ts || 0));
        } catch (e) { mode = JSON.parse(localStorage.getItem('couple_angry') || '{"enabled":false}'); ap = JSON.parse(localStorage.getItem('couple_apologies') || '[]'); }
        // 修复：对方点了“暂不道歉”后，本会话不再强制弹遮罩打断浏览（状态仍正常显示）
        const silent = sessionStorage.getItem('couple_angry_silent') === '1';
        if (mode.enabled && mode.by !== currentUser && currentUser && !isAdmin && !silent) document.getElementById('angryMask').style.display = 'flex';
        if (mode.enabled) { document.getElementById('angryBtn').innerText = '取消生气模式'; document.getElementById('angryStatus').textContent = '生气模式已开启（开启者：'+ (escapeHtml(stripNameEmoji(mode.by)) || '未知') + '）'; }
        else { document.getElementById('angryBtn').innerText = '启用生气模式'; document.getElementById('angryStatus').textContent = '当前状态：没有生气，开开心心~'; }
        let html = ap.map(a => `<div class="lui-card" style="margin-bottom:10px;"><div style="font-size:15px; line-height:1.7;"><svg class="lui-icon s14" style="color:var(--rose); vertical-align:-2px; margin-right:4px;"><use href="assets/icons.svg#i-heart-crack"/></svg>${escapeHtml(a.content)}</div><div style="display:flex; align-items:center; gap:8px; margin-top:8px; font-size:12px; color:var(--ink-3);"><span>${escapeHtml(stripNameEmoji(a.fromName || a.from || '某人'))}</span><span>·</span><span>${a.time || ''}</span><span class="lui-tag ${a.status === 'pass'? 'green': a.status === 'reject'? 'red': 'amber'}" style="margin-left:auto;">${a.status === 'pass'? '已原谅': (a.status === 'reject'? '未原谅': '待审核')}</span></div>${((mode.enabled && mode.by === currentUser) || isAdmin) && a.status === 'pending'? `<div style="margin-top:10px; display:flex; gap:8px;"><button class="lui-btn sm primary" onclick="reviewApology('${a.id}',true)">原谅</button> <button class="lui-btn sm ghost" onclick="reviewApology('${a.id}',false)">拒绝</button></div>` : ''}</div>`).join('');
        document.getElementById('apologyList').innerHTML = html || '<div class="lui-empty"><div class="e-icon"><svg class="lui-icon"><use href="assets/icons.svg#i-heart"/></svg></div><div class="e-title">暂无道歉记录</div></div>';
    }
    async function submitApology() {
        if (!(await requirePermission('comment'))) return;
        const content = document.getElementById('apologyInput').value.trim();
        if (!content) { alert('写点道歉内容~'); return; }
        // 修复：本地必存（秒见 + 云端不可用时不丢）+ 云端尝试写真实存在的列
        const localRec = { id: 'local-'+ Date.now(), content, from: currentUser, fromName: authorDisplay(currentUser), ts: Date.now(), time: new Date().toLocaleString(), status: 'pending'};
        const ap = JSON.parse(localStorage.getItem('couple_apologies') || '[]'); ap.unshift(localRec); localStorage.setItem('couple_apologies', JSON.stringify(ap));
        try {
            await sb.from('apologies').insert({ content, status: 'pending', created_at: new Date().toISOString() });
            logAction('apology_submit', { content: content.substring(0, 50) });
        } catch (e) { console.warn('道歉云端写入失败（已保存在本机）:', e); }
        alert('道歉已提交，等待TA原谅~');
        document.getElementById('apologyInput').value = '';
        closeAngryMask();
        loadAngryData();
    }
    function closeAngryMask(silent) { document.getElementById('angryMask').style.display = 'none'; if (silent) sessionStorage.setItem('couple_angry_silent', '1'); }
    async function reviewApology(id, pass) {
        try {
            await sb.from('apologies').update({ status: pass ? 'pass': 'reject'}).eq('id', id);
            logAction(pass ? 'apology_pass': 'apology_reject', { apology_id: id });
            if (pass) {
                // 修复：原谅时必须按 id 关闭生气模式，避免无过滤 update 影响全表
                const { data: am } = await sb.from('angry_mode').select('id').limit(1).maybeSingle();
                if (am && am.id) await sb.from('angry_mode').update({ enabled: false, by: ''}).eq('id', am.id);
                sessionStorage.removeItem('couple_angry_silent');
                alert('已原谅，和好啦~');
            } else alert('未原谅，继续道歉吧~');
        } catch (e) { const ap = JSON.parse(localStorage.getItem('couple_apologies') || '[]'); const idx = ap.findIndex(a => a.id == id); if (idx >= 0) { ap[idx].status = pass ? 'pass': 'reject'; if (pass) localStorage.setItem('couple_angry', JSON.stringify({ enabled: false, by: ''})); localStorage.setItem('couple_apologies', JSON.stringify(ap)); } }
        loadAngryData();
    }

    // ---------- 梦幻气泡池 ----------
    async function loadBubbleConfig(options = {}) {
        const loadPhotos = options.loadPhotos === true;
        try {
            const { data: configData } = await sb.from('bubble_config').select('id,enabled,interval').limit(1).maybeSingle();
            if (configData) { bubbleEnabled = configData.enabled !== undefined ? configData.enabled : true; bubbleIntervalSec = configData.interval || 12; }
            if (loadPhotos) {
                // 气泡图源：专属气泡照片 + 留言板照片 + 相册照片（默认就有照片，无需手动上传）
                const pool = [];
                const seen = new Set();
                const addBubble = (url, id) => { if (url && !seen.has(url)) { seen.add(url); pool.push({ dataUrl: url, id: id || null }); } };
                try { const { data: photosData } = await sb.from('bubble_photos').select('id,photo_url').limit(100); (photosData || []).forEach(p => addBubble(p.photo_url, p.id)); } catch (e) {}
                try { const { data: msgData } = await sb.from('messages').select('photo').not('photo', 'is', null).limit(100); (msgData || []).forEach(m => addBubble(m.photo)); } catch (e) {}
                try { const { data: feedData } = await sb.from('feeds').select('medias').limit(100); (feedData || []).forEach(f => (f.medias || []).forEach(md => { if (md && md.type !== 'video'&& md.data) addBubble(md.data); })); } catch (e) {}
                floatPhotos = pool;
            }
        } catch (e) { const s = localStorage.getItem('couple_float_photos'); if (s) { const c = JSON.parse(s); floatPhotos = c.photos || []; bubbleEnabled = c.enabled !== undefined ? c.enabled : true; bubbleIntervalSec = c.interval || 12; } }
        updateToggleUI();
        const iv = document.getElementById('bubbleInterval'); if (iv) iv.value = bubbleIntervalSec;
        if (loadPhotos) renderBubblePreview();
        if (bubbleEnabled && floatPhotos.length && document.getElementById('mainPage').style.display === 'block') startBubbleGenerator();
        else stopBubbleGenerator();
    }
    async function saveBubbleConfig() {
        try { const { data } = await sb.from('bubble_config').select('id').limit(1).maybeSingle(); if (data && data.id) await sb.from('bubble_config').update({ enabled: bubbleEnabled, interval: bubbleIntervalSec }).eq('id', data.id); else await sb.from('bubble_config').insert({ enabled: bubbleEnabled, interval: bubbleIntervalSec }); }
        catch (e) { localStorage.setItem('couple_float_photos', JSON.stringify({ photos: floatPhotos, enabled: bubbleEnabled, interval: bubbleIntervalSec })); }
    }
    function updateToggleUI() { const t = document.getElementById('bubbleToggle'); if (t) t.checked = !!bubbleEnabled; }
    function renderBubblePreview() {
        const c = document.getElementById('bubblePhotoList');
        if (!c) return;
        const custom = floatPhotos.filter(p => p.id);
        const autoCount = floatPhotos.length - custom.length;
        c.innerHTML = '<div style="width:100%;font-size:12px;color:var(--ink-3);margin-bottom:6px;line-height:1.6;">自动从留言板/相册播放 '+ autoCount + ' 张；下面是你额外上传的专属气泡照片。</div>';
        if (!custom.length) {
            c.innerHTML += '<div style="width:100%;font-size:12px;color:#bbb;">暂无专属照片（可不传，气泡默认用留言板和相册里的照片）。</div>';
            return;
        }
        custom.forEach((p) => {
            const realIdx = floatPhotos.indexOf(p);
            const d = document.createElement('div');
            d.className = 'preview-item';
            d.innerHTML = `<img src="${imgProxy(p.dataUrl)}" loading="lazy" decoding="async" referrerpolicy="no-referrer"><span class="remove-photo" data-idx="${realIdx}"><svg class="lui-icon s14"><use href="assets/icons.svg#i-x"/></svg></span>`;
            d.querySelector('.remove-photo').onclick = async () => {
                try { if (p.id) await sb.from('bubble_photos').delete().eq('id', p.id); } catch (e) {}
                floatPhotos.splice(realIdx, 1);
                renderBubblePreview();
                saveBubbleConfig();
                if (bubbleEnabled) restartBubbleGenerator();
            };
            c.appendChild(d);
        });
    }
    async function addPhotosToBubble(files) {
        if (!(await requirePermission('full'))) return;
        for (let f of Array.from(files)) {
            const url = await uploadToBucket(f, 'bubbles');
            if (url) { try { await sb.from('bubble_photos').insert({ photo_url: url, author: currentUser }); } catch (e) {} }
        }
        loadBubbleConfig({ loadPhotos: true });
    }
    async function saveBubbleSettings() {
        if (!(await requirePermission('full'))) return;
        const toggleEl = document.getElementById('bubbleToggle');
        bubbleEnabled = toggleEl ? !!toggleEl.checked : false;
        bubbleIntervalSec = parseInt(document.getElementById('bubbleInterval').value) || 12;
        await saveBubbleConfig();
        renderBubblePreview();
        if (bubbleEnabled && floatPhotos.length) restartBubbleGenerator();
        else { stopBubbleGenerator(); clearAllDreamBubbles(); }
        closeBubbleSettings();
        alert('背景气泡已保存，双方共享~');
    }
    function closeBubbleSettings() { document.getElementById('bubbleSettingsModal').style.display = 'none'; }
    function createDreamBubble(url) {
        if (!bubbleEnabled || activeBubbleCount >= 1) return;
        activeBubbleCount++;
        const b = document.createElement('img');
        b.className = 'photo-bubble';
        b.src = imgProxy(url);
        b.loading = 'lazy'; b.referrerPolicy = 'no-referrer';
        b.onerror = function () { if (this.parentNode) this.remove(); activeBubbleCount = Math.max(0, activeBubbleCount - 1); };
        const sides = [[2, 5], [75, 5], [2, 60], [75, 60]][Math.floor(Math.random() * 4)];
        b.style.left = sides[0] + '%';
        b.style.top = sides[1] + '%';
        const s = 90 + Math.random() * 60;
        b.style.width = s + 'px'; b.style.height = s + 'px';
        b.style.animation = `dreamyRotate ${20 + Math.random() * 15}s infinite`;
        document.body.appendChild(b);
        setTimeout(() => { if (b.parentNode) { b.style.transition = 'opacity 2s'; b.style.opacity = '0'; setTimeout(() => { b.remove(); activeBubbleCount--; }, 2000); } }, 15000 + Math.random() * 10000);
    }
    function generateDreamBubble() { if (!bubbleEnabled || floatPhotos.length === 0 || activeBubbleCount >= 1) return; const r = floatPhotos[Math.floor(Math.random() * floatPhotos.length)]; if (r) createDreamBubble(r.dataUrl || r); }
    function startBubbleGenerator() { if (bubbleTimer) clearInterval(bubbleTimer); if (bubbleEnabled && floatPhotos.length) { bubbleTimer = setInterval(generateDreamBubble, bubbleIntervalSec * 1000); setTimeout(generateDreamBubble, 3000); } }
    function stopBubbleGenerator() { if (bubbleTimer) clearInterval(bubbleTimer); bubbleTimer = null; }
    function clearAllDreamBubbles() { document.querySelectorAll('.photo-bubble').forEach(el => el.remove()); activeBubbleCount = 0; }
    function restartBubbleGenerator() { stopBubbleGenerator(); clearAllDreamBubbles(); startBubbleGenerator(); }

    // ---------- 在线状态与心跳 ----------
    async function updateActivity() {
        if (!currentUser) return;
        localStorage.setItem('last_activity', Date.now().toString());
        if (Date.now() - lastActivityWrite < ONLINE_STATUS_INTERVAL_MS) return;
        lastActivityWrite = Date.now();
        try { await accountApi('updateActivity'); } catch (e) {}
    }
    function startHeartbeat() { updateActivity(); if (heartbeatInterval) clearInterval(heartbeatInterval); heartbeatInterval = setInterval(updateActivity, ONLINE_STATUS_INTERVAL_MS); }
    function stopHeartbeat() { if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; } if (onlineStatusTimer) { clearInterval(onlineStatusTimer); onlineStatusTimer = null; } }
    async function updateOnlineStatus() {
        if (!currentUser) return;
        try {
            const { user: otherUser } = await accountApi('onlineStatus');
            if (!otherUser) return;
            const statusEl = document.getElementById('onlineStatus');
            if (!statusEl) return;
            const lastActive = otherUser.last_active ? new Date(otherUser.last_active) : null;
            if (!lastActive) { statusEl.innerHTML = ''; return; }
            const diffSec = Math.floor((new Date() - lastActive) / 1000);
            let statusText, dotCls;
            if (diffSec < 30) { statusText = '在线'; dotCls = 'green'; }
            else if (diffSec < 300) { statusText = Math.floor(diffSec / 60) + '分钟前在线'; dotCls = ''; }
            else { statusText = '离线'; dotCls = ''; }
            statusEl.innerHTML = `<span class="lui-status-dot ${dotCls}"></span><span style="font-size:12px; color:var(--ink-2);">${escapeHtml(otherUser.username)} · ${statusText}</span>`;
        } catch (e) {}
    }
    function startAutoSync() {
        if (syncTimer) clearInterval(syncTimer);
        let syncTick = 0;
        syncTimer = setInterval(async () => {
            if (!currentUser) return;
            const activeEl = document.activeElement;
            const isTyping = activeEl && (activeEl.tagName === 'TEXTAREA'|| activeEl.tagName === 'INPUT'|| (activeEl.id && (activeEl.id.startsWith('comment_input_') || activeEl.id.startsWith('msg_comment_input_'))));
            if (isTyping) return;
            syncTick++;
            // 平时增量同步（只拉新增，几KB）；每 3 次（约15分钟）全量对比一次，兜底同步删除
            const force = (syncTick % 3 === 0);
            refreshCurrentSection(force).catch(e => console.log('自动刷新失败（不影响使用）'));
        }, AUTO_SYNC_INTERVAL_MS);
    }
    async function refreshCurrentSection(force = false) {
        if (!currentUser) return;
        const refreshMap = {
            message: (o) => renderMessages(o), gallery: (o) => renderFeeds(o), memory: (o) => renderMemories(o),
            love: (o) => renderLoves(o), memo: (o) => renderMemos(o),
            todo: async (o) => { await renderSchedules(o); await renderCountdowns(o); },
            angry: (o) => loadAngryData(o), travel: (o) => loadMarkers(o)
        };
        const refresh = refreshMap[currentTab] || refreshMap.message;
        await refresh({ force });
    }

    // ---------- 图片/视频查看 ----------
    function openImageModal(src) {
        // 行为埋点：找到被点击的图片，读取来源/作者/描述，生成可读标签
        try {
            const allImgs = Array.from(document.querySelectorAll('#galleryContainer img, #messageList img'));
            const el = allImgs.find(img => img.getAttribute('src') === src || img.src === src);
            if (el && el.dataset.source) {
                trackEvent('查看照片', `[${el.dataset.source}] ${el.dataset.author || '未知'}：${el.dataset.desc || '无描述'}`, { url: String(src || '').slice(0, 120) });
            } else {
                trackEvent('查看照片', (src || '').split('/').pop() || src, { url: String(src || '').slice(0, 120) });
            }
        } catch (e) { trackEvent('查看照片', (src || '').split('/').pop() || src); }
        const imgs = Array.from(document.querySelectorAll('#galleryContainer img, #messageList img'));
        currentPhotosList = imgs.map(img => img.getAttribute('src') || img.src);
        currentPhotoIndex = currentPhotosList.indexOf(src);
        if (currentPhotoIndex === -1) { currentPhotosList = [src]; currentPhotoIndex = 0; }
        updateModalImage();
    }
    function updateModalImage() {
        if (currentPhotosList.length === 0) return;
        const src = currentPhotosList[currentPhotoIndex];
        document.getElementById('modalImage').src = src;
        document.getElementById('imageModal').style.display = 'flex';
        document.getElementById('downloadImageBtn').onclick = () => downloadImage(src);
    }
    function prevPhoto(e) { if (e) e.stopPropagation(); if (currentPhotosList.length <= 1) return; currentPhotoIndex = (currentPhotoIndex - 1 + currentPhotosList.length) % currentPhotosList.length; updateModalImage(); }
    function nextPhoto(e) { if (e) e.stopPropagation(); if (currentPhotosList.length <= 1) return; currentPhotoIndex = (currentPhotoIndex + 1) % currentPhotosList.length; updateModalImage(); }
    function handleDisplaySwipe() { if (touchEndX < touchStartX - 50) nextPhoto(); if (touchEndX > touchStartX + 50) prevPhoto(); }
    function closeModal() { document.getElementById('imageModal').style.display = 'none'; }
    function openVideoModal(src) {
        // 行为埋点：找到被点击的视频元素，读取来源/作者/描述
        try {
            const vids = Array.from(document.querySelectorAll('#galleryContainer video'));
            const el = vids.find(v => v.getAttribute('src') === src || v.src === src);
            if (el && el.dataset.source) {
                trackEvent('查看视频', `[${el.dataset.source}] ${el.dataset.author || '未知'}：${el.dataset.desc || '无描述'}`, { url: String(src || '').slice(0, 120) });
            } else {
                trackEvent('查看视频', (src || '').split('/').pop() || src, { url: String(src || '').slice(0, 120) });
            }
        } catch (e) { trackEvent('查看视频', (src || '').split('/').pop() || src); }
        const v = document.getElementById('modalVideo');
        if (!v) return;
        v.src = src;
        document.getElementById('videoModal').style.display = 'flex';
        const p = v.play(); if (p && p.catch) p.catch(() => {});
    }
    function closeVideoModal() {
        const v = document.getElementById('modalVideo');
        if (v) { v.pause(); v.removeAttribute('src'); v.load(); } // 修复：关闭弹窗后暂停并释放视频，避免声音继续、省流量
        document.getElementById('videoModal').style.display = 'none';
    }

    // ---------- 账号管理 ----------
    function toggleDropdown() { const m = document.getElementById('dropdownMenu'); m.style.display = m.style.display === 'block'? 'none': 'block'; }
    function openAvatarModal() { document.getElementById('avatarModal').style.display = 'flex'; }
    function openPasswordModal() { document.getElementById('passwordModal').style.display = 'flex'; }
    function openUsernameModal() {
        const el = document.getElementById('renameCurrentUser');
        if (el) el.innerText = currentUser || '';
        document.getElementById('newUsernameInput').value = '';
        document.getElementById('renamePwd').value = '';
        document.getElementById('usernameModal').style.display = 'flex';
    }
    async function changeUsername() {
        const newName = document.getElementById('newUsernameInput').value.trim();
        const pwd = document.getElementById('renamePwd').value;
        if (!newName) { alert('请输入新用户名'); return; }
        if (!/^[A-Za-z0-9_.-]+$/.test(newName)) { alert('用户名只能包含字母、数字、下划线、点、减号'); return; }
        if (!pwd) { alert('请输入当前密码确认'); return; }
        if (!(await luiConfirm('确定把用户名从「'+ currentUser + '」改为「'+ newName + '」吗？\n\n你发布的所有动态、留言、点赞、评论会自动归属到新名字，历史内容不会丢失。改完将自动用新名字登录。', { title: '修改用户名', danger: false, okText: '确认修改'}))) return;
        try {
            const res = await accountApi('changeUsername', { newUsername: newName, password: pwd });
            if (res && res.user && res.sessionToken) {
                setSession(res.user.username, res.sessionToken);
                alert('用户名修改成功！已自动用新名字「'+ res.user.username + '」登录，页面即将刷新。');
                location.reload();
            } else {
                alert('修改返回异常，请刷新后用新用户名登录');
                location.reload();
            }
        } catch (e) { alert(e.message || '用户名修改失败'); }
    }
    function openSetUserPasswordModal(username) { document.getElementById('setPwdUsername').value = username; document.getElementById('setPwdNew').value = ''; document.getElementById('setPwdConfirm').value = ''; document.getElementById('setUserPasswordModal').style.display = 'flex'; }
    function closeModalById(id) { document.getElementById(id).style.display = 'none'; }
    function resizeAvatarImage(file, size = 160, quality = 0.82) {
        return new Promise((resolve, reject) => {
            if (!file || !file.type.startsWith('image/')) { reject(new Error('请选择图片文件')); return; }
            const reader = new FileReader();
            reader.onload = e => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    canvas.width = size; canvas.height = size;
                    const ctx = canvas.getContext('2d');
                    const side = Math.min(img.width, img.height);
                    const sx = Math.max(0, (img.width - side) / 2);
                    const sy = Math.max(0, (img.height - side) / 2);
                    ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
                    resolve(canvas.toDataURL('image/jpeg', quality));
                };
                img.onerror = () => reject(new Error('头像图片读取失败'));
                img.src = e.target.result;
            };
            reader.onerror = () => reject(new Error('头像文件读取失败'));
            reader.readAsDataURL(file);
        });
    }
    async function updateAvatar() {
        const file = document.getElementById('avatarInput').files[0];
        if (!file) return;
        try {
            const avatarData = await resizeAvatarImage(file);
            const result = await accountApi('updateAvatar', { avatar: avatarData });
            currentUserInfo = result.user || { ...(currentUserInfo || {}), avatar: avatarData };
            document.getElementById('userAvatarImg').src = avatarData;
            closeModalById('avatarModal');
            logAction('update_avatar', { file_name: file.name, file_size: file.size });
            alert('头像已更新！');
        } catch (err) { alert('头像同步到云端失败：'+ err.message); }
    }
    async function changePassword() {
        const old = document.getElementById('oldPwd').value, newPwd = document.getElementById('newPwd').value, confirm = document.getElementById('confirmPwd').value;
        if (newPwd !== confirm) { alert('两次新密码不一致'); return; }
        if (newPwd.length < 8) { toast('密码至少8位', 'error'); return; }
        try {
            await accountApi('changePassword', { oldPassword: old, newPassword: newPwd });
            logAction('change_password', { success: true });
            alert('密码修改成功，请重新登录'); logout();
        } catch (e) { logAction('change_password', { success: false, reason: e.message }); alert(e.message || '密码修改失败'); }
    }
    async function registerNewUser() {
        const newName = document.getElementById('newUsername').value.trim();
        const newPwd = document.getElementById('newUserPwd').value.trim();
        const isPublic = window.__registerMode === 'public';
        const registerOpen = !!window.__registerOpen;
        const invite = isPublic ? document.getElementById('newUserInvite').value.trim() : '';
        if (!newName || !newPwd) { alert('请填写账号和密码'); return; }
        if (isPublic && !registerOpen && !invite) { alert('请填写注册邀请码'); return; }
        const btn = document.querySelector('#registerModal .submit-btn');
        if (btn) { btn.disabled = true; btn.innerText = '正在注册...'; }
        try {
            if (isPublic) {
                // 登录页公开注册：带邀请码，成功后自动登录
                const result = await accountApi('publicRegister', { username: newName, password: newPwd, inviteCode: invite });
                closeModalById('registerModal');
                if (btn) { btn.disabled = false; btn.innerText = '注册'; }
                if (result && result.sessionToken) {
                    setSession(result.user.username, result.sessionToken);
                    const users = {}; users[result.user.username] = normalizeUserInfo(result.user.username, result.user);
                    document.getElementById('loginPage').style.display = 'none';
                    enterMainSystem(result.user.username, users);
                }
                toast('注册成功，欢迎来到我们的小站！', 'success');
                return;
            }
            await accountApi('createUser', { username: newName, password: newPwd });
        }
        catch (e) { alert('注册失败：'+ e.message); if (btn) { btn.disabled = false; btn.innerText = '注册'; } return; }
        document.getElementById('newUsername').value = ''; document.getElementById('newUserPwd').value = '';
        const invEl = document.getElementById('newUserInvite'); if (invEl) invEl.value = '';
        closeModalById('registerModal');
        if (isAdmin) await renderAdminData();
        if (btn) { btn.disabled = false; btn.innerText = '注册'; }
        alert(`账号 ${newName} 注册成功，已经在后台列表刷新。`);
    }
    async function setUserPassword() {
        if (!(await requireAdmin())) return;
        const username = document.getElementById('setPwdUsername').value.trim();
        const newPassword = document.getElementById('setPwdNew').value;
        const confirm = document.getElementById('setPwdConfirm').value;
        if (!username) { alert('用户不存在'); return; }
        if (newPassword !== confirm) { alert('两次新密码不一致'); return; }
        if (newPassword.length < 8) { toast('密码至少8位', 'error'); return; }
        const btn = document.querySelector('#setUserPasswordModal .submit-btn');
        if (btn) { btn.disabled = true; btn.innerText = '正在保存...'; }
        try {
            await accountApi('setUserPassword', { username, newPassword });
            logAction('admin_reset_pwd', { username });
            closeModalById('setUserPasswordModal');
            await renderAdminData();
            alert(`${username} 的密码已更新，已经立即生效。`);
        } catch (e) { alert('设置密码失败：'+ e.message); }
        finally { if (btn) { btn.disabled = false; btn.innerText = '保存新密码'; } }
    }
    function closeAdminPanel() { document.getElementById('adminPanel').style.display = 'none'; stopAdminMonitorTimer(); unlockBackground(); }
    function startAdminMonitorTimer() {
        stopAdminMonitorTimer();
        adminMonitorTimer = setInterval(function () {
            if (!currentUser) return;
            var content = document.getElementById('adminContent');
            if (!content || document.getElementById('adminPanel').style.display !== 'block') return;
            if (window.__adminTab === 'monitor') renderMonitorTab(content).catch(function () {});
            else if (window.__adminTab === 'security') renderSecurityTab(content).catch(function () {});
        }, 60000);
    }
    function stopAdminMonitorTimer() { if (adminMonitorTimer) { clearInterval(adminMonitorTimer); adminMonitorTimer = null; } }
    function adminSetStorageMode() { const s = document.getElementById('adminStorageModeSelect'); storageMode = s.value; localStorage.setItem('couple_storage_mode', storageMode); alert(`已切换为 ${storageMode === 'cloud'? '图床模式': '本地模式'}`); }
    function loadStorageModeSetting() { const saved = localStorage.getItem('couple_storage_mode'); storageMode = saved === 'local'? 'local': 'cloud'; if (isAdmin && document.getElementById('adminStorageModeSelect')) document.getElementById('adminStorageModeSelect').value = storageMode; }
    async function logout() {
        logAction('logout', { username: currentUser });
        try { await accountApi('logout'); } catch (e) {}
        stopBubbleGenerator(); clearAllDreamBubbles(); stopHeartbeat();
        if (syncTimer) clearInterval(syncTimer);
        document.getElementById('mainPage').style.display = 'none';
        document.getElementById('loginPage').style.display = 'flex';
        currentUser = ''; currentUserInfo = null; isAdmin = false; clearSession();
    }

    // ---------- 管理后台 ----------
    // ===== 后台分区 Tab 框架（控制台：监控/安全/用户/内容/回收站/日志/设置） =====
    var ADMIN_TABS = [
        { key: 'monitor', label: '监控', icon: 'i-gauge'},
        { key: 'security', label: '安全', icon: 'i-shield-check'},
        { key: 'users', label: '用户', icon: 'i-users'},
        { key: 'content', label: '内容', icon: 'i-grid'},
        { key: 'trash', label: '回收站', icon: 'i-trash', badge: true },
        { key: 'logs', label: '日志', icon: 'i-clipboard'},
        { key: 'settings', label: '设置', icon: 'i-settings'}
    ];
    window.__adminTab = 'monitor';
    window.__adminUsers = null;
    window.__adminTrashCount = 0;
    var adminMonitorTimer = null;

    function adminTabsHtml() {
        return ADMIN_TABS.map(function (t) {
            var badge = (t.badge && window.__adminTrashCount > 0) ? '<span class="lui-badge">'+ window.__adminTrashCount + '</span>': '';
            return '<button class="tab '+ (window.__adminTab === t.key ? 'active': '') + '" onclick="switchAdminTab(\''+ t.key + '\')"><svg class="lui-icon"><use href="assets/icons.svg#'+ t.icon + '"/></svg><span>'+ t.label + '</span>'+ badge + '</button>';
        }).join('');
    }
    function refreshTrashBadge() { const e = document.getElementById('adminTabs'); if (e) e.innerHTML = adminTabsHtml(); }
    function switchAdminTab(key) { window.__adminTab = key; refreshTrashBadge(); renderAdminTabBody(); }
    window.switchAdminTab = switchAdminTab;

    async function renderAdminData() {
        const adminContent = document.getElementById('adminContent');
        if (adminContent) adminContent.innerHTML = '<div class="lui-loading"><span class="lui-spinner"></span><span>后台正在加载…</span></div>';
        let users = {};
        try {
            users = await loadUserData({ includeAll: true, allowLocalFallback: false }) || {};
            window.__adminUsers = users;
        } catch (e) {
            if (adminContent) adminContent.innerHTML = '<div class="lui-notice">后台加载失败：'+ escapeHtml(e.message || String(e)) + '<br>请刷新后重试，或确认数据库表字段已执行最新 SQL。</div>';
            return;
        }
        refreshTrashBadge();
        renderAdminTabBody();
        trashApi('list').then(function (res) {
            window.__adminTrashCount = (res.items || []).length;
            refreshTrashBadge();
        }).catch(function () {});
    }

    function renderAdminTabBody() {
        const el = document.getElementById('adminContent');
        if (!el) return;
        const key = window.__adminTab;
        if (key === 'monitor') return renderMonitorTab(el);
        if (key === 'security') return renderSecurityTab(el);
        if (key === 'users') return renderAdminUsers(el);
        if (key === 'content') return renderAdminContentTab(el);
        if (key === 'trash') return renderAdminTrashTab(el);
        if (key === 'logs') return renderAdminLogsTab(el);
        if (key === 'settings') return renderAdminSettingsTab(el);
    }

    var ADMIN_STAT_TABLES = [
        ['feeds', '相册'], ['messages', '留言'], ['loves', '感动'], ['memories', '回忆'],
        ['memos', '待办'], ['schedules', '行程'], ['countdowns', '纪念日'], ['travel_markers', '地图']
    ];
    function fmtLastActive(t) {
        if (!t) return '';
        try {
            const d = new Date(t); const diff = Date.now() - d.getTime();
            const min = Math.floor(diff / 60000);
            if (min < 1) return '刚刚活跃';
            if (min < 60) return min + '分钟前活跃';
            const hr = Math.floor(min / 60);
            if (hr < 24) return hr + '小时前活跃';
            return d.toLocaleDateString() + '活跃';
        } catch (e) { return ''; }
    }
    // 在线判定以最近活跃时间为准（5 分钟内），不依赖可能不复位的 is_online 布尔
    function isUserOnlineNow(info) {
        if (!info || !info.last_active) return false;
        try { return (Date.now() - new Date(info.last_active).getTime()) < 5 * 60 * 1000; } catch (e) { return false; }
    }
    // ---------- 监控 tab（GET /api/monitor，60s 自动刷新；按真实契约渲染） ----------
    function fmtMonitorTime(t) {
        if (!t) return '—';
        try { return new Date(t).toLocaleString(); } catch (e) { return String(t); }
    }
    function setupStepsBox(setupSteps) {
        if (!setupSteps) return '';
        return '<details class="lui-notice warn" style="margin-top:10px;"><summary style="cursor:pointer; font-weight:600;">配置步骤</summary><pre style="white-space:pre-wrap; font-size:12px; line-height:1.7; margin:10px 0 0; font-family:inherit;">' + escapeHtml(String(setupSteps)) + '</pre></details>';
    }
    function scoreRingHtml(score, grade) {
        const v = (typeof score === 'number') ? Math.max(0, Math.min(100, score)) : null;
        const dash = v == null ? '0 283' : (Math.round(v / 100 * 283) + ' 283');
        return '<div class="lui-score-ring" style="--p:' + (v == null ? 0 : v) + ';">'
            + '<svg viewBox="0 0 120 120"><circle class="r-bg" cx="60" cy="60" r="52"/><circle class="r-fg" cx="60" cy="60" r="52" stroke-dasharray="' + dash + '"/></svg>'
            + '<div class="r-center"><div class="r-num">' + (v == null ? '—' : v) + '</div><div class="r-grade">' + (grade || (v == null ? '—' : v >= 90 ? '优' : v >= 75 ? '良' : v >= 60 ? '中' : '需改进')) + '</div></div></div>';
    }
    // 审计展示：管理员账号名脱敏；details 原始 JSON 压成可读短语
    function auditUserName(name) {
        const s = String(name || '');
        return /^admin$/i.test(s) ? '超管' : s;
    }
    const AUDIT_ACTION_LABELS = { login: '登录', logout: '登出', '用户登录': '登录', '用户登出': '登出', update_avatar: '更换头像', publish_feed: '发布动态', publish_message: '发布留言', like_feed: '点赞动态', like_message: '点赞留言', unlike_feed: '取消点赞', unlike_message: '取消点赞' };
    function auditActionText(a) {
        return AUDIT_ACTION_LABELS[a] || a;
    }
    function auditDetailText(details) {
        if (details == null || details === '') return '';
        let obj = null;
        try { obj = typeof details === 'string' ? JSON.parse(details) : details; } catch (e) { obj = null; }
        if (obj && typeof obj === 'object') {
            const TABLE_LABEL = { feeds: '动态', messages: '留言', loves: '感动', memories: '回忆', memos: '待办', schedules: '行程', countdowns: '纪念日', travel_markers: '地图标记', bubble_photos: '气泡照片' };
            const METHOD_LABEL = { PATCH: '修改', POST: '新增', DELETE: '删除' };
            const parts = [];
            if (obj.table) parts.push((TABLE_LABEL[obj.table] || obj.table) + (METHOD_LABEL[obj.method] ? '·' + METHOD_LABEL[obj.method] : ''));
            if (obj.ip) parts.push('IP ' + obj.ip);
            if (obj.page_url) parts.push('页面浏览');
            if (obj.content) parts.push(String(obj.content).slice(0, 18));
            if (parts.length) return parts.join(' · ');
        }
        return String(details).slice(0, 60);
    }
    async function fetchMonitorJson() {
        try {
            const resp = await fetch('/api/monitor', { headers: { 'X-Couple-Token': getSessionToken() || '' } });
            if (resp.status === 401 || resp.status === 403) { toast('登录状态已失效，请重新登录', 'error'); return null; }
            const j = await resp.json().catch(() => null);
            return (j && typeof j === 'object') ? j : null;
        } catch (e) { return null; }
    }
    async function renderMonitorTab(el) {
        el.innerHTML = '<div class="lui-loading"><span class="lui-spinner"></span><span>正在拉取监控数据…</span></div>';
        const m = await fetchMonitorJson();
        if (!m) {
            el.innerHTML = '<div class="lui-notice" style="margin:16px 0;"><b>监控数据暂不可用</b><div style="margin-top:6px;">接口 /api/monitor 未返回数据（可能尚未部署）。请确认后端已上线，或稍后刷新重试。</div><div style="margin-top:12px; display:flex; gap:8px;"><button class="lui-btn sm tonal" onclick="switchAdminTab(\'monitor\')"><svg class="lui-icon s14"><use href="assets/icons.svg#i-refresh"/></svg>重新加载</button></div></div>';
            return;
        }
        const site = m.site || {};
        const counts = site.counts || {};
        const sec = m.security || {};
        const online = Array.isArray(site.usersOnline) ? site.usersOnline : [];
        function statCell(label, val) { return '<div class="lui-stat"><div class="s-v">' + (val == null || val === '' ? '—' : val) + '</div><div class="s-k">' + label + '</div></div>'; }
        // 统计网格：site.counts 全部字段 + 当前在线人数
        const gridHtml = '<div class="lui-stat-grid">'
            + statCell('注册用户', counts.users) + statCell('当前在线', online.length)
            + statCell('动态', counts.feeds) + statCell('留言', counts.messages)
            + statCell('感动的话', counts.loves) + statCell('回忆打卡', counts.memories)
            + statCell('待办', counts.memos) + statCell('行程', counts.schedules)
            + statCell('纪念日', counts.countdowns) + statCell('地图标记', counts.travelMarkers)
            + statCell('气泡照片', counts.bubblePhotos) + statCell('图仓图片', counts.images)
            + '</div>';
        // GitHub 仓库卡
        const gh = m.github || {};
        let ghHtml = '';
        if (gh.configured === false || gh.error) {
            ghHtml = '<div class="lui-notice warn"><b>GitHub 未配置</b><div style="margin-top:6px;">' + escapeHtml(gh.error || 'GITHUB_TOKEN 未配置') + '</div>' + setupStepsBox(gh.setupSteps) + '</div>';
        } else if (Array.isArray(gh.repos)) {
            ghHtml = gh.repos.map(function (r) {
                let rows = '<div style="margin-top:8px; font-size:13px; line-height:1.7; color:var(--ink-2);">'
                    + (r.imageCount != null ? '图片 ' + r.imageCount + ' 张　' : '')
                    + (r.commitCount != null ? '提交 ' + r.commitCount + ' 次　' : '')
                    + (r.sizeKb != null ? '体积 ' + r.sizeKb + ' KB　' : '')
                    + (r.updatedAt ? '更新于 ' + fmtMonitorTime(r.updatedAt) : '')
                    + '</div>';
                if (r.recentCommits && r.recentCommits.length) {
                    rows += '<div style="margin-top:8px; font-size:12px; color:var(--ink-3);">最近提交：' + r.recentCommits.slice(0, 3).map(function (c) {
                        return '<div style="margin-top:4px;">' + escapeHtml(String(c.sha || '').slice(0, 7)) + ' · ' + escapeHtml(c.message || '') + '</div>';
                    }).join('') + '</div>';
                }
                if (r.actionsRuns && r.actionsRuns.length) {
                    rows += '<div style="margin-top:8px; font-size:12px; color:var(--ink-3);">最近工作流：' + r.actionsRuns.slice(0, 3).map(function (a) {
                        return '<div style="margin-top:4px;">' + escapeHtml(a.name || '') + ' · ' + escapeHtml(a.status || '') + (a.conclusion ? ' / ' + escapeHtml(a.conclusion) : '') + '</div>';
                    }).join('') + '</div>';
                }
                if (r.error) rows = '<div class="lui-notice warn" style="margin-top:8px;"><b>读取失败</b><div style="margin-top:4px;">' + escapeHtml(r.error) + '</div></div>';
                return '<div style="padding:10px 0; border-top:1px solid var(--line);"><div style="display:flex; align-items:center; gap:8px;"><b>' + escapeHtml(r.name || '—') + '</b>' + (r.private ? '<span class="lui-tag red">私有</span>' : '<span class="lui-tag">公开</span>') + '</div>' + rows + '</div>';
            }).join('');
        } else ghHtml = '<div class="lui-mini" style="color:var(--ink-3);">暂无仓库数据</div>';
        // Supabase 卡
        const sb = m.supabase || {};
        const health = sb.health || {};
        const tables = Array.isArray(sb.tableSizes) ? sb.tableSizes : [];
        const maxRows = Math.max.apply(null, tables.map(function (t) { return t.rowsEstimate || 0; }).concat([1]));
        const barsHtml = tables.length ? '<div class="lui-bars" style="margin-top:10px;">' + tables.map(function (t) {
            return '<div class="bar" data-label="' + escapeHtml(t.table) + '" style="height:' + Math.round(Math.max(6, (t.rowsEstimate || 0) / maxRows * 60)) + 'px;" title="' + escapeHtml(t.table + ' ' + (t.totalSizeMb || 0) + 'MB / ' + (t.rowsEstimate || 0) + ' 行') + '"></div>';
        }).join('') + '</div>' : '';
        const mgmt = sb.management || {};
        let sbHtml = '<div style="display:flex; align-items:center; gap:10px;">'
            + '<span class="lui-status-dot ' + (health.status === 'ok' || health.db === 'ok' ? 'green' : '') + '"></span>'
            + '<div style="flex:1;"><div style="font-weight:600;">Supabase ' + escapeHtml(health.status || '—') + (health.db ? ' · ' + escapeHtml(health.db) : '') + '</div>'
            + '<div class="lui-mini" style="color:var(--ink-3); margin-top:2px;">数据库大小 ' + (sb.dbSizeMb != null ? sb.dbSizeMb + ' MB' : '—') + '</div></div></div>'
            + barsHtml;
        if (sb.error) sbHtml += '<div class="lui-notice warn" style="margin-top:10px;"><b>连接异常</b><div style="margin-top:4px;">' + escapeHtml(sb.error) + '</div></div>';
        if (mgmt.configured === false) sbHtml += setupStepsBox(mgmt.setupSteps);
        // 访问审计
        const access = m.access || {};
        const recent = Array.isArray(access.recent) ? access.recent : [];
        const byUser = Array.isArray(access.byUser) ? access.byUser : [];
        const byAction = Array.isArray(access.byAction) ? access.byAction : [];
        const day7 = Array.isArray(access.day7) ? access.day7 : [];
        const maxDay = Math.max.apply(null, day7.map(function (d) { return d.count || 0; }).concat([1]));
        const accessHtml = '<div class="lui-timeline" style="margin-top:6px;">' + (recent.length ? recent.slice(0, 10).map(function (a) {
            const det = auditDetailText(a.details);
            return '<div class="lui-tl-item"><div class="t-time">' + fmtMonitorTime(a.createdAt) + ' · ' + escapeHtml(auditUserName(a.user || '')) + '</div><div class="t-text">' + escapeHtml(auditActionText(a.action || '')) + (det ? '<div class="lui-mini" style="color:var(--ink-3); margin-top:2px;">' + escapeHtml(det) + '</div>' : '') + '</div></div>';
        }).join('') : '<div class="lui-mini" style="color:var(--ink-3);">暂无访问记录</div>') + '</div>'
            + (byUser.length ? '<div style="margin-top:12px;"><div class="lui-label">活跃用户</div><div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:6px;">' + byUser.map(function (u) { return '<span class="lui-tag">' + escapeHtml(auditUserName(u.user)) + ' · ' + u.count + '</span>'; }).join('') + '</div></div>' : '')
            + (byAction.length ? '<div style="margin-top:12px;"><div class="lui-label">热门操作</div><div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:6px;">' + byAction.map(function (a) { return '<span class="lui-tag">' + escapeHtml(auditActionText(a.action)) + ' · ' + a.count + '</span>'; }).join('') + '</div></div>' : '')
            + (day7.length ? '<div class="lui-bars" style="margin-top:12px;">' + day7.map(function (d) {
                return '<div class="bar" data-label="' + escapeHtml(String(d.date).slice(5)) + '" style="height:' + Math.round(Math.max(6, (d.count || 0) / maxDay * 60)) + 'px;"></div>';
            }).join('') + '</div>' : '');
        el.innerHTML =
            '<div class="lui-card hero" style="margin:14px 0;"><div style="display:flex; align-items:center; gap:16px;">'
            + scoreRingHtml(sec.score, sec.grade)
            + '<div style="flex:1;"><div class="h-title">网站运行状况</div><div class="h-sub" style="margin-top:6px;">版本 ' + escapeHtml(site.version || '—') + ' · ' + (site.usersOnlineNote ? escapeHtml(site.usersOnlineNote) : '服务器时间 ' + fmtMonitorTime(site.serverTime)) + '</div>'
            + '<div style="margin-top:12px; display:flex; gap:8px;"><button class="lui-btn sm" style="background:rgba(255,255,255,0.18); color:#fff;" onclick="switchAdminTab(\'monitor\')"><svg class="lui-icon s14"><use href="assets/icons.svg#i-refresh"/></svg>刷新</button><button class="lui-btn sm" style="background:rgba(255,255,255,0.18); color:#fff;" onclick="switchAdminTab(\'security\')">安全扫描</button></div></div>'
            + '</div></div>'
            + gridHtml
            + '<div class="lui-card" style="margin-top:14px;"><div class="lui-card-head"><h3 class="lui-h3">代码仓库</h3></div>' + ghHtml + '</div>'
            + '<div class="lui-card" style="margin-top:12px;"><div class="lui-card-head"><h3 class="lui-h3">数据后端</h3></div>' + sbHtml + '</div>'
            + '<div class="lui-card" style="margin-top:12px;"><div class="lui-card-head"><h3 class="lui-h3">访问审计</h3></div>' + accessHtml + '</div>'
            + '<div class="lui-card soft" style="margin-top:12px;"><div style="display:flex; align-items:center; gap:10px;"><span class="lui-status-dot ' + (sec.status === 'ok' ? 'green' : '') + '"></span><div style="font-size:13px; line-height:1.7;">安全评分 ' + (sec.score == null ? '—' : sec.score + ' 分（' + escapeHtml(sec.grade || '') + '）') + ' · 高危 ' + (sec.high == null ? '—' : sec.high) + ' · 中危 ' + (sec.medium == null ? '—' : sec.medium) + ' · 低危 ' + (sec.low == null ? '—' : sec.low) + '。<a href="javascript:switchAdminTab(\'security\')" style="color:var(--rose);">前往安全扫描 →</a></div></div></div>';
    }

    // ---------- 安全 tab（GET/POST /api/security-scan；report=null 时空状态） ----------
    async function fetchSecurityJson() {
        try {
            const resp = await fetch('/api/security-scan', { headers: { 'X-Couple-Token': getSessionToken() || '' } });
            if (resp.status === 401 || resp.status === 403) { toast('登录状态已失效，请重新登录', 'error'); return null; }
            const j = await resp.json().catch(() => null);
            return (j && typeof j === 'object') ? j : null;
        } catch (e) { return null; }
    }
    function renderSecurityReport(el, report, running) {
        if (!report) {
            el.innerHTML = '<div class="lui-empty"><div class="e-icon"><svg class="lui-icon"><use href="assets/icons.svg#i-shield-check"/></svg></div><div class="e-title">' + (running ? '正在扫描…' : '还没有扫描报告') + '</div><div class="e-text">' + (running ? '请稍候，扫描需要一点时间' : '每 2 天（北京时间约 11:00）由 GitHub Actions 自动扫描，也可立即手动触发') + '</div><button class="lui-btn primary" id="runScanBtn" onclick="runSecurityScan()"><svg class="lui-icon s16"><use href="assets/icons.svg#i-scan"/></svg>立即扫描</button></div>';
            return;
        }
        const summary = report.summary || {};
        const score = typeof summary.score === 'number' ? summary.score : null;
        const checks = Array.isArray(report.checks) ? report.checks : [];
        function statCell(label, val) { return '<div class="lui-stat"><div class="s-v">' + (val == null || val === '' ? '—' : val) + '</div><div class="s-k">' + label + '</div></div>'; }
        // 按 category 分组
        const groups = {};
        checks.forEach(function (c) {
            const k = c.category || '其他';
            if (!groups[k]) groups[k] = [];
            groups[k].push(c);
        });
        const stText = { pass: '通过', fail: '未通过', warn: '警告', unknown: '未知' };
        const sevTag = { high: 'red', medium: 'amber', low: '' };
        const sevLabel = { high: '高', medium: '中', low: '低' };
        const checkHtml = Object.keys(groups).map(function (cat) {
            const items = groups[cat].map(function (c) {
                const st = c.status || 'unknown';
                const showSev = st !== 'pass' && c.severity;
                return '<div class="lui-check"><div class="c-status ' + st + '">' + (stText[st] || st) + '</div>'
                    + '<div class="c-body"><div class="c-title">' + escapeHtml(c.title || '')
                    + (showSev ? '<span class="lui-tag ' + (sevTag[c.severity] == null ? '' : sevTag[c.severity]) + '" style="margin-left:6px;">' + (sevLabel[c.severity] || escapeHtml(c.severity)) + '</span>' : '')
                    + '</div>' + (c.detail ? '<div class="c-detail">' + escapeHtml(c.detail) + '</div>' : '')
                    + (c.fix ? '<div class="c-fix">' + escapeHtml(c.fix) + '</div>' : '') + '</div></div>';
            }).join('');
            return '<div class="lui-card" style="margin-top:12px;"><div class="lui-card-head"><h3 class="lui-h3">' + escapeHtml(cat) + '</h3></div>' + items + '</div>';
        }).join('') || '<div class="lui-mini" style="color:var(--ink-3);">暂无检查项</div>';
        el.innerHTML =
            '<div class="lui-card" style="margin:14px 0; display:flex; align-items:center; gap:18px;">' + scoreRingHtml(score, summary.grade)
            + '<div style="flex:1;"><div style="font-weight:600;">安全评分</div><div class="lui-mini" style="color:var(--ink-3); margin-top:4px;">生成于 ' + fmtMonitorTime(report.generatedAt) + '</div>'
            + '<button id="runScanBtn" class="lui-btn primary sm" style="margin-top:10px;" onclick="runSecurityScan()"><svg class="lui-icon s14"><use href="assets/icons.svg#i-scan"/></svg>立即扫描</button>'
            + '<div id="scanRunningTip" style="display:none; margin-top:8px; align-items:center; gap:8px;"><span class="lui-spinner"></span><span class="lui-mini" style="color:var(--ink-3);">正在扫描，请稍候…</span></div></div></div>'
            + '<div class="lui-stat-grid">' + statCell('通过', summary.passes) + statCell('高危', summary.high) + statCell('中危', summary.medium) + statCell('低危', summary.low) + '</div>'
            + checkHtml
            + '<div class="lui-mini" style="color:var(--ink-3); line-height:1.8; margin:14px 2px;">每 2 天（北京时间约 11:00）由 GitHub Actions 自动扫描，本页也可手动触发；历史报告在仓库 docs/security-reports/。</div>';
    }
    async function renderSecurityTab(el) {
        el.innerHTML = '<div class="lui-loading"><span class="lui-spinner"></span><span>正在加载安全扫描结果…</span></div>';
        const s = await fetchSecurityJson();
        if (!s) {
            el.innerHTML = '<div class="lui-notice" style="margin:16px 0;"><b>安全扫描暂不可用</b><div style="margin-top:6px;">接口 /api/security-scan 未返回数据（可能尚未部署）。请确认后端已上线。</div><div style="margin-top:12px;"><button class="lui-btn sm tonal" onclick="runSecurityScan()"><svg class="lui-icon s14"><use href="assets/icons.svg#i-scan"/></svg>立即扫描</button></div></div>';
            return;
        }
        renderSecurityReport(el, s.report || null, false);
    }
    async function runSecurityScan() {
        const btn = document.getElementById('runScanBtn');
        if (btn) { btn.classList.add('loading'); btn.disabled = true; }
        const tip = document.getElementById('scanRunningTip');
        if (tip) tip.style.display = 'flex';
        try {
            const resp = await fetch('/api/security-scan', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Couple-Token': getSessionToken() || '' }, body: JSON.stringify({ action: 'run' }) });
            const j = await resp.json().catch(() => null);
            if (!resp.ok || !j) throw new Error('HTTP ' + resp.status);
            toast('扫描完成', 'success');
            renderSecurityReport(document.getElementById('adminContent'), j.report || null, false);
        } catch (e) {
            toast('扫描失败：' + (e.message || '网络错误'), 'error');
            if (btn) { btn.classList.remove('loading'); btn.disabled = false; }
            if (tip) tip.style.display = 'none';
        }
    }

    function renderAdminUsers(el) {
        const users = window.__adminUsers || {};
        const permLabels = { full: '完全权限', comment: '仅评论', view: '仅浏览'};
        let html = '';
        for (const [uname, info] of Object.entries(users)) {
            const isAdm = uname === 'admin'|| info.role === 'admin';
            const permission = info.permission || 'full';
            const initial = (uname[0] || '?').toUpperCase();
            const online = isUserOnlineNow(info);
            html += '<div class="lui-card" style="margin-bottom:10px;">'+ '<div style="display:flex; align-items:center; gap:12px;">'+ '<span class="lui-avatar s40">'+ escapeHtml(initial) + '</span>'+ '<div style="flex:1; min-width:0;"><div style="font-weight:600; display:flex; align-items:center; gap:6px;">'+ escapeHtml(uname) + (isAdm ? '<span class="lui-tag rose">管理员</span>': '<span class="lui-tag">用户</span>') + '</div>'+ '<div class="lui-mini" style="color:var(--ink-3); margin-top:3px;"><span class="lui-status-dot '+ (online ? 'green': '') + '"></span> '+ (online ? '在线': (fmtLastActive(info.last_active) || '离线')) + '· 权限：'+ (isAdm ? '不受限制': (permLabels[permission] || permLabels.full)) + '</div></div></div>'+ '<div style="display:flex; flex-wrap:wrap; gap:8px; margin-top:12px;">'+ '<button class="lui-btn sm tonal" onclick="openSetUserPasswordModal(\''+ uname + '\')"><svg class="lui-icon s14"><use href="assets/icons.svg#i-key"/></svg>设置密码</button>'+ (uname === 'admin'? '': '<button class="lui-btn sm ghost" onclick="toggleUserRole(\''+ uname + '\')">'+ (isAdm ? '取消管理员': '设为管理员') + '</button>')
                + (!isAdm ? '<select class="lui-input sm" style="width:auto;" onchange="setUserPermission(\''+ uname + '\', this.value)">'+ '<option value="full" '+ (permission === 'full'? 'selected': '') + '>完全权限</option>'+ '<option value="comment" '+ (permission === 'comment'? 'selected': '') + '>仅评论</option>'+ '<option value="view" '+ (permission === 'view'? 'selected': '') + '>仅浏览</option></select>': '')
                + (!isAdm ? '<button class="lui-btn sm danger" onclick="deleteUserAccount(\''+ uname + '\')"><svg class="lui-icon s14"><use href="assets/icons.svg#i-trash"/></svg>删除</button>': '')
                + '</div></div>';
        }
        el.innerHTML = html || '<div class="lui-empty"><div class="e-icon"><svg class="lui-icon"><use href="assets/icons.svg#i-users"/></svg></div><div class="e-title">暂无用户</div></div>';
    }

    function renderAdminContentTab(el) {
        const sections = [
            ['feed', '时光相册'], ['message', '留言板'], ['love', '感动的话'], ['memory', '回忆打卡'],
            ['memo', '待办'], ['schedule', '行程'], ['countdown', '纪念日'], ['marker', '地图']
        ];
        const sel = window.__adminContentSel;
        el.innerHTML = '<div class="lui-card"><div style="display:flex; gap:8px; flex-wrap:wrap;" class="lui-hide-scrollbar">'+ sections.map(function (p) { return '<button class="lui-chip'+ (sel === p[0] ? 'active': '') + '" onclick="adminPickChip(\''+ p[0] + '\', this)">'+ p[1] + '</button>'; }).join('') + '</div>'+ '<div id="adminContentSection" style="margin-top:14px; color:var(--ink-3); font-size:13px;">'+ (sel ? '<div class="lui-loading"><span class="lui-spinner"></span><span>正在加载…</span></div>': '点上方分类，按需加载对应内容（避免一次拉取全部数据）。') + '</div></div>';
        if (sel) renderAdminContentSection(sel);
    }
    function adminPickChip(type, btn) {
        window.__adminContentSel = type;
        document.querySelectorAll('.lui-chip').forEach(function (c) { c.classList.remove('active'); });
        if (btn) btn.classList.add('active');
        renderAdminContentSection(type);
    }

    function renderAdminTrashTab(el) {
        el.innerHTML = '<div id="adminTrashSection" class="lui-loading"><span class="lui-spinner"></span><span>回收站加载中…</span></div>';
        loadTrashSection().catch(function (e) {
            const t = document.getElementById('adminTrashSection');
            if (t) t.innerHTML = '<div class="lui-notice">回收站加载失败：'+ escapeHtml(e.message || String(e)) + '</div>';
        });
    }

    var ADMIN_ACTION_LABELS = {
        login: '用户登录', logout: '用户登出', login_failed: '登录失败',
        publish_feed: '发布相册', publish_message: '发布留言', publish_love: '发布感动',
        publish_memory: '添加回忆', publish_memo: '添加待办', publish_schedule: '添加行程',
        publish_countdown: '添加纪念日', publish_marker: '添加地图标记',
        delete_feed: '删除相册', delete_message: '删除留言', delete_love: '删除感动',
        delete_memory: '删除回忆', delete_memo: '删除待办', delete_schedule: '删除行程',
        delete_countdown: '删除纪念日', delete_marker: '删除地图标记',
        like_feed: '点赞动态', unlike_feed: '取消点赞', like_message: '点赞留言', unlike_message: '取消点赞',
        comment_feed: '评论动态', comment_message: '评论留言',
        update_avatar: '更新头像', change_password: '修改密码',
        angry_on: '开启生气模式', angry_off: '关闭生气模式',
        apology_submit: '提交道歉信', apology_pass: '道歉信通过', apology_reject: '道歉信驳回',
        admin_delete: '管理员删除', admin_reset_pwd: '重置密码', admin_delete_user: '删除账号',
        admin_create_user: '创建账号', admin_toggle_role: '切换角色', admin_set_permission: '设置权限',
        admin_toggle_visibility: '切换可见性', view_page: '浏览页面', switch_tab: '切换标签'};
    const LOG_PAGE = 50;
    function logRangeSince(range) {
        if (range === 'today') { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString(); }
        if (range === '7d') return new Date(Date.now() - 7 * 86400000).toISOString();
        if (range === '30d') return new Date(Date.now() - 30 * 86400000).toISOString();
        return null;
    }
    function shortUA(ua) {
        if (!ua) return '';
        if (/iPhone|iPad/i.test(ua)) return 'iPhone / iPad';
        if (/Android/i.test(ua)) return 'Android';
        if (/Windows/i.test(ua)) return 'Windows';
        if (/Mac OS|Macintosh/i.test(ua)) return 'Mac';
        if (/Linux/i.test(ua)) return 'Linux';
        return String(ua).substring(0, 40);
    }
    function renderLogItem(log) {
        let p = {};
        try { p = JSON.parse(log.details) || {}; } catch (e) { if (log.details) p = { raw: log.details }; }
        const act = ADMIN_ACTION_LABELS[log.action] || log.action || '操作';
        const fail = p.ok === false;
        const meta = [];
        if (p.target) meta.push('目标：'+ p.target);
        if (p.title) meta.push('「'+ p.title + '」');
        if (p.files) meta.push('附件 '+ p.files + '个');
        if (p.module) meta.push('模块 '+ p.module);
        if (p.error) meta.push('原因：'+ p.error);
        else if (p.raw) meta.push(p.raw);
        const metaLine = meta.length ? escapeHtml(meta.join('')) : '';
        return '<div class="lui-tl-item"><div class="t-time">'+ new Date(log.created_at).toLocaleString() + ' · '+ escapeHtml(log.user || '') + '</div>'+ '<div class="t-text"><b>'+ escapeHtml(act) + '</b>'+ (p.ip ? '<span class="lui-mini" style="color:var(--ink-3); margin-left:6px;">IP '+ escapeHtml(p.ip) + '</span>': '')
            + (metaLine ? '<div class="lui-mini" style="color:var(--ink-3); margin-top:2px;">'+ metaLine + '</div>': '') + '</div></div>';
    }
    async function fetchAdminLogs(reset) {
        const f = window.__logFilter;
        if (!f || f.loading) return;
        f.loading = true;
        const box = document.getElementById('adminLogList');
        const more = document.getElementById('adminLogMore');
        if (reset) { f.items = []; f.offset = 0; f.hasMore = true; if (box) { box.className = 'lui-loading'; box.innerHTML = '<span class="lui-spinner"></span><span>日志加载中…</span>'; } }
        try {
            let q = sb.from('admin_logs').select('action,user,details,created_at');
            if (f.user) q = q.eq('user', f.user);
            const since = logRangeSince(f.range);
            if (since) q = q.gte('created_at', since);
            const { data } = await q.order('created_at', { ascending: false }).range(f.offset, f.offset + LOG_PAGE - 1);
            const rows = data || [];
            f.items = f.items.concat(rows);
            f.hasMore = rows.length === LOG_PAGE;
            f.offset += rows.length;
            if (box) {
                if (!f.items.length) { box.className = 'adm-empty'; box.textContent = '该筛选条件下暂无日志'; }
                else { box.className = 'adm-log'; box.innerHTML = f.items.map(renderLogItem).join(''); }
            }
            if (more) more.style.display = f.hasMore ? 'block': 'none';
        } catch (e) { if (box) { box.className = 'adm-empty'; box.textContent = '日志加载失败，不影响其他功能。'; } }
        finally { f.loading = false; }
    }
    function applyLogFilter() {
        const f = window.__logFilter;
        if (!f) return;
        const u = document.getElementById('logFilterUser');
        const r = document.getElementById('logFilterRange');
        f.user = u ? u.value : '';
        f.range = r ? r.value : 'all';
        fetchAdminLogs(true);
    }
    function renderAdminLogsTab(el) {
        window.__logFilter = { user: '', range: 'all', items: [], offset: 0, hasMore: true, loading: false };
        el.innerHTML = '<div class="lui-card"><div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px;">'+ '<select id="logFilterUser" class="lui-input sm" style="flex:1; min-width:120px;"><option value="">全部用户</option></select>'+ '<select id="logFilterRange" class="lui-input sm" style="flex:1; min-width:120px;"><option value="all">全部时间</option><option value="today">今天</option><option value="7d">近 7 天</option><option value="30d">近 30 天</option></select>'+ '<button class="lui-btn sm tonal" onclick="applyLogFilter()"><svg class="lui-icon s14"><use href="assets/icons.svg#i-filter"/></svg>筛选</button></div>'+ '<div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px;">'+ '<button class="lui-btn sm ghost" onclick="exportAdminLogs()"><svg class="lui-icon s14"><use href="assets/icons.svg#i-download"/></svg>导出</button>'+ '<button class="lui-btn sm ghost" onclick="clearAdminLogs()"><svg class="lui-icon s14"><use href="assets/icons.svg#i-trash"/></svg>清空</button></div>'+ '<div id="adminLogList" class="lui-loading"><span class="lui-spinner"></span><span>日志加载中…</span></div>'+ '<button id="adminLogMore" class="lui-btn tonal block sm" style="margin-top:10px; display:none;" onclick="fetchAdminLogs(false)">加载更多</button></div>';
        accountApi('listUsers').then(function (r) {
            const sel = document.getElementById('logFilterUser');
            if (!sel) return;
            (r.users || []).forEach(function (u) { const o = document.createElement('option'); o.value = u.username; o.textContent = u.username; sel.appendChild(o); });
        }).catch(function () { });
        fetchAdminLogs(true);
    }
    window.fetchAdminLogs = fetchAdminLogs;
    window.applyLogFilter = applyLogFilter;

    function renderAdminSettingsTab(el) {
        el.innerHTML =
            '<div class="lui-card"><div class="lui-card-head"><h3 class="lui-h3">注册通道</h3></div>'+ '<div class="lui-mini" style="line-height:1.8;">设置邀请码后，登录页会出现注册入口，对方凭邀请码自助注册；清空邀请码即关闭通道。</div>'+ '<div id="adminSignupSlot" class="lui-mini" style="color:var(--ink-3); margin-top:8px;">加载中…</div></div>'+ '<div class="lui-card" style="margin-top:12px;"><div class="lui-card-head"><h3 class="lui-h3">梦幻背景气泡</h3></div>'+ '<div class="lui-mini" style="line-height:1.8;">主界面角落会缓缓漂浮照片气泡，默认播放留言板和相册里的照片。</div>'+ '<div id="adminBubbleSlot" class="lui-mini" style="color:var(--ink-3); margin-top:8px;">加载中…</div></div>'+ '<div class="lui-card" style="margin-top:12px;"><div class="lui-card-head"><h3 class="lui-h3">账号</h3></div>'+ '<button class="lui-btn tonal block sm" onclick="showRegisterModal()"><svg class="lui-icon s14"><use href="assets/icons.svg#i-plus"/></svg>注册新账号</button></div>'+ '<div id="adminNotifySlot">'+ renderNotifyConfigPanel() + '</div>';
        loadNotifyConfigIntoForm();
        loadSignupConfigIntoForm();
        loadBubbleConfigIntoForm();
    }

    // 内容条目卡片（手机友好）
    function renderAdminCards(type, rows) {
        if (!rows || rows.length === 0) return '<div class="lui-empty"><div class="e-icon"><svg class="lui-icon"><use href="assets/icons.svg#i-grid"/></svg></div><div class="e-title">暂无数据</div></div>';
        const pl = { high: '高', medium: '中', low: '低'};
        return rows.map(function (row) {
            const time = row.created_at ? new Date(row.created_at).toLocaleString() : '';
            let title = '', extra = '', del = '';
            if (type === 'feed') { title = row.description || ''; del = '<button class="lui-btn sm danger" onclick="deleteFeed(\''+ row.id + '\')">删除</button>'; }
            else if (type === 'message') { title = row.content || ''; del = admDelBtn('message', row.id); }
            else if (type === 'love') { title = row.content || ''; extra = row.privacy === 'private'? '私密': '公开'; del = admDelBtn('love', row.id); }
            else if (type === 'memory') { title = row.content || ''; del = admDelBtn('memory', row.id); }
            else if (type === 'memo') { title = row.content || ''; extra = (pl[row.priority] || row.priority || '') + '· '+ (row.done ? '已完成': '进行中'); del = admDelBtn('memo', row.id); }
            else if (type === 'schedule') { title = row.title || ''; extra = row.start_date ? (row.end_date ? row.start_date + '~ '+ row.end_date : row.start_date) : ''; del = admDelBtn('schedule', row.id); }
            else if (type === 'countdown') { title = row.name || ''; extra = row.target_date || ''; del = admDelBtn('countdown', row.id); }
            else if (type === 'marker') { title = row.name || ''; extra = row.description || ''; del = admDelBtn('marker', row.id); }
            const vis = renderVisibilityAdminControls(type, row.id, row.visibility);
            return '<div class="lui-card" style="margin-bottom:10px;"><div style="font-size:14px; line-height:1.6;">'+ escapeHtml(title || '(无文字)').substring(0, 80) + '</div>'+ '<div class="lui-mini" style="color:var(--ink-3); margin-top:6px; display:flex; gap:10px; flex-wrap:wrap;"><span>'+ escapeHtml(row.author_name || '') + '</span>'+ (extra ? '<span>'+ escapeHtml(extra) + '</span>': '')
                + '<span>'+ time + '</span></div>'+ '<div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-top:10px;">'+ vis + del + '</div></div>';
        }).join('');
    }
    function admDelBtn(type, id) { return '<button class="lui-btn sm danger" onclick="adminDelete(\'' + type + '\',\'' + id + '\')">删除</button>'; }

    function notifySwitchRow(key, label) {
        const idMap = { enabled: 'swEnabled', feed: 'swFeed', message: 'swMessage', like: 'swLike'};
        return '<div class="lui-list-row" style="min-height:34px;"><div class="lui-row-main"><div class="lui-row-title" style="font-weight:500;">'+ label + '</div></div>'+ '<span class="lui-switch"><input type="checkbox" id="'+ idMap[key] + '" checked onchange="toggleNotifySwitch(\''+ key + '\')"><span class="track"></span></span></div>';
    }
    function renderNotifyConfigPanel() {
        return `<div class="lui-card" style="margin-top:12px;"><div class="lui-card-head"><h3 class="lui-h3">邮箱通知</h3></div>
            <div class="lui-mini" style="line-height:1.8; margin-bottom:10px;">
                你或对方发<b>动态 / 留言</b>时，自动给<b>对方</b>邮箱发通知，<b style="color:var(--rose);">不会发给发布者自己</b>。对方未绑定邮箱时自动跳过。
            </div>
            <div class="lui-list" style="margin:0 -14px;">${notifySwitchRow('enabled', '通知总开关')}${notifySwitchRow('feed', '发动态时通知对方')}${notifySwitchRow('message', '写留言时通知对方')}${notifySwitchRow('like', '点赞时通知对方')}</div>
            <h3 class="lui-h3" style="margin-top:16px;">通知收件人</h3>
            <div class="lui-mini" style="line-height:1.7; margin-bottom:8px;">boy 发内容 → 发到 girl 邮箱；反之亦然。</div>
            <div class="lui-field"><label class="lui-label">boy 的邮箱</label><div style="display:flex; gap:8px;"><input id="emailBoy" class="lui-input sm" placeholder="boy 的收件邮箱" style="flex:1; min-width:0;"><button class="lui-btn sm tonal" onclick="adminSaveUserEmail('boy')">保存</button></div></div>
            <div class="lui-field"><label class="lui-label">girl 的邮箱</label><div style="display:flex; gap:8px;"><input id="emailGirl" class="lui-input sm" placeholder="girl 的收件邮箱" style="flex:1; min-width:0;"><button class="lui-btn sm tonal" onclick="adminSaveUserEmail('girl')">保存</button></div></div>
            <details style="margin-top:12px; border-top:1px solid var(--line); padding-top:10px;">
                <summary class="lui-label" style="cursor:pointer;">EmailJS 服务配置（一般不用改）</summary>
                <div style="display:flex; flex-direction:column; gap:8px; margin-top:10px;">
                    <input id="notifyPublicKey" class="lui-input sm" placeholder="EmailJS Public Key">
                    <input id="notifyServiceId" class="lui-input sm" placeholder="EmailJS Service ID">
                    <input id="notifyTemplateId" class="lui-input sm" placeholder="EmailJS Template ID">
                    <div style="display:flex; gap:8px; flex-wrap:wrap;">
                        <button class="lui-btn sm tonal" onclick="saveNotifyConfig()">保存配置</button>
                        <button class="lui-btn sm primary" onclick="testNotifyEmail()">发测试邮件</button>
                    </div>
                </div>
            </details>
        </div>`;
    }
    window.__notifySwitches = { enabled: true, feed: true, message: true, like: true };
    function applyNotifySwitchUI(key, val) {
        const el = document.getElementById('sw'+ key.charAt(0).toUpperCase() + key.slice(1));
        if (el) el.checked = !!val;
    }
    async function loadNotifyConfigIntoForm() {
        try {
            const cfg = await accountApi('getNotifyConfig');
            if (cfg.switches) {
                window.__notifySwitches = Object.assign(window.__notifySwitches, cfg.switches);
                ['enabled', 'feed', 'message', 'like'].forEach(k => applyNotifySwitchUI(k, window.__notifySwitches[k]));
            }
            const emails = cfg.emails || {};
            if (document.getElementById('emailBoy')) document.getElementById('emailBoy').value = emails.boy || '';
            if (document.getElementById('emailGirl')) document.getElementById('emailGirl').value = emails.girl || '';
            const ejs = cfg.emailjs || {};
            if (ejs.publicKey && document.getElementById('notifyPublicKey')) document.getElementById('notifyPublicKey').value = ejs.publicKey;
            if (ejs.serviceId && document.getElementById('notifyServiceId')) document.getElementById('notifyServiceId').value = ejs.serviceId;
            if (ejs.templateId && document.getElementById('notifyTemplateId')) document.getElementById('notifyTemplateId').value = ejs.templateId;
        } catch (e) { console.warn('读取通知配置失败:', e); }
    }
    async function loadSignupConfigIntoForm() {
        const slot = document.getElementById('adminSignupSlot');
        if (!slot) return;
        try {
            const cfg = await accountApi('getSignupCode');
            const code = cfg.code || '';
            const regOpen = !!(cfg && cfg.register_open);
            slot.innerHTML =
                '<div style="display:flex; align-items:center; gap:10px; margin-bottom:10px;">'+ '<span class="lui-switch"><input type="checkbox" id="registerOpenToggle" '+ (regOpen ? 'checked': '') + 'onchange="adminToggleRegisterOpen(this.checked)"><span class="track"></span></span>'+ '<span style="font-size:13px;">开放注册（无需邀请码，任何人可自助注册）</span></div>'+ '<div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">'+ '<input id="signupCodeInput" type="text" value="'+ escapeHtml(code) + '" placeholder="设置邀请码，留空=关闭注册" class="lui-input sm" style="flex:1; min-width:160px;'+ (regOpen ? 'opacity:0.5;': '') + '">'+ '<button class="lui-btn sm ghost" onclick="adminGenSignupCode()">随机生成</button>'+ '<button class="lui-btn sm tonal" onclick="adminSaveSignupCode()">保存</button></div>'+ '<div id="signupCodeStatus" style="margin-top:10px; font-size:12px; line-height:1.7;">'+ (regOpen
                    ? '<span style="color:var(--blue);">开放注册中：登录页无需邀请码即可注册。</span>': (code
                        ? '<span style="color:var(--green);">邀请码模式：当前邀请码 <b>'+ escapeHtml(code) + '</b>，登录页可自助注册。</span>': '<span style="color:var(--amber);">未开通：登录页无法注册。</span>')) + '</div>';
        } catch (e) { slot.innerHTML = '<span style="color:var(--red);">读取失败：'+ escapeHtml(e.message || String(e)) + '</span>'; }
    }
    async function adminToggleRegisterOpen(open) {
        try {
            await accountApi('setRegisterOpen', { open });
            toast(open ? '已开启开放注册': '已关闭开放注册，恢复邀请码模式');
            await loadSignupConfigIntoForm();
        } catch (e) { alert('操作失败：'+ e.message); }
    }
    window.adminToggleRegisterOpen = adminToggleRegisterOpen;
    function adminGenSignupCode() {
        const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
        let s = '';
        for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
        const el = document.getElementById('signupCodeInput');
        if (el) el.value = s;
    }
    window.adminGenSignupCode = adminGenSignupCode;
    async function adminSaveSignupCode() {
        const code = (document.getElementById('signupCodeInput').value || '').trim();
        try {
            await accountApi('setSignupCode', { code });
            toast(code ? '注册通道已开通，邀请码：'+ code : '已关闭登录页注册通道');
            await loadSignupConfigIntoForm();
        } catch (e) { alert('保存失败：'+ e.message); }
    }
    window.adminSaveSignupCode = adminSaveSignupCode;
    async function loadBubbleConfigIntoForm() {
        const slot = document.getElementById('adminBubbleSlot');
        if (!slot) return;
        try {
            const cfg = await accountApi('getBubbleConfig');
            window.__bubbleCfg = cfg;
            renderBubbleAdminUI(cfg.enabled, cfg.interval);
        } catch (e) { slot.innerHTML = '<span style="color:#c00;">读取失败：'+ escapeHtml(e.message || String(e)) + '</span>'; }
    }
    function renderBubbleAdminUI(enabled, interval) {
        const slot = document.getElementById('adminBubbleSlot');
        if (!slot) return;
        slot.innerHTML =
            '<div style="margin-bottom:10px; display:flex; align-items:center; gap:10px;">'+ '<span class="lui-switch"><input type="checkbox" '+ (enabled ? 'checked': '') + 'onchange="adminToggleBubble()"><span class="track"></span></span>'+ '<span style="font-size:13px;">'+ (enabled ? '气泡已开启': '气泡已关闭') + '</span></div>'+ '<div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">'+ '<span style="font-size:13px; color:var(--ink-2);">出现间隔</span>'+ '<input id="bubbleAdminInterval" type="number" min="3" max="120" value="'+ interval + '" class="lui-input sm" style="width:80px;">'+ '<span style="font-size:13px; color:var(--ink-3);">秒（3-120）</span>'+ '<button class="lui-btn sm tonal" onclick="adminSaveBubbleConfig()">保存</button></div>';
    }
    function adminToggleBubble() {
        const cfg = window.__bubbleCfg || { enabled: true, interval: 12 };
        cfg.enabled = !cfg.enabled;
        window.__bubbleCfg = cfg;
        renderBubbleAdminUI(cfg.enabled, cfg.interval);
    }
    window.adminToggleBubble = adminToggleBubble;
    async function adminSaveBubbleConfig() {
        const cfg = window.__bubbleCfg || { enabled: true, interval: 12 };
        const interval = parseInt(document.getElementById('bubbleAdminInterval').value, 10) || 12;
        try {
            const r = await accountApi('setBubbleConfig', { enabled: cfg.enabled, interval });
            window.__bubbleCfg = { enabled: r.enabled, interval: r.interval };
            bubbleEnabled = r.enabled; bubbleIntervalSec = r.interval;
            if (r.enabled && floatPhotos.length) restartBubbleGenerator();
            else { stopBubbleGenerator(); clearAllDreamBubbles(); }
            renderBubbleAdminUI(r.enabled, r.interval);
            toast('背景气泡设置已保存');
        } catch (e) { alert('保存失败：'+ e.message); }
    }
    window.adminSaveBubbleConfig = adminSaveBubbleConfig;
    async function toggleNotifySwitch(key) {
        const next = !window.__notifySwitches[key];
        window.__notifySwitches[key] = next;
        applyNotifySwitchUI(key, next);
        try {
            await accountApi('setNotifySwitches', { [key]: next });
            toast((next ? '已开启': '已关闭') + ({ enabled: '通知总开关', feed: '动态通知', message: '留言通知', like: '点赞通知'}[key] || '通知'), 'success');
        } catch (e) {
            window.__notifySwitches[key] = !next; applyNotifySwitchUI(key, !next);
            toast('保存失败：'+ e.message, 'error');
        }
    }
    async function adminSaveUserEmail(username) {
        const input = document.getElementById(username === 'boy'? 'emailBoy': 'emailGirl');
        const email = input.value.trim();
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast('邮箱格式不正确', 'error'); return; }
        try {
            await accountApi('setUserEmail', { username, email });
            toast(username + '的邮箱已'+ (email ? '保存': '清空'), 'success');
        } catch (e) { toast('保存失败：'+ e.message, 'error'); }
    }
    async function saveNotifyConfig() {
        const publicKey = document.getElementById('notifyPublicKey').value.trim();
        const serviceId = document.getElementById('notifyServiceId').value.trim();
        const templateId = document.getElementById('notifyTemplateId').value.trim();
        try {
            await accountApi('setNotifyConfig', { publicKey, serviceId, templateId });
            toast('EmailJS 配置已保存', 'success');
        } catch (e) { toast('保存失败：'+ e.message, 'error'); }
    }
    async function testNotifyEmail() {
        try {
            const result = await accountApi('testNotify', {});
            toast('测试邮件已发送到 '+ (result.to || '你的邮箱'), 'success');
        } catch (e) { toast('发送失败：'+ e.message, 'error'); }
    }
    function renderAdminSectionShell() {
        const sections = [
            ['feed', '时光相册'], ['message', '留言板'], ['love', '感动的话'], ['memory', '一起做过的事'],
            ['memo', '待办备忘录'], ['schedule', '行程安排'], ['countdown', '纪念日倒计时'], ['marker', '旅行地图']
        ];
        return `<div class="admin-section"><h3>内容管理 · 按需加载</h3><div style="display:flex;gap:8px;flex-wrap:wrap;">${sections.map(([type, label]) => `<button class="admin-btn" onclick="renderAdminContentSection('${type}')">${label}</button>`).join('')}</div><div id="adminContentSection" style="margin-top:12px;color:#888;">选择一个分类后再加载对应内容，避免后台一次拉取全部数据。</div></div>`;
    }
    function renderAdminRows(type, rows) {
        if (!rows || rows.length === 0) return '<tr><td colspan="6" style="text-align:center;color:#999;padding:20px;">暂无数据</td></tr>';
        return rows.map(row => {
            const time = row.created_at ? new Date(row.created_at).toLocaleString() : '';
            if (type === 'feed') return `<tr><td>${escapeHtml(row.description || '').substring(0, 30)}</td><td>${escapeHtml(row.author_name || '')}</td><td>${time}</td><td>${renderVisibilityAdminControls('feed', row.id, row.visibility)}</td><td><button class="admin-btn danger" onclick="deleteFeed('${row.id}')">删除</button></td></tr>`;
            if (type === 'message') return `<tr><td>${escapeHtml(row.content || '').substring(0, 30)}</td><td>${escapeHtml(row.author_name || '')}</td><td>${time}</td><td>${renderVisibilityAdminControls('message', row.id, row.visibility)}</td><td><button class="admin-btn danger" onclick="adminDelete('message', '${row.id}')">删除</button></td></tr>`;
            if (type === 'love') return `<tr><td>${escapeHtml(row.content || '').substring(0, 30)}</td><td>${escapeHtml(row.author_name || '')}</td><td>${row.privacy === 'private'? '私密': '公开'}</td><td>${time}</td><td>${renderVisibilityAdminControls('love', row.id, row.visibility)}</td><td><button class="admin-btn danger" onclick="adminDelete('love', '${row.id}')">删除</button></td></tr>`;
            if (type === 'memory') return `<tr><td>${escapeHtml(row.content || '').substring(0, 30)}</td><td>${escapeHtml(row.author_name || '')}</td><td>${time}</td><td>${renderVisibilityAdminControls('memory', row.id, row.visibility)}</td><td><button class="admin-btn danger" onclick="adminDelete('memory', '${row.id}')">删除</button></td></tr>`;
            if (type === 'memo') { const pl = { high: '高', medium: '中', low: '低'}; return `<tr><td>${escapeHtml(row.content || '').substring(0, 30)}</td><td>${escapeHtml(row.author_name || '')}</td><td>${pl[row.priority] || row.priority || ''}</td><td>${row.done ? '已完成': '进行中'}</td><td>${renderVisibilityAdminControls('memo', row.id, row.visibility)}</td><td><button class="admin-btn danger" onclick="adminDelete('memo', '${row.id}')">删除</button></td></tr>`; }
            if (type === 'schedule') { const dr = row.start_date ? (row.end_date ? `${row.start_date} ~ ${row.end_date}` : row.start_date) : ''; return `<tr><td>${escapeHtml(row.title || '').substring(0, 20)}</td><td>${dr}</td><td>${escapeHtml(row.author_name || '')}</td><td>${renderVisibilityAdminControls('schedule', row.id, row.visibility)}</td><td><button class="admin-btn danger" onclick="adminDelete('schedule', '${row.id}')">删除</button></td></tr>`; }
            if (type === 'countdown') return `<tr><td>${escapeHtml(row.name || '').substring(0, 20)}</td><td>${row.target_date || ''}</td><td>${escapeHtml(row.author_name || '')}</td><td>${renderVisibilityAdminControls('countdown', row.id, row.visibility)}</td><td><button class="admin-btn danger" onclick="adminDelete('countdown', '${row.id}')">删除</button></td></tr>`;
            if (type === 'marker') return `<tr><td>${escapeHtml(row.name || '').substring(0, 15)}</td><td>${escapeHtml(row.author_name || '')}</td><td>${renderVisibilityAdminControls('marker', row.id, row.visibility)}</td><td><button class="admin-btn danger" onclick="adminDelete('marker', '${row.id}')">删除</button></td></tr>`;
            return '';
        }).join('');
    }
    async function renderAdminContentSection(type, options = {}) {
        if (!options.skipAdminCheck && !(await requireAdmin())) return;
        const target = document.getElementById('adminContentSection');
        if (!target) return;
        target.innerHTML = '<div style="color:#888;padding:12px;">正在加载...</div>';
        const configs = {
            feed: { title: '时光相册动态', table: 'feeds', cols: 'id,description,author_name,created_at,visibility', headers: ['描述', '作者', '时间', '可见性', '操作'] },
            message: { title: '留言板', table: 'messages', cols: 'id,content,author_name,created_at,visibility', headers: ['内容', '作者', '时间', '可见性', '操作'] },
            love: { title: '感动的话', table: 'loves', cols: 'id,content,author_name,privacy,created_at,visibility', headers: ['内容', '作者', '隐私', '时间', '可见性', '操作'] },
            memory: { title: '一起做过的事', table: 'memories', cols: 'id,content,author_name,created_at,visibility', headers: ['内容', '作者', '时间', '可见性', '操作'] },
            memo: { title: '待办备忘录', table: 'memos', cols: 'id,content,author_name,priority,done,created_at,visibility', headers: ['内容', '作者', '优先级', '状态', '可见性', '操作'] },
            schedule: { title: '行程安排', table: 'schedules', cols: 'id,title,start_date,end_date,author_name,created_at,visibility', headers: ['标题', '日期', '作者', '可见性', '操作'] },
            countdown: { title: '纪念日倒计时', table: 'countdowns', cols: 'id,name,target_date,author_name,created_at,visibility', headers: ['标题', '目标日期', '作者', '可见性', '操作'] },
            marker: { title: '旅行地图标记', table: 'travel_markers', cols: 'id,name,author_name,created_at,visibility', headers: ['名称', '作者', '可见性', '操作'] }
        };
        const config = configs[type];
        if (!config) { target.innerHTML = '<div style="color:#c00;padding:12px;">未知分类</div>'; return; }
        try {
            const { data, error } = await sb.from(config.table).select(config.cols).is('deleted_at', null).order('created_at', { ascending: false }).limit(ADMIN_LIMIT);
            if (error) throw error;
            const headerHtml = config.headers.map(h => `<th>${h}</th>`).join('');
            target.innerHTML = `<div style="font-size:13px;color:#999;margin-bottom:10px;">${config.title} · ${data ? data.length : 0} 条（最多显示${ADMIN_LIMIT}条）</div><div>${renderAdminCards(type, data || [])}</div>`;
        } catch (e) { target.innerHTML = `<div style="color:#c00;padding:12px;">加载失败：${escapeHtml(e.message || String(e))}</div>`; }
    }
    function fmtTrashTime(t) { try { return t ? new Date(t).toLocaleString() : ''; } catch (e) { return t || ''; } }
    async function loadTrashSection() {
        const target = document.getElementById('adminTrashSection');
        if (!target) return;
        const res = await trashApi('list');
        const items = res.items || [];
        window.__adminTrashCount = items.length;
        if (typeof refreshTrashBadge === 'function') refreshTrashBadge();
        if (!items.length) { target.innerHTML = '<div class="lui-empty"><div class="e-icon"><svg class="lui-icon"><use href="assets/icons.svg#i-trash"/></svg></div><div class="e-title">回收站是空的</div><div class="e-text">删除的内容会出现在这里，可恢复或彻底删除</div></div>'; return; }
        let html = '<div class="lui-mini" style="margin:4px 0 12px;">'+ items.length + '条，永久保留</div>';
        items.forEach(function(it) {
            let media = '';
            (it.media || []).forEach(function(m) {
                if (m.isVideo) media += '<video controls preload="none" src="'+ m.trashUrl + '" style="width:90px; height:90px; border-radius:12px; margin:4px 6px 4px 0; background:#000; object-fit:cover;"></video>';
                else media += '<img src="'+ m.trashUrl + '" loading="lazy" style="width:90px; height:90px; border-radius:12px; margin:4px 6px 4px 0; object-fit:cover;" />';
            });
            html += '<div class="lui-card" style="margin-bottom:10px;">'+ '<div style="font-weight:600;">['+ escapeHtml(it.type) + '] '+ escapeHtml(it.title || '(无文字内容)') + '</div>'+ '<div class="lui-mini" style="color:var(--ink-3); margin:6px 0;">作者：'+ escapeHtml(it.author || '') + '删除人：'+ escapeHtml(it.deleted_by || '') + ''+ fmtTrashTime(it.deleted_at) + '</div>'+ (media ? '<div style="display:flex; flex-wrap:wrap;">'+ media + '</div>': '')
                + '<div style="margin-top:8px; display:flex; gap:8px; flex-wrap:wrap;">'+ '<button class="lui-btn sm tonal" onclick="trashRestore(\''+ it.table + '\',\''+ it.id + '\')"><svg class="lui-icon s14"><use href="assets/icons.svg#i-trash-restore"/></svg>恢复</button>'+ '<button class="lui-btn sm danger" onclick="trashPurge(\''+ it.table + '\',\''+ it.id + '\')"><svg class="lui-icon s14"><use href="assets/icons.svg#i-trash"/></svg>彻底删除</button>'+ '</div></div>';
        });
        target.innerHTML = html;
    }
    async function trashRestore(table, id) {
        if (!(await luiConfirm('恢复这条内容？图片/视频将移回原位，内容重新显示。', { danger: false, okText: '恢复'}))) return;
        try { await trashApi('restore', table, id); toast('已恢复', 'success'); await loadTrashSection(); renderAdminData(); }
        catch (e) { toast('恢复失败：'+ (e.message || e), 'error'); }
    }
    async function trashPurge(table, id) {
        if (!(await luiConfirm('彻底删除后不可恢复！这条内容及其图片/视频将被永久移除。', { title: '最后确认', okText: '永久删除'}))) return;
        try { await trashApi('purge', table, id); toast('已彻底删除', 'success'); await loadTrashSection(); }
        catch (e) { toast('彻底删除失败：'+ (e.message || e), 'error'); }
    }
    async function renderAdminLogSection() {
        const logs = await getAdminLogs();
        const actionLabels = {
            login: '用户登录', logout: '用户登出', login_failed: '登录失败', publish_feed: '发布相册', publish_message: '发布留言',
            publish_love: '发布感动', publish_memory: '添加回忆', publish_memo: '添加待办', publish_schedule: '添加行程',
            publish_countdown: '添加纪念日', publish_marker: '添加地图标记', admin_delete: '管理员删除',
            admin_reset_pwd: '管理员重置密码', admin_delete_user: '管理员删除账号', admin_create_user: '管理员创建账号',
            admin_toggle_role: '切换用户角色', admin_set_permission: '设置用户权限', admin_toggle_visibility: '切换对外可见性'};
        let rows = '';
        if (logs && logs.length > 0) {
            for (let log of logs.slice(0, ADMIN_LIMIT)) {
                let details = '';
                try { const parsed = JSON.parse(log.details); details = Object.entries(parsed).map(([k, v]) => `${k}: ${String(v).substring(0, 20)}`).join(', '); } catch (e) { details = log.details ? String(log.details).substring(0, 30) : ''; }
                rows += `<tr><td style="font-size:11px;white-space:nowrap;">${new Date(log.created_at).toLocaleString()}</td><td>${log.user}</td><td>${actionLabels[log.action] || log.action}</td><td style="font-size:11px;color:#666;">${escapeHtml(details)}</td></tr>`;
            }
        } else rows = '<tr><td colspan="4" style="text-align:center;color:#999;padding:20px;">暂无日志记录</td></tr>';
        // 修复：日志支持导出与清空（本地+云端），管理员可管理
        return `<div class="admin-section"><h3>操作日志 (${logs ? logs.length : 0}条)</h3>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">
            <button class="admin-btn" onclick="exportAdminLogs()">导出日志</button>
            <button class="admin-btn danger" onclick="clearAdminLogs()">清空日志</button>
        </div>
        <div style="max-height:400px;overflow-y:auto;"><table class="data-table"><thead><tr><th>时间</th><th>用户</th><th>操作</th><th>详情</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
    }
    async function exportAdminLogs() {
        const logs = await getAdminLogs();
        downloadTextFile('操作日志.json', JSON.stringify(logs, null, 2), 'application/json;charset=utf-8');
        alert(`已导出 ${logs.length} 条操作日志。`);
    }
    async function clearAdminLogs() {
        if (!(await luiConfirm('本地和云端的操作日志都会被清空，且不可恢复。', { title: '清空日志', okText: '全部清空'}))) return;
        try { localStorage.removeItem('admin_logs'); } catch (e) {}
        try { await sb.from('admin_logs').delete().gt('created_at', '1970-01-01'); } catch (e) {}
        alert('操作日志已清空');
        renderAdminData();
    }
    async function adminDelete(type, id) {
        if (!(await luiConfirm('删除这条内容？删除后进入「回收站」，可恢复或彻底删除。', { okText: '删除'}))) return;
        try {
            const tableMap = { 'feed': 'feeds', 'message': 'messages', 'love': 'loves', 'memory': 'memories', 'memo': 'memos', 'schedule': 'schedules', 'countdown': 'countdowns', 'marker': 'travel_markers'};
            const table = tableMap[type];
            if (!table) { alert('未知类型'); return; }
            await trashApi('delete', table, id);
            logAction('admin_delete', { type, id });
            renderAdminData();
        } catch (e) { alert('删除失败: '+ e.message); }
    }
    async function toggleUserRole(username) {
        if (!(await requireAdmin())) return;
        if (username === 'admin') { alert('不能修改超级管理员的角色'); return; }
        try { const result = await accountApi('toggleUserRole', { username }); logAction('admin_toggle_role', { username, new_role: result.user && result.user.role }); renderAdminData(); alert(`已将 ${username} 设为${result.user && result.user.role === 'admin'? '管理员': '普通用户'}`); }
        catch (e) { alert('保存角色失败：'+ e.message); }
    }
    async function setUserPermission(username, permission) {
        if (!(await requireAdmin())) return;
        if (username === 'admin') { alert('不能修改超级管理员的权限'); return; }
        if (!['view', 'comment', 'full'].includes(permission)) { alert('权限值不正确'); return; }
        try { await accountApi('setUserPermission', { username, permission }); logAction('admin_set_permission', { username, permission }); const l = { 'full': '完全权限', 'comment': '仅评论', 'view': '仅浏览'}; alert(`已将 ${username} 的权限设为：${l[permission]}`); renderAdminData(); }
        catch (e) { alert('保存权限失败：'+ e.message); }
    }
    async function deleteUserAccount(username) {
        if (!(await requireAdmin())) return;
        if (username === 'admin') { alert('该账号不能删除'); return; }
        if (!(await luiConfirm('删除账号「'+ username + '」？\n\n它已发布的动态、留言会保留，但该账号将无法再登录。此操作不可撤销。', { title: '删除账号', okText: '删除账号'}))) return;
        try { await accountApi('deleteUser', { username }); } catch (e) { alert('删除账号失败：'+ e.message); return; }
        logAction('admin_delete_user', { username }); renderAdminData(); alert(`账号 ${username} 已删除`);
    }
    async function showRegisterModal() {
        if (!(await requireAdmin())) return;
        window.__registerMode = 'admin';
        const wrap = document.getElementById('registerInviteWrap');
        if (wrap) wrap.style.display = 'none';
        const inv = document.getElementById('newUserInvite'); if (inv) inv.value = '';
        document.getElementById('registerModal').style.display = 'flex';
    }
    // 登录页公开注册入口（未登录；管理员开启"开放注册"时无需邀请码）
    async function openPublicRegisterModal() {
        window.__registerMode = 'public';
        window.__registerOpen = false;
        const wrap = document.getElementById('registerInviteWrap');
        try {
            const cfg = await accountApi('getSignupCode');
            window.__registerOpen = !!(cfg && cfg.register_open);
        } catch (e) { /* 默认需邀请码 */ }
        if (wrap) wrap.style.display = window.__registerOpen ? 'none': 'block';
        document.getElementById('newUsername').value = '';
        document.getElementById('newUserPwd').value = '';
        const inv = document.getElementById('newUserInvite'); if (inv) inv.value = '';
        document.getElementById('registerModal').style.display = 'flex';
    }
    window.openPublicRegisterModal = openPublicRegisterModal;
    async function openAdminPanel() {
        lockBackground();
        if (isAdmin && currentUserInfo) {
            document.getElementById('adminPanel').style.display = 'block';
            document.getElementById('adminContent').innerHTML = '<div class="lui-loading"><span class="lui-spinner"></span><span>后台正在加载…</span></div>';
            renderAdminData().catch(e => { document.getElementById('adminContent').innerHTML = '<div class="lui-notice">后台加载失败：'+ escapeHtml(e.message || String(e)) + '<br>请刷新页面后再试。</div>'; });
            startAdminMonitorTimer();
            return;
        }
        document.getElementById('adminPanel').style.display = 'block';
        document.getElementById('adminContent').innerHTML = '<div class="lui-loading"><span class="lui-spinner"></span><span>正在确认管理员权限…</span></div>';
        if (!(await requireAdmin())) { closeAdminPanel(); return; }
        document.getElementById('adminPanel').style.display = 'block';
        renderAdminData().catch(e => { document.getElementById('adminContent').innerHTML = '<div class="lui-notice">后台加载失败：'+ escapeHtml(e.message || String(e)) + '<br>请刷新页面后再试。</div>'; });
        startAdminMonitorTimer();
    }

    // ---------- 可见性切换 ----------
    function getVisibilityLabel(v) { return normalizeVisibility(v) === 'couple_only'? '仅情侣可见': '公开'; }
    function getVisibilityToggleText(v) { return normalizeVisibility(v) === 'couple_only'? '恢复公开': '对外隐藏'; }
    function renderVisibilityAdminControls(type, id, visibility) {
        const normalized = normalizeVisibility(visibility);
        const next = normalized === 'couple_only'? 'public': 'couple_only';
        return `<div style="margin-bottom:4px;"><span class="lui-tag ${normalized === 'couple_only'? 'red': ''}">${getVisibilityLabel(normalized)}</span></div><button class="lui-btn sm ghost" style="padding:2px 10px; min-height:26px;" onclick="toggleRecordVisibility('${type}', '${id}', '${next}')">${getVisibilityToggleText(normalized)}</button>`;
    }
    // 前端卡片上的"对外隐藏/恢复"管理员按钮（仅管理员可见，复用后台 toggleRecordVisibility，服务端鉴权）
    function adminVisCtrl(type, id, vis) {
        if (!isAdmin) return '';
        const n = normalizeVisibility(vis);
        const next = n === 'couple_only'? 'public': 'couple_only';
        const badge = n === 'couple_only'? '<span class="lui-tag red" style="margin-right:6px;"><svg class="lui-icon s12"><use href="assets/icons.svg#i-lock"/></svg> 仅情侣可见</span>': '';
        const label = n === 'couple_only'? '恢复公开': '对外隐藏';
        return `${badge}<button class="lui-btn sm ghost" style="padding:2px 10px; min-height:26px;" onclick="toggleRecordVisibility('${type}','${id}','${next}')">${label}</button>`;
    }
    async function toggleRecordVisibility(type, id, visibility) {
        if (!(await requireAdmin())) return;
        const tableMap = { feed: 'feeds', message: 'messages', love: 'loves', memory: 'memories', memo: 'memos', schedule: 'schedules', countdown: 'countdowns', marker: 'travel_markers'};
        const table = tableMap[type];
        const nextVisibility = normalizeVisibility(visibility);
        if (!table) { alert('未知内容类型'); return; }
        const hiding = nextVisibility === 'couple_only';
        const confirmTip = hiding
            ? '设为「仅情侣可见」后，外部账号将看不到这条；你和对方、管理员仍能看到。': '恢复公开后，所有账号都能看到这条内容。';
        if (!(await luiConfirm(confirmTip, { title: hiding ? '仅情侣可见': '恢复公开', danger: false, okText: hiding ? '对外隐藏': '恢复公开'}))) return;
        try {
            const { error } = await sb.from(table).update({ visibility: nextVisibility }).eq('id', id);
            if (error) throw error;
            logAction('admin_toggle_visibility', { type, id, visibility: nextVisibility });
            toast(hiding ? '已设为「仅情侣可见」，外部账号看不到了': '已恢复公开，所有账号可见', 'success');
            if (document.getElementById('adminContentSection')) renderAdminContentSection(type);
            else renderAdminData();
            refreshCurrentSection().catch(e => console.log('可见性切换后刷新当前页面失败:', e));
        } catch (e) { toast('切换可见性失败：'+ e.message, 'error'); }
    }

    // ---------- 登录 / 自动登录 / 主系统 ----------
    function backToLogin() { document.getElementById('angryMask').style.display = 'none'; document.getElementById('loginPage').style.display = 'flex'; }
    function showSection(sectionName) {
        trackEvent('切换页面', sectionCN(sectionName));
        document.querySelectorAll('.section').forEach(sec => sec.classList.remove('active'));
        document.getElementById(sectionName + 'Section').classList.add('active');
        document.querySelectorAll('.lui-tabbar .tab').forEach(btn => btn.classList.remove('active'));
        var tabBtn = document.querySelector(`.lui-tabbar .tab[data-section="${sectionName}"]`);
        if (tabBtn) tabBtn.classList.add('active');
        currentTab = sectionName;
        window.scrollTo({ top: 0 });
        refreshCurrentSection().catch(e => console.log('切换页面刷新出现微调'));
        if (sectionName === 'travel') setTimeout(() => { initMap(); if (map) map.invalidateSize(); }, 120);
    }
    async function autoLogin() {
        const savedUser = localStorage.getItem('couple_logged_user');
        if (!savedUser || !getSessionToken()) return false;
        // 补写图片代理 cookie：自动登录恢复会话时，<img> 请求靠 cookie 鉴权
        try { document.cookie = 'couple_t='+ encodeURIComponent(getSessionToken()) + '; path=/; max-age=2592000; samesite=lax'+ (location.protocol === 'https:'? '; secure': ''); } catch (e) {}
        try {
            const users = await loadUserData({ allowLocalFallback: false });
            if (users[savedUser]) { enterMainSystem(savedUser, users); return true; }
        } catch (e) {
            // 修复：自动登录失败时保留登录态（网络抖动不清除），仅回到登录页让用户手动重登
            console.warn('自动登录失败，请手动登录:', e);
            document.getElementById('mainPage').style.display = 'none';
            document.getElementById('loginPage').style.display = 'flex';
            updateAdminVisibility();
        }
        return false;
    }
    async function unlockEntryGate() {
        document.getElementById('bubbleLayer').style.display = 'none';
        document.getElementById('mainPage').style.display = 'none';
        document.getElementById('loginPage').style.display = 'flex';
        if (bubbleReplenishTimer) { clearInterval(bubbleReplenishTimer); bubbleReplenishTimer = null; } // 修复：解锁后停止气泡补充定时器
        const restored = await autoLogin();
        if (!restored) document.getElementById('loginPage').style.display = 'flex';
    }
    async function login() {
        const u = document.getElementById('username').value.trim();
        const p = document.getElementById('password').value.trim();
        const btn = document.getElementById('loginBtn');
        if (!u || !p) { alert('请输入账号和密码'); return; }
        if (btn) { btn.disabled = true; btn.innerText = '正在登录...'; }
        try {
            const result = await accountApi('login', { username: u, password: p });
            setSession(result.user.username, result.sessionToken);
            const users = {}; users[result.user.username] = normalizeUserInfo(result.user.username, result.user);
            enterMainSystem(result.user.username, users);
        } catch (e) {
            logAction('login_failed', { username: u, reason: e.message });
            alert('登录失败：'+ e.message);
        } finally { if (btn) { btn.disabled = false; btn.innerText = '登录'; } }
    }
    function runDeferredInitialLoad() {
        // 修复：登录后立即加载共享照片池（不再等用户进设置），背景气泡真正生效
        const tasks = [() => loadBubbleConfig({ loadPhotos: true }), () => loadAngryData()];
        let index = 0;
        const runNext = () => { if (index >= tasks.length || !currentUser) return; const t = tasks[index++]; Promise.resolve().then(t).catch(e => console.log('延后加载共享状态失败:', e)).finally(() => setTimeout(runNext, 250)); };
        setTimeout(runNext, 300);
    }
    function enterMainSystem(username, users) {
        currentUser = username;
        currentTab = 'message';
        const userInfo = users[username] || {};
        currentUserInfo = userInfo;
        isAdmin = (username === 'admin') || userInfo.role === 'admin';
        document.getElementById('bubbleLayer').style.display = 'none';
        document.getElementById('loginPage').style.display = 'none';
        document.getElementById('mainPage').style.display = 'block';
        document.getElementById('displayUsername').innerHTML = authorDisplay(username);
        loadCurrentUserAvatar();
        loadStorageModeSetting();
        updateTogetherDays();
        updateAdminVisibility();
        updateActivity();
        logAction('login', { username });
        renderMessages({ force: false }).catch(e => console.log('留言板首屏加载失败:', e));
        startAutoSync();
        startHeartbeat();
        setTimeout(updateOnlineStatus, 1000);
        if (onlineStatusTimer) clearInterval(onlineStatusTimer);
        onlineStatusTimer = setInterval(updateOnlineStatus, ONLINE_STATUS_INTERVAL_MS);
        setTimeout(runDeferredInitialLoad, 800);
    }
    async function openBubbleSettings() {
        if (!(await requirePermission('full'))) return;
        document.getElementById('bubbleSettingsModal').style.display = 'flex';
        await loadBubbleConfig({ loadPhotos: true });
        renderBubblePreview();
    }

    // ---------- 初始化 ----------
    function initApp() {
        // 事件绑定
        document.getElementById('openBubbleSettingsBtn').onclick = openBubbleSettings;
        document.getElementById('bubblePhotoInput').addEventListener('change', (e) => { addPhotosToBubble(e.target.files); e.target.value = ''; });
        var bubbleToggleEl = document.getElementById('bubbleToggle');
        if (bubbleToggleEl) bubbleToggleEl.onchange = () => { bubbleEnabled = bubbleToggleEl.checked; updateToggleUI(); };
        // 二次确认弹窗按钮绑定
        var cmOk = document.getElementById('cmOk');
        var cmCancel = document.getElementById('cmCancel');
        var cmClose = document.getElementById('cmClose');
        if (cmOk) cmOk.onclick = () => __closeCm(true);
        if (cmCancel) cmCancel.onclick = () => __closeCm(false);
        if (cmClose) cmClose.onclick = () => __closeCm(false);
        var cmOv = document.getElementById('confirmModal');
        if (cmOv) cmOv.addEventListener('click', (e) => { if (e.target === cmOv) __closeCm(false); });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape'&& document.getElementById('confirmModal').style.display === 'flex') __closeCm(false); });
        document.addEventListener('click', (e) => { if (!e.target.closest('.settings-dropdown')) { var dm = document.getElementById('dropdownMenu'); if (dm) dm.style.display = 'none'; } });
        document.querySelectorAll('.lui-tabbar .tab').forEach(btn => { btn.onclick = function () { showSection(this.getAttribute('data-section')); }; });
        const msgPhotoEl = document.getElementById('messagePhotoInput');
        if (msgPhotoEl) msgPhotoEl.addEventListener('change', (e) => {
            const p = document.getElementById('messagePhotoPreview');
            if (!p) return;
            p.innerHTML = e.target.files[0] ? `<img src="${URL.createObjectURL(e.target.files[0])}" loading="lazy" decoding="async" style="max-width:100px;border-radius:12px;border:1px solid var(--line);">` : '';
        });
        const fileInputElem = document.getElementById('fileInput');
        if (fileInputElem) fileInputElem.addEventListener('change', function (e) { window.selectedFiles = Array.from(e.target.files); updateFilePreview(); });
        const modalEl = document.getElementById('imageModal');
        if (modalEl) {
            modalEl.addEventListener('touchstart', e => { touchStartX = e.changedTouches[0].screenX; }, { passive: true });
            modalEl.addEventListener('touchend', e => { touchEndX = e.changedTouches[0].screenX; handleDisplaySwipe(); }, { passive: true });
        }
            // 与零依赖门禁脚本衔接：库加载完成前已点满气泡则补进登录/自动登录
        if (window.__gateUnlocked) { try { unlockEntryGate(); } catch (e) { console.error(e); } }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initApp);
    else initApp();
