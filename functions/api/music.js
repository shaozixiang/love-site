// 背景音乐搜索/解析代理
// search：QQ/咪咕/网易云负责原唱与相关性，酷我优先提供完整音源；咪咕可播时补充第三完整源
// resolve/stream：酷我 rid → 动态解析并流式播放完整音源
// miguStream：咪咕 copyrightId/contentId → 动态解析并流式播放完整音源
// play：网易云外链代理（未匹配歌曲使用，版权限制时可能仅有试听）
// 登录态：search 需要有效会话（防滥用）；resolve/stream/miguStream/play 免登录（登录页未登录时也要播放）
import { getConfig, requireSession } from '../_lib/session.js';
import { resolveTenant } from '../_lib/tenant.js';

const NETEASE_SEARCH = 'https://music.163.com/api/search/get/web';
const NETEASE_OUTER = 'https://music.163.com/song/media/outer/url';
const NETEASE_SONG_URL = 'https://music.163.com/api/song/enhance/player/url';
const NETEASE_PROXY = 'https://api.injahow.cn/meting/?type=url&id=';
const KUWO_SEARCH = 'https://search.kuwo.cn/r.s';
const KUWO_ANTI = 'http://antiserver.kuwo.cn/anti.s';
const QQ_SEARCH = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp';
const MIGU_SEARCH = 'https://pd.musicapp.migu.cn/MIGUM2.0/v1.0/content/search_all.do';
const MIGU_LISTEN = 'https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/sub/listenSong.do';
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const MIGU_SEARCH_SWITCH = JSON.stringify({ song: 1, album: 0, singer: 0, tag: 0, playlist: 0, mv: 0, user: 0, rb: 0, dv: 0, podcast: 0, voice: 0, songlist: 0, radio: 0, cp: 0 });

