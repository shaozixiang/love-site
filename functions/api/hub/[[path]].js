// ============================================================
// 资料区 / 文件中转站  ——  /api/hub/*
// ------------------------------------------------------------
// 设计要点：
// 1. 存储：复用「情侣站」的私有 GitHub 仓库（GITHUB_REPO，默认 couple-images），
//    文件放在 files/in（我 → 智能体）与 files/out（智能体 → 我）两个目录。
//    智能体（服务端协作者）可直接用 git 推送 / 读取同一目录，因此双向互通。
// 2. 门禁：完全复用站点登录会话（cookie couple_t / X-Couple-Token），
//    未登录返回 401，绝不匿名可写。
// 3. 类型：不做 MIME 白名单，任意后缀都可存放（doc/apk/zip/md/...）；
//    仅限制单文件体积，避免 Workers 内存与 GitHub blob 上限。
// 4. 下载：一律经本站代理，私有仓库内容不外泄；支持 Range 断点续传。
// 5. 分享：可生成带 HMAC 签名的限时直链，给「没有登录态的其他智能体」取件。
// ============================================================

import {
  readCookie, jsonResponse, requireSession, hmacHex, constantTimeEqual
} from '../../_lib/session.js';
import { resolveTenant } from '../../_lib/tenant.js';

// ---------- 常量 ----------
const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;      // 单文件 40MB（浏览器上传通道）
const DIRS = { in: 'files/in', out: 'files/out' }; // in=我上传，out=智能体交付
const MAX_TEXT_NAME = 96;

const MIME_BY_EXT = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  json: 'application/json; charset=utf-8',
  html: 'text/html; charset=utf-8',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  apk: 'application/vnd.android.package-archive',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', heic: 'image/heic',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg',
  ipynb: 'application/json; charset=utf-8',
  py: 'text/plain; charset=utf-8', js: 'text/plain; charset=utf-8', java: 'text/plain; charset=utf-8'
};

const EXT_BY_MIME = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3', 'audio/wav': 'wav'
};

// ---------- 小工具 ----------
class HubError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function envConfig(env) {
  return {
    supabaseUrl: String(env.SUPABASE_URL || '').replace(/\/$/, ''),
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY,
    sessionSecret: env.AUTH_SESSION_SECRET || env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY
  };
}

function ghCtx(env) {
  return {
    token: env.GITHUB_TOKEN,
    owner: env.GITHUB_OWNER || 'shaozixiang',
    repo: env.GITHUB_REPO || 'couple-images',
    branch: env.GITHUB_BRANCH || 'main'
  };
}

async function gh(c, path, init) {
  const res = await fetch('https://api.github.com' + path, {
    ...init,
    headers: {
      Authorization: 'Bearer ' + c.token,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'love-hub',
      ...((init && init.headers) || {})
    }
  });
  return res;
}

async function ghJson(c, path, init) {
  const res = await gh(c, path, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new HubError('仓库操作失败（' + res.status + '）' + (text ? '：' + text.slice(0, 120) : ''), 502);
  }
  return res.json();
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function extOf(name) {
  const m = String(name).match(/\.([a-z0-9]{1,8})$/i);
  return m ? m[1].toLowerCase() : '';
}

function mimeOf(name) {
  return MIME_BY_EXT[extOf(name)] || 'application/octet-stream';
}

// 浏览器上传的文件名净化：保留中文与常规符号，剔除路径分隔与控制字符
function sanitizeName(raw, mime) {
  let name = String(raw || '').trim();
  name = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
  if (!name) name = '未命名文件';
  const ext = extOf(name);
  if (!ext) {
    const guess = EXT_BY_MIME[String(mime || '').toLowerCase()];
    if (guess) name = name + '.' + guess;
  }
  if (name.length > MAX_TEXT_NAME) {
    const e = extOf(name);
    const base = e ? name.slice(0, name.length - e.length - 1) : name;
    name = base.slice(0, MAX_TEXT_NAME - (e ? e.length + 1 : 0)) + (e ? '.' + e : '');
  }
  return name;
}

function stampNow() {
  const d = new Date(Date.now() + 8 * 3600 * 1000); // 固定按北京时间命名
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

// 仓库内文件名 = 时间戳__原文件名（时间戳保证可排序、原文件名可读）
function entryOf(name, dirKey) {
  let at = null;
  let label = name;
  const m = String(name).match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})__(.+)$/);
  if (m) {
    at = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5]);
    label = m[6];
  }
  return { dir: dirKey, name, label, at };
}

function padSize(n) { return Number(n) || 0; }

