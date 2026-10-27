// 背景音乐搜索/播放代理
// search：代理网易云搜索，返回歌曲列表（歌名/歌手/专辑/时长/封面）
// play：代理网易云外链播放流（每次实时获取，地址永不过期；支持 Range/拖动）
// 登录态要求：需要有效会话（登录页背景功能的一部分），与 login-bg 同权限模型
const NETEASE_SEARCH = 'https://music.163.com/api/search/get/web';
const NETEASE_OUTER = 'https://music.163.com/song/media/outer/url';
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
  // CORS 预检
  if (request.method === 'OPTIONS') return json({ ok: true });

  const url = new URL(request.url);
  let action = url.searchParams.get('action');
  let keyword = url.searchParams.get('s');
  let id = url.searchParams.get('id');
  if (!action && request.method === 'POST') {
    try {
      const body = await request.json();
      action = body.action || action;
      keyword = body.keyword || body.s || keyword;
      id = body.id || id;
    } catch (e) {}
  }

  // 搜索需要登录（防滥用）；play 免登录——登录页未登录时也要播放背景音乐（只代理音频流，风险可控）
  const needLogin = action === 'search';
  if (needLogin) {
    const sessionToken = request.headers.get('X-Couple-Token') || (url.searchParams.get('sessionToken') || '');
    if (!sessionToken) return json({ error: '需要登录后才能搜索音乐' }, 401);
  }

  if (action === 'search') {
    if (!keyword || String(keyword).trim().length < 1) return json({ error: '请输入歌名' }, 400);
    try {
      const q = encodeURIComponent(String(keyword).trim());
      const resp = await fetch(NETEASE_SEARCH + '?s=' + q + '&type=1&limit=15', {
        headers: { 'User-Agent': UA, 'Referer': 'https://music.163.com/' }
      });
      if (!resp.ok) return json({ error: '音乐服务暂时不可用，请稍后再试' }, 502);
      const data = await resp.json();
      const songs = (data && data.result && data.result.songs || []).slice(0, 15).map(function (s) {
        return {
          id: s.id,
          name: s.name || '',
          artist: (s.artists || []).map(function (a) { return a.name; }).join(' / '),
          album: (s.album && s.album.name) || '',
          duration: s.duration || 0,
          albumPic: (s.album && s.album.picUrl) || ''
        };
      });
      if (!songs.length) return json({ error: '没搜到相关歌曲，换个关键词试试' }, 404);
      return json({ ok: true, songs: songs });
    } catch (e) {
      return json({ error: '音乐服务暂时不可用，请稍后再试' }, 502);
    }
  }

  if (action === 'play') {
    // id 必须纯数字，防注入
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
      // 网易云返回 text/html 表示该曲无外链/404
      if (!upstream.ok && upstream.status !== 206) return json({ error: '该歌曲暂时无法播放（可能无版权外链）' }, 404);
      if (ctype.indexOf('text/html') >= 0) return json({ error: '该歌曲暂时无法播放（可能无版权外链）' }, 404);
      const headers = new Headers();
      headers.set('Content-Type', ctype || 'audio/mpeg');
      headers.set('Cache-Control', 'public, max-age=3600');
      headers.set('Accept-Ranges', 'bytes');
      if (upstream.status === 206 && upstream.headers.get('content-range')) {
        headers.set('Content-Range', upstream.headers.get('content-range'));
      }
      if (upstream.headers.get('content-length')) headers.set('Content-Length', upstream.headers.get('content-length'));
      return new Response(upstream.body, { status: upstream.status, headers: headers });
    } catch (e) {
      return json({ error: '播放服务暂时不可用，请稍后再试' }, 502);
    }
  }

  return json({ error: '参数错误' }, 400);
}