// 短缓存：同一 rid 的酷我直链 120s 内复用（直链本身约 4 分钟有效，留足安全余量），
// 避免音频分段 Range 请求反复走 anti.s 解析造成缓冲卡顿
const _directCache = new Map();
async function resolveKuwoDirect(rid) {
  const now = Date.now();
  const hit = _directCache.get(rid);
  if (hit && now - hit.t < 120000) return hit.url;
  const antiResp = await fetch(KUWO_ANTI + '?format=mp3&rid=' + encodeURIComponent(rid) + '&type=convert_url&response=url', {
    headers: { 'User-Agent': UA }
  });
  if (!antiResp.ok) throw new Error('kuwo resolve ' + antiResp.status);
  const direct = (await antiResp.text()).trim();
  if (!/^https?:\/\//.test(direct)) throw new Error('kuwo invalid direct');
  _directCache.set(rid, { t: now, url: direct });
  return direct;
}

// 咪咕直链时效更短，同样做 120 秒短缓存，避免试听/拖进度条时重复换取
const _miguDirectCache = new Map();
async function resolveMiguDirect(songId, copyrightId, contentId) {
  const key = String(songId) + ':' + String(copyrightId) + ':' + String(contentId);
  const now = Date.now();
  const hit = _miguDirectCache.get(key);
  if (hit && now - hit.t < 120000) return hit.url;
  const query = new URLSearchParams({
    toneFlag: 'PQ', netType: '00', userId: '1554861458870011', ua: 'Android_migu', version: '5.9',
    channel: '014000D', copyrightId: String(copyrightId), contentId: String(contentId),
    resourceType: '2', formatType: 'PQ', songId: String(songId)
  });
  const resp = await fetch(MIGU_LISTEN + '?' + query.toString(), {
    redirect: 'manual',
    headers: { 'User-Agent': MOBILE_UA, Referer: 'https://music.migu.cn/' }
  });
  const location = resp.headers.get('location') || '';
  if (!/^https?:\/\//.test(location)) {
    const body = await resp.text().catch(() => '');
    throw new Error('migu unavailable ' + body.slice(0, 80));
  }
  _miguDirectCache.set(key, { t: now, url: location });
  return location;
}

// 网易云官方播放地址接口：比 outer/url 稳定，且能拿到文件大小和试听片段信息。
// 版权受限歌曲会返回 30/45 秒试听，仍可播；url 为空时才判不可播。
const _neteaseDirectCache = new Map();
async function resolveNeteaseDirect(id) {
  const key = String(id);
  const now = Date.now();
  const hit = _neteaseDirectCache.get(key);
  if (hit && now - hit.t < 120000) return hit;
  const resp = await fetch(NETEASE_SONG_URL + '?ids=[' + encodeURIComponent(id) + ']&br=320000', {
    headers: { 'User-Agent': MOBILE_UA, Referer: 'https://music.163.com/', Cookie: 'appver=8.9.70; os=android', Accept: 'application/json' }
  });
  if (!resp.ok) throw new Error('netease url ' + resp.status);
  const data = await resp.json();
  const item = data && data.data && data.data[0];
  if (!item || !item.url) throw new Error('netease unavailable');
  const meta = {
    t: now,
    url: item.url,
    size: Number(item.size || 0),
    trial: !!item.freeTrialInfo,
    type: item.type || 'mp3'
  };
  _neteaseDirectCache.set(key, meta);
  return meta;
}

// Cloudflare 出口访问网易云官方接口会被风控，改用公开解析节点取音频；Range 仍透传给最终 CDN。
const _neteaseProxyCache = new Map();
async function probeNeteaseProxy(id) {
  const key = String(id);
  const now = Date.now();
  const hit = _neteaseProxyCache.get(key);
  if (hit && now - hit.t < 120000) return hit;
  const resp = await fetch(NETEASE_PROXY + encodeURIComponent(id), {
    headers: { 'User-Agent': MOBILE_UA, Range: 'bytes=0-0' }
  });
  const ctype = resp.headers.get('content-type') || '';
  const cr = resp.headers.get('content-range') || '';
  if ((resp.status !== 200 && resp.status !== 206) || (ctype.indexOf('audio') < 0 && ctype.indexOf('octet-stream') < 0)) {
    throw new Error('netease proxy unavailable');
  }
  const total = Number((/(\d+)$/.exec(cr) || [])[1] || 0);
  const meta = { t: now, size: total, url: NETEASE_PROXY + encodeURIComponent(id) };
  _neteaseProxyCache.set(key, meta);
  return meta;
}

export async function onRequestGet(context) {
  return handle(context);
}
export async function onRequestPost(context) {
  return handle(context);
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Couple-Token', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }
  });
}

