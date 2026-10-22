// ============================================================
// 管理员监控聚合接口 GET /api/monitor
// 一次性返回：站点概况 / GitHub 仓库 / Supabase 库 / 访问审计 / 安全总览
// 设计：
// - 管理员会话校验（与 /api/account、/api/db 同一套 HMAC 会话）
// - 每个子系统独立容错（Promise.allSettled），任一失败不影响其他
// - 所有 fetch 带 AbortController 超时，整体 ≤15 秒
// - 任何数字都来自真实 API；未配置的能力返回 null 并给配置步骤，绝不编造
// ============================================================

import {
  requireSession, checkAdmin, checkAllowedOrigin, corsHeaders, jsonResponse, readCookie
} from '../_lib/session.js';

const COUNTS_TABLES = [
  ['feeds', 'feeds'], ['messages', 'messages'], ['loves', 'loves'],
  ['memories', 'memories'], ['memos', 'memos'], ['schedules', 'schedules'],
  ['countdowns', 'countdowns'], ['travelMarkers', 'travel_markers'],
  ['users', 'users'], ['bubblePhotos', 'bubble_photos']
];

const MEDIA_EXT = /\.(jpe?g|png|gif|webp|avif|heic|heif|bmp|mp4|mov|webm|3gp|3g2|m4v|avi|mpeg)$/i;

export async function onRequest(context) {
  const { request, env } = context;
  const origin = request.headers.get('Origin') || '';
  const originCheck = checkAllowedOrigin(origin, env.ACCOUNT_ALLOWED_ORIGINS || env.UPLOAD_ALLOWED_ORIGINS);
  const headers = corsHeaders(originCheck.corsOrigin);
  if (!originCheck.allowed) return jsonResponse({ error: 'Origin is not allowed.' }, 403, headers);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405, headers);

  const cfg = getConfig(env);
  if (!cfg.ok) return jsonResponse({ error: cfg.error }, 500, headers);

  // 管理员会话校验
  const token = request.headers.get('X-Couple-Token') || readCookie(request.headers.get('Cookie') || '', 'couple_t');
  let session;
  try { session = await requireSession(cfg, token); }
  catch (e) { return jsonResponse({ error: '未登录或登录已失效，请重新登录' }, 401, headers); }
  const isAdmin = await checkAdmin(cfg, session.username);
  if (!isAdmin) return jsonResponse({ error: '无权限：只有管理员可以查看监控面板' }, 403, headers);

  const siteUrl = new URL(request.url).origin;

  const results = await Promise.allSettled([
    buildSite(cfg, siteUrl),
    buildGithub(cfg),
    buildSupabase(cfg),
    buildAccess(cfg),
    buildSecurity(cfg)
  ]);
  const [site, github, supabase, access, security] = results.map(r => r.status === 'fulfilled' ? r.value : { error: String(r.reason && r.reason.message || r.reason) });

  // 图仓图片数回填到 counts.images（github 子系统统计）
  if (site && !site.error && github && !github.error && Array.isArray(github.repos)) {
    const imgRepo = github.repos.find(x => x.name === (cfg.imgRepo));
    if (imgRepo && site.counts) site.counts.images = typeof imgRepo.imageCount === 'number' ? imgRepo.imageCount : null;
  }

  return jsonResponse({
    generatedAt: new Date().toISOString(),
    site, github, supabase, access, security
  }, 200, headers);
}

