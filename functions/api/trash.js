// ============================================================
// 回收站接口 /api/trash
// action:
//   delete  软删除（本人或管理员）：GitHub 图片/视频移动到 trash/ 目录，数据库记录打删除标记
//   list    管理员：列出所有模块回收站内容（含缩略图代理地址）
//   restore 管理员：图片移回原目录，记录恢复显示
//   purge   管理员：彻底删除 GitHub 文件 + 物理删除数据库记录
// 设计：数据库记录始终保留原始图片路径；文件在 原路径 <-> trash/原路径 之间移动。
// 注：DB 与 GitHub 两侧非事务，单侧失败时向 admin_logs 补写 trash_compensation_needed 告警。
// ============================================================

import {
  getConfig as baseConfig, requireSession, checkAdmin,
  checkAllowedOrigin, corsHeaders, jsonResponse, readCookie, authHeaders
} from '../_lib/session.js';

// 各内容表配置：type 中文名、title 摘要、medias 提取媒体 URL 列表
const TABLES = {
  feeds:          { type: '时光相册', title: r => r.description || '(无文字)', medias: r => (Array.isArray(r.medias) ? r.medias.map(m => m && m.data).filter(Boolean) : []) },
  messages:       { type: '留言板',   title: r => r.content || '(无文字)',     medias: r => (r.photo ? [r.photo] : []) },
  loves:          { type: '感动的话', title: r => r.content || '',             medias: () => [] },
  memories:       { type: '打卡回忆', title: r => r.content || '',             medias: () => [] },
  memos:          { type: '待办备忘', title: r => r.content || '',             medias: () => [] },
  schedules:      { type: '行程',     title: r => r.title || '',               medias: () => [] },
  countdowns:     { type: '纪念日',   title: r => r.name || '',                medias: () => [] },
  travel_markers: { type: '地图标记', title: r => r.name || '',                medias: () => [] },
  apologies:      { type: '道歉信',   title: r => r.content || '',             medias: () => [] }
};

