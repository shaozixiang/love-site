/* ============================================================
 * 登录页背景（login-bg）—— 两版共用
 * - 登录页背景播放器：照片轮播（Ken Burns 动态）/ 视频 / 混合，4 模板，音乐与原声
 * - 设置编辑器：管理员后台 tab + 被授权用户入口（总开关/授权列表仅管理员）
 * - 媒体上传走 /api/upload-to-github（folder=loginbg，服务端校验权限）
 * ============================================================ */
(function () {
  'use strict';

  var __lbg = {
    cfg: null,            // 线上生效配置
    built: false,         // 播放器是否已构建
    timer: null, idx: 0, list: [],
    mode: 'photos', order: 'sequence', duration: 6,
    audio: null, audioUnlocked: false,
    videoEls: [], soundEl: null,
    dirty: false,         // 编辑器保存后置 true，下次登录页可见时重建
    draft: null,          // 编辑器草稿
    usersCache: null
  };

  // ---------- 基础工具 ----------
  function lbgApi(action, payload) {
    return fetch('/api/login-bg', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Couple-Token': window.getSessionToken ? window.getSessionToken() : '' },
      body: JSON.stringify(Object.assign({ action: action, sessionToken: window.getSessionToken ? window.getSessionToken() : '' }, payload || {}))
    }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status)); return j; }); });
  }
  function lbgToast(msg, type) { if (window.toast) { window.toast(msg, type); } else { alert(msg); } }
  function lbgEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function lbgIcon(id, cls) { return '<svg class="lui-icon ' + (cls || 's16') + '"><use href="assets/icons.svg#' + id + '"/></svg>'; }

  // ---------- 播放器引擎 ----------
  // 私有仓库媒体统一走站内代理：jsdelivr/raw 直链对私有仓库必 404，前端兜底归一化
  function lbgNormalizeUrl(u) {
    if (!u) return u;
    var s = String(u).trim();
    var m = s.match(/^https:\/\/cdn\.jsdelivr\.net\/gh\/[^/]+\/[^/]+@[^/]+\/(.+)$/);
    if (m) return '/api/img/' + m[1];
    m = s.match(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/(?:main|master)\/(.+)$/);
    if (m) return '/api/img/' + m[1];
    return s;
  }

  function lbgBuildList(cfg) {
    var items = (cfg && Array.isArray(cfg.items)) ? cfg.items.slice() : [];
    for (var k = 0; k < items.length; k++) { if (items[k]) items[k].url = lbgNormalizeUrl(items[k].url); }
    var mode = cfg.mode || 'photos';
    var list = [];
    if (mode === 'photos') list = items.filter(function (i) { return i.kind === 'photo'; });
    else if (mode === 'video') list = items.filter(function (i) { return i.kind === 'video'; });
    else list = items; // mixed
    if (cfg.order_mode === 'random') {
      for (var i = list.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = list[i]; list[i] = list[j]; list[j] = t; }
    }
    return list;
  }

  function lbgClearPlayer(container) {
    if (!container) return;
    var kids = container.querySelectorAll('.lbg-layer, video.lbg-video, .lbg-overlay, .lbg-sound-hint');
    for (var i = 0; i < kids.length; i++) kids[i].remove();
  }

  function lbgStopPlayer() {
    if (__lbg.timer) { clearTimeout(__lbg.timer); __lbg.timer = null; }
    for (var i = 0; i < __lbg.videoEls.length; i++) { try { __lbg.videoEls[i].pause(); } catch (e) {} }
    __lbg.videoEls = [];
    if (__lbg.audio) { try { __lbg.audio.pause(); } catch (e) {} }
  }

  // 构建播放器到指定容器（登录页 / 预览浮层共用）
  function lbgBuildPlayer(container, cfg, opts) {
    opts = opts || {};
    // 关键：同步当前配置，播放器内所有判断（video_sound 等）以本次构建的 cfg 为准
    __lbg.cfg = cfg;
    lbgStopPlayer();
    lbgClearPlayer(container);
    __lbg.mode = cfg.mode || 'photos';
    __lbg.order = cfg.order_mode || 'sequence';
    __lbg.duration = Number(cfg.photo_duration) || 6;
    __lbg.list = lbgBuildList(cfg);
    __lbg.idx = 0;

    var loginPage = document.getElementById('loginPage');
    if (loginPage) {
      loginPage.classList.remove('lbg-t1', 'lbg-t2', 'lbg-t3', 'lbg-t4');
      loginPage.classList.add('lbg-' + (cfg.template || 't1'));
    }
    if (opts.preview) {
      container.classList.remove('lbg-t1', 'lbg-t2', 'lbg-t3', 'lbg-t4');
      container.classList.add('lbg-' + (cfg.template || 't1'));
    }

    // 蒙版层
    var overlay = document.createElement('div');
    overlay.className = 'lbg-overlay';
    container.appendChild(overlay);

    // 空列表：预览给友好提示（绝不纯黑屏），登录页给 toast
    if (!__lbg.list.length) {
      container.style.display = 'block';
      var empty = document.createElement('div');
      empty.className = 'lbg-empty';
      empty.innerHTML = opts.preview
        ? '预览：还没有背景媒体<br><span style="opacity:.7;font-size:12px;">回到设置上传照片或视频后再预览</span>'
        : '背景列表为空，请在管理后台「登录页背景」里上传';
      container.appendChild(empty);
      if (!opts.preview && !opts.silent) lbgToast('背景列表为空：请先在设置里上传照片或视频。', 'error');
      return;
    }

    container.style.display = 'block';
    if (opts.preview) container.classList.add('lbg-preview-active');

    // 加载提示层（媒体 ready 后移除，避免黑屏无反馈）
    var status = document.createElement('div');
    status.className = 'lbg-status';
    status.textContent = '背景加载中…';
    container.appendChild(status);

    // 音频（播放由全局首次交互解锁触发，见 lbgGlobalUnlock）
    if (cfg.music_enabled && cfg.music_url) {
      if (!__lbg.audio) { __lbg.audio = new Audio(); __lbg.audio.loop = true; __lbg.audio.preload = 'auto'; }
      if (opts.allowSound && __lbg.audioUnlocked) {
        __lbg.audio.src = cfg.music_url;
        __lbg.audio.play().catch(function () {});
      }
    } else if (__lbg.audio) { try { __lbg.audio.pause(); __lbg.audio.src = ''; } catch (e) {} }

    if (opts.allowSound && (cfg.music_enabled || cfg.video_sound)) {
      var hint = document.createElement('div');
      hint.className = 'lbg-sound-hint';
      hint.textContent = '点击页面任意处开启声音';
      container.appendChild(hint);
    }

    lbgActivate(container, 0, false);
  }

  // 激活第 idx 个媒体
  function lbgActivate(container, idx, unlocked) {
    if (__lbg.timer) { clearTimeout(__lbg.timer); __lbg.timer = null; }
    if (!__lbg.list.length) return;
    if (idx >= __lbg.list.length) {
      // 一轮结束：随机模式重新洗牌
      if (__lbg.order === 'random') __lbg.list = lbgBuildList({ mode: __lbg.mode, order_mode: 'random', items: __lbg.list });
      idx = 0;
    }
    __lbg.idx = idx;
    var item = __lbg.list[idx];
    var active = container.querySelector('.lbg-layer.active, video.lbg-video.active');
    if (active) { active.classList.remove('active'); if (active.tagName === 'VIDEO') { try { active.pause(); } catch (e) {} } }

    var status = container.querySelector('.lbg-status');
    var cfg = __lbg.cfg || {};

    if (item.kind === 'photo') {
      // 清理视频
      var vids = container.querySelectorAll('video.lbg-video');
      for (var i = 0; i < vids.length; i++) { try { vids[i].pause(); } catch (e) {} vids[i].remove(); }
      // 预加载校验：失败自动跳到下一项（避免黑屏一直挂着）
      var probe = new Image();
      probe.onload = function () { if (status) status.style.display = 'none'; };
      probe.onerror = function () {
        lbgActivate(container, idx + 1, true);
        return;
      };
      probe.src = item.url;
      var layer = document.createElement('div');
      layer.className = 'lbg-layer lbg-photo' + (item.dynamic ? ' dynamic' : '');
      layer.style.backgroundImage = 'url("' + item.url.replace(/"/g, '%22') + '")';
      layer.classList.add('active');
      container.appendChild(layer);
      // 音乐接管
      lbgHandleAudio(container, true);
      __lbg.timer = setTimeout(function () { lbgActivate(container, idx + 1, true); }, __lbg.duration * 1000);
    } else {
      // 视频
      var vids2 = container.querySelectorAll('video.lbg-video');
      for (var j = 0; j < vids2.length; j++) { try { vids2[j].pause(); } catch (e) {} vids2[j].remove(); }
      var v = document.createElement('video');
      v.className = 'lbg-video active';
      v.src = item.url;
      v.playsInline = true;
      v.preload = 'auto';
      v.setAttribute('playsinline', '');
      v.setAttribute('webkit-playsinline', '');
      // 原声开关：视频原声开启且已解锁 → 有声；否则静音
      var soundOn = !!(cfg.video_sound) && (__lbg.audioUnlocked || (container.dataset.sound === '1'));
      v.muted = !soundOn;
      v.loop = false;
      container.appendChild(v);
      __lbg.videoEls.push(v);
      // 首帧就绪后隐藏"加载中"
      v.addEventListener('loadeddata', function () { if (status) status.style.display = 'none'; });
      v.addEventListener('playing', function () { if (status) status.style.display = 'none'; });
      // 自动播放兜底：带声音被浏览器拦截时，立即降级为静音重试（保证画面出来）
      var tryPlay = function (muted) {
        if (muted) v.muted = true;
        var p = v.play();
        if (p && p.catch) p.catch(function () {
          if (!v.muted) tryPlay(true); // 有声失败 → 静音重试
          else if (status) { status.textContent = '视频格式可能不受支持，已跳过'; setTimeout(function () { lbgActivate(container, idx + 1, true); }, 1200); }
        });
      };
      tryPlay(false);
      lbgHandleAudio(container, !soundOn);
      // 单视频：纯原生 loop（浏览器标准无缝循环；不做手动回卷——seek 跳变会在部分设备上引起"突然跳一下+短暂黑"）
      if (__lbg.list.length === 1) {
        v.loop = true;
      }
      v.addEventListener('ended', function () { lbgActivate(container, idx + 1, true); });
      v.addEventListener('error', function () { lbgActivate(container, idx + 1, true); });
      __lbg.timer = setTimeout(function () { lbgActivate(container, idx + 1, true); }, Math.max(8, Math.min(30, (item.maxSec || 15))) * 1000);
    }
  }

  // 全局首次交互解锁（浏览器自动播放策略：点一下页面任意处才出声）
  function lbgGlobalUnlock() {
    if (__lbg.audioUnlocked) return;
    __lbg.audioUnlocked = true;
    var cfg = __lbg.cfg || {};
    if (__lbg.audio && cfg.music_enabled && cfg.music_url) {
      __lbg.audio.src = cfg.music_url;
      __lbg.audio.play().catch(function () {});
    }
    // 当前视频若有原声 → 取消静音
    for (var i = 0; i < __lbg.videoEls.length; i++) {
      var v = __lbg.videoEls[i];
      if (v && v.classList && v.classList.contains('active') && cfg.video_sound) {
        v.muted = false; try { v.play(); } catch (e) {}
      }
    }
    var hint = document.querySelector('.lbg-sound-hint');
    if (hint) hint.remove();
  }

  // 音乐与视频原声协调：playingMusic=true 表示当前是照片（音乐接管），false 表示视频原声接管
  function lbgHandleAudio(container, playingMusic) {
    var cfg = __lbg.cfg || {};
    var sound = !!(cfg.video_sound);
    if (__lbg.audio) {
      if (playingMusic && cfg.music_enabled && cfg.music_url && __lbg.audioUnlocked) {
        if (!__lbg.audio.src || __lbg.audio.src.indexOf(cfg.music_url) < 0) __lbg.audio.src = cfg.music_url;
        __lbg.audio.play().catch(function () {});
      } else {
        try { __lbg.audio.pause(); } catch (e) {}
      }
    }
  }

  // ---------- 登录页集成 ----------
  function initLoginBg() {
    lbgApi('getConfig', {}).then(function (cfg) {
      __lbg.cfg = cfg;
      var player = document.getElementById('loginBgPlayer');
      if (!player) return;
      if (!cfg || !cfg.enabled) { player.style.display = 'none'; return; }
      lbgBuildPlayer(player, cfg, { allowSound: true });
    }).catch(function (e) { /* 表未初始化等静默：登录页保持原样；下次 tick 重试 */ __lbg.built = false; });
  }

  function lbgResume() {
    var player = document.getElementById('loginBgPlayer');
    if (!player || !__lbg.list.length) return;
    lbgActivate(player, __lbg.idx || 0, true);
  }

  function lbgTick() {
    var lp = document.getElementById('loginPage');
    if (!lp) return;
    // 注意：#loginPage 是 position:fixed，offsetParent 恒为 null，不能用它判断可见性
    var visible = lp.style.display !== 'none' && lp.getBoundingClientRect().height > 0;
    if (visible) {
      if (!__lbg.built) { __lbg.built = true; initLoginBg(); }
      else if (__lbg.dirty) { __lbg.dirty = false; initLoginBg(); }
      else if (__lbg.paused) { __lbg.paused = false; lbgResume(); }
    } else if (__lbg.built) {
      // 登录页不可见（已登录/未打开）→ 暂停播放器省电，避免后台空转
      if (!__lbg.paused) { __lbg.paused = true; lbgStopPlayer(); }
    }
  }

  // ---------- 编辑器 ----------
  var LBG_TEMPLATES = [
    { id: 't1', name: '沉浸全屏', desc: '照片铺满整屏 + 柔和渐变', prev: 'linear-gradient(160deg,#d96a8c,#7e3550 70%,#2a1420)' },
    { id: 't2', name: '磨砂玻璃', desc: '背景清晰 + 卡片磨砂质感', prev: 'linear-gradient(150deg,#e88aa8,#a85272 55%,#5c2b40)' },
    { id: 't3', name: '景深虚化', desc: '背景模糊 + 卡片清晰醒目', prev: 'linear-gradient(150deg,#b36a86,#f2b7c8 30%,#8a415c 90%)' },
    { id: 't4', name: '轻语极简', desc: '浅色通透 + 温柔留白', prev: 'linear-gradient(150deg,#f7e3ea,#eec2d3 45%,#d9a0b8)' }
  ];

  function lbgSeg(id, options, current, label) {
    return '<div style="margin:14px 0 4px;"><div class="lui-label">' + label + '</div>'
      + '<div class="lui-segmented" id="' + id + '" style="margin-top:6px;">'
      + options.map(function (o) {
        return '<button type="button" data-v="' + o.v + '" class="' + (current === o.v ? 'active' : '') + '" onclick="window.__lbgSetSeg(\'' + id + '\', \'' + o.v + '\', this)">' + o.t + '</button>';
      }).join('') + '</div></div>';
  }
  var LBG_SEG_KEYS = { lbgModeSeg: 'mode', lbgOrderSeg: 'order_mode' };
  window.__lbgSetSeg = function (id, v, btn) {
    var wrap = document.getElementById(id);
    if (!wrap) return;
    var btns = wrap.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) btns[i].classList.remove('active');
    btn.classList.add('active');
    __lbgDraftSet(LBG_SEG_KEYS[id] || id, v);
  };

  function __lbgDraftSet(key, value) {
    if (!__lbg.draft) return;
    __lbg.draft[key] = value;
    if (key === 'music_enabled') {
      var mu = document.getElementById('lbgMusicWrap');
      if (mu) mu.style.display = value ? 'block' : 'none';
    }
    if (key === 'mode') { lbgRefreshListWarn(); }
  }
  window.__lbgDraftSet = __lbgDraftSet;

  function lbgRefreshListWarn() {
    var d = __lbg.draft; if (!d) return;
    var warn = document.getElementById('lbgModeWarn');
    if (!warn) return;
    var items = d.items || [];
    if (d.mode === 'photos' && !items.some(function (i) { return i.kind === 'photo'; })) warn.textContent = '当前模式「照片组」：还没有照片，请上传。';
    else if (d.mode === 'video' && !items.some(function (i) { return i.kind === 'video'; })) warn.textContent = '当前模式「视频」：还没有视频，请上传。';
    else if (d.mode === 'mixed' && items.length === 0) warn.textContent = '混合模式：请至少上传一个照片或视频。';
    else warn.textContent = '';
  }

  function lbgRenderMediaList() {
    var d = __lbg.draft; if (!d) return;
    var box = document.getElementById('lbgMediaList');
    if (!box) return;
    var items = d.items || [];
    if (!items.length) { box.innerHTML = '<div class="lui-mini" style="color:var(--ink-3); padding:8px 0;">还没有背景媒体，点击下方「上传照片/视频」添加。</div>'; return; }
    box.innerHTML = items.map(function (it, idx) {
      var isVid = it.kind === 'video';
      return '<div class="lbg-media-row">'
        + '<div class="lbg-thumb">' + (isVid ? '<video src="' + lbgEsc(it.url) + '" muted playsinline preload="metadata"></video>' : '<img src="' + lbgEsc(it.url) + '" alt="">') + '</div>'
        + '<div class="lbg-media-main"><div class="lui-mini" style="font-weight:600;color:var(--ink);">' + (isVid ? '视频' : '照片') + ' #' + (idx + 1) + '</div>'
        + (isVid ? '' : '<label class="lui-label" style="display:inline-flex;align-items:center;gap:5px;margin-top:4px;cursor:pointer;"><input type="checkbox" ' + (it.dynamic ? 'checked' : '') + ' onchange="window.__lbgToggleDynamic(' + idx + ', this.checked)"> 动态效果</label>')
        + '</div>'
        + '<div class="lbg-actions">'
        + '<button class="lui-btn icon sm" onclick="window.__lbgMove(' + idx + ',-1)" title="上移">' + lbgIcon('i-arrow-up-right', 's14') + '</button>'
        + '<button class="lui-btn icon sm" onclick="window.__lbgMove(' + idx + ',1)" title="下移">' + lbgIcon('i-arrow-down', 's14') + '</button>'
        + '<button class="lui-btn icon sm danger" onclick="window.__lbgDel(' + idx + ')" title="删除">' + lbgIcon('i-trash', 's14') + '</button>'
        + '</div></div>';
    }).join('');
    lbgRefreshListWarn();
  }
  window.__lbgToggleDynamic = function (idx, on) { if (__lbg.draft && __lbg.draft.items[idx]) { __lbg.draft.items[idx].dynamic = on; lbgRenderMediaList(); } };
  window.__lbgMove = function (idx, dir) {
    var d = __lbg.draft; if (!d) return;
    var items = d.items; var ni = idx + dir;
    if (ni < 0 || ni >= items.length) return;
    var t = items[idx]; items[idx] = items[ni]; items[ni] = t;
    lbgRenderMediaList();
  };
  window.__lbgDel = function (idx) {
    var d = __lbg.draft; if (!d) return;
    d.items.splice(idx, 1); lbgRenderMediaList();
  };

  // HEVC/H.265 检测：读文件头找 hev1/hvc1 标记（iPhone 录制默认格式，桌面/安卓浏览器基本不能解码）
  function lbgDetectHevc(file) {
    return new Promise(function (resolve) {
      try {
        var reader = new FileReader();
        reader.onload = function () {
          try {
            var bytes = new Uint8Array(reader.result);
            var str = '';
            for (var i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
            resolve(/hev1|hvc1/i.test(str));
          } catch (e) { resolve(false); }
        };
        reader.onerror = function () { resolve(false); };
        reader.readAsArrayBuffer(file.slice(0, Math.min(file.size, 1024 * 1024)));
      } catch (e) { resolve(false); }
    });
  }

  // HEVC → WebM(VP9/VP8) 前端转码：canvas 逐帧重绘 + MediaRecorder，全平台浏览器可播放
  function lbgTranscodeToWebm(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var v = document.createElement('video');
      v.muted = false; v.playsInline = true; v.preload = 'auto'; v.src = url;
      var timer = setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} reject(new Error('视频读取超时')); }, 15000);
      v.onloadedmetadata = function () {
        var w = v.videoWidth, h = v.videoHeight;
        if (!w || !h) { clearTimeout(timer); URL.revokeObjectURL(url); reject(new Error('无法读取视频信息')); return; }
        var maxW = 960;
        var scale = Math.min(1, maxW / w);
        var cw = Math.round(w * scale), ch = Math.round(h * scale);
        var canvas = document.createElement('canvas');
        canvas.width = cw; canvas.height = ch;
        var ctx = canvas.getContext('2d');
        var mixed = new MediaStream();
        try {
          canvas.captureStream(30).getVideoTracks().forEach(function (t) { mixed.addTrack(t); });
          if (typeof v.captureStream === 'function') {
            v.captureStream().getAudioTracks().forEach(function (t) { mixed.addTrack(t); });
          }
        } catch (e) {}
        var mime = (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('video/webm;codecs=vp9')) ? 'video/webm;codecs=vp9' : 'video/webm';
        var rec;
        try { rec = new MediaRecorder(mixed, { mimeType: mime, videoBitsPerSecond: 2000000 }); }
        catch (e) { clearTimeout(timer); URL.revokeObjectURL(url); reject(new Error('当前浏览器不支持视频转码，请改用 Safari 或换 H.264 视频')); return; }
        var chunks = [];
        rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
        rec.onstop = function () {
          clearTimeout(timer);
          URL.revokeObjectURL(url);
          var blob = new Blob(chunks, { type: 'video/webm' });
          if (blob.size < 1024) { reject(new Error('转码失败')); return; }
          blob.name = 'background.webm';
          resolve(blob);
        };
        rec.onerror = function () { clearTimeout(timer); URL.revokeObjectURL(url); reject(new Error('转码失败，请重试')); };
        var draw = function () {
          if (v.ended) { try { rec.stop(); } catch (e) {} return; }
          try { ctx.drawImage(v, 0, 0, cw, ch); } catch (e) {}
          requestAnimationFrame(draw);
        };
        rec.start(250);
        draw();
        var p = v.play();
        if (p && p.catch) p.catch(function () { v.muted = true; v.play().catch(function () {}); });
      };
      v.onerror = function () { clearTimeout(timer); URL.revokeObjectURL(url); reject(new Error('视频读取失败')); };
    });
  }

  function lbgUpload(file, isMusic) {
    if (!file) return Promise.resolve();
    var maxB = isMusic ? 20 * 1024 * 1024 : 30 * 1024 * 1024;
    if (file.size > maxB) { lbgToast((isMusic ? '音乐' : '文件') + '过大：请控制在 ' + Math.round(maxB / 1024 / 1024) + 'MB 以内（GitHub 单文件限制）。', 'error'); return Promise.resolve(); }
    var fd = new FormData();
    var uploadChain = Promise.resolve(file);
    var started = false;
    // 视频：检测 HEVC（hev1/hvc1），是则前端转码为 WebM 再上传（否则 Chrome/安卓黑屏）
    if (!isMusic && (file.type || '').indexOf('video/') === 0) {
      uploadChain = lbgDetectHevc(file).then(function (hevc) {
        if (!hevc) return file;
        lbgToast('检测到 HEVC/H.265 视频（部分浏览器无法播放），正在自动转码…', 'info');
        return lbgTranscodeToWebm(file).then(function (webm) {
          lbgToast('转码完成，正在上传…', 'info');
          started = true;
          return webm;
        }, function (err) {
          lbgToast('转码失败：' + (err && err.message || '请换用 H.264 视频'), 'error');
          throw err;
        });
      });
    }
    return uploadChain.then(function (f) {
      if (!started) lbgToast('正在上传' + (isMusic ? '音乐' : '文件') + '…（文件较大时请稍候）', 'info');
      fd.append('file', f, f.name || 'media');
      fd.append('folder', 'loginbg');
      return fetch('/api/upload-to-github', { method: 'POST', headers: { 'X-Couple-Token': (window.getSessionToken ? window.getSessionToken() : '') }, body: fd })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); })
        .then(function (j) {
          var url = j.url || j.cdnUrl;
          if (!url) throw new Error('上传成功但未返回地址');
          if (isMusic) { __lbg.draft.music_url = url; __lbg.draft.music_name = f.name || '本地音乐'; lbgRenderMusic(); lbgToast('音乐已上传，可预览试听。'); }
          else {
            var kind = (file.type || '').indexOf('video/') === 0 ? 'video' : 'photo';
            __lbg.draft.items.push({ kind: kind, url: url, dynamic: kind === 'photo', sort_order: __lbg.draft.items.length });
            lbgRenderMediaList();
            lbgToast('上传成功，已加入列表（未保存），点「确认保存并生效」后生效。');
          }
          return url;
        })
        .catch(function (err) {
          lbgToast('上传失败：' + (err && err.message || '网络异常，请重试'), 'error');
          throw err;
        });
    });
  }
  window.__lbgPickMedia = function () {
    var inp = document.getElementById('lbgFileInput');
    if (inp) inp.click();
  };
  window.__lbgPickMusic = function () {
    var inp = document.getElementById('lbgMusicInput');
    if (inp) inp.click();
  };
  window.__lbgRemoveMusic = function () {
    if (__lbg.draft) { __lbg.draft.music_url = null; __lbg.draft.music_enabled = false; }
    var sw = document.getElementById('lbgMusicSw');
    if (sw) sw.checked = false;
    lbgRenderMusic();
  };
  window.__lbgPlayMusic = function () {
    var mu = __lbg.draft && __lbg.draft.music_url;
    if (!mu) return;
    var a = document.getElementById('lbgMusicPreviewAudio');
    if (!a) { a = new Audio(); a.id = 'lbgMusicPreviewAudio'; }
    a.src = mu; a.play().catch(function () { lbgToast('浏览器需先与页面交互才能播放声音，请再点一次。'); });
  };

  // ---------- 音乐搜索（网易云曲库，站内代理保证地址永不过期） ----------
  window.__lbgSongsCache = [];
  function lbgFmtDur(ms) {
    if (!ms) return '--:--';
    var s = Math.round(ms / 1000);
    var m = Math.floor(s / 60), r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }
  window.__lbgSearchMusic = function () {
    var kwEl = document.getElementById('lbgMusicKw');
    var kw = kwEl ? kwEl.value.trim() : '';
    if (!kw) { lbgToast('请输入歌名', 'error'); return; }
    var box = document.getElementById('lbgMusicResults');
    if (box) box.innerHTML = '<div class="lui-loading" style="padding:10px;"><span class="lui-spinner"></span><span>搜索中…</span></div>';
    fetch('/api/music?action=search&s=' + encodeURIComponent(kw), { headers: { 'X-Couple-Token': (window.getSessionToken ? window.getSessionToken() : '') } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) throw new Error(j.error || '搜索失败');
        if (!box) return;
        window.__lbgSongsCache = j.songs || [];
        box.innerHTML = window.__lbgSongsCache.map(function (s, i) {
          return '<div style="display:flex; align-items:center; gap:8px; padding:9px 4px; border-bottom:1px solid var(--line);">'
            + '<div style="flex:1; min-width:0;"><div style="font-weight:600; font-size:var(--f-sub); color:var(--ink); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + lbgEsc(s.name) + '</div>'
            + '<div class="lui-mini" style="color:var(--ink-3); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + lbgEsc(s.artist) + ' · ' + lbgFmtDur(s.duration) + '</div></div>'
            + '<button class="lui-btn tonal sm" type="button" style="flex:none; padding:0 10px;" onclick="window.__lbgPlaySong(' + s.id + ')">试听</button>'
            + '<button class="lui-btn primary sm" type="button" style="flex:none; padding:0 10px;" onclick="window.__lbgPickSong(' + i + ')">使用</button></div>';
        }).join('');
      })
      .catch(function (err) {
        if (box) box.innerHTML = '<div class="lui-mini" style="color:var(--red); padding:8px 4px;">' + lbgEsc(err && err.message || '搜索失败') + '</div>';
        lbgToast('搜索失败：' + (err && err.message || '请稍后再试'), 'error');
      });
  };
  window.__lbgPlaySong = function (id) {
    var a = document.getElementById('lbgMusicPreviewAudio');
    if (!a) { a = new Audio(); a.id = 'lbgMusicPreviewAudio'; a.preload = 'none'; }
    // 直接使用网易云外链（audio 元素播放无需 CORS；URL 稳定，每次请求实时 302 到带时效 token 的 mp3，永不过期）
    a.src = 'https://music.163.com/song/media/outer/url?id=' + id + '.mp3';
    a.play().catch(function () { lbgToast('浏览器需先与页面交互才能播放声音，请再点一次。', 'error'); });
  };
  window.__lbgPickSong = function (i) {
    var s = window.__lbgSongsCache[i];
    if (!s) return;
    __lbg.draft.music_url = 'https://music.163.com/song/media/outer/url?id=' + s.id + '.mp3';
    __lbg.draft.music_name = s.name + ' - ' + s.artist;
    __lbg.draft.music_enabled = true; // 使用歌曲时自动开启播放
    lbgRenderMusic();
    lbgToast('已使用：' + s.name + '。别忘了点下方「确认保存并生效」，保存后登录页才会播放。', 'info');
  };

  function lbgRenderMusic() {
    var d = __lbg.draft; if (!d) return;
    var mu = document.getElementById('lbgMusicWrap');
    // 搜索框常驻显示（不再随开关隐藏）；开关只控制是否播放
    if (mu) mu.style.display = 'block';
    var sw = document.getElementById('lbgMusicSw');
    if (sw) sw.checked = !!d.music_enabled;
    var show = document.getElementById('lbgMusicShow');
    if (show) {
      if (d.music_url) {
        var label = d.music_name || (d.music_url.indexOf('/api/music/play') === 0 ? '网易云音乐' : '本地音乐');
        show.innerHTML = '<div class="lui-mini" style="color:var(--ink);">当前音乐：' + lbgEsc(label) + '</div>'
          + '<div style="margin-top:6px;"><a href="javascript:void(0)" onclick="window.__lbgPlayMusic()" style="color:var(--rose);">试听</a>'
          + ' <button class="lui-btn sm tonal" onclick="window.__lbgRemoveMusic()">移除</button></div>';
      }
      else show.innerHTML = '<span class="lui-mini" style="color:var(--ink-3);">未设置音乐</span>';
    }
  }

  function lbgDraftFromCfg(cfg, opts) {
    opts = opts || {};
    var items = (cfg && Array.isArray(cfg.items)) ? cfg.items.map(function (i) { return { kind: i.kind, url: i.url, dynamic: !!i.dynamic, sort_order: Number(i.sort_order || 0) }; }) : [];
    return {
      enabled: !!(cfg && cfg.enabled),
      mode: (cfg && cfg.mode) || 'photos',
      order_mode: (cfg && cfg.order_mode) || 'sequence',
      template: (cfg && cfg.template) || 't1',
      music_enabled: !!(cfg && cfg.music_enabled && cfg.music_url),
      video_sound: !!(cfg && cfg.video_sound),
      music_url: (cfg && cfg.music_url) || null,
      music_name: (cfg && cfg.music_name) || null,
      photo_duration: (cfg && cfg.photo_duration != null) ? Number(cfg.photo_duration) : 6,
      authorized_users: (opts.admin && cfg && Array.isArray(cfg.authorized_users)) ? cfg.authorized_users.slice() : [],
      items: items
    };
  }

  function lbgEditorHtml(opts) {
    var d = __lbg.draft || lbgDraftFromCfg({}, opts);
    var admin = !!opts.admin;
    var h = '';
    if (admin) {
      h += '<div class="lui-card"><div class="lui-card-head"><h3 class="lui-h3">总开关</h3></div>'
        + '<div class="lui-list-row" style="min-height:40px;"><div class="lui-row-main"><div class="lui-row-title" style="font-weight:500;">启用登录页背景</div><div class="lui-row-sub">开启后登录页会播放照片/视频（仅管理员可开关）</div></div>'
        + '<label class="lui-switch"><input type="checkbox" id="lbgEnabledSw" ' + (d.enabled ? 'checked' : '') + ' onchange="window.__lbgDraftSet(\'enabled\', this.checked)"><span class="track"></span></span></div></div>';
    }
    h += '<div class="lui-card"><div class="lui-card-head"><h3 class="lui-h3">播放内容</h3></div>'
      + lbgSeg('lbgModeSeg', [{ v: 'photos', t: '照片组' }, { v: 'video', t: '视频' }, { v: 'mixed', t: '照片+视频' }], d.mode, '内容模式')
      + lbgSeg('lbgOrderSeg', [{ v: 'sequence', t: '按顺序' }, { v: 'random', t: '随机播放' }], d.order_mode, '播放顺序')
      + '<div style="margin:14px 0 4px;"><div class="lui-label">每张照片停留（秒）</div><select class="lui-input" id="lbgDuration" style="margin-top:6px;" onchange="window.__lbgDraftSet(\'photo_duration\', Number(this.value))">'
      + [3, 4, 5, 6, 8, 10, 12, 15].map(function (s) { return '<option value="' + s + '" ' + (Number(d.photo_duration) === s ? 'selected' : '') + '>' + s + ' 秒</option>'; }).join('')
      + '</select></div>'
      + '<div style="margin:14px 0 4px;"><div class="lui-label">模板</div><div class="lbg-tpl-grid" style="margin-top:6px;">'
      + LBG_TEMPLATES.map(function (t) {
        return '<div class="lbg-tpl ' + (d.template === t.id ? 'active' : '') + '" onclick="window.__lbgPickTpl(\'' + t.id + '\', this)"><div class="t-prev" style="background:' + t.prev + ';"></div><div class="t-name">' + t.name + '</div><div class="t-desc">' + t.desc + '</div></div>';
      }).join('') + '</div></div>'
      + '<div style="margin:14px 0 4px;"><div class="lui-label">背景音乐</div>'
      + '<div class="lui-list-row" style="min-height:38px;"><div class="lui-row-main"><div class="lui-row-title" style="font-weight:500;">播放音乐</div></div><label class="lui-switch"><input type="checkbox" id="lbgMusicSw" ' + (d.music_enabled ? 'checked' : '') + ' onchange="window.__lbgDraftSet(\'music_enabled\', this.checked)"><span class="track"></span></span></div>'
      + '<div id="lbgMusicWrap" style="margin-top:8px;">'
      + '<div style="display:flex; gap:6px; margin-bottom:6px;"><input class="lui-input" id="lbgMusicKw" placeholder="输入歌名搜索（如：晴天）" style="flex:1; padding:9px 12px;" onkeydown="if(event.key===\'Enter\')window.__lbgSearchMusic()"><button class="lui-btn tonal sm" type="button" style="flex:none; padding:0 14px;" onclick="window.__lbgSearchMusic()">搜索</button></div>'
      + '<div id="lbgMusicResults" style="max-height:220px; overflow-y:auto; margin-bottom:6px;"></div>'
      + '<div class="lui-mini" style="color:var(--ink-3); margin-bottom:6px;">搜索自网易云曲库，试听满意后点「使用」；也可以上传自己的本地音乐：</div>'
      + '<button class="lui-btn tonal sm" type="button" onclick="window.__lbgPickMusic()">' + lbgIcon('i-music', 's14') + '上传本地音乐（mp3/m4a/wav/ogg ≤20MB）</button>'
      + '<div id="lbgMusicShow" style="margin-top:8px;"></div></div></div>'
      + '<div style="margin:14px 0 4px;"><div class="lui-label">视频原声</div>'
      + '<div class="lui-list-row" style="min-height:38px;"><div class="lui-row-main"><div class="lui-row-title" style="font-weight:500;">播放视频原声</div><div class="lui-row-sub">开启后视频自带声音（浏览器要求先点击页面一次）</div></div><label class="lui-switch"><input type="checkbox" id="lbgSoundSw" ' + (d.video_sound ? 'checked' : '') + ' onchange="window.__lbgDraftSet(\'video_sound\', this.checked)"><span class="track"></span></span></div></div>'
      + '<div id="lbgModeWarn" class="lui-mini" style="color:var(--amber); margin-top:8px;"></div>'
      + '</div>';

    h += '<div class="lui-card"><div class="lui-card-head"><h3 class="lui-h3">背景媒体</h3></div>'
      + '<div id="lbgMediaList"></div>'
      + '<div style="display:flex; gap:8px; margin-top:12px; flex-wrap:wrap;">'
      + '<button class="lui-btn tonal sm" type="button" onclick="window.__lbgPickMedia()">' + lbgIcon('i-plus', 's14') + '上传照片/视频</button>'
      + '<input type="file" id="lbgFileInput" accept="image/jpeg,image/png,image/gif,image/webp,image/avif,image/heic,video/mp4,video/webm,video/quicktime,video/3gpp" multiple style="display:none;">'
      + '<input type="file" id="lbgMusicInput" accept="audio/mpeg,audio/mp3,audio/mp4,audio/x-m4a,audio/wav,audio/ogg,audio/webm" style="display:none;">'
      + '<span class="lui-mini" style="color:var(--ink-3); align-self:center;">图片 ≤10MB / 视频 ≤30MB，GitHub 图床无流量限制</span></div>'
      + '<div class="lui-mini" style="color:var(--ink-3); margin-top:6px;">照片勾选「动态效果」会有缓慢缩放移动的生动感（Ken Burns）。</div>'
      + '</div>';

    if (admin) {
      h += '<div class="lui-card"><div class="lui-card-head"><h3 class="lui-h3">开放权限</h3></div>'
        + '<div class="lui-mini" style="line-height:1.8;">勾选用户后，对方登录即可在右上角菜单看到「登录页背景」入口，共同维护背景；总开关与授权列表仍只有管理员能改。</div>'
        + '<div id="lbgAuthUsers" style="display:flex; flex-wrap:wrap; gap:8px; margin-top:10px;"></div></div>';
    }

    h += '<div style="display:flex; gap:10px; margin-top:14px; flex-wrap:wrap;">'
      + '<button class="lui-btn primary" type="button" onclick="window.__lbgPreview()">' + lbgIcon('i-eye', 's14') + '预览效果</button>'
      + '<button class="lui-btn tonal" type="button" onclick="window.__lbgSave()">' + lbgIcon('i-check', 's14') + '确认保存并生效</button>'
      + '</div>';
    return h;
  }

  window.__lbgPickTpl = function (id, el) {
    __lbgDraftSet('template', id);
    var wrap = el.parentNode;
    var cards = wrap.querySelectorAll('.lbg-tpl');
    for (var i = 0; i < cards.length; i++) cards[i].classList.remove('active');
    el.classList.add('active');
  };

  function lbgLoadEditor(container, opts) {
    return lbgApi('getConfig', {}).then(function (cfg) {
      __lbg.draft = lbgDraftFromCfg(cfg, opts);
      container.innerHTML = lbgEditorHtml(opts);
      lbgRenderMediaList();
      lbgRenderMusic();
      lbgRefreshListWarn();
      if (opts.admin) lbgRenderAuthUsers();
      // 上传监听
      var fi = document.getElementById('lbgFileInput');
      if (fi) fi.addEventListener('change', function (e) {
        var files = Array.from(e.target.files || []);
        var chain = Promise.resolve();
        files.forEach(function (f) { chain = chain.then(function () { return lbgUpload(f, false); }); });
        e.target.value = '';
      });
      var mi = document.getElementById('lbgMusicInput');
      if (mi) mi.addEventListener('change', function (e) {
        var f = e.target.files && e.target.files[0];
        if (f) lbgUpload(f, true);
        e.target.value = '';
      });
      return cfg;
    }).catch(function (e) {
      container.innerHTML = '<div class="lui-notice" style="margin:16px 0;"><b>登录页背景暂不可用</b><div style="margin-top:6px;">' + lbgEsc(e.message || String(e)) + '</div></div>';
      throw e;
    });
  }

  function lbgRenderAuthUsers() {
    var box = document.getElementById('lbgAuthUsers');
    if (!box) return;
    var d = __lbg.draft; if (!d) return;
    Promise.resolve(window.loadUserData ? loadUserData({ includeAll: true, allowLocalFallback: false }).catch(function () { return {}; }) : {}).then(function (users) {
      var names = Object.keys(users || {});
      if (!names.length) { box.innerHTML = '<span class="lui-mini" style="color:var(--ink-3);">暂无用户</span>'; return; }
      box.innerHTML = names.map(function (n) {
        var checked = d.authorized_users.indexOf(n) !== -1;
        return '<label class="lui-tag" style="cursor:pointer; display:inline-flex; align-items:center; gap:5px; padding:7px 12px;"><input type="checkbox" ' + (checked ? 'checked' : '') + ' onchange="window.__lbgToggleAuth(\'' + lbgEsc(n) + '\', this.checked)"> ' + lbgEsc(n) + '</label>';
      }).join('');
    });
  }
  window.__lbgToggleAuth = function (name, on) {
    var d = __lbg.draft; if (!d) return;
    var arr = d.authorized_users;
    var i = arr.indexOf(name);
    if (on && i === -1) arr.push(name);
    if (!on && i !== -1) arr.splice(i, 1);
  };

  window.__lbgSave = function () {
    var d = __lbg.draft; if (!d) return;
    var payload = {
      mode: d.mode, order_mode: d.order_mode, template: d.template,
      music_enabled: d.music_enabled, video_sound: d.video_sound,
      music_url: d.music_url, music_name: d.music_name, photo_duration: d.photo_duration,
      items: d.items.map(function (it, i) { return { kind: it.kind, url: it.url, dynamic: !!it.dynamic, sort_order: i }; })
    };
    if (isAdmin || currentUser === 'admin') {
      payload.enabled = !!d.enabled;
      payload.authorized_users = d.authorized_users;
    }
    var btn = document.querySelector('[onclick="window.__lbgSave()"]');
    if (btn) { btn.disabled = true; btn.innerText = '保存中…'; }
    lbgApi('saveConfig', payload).then(function (r) {
      lbgToast('已保存并生效。重新打开登录页即可看到；音乐/视频原声需在登录页点击页面任意处才会出声（浏览器自动播放限制）。', 'info');
      __lbg.cfg = Object.assign({}, __lbg.cfg, { enabled: !!d.enabled, mode: d.mode, order_mode: d.order_mode, template: d.template, music_enabled: d.music_enabled, video_sound: d.video_sound, music_url: d.music_url, music_name: d.music_name, photo_duration: d.photo_duration, items: d.items });
      __lbg.dirty = true;
      // 预览浮层若开着，同步重建
      var prev = document.getElementById('loginBgPreview');
      if (prev && prev.style.display !== 'none') lbgBuildPlayer(prev, __lbg.cfg, { preview: true, allowSound: true });
    }).catch(function (e) { lbgToast('保存失败：' + e.message, 'error'); })
      .finally(function () { if (btn) { btn.disabled = false; btn.innerText = '确认保存并生效'; } });
  };

  window.__lbgPreview = function () {
    var d = __lbg.draft; if (!d) return;
    var prev = document.getElementById('loginBgPreview');
    if (!prev) return;
    var items = d.items.map(function (it, i) { return { kind: it.kind, url: it.url, dynamic: !!it.dynamic, sort_order: i }; });
    var cfg = { enabled: true, mode: d.mode, order_mode: d.order_mode, template: d.template, music_enabled: d.music_enabled, video_sound: d.video_sound, music_url: d.music_url, photo_duration: d.photo_duration, items: items };
    prev.style.display = 'block';
    prev.innerHTML = '<button class="lbg-close" onclick="window.__lbgClosePreview()">×</button><div class="lbg-preview-title">登录页背景预览</div>';
    lbgBuildPlayer(prev, cfg, { preview: true, allowSound: true });
  };
  window.__lbgClosePreview = function () {
    var prev = document.getElementById('loginBgPreview');
    if (!prev) return;
    lbgStopPlayer();
    lbgClearPlayer(prev);
    prev.style.display = 'none';
  };

  // ---------- 管理面板 tab 与授权用户入口 ----------
  function renderLoginBgAdminTab(el) {
    el.innerHTML = '<div class="lui-loading"><span class="lui-spinner"></span><span>正在加载登录页背景设置…</span></div>';
    lbgLoadEditor(el, { admin: true }).catch(function () {});
  }
  window.renderLoginBgAdminTab = renderLoginBgAdminTab;

  function updateLoginBgEntryVisibility() {
    var btn = document.getElementById('loginBgEntryBtn');
    if (!btn) return;
    // 不依赖 app 局部变量：getConfig 返回的 canEdit 已由服务端按会话判定（未登录/未授权=隐藏）
    lbgApi('getConfig', {}).then(function (cfg) {
      btn.style.display = (cfg && cfg.canEdit) ? 'block' : 'none';
      if (cfg && cfg.canEdit) __lbg.cfg = cfg;
    }).catch(function () { btn.style.display = 'none'; });
  }
  window.updateLoginBgEntryVisibility = updateLoginBgEntryVisibility;

  function openLoginBgEntry() {
    // 管理员：走管理面板「登录页背景」tab；授权用户：弹出设置浮层
    var cfg = __lbg.cfg;
    if (cfg && cfg.isAdmin) {
      if (window.openAdminPanel) openAdminPanel();
      if (window.switchAdminTab) switchAdminTab('loginbg');
      return;
    }
    // 授权用户：弹出设置浮层（不含总开关/授权管理）
    var prev = document.getElementById('loginBgPreview');
    if (prev && prev.style.display === 'block') return;
    var overlay = document.createElement('div');
    overlay.className = 'lui-overlay show center';
    overlay.id = 'loginBgEditorModal';
    overlay.style.zIndex = '2000';
    document.body.style.overflow = 'hidden'; // 锁住背景滚动，防止滚动穿透
    overlay.innerHTML = '<div class="lui-shell" style="max-width:640px; max-height:88dvh; min-height:0; overflow-y:auto; border-radius:16px; padding-left:20px; padding-right:20px;">'
      + '<div class="lui-between" style="padding:16px 0 0;"><div><h2 class="lui-h2">登录页背景</h2><div class="lui-mini">共同维护我们的小站门面</div></div>'
      + '<button class="lui-btn icon" onclick="window.__lbgCloseModal()"><svg class="lui-icon"><use href="assets/icons.svg#i-x"/></svg></button></div>'
      + '<div style="padding:0 0 18px;" id="loginBgModalBody"><div class="lui-loading"><span class="lui-spinner"></span><span>加载中…</span></div></div></div>';
    document.body.appendChild(overlay);
    var body = document.getElementById('loginBgModalBody');
    lbgLoadEditor(body, { admin: false }).catch(function () {});
  }
  window.openLoginBgEntry = openLoginBgEntry;
  window.__lbgCloseModal = function () {
    var m = document.getElementById('loginBgEditorModal');
    if (m) m.remove();
    document.body.style.overflow = ''; // 恢复背景滚动
  };

  // ---------- 挂载 ----------
  // 1) 管理面板 tab 注册（两版 ADMIN_TABS 全局数组）
  if (Array.isArray(window.ADMIN_TABS) && !window.ADMIN_TABS.some(function (t) { return t.key === 'loginbg'; })) {
    window.ADMIN_TABS.push({ key: 'loginbg', label: '登录页背景', icon: 'i-film' });
  }
  // 2) 渲染分发：拦截 renderAdminTabBody 的 loginbg 分支
  var __origRTB = window.renderAdminTabBody;
  window.renderAdminTabBody = function () {
    if (window.__adminTab === 'loginbg') { var el = document.getElementById('adminContent'); if (el) return renderLoginBgAdminTab(el); }
    if (__origRTB) return __origRTB();
    return undefined;
  };
  // 3) 登录后更新入口可见性：两版 app 的 updateAdminVisibility 登录成功都会调用，
  //    已分别在 app.js/app-v2.js 中显式调用 window.updateLoginBgEntryVisibility（无需再挂包装）
  // 4) 全局首次交互解锁（只绑定一次）
  document.addEventListener('pointerdown', lbgGlobalUnlock, { once: true });
  document.addEventListener('keydown', lbgGlobalUnlock, { once: true });
  // 5) 登录页可见时初始化播放器（轮询，500ms 保证登录页一隐藏就立即停播，避免后台空转出声）
  setInterval(function () {
    try { lbgTick(); } catch (e) {}
  }, 500);
})();
