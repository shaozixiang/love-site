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

  // ---------- 环境取证（只上报一次，不涉及隐私字段）----------
  function lbgTrace() {
    try {
      if (window.__lbgTraced) return;
      window.__lbgTraced = true;
      fetch('/api/login-bg', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'trace',
          data: {
            ua: navigator.userAgent,
            platform: navigator.platform || '',
            screen: (window.screen && screen.width ? screen.width + 'x' + screen.height : ''),
            href: location.pathname + location.search,
            v: '20261027at'
          }
        })
      }).catch(function () {});
    } catch (e) {}
  }
  lbgTrace();

  // 播放器运行时事件埋点（落 admin_logs 供三平台排查；所有字段仅用于诊断）
  function lbgReport(ev, data) {
    try {
      fetch('/api/login-bg', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'trace',
          data: Object.assign({
            ev: ev,
            ua: navigator.userAgent,
            screen: (window.screen && screen.width ? screen.width + 'x' + screen.height : ''),
            href: location.pathname + location.search,
            v: '20261027at'
          }, data || {})
        })
      }).catch(function () {});
    } catch (e) {}
  }

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

  // Web Audio 加载（解锁后触发，避免构建期抢视频资源）：fetch → decode → 就绪后自动起播
  function lbgCtxEnsure() {
    if (!__lbg.ctxUsable || __lbg.stopped) return;
    var cfg = __lbg.cfg || {};
    if (!(cfg.music_enabled && cfg.music_url)) return;
    if (!__lbg.audioCtx || __lbg.audioBuf || __lbg._ctxLoading) return;
    var url = cfg.music_url;
    __lbg._ctxLoading = true;
    fetch(url).then(function (resp) { return resp.arrayBuffer(); }).then(function (ab) {
      return __lbg.audioCtx.decodeAudioData(ab);
    }).then(function (buf) {
      __lbg.audioBuf = buf; __lbg._ctxLoading = false;
      lbgReport('ctx-ready', { len: Math.round(buf.duration || 0) });
      if (__lbg.audioUnlocked && !__lbg.stopped) lbgCtxPlay(); // 就绪自动起播
    }).catch(function () { __lbg.audioBuf = null; __lbg._ctxLoading = false; lbgReport('ctx-fail', {}); });
  }

  // Web Audio 播放音乐（绕过 Edge Mobile "单活跃媒体"限制：video 元素 + AudioContext 可真正同时）：
  // audio 元素路径在 Edge 上会与视频互斥（音乐起播→视频被暂停）；AudioContext 不走媒体会话通道
  function lbgCtxPlay() {
    if (__lbg.stopped || !__lbg.audioUnlocked) return false;
    var c = __lbg.audioCtx;
    if (!c || !__lbg.audioBuf) return false; // ctx 或缓冲未就绪 → 返回 false 走 audio 元素兜底
    if (__lbg.audioSrcNode && __lbg.audioSrcNode._playing) return true; // 已在播
    try {
      if (c.state === 'suspended') { var rp = c.resume(); if (rp && rp.catch) rp.catch(function () {}); }
      var src = c.createBufferSource();
      src.buffer = __lbg.audioBuf;
      src.loop = true;
      src.connect(c.destination);
      src.start(0);
      src._playing = true;
      src.onended = function () { src._playing = false; };
      __lbg.audioSrcNode = src;
      // 兜底：Web Audio 也暂停掉 audio 元素，避免双声
      if (__lbg.audio) { try { __lbg.audio.pause(); } catch (e) {} }
      lbgReport('audio-playing', { via: 'webaudio', len: Math.round(__lbg.audioBuf.duration || 0) });
      return true;
    } catch (e) {
      try { if (__lbg.audioSrcNode) { __lbg.audioSrcNode.stop(); __lbg.audioSrcNode._playing = false; } } catch (e2) {}
      return false;
    }
  }
  function lbgCtxStop() {
    try {
      if (__lbg.audioSrcNode) { __lbg.audioSrcNode.onended = null; try { __lbg.audioSrcNode.stop(); } catch (e) {} __lbg.audioSrcNode._playing = false; __lbg.audioSrcNode = null; }
      if (__lbg.audioCtx && __lbg.audioCtx.state === 'running') { try { __lbg.audioCtx.suspend(); } catch (e) {} }
    } catch (e) {}
  }
  function lbgCtxResume() {
    if (__lbg.stopped || !__lbg.audioUnlocked) return;
    try {
      if (__lbg.audioCtx && __lbg.audioCtx.state === 'suspended') { var rp = __lbg.audioCtx.resume(); if (rp && rp.catch) rp.catch(function () {}); }
    } catch (e) {}
  }

  function lbgStopPlayer() {
    // 停止标志：所有异步回调（ended/error/timer/音频）先查 stopped，杜绝"退出后媒体复活"
    __lbg.stopped = true;
    if (__lbg.timer) { clearTimeout(__lbg.timer); __lbg.timer = null; }
    if (__lbg._raf) { cancelAnimationFrame(__lbg._raf); __lbg._raf = null; } // 停止 Canvas 绘制
    for (var i = 0; i < __lbg.videoEls.length; i++) {
      var v = __lbg.videoEls[i];
      if (v) {
        try { v.pause(); v.onended = null; v.onerror = null; v.removeAttribute('src'); v.load(); } catch (e) {}
      }
    }
    __lbg.videoEls = [];
    // 移除残留的"点击续播"监听
    for (var _ci2 = 0; _ci2 < (window.__lbgTapClean || []).length; _ci2++) {
      try { document.removeEventListener('pointerdown', window.__lbgTapClean[_ci2]); } catch (e) {}
    }
    window.__lbgTapClean = [];
    // 移除 Canvas 画面层 / 双视频 wrapper
    var cv = document.querySelectorAll('canvas.lbg-video, .lbg-video-wrap');
    for (var ci = 0; ci < cv.length; ci++) { try { cv[ci].remove(); } catch (e) {} }
    if (__lbg.audio) { try { __lbg.audio.pause(); __lbg.audio.src = ''; } catch (e) {} }
    lbgCtxStop();
    // 同时停止试听音频（编辑器里点过的歌），退出后绝不留声
    try { var pa = document.getElementById('lbgMusicPreviewAudio'); if (pa) { pa.pause(); pa.src = ''; } } catch (e) {}
  }

  // 构建播放器到指定容器（登录页 / 预览浮层共用）
  function lbgBuildPlayer(container, cfg, opts) {
    opts = opts || {};
    // 关键：同步当前配置，播放器内所有判断（video_sound 等）以本次构建的 cfg 为准
    __lbg.cfg = cfg;
    // 音乐链路：resolve(302直链) 统一切到 stream(流式代理)——COS 直链带 attachment 头，移动端
    // (Edge/部分内置浏览器)会把音频当"下载"反复断流并连累同页视频起播失败；代理重写为 inline 播放头
    if (cfg && cfg.music_url && cfg.music_url.indexOf('action=resolve') >= 0) {
      cfg.music_url = cfg.music_url.replace('action=resolve&rid=', 'action=stream&rid=');
    }
    lbgStopPlayer();
    // 重新构建：解除停止标志，允许播放
    __lbg.stopped = false;
    // 页面切回前台自动恢复媒体：移动端(Edge/部分内置浏览器)页面一不可见就自动暂停音频/视频，
    // 切回来不会自动恢复 → 表现为"音乐时不时断一下/画面停住"；这里监听可见性恢复继续播放
    if (!__lbg._visBound) {
      __lbg._visBound = true;
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState !== 'visible') return;
        if (__lbg.stopped || !__lbg.audioUnlocked) return;
        var c2 = __lbg.cfg || {};
        if (c2.music_enabled && c2.music_url) {
          lbgCtxResume();
          if (__lbg.audio && __lbg.audio.paused && !(__lbg.audioSrcNode && __lbg.audioSrcNode._playing)) {
            var ap = __lbg.audio.play(); if (ap && ap.catch) ap.catch(function () {});
          }
        }
        for (var vi = 0; vi < __lbg.videoEls.length; vi++) {
          var vv = __lbg.videoEls[vi];
          if (vv && vv.paused && vv.classList.contains('active') && !document.querySelector('.lbg-gesture-frame') && !document.querySelector('.lbg-freeze-frame')) {
            try { vv.play().catch(function () {}); } catch (e) {}
          }
        }
        lbgReport('vis-resume', { music: !!(c2.music_enabled && c2.music_url) });
      });
    }
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
    status.textContent = '正在加载我们的回忆…';
    container.appendChild(status);

    // 音频（播放由全局首次交互解锁触发，见 lbgGlobalUnlock）
    if (cfg.music_enabled && cfg.music_url) {
      // Web Audio：Edge Mobile 上 audio 元素与 video 互斥（单活跃媒体），AudioContext 不走媒体会话通道
      // → 视频画面+音乐可真正同时。仅标准 Android 浏览器（Chrome/Edge）启用；平板(WebView)/微信保持 audio 元素方案
      var _ua = navigator.userAgent || '';
      if (!__lbg._ctxInit) {
        __lbg._ctxInit = true;
        __lbg.ctxUsable = !/; wv/i.test(_ua) && /Chrome\/\d/i.test(_ua) && !/MicroMessenger/i.test(_ua);
        if (__lbg.ctxUsable) {
          try {
            var AC = window.AudioContext || window.webkitAudioContext;
            if (AC) __lbg.audioCtx = new AC();
            else __lbg.ctxUsable = false;
          } catch (e) { __lbg.audioCtx = null; __lbg.ctxUsable = false; }
        }
      }
      // 换歌（music_url 变化）→ 旧缓冲作废；加载延后到解锁后触发（不抢视频加载带宽）
      if (__lbg.ctxUrl !== cfg.music_url) {
        __lbg.ctxUrl = cfg.music_url;
        __lbg.audioBuf = null;
        __lbg._ctxLoading = false;
        if (__lbg.audioSrcNode) { try { __lbg.audioSrcNode.stop(); } catch (e) {} __lbg.audioSrcNode = null; }
      }
      if (!__lbg.audio) { __lbg.audio = new Audio(); __lbg.audio.loop = true; __lbg.audio.preload = 'auto'; }
      // 音频出错自动重试（限 3 次防死循环卡顿）：resolve 代理的直链带时效签名，播放中网络抖动/直链失效时重新解析换新地址
      if (!__lbg.audio._errBound) {
        __lbg.audio._errBound = true;
        __lbg.audio._errCount = 0;
        // 媒体时间线取证：audio 实际起播/被暂停（定位"音乐和视频不同时"谁先停）
        __lbg.audio.addEventListener('playing', function () {
          lbgReport('audio-playing', { unlocked: __lbg.audioUnlocked, paused: __lbg.audio.paused });
        });
        __lbg.audio.addEventListener('pause', function () {
          if (!__lbg.stopped) lbgReport('audio-pause', { unlocked: __lbg.audioUnlocked });
        });
        __lbg.audio.addEventListener('error', function () {
          var cfg = __lbg.cfg || {};
          if (__lbg.stopped || !cfg.music_url || !__lbg.audioUnlocked) return;
          if ((__lbg.audio._errCount || 0) >= 3) return; // 重试上限：连续失败不再死循环
          __lbg.audio._errCount++;
          lbgReport('audio-error', { count: __lbg.audio._errCount });
          try {
            __lbg.audio.src = '';
            __lbg.audio.src = cfg.music_url;
            __lbg.audio.play().catch(function () {});
          } catch (e) {}
        });
      }
      if (opts.allowSound && __lbg.audioUnlocked) {
        if (__lbg.ctxUsable) { lbgCtxEnsure(); }
        else if (__lbg.audio) {
          __lbg.audio.src = cfg.music_url;
          __lbg.audio.play().catch(function () {});
        }
      }
    } else if (__lbg.audio) { try { __lbg.audio.pause(); __lbg.audio.src = ''; } catch (e) {} }

    if (opts.allowSound && (cfg.music_enabled || cfg.video_sound)) {
      var hint = document.createElement('div');
      hint.className = 'lbg-sound-hint';
      hint.textContent = '点击页面任意处开启声音';
      container.appendChild(hint);
    }

    lbgActivate(container, 0, false);
    lbgReport('build', { mode: __lbg.mode, listLen: __lbg.list.length, music: !!(cfg.music_enabled && cfg.music_url), loopN: cfg.loop_count, staticUrl: !!cfg.static_url });
    // 竞态修复：页面加载早期用户已点过页面（此时播放器未构建完，unlock 白跑）→
    // 构建完成后补发一次解锁启动（幂等，视频/音乐已播则无副作用）
    if (__lbg.audioUnlocked) {
      setTimeout(function () { try { lbgDoUnlock(); } catch (e) {} }, 0);
    }
  }

  // 激活第 idx 个媒体
  function lbgActivate(container, idx, unlocked) {
    if (__lbg.stopped) return; // 已停止（登录页隐藏）后，任何回调一律不再复活播放
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
    // 清理上一视频项的"点击续播"监听（轮播切走/停止后不残留）
    for (var _ci = 0; _ci < __lbg.videoEls.length; _ci++) {
      if (__lbg.videoEls[_ci] && __lbg.videoEls[_ci]._tapResume) {
        document.removeEventListener('pointerdown', __lbg.videoEls[_ci]._tapResume);
        __lbg.videoEls[_ci]._tapResume = null;
      }
    }

    var status = container.querySelector('.lbg-status');
    var cfg = __lbg.cfg || {};

    if (item.kind === 'photo') {
      // 清理视频 + Canvas 画面层 + 双视频 wrapper
      var vids = container.querySelectorAll('video.lbg-video, canvas.lbg-video, .lbg-video-wrap');
      for (var i = 0; i < vids.length; i++) { try { vids[i].pause ? vids[i].pause() : null; } catch (e) {} vids[i].remove(); }
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
      // 视频不可点击（pointer-events:none）：华为/荣耀等浏览器点击视频会弹系统全屏播放器
      var ua = navigator.userAgent || '';
      // 关键判定（用户实测校准）：Android 非微信浏览器全部"触摸后才播"——
      // Edge 移动版自动播放的视频会独占媒体通道，导致同页音乐起不来（aj 版改自动播后音画不同步，已回退）；
      // 触摸手势同时启动视频+音乐 → Edge 允许手势并发 → 音画同步（今天上午 af 版实测好的方案）
      var needGesture = /Android/i.test(ua) && !/MicroMessenger/i.test(ua);
      // 接管型内核（WebView wv / 无 Chrome 标记）：视频一播就被系统播放器接管（OPPO 平板），
      // 触摸后也不播视频，仅静帧+KenBurns 动效+音乐；标准 Chrome/Edge 触摸后正常播视频+音乐
      var takeover = needGesture && (/; wv/i.test(ua) || !/Chrome\/\d/i.test(ua));
      var pre = window.__lbgPreloaded || [];
      var reuse = null;
      for (var pi = 0; pi < pre.length; pi++) {
        if (pre[pi] && pre[pi].tagName === 'VIDEO' && pre[pi].src && pre[pi].src.indexOf(item.url) >= 0) { reuse = pre[pi]; pre[pi] = null; break; }
      }
      var v = reuse || document.createElement('video');
      v.className = 'lbg-video active';
      if (!reuse) v.src = item.url;
      v.playsInline = true;
      v.preload = 'auto';
      // 关键修复：销毁容器内所有旧 video（仅保留本轮复用对象）——残留 video 会让平板浏览器误判多路视频、内存/解码器膨胀导致卡死
      var oldVids = container.querySelectorAll('video.lbg-video');
      for (var oi = 0; oi < oldVids.length; oi++) {
        if (oldVids[oi] !== reuse) { try { oldVids[oi].pause(); } catch (e) {} oldVids[oi].remove(); }
      }
      // 全平台内联播放：X5/微信内核等必须有 x5-* 属性，否则会把背景视频弹成独立全屏播放器挡住登录
      v.setAttribute('playsinline', '');
      v.setAttribute('webkit-playsinline', '');
      v.setAttribute('x5-playsinline', '');
      v.setAttribute('x5-video-player-type', 'h5');
      v.setAttribute('x5-video-player-fullscreen', 'false');
      v.setAttribute('disablePictureInPicture', '');
      v.setAttribute('controls', 'false');
      v.controls = false;
      v.style.pointerEvents = 'none'; // 关键：视频不可点击 → 平板/国产浏览器不会因点击弹全屏播放器
      // 原声开关：音乐启用时视频一律静音（音乐优先，画面照播）；否则按视频原声开关
      var musicOn = !!(cfg.music_enabled && cfg.music_url);
      var soundOn = !musicOn && !!(cfg.video_sound) && (__lbg.audioUnlocked || (container.dataset.sound === '1'));
      v.muted = !soundOn;
      v.loop = false;
      // 竖屏手机双视频层：背景模糊放大填充 + 前景完整 contain —— 横屏视频在竖屏手机上完整可看，
      // 不拉伸不变形不留黑边；平板(接管型)/横屏设备保持单视频 cover
      var wrap = null, bgV = null;
      var portraitPhone = !takeover && !reuse && window.matchMedia && window.matchMedia('(orientation: portrait) and (max-width: 767px)').matches;
      if (portraitPhone) {
        v.className = 'lbg-video lbg-video-fg active'; // 前景层：完整 contain 显示（不拉伸不变形）
        wrap = document.createElement('div');
        wrap.className = 'lbg-video-wrap';
        bgV = document.createElement('video');
        bgV.className = 'lbg-video lbg-video-bg';
        bgV.src = item.url;
        bgV.muted = true;
        bgV.loop = false;
        bgV.preload = 'auto';
        bgV.playsInline = true;
        bgV.setAttribute('playsinline', '');
        bgV.setAttribute('webkit-playsinline', '');
        bgV.setAttribute('x5-playsinline', '');
        bgV.setAttribute('x5-video-player-type', 'h5');
        bgV.setAttribute('x5-video-player-fullscreen', 'false');
        bgV.setAttribute('disablePictureInPicture', '');
        bgV.controls = false;
        bgV.style.pointerEvents = 'none';
        wrap.appendChild(bgV);
        wrap.appendChild(v);
        container.appendChild(wrap);
        v._bgV = bgV;
      } else {
        container.appendChild(v);
      }
      __lbg.videoEls.push(v);
      if (bgV) __lbg.videoEls.push(bgV);
      // 全屏兜底：个别内核仍会弹系统播放器 → 立即退出全屏；退不出的直接移除视频（登录不被挡）
      var fullscreenExit = function () {
        try { if (document.fullscreenElement) document.exitFullscreen(); } catch (e) {}
        try { if (document.webkitFullscreenElement) document.webkitExitFullscreen(); } catch (e) {}
        try { if (v.webkitExitFullscreen) v.webkitExitFullscreen(); } catch (e) {}
      };
      var esc = function () {
        fullscreenExit();
        lbgReport('fullscreen-taken', { w: v.videoWidth || 0 }); // 平板弹播放器证据
        setTimeout(function () {
          try {
            var fs = document.fullscreenElement || document.webkitFullscreenElement;
            if (fs) { fullscreenExit(); try { v.pause(); v.remove(); } catch (e) {} }
          } catch (e) {}
        }, 800);
      };
      v.addEventListener('webkitbeginfullscreen', esc);
      v.addEventListener('fullscreenchange', function () { if (document.fullscreenElement) esc(); });
      // 首帧就绪后隐藏"加载中"（playing 在静音起播时可能早于画面数据，不据此隐藏）
      var hideStatus = function () { if (status) status.style.display = 'none'; };
      v.addEventListener('loadeddata', hideStatus);
      v.addEventListener('playing', function () { if (v.videoWidth > 0) hideStatus(); });
      if (v.readyState >= 2) hideStatus(); // 复用预载 video 时数据已就绪
      // 自动播放兜底：带声音被浏览器拦截时，立即降级为静音重试（保证画面出来）
      var tryPlay = function (muted) {
        if (muted) v.muted = true;
        var p = v.play();
        if (v._bgV) { try { v._bgV.muted = true; v._bgV.play().catch(function () {}); } catch (e) {} } // 背景层同步播放
        if (p && p.catch) p.catch(function () {
          if (!v.muted) tryPlay(true); // 有声失败 → 静音重试
          else {
            lbgReport('video-play-fail', { needGesture: needGesture, muted: v.muted, retried: v._playRetry || 0 });
            // 单视频场景：不跳过（避免"画面永远起不来"），保留静态帧，短延时重试 2 次；仍失败保持静帧
            if ((v._playRetry || 0) < 2) {
              v._playRetry = (v._playRetry || 0) + 1;
              setTimeout(function () { if (!__lbg.stopped && v.parentNode) tryPlay(true); }, 1200);
            } else if (status && cfg.static_url) {
              status.style.display = 'none';
            }
          }
        });
      };
      // 接管内核：不自动播放（等首次触摸），先显示静帧保持视频画面感
      if (needGesture && cfg.static_url) {
        var gf = document.createElement('div');
        gf.className = 'lbg-layer lbg-photo active lbg-gesture-frame';
        gf.style.backgroundImage = 'url("' + cfg.static_url.replace(/"/g, '%22') + '")';
        gf.style.zIndex = '2';
        container.appendChild(gf);
        if (status) status.style.display = 'none';
        // 已解锁后轮播回视频：Edge 非手势 play 被拒 → 定格帧先显示，点一下页面即续播（体验与首次一致）
        if (!takeover && __lbg.audioUnlocked) {
          var tapResume = function () {
            document.removeEventListener('pointerdown', tapResume);
            if (__lbg.stopped || !v.parentNode) return;
            var gf2 = document.querySelector('.lbg-gesture-frame');
            if (gf2) gf2.remove();
            try { tryPlay(true); } catch (e) {}
            lbgReport('video-resume-tap', { t: Math.round((v.currentTime || 0) * 10) / 10 });
          };          v._tapResume = tapResume;
          document.addEventListener('pointerdown', tapResume);
          if (!window.__lbgTapClean) window.__lbgTapClean = [];
          window.__lbgTapClean.push(tapResume);
        }
      }
      var _playTimer = null;
      if (!needGesture) {
        // 延迟起播：给浏览器渲染/页面切换留时间，避免"刚解锁立即弹出全屏播放器"（个别内核的触发窗口）
        _playTimer = setTimeout(function () {
          try { tryPlay(false); } catch (e) {}
        }, 400);
      }
      lbgHandleAudio(container, !soundOn);
      // 循环控制：loop_count=0 无限；>0 播 N 遍后停止——显示定格帧(static_url,用户选的帧)或保留最后帧
      var loopN = Math.max(0, parseInt(cfg.loop_count, 10) || 0);
      var loopDone = 0;
      var lastT = 0;
      var freezeShown = false;
      var showFreeze = function () {
        if (freezeShown) return;
        freezeShown = true;
        try { v.pause(); } catch (e) {}
        if (cfg.static_url) {
          var fz = document.createElement('div');
          fz.className = 'lbg-layer lbg-photo active lbg-freeze-frame';
          fz.style.backgroundImage = 'url("' + cfg.static_url.replace(/"/g, '%22') + '")';
          container.appendChild(fz);
          // 盖住原视频帧（定格图在上面）
          fz.style.zIndex = '2';
        }
      };
      var onTime = function () {
        if (__lbg.stopped) return;
        var t = v.currentTime;
        if (t - shotMark >= 0.5) { shotMark = t; takeShot(); } // 播放中定期缓存帧，供结束定格用
        if (t < lastT) { // 回卷 = 完成一轮
          loopDone++;
          if (loopN > 0 && loopDone >= loopN) { showFreeze(); return; } // 播完 N 遍 → 定格
        }
        lastT = t;
      };
      v.addEventListener('timeupdate', onTime);
      // 单视频：原生 loop（Chrome 顺滑）；X5 等不认 loop 的播完用"播放中定期截取的帧"定格，触摸页面时续播
      if (__lbg.list.length === 1 && loopN === 0) v.loop = true;
      // X5/部分内核 ended 后解码器释放，结束时截帧必失败 → 播放过程中每 0.5s 截一帧缓存（hidden canvas），结束时总能显示最近一帧
      var lastShot = null;
      var shotMark = -10;
      var takeShot = function () {
        try {
          if (v.videoWidth > 0 && !v.paused) {
            var c = document.createElement('canvas');
            c.width = v.videoWidth; c.height = v.videoHeight;
            c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
            if (lastShot) lastShot.remove();
            lastShot = c;
          }
        } catch (e) {}
      };
      // 媒体时间线取证：video 实际起播/被暂停（创建时即绑定，定位"音乐和画面不同时"谁先停）
      if (!v._evB2) {
        v._evB2 = true;
        v.addEventListener('playing', function () {
          lbgReport('video-playing', { t: Math.round((v.currentTime || 0) * 10) / 10, muted: v.muted });
        });
        v.addEventListener('pause', function () {
          if (!__lbg.stopped) lbgReport('video-pause', { t: Math.round((v.currentTime || 0) * 10) / 10, ended: v.ended });
        });
      }
      // 属性级事件句柄（StopPlayer 时置 null 解绑，防止隐藏后 ended/error 复活播放）
      v.onended = function () {
        if (__lbg.stopped) return;
        if (__lbg.list.length > 1) { lbgActivate(container, idx + 1, true); return; }
        if (loopN > 0 && loopDone >= loopN) { showFreeze(); return; }
        // 单视频无限循环：原生 loop 的内核不触发 ended；不认 loop 的内核(X5/部分安卓)播完画面会被清空 →
        // 显示播放中缓存的最近一帧（保证不黑屏）；触摸页面时自动续播
        var src = lastShot;
        if (!src) {
          try {
            if (v.videoWidth > 0) {
              src = document.createElement('canvas');
              src.width = v.videoWidth; src.height = v.videoHeight;
              src.getContext('2d').drawImage(v, 0, 0, src.width, src.height);
            }
          } catch (e) { src = null; }
        }
        if (src) {
          src.className = 'lbg-layer lbg-lastframe active';
          src.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:2;';
          container.appendChild(src);
        }
        lbgReport('video-ended', { loopN: loopN, loopDone: loopDone, shot: !!lastShot, srcSet: !!src });
      };
      v.onerror = function () { lbgReport('video-error', { code: v.error ? v.error.code : -1 }); lbgActivate(container, idx + 1, true); };
      // 关键修复：单视频不需要"强制轮换"（loop/截帧已处理）；只有多视频列表才设轮换 timer——
      // 否则 X5 在 15s 后重建 video 无手势 play 被拦 → "播完就黑、不触摸不播"
      if (__lbg.list.length > 1) {
        // 初始兜底 15s；loadedmetadata 后按视频实际时长+2s 重设（防止加载慢时"播一半被强制切走"）
        __lbg.timer = setTimeout(function () { lbgActivate(container, idx + 1, true); }, 15000);
        v.addEventListener('loadedmetadata', function () {
          var sec = Math.max(8, Math.min(30, (v.duration || 15) + 2));
          if (!__lbg.stopped && __lbg.timer) {
            clearTimeout(__lbg.timer);
            __lbg.timer = setTimeout(function () { lbgActivate(container, idx + 1, true); }, sec * 1000);
          }
        });
      }
    }
  }

  // 全局首次交互解锁（浏览器自动播放策略：点一下页面任意处才出声）
  function lbgGlobalUnlock() {
    if (__lbg.audioUnlocked) {
      // 已解锁：解除监听，不再重复处理
      document.removeEventListener('pointerdown', lbgGlobalUnlock);
      document.removeEventListener('keydown', lbgGlobalUnlock);
      return;
    }
    // 已登录/主界面时 loginPage 不可见，不启动声音、不消耗解锁（保持监听，等登录页显示后点击才出声）
    var lp = document.getElementById('loginPage');
    if (!lp || lp.style.display === 'none') return;
    __lbg.audioUnlocked = true;
    document.removeEventListener('pointerdown', lbgGlobalUnlock);
    document.removeEventListener('keydown', lbgGlobalUnlock);
    lbgDoUnlock();
  }

  // 解锁启动（幂等）：标准 Android 浏览器触摸手势同时启动视频+音乐（Edge 允许手势并发）；
  // 接管型内核（OPPO WebView）仅静帧动效+音乐；build 未完成时点击会白跑 → lbgBuildPlayer 末尾补发
  function lbgDoUnlock() {
    if (__lbg.stopped) return;
    var cfg = __lbg.cfg || {};
    var gf = document.querySelector('.lbg-gesture-frame');
    // 接管型内核（OPPO WebView 等"视频一播即被系统播放器接管"，全屏事件都不触发）：
    // 触摸后也不启动视频——硬播=弹播放器+登录不可用；改为静帧 + Ken Burns 缓动 + 音乐
    var takeover = gf && (/; wv/i.test(navigator.userAgent || '') || !/Chrome\/\d/i.test(navigator.userAgent || ''));
    if (gf && takeover) {
      gf.classList.add('dynamic');
      lbgReport('pad-compat', { gf: true, ua: navigator.userAgent.slice(0, 80) });
    } else {
      // 标准 Android 浏览器（Chrome/Edge）：触摸手势同时启动视频+音乐
      if (gf) gf.remove();
      var lf = document.querySelector('.lbg-lastframe');
      if (lf) lf.remove();
    }
    // 音乐启动：
    // - 标准浏览器（Web Audio 可用）：触发音乐缓冲加载（不抢视频），decode 完成后自动起播（与视频真正同时，互不抢占）
    //   15 秒内未就绪 → audio 元素兜底（保证有声音）
    // - 平板/微信等其他内核：audio 元素直接播放
    var startMusic = function () {
      if (__lbg.stopped) return;
      if (!(cfg.music_enabled && cfg.music_url)) return;
      if (__lbg.ctxUsable) {
        lbgCtxEnsure();
        clearTimeout(__lbg._ctxFallbackT);
        __lbg._ctxFallbackT = setTimeout(function () {
          if (__lbg.stopped) return;
          var ready = __lbg.audioSrcNode && __lbg.audioSrcNode._playing;
          if (!ready && __lbg.audio && __lbg.audio.paused) {
            if (!__lbg.audio.src || __lbg.audio.src.indexOf(cfg.music_url) < 0) __lbg.audio.src = cfg.music_url;
            __lbg.audio.play().catch(function () {});
          }
        }, 15000);
        return;
      }
      if (__lbg.audio) {
        if (!__lbg.audio.src || __lbg.audio.src.indexOf(cfg.music_url) < 0) __lbg.audio.src = cfg.music_url;
        var ap = __lbg.audio.play();
        if (ap && ap.catch) ap.catch(function () {
          setTimeout(function () { // 部分内置浏览器音频焦点暂被占用 → 延迟重试
            if (!__lbg.stopped && __lbg.audioUnlocked && __lbg.audio && __lbg.audio.paused) __lbg.audio.play().catch(function () {});
          }, 500);
        });
      }
    };
    startMusic();
    // 无音乐且当前视频有原声 → 取消静音；有音乐则视频保持静音（音乐优先）
    if (!(cfg.music_enabled && cfg.music_url)) {
      for (var i = 0; i < __lbg.videoEls.length; i++) {
        var v = __lbg.videoEls[i];
        if (v && v.classList && v.classList.contains('active') && cfg.video_sound) {
          v.muted = false; try { v.play(); } catch (e) {}
        }
      }
    } else if (!document.querySelector('.lbg-gesture-frame')) {
      // 音乐模式：接管内核的 video 等首次手势才播 → 现在手势到了，启动；暂停的视频（X5 播完停在末帧）触摸续播
      for (var j = 0; j < __lbg.videoEls.length; j++) {
        var v2 = __lbg.videoEls[j];
        if (v2 && v2.classList && v2.classList.contains('active') && v2.paused && !document.querySelector('.lbg-freeze-frame')) {
          try { v2.play().catch(function () {}); } catch (e) {}
        }
      }
    }
    var hint = document.querySelector('.lbg-sound-hint');
    if (hint) hint.remove();
    lbgReport('unlock', { music: !!(cfg.music_enabled && cfg.music_url), videos: __lbg.videoEls.length });
  }

  // 音乐播放带"音频焦点被占用 → 延迟重试"（内置浏览器视频/音频会话抢占时）
  function lbgPlayMusicRetry() {
    if (__lbg.stopped || !__lbg.audioUnlocked) return;
    var cfg = __lbg.cfg || {};
    if (!(cfg.music_enabled && cfg.music_url)) return;
    if (__lbg.ctxUsable) { lbgCtxEnsure(); return; }
    if (!__lbg.audio) return;
    if (!__lbg.audio.src || __lbg.audio.src.indexOf(cfg.music_url) < 0) __lbg.audio.src = cfg.music_url;
    var ap = __lbg.audio.play();
    if (ap && ap.catch) ap.catch(function () {
      setTimeout(function () {
        if (!__lbg.stopped && __lbg.audioUnlocked && __lbg.audio && __lbg.audio.paused) __lbg.audio.play().catch(function () {});
      }, 500);
    });
  }

  // 音乐与视频原声协调：
  // - 音乐启用：音乐始终播放（画面照播），所有视频静音——音乐/视频可共存，不再互斥
  // - 音乐未启用：按视频原声开关（视频有声时音乐不存在，无冲突）
  function lbgHandleAudio(container, playingMusic) {
    var cfg = __lbg.cfg || {};
    var musicOn = !!(cfg.music_enabled && cfg.music_url);
    if (__lbg.stopped) { // 已停止后不复活音乐
      if (__lbg.audio) { try { __lbg.audio.pause(); } catch (e) {} }
      return;
    }
    if (musicOn) {
      if (__lbg.audio) lbgPlayMusicRetry();
      for (var i = 0; i < __lbg.videoEls.length; i++) {
        var v = __lbg.videoEls[i];
        if (v) { v.muted = true; }
      }
      return;
    }
    if (__lbg.audio) {
      if (playingMusic && cfg.music_enabled && cfg.music_url && __lbg.audioUnlocked) {
        lbgPlayMusicRetry();
      } else {
        try { __lbg.audio.pause(); } catch (e) {}
      }
    }
  }

  // 关闭背景画面时仍可播放独立音乐（纯音乐模式）：enabled 控制画面，music_enabled 独立控制音乐
  function lbgStandaloneMusic(cfg) {
    var musicOn = !!(cfg && cfg.music_enabled && cfg.music_url);
    if (!musicOn) {
      if (__lbg.audio) { try { __lbg.audio.pause(); __lbg.audio.src = ''; } catch (e) {} }
      return;
    }
    if (!__lbg.audio) { __lbg.audio = new Audio(); __lbg.audio.loop = true; __lbg.audio.preload = 'auto'; }
    if (__lbg.audio.src.indexOf(cfg.music_url) < 0) __lbg.audio.src = cfg.music_url;
    if (__lbg.audioUnlocked) lbgPlayMusicRetry();
    // 声音提示角标（首次点击页面解锁出声）——加在可见的登录页容器上
    var page = document.getElementById('loginPage');
    if (page && !page.querySelector('.lbg-sound-hint')) {
      var hint = document.createElement('div');
      hint.className = 'lbg-sound-hint';
      hint.textContent = '点击页面任意处开启声音';
      page.appendChild(hint);
    }
  }

  // ---------- 登录页集成 ----------
  function initLoginBg() {
    lbgApi('getConfig', {}).then(function (cfg) {
      __lbg.cfg = cfg;
      var player = document.getElementById('loginBgPlayer');
      if (!player) return;
      if (!cfg || !cfg.enabled) { player.style.display = 'none'; lbgStandaloneMusic(cfg); return; }
      player.style.display = 'block';
      lbgBuildPlayer(player, cfg, { allowSound: true });
    }).catch(function (e) { /* 表未初始化等静默：登录页保持原样；下次 tick 重试 */ __lbg.built = false; });
  }

  function lbgResume() {
    if (__lbg.stopped) { __lbg.stopped = false; } // 登录页重新可见：解除停止，恢复播放
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
    } else {
      // 登录页从未构建且不可见（已登录直接进主界面）→ 清空门禁预载的媒体，防止后台继续下载/误播
      var pre = window.__lbgPreloaded || [];
      for (var pi = 0; pi < pre.length; pi++) {
        var el = pre[pi];
        if (el) { try { if (el.pause) el.pause(); if (el.src) el.src = ''; } catch (e) {} pre[pi] = null; }
      }
      // 同时停掉编辑器试听音频（管理面板里点过试听，返回主界面不得留声）
      try { var pa = document.getElementById('lbgMusicPreviewAudio'); if (pa) { pa.pause(); pa.src = ''; } } catch (e) {}
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
  var LBG_SEG_KEYS = { lbgModeSeg: 'mode', lbgOrderSeg: 'order_mode', lbgLoopSeg: 'loop_count' };
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
            + '<button class="lui-btn tonal sm" type="button" style="flex:none; padding:0 10px;" onclick="window.__lbgPlaySong(' + i + ')">试听</button>'
            + '<button class="lui-btn primary sm" type="button" style="flex:none; padding:0 10px;" onclick="window.__lbgPickSong(' + i + ')">使用</button></div>';
        }).join('');
      })
      .catch(function (err) {
        if (box) box.innerHTML = '<div class="lui-mini" style="color:var(--red); padding:8px 4px;">' + lbgEsc(err && err.message || '搜索失败') + '</div>';
        lbgToast('搜索失败：' + (err && err.message || '请稍后再试'), 'error');
      });
  };
  window.__lbgPlaySong = function (i) {
    var s = window.__lbgSongsCache[i];
    if (!s) return;
    var a = document.getElementById('lbgMusicPreviewAudio');
    if (!a) { a = new Audio(); a.id = 'lbgMusicPreviewAudio'; a.preload = 'none'; }
    // 换歌前强制停止旧播放（不同音频流不会自动串，确保点第二首第一首立即停）
    try { a.pause(); a.removeAttribute('src'); a.load(); } catch (e) {}
    // 优先使用服务端解析地址（酷我完整版，302 到新鲜直链）；否则回退网易云外链
    a.src = (s.url || 'https://music.163.com/song/media/outer/url?id=' + s.id + '.mp3');
    a.play().catch(function () { lbgToast('浏览器需先与页面交互才能播放声音，请再点一次。', 'error'); });
  };
  window.__lbgPickSong = function (i) {
    var s = window.__lbgSongsCache[i];
    if (!s) return;
    __lbg.draft.music_url = (s.url || 'https://music.163.com/song/media/outer/url?id=' + s.id + '.mp3');
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
      static_url: (cfg && cfg.static_url) || null,
      loop_count: (cfg && cfg.loop_count != null) ? Number(cfg.loop_count) : 0,
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
      + '<div style="margin:14px 0 4px;"><div class="lui-label">视频循环</div>'
      + lbgSeg('lbgLoopSeg', [{ v: '0', t: '无限循环' }, { v: '1', t: '1遍' }, { v: '2', t: '2遍' }, { v: '3', t: '3遍' }], String(Number(d.loop_count) || 0), '视频播放')
      + '<div style="margin:14px 0 4px;"><div class="lui-label">停止后画面</div>'
      + '<div style="display:flex; align-items:center; gap:10px; margin-top:6px;">'
      + '<div id="lbgFreezePrev" style="width:60px;height:60px;border-radius:10px;background:#f0eef7 center/cover no-repeat;' + (d.static_url ? 'background-image:url(\'' + d.static_url.replace(/'/g, '\\\'') + '\');' : '') + ';"></div>'
      + '<div style="flex:1; display:flex; flex-direction:column; gap:6px;">'
      + '<button class="lui-btn tonal sm" type="button" onclick="window.__lbgOpenFramePicker()">' + lbgIcon('i-plus', 's14') + '从视频选一帧</button>'
      + '<button class="lui-btn tonal sm" type="button" onclick="window.__lbgPickFreezeImage()">上传一张图片</button>'
      + (d.static_url ? '<button class="lui-btn ghost sm" type="button" onclick="window.__lbgClearFreeze()">移除定格画面</button>' : '')
      + '</div></div>'
      + '<div class="lui-mini" style="color:var(--ink-3); margin-top:6px;">视频播完指定遍数后，定格显示这一帧；不设置则停留在最后一帧。</div></div>'
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
      static_url: d.static_url || null, loop_count: Number(d.loop_count) || 0,
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
      __lbg.cfg = Object.assign({}, __lbg.cfg, { enabled: !!d.enabled, mode: d.mode, order_mode: d.order_mode, template: d.template, music_enabled: d.music_enabled, video_sound: d.video_sound, music_url: d.music_url, music_name: d.music_name, photo_duration: d.photo_duration, static_url: d.static_url || null, loop_count: Number(d.loop_count) || 0, items: d.items });
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
    var cfg = { enabled: true, mode: d.mode, order_mode: d.order_mode, template: d.template, music_enabled: d.music_enabled, video_sound: d.video_sound, music_url: d.music_url, music_name: d.music_name, photo_duration: d.photo_duration, static_url: d.static_url || null, loop_count: Number(d.loop_count) || 0, items: items };
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

  // ---------- 定格帧（循环停止后画面）----------
  function lbgUpdateFreezeUi() {
    var d = __lbg.draft; if (!d) return;
    var prev = document.getElementById('lbgFreezePrev');
    if (prev) prev.style.backgroundImage = d.static_url ? 'url(\'' + d.static_url.replace(/'/g, '\\\'') + '\')' : 'none';
    // 重新渲染"移除"按钮区域
    var editor = document.getElementById('loginBgEditorModal');
    if (editor) { var btns = editor.querySelectorAll('button[onclick*="__lbgClearFreeze"]'); for (var i = 0; i < btns.length; i++) btns[i].parentElement.innerHTML = ''; }
  }
  window.__lbgClearFreeze = function () {
    __lbgDraftSet('static_url', null);
    lbgUpdateFreezeUi();
    lbgToast('已移除定格画面（将停留在视频最后一帧）。', 'info');
  };
  window.__lbgPickFreezeImage = function () {
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/jpeg,image/png,image/webp,image/gif';
    inp.onchange = function () {
      var f = inp.files && inp.files[0];
      if (!f) return;
      lbgToast('正在上传定格图片…', 'info');
      lbgUpload(f, false).then(function (url) {
        if (!url) throw new Error('上传失败');
        __lbgDraftSet('static_url', url);
        lbgUpdateFreezeUi();
        lbgToast('定格图片已设置：视频停播后显示这张图。', 'info');
      }).catch(function (e) { lbgToast('上传失败：' + e.message, 'error'); });
    };
    inp.click();
  };
  // 选帧工具：加载背景视频 → 拖动选时间 → 截取此帧 → 上传设为定格帧
  window.__lbgOpenFramePicker = function () {
    var d = __lbg.draft; if (!d) return;
    var vids = (d.items || []).filter(function (it) { return it.kind === 'video'; });
    if (!vids.length) { lbgToast('请先上传背景视频，才能选帧。', 'error'); return; }
    var url = vids[0].url;
    var mask = document.createElement('div');
    mask.style.cssText = 'position:fixed;inset:0;z-index:4000;background:rgba(10,10,20,.55);display:flex;align-items:center;justify-content:center;';
    mask.innerHTML = '<div style="width:min(520px,92vw);max-height:88vh;overflow:auto;background:#fff;border-radius:18px;padding:18px;box-sizing:border-box;">'
      + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;"><b style="font-size:16px;">从视频选一帧（定格画面）</b><button type="button" style="border:none;background:none;font-size:20px;color:#999;padding:4px 10px;" onclick="this.closest(\'div\').remove()">×</button></div>'
      + '<video id="lbgFrameVid" muted playsinline style="width:100%;border-radius:12px;background:#000;max-height:52vh;" src="' + url + '"></video>'
      + '<canvas id="lbgFrameCanvas" style="display:none;width:100%;border-radius:12px;background:#000;"></canvas>'
      + '<div style="display:flex;align-items:center;gap:10px;margin:12px 0 4px;"><span style="font-size:13px;color:#666;">选时间</span><input id="lbgFrameRange" type="range" min="0" max="100" value="0" style="flex:1;"><span id="lbgFrameTime" style="font-size:13px;color:#888;min-width:52px;">0.0s</span></div>'
      + '<div style="display:flex;gap:8px;margin-top:10px;">'
      + '<button type="button" id="lbgFrameOk" style="flex:1;background:#f472b6;color:#fff;border:none;border-radius:10px;padding:11px;font-size:14px;font-weight:600;">截取此帧并设为定格画面</button>'
      + '<button type="button" style="padding:11px 16px;border-radius:10px;border:1px solid #ddd;background:#fff;color:#666;" onclick="this.closest(\'div\').remove()">取消</button></div>'
      + '<div class="lui-mini" style="color:#aaa;margin-top:8px;">左右拖动选择画面，选好后点上方按钮；定格图会用于视频循环停止后的显示。</div></div>';
    document.body.appendChild(mask);
    var vid = mask.querySelector('#lbgFrameVid');
    var canvas = mask.querySelector('#lbgFrameCanvas');
    var range = mask.querySelector('#lbgFrameRange');
    var timeEl = mask.querySelector('#lbgFrameTime');
    var okBtn = mask.querySelector('#lbgFrameOk');
    var vidReady = false;
    var drawFrame = function () {
      if (!vidReady) return;
      canvas.width = vid.videoWidth; canvas.height = vid.videoHeight;
      canvas.style.display = 'block';
      canvas.getContext('2d').drawImage(vid, 0, 0, canvas.width, canvas.height);
    };
    vid.addEventListener('loadedmetadata', function () { vidReady = true; vid.currentTime = 0; });
    vid.addEventListener('seeked', function () { drawFrame(); vid.pause(); });
    range.oninput = function () {
      if (!vidReady) return;
      var dur = vid.duration || 1;
      vid.currentTime = (Number(range.value) / 100) * dur;
      timeEl.textContent = ((Number(range.value) / 100) * dur).toFixed(1) + 's';
    };
    vid.play().catch(function () {});
    okBtn.onclick = function () {
      if (!vidReady) { lbgToast('视频还没准备好，请稍候再试。', 'error'); return; }
      okBtn.disabled = true; okBtn.textContent = '截取中…';
      canvas.toBlob(function (blob) {
        if (!blob) { okBtn.disabled = false; okBtn.textContent = '截取此帧并设为定格画面'; lbgToast('截取失败，请重试。', 'error'); return; }
        var f = new File([blob], 'freeze-frame.jpg', { type: 'image/jpeg' });
        lbgUpload(f, false).then(function (u) {
          if (!u) throw new Error('上传失败');
          __lbgDraftSet('static_url', u);
          lbgUpdateFreezeUi();
          mask.remove();
          try { vid.pause(); vid.src = ''; } catch (e) {}
          lbgToast('定格画面已设置：视频循环停播后将显示这一帧。', 'info');
        }).catch(function (e) { okBtn.disabled = false; okBtn.textContent = '截取此帧并设为定格画面'; lbgToast('设置失败：' + e.message, 'error'); });
      }, 'image/jpeg', 0.9);
    };
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
    // 关闭编辑器时停止试听音频，防止退出后还在后台播放
    try { var pa = document.getElementById('lbgMusicPreviewAudio'); if (pa) { pa.pause(); pa.src = ''; } } catch (e) {}
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
  document.addEventListener('pointerdown', lbgGlobalUnlock);
  document.addEventListener('keydown', lbgGlobalUnlock);
  // 5) 登录页可见时初始化播放器（轮询，500ms 保证登录页一隐藏就立即停播，避免后台空转出声）
  setInterval(function () {
    try { lbgTick(); } catch (e) {}
  }, 500);
  // 6) 登录页一隐藏（登录成功/退出）立即停播：MutationObserver 即时生效，不等轮询周期
  (function () {
    var lp = document.getElementById('loginPage');
    if (!lp || !window.MutationObserver) return;
    var mo = new MutationObserver(function () {
      if (lp.style.display === 'none' && __lbg.built && !__lbg.paused) {
        __lbg.paused = true;
        try { lbgStopPlayer(); } catch (e) {}
      }
    });
    mo.observe(lp, { attributes: true, attributeFilter: ['style'] });
  })();
  // 供外部（登录成功/退出登录等）立即停声
  window.__lbgStopAll = function () { try { lbgStopPlayer(); } catch (e) {} };
})();
