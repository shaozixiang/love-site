        // ========== Supabase 数据库初始化 ==========
        const SUPABASE_URL = 'https://txeynuvttibnilvttieu.supabase.co';
        const SUPABASE_ANON_KEY = 'sb_publishable_Z8E9qPbi6F2NLzoQh9fhfw__goWiZZ4'; 
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
                const maxVideoSize = 50 * 1024 * 1024; // 视频最大50MB
                
                if (isImage && file.size > maxImageSize) {
                    alert('图片太大啦！最大支持10MB哦~');
                    return null;
                }
                if (isVideo && file.size > maxVideoSize) {
                    alert('视频太大啦！最大支持50MB哦~');
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
                    alert('本地直接打开不能上传图片：上传接口 /api/upload-to-github 只在 Cloudflare Pages 部署后存在。请部署到线上测试，或临时开启 GITHUB_DIRECT_UPLOAD_TEST_MODE 进行本地直传测试。');
                    return null;
                }
                
                const formData = new FormData();
                formData.append('file', uploadFile, uploadFile.name || file.name || 'media');
                formData.append('folder', folder || 'common');
                formData.append('mediaType', isVideo ? 'video' : (isImage ? 'image' : 'file'));
                
                const response = await fetch('/api/upload-to-github', {
                    method: 'POST',
                    body: formData
                });
                const result = await response.json().catch(() => ({}));
                if (!response.ok || !result.url) {
                    alert('上传失败: ' + (result.error || 'GitHub 上传接口未返回链接'));
                    return null;
                }
                return result.url;
            } catch (e) {
                alert('上传失败: ' + (e.message || '请确认网站已部署到 Cloudflare Pages，并配置 GITHUB_TOKEN 环境变量')); 
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
        let floatPhotos = [], bubbleEnabled = true, bubbleIntervalSec = 12, bubbleTimer = null, activeBubbleCount = 0;
        
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
        function selectContentRows(table, columns, options = {}) {
            let query = sb.from(table).select(columns);
            query = query.is('deleted_at', null);
            if (!isAdmin && !isCoupleAccount()) query = query.or('visibility.is.null,visibility.eq.public');
            query = query.order(options.orderBy || 'created_at', { ascending: !!options.ascending });
            return query.limit(options.limit || PAGE_LIMIT);
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
            if(files.length === 0 && !desc) { alert('请选择照片/视频或输入描述'); return; }
            
            if(btn) { btn.disabled = true; btn.innerText = '📤 上传中...'; }
            
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
                author_name: currentUser=='boy'?'👦 boy':(currentUser=='girl'?'👧 girl':currentUser),
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
            if(btn) { btn.disabled = false; btn.innerText = '📤 发送动态'; }
            renderFeeds();
            addDanmaku(`${currentUser=='boy'?'👦 boy':(currentUser=='girl'?'👧 girl':currentUser)} 发布了新动态！`);
        }
        
        async function renderFeeds(options = {}) {
            if (!shouldReloadSection('gallery', options && options.force)) return;
            let feeds = [];
            try {
                const { data, error } = await selectContentRows('feeds', 'id,description,author,author_name,created_at,comments,likes,visibility', { limit: PAGE_LIMIT });
                if (!error && data) {
                    feeds = data.map(f => ({
                        id: f.id, medias: f.medias || [], desc: f.description || '', author: f.author,
                        authorName: f.author_name, time: new Date(f.created_at).toLocaleString(), comments: f.comments || [],
                        likes: f.likes || [], visibility: normalizeVisibility(f.visibility)
                    }));
                }
            } catch(e) {}
            feeds = feeds.filter(canViewRecord);
            markSectionLoaded('gallery');
            
            if(!feeds.length){ 
                document.getElementById('galleryContainer').innerHTML='<div class="empty-gallery">✨ 暂无动态，快发第一条朋友圈吧~</div>'; 
                return; 
            }
            
            let html = '';
            for(let feed of feeds) {
                let canDelete = isAdmin || feed.author === currentUser;
                let mediaHtml = `<div class="feed-media" id="feed_media_${feed.id}"><button class="submit-btn" style="padding:6px 12px;font-size:12px;" onclick="loadFeedMedia('${feed.id}')">Load media</button></div>`;
                
                let commentsHtml = `<div class="feed-comments">`;
                if(feed.comments && feed.comments.length) {
                    for(let ci = 0; ci < feed.comments.length; ci++) {
                        let c = feed.comments[ci];
                        let canDelComment = isAdmin || c.author === currentUser;
                        commentsHtml += `<div class="comment-item"><strong>${c.authorName || c.author}</strong>: ${escapeHtml(c.content)}<span style="color:#aaa; margin-left:8px;">${c.time}</span>${canDelComment ? `<button class="submit-btn" style="padding:0px 6px;margin-left:8px;font-size:10px;" onclick="deleteComment('${feed.id}',${ci})">删除</button>` : ''}</div>`;
                    }
                }
                commentsHtml += `<div class="reply-input"><input type="text" id="comment_input_${feed.id}" placeholder="写评论..."><button onclick="addFeedComment('${feed.id}', document.getElementById('comment_input_${feed.id}').value);document.getElementById('comment_input_${feed.id}').value=''">评论</button></div></div>`;
                
                // 点赞区域
                let likes = feed.likes || [];
                let hasLiked = likes.includes(currentUser);
                let likeCount = likes.length;
                let likeUsersHtml = likes.map(u => {
                    let displayName = u === 'boy' ? '👦 boy' : (u === 'girl' ? '👧 girl' : u);
                    return `<span class="like-user-tag">${displayName}</span>`;
                }).join('');
                let likeHtml = `<div class="like-section">
                    <button class="like-btn ${hasLiked ? 'liked' : ''}" onclick="toggleFeedLike('${feed.id}')">
                        <span class="heart-icon">${hasLiked ? '❤️' : '🤍'}</span>
                        <span>${hasLiked ? '已赞' : '点赞'}</span>
                    </button>
                    <div class="like-users">
                        <span class="like-count">${likeCount}人赞</span>
                        ${likeUsersHtml}
                    </div>
                </div>`;
                
                html += `<div class="feed-item"><div class="feed-header"><span class="feed-author">${feed.authorName}</span><span class="feed-time">${feed.time}</span>${canDelete ? `<button class="submit-btn" style="padding:2px 8px;" onclick="deleteFeed('${feed.id}')">删除</button>` : ''}${adminVisCtrl('feed', feed.id, feed.visibility)}</div>${feed.desc ? `<div class="feed-desc">${escapeHtml(feed.desc)}</div>` : ''}${mediaHtml}${likeHtml}${commentsHtml}</div>`;
            }
            document.getElementById('galleryContainer').innerHTML = html;
        }
        async function loadFeedMedia(feedId) {
            const container = document.getElementById('feed_media_' + feedId);
            if (!container) return;
            container.innerHTML = '<div style="color:#999;padding:8px;">Loading media...</div>';
            try {
                const { data, error } = await sb.from('feeds').select('medias,visibility').eq('id', feedId).maybeSingle();
                if (error) throw error;
                if (!data || !canViewRecord(data)) { container.innerHTML = ''; return; }
                const medias = (data.medias || []).filter(media => shouldUseHeavyMedia(data, media && media.data));
                if (!medias.length) { container.innerHTML = '<div style="color:#999;padding:8px;">No media</div>'; return; }
                let html = '';
                for (let media of medias) {
                    if (media.type === 'video') html += `<div class="feed-media-item" onclick="openVideoModal('${imgProxy(media.data)}')"><video src="${imgProxy(media.data)}" preload="metadata" muted playsinline style="pointer-events:none;"></video></div>`;
                    else html += `<div class="feed-media-item" onclick="openImageModal('${imgProxy(media.data)}')"><img src="${imgProxy(media.data)}" loading="lazy" decoding="async"></div>`;
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
                authorName: currentUser=='boy'?'👦 boy':(currentUser=='girl'?'👧 girl':currentUser), 
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
            addDanmaku(`${currentUser=='boy'?'👦 boy':(currentUser=='girl'?'👧 girl':currentUser)} 评论了动态`); 
        }
        async function deleteComment(feedId, commentIdx) { 
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
            if (!confirm('确定删除吗？\n删除后内容进入管理员后台「回收站」，可随时恢复。')) return;
            try { await trashApi('delete','feeds',id); alert('已移入回收站'); } catch(e) { alert('删除失败：' + (e.message || e)); return; }
            // 记录删除日志
            logAction('delete_feed', { feed_id: id });
            renderFeeds(); 
        }
        
        // ========== 动态点赞功能 ==========
        async function toggleFeedLike(feedId) {
            if (!currentUser) {
                alert('请先登录');
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
                } else {
                    // 点赞
                    currentLikes.push(currentUser);
                    logAction('like_feed', { feed_id: feedId });
                }
                
                // 3. 更新到数据库
                const { error: updateError } = await sb.from('feeds').update({ likes: currentLikes }).eq('id', feedId);
                if (updateError) throw updateError;
                
                // 4. 重新渲染UI，显示最新点赞状态
                renderFeeds();
                
            } catch(e) { 
                console.error('点赞失败:', e);
                alert('点赞失败：' + (e.message || '未知错误') + '\n\n请检查Supabase数据库：\n1. feeds表是否有likes字段\n2. likes字段类型是否为 text[]（数组）');
            }
        }
        
        // ========== 留言板 ==========
        async function addMessageWithPhoto() { 
            // 权限检查
            if (!(await requirePermission('full'))) return;
            
            let content = document.getElementById('messageInput').value.trim(); 
            let fileInput = document.getElementById('messagePhotoInput');
            let file = fileInput.files[0]; 
            if(!content && !file) { alert('请写点内容或上传照片'); return; } 
            
            const btn = document.getElementById('msgSubmitBtn');
            if(btn) { btn.disabled = true; btn.innerText = '📤 上传中...'; }

            let photoUrl = null;
            if (file) {
                let blob = file.slice(0, file.size, file.type);
                let uploadFile = new File([blob], file.name, { type: file.type });
                photoUrl = await uploadToBucket(uploadFile, 'messages');
            }
            
            const newMsg = {
                author: currentUser,
                author_name: currentUser=='boy'?'👦 boy':(currentUser=='girl'?'👧 girl':currentUser),
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
            document.getElementById('messagePhotoPreview').innerHTML = ''; 
            if(btn) { btn.disabled = false; btn.innerText = '发送留言'; }
            renderMessages(); 
            addDanmaku(`${currentUser=='boy'?'👦 boy':(currentUser=='girl'?'👧 girl':currentUser)} 在留言板说了悄悄话`); 
        }
        async function renderMessages(options = {}) { 
            if (!shouldReloadSection('message', options && options.force)) return;
            let msgs = [];
            try {
                const { data, error } = await selectContentRows('messages', 'id,content,author,author_name,created_at,comments,likes,visibility', { limit: PAGE_LIMIT });
                if (!error && data) {
                    msgs = data.map(m => ({
                        id: m.id, content: m.content || '', photo: m.photo, author: m.author,
                        author_name: m.author_name, time: new Date(m.created_at).toLocaleString(), comments: m.comments || [],
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
                        commentsHtml += `<div class="comment-item"><strong>${c.authorName || c.author}</strong>: ${escapeHtml(c.content)}<span style="color:#aaa; margin-left:8px;">${c.time}</span>${canDelComment ? `<button class="submit-btn" style="padding:0px 6px;margin-left:8px;font-size:10px;" onclick="deleteMsgComment('${m.id}',${ci})">删除</button>` : ''}</div>`;
                    }
                }
                commentsHtml += `<div class="reply-input"><input type="text" id="msg_comment_input_${m.id}" placeholder="回复悄悄话..."><button onclick="addMsgComment('${m.id}', document.getElementById('msg_comment_input_${m.id}').value);document.getElementById('msg_comment_input_${m.id}').value=''">回复</button></div></div>`;
                
                // 点赞区域
                let msgLikes = m.likes || [];
                let msgHasLiked = msgLikes.includes(currentUser);
                let msgLikeCount = msgLikes.length;
                let msgLikeUsersHtml = msgLikes.map(u => {
                    let displayName = u === 'boy' ? '👦 boy' : (u === 'girl' ? '👧 girl' : u);
                    return `<span class="like-user-tag">${displayName}</span>`;
                }).join('');
                let msgLikeHtml = `<div class="like-section" style="padding:0 15px 10px;">
                    <button class="like-btn ${msgHasLiked ? 'liked' : ''}" onclick="toggleMessageLike('${m.id}')">
                        <span class="heart-icon">${msgHasLiked ? '❤️' : '🤍'}</span>
                        <span>${msgHasLiked ? '已赞' : '点赞'}</span>
                    </button>
                    <div class="like-users">
                        <span class="like-count">${msgLikeCount}人赞</span>
                        ${msgLikeUsersHtml}
                    </div>
                </div>`;
                let photoHtml = `<div id="message_photo_${m.id}" style="margin-top:8px;"><button class="submit-btn" style="padding:6px 12px;font-size:12px;" onclick="loadMessagePhoto('${m.id}')">查看图片</button></div>`;
                return `<div class="card-item" style="padding:0;overflow:hidden;"><div style="padding:15px;"><div>💬 ${escapeHtml(m.content)}</div>${photoHtml}<div class="card-meta"><span>${m.author_name}</span><span>${m.time}</span>${canDelete ? `<button class="submit-btn" style="padding:2px 8px;" onclick="deleteMsg('${m.id}')">删除</button>` : ''}${adminVisCtrl('message', m.id, m.visibility)}</div></div>${msgLikeHtml}${commentsHtml}</div>`; 
            }).join(''); 
            document.getElementById('messageList').innerHTML = html || '<div class="empty-gallery">还没有留言，写下第一句吧~</div>'; 
        }
        async function loadMessagePhoto(msgId) {
            const container = document.getElementById('message_photo_' + msgId);
            if (!container) return;
            container.innerHTML = '<span style="color:#999;font-size:12px;">Loading image...</span>';
            try {
                const { data, error } = await sb.from('messages').select('photo,visibility').eq('id', msgId).maybeSingle();
                if (error) throw error;
                if (!data || !data.photo || !canViewRecord(data) || !shouldUseHeavyMedia(data, data.photo)) {
                    container.innerHTML = '<span style="color:#999;font-size:12px;">No image</span>';
                    return;
                }
                container.innerHTML = `<img src="${imgProxy(data.photo)}" loading="lazy" decoding="async" style="max-width:100px;max-height:100px;border-radius:10px;margin-top:8px;cursor:pointer;" onclick="openImageModal('${data.photo}')">`;
            } catch(e) {
                container.innerHTML = '<span style="color:#999;font-size:12px;">Image load failed</span>';
            }
        }
        async function addMsgComment(msgId, content) {
            if (!(await requirePermission('comment'))) return;
            if(!content.trim()) return;
            let commentObj = {
                author: currentUser,
                authorName: currentUser=='boy'?'👦 boy':(currentUser=='girl'?'👧 girl':currentUser),
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
            if (!confirm('确定删除吗？\n删除后内容进入管理员后台「回收站」，可随时恢复。')) return;
            try { await trashApi('delete','messages',id); alert('已移入回收站'); } catch(e) { alert('删除失败：' + (e.message || e)); return; }
            // 记录删除日志
            logAction('delete_message', { msg_id: id });
            renderMessages(); 
        }
        
        // ========== 留言点赞功能 ==========
        async function toggleMessageLike(msgId) {
            if (!currentUser) {
                alert('请先登录');
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
                } else {
                    // 点赞
                    currentLikes.push(currentUser);
                    logAction('like_message', { msg_id: msgId });
                }
                
                // 3. 更新到数据库
                const { error: updateError } = await sb.from('messages').update({ likes: currentLikes }).eq('id', msgId);
                if (updateError) throw updateError;
                
                // 4. 重新渲染UI，显示最新点赞状态
                renderMessages();
                
            } catch(e) { 
                console.error('点赞失败:', e);
                alert('点赞失败：' + (e.message || '未知错误') + '\n\n请检查Supabase数据库：\n1. messages表是否有likes字段\n2. likes字段类型是否为 text[]（数组）');
            }
        }
        
        // ========== 感动的话 ==========
        async function addLove() { 
            if (!(await requirePermission('full'))) return;
            let val = document.getElementById('loveInput').value.trim(); 
            if(!val) return; 
            let privacy = document.querySelector('input[name="lovePrivacy"]:checked').value; 
            const newLove = { author: currentUser, author_name: currentUser=='boy'?'👦 boy':(currentUser=='girl'?'👧 girl':currentUser), content: val, privacy: privacy, visibility: 'public' };
            try { 
                await sb.from('loves').insert(newLove); 
                // 记录发布感动的话日志
                logAction('publish_love', { content: val.substring(0, 50), privacy: privacy });
            } catch(e) { console.error(e); }
            
            document.getElementById('loveInput').value = ''; 
            renderLoves(); 
            addDanmaku(`${currentUser=='boy'?'👦 boy':(currentUser=='girl'?'👧 girl':currentUser)} 记录了感动的话`); 
        }
        async function renderLoves(options = {}) {
            if (!shouldReloadSection('love', options && options.force)) return; 
            let loves = [];
            try {
                const { data, error } = await selectContentRows('loves', 'id,content,author,author_name,created_at,privacy,visibility', { limit: PAGE_LIMIT });
                if (!error && data) {
                    loves = data.map(l => ({ id: l.id, content: l.content, author: l.author, authorName: l.author_name, time: new Date(l.created_at).toLocaleString(), privacy: l.privacy, visibility: normalizeVisibility(l.visibility) }));
                }
            } catch(e) {}
            loves = loves.filter(canViewRecord);
            markSectionLoaded('love');
            
            let html = loves.map(l => { 
                if(l.privacy === 'private' && l.author !== currentUser && !isAdmin) return ''; 
                let canDelete = isAdmin || l.author === currentUser; 
                return `<div class="card-item"><div>💌 ${escapeHtml(l.content)}${l.privacy === 'private' ? '<span class="private-badge">🔒 私密</span>' : ''}</div><div class="card-meta"><span>${l.authorName}</span><span>${l.time}</span>${canDelete ? `<button class="submit-btn" style="padding:2px 8px;" onclick="deleteLove('${l.id}')">删除</button>` : ''}${adminVisCtrl('love', l.id, l.visibility)}</div></div>`; 
            }).join(''); 
            document.getElementById('loveList').innerHTML = html || '暂无感动的话'; 
        }
        async function deleteLove(id){ 
            if (!(await canDeleteRecord('loves', id))) return;
            if (!confirm('确定删除吗？\n删除后内容进入管理员后台「回收站」，可随时恢复。')) return;
            try { await trashApi('delete','loves',id); alert('已移入回收站'); } catch(e) { alert('删除失败：' + (e.message || e)); return; }
            renderLoves(); 
        }
        // ========== 一起做过的事 ==========
        async function addMemory(){ 
            if (!(await requirePermission('full'))) return;
            let val=document.getElementById('memoryInput').value.trim(); 
            if(!val) return; 
            const newMemory = { author: currentUser, author_name: currentUser=='boy'?'👦 boy':(currentUser=='girl'?'👧 girl':currentUser), content: val, visibility: 'public' };
            try { 
                await sb.from('memories').insert(newMemory); 
                // 记录添加回忆日志
                logAction('publish_memory', { content: val.substring(0, 50) });
            } catch(e) { console.error(e); }
            
            document.getElementById('memoryInput').value=''; 
            renderMemories(); 
            addDanmaku(`${currentUser=='boy'?'👦 boy':(currentUser=='girl'?'👧 girl':currentUser)} 完成了新打卡`); 
        }
        async function renderMemories(options = {}) {
            if (!shouldReloadSection('memory', options && options.force)) return; 
            let mem = [];
            try {
                const { data, error } = await selectContentRows('memories', 'id,content,author,author_name,created_at,visibility', { limit: PAGE_LIMIT });
                if (!error && data) {
                    mem = data.map(m => ({ id: m.id, content: m.content, author: m.author, authorName: m.author_name, time: new Date(m.created_at).toLocaleString(), visibility: normalizeVisibility(m.visibility) }));
                }
            } catch(e) {}
            mem = mem.filter(canViewRecord);
            markSectionLoaded('memory');
            
            let html=mem.map(m=>{ 
                let canDelete = isAdmin || m.author === currentUser; 
                return `<div class="card-item"><div>✨ ${escapeHtml(m.content)}</div><div class="card-meta"><span>${m.authorName}</span><span>${m.time}</span>${canDelete ? `<button class="submit-btn" style="padding:2px 8px;" onclick="deleteMemory('${m.id}')">删除</button>` : ''}${adminVisCtrl('memory', m.id, m.visibility)}</div></div>`; 
            }).join(''); 
            document.getElementById('memoryList').innerHTML=html||'暂无打卡记录'; 
        }
        async function deleteMemory(id){ 
            if (!(await canDeleteRecord('memories', id))) return;
            if (!confirm('确定删除吗？\n删除后内容进入管理员后台「回收站」，可随时恢复。')) return;
            try { await trashApi('delete','memories',id); alert('已移入回收站'); } catch(e) { alert('删除失败：' + (e.message || e)); return; }
            renderMemories(); 
        }
        // ========== 待办备忘录模块 ==========
        async function addMemo() {
            if (!(await requirePermission('full'))) return;
            let content = document.getElementById('memoInput').value.trim();
            let priority = document.getElementById('memoPriority').value;
            if (!content) { alert('请输入待办内容'); return; }
            
            const newMemo = {
                author: currentUser,
                author_name: currentUser=='boy'?'👦 boy':(currentUser=='girl'?'👧 girl':currentUser),
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
            addDanmaku(`${currentUser=='boy'?'👦 boy':(currentUser=='girl'?'👧 girl':currentUser)} 添加了待办事项`);
        }
        
        async function renderMemos(options = {}) {
            if (!shouldReloadSection('memo', options && options.force)) return;
            let memos = [];
            try {
                const { data, error } = await selectContentRows('memos', 'id,content,priority,done,author,author_name,created_at,visibility', { limit: PAGE_LIMIT });
                if (!error && data) {
                    memos = data.map(m => ({
                        id: m.id, content: m.content, priority: m.priority || 'normal',
                        done: m.done || false, author: m.author, authorName: m.author_name,
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
                return `<div class="card-item" style="${strike}"><div style="display:flex;align-items:center;gap:10px;"><input type="checkbox" ${m.done?'checked':''} onchange="toggleMemoDone('${m.id}', this.checked)"><span><strong style="color:${priorityColors[m.priority]}">[${priorityLabels[m.priority]}]</strong> ${escapeHtml(m.content)}</span></div><div class="card-meta"><span>${m.authorName}</span><span>${m.time}</span>${canDelete ? `<button class="submit-btn" style="padding:2px 8px;" onclick="deleteMemo('${m.id}')">删除</button>` : ''}${adminVisCtrl('memo', m.id, m.visibility)}</div></div>`;
            }).join('');
            document.getElementById('memoList').innerHTML = html || '<div style="color:#999;">暂无待办事项，添加你们的计划吧~</div>';
        }
        
        async function toggleMemoDone(id, done) {
            if (!(await canDeleteRecord('memos', id))) return;
            try { await sb.from('memos').update({ done: done }).eq('id', id); } catch(e) { console.error(e); }
            renderMemos();
        }
        
        async function deleteMemo(id) {
            if (!(await canDeleteRecord('memos', id))) return;
            if (!confirm('确定删除吗？\n删除后内容进入管理员后台「回收站」，可随时恢复。')) return;
            try { await trashApi('delete','memos',id); alert('已移入回收站'); } catch(e) { alert('删除失败：' + (e.message || e)); return; }
            renderMemos();
        }
        // ========== 行程模块 与 纪念日倒计时 ==========
        async function addSchedule() { 
            if (!(await requirePermission('full'))) return;
            let start = document.getElementById('scheduleStart').value; 
            let end = document.getElementById('scheduleEnd').value; 
            let title = document.getElementById('scheduleTitle').value.trim(); 
            if(!start || !title) { alert('请填写开始日期和行程标题'); return; } 
            
            const newSchedule = { author: currentUser, author_name: currentUser=='boy'?'👦 boy':(currentUser=='girl'?'👧 girl':currentUser), title: title, start_date: start, end_date: end || start, visibility: 'public' };
            try { 
                await sb.from('schedules').insert(newSchedule); 
                // 记录添加行程日志
                logAction('publish_schedule', { title: title.substring(0, 50), start_date: start, end_date: end || start });
            } catch(e) { console.error(e); }
            
            document.getElementById('scheduleStart').value = ''; 
            document.getElementById('scheduleEnd').value = ''; 
            document.getElementById('scheduleTitle').value = ''; 
            renderSchedules(); 
            addDanmaku(`${currentUser=='boy'?'👦 boy':(currentUser=='girl'?'👧 girl':currentUser)} 添加了新行程`); 
        }
        
        async function renderSchedules(options = {}) {
            if (!shouldReloadSection('todo-schedules', options && options.force)) return; 
            let schedules = [];
            try {
                const { data, error } = await selectContentRows('schedules', 'id,start_date,end_date,title,author,author_name,created_at,visibility', { limit: PAGE_LIMIT });
                if (!error && data) {
                    schedules = data.map(s => ({ id: s.id, start: s.start_date, end: s.end_date, title: s.title, author: s.author, authorName: s.author_name, time: new Date(s.created_at).toLocaleString(), visibility: normalizeVisibility(s.visibility) }));
                }
            } catch(e) {}
            schedules = schedules.filter(canViewRecord);
            markSectionLoaded('todo-schedules');
            
            let html = schedules.map(s => { 
                let canDelete = isAdmin || s.author === currentUser; 
                let dateHtml = `📅 ${formatPrettyDate(s.start)}`;
                if (s.end && s.end !== s.start) {
                    dateHtml += ` ～ ${formatPrettyDate(s.end)}`;
                }
                return `<div class="schedule-item"><div class="schedule-date">${dateHtml}</div><div>${escapeHtml(s.title)}</div><div class="card-meta"><span>✍️ ${s.authorName}</span><span>${s.time}</span>${canDelete ? `<button class="submit-btn" style="padding:2px 8px;" onclick="deleteSchedule('${s.id}')">删除</button>` : ''}${adminVisCtrl('schedule', s.id, s.visibility)}</div></div>`; 
            }).join(''); 
            document.getElementById('scheduleList').innerHTML = html || '<div style="color:#999;">暂无行程，添加你们的旅行计划吧~</div>'; 
        }
        
        async function deleteSchedule(id) { 
            if (!(await canDeleteRecord('schedules', id))) return;
            if (!confirm('确定删除吗？\n删除后内容进入管理员后台「回收站」，可随时恢复。')) return;
            try { await trashApi('delete','schedules',id); alert('已移入回收站'); } catch(e) { alert('删除失败：' + (e.message || e)); return; }
            renderSchedules(); 
        }
        
        async function addCountdown() { 
            if (!(await requirePermission('full'))) return;
            let name = document.getElementById('countdownName').value.trim(); 
            let date = document.getElementById('countdownDate').value; 
            if(!name || !date) { alert('请填写名称和日期'); return; } 
            
            const newCountdown = { author: currentUser, author_name: currentUser=='boy'?'👦 boy':(currentUser=='girl'?'👧 girl':currentUser), name: name, target_date: date, visibility: 'public' };
            try { 
                await sb.from('countdowns').insert(newCountdown); 
                // 记录添加纪念日日志
                logAction('publish_countdown', { name: name.substring(0, 50), target_date: date });
            } catch(e) { console.error(e); }
            
            document.getElementById('countdownName').value = ''; 
            document.getElementById('countdownDate').value = ''; 
            renderCountdowns(); 
            addDanmaku(`${currentUser=='boy'?'👦 boy':(currentUser=='girl'?'👧 girl':currentUser)} 添加了纪念日`); 
        }
        
        async function renderCountdowns(options = {}) {
            if (!shouldReloadSection('todo-countdowns', options && options.force)) return; 
            let countdowns = [];
            try {
                const { data, error } = await selectContentRows('countdowns', 'id,name,target_date,author,author_name,created_at,visibility', { limit: PAGE_LIMIT });
                if (!error && data) {
                    countdowns = data.map(c => ({ id: c.id, name: c.name, date: c.target_date, author: c.author, authorName: c.author_name, time: new Date(c.created_at).toLocaleString(), visibility: normalizeVisibility(c.visibility) }));
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
                html += `<div class="countdown-item"><span><strong>${escapeHtml(c.name)}</strong><br><span style="font-size:11px;color:#ff6b81;font-weight:500;">✨ ${prettyD}</span></span><span>${status}</span>${canDelete ? `<button class="submit-btn" style="padding:2px 8px;" onclick="deleteCountdown('${c.id}')">删除</button>` : ''}${adminVisCtrl('countdown', c.id, c.visibility)}</div>`; 
            } 
            document.getElementById('countdownList').innerHTML = html || '<div style="color:#999;">暂无纪念日，添加你们的特殊日子吧~</div>'; 
        }
        
        async function deleteCountdown(id) { 
            if (!(await canDeleteRecord('countdowns', id))) return;
            if (!confirm('确定删除吗？\n删除后内容进入管理员后台「回收站」，可随时恢复。')) return;
            try { await trashApi('delete','countdowns',id); alert('已移入回收站'); } catch(e) { alert('删除失败：' + (e.message || e)); return; }
            renderCountdowns(); 
        }
        // ========== 旅行地图 ==========
        function initMap() { 
            if(map) return; 
            map = L.map('map').setView([39.9042, 116.4074], 5); 
            L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { attribution: '&copy; OSM' }).addTo(map); 
            loadMarkers(); 
            map.on('click', (e) => { 
                let name = prompt('输入地点名称:', `记忆地点`); 
                if(name) addMarker(e.latlng.lat, e.latlng.lng, name); 
            }); 
        }
        async function loadMarkers(options = {}) { 
            if (!shouldReloadSection('travel', options && options.force)) return;
            markers = [];
            try {
                const { data, error } = await selectContentRows('travel_markers', 'id,lat,lng,name,description,author,author_name,created_at,visibility', { ascending: true, limit: MAP_LIMIT });
                if (!error && data) {
                    markers = data.map(m => ({
                        id: m.id, lat: m.lat, lng: m.lng, name: m.name, 
                        author: m.author, authorName: m.author_name, 
                        time: new Date(m.created_at).toLocaleString(), visibility: normalizeVisibility(m.visibility)
                    }));
                }
            } catch(e) {}
            markers = markers.filter(canViewRecord);
            markSectionLoaded('travel');
            
            if(map) {
                map.eachLayer(layer => { if(layer instanceof L.Marker) map.removeLayer(layer); });
                for(let m of markers) { 
                    L.marker([m.lat, m.lng]).addTo(map).bindPopup(`<b>${escapeHtml(m.name)}</b><br>📌 添加人：${m.authorName}<br>🕒 ${m.time || ''}`); 
                }
            }
            renderMarkerList(); 
        }
        async function addMarker(lat, lng, name) { 
            if (!(await requirePermission('full'))) return;
            const newMarker = { 
                lat, lng, name, 
                author: currentUser, 
                author_name: currentUser=='boy'?'👦 boy':(currentUser=='girl'?'👧 girl':currentUser),
                visibility: 'public'
            }; 
            try { 
                await sb.from('travel_markers').insert(newMarker); 
                // 记录添加地图标记日志
                logAction('publish_marker', { name: name.substring(0, 50), lat: lat, lng: lng });
            } catch(e) { console.error(e); }
            loadMarkers(); 
            addDanmaku(`${currentUser=='boy'?'👦 boy':(currentUser=='girl'?'👧 girl':currentUser)} 标记了地点：${name}`); 
        }
        function addMarkerFromInput() { 
            let name = document.getElementById('markerName').value.trim(); 
            if(!name) { alert('请输入地点名称'); return; } 
            if(map) { 
                let center = map.getCenter(); 
                addMarker(center.lat, center.lng, name); 
                document.getElementById('markerName').value = ''; 
            } else alert('地图未加载'); 
        }
        function renderMarkerList() { 
            let html = ''; 
            for(let m of markers.slice().reverse()) { 
                let canDelete = isAdmin || m.author === currentUser; 
                html += `<div class="map-marker-item"><span><strong>${escapeHtml(m.name)}</strong><br><span style="font-size:11px;color:#888;">👤 ${m.authorName} · ${m.time}</span></span>${canDelete ? `<button class="submit-btn" style="padding:4px 12px;font-size:12px;" onclick="deleteMarker('${m.id}')">删除</button>` : ''}${adminVisCtrl('marker', m.id, m.visibility)}</div>`; 
            } 
            document.getElementById('markerList').innerHTML = html || '<div style="color:#999;">暂无标记，点击地图添加回忆地点~</div>'; 
        }
        async function deleteMarker(id) { 
            if (!(await canDeleteRecord('travel_markers', id))) return;
            if (!confirm('确定删除吗？\n删除后内容进入管理员后台「回收站」，可随时恢复。')) return;
            try { await trashApi('delete','travel_markers',id); alert('已移入回收站'); } catch(e) { alert('删除失败：' + (e.message || e)); return; }
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
                    alert('已取消生气模式'); 
                } else { 
                    if (mode.id) {
                        await sb.from('angry_mode').update({ enabled: true, by: currentUser }).eq('id', mode.id);
                    } else {
                        await sb.from('angry_mode').insert({ enabled: true, by: currentUser });
                    }
                    // 记录开启生气模式日志
                    logAction('angry_on', {});
                    document.getElementById('angryBtn').innerText = '取消生气模式'; 
                    document.getElementById('angryStatus').innerHTML = '😠 已启用生气模式'; 
                    alert('生气模式已开启'); 
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
                    document.getElementById('angryStatus').innerHTML = '😠 已启用生气模式'; 
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
                document.getElementById('angryStatus').innerHTML = '😠 生气模式已开启（开启者：' + mode.by + '）';
            } else {
                document.getElementById('angryBtn').innerText = '启用生气模式'; 
                document.getElementById('angryStatus').innerHTML = '当前状态：没有生气，开开心心~';
            }
            
            let html = ap.map((a,idx)=>`<div class="card-item"><div>💔 ${escapeHtml(a.content)}</div><div class="card-meta">${a.fromName || a.from} · ${a.time} · ${a.status==='pass'?'✅ 已原谅':(a.status==='reject'?'❌ 未原谅':'⏳ 待审核')}</div>${((mode.enabled && mode.by===currentUser) || isAdmin) && a.status==='pending'?`<div><button class="submit-btn" onclick="reviewApology('${a.id}',true)">原谅</button> <button class="submit-btn" onclick="reviewApology('${a.id}',false)">拒绝</button></div>`:''}</div>`).join(''); 
            document.getElementById('apologyList').innerHTML = html || '暂无道歉记录'; 
        }
        async function submitApology(){ 
            if (!(await requirePermission('comment'))) return;
            let content = document.getElementById('apologyInput').value.trim(); 
            if(!content) { alert('写点道歉内容~'); return; } 
            
            try {
                await sb.from('apologies').insert({
                    content: content,
                    author: currentUser,
                    author_name: currentUser=='boy'?'👦 boy':(currentUser=='girl'?'👧 girl':currentUser),
                    status: 'pending'
                });
                // 记录提交道歉信日志
                logAction('apology_submit', { content: content.substring(0, 50) });
            } catch(e) {
                let ap = JSON.parse(localStorage.getItem('couple_apologies')||'[]');
                ap.unshift({ id:Date.now(), content:content, from:currentUser, fromName:currentUser=='boy'?'👦 boy':(currentUser=='girl'?'👧 girl':currentUser), time:new Date().toLocaleString(), status:'pending' });
                localStorage.setItem('couple_apologies', JSON.stringify(ap));
            }
            
            alert('道歉已提交，等待TA原谅~'); 
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
                    alert('已原谅，和好啦~');
                } else {
                    alert('未原谅，继续道歉吧~');
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
                const { data: configData } = await sb.from('bubble_config').select('id,enabled,interval').limit(1).maybeSingle();
                if (configData) {
                    bubbleEnabled = configData.enabled !== undefined ? configData.enabled : true;
                    bubbleIntervalSec = configData.interval || 12;
                }
                if (loadPhotos) {
                    const { data: photosData, error } = await sb.from('bubble_photos').select('id,photo_url').limit(100);
                    if (!error && photosData) floatPhotos = photosData.map(p => ({ dataUrl: p.photo_url, id: p.id }));
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
            document.getElementById('bubbleInterval').value=bubbleIntervalSec; 
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
            c.innerHTML=''; 
            floatPhotos.forEach((p,idx)=>{ 
                let d=document.createElement('div'); 
                d.className='preview-item'; 
                d.innerHTML=`<img src="${p.dataUrl}" loading="lazy" decoding="async"><span class="remove-photo" data-idx="${idx}">✖</span>`; 
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
            alert('背景气泡已保存，双方共享~'); 
        }
        function closeBubbleSettings(){ document.getElementById('bubbleSettingsModal').style.display='none'; }
        
        function createDreamBubble(url){ 
            if(!bubbleEnabled||activeBubbleCount>=1) return; 
            activeBubbleCount++; 
            let b=document.createElement('img'); 
            b.className='photo-bubble'; 
            b.src=url; 
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
                alert('会话已超时，请重新登录');
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
                    statusText = '🟢 在线';
                    statusColor = '#52c41a';
                } else if (diffSec < 300) {
                    statusText = `🟡 ${Math.floor(diffSec / 60)}分钟前`;
                    statusColor = '#faad14';
                } else {
                    statusText = '🔴 离线';
                    statusColor = '#ff4757';
                }
                
                const statusEl = document.getElementById('onlineStatus');
                if (statusEl) {
                    statusEl.innerHTML = `<span style="color:${statusColor};font-size:12px;">${otherUser.username === 'boy'?'👦':'👧'} ${statusText}</span>`;
                }
            } catch(e) {}
        }
        
        // ========== 后台管理模块 ==========
        // ===== 后台分区 Tab 框架（重设计：概览/用户/内容/回收站/日志/设置） =====
        var ADMIN_TABS = [
            { key: 'home', label: '🏠 概览' },
            { key: 'users', label: '👥 用户' },
            { key: 'content', label: '📦 内容' },
            { key: 'trash', label: '🗑️ 回收站', badge: true },
            { key: 'logs', label: '📋 日志' },
            { key: 'settings', label: '⚙️ 设置' }
        ];
        window.__adminTab = 'home';
        window.__adminUsers = null;
        window.__adminTrashCount = 0;

        function adminTabsHtml() {
            return ADMIN_TABS.map(function (t) {
                const badge = (t.badge && window.__adminTrashCount > 0) ? '<span class="adm-badge">' + window.__adminTrashCount + '</span>' : '';
                return '<button class="adm-tab ' + (window.__adminTab === t.key ? 'active' : '') + '" onclick="switchAdminTab(\'' + t.key + '\')">' + t.label + badge + '</button>';
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
            if (key === 'home') return renderAdminHome(el);
            if (key === 'users') return renderAdminUsers(el);
            if (key === 'content') return renderAdminContentTab(el);
            if (key === 'trash') return renderAdminTrashTab(el);
            if (key === 'logs') return renderAdminLogsTab(el);
            if (key === 'settings') return renderAdminSettingsTab(el);
        }

        function renderAdminHome(el) {
            const users = window.__adminUsers || {};
            const names = Object.keys(users);
            const adminCount = names.filter(function (n) { return n === 'admin' || users[n].role === 'admin'; }).length;
            el.innerHTML =
                '<div class="adm-card"><h3>📊 站点概览</h3>'
                + '<div class="adm-stat-grid">'
                + '<div class="adm-stat"><div class="num">' + names.length + '</div><div class="lbl">注册账号</div></div>'
                + '<div class="adm-stat"><div class="num">' + adminCount + '</div><div class="lbl">管理员</div></div>'
                + '<div class="adm-stat"><div class="num" id="homeTrashNum" style="color:#ff8a3d;">' + (window.__adminTrashCount || 0) + '</div><div class="lbl">回收站待处理</div></div>'
                + '<div class="adm-stat"><div class="num">8</div><div class="lbl">内容板块</div></div>'
                + '</div>'
                + '<div class="adm-quick">'
                + '<button onclick="switchAdminTab(\'users\')">👥 管理用户</button>'
                + '<button class="alt" onclick="switchAdminTab(\'content\')">📦 管理内容</button>'
                + '<button class="warn" onclick="switchAdminTab(\'trash\')">🗑️ 回收站</button>'
                + '<button class="gray" onclick="switchAdminTab(\'settings\')">⚙️ 设置</button>'
                + '</div></div>'
                + '<div class="adm-card"><h3>💡 使用提示</h3><div style="color:#777;font-size:13px;line-height:1.9;">删除的内容不会立刻消失，会进入「回收站」永久保留，可随时恢复或彻底删除。<br>点顶部「➕ 注册账号」可为对方开通账号。<br>「对外隐藏」的内容仅你们两人可见，不会出现在对外同步里。</div></div>';
        }

        function renderAdminUsers(el) {
            const users = window.__adminUsers || {};
            const permLabels = { full: '✏️ 完全权限', comment: '💬 仅评论', view: '👀 仅浏览' };
            let cards = '';
            for (const [uname, info] of Object.entries(users)) {
                const isAdm = uname === 'admin' || info.role === 'admin';
                const permission = info.permission || 'full';
                const initial = (uname[0] || '👤');
                cards += '<div class="adm-card adm-user">'
                    + '<div class="adm-user-head"><div class="adm-user-ava">' + escapeHtml(initial.toUpperCase()) + '</div>'
                    + '<div><div class="adm-user-name">' + escapeHtml(uname) + '<span class="adm-role-tag ' + (isAdm ? 'admin' : 'user') + '">' + (isAdm ? '👑 管理员' : '👤 普通用户') + '</span></div>'
                    + '<div class="adm-user-meta">' + (isAdm ? '👑 权限不受限制' : ('权限：' + (permLabels[permission] || permLabels.full))) + '</div></div></div>'
                    + '<div class="adm-user-actions">'
                    + '<button class="adm-ua-btn blue" onclick="openSetUserPasswordModal(\'' + uname + '\')">🔑 设置密码</button>'
                    + (uname === 'admin' ? '' : '<button class="adm-ua-btn green" onclick="toggleUserRole(\'' + uname + '\')">' + (isAdm ? '取消管理员' : '设为管理员') + '</button>')
                    + (!isAdm ? '<div class="adm-perm"><select onchange="setUserPermission(\'' + uname + '\', this.value)">'
                        + '<option value="full" ' + (permission === 'full' ? 'selected' : '') + '>✏️ 完全权限</option>'
                        + '<option value="comment" ' + (permission === 'comment' ? 'selected' : '') + '>💬 仅评论</option>'
                        + '<option value="view" ' + (permission === 'view' ? 'selected' : '') + '>👀 仅浏览</option></select></div>' : '')
                    + (!isAdm ? '<button class="adm-ua-btn red" onclick="deleteUserAccount(\'' + uname + '\')">🗑️ 删除账号</button>' : '')
                    + '</div></div>';
            }
            el.innerHTML = cards || '<div class="adm-empty">暂无用户</div>';
        }

        function renderAdminContentTab(el) {
            const sections = [
                ['feed', '📸 时光相册'], ['message', '💬 留言板'], ['love', '💌 感动的话'], ['memory', '✨ 一起做过的事'],
                ['memo', '📋 待办'], ['schedule', '📝 行程'], ['countdown', '⏰ 纪念日'], ['marker', '🗺️ 地图']
            ];
            el.innerHTML = '<div class="adm-card"><h3>📦 内容管理 · 按需加载</h3>'
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
            el.innerHTML = '<div class="adm-card"><div id="adminTrashSection" class="adm-loading">🗑️ 回收站加载中…</div></div>';
            loadTrashSection().catch(function (e) {
                const t = document.getElementById('adminTrashSection');
                if (t) t.innerHTML = '<div style="color:#c00;">回收站加载失败：' + escapeHtml(e.message || String(e)) + '</div>';
            });
        }

        var ADMIN_ACTION_LABELS = {
            login: '🔐 用户登录', logout: '🚪 用户登出', login_failed: '❌ 登录失败',
            publish_feed: '📸 发布相册', publish_message: '💬 发布留言', publish_love: '💌 发布感动',
            publish_memory: '✨ 添加回忆', publish_memo: '📋 添加待办', publish_schedule: '📝 添加行程',
            publish_countdown: '⏰ 添加纪念日', publish_marker: '🗺️ 添加地图标记',
            delete_feed: '🗑️ 删除相册', delete_message: '🗑️ 删除留言', delete_love: '🗑️ 删除感动',
            delete_memory: '🗑️ 删除回忆', delete_memo: '🗑️ 删除待办', delete_schedule: '🗑️ 删除行程',
            delete_countdown: '🗑️ 删除纪念日', delete_marker: '🗑️ 删除地图标记',
            like_feed: '❤️ 点赞动态', unlike_feed: '💔 取消点赞', like_message: '❤️ 点赞留言', unlike_message: '💔 取消点赞',
            comment_feed: '💬 评论动态', comment_message: '💬 评论留言',
            update_avatar: '🖼️ 更新头像', change_password: '🔑 修改密码',
            angry_on: '😠 开启生气模式', angry_off: '😊 关闭生气模式',
            apology_submit: '💌 提交道歉信', apology_pass: '✅ 道歉信通过', apology_reject: '❌ 道歉信驳回',
            admin_delete: '🔧 管理员删除', admin_reset_pwd: '🔧 重置密码', admin_delete_user: '🔧 删除账号',
            admin_create_user: '🔧 创建账号', admin_toggle_role: '🔧 切换角色', admin_set_permission: '🔧 设置权限',
            admin_toggle_visibility: '🔒 切换可见性', view_page: '👁️ 浏览页面', switch_tab: '🔄 切换标签'
        };
        function renderAdminLogsTab(el) {
            el.innerHTML = '<div class="adm-card"><h3>📋 操作日志</h3><div id="adminLogList" class="adm-loading">日志加载中…</div></div>';
            getAdminLogs().then(function (logs) {
                const box = document.getElementById('adminLogList');
                if (!box) return;
                if (!logs || !logs.length) { box.className = 'adm-empty'; box.textContent = '暂无日志记录'; return; }
                box.className = 'adm-log';
                box.innerHTML = logs.slice(0, ADMIN_LIMIT).map(function (log) {
                    let details = '';
                    try { const p = JSON.parse(log.details); details = Object.entries(p).map(function (kv) { return kv[0] + ': ' + String(kv[1]).substring(0, 20); }).join(', '); }
                    catch (e) { details = log.details ? String(log.details).substring(0, 30) : ''; }
                    return '<div class="adm-log-item"><div class="adm-log-act">' + (ADMIN_ACTION_LABELS[log.action] || log.action) + '</div>'
                        + '<div class="adm-log-meta">🕒 ' + new Date(log.created_at).toLocaleString() + '　👤 ' + escapeHtml(log.user || '') + '</div>'
                        + (details ? '<div class="adm-log-detail">' + escapeHtml(details) + '</div>' : '') + '</div>';
                }).join('');
            }).catch(function () {
                const box = document.getElementById('adminLogList');
                if (box) { box.className = 'adm-empty'; box.textContent = '日志加载失败，不影响其他功能。'; }
            });
        }

        function renderAdminSettingsTab(el) {
            el.innerHTML =
                '<div class="adm-card"><h3>📦 相册存储模式</h3>'
                + '<div class="adm-field"><span style="color:#666;font-size:14px;">照片/视频存放方式</span>'
                + '<select id="adminStorageModeSelect" onchange="adminSetStorageMode()">'
                + '<option value="cloud">☁️ 图床模式（无限容量）</option>'
                + '<option value="local">💾 本地存储（测试用）</option></select></div>'
                + '<div style="color:#999;font-size:12px;margin-top:10px;line-height:1.7;">图床模式把图片/视频存到 GitHub 私密仓库，不占数据库流量，建议保持。</div></div>'
                + '<div class="adm-card"><h3>🧑‍🤝‍🧑 账号</h3>'
                + '<button class="adm-ua-btn blue" style="width:100%;" onclick="showRegisterModal()">➕ 注册新账号</button></div>'
                + '<div id="adminQqSlot"></div>';
            const sel = document.getElementById('adminStorageModeSelect');
            if (sel) sel.value = storageMode || 'cloud';
            const slot = document.getElementById('adminQqSlot');
            if (slot) slot.innerHTML = renderQqSyncPanel();
        }

        // 内容条目卡片（替代旧表格，手机友好）
        function renderAdminCards(type, rows) {
            if (!rows || rows.length === 0) return '<div class="adm-empty">暂无数据</div>';
            const pl = { high: '🔴 高', medium: '🟡 中', low: '🟢 低' };
            return rows.map(function (row) {
                const time = row.created_at ? new Date(row.created_at).toLocaleString() : '';
                let title = '', extra = '', del = '';
                if (type === 'feed') { title = row.description || ''; del = '<button class="adm-del-btn" onclick="deleteFeed(\'' + row.id + '\')">删除</button>'; }
                else if (type === 'message') { title = row.content || ''; del = admDelBtn('message', row.id); }
                else if (type === 'love') { title = row.content || ''; extra = row.privacy === 'private' ? '🔒 私密' : '🌐 公开'; del = admDelBtn('love', row.id); }
                else if (type === 'memory') { title = row.content || ''; del = admDelBtn('memory', row.id); }
                else if (type === 'memo') { title = row.content || ''; extra = (pl[row.priority] || row.priority || '') + ' · ' + (row.done ? '✅ 已完成' : '⏳ 进行中'); del = admDelBtn('memo', row.id); }
                else if (type === 'schedule') { title = row.title || ''; extra = row.start_date ? (row.end_date ? row.start_date + ' ~ ' + row.end_date : row.start_date) : ''; del = admDelBtn('schedule', row.id); }
                else if (type === 'countdown') { title = row.name || ''; extra = row.target_date || ''; del = admDelBtn('countdown', row.id); }
                else if (type === 'marker') { title = row.name || ''; extra = row.description || ''; del = admDelBtn('marker', row.id); }
                const vis = renderVisibilityAdminControls(type, row.id, row.visibility);
                return '<div class="adm-item"><div class="adm-item-text">' + escapeHtml(title || '(无文字)').substring(0, 80) + '</div>'
                    + '<div class="adm-item-meta"><span>👤 ' + escapeHtml(row.author_name || '') + '</span>'
                    + (extra ? '<span>' + escapeHtml(extra) + '</span>' : '')
                    + '<span>🕒 ' + time + '</span></div>'
                    + '<div class="adm-item-foot"><div class="adm-vis">' + vis + '</div>' + del + '</div></div>';
            }).join('');
        }
        function admDelBtn(type, id) {
            return '<button class="adm-del-btn" onclick="adminDelete(\'' + type + '\',\'' + id + '\')">删除</button>';
        }

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
                alert(items.length ? `已导出 ${items.length} 条待同步内容。下一步双击“启动QQ空间同步.bat”。` : '没有新的公开内容需要同步。');
            } catch(e) {
                alert('导出失败：请先运行 docs/supabase-qzone-sync.sql，或检查网络连接。错误：' + e.message);
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
                alert('已生成 QQ空间发布预览.txt，可以先检查每条将要发布的文字。');
            } catch(e) {
                alert('生成预览失败：' + e.message);
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
                if (!items.length) { alert('发布结果里没有可导入的记录。'); return; }
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
                alert(`发布结果导入完成：已更新 ${ok} 条。已同步的内容下次不会再导出。`);
                renderAdminData();
            } catch(e) {
                alert('导入发布结果失败：' + e.message);
            }
        }

        function renderQqSyncStatusAdmin(row) {
            return `<span style="display:block;color:#666;font-size:12px;">${getQqSyncStatusLabel(row.qzone_sync_status)}</span>${row.qzone_synced_at ? `<span style="display:block;color:#999;font-size:11px;">${formatDateTimeText(row.qzone_synced_at)}</span>` : ''}`;
        }

        function renderAdminSectionShell() {
            const sections = [
                ['feed', '📸 时光相册'], ['message', '💬 留言板'], ['love', '💌 感动的话'], ['memory', '✨ 一起做过的事'],
                ['memo', '📋 待办备忘录'], ['schedule', '📝 行程安排'], ['countdown', '⏰ 纪念日倒计时'], ['marker', '🗺️ 旅行地图']
            ];
            return `<div class="admin-section"><h3>📦 内容管理 · 按需加载</h3><div style="display:flex;gap:8px;flex-wrap:wrap;">${sections.map(([type, label]) => `<button class="admin-btn" onclick="renderAdminContentSection('${type}')">${label}</button>`).join('')}</div><div id="adminContentSection" style="margin-top:12px;color:#888;">选择一个分类后再加载对应内容，避免后台一次拉取全部数据。</div></div>`;
        }
        
        function renderAdminRows(type, rows) {
            if (!rows || rows.length === 0) return '<tr><td colspan="6" style="text-align:center;color:#999;padding:20px;">暂无数据</td></tr>'; 
            return rows.map(row => {
                const time = row.created_at ? new Date(row.created_at).toLocaleString() : ''; 
                if (type === 'feed') return `<tr><td>${escapeHtml(row.description || '').substring(0,30)}</td><td>${row.author_name || ''}</td><td>${time}</td><td>${renderVisibilityAdminControls('feed', row.id, row.visibility)}</td><td><button class="admin-btn danger" onclick="deleteFeed('${row.id}')">删除</button></td></tr>`;
                if (type === 'message') return `<tr><td>${escapeHtml(row.content || '').substring(0,30)}</td><td>${row.author_name || ''}</td><td>${time}</td><td>${renderVisibilityAdminControls('message', row.id, row.visibility)}</td><td><button class="admin-btn danger" onclick="adminDelete('message', '${row.id}')">删除</button></td></tr>`;
                if (type === 'love') return `<tr><td>${escapeHtml(row.content || '').substring(0,30)}</td><td>${row.author_name || ''}</td><td>${row.privacy === 'private' ? '🔒 私密' : '公开'}</td><td>${time}</td><td>${renderVisibilityAdminControls('love', row.id, row.visibility)}</td><td><button class="admin-btn danger" onclick="adminDelete('love', '${row.id}')">删除</button></td></tr>`;
                if (type === 'memory') return `<tr><td>${escapeHtml(row.content || '').substring(0,30)}</td><td>${row.author_name || ''}</td><td>${time}</td><td>${renderVisibilityAdminControls('memory', row.id, row.visibility)}</td><td><button class="admin-btn danger" onclick="adminDelete('memory', '${row.id}')">删除</button></td></tr>`;
                if (type === 'memo') { const priorityLabels = { high: '🔴 高', medium: '🟡 中', low: '🟢 低' }; return `<tr><td>${escapeHtml(row.content || '').substring(0,30)}</td><td>${row.author_name || ''}</td><td>${priorityLabels[row.priority] || row.priority || ''}</td><td>${row.done ? '✅ 已完成' : '⏳ 进行中'}</td><td>${renderVisibilityAdminControls('memo', row.id, row.visibility)}</td><td><button class="admin-btn danger" onclick="adminDelete('memo', '${row.id}')">删除</button></td></tr>`; }
                if (type === 'schedule') { const dateRange = row.start_date ? (row.end_date ? `${row.start_date} ~ ${row.end_date}` : row.start_date) : ''; return `<tr><td>${escapeHtml(row.title || '').substring(0,20)}</td><td>${dateRange}</td><td>${row.author_name || ''}</td><td>${renderVisibilityAdminControls('schedule', row.id, row.visibility)}</td><td><button class="admin-btn danger" onclick="adminDelete('schedule', '${row.id}')">删除</button></td></tr>`; }
                if (type === 'countdown') return `<tr><td>${escapeHtml(row.name || '').substring(0,20)}</td><td>${row.target_date || ''}</td><td>${row.author_name || ''}</td><td>${renderVisibilityAdminControls('countdown', row.id, row.visibility)}</td><td><button class="admin-btn danger" onclick="adminDelete('countdown', '${row.id}')">删除</button></td></tr>`;
                if (type === 'marker') return `<tr><td>${escapeHtml(row.name || '').substring(0,15)}</td><td>${escapeHtml(row.description || '').substring(0,20)}</td><td>${row.author_name || ''}</td><td>${renderVisibilityAdminControls('marker', row.id, row.visibility)}</td><td><button class="admin-btn danger" onclick="adminDelete('marker', '${row.id}')">删除</button></td></tr>`;
                return '';
            }).join('');
        }
        
        async function renderAdminContentSection(type, options = {}) {
            if (!options.skipAdminCheck && !(await requireAdmin())) return;
            const target = document.getElementById('adminContentSection');
            if (!target) return;
            target.innerHTML = '<div style="color:#888;padding:12px;">正在加载...</div>'; 
            const configs = {
                feed: { title: '📸 时光相册动态', table: 'feeds', cols: 'id,description,author_name,created_at,visibility', headers: ['描述','作者','时间','可见性','操作'] },
                message: { title: '💬 留言板', table: 'messages', cols: 'id,content,author_name,created_at,visibility', headers: ['内容','作者','时间','可见性','操作'] },
                love: { title: '💌 感动的话', table: 'loves', cols: 'id,content,author_name,privacy,created_at,visibility', headers: ['内容','作者','隐私','时间','可见性','操作'] },
                memory: { title: '✨ 一起做过的事', table: 'memories', cols: 'id,content,author_name,created_at,visibility', headers: ['内容','作者','时间','可见性','操作'] },
                memo: { title: '📋 待办备忘录', table: 'memos', cols: 'id,content,author_name,priority,done,created_at,visibility', headers: ['内容','作者','优先级','状态','可见性','操作'] },
                schedule: { title: '📝 行程安排', table: 'schedules', cols: 'id,title,start_date,end_date,author_name,created_at,visibility', headers: ['标题','日期','作者','可见性','操作'] },
                countdown: { title: '⏰ 纪念日倒计时', table: 'countdowns', cols: 'id,name,target_date,author_name,created_at,visibility', headers: ['标题','目标日期','作者','可见性','操作'] },
                marker: { title: '🗺️ 旅行地图标记', table: 'travel_markers', cols: 'id,name,description,author_name,created_at,visibility', headers: ['名称','描述','作者','可见性','操作'] }
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
            return '<div class="admin-section" id="adminTrashSection" style="color:#888;">🗑️ 回收站加载中...</div>';
        }
        function fmtTrashTime(t) { try { return t ? new Date(t).toLocaleString() : ''; } catch(e) { return t || ''; } }
        async function loadTrashSection() {
            const target = document.getElementById('adminTrashSection');
            if (!target) return;
            const res = await trashApi('list');
            const items = res.items || [];
            window.__adminTrashCount = items.length;
            if (typeof refreshTrashBadge === 'function') { refreshTrashBadge(); const _hn = document.getElementById('homeTrashNum'); if (_hn) _hn.textContent = items.length; }
            if (!items.length) { target.innerHTML = '<h3>🗑️ 回收站</h3><div style="color:#888;padding:8px 0;">回收站是空的～删除的内容会出现在这里，可恢复或彻底删除。</div>'; return; }
            let html = '<h3>🗑️ 回收站（' + items.length + ' 条，永久保留）</h3>';
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
                    + '<button class="admin-btn" onclick="trashRestore(\'' + it.table + '\',\'' + it.id + '\')">♻️ 恢复</button>'
                    + '<button class="admin-btn danger" onclick="trashPurge(\'' + it.table + '\',\'' + it.id + '\')">🔥 彻底删除</button>'
                    + '</div></div>';
            });
            html += '</div>';
            target.innerHTML = html;
        }
        async function trashRestore(table, id) {
            if (!confirm('恢复这条内容吗？\n图片/视频将移回原位，内容重新在对应板块显示。')) return;
            try { await trashApi('restore', table, id); alert('已恢复'); await loadTrashSection(); renderAdminData(); }
            catch(e) { alert('恢复失败：' + (e.message || e)); }
        }
        async function trashPurge(table, id) {
            if (!confirm('⚠️ 彻底删除后不可恢复！')) return;
            if (!confirm('最后确认：永久删除这条内容及其图片/视频？')) return;
            try { await trashApi('purge', table, id); alert('已彻底删除'); await loadTrashSection(); }
            catch(e) { alert('彻底删除失败：' + (e.message || e)); }
        }
        async function renderAdminLogSection() {
            const logs = await getAdminLogs();
            const actionLabels = {
                login: '🔐 用户登录', logout: '🚪 用户登出', login_failed: '❌ 登录失败', publish_feed: '📸 发布相册', publish_message: '💬 发布留言',
                publish_love: '💌 发布感动', publish_memory: '✨ 添加回忆', publish_memo: '📋 添加待办', publish_schedule: '📝 添加行程',
                publish_countdown: '⏰ 添加纪念日', publish_marker: '🗺️ 添加地图标记', admin_delete: '🔧 管理员删除',
                admin_reset_pwd: '🔧 管理员重置密码', admin_delete_user: '🔧 管理员删除账号', admin_create_user: '🔧 管理员创建账号',
                admin_toggle_role: '🔧 切换用户角色', admin_set_permission: '🔧 设置用户权限', admin_toggle_visibility: '🔒 切换对外可见性'
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
            return `<div class="admin-section"><h3>📋 操作日志 (${logs ? logs.length : 0}条)</h3><div style="max-height:400px;overflow-y:auto;"><table class="data-table"><thead><tr><th>时间</th><th>用户</th><th>操作</th><th>详情</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
        }
        
        // ========== 管理后台通用删除函数 ==========
        async function adminDelete(type, id) {
            if (!confirm('确定删除这条内容吗？\n删除后进入「回收站」，可在回收站恢复或彻底删除。')) return;
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
                if (!table) { alert('未知类型'); return; }
                await trashApi('delete', table, id);
                // 记录管理员删除日志
                logAction('admin_delete', { type: type, id: id });
                renderAdminData();
            } catch(e) {
                alert('删除失败: ' + e.message);
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
                role: (info.role === 'admin' || username === 'admin') ? 'admin' : 'user'
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
        function mergeAdminLogs(remoteLogs = [], localLogs = []) {
            const seen = new Set();
            const merged = [];
            for (let log of [...localLogs, ...remoteLogs]) {
                const key = getLogKey(log);
                if (!key || seen.has(key)) continue;
                seen.add(key);
                merged.push(log);
            }
            return merged
                .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
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
                alert('头像已更新！'); 
            } catch(err) {
                alert('头像同步到云端失败：' + err.message);
            }
        }
        async function changePassword() { 
            let old = document.getElementById('oldPwd').value, 
                newPwd = document.getElementById('newPwd').value, 
                confirm = document.getElementById('confirmPwd').value; 
            if(newPwd !== confirm) { alert('两次新密码不一致'); return; } 
            if(newPwd.length < 4) { alert('密码至少4位'); return; } 
            try { 
                await accountApi('changePassword', { oldPassword: old, newPassword: newPwd });
                logAction('change_password', { success: true });
                alert('密码修改成功，请重新登录'); 
                logout(); 
            } catch(e) { 
                logAction('change_password', { success: false, reason: e.message });
                alert(e.message || '密码修改失败'); 
            }
        }
        async function registerNewUser() { 
            let newName = document.getElementById('newUsername').value.trim(); 
            let newPwd = document.getElementById('newUserPwd').value.trim(); 
            if(!newName || !newPwd) { alert('请填写账号和密码'); return; } 
            const btn = document.querySelector('#registerModal .submit-btn');
            if (btn) { btn.disabled = true; btn.innerText = '正在注册...'; }
            try { 
                await accountApi('createUser', { username: newName, password: newPwd }); 
            } catch(e) { 
                alert('注册失败：' + e.message);
                if (btn) { btn.disabled = false; btn.innerText = '注册'; }
                return;
            }
            document.getElementById('newUsername').value = ''; 
            document.getElementById('newUserPwd').value = ''; 
            closeModalById('registerModal'); 
            if(isAdmin) await renderAdminData(); 
            if (btn) { btn.disabled = false; btn.innerText = '注册'; }
            alert(`账号 ${newName} 注册成功，已经在后台列表刷新。`); 
        }
        function closeAdminPanel() { 
            document.getElementById('adminPanel').style.display = 'none'; 
        }
        function adminSetStorageMode() { 
            let select = document.getElementById('adminStorageModeSelect'); 
            storageMode = select.value; 
            localStorage.setItem('couple_storage_mode', storageMode); 
            alert(`已切换为 ${storageMode === 'cloud' ? '图床模式' : '本地模式'}`); 
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
            document.getElementById('togetherDaysDisplay').innerHTML=`💞 已相爱 ${diff} 天 💞`; 
        }
        function toggleDropdown(){ 
            let m=document.getElementById('dropdownMenu'); 
            m.style.display=m.style.display==='block'?'none':'block'; 
        }
        function openAvatarModal(){ document.getElementById('avatarModal').style.display='flex'; }
        function openPasswordModal(){ document.getElementById('passwordModal').style.display='flex'; }
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
            document.querySelectorAll('.section').forEach(sec => sec.classList.remove('active')); 
            document.getElementById(sectionName + 'Section').classList.add('active'); 
            document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active')); 
            document.querySelector(`.nav-btn[data-section="${sectionName}"]`).classList.add('active');
            currentTab = sectionName;
            refreshCurrentSection().catch(e => console.log('切换页面刷新出现微调')); 
            if(sectionName === 'travel') setTimeout(() => initMap(), 100); 
        }
        function escapeHtml(str){ 
            return String(str||'').replace(/[&<>]/g,function(m){return m==='&'?'&amp;':m==='<'?'&lt;':'&gt;';}); 
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
            return visibility === 'couple_only' ? '🔒 仅情侣可见' : '🌍 公开';
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
            const badge = n === 'couple_only' ? '<span class="vis-badge">🔒 仅情侣可见</span>' : '';
            const label = n === 'couple_only' ? '🔓 恢复公开' : '🌐 对外隐藏';
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
            if (!table) { alert('未知内容类型'); return; }
            const hiding = nextVisibility === 'couple_only';
            const confirmTip = hiding
                ? '确定要把这条内容设为「仅情侣可见」吗？\n\n设置后，外部账号（如 test）将看不到这条，你和女朋友、管理员仍能看到。'
                : '确定要把这条内容「恢复公开」吗？\n\n恢复后所有账号都能看到。';
            if (!confirm(confirmTip)) return;
            try {
                const { error } = await sb.from(table).update({ visibility: nextVisibility }).eq('id', id);
                if (error) throw error;
                logAction('admin_toggle_visibility', { type, id, visibility: nextVisibility });
                if (document.getElementById('adminContentSection')) renderAdminContentSection(type);
                else renderAdminData();
                refreshCurrentSection().catch(e => console.log('可见性切换后刷新当前页面失败:', e));
                alert(hiding ? '✅ 已设为「仅情侣可见」，外部账号看不到了' : '✅ 已恢复公开，所有账号可见');
            } catch(e) {
                alert('切换可见性失败：请先在 Supabase 执行 docs/supabase-visibility.sql。错误：' + e.message);
            }
        }
        
        function openImageModal(src){ src = imgProxy(src); 
            const imgs = Array.from(document.querySelectorAll('#galleryContainer img, #messageList img'));
            currentPhotosList = imgs.map(img => img.src);
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
                alert(`当前账号没有“${labels[required] || required}”权限，请联系管理员调整权限${extra}`);
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
                if (!isAdmin) alert('无权限：只有管理员可以操作这里');
                return isAdmin;
            } catch(e) {
                alert('无法确认管理员权限，请检查 Supabase users 表和网络连接。错误：' + e.message);
                return false;
            }
        }
        async function canDeleteRecord(table, id) {
            if (!(await hasPermission('full'))) {
                alert('删除内容需要“完整权限”，请联系管理员调整权限');
                return false;
            }
            if (isAdmin) return true;
            try {
                const { data, error } = await sb.from(table).select('author').eq('id', id).maybeSingle();
                if (!error && data && data.author === currentUser) return true;
            } catch(e) {}
            alert('只能删除自己发布的内容，或让管理员删除');
            return false;
        }
        async function ensureCommentMutationAllowed(comment) {
            if (!(await hasPermission('comment'))) {
                alert('删除评论需要“评论/点赞”权限，请联系管理员调整权限');
                return false;
            }
            if (isAdmin || (comment && comment.author === currentUser)) return true;
            alert('只能删除自己的评论，或让管理员删除');
            return false;
        }
        async function showRegisterModal() {
            if (!(await requireAdmin())) return;
            document.getElementById('registerModal').style.display='flex';
        }
        async function openAdminPanel() {
            if (isAdmin && currentUserInfo) {
                document.getElementById('adminPanel').style.display = 'block';
                document.getElementById('adminContent').innerHTML = '<div class="admin-section" style="color:#888;">后台正在加载...</div>'; 
                renderAdminData().catch(e => {
                    document.getElementById('adminContent').innerHTML = `<div class="admin-section" style="color:#c00;line-height:1.7;">后台加载失败：${escapeHtml(e.message || String(e))}<br>请刷新页面后再试。</div>`;
                });
                return;
            }
            document.getElementById('adminPanel').style.display = 'block';
            document.getElementById('adminContent').innerHTML = '<div class="admin-section" style="color:#888;">正在确认管理员权限...</div>'; 
            if (!(await requireAdmin())) { closeAdminPanel(); return; }
            document.getElementById('adminPanel').style.display = 'block';
            renderAdminData().catch(e => {
                document.getElementById('adminContent').innerHTML = `<div class="admin-section" style="color:#c00;line-height:1.7;">后台加载失败：${escapeHtml(e.message || String(e))}<br>请刷新页面后再试。</div>`;
            });
        }
        async function deleteUserAccount(username) {
            if (!(await requireAdmin())) return;
            if(username === 'admin') { alert('不能删除管理员账号'); return; }
            try {
                await accountApi('deleteUser', { username });
            } catch(e) { alert('删除账号失败：' + e.message); return; }
            logAction('admin_delete_user', { username: username });
            renderAdminData();
            alert(`账号 ${username} 已删除`);
        }
        async function toggleUserRole(username) {
            if (!(await requireAdmin())) return;
            if (username === 'admin') { alert('不能修改超级管理员的角色'); return; }
            try {
                const result = await accountApi('toggleUserRole', { username });
                logAction('admin_toggle_role', { username: username, new_role: result.user && result.user.role });
                renderAdminData();
                alert(`已将 ${username} 设为${result.user && result.user.role === 'admin' ? '管理员' : '普通用户'}`);
            } catch(e) { alert('保存角色失败：' + e.message); }
        }
        async function setUserPermission(username, permission) {
            if (!(await requireAdmin())) return;
            if (username === 'admin') { alert('不能修改超级管理员的权限'); return; }
            if (!['view', 'comment', 'full'].includes(permission)) { alert('权限值不正确'); return; }
            try {
                await accountApi('setUserPermission', { username, permission });
                logAction('admin_set_permission', { username: username, permission: permission });
                const permLabels = { 'full': '完全权限', 'comment': '仅评论', 'view': '仅浏览' };
                alert(`已将 ${username} 的权限设为：${permLabels[permission]}`);
                renderAdminData();
            } catch(e) { alert('保存权限失败：' + e.message); }
        }
        async function setUserPassword() {
            if (!(await requireAdmin())) return;
            const username = document.getElementById('setPwdUsername').value.trim();
            const newPassword = document.getElementById('setPwdNew').value;
            const confirm = document.getElementById('setPwdConfirm').value;
            if (!username) { alert('用户不存在'); return; }
            if (newPassword !== confirm) { alert('两次新密码不一致'); return; }
            if (newPassword.length < 4) { alert('密码至少4位'); return; }
            const btn = document.querySelector('#setUserPasswordModal .submit-btn');
            if (btn) { btn.disabled = true; btn.innerText = '正在保存...'; }
            try {
                await accountApi('setUserPassword', { username, newPassword });
                logAction('admin_reset_pwd', { username: username });
                closeModalById('setUserPasswordModal');
                await renderAdminData();
                alert(`${username} 的密码已更新，已经立即生效。`);
            } catch(e) { 
                alert('设置密码失败：' + e.message); 
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
            if(!u || !p) { alert('请输入账号和密码'); return; }
            if(btn) { btn.disabled = true; btn.innerText = '正在登录...'; }
            try {
                const result = await accountApi('login', { username: u, password: p });
                setSession(result.user.username, result.sessionToken);
                const users = {}; users[result.user.username] = normalizeUserInfo(result.user.username, result.user);
                enterMainSystem(result.user.username, users);
            } catch(e) {
                logAction('login_failed', { username: u, reason: e.message });
                alert('登录失败：' + e.message);
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
            document.getElementById('displayUsername').innerHTML = username==='boy'?'👦 boy':(username==='girl'?'👧 girl':username);
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
            document.querySelectorAll('.nav-btn').forEach(btn => { btn.onclick = function() { 
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
