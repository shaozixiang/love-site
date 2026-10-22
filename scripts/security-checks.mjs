// ============================================================
// 情侣小站 · 安全检查引擎（纯 ESM，零第三方依赖）
// - 同时兼容 Cloudflare Pages Functions(workerd) 与 Node 22 运行时
// - 只使用全局 fetch；不引用任何 Node 内置模块（fs/process/Buffer 等一律禁止）
// - 配置全部由参数 cfg 传入；只读探测，绝不执行任何写请求
//
// runSecurityChecks(cfg) -> {
//   generatedAt, summary: {score,grade,high,medium,low,info,passes,fails,warns,unknowns},
//   checks: [{id,category,title,severity,status,detail,fix}]
// }
//
// cfg: {
//   siteUrl, supabaseUrl,
//   supabaseAnonKey: string|null,   // 公开 publishable key（Actions/Function 均可读）
//   serviceRoleKey:  string|null,   // 仅 Function 侧注入；Actions 侧不提供 → 相关检查记 unknown
//   githubToken: string|null, githubOwner, githubImgRepo, githubBranch, mainRepo,
//   envFlags: {
//     supabaseUrl, serviceRoleKey, sessionSecret, githubToken,
//     supabaseAccessToken, supabaseProjectRef, allowedOrigins
//   },
//   staticFindings: [ {id,category,title,severity,status,detail,fix} ], // 调用方静态扫描结果
//   timeoutMs, ua
// }
// ============================================================

const EVIL_ORIGIN = 'https://evil.example.com';
const UA = 'couple-security-scan/1.0 (+read-only probes)';

// 业务表清单（RLS 探测面，16 张）
const DATA_TABLES = [
  'feeds', 'messages', 'loves', 'memories', 'memos', 'schedules', 'countdowns',
  'travel_markers', 'users', 'bubble_config', 'bubble_photos', 'angry_mode',
  'apologies', 'admin_logs', 'site_config', 'logs'
];

function check(id, category, title, severity, status, detail, fix) {
  return { id, category, title, severity, status, detail: String(detail || ''), fix: String(fix || '') };
}

async function fetchWithTimeout(url, opts = {}, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, redirect: 'follow', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getHeaders(cfg, path, extraHeaders = {}) {
  const url = path.startsWith('http') ? path : cfg.siteUrl.replace(/\/$/, '') + path;
  try {
    const r = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { 'User-Agent': cfg.ua || UA, ...extraHeaders }
    }, cfg.timeoutMs || 8000);
    return { status: r.status, headers: r.headers, ok: r.ok, text: () => r.text() };
  } catch (e) {
    return { status: 0, headers: new Headers(), ok: false, error: String(e && e.message || e), text: async () => '' };
  }
}

// 取首页 HTML（安全头挂在首页响应上）
async function fetchHome(cfg) {
  try {
    const r = await fetchWithTimeout(cfg.siteUrl.replace(/\/$/, '') + '/', {
      headers: { 'User-Agent': cfg.ua || UA }
    }, cfg.timeoutMs || 8000);
    const text = await r.text();
    return { status: r.status, headers: r.headers, text };
  } catch (e) {
    return { status: 0, headers: new Headers(), text: '', error: String(e && e.message || e) };
  }
}

