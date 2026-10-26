        // ========== Supabase 数据库初始化 ==========
        const SUPABASE_URL = 'https://txeynuvttibnilvttieu.supabase.co';
        const SUPABASE_ANON_KEY = 'sb_publishable_Z8E9qPbi6F2NLzoQh9fhfw__goWiZZ4'; 

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
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'track', sessionToken: (typeof getSessionToken === 'function' ? getSessionToken() : '') || '', page_url: location.href.slice(0, 120), events: events })
            }).catch(() => {});
        }
        window.addEventListener('beforeunload', function () {
            if (__trackQueue.length) {
                try { navigator.sendBeacon('/api/account', JSON.stringify({ action: 'track', events: __trackQueue.splice(0), page_url: location.href.slice(0, 120) })); } catch (e) {}
            }
        });

        // 板块英文名 → 中文（行为日志可读化）
        const SECTION_CN = { message: '留言板', gallery: '时光相册', memory: '回忆', love: '感动', memo: '待办', todo: '待办', travel: '旅行地图', angry: '生气模式' };
        function sectionCN(name) { return SECTION_CN[name] || name; }

        // 数据请求统一走 /api/db 代理（服务端鉴权，RLS 封死后的正确通道）
        function dbProxyFetch(input, init) {
            var url = typeof input === 'string' ? new URL(input, window.location.origin) : new URL(input.url);
            if (url.pathname.indexOf('/rest/v1/') >= 0) {
                var headers = new Headers(init ? init.headers : undefined);
                headers.set('X-Couple-Token', localStorage.getItem('couple_session_token') || '');
                return fetch('/api/db' + url.pathname + url.search, {
                    method: init ? init.method : 'GET',
                    headers: headers,
                    body: init && init.body ? init.body : undefined
                });
            }
            return fetch(input, init);
        }
        const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { fetch: dbProxyFetch } });

        // ========== LUI 设计系统助手（图标 / Toast / 确认框 / 浮层开关） ==========
        function iconSvg(name) { return '<svg class="lui-icon"><use href="assets/icons.svg#' + name + '"/></svg>'; }
        // 展示用用户名：剥离历史数据里开头的 emoji/变体选择符/ZWJ 序列与空白（如 👦 boy / 🧑‍🤝‍🧑 x）
        function prettyName(name) {
            return String(name || '').replace(/^(?:[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{FE0F}\u{200D}\s]+)+/u, '').trim();
        }
        // 改名兜底：author_name 是历史快照，改名后服务端已把 author 列更新为新名；
        // 若快照与 author 不一致（旧补丁漏更新场景），以 author（权威用户名）为准
        function displayName(author, authorName) { return (authorName && authorName !== author) ? author : (authorName || author || ''); }
        function toast(msg, type) {
            var t = document.createElement('div');
            t.className = 'lui-toast show' + (type === 'success' ? ' success' : type === 'error' ? ' error' : type === 'warn' ? ' warn' : '');
            var icon = type === 'success' ? 'i-check-circle' : type === 'error' ? 'i-x-circle' : type === 'warn' ? 'i-alert' : 'i-info';
            t.innerHTML = iconSvg(icon) + '<span>' + escapeHtml(String(msg == null ? '' : msg)) + '</span>';
            document.body.appendChild(t);
            setTimeout(function(){ t.classList.remove('show'); setTimeout(function(){ t.remove(); }, 320); }, 2400);
        }
        function confirmDialog(opts) {
            return new Promise(function(resolve) {
                opts = opts || {};
                var old = document.getElementById('luiConfirmHost'); if (old) old.remove();
                var host = document.createElement('div');
                host.id = 'luiConfirmHost';
                host.className = 'lui-overlay center';
                host.style.display = 'flex';
                var danger = !!opts.danger;
                host.innerHTML = '<div class="lui-modal">'
                    + '<div class="m-title"><span class="lui-badge-icon' + (danger ? ' red' : '') + '">' + iconSvg(danger ? 'i-alert' : 'i-info') + '</span>' + escapeHtml(opts.title || '请确认') + '</div>'
                    + '<div class="m-text">' + escapeHtml(opts.text || '') + '</div>'
                    + '<div class="m-actions"><button class="lui-btn subtle" data-act="cancel">' + escapeHtml(opts.cancelText || '取消') + '</button>'
                    + '<button class="lui-btn ' + (danger ? 'danger' : 'primary') + '" data-act="ok">' + escapeHtml(opts.okText || '确定') + '</button></div></div>';
                document.body.appendChild(host);
                function done(v){ host.remove(); document.body.style.overflow=''; resolve(v); }
                host.querySelector('[data-act=ok]').onclick = function(){ done(true); };
                host.querySelector('[data-act=cancel]').onclick = function(){ done(false); };
                host.onclick = function(e){ if (!danger && e.target === host) done(false); };
                document.body.style.overflow = 'hidden';
            });
        }
        function openOverlay(id){ var el=document.getElementById(id); if(!el) return; el.style.display='flex'; document.body.style.overflow='hidden'; }
        function hideOverlay(id){ var el=document.getElementById(id); if(!el) return; el.style.display='none'; document.body.style.overflow=''; }
        
        // 临时 GitHub 前端直传测试模式：token 只在浏览器会话中粘贴使用，不写进源码。
        const GITHUB_DIRECT_UPLOAD_TEST_MODE = false;
        const GITHUB_DIRECT_OWNER = 'shaozixiang';
        const GITHUB_DIRECT_REPO = 'couple-images';
        const GITHUB_DIRECT_BRANCH = 'main';
        
        // ========== 图片压缩与文件大小限制 ==========
        // 图片自动压缩，超过指定大小自动压缩
        async function compressImage(file, maxSizeMB = 2, maxWidth = 1280) {
            return new Promise((resolve) => {
                // 不是图片或者是GIF动图，不压缩（避免丢失动画）
                if (!file.type.startsWith('image/') || file.type === 'image/gif') {
                    resolve(file);
                    return;
                }
                
                // 文件小于限制，不压缩
                if (file.size <= maxSizeMB * 1024 * 1024) {
                    resolve(file);
                    return;
                }
                
                const reader = new FileReader();
                reader.onload = function(e) {
                    const img = new Image();
                    img.onload = function() {
                        const canvas = document.createElement('canvas');
                        let width = img.width;
                        let height = img.height;
                        
                        // 等比例缩放
                        if (width > maxWidth) {
                            height = (height * maxWidth) / width;
                            width = maxWidth;
                        }
                        
                        canvas.width = width;
                        canvas.height = height;
                        
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(img, 0, 0, width, height);
                        
                        // 转换为blob，质量0.8
                        canvas.toBlob(function(blob) {
                            const compressedFile = new File([blob], file.name, { 
                                type: 'image/jpeg', 
                                lastModified: Date.now() 
                            });
                            resolve(compressedFile);
                        }, 'image/jpeg', 0.8);
                    };
                    img.onerror = function() {
                        resolve(file); // 压缩失败，返回原文件
                    };
                    img.src = e.target.result;
                };
                reader.onerror = function() {
                    resolve(file); // 读取失败，返回原文件
                };
                reader.readAsDataURL(file);
            });
        }
        
        async function uploadToBucket(file, folder = 'common') {
            if (!file) return null;
            try {
                // 文件大小限制
                const isVideo = file.type.startsWith('video/');
                const isImage = file.type.startsWith('image/');
                const maxImageSize = 10 * 1024 * 1024; // 图片最大10MB
                const maxVideoSize = 30 * 1024 * 1024; // 视频最大30MB（服务端 Git Data 限额）
                
                if (isImage && file.size > maxImageSize) {
                    toast('图片太大啦！最大支持10MB哦~');
                    return null;
                }
                if (isVideo && file.size > maxVideoSize) {
                    toast('视频太大啦！最大支持30MB哦~');
                    return null;
                }
                
                // 图片自动压缩
                let uploadFile = file;
                if (isImage && file.type !== 'image/gif') {
                    uploadFile = await compressImage(file, 2, 1280);
                }
                
                if (GITHUB_DIRECT_UPLOAD_TEST_MODE) {
                    return await uploadToGitHubFromBrowser(uploadFile, folder || 'common');
                }
                if (window.location.protocol === 'file:') {
                    toast('本地直接打开不能上传图片：上传接口 /api/upload-to-github 只在 Cloudflare Pages 部署后存在。请部署到线上测试，或临时开启 GITHUB_DIRECT_UPLOAD_TEST_MODE 进行本地直传测试。');
                    return null;
                }
                
                const formData = new FormData();
                formData.append('file', uploadFile, uploadFile.name || file.name || 'media');
                formData.append('folder', folder || 'common');
                formData.append('mediaType', isVideo ? 'video' : (isImage ? 'image' : 'file'));
                
                const response = await fetch('/api/upload-to-github', {
                    method: 'POST',
                    headers: { 'X-Couple-Token': getSessionToken() || '' },
                    body: formData
                });
                const result = await response.json().catch(() => ({}));
                if (!response.ok || !result.url) {
                    toast('上传失败: ' + (result.error || 'GitHub 上传接口未返回链接'));
                    return null;
                }
                return result.url;
            } catch (e) {
                toast('上传失败: ' + (e.message || '请确认网站已部署到 Cloudflare Pages，并配置 GITHUB_TOKEN 环境变量')); 
                return null;
            }
        }
        
        async function uploadToGitHubFromBrowser(file, folder = 'common') {
            const tokenKey = 'github_direct_upload_token';
            let token = sessionStorage.getItem(tokenKey);
            if (!token) {
                token = prompt('临时测试：请粘贴 GitHub token。只保存在当前浏览器会话，不会写入源码。');
                if (!token) return null;
                sessionStorage.setItem(tokenKey, token.trim());
            }
            token = token.trim();
            const safeFolder = String(folder || 'common').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'common';
            const extension = getMediaExtension(file);
            const month = new Date().toISOString().slice(0, 7);
            const random = Math.random().toString(36).slice(2, 10);
            const path = `${safeFolder}/${month}/${Date.now()}-${random}.${extension}`;
            const base64 = await fileToBase64(file);
            const apiUrl = `https://api.github.com/repos/${GITHUB_DIRECT_OWNER}/${GITHUB_DIRECT_REPO}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
            const response = await fetch(apiUrl, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/vnd.github+json',
                    'Content-Type': 'application/json',
                    'X-GitHub-Api-Version': '2022-11-28'
                },
                body: JSON.stringify({
                    message: `Upload ${safeFolder} media ${path.split('/').pop()}`,
                    branch: GITHUB_DIRECT_BRANCH,
                    content: base64
                })
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) {
                if (response.status === 401 || response.status === 403) sessionStorage.removeItem(tokenKey);
                throw new Error(result.message || 'GitHub 前端直传失败');
            }
            return `https://cdn.jsdelivr.net/gh/${GITHUB_DIRECT_OWNER}/${GITHUB_DIRECT_REPO}@${GITHUB_DIRECT_BRANCH}/${path}`;
        }
        
        function fileToBase64(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result).split(',')[1]);
                reader.onerror = () => reject(new Error('读取文件失败'));
                reader.readAsDataURL(file);
            });
        }
        
        function getMediaExtension(file) {
            const mimeMap = {
                'image/jpeg': 'jpg',
                'image/png': 'png',
                'image/gif': 'gif',
                'image/webp': 'webp',
                'video/mp4': 'mp4',
                'video/webm': 'webm',
                'video/quicktime': 'mov'
            };
            if (mimeMap[file.type]) return mimeMap[file.type];
            const nameMatch = String(file.name || '').toLowerCase().match(/\.([a-z0-9]{1,8})$/);
            return nameMatch ? nameMatch[1] : 'bin';
        }
        let bubbleClicked = 0, currentUser = '', isAdmin = false, storageMode = 'cloud', map = null, markers = [], currentTab = 'message';
        let currentUserInfo = null;
        let lastUserSyncError = null;
        let lastPermissionError = null;
        const START_DATE = new Date(2023, 11, 12);
        let floatPhotos = [], bubbleEnabled = true, bubbleIntervalSec = 12, bubbleTimer = null, activeBubbleCount = 0, bubblePhotoScope = 'all';
        
        let currentPhotosList = [];
        let currentPhotoIndex = -1;
        let touchStartX = 0;
        let touchEndX = 0;
        window.selectedFiles = [];
        
        // ========== 实时同步核心机制 ==========
        let syncTimer = null;
        let onlineStatusTimer = null;
        const PAGE_LIMIT = 500;
        const MAP_LIMIT = 120;
        const ADMIN_LIMIT = 50;
        const SECTION_CACHE_MS = 90 * 1000;
        const AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000;
        const ONLINE_STATUS_INTERVAL_MS = 5 * 60 * 1000;
        const LOG_LOCAL_LIMIT = 300;
        const LOG_REMOTE_ACTIONS = new Set([
            'admin_delete', 'admin_reset_pwd', 'admin_delete_user', 'admin_create_user',
            'admin_toggle_role', 'admin_set_permission', 'admin_toggle_visibility',
            'publish_feed', 'publish_message', 'publish_love', 'publish_memory',
            'publish_memo', 'publish_schedule', 'publish_countdown', 'publish_marker'
        ]);
        const sectionLoadedAt = {};
        function selectUserAuthRows() { return 'username,avatar,permission,role,last_active,is_online'; }
        function imgProxy(url) {
            if (!url || typeof url !== 'string') return url;
            var m;
            if ((m = url.match(/^https:\/\/cdn\.jsdelivr\.net\/gh\/([^\/]+)\/([^@\/]+)@([^\/]+)\/(.+)$/))) return '/api/img/' + m[4];
            if ((m = url.match(/^https:\/\/raw\.githubusercontent\.com\/([^\/]+)\/([^\/]+)\/([^\/]+)\/(.+)$/))) return '/api/img/' + m[4];
            if ((m = url.match(/^https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/blob\/([^\/]+)\/(.+)$/))) return '/api/img/' + m[4];
            return url;
        }
        function getSessionToken() { return localStorage.getItem('couple_session_token') || ''; }
        function setSession(username, sessionToken) { localStorage.setItem('couple_logged_user', username); localStorage.setItem('couple_session_token', sessionToken); try { document.cookie = 'couple_t=' + encodeURIComponent(sessionToken) + '; path=/; max-age=2592000; samesite=lax' + (location.protocol === 'https:' ? '; secure' : ''); } catch (e) {} }
        function clearSession() { localStorage.removeItem('couple_logged_user'); localStorage.removeItem('couple_session_token'); try { document.cookie = 'couple_t=; path=/; max-age=0; samesite=lax'; } catch (e) {} }
        async function accountApi(action, payload = {}) {
            if (window.location.protocol === 'file:') throw new Error('账号安全接口 /api/account 只在部署到 Cloudflare Pages 或 Vercel 后可用，不能直接双击本地 HTML 登录。');
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 12000);
            let response;
            try {
                response = await fetch('/api/account', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action, sessionToken: getSessionToken(), ...payload }),
                signal: controller.signal
            });
            } catch(e) {
                if (e && e.name === 'AbortError') throw new Error('/api/account 超时，请刷新页面或检查网络/后端函数。');
                throw e;
            } finally {
                clearTimeout(timeout);
            }
            const responseText = await response.text();
            let result = {};
            try { result = responseText ? JSON.parse(responseText) : {}; } catch(e) {
                const preview = responseText ? responseText.slice(0, 120).replace(/\s+/g, ' ') : '空响应';
                throw new Error(`/api/account 返回的不是 JSON。HTTP ${response.status}，内容：${preview}`);
            }
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
            } catch(e) {
                clearTimeout(timeout);
                if (e && e.name === 'AbortError') throw new Error('/api/trash 超时，请检查网络后重试。');
                throw e;
            }
            clearTimeout(timeout);
            let result = {};
            const txt = await resp.text();
            try { result = txt ? JSON.parse(txt) : {}; } catch(_) { throw new Error('回收站返回格式错误'); }
            if (!resp.ok) throw new Error(result.error || ('请求失败 HTTP ' + resp.status));
            return result;
        }
        function userArrayToMap(list = []) {
            const map = {};
            (list || []).forEach(user => { if (user && user.username) map[user.username] = normalizeUserInfo(user.username, user); });
            return map;
        }
        // 安全（H2 存储型 XSS）：展示前统一转义用户可控的昵称/评论作者名
        function sanitizeContentRows(rows) {
            return (rows || []).map(function (r) {
                if (!r || typeof r !== 'object') return r;
                if (r.author_name != null) r.author_name = escapeHtml(String(r.author_name));
                if (Array.isArray(r.comments)) {
                    r.comments = r.comments.map(function (c) {
                        if (!c || typeof c !== 'object') return c;
                        const n = Object.assign({}, c);
                        if (n.authorName != null) n.authorName = escapeHtml(String(n.authorName));
                        if (n.author != null) n.author = escapeHtml(String(n.author));
                        return n;
                    });
                }
                return r;
            });
        }
        async function selectContentRows(table, columns, options = {}) {
            let query = sb.from(table).select(columns);
            query = query.is('deleted_at', null);
            if (!isAdmin && !isCoupleAccount()) query = query.or('visibility.is.null,visibility.eq.public');
            const res = await query.order(options.orderBy || 'created_at', { ascending: !!options.ascending }).limit(options.limit || PAGE_LIMIT);
            if (res && res.data) res.data = sanitizeContentRows(res.data);
            return res;
        }
        function shouldUseHeavyMedia(record, url) {
            const value = String(url || '');
            const looksInlineOrHuge = value.startsWith('data:') || value.length > 20000;
            return !looksInlineOrHuge || isAdmin || isCoupleAccount() || normalizeVisibility(record && record.visibility) === 'public';
        }
        function shouldReloadSection(sectionName, force = false) {
            if (force) return true;
            return Date.now() - (sectionLoadedAt[sectionName] || 0) > SECTION_CACHE_MS;
        }
        function markSectionLoaded(sectionName) { sectionLoadedAt[sectionName] = Date.now(); }
        async function refreshCurrentSection() {
            if (!currentUser) return;
            const refreshMap = {
                message: (options) => renderMessages(options),
                gallery: (options) => renderFeeds(options),
                memory: (options) => renderMemories(options),
                love: (options) => renderLoves(options),
                memo: (options) => renderMemos(options),
                todo: async (options) => { await renderSchedules(options); await renderCountdowns(options); },
                angry: (options) => loadAngryData(options),
                travel: (options) => loadMarkers(options)
            };
            const refresh = refreshMap[currentTab] || refreshMap.message;
            await refresh({ force: false });
        }
        function startAutoSync() {
            if (syncTimer) clearInterval(syncTimer);
            syncTimer = setInterval(async () => {
                if (!currentUser) return;
                
                const activeEl = document.activeElement;
                const isTyping = activeEl && (
                    (activeEl.id && activeEl.id.startsWith('comment_input_')) ||
                    (activeEl.id && activeEl.id.startsWith('msg_comment_input_')) ||
                    activeEl.id === 'msgContent' ||           
                    activeEl.id === 'feedDescription' ||      
                    activeEl.id === 'loveContent' ||          
                    activeEl.id === 'memoryContent' ||        
                    activeEl.id === 'memoContent' ||          
                    activeEl.id === 'scheduleTitle' ||        
                    activeEl.id === 'countdownTitle' ||       
                    activeEl.id === 'markerName' ||           
                    activeEl.tagName === 'TEXTAREA' ||
                    activeEl.tagName === 'INPUT'
                );
                if (isTyping) return;
                
                await refreshCurrentSection().catch(e => console.log('当前页面同步出现微调')); 
            }, AUTO_SYNC_INTERVAL_MS); // 只刷新当前页面，显著减少数据库出站流量
        }
        
        function formatPrettyDate(dateStr) {
            if (!dateStr) return '';
            const parts = dateStr.split('-');
            if (parts.length === 3) {
                return `${parts[0]}年${parseInt(parts[1])}月${parseInt(parts[2])}日`;
            }
            return dateStr;
        }
        function addDanmaku(text) {
            if(!text) return;
            let dan = document.createElement('div');
            dan.className = 'danmaku';
            dan.innerText = text;
            dan.style.left = Math.random() * 70 + 15 + '%';
            dan.style.fontSize = (22 + Math.random() * 14) + 'px';
            dan.style.color = `hsl(${Math.random() * 20 + 340}, 75%, 50%)`;
            dan.style.animationDuration = (10 + Math.random() * 6) + 's';
            document.body.appendChild(dan);
            setTimeout(() => dan.remove(), 16000);
        }
        function updateFilePreview() {
            let container = document.getElementById('selectedFilesPreview');
            if (!container) return;
            container.innerHTML = '';
            for(let i = 0; i < window.selectedFiles.length; i++) {
                let file = window.selectedFiles[i];
                let url = URL.createObjectURL(file);
                let img = document.createElement('img');
                img.src = url;
                img.className = 'preview-img';
                img.onclick = (function(idx) { return function() { 
                    window.selectedFiles.splice(idx, 1); 
                    updateFilePreview(); 
                    let dt = new DataTransfer();
                    for(let f of window.selectedFiles) dt.items.add(f);
                    const fileInput = document.getElementById('fileInput');
                    if(fileInput) fileInput.files = dt.files;
                }; })(i);
                container.appendChild(img);
            }
        }
        // ========== 时光相册 ==========
        async function uploadFeed() {
            // 权限检查
            if (!(await requirePermission('full'))) return;
            
            const btn = document.getElementById('feedSubmitBtn');
            const fileInput = document.getElementById('fileInput');
            let files = [];
            if (fileInput && fileInput.files && fileInput.files.length > 0) files = Array.from(fileInput.files);
            else if (window.selectedFiles && window.selectedFiles.length > 0) files = window.selectedFiles;
            
            const descEl = document.getElementById('feedDesc');
            const desc = descEl ? descEl.value.trim() : '';
            if(files.length === 0 && !desc) { toast('请选择照片/视频或输入描述'); return; }
            
            if(btn) { btn.disabled = true; btn.innerText = '上传中…'; }
            
            let medias = [];
            for(let file of files) {
                let isVideo = file.type.startsWith('video/');
                let blob = file.slice(0, file.size, file.type);
                let uploadFile = new File([blob], file.name, { type: file.type });
                let url = await uploadToBucket(uploadFile, 'feeds');
                if (url) medias.push({ type: isVideo ? 'video' : 'image', data: url });
            }
            
            const newFeed = {
                author: currentUser,
                author_name: currentUser,
                description: desc,
                medias: medias,
                comments: [],
                visibility: 'public'
            };
            
            try {
                await sb.from('feeds').insert(newFeed);
                // 记录发布日志
                logAction('publish_feed', { description: desc.substring(0, 50), media_count: medias.length });
            } catch(e) { console.error(e); }
            
            if(fileInput) fileInput.value = '';
            window.selectedFiles = [];
            updateFilePreview();
            if(descEl) descEl.value = '';
            if(btn) { btn.disabled = false; btn.innerText = '发送动态'; }
            renderFeeds();
            addDanmaku(`${currentUser} 发布了新动态！`);
        }
        
        async function renderFeeds(options = {}) {
            if (!shouldReloadSection('gallery', options && options.force)) return;
            let feeds = [];
            try {
                const { data, error } = await selectContentRows('feeds', 'id,description,author,author_name,created_at,comments,likes,visibility', { limit: PAGE_LIMIT });
                if (!error && data) {
                    feeds = data.map(f => ({
                        id: f.id, medias: f.medias || [], desc: f.description || '', author: f.author,
                        authorName: displayName(f.author, f.author_name), time: new Date(f.created_at).toLocaleString(), comments: f.comments || [],
                        likes: f.likes || [], visibility: normalizeVisibility(f.visibility)
                    }));
                }
            } catch(e) {}
            feeds = feeds.filter(canViewRecord);
            markSectionLoaded('gallery');
            
            if(!feeds.length){ 
                document.getElementById('galleryContainer').innerHTML='<div class="lui-empty"><div class="e-icon">'+iconSvg('i-photo')+'</div><div class="e-title">相册空空如也</div><div class="e-text">发第一条动态，记录今天吧</div></div>'; 
                return; 
            }
            
            let html = '';
            for(let feed of feeds) {
                let canDelete = isAdmin || feed.author === currentUser;
                let mediaHtml = `<div class="feed-media" id="feed_media_${feed.id}"></div>`;
                loadFeedMedia(feed.id);
                
                let commentsHtml = `<div class="feed-comments">`;
                if(feed.comments && feed.comments.length) {
                    for(let ci = 0; ci < feed.comments.length; ci++) {
                        let c = feed.comments[ci];
                        let canDelComment = isAdmin || c.author === currentUser;
                        commentsHtml += `<div class="comment-item"><strong>${escapeHtml(c.authorName || c.author)}</strong>：${escapeHtml(c.content)}<span class="lui-mini">${escapeHtml(c.time || '')}</span>${canDelComment ? `<button class="lui-btn subtle xs" onclick="deleteComment('${feed.id}',${ci})">删除</button>` : ''}</div>`;
                    }
                }
                commentsHtml += `<div class="reply-row"><input type="text" id="comment_input_${feed.id}" placeholder="友善评论…"><button class="lui-btn tonal sm" onclick="addFeedComment('${feed.id}', document.getElementById('comment_input_${feed.id}').value);document.getElementById('comment_input_${feed.id}').value=''">发送</button></div></div>`;
                
                // 点赞区域
                let likes = feed.likes || [];
                let hasLiked = likes.includes(currentUser);
                let likeCount = likes.length;
                let likeUsersHtml = likes.map(u => {
                    let displayName = u === 'boy' ? 'boy' : (u === 'girl' ? 'girl' : u);
                    return `<span class="like-user-tag">${escapeHtml(displayName)}</span>`;
                }).join('');
                let likeIcon = hasLiked ? 'i-heart-fill' : 'i-heart';
                let likeHtml = `<div class="like-row">
                    <button class="lui-btn subtle sm ${hasLiked ? 'liked' : ''}" onclick="toggleFeedLike('${feed.id}')">
                        <span class="heart-icon ${window.__justLikedFeed === feed.id ? 'heart-pop' : ''}">${iconSvg(likeIcon)}</span>
                        <span>${hasLiked ? '已喜欢' : '喜欢'}</span>
                    </button>
                    <span class="like-users">
                        <span class="lui-mini">${likeCount} 人喜欢</span>
                        ${likeUsersHtml}
                    </span>
                </div>`;
                
                html += `<div class="lui-card" style="margin-bottom:12px;"><div class="lui-between"><div class="lui-flex" style="gap:9px;align-items:center;"><span class="lui-avatar s32">${escapeHtml((prettyName(feed.authorName) || '我').slice(0,1).toUpperCase())}</span><div><div class="lui-body-text" style="font-weight:650;">${escapeHtml(prettyName(feed.authorName))}</div><div class="lui-mini">${escapeHtml(feed.time)}</div></div></div>${canDelete ? `<button class="lui-btn subtle sm" onclick="deleteFeed('${feed.id}')">${iconSvg('i-trash')}</button>` : ''}${adminVisCtrl('feed', feed.id, feed.visibility)}</div>${feed.desc ? `<div class="lui-body-text" style="margin:8px 0;">${escapeHtml(feed.desc)}</div>` : ''}${mediaHtml}${likeHtml}${commentsHtml}</div>`;
            }
            document.getElementById('galleryContainer').innerHTML = html;
            window.__justLikedFeed = null;
        }
        async function loadFeedMedia(feedId) {
            const container = document.getElementById('feed_media_' + feedId);
            if (!container) return;
            container.innerHTML = '<div style="color:#999;padding:8px;">Loading media...</div>';
            try {
                const { data, error } = await sb.from('feeds').select('medias,visibility,author,author_name,description').eq('id', feedId).maybeSingle();
                if (error) throw error;
                if (!data || !canViewRecord(data)) { container.innerHTML = ''; return; }
                const medias = (data.medias || []).filter(media => shouldUseHeavyMedia(data, media && media.data));
                if (!medias.length) { container.innerHTML = '<div style="color:#999;padding:8px;">No media</div>'; return; }
                const _fauthor = escapeHtml(data.author_name || data.author || '未知');
                const _fdesc = escapeHtml((data.description || '').slice(0, 40));
                let html = '';
                for (let media of medias) {
                    if (media.type === 'video') html += `<div class="feed-media-item" onclick="openVideoModal('${imgProxy(media.data)}')"><video src="${imgProxy(media.data)}" data-source="相册" data-author="${_fauthor}" data-desc="${_fdesc}" preload="metadata" muted playsinline style="pointer-events:none;"></video></div>`;
                    else html += `<div class="feed-media-item" onclick="openImageModal('${imgProxy(media.data)}')"><img src="${imgProxy(media.data)}" data-source="相册" data-author="${_fauthor}" data-desc="${_fdesc}" loading="lazy" decoding="async"></div>`;
                }
                container.innerHTML = html;
            } catch(e) {
                container.innerHTML = '<div style="color:#999;padding:8px;">Media load failed</div>';
            }
        }
        
        async function addFeedComment(feedId, content) { 
            if (!(await requirePermission('comment'))) return;
            if(!content.trim()) return; 
            let commentObj = { 
                author: currentUser, 
                authorName: currentUser, 
                content: content, time: new Date().toLocaleString() 
            }; 
            
            try {
                const { data } = await sb.from('feeds').select('comments').eq('id', feedId).single();
                let currentComments = data ? (data.comments || []) : [];
                currentComments.unshift(commentObj);
                await sb.from('feeds').update({ comments: currentComments }).eq('id', feedId);
                // 记录评论日志
                logAction('comment_feed', { feed_id: feedId, content: content.substring(0, 50) });
            } catch(e) { console.error(e); }
            
            const inputEl = document.getElementById('comment_input_' + feedId);
            const commentsContainer = inputEl ? inputEl.closest('.feed-comments') : null;
            if (commentsContainer) {
                const firstComment = commentsContainer.querySelector('.comment-item');
                const newCommentDiv = document.createElement('div');
                newCommentDiv.className = 'comment-item';
                newCommentDiv.innerHTML = `<strong>${commentObj.authorName}</strong>: ${escapeHtml(commentObj.content)}<span style="color:#aaa; margin-left:8px;">${commentObj.time}</span><button class="submit-btn" style="padding:0px 6px;margin-left:8px;font-size:10px;" onclick="deleteComment('${feedId}',0)">删除</button>`;
                if (firstComment) {
                    commentsContainer.insertBefore(newCommentDiv, firstComment);
                } else {
                    commentsContainer.insertBefore(newCommentDiv, inputEl.parentElement);
                }
            }
            inputEl.value = '';
            addDanmaku(`${currentUser} 评论了动态`); 
        }
        async function deleteComment(feedId, commentIdx) {
            if (!(await confirmDialog({ title: '请确认', text: '删除这条评论？评论删除后不可恢复。', okText: '删除', danger: true }))) return;
            try {
                const { data } = await sb.from('feeds').select('comments').eq('id', feedId).single();
                if(data) {
                    let currentComments = data.comments || [];
                    let deletedComment = currentComments[commentIdx];
                    if (!(await ensureCommentMutationAllowed(deletedComment))) return;
                    currentComments.splice(commentIdx, 1);
                    await sb.from('feeds').update({ comments: currentComments }).eq('id', feedId);
                    // 记录删除评论日志
                    logAction('delete_comment_feed', { 
                        feed_id: feedId, 
                        comment_author: deletedComment ? deletedComment.author : 'unknown',
                        comment_content: deletedComment ? deletedComment.content.substring(0, 30) : ''
                    });
                }
            } catch(e) { console.error(e); }
            renderFeeds(); 
        }
        async function deleteFeed(id) { 
            if (!(await canDeleteRecord('feeds', id))) return;
            if (!(await confirmDialog({ title: '请确认', text: '确定删除吗？\n删除后内容进入管理员后台「回收站」，可随时恢复。', okText: '确定', danger: true }))) return;
            try { await trashApi('delete','feeds',id); toast('已移入回收站'); } catch(e) { toast('删除失败：' + (e.message || e)); return; }
            // 记录删除日志
            logAction('delete_feed', { feed_id: id });
            renderFeeds(); 
        }
        
        // ========== 动态点赞功能 ==========
        async function toggleFeedLike(feedId) {
            if (!currentUser) {
                toast('请先登录');
                return;
            }
            if (!(await requirePermission('comment'))) return;
            
            try {
                // 1. 从数据库读取当前点赞状态
                const { data, error } = await sb.from('feeds').select('likes').eq('id', feedId).single();
                if (error) throw error;
                
                let currentLikes = data ? (data.likes || []) : [];
                
                // 2. 切换点赞状态
                let hasLiked = currentLikes.includes(currentUser);
                if (hasLiked) {
                    // 取消点赞
                    currentLikes = currentLikes.filter(u => u !== currentUser);
                    logAction('unlike_feed', { feed_id: feedId });
                    window.__justLikedFeed = null;
                } else {
                    // 点赞
                    currentLikes.push(currentUser);
                    logAction('like_feed', { feed_id: feedId });
                    window.__justLikedFeed = feedId;
                }
                // 3. 更新到数据库
                const { error: updateError } = await sb.from('feeds').update({ likes: currentLikes }).eq('id', feedId);
                if (updateError) throw updateError;

                // 4. 重新渲染UI，显示最新点赞状态
                renderFeeds();
                
            } catch(e) { 
                console.error('点赞失败:', e);
                toast('操作失败：' + (e.message || '未知错误') + '，已同步最新状态');
                renderFeeds();
            }
        }
        
        // ========== 留言板 ==========
        async function addMessageWithPhoto() { 
            // 权限检查
            if (!(await requirePermission('full'))) return;
            
            let content = document.getElementById('messageInput').value.trim(); 
            let fileInput = document.getElementById('messagePhotoInput');
            let file = fileInput.files[0]; 
            if(!content && !file) { toast('请写点内容或上传照片'); return; } 
            
            const btn = document.getElementById('msgSubmitBtn');
            if(btn) { btn.disabled = true; btn.innerText = '上传中…'; }

            let photoUrl = null;
            if (file) {
                let blob = file.slice(0, file.size, file.type);
                let uploadFile = new File([blob], file.name, { type: file.type });
                photoUrl = await uploadToBucket(uploadFile, 'messages');
            }
            
            const newMsg = {
                author: currentUser,
                author_name: currentUser,
                content: content || '',
                photo: photoUrl,
                comments: [],
                visibility: 'public'
            };
            
            try { 
                await sb.from('messages').insert(newMsg); 
                // 记录发布日志
                logAction('publish_message', { content: (content || '').substring(0, 50), has_photo: !!photoUrl });
            } catch(e) { console.error(e); }
            
            document.getElementById('messageInput').value = ''; 
            fileInput.value = ''; 
            var _pn = document.getElementById('messagePhotoName'); if (_pn) _pn.textContent = '添加照片（可选）';
            document.getElementById('messagePhotoPreview').innerHTML = ''; 
            if(btn) { btn.disabled = false; btn.innerText = '发送留言'; }
            renderMessages(); 
            addDanmaku(`${currentUser} 在留言板说了悄悄话`); 
        }
        async function renderMessages(options = {}) { 
            if (!shouldReloadSection('message', options && options.force)) return;
            let msgs = [];
            try {
                const { data, error } = await selectContentRows('messages', 'id,content,author,author_name,created_at,comments,likes,visibility', { limit: PAGE_LIMIT });
                if (!error && data) {
                    msgs = data.map(m => ({
                        id: m.id, content: m.content || '', photo: m.photo, author: m.author,
                        author_name: displayName(m.author, m.author_name), time: new Date(m.created_at).toLocaleString(), comments: m.comments || [],
                        likes: m.likes || [], visibility: normalizeVisibility(m.visibility)
                    }));
                }
            } catch(e) {}
            msgs = msgs.filter(canViewRecord);
            markSectionLoaded('message');
            
            let html = msgs.map(m => { 
                let canDelete = isAdmin || m.author === currentUser; 
                let commentsHtml = `<div class="feed-comments" style="margin-top:10px; border-radius:12px;">`;
                if(m.comments && m.comments.length) {
                    for(let ci = 0; ci < m.comments.length; ci++) {
                        let c = m.comments[ci];
                        let canDelComment = isAdmin || c.author === currentUser;
                        commentsHtml += `<div class="comment-item"><strong>${escapeHtml(c.authorName || c.author)}</strong>：${escapeHtml(c.content)}<span class="lui-mini">${escapeHtml(c.time || '')}</span>${canDelComment ? `<button class="lui-btn subtle xs" onclick="deleteMsgComment('${m.id}',${ci})">删除</button>` : ''}</div>`;
                    }
                }
                commentsHtml += `<div class="reply-row"><input type="text" id="msg_comment_input_${m.id}" placeholder="回复悄悄话…"><button class="lui-btn tonal sm" onclick="addMsgComment('${m.id}', document.getElementById('msg_comment_input_${m.id}').value);document.getElementById('msg_comment_input_${m.id}').value=''">发送</button></div></div>`;
                
                // 点赞区域
                let msgLikes = m.likes || [];
                let msgHasLiked = msgLikes.includes(currentUser);
                let msgLikeCount = msgLikes.length;
                let msgLikeUsersHtml = msgLikes.map(u => {
                    let displayName = u === 'boy' ? 'boy' : (u === 'girl' ? 'girl' : u);
                    return `<span class="like-user-tag">${escapeHtml(displayName)}</span>`;
                }).join('');
                let msgLikeIcon = msgHasLiked ? 'i-heart-fill' : 'i-heart';
                let msgLikeHtml = `<div class="like-row">
                    <button class="lui-btn subtle sm ${msgHasLiked ? 'liked' : ''}" onclick="toggleMessageLike('${m.id}')">
                        <span class="heart-icon ${window.__justLikedMsg === m.id ? 'heart-pop' : ''}">${iconSvg(msgLikeIcon)}</span>
                        <span>${msgHasLiked ? '已喜欢' : '喜欢'}</span>
                    </button>
                    <span class="like-users">
                        <span class="lui-mini">${msgLikeCount} 人喜欢</span>
                        ${msgLikeUsersHtml}
                    </span>
                </div>`;
                let photoHtml = `<div id="message_photo_${m.id}" style="margin-top:8px;"></div>`;
                loadMessagePhoto(m.id);
                return `<div class="lui-card" style="margin-bottom:12px;"><div class="lui-body-text" style="margin-bottom:8px;">${escapeHtml(m.content)}</div>${photoHtml}<div class="lui-between" style="margin-top:8px;"><div class="lui-flex" style="gap:9px;align-items:center;"><span class="lui-avatar s32">${escapeHtml((prettyName(m.author_name) || '我').slice(0,1).toUpperCase())}</span><div><div class="lui-body-text" style="font-weight:650;">${escapeHtml(prettyName(m.author_name))}</div><div class="lui-mini">${escapeHtml(m.time)}</div></div></div>${canDelete ? `<button class="lui-btn subtle sm" onclick="deleteMsg('${m.id}')">${iconSvg('i-trash')}</button>` : ''}${adminVisCtrl('message', m.id, m.visibility)}</div>${msgLikeHtml}${commentsHtml}</div>`; 
            }).join(''); 
            document.getElementById('messageList').innerHTML = html || '<div class="lui-empty"><div class="e-icon">'+iconSvg('i-message')+'</div><div class="e-title">还没有留言</div><div class="e-text">写下第一句悄悄话吧</div></div>';
            window.__justLikedMsg = null;
        }
        async function loadMessagePhoto(msgId) {
            const container = document.getElementById('message_photo_' + msgId);
            if (!container) return;
            container.innerHTML = '<span style="color:#999;font-size:12px;">Loading image...</span>';
            try {
                const { data, error } = await sb.from('messages').select('photo,visibility,author,author_name,content').eq('id', msgId).maybeSingle();
                if (error) throw error;
                if (!data || !data.photo || !canViewRecord(data) || !shouldUseHeavyMedia(data, data.photo)) {
                    container.innerHTML = '<span style="color:#999;font-size:12px;">No image</span>';
                    return;
                }
                const _mauthor = escapeHtml(data.author_name || data.author || '未知');
                const _mcontent = escapeHtml((data.content || '').slice(0, 40));
                container.innerHTML = `<img src="${imgProxy(data.photo)}" data-source="留言板" data-author="${_mauthor}" data-desc="${_mcontent}" loading="lazy" decoding="async" style="max-width:100px;max-height:100px;border-radius:10px;margin-top:8px;cursor:pointer;" onclick="openImageModal('${data.photo}')">`;
            } catch(e) {
                container.innerHTML = '<span style="color:#999;font-size:12px;">Image load failed</span>';
            }
        }
        async function addMsgComment(msgId, content) {
            if (!(await requirePermission('comment'))) return;
            if(!content.trim()) return;
            let commentObj = {
                author: currentUser,
                authorName: currentUser,
                content: content, time: new Date().toLocaleString()
            };
            try {
                const { data } = await sb.from('messages').select('comments').eq('id', msgId).single();
                let currentComments = data ? (data.comments || []) : [];
                currentComments.unshift(commentObj);
                await sb.from('messages').update({ comments: currentComments }).eq('id', msgId);
                // 记录评论日志
                logAction('comment_message', { msg_id: msgId, content: content.substring(0, 50) });
            } catch(e) { console.error(e); }
            
            const inputEl = document.getElementById('msg_comment_input_' + msgId);
            const commentsContainer = inputEl ? inputEl.closest('.feed-comments') : null;
            if (commentsContainer) {
                const firstComment = commentsContainer.querySelector('.comment-item');
                const newCommentDiv = document.createElement('div');
                newCommentDiv.className = 'comment-item';
                newCommentDiv.innerHTML = `<strong>${commentObj.authorName}</strong>: ${escapeHtml(commentObj.content)}<span style="color:#aaa; margin-left:8px;">${commentObj.time}</span><button class="submit-btn" style="padding:0px 6px;margin-left:8px;font-size:10px;" onclick="deleteMsgComment('${msgId}',0)">删除</button>`;
                if (firstComment) {
                    commentsContainer.insertBefore(newCommentDiv, firstComment);
                } else {
                    commentsContainer.insertBefore(newCommentDiv, inputEl.parentElement);
                }
            }
            inputEl.value = '';
        }
        async function deleteMsgComment(msgId, commentIdx) {
            if (!(await confirmDialog({ title: '请确认', text: '删除这条评论？评论删除后不可恢复。', okText: '删除', danger: true }))) return;
            try {
                const { data } = await sb.from('messages').select('comments').eq('id', msgId).single();
                if(data) {
                    let currentComments = data.comments || [];
                    let deletedComment = currentComments[commentIdx];
                    if (!(await ensureCommentMutationAllowed(deletedComment))) return;
                    currentComments.splice(commentIdx, 1);
                    await sb.from('messages').update({ comments: currentComments }).eq('id', msgId);
                    // 记录删除评论日志
                    logAction('delete_comment_message', { 
                        msg_id: msgId, 
                        comment_author: deletedComment ? deletedComment.author : 'unknown',
                        comment_content: deletedComment ? deletedComment.content.substring(0, 30) : ''
                    });
                }
            } catch(e) { console.error(e); }
            renderMessages();
        }
        async function deleteMsg(id){ 
            if (!(await canDeleteRecord('messages', id))) return;
            if (!(await confirmDialog({ title: '请确认', text: '确定删除吗？\n删除后内容进入管理员后台「回收站」，可随时恢复。', okText: '确定', danger: true }))) return;
            try { await trashApi('delete','messages',id); toast('已移入回收站'); } catch(e) { toast('删除失败：' + (e.message || e)); return; }
            // 记录删除日志
            logAction('delete_message', { msg_id: id });
            renderMessages(); 
        }
        
        // ========== 留言点赞功能 ==========
        async function toggleMessageLike(msgId) {
            if (!currentUser) {
                toast('请先登录');
                return;
            }
            if (!(await requirePermission('comment'))) return;
            
            try {
                // 1. 从数据库读取当前点赞状态
                const { data, error } = await sb.from('messages').select('likes').eq('id', msgId).single();
                if (error) throw error;
                
                let currentLikes = data ? (data.likes || []) : [];
                
                // 2. 切换点赞状态
                let hasLiked = currentLikes.includes(currentUser);
                if (hasLiked) {
                    // 取消点赞
                    currentLikes = currentLikes.filter(u => u !== currentUser);
                    logAction('unlike_message', { msg_id: msgId });
                    window.__justLikedMsg = null;
                } else {
                    // 点赞
                    currentLikes.push(currentUser);
                    logAction('like_message', { msg_id: msgId });
                    window.__justLikedMsg = msgId;
                }
                
                // 3. 更新到数据库
                const { error: updateError } = await sb.from('messages').update({ likes: currentLikes }).eq('id', msgId);
                if (updateError) throw updateError;
                
                // 4. 重新渲染UI，显示最新点赞状态
                renderMessages();
                
            } catch(e) { 
                console.error('点赞失败:', e);
                toast('操作失败：' + (e.message || '未知错误') + '，已同步最新状态');
                renderMessages();
            }
        }
        
        // ========== 感动的话 ==========
        async function addLove() { 
            if (!(await requirePermission('full'))) return;
            let val = document.getElementById('loveInput').value.trim(); 
            if(!val) return; 
            let privacy = document.querySelector('input[name="lovePrivacy"]:checked').value; 
            const newLove = { author: currentUser, author_name: currentUser, content: val, privacy: privacy, visibility: 'public' };
            try { 
                await sb.from('loves').insert(newLove); 
                // 记录发布感动的话日志
                logAction('publish_love', { content: val.substring(0, 50), privacy: privacy });
            } catch(e) { console.error(e); }
            
            document.getElementById('loveInput').value = ''; 
            renderLoves(); 
            addDanmaku(`${currentUser} 记录了感动的话`); 
        }
        async function renderLoves(options = {}) {
            if (!shouldReloadSection('love', options && options.force)) return; 
            let loves = [];
            try {
                const { data, error } = await selectContentRows('loves', 'id,content,author,author_name,created_at,privacy,visibility', { limit: PAGE_LIMIT });
                if (!error && data) {
                    loves = data.map(l => ({ id: l.id, content: l.content, author: l.author, authorName: displayName(l.author, l.author_name), time: new Date(l.created_at).toLocaleString(), privacy: l.privacy, visibility: normalizeVisibility(l.visibility) }));
                }
            } catch(e) {}
            loves = loves.filter(canViewRecord);
            markSectionLoaded('love');
            
            let html = loves.map(l => { 
                if(l.privacy === 'private' && l.author !== currentUser && !isAdmin) return ''; 
                let canDelete = isAdmin || l.author === currentUser; 
                return `<div class="lui-card" style="margin-bottom:10px;"><div class="lui-flex" style="gap:10px;align-items:flex-start;"><span class="lui-row-icon rose" style="flex-shrink:0;">${iconSvg('i-heart')}</span><div style="flex:1;min-width:0;"><div class="lui-body-text">${escapeHtml(l.content)}${l.privacy === 'private' ? ' <span class="lui-tag">'+iconSvg('i-lock')+' 私密</span>' : ''}</div><div class="lui-mini" style="margin-top:4px;">${escapeHtml(prettyName(l.authorName))} · ${escapeHtml(l.time)}</div></div><div class="lui-flex" style="gap:6px;">${canDelete ? `<button class="lui-btn subtle sm" onclick="deleteLove('${l.id}')">${iconSvg('i-trash')}</button>` : ''}${adminVisCtrl('love', l.id, l.visibility)}</div></div></div>`; 
            }).join(''); 
            document.getElementById('loveList').innerHTML = html || '<div class="lui-empty"><div class="e-icon">'+iconSvg('i-heart')+'</div><div class="e-title">还没有记录</div><div class="e-text">写下一句让你心动的话吧</div></div>'; 
        }
        async function deleteLove(id){ 
            if (!(await canDeleteRecord('loves', id))) return;
            if (!(await confirmDialog({ title: '请确认', text: '确定删除吗？\n删除后内容进入管理员后台「回收站」，可随时恢复。', okText: '确定', danger: true }))) return;
            try { await trashApi('delete','loves',id); toast('已移入回收站'); } catch(e) { toast('删除失败：' + (e.message || e)); return; }
            renderLoves(); 
        }
        // ========== 一起做过的事 ==========
        async function addMemory(){ 
            if (!(await requirePermission('full'))) return;
            let val=document.getElementById('memoryInput').value.trim(); 
            if(!val) return; 
            const newMemory = { author: currentUser, author_name: currentUser, content: val, visibility: 'public' };
            try { 
                await sb.from('memories').insert(newMemory); 
                // 记录添加回忆日志
                logAction('publish_memory', { content: val.substring(0, 50) });
            } catch(e) { console.error(e); }
            
            document.getElementById('memoryInput').value=''; 
            renderMemories(); 
            addDanmaku(`${currentUser} 完成了新打卡`); 
        }
        async function renderMemories(options = {}) {
            if (!shouldReloadSection('memory', options && options.force)) return; 
            let mem = [];
            try {
                const { data, error } = await selectContentRows('memories', 'id,content,author,author_name,created_at,visibility', { limit: PAGE_LIMIT });
                if (!error && data) {
                    mem = data.map(m => ({ id: m.id, content: m.content, author: m.author, authorName: displayName(m.author, m.author_name), time: new Date(m.created_at).toLocaleString(), visibility: normalizeVisibility(m.visibility) }));
                }
            } catch(e) {}
            mem = mem.filter(canViewRecord);
            markSectionLoaded('memory');
            
            let html=mem.map(m=>{ 
                let canDelete = isAdmin || m.author === currentUser; 
                return `<div class="lui-card" style="margin-bottom:10px;"><div class="lui-flex" style="gap:10px;align-items:flex-start;"><span class="lui-row-icon" style="flex-shrink:0;">${iconSvg('i-sparkles')}</span><div style="flex:1;min-width:0;"><div class="lui-body-text">${escapeHtml(m.content)}</div><div class="lui-mini" style="margin-top:4px;">${escapeHtml(prettyName(m.authorName))} · ${escapeHtml(m.time)}</div></div><div class="lui-flex" style="gap:6px;">${canDelete ? `<button class="lui-btn subtle sm" onclick="deleteMemory('${m.id}')">${iconSvg('i-trash')}</button>` : ''}${adminVisCtrl('memory', m.id, m.visibility)}</div></div></div>`; 
            }).join(''); 
            document.getElementById('memoryList').innerHTML=html||'<div class="lui-empty"><div class="e-icon">'+iconSvg('i-sparkles')+'</div><div class="e-title">暂无打卡记录</div><div class="e-text">今天也一起做点值得纪念的事吧</div></div>'; 
        }
        async function deleteMemory(id){ 
            if (!(await canDeleteRecord('memories', id))) return;
            if (!(await confirmDialog({ title: '请确认', text: '确定删除吗？\n删除后内容进入管理员后台「回收站」，可随时恢复。', okText: '确定', danger: true }))) return;
            try { await trashApi('delete','memories',id); toast('已移入回收站'); } catch(e) { toast('删除失败：' + (e.message || e)); return; }
            renderMemories(); 
        }
        // ========== 待办备忘录模块 ==========
        async function addMemo() {
            if (!(await requirePermission('full'))) return;
            let content = document.getElementById('memoInput').value.trim();
            let priority = document.getElementById('memoPriority').value;
            if (!content) { toast('请输入待办内容'); return; }
            
            const newMemo = {
                author: currentUser,
                author_name: currentUser,
                content: content,
                priority: priority,
                done: false,
                visibility: 'public'
            };
            
            try { 
                await sb.from('memos').insert(newMemo); 
                // 记录添加待办日志
                logAction('publish_memo', { content: content.substring(0, 50), priority: priority });
            } catch(e) { console.error(e); }
            document.getElementById('memoInput').value = '';
            renderMemos();
            addDanmaku(`${currentUser} 添加了待办事项`);
        }
        
        async function renderMemos(options = {}) {
            if (!shouldReloadSection('memo', options && options.force)) return;
            let memos = [];
            try {
                const { data, error } = await selectContentRows('memos', 'id,content,priority,done,author,author_name,created_at,visibility', { limit: PAGE_LIMIT });
                if (!error && data) {
                    memos = data.map(m => ({
                        id: m.id, content: m.content, priority: m.priority || 'normal',
                        done: m.done || false, author: m.author, authorName: displayName(m.author, m.author_name),
                        time: new Date(m.created_at).toLocaleString(), visibility: normalizeVisibility(m.visibility)
                    }));
                }
            } catch(e) {}
            memos = memos.filter(canViewRecord);
            markSectionLoaded('memo');
            
            let priorityColors = { normal: '#999', important: '#faad14', urgent: '#ff4757' };
            let priorityLabels = { normal: '普通', important: '重要', urgent: '紧急' };
            
            let html = memos.map(m => {
                let canDelete = isAdmin || m.author === currentUser;
                let strike = m.done ? 'text-decoration:line-through;opacity:0.6;' : '';
                const prioTag = m.priority === 'urgent' ? 'red' : m.priority === 'important' ? 'amber' : 'green';
                return `<div class="lui-card" style="margin-bottom:10px;${strike}"><div class="lui-flex" style="gap:10px;align-items:center;"><button class="todo-box ${m.done ? 'checked' : ''}" onclick="toggleMemoDone('${m.id}', ${!m.done})">${m.done ? iconSvg('i-check') : ''}</button><div style="flex:1;min-width:0;"><div class="lui-body-text"><span class="lui-tag ${prioTag}">${priorityLabels[m.priority]}</span> ${escapeHtml(m.content)}</div><div class="lui-mini" style="margin-top:3px;">${escapeHtml(prettyName(m.authorName))} · ${escapeHtml(m.time)}</div></div><div class="lui-flex" style="gap:6px;">${canDelete ? `<button class="lui-btn subtle sm" onclick="deleteMemo('${m.id}')">${iconSvg('i-trash')}</button>` : ''}${adminVisCtrl('memo', m.id, m.visibility)}</div></div></div>`;
            }).join('');
            document.getElementById('memoList').innerHTML = html || '<div class="lui-empty"><div class="e-icon">'+iconSvg('i-check-square')+'</div><div class="e-title">暂无待办事项</div><div class="e-text">一起列个计划吧</div></div>';
        }
        
        async function toggleMemoDone(id, done) {
            if (!(await canDeleteRecord('memos', id))) return;
            try { await sb.from('memos').update({ done: done }).eq('id', id); } catch(e) { console.error(e); }
            renderMemos();
        }
        
        async function deleteMemo(id) {
            if (!(await canDeleteRecord('memos', id))) return;
            if (!(await confirmDialog({ title: '请确认', text: '确定删除吗？\n删除后内容进入管理员后台「回收站」，可随时恢复。', okText: '确定', danger: true }))) return;
            try { await trashApi('delete','memos',id); toast('已移入回收站'); } catch(e) { toast('删除失败：' + (e.message || e)); return; }
            renderMemos();
        }
        // ========== 行程模块 与 纪念日倒计时 ==========
        async function addSchedule() { 
            if (!(await requirePermission('full'))) return;
            let start = document.getElementById('scheduleStart').value; 
            let end = document.getElementById('scheduleEnd').value; 
            let title = document.getElementById('scheduleTitle').value.trim(); 
            if(!start || !title) { toast('请填写开始日期和行程标题'); return; } 
            
            const newSchedule = { author: currentUser, author_name: currentUser, title: title, start_date: start, end_date: end || start, visibility: 'public' };
            try { 
                await sb.from('schedules').insert(newSchedule); 
                // 记录添加行程日志
                logAction('publish_schedule', { title: title.substring(0, 50), start_date: start, end_date: end || start });
            } catch(e) { console.error(e); }
            
            document.getElementById('scheduleStart').value = ''; 
            document.getElementById('scheduleEnd').value = ''; 
            document.getElementById('scheduleTitle').value = ''; 
            renderSchedules(); 
            addDanmaku(`${currentUser} 添加了新行程`); 
        }
        
        async function renderSchedules(options = {}) {
            if (!shouldReloadSection('todo-schedules', options && options.force)) return; 
            let schedules = [];
            try {
                const { data, error } = await selectContentRows('schedules', 'id,start_date,end_date,title,author,author_name,created_at,visibility', { limit: PAGE_LIMIT });
                if (!error && data) {
                    schedules = data.map(s => ({ id: s.id, start: s.start_date, end: s.end_date, title: s.title, author: s.author, authorName: displayName(s.author, s.author_name), time: new Date(s.created_at).toLocaleString(), visibility: normalizeVisibility(s.visibility) }));
                }
            } catch(e) {}
            schedules = schedules.filter(canViewRecord);
            markSectionLoaded('todo-schedules');
            
            let html = schedules.map(s => { 
                let canDelete = isAdmin || s.author === currentUser; 
                let dateHtml = formatPrettyDate(s.start);
                if (s.end && s.end !== s.start) {
                    dateHtml += ` ～ ${formatPrettyDate(s.end)}`;
                }
                return `<div class="lui-card" style="margin-bottom:10px;"><div class="lui-flex" style="gap:10px;align-items:flex-start;"><span class="lui-row-icon" style="flex-shrink:0;">${iconSvg('i-calendar')}</span><div style="flex:1;min-width:0;"><div class="lui-body-text">${escapeHtml(s.title)}</div><div class="lui-mini" style="margin-top:3px;">${dateHtml}</div></div><div class="lui-flex" style="gap:6px;">${canDelete ? `<button class="lui-btn subtle sm" onclick="deleteSchedule('${s.id}')">${iconSvg('i-trash')}</button>` : ''}${adminVisCtrl('schedule', s.id, s.visibility)}</div></div></div>`; 
            }).join(''); 
            document.getElementById('scheduleList').innerHTML = html || '<div class="lui-empty"><div class="e-icon">'+iconSvg('i-calendar')+'</div><div class="e-title">暂无行程</div><div class="e-text">记下下一次出发吧</div></div>'; 
        }
        
        async function deleteSchedule(id) { 
            if (!(await canDeleteRecord('schedules', id))) return;
            if (!(await confirmDialog({ title: '请确认', text: '确定删除吗？\n删除后内容进入管理员后台「回收站」，可随时恢复。', okText: '确定', danger: true }))) return;
            try { await trashApi('delete','schedules',id); toast('已移入回收站'); } catch(e) { toast('删除失败：' + (e.message || e)); return; }
            renderSchedules(); 
        }
        
        async function addCountdown() { 
            if (!(await requirePermission('full'))) return;
            let name = document.getElementById('countdownName').value.trim(); 
            let date = document.getElementById('countdownDate').value; 
            if(!name || !date) { toast('请填写名称和日期'); return; } 
            
            const newCountdown = { author: currentUser, author_name: currentUser, name: name, target_date: date, visibility: 'public' };
            try { 
                await sb.from('countdowns').insert(newCountdown); 
                // 记录添加纪念日日志
                logAction('publish_countdown', { name: name.substring(0, 50), target_date: date });
            } catch(e) { console.error(e); }
            
            document.getElementById('countdownName').value = ''; 
            document.getElementById('countdownDate').value = ''; 
            renderCountdowns(); 
            addDanmaku(`${currentUser} 添加了纪念日`); 
        }
        
        async function renderCountdowns(options = {}) {
            if (!shouldReloadSection('todo-countdowns', options && options.force)) return; 
            let countdowns = [];
            try {
                const { data, error } = await selectContentRows('countdowns', 'id,name,target_date,author,author_name,created_at,visibility', { limit: PAGE_LIMIT });
                if (!error && data) {
                    countdowns = data.map(c => ({ id: c.id, name: c.name, date: c.target_date, author: c.author, authorName: displayName(c.author, c.author_name), time: new Date(c.created_at).toLocaleString(), visibility: normalizeVisibility(c.visibility) }));
                }
            } catch(e) {}
            countdowns = countdowns.filter(canViewRecord);
            markSectionLoaded('todo-countdowns');
            
            let today = new Date(); 
            today.setHours(0,0,0,0); 
            let html = ''; 
            for(let c of countdowns) { 
                let canDelete = isAdmin || c.author === currentUser; 
                let target = new Date(c.date); 
                target.setHours(0,0,0,0); 
                let diff = Math.ceil((target - today) / (1000 * 60 * 60 * 24)); 
                let status = diff > 0 ? `还有 ${diff} 天` : diff === 0 ? '就是今天！' : `已过 ${-diff} 天`; 
                let prettyD = formatPrettyDate(c.date);
                html += `<div class="lui-card" style="margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;gap:10px;"><div style="min-width:0;flex:1;"><div class="lui-body-text">${escapeHtml(c.name)}</div><div class="lui-mini">${prettyD}</div></div><div style="text-align:right;flex-shrink:0;"><div class="lui-num" style="font-size:18px;color:var(--rose);">${status}</div></div><div class="lui-flex" style="gap:6px;">${canDelete ? `<button class="lui-btn subtle sm" onclick="deleteCountdown('${c.id}')">${iconSvg('i-trash')}</button>` : ''}${adminVisCtrl('countdown', c.id, c.visibility)}</div></div>`; 
            } 
            document.getElementById('countdownList').innerHTML = html || '<div class="lui-empty"><div class="e-icon">'+iconSvg('i-gift')+'</div><div class="e-title">暂无纪念日</div><div class="e-text">标记对你们重要的日子吧</div></div>'; 
        }
        
        async function deleteCountdown(id) { 
            if (!(await canDeleteRecord('countdowns', id))) return;
            if (!(await confirmDialog({ title: '请确认', text: '确定删除吗？\n删除后内容进入管理员后台「回收站」，可随时恢复。', okText: '确定', danger: true }))) return;
            try { await trashApi('delete','countdowns',id); toast('已移入回收站'); } catch(e) { toast('删除失败：' + (e.message || e)); return; }
            renderCountdowns(); 
        }
        // ========== 旅行地图 ==========
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
            if(map) return;
            const c0 = wgs84ToGcj02(116.4074, 39.9042);
            map = L.map('map').setView([c0[1], c0[0]], 5);
            L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', { subdomains: '1234', attribution: '&copy; 高德地图', maxZoom: 18 }).addTo(map);
            loadMarkers();
            map.on('click', (e) => {
                let name = prompt('输入地点名称:', `记忆地点`);
                if(name) { const w = gcj02ToWgs84(e.latlng.lng, e.latlng.lat); addMarker(w[1], w[0], name); }
            });
        }
        async function loadMarkers(options = {}) { 
            if (!shouldReloadSection('travel', options && options.force)) return;
            markers = [];
            try {
                const { data, error } = await selectContentRows('travel_markers', 'id,lat,lng,name,author,author_name,created_at,visibility', { ascending: false, limit: MAP_LIMIT });
                if (!error && data) {
                    markers = data.map(m => ({
                        id: m.id, lat: m.lat, lng: m.lng, name: m.name,
                        author: m.author, authorName: displayName(m.author, m.author_name),
                        time: new Date(m.created_at).toLocaleString(), visibility: normalizeVisibility(m.visibility)
                    }));
                }
            } catch(e) {}
            markers = markers.filter(canViewRecord);
            markSectionLoaded('travel');
            
            if(map) {
                map.eachLayer(layer => { if(layer instanceof L.Marker) map.removeLayer(layer); });
                for(let m of markers) {
                    const g = wgs84ToGcj02(m.lng, m.lat);
                    L.marker([g[1], g[0]], { icon: mapPinIcon() }).addTo(map).bindPopup(`<b>${escapeHtml(m.name)}</b><br>添加人：${escapeHtml(prettyName(m.authorName))}<br>${escapeHtml(m.time || '')}`);
                }
            }
            renderMarkerList(); 
        }
        async function addMarker(lat, lng, name) { 
            if (!(await requirePermission('full'))) return;
            const newMarker = { 
                lat, lng, name, 
                author: currentUser, 
                author_name: currentUser,
                visibility: 'public'
            }; 
            try { 
                await sb.from('travel_markers').insert(newMarker); 
                // 记录添加地图标记日志
                logAction('publish_marker', { name: name.substring(0, 50), lat: lat, lng: lng });
            } catch(e) { console.error(e); }
            loadMarkers(); 
            addDanmaku(`${currentUser} 标记了地点：${name}`); 
        }
        function addMarkerFromInput() { 
            let name = document.getElementById('markerName').value.trim(); 
            if(!name) { toast('请输入地点名称'); return; } 
            if(map) {
                let center = map.getCenter();
                const w = gcj02ToWgs84(center.lng, center.lat);
                addMarker(w[1], w[0], name);
                document.getElementById('markerName').value = '';
            } else toast('地图未加载');
        }
        function renderMarkerList() { 
            let html = ''; 
            for(let m of markers.slice().reverse()) { 
                let canDelete = isAdmin || m.author === currentUser; 
                html += `<div class="lui-card" style="margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;gap:10px;"><div style="min-width:0;flex:1;"><div class="lui-body-text">${escapeHtml(m.name)}</div><div class="lui-mini">${escapeHtml(prettyName(m.authorName))} · ${escapeHtml(m.time)}</div></div><div class="lui-flex" style="gap:6px;">${canDelete ? `<button class="lui-btn subtle sm" onclick="deleteMarker('${m.id}')">${iconSvg('i-trash')}</button>` : ''}${adminVisCtrl('marker', m.id, m.visibility)}</div></div>`; 
            } 
            document.getElementById('markerList').innerHTML = html || '<div style="color:#999;">暂无标记，点击地图添加回忆地点~</div>'; 
        }
        async function deleteMarker(id) { 
            if (!(await canDeleteRecord('travel_markers', id))) return;
            if (!(await confirmDialog({ title: '请确认', text: '确定删除吗？\n删除后内容进入管理员后台「回收站」，可随时恢复。', okText: '确定', danger: true }))) return;
            try { await trashApi('delete','travel_markers',id); toast('已移入回收站'); } catch(e) { toast('删除失败：' + (e.message || e)); return; }
            loadMarkers(); 
        }
        // ========== 生气模式 ==========
        async function toggleAngryMode(){ 
            if (!(await requirePermission('full'))) return;
            try {
                const { data } = await sb.from('angry_mode').select('id,enabled,by').limit(1).single();
                let mode = data || { enabled: false, by: '' };
                
                if(mode.enabled){ 
                    await sb.from('angry_mode').update({ enabled: false, by: '' }).eq('id', mode.id);
                    // 记录关闭生气模式日志
                    logAction('angry_off', {});
                    document.getElementById('angryBtn').innerText = '启用生气模式'; 
                    document.getElementById('angryStatus').innerHTML = '当前状态：没有生气，开开心心~'; 
                    toast('已取消生气模式'); 
                } else { 
                    if (mode.id) {
                        await sb.from('angry_mode').update({ enabled: true, by: currentUser }).eq('id', mode.id);
                    } else {
                        await sb.from('angry_mode').insert({ enabled: true, by: currentUser });
                    }
                    // 记录开启生气模式日志
                    logAction('angry_on', {});
                    document.getElementById('angryBtn').innerText = '取消生气模式'; 
                    document.getElementById('angryStatus').innerHTML = '<div class="lui-notice warn">'+iconSvg('i-heart-crack')+'<div class="n-body"><div class="n-title">生气模式已开启</div></div></div>'; 
                    toast('生气模式已开启'); 
                } 
            } catch(e) { 
                let mode = JSON.parse(localStorage.getItem('couple_angry') || '{"enabled":false,"by":""}');
                if(mode.enabled){ 
                    localStorage.setItem('couple_angry', JSON.stringify({enabled:false, by:''})); 
                    document.getElementById('angryBtn').innerText = '启用生气模式'; 
                    document.getElementById('angryStatus').innerHTML = '当前状态：没有生气，开开心心~'; 
                } else { 
                    localStorage.setItem('couple_angry', JSON.stringify({enabled:true, by:currentUser})); 
                    document.getElementById('angryBtn').innerText = '取消生气模式'; 
                    document.getElementById('angryStatus').innerHTML = '<div class="lui-notice warn">'+iconSvg('i-heart-crack')+'<div class="n-body"><div class="n-title">生气模式已开启</div></div></div>'; 
                }
            }
            loadAngryData(); 
        }
        async function loadAngryData(){ 
            let mode = { enabled: false, by: '' };
            let ap = [];
            
            try {
                const { data: modeData } = await sb.from('angry_mode').select('id,enabled,by').limit(1).single();
                if (modeData) mode = modeData;
                
                const { data: apData } = await sb.from('apologies').select('id,content,author,author_name,created_at,status').is('deleted_at', null).order('created_at', { ascending: false }).limit(PAGE_LIMIT);
                if (apData) ap = apData.map(a => ({
                    id: a.id, content: a.content, from: a.author, 
                    fromName: a.author_name, time: new Date(a.created_at).toLocaleString(), 
                    status: a.status || 'pending'
                }));
            } catch(e) {
                mode = JSON.parse(localStorage.getItem('couple_angry')||'{"enabled":false}');
                ap = JSON.parse(localStorage.getItem('couple_apologies')||'[]');
            }
            
            if(mode.enabled && mode.by !== currentUser && currentUser && !isAdmin) {
                // 显示生气提示，但不阻止使用，用户可以选择道歉或关闭
                document.getElementById('angryMask').style.display = 'flex';
            }
            
            if (mode.enabled) {
                document.getElementById('angryBtn').innerText = '取消生气模式'; 
                document.getElementById('angryStatus').innerHTML = '<div class="lui-notice warn">'+iconSvg('i-heart-crack')+'<div class="n-body"><div class="n-title">生气模式已开启</div><div>开启者：' + escapeHtml(prettyName(mode.by || '')) + '</div></div></div>';
            } else {
                document.getElementById('angryBtn').innerText = '启用生气模式'; 
                document.getElementById('angryStatus').innerHTML = '<div class="lui-notice success">'+iconSvg('i-check-circle')+'<div class="n-body"><div class="n-title">一切安好</div><div>没有生气，开开心心</div></div></div>';
            }
            
            let apStatus = a => a.status==='pass' ? '<span class="lui-tag green">已原谅</span>' : a.status==='reject' ? '<span class="lui-tag red">未原谅</span>' : '<span class="lui-tag amber">待审核</span>';
            let html = ap.map((a,idx)=>`<div class="lui-card" style="margin-bottom:10px;"><div class="lui-flex" style="gap:10px;align-items:flex-start;"><span class="lui-row-icon" style="flex-shrink:0;">${iconSvg('i-heart-crack')}</span><div style="flex:1;min-width:0;"><div class="lui-body-text">${escapeHtml(a.content)}</div><div class="lui-mini" style="margin-top:4px;">${escapeHtml(prettyName(a.fromName || a.from || ''))} · ${escapeHtml(a.time)} · ${apStatus(a)}</div></div>${((mode.enabled && mode.by===currentUser) || isAdmin) && a.status==='pending'?`<div class="lui-flex" style="gap:6px;flex-shrink:0;"><button class="lui-btn tonal sm" onclick="reviewApology('${a.id}',true)">原谅</button><button class="lui-btn subtle sm" onclick="reviewApology('${a.id}',false)">拒绝</button></div>`:''}</div></div>`).join(''); 
            document.getElementById('apologyList').innerHTML = html || '<div class="lui-empty"><div class="e-icon">'+iconSvg('i-heart-crack')+'</div><div class="e-title">暂无道歉记录</div></div>';
        }
        async function submitApology(){ 
            if (!(await requirePermission('comment'))) return;
            let content = document.getElementById('apologyInput').value.trim(); 
            if(!content) { toast('写点道歉内容~'); return; } 
            
            try {
                await sb.from('apologies').insert({
                    content: content,
                    author: currentUser,
                    author_name: currentUser,
                    status: 'pending'
                });
                // 记录提交道歉信日志
                logAction('apology_submit', { content: content.substring(0, 50) });
            } catch(e) {
                let ap = JSON.parse(localStorage.getItem('couple_apologies')||'[]');
                ap.unshift({ id:Date.now(), content:content, from:currentUser, fromName:currentUser, time:new Date().toLocaleString(), status:'pending' });
                localStorage.setItem('couple_apologies', JSON.stringify(ap));
            }
            
            toast('道歉已提交，等待TA原谅~'); 
            document.getElementById('apologyInput').value = '';
            closeAngryMask();
        }
        
        function closeAngryMask() {
            document.getElementById('angryMask').style.display = 'none';
        }
        async function reviewApology(id, pass){ 
            try {
                await sb.from('apologies').update({ status: pass ? 'pass' : 'reject' }).eq('id', id);
                // 记录审核道歉信日志
                logAction(pass ? 'apology_pass' : 'apology_reject', { apology_id: id });
                if (pass) {
                    await sb.from('angry_mode').update({ enabled: false, by: '' });
                    toast('已原谅，和好啦~');
                } else {
                    toast('未原谅，继续道歉吧~');
                }
            } catch(e) {
                let ap = JSON.parse(localStorage.getItem('couple_apologies')||'[]');
                let idx = ap.findIndex(a => a.id == id);
                if (idx >= 0) {
                    ap[idx].status = pass ? 'pass' : 'reject';
                    if(pass) localStorage.setItem('couple_angry', JSON.stringify({enabled:false, by:''}));
                    localStorage.setItem('couple_apologies', JSON.stringify(ap));
                }
            }
            loadAngryData(); 
        }
        // ========== 气泡池 ==========
        async function loadBubbleConfig(options = {}){ 
            const loadPhotos = options.loadPhotos === true;
            try {
                // photo_scope 列是新加列：SQL 未执行时回退到旧查询（photo_scope 默认 all）
                let configData = null;
                try { const r = await sb.from('bubble_config').select('id,enabled,interval,photo_scope').limit(1).maybeSingle(); if (!r.error) configData = r.data; } catch (e) {}
                if (!configData) { try { const r = await sb.from('bubble_config').select('id,enabled,interval').limit(1).maybeSingle(); if (!r.error) configData = r.data; } catch (e) {} }
                if (configData) {
                    bubbleEnabled = configData.enabled !== undefined ? configData.enabled : true;
                    bubbleIntervalSec = configData.interval || 12;
                    bubblePhotoScope = configData.photo_scope || 'all';
                }
                if (loadPhotos) {
                    // 气泡图源（隐私控制）：photo_scope 限制来源，bubble_ok=false 的照片不进气泡
                    const scope = bubblePhotoScope;
                    const pool = [];
                    const seen = new Set();
                    const addBubble = (url, id) => { if (url && !seen.has(url)) { seen.add(url); pool.push({ dataUrl: url, id: id || null }); } };
                    try { const { data: photosData } = await sb.from('bubble_photos').select('id,photo_url').limit(100); (photosData || []).forEach(p => addBubble(p.photo_url, p.id)); } catch (e) {}
                    if (scope === 'all' || scope === 'messages') {
                        try {
                            let mrows = null;
                            try { const r = await sb.from('messages').select('photo,bubble_ok').not('photo', 'is', null).limit(100); if (!r.error) mrows = r.data; } catch (e) {}
                            if (!mrows) { try { const r = await sb.from('messages').select('photo').not('photo', 'is', null).limit(100); if (!r.error) mrows = r.data; } catch (e) {} }
                            (mrows || []).forEach(m => { if (m.bubble_ok !== false) addBubble(m.photo); });
                        } catch (e) {}
                    }
                    if (scope === 'all' || scope === 'feeds') {
                        try {
                            let frows = null;
                            try { const r = await sb.from('feeds').select('medias,bubble_ok').limit(100); if (!r.error) frows = r.data; } catch (e) {}
                            if (!frows) { try { const r = await sb.from('feeds').select('medias').limit(100); if (!r.error) frows = r.data; } catch (e) {} }
                            (frows || []).forEach(f => { if (f.bubble_ok !== false) (f.medias || []).forEach(md => { if (md && md.type !== 'video' && md.data) addBubble(md.data); }); });
                        } catch (e) {}
                    }
                    floatPhotos = pool;
                }
            } catch(e) {
                let s=localStorage.getItem('couple_float_photos');
                if(s){
                    let c=JSON.parse(s);
                    floatPhotos=c.photos||[];
                    bubbleEnabled=c.enabled!==undefined?c.enabled:true;
                    bubbleIntervalSec=c.interval||12;
                }
            }
            updateToggleUI();
            const iv0 = document.getElementById('bubbleInterval'); if (iv0) iv0.value=bubbleIntervalSec;
            if (loadPhotos) renderBubblePreview();
            if(bubbleEnabled && floatPhotos.length && document.getElementById('mainPage').style.display==='block') startBubbleGenerator(); 
            else stopBubbleGenerator(); 
        }
        async function ensureBubblePhotosLoaded() {
            if (floatPhotos.length) return;
            await loadBubbleConfig({ loadPhotos: true });
        }
        async function saveBubbleConfig(){ 
            try {
                const { data } = await sb.from('bubble_config').select('id').limit(1).single();
                if (data && data.id) {
                    await sb.from('bubble_config').update({ enabled: bubbleEnabled, interval: bubbleIntervalSec }).eq('id', data.id);
                } else {
                    await sb.from('bubble_config').insert({ enabled: bubbleEnabled, interval: bubbleIntervalSec });
                }
            } catch(e) {
                localStorage.setItem('couple_float_photos',JSON.stringify({photos:floatPhotos,enabled:bubbleEnabled,interval:bubbleIntervalSec})); 
            }
        }
        function updateToggleUI(){ 
            let t=document.getElementById('bubbleToggle'); 
            if(bubbleEnabled) t.classList.add('active'); 
            else t.classList.remove('active'); 
        }
        function renderBubblePreview(){
            let c=document.getElementById('bubblePhotoList');
            if(!c) return;
            const custom = floatPhotos.filter(p => p.id);
            const autoCount = floatPhotos.length - custom.length;
            c.innerHTML='<div style="width:100%;font-size:12px;color:var(--ink-3);margin-bottom:6px;line-height:1.6;">自动从留言板/相册播放 ' + autoCount + ' 张；下面是你额外上传的专属气泡照片。</div>';
            if (!custom.length) {
                c.innerHTML += '<div style="width:100%;font-size:12px;color:#bbb;">暂无专属照片（可不传，气泡默认用留言板和相册里的照片）。</div>';
                return;
            }
            custom.forEach((p)=>{
                const idx = floatPhotos.indexOf(p);
                let d=document.createElement('div');
                d.className='preview-item';
                d.innerHTML=`<img src="${imgProxy(p.dataUrl)}" loading="lazy" decoding="async" referrerpolicy="no-referrer"><span class="remove-photo" data-idx="${idx}">&times;</span>`;
                d.querySelector('.remove-photo').onclick=async ()=>{
                    try {
                        if (p.id) await sb.from('bubble_photos').delete().eq('id', p.id);
                    } catch(e) {}
                    floatPhotos.splice(idx,1);
                    renderBubblePreview();
                    saveBubbleConfig();
                    if(bubbleEnabled) restartBubbleGenerator();
                };
                c.appendChild(d);
            });
        }
        async function addPhotosToBubble(files){ 
            if (!(await requirePermission('full'))) return;
            for(let f of Array.from(files)) {
                let url = await uploadToBucket(f, 'bubbles');
                if (url) {
                    try {
                        await sb.from('bubble_photos').insert({ photo_url: url, author: currentUser });
                    } catch(e) {}
                }
            }
            loadBubbleConfig({ loadPhotos: true });
        }
        async function saveBubbleSettings(){ 
            if (!(await requirePermission('full'))) return;
            bubbleEnabled=document.getElementById('bubbleToggle').classList.contains('active'); 
            bubbleIntervalSec=parseInt(document.getElementById('bubbleInterval').value)||12; 
            await saveBubbleConfig(); 
            renderBubblePreview(); 
            if(bubbleEnabled && floatPhotos.length) restartBubbleGenerator(); 
            else { stopBubbleGenerator(); clearAllDreamBubbles(); } 
            closeBubbleSettings(); 
            toast('背景气泡已保存，双方共享~'); 
        }
        function closeBubbleSettings(){ document.getElementById('bubbleSettingsModal').style.display='none'; }
        
        function createDreamBubble(url){ 
            if(!bubbleEnabled||activeBubbleCount>=1) return; 
            activeBubbleCount++; 
            let b=document.createElement('img');
            b.className='photo-bubble';
            b.src=imgProxy(url);
            b.loading='lazy'; b.referrerPolicy='no-referrer';
            b.onerror=function(){ if(this.parentNode) this.remove(); activeBubbleCount=Math.max(0,activeBubbleCount-1); };
            let sides=[[2,5],[75,5],[2,60],[75,60]][Math.floor(Math.random()*4)]; 
            b.style.left=sides[0]+'%'; 
            b.style.top=sides[1]+'%'; 
            let s=90+Math.random()*60; 
            b.style.width=s+'px'; 
            b.style.height=s+'px'; 
            b.style.animation=`dreamyRotate ${20+Math.random()*15}s infinite`; 
            document.body.appendChild(b); 
            setTimeout(()=>{ 
                if(b.parentNode){ 
                    b.style.transition='opacity 2s'; 
                    b.style.opacity='0'; 
                    setTimeout(()=>{ b.remove(); activeBubbleCount--; },2000); 
                } 
            },15000+Math.random()*10000); 
        }
        function generateDreamBubble(){ 
            if(!bubbleEnabled||floatPhotos.length===0||activeBubbleCount>=1) return; 
            let r=floatPhotos[Math.floor(Math.random()*floatPhotos.length)]; 
            if(r) createDreamBubble(r.dataUrl || r); 
        }
        function startBubbleGenerator(){ 
            if(bubbleTimer) clearInterval(bubbleTimer); 
            if(bubbleEnabled && floatPhotos.length) { 
                bubbleTimer=setInterval(generateDreamBubble,bubbleIntervalSec*1000); 
                setTimeout(generateDreamBubble,3000); 
            } 
        }
        function stopBubbleGenerator(){ 
            if(bubbleTimer) clearInterval(bubbleTimer); 
            bubbleTimer=null; 
        }
        function clearAllDreamBubbles(){ 
            document.querySelectorAll('.photo-bubble').forEach(el=>el.remove()); 
            activeBubbleCount=0; 
        }
        function restartBubbleGenerator(){ 
            stopBubbleGenerator(); 
            clearAllDreamBubbles(); 
            startBubbleGenerator(); 
        }
        // ========== 本地数据缓存机制（秒开加速） ==========
        // 缓存数据到 localStorage，下次登录直接显示，再异步更新
        function saveToCache(key, data) {
            try {
                localStorage.setItem('cache_' + key, JSON.stringify({
                    data: data,
                    time: Date.now()
                }));
            } catch(e) {}
        }
        
        function loadFromCache(key, maxAge = 7 * 24 * 60 * 60 * 1000) {
            try {
                let cached = localStorage.getItem('cache_' + key);
                if (!cached) return null;
                let parsed = JSON.parse(cached);
                if (Date.now() - parsed.time > maxAge) return null;
                return parsed.data;
            } catch(e) {
                return null;
            }
        }
        
        // ========== 在线会话保活机制 ==========
        const SESSION_TIMEOUT = 60 * 60 * 1000; 
        let heartbeatInterval = null;
        let lastActivityWrite = 0;
        
        async function updateActivity() {
            if (!currentUser) return;
            localStorage.setItem('last_activity', Date.now().toString());
            if (Date.now() - lastActivityWrite < ONLINE_STATUS_INTERVAL_MS) return;
            lastActivityWrite = Date.now();
            try { await accountApi('updateActivity'); } catch(e) {}
        }
        
        function startHeartbeat() {
            updateActivity();
            if (heartbeatInterval) clearInterval(heartbeatInterval);
            heartbeatInterval = setInterval(updateActivity, ONLINE_STATUS_INTERVAL_MS);
        }
        
        function stopHeartbeat() {
            if (heartbeatInterval) {
                clearInterval(heartbeatInterval);
                heartbeatInterval = null;
            }
            if (onlineStatusTimer) {
                clearInterval(onlineStatusTimer);
                onlineStatusTimer = null;
            }
        }
        
        function checkSessionTimeout() {
            const lastActivity = localStorage.getItem('last_activity');
            if (lastActivity && Date.now() - parseInt(lastActivity) > SESSION_TIMEOUT) {
                logout();
                toast('会话已超时，请重新登录');
                return true;
            }
            updateActivity();
            return false;
        }
        
        document.addEventListener('click', updateActivity, { passive: true });
        document.addEventListener('keypress', updateActivity);
        document.addEventListener('scroll', updateActivity, { passive: true });
        
        async function updateOnlineStatus() {
            if (!currentUser || currentUser === 'admin') return;
            try {
                const { user: otherUser } = await accountApi('onlineStatus');
                if (!otherUser) return;
                
                const lastActive = otherUser.last_active ? new Date(otherUser.last_active) : null;
                if (!lastActive) {
                    const statusEl = document.getElementById('onlineStatus');
                    if (statusEl) statusEl.innerHTML = '';
                    return;
                }
                
                const now = new Date();
                const diffSec = Math.floor((now - lastActive) / 1000); 
                
                let statusText, statusColor;
                if (diffSec < 30) {
                    statusText = '在线';
                    statusColor = '#52c41a';
                } else if (diffSec < 300) {
                    statusText = `${Math.floor(diffSec / 60)}分钟前`;
                    statusColor = '#faad14';
                } else {
                    statusText = '离线';
                    statusColor = '#ff4757';
                }
                
                const statusEl = document.getElementById('onlineStatus');
                if (statusEl) {
                    statusEl.innerHTML = `<span class="lui-mini"><span class="lui-status-dot ${online?'green':''}"></span> ${statusText}</span>`;
                }
            } catch(e) {}
        }
        
        // ========== 后台管理模块 ==========
        // ===== 后台分区 Tab 框架（重设计：概览/用户/内容/回收站/日志/设置） =====
        var ADMIN_TABS = [
            { key: 'monitor', label: '监控', icon: 'i-gauge' },
            { key: 'security', label: '安全', icon: 'i-shield-check' },
            { key: 'users', label: '用户', icon: 'i-users' },
            { key: 'content', label: '内容', icon: 'i-grid' },
            { key: 'trash', label: '回收站', icon: 'i-trash', badge: true },
            { key: 'logs', label: '日志', icon: 'i-clipboard' },
            { key: 'settings', label: '设置', icon: 'i-settings' }
        ];
        window.__adminTab = 'monitor';
        window.__adminUsers = null;
        window.__adminTrashCount = 0;

        function adminTabsHtml() {
            return ADMIN_TABS.map(function (t) {
                const badge = (t.badge && window.__adminTrashCount > 0) ? '<span class="lui-badge">' + window.__adminTrashCount + '</span>' : '';
                return '<button class="tab ' + (window.__adminTab === t.key ? 'active' : '') + '" onclick="switchAdminTab(\'' + t.key + '\')">' + iconSvg(t.icon) + '<span class="t-label">' + t.label + '</span>' + badge + '</button>';
            }).join('');
        }
        function refreshTrashBadge() {
            const tabsEl = document.getElementById('adminTabs');
            if (tabsEl) tabsEl.innerHTML = adminTabsHtml();
        }
        function switchAdminTab(key) {
            window.__adminTab = key;
            refreshTrashBadge();
            renderAdminTabBody();
        }

        async function renderAdminData() {
            const adminContent = document.getElementById('adminContent');
            const tabsEl = document.getElementById('adminTabs');
            if (adminContent) adminContent.innerHTML = '<div class="adm-loading">后台正在加载…</div>';
            let users = {};
            try {
                users = await loadUserData({ includeAll: true, allowLocalFallback: false }) || {};
                window.__adminUsers = users;
            } catch (e) {
                if (adminContent) adminContent.innerHTML = '<div class="adm-card" style="color:#c00;line-height:1.7;">后台加载失败：' + escapeHtml(e.message || String(e)) + '<br>请刷新后重试，或确认 Supabase 表字段已执行最新 SQL。</div>';
                return;
            }
            if (tabsEl) tabsEl.innerHTML = adminTabsHtml();
            renderAdminTabBody();
            trashApi('list').then(function (res) {
                window.__adminTrashCount = (res.items || []).length;
                refreshTrashBadge();
                const hn = document.getElementById('homeTrashNum');
                if (hn) hn.textContent = window.__adminTrashCount;
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
                if (min < 60) return min + ' 分钟前活跃';
                const hr = Math.floor(min / 60);
                if (hr < 24) return hr + ' 小时前活跃';
                return d.toLocaleDateString() + ' 活跃';
            } catch (e) { return ''; }
        }
        // 在线判定以最近活跃时间为准（5 分钟内），不依赖可能不复位的 is_online 布尔
        function isUserOnlineNow(info) {
            if (!info || !info.last_active) return false;
            try { return (Date.now() - new Date(info.last_active).getTime()) < 5 * 60 * 1000; } catch (e) { return false; }
        }
        // ========== 监控 tab（GET /api/monitor） ==========
        // ========== 监控 tab（GET /api/monitor，顶层无包装层） ==========
        function fmtSizeMb(mb) {
            if (mb == null || isNaN(mb)) return '—';
            if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB';
            if (mb >= 1) return Number(mb.toFixed(2)) + ' MB';
            return Math.round(mb * 1024) + ' KB';
        }
        function fmtTime(iso) {
            if (!iso) return '—';
            try { return new Date(iso).toLocaleString(); } catch (e) { return '—'; }
        }
        // 审计展示：管理员账号名脱敏；details 原始 JSON 压成可读短语
        function auditUserName(name) {
            const s = String(name || '');
            return /^admin$/i.test(s) ? '超管' : s;
        }
        var AUDIT_ACTION_LABELS = { login: '登录', logout: '登出', '用户登录': '登录', '用户登出': '登出', update_avatar: '更换头像', publish_feed: '发布动态', publish_message: '发布留言', like_feed: '点赞动态', like_message: '点赞留言', unlike_feed: '取消点赞', unlike_message: '取消点赞' };
        function auditActionText(a) { return AUDIT_ACTION_LABELS[a] || a; }
        function auditDetailText(details) {
            if (details == null || details === '') return '';
            var obj = null;
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
        function scoreRingHtml(score) {
            if (score == null || isNaN(score)) return '<div class="lui-score-ring"><svg viewBox="0 0 80 80"><circle cx="40" cy="40" r="34" class="r-bg"/><circle cx="40" cy="40" r="34" class="r-fg" stroke-dasharray="213.6" stroke-dashoffset="213.6"/></svg><div class="r-center"><div class="r-num" style="color:var(--ink-3);">—</div><div class="r-grade">安全评分</div></div></div>';
            const off = ((100 - score) / 100 * 213.6).toFixed(1);
            return '<div class="lui-score-ring"><svg viewBox="0 0 80 80"><circle cx="40" cy="40" r="34" class="r-bg"/><circle cx="40" cy="40" r="34" class="r-fg" stroke-dasharray="213.6" stroke-dashoffset="' + off + '"/></svg><div class="r-center"><div class="r-num">' + score + '</div><div class="r-grade">安全评分</div></div></div>';
        }
        function statCard(icon, label, val) {
            const v = (val == null || isNaN(val)) ? '—' : String(val);
            return '<div class="lui-stat"><div class="s-k">' + iconSvg(icon) + ' ' + escapeHtml(label) + '</div><div class="s-v">' + v + '</div></div>';
        }
        async function fetchMonitorData() {
            try {
                const res = await fetch('/api/monitor', { headers: { 'X-Couple-Token': localStorage.getItem('couple_session_token') || '' } });
                if (res.status === 401 || res.status === 403) { toast('未登录或无管理员权限', 'error'); return null; }
                if (!res.ok) return null;
                return await res.json();
            } catch (e) { return null; }
        }
        async function fetchSecurityData() {
            try {
                const res = await fetch('/api/security-scan', { headers: { 'X-Couple-Token': localStorage.getItem('couple_session_token') || '' } });
                if (res.status === 401 || res.status === 403) { toast('未登录或无管理员权限', 'error'); return null; }
                if (!res.ok) return null;
                return await res.json();
            } catch (e) { return null; }
        }
        window.__monitorTimer = null;
        function startMonitorAuto() {
            stopMonitorAuto();
            window.__monitorTimer = setInterval(function () {
                if (window.__adminTab !== 'monitor') { stopMonitorAuto(); return; }
                refreshMonitor();
            }, 60000);
        }
        function stopMonitorAuto() {
            if (window.__monitorTimer) { clearInterval(window.__monitorTimer); window.__monitorTimer = null; }
        }
        async function refreshMonitor() {
            if (window.__adminTab !== 'monitor') return;
            const el = document.getElementById('adminContent');
            if (el) await renderMonitorTab(el);
        }
        function setupStepsBlock(head, steps) {
            if (!steps) return '';
            return '<details style="margin-top:8px;"><summary class="lui-mini" style="cursor:pointer;">' + escapeHtml(head) + '</summary><pre style="white-space:pre-wrap;font-size:var(--f-mini);color:var(--ink-2);background:var(--soft);border-radius:var(--r-sm);padding:10px;margin:8px 0 0;line-height:1.6;">' + escapeHtml(steps) + '</pre></details>';
        }
        async function renderMonitorTab(el) {
            el.innerHTML = '<div class="lui-card"><div class="lui-empty"><div class="e-icon"><div class="lui-spinner lg"></div></div><div class="e-title">正在加载站点监控…</div></div></div>';
            const data = await fetchMonitorData();
            if (!data) {
                el.innerHTML = '<div class="lui-notice warn">' + iconSvg('i-alert') + '<div class="n-body"><div class="n-title">监控服务暂不可用</div><div>GET /api/monitor 网络错误或未授权，请检查登录态后重试。</div></div></div>'
                    + '<div style="margin-top:10px;"><button class="lui-btn tonal block" onclick="refreshMonitor()">重试</button></div>';
                return;
            }
            const site = data.site || {};
            const counts = site.counts || {};
            const sec = data.security || {};
            const onlineRows = (site.usersOnline || []).map(function (u) {
                return '<span class="lui-mini"><span class="lui-status-dot green"></span> ' + escapeHtml(auditUserName(prettyName(u.username))) + (u.lastSeenMinAgo == null ? '' : ' ' + u.lastSeenMinAgo + ' 分钟前') + '</span>';
            }).join('');
            el.innerHTML =
                '<div class="lui-card hero" style="display:flex;justify-content:space-between;align-items:center;gap:14px;padding:20px;">'
                + '<div style="min-width:0;"><div class="h-title" style="margin-bottom:6px;">网站总览</div><div class="h-sub" style="margin-bottom:10px;">v' + escapeHtml(site.version || '—') + ' · ' + fmtTime(site.serverTime) + '</div>'
                + '<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;">' + (onlineRows || '<span class="lui-mini">当前无在线用户</span>') + '</div>'
                + '<div class="lui-mini" style="margin-top:6px;color:var(--ink-3);">' + escapeHtml(site.usersOnlineNote || '') + '</div></div>'
                + '<div style="flex-shrink:0;text-align:center;">' + scoreRingHtml(sec.score) + '</div></div>'
                + '<div class="lui-between" style="margin:16px 0 10px;"><h3 class="lui-title" style="margin:0;">运行统计</h3>'
                + '<button class="lui-btn tonal sm" onclick="refreshMonitor()">' + iconSvg('i-refresh') + ' 刷新</button></div>'
                + '<div class="lui-stat-grid">'
                + statCard('i-message', '留言', counts.messages) + statCard('i-photo', '相册动态', counts.feeds)
                + statCard('i-heart', '感动', counts.loves) + statCard('i-sparkles', '回忆', counts.memories)
                + statCard('i-check-square', '待办', counts.memos) + statCard('i-calendar', '行程', counts.schedules)
                + statCard('i-gift', '纪念日', counts.countdowns) + statCard('i-map-pin', '地图标记', counts.travelMarkers)
                + statCard('i-users', '用户', counts.users) + statCard('i-bubble', '气泡照片', counts.bubblePhotos)
                + statCard('i-photo', '已上传图片', counts.images)
                + '</div>'
                + githubCardHtml(data.github) + supabaseCardHtml(data.supabase) + auditCardHtml(data.access) + securityMiniCardHtml(sec);
            startMonitorAuto();
        }
        function githubCardHtml(g) {
            const head = '<div class="lui-between" style="margin:16px 0 10px;"><h3 class="lui-title" style="margin:0;">' + iconSvg('i-github') + ' GitHub 仓库</h3></div>';
            if (!g || g.configured === false || g.error) {
                return '<div class="lui-card">' + head + '<div class="lui-notice warn">' + iconSvg('i-alert') + '<div class="n-body"><div class="n-title">GitHub 图床未配置</div><div>' + escapeHtml((g && g.error) || '未配置 GITHUB_TOKEN') + '</div></div></div>'
                    + setupStepsBlock('查看配置步骤', g && g.setupSteps) + '</div>';
            }
            const rows = (g.repos || []).map(function (r) {
                const isMain = !!r.recentCommits;
                let sub = '大小 ' + fmtSizeMb(r.sizeKb != null ? r.sizeKb / 1024 : null);
                if (!isMain) {
                    sub += ' · 图片 ' + (r.imageCount == null ? '—' : r.imageCount) + ' 张';
                } else {
                    sub += ' · 共 ' + (r.commitCount == null ? '—' : r.commitCount) + ' 次提交';
                }
                let html = '<div class="lui-list-row"><div class="lui-row-main">'
                    + '<div class="lui-row-title">' + iconSvg('i-github') + ' ' + escapeHtml(r.name || '—') + (r.private ? ' <span class="lui-tag rose">私有</span>' : '') + '</div>'
                    + '<div class="lui-row-sub">' + sub + '</div>';
                if (isMain && r.recentCommits && r.recentCommits.length) {
                    html += r.recentCommits.slice(0, 3).map(function (c) {
                        return '<div class="lui-row-sub">' + iconSvg('i-history') + ' ' + escapeHtml((c.message || '').slice(0, 50)) + ' <span style="color:var(--ink-3);">' + escapeHtml(c.sha || '') + '</span></div>';
                    }).join('');
                }
                if (isMain && r.actionsRuns && r.actionsRuns.length) {
                    const run = r.actionsRuns[0];
                    const ok = run.conclusion === 'success';
                    html += '<div class="lui-row-sub">' + iconSvg(ok ? 'i-check-circle' : 'i-x-circle') + ' ' + escapeHtml(run.name || 'Actions') + '：' + (ok ? '最近一次成功' : escapeHtml(run.conclusion || run.status || '未知')) + '</div>';
                }
                if (r.error) html += '<div class="lui-row-sub" style="color:var(--red);">' + escapeHtml(r.error) + '</div>';
                return html + '</div></div>';
            }).join('') || '<div class="lui-mini" style="text-align:center;padding:10px;">暂无仓库数据</div>';
            return '<div class="lui-card">' + head + '<div class="lui-list" style="box-shadow:none;border:none;">' + rows + '</div></div>';
        }
        function supabaseCardHtml(s) {
            const head = '<div class="lui-between" style="margin:16px 0 10px;"><h3 class="lui-title" style="margin:0;">' + iconSvg('i-database') + ' Supabase</h3>'
                + '<span class="lui-tag ' + ((s && s.health && s.health.status === 'ok') ? 'green' : 'red') + '">' + escapeHtml((s && s.health && s.health.status) || '—') + '</span></div>';
            if (!s) return '<div class="lui-card">' + head + '<div class="lui-mini">—</div></div>';
            const sizes = s.tableSizes || [];
            const maxMb = sizes.reduce(function (a, t) { return Math.max(a, t.totalSizeMb || 0); }, 0);
            // 表太多时只展示 Top 8 大表，其余合并，避免手机端密集重叠
            const sorted = sizes.slice().sort(function (a, b) { return (b.totalSizeMb || 0) - (a.totalSizeMb || 0); });
            const topSizes = sorted.slice(0, 8);
            const restSizes = sorted.slice(8);
            const showSizes = restSizes.length ? topSizes.concat([{ table: '其他 ' + restSizes.length + ' 表', totalSizeMb: restSizes.reduce(function (s2, t) { return s2 + (t.totalSizeMb || 0); }, 0), rowsEstimate: restSizes.reduce(function (s2, t) { return s2 + (t.rowsEstimate || 0); }, 0) }]) : topSizes;
            const bars = showSizes.map(function (t) {
                const pct = maxMb ? Math.min(100, Math.round((t.totalSizeMb || 0) / maxMb * 100)) : 0;
                return '<div style="margin-bottom:10px;"><div class="lui-mini" style="display:flex;justify-content:space-between;margin-bottom:4px;"><span>' + escapeHtml(t.table || '—') + '</span><span>' + fmtSizeMb(t.totalSizeMb) + (t.rowsEstimate ? ' · ' + t.rowsEstimate + ' 行' : '') + '</span></div><div class="lui-progress"><i style="width:' + pct + '%"></i></div></div>';
            }).join('');
            const mgmt = s.management || {};
            const proj = mgmt.project || {};
            let mgmtTags = '';
            if (mgmt.configured && (proj.name || proj.region || mgmt.plan || proj.status || proj.createdAt)) {
                mgmtTags = '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;">'
                    + (proj.name ? '<span class="lui-tag">项目 ' + escapeHtml(proj.name) + '</span>' : '')
                    + (proj.region ? '<span class="lui-tag">地域 ' + escapeHtml(proj.region) + '</span>' : '')
                    + (mgmt.plan ? '<span class="lui-tag">套餐 ' + escapeHtml(mgmt.plan) + '</span>' : '')
                    + (proj.status ? '<span class="lui-tag">状态 ' + escapeHtml(proj.status) + '</span>' : '')
                    + (proj.createdAt ? '<span class="lui-tag">创建 ' + escapeHtml(String(proj.createdAt).slice(0, 10)) + '</span>' : '')
                    + '</div>';
            }
            if (mgmt.error) mgmtTags += '<div class="lui-notice warn" style="margin-bottom:8px;">' + escapeHtml(mgmt.error) + '</div>';
            return '<div class="lui-card">' + head
                + '<div class="lui-stat-grid" style="margin-bottom:12px;">'
                + '<div class="lui-stat"><div class="s-v">' + (s.health ? (s.health.db ? '已连通' : '未连通') : '—') + '</div><div class="s-k">数据库连接</div></div>'
                + '<div class="lui-stat"><div class="s-v">' + (s.dbSizeMb != null ? fmtSizeMb(s.dbSizeMb) : '—') + '</div><div class="s-k">数据库体积</div></div>'
                + '<div class="lui-stat"><div class="s-v">' + (mgmt.configured ? '已配置' : '未配置') + '</div><div class="s-k">出站流量</div></div>'
                + '</div>'
                + mgmtTags
                + (bars || '<div class="lui-mini">暂无表体积数据（需在 Supabase SQL Editor 执行一次 sql/monitoring_rpcs.sql）</div>')
                + setupStepsBlock('查看配置步骤', mgmt.setupSteps)
                + '</div>';
        }
        function auditCardHtml(a) {
            const head = '<div class="lui-between" style="margin:16px 0 10px;"><h3 class="lui-title" style="margin:0;">' + iconSvg('i-activity') + ' 访问审计</h3></div>';
            if (!a) return '<div class="lui-card">' + head + '<div class="lui-mini">—</div></div>';
            const day7 = a.day7 || [];
            const maxCount = day7.reduce(function (m, d) { return Math.max(m, d.count || 0); }, 0);
            const bars = day7.map(function (d) {
                const pct = maxCount ? Math.round((d.count || 0) / maxCount * 100) : 0;
                return '<div class="bar" style="height:' + Math.max(4, pct) + '%" data-label="' + escapeHtml(String(d.date || '—').slice(5)) + '" title="' + (d.count || 0) + ' 次"></div>';
            }).join('');
            const recent = (a.recent || []).slice(0, 10).map(function (r) {
                const det = auditDetailText(r.details);
                return '<div class="lui-list-row"><div class="lui-row-main">'
                    + '<div class="lui-row-title">' + iconSvg('i-user') + ' ' + escapeHtml(auditUserName(r.user || '—'))
                    + ' <span class="lui-mini" style="color:var(--ink-3);">' + escapeHtml(fmtTime(r.createdAt)) + '</span></div>'
                    + '<div class="lui-row-sub">' + escapeHtml(auditActionText(r.action || '—')) + (det ? ' · ' + escapeHtml(det) : '') + '</div></div></div>';
            }).join('');
            return '<div class="lui-card">' + head
                + (bars ? '<div class="lui-label">近 7 天访问量</div><div class="lui-bars" style="margin-bottom:22px;">' + bars + '</div>' : '<div class="lui-mini" style="margin-bottom:8px;">近 7 天暂无数据</div>')
                + (recent ? '<div class="lui-label">最近访问</div><div class="lui-list" style="box-shadow:none;border:none;">' + recent + '</div>' : '<div class="lui-mini">暂无访问记录</div>')
                + '</div>';
        }
        function securityMiniCardHtml(sec) {
            return '<div class="lui-card" style="display:flex;align-items:center;gap:14px;">'
                + '<div style="flex-shrink:0;">' + scoreRingHtml(sec.score != null ? sec.score : null) + '</div>'
                + '<div style="flex:1;min-width:0;"><div class="lui-body-text" style="font-weight:650;margin-bottom:6px;">安全状况</div>'
                + '<div class="lui-mini">高风险 ' + (sec.high || 0) + ' · 中风险 ' + (sec.medium || 0) + ' · 低风险 ' + (sec.low || 0) + '</div>'
                + '<div class="lui-mini">上次扫描 ' + fmtTime(sec.lastScanAt) + '</div></div>'
                + '<button class="lui-btn tonal sm" onclick="switchAdminTab(\'security\')">前往安全</button></div>';
        }
        // ========== 安全 tab（GET/POST /api/security-scan） ==========
        function securityCheckRow(c) {
            const st = c.status === 'pass' ? 'pass' : c.status === 'fail' ? 'fail' : c.status === 'warn' ? 'warn' : 'unknown';
            const icon = c.status === 'pass' ? 'i-check-circle' : c.status === 'fail' ? 'i-x-circle' : c.status === 'warn' ? 'i-alert' : 'i-clock';
            const sevTag = (st !== 'pass' && c.severity === 'high') ? '<span class="lui-tag red">高</span>'
                : (st !== 'pass' && c.severity === 'medium') ? '<span class="lui-tag amber">中</span>'
                : (st !== 'pass' && c.severity === 'low') ? '<span class="lui-tag">低</span>' : '';
            return '<div class="lui-check"><div class="c-status ' + st + '">' + iconSvg(icon) + '</div>'
                + '<div class="c-body"><div class="c-title">' + escapeHtml(c.title || '—') + '</div>'
                + '<div class="c-detail">' + escapeHtml(c.detail || '') + '</div>'
                + (c.fix ? '<div class="c-fix">' + escapeHtml(c.fix) + '</div>' : '') + '</div>'
                + sevTag + '</div>';
        }
        function securityReportHtml(report) {
            if (!report) {
                return '<div class="lui-empty"><div class="e-icon">' + iconSvg('i-shield-check') + '</div><div class="e-title">暂无安全报告</div><div class="e-text">点「立即扫描」生成第一份安全报告</div></div>';
            }
            const s = report.summary || {};
            const groups = {};
            (report.checks || []).forEach(function (c) {
                const cat = c.category || '其它';
                (groups[cat] = groups[cat] || []).push(c);
            });
            return '<div class="lui-stat-grid" style="margin:14px 0;">'
                + '<div class="lui-stat"><div class="s-v" style="color:var(--green);">' + (s.passes || 0) + '</div><div class="s-k">通过</div></div>'
                + '<div class="lui-stat"><div class="s-v" style="color:var(--red);">' + (s.high || 0) + '</div><div class="s-k">高风险</div></div>'
                + '<div class="lui-stat"><div class="s-v" style="color:var(--amber);">' + (s.medium || 0) + '</div><div class="s-k">中风险</div></div>'
                + '<div class="lui-stat"><div class="s-v">' + (s.low || 0) + '</div><div class="s-k">低风险</div></div>'
                + '</div>'
                + Object.keys(groups).map(function (cat) {
                    return '<div class="lui-card"><h3 class="lui-title" style="margin-bottom:10px;">' + escapeHtml(cat) + '</h3>'
                        + groups[cat].map(securityCheckRow).join('') + '</div>';
                }).join('');
        }
        async function renderSecurityTab(el) {
            el.innerHTML = '<div class="lui-card"><div class="lui-empty"><div class="e-icon"><div class="lui-spinner lg"></div></div><div class="e-title">正在加载安全扫描…</div></div></div>';
            const data = await fetchSecurityData();
            if (!data) {
                el.innerHTML = '<div class="lui-notice warn">' + iconSvg('i-alert') + '<div class="n-body"><div class="n-title">安全扫描服务暂不可用</div><div>GET /api/security-scan 网络错误或未授权。</div></div></div>'
                    + '<div style="margin-top:10px;"><button class="lui-btn tonal block" onclick="renderSecurityTab(document.getElementById(\'adminContent\'))">重试</button></div>';
                return;
            }
            const report = data.report || null;
            const s = (report && report.summary) || {};
            el.innerHTML =
                '<div class="lui-card" style="display:flex;align-items:center;gap:14px;">'
                + '<div style="flex-shrink:0;">' + scoreRingHtml(s.score != null ? s.score : null) + '</div>'
                + '<div style="flex:1;min-width:0;"><div class="lui-body-text" style="font-weight:650;">' + escapeHtml(s.grade || '—') + '</div>'
                + '<div class="lui-mini">上次扫描 ' + fmtTime(report ? report.generatedAt : (data.lastScanAt || null)) + '</div></div>'
                + '<button class="lui-btn primary sm" id="securityScanBtn" onclick="runSecurityScan()">' + iconSvg('i-scan') + ' 立即扫描</button></div>'
                + securityReportHtml(report)
                + '<div class="lui-mini" style="text-align:center;padding:12px 0;color:var(--ink-3);">每 2 天（北京时间约 11:00）由 GitHub Actions 自动扫描，本页也可手动触发；历史报告在仓库 docs/security-reports/</div>';
        }
        async function runSecurityScan() {
            const btn = document.getElementById('securityScanBtn');
            if (btn) { btn.disabled = true; btn.innerHTML = '<div class="lui-spinner sm"></div> 正在全面检查，约需 30–60 秒'; }
            try {
                const res = await fetch('/api/security-scan', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Couple-Token': localStorage.getItem('couple_session_token') || '' },
                    body: JSON.stringify({ action: 'run' })
                });
                if (res.status === 401 || res.status === 403) { toast('未登录或无管理员权限', 'error'); return; }
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const out = await res.json();
                toast('扫描完成，已更新安全评分', 'success');
                const el = document.getElementById('adminContent');
                if (el && out.report) {
                    // POST 直接返回 report，按安全 tab 结构渲染（复用 fetchSecurityData 外壳数据）
                    el.innerHTML = securityTabHtmlFromReport(out.report, out.status);
                    return;
                }
            } catch (e) { toast('扫描失败：' + e.message, 'error'); }
            finally { if (btn) btn.disabled = false; }
            const el = document.getElementById('adminContent');
            if (el) await renderSecurityTab(el);
        }
        function securityTabHtmlFromReport(report, status) {
            const s = (report && report.summary) || {};
            return '<div class="lui-card" style="display:flex;align-items:center;gap:14px;">'
                + '<div style="flex-shrink:0;">' + scoreRingHtml(s.score != null ? s.score : null) + '</div>'
                + '<div style="flex:1;min-width:0;"><div class="lui-body-text" style="font-weight:650;">' + escapeHtml(s.grade || '—') + '</div>'
                + '<div class="lui-mini">上次扫描 ' + fmtTime(report ? report.generatedAt : null) + '</div></div>'
                + '<button class="lui-btn primary sm" id="securityScanBtn" onclick="runSecurityScan()">' + iconSvg('i-scan') + ' 立即扫描</button></div>'
                + securityReportHtml(report)
                + '<div class="lui-mini" style="text-align:center;padding:12px 0;color:var(--ink-3);">每 2 天（北京时间约 11:00）由 GitHub Actions 自动扫描，本页也可手动触发；历史报告在仓库 docs/security-reports/</div>';
        }

        async function loadAdminStats() {
            const counts = {};
            await Promise.all(ADMIN_STAT_TABLES.map(async function (p) {
                let n = 0;
                try {
                    const { data, error } = await sb.from(p[0]).select('id').is('deleted_at', null).limit(500);
                    if (!error) n = data ? data.length : 0;
                } catch (e) { n = 0; }
                counts[p[0]] = n;
                const el = document.getElementById('stat_' + p[0]);
                if (el) el.textContent = n;
            }));
            let total = 0;
            Object.values(counts).forEach(function (v) { total += v; });
            const te = document.getElementById('statTotal');
            if (te) te.textContent = total;
        }

        function renderAdminUsers(el) {
            const users = window.__adminUsers || {};
            const permLabels = { full: '完全权限', comment: '仅评论', view: '仅浏览' };
            let cards = '';
            for (const [uname, info] of Object.entries(users)) {
                const isAdm = uname === 'admin' || info.role === 'admin';
                const permission = info.permission || 'full';
                const initial = (uname[0] || '?');
                const onlineTxt = '<span class="lui-mini"><span class="lui-status-dot ' + (isUserOnlineNow(info) ? 'green' : '') + '"></span> ' + (isUserOnlineNow(info) ? '在线' : (fmtLastActive(info.last_active) || '离线')) + '</span>';
                const permTxt = isAdm ? '权限不受限制' : ('权限：' + (permLabels[permission] || permLabels.full));
                cards += '<div class="adm-card adm-user">'
                    + '<div class="adm-user-head"><div class="adm-user-ava">' + escapeHtml(initial.toUpperCase()) + '</div>'
                    + '<div><div class="adm-user-name">' + escapeHtml(uname) + '<span class="adm-role-tag ' + (isAdm ? 'admin' : 'user') + '">' + (isAdm ? '管理员' : '普通用户') + '</span></div>'
                    + '<div class="adm-user-meta">' + permTxt + ' · ' + onlineTxt + '</div></div></div>'
                    + '<div class="adm-user-actions">'
                    + '<button class="adm-ua-btn blue" onclick="openSetUserPasswordModal(\'' + uname + '\')">' + iconSvg('i-key') + ' 设置密码</button>'
                    + (uname === 'admin' ? '' : '<button class="adm-ua-btn green" onclick="toggleUserRole(\'' + uname + '\')">' + (isAdm ? '取消管理员' : '设为管理员') + '</button>')
                    + (!isAdm ? '<div class="adm-perm"><select onchange="setUserPermission(\'' + uname + '\', this.value)">'
                        + '<option value="full" ' + (permission === 'full' ? 'selected' : '') + '>完全权限</option>'
                        + '<option value="comment" ' + (permission === 'comment' ? 'selected' : '') + '>仅评论</option>'
                        + '<option value="view" ' + (permission === 'view' ? 'selected' : '') + '>仅浏览</option></select></div>' : '')
                    + (!isAdm ? '<button class="adm-ua-btn red" onclick="deleteUserAccount(\'' + uname + '\')">' + iconSvg('i-trash') + ' 删除账号</button>' : '')
                    + '</div></div>';
            }
            el.innerHTML = cards || '<div class="adm-empty">暂无用户</div>';
        }

        function renderAdminContentTab(el) {
            const sections = [
                ['feed', '时光相册'], ['message', '留言板'], ['love', '感动的话'], ['memory', '一起做过的事'],
                ['memo', '待办'], ['schedule', '行程'], ['countdown', '纪念日'], ['marker', '地图']
            ];
            el.innerHTML = '<div class="adm-card"><h3>' + iconSvg('i-grid') + ' 内容管理 · 按需加载</h3>'
                + '<div class="adm-chips">' + sections.map(function (p) { return '<button class="adm-chip' + (window.__adminContentSel === p[0] ? ' active' : '') + '" onclick="adminPickChip(\'' + p[0] + '\', this)">' + p[1] + '</button>'; }).join('') + '</div>'
                + '<div id="adminContentSection" style="margin-top:14px;color:#999;font-size:14px;">' + (window.__adminContentSel ? '正在加载…' : '点上方分类，按需加载对应内容（避免一次拉取全部数据）。') + '</div></div>';
            if (window.__adminContentSel) renderAdminContentSection(window.__adminContentSel);
        }
        function adminPickChip(type, btn) {
            window.__adminContentSel = type;
            document.querySelectorAll('.adm-chip').forEach(function (c) { c.classList.remove('active'); });
            if (btn) btn.classList.add('active');
            renderAdminContentSection(type);
        }

        function renderAdminTrashTab(el) {
            el.innerHTML = '<div class="adm-card"><div id="adminTrashSection" class="adm-loading">回收站加载中…</div></div>';
            loadTrashSection().catch(function (e) {
                const t = document.getElementById('adminTrashSection');
                if (t) t.innerHTML = '<div style="color:#c00;">回收站加载失败：' + escapeHtml(e.message || String(e)) + '</div>';
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
            admin_toggle_visibility: '切换可见性', view_page: '浏览页面', switch_tab: '切换标签'
        };
        var LOG_PAGE = 50;
        function logRangeSince(range) {
            if (range === 'today') { const d = new Date(); d.setHours(0,0,0,0); return d.toISOString(); }
            if (range === '7d') return new Date(Date.now() - 7*86400000).toISOString();
            if (range === '30d') return new Date(Date.now() - 30*86400000).toISOString();
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
            if (p.target) meta.push('目标：' + p.target);
            if (p.title) meta.push('「' + p.title + '」');
            if (p.files) meta.push('附件 ' + p.files + ' 个');
            if (p.module) meta.push('模块 ' + p.module);
            if (p.error) meta.push('原因：' + p.error);
            else if (p.raw) meta.push(p.raw);
            const metaLine = meta.length ? escapeHtml(meta.join('　')) : '';
            return '<div class="adm-log-item' + (fail ? ' log-fail' : '') + '"><div class="adm-log-act">' + (fail ? '<span class="lui-tag red">失败</span> ' : '') + escapeHtml(act) + '</div>'
                + '<div class="adm-log-meta">' + new Date(log.created_at).toLocaleString() + '　' + escapeHtml(prettyName(log.user || '')) + '</div>'
                + (p.ip ? '<div class="adm-log-detail">IP ' + escapeHtml(p.ip) + (metaLine ? '　' + metaLine : '') + '</div>' : (metaLine ? '<div class="adm-log-detail">' + metaLine + '</div>' : ''))
                + (p.user_agent ? '<div class="adm-log-detail" style="color:#bbb;font-size:11px;">' + escapeHtml(shortUA(p.user_agent)) + '</div>' : '') + '</div>';
        }
        async function fetchAdminLogs(reset) {
            const f = window.__logFilter;
            if (!f || f.loading) return;
            f.loading = true;
            const box = document.getElementById('adminLogList');
            const more = document.getElementById('adminLogMore');
            if (reset) { f.items = []; f.offset = 0; f.hasMore = true; if (box) { box.className = 'adm-loading'; box.textContent = '日志加载中…'; } }
            try {
                let q = sb.from('admin_logs').select('action,user,details,created_at');
                if (f.user) q = q.eq('user', f.user);
                const since = logRangeSince(f.range);
                if (since) q = q.gte('created_at', since);
                const res = await q.order('created_at', { ascending: false }).range(f.offset, f.offset + LOG_PAGE - 1);
                const rows = res.data || [];
                f.items = f.items.concat(rows);
                f.hasMore = rows.length === LOG_PAGE;
                f.offset += rows.length;
                if (box) {
                    if (!f.items.length) { box.className = 'adm-empty'; box.textContent = '该筛选条件下暂无日志'; }
                    else { box.className = 'adm-log'; box.innerHTML = f.items.map(renderLogItem).join(''); }
                }
                if (more) more.style.display = f.hasMore ? 'block' : 'none';
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
        window.fetchAdminLogs = fetchAdminLogs;
        window.applyLogFilter = applyLogFilter;
        function renderAdminLogsTab(el) {
            window.__logFilter = { user:'', range:'all', items:[], offset:0, hasMore:true, loading:false };
            el.innerHTML = '<div class="adm-card"><h3>' + iconSvg('i-clipboard') + ' 操作日志</h3>'
                + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">'
                + '<select id="logFilterUser" style="flex:1;min-width:120px;padding:9px;border:1.5px solid #ffd1d8;border-radius:10px;font-size:14px;"><option value="">全部用户</option></select>'
                + '<select id="logFilterRange" style="flex:1;min-width:120px;padding:9px;border:1.5px solid #ffd1d8;border-radius:10px;font-size:14px;"><option value="all">全部时间</option><option value="today">今天</option><option value="7d">近 7 天</option><option value="30d">近 30 天</option></select>'
                + '<button class="adm-ua-btn blue" onclick="applyLogFilter()">筛选</button></div>'
                + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">'
                + '<button class="adm-ua-btn blue" style="flex:0 0 auto;" onclick="exportAdminLogs()">' + iconSvg('i-download') + ' 导出日志</button>'
                + '<button class="adm-ua-btn red" style="flex:0 0 auto;" onclick="clearAdminLogs()">' + iconSvg('i-trash') + ' 清空日志</button></div>'
                + '<div id="adminLogList" class="adm-loading">日志加载中…</div>'
                + '<button id="adminLogMore" class="adm-ua-btn blue" style="width:100%;margin-top:10px;display:none;" onclick="fetchAdminLogs(false)">' + iconSvg('i-chevron-down') + ' 加载更多</button></div>';
            accountApi('listUsers').then(function (r) {
                const sel = document.getElementById('logFilterUser');
                if (!sel) return;
                (r.users || []).forEach(function (u) { const o = document.createElement('option'); o.value = u.username; o.textContent = u.username; sel.appendChild(o); });
            }).catch(function () {});
            fetchAdminLogs(true);
        }

        function renderAdminSettingsTab(el) {
            el.innerHTML =
                '<div class="adm-card"><h3>' + iconSvg('i-hard-drive') + ' 相册存储模式</h3>'
                + '<div class="adm-field"><span style="color:#666;font-size:14px;">照片/视频存放方式</span>'
                + '<select id="adminStorageModeSelect" onchange="adminSetStorageMode()">'
                + '<option value="cloud">图床模式（无限容量）</option>'
                + '<option value="local">本地存储（测试用）</option></select></div>'
                + '<div style="color:#999;font-size:12px;margin-top:10px;line-height:1.7;">图床模式把图片/视频存到 GitHub 私密仓库，不占数据库流量，建议保持。</div></div>'
                + '<div class="adm-card"><h3>' + iconSvg('i-users') + ' 账号</h3>'
                + '<button class="adm-ua-btn blue" style="width:100%;" onclick="showRegisterModal()">' + iconSvg('i-plus') + ' 注册新账号</button></div>'
                + '<div class="adm-card"><h3>' + iconSvg('i-key') + ' 登录页注册通道</h3>'
                + '<div style="color:#888;font-size:13px;line-height:1.7;margin-bottom:10px;">设置邀请码后，登录页会出现"注册账号"入口，对方凭邀请码即可自助注册；清空邀请码即关闭通道。</div>'
                + '<div id="adminSignupSlot" style="color:#aaa;font-size:13px;">加载中…</div></div>'
                + '<div class="adm-card"><h3>' + iconSvg('i-bubble') + ' 梦幻背景气泡</h3>'
                + '<div style="color:#888;font-size:13px;line-height:1.7;margin-bottom:10px;">开启后，主界面角落会缓缓漂浮照片气泡，默认播放留言板和相册里的照片（无需额外上传）。</div>'
                + '<div id="adminBubbleSlot" style="color:#aaa;font-size:13px;">加载中…</div></div>'
                + '<div id="adminQqSlot"></div>';
            const sel = document.getElementById('adminStorageModeSelect');
            if (sel) sel.value = storageMode || 'cloud';
            const slot = document.getElementById('adminQqSlot');
            if (slot) slot.innerHTML = renderQqSyncPanel();
            loadSignupConfigIntoForm();
            loadBubbleConfigIntoForm();
        }

        async function loadSignupConfigIntoForm() {
            const slot = document.getElementById('adminSignupSlot');
            if (!slot) return;
            try {
                const cfg = await accountApi('getSignupCode');
                const code = cfg.code || '';
                const regOpen = !!(cfg && cfg.register_open);
                slot.innerHTML =
                    '<label style="display:flex;align-items:center;gap:8px;font-size:14px;color:#333;margin-bottom:10px;cursor:pointer;">'
                    + '<input type="checkbox" id="registerOpenToggle" ' + (regOpen ? 'checked' : '') + ' onchange="adminToggleRegisterOpen(this.checked)" style="width:18px;height:18px;accent-color:#ff6b81;">'
                    + '<span>开放注册（无需邀请码，任何人可自助注册）</span></label>'
                    + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">'
                    + '<input id="signupCodeInput" type="text" value="' + escapeHtml(code) + '" placeholder="设置邀请码，留空=关闭注册" style="flex:1;min-width:160px;padding:10px 12px;border:1.5px solid #ffd1d8;border-radius:12px;font-size:14px;' + (regOpen ? 'opacity:0.5;' : '') + '">'
                    + '<button class="adm-ua-btn blue" onclick="adminGenSignupCode()">随机生成</button>'
                    + '<button class="adm-ua-btn green" onclick="adminSaveSignupCode()">保存</button></div>'
                    + '<div id="signupCodeStatus" style="margin-top:10px;font-size:13px;line-height:1.7;">'
                    + (regOpen
                        ? '<span style="color:var(--blue);">开放注册中：登录页无需邀请码即可注册。</span>'
                        : (code
                            ? '<span style="color:var(--green);">邀请码模式：当前邀请码 <b>' + escapeHtml(code) + '</b>，登录页可自助注册。</span>'
                            : '<span style="color:var(--amber);">未开通：登录页无法注册（留空状态）。</span>')) + '</div>';
            } catch (e) { slot.innerHTML = '<span style="color:#c00;">读取失败：' + escapeHtml(e.message || String(e)) + '</span>'; }
        }
        async function adminToggleRegisterOpen(open) {
            try {
                await accountApi('setRegisterOpen', { open });
                toast(open ? '已开启开放注册' : '已关闭开放注册，恢复邀请码模式', 'success');
                await loadSignupConfigIntoForm();
            } catch (e) { toast('操作失败：' + e.message); }
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
                toast(code ? '注册通道已开通，邀请码：' + code : '已关闭登录页注册通道', 'success');
                await loadSignupConfigIntoForm();
            } catch (e) { toast('保存失败：' + e.message); }
        }
        window.adminSaveSignupCode = adminSaveSignupCode;

        async function loadBubbleConfigIntoForm() {
            const slot = document.getElementById('adminBubbleSlot');
            if (!slot) return;
            try {
                const cfg = await accountApi('getBubbleConfig');
                window.__bubbleCfg = cfg;
                renderBubbleAdminUI(cfg.enabled, cfg.interval, cfg.photo_scope);
            } catch (e) { slot.innerHTML = '<span style="color:#c00;">读取失败：' + escapeHtml(e.message || String(e)) + '</span>'; }
        }
        function renderBubbleAdminUI(enabled, interval, photoScope) {
            const slot = document.getElementById('adminBubbleSlot');
            if (!slot) return;
            const scopeLabels = { all: '全部照片（留言板+相册）', feeds: '仅相册照片', messages: '仅留言板照片', none: '不显示照片气泡' };
            const scopeOptions = ['all', 'feeds', 'messages', 'none'].map(function (s) { return '<option value="' + s + '"' + (s === (photoScope || 'all') ? ' selected' : '') + '>' + (scopeLabels[s] || s) + '</option>'; }).join('');
            slot.innerHTML =
                '<div style="margin-bottom:10px;">'
                + '<button id="bubbleAdminToggle" class="adm-ua-btn ' + (enabled ? 'green' : 'red') + '" style="width:100%;" onclick="adminToggleBubble()">' + (enabled ? '气泡已开启（点击关闭）' : '气泡已关闭（点击开启）') + '</button></div>'
                + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">'
                + '<span style="font-size:13px;color:#666;">出现间隔</span>'
                + '<input id="bubbleAdminInterval" type="number" min="3" max="120" value="' + interval + '" style="width:80px;padding:9px;border:1.5px solid #ffd1d8;border-radius:10px;font-size:14px;">'
                + '<span style="font-size:13px;color:#666;">秒（3-120）</span></div>'
                + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px;">'
                + '<span style="font-size:13px;color:#666;">照片范围</span>'
                + '<select id="bubbleAdminScope" style="flex:1;min-width:170px;padding:9px;border:1.5px solid #ffd1d8;border-radius:10px;font-size:14px;">' + scopeOptions + '</select></div>'
                + '<div style="font-size:12px;color:#999;margin:8px 0;line-height:1.7;">隐私：范围外的照片和单条被关闭气泡的照片不会漂浮显示；也可在内容管理中逐条开关。</div>'
                + '<button class="adm-ua-btn blue" onclick="adminSaveBubbleConfig()">保存</button>'
        }
        function adminToggleBubble() {
            const cfg = window.__bubbleCfg || { enabled: true, interval: 12, photo_scope: 'all' };
            cfg.enabled = !cfg.enabled;
            window.__bubbleCfg = cfg;
            renderBubbleAdminUI(cfg.enabled, cfg.interval, cfg.photo_scope);
        }
        window.adminToggleBubble = adminToggleBubble;
        async function adminSaveBubbleConfig() {
            const cfg = window.__bubbleCfg || { enabled: true, interval: 12, photo_scope: 'all' };
            const interval = parseInt(document.getElementById('bubbleAdminInterval').value, 10) || 12;
            const scopeEl = document.getElementById('bubbleAdminScope');
            const scope = scopeEl ? scopeEl.value : (cfg.photo_scope || 'all');
            try {
                const r = await accountApi('setBubbleConfig', { enabled: cfg.enabled, interval, photo_scope: scope });
                window.__bubbleCfg = { enabled: r.enabled, interval: r.interval, photo_scope: r.photo_scope };
                bubbleEnabled = r.enabled; bubbleIntervalSec = r.interval; bubblePhotoScope = r.photo_scope;
                if (r.enabled && floatPhotos.length) restartBubbleGenerator();
                else { stopBubbleGenerator(); clearAllDreamBubbles(); }
                renderBubbleAdminUI(r.enabled, r.interval, r.photo_scope);
                toast('背景气泡设置已保存', 'success');
            } catch (e) { toast('保存失败：' + e.message); }
        }
        window.adminSaveBubbleConfig = adminSaveBubbleConfig;

        // 内容条目卡片（替代旧表格，手机友好）
        function renderAdminCards(type, rows) {
            if (!rows || rows.length === 0) return '<div class="adm-empty">暂无数据</div>';
            const pl = { high: '<span class="lui-tag red">高</span>', medium: '<span class="lui-tag amber">中</span>', low: '<span class="lui-tag green">低</span>' };
            return rows.map(function (row) {
                const time = row.created_at ? new Date(row.created_at).toLocaleString() : '';
                let title = '', extra = '', del = '';
                if (type === 'feed') { title = row.description || ''; del = '<button class="adm-del-btn" onclick="deleteFeed(\'' + row.id + '\')">删除</button>'; }
                else if (type === 'message') { title = row.content || ''; del = admDelBtn('message', row.id); }
                else if (type === 'love') { title = row.content || ''; extra = row.privacy === 'private' ? '<span class="lui-tag rose">私密</span>' : '<span class="lui-tag blue">公开</span>'; del = admDelBtn('love', row.id); }
                else if (type === 'memory') { title = row.content || ''; del = admDelBtn('memory', row.id); }
                else if (type === 'memo') { title = row.content || ''; extra = (pl[row.priority] || row.priority || '') + ' · ' + (row.done ? '已完成' : '进行中'); del = admDelBtn('memo', row.id); }
                else if (type === 'schedule') { title = row.title || ''; extra = row.start_date ? (row.end_date ? row.start_date + ' ~ ' + row.end_date : row.start_date) : ''; del = admDelBtn('schedule', row.id); }
                else if (type === 'countdown') { title = row.name || ''; extra = row.target_date || ''; del = admDelBtn('countdown', row.id); }
                else if (type === 'marker') { title = row.name || ''; extra = row.description || ''; del = admDelBtn('marker', row.id); }
                const vis = renderVisibilityAdminControls(type, row.id, row.visibility);
                // 气泡隐私：feed/message 可逐条开关"是否允许进气泡"
                let bubbleCtrl = '';
                if (type === 'feed' || type === 'message') {
                    const on = row.bubble_ok !== false;
                    bubbleCtrl = '<button class="adm-ua-btn ' + (on ? 'green' : 'red') + '" style="padding:4px 8px;font-size:12px;" onclick="toggleBubbleOk(\'' + type + '\',\'' + row.id + '\',' + (on ? 'false' : 'true') + ')">' + (on ? '气泡:开' : '气泡:关') + '</button>';
                }
                return '<div class="adm-item"><div class="adm-item-text">' + escapeHtml(title || '(无文字)').substring(0, 80) + '</div>'
                    + '<div class="adm-item-meta"><span>' + escapeHtml(prettyName(row.author_name || '')) + '</span>'
                    + (extra ? '<span>' + escapeHtml(extra) + '</span>' : '')
                    + '<span>' + time + '</span></div>'
                    + '<div class="adm-item-foot"><div class="adm-vis">' + vis + '</div>' + bubbleCtrl + del + '</div></div>';
            }).join('');
        }
        function admDelBtn(type, id) {
            return '<button class="adm-del-btn" onclick="adminDelete(\'' + type + '\',\'' + id + '\')">删除</button>';
        }
        async function toggleBubbleOk(type, id, next) {
            if (!(await requireAdmin())) return;
            try {
                const table = type === 'feed' ? 'feeds' : 'messages';
                await sb.from(table).update({ bubble_ok: next }).eq('id', id);
                toast(next ? '已允许该内容进入气泡' : '已关闭该内容的气泡显示（隐私保护）', 'success');
                if (type === 'feed' || type === 'message') renderAdminContentSection(type, { skipAdminCheck: true });
            } catch (e) { toast('操作失败：' + (e.message || String(e))); }
        }
        window.toggleBubbleOk = toggleBubbleOk;

        function renderQqSyncPanel() {
            // Legacy verification keywords: 鑷姩澶囦唤鑷砆Q绌洪棿 / QQ绌洪棿鍚屾澶囦唤
            return `<div class="admin-section qq-sync-panel">
                <div class="qq-sync-hero">
                    <div>
                        <h3 class="qq-sync-title">QQ空间同步备份 <span class="badge">半自动</span></h3>
                        <div class="qq-sync-desc">只导出公开内容，已“对外隐藏”和私密内容不会进入同步包。发布文案会自动写上“自动备份至QQ空间”、发布者、原发布时间和分类。</div>
                    </div>
                    <div class="qq-sync-actions">
                        <button class="admin-btn qq-sync-primary" onclick="exportQqSyncQueue()">导出待同步内容</button>
                        <button class="admin-btn qq-sync-secondary" onclick="exportQqSyncPreview()">查看发布预览</button>
                        <button class="admin-btn qq-sync-import" onclick="document.getElementById('qqSyncResultInput').click()">导入发布结果</button>
                        <input id="qqSyncResultInput" type="file" accept="application/json,.json" style="display:none" onchange="importQqSyncResult(this.files[0]); this.value='';">
                    </div>
                </div>
                <div class="qq-sync-stats">
                    <div class="qq-sync-stat"><strong>1</strong><span>先点“导出待同步内容”，得到 待同步内容.json</span></div>
                    <div class="qq-sync-stat"><strong>2</strong><span>再双击本地 启动QQ空间同步.bat 发布</span></div>
                    <div class="qq-sync-stat"><strong>3</strong><span>最后点“导入发布结果”，成功项下次会跳过</span></div>
                </div>
                <div class="qq-sync-note">提示：第一次使用前，请先在 Supabase SQL Editor 运行 docs/supabase-qzone-sync.sql。导出时如果提示字段不存在，就是这一步还没做。</div>
            </div>`;
        }

        function getQqSyncStatusLabel(status) {
            const labels = { pending: '待同步', synced: '已同步', failed: '同步失败', skipped: '已跳过' };
            return labels[status || 'pending'] || '待同步';
        }

        function getQqSourceLabel(table) {
            const labels = { feeds: '时光相册', messages: '留言板', loves: '感动的话', memories: '一起做过的事' };
            return labels[table] || table;
        }

        function getAuthorDisplayName(row) {
            return row.author_name || (row.author === 'boy' ? 'boy' : (row.author === 'girl' ? 'girl' : (row.author || '未知')));
        }

        function formatDateTimeText(value) {
            if (!value) return '';
            try {
                const d = new Date(value);
                if (Number.isNaN(d.getTime())) return String(value);
                return d.toLocaleString('zh-CN', { hour12: false });
            } catch(e) {
                return String(value);
            }
        }

        function extractQqMediaItems(table, row) {
            const photos = [];
            const videos = [];
            if (table === 'feeds' && Array.isArray(row.medias)) {
                row.medias.forEach(media => {
                    const url = media && media.data;
                    if (!url || String(url).startsWith('data:')) return;
                    if (media.type === 'video') videos.push(url);
                    else photos.push(url);
                });
            }
            if (table === 'messages' && row.photo && !String(row.photo).startsWith('data:')) photos.push(row.photo);
            return { photos, videos };
        }

        async function collectQqSyncQueue() {
            if (!(await requireAdmin())) return [];
            const batchId = 'qzone_' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
            const configs = [
                { table: 'feeds', cols: 'id,description,medias,author,author_name,created_at,visibility,qzone_sync_status,qzone_synced_at,qzone_sync_batch_id' },
                { table: 'messages', cols: 'id,content,photo,author,author_name,created_at,visibility,qzone_sync_status,qzone_synced_at,qzone_sync_batch_id' },
                { table: 'loves', cols: 'id,content,privacy,author,author_name,created_at,visibility,qzone_sync_status,qzone_synced_at,qzone_sync_batch_id' },
                { table: 'memories', cols: 'id,content,author,author_name,created_at,visibility,qzone_sync_status,qzone_synced_at,qzone_sync_batch_id' }
            ];
            let items = [];
            for (let config of configs) {
                const { data, error } = await sb.from(config.table).select(config.cols).is('deleted_at', null).order('created_at', { ascending: false }).limit(ADMIN_LIMIT);
                if (error) throw new Error(`${getQqSourceLabel(config.table)} 读取失败：${error.message}`);
                (data || []).forEach(row => {
                    if (normalizeVisibility(row.visibility) !== 'public') return;
                    if ((row.qzone_sync_status || 'pending') === 'synced') return;
                    if (config.table === 'loves' && row.privacy === 'private') return;
                    items.push(buildQqSyncItem(config.table, row, batchId));
                });
            }
            return items;
        }

        function buildQqSyncItem(type, row, batchId) {
            const media = extractQqMediaItems(type, row);
            const sourceType = getQqSourceLabel(type);
            const text = type === 'feeds' ? (row.description || '') : (row.content || '');
            const item = {
                sync_id: `${type}_${row.id}`,
                source_table: type,
                source_type: sourceType,
                source_id: String(row.id),
                author: row.author || '',
                author_name: getAuthorDisplayName(row),
                created_at: row.created_at || '',
                created_at_text: formatDateTimeText(row.created_at),
                visibility: normalizeVisibility(row.visibility),
                title: `${sourceType}备份`,
                text: text,
                photos: media.photos,
                videos: media.videos,
                sync_target: 'qzone',
                sync_status: row.qzone_sync_status || 'pending',
                qzone_sync_batch_id: batchId
            };
            item.qq_publish_text = formatQqPublishText(item);
            return item;
        }

        function formatQqPublishText(item) {
            const body = (item.text || '').trim() || `[${item.source_type}]`;
            return `${body}\n\n—— 自动备份至QQ空间\n来源：我们的专属小站\n发布者：${item.author_name || item.author || '未知'}\n原发布时间：${item.created_at_text || item.created_at || '未知'}\n分类：${item.source_type}`;
        }

        function downloadTextFile(filename, content, mime) {
            const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }

        async function exportQqSyncQueue() {
            try {
                const items = await collectQqSyncQueue();
                const payload = {
                    exported_at: new Date().toISOString(),
                    exported_by: currentUser,
                    sync_target: 'qzone',
                    note: '自动备份至QQ空间。只包含公开且尚未同步的内容。',
                    items
                };
                downloadTextFile('待同步内容.json', JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
                toast(items.length ? `已导出 ${items.length} 条待同步内容。下一步双击“启动QQ空间同步.bat”。` : '没有新的公开内容需要同步。');
            } catch(e) {
                toast('导出失败：请先运行 docs/supabase-qzone-sync.sql，或检查网络连接。错误：' + e.message);
            }
        }

        async function exportQqSyncPreview() {
            try {
                const items = await collectQqSyncQueue();
                const preview = items.map((item, idx) => {
                    const mediaText = [`照片：${item.photos.length}张`, `视频：${item.videos.length}个`].join('，');
                    return `#${idx + 1} ${item.source_type} / ${item.author_name} / ${item.created_at_text}\n${mediaText}\n${item.qq_publish_text}`;
                }).join('\n\n------------------------------\n\n') || '没有新的公开内容需要同步。';
                downloadTextFile('QQ空间发布预览.txt', preview, 'text/plain;charset=utf-8');
                toast('已生成 QQ空间发布预览.txt，可以先检查每条将要发布的文字。');
            } catch(e) {
                toast('生成预览失败：' + e.message);
            }
        }

        function readJsonFile(file) {
            return new Promise((resolve, reject) => {
                if (!file) { reject(new Error('没有选择文件')); return; }
                const reader = new FileReader();
                reader.onload = () => {
                    try { resolve(JSON.parse(String(reader.result || ''))); }
                    catch(e) { reject(new Error('发布结果不是有效 JSON 文件')); }
                };
                reader.onerror = () => reject(new Error('读取发布结果失败'));
                reader.readAsText(file, 'utf-8');
            });
        }

        async function importQqSyncResult(file) {
            if (!(await requireAdmin())) return;
            try {
                const result = await readJsonFile(file);
                const items = Array.isArray(result) ? result : (Array.isArray(result.items) ? result.items : []);
                if (!items.length) { toast('发布结果里没有可导入的记录。'); return; }
                const allowedTables = new Set(['feeds', 'messages', 'loves', 'memories']);
                const allowedStatuses = new Set(['pending', 'synced', 'failed', 'skipped']);
                let ok = 0;
                for (let item of items) {
                    const table = item.source_table;
                    const status = allowedStatuses.has(item.sync_status) ? item.sync_status : 'failed';
                    if (!allowedTables.has(table) || !item.source_id) continue;
                    const patch = {
                        qzone_sync_status: status,
                        qzone_synced_at: item.synced_at || (status === 'synced' ? new Date().toISOString() : null),
                        qzone_sync_target: item.sync_target || 'qzone',
                        qzone_sync_error: item.error || '',
                        qzone_sync_batch_id: item.qzone_sync_batch_id || item.batch_id || null
                    };
                    const { error } = await sb.from(table).update(patch).eq('id', item.source_id);
                    if (!error) ok++;
                }
                logAction('admin_import_qzone_sync_result', { count: ok });
                toast(`发布结果导入完成：已更新 ${ok} 条。已同步的内容下次不会再导出。`);
                renderAdminData();
            } catch(e) {
                toast('导入发布结果失败：' + e.message);
            }
        }

        function renderQqSyncStatusAdmin(row) {
            return `<span style="display:block;color:#666;font-size:12px;">${getQqSyncStatusLabel(row.qzone_sync_status)}</span>${row.qzone_synced_at ? `<span style="display:block;color:#999;font-size:11px;">${formatDateTimeText(row.qzone_synced_at)}</span>` : ''}`;
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
                if (type === 'feed') return `<tr><td>${escapeHtml(row.description || '').substring(0,30)}</td><td>${escapeHtml(row.author_name || '')}</td><td>${time}</td><td>${renderVisibilityAdminControls('feed', row.id, row.visibility)}</td><td><button class="admin-btn danger" onclick="deleteFeed('${row.id}')">删除</button></td></tr>`;
                if (type === 'message') return `<tr><td>${escapeHtml(row.content || '').substring(0,30)}</td><td>${escapeHtml(row.author_name || '')}</td><td>${time}</td><td>${renderVisibilityAdminControls('message', row.id, row.visibility)}</td><td><button class="admin-btn danger" onclick="adminDelete('message', '${row.id}')">删除</button></td></tr>`;
                if (type === 'love') return `<tr><td>${escapeHtml(row.content || '').substring(0,30)}</td><td>${escapeHtml(prettyName(row.author_name || ''))}</td><td>${row.privacy === 'private' ? '<span class="lui-tag rose">私密</span>' : '公开'}</td><td>${time}</td><td>${renderVisibilityAdminControls('love', row.id, row.visibility)}</td><td><button class="admin-btn danger" onclick="adminDelete('love', '${row.id}')">删除</button></td></tr>`;
                if (type === 'memory') return `<tr><td>${escapeHtml(row.content || '').substring(0,30)}</td><td>${escapeHtml(row.author_name || '')}</td><td>${time}</td><td>${renderVisibilityAdminControls('memory', row.id, row.visibility)}</td><td><button class="admin-btn danger" onclick="adminDelete('memory', '${row.id}')">删除</button></td></tr>`;
                if (type === 'memo') { const priorityLabels = { high: '高', medium: '中', low: '低' }; return `<tr><td>${escapeHtml(row.content || '').substring(0,30)}</td><td>${escapeHtml(prettyName(row.author_name || ''))}</td><td>${priorityLabels[row.priority] || row.priority || ''}</td><td>${row.done ? '已完成' : '进行中'}</td><td>${renderVisibilityAdminControls('memo', row.id, row.visibility)}</td><td><button class="admin-btn danger" onclick="adminDelete('memo', '${row.id}')">删除</button></td></tr>`; }
                if (type === 'schedule') { const dateRange = row.start_date ? (row.end_date ? `${row.start_date} ~ ${row.end_date}` : row.start_date) : ''; return `<tr><td>${escapeHtml(row.title || '').substring(0,20)}</td><td>${dateRange}</td><td>${escapeHtml(row.author_name || '')}</td><td>${renderVisibilityAdminControls('schedule', row.id, row.visibility)}</td><td><button class="admin-btn danger" onclick="adminDelete('schedule', '${row.id}')">删除</button></td></tr>`; }
                if (type === 'countdown') return `<tr><td>${escapeHtml(row.name || '').substring(0,20)}</td><td>${row.target_date || ''}</td><td>${escapeHtml(row.author_name || '')}</td><td>${renderVisibilityAdminControls('countdown', row.id, row.visibility)}</td><td><button class="admin-btn danger" onclick="adminDelete('countdown', '${row.id}')">删除</button></td></tr>`;
                if (type === 'marker') return `<tr><td>${escapeHtml(row.name || '').substring(0,15)}</td><td>${escapeHtml(row.description || '').substring(0,20)}</td><td>${escapeHtml(row.author_name || '')}</td><td>${renderVisibilityAdminControls('marker', row.id, row.visibility)}</td><td><button class="admin-btn danger" onclick="adminDelete('marker', '${row.id}')">删除</button></td></tr>`;
                return '';
            }).join('');
        }
        
        async function renderAdminContentSection(type, options = {}) {
            if (!options.skipAdminCheck && !(await requireAdmin())) return;
            const target = document.getElementById('adminContentSection');
            if (!target) return;
            target.innerHTML = '<div style="color:#888;padding:12px;">正在加载...</div>'; 
            const configs = {
                feed: { title: '时光相册动态', table: 'feeds', cols: 'id,description,author_name,created_at,visibility,bubble_ok', headers: ['描述','作者','时间','可见性','气泡','操作'] },
                message: { title: '留言板', table: 'messages', cols: 'id,content,author_name,created_at,visibility,bubble_ok', headers: ['内容','作者','时间','可见性','气泡','操作'] },
                love: { title: '感动的话', table: 'loves', cols: 'id,content,author_name,privacy,created_at,visibility', headers: ['内容','作者','隐私','时间','可见性','操作'] },
                memory: { title: '一起做过的事', table: 'memories', cols: 'id,content,author_name,created_at,visibility', headers: ['内容','作者','时间','可见性','操作'] },
                memo: { title: '待办备忘录', table: 'memos', cols: 'id,content,author_name,priority,done,created_at,visibility', headers: ['内容','作者','优先级','状态','可见性','操作'] },
                schedule: { title: '行程安排', table: 'schedules', cols: 'id,title,start_date,end_date,author_name,created_at,visibility', headers: ['标题','日期','作者','可见性','操作'] },
                countdown: { title: '纪念日倒计时', table: 'countdowns', cols: 'id,name,target_date,author_name,created_at,visibility', headers: ['标题','目标日期','作者','可见性','操作'] },
                marker: { title: '旅行地图标记', table: 'travel_markers', cols: 'id,name,author_name,created_at,visibility', headers: ['名称','作者','可见性','操作'] }
            };
            const config = configs[type];
            if (!config) { target.innerHTML = '<div style="color:#c00;padding:12px;">未知分类</div>'; return; }
            try {
                const { data, error } = await sb.from(config.table).select(config.cols).is('deleted_at', null).order('created_at', { ascending: false }).limit(ADMIN_LIMIT);
                if (error) throw error;
                const headerHtml = config.headers.map(h => `<th>${h}</th>`).join('');
                target.innerHTML = `<div style="font-size:13px;color:#999;margin-bottom:10px;">${config.title} · ${data ? data.length : 0} 条（最多显示${ADMIN_LIMIT}条）</div><div>${renderAdminCards(type, data || [])}</div>`;
            } catch(e) {
                target.innerHTML = `<div style="color:#c00;padding:12px;">加载失败：${escapeHtml(e.message || String(e))}</div>`;
            }
        }
        
        function renderTrashPanel() {
            return '<div class="admin-section" id="adminTrashSection" style="color:var(--ink-3);">回收站加载中...</div>';
        }
        function fmtTrashTime(t) { try { return t ? new Date(t).toLocaleString() : ''; } catch(e) { return t || ''; } }
        async function loadTrashSection() {
            const target = document.getElementById('adminTrashSection');
            if (!target) return;
            const res = await trashApi('list');
            const items = res.items || [];
            window.__adminTrashCount = items.length;
            if (typeof refreshTrashBadge === 'function') { refreshTrashBadge(); const _hn = document.getElementById('homeTrashNum'); if (_hn) _hn.textContent = items.length; }
            if (!items.length) { target.innerHTML = '<h3>回收站</h3><div style="color:var(--ink-3);padding:8px 0;">回收站是空的～删除的内容会出现在这里，可恢复或彻底删除。</div>'; return; }
            let html = '<h3>回收站（' + items.length + ' 条，永久保留）</h3>';
            html += '<div style="display:flex;flex-direction:column;gap:10px;">';
            items.forEach(function(it) {
                let media = '';
                (it.media || []).forEach(function(m) {
                    if (m.isVideo) media += '<video controls preload="none" src="' + m.trashUrl + '" style="max-width:140px;max-height:140px;border-radius:8px;margin:4px 6px 4px 0;background:#000;"></video>';
                    else media += '<img src="' + m.trashUrl + '" loading="lazy" style="max-width:140px;max-height:140px;border-radius:8px;margin:4px 6px 4px 0;object-fit:cover;" />';
                });
                html += '<div class="admin-section" style="border:1px solid #f3c0cb;margin:0;">'
                    + '<div style="font-weight:600;">[' + escapeHtml(it.type) + '] ' + escapeHtml(it.title || '(无文字内容)') + '</div>'
                    + '<div style="color:#999;font-size:12px;margin:4px 0;">作者：' + escapeHtml(it.author || '') + '　删除人：' + escapeHtml(it.deleted_by || '') + '　' + fmtTrashTime(it.deleted_at) + '</div>'
                    + (media ? '<div style="display:flex;flex-wrap:wrap;">' + media + '</div>' : '')
                    + '<div style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap;">'
                    + '<button class="admin-btn" onclick="trashRestore(\'' + it.table + '\',\'' + it.id + '\')">' + iconSvg('i-trash-restore') + ' 恢复</button>'
                    + '<button class="admin-btn danger" onclick="trashPurge(\'' + it.table + '\',\'' + it.id + '\')">彻底删除</button>'
                    + '</div></div>';
            });
            html += '</div>';
            target.innerHTML = html;
        }
        async function trashRestore(table, id) {
            if (!(await confirmDialog({ title: '请确认', text: '恢复这条内容吗？\n图片/视频将移回原位，内容重新在对应板块显示。', okText: '确定', danger: true }))) return;
            try { await trashApi('restore', table, id); toast('已恢复'); await loadTrashSection(); renderAdminData(); }
            catch(e) { toast('恢复失败：' + (e.message || e)); }
        }
        async function trashPurge(table, id) {
            if (!(await confirmDialog({ title: '请确认', text: '彻底删除后不可恢复！', okText: '确定', danger: true }))) return;
            if (!(await confirmDialog({ title: '请确认', text: '最后确认：永久删除这条内容及其图片/视频？', okText: '确定', danger: true }))) return;
            try { await trashApi('purge', table, id); toast('已彻底删除'); await loadTrashSection(); }
            catch(e) { toast('彻底删除失败：' + (e.message || e)); }
        }
        async function renderAdminLogSection() {
            const logs = await getAdminLogs();
            const actionLabels = {
                login: '用户登录', logout: '用户登出', login_failed: '登录失败', publish_feed: '发布相册', publish_message: '发布留言',
                publish_love: '发布感动', publish_memory: '添加回忆', publish_memo: '添加待办', publish_schedule: '添加行程',
                publish_countdown: '添加纪念日', publish_marker: '添加地图标记', admin_delete: '管理员删除',
                admin_reset_pwd: '管理员重置密码', admin_delete_user: '管理员删除账号', admin_create_user: '管理员创建账号',
                admin_toggle_role: '切换用户角色', admin_set_permission: '设置用户权限', admin_toggle_visibility: '切换对外可见性'
            };
            let rows = ''; 
            if (logs && logs.length > 0) {
                for (let log of logs.slice(0, ADMIN_LIMIT)) {
                    let details = ''; 
                    try { const parsed = JSON.parse(log.details); details = Object.entries(parsed).map(([k, v]) => `${k}: ${String(v).substring(0, 20)}`).join(', '); }
                    catch(e) { details = log.details ? String(log.details).substring(0, 30) : ''; }
                    rows += `<tr><td style="font-size:11px;white-space:nowrap;">${new Date(log.created_at).toLocaleString()}</td><td>${log.user}</td><td>${actionLabels[log.action] || log.action}</td><td style="font-size:11px;color:#666;">${escapeHtml(details)}</td></tr>`;
                }
            } else {
                rows = '<tr><td colspan="4" style="text-align:center;color:#999;padding:20px;">暂无日志记录</td></tr>'; 
            }
            return `<div class="admin-section"><h3>操作日志 (${logs ? logs.length : 0}条)</h3><div style="max-height:400px;overflow-y:auto;"><table class="data-table"><thead><tr><th>时间</th><th>用户</th><th>操作</th><th>详情</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
        }
        
        // ========== 管理后台通用删除函数 ==========
        async function adminDelete(type, id) {
            if (!(await confirmDialog({ title: '请确认', text: '确定删除这条内容吗？\n删除后进入「回收站」，可在回收站恢复或彻底删除。', okText: '确定', danger: true }))) return;
            try {
                const tableMap = {
                    'feed': 'feeds',
                    'message': 'messages',
                    'love': 'loves',
                    'memory': 'memories',
                    'memo': 'memos',
                    'schedule': 'schedules',
                    'countdown': 'countdowns',
                    'marker': 'travel_markers'
                };
                const table = tableMap[type];
                if (!table) { toast('未知类型'); return; }
                await trashApi('delete', table, id);
                // 记录管理员删除日志
                logAction('admin_delete', { type: type, id: id });
                renderAdminData();
            } catch(e) {
                toast('删除失败: ' + e.message);
            }
        }
        
        // ========== 切换用户角色（管理员/普通用户） ==========
        
        // 权限检查函数
        function normalizeUsers(users) {
            const normalized = {};
            for (let [username, info] of Object.entries(users || {})) {
                normalized[username] = normalizeUserInfo(username, info);
            }
            return normalized;
        }
        function normalizeUserInfo(username, info = {}) {
            return {
                avatar: info.avatar || '',
                permission: ['view', 'comment', 'full'].includes(info.permission) ? info.permission : 'full',
                role: (info.role === 'admin' || username === 'admin') ? 'admin' : 'user',
                last_active: info.last_active || '',
                is_online: info.is_online === true || info.is_online === 'true'
            };
        }
        function getCacheSafeUsers(users) {
            const normalized = normalizeUsers(users);
            const cacheSafe = {};
            for (let [username, info] of Object.entries(normalized)) {
                cacheSafe[username] = {
                    avatar: '',
                    permission: info.permission,
                    role: info.role
                };
            }
            return cacheSafe;
        }
        function safeSetLocalStorage(key, value) {
            try {
                localStorage.setItem(key, value);
                return true;
            } catch(e) {
                console.warn('本地缓存写入失败，已跳过，不影响云端数据:', e);
                try { localStorage.removeItem(key); } catch(_) {}
                return false;
            }
        }
        function cacheUsersLocally(users) {
            return safeSetLocalStorage('couple_users', JSON.stringify(getCacheSafeUsers(users)));
        }
        function loadCachedUsers(defaultUsers = {}) {
            try {
                const cached = localStorage.getItem('couple_users');
                return cached ? normalizeUsers(JSON.parse(cached)) : defaultUsers;
            } catch(e) {
                console.warn('本地用户缓存读取失败，已恢复默认账号缓存:', e);
                try { localStorage.removeItem('couple_users'); } catch(_) {}
                return defaultUsers;
            }
        }
        
        // ========== 管理员操作日志功能 ==========
        // 记录操作日志（优先存云端，失败则存本地）
        async function logAction(action, details = {}) {
            try {
                // 收集设备和环境信息
                const envInfo = {
                    user_agent: navigator.userAgent.substring(0, 100),
                    platform: navigator.platform,
                    language: navigator.language,
                    screen_size: `${screen.width}x${screen.height}`,
                    page_url: window.location.href.substring(0, 100),
                    current_tab: currentTab || 'unknown'
                };
                
                // 合并详情信息
                const fullDetails = {
                    ...envInfo,
                    ...(typeof details === 'string' ? { message: details } : details)
                };
                
                const logData = {
                    action: action,
                    user: currentUser || 'guest',
                    details: JSON.stringify(fullDetails),
                    created_at: new Date().toISOString()
                };
                
                // 先立即存到本地，确保日志不丢失
                try {
                    let localLogs = JSON.parse(localStorage.getItem('admin_logs') || '[]');
                    localLogs.unshift(logData);
                    // 本地保留最近日志，后台会和云端日志合并展示
                    if (localLogs.length > LOG_LOCAL_LIMIT) localLogs = localLogs.slice(0, LOG_LOCAL_LIMIT);
                    localStorage.setItem('admin_logs', JSON.stringify(localLogs));
                } catch(e) {
                    console.error('保存本地日志失败:', e);
                }
                
                // 异步尝试存到 Supabase（不阻塞）
                if (LOG_REMOTE_ACTIONS.has(action)) {
                    try { await sb.from('admin_logs').insert(logData); } catch(e) {}
                }
            } catch(e) {
                console.error('记录日志失败:', e);
            }
        }
        
        // 获取日志列表
        function readLocalAdminLogs() {
            try {
                const logs = JSON.parse(localStorage.getItem('admin_logs') || '[]');
                return Array.isArray(logs) ? logs : [];
            } catch(e) {
                return [];
            }
        }
        function getLogKey(log) {
            if (!log) return '';
            return [log.created_at || '', log.action || '', log.user || '', log.details || ''].join('|');
        }
        function logEpoch(log) {
            const t = Date.parse(log && log.created_at);
            return isNaN(t) ? -1 : t;
        }
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
            return kept.map(x => x.l)
                .sort((a, b) => logEpoch(b) - logEpoch(a))
                .slice(0, ADMIN_LIMIT);
        }
        async function getAdminLogs() {
            let logs = [];
            
            // 尝试从 Supabase 获取
            try {
                const { data, error } = await sb.from('admin_logs').select('action,user,details,created_at').order('created_at', { ascending: false }).limit(ADMIN_LIMIT);
                if (!error && data) {
                    logs = data;
                }
            } catch(e) {}
            logs = mergeAdminLogs(logs, readLocalAdminLogs());
            
            return logs;
        }

        // 🌟 核心提速修改点：优先读取本地，异步在后台同步云端
        function resizeAvatarImage(file, size = 160, quality = 0.82) {
            return new Promise((resolve, reject) => {
                if (!file || !file.type.startsWith('image/')) {
                    reject(new Error('请选择图片文件'));
                    return;
                }
                const reader = new FileReader();
                reader.onload = e => {
                    const img = new Image();
                    img.onload = () => {
                        const canvas = document.createElement('canvas');
                        canvas.width = size;
                        canvas.height = size;
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
            let file = document.getElementById('avatarInput').files[0]; 
            if(!file) return; 
            try {
                const avatarData = await resizeAvatarImage(file);
                const result = await accountApi('updateAvatar', { avatar: avatarData });
                currentUserInfo = result.user || { ...(currentUserInfo || {}), avatar: avatarData };
                document.getElementById('userAvatarImg').src = avatarData; 
                closeModalById('avatarModal'); 
                logAction('update_avatar', { file_name: file.name, file_size: file.size });
                toast('头像已更新！'); 
            } catch(err) {
                toast('头像同步到云端失败：' + err.message);
            }
        }
        async function changePassword() { 
            let old = document.getElementById('oldPwd').value, 
                newPwd = document.getElementById('newPwd').value, 
                confirm = document.getElementById('confirmPwd').value; 
            if(newPwd !== confirm) { toast('两次新密码不一致'); return; } 
            if(newPwd.length < 8) { toast('密码至少8位'); return; } 
            try { 
                await accountApi('changePassword', { oldPassword: old, newPassword: newPwd });
                logAction('change_password', { success: true });
                toast('密码修改成功，请重新登录'); 
                logout(); 
            } catch(e) { 
                logAction('change_password', { success: false, reason: e.message });
                toast(e.message || '密码修改失败'); 
            }
        }
        async function registerNewUser() {
            let newName = document.getElementById('newUsername').value.trim();
            let newPwd = document.getElementById('newUserPwd').value.trim();
            const isPublic = window.__registerMode === 'public';
            const registerOpen = !!window.__registerOpen;
            const invite = isPublic ? document.getElementById('newUserInvite').value.trim() : '';
            if(!newName || !newPwd) { toast('请填写账号和密码'); return; }
            if(isPublic && !registerOpen && !invite) { toast('请填写注册邀请码'); return; }
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
            } catch(e) {
                toast('注册失败：' + e.message);
                if (btn) { btn.disabled = false; btn.innerText = '注册'; }
                return;
            }
            document.getElementById('newUsername').value = '';
            document.getElementById('newUserPwd').value = '';
            const invEl = document.getElementById('newUserInvite'); if (invEl) invEl.value = '';
            closeModalById('registerModal');
            if(isAdmin) await renderAdminData();
            if (btn) { btn.disabled = false; btn.innerText = '注册'; }
            toast(`账号 ${newName} 注册成功，已经在后台列表刷新。`);
        }
        function closeAdminPanel() {
            document.getElementById('adminPanel').classList.remove('show');
            stopMonitorAuto();
            document.body.style.overflow = '';
        }
        function adminSetStorageMode() { 
            let select = document.getElementById('adminStorageModeSelect'); 
            storageMode = select.value; 
            localStorage.setItem('couple_storage_mode', storageMode); 
            toast(`已切换为 ${storageMode === 'cloud' ? '图床模式' : '本地模式'}`); 
        }
        function loadStorageModeSetting() { 
            let saved = localStorage.getItem('couple_storage_mode'); 
            if(saved === 'local') storageMode = 'local'; 
            else storageMode = 'cloud'; 
            if(isAdmin && document.getElementById('adminStorageModeSelect')) 
                document.getElementById('adminStorageModeSelect').value = storageMode; 
        }
        function updateTogetherDays(){ 
            let diff=Math.floor((new Date()-START_DATE)/(86400000)); 
            document.getElementById('togetherDaysDisplay').innerHTML=iconSvg('i-heart-fill')+' 已相爱 <strong>'+diff+'</strong> 天'; 
        }
        function toggleDropdown(){ 
            let m=document.getElementById('dropdownMenu'); 
            m.style.display=m.style.display==='block'?'none':'block'; 
        }
        function openAvatarModal(){ document.getElementById('avatarModal').style.display='flex'; }
        function openPasswordModal(){ document.getElementById('passwordModal').style.display='flex'; }
        function openUsernameModal(){
            const el = document.getElementById('renameCurrentUser');
            if (el) el.innerText = currentUser || '';
            document.getElementById('newUsernameInput').value = '';
            document.getElementById('renamePwd').value = '';
            document.getElementById('usernameModal').style.display='flex';
        }
        async function changeUsername(){
            const newName = document.getElementById('newUsernameInput').value.trim();
            const pwd = document.getElementById('renamePwd').value;
            if (!newName) { toast('请输入新用户名'); return; }
            if (!/^[A-Za-z0-9_.-]+$/.test(newName)) { toast('用户名只能包含字母、数字、下划线、点、减号'); return; }
            if (!pwd) { toast('请输入当前密码确认'); return; }
            if (!(await confirmDialog({ title: '请确认', text: '确定把用户名从「' + currentUser + '」改为「' + newName + '」吗？\n\n你发布的所有动态、留言、点赞、评论会自动归属到新名字，历史内容不会丢失。改完将自动用新名字登录。', okText: '确定', danger: true }))) return;
            try {
                const res = await accountApi('changeUsername', { newUsername: newName, password: pwd });
                if (res && res.user && res.sessionToken) {
                    setSession(res.user.username, res.sessionToken);
                    toast('用户名修改成功！已自动用新名字「' + res.user.username + '」登录，页面即将刷新。');
                    location.reload();
                } else {
                    toast('修改返回异常，请刷新后用新用户名登录');
                    location.reload();
                }
            } catch (e) { toast(e.message || '用户名修改失败'); }
        }
        function openSetUserPasswordModal(username){
            document.getElementById('setPwdUsername').value = username;
            document.getElementById('setPwdNew').value = '';
            document.getElementById('setPwdConfirm').value = '';
            document.getElementById('setUserPasswordModal').style.display='flex';
        }
        function closeModalById(id){ document.getElementById(id).style.display='none'; }
        async function logout(){ 
            // 记录登出日志
            logAction('logout', { username: currentUser });
            try { await accountApi('logout'); } catch(e) {}
            
            stopBubbleGenerator(); 
            clearAllDreamBubbles(); 
            stopHeartbeat(); 
            if (syncTimer) clearInterval(syncTimer);
            document.getElementById('mainPage').style.display='none'; 
            document.getElementById('loginPage').style.display='flex'; 
            currentUser=''; 
            currentUserInfo=null; 
            isAdmin=false; 
            clearSession();
        }
        
        // ========== 自动登录与秒级登录核心逻辑 ==========
        // 永久记住登录状态，取消会话超时
        // 进入主系统解耦，统一并发提速
        function backToLogin(){ 
            document.getElementById('angryMask').style.display='none'; 
            document.getElementById('loginPage').style.display='flex'; 
        }
        function showSection(sectionName) { 
            trackEvent('切换页面', sectionCN(sectionName));
            document.querySelectorAll('.section').forEach(sec => sec.classList.remove('active'));
            document.getElementById(sectionName + 'Section').classList.add('active');
            document.querySelectorAll('.nav-btn, .lui-tabbar .tab').forEach(btn => btn.classList.remove('active'));
            const curNav = document.querySelector('.nav-btn[data-section="' + sectionName + '"], .lui-tabbar .tab[data-section="' + sectionName + '"]');
            if (curNav) curNav.classList.add('active');
            currentTab = sectionName;
            refreshCurrentSection().catch(e => console.log('切换页面刷新出现微调')); 
            if(sectionName === 'travel') setTimeout(() => initMap(), 100); 
        }
        function escapeHtml(str){ 
            return String(str == null ? '' : str)
                .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                .replace(/"/g,'&quot;').replace(/'/g,'&#39;'); 
        }
        function isCoupleAccount(username = currentUser) {
            return username === 'boy' || username === 'girl';
        }
        function normalizeVisibility(value) {
            return value === 'couple_only' ? 'couple_only' : 'public';
        }
        function canViewRecord(record) {
            const visibility = normalizeVisibility(record && record.visibility);
            return visibility !== 'couple_only' || isAdmin || isCoupleAccount();
        }
        function getVisibilityLabel(value) {
            const visibility = normalizeVisibility(value);
            return visibility === 'couple_only' ? '<span class="lui-tag rose">仅情侣可见</span>' : '<span class="lui-tag blue">公开</span>';
        }
        function getVisibilityToggleText(value) {
            const visibility = normalizeVisibility(value);
            return visibility === 'couple_only' ? '恢复公开' : '对外隐藏';
        }
        function renderVisibilityAdminControls(type, id, visibility) {
            const normalized = normalizeVisibility(visibility);
            const nextVisibility = normalized === 'couple_only' ? 'public' : 'couple_only';
            const dangerClass = normalized === 'couple_only' ? '' : ' danger';
            return `<span style="display:block;margin-bottom:4px;">${getVisibilityLabel(normalized)}</span><button class="admin-btn${dangerClass}" onclick="toggleRecordVisibility('${type}', '${id}', '${nextVisibility}')">${getVisibilityToggleText(normalized)}</button>`;
        }
        // 前端卡片上的"对外隐藏/恢复"管理员按钮（仅管理员可见，复用后台 toggleRecordVisibility，服务端鉴权）
        function adminVisCtrl(type, id, vis) {
            if (!isAdmin) return '';
            const n = normalizeVisibility(vis);
            const next = n === 'couple_only' ? 'public' : 'couple_only';
            const badge = n === 'couple_only' ? '<span class="vis-badge">仅情侣可见</span>' : '';
            const label = n === 'couple_only' ? '恢复公开' : '对外隐藏';
            return `${badge}<button class="vis-btn${n === 'couple_only' ? ' is-hidden' : ''}" onclick="toggleRecordVisibility('${type}','${id}','${next}')">${label}</button>`;
        }
        async function toggleRecordVisibility(type, id, visibility) {
            if (!(await requireAdmin())) return;
            const tableMap = {
                feed: 'feeds',
                message: 'messages',
                love: 'loves',
                memory: 'memories',
                memo: 'memos',
                schedule: 'schedules',
                countdown: 'countdowns',
                marker: 'travel_markers'
            };
            const table = tableMap[type];
            const nextVisibility = normalizeVisibility(visibility);
            if (!table) { toast('未知内容类型'); return; }
            const hiding = nextVisibility === 'couple_only';
            const confirmTip = hiding
                ? '确定要把这条内容设为「仅情侣可见」吗？\n\n设置后，外部账号（如 test）将看不到这条，你和女朋友、管理员仍能看到。'
                : '确定要把这条内容「恢复公开」吗？\n\n恢复后所有账号都能看到。';
            if (!(await confirmDialog({ title: '请确认', text: confirmTip, okText: '确定', danger: true }))) return;
            try {
                const { error } = await sb.from(table).update({ visibility: nextVisibility }).eq('id', id);
                if (error) throw error;
                logAction('admin_toggle_visibility', { type, id, visibility: nextVisibility });
                if (document.getElementById('adminContentSection')) renderAdminContentSection(type);
                else renderAdminData();
                refreshCurrentSection().catch(e => console.log('可见性切换后刷新当前页面失败:', e));
                toast(hiding ? '已设为「仅情侣可见」，外部账号看不到了' : '已恢复公开，所有账号可见', 'success');
            } catch(e) {
                toast('切换可见性失败：请先在 Supabase 执行 docs/supabase-visibility.sql。错误：' + e.message);
            }
        }
        
        function openImageModal(src){ src = imgProxy(src); 
            // 行为埋点：找到被点击的图片，读取来源/作者/描述，生成可读标签
            try {
                const allImgs = Array.from(document.querySelectorAll('#galleryContainer img[data-source], #messageList img[data-source]'));
                const el = allImgs.find(img => img.getAttribute('src') === src || img.src === src);
                if (el && el.dataset.source) {
                    trackEvent('查看照片', `[${el.dataset.source}] ${el.dataset.author || '未知'}：${el.dataset.desc || '无描述'}`, { url: String(src || '').slice(0, 120) });
                } else {
                    trackEvent('查看照片', (src || '').split('/').pop() || src, { url: String(src || '').slice(0, 120) });
                }
            } catch (e) { trackEvent('查看照片', (src || '').split('/').pop() || src); }
            const imgs = Array.from(document.querySelectorAll('#galleryContainer img[data-source], #messageList img[data-source]'));
            currentPhotosList = imgs.map(img => img.getAttribute('src') || img.src);
            currentPhotoIndex = currentPhotosList.indexOf(src);
            if(currentPhotoIndex === -1) { currentPhotosList = [src]; currentPhotoIndex = 0; }
            updateModalImage(); 
        }
        function updateModalImage() {
            if(currentPhotosList.length === 0) return;
            const src = currentPhotosList[currentPhotoIndex];
            document.getElementById('modalImage').src = src; 
            document.getElementById('imageModal').style.display = 'flex'; 
            document.getElementById('downloadImageBtn').onclick = () => { 
                let a = document.createElement('a'); a.href = src; a.download = 'love.png'; a.click(); 
            }; 
        }
        function prevPhoto(e) {
            if(e) e.stopPropagation();
            if(currentPhotosList.length <= 1) return;
            currentPhotoIndex = (currentPhotoIndex - 1 + currentPhotosList.length) % currentPhotosList.length;
            updateModalImage();
        }
        function nextPhoto(e) {
            if(e) e.stopPropagation();
            if(currentPhotosList.length <= 1) return;
            currentPhotoIndex = (currentPhotoIndex + 1) % currentPhotosList.length;
            updateModalImage();
        }
        function handleDisplaySwipe() {
            if (touchEndX < touchStartX - 50) nextPhoto(); 
            if (touchEndX > touchStartX + 50) prevPhoto(); 
        }
        function closeModal(){ document.getElementById('imageModal').style.display='none'; }
        function openVideoModal(src){ 
            // 行为埋点：找到被点击的视频元素，读取来源/作者/描述
            try {
                const vids = Array.from(document.querySelectorAll('#galleryContainer video'));
                const el = vids.find(v => v.getAttribute('src') === imgProxy(src) || v.src === imgProxy(src));
                if (el && el.dataset.source) {
                    trackEvent('查看视频', `[${el.dataset.source}] ${el.dataset.author || '未知'}：${el.dataset.desc || '无描述'}`, { url: String(src || '').slice(0, 120) });
                } else {
                    trackEvent('查看视频', (src || '').split('/').pop() || src, { url: String(src || '').slice(0, 120) });
                }
            } catch (e) { trackEvent('查看视频', (src || '').split('/').pop() || src); }
            document.getElementById('modalVideo').src=imgProxy(src); 
            document.getElementById('videoModal').style.display='flex'; 
        }
        function closeVideoModal(){ document.getElementById('videoModal').style.display='none'; }

        // ========== Account and permission final override layer ==========
        function updateAdminVisibility() {
            const adminBtn = document.getElementById('adminEntryBtn');
            if (adminBtn) adminBtn.style.display = isAdmin ? 'block' : 'none';
        }
        async function loadCurrentUserAvatar() {
            if (!currentUser) return;
            const avatar = currentUserInfo && currentUserInfo.avatar;
            if (avatar) document.getElementById('userAvatarImg').src = imgProxy(avatar);
        }
        async function forceRefreshUserData(options = {}) {
            const allowLocalFallback = options.allowLocalFallback !== false;
            try {
                let users = {};
                if (options.includeAll) {
                    const result = await accountApi('listUsers');
                    users = userArrayToMap(result.users || []);
                    // 轻量用户列表不含头像，保留当前登录用户已有头像，避免顶部头像被清空
                    const _prev = window.__usersCache && window.__usersCache[currentUser];
                    if (_prev && users[currentUser] && !users[currentUser].avatar && _prev.avatar) users[currentUser].avatar = _prev.avatar;
                } else {
                    const result = await accountApi('me');
                    if (result.user) users[result.user.username] = normalizeUserInfo(result.user.username, result.user);
                }
                lastUserSyncError = null;
                cacheUsersLocally(users);
                if (users[currentUser]) currentUserInfo = users[currentUser];
                return users;
            } catch(e) {
                lastUserSyncError = e;
                if (!allowLocalFallback) throw e;
                return loadCachedUsers({});
            }
        }
        async function loadUserData(options = {}) {
            return await forceRefreshUserData(options);
        }
        async function saveUsers(users) {
            throw new Error('账号资料必须通过 /api/account 安全接口保存，不能从前端直接写 users 表。');
        }
        async function hasPermission(required) {
            try {
                const users = await forceRefreshUserData({ allowLocalFallback: false });
                const userInfo = users[currentUser];
                if (!userInfo) return false;
                currentUserInfo = userInfo;
                isAdmin = (currentUser === 'admin') || userInfo.role === 'admin';
                updateAdminVisibility();
                if (isAdmin) return true;
                const userPerm = userInfo.permission || 'full';
                const levels = { 'view': 1, 'comment': 2, 'full': 3 };
                lastPermissionError = null;
                return (levels[userPerm] || 3) >= (levels[required] || 0);
            } catch(e) {
                lastPermissionError = e;
                console.error('权限检查失败:', e);
                return false;
            }
        }
        async function requirePermission(required) {
            const ok = await hasPermission(required);
            if (!ok) {
                const labels = { view: '浏览', comment: '评论/点赞', full: '发布/修改' };
                const extra = lastPermissionError ? '\n\n如果你刚改过权限，请检查 Supabase users 表字段和网络连接。错误：' + lastPermissionError.message : '';
                toast(`当前账号没有“${labels[required] || required}”权限，请联系管理员调整权限${extra}`);
            }
            return ok;
        }
        async function requireAdmin() {
            try {
                const users = await forceRefreshUserData({ allowLocalFallback: false });
                const userInfo = users[currentUser];
                if (userInfo) currentUserInfo = userInfo;
                isAdmin = !!(userInfo && ((currentUser === 'admin') || userInfo.role === 'admin'));
                updateAdminVisibility();
                if (!isAdmin) toast('无权限：只有管理员可以操作这里');
                return isAdmin;
            } catch(e) {
                toast('无法确认管理员权限，请检查 Supabase users 表和网络连接。错误：' + e.message);
                return false;
            }
        }
        async function canDeleteRecord(table, id) {
            if (!(await hasPermission('full'))) {
                toast('删除内容需要“完整权限”，请联系管理员调整权限');
                return false;
            }
            if (isAdmin) return true;
            try {
                const { data, error } = await sb.from(table).select('author').eq('id', id).maybeSingle();
                if (!error && data && data.author === currentUser) return true;
            } catch(e) {}
            toast('只能删除自己发布的内容，或让管理员删除');
            return false;
        }
        async function ensureCommentMutationAllowed(comment) {
            if (!(await hasPermission('comment'))) {
                toast('删除评论需要“评论/点赞”权限，请联系管理员调整权限');
                return false;
            }
            if (isAdmin || (comment && comment.author === currentUser)) return true;
            toast('只能删除自己的评论，或让管理员删除');
            return false;
        }
        async function showRegisterModal() {
            if (!(await requireAdmin())) return;
            window.__registerMode = 'admin';
            const wrap = document.getElementById('registerInviteWrap');
            if (wrap) wrap.style.display = 'none';
            const inv = document.getElementById('newUserInvite'); if (inv) inv.value = '';
            document.getElementById('registerModal').style.display='flex';
        }
        // 登录页公开注册入口（未登录；管理员开启"开放注册"时无需邀请码）
        async function openPublicRegisterModal() {
            window.__registerMode = 'public';
            window.__registerOpen = false;
            const wrap = document.getElementById('registerInviteWrap');
            // 先弹窗再异步加载配置：避免接口慢/失败时看起来"点了没反应"
            document.getElementById('newUsername').value = '';
            document.getElementById('newUserPwd').value = '';
            const inv = document.getElementById('newUserInvite'); if (inv) inv.value = '';
            document.getElementById('registerModal').style.display = 'flex';
            try {
                const cfg = await accountApi('getSignupCode');
                window.__registerOpen = !!(cfg && cfg.register_open);
            } catch (e) { /* 默认需邀请码 */ }
            if (wrap) wrap.style.display = window.__registerOpen ? 'none' : 'block';
        }
        window.openPublicRegisterModal = openPublicRegisterModal;
        async function openAdminPanel() {
            var showAdminPanelNow = function() {
                document.getElementById('adminPanel').classList.add('show');
                document.body.style.overflow = 'hidden';
                document.getElementById('adminContent').innerHTML = '<div class="lui-card"><div class="lui-empty"><div class="e-icon"><div class="lui-spinner lg"></div></div><div class="e-title">后台正在加载…</div></div></div>';
                renderAdminData().catch(e => {
                    document.getElementById('adminContent').innerHTML = `<div class="lui-notice error"><div class="n-icon" style="display:none"></div><div class="n-body"><div class="n-title">后台加载失败</div><div>${escapeHtml(e.message || String(e))}<br>请刷新页面后再试。</div></div></div>`;
                });
            };
            if (isAdmin && currentUserInfo) { showAdminPanelNow(); return; }
            document.getElementById('adminPanel').classList.add('show');
            document.body.style.overflow = 'hidden';
            document.getElementById('adminContent').innerHTML = '<div class="lui-card"><div class="lui-empty"><div class="e-icon"><div class="lui-spinner lg"></div></div><div class="e-title">正在确认管理员权限…</div></div></div>';
            if (!(await requireAdmin())) { closeAdminPanel(); return; }
            showAdminPanelNow();
        }
        async function deleteUserAccount(username) {
            if (!(await requireAdmin())) return;
            if(username === 'admin') { toast('该账号不能删除'); return; }
            if (!(await confirmDialog({ title: '请确认', text: `确定删除账号「${username}」吗？\n\n删除后该账号将无法再登录，它已发布的动态、留言等内容会保留。\n此操作不可撤销，请谨慎确认。`, okText: '确定', danger: true }))) return;
            try {
                await accountApi('deleteUser', { username });
            } catch(e) { toast('删除账号失败：' + e.message); return; }
            logAction('admin_delete_user', { username: username });
            renderAdminData();
            toast(`账号 ${username} 已删除`);
        }
        async function toggleUserRole(username) {
            if (!(await requireAdmin())) return;
            if (username === 'admin') { toast('不能修改超级管理员的角色'); return; }
            try {
                const result = await accountApi('toggleUserRole', { username });
                logAction('admin_toggle_role', { username: username, new_role: result.user && result.user.role });
                renderAdminData();
                toast(`已将 ${username} 设为${result.user && result.user.role === 'admin' ? '管理员' : '普通用户'}`);
            } catch(e) { toast('保存角色失败：' + e.message); }
        }
        async function setUserPermission(username, permission) {
            if (!(await requireAdmin())) return;
            if (username === 'admin') { toast('不能修改超级管理员的权限'); return; }
            if (!['view', 'comment', 'full'].includes(permission)) { toast('权限值不正确'); return; }
            try {
                await accountApi('setUserPermission', { username, permission });
                logAction('admin_set_permission', { username: username, permission: permission });
                const permLabels = { 'full': '完全权限', 'comment': '仅评论', 'view': '仅浏览' };
                toast(`已将 ${username} 的权限设为：${permLabels[permission]}`);
                renderAdminData();
            } catch(e) { toast('保存权限失败：' + e.message); }
        }
        async function setUserPassword() {
            if (!(await requireAdmin())) return;
            const username = document.getElementById('setPwdUsername').value.trim();
            const newPassword = document.getElementById('setPwdNew').value;
            const confirm = document.getElementById('setPwdConfirm').value;
            if (!username) { toast('用户不存在'); return; }
            if (newPassword !== confirm) { toast('两次新密码不一致'); return; }
            if (newPassword.length < 8) { toast('密码至少8位'); return; }
            const btn = document.querySelector('#setUserPasswordModal .submit-btn');
            if (btn) { btn.disabled = true; btn.innerText = '正在保存...'; }
            try {
                await accountApi('setUserPassword', { username, newPassword });
                logAction('admin_reset_pwd', { username: username });
                closeModalById('setUserPasswordModal');
                await renderAdminData();
                toast(`${username} 的密码已更新，已经立即生效。`);
            } catch(e) { 
                toast('设置密码失败：' + e.message); 
            } finally {
                if (btn) { btn.disabled = false; btn.innerText = '保存新密码'; }
            }
        }
        async function autoLogin() {
            let savedUser = localStorage.getItem('couple_logged_user');
            if (!savedUser || !getSessionToken()) return false; try { document.cookie = 'couple_t=' + encodeURIComponent(getSessionToken()) + '; path=/; max-age=2592000; samesite=lax' + (location.protocol === 'https:' ? '; secure' : ''); } catch (e) {}
            try {
                let users = await loadUserData({ allowLocalFallback: false });
                if (users[savedUser]) {
                    enterMainSystem(savedUser, users);
                    return true;
                }
            } catch(e) {
                localStorage.removeItem('couple_logged_user');
                console.warn('自动登录失败，需要重新登录:', e);
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
            const restored = await autoLogin();
            if (!restored) {
                document.getElementById('loginPage').style.display = 'flex';
            }
        }
        async function login(){ 
            const u = document.getElementById('username').value.trim(); 
            const p = document.getElementById('password').value.trim(); 
            const btn = document.getElementById('loginBtn');
            if(!u || !p) { toast('请输入账号和密码'); return; }
            if(btn) { btn.disabled = true; btn.innerText = '正在登录...'; }
            try {
                const result = await accountApi('login', { username: u, password: p });
                setSession(result.user.username, result.sessionToken);
                const users = {}; users[result.user.username] = normalizeUserInfo(result.user.username, result.user);
                enterMainSystem(result.user.username, users);
            } catch(e) {
                logAction('login_failed', { username: u, reason: e.message });
                toast('登录失败：' + e.message);
            } finally {
                if(btn) { btn.disabled = false; btn.innerText = '登录'; }
            }
        }
        function runDeferredInitialLoad() {
            const sharedStateLoads = [
                () => loadBubbleConfig({ loadPhotos: false }),
                () => loadAngryData()
            ];
            let index = 0;
            const runNext = () => {
                if (index >= sharedStateLoads.length || !currentUser) return;
                const task = sharedStateLoads[index++];
                Promise.resolve()
                    .then(task)
                    .catch(e => console.log('延后加载共享状态失败:', e))
                    .finally(() => setTimeout(runNext, 250));
            };
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
            document.getElementById('displayUsername').innerHTML = '<span class="lui-avatar s32">' + escapeHtml((username||'我').slice(0,1).toUpperCase()) + '</span><span>' + escapeHtml(username||'') + '</span>';
            loadCurrentUserAvatar();
            loadStorageModeSetting();
            updateTogetherDays();
            updateAdminVisibility();
            updateActivity();
            logAction('login', { username: username });
            renderMessages({ force: true }).catch(e => console.log('留言板首屏加载失败:', e));
            startAutoSync();
            startHeartbeat();
            setTimeout(updateOnlineStatus, 1000);
            if (onlineStatusTimer) clearInterval(onlineStatusTimer);
            onlineStatusTimer = setInterval(updateOnlineStatus, ONLINE_STATUS_INTERVAL_MS);
            setTimeout(runDeferredInitialLoad, 800);
        }
        async function openBubbleSettings(){ 
            if (!(await requirePermission('full'))) return;
            document.getElementById('bubbleSettingsModal').style.display='flex'; 
            await loadBubbleConfig({ loadPhotos: true });
            renderBubblePreview(); 
        }
        // ========== DOM加载完成后初始化 ==========
        function initApp() {
            document.getElementById('openBubbleSettingsBtn').onclick = openBubbleSettings;
            document.getElementById('bubblePhotoInput').addEventListener('change',(e)=>{ addPhotosToBubble(e.target.files); e.target.value=''; });
            document.getElementById('bubbleToggle').onclick = () => { bubbleEnabled = !bubbleEnabled; updateToggleUI(); };
            document.addEventListener('click',(e)=>{ if(!e.target.closest('.settings-dropdown')) document.getElementById('dropdownMenu').style.display='none'; });
            document.querySelectorAll('.nav-btn, .lui-tabbar .tab').forEach(btn => { btn.onclick = function() {
                let section = this.getAttribute('data-section');
                showSection(section);
            }; });
            document.getElementById('messagePhotoInput').addEventListener('change', (e) => { 
                let p = document.getElementById('messagePhotoPreview'); 
                p.innerHTML = e.target.files[0] ? `<img src="${URL.createObjectURL(e.target.files[0])}" loading="lazy" decoding="async" style="max-width:100px;border-radius:10px;">` : ''; 
            });
            
            const fileInputElem = document.getElementById('fileInput');
            if (fileInputElem) {
                fileInputElem.addEventListener('change', function(e) {
                    window.selectedFiles = Array.from(e.target.files);
                    updateFilePreview();
                });
            }
            
            const modalEl = document.getElementById('imageModal');
            if(modalEl) {
                modalEl.addEventListener('touchstart', e => { touchStartX = e.changedTouches[0].screenX; }, {passive: true});
                modalEl.addEventListener('touchend', e => { touchEndX = e.changedTouches[0].screenX; handleDisplaySwipe(); }, {passive: true});
            }
                    // 与零依赖门禁脚本衔接：若库加载完成前已点满气泡，补进登录/自动登录
            if (window.__gateUnlocked) { try { unlockEntryGate(); } catch (e) { console.error(e); } }
        }
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initApp);
        else initApp();