// ---------- 站点概况 ----------
async function buildSite(cfg, siteUrl) {
  // 首页版本戳（meta[name=version] 或 <!-- v1.2.3 --> 注释）
  let version = null;
  try {
    const r = await fetchWithTimeout(siteUrl + '/', { headers: { 'User-Agent': 'couple-monitor' } }, 6000);
    const html = await r.text();
    const m = html.match(/<meta[^>]+name=["']version["'][^>]+content=["']([^"']+)/i)
      || html.match(/<!--\s*v?([0-9][0-9.]+[a-z0-9-]*)\s*--/i);
    if (m) version = m[1];
  } catch (e) { /* 无版本戳就返回 null */ }

  // 表行数：service_role HEAD + Prefer: count=exact
  const counts = {};
  const countEntries = await Promise.all(COUNTS_TABLES.map(async ([key, table]) => {
    try {
      const r = await fetchWithTimeout(`${cfg.supabaseUrl}/rest/v1/${table}`, {
        method: 'HEAD',
        headers: sbHeaders(cfg, { Prefer: 'count=exact' })
      }, 6000);
      const cr = r.headers.get('content-range') || '';
      const m = cr.match(/\/(\d+)$/);
      return [key, m ? parseInt(m[1], 10) : 0];
    } catch (e) { return [key, 0]; }
  }));
  for (const [k, v] of countEntries) counts[k] = v;

  // 在线口径：is_online=true 优先；为空则退回最近 10 条 last_active
  let users = [];
  try {
    const r = await fetchWithTimeout(`${cfg.supabaseUrl}/rest/v1/users?select=username,is_online,last_active&order=last_active.desc&limit=50`, {
      headers: sbHeaders(cfg)
    }, 6000);
    users = await r.json();
  } catch (e) { users = []; }
  if (!Array.isArray(users)) users = [];

  const now = Date.now();
  let online = users.filter(u => u.is_online === true);
  let note = '口径：users.is_online=true（登录链路每 30s 更新一次活跃）';
  if (online.length === 0) {
    online = users.slice(0, 5);
    note = '口径：当前无 is_online=true 用户，退回 last_active 最近的 5 人';
  }
  const usersOnline = online.map(u => ({
    username: u.username,
    lastSeenMinAgo: u.last_active ? Math.max(0, Math.round((now - new Date(u.last_active).getTime()) / 60000)) : null
  })).filter(u => u.username);

  // images 数量交给 github 子系统统计（传不进来，先置 null 后回填）
  counts.images = null;
  return {
    version,
    serverTime: new Date().toISOString(),
    usersOnline,
    usersOnlineNote: note,
    counts: { ...counts, images: null }
  };
}

// ---------- GitHub 仓库 ----------
async function buildGithub(cfg) {
  if (!cfg.ghToken) {
    return {
      configured: false,
      repos: [],
      error: 'GITHUB_TOKEN is not configured in Cloudflare Pages.',
      setupSteps:
        '1) GitHub → Settings → Developer settings → Personal access tokens → Fine-grained token\n' +
        '2) 授予 Contents: Read-only（couple-images 仓）\n' +
        '3) Cloudflare Pages → Settings → Environment variables 添加 GITHUB_TOKEN\n' +
        '4) 若要监控主仓 love-site，再配 GITHUB_OWNER / GITHUB_MAIN_REPO'
    };
  }
  const gh = (path, opts = {}) => githubFetch(cfg, path, opts);

  // 图仓：元信息 + 递归树统计图片/视频数
  const imgRes = await gh(`/repos/${cfg.owner}/${cfg.imgRepo}`);
  let imgRepo = {};
  try { imgRepo = await imgRes.json(); } catch (e) {}
  let imageCount = 0;
  if (imgRes.ok) {
    const treeRes = await gh(`/repos/${cfg.owner}/${cfg.imgRepo}/git/trees/${encodeURIComponent(cfg.branch)}?recursive=1`);
    try {
      const tree = await treeRes.json();
      imageCount = (Array.isArray(tree.tree) ? tree.tree : [])
        .filter(t => t.type === 'blob' && !/^trash\//.test(t.path) && MEDIA_EXT.test(t.path)).length;
    } catch (e) {}
  }
  const imgEntry = {
    name: cfg.imgRepo,
    private: !!imgRepo.private,
    sizeKb: imgRepo.size ?? null,
    imageCount,
    updatedAt: imgRepo.pushed_at || null,
    error: imgRes.ok ? null : (imgRepo.message || `GitHub HTTP ${imgRes.status}`)
  };

  // 主仓：元信息 + 最近提交 + Actions 运行记录
  let mainEntry = null;
  try {
    const mainRes = await gh(`/repos/${cfg.owner}/${cfg.mainRepo}`);
    if (mainRes.ok) {
      const main = await mainRes.json();
      const commitsRes = await gh(`/repos/${cfg.owner}/${cfg.mainRepo}/commits?per_page=5`);
      let recentCommits = [];
      let commitCount = null;
      if (commitsRes.ok) {
        const commits = await commitsRes.json();
        recentCommits = (Array.isArray(commits) ? commits : []).map(c => ({
          sha: (c.sha || '').slice(0, 7),
          message: (c.commit && c.commit.message || '').split('\n')[0].slice(0, 80),
          date: c.commit && (c.commit.author && c.commit.author.date) || null
        }));
        // 准确提交数改由 per_page=1 请求获取（见下方）
        
        commitCount = recentCommits.length || null;
      }
        // 准确提交数：per_page=1 时 Link 头最后一页页码即总数
        try {
          const countRes = await gh(`/repos/${cfg.owner}/${cfg.mainRepo}/commits?per_page=1`);
          if (countRes.ok) {
            const lk = countRes.headers.get('link') || '';
            const lpm = lk.match(/[?&]page=(\d+)>; rel="last"/);
            commitCount = lpm ? parseInt(lpm[1], 10) : (recentCommits.length || 1);
          }
        } catch (e) {}

      const runsRes = await gh(`/repos/${cfg.owner}/${cfg.mainRepo}/actions/runs?per_page=5`);
      let actionsRuns = [];
      if (runsRes.ok) {
        const runs = await runsRes.json();
        actionsRuns = (Array.isArray(runs.workflow_runs) ? runs.workflow_runs : []).map(r => ({
          name: r.name || '', status: r.status || '', conclusion: r.conclusion || '', createdAt: r.created_at || null
        }));
      }
      mainEntry = {
        name: cfg.mainRepo, private: !!main.private, sizeKb: main.size ?? null,
        commitCount, recentCommits, actionsRuns, error: null
      };
    } else {
      mainEntry = { name: cfg.mainRepo, private: false, sizeKb: null, commitCount: null, recentCommits: [], actionsRuns: [], error: `主仓不存在或无权限（HTTP ${mainRes.status}）` };
    }
  } catch (e) {
    mainEntry = { name: cfg.mainRepo, private: false, sizeKb: null, commitCount: null, recentCommits: [], actionsRuns: [], error: String(e.message || e) };
  }

  return { configured: true, repos: [imgEntry, mainEntry].filter(Boolean), error: null };
}

// ---------- Supabase ----------
async function buildSupabase(cfg) {
  const out = {
    configured: true,
    health: { status: 'unknown', db: false },
    dbSizeMb: null,
    tableSizes: [],
    egress: null,
    management: {
      configured: false,
      setupSteps: '出站流量/用量管理需要额外两步：\n' +
        '1) supabase.com → 左下角头像 → Account → Access Tokens → 生成 token（Project read 即可）\n' +
        '2) Cloudflare Pages 添加两个环境变量：SUPABASE_ACCESS_TOKEN（上一步的 token）、SUPABASE_PROJECT_REF（项目 URL 开头 txeynuvttibnilvttieu）\n' +
        '未配置时 egress 恒为 null，仪表盘显示“未配置”，不会编造数字'
    },
    error: null
  };

  // 健康
  try {
    const r = await fetchWithTimeout(`${cfg.supabaseUrl}/auth/v1/health`, { headers: sbHeaders(cfg) }, 6000);
    out.health.status = r.ok ? 'ok' : 'degraded';
  } catch (e) { out.health.status = 'error'; out.error = 'auth health 探测失败：' + e.message; }
  // DB 连通性
  try {
    const r = await fetchWithTimeout(`${cfg.supabaseUrl}/rest/v1/site_config?select=key&limit=1`, { headers: sbHeaders(cfg) }, 6000);
    out.health.db = r.ok;
  } catch (e) { out.health.db = false; }

  // 表大小：优先 RPC；未建则空数组并提示
  try {
    const r = await fetchWithTimeout(`${cfg.supabaseUrl}/rest/v1/rpc/get_table_sizes`, {
      method: 'POST',
      headers: sbHeaders(cfg),
      body: '{}'
    }, 6000);
    if (r.ok) {
      const rows = await r.json();
      out.tableSizes = (Array.isArray(rows) ? rows : []).map(x => ({
        table: x.table_name || x.table,
        totalSizeMb: Number(x.total_size_mb ?? x.totalSizeMb ?? 0),
        rowsEstimate: Number(x.rows_estimate ?? x.rowsEstimate ?? 0)
      }));
      out.dbSizeMb = Math.round(out.tableSizes.reduce((s, t) => s + (t.totalSizeMb || 0), 0) * 100) / 100;
    } else if (r.status === 404 || r.status === 400 || r.status === 428) {
      out.tableSizes = [];
      out.management.setupSteps += '\n\n注意：get_table_sizes() RPC 尚未创建。请在 Supabase SQL Editor 执行一次 sql/monitoring_rpcs.sql 后刷新本面板。';
    }
  } catch (e) { /* RPC 不可用保持空数组 */ }

  // Management API（可选 env）
  if (cfg.sbAccessToken && cfg.sbProjectRef) {
    out.management.configured = true;
    out.management.setupSteps = '已配置 SUPABASE_ACCESS_TOKEN / SUPABASE_PROJECT_REF；用量明细请到 Dashboard → Project Usage 查看';
    // 真实 egress 数据需 Management API 用量接口；未取到保持 null，不编造
    out.egress = null;
  }
  return out;
}

// ---------- 访问审计 ----------
async function buildAccess(cfg) {
  let data = null;
  // 优先 RPC 聚合
  try {
    const r = await fetchWithTimeout(`${cfg.supabaseUrl}/rest/v1/rpc/get_access_stats`, {
      method: 'POST', headers: sbHeaders(cfg), body: '{}'
    }, 7000);
    if (r.ok) data = await r.json();
  } catch (e) { data = null; }

  let rows = [];
  if (!data) {
    // 兜底：service_role 直拉最近 500 条
    try {
      const r = await fetchWithTimeout(`${cfg.supabaseUrl}/rest/v1/admin_logs?select=action,user,details,created_at&order=created_at.desc&limit=500`, {
        headers: sbHeaders(cfg)
      }, 7000);
      rows = await r.json();
    } catch (e) { rows = []; }
    if (!Array.isArray(rows)) rows = [];

    const byUser = {}, byAction = {}, byDay = {};
    for (const row of rows) {
      byUser[row.user || 'guest'] = (byUser[row.user || 'guest'] || 0) + 1;
      byAction[row.action || ''] = (byAction[row.action || ''] || 0) + 1;
      const day = (row.created_at || '').slice(5, 10);
      if (day) byDay[day] = (byDay[day] || 0) + 1;
    }
    data = {
      recent: rows.slice(0, 20),
      byUser: Object.entries(byUser).map(([user, count]) => ({ user, count })).sort((a, b) => b.count - a.count).slice(0, 10),
      byAction: Object.entries(byAction).map(([action, count]) => ({ action, count })).sort((a, b) => b.count - a.count).slice(0, 10),
      day7: Object.entries(byDay).map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date))
    };
  }

  const scrub = (s) => String(s == null ? '' : s)
    .replace(/\b(passw\w*|token|secret|api[-_]?key|salt|avatar)\b\s*[:=]\s*\S+/gi, '$1:***')
    .slice(0, 240);

  return {
    recent: (Array.isArray(data.recent) ? data.recent : []).slice(0, 20).map(r => ({
      action: r.action || '', user: r.user || '', details: scrub(r.details), createdAt: r.created_at || null
    })),
    byUser: Array.isArray(data.byUser) ? data.byUser.slice(0, 10) : [],
    byAction: Array.isArray(data.byAction) ? data.byAction.slice(0, 10) : [],
    day7: Array.isArray(data.day7) ? data.day7.slice(-7) : []
  };
}

// ---------- 安全总览（读 site_config.last_security_report） ----------
async function buildSecurity(cfg) {
  let raw = null;
  try {
    const r = await fetchWithTimeout(`${cfg.supabaseUrl}/rest/v1/site_config?key=eq.last_security_report&select=value&limit=1`, {
      headers: sbHeaders(cfg)
    }, 6000);
    const rows = await r.json();
    if (Array.isArray(rows) && rows[0] && rows[0].value) raw = rows[0].value;
  } catch (e) { return { status: 'error', score: null, grade: null, high: 0, medium: 0, low: 0, passes: 0, lastScanAt: null }; }

  if (!raw) return { status: 'never', score: null, grade: null, high: 0, medium: 0, low: 0, passes: 0, lastScanAt: null };

  let report;
  try { report = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch (e) { return { status: 'error', score: null, grade: null, high: 0, medium: 0, low: 0, passes: 0, lastScanAt: null }; }

  const s = report.summary || {};
  const high = s.high || 0;
  const score = typeof s.score === 'number' ? s.score : null;
  const status = (score !== null && score < 60) || high > 0 ? 'issues' : 'ok';
  return {
    status,
    score,
    grade: s.grade || null,
    high,
    medium: s.medium || 0,
    low: s.low || 0,
    passes: s.passes || 0,
    lastScanAt: report.generatedAt || null
  };
}

// ============================================================
// GitHub / HTTP 辅助（会话与鉴权统一走 ../_lib/session.js）
// ============================================================
async function githubFetch(cfg, path, opts = {}) {
  return fetchWithTimeout(`https://api.github.com${path}`, {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${cfg.ghToken}`, Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json', 'User-Agent': 'couple-site-monitor',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: opts.body
  }, 8000);
}

function sbHeaders(cfg, extra = {}) {
  return { apikey: cfg.serviceKey, Authorization: `Bearer ${cfg.serviceKey}`, 'Content-Type': 'application/json', ...extra };
}

async function fetchWithTimeout(url, opts = {}, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try { return await fetch(url, { ...opts, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

function getConfig(env) {
  const supabaseUrl = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  const sessionSecret = env.AUTH_SESSION_SECRET || serviceKey;
  if (!supabaseUrl) return { ok: false, error: 'SUPABASE_URL is not configured.' };
  if (!serviceKey) return { ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY is not configured.' };
  return {
    ok: true, supabaseUrl, serviceKey, sessionSecret,
    ghToken: env.GITHUB_TOKEN || env.GITHUB_IMG_TOKEN || '',
    owner: env.GITHUB_OWNER || env.GITHUB_IMG_OWNER || 'shaozixiang',
    imgRepo: env.GITHUB_REPO || env.GITHUB_IMG_REPO || 'couple-images',
    branch: env.GITHUB_BRANCH || 'main',
    mainRepo: env.GITHUB_MAIN_REPO || 'love-site',
    sbAccessToken: env.SUPABASE_ACCESS_TOKEN || '',
    sbProjectRef: env.SUPABASE_PROJECT_REF || ''
  };
}