// ------------------------------------------------------------
export async function runSecurityChecks(cfg) {
  const checks = [];
  const site = cfg.siteUrl.replace(/\/$/, '');
  const sb = (cfg.supabaseUrl || '').replace(/\/$/, '');
  const T = cfg.timeoutMs || 8000;

  // ---------- 0. 把调用方静态扫描结果并入 ----------
  for (const f of (cfg.staticFindings || [])) {
    if (f && f.id) checks.push(check(f.id, f.category || '静态代码', f.title || f.id,
      f.severity || 'low', f.status || 'warn', f.detail || '', f.fix || ''));
  }

  // ---------- 1. HTTP 安全头（首页响应） ----------
  const home = await fetchHome(cfg);
  const h = (name) => home.headers.get(name) || '';
  const csp = h('content-security-policy');
  const cspLower = csp.toLowerCase();

  checks.push(check('HDR-CSP', 'HTTP安全头', '响应包含 Content-Security-Policy',
    csp ? 'high' : 'high', csp ? 'pass' : 'fail',
    csp ? '已下发 CSP：' + csp.slice(0, 160) : '首页响应未下发 CSP',
    '在 Cloudflare Pages _headers 增加 Content-Security-Policy 策略'));

  if (csp) {
    const unsafeInline = /script-src[^;]*'unsafe-inline'/.test(cspLower);
    checks.push(check('HDR-CSP-UNSAFE-INLINE', 'HTTP安全头', 'CSP script-src 不应包含 unsafe-inline',
      'medium', unsafeInline ? 'warn' : 'pass',
      unsafeInline ? '当前 script-src 含 unsafe-inline，内联脚本可被注入执行' : '未发现 unsafe-inline',
      '把内联脚本抽到外部 js 文件，改用 nonce/hash 模式收紧 script-src'));

    const needDirective = (name) => cspLower.includes(name);
    checks.push(check('HDR-OBJECT-SRC', 'HTTP安全头', 'CSP 限定 object-src',
      'medium', needDirective('object-src') ? 'pass' : 'warn',
      needDirective('object-src') ? '已声明 object-src' : 'CSP 未声明 object-src，默认等同 allow-all',
      '增加 object-src \'none\''));
    checks.push(check('HDR-BASE-URI', 'HTTP安全头', 'CSP 限定 base-uri',
      'medium', needDirective('base-uri') ? 'pass' : 'warn',
      needDirective('base-uri') ? '已声明 base-uri' : '未声明 base-uri，存在 base 标签劫持风险',
      '增加 base-uri \'self\''));
    checks.push(check('HDR-FORM-ACTION', 'HTTP安全头', 'CSP 限定 form-action',
      'low', needDirective('form-action') ? 'pass' : 'warn',
      needDirective('form-action') ? '已声明 form-action' : '未声明 form-action',
      '增加 form-action \'self\''));
    checks.push(check('HDR-FRAME-ANCESTORS', 'HTTP安全头', 'CSP 禁止被第三方 iframe 嵌套',
      'high', needDirective('frame-ancestors') ? 'pass' : 'fail',
      needDirective('frame-ancestors') ? '已声明 frame-ancestors' : '未声明 frame-ancestors，存在点击劫持风险',
      '增加 frame-ancestors \'none\'（或同时保留 X-Frame-Options: DENY）'));
  }

  checks.push(check('HDR-HSTS', 'HTTP安全头', '启用 HSTS 强制 HTTPS',
    'high', h('strict-transport-security') ? 'pass' : 'fail',
    h('strict-transport-security') || '未下发 Strict-Transport-Security',
    '增加 Strict-Transport-Security: max-age=31536000; includeSubDomains'));
  checks.push(check('HDR-XFO', 'HTTP安全头', 'X-Frame-Options 或 frame-ancestors 防嵌套',
    'medium', h('x-frame-options') || csp ? 'pass' : 'warn',
    h('x-frame-options') || '未下发 X-Frame-Options（若 CSP 已有 frame-ancestors 可忽略）',
    '增加 X-Frame-Options: DENY'));
  checks.push(check('HDR-XCTO', 'HTTP安全头', 'MIME 嗅探保护',
    'low', /nosniff/.test(h('x-content-type-options')) ? 'pass' : 'warn',
    h('x-content-type-options') || '未下发 X-Content-Type-Options: nosniff',
    '增加 X-Content-Type-Options: nosniff'));
  checks.push(check('HDR-REFERRER', 'HTTP安全头', 'Referrer-Policy 防地址泄露',
    'low', h('referrer-policy') ? 'pass' : 'info',
    h('referrer-policy') || '未下发 Referrer-Policy',
    '增加 Referrer-Policy: strict-origin-when-cross-origin'));
  checks.push(check('HDR-PERMISSIONS', 'HTTP安全头', '权限策略收紧敏感能力',
    'low', h('permissions-policy') ? 'pass' : 'info',
    h('permissions-policy').slice(0, 160) || '未下发 Permissions-Policy',
    '增加 Permissions-Policy: camera=(), microphone=(), geolocation=(self)'));

  // ---------- 2. CORS（恶意 Origin 不得放行） ----------
  const corsTargets = [
    { path: '/api/account', method: 'GET' },
    { path: '/api/db/rest/v1/users?select=username&limit=1', method: 'GET' },
    { path: '/api/upload-to-github', method: 'POST' },
    { path: '/api/trash', method: 'POST' },
    { path: '/api/monitor', method: 'GET' },
    { path: '/api/security-scan', method: 'GET' }
  ];
  for (const t of corsTargets) {
    const r = await getHeaders(cfg, t.path, { Origin: EVIL_ORIGIN });
    const acao = r.headers.get('access-control-allow-origin') || '';
    const echoesEvil = acao === EVIL_ORIGIN;
    const name = t.path.split('?')[0];
    checks.push(check('CORS-' + name.replace(/[^a-z]/gi, '-').slice(0, 30), 'CORS',
      `恶意 Origin 不得被 ${name} 放行`,
      echoesEvil ? 'medium' : 'low',
      echoesEvil ? 'warn' : (r.status === 404 ? 'unknown' : 'pass'),
      echoesEvil
        ? `响应回显了恶意 Origin（ACAO: ${acao}），跨站脚本可借浏览器读取接口`
        : `状态 ${r.status}，ACAO=${acao || '(未下发)'}${r.status === 404 ? '（接口尚未部署）' : ''}`,
      echoesEvil ? '把 CORS 改为白名单回显，拒绝任意外域 Origin' : ''));
  }
  // OPTIONS 预检回显检查（db 端点历史上会回显任意 Origin）
  try {
    const pre = await fetchWithTimeout(site + '/api/db/rest/v1/users', {
      method: 'OPTIONS',
      headers: { Origin: EVIL_ORIGIN, 'Access-Control-Request-Method': 'GET' }
    }, T);
    const preAcao = pre.headers.get('access-control-allow-origin') || '';
    checks.push(check('CORS-PREFLIGHT', 'CORS', 'OPTIONS 预检不得回显恶意 Origin',
      'medium', preAcao === EVIL_ORIGIN ? 'warn' : 'pass',
      preAcao === EVIL_ORIGIN ? `预检 204 回显 ${preAcao}（后续真实请求虽不带 ACAO 仍被读响应，但应一并收紧）` : `预检未回显恶意 Origin（ACAO=${preAcao || '(无)'}）`,
      preAcao === EVIL_ORIGIN ? '预检阶段同样做 Origin 白名单校验' : ''));
  } catch (e) {
    checks.push(check('CORS-PREFLIGHT', 'CORS', 'OPTIONS 预检不得回显恶意 Origin',
      'low', 'unknown', '预检请求失败：' + e.message, ''));
  }

  // ---------- 3. RLS 与数据面（anon key 只读探测） ----------
  if (!cfg.supabaseAnonKey) {
    checks.push(check('RLS-TABLES', 'RLS数据面', 'anon key 对全部业务表的只读探测',
      'high', 'unknown', '未配置 SUPABASE_ANON_KEY，跳过 RLS 探测',
      '在 Function/Actions 环境注入公开 publishable key'));
  } else {
    const leaked = [];
    for (const t of DATA_TABLES) {
      const r = await fetchWithTimeout(`${sb}/rest/v1/${t}?select=*&limit=1`, {
        headers: { apikey: cfg.supabaseAnonKey, Authorization: `Bearer ${cfg.supabaseAnonKey}` }
      }, T);
      const body = await r.text();
      let rows = null;
      try { rows = JSON.parse(body); } catch (_) {}
      const isLeak = Array.isArray(rows) && rows.length > 0;
      if (isLeak) leaked.push(`${t}(${rows.length}行)`);
    }
    checks.push(check('RLS-TABLES', 'RLS数据面', 'anon key 对 16 张业务表只读探测（不得返回数据）',
      'high', leaked.length === 0 ? 'pass' : 'fail',
      leaked.length === 0
        ? '全部 16 张表对 anon 均返回空数组/拒绝，RLS 生效'
        : '以下表对 anon 返回了真实数据：' + leaked.join(', '),
      leaked.length === 0 ? '' : '立即检查表 RLS 策略，撤销 anon 的 SELECT 权限'));
  }

  const openapi = await getHeaders(cfg, `${sb}/rest/v1/`, { apikey: cfg.supabaseAnonKey || '' });
  const openapiBody = await openapi.text();
  const openapiLeak = /paths|openapi|definitions/.test(openapiBody) && !/secret api key required/i.test(openapiBody);
  checks.push(check('RLS-OPENAPI', 'RLS数据面', 'PostgREST OpenAPI 根不对 anon 暴露',
    'medium', openapiLeak ? 'warn' : 'pass',
    openapiLeak ? 'OpenAPI 文档对 anon 可访问（暴露表结构）' : 'OpenAPI 根要求 secret key，anon 不可见',
    openapiLeak ? '在 PostgREST 配置关闭 anon 的根文档访问' : ''));

  const storage = await getHeaders(cfg, `${sb}/storage/v1/bucket`, { apikey: cfg.supabaseAnonKey || '' });
  let storageEmpty = false;
  try { const sbList = JSON.parse(await storage.text()); storageEmpty = Array.isArray(sbList) && sbList.length === 0; } catch (_) {}
  const storageBlocked = storage.status === 401 || storage.status === 403 || storageEmpty;
  checks.push(check('RLS-STORAGE', 'RLS数据面', 'anon 不得列出 Storage 桶（空列表视为 RLS 生效）',
    'medium', storageBlocked ? 'pass' : (storage.status === 0 ? 'unknown' : 'warn'),
    `状态 ${storage.status}（期望 401/403 或空列表${storageEmpty ? '；当前为空，RLS 生效' : ''}）`,
    storage.status === 200 && !storageEmpty ? '撤销 anon 对 storage buckets 的列出权限' : ''));

  // ---------- 4. 服务端鉴权（无会话必须拒绝） ----------
  const authProbes = [
    { id: 'AUTH-DB-LOGS', path: '/api/db/rest/v1/admin_logs?select=*&limit=1', method: 'GET' },
    { id: 'AUTH-TRASH', path: '/api/trash', method: 'POST', body: JSON.stringify({ action: 'list' }) },
    { id: 'AUTH-MONITOR', path: '/api/monitor', method: 'GET' },
    { id: 'AUTH-SCAN-GET', path: '/api/security-scan', method: 'GET' },
    { id: 'AUTH-SCAN-POST', path: '/api/security-scan', method: 'POST', body: JSON.stringify({ action: 'run' }) },
    { id: 'AUTH-UPLOAD', path: '/api/upload-to-github', method: 'POST', body: '' }
  ];
  for (const p of authProbes) {
    const r = await getHeaders(cfg, p.path, p.body ? { 'Content-Type': 'application/json' } : {});
    // getHeaders 只发 GET；POST 探测单独发
    let status = r.status;
    let ct = r.headers.get('content-type') || '';
    if (p.method !== 'GET') {
      try {
        const pr = await fetchWithTimeout(site + p.path, {
          method: p.method,
          headers: { 'Content-Type': 'application/json', 'User-Agent': cfg.ua || UA },
          body: p.body || undefined
        }, T);
        status = pr.status;
        ct = pr.headers.get('content-type') || '';
      } catch (e) { status = 0; }
    }
    const expected = status === 401 || status === 403;
    // 200 且返回 HTML → 命中 SPA 回退页（接口尚未部署）；405 → 静态托管无此路由
    const undeployed = (status === 200 && /text\/html/.test(ct)) || status === 405;
    checks.push(check(p.id, '服务端鉴权', `无会话访问 ${p.path} 必须被拒绝`,
      'high', undeployed ? 'unknown' : (expected ? 'pass' : 'fail'),
      `状态 ${status}（期望 401/403）${undeployed ? '，接口尚未部署（命中 SPA 回退页/405）' : ''}`,
      expected ? '' : '补齐会话校验，未登录一律 401'));
  }

  // ---------- 5. 会话与环境 ----------
  checks.push(check('ENV-SESSION-SECRET', '会话配置', 'AUTH_SESSION_SECRET 独立配置（非复用 service key）',
    'high',
    cfg.envFlags.sessionSecret ? 'pass' : 'unknown',
    cfg.envFlags.sessionSecret ? 'Function 环境检测到 AUTH_SESSION_SECRET 已配置'
      : 'Actions 侧无法读取运行时环境（记 unknown）；若未配置会退化为复用 service_role 签发会话',
    '在 Cloudflare Pages 单独设置 AUTH_SESSION_SECRET（随机长串）'));
  checks.push(check('ENV-CONFIG-COMPLETE', '会话配置', '必需的运行时环境变量齐备',
    'high',
    (cfg.envFlags.supabaseUrl && cfg.envFlags.serviceRoleKey) ? 'pass' : 'unknown',
    `supabaseUrl=${cfg.envFlags.supabaseUrl ? '✓' : '✗'} serviceRoleKey=${cfg.envFlags.serviceRoleKey ? '✓' : '✗'}（仅报告布尔值）`,
    'Cloudflare Pages 补齐 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'));
  checks.push(check('ENV-ORIGINS', '会话配置', '上传/账号接口配置了 Origin 白名单',
    'low',
    cfg.envFlags.allowedOrigins === undefined ? 'unknown'
      : (cfg.envFlags.allowedOrigins ? 'pass' : 'warn'),
    cfg.envFlags.allowedOrigins ? '已配置 UPLOAD_ALLOWED_ORIGINS/ACCOUNT_ALLOWED_ORIGINS'
      : '未配置白名单，当前仅靠同源判断兜底',
    '配置 UPLOAD_ALLOWED_ORIGINS / ACCOUNT_ALLOWED_ORIGINS'));
  checks.push(check('COOKIE-FLAGS', '会话配置', '登录 Cookie 标志（HttpOnly/Secure/SameSite）人工复核',
    'low', 'info',
    '出于安全纪律，本扫描不尝试真实登录、不观察 Set-Cookie；请人工确认 couple_t 为 HttpOnly+Secure+SameSite=Lax',
    '登录成功后 curl -i 查看 Set-Cookie 属性'));

  // ---------- 6. GitHub 面 ----------
  if (!cfg.githubToken) {
    checks.push(check('GH-IMAGE-REPO-PRIVATE', 'GitHub面', '私密图仓必须为 private',
      'high', 'unknown',
      '未配置 GITHUB_TOKEN，无法读取仓库元信息',
      '在 Cloudflare Pages 配置 GITHUB_TOKEN（repo 只读 scope），Actions 配置 IMAGE_REPO_TOKEN'));
    checks.push(check('GH-MAIN-REPO-SECRETS', 'GitHub面', '主仓不得提交 .dev.vars/wrangler.toml 等密钥文件',
      'high', 'unknown', '未配置 GITHUB_TOKEN，无法抽查主仓文件树', '配置 GITHUB_TOKEN 后自动检查'));
    checks.push(check('GH-WORKFLOW-PERMISSIONS', 'GitHub面', 'GitHub Actions 默认权限最小化',
      'medium', 'unknown',
      '请人工确认 .github/workflows 已声明 permissions: contents: read（本扫描的静态检查项会补充）', ''));
  } else {
    const ghHeaders = {
      Authorization: `Bearer ${cfg.githubToken}`, Accept: 'application/vnd.github+json',
      'User-Agent': 'couple-site-scan', 'X-GitHub-Api-Version': '2022-11-28'
    };
    const imgRepoRes = await getHeaders(cfg, `https://api.github.com/repos/${cfg.githubOwner}/${cfg.githubImgRepo}`, ghHeaders);
    let imgRepo = {};
    try { imgRepo = JSON.parse(await imgRepoRes.text()); } catch (_) {}
    checks.push(check('GH-IMAGE-REPO-PRIVATE', 'GitHub面', '私密图仓必须为 private',
      'high', imgRepo.private === true ? 'pass' : 'fail',
      imgRepo.private === true
        ? `${cfg.githubImgRepo} 为 private（size=${imgRepo.size}KB）`
        : `图仓 private=${imgRepo.private}（HTTP ${imgRepoRes.status}）——私密照片不得放在公开仓！`,
      '立即把仓库切换为 private，并轮换可能泄露的文件'));

    // 主仓文件树抽查密钥文件
    const main = cfg.mainRepo || 'love-site';
    const treeRes = await getHeaders(cfg, `https://api.github.com/repos/${cfg.githubOwner}/${main}/git/trees/${cfg.githubBranch || 'main'}?recursive=1`, ghHeaders);
    let tree = {};
    try { tree = JSON.parse(await treeRes.text()); } catch (_) {}
    const dangerousFiles = (Array.isArray(tree.tree) ? tree.tree.map(t => t.path) : [])
      .filter(p => /(^|\/)(\.dev\.vars|wrangler\.toml|\.env(\..+)?|\.npmrc)$/.test(p));
    checks.push(check('GH-MAIN-REPO-SECRETS', 'GitHub面', '主仓不得包含 .dev.vars/wrangler.toml/.env',
      'high', dangerousFiles.length === 0 ? 'pass' : 'fail',
      dangerousFiles.length === 0 ? '文件树抽查未发现密钥文件' : '发现疑似密钥文件：' + dangerousFiles.join(', '),
      '从历史中彻底移除密钥文件并轮换该密钥'));
  }

  // ---------- 7. Supabase 面（service_role 探测） ----------
  if (!cfg.serviceRoleKey) {
    checks.push(check('SB-STORAGE-BUCKETS', 'Supabase面', 'Storage 桶公开情况',
      'medium', 'unknown', 'Actions 侧不持有 service_role key，跳过（Function 侧扫描自动补检）', ''));
    checks.push(check('SB-USERS-PASSWORD-COLUMN', 'Supabase面', 'users 表不得残留明文 password 列',
      'high', 'unknown', 'Actions 侧不持有 service_role key，跳过', ''));
  } else {
    const sbHeaders = { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}` };
    // 桶
    const buckets = await getHeaders(cfg, `${sb}/storage/v1/bucket`, sbHeaders);
    let bucketList = [];
    try { bucketList = JSON.parse(await buckets.text()); } catch (_) {}
    const publicBuckets = Array.isArray(bucketList) ? bucketList.filter(b => b.public) : [];
    checks.push(check('SB-STORAGE-BUCKETS', 'Supabase面', 'Storage 桶公开情况',
      'medium', publicBuckets.length === 0 ? 'pass' : 'warn',
      Array.isArray(bucketList)
        ? `共 ${bucketList.length} 个桶，公开桶：${publicBuckets.map(b => b.name).join(', ') || '无'}`
        : `桶列表获取失败（${buckets.status}）`,
      publicBuckets.length ? '私密内容所在桶必须设为 private' : ''));

    // users.password 列残留（只 select password 列，limit 1；绝不把值写进报告）
    const pcol = await fetchWithTimeout(`${sb}/rest/v1/users?select=password&limit=1`, { headers: sbHeaders }, T);
    let pcolRows = null;
    try { pcolRows = JSON.parse(await pcol.text()); } catch (_) {}
    const pcolExists = Array.isArray(pcolRows) && pcol.status === 200;
    checks.push(check('SB-USERS-PASSWORD-COLUMN', 'Supabase面', 'users 表不得残留明文 password 列',
      'high', pcolExists ? 'fail' : 'pass',
      pcolExists
        ? `成功 select 到 password 列（${Array.isArray(pcolRows) ? pcolRows.length : 0} 行）——历史明文密码列仍在！报告未记录任何值。`
        : `select password 返回 ${pcol.status}，列应已移除`,
      pcolExists ? 'ALTER TABLE users DROP COLUMN password; 并审计历史登录日志' : ''));
  }

  // auth 注册是否开放（只读 GET，期望 405）
  const signup = await getHeaders(cfg, `${sb}/auth/v1/signup`, { apikey: cfg.supabaseAnonKey || '' });
  checks.push(check('SB-OPEN-SIGNUP', 'Supabase面', 'GoTrue 注册端点状态',
    'medium', signup.status === 405 || signup.status === 401 ? 'pass' : 'info',
    `GET /auth/v1/signup 状态 ${signup.status}（本站账号体系在 /api/account，不使用 GoTrue；生产应保持拒绝开放注册）`,
    'Dashboard → Authentication → Providers 关闭 Email 注册'));

  // ---------- 8. 暴露面 ----------
  const probePath = async (path, dangerous) => {
    const r = await getHeaders(cfg, path);
    const body = await r.text();
    const leaked = dangerous(body, r);
    return { status: r.status, leaked };
  };
  const git = await probePath('/.git/config', (b, r) => r.status === 200 && /\[core\]|repositoryformatversion/i.test(b));
  checks.push(check('EXP-GIT', '暴露面', '/.git/config 不得泄露',
    'high', git.leaked ? 'fail' : 'pass',
    git.leaked ? '检测到 git 配置内容！' : `状态 ${git.status}（未泄露 git 内容）`,
    git.leaked ? '从发布目录移除 .git，并在 Pages 构建配置排除' : ''));
  const dv = await probePath('/.dev.vars', (b, r) => r.status === 200 && /SUPABASE|SECRET|TOKEN/i.test(b) && !/<html/i.test(b));
  checks.push(check('EXP-DEVVARS', '暴露面', '/.dev.vars 不得泄露',
    'high', dv.leaked ? 'fail' : 'pass',
    dv.leaked ? '检测到 dev.vars 密钥内容！' : `状态 ${dv.status}（未泄露，命中为 SPA 回退页）`,
    dv.leaked ? '删除已泄露密钥并轮换' : ''));
  const sql = await probePath('/sql/trash-columns.sql', (b, r) => r.status === 200 && /^--\s|CREATE TABLE|ALTER TABLE/i.test(b));
  checks.push(check('EXP-SQL-DIR', '暴露面', 'sql/ 迁移脚本不得被公开发布',
    'medium', sql.leaked ? 'warn' : 'pass',
    sql.leaked
      ? 'GET /sql/trash-columns.sql 直接返回了 SQL 源文件（暴露表结构/迁移逻辑，无密钥但属信息泄露）'
      : `状态 ${sql.status}（未泄露）`,
    sql.leaked ? '在 Cloudflare Pages 构建配置把 sql/、docs/ 移出发布目录，或用 Functions 拦截' : ''));
  checks.push(check('EXP-HTTPS', '暴露面', '站点强制 HTTPS',
    'high', /^https:/.test(cfg.siteUrl) ? 'pass' : 'fail',
    `siteUrl=${cfg.siteUrl}`, 'Pages 默认即 HTTPS；配合 HSTS 完成闭环'));

  // ---------- 9. 图床与代理 ----------
  const trav = await getHeaders(cfg, '/api/img/..%2f..%2f..%2fetc%2fpasswd');
  checks.push(check('IMG-TRAVERSAL', '图床代理', '/api/img 路径穿越必须被拒绝',
    'high', trav.status === 400 || trav.status === 403 ? 'pass' : 'fail',
    `状态 ${trav.status}（期望 400/403）`,
    trav.status === 200 ? '立即修复路径段校验，拒绝含 .. 的段' : ''));
  const imgNoAuth = await getHeaders(cfg, '/api/img/common/2099-01/nonexistent.jpg');
  checks.push(check('IMG-NOAUTH', '图床代理', '/api/img 无会话必须 401',
    'high', imgNoAuth.status === 401 || imgNoAuth.status === 403 ? 'pass' : 'warn',
    `状态 ${imgNoAuth.status}（期望 401/403）`,
    imgNoAuth.status === 200 ? '补齐会话校验' : ''));

  // ---------- 汇总 ----------
  let score = 100;
  let high = 0, medium = 0, low = 0, info = 0, passes = 0, fails = 0, warns = 0, unknowns = 0;
  for (const c of checks) {
    if (c.status === 'pass') { passes++; continue; }
    if (c.status === 'unknown') { unknowns++; continue; }
    if (c.status === 'info') { info++; continue; }
    // fail / warn 按严重度扣分（warn 扣一半）
    const base = c.severity === 'high' ? 15 : c.severity === 'medium' ? 6 : c.severity === 'low' ? 2 : 0;
    const deduct = c.status === 'warn' ? Math.ceil(base / 2) : base;
    score = Math.max(0, score - deduct);
    if (c.status === 'fail') fails++; else warns++;
    if (c.severity === 'high') high++;
    else if (c.severity === 'medium') medium++;
    else if (c.severity === 'low') low++;
    else info++;
  }
  const grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : score >= 40 ? 'E' : 'F';

  return {
    generatedAt: new Date().toISOString(),
    summary: { score, grade, high, medium, low, info, passes, fails, warns, unknowns, total: checks.length },
    checks
  };
}

export default runSecurityChecks;