export async function onRequest(context) {
  const { request, env } = context;
  const origin = request.headers.get('Origin') || '';
  const originCheck = checkAllowedOrigin(origin, env.ACCOUNT_ALLOWED_ORIGINS || env.UPLOAD_ALLOWED_ORIGINS);
  if (request.method === 'OPTIONS') {
    if (!originCheck.allowed) return jsonResponse({ error: 'Origin is not allowed.' }, 403);
    return new Response(null, { status: 204, headers: corsHeaders(originCheck.corsOrigin, { methods: 'POST, OPTIONS' }) });
  }
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  try {
    const cfg = getConfig(env);
    if (!cfg.ok) return jsonResponse({ error: cfg.error }, 500);

    const body = await request.json().catch(() => ({}));
    const action = String(body.action || '');
    const table = String(body.table || '');
    const id = String(body.id || '');
    const token = request.headers.get('X-Couple-Token') || readCookie(request.headers.get('Cookie') || '', 'couple_t');

    let session;
    try { session = await requireSession(cfg, token); }
    catch (e) { return jsonResponse({ error: '未登录或登录已失效，请重新登录' }, 401); }

    const isAdmin = await checkAdmin(cfg, session.username);

    // ---------- 列表（管理员，不需要 table 参数） ----------
    if (action === 'list') {
      if (!isAdmin) return jsonResponse({ error: '仅管理员可查看回收站' }, 403);
      const out = [];
      for (const [t, conf] of Object.entries(TABLES)) {
        const rows = await sbQuery(cfg, `${t}?select=*&deleted_at=not.is.null&order=deleted_at.desc&limit=200`);
        if (!Array.isArray(rows)) continue;
        for (const r of rows) {
          out.push({
            table: t, type: conf.type, id: r.id,
            author: r.author_name || r.author || '',
            deleted_at: r.deleted_at || '', deleted_by: r.deleted_by || '',
            title: String(conf.title(r) || '').slice(0, 120),
            media: conf.medias(r).map(u => {
              const rel = relFromUrl(u);
              return rel ? { rel, trashUrl: '/api/img/trash/' + rel, isVideo: /\.(mp4|mov|webm|avi)$/i.test(rel) } : null;
            }).filter(Boolean)
          });
        }
      }
      out.sort((a, b) => String(b.deleted_at).localeCompare(String(a.deleted_at)));
      return jsonResponse({ items: out }, 200);
    }

    if (!TABLES[table]) return jsonResponse({ error: '未知的数据模块' }, 400);
    if (!id) return jsonResponse({ error: '缺少记录 ID' }, 400);

    // 取目标记录
    const rows = await sbQuery(cfg, `${table}?select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
    if (!Array.isArray(rows) || rows.length === 0) return jsonResponse({ error: '记录不存在' }, 404);
    const row = rows[0];
    const rels = [...new Set(TABLES[table].medias(row).map(relFromUrl).filter(Boolean))];

    // ---------- 软删除（本人或管理员） ----------
    if (action === 'delete') {
      if (!isAdmin && row.author !== session.username) return jsonResponse({ error: '只能删除自己发布的内容' }, 403);
      if (row.deleted_at) return jsonResponse({ ok: true, already: true, moved: 0 });
      // 先移动文件，成功后再写删除标记，保证一致性
      let moved = 0;
      if (rels.length) {
        const pairs = rels.map(rel => ({ from: rel, to: 'trash/' + rel }));
        const r = await gitMove(cfg, pairs);
        if (!r.ok) return jsonResponse({ error: '图片移入回收站失败：' + r.error }, 502);
        moved = r.moved;
        // 文件已移动：顺手清掉 img 代理边缘缓存，原路径尽快返回 404（P1-05）
        await purgeImgCache(rels.map(rel => '/' + rel).concat(rels.map(rel => '/trash/' + rel)));
      }
      const patched = await sbExec(cfg, `${table}?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ deleted_at: new Date().toISOString(), deleted_by: session.username })
      });
      if (!patched.ok) {
        // 单侧失败：文件已进 trash 但 DB 未打标 → 补写可追踪告警，不阻断主流程
        await compensate(cfg, 'delete_patch_failed', table, id, rels, session.username, request);
      }
      await trashLog(cfg, '移入回收站·' + TABLES[table].type, session.username, { module: table, id, files: rels.length, title: String(TABLES[table].title(row) || '').slice(0, 60) }, request);
      return jsonResponse({ ok: true, moved }, 200);
    }

    // ---------- 以下仅管理员 ----------
    if (!isAdmin) return jsonResponse({ error: '仅管理员可执行该操作' }, 403);

    if (action === 'restore') {
      if (!row.deleted_at) return jsonResponse({ ok: true, already: true });
      if (rels.length) {
        const pairs = rels.map(rel => ({ from: 'trash/' + rel, to: rel }));
        const r = await gitMove(cfg, pairs);
        if (!r.ok) return jsonResponse({ error: '图片恢复失败：' + r.error }, 502);
        await purgeImgCache(rels.map(rel => '/' + rel).concat(rels.map(rel => '/trash/' + rel)));
      }
      const restored = await sbExec(cfg, `${table}?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ deleted_at: null, deleted_by: null })
      });
      if (!restored.ok) {
        // 单侧失败：文件已移回但 DB 仍标删除 → 补写告警
        await compensate(cfg, 'restore_patch_failed', table, id, rels, session.username, request);
      }
      await trashLog(cfg, '从回收站恢复·' + TABLES[table].type, session.username, { module: table, id, files: rels.length }, request);
      return jsonResponse({ ok: true }, 200);
    }

    if (action === 'purge') {
      if (rels.length) {
        // 文件当前在 trash/ 下；若记录已删则删 trash 副本，若未删（理论上不会）删原文件
        const inTrash = !!row.deleted_at;
        const targets = rels.map(rel => (inTrash ? 'trash/' + rel : rel));
        const r = await gitDelete(cfg, targets);
        if (!r.ok) return jsonResponse({ error: '文件删除失败：' + r.error }, 502);
        await purgeImgCache(rels.map(rel => '/' + rel).concat(rels.map(rel => '/trash/' + rel)));
      }
      const deleted = await sbExec(cfg, `${table}?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!deleted.ok) {
        // 单侧失败：文件已删但 DB 行仍在（孤儿行）→ 补写告警
        await compensate(cfg, 'purge_delete_failed', table, id, rels, session.username, request);
      }
      await trashLog(cfg, '彻底删除·' + TABLES[table].type, session.username, { module: table, id, files: rels.length }, request);
      return jsonResponse({ ok: true }, 200);
    }

    return jsonResponse({ error: '未知操作' }, 400);
  } catch (e) {
    return jsonResponse({ error: '回收站服务错误：' + ((e && e.message) || String(e)) }, 500);
  }
}