async function handle({ request, env }) {
  if (request.method === 'OPTIONS') return json({ ok: true });

  const url = new URL(request.url);
  let action = url.searchParams.get('action');
  let keyword = url.searchParams.get('s');
  let id = url.searchParams.get('id');
  let rid = url.searchParams.get('rid');
  if (!action && request.method === 'POST') {
    try {
      const body = await request.json();
      action = body.action || action;
      keyword = body.keyword || body.s || keyword;
      id = body.id || id;
      rid = body.rid || rid;
    } catch (e) {}
  }

  const needLogin = action === 'search';
  if (needLogin) {
    const authConfig = getConfig(env);
    if (!authConfig.ok) return json({ error: authConfig.error }, 500);
    const currentTenant = await resolveTenant(request, authConfig);
    const sessionToken = request.headers.get('X-Couple-Token') || (url.searchParams.get('sessionToken') || '');
    try { await requireSession(authConfig, sessionToken, currentTenant); }
    catch (e) { return json({ error: '需要登录后才能搜索音乐' }, 401); }
  }

  if (action === 'search') {
    if (!keyword || String(keyword).trim().length < 1) return json({ error: '请输入歌名' }, 400);
    const q = String(keyword).trim();
    // 四曲库并行：QQ/咪咕提供更准确的原唱曲库与额外完整音源，网易云/酷我保留原有可播链路。
    const results = await Promise.allSettled([neteaseSearch(q), kuwoSearch(q), qqSearch(q), miguSearch(q)]);
    const neteaseSongs = results[0].status === 'fulfilled' ? results[0].value : [];
    const kuwoSongs = results[1].status === 'fulfilled' ? results[1].value : [];
    const qqSongs = results[2].status === 'fulfilled' ? results[2].value : [];
    let miguSongs = results[3].status === 'fulfilled' ? results[3].value : [];
    // QQ/咪咕对“歌名+歌手”和“完整版本名”的召回不同：用 QQ 命中的完整原唱名再查一次咪咕，
    // 解决《宝贝 (In A Day)》这类“搜歌手只出翻唱、搜完整名才有原唱”的缺口。
    const extraNames = [];
    for (let qi = 0; qi < qqSongs.length && extraNames.length < 3; qi++) {
      const qn = musicNorm(qqSongs[qi].name);
      const base = musicBaseTitle(qqSongs[qi].name);
      if (!qn || qn === base || musicHasVariant(qqSongs[qi].name)) continue;
      if (extraNames.indexOf(qn) >= 0) continue;
      extraNames.push(qn);
    }
    if (extraNames.length) {
      const extraChecks = await Promise.allSettled(extraNames.map(function (name) { return miguSearch(name, 3); }));
      const seenMiguIds = {};
      miguSongs.forEach(function (s) { seenMiguIds[String(s.id)] = true; });
      extraChecks.forEach(function (check) {
        if (check.status !== 'fulfilled') return;
        check.value.forEach(function (song) {
          if (!seenMiguIds[String(song.id)]) { seenMiguIds[String(song.id)] = true; miguSongs.push(song); }
        });
      });
      miguSongs.sort(function (a, b) {
        const aExact = a.playable && !musicNorm(a.artist) ? 1 : 0;
        const bExact = b.playable && !musicNorm(b.artist) ? 1 : 0;
        return bExact - aExact;
      });
    }
    const songs = mergeMusicResults(q, neteaseSongs, kuwoSongs, qqSongs, miguSongs);
    let currentSong = null;
    const currentRid = String(url.searchParams.get('currentRid') || '');
    if (currentRid) {
      const hit = kuwoSongs.find(function (song) { return song.url && song.url.indexOf('rid=' + currentRid) >= 0; });
      if (hit) currentSong = { name: hit.name, artist: hit.artist, url: hit.url, rid: currentRid };
    }
    if (songs.length) return json({ ok: true, songs, current: currentSong, sources: { netease: neteaseSongs.length, kuwo: kuwoSongs.length, qq: qqSongs.length, migu: miguSongs.length } });
    return json({ error: '没搜到相关歌曲，换个关键词试试' }, 404);
  }

  if (action === 'resolve') {
    // 酷我 rid → 拿完整 mp3 直链 → 302 重定向（audio 元素自动跟随，无 CORS 限制）
    if (!/^MUSIC_\d+$/.test(String(rid || ''))) return json({ error: '参数错误' }, 400);
    try {
      const direct = await resolveKuwoDirect(rid);
      return new Response(null, { status: 302, headers: { Location: direct } });
    } catch (e) {
      return json({ error: '播放服务暂时不可用，请稍后再试' }, 502);
    }
  }

  if (action === 'stream') {
    // 酷我完整曲目"流式代理"：客户端 src 直指本代理 → worker 解析直链并转发 mp3 流，
    // 重写为 inline 播放头（COS 原头 attachment 会让移动端当下载反复断流），全端稳定。
    if (!/^MUSIC_\d+$/.test(String(rid || ''))) return json({ error: '参数错误' }, 400);
    try {
      const direct = await resolveKuwoDirect(rid);
      const rangeHeader = request.headers.get('range');
      const upstream = await fetch(direct, {
        redirect: 'follow',
        headers: {
          'User-Agent': UA,
          'Referer': 'https://www.kuwo.cn/',
          ...(rangeHeader ? { 'Range': rangeHeader } : {})
        }
      });
      if (!upstream.ok && upstream.status !== 206) return json({ error: '音频源暂不可用' }, 502);
      const headers = new Headers();
      headers.set('Content-Type', 'audio/mpeg');
      headers.set('Content-Disposition', 'inline'); // 关键：COS 原响应是 attachment，重写为 inline 才能正常播放
      headers.set('Cache-Control', 'public, max-age=3600');
      headers.set('Accept-Ranges', 'bytes');
      if (upstream.status === 206 && upstream.headers.get('content-range')) headers.set('Content-Range', upstream.headers.get('content-range'));
      if (upstream.headers.get('content-length')) headers.set('Content-Length', upstream.headers.get('content-length'));
      return new Response(upstream.body, { status: upstream.status === 206 ? 206 : 200, headers: headers });
    } catch (e) {
      return json({ error: '播放服务暂时不可用，请稍后再试' }, 502);
    }
  }

  if (action === 'miguStream') {
    // 咪咕版权受限歌曲在换链时返回 JSON；只有拿到 302 直链才进入流代理。
    const songId = url.searchParams.get('songId') || url.searchParams.get('id') || '';
    const copyrightId = url.searchParams.get('copyrightId') || '';
    const contentId = url.searchParams.get('contentId') || '';
    if (!/^\d{5,}$/.test(songId) || !/^[A-Za-z0-9]{5,}$/.test(copyrightId) || !/^[A-Za-z0-9]{5,}$/.test(contentId)) return json({ error: '参数错误' }, 400);
    try {
      const direct = await resolveMiguDirect(songId, copyrightId, contentId);
      const rangeHeader = request.headers.get('range');
      const upstream = await fetch(direct, {
        redirect: 'follow',
        headers: {
          'User-Agent': MOBILE_UA,
          Referer: 'https://music.migu.cn/',
          ...(rangeHeader ? { Range: rangeHeader } : {})
        }
      });
      if (!upstream.ok && upstream.status !== 206) return json({ error: '音频源暂不可用' }, 502);
      const headers = new Headers();
      headers.set('Content-Type', upstream.headers.get('content-type') || 'audio/mpeg');
      headers.set('Content-Disposition', 'inline');
      headers.set('Cache-Control', 'public, max-age=3600');
      headers.set('Accept-Ranges', 'bytes');
      if (upstream.status === 206 && upstream.headers.get('content-range')) headers.set('Content-Range', upstream.headers.get('content-range'));
      if (upstream.headers.get('content-length')) headers.set('Content-Length', upstream.headers.get('content-length'));
      return new Response(upstream.body, { status: upstream.status === 206 ? 206 : 200, headers: headers });
    } catch (e) {
      return json({ error: '该歌曲暂时无法播放（咪咕版权限制）' }, 404);
    }
  }

  if (action === 'play') {
    if (!/^\d+$/.test(String(id || ''))) return json({ error: '参数错误' }, 400);
    try {
      const rangeHeader = request.headers.get('range');
      const audioHeaders = {
        'User-Agent': MOBILE_UA,
        'Referer': 'https://music.163.com/',
        ...(rangeHeader ? { 'Range': rangeHeader } : {})
      };
      let upstream = null;
      try {
        upstream = await fetch(NETEASE_PROXY + encodeURIComponent(id), { redirect: 'follow', headers: audioHeaders });
      } catch (e) { upstream = null; }
      const firstType = upstream ? (upstream.headers.get('content-type') || '') : '';
      const firstOk = !!upstream && (upstream.ok || upstream.status === 206)
        && (firstType.indexOf('audio') >= 0 || firstType.indexOf('octet-stream') >= 0);
      if (!firstOk) {
        // 公开解析节点异常时回退网易云官方接口（部分地区/出口可能可用）
        try {
          const meta = await resolveNeteaseDirect(id);
          upstream = await fetch(meta.url, { redirect: 'follow', headers: audioHeaders });
        } catch (e) {
          return json({ error: '该歌曲暂时无法播放（可能无版权外链）' }, 404);
        }
      }
      const ctype = upstream.headers.get('content-type') || '';
      if (!upstream.ok && upstream.status !== 206) return json({ error: '该歌曲暂时无法播放（可能无版权外链）' }, 404);
      if (ctype.indexOf('text/html') >= 0 || ctype.indexOf('application/json') >= 0) return json({ error: '该歌曲暂时无法播放（可能无版权外链）' }, 404);
      const headers = new Headers();
      headers.set('Content-Type', ctype || 'audio/mpeg');
      headers.set('Content-Disposition', 'inline');
      headers.set('Cache-Control', 'public, max-age=3600');
      headers.set('Accept-Ranges', 'bytes');
      if (upstream.status === 206 && upstream.headers.get('content-range')) headers.set('Content-Range', upstream.headers.get('content-range'));
      if (upstream.headers.get('content-length')) headers.set('Content-Length', upstream.headers.get('content-length'));
      return new Response(upstream.body, { status: upstream.status, headers: headers });
    } catch (e) {
      return json({ error: '该歌曲暂时无法播放（可能无版权外链）' }, 404);
    }
  }

  return json({ error: '参数错误' }, 400);
}

