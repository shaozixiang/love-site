// 背景音乐搜索/解析代理
// search：优先酷我（完整曲库，返回可动态解析的播放地址）；酷我失败时回退网易云（30s 试听外链）
// resolve：酷我 rid → 实时获取完整 mp3 直链并 302 重定向（每次新鲜签名，永不过期、永不截断）
// play：网易云外链代理（仅回退链路使用）
// 登录态：search 需要有效会话（防滥用）；resolve/play 免登录（登录页未登录时也要播放）
const NETEASE_SEARCH = 'https://music.163.com/api/search/get/web';
const NETEASE_OUTER = 'https://music.163.com/song/media/outer/url';
const KUWO_SEARCH = 'https://search.kuwo.cn/r.s';
const KUWO_ANTI = 'http://antiserver.kuwo.cn/anti.s';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

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
    const sessionToken = request.headers.get('X-Couple-Token') || (url.searchParams.get('sessionToken') || '');
    if (!sessionToken) return json({ error: '需要登录后才能搜索音乐' }, 401);
  }

  if (action === 'kuwoRaw') {
    // 临时诊断：暴露酷我搜索 Worker 实际响应，定位失败原因
    const q = String(keyword || '宝贝').trim();
    try {
      const resp = await fetch(KUWO_SEARCH + '?all=' + encodeURIComponent(q) + '&ft=music&itemset=web_2013&client=kt&pn=0&rn=3&rformat=json&encoding=utf8', {
        headers: { 'User-Agent': UA, 'Referer': 'https://www.kuwo.cn/' }
      });
      const text = await resp.text();
      return json({ status: resp.status, len: text.length, head: text.slice(0, 400), isJson: text.indexOf('MUSICRID') >= 0 });
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  }

  if (action === 'search') {    if (!keyword || String(keyword).trim().length < 1) return json({ error: '请输入歌名' }, 400);
    const q = String(keyword).trim();
    // 1) 酷我：完整曲库 + 动态解析完整播放（优先）
    try {
      const songs = await kuwoSearch(q);
      if (songs && songs.length) return json({ ok: true, songs: songs, source: 'kuwo' });
    } catch (e) {}
    // 2) 网易云回退：多端点 failover（试听 30s 外链）
    try {
      const songs = await neteaseSearch(q);
      if (songs && songs.length) return json({ ok: true, songs: songs, source: 'netease' });
    } catch (e) {}
    return json({ error: '没搜到相关歌曲，换个关键词试试' }, 404);
  }

  if (action === 'resolve') {
    // 酷我 rid → 实时拿完整 mp3 直链 → 302 重定向（audio 元素自动跟随，无 CORS 限制）
    if (!/^MUSIC_\d+$/.test(String(rid || ''))) return json({ error: '参数错误' }, 400);
    try {
      const antiResp = await fetch(KUWO_ANTI + '?format=mp3&rid=' + encodeURIComponent(rid) + '&type=convert_url&response=url', {
        headers: { 'User-Agent': UA }
      });
      if (!antiResp.ok) return json({ error: '获取播放地址失败' }, 502);
      const direct = (await antiResp.text()).trim();
      if (!/^https?:\/\//.test(direct)) return json({ error: '该歌曲暂时无法播放' }, 404);
      return new Response(null, { status: 302, headers: { Location: direct } });
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
      url: '/api/music?action=resolve&rid=' + rid
    });
    if (out.length >= 15) break;
  }
  return out;
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
          url: ''
        };
      });
    } catch (e) { continue; }
  }
  return [];
}
