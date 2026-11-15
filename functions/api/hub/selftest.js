// 临时自检端点（验证后即删除）：确认线上运行时的仓库令牌可读可写
export async function onRequest(context) {
  const { env } = context;
  const token = env.GITHUB_TOKEN;
  const owner = env.GITHUB_OWNER || 'shaozixiang';
  const repo = env.GITHUB_REPO || 'couple-images';
  const branch = env.GITHUB_BRANCH || 'main';
  const h = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'User-Agent': 'hub-selftest' };
  const out = { hasToken: !!token, owner, repo, branch };

  try {
    const list = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/files/out?ref=${branch}`, { headers: h });
    out.listStatus = list.status;
    if (list.ok) {
      const items = await list.json();
      out.outCount = Array.isArray(items) ? items.length : -1;
      if (Array.isArray(items) && items[0]) {
        const p = 'files/out/' + items[0].name;
        const raw = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${p.split('/').map(encodeURIComponent).join('/')}`, { headers: { Authorization: 'Bearer ' + token } });
        out.rawStatus = raw.status;
        out.rawBytes = raw.ok ? (await raw.arrayBuffer()).byteLength : 0;
      }
    }
  } catch (e) { out.listError = String(e).slice(0, 120); }

  try {
    const blob = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/blobs`, {
      method: 'POST', headers: { ...h, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'c2VsZi10ZXN0', encoding: 'base64' })
    });
    out.writeStatus = blob.status;
    if (blob.ok) out.blobSha = (await blob.json()).sha.slice(0, 7);
  } catch (e) { out.writeError = String(e).slice(0, 120); }

  return new Response(JSON.stringify(out, null, 2), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