// ---------- 仓库读写 ----------
async function listDir(c, dirKey) {
  const res = await gh(c, `/repos/${c.owner}/${c.repo}/contents/${DIRS[dirKey]}?ref=${encodeURIComponent(c.branch)}`);
  if (res.status === 404) return [];
  if (!res.ok) throw new HubError('无法读取仓库目录', 502);
  const items = await res.json();
  if (!Array.isArray(items)) return [];
  return items
    .filter(i => i && i.type === 'file')
    .map(i => ({ ...entryOf(i.name, dirKey), size: padSize(i.size), sha: i.sha }))
    .sort((a, b) => String(b.name).localeCompare(String(a.name)));
}

// blob → tree → commit → 移动 ref；ref 冲突时自动重试（与智能体的 git 推送并行安全）
async function putFile(c, dirKey, fileName, buffer) {
  const blob = await ghJson(c, `/repos/${c.owner}/${c.repo}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({ content: toBase64(buffer), encoding: 'base64' })
  });

  const repoPath = `${DIRS[dirKey]}/${fileName}`;
  let lastError = null;

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const ref = await ghJson(c, `/repos/${c.owner}/${c.repo}/git/ref/heads/${encodeURIComponent(c.branch)}`);
      const parent = ref.object.sha;
      const commit = await ghJson(c, `/repos/${c.owner}/${c.repo}/git/commits/${parent}`);
      const tree = await ghJson(c, `/repos/${c.owner}/${c.repo}/git/trees`, {
        method: 'POST',
        body: JSON.stringify({
          base_tree: commit.tree.sha,
          tree: [{ path: repoPath, mode: '100644', type: 'blob', sha: blob.sha }]
        })
      });
      const next = await ghJson(c, `/repos/${c.owner}/${c.repo}/git/commits`, {
        method: 'POST',
        body: JSON.stringify({
          message: `hub: 存入 ${fileName}`,
          tree: tree.sha,
          parents: [parent]
        })
      });
      const res = await gh(c, `/repos/${c.owner}/${c.repo}/git/refs/heads/${encodeURIComponent(c.branch)}`, {
        method: 'PATCH',
        body: JSON.stringify({ sha: next.sha, force: false })
      });
      if (res.ok) return { path: repoPath };
      lastError = new HubError('提交冲突，请重试', 409);
    } catch (e) {
      lastError = e;
      if (e.status && e.status !== 409) break;
    }
  }
  throw lastError || new HubError('写入仓库失败', 502);
}

async function removeFile(c, dirKey, name) {
  const repoPath = `${DIRS[dirKey]}/${name}`;
  const infoRes = await gh(c, `/repos/${c.owner}/${c.repo}/contents/${repoPath}?ref=${encodeURIComponent(c.branch)}`);
  if (!infoRes.ok) throw new HubError('文件不存在或已删除', 404);
  const info = await infoRes.json();
  if (Array.isArray(info)) throw new HubError('非法文件路径', 400);
  const res = await gh(c, `/repos/${c.owner}/${c.repo}/contents/${repoPath}`, {
    method: 'DELETE',
    body: JSON.stringify({ message: `hub: 删除 ${name}`, sha: info.sha, branch: c.branch })
  });
  if (!res.ok) throw new HubError('删除失败', 502);
}

// 私有仓库回源：raw 优先，失败退到 Contents API（两者都带令牌，内容不外泄）
async function fetchRaw(c, repoPath, range) {
  const headers = { Authorization: 'Bearer ' + c.token };
  if (range) headers.Range = range;
  const rawUrl = `https://raw.githubusercontent.com/${c.owner}/${c.repo}/${c.branch}/${repoPath.split('/').map(encodeURIComponent).join('/')}`;
  const raw = await fetch(rawUrl, { headers });
  if (raw.status === 200 || raw.status === 206) return raw;
  const api = await fetch(`https://api.github.com/repos/${c.owner}/${c.repo}/contents/${repoPath.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(c.branch)}`, {
    headers: { Authorization: 'Bearer ' + c.token, Accept: 'application/vnd.github.raw', 'User-Agent': 'love-hub', ...(range ? { Range: range } : {}) }
  });
  return api;
}

function streamDownload(upstream, fileName, opts = {}) {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const headers = {
    'Content-Type': mimeOf(fileName),
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    'Cache-Control': opts.public ? 'public, max-age=300' : 'private, no-store',
    'X-Content-Type-Options': 'nosniff'
  };
  const len = upstream.headers.get('Content-Length');
  if (len) headers['Content-Length'] = len;
  const cr = upstream.headers.get('Content-Range');
  if (cr) headers['Content-Range'] = cr;
  const ar = upstream.headers.get('Accept-Ranges');
  if (ar) headers['Accept-Ranges'] = ar;
  return new Response(upstream.body, { status: upstream.status, headers });
}

// ---------- 鉴权 ----------
async function authenticate(request, env) {
  const config = envConfig(env);
  const token = readCookie(request.headers.get('Cookie') || '', 'couple_t')
    || request.headers.get('X-Couple-Token') || '';
  const tenant = await resolveTenant(request, config);
  const session = await requireSession(config, token, tenant);
  return { config, session, tenant };
}

// ---------- 路由 ----------
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const segs = (context.params.path || []).filter(Boolean).map(s => String(s));

  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });

  // 公开取件（签名直链）：不校验登录态，靠 HMAC + 过期时间兜底
  if (segs[0] === 's') return handleSignedFetch(context, segs);

  let auth;
  try {
    auth = await authenticate(request, env);
  } catch (e) {
    return jsonResponse({ error: '请先登录后再使用资料区。' }, 401);
  }

  const ghc = ghCtx(env);
  if (!ghc.token) return jsonResponse({ error: '服务端未配置仓库令牌。' }, 500);

  try {
    if (segs[0] === 'list' && request.method === 'GET') {
      const [inbox, outbox] = await Promise.all([listDir(ghc, 'in'), listDir(ghc, 'out')]);
      return jsonResponse({ ok: true, in: inbox, out: outbox, user: auth.session.username, limit: MAX_UPLOAD_BYTES });
    }

    if (segs[0] === 'upload' && request.method === 'POST') {
      return await handleUpload(request, ghc);
    }

    if (segs[0] === 'delete' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const dirKey = body.dir === 'out' ? 'out' : 'in';
      const name = String(body.name || '');
      if (!/^[\w\u4e00-\u9fa5.\- ()（）\[\]【】]+$/.test(name)) throw new HubError('非法文件名', 400);
      await removeFile(ghc, dirKey, name);
      return jsonResponse({ ok: true });
    }

    if (segs[0] === 'share' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const dirKey = body.dir === 'out' ? 'out' : 'in';
      const name = String(body.name || '');
      const days = Math.min(30, Math.max(1, Number(body.days) || 7));
      const exp = Date.now() + days * 86400 * 1000;
      const payload = `${dirKey}/${name}|${exp}`;
      const sig = await hmacHex(envConfig(env).sessionSecret, payload);
      const link = `${url.origin}/api/hub/s?p=${encodeURIComponent(`${dirKey}/${name}`)}&e=${exp}&k=${sig}`;
      return jsonResponse({ ok: true, url: link, days });
    }

    if (segs[0] === 'dl' && segs.length >= 3 && request.method === 'GET') {
      const dirKey = segs[1] === 'out' ? 'out' : 'in';
      const name = segs.slice(2).join('/');
      const repoPath = `${DIRS[dirKey]}/${name}`;
      const upstream = await fetchRaw(ghc, repoPath, request.headers.get('Range') || '');
      if (!upstream.ok && upstream.status !== 206) throw new HubError('文件读取失败', 502);
      return streamDownload(upstream, entryOf(name, dirKey).label);
    }

    return jsonResponse({ error: '未知接口' }, 404);
  } catch (e) {
    return jsonResponse({ error: e.message || '操作失败' }, e.status || 500);
  }
}