// 酷我搜索：返回 {id: rid, name, artist, duration(ms), url: resolve 代理}
async function kuwoSearch(keyword) {
  const resp = await fetch(KUWO_SEARCH + '?all=' + encodeURIComponent(keyword) + '&ft=music&itemset=web_2013&client=kt&pn=0&rn=15&rformat=json&encoding=utf8', {
    headers: { 'User-Agent': UA, 'Referer': 'https://www.kuwo.cn/' }
  });
  if (!resp.ok) throw new Error('kuwo ' + resp.status);
  const text = await resp.text();
  if (!text || text.indexOf('abslist') < 0) throw new Error('kuwo empty');
  // 酷我返回单引号 JSON，且字段顺序不定（MUSICRID 可能不在对象开头）：
  // 先切出 abslist 数组体，再按对象边界 "},{'" 切分，逐对象提取字段
  const start = text.indexOf("'abslist':[");
  if (start < 0) throw new Error('kuwo no abslist');
  const arrText = text.slice(start + 11, text.lastIndexOf(']'));
  const objs = arrText.split("},{'");
  const out = [];
  for (const o of objs) {
    const ridM = /'MUSICRID':'([^']*)'/.exec(o);
    const nameM = /'SONGNAME':'([^']*)'/.exec(o);
    const artM = /'ARTIST':'([^']*)'/.exec(o);
    const durM = /'DURATION':'([^']*)'/.exec(o);
    const rid = ridM ? ridM[1] : '';
    const name = nameM ? nameM[1].replace(/&nbsp;/g, ' ') : '';
    const artist = artM ? artM[1].replace(/&nbsp;/g, ' ') : '';
    const secs = durM ? parseInt(durM[1], 10) || 0 : 0;
    if (!rid || !name) continue;
    out.push({
      id: rid,
      name: name,
      artist: artist || '',
      album: '',
      duration: secs * 1000,
      url: '/api/music?action=resolve&rid=' + rid,
      playSource: 'kuwo',
      sourceLabel: '酷我音乐',
      full: true,
      playable: true
    });
    if (out.length >= 15) break;
  }
  return out;
}

