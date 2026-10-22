// ============================================================
// 安全扫描接口 /api/security-scan
//   GET  : 管理员读取最近一次扫描报告（site_config.last_security_report）
//   POST {"action":"run"} : 管理员手动触发一次完整扫描（同步执行，整体 ≤60s）
// 报告通过 service_role upsert 存入 site_config，并原样返回给调用方。
// 只读探测：绝不执行登录/写库/删图等任何写操作。
// ============================================================

import { runSecurityChecks } from '../../scripts/security-checks.mjs';
import {
  requireSession, checkAdmin, checkAllowedOrigin, corsHeaders, jsonResponse, readCookie
} from '../_lib/session.js';

export async function onRequest(context) {
  const { request, env } = context;
  const origin = request.headers.get('Origin') || '';
  const originCheck = checkAllowedOrigin(origin, env.ACCOUNT_ALLOWED_ORIGINS || env.UPLOAD_ALLOWED_ORIGINS);
  const headers = corsHeaders(originCheck.corsOrigin);
  if (!originCheck.allowed) return jsonResponse({ error: 'Origin is not allowed.' }, 403, headers);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  const cfg = getConfig(env);
  if (!cfg.ok) return jsonResponse({ error: cfg.error }, 500, headers);

  // 管理员会话校验（与 /api/account、/api/db 同一套 HMAC 会话）
  const token = request.headers.get('X-Couple-Token') || readCookie(request.headers.get('Cookie') || '', 'couple_t');
  let session;
  try { session = await requireSession(cfg, token); }
  catch (e) { return jsonResponse({ error: '未登录或登录已失效，请重新登录' }, 401, headers); }
  const isAdmin = await checkAdmin(cfg, session.username);
  if (!isAdmin) return jsonResponse({ error: '无权限：只有管理员可以查看/触发安全扫描' }, 403, headers);

  if (request.method === 'GET') {
    return jsonResponse(await readLatest(cfg), 200, headers);
  }

  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, headers);
  let body = {};
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'Expected JSON request body.' }, 400, headers); }
  if (String(body.action || '') !== 'run') return jsonResponse({ error: '未知操作：仅支持 {"action":"run"}' }, 400, headers);

  // 公开 publishable key（与 .github/workflows/keepalive.yml 中一致，公开无害），
  // 作为未配置 SUPABASE_ANON_KEY 环境变量时的兜底，保证 RLS 探测始终运行
  const FALLBACK_ANON_KEY = 'sb_publishable_Z8E9qPbi6F2NLzoQh9fhfw__goWiZZ4';
  // 组装引擎配置：服务端环境态只报布尔值，绝不报告具体值
  const report = await runSecurityChecks({
    siteUrl: new URL(request.url).origin,
    supabaseUrl: cfg.supabaseUrl,
    supabaseAnonKey: env.SUPABASE_ANON_KEY || FALLBACK_ANON_KEY,
    serviceRoleKey: cfg.serviceKey,
    githubToken: env.GITHUB_TOKEN || null,
    githubOwner: cfg.owner,
    githubImgRepo: cfg.imgRepo,
    githubBranch: cfg.branch,
    mainRepo: cfg.mainRepo,
    envFlags: {
      supabaseUrl: !!env.SUPABASE_URL,
      serviceRoleKey: !!cfg.serviceKey,
      sessionSecret: !!env.AUTH_SESSION_SECRET,
      githubToken: !!env.GITHUB_TOKEN,
      allowedOrigins: !!(env.UPLOAD_ALLOWED_ORIGINS || env.ACCOUNT_ALLOWED_ORIGINS),
      supabaseAccessToken: !!env.SUPABASE_ACCESS_TOKEN,
      supabaseProjectRef: !!env.SUPABASE_PROJECT_REF
    },
    // Function 侧无文件系统：静态代码扫描由 Actions 入口（run-security-scan.mjs）负责
    staticFindings: [],
    timeoutMs: 8000
  });

  // 落库（key 合并写；报告可能较大，保留摘要+全部 checks）
  try {
    await fetch(`${cfg.supabaseUrl}/rest/v1/site_config`, {
      method: 'POST',
      headers: sbHeaders(cfg, { Prefer: 'resolution=merge-duplicates' }),
      body: JSON.stringify({ key: 'last_security_report', value: JSON.stringify(report) })
    });
  } catch (e) { /* 落库失败仍返回本次报告 */ }

  return jsonResponse({ ok: true, status: summarizeStatus(report), report }, 200, headers);
}

function summarizeStatus(report) {
  const s = (report && report.summary) || {};
  return (typeof s.score === 'number' && s.score < 60) || (s.high || 0) > 0 ? 'issues' : 'ok';
}

async function readLatest(cfg) {
  try {
    const r = await fetch(`${cfg.supabaseUrl}/rest/v1/site_config?key=eq.last_security_report&select=value&limit=1`, { headers: sbHeaders(cfg) });
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows[0] || !rows[0].value) {
      return { status: 'never', lastScanAt: null, report: null };
    }
    const report = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
    return { status: summarizeStatus(report), lastScanAt: report.generatedAt || null, report };
  } catch (e) {
    return { status: 'error', lastScanAt: null, report: null, error: String(e.message || e) };
  }
}

// ============================================================
// HTTP 辅助（会话与鉴权统一走 ../_lib/session.js）
// ============================================================
function sbHeaders(cfg, extra = {}) {
  return { apikey: cfg.serviceKey, Authorization: `Bearer ${cfg.serviceKey}`, 'Content-Type': 'application/json', ...extra };
}

function getConfig(env) {
  const supabaseUrl = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  const sessionSecret = env.AUTH_SESSION_SECRET || serviceKey;
  if (!supabaseUrl) return { ok: false, error: 'SUPABASE_URL is not configured.' };
  if (!serviceKey) return { ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY is not configured.' };
  return {
    ok: true, supabaseUrl, serviceKey, sessionSecret,
    owner: env.GITHUB_OWNER || 'shaozixiang',
    imgRepo: env.GITHUB_REPO || 'couple-images',
    branch: env.GITHUB_BRANCH || 'main',
    mainRepo: env.GITHUB_MAIN_REPO || 'love-site'
  };
}
