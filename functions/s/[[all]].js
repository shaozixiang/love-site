// ============================================================
// 多租户子路径路由层：匹配 /s/:slug/*
// 职责：
//   1. 解析并校验 slug，查询 tenants（不存在→404，停用→403）
//   2. 重写 URL 去掉 /s/:slug 前缀，注入可信租户头
//   3. api/* 同源 fetch 回环到现有 Functions；其余走 env.ASSETS 静态资源
//   4. HTML 入口用 HTMLRewriter 改写资源路径并注入 window.__TENANT__
// ============================================================

import { getConfig, authHeaders } from '../_lib/session.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

function shellPage(title, body, status) {
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
font-family:system-ui,-apple-system,sans-serif;background:#f6f4f3;color:#3a3338;padding:24px;box-sizing:border-box}
.card{text-align:center}.card h2{font-weight:600}.card p{color:#8a8087;font-size:14px}</style></head>
<body><div class="card"><h2>${title}</h2><p>${body}</p></div></body></html>`;
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

// 重写 HTML：同源绝对路径加 base 前缀；head 注入租户全局变量
function rewriteHtml(response, tenant) {
  const base = `/s/${tenant.slug}`;
  const inject = `<script>window.__TENANT__=${JSON.stringify({
    id: tenant.id, slug: tenant.slug, base
  })};</script>`;
  const rewriter = new HTMLRewriter()
    .on('link[href],script[src],img[src],a[href],use[href],video[src],audio[src],source[src]', {
      element(el) {
        ['href', 'src'].forEach(attr => {
          const v = el.getAttribute(attr);
          if (v && v.startsWith('/') && !v.startsWith('//')) el.setAttribute(attr, base + v);
        });
      }
    })
    .on('head', {
      element(el) { el.prepend(inject, { html: true }); }
    });
  return rewriter.transform(response);
}

export async function onRequest(context) {
  const { request, env } = context;
  const cfg = getConfig(env);
  if (!cfg.ok) return new Response(JSON.stringify({ error: cfg.error }), {
    status: 500, headers: { 'Content-Type': 'application/json' }
  });

  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean); // ['s', slug, ...rest]
  if (parts[0] !== 's' || parts.length < 2) {
    return shellPage('页面不存在', '链接格式不正确。', 404);
  }
  const slug = parts[1];
  const rest = parts.slice(2).join('/');

  if (!SLUG_RE.test(slug)) {
    return shellPage('小站不存在', '地址标识无效。', 404);
  }

  // 查询租户
  let tenant = null;
  try {
    const r = await fetch(
      `${cfg.supabaseUrl}/rest/v1/tenants?select=id,slug,name,owner_id,status&slug=eq.${encodeURIComponent(slug)}&limit=1`,
      { headers: authHeaders(cfg) }
    );
    const rows = r.ok ? await r.json().catch(() => null) : null;
    tenant = Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch (e) { tenant = null; }

  if (!tenant) {
    return shellPage('小站不存在', '该小站尚未开通或地址有误，请联系平台管理员。', 404);
  }
  if (tenant.status === 'suspended') {
    return shellPage('小站已停用', '该小站已被平台管理员暂停服务。', 403);
  }

  // 计算内部路径与是否 HTML 入口
  const targetPath = rest || 'index.html';
  const isHtml = targetPath.endsWith('.html') || !rest;
  const isApi = targetPath.startsWith('api/');

  // 平台超管页只在根站可用，租户子路径下一律 404
  if (targetPath === 'admin-tenants.html') {
    return shellPage('页面不存在', '该页面不存在。', 404);
  }
  // 租户内禁止直接访问平台级租户接口
  if (targetPath === 'api/tenants' || targetPath === 'api/tenants.js') {
    return new Response(JSON.stringify({ error: '无权限' }), {
      status: 403, headers: { 'Content-Type': 'application/json' }
    });
  }

  // 构造内部 URL（去掉 /s/slug，保留 query）
  const internalUrl = new URL(url.toString());
  internalUrl.pathname = '/' + targetPath;
  internalUrl.search = url.search;

  // 复制并清理请求头：剥离伪造租户头，注入可信值
  const h = new Headers(request.headers);
  h.delete('X-Tenant-Id');
  h.delete('X-Tenant-Slug');
  h.set('X-Tenant-Id', String(tenant.id));
  h.set('X-Tenant-Slug', tenant.slug);
  const internalRequest = new Request(internalUrl.toString(), {
    method: request.method, headers: h,
    body: (request.method === 'GET' || request.method === 'HEAD') ? undefined : request.body,
    redirect: 'manual'
  });

  try {
    let response;
    let hop = 0;
    let curRequest = internalRequest;
    let curUrl = internalUrl;
    for (;;) {
      response = isApi ? await fetch(curRequest) : await env.ASSETS.fetch(curRequest);
      const loc = response.headers.get('Location');
      if (response.status >= 300 && response.status < 400 && loc && hop < 3) {
        // 静态资源的规范化重定向（如 /index.html -> /）：在内部跟掉，
        // 不能透传给浏览器，否则会跳出 /s/<slug>/ 命名空间
        curUrl = new URL(loc, curUrl);
        curRequest = new Request(curUrl.toString(), {
          method: curRequest.method, headers: curRequest.headers,
          body: (curRequest.method === 'GET' || curRequest.method === 'HEAD') ? undefined : curRequest.body,
          redirect: 'manual'
        });
        hop++;
        continue;
      }
      break;
    }
    if (isHtml && response.ok && (response.headers.get('Content-Type') || '').includes('text/html')) {
      response = rewriteHtml(response, tenant);
    }
    return response;
  } catch (e) {
    return shellPage('服务暂时不可用', '请稍后再试。', 502);
  }
}