function musicNorm(value) {
  return String(value || '').toLowerCase().replace(/[\s·•・,，.。!！?？:：;；'\"‘’“”_\-—/\\|]+/g, '');
}
function musicBaseTitle(value) {
  return musicNorm(String(value || '').replace(/[\(（\[【][^\)）\]】]*[\)）\]】]/g, ''));
}
function musicArtistMatches(a, b) {
  const left = musicNorm(a), right = musicNorm(b);
  if (!left || !right) return left === right;
  return left.indexOf(right) >= 0 || right.indexOf(left) >= 0;
}
function musicKey(song) {
  // 用完整歌名去重：不能把《宝贝 (In a Day)》和《宝贝 (in the night)》合并成同一首
  return musicNorm(song.name) + '|' + musicNorm(song.artist);
}
function musicQueryScore(song, keyword) {
  const q = musicNorm(keyword);
  const title = musicBaseTitle(song.name);
  const artist = musicNorm(song.artist);
  let score = 0;
  // 歌名命中远高于歌手命中：搜“晴天 周杰伦”时不能把《夜曲》排到《晴天》前面。
  if (title && q.indexOf(title) >= 0) score += 100;
  if (artist && q.indexOf(artist) >= 0) score += 35;
  if (song.playable) score += 10;
  if (song.full) score += 8;
  return score;
}
function musicHasVariant(name) {
  return /(live|cover|翻唱|现场|演唱会|伴奏|remix|mix|dj|试听|片段|纯音乐|instrumental|改编|舒缓|两会|网友|版|伴唱|消音|加速|降速|吉他|0\.8x|1\.1x|1\.2x|1\.5x)/i.test(String(name || ''));
}
function findExactMusic(list, song) {
  const exactTitle = musicNorm(song.name), baseTitle = musicBaseTitle(song.name);
  const exact = list.filter(function (candidate) {
    return musicNorm(candidate.name) === exactTitle && musicArtistMatches(song.artist, candidate.artist);
  });
  if (exact.length) return exact.find(function (candidate) { return candidate.full && candidate.playable; }) || exact[0];
  if (baseTitle && !musicHasVariant(song.name)) {
    const base = list.filter(function (candidate) {
      return musicBaseTitle(candidate.name) === baseTitle && !musicHasVariant(candidate.name) && musicArtistMatches(song.artist, candidate.artist);
    });
    if (base.length) return base.find(function (candidate) { return candidate.full && candidate.playable; }) || base[0];
  }
  return null;
}
function mergeMusicResults(keyword, neteaseSongs, kuwoSongs, qqSongs, miguSongs) {
  const candidates = [];
  const seen = new Set();
  function add(song) {
    const key = musicKey(song);
    if (!key || seen.has(key)) return null;
    seen.add(key); candidates.push(song); return song;
  }
  function same(song) {
    const key = musicKey(song);
    return candidates.find(function (candidate) { return musicKey(candidate) === key; });
  }

  // QQ/咪咕先进入，保证知名歌曲的原唱版本优先出现；再尝试从酷我/网易云补可播地址。
  qqSongs.forEach(function (song) {
    const kuwo = findExactMusic(kuwoSongs, song);
    const netease = findExactMusic(neteaseSongs, song);
    // 咪咕部分原唱条目歌手字段为空：仅当完整歌名完全一致且不是 Live/翻唱时才允许绑定。
    const miguExact = !musicHasVariant(song.name) && miguSongs.find(function (candidate) {
      return candidate.playable && !musicNorm(candidate.artist) && musicNorm(candidate.name) === musicNorm(song.name);
    });
    if (miguExact) miguExact._used = true;
    add(Object.assign({}, song,
      miguExact ? { url: miguExact.url, playSource: 'migu', sourceLabel: '咪咕音乐', full: true, playable: true } :
      kuwo ? { url: kuwo.url, playSource: 'kuwo', sourceLabel: '酷我音乐', full: true, playable: true } :
      netease ? { url: netease.url, playSource: 'netease', sourceLabel: '网易云音乐', full: !!netease.full, playable: netease.playable !== false } :
      { url: '', playSource: 'qq', sourceLabel: 'QQ音乐', full: false, playable: false }));
  });
  miguSongs.forEach(function (song) {
    if (song._used) return;
    const existing = same(song);
    if (existing) {
      if (song.playable && (!existing.full || !existing.playable)) {
        existing.url = song.url; existing.playSource = 'migu'; existing.full = true; existing.playable = true;
        existing.sourceLabel = '咪咕音乐';
      }
      return;
    }
    const kuwo = findExactMusic(kuwoSongs, song);
    const netease = findExactMusic(neteaseSongs, song);
    add(Object.assign({}, song,
      song.playable ? {} :
      kuwo ? { url: kuwo.url, playSource: 'kuwo', sourceLabel: '酷我音乐', full: true, playable: true } :
      netease ? { url: netease.url, playSource: 'netease', sourceLabel: '网易云音乐', full: !!netease.full, playable: netease.playable !== false } :
      { url: '', playSource: 'migu', sourceLabel: '咪咕音乐', full: false, playable: false }));
  });
  neteaseSongs.forEach(function (song) {
    const existing = same(song);
    if (existing) {
      if (!existing.playable && song.url && song.playable !== false) {
        existing.url = song.url; existing.playSource = 'netease'; existing.sourceLabel = '网易云音乐'; existing.playable = true;
      }
      return;
    }
    const kuwo = findExactMusic(kuwoSongs, song);
    add(Object.assign({}, song, kuwo ? { url: kuwo.url, playSource: 'kuwo', sourceLabel: '酷我音乐', full: true, playable: true } : {}));
  });

  // 其他曲库完全没结果时，酷我兜底，避免搜索空白。
  if (!candidates.length) return kuwoSongs.slice(0, 15);
  const qNorm = musicNorm(keyword);
  let ranked = candidates
    .map(function (song, index) { return { song: song, index: index, score: musicQueryScore(song, keyword) }; });
  // 只要结果里有歌名命中，就不要把同歌手的无关歌曲（《夜曲》《发如雪》）混进前排。
  if (ranked.some(function (item) { return qNorm.indexOf(musicBaseTitle(item.song.name)) >= 0; })) {
    ranked = ranked.filter(function (item) { return qNorm.indexOf(musicBaseTitle(item.song.name)) >= 0; });
  }
  return ranked
    .sort(function (a, b) { return b.score - a.score || a.index - b.index; })
    .slice(0, 20)
    .map(function (item) { return item.song; });
}