// ============================================================
// GitHub 文件移动 / 删除（Git Data API，一次提交完成，复用 blob，支持大文件）
// ============================================================
async function gitMove(cfg, pairs) {
  const gh = (path, opts) => ghFetch(cfg, path, opts);
  // 1. 取每个源文件的 blob sha（源不存在视为已移动，跳过）
  const tree = [];
  let moved = 0;
  for (const p of pairs) {
    const info = await gh(`/contents/${encPath(p.from)}?ref=${encodeURIComponent(cfg.branch)}`);
    if (info.status === 404) continue;
    if (!info.ok) return { ok: false, error: `读取 ${p.from} 失败(${info.status})` };
    const meta = info.json;
    if (Array.isArray(meta)) return { ok: false, error: `${p.from} 是目录` };
    tree.push({ path: p.to, mode: '100644', type: 'blob', sha: meta.sha }); // 新位置指向同一 blob
    tree.push({ path: p.from, mode: '100644', type: 'blob', sha: null });   // 旧位置删除
    moved++;
  }
  if (!tree.length) return { ok: true, moved: 0 };
  const commit = await commitTree(cfg, tree, `trash: move ${moved} file(s)`);
  if (!commit.ok) return { ok: false, error: commit.error };
  return { ok: true, moved };
}

async function gitDelete(cfg, rels) {
  const gh = (path, opts) => ghFetch(cfg, path, opts);
  const tree = [];
  for (const rel of rels) {
    const info = await gh(`/contents/${encPath(rel)}?ref=${encodeURIComponent(cfg.branch)}`);
    if (info.status === 404) continue; // 已不存在视为成功
    if (!info.ok) return { ok: false, error: `读取 ${rel} 失败(${info.status})` };
    tree.push({ path: rel, mode: '100644', type: 'blob', sha: null });
  }
  if (!tree.length) return { ok: true };
  const commit = await commitTree(cfg, tree, `trash: purge ${tree.length} file(s)`);
  if (!commit.ok) return { ok: false, error: commit.error };
  return { ok: true };
}

async function commitTree(cfg, tree, message) {
  const gh = (path, opts) => ghFetch(cfg, path, opts);
  const ref = await gh(`/git/ref/heads/${encodeURIComponent(cfg.branch)}`);
  if (!ref.ok) return { ok: false, error: '获取分支失败 ' + ref.status };
  const baseCommitSha = ref.json.object.sha;
  const baseCommit = await gh(`/git/commits/${baseCommitSha}`);
  if (!baseCommit.ok) return { ok: false, error: '获取提交失败' };
  const newTree = await gh('/git/trees', {
    method: 'POST', body: JSON.stringify({ base_tree: baseCommit.json.tree.sha, tree })
  });
  if (!newTree.ok) return { ok: false, error: '创建树失败 ' + newTree.status + ' ' + JSON.stringify(newTree.json).slice(0, 160) };
  const newCommit = await gh('/git/commits', {
    method: 'POST', body: JSON.stringify({ message, tree: newTree.json.sha, parents: [baseCommitSha] })
  });
  if (!newCommit.ok) return { ok: false, error: '创建提交失败 ' + newCommit.status };
  const upd = await gh(`/git/refs/heads/${encodeURIComponent(cfg.branch)}`, {
    method: 'PATCH', body: JSON.stringify({ sha: newCommit.json.sha, force: false })
  });
  if (!upd.ok) return { ok: false, error: '更新分支失败 ' + upd.status };
  return { ok: true };
}

