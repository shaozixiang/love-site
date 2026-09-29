/* ===== 我们的小站 PWA · 核心逻辑 =====
 * 设计原则（针对旧站卡顿病因）：
 *  1) 增量渲染：只往列表头部插入新卡片，绝不整块 innerHTML 重建（保住滚动位置与已渲染图片）
 *  2) 增量同步：轮询只拉 created_at > last 的新行，不反复全量查询
 *  3) 离线优先：数据进 IndexedDB、图片经 Service Worker 缓存，二次打开秒出、弱网不卡
 *  4) 轻依赖：原生 JS，无地图/弹幕/动画库，主线程只做必要工作
 */
'use strict';

/* ---------- 配置（与线上一致；如需更换填这里） ---------- */
const CONFIG = {
  SUPABASE_URL: 'https://txeynuvttibnilvttieu.supabase.co',
  SUPABASE_ANON: 'sb_publishable_Z8E9qPbi6F2NLzoQh9fhfw__goWiZZ4',
  API_BASE: '', // 同域：/api/account、/api/upload-to-github
  TABLES: ['messages', 'feeds', 'memories', 'loves', 'schedules', 'countdowns', 'memos', 'travel_markers', 'apologies', 'angry_mode', 'bubble_config'],
  POLL_MS: 30000,
};

