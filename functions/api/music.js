// 背景音乐搜索/解析代理
// search：网易云相关性优先，自动匹配酷我完整音源；网易云不可用时回退酷我
// resolve/stream：酷我 rid → 动态解析并流式播放完整音源
// play：网易云外链代理（未匹配歌曲使用，版权限制时可能仅有试听）
// 登录态：search 需要有效会话（防滥用）；resolve/play 免登录（登录页未登录时也要播放）
import { getConfig, requireSession } from '../_lib/session.js';
import { resolveTenant } from '../_lib/tenant.js';

const NETEASE_SEARCH = 'https://music.163.com/api/search/get/web';
const NETEASE_OUTER = 'https://music.163.com/song/media/outer/url';
const KUWO_SEARCH = 'https://search.kuwo.cn/r.s';
const KUWO_ANTI = 'http://antiserver.kuwo.cn/anti.s';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

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
    // 双音源并行：网易云负责歌名/歌手相关性，酷我负责可匹配的完整播放地址。
    // 不再让酷我的低相关排序覆盖知名歌曲的网易云结果。
    const [neteaseResult, kuwoResult] = await Promise.allSettled([neteaseSearch(q), kuwoSearch(q)]);
    const neteaseSongs = neteaseResult.status === 'fulfilled' ? neteaseResult.value : [];
    const kuwoSongs = kuwoResult.status === 'fulfilled' ? kuwoResult.value : [];
    const songs = mergeMusicResults(neteaseSongs, kuwoSongs);
    if (songs.length) return json({ ok: true, songs, source: neteaseSongs.length ? 'netease' : 'kuwo' });
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

  if (action === 'play') {
    if (!/^\d+$/.test(String(id || ''))) return json({ error: '参数错误' }, 400);
    try {
      const upstream = await fetch(NETEASE_OUTER + '?id=' + id + '.mp3', {
        redirect: 'follow',
        headers: {
          'User-Agent': UA,
          'Referer': 'https://music.163.com/',
          ...(request.headers.get('range') ? { 'Range': request.headers.get('range') } : {})
        }
      });
      const ctype = upstream.headers.get('content-type') || '';
      if (!upstream.ok && upstream.status !== 206) return json({ error: '该歌曲暂时无法播放（可能无版权外链）' }, 404);
      if (ctype.indexOf('text/html') >= 0) return json({ error: '该歌曲暂时无法播放（可能无版权外链）' }, 404);
      const headers = new Headers();
      headers.set('Content-Type', ctype || 'audio/mpeg');
      headers.set('Cache-Control', 'public, max-age=3600');
      headers.set('Accept-Ranges', 'bytes');
      if (upstream.status === 206 && upstream.headers.get('content-range')) headers.set('Content-Range', upstream.headers.get('content-range'));
      if (upstream.headers.get('content-length')) headers.set('Content-Length', upstream.headers.get('content-length'));
      return new Response(upstream.body, { status: upstream.status, headers: headers });
    } catch (e) {
      return json({ error: '播放服务暂时不可用，请稍后再试' }, 502);
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
      full: true
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
  if (!left || !right) return true;
  return left.indexOf(right) >= 0 || right.indexOf(left) >= 0;
}
function mergeMusicResults(neteaseSongs, kuwoSongs) {
  if (!neteaseSongs.length) return kuwoSongs.slice(0, 15);
  const remaining = kuwoSongs.slice();
  return neteaseSongs.slice(0, 15).map(function (song) {
    const exactTitle = musicNorm(song.name), baseTitle = musicBaseTitle(song.name);
    let matchIndex = remaining.findIndex(function (candidate) {
      return musicNorm(candidate.name) === exactTitle && musicArtistMatches(song.artist, candidate.artist);
    });
    if (matchIndex < 0 && baseTitle) {
      matchIndex = remaining.findIndex(function (candidate) {
        return musicBaseTitle(candidate.name) === baseTitle && musicArtistMatches(song.artist, candidate.artist);
      });
    }
    if (matchIndex >= 0) {
      const match = remaining.splice(matchIndex, 1)[0];
      return Object.assign({}, song, { url: match.url, playSource: 'kuwo', full: true });
    }
    return song;
  });
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
      return list.slice(0, 15).map(function (s) {
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
          full: false
        };
      });
    } catch (e) { continue; }
  }
  return [];
}