async function ghFetch(cfg, path, opts = {}) {
  const resp = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}${path}`, {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${cfg.ghToken}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'couple-site-trash',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: opts.body
  });
  let json = null;
  const txt = await resp.text();
  try { json = txt ? JSON.parse(txt) : null; } catch (_) { json = { raw: txt }; }
  return { ok: resp.ok, status: resp.status, json };
}

function encPath(rel) {
  return String(rel).split('/').map(encodeURIComponent).join('/');
}

// 从图片 URL 解析仓库相对路径（兼容 jsDelivr 链接与 /api/img 代理路径）
function relFromUrl(u) {
  if (!u) return null;
  const s = String(u).split('?')[0].split('#')[0];
  let m = s.match(/\/api\/img\/(.+)$/);
  if (m) return safeRel(decodeURIComponent(m[1]));
  m = s.match(/cdn\.jsdelivr\.net\/gh\/[^/]+\/[^/]+@[^/]+\/(.+)$/);
  if (m) return safeRel(decodeURIComponent(m[1]));
  m = s.match(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\/(.+)$/);
  if (m) return safeRel(decodeURIComponent(m[1]));
  return null;
}
function safeRel(rel) {
  rel = String(rel).replace(/^\/+/, '');
  if (rel.includes('..')) return null;
  return rel;
}

// ============================================================
// Supabase 辅助
// ============================================================
async function sbQuery(cfg, qs, opts = {}) {
  const resp = await fetch(`${cfg.supabaseUrl}/rest/v1/${qs}`, {
    method: opts.method || 'GET',
    headers: authHeaders(cfg),
    ...(opts.headers ? { headers: { ...authHeaders(cfg), ...opts.headers } } : {}),
    body: opts.body
  });
  const txt = await resp.text();
  try { return txt ? JSON.parse(txt) : null; } catch (_) { return null; }
}

// 关键写操作专用：返回状态，便于发现单侧失败（P2-03 补偿）
async function sbExec(cfg, qs, opts = {}) {
  const resp = await fetch(`${cfg.supabaseUrl}/rest/v1/${qs}`, {
    method: opts.method || 'GET',
    headers: { ...authHeaders(cfg), ...(opts.headers || {}) },
    body: opts.body
  });
  return { ok: resp.ok, status: resp.status };
}

// 回收站操作服务端日志（带真实 IP/UA，防伪造；失败静默）
async function trashLog(cfg, action, username, details, request) {
  try {
    const row = {
      action,
      user: username || 'guest',
      details: JSON.stringify({
        ...(details || {}),
        ip: request.headers.get('CF-Connecting-IP') || request.headers.get('x-real-ip') || '',
        user_agent: (request.headers.get('user-agent') || '').substring(0, 120)
      }),
      created_at: new Date().toISOString()
    };
    await sbQuery(cfg, 'admin_logs', { method: 'POST', body: JSON.stringify(row) });
  } catch (e) {}
}

// P2-03：DB 与 GitHub 单侧失败时补写可追踪告警，不阻断主流程
async function compensate(cfg, step, table, id, rels, username, request) {
  await trashLog(cfg, 'trash_compensation_needed', username, {
    step, table, id, files: (rels || []).length,
    note: 'DB 与 GitHub 两侧不一致，需人工核对回收站记录'
  }, request);
}

// P1-05：清掉 /api/img 边缘缓存里受影响的代理 URL（失败静默）
async function purgeImgCache(relPaths) {
  try {
    const cache = caches.default;
    if (!cache || !cache.delete) return;
    for (const rel of relPaths) {
      await cache.delete(new Request(`https://img-cache.local${rel}`));
    }
  } catch (e) {}
}

function getConfig(env) {
  const base = baseConfig(env);
  if (!base.ok) return { ok: false, error: '数据库未配置' };
  const owner = String(env.GITHUB_IMG_OWNER || env.GITHUB_OWNER || '');
  const repo = String(env.GITHUB_IMG_REPO1 || env.GITHUB_IMG_REPO || env.GITHUB_REPO || '');
  const branch = String(env.GITHUB_IMG_BRANCH || env.GITHUB_BRANCH || 'main');
  const ghToken = String(env.GITHUB_IMG_TOKEN || env.GITHUB_TOKEN || '');
  if (!owner || !repo || !ghToken) return { ok: false, error: '图片仓库未配置' };
  return { ...base, owner, repo, branch, ghToken };
}