async function handleUpload(request, ghc) {
  const form = await request.formData();
  const file = form.get('file');
  if (!file || typeof file.arrayBuffer !== 'function') throw new HubError('没有收到文件', 400);
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new HubError(`文件超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB，请改用其他方式传输。`, 413);
  }
  const dirKey = form.get('dir') === 'out' ? 'out' : 'in';
  const fileName = `${stampNow()}__${sanitizeName(file.name, file.type)}`;
  await putFile(ghc, dirKey, fileName, await file.arrayBuffer());
  return jsonResponse({ ok: true, name: fileName, dir: dirKey });
}

async function handleSignedFetch(context, segs) {
  const { request, env } = context;
  const url = new URL(request.url);
  const p = url.searchParams.get('p') || '';
  const e = url.searchParams.get('e') || '';
  const k = url.searchParams.get('k') || '';
  if (!p || !e || !k) return jsonResponse({ error: '链接不完整' }, 400);
  if (Number(e) < Date.now()) return jsonResponse({ error: '链接已过期' }, 403);
  const expected = await hmacHex(envConfig(env).sessionSecret, `${p}|${e}`);
  if (!constantTimeEqual(expected, k)) return jsonResponse({ error: '链接无效' }, 403);

  const [dirKey, ...rest] = p.split('/');
  const name = rest.join('/');
  if (!name || dirKey !== 'in' && dirKey !== 'out') return jsonResponse({ error: '链接无效' }, 403);

  try {
    const upstream = await fetchRaw(ghCtx(env), `${DIRS[dirKey]}/${name}`, request.headers.get('Range') || '');
    if (!upstream.ok && upstream.status !== 206) return jsonResponse({ error: '文件不存在' }, 404);
    return streamDownload(upstream, entryOf(name, dirKey).label, { public: true });
  } catch (e2) {
    return jsonResponse({ error: '文件读取失败' }, 502);
  }
}
