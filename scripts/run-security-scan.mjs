// ============================================================
// 安全扫描入口（GitHub Actions / Node 22）
// - 负责：静态代码扫描 → 组装 cfg → 调用 security-checks.mjs 引擎 → 落盘报告
// - 退出码：有 high 问题 → 1；否则 0
//
// 需要的环境变量：
//   SITE_URL             默认 https://love-site-2am.pages.dev
//   SUPABASE_URL         Supabase 项目地址
//   SUPABASE_ANON_KEY    公开 publishable key（与 keepalive.yml 一致）
//   SERVICE_ROLE_KEY     可选 secret；不给则 Supabase 服务面检查记 unknown
//   GITHUB_TOKEN         默认使用 Actions 内置 GITHUB_TOKEN（只读主仓）
//   IMAGE_REPO_TOKEN     可选 secret；用于检查私密图仓是否 private
//   GITHUB_OWNER         默认 shaozixiang
//   GITHUB_IMG_REPO      默认 couple-images
//   GITHUB_BRANCH        默认 main
//   GITHUB_MAIN_REPO     默认 love-site
// ============================================================

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import runSecurityChecks from './security-checks.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ---------- 1. 静态代码扫描 ----------
function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.git' || name === 'docs/security-reports') continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const SOURCE_EXT = new Set(['.js', '.mjs', '.html', '.yml', '.yaml', '.toml', '.vars', '.css']);
const files = walk(ROOT).filter(f => SOURCE_EXT.has(extname(f)));

// 已知公开 publishable key（keepalive.yml 里本来就公开，不算泄露）
const KNOWN_PUBLIC = 'sb_publishable_Z8E9qPbi6F2NLzoQh9fhfw__goWiZZ4';

function grep(pattern) {
  const hits = [];
  for (const f of files) {
    let text = '';
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    // 跳过自身报告目录与公开 key
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (line.includes(KNOWN_PUBLIC)) return;
      if (pattern.test(line)) hits.push(`${relative(ROOT, f)}:${i + 1}`);
    });
  }
  return hits;
}

const staticFindings = [];

// 1.1 硬编码密钥（service_role JWT / GitHub PAT / AWS / OpenAI sk-）
const secretPatterns = [
  { re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, label: 'JWT/service-role key' },
  { re: /ghp_[A-Za-z0-9]{30,}/, label: 'GitHub classic PAT' },
  { re: /github_pat_[A-Za-z0-9_]{20,}/, label: 'GitHub fine-grained PAT' },
  { re: /AKIA[0-9A-Z]{16}/, label: 'AWS access key' },
  { re: /sk-[A-Za-z0-9]{20,}/, label: 'OpenAI 风格 sk- key' }
];
const secretHits = [];
for (const p of secretPatterns) secretHits.push(...grep(p.re));
staticFindings.push({
  id: 'STATIC-SECRETS', category: '静态代码', severity: 'high',
  title: '源码/配置中不得硬编码密钥',
  status: secretHits.length === 0 ? 'pass' : 'fail',
  detail: secretHits.length === 0 ? '未发现硬编码的 service_role key / PAT / 云厂商 key' : '命中：' + secretHits.slice(0, 10).join('; '),
  fix: '把命中的密钥移入环境变量/secrets，并轮换已泄露的密钥'
});

// 1.2 管理员账号名写进错误文案/JS
const adminHits = grep(/(error|错误|无权|拒绝).{0,20}(admin|管理员)/i);
staticFindings.push({
  id: 'STATIC-ADMIN-LEAK', category: '静态代码', severity: 'low',
  title: '错误文案不应泄露管理员账号特征',
  status: adminHits.length === 0 ? 'pass' : 'warn',
  detail: adminHits.length === 0 ? '未发现把 admin 写进错误文案的位置' : '命中 ' + adminHits.length + ' 处：' + adminHits.slice(0, 5).join('; '),
  fix: '错误文案统一为“无权操作/未登录”，不暴露管理员角色名'
});