// QQ音乐：原唱曲库准确度高；无授权直链时仅提供原唱信息，不冒充完整音源。
async function qqSearch(keyword) {
  const params = new URLSearchParams({ w: keyword, format: 'json', n: '15', p: '1' });
  const resp = await fetch(QQ_SEARCH + '?' + params.toString(), {
    headers: { 'User-Agent': UA, Referer: 'https://y.qq.com/', Accept: 'application/json' }
  });
  if (!resp.ok) throw new Error('qq ' + resp.status);
  const data = await resp.json();
  const list = data && data.data && data.data.song && data.data.song.list;
  if (!Array.isArray(list)) return [];
  return list.slice(0, 15).map(function (s) {
    const singers = s.singer || [];
    return {
      id: s.songid || s.songmid,
      name: s.songname || '',
      artist: singers.map(function (a) { return a.name; }).join(' / '),
      album: s.albumname || '',
      duration: Number(s.interval || 0) * 1000,
      albumPic: s.albummid ? 'https://y.qq.com/music/photo_new/T002R300x300M000' + s.albummid + '.jpg' : '',
      url: '', playSource: 'qq', sourceLabel: 'QQ音乐', full: false, playable: false
    };
  }).filter(function (s) { return s.name; });
}

// 咪咕：先搜索准确原唱，再对前几条尝试换取可播直链；受版权限制的保留信息但不标完整音源。
async function miguSearch(keyword, checkLimit) {
  const maxCheck = Math.max(0, Number(checkLimit) || 6);
  const params = new URLSearchParams({ text: keyword, pageNo: '1', pageSize: '15', searchSwitch: MIGU_SEARCH_SWITCH });
  const resp = await fetch(MIGU_SEARCH + '?' + params.toString(), {
    headers: { 'User-Agent': MOBILE_UA, Referer: 'https://music.migu.cn/', Accept: 'application/json' }
  });
  if (!resp.ok) throw new Error('migu ' + resp.status);
  const data = await resp.json();
  const list = data && data.songResultData && data.songResultData.result;
  if (!Array.isArray(list)) return [];
  const songs = list.slice(0, 15).map(function (s) {
    const singers = s.singers || [];
    return {
      id: s.id || '',
      name: s.name || '',
      artist: singers.map(function (a) { return a.name; }).join(' / '),
      album: (s.albums && s.albums[0] && s.albums[0].name) || '',
      duration: Number(s.duration || s.playTime || 0),
      albumPic: (s.imgItems && s.imgItems[0] && s.imgItems[0].img) || '',
      copyrightId: s.copyrightId || '',
      contentId: s.contentId || '',
      url: '', playSource: 'migu', sourceLabel: '咪咕音乐', full: false, playable: false
    };
  }).filter(function (s) { return s.name && s.id && s.copyrightId && s.contentId; });
  const checks = await Promise.allSettled(songs.slice(0, maxCheck).map(function (s) {
    return resolveMiguDirect(s.id, s.copyrightId, s.contentId);
  }));
  checks.forEach(function (check, index) {
    if (check.status !== 'fulfilled' || !songs[index]) return;
    songs[index].url = '/api/music?action=miguStream&songId=' + encodeURIComponent(songs[index].id)
      + '&copyrightId=' + encodeURIComponent(songs[index].copyrightId)
      + '&contentId=' + encodeURIComponent(songs[index].contentId);
    songs[index].full = true; songs[index].playable = true;
  });
  return songs;
}