/* ---------- 工具 ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtTime = (t) => {
  if (!t) return '';
  const d = new Date(t); if (isNaN(d)) return String(t).slice(0, 10);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth()+1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const nowIso = () => new Date().toISOString();
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const displayName = (u) => u === 'boy' ? '👦 猪猪' : (u === 'girl' ? '👧 宝宝' : u);
const avatarOf = (u) => u === 'boy' ? '👦' : '👧';

/* ---------- IndexedDB 封装 ---------- */
const DB = (() => {
  let dbP;
  const open = () => dbP || (dbP = new Promise((res, rej) => {
    const req = indexedDB.open('couple_pwa', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const t of CONFIG.TABLES) if (!db.objectStoreNames.contains(t)) db.createObjectStore(t, { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  }));
  const tx = async (store, mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const o = t.objectStore(store);
      const r = fn(o);
      t.oncomplete = () => res(r && r.result !== undefined ? r.result : undefined);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    putAll: (store, rows) => tx(store, 'readwrite', o => rows.forEach(x => o.put(x))),
    get: (store, id) => tx(store, 'readonly', o => o.get(id)),
    all: (store) => tx(store, 'readonly', o => o.getAll()),
    del: (store, id) => tx(store, 'readwrite', o => o.delete(id)),
    clear: (store) => tx(store, 'readwrite', o => o.clear()),
    metaGet: (k) => tx('meta', 'readonly', o => o.get(k)),
    metaSet: (k, v) => tx('meta', 'readwrite', o => o.put(v, k)),
  };
})();

/* ---------- Supabase REST（anon 公钥） ---------- */
const supabase = {
  _headers() { return { 'apikey': CONFIG.SUPABASE_ANON, 'Authorization': 'Bearer ' + CONFIG.SUPABASE_ANON, 'Content-Type': 'application/json' }; },
  select(table, { filter = '', order = 'created_at.desc', limit = 1000 } = {}) {
    let url = `${CONFIG.SUPABASE_URL}/rest/v1/${table}?select=*&order=${order}&limit=${limit}`;
    if (filter) url += '&' + filter;
    return fetch(url, { headers: this._headers() }).then(r => { if (!r.ok) throw new Error(`${table} 查询失败 ${r.status}`); return r.json(); });
  },
  insert(table, row) {
    return fetch(`${CONFIG.SUPABASE_URL}/rest/v1/${table}`, { method: 'POST', headers: this._headers(), body: JSON.stringify(row) })
      .then(r => { if (!r.ok) return r.text().then(t => { throw new Error(`${table} 写入失败 ${r.status}: ${t.slice(0, 120)}`); }); return r.json(); });
  },
  update(table, id, patch) {
    return fetch(`${CONFIG.SUPABASE_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', headers: this._headers(), body: JSON.stringify(patch) })
      .then(r => { if (!r.ok) throw new Error(`${table} 更新失败 ${r.status}`); });
  },
};

/* ---------- 账号（同域 /api/account，与网站共用登录体系） ---------- */
const Auth = {
  user: null, token: null,
  async login(u, p) {
    const r = await fetch(`${CONFIG.API_BASE}/api/account`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'login', username: u, password: p }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.user) throw new Error(j.error || `登录失败 ${r.status}`);
    this.user = j.user; this.token = j.sessionToken;
    localStorage.setItem('cw_user', JSON.stringify(j.user));
    localStorage.setItem('cw_token', j.sessionToken);
    return j.user;
  },
  async restore() {
    const u = localStorage.getItem('cw_user'); const t = localStorage.getItem('cw_token');
    if (!u || !t) return null;
    this.user = JSON.parse(u); this.token = t;
    try {
      const r = await fetch(`${CONFIG.API_BASE}/api/account`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'me', sessionToken: t }),
      });
      const j = await r.json();
      if (r.ok && j.user) this.user = j.user;
    } catch (_) {} // 离线时用本地身份
    return this.user;
  },
  logout() { localStorage.removeItem('cw_user'); localStorage.removeItem('cw_token'); this.user = this.token = null; },
  get isAdmin() { return this.user && (this.user.username === 'admin' || this.user.role === 'admin'); },
};

/* ---------- 同步引擎（全量 + 增量） ---------- */
const Sync = {
  syncing: false,
  async fullSync() {
    await DB.metaSet('last_sync', {});
    for (const t of CONFIG.TABLES) {
      try { await this.pullTable(t, null); } catch (e) { console.warn(t, e); }
    }
  },
  async incremental() {
    const marks = (await DB.metaGet('last_sync')) || {};
    for (const t of CONFIG.TABLES) {
      try { await this.pullTable(t, marks[t] || null); } catch (_) {}
    }
  },
  async pullTable(t, last) {
    const rows = last
      ? await supabase.select(t, { filter: `created_at=gt.${encodeURIComponent(last)}` })
      : await supabase.select(t);
    if (!rows || !rows.length) return;
    await DB.putAll(t, rows);
    const marks = (await DB.metaGet('last_sync')) || {};
    const newest = rows.reduce((m, r) => r.created_at > m ? r.created_at : m, marks[t] || '');
    if (newest) { marks[t] = newest; await DB.metaSet('last_sync', marks); }
    await App.onNewRows(t, rows);
  },
};

/* ---------- 图片上传（复用网站接口） ---------- */
async function uploadMedia(file) {
  const fd = new FormData();
  fd.append('file', file, file.name || 'media');
  fd.append('folder', 'app');
  fd.append('mediaType', file.type.startsWith('video') ? 'video' : 'image');
  const r = await fetch(`${CONFIG.API_BASE}/api/upload-to-github`, { method: 'POST', body: fd });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.url) throw new Error(j.error || '上传失败，请确认已部署在线上');
  return j.url;
}

/* ---------- 应用状态与渲染 ---------- */
const App = {
  tab: 'messages',
  rendered: {},          // table -> Set(已渲染 id)，避免重复
  cache: {},             // table -> 最新行（渲染用）
  evt: new EventTarget(),
  onNewRows(t, rows) { this.evt.dispatchEvent(new CustomEvent('rows', { detail: { t, rows } })); },

  async boot() {
    // 注册 Service Worker（离线缓存）
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW:', e));
    }
    const user = await Auth.restore();
    if (user) { this.enterMain(); } else { this.showLogin(); }
    this.bindEvents();
  },

  showLogin() { $('#loginPage').hidden = false; $('#mainPage').hidden = true; },
  enterMain() {
    $('#loginPage').hidden = true; $('#mainPage').hidden = false;
    this.loadAllLocal().then(() => this.switchTab('messages'));
    // 打开即同步一次，然后前台轮询增量
    Sync.fullSync().catch(() => {}).finally(() => {});
    setInterval(() => { if (document.visibilityState === 'visible') Sync.incremental().catch(() => {}); }, CONFIG.POLL_MS);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') Sync.incremental().catch(() => {}); });
  },

  /* 本地秒开：先渲染 IndexedDB 已有数据 */
  async loadAllLocal() {
    for (const t of CONFIG.TABLES) {
      const rows = await DB.all(t);
      rows.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
      this.cache[t] = rows;
    }
    this.renderCurrent();
  },

  switchTab(t) {
    this.tab = t;
    $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
    const titles = { messages: '留言板', gallery: '时光相册', memories: '回忆', love: '爱你', more: '更多' };
    $('#topTitle').textContent = titles[t];
    this.renderCurrent();
  },

  renderCurrent() {
    const el = $('#content');
    const fn = { messages: this.renderMessages, gallery: this.renderGallery, memories: this.renderMemories, love: this.renderLove, more: this.renderMore }[this.tab];
    el.innerHTML = '';
    this.rendered[this.tab] = new Set();
    fn.call(this, el);
  },

  /* ----- 留言板 ----- */
  renderMessages(el) {
    const rows = (this.cache.messages || []).slice(0, 60);
    el.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const m of rows) frag.appendChild(this.messageCard(m));
    el.appendChild(frag);
    el.appendChild(this.composeBar());
    this.rendered.messages = new Set(rows.map(r => r.id));
  },
  messageCard(m) {
    const card = document.createElement('div'); card.className = 'card'; card.dataset.id = m.id;
    const likes = (m.likes || []).map(String);
    const liked = likes.includes(Auth.user?.username);
    const comments = (m.comments || []).slice(0, 3);
    const media = m.photo ? `<div class="card-media"><img src="${esc(m.photo)}" loading="lazy" decoding="async" onclick="App.viewImage('${esc(m.photo)}')"></div>` : '';
    card.innerHTML = `
      <div class="card-head">
        <div class="avatar">${avatarOf(m.author)}</div>
        <div><div class="card-name">${esc(m.authorName || displayName(m.author))}</div><div class="card-time">${fmtTime(m.created_at)}</div></div>
      </div>
      ${m.content ? `<div class="card-text">${esc(m.content)}</div>` : ''}
      ${media}
      <div class="card-actions">
        <button class="act-btn ${liked ? 'liked' : ''}" onclick="App.toggleLike('messages','${m.id}',this)">${liked ? '❤️' : '🤍'} ${likes.length ? likes.length : '赞'}</button>
        <button class="act-btn" onclick="App.openComment('messages','${m.id}')">💬 ${comments.length ? comments.length : '评论'}</button>
      </div>
      ${comments.length ? `<div class="comments">${comments.map(c => `<div class="comment-line"><b>${esc(c.authorName || c.author)}：</b>${esc(c.content)}<span class="comment-time">${fmtTime(c.time)}</span></div>`).join('')}</div>` : ''}`;
    return card;
  },
  composeBar() {
    const bar = document.createElement('button');
    bar.className = 'card compose-bar'; bar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;color:var(--text-soft);font-size:14px;border:none;cursor:pointer;';
    bar.innerHTML = '<span>💬 说点什么…</span><span style="color:var(--pink)">✍️</span>';
    bar.onclick = () => App.openCompose('messages');
    return bar;
  },

  /* ----- 相册（朋友圈九宫格） ----- */
  renderGallery(el) {
    const rows = (this.cache.feeds || []).slice(0, 60);
    el.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const f of rows) frag.appendChild(this.feedCard(f));
    el.appendChild(frag);
    const bar = document.createElement('button');
    bar.className = 'card compose-bar'; bar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;color:var(--text-soft);font-size:14px;border:none;cursor:pointer;';
    bar.innerHTML = '<span>📸 发一条新动态…</span><span style="color:var(--pink)">📷</span>';
    bar.onclick = () => App.openCompose('feeds');
    el.appendChild(bar);
    this.rendered.gallery = new Set(rows.map(r => r.id));
  },
  feedCard(f) {
    const card = document.createElement('div'); card.className = 'card'; card.dataset.id = f.id;
    const likes = (f.likes || []).map(String);
    const liked = likes.includes(Auth.user?.username);
    const comments = (f.comments || []).slice(0, 3);
    const medias = (f.media || []).filter(x => x && x.data);
    let grid = '';
    if (medias.length) {
      const cls = medias.length === 1 ? 'grid-1' : (medias.length === 2 ? 'grid-2' : 'grid-3');
      grid = `<div class="grid ${cls}">${medias.slice(0, 9).map((mm, i) => {
        const isV = mm.type === 'video';
        return `<div class="grid-cell ${isV ? 'video' : ''}" style="position:relative" onclick="App.viewMedia('${esc(mm.data)}',${isV})">${isV ? '<div class="video-badge">▶</div>' : ''}<img src="${esc(mm.data)}" loading="lazy" decoding="async"></div>`;
      }).join('')}</div>`;
    }
    card.innerHTML = `
      <div class="card-head">
        <div class="avatar">${avatarOf(f.author)}</div>
        <div><div class="card-name">${esc(f.authorName || displayName(f.author))}</div><div class="card-time">${fmtTime(f.created_at)}</div></div>
      </div>
      ${f.desc ? `<div class="card-text">${esc(f.desc)}</div>` : ''}
      ${grid}
      <div class="card-actions">
        <button class="act-btn ${liked ? 'liked' : ''}" onclick="App.toggleLike('feeds','${f.id}',this)">${liked ? '❤️' : '🤍'} ${likes.length ? likes.length : '赞'}</button>
        <button class="act-btn" onclick="App.openComment('feeds','${f.id}')">💬 ${comments.length ? comments.length : '评论'}</button>
      </div>
      ${comments.length ? `<div class="comments">${comments.map(c => `<div class="comment-line"><b>${esc(c.authorName || c.author)}：</b>${esc(c.content)}<span class="comment-time">${fmtTime(c.time)}</span></div>`).join('')}</div>` : ''}`;
    return card;
  },

  /* ----- 回忆 / 爱你 / 更多 ----- */
  renderMemories(el) {
    const sec = (title, emoji, rows, fmt) => {
      const wrap = document.createElement('div'); wrap.className = 'section';
      wrap.innerHTML = `<h3 style="font-size:15px;margin:14px 2px 8px;color:var(--pink)">${emoji} ${title}</h3>`;
      const list = document.createElement('div');
      if (!rows.length) { list.innerHTML = '<div class="empty" style="padding:22px 0">还没有记录</div>'; }
      else for (const r of rows.slice(0, 20)) {
        const d = document.createElement('div'); d.className = 'card';
        d.innerHTML = `<div class="card-head"><div class="avatar" style="font-size:15px">${emoji}</div><div><div class="card-name">${esc(fmt(r) || r.title || r.content || '')}</div><div class="card-time">${fmtTime(r.created_at)}</div></div></div>`;
        list.appendChild(d);
      }
      wrap.appendChild(list); return wrap;
    };
    const mem = (this.cache.memories || []);
    const todo = (this.cache.schedules || []);
    const count = (this.cache.countdowns || []);
    el.appendChild(sec('打卡回忆', '🌟', mem, r => `${r.content || r.title || ''}`));
    el.appendChild(sec('行程计划', '🗺️', todo, r => `${r.title || r.place || ''}${r.date ? ' · ' + String(r.date).slice(0, 10) : ''}`));
    el.appendChild(sec('纪念日', '⏳', count, r => `${r.title || ''}${r.date ? ' · ' + String(r.date).slice(0, 10) : ''}`));
  },
  renderLove(el) {
    const rows = (this.cache.loves || []).slice(0, 40);
    const wrap = document.createElement('div');
    wrap.innerHTML = '<h3 style="font-size:15px;margin:10px 2px 10px;color:var(--pink)">💗 说给彼此的话</h3>';
    if (!rows.length) wrap.innerHTML += '<div class="empty" style="padding:34px 0"><span class="big">💗</span>还没有情话</div>';
    for (const r of rows) {
      const d = document.createElement('div'); d.className = 'card';
      d.innerHTML = `<div class="card-text" style="font-size:15.5px">${esc(r.content || '')}</div>
        <div style="margin-top:8px;font-size:11.5px;color:var(--text-soft)">${esc(r.authorName || displayName(r.author))} · ${fmtTime(r.created_at)}</div>`;
      wrap.appendChild(d);
    }
    const add = document.createElement('button'); add.className = 'card compose-bar';
    add.style.cssText = 'display:flex;align-items:center;justify-content:space-between;color:var(--text-soft);font-size:14px;border:none;cursor:pointer;width:100%;';
    add.innerHTML = '<span>💌 写一句情话…</span><span style="color:var(--pink)">➤</span>';
    add.onclick = () => App.openLoveCompose();
    wrap.appendChild(add);
    el.appendChild(wrap);
  },
  renderMore(el) {
    const u = Auth.user || {};
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="card" style="text-align:center;padding:22px">
        <div class="avatar" style="width:54px;height:54px;font-size:26px;margin:0 auto 10px">${avatarOf(u.username)}</div>
        <div style="font-size:16px;font-weight:600">${esc(u.username)}</div>
        <div style="font-size:12px;color:var(--text-soft);margin-top:4px">${Auth.isAdmin ? '管理员' : '恋人'} · 数据已离线保存</div>
      </div>`;
    const item = (icon, title, sub, fn) => `<div class="more-item" onclick="${fn}"><span><span class="m-icon">${icon}</span>${title}<div class="m-sub">${sub}</div></span><span style="color:var(--text-soft)">›</span></div>`;
    wrap.innerHTML += `<div class="card" style="padding:4px 12px">
      ${item('🤖', 'AI 助手设置', '填入 API Key 后可让小站 AI 帮发留言、查数据', 'App.openAiSettings()')}
      ${item('🧹', '清空本地缓存', '重新下载全部数据（解决显示异常）', 'App.clearLocal()')}
      ${item('🚪', '退出登录', '', 'App.logout()')}
    </div>`;
    el.appendChild(wrap);
  },

  /* ----- 新数据增量插入（不动已有 DOM） ----- */
  onNewRows(t, rows) {
    if (!rows || !rows.length || !this.cache[t]) return;
    const known = this.cache[t];
    const seen = new Set(known.map(r => r.id));
    const fresh = rows.filter(r => !seen.has(r.id)).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    if (!fresh.length) return;
    this.cache[t] = [...fresh, ...known];
    // 只刷新当前可见板块
    const key = t === 'messages' ? 'messages' : (t === 'feeds' ? 'gallery' : null);
    if (!key || this.tab !== key) return;
    const el = $('#content');
    const list = el.firstElementChild;
    if (!list) return;
    const frag = document.createDocumentFragment();
    const maker = t === 'messages' ? this.messageCard : this.feedCard;
    for (const r of fresh) {
      if (this.rendered[key].has(r.id)) continue;
      this.rendered[key].add(r.id);
      frag.appendChild(maker.call(this, r));
    }
    if (frag.childElementCount) list.insertBefore(frag, list.firstChild);
    if (fresh.length) this.toast(`收到 ${fresh.length} 条新内容`);
  },
  toast(msg) {
    let t = $('#toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; t.style.cssText = 'position:fixed;top:calc(14px + env(safe-area-inset-top));left:50%;transform:translateX(-50%);z-index:90;background:rgba(60,30,40,.85);color:#fff;font-size:13px;padding:10px 18px;border-radius:999px;transition:opacity .3s'; document.body.appendChild(t); }
    t.textContent = msg; t.style.opacity = 1;
    clearTimeout(t._tm); t._tm = setTimeout(() => t.style.opacity = 0, 2200);
  },

  /* ----- 写操作 ----- */
  async toggleLike(t, id, btn) {
    try {
      const row = (this.cache[t] || []).find(r => r.id === id);
      const likes = (row?.likes || []).map(String);
      const me = Auth.user?.username;
      if (likes.includes(me)) likes.splice(likes.indexOf(me), 1); else likes.push(me);
      await supabase.update(t, id, { likes });
      await Sync.pullTable(t, null);
      this.renderCurrent();
    } catch (e) { this.toast('点赞失败：' + e.message); }
  },
  openComment(t, id) {
    const row = (this.cache[t] || []).find(r => r.id === id);
    const text = prompt(`评论 ${row?.authorName || ''} 的内容：`);
    if (!text || !text.trim()) return;
    this.addComment(t, id, text.trim());
  },
  async addComment(t, id, content) {
    try {
      const row = (this.cache[t] || []).find(r => r.id === id);
      const comments = (row?.comments || []).slice();
      comments.unshift({ author: Auth.user.username, authorName: displayName(Auth.user.username), content, time: nowIso() });
      await supabase.update(t, id, { comments });
      await Sync.pullTable(t, null);
      this.renderCurrent();
      this.toast('评论已发送');
    } catch (e) { this.toast('评论失败：' + e.message); }
  },

  /* ----- 发留言 / 动态 ----- */
  openCompose(t) {
    this._composeTable = t;
    $('#composeTitle').textContent = t === 'messages' ? '发留言' : '发动态';
    $('#composeText').value = ''; $('#composePreview').hidden = true; $('#composeFile').value = '';
    $('#composeLayer').hidden = false;
  },
  openLoveCompose() {
    this._composeTable = 'loves';
    $('#composeTitle').textContent = '写情话';
    $('#composeText').value = ''; $('#composePreview').hidden = true; $('#composeFile').value = '';
    $('#composeLayer').hidden = false;
  },
  async sendCompose() {
    const t = this._composeTable;
    const text = $('#composeText').value.trim();
    const file = $('#composeFile').files[0];
    if (!text && !file) return this.toast('写点内容再发吧');
    const btn = $('#composeSend'); btn.disabled = true; btn.textContent = '发送中…';
    try {
      const row = {
        id: uid(), author: Auth.user.username, authorName: displayName(Auth.user.username), created_at: nowIso(),
      };
      if (t === 'messages') { row.content = text; if (file) row.photo = await uploadMedia(file); }
      else if (t === 'feeds') { row.desc = text; if (file) { const url = await uploadMedia(file); row.media = [{ type: 'image', data: url }]; } }
      else if (t === 'loves') { row.content = text; row.author = Auth.user.username; }
      await supabase.insert(t, row);
      await Sync.pullTable(t, null);
      $('#composeLayer').hidden = true;
      this.renderCurrent();
      this.toast('发送成功 💗');
    } catch (e) { this.toast('发送失败：' + e.message); }
    finally { btn.disabled = false; btn.textContent = '发送'; }
  },

  /* ----- 图片/视频查看 ----- */
  viewImage(url) { window.open(url, '_blank'); },
  viewMedia(url, isVideo) {
    if (isVideo) window.open(url, '_blank');
    else this.viewImage(url);
  },
  async clearLocal() {
    if (!confirm('确定清空本地缓存重新下载？')) return;
    for (const t of CONFIG.TABLES) await DB.clear(t);
    await DB.metaSet('last_sync', {});
    this.cache = {}; this.rendered = {};
    await this.loadAllLocal();
    this.toast('本地数据已重置');
  },
  logout() { Auth.logout(); this.showLogin(); },

  /* ----- AI 悬浮窗 ----- */
  openAiSettings() {
    const key = localStorage.getItem('cw_ai_key') || '';
    const base = localStorage.getItem('cw_ai_base') || 'https://api.openai.com/v1';
    const model = localStorage.getItem('cw_ai_model') || 'gpt-4o-mini';
    const k = prompt('OpenAI 兼容 API Key：', key); if (k === null) return;
    const b = prompt('接口地址（默认 OpenAI）：', base) || base;
    const m = prompt('模型名：', model) || model;
    localStorage.setItem('cw_ai_key', k.trim()); localStorage.setItem('cw_ai_base', b.trim()); localStorage.setItem('cw_ai_model', m.trim());
    this.toast('AI 设置已保存');
  },
};

/* ---------- 事件绑定 ---------- */
App.bindEvents = function () {
  // Tab 切换
  $$('.tab-btn').forEach(b => b.onclick = () => this.switchTab(b.dataset.tab));
  $('#syncBtn').onclick = async () => { this.toast('正在同步…'); try { await Sync.incremental(); this.toast('已是最新'); } catch (e) { this.toast('同步失败：' + e.message); } };
  // 登录
  $('#loginBtn').onclick = async () => {
    const u = $('#loginUser').value.trim(), p = $('#loginPass').value.trim();
    if (!u || !p) return;
    const btn = $('#loginBtn'); btn.disabled = true; btn.textContent = '进入中…';
    $('#loginError').textContent = '';
    try { await Auth.login(u, p); this.enterMain(); }
    catch (e) { $('#loginError').textContent = e.message; }
    finally { btn.disabled = false; btn.textContent = '进入小站'; }
  };
  $('#loginPass').onkeydown = (e) => { if (e.key === 'Enter') $('#loginBtn').click(); };
  // 弹层
  $$('[data-close]').forEach(x => x.onclick = () => { $('#' + x.dataset.close).hidden = true; });
  $('#composeFile').onchange = () => {
    const f = $('#composeFile').files[0];
    if (f) { $('#composePreview').src = URL.createObjectURL(f); $('#composePreview').hidden = false; }
  };
  $('#composeSend').onclick = () => this.sendCompose();
  // AI
  $('#aiFab').onclick = () => { $('#aiPanel').hidden = !$('#aiPanel').hidden; if (!$('#aiPanel').hidden && !$('#aiMsgs').childElementCount) Ai.hello(); };
  $('#aiClose').onclick = () => $('#aiPanel').hidden = true;
  $('#aiSend').onclick = () => Ai.send();
  $('#aiInput').onkeydown = (e) => { if (e.key === 'Enter') Ai.send(); };
  // 行新增事件
  this.evt.addEventListener('rows', (e) => this.onNewRows(e.detail.t, e.detail.rows));
};

/* ---------- AI 助手（OpenAI 兼容接口） ---------- */
const Ai = {
  msgs: [],
  hello() { this.push('bot', '嗨～我是小站 AI 💗 我可以：\n· 查最新留言/动态\n· 帮你发留言（例：帮我发留言“晚安”)\n· 回答问题\n先到「更多 → AI 助手设置」填 API Key 哦'); },
  push(role, text) {
    const d = document.createElement('div'); d.className = 'ai-msg ' + role; d.textContent = text;
    $('#aiMsgs').appendChild(d); $('#aiMsgs').scrollTop = 99999;
    this.msgs.push({ role: role === 'bot' ? 'assistant' : 'user', content: text });
  },
  async send() {
    const q = $('#aiInput').value.trim(); if (!q) return;
    $('#aiInput').value = '';
    this.push('user', q);
    const key = localStorage.getItem('cw_ai_key');
    if (!key) { this.push('bot', '还没填 API Key：更多 → AI 助手设置'); return; }
    this.push('sys', '思考中…');
    const toolText = await this.runTools(q);
    const base = localStorage.getItem('cw_ai_base') || 'https://api.openai.com/v1';
    const model = localStorage.getItem('cw_ai_model') || 'gpt-4o-mini';
    try {
      const r = await fetch(base.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({ model, messages: [...this.msgs.slice(-8), { role: 'system', content: '你是这对情侣的小站助手，语气温柔可爱。' + toolText }], temperature: 0.8 }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error?.message || `HTTP ${r.status}`);
      const text = j.choices?.[0]?.message?.content || '';
      this.msgs.pop(); // 移除思考中
      this.msgs = this.msgs.slice(-14);
      this.push('bot', text.trim());
    } catch (e) {
      this.msgs.pop();
      this.push('bot', '调用失败：' + e.message);
    }
  },
  /* 简单工具：查数据 / 发留言 */
  async runTools(q) {
    let info = '';
    try {
      const latestMsg = (App.cache.messages || []).slice(0, 3).map(m => `${m.authorName}: ${(m.content || '').slice(0, 50)}`).join('\n');
      const latestFeed = (App.cache.feeds || []).slice(0, 3).map(f => `${f.authorName}: ${(f.desc || '').slice(0, 50)}`).join('\n');
      info = `\n\n[小站数据] 最新留言：\n${latestMsg || '无'}\n\n最新动态：\n${latestFeed || '无'}`;
    } catch (_) {}
    if (/发(留言|动态)|帮我(发|写)/.test(q)) {
      const m = q.match(/发(留言|动态)[：: ]?(.*)/);
      if (m && m[2]) {
        try {
          const t = m[1] === '留言' ? 'messages' : 'feeds';
          const row = { id: uid(), author: Auth.user.username, authorName: displayName(Auth.user.username), created_at: nowIso() };
          if (t === 'messages') row.content = m[2].trim();
          else row.desc = m[2].trim();
          await supabase.insert(t, row);
          await Sync.pullTable(t, null);
          App.renderCurrent();
          info += `\n[已执行] 已用你的账号发布${m[1]}：${m[2].trim()}`;
        } catch (e) { info += `\n[执行失败] ${e.message}`; }
      }
    }
    return info;
  },
};

/* ---------- 启动 ---------- */
App.boot();