// 1.3 innerHTML 拼接用户可控内容
let innerHtmlCount = 0;
for (const f of files) {
  if (!/\/(app|lib)\//.test(f) && !f.endsWith('.html')) continue;
  try { innerHtmlCount += (readFileSync(f, 'utf8').match(/\.innerHTML\s*=/g) || []).length; } catch {}
}
staticFindings.push({
  id: 'STATIC-INNERHTML', category: '静态代码', severity: 'low',
  title: '前端 innerHTML 使用数量',
  status: innerHtmlCount <= 20 ? 'pass' : 'warn',
  detail: `app/lib/ 与 HTML 中共 ${innerHtmlCount} 处 innerHTML 赋值（需人工确认均不拼接用户输入）`,
  fix: '用户内容一律用 textContent，或做转义白名单'
});

// 1.4 Workflow 权限最小化
let wfText = '';
try { wfText = readFileSync(join(ROOT, '.github/workflows/security-scan.yml'), 'utf8'); } catch {}
const hasPerms = /permissions:\s*\n\s+contents:\s+write/.test(wfText) || /permissions:/.test(wfText);
staticFindings.push({
  id: 'STATIC-WORKFLOW-PERM', category: '静态代码', severity: 'medium',
  title: 'GitHub Actions 显式声明最小权限',
  status: hasPerms ? 'pass' : 'warn',
  detail: hasPerms ? 'security-scan.yml 已显式声明 permissions' : '未在 workflow 中声明 permissions（默认 read/write 过大）',
  fix: '在 workflow 顶部声明 permissions: contents: write'
});

// 1.5 _headers 完整性
let headersText = '';
try { headersText = readFileSync(join(ROOT, '_headers'), 'utf8'); } catch {}
staticFindings.push({
  id: 'STATIC-HEADERS-FILE', category: '静态代码', severity: 'medium',
  title: '_headers 包含完整安全头',
  status: /Content-Security-Policy/.test(headersText) && /Strict-Transport-Security/.test(headersText) ? 'pass' : 'warn',
  detail: /Content-Security-Policy/.test(headersText) ? '_headers 含 CSP/HSTS 等' : '_headers 缺 CSP/HSTS',
  fix: '补齐 CSP/HSTS/X-Frame-Options 等'
});

// 1.6 SW 是否缓存 API
let swText = '';
try { swText = readFileSync(join(ROOT, 'app/sw.js'), 'utf8'); } catch {}
const swCachesApi = /\/api\//.test(swText) && /cache\.(put|addAll)/.test(swText);
staticFindings.push({
  id: 'STATIC-SW-API-CACHE', category: '静态代码', severity: 'medium',
  title: 'Service Worker 不得缓存 API 响应',
  status: swCachesApi ? 'warn' : 'pass',
  detail: swCachesApi ? '检测到 SW 可能缓存 /api/ 响应，存在读到旧会话数据的风险' : 'SW 未缓存 /api/',
  fix: 'SW 的 fetch 拦截里对 /api/ 直接 bypassNetwork'
});

// ---------- 2. 组装配置并执行引擎 ----------
const cfg = {
  siteUrl: process.env.SITE_URL || 'https://love-site-2am.pages.dev',
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null,
  serviceRoleKey: process.env.SERVICE_ROLE_KEY || null,
  githubToken: process.env.IMAGE_REPO_TOKEN || process.env.GITHUB_TOKEN || null,
  githubOwner: process.env.GITHUB_OWNER || 'shaozixiang',
  githubImgRepo: process.env.GITHUB_IMG_REPO || 'couple-images',
  githubBranch: process.env.GITHUB_BRANCH || 'main',
  mainRepo: process.env.GITHUB_MAIN_REPO || 'love-site',
  envFlags: {
    supabaseUrl: !!process.env.SUPABASE_URL,
    serviceRoleKey: !!process.env.SERVICE_ROLE_KEY,
    sessionSecret: false,                 // Actions 侧读不到运行时环境
    githubToken: !!(process.env.IMAGE_REPO_TOKEN || process.env.GITHUB_TOKEN),
    allowedOrigins: undefined
  },
  staticFindings,
  timeoutMs: 9000
};

const report = await runSecurityChecks(cfg);

// ---------- 3. 落盘 ----------
const ts = new Date();
const pad = (n) => String(n).padStart(2, '0');
const stamp = `${ts.getUTCFullYear()}${pad(ts.getUTCMonth() + 1)}${pad(ts.getUTCDate())}-${pad(ts.getUTCHours())}${pad(ts.getUTCMinutes())}`;
const outDir = join(ROOT, 'docs/security-reports');
mkdirSync(outDir, { recursive: true });

const jsonPath = join(outDir, `scan-${stamp}.json`);
writeFileSync(jsonPath, JSON.stringify(report, null, 2));

// markdown 摘要
const s = report.summary;
const lines = [
  `# 安全扫描摘要 ${report.generatedAt}`,
  '',
  `- 总分：**${s.score}** / 100　评级：**${s.grade}**`,
  `- high: ${s.high}　medium: ${s.medium}　low: ${s.low}　info: ${s.info}`,
  `- pass: ${s.passes}　fail: ${s.fails}　warn: ${s.warns}　unknown: ${s.unknowns}（共 ${s.total} 项）`,
  '',
  '## 未通过项',
  ''
];
for (const c of report.checks) {
  if (c.status === 'fail' || c.status === 'warn') {
    lines.push(`- [${c.severity}] **${c.title}** — ${c.detail}${c.fix ? `（修复：${c.fix}）` : ''}`);
  }
}
if (!report.checks.some(c => c.status === 'fail' || c.status === 'warn')) lines.push('- 无');
lines.push('', '## 未知/未覆盖项', '');
for (const c of report.checks) {
  if (c.status === 'unknown' || c.status === 'info') {
    lines.push(`- [${c.severity}] ${c.title} — ${c.detail}`);
  }
}
writeFileSync(join(outDir, 'latest.md'), lines.join('\n'));

console.log(JSON.stringify({ score: s.score, grade: s.grade, high: s.high, medium: s.medium, low: s.low, passes: s.passes, fails: s.fails, warns: s.warns, unknowns: s.unknowns }, null, 2));
console.log('报告已写入：' + relative(ROOT, jsonPath));

if (s.high > 0) {
  console.error(`::error::发现 ${s.high} 个 high 级别安全问题，请尽快修复`);
  process.exit(1);
}
process.exit(0);