// 网易云搜索：兼容 artists/ar 字段；duration 毫秒
async function neteaseSearch(keyword) {
  const q = encodeURIComponent(keyword);
  const endpoints = [
    'https://music.163.com/api/search/get/web?s=' + q + '&type=1&limit=15',
    'https://music.163.com/api/search/get?s=' + q + '&type=1&limit=15',
    'https://music.163.com/api/cloudsearch/pc?s=' + q + '&type=1&limit=15'
  ];
  for (const ep of endpoints) {
    try {
      const resp = await fetch(ep, {
        headers: { 'User-Agent': UA, 'Referer': 'https://music.163.com/', 'Accept': 'application/json' }
      });
      if (!resp.ok) continue;
      const data = await resp.json();
      const list = (data && data.result && data.result.songs) || [];
      if (!list || !list.length) continue;
      const result = list.slice(0, 15).map(function (s) {
        const arts = s.artists || s.ar || [];
        return {
          id: s.id,
          name: s.name || '',
          artist: arts.map(function (a) { return a.name; }).join(' / '),
          album: (s.album && s.album.name) || (s.al && s.al.name) || '',
          duration: s.duration || s.dt || 0,
          albumPic: (s.album && s.album.picUrl) || (s.al && s.al.picUrl) || '',
          url: '/api/music?action=play&id=' + s.id,
          playSource: 'netease',
          sourceLabel: '网易云音乐',
          full: false,
          playable: true
        };
      });
      // 用公开解析节点探测前 6 条：能拿到音频才可播；文件 ≥1.5MB 视为完整音源。
      const checks = await Promise.allSettled(result.slice(0, 6).map(function (s) {
        return probeNeteaseProxy(s.id);
      }));
      checks.forEach(function (check, index) {
        if (!result[index]) return;
        if (check.status !== 'fulfilled') { result[index].playable = false; return; }
        result[index].playable = true;
        result[index].full = check.value.size >= 1500000;
        result[index].fileSize = check.value.size;
      });
      return result;
    } catch (e) { continue; }
  }
  return [];
}
