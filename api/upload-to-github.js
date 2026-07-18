const crypto = require('crypto');

const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;
const ALLOWED_FOLDERS = new Set(['common', 'feeds', 'messages', 'bubbles', 'avatars']);

module.exports = async function uploadToGitHub(req, res) {
  const originCheck = checkAllowedOrigin(req.headers.origin || '', process.env.UPLOAD_ALLOWED_ORIGINS);
  setCorsHeaders(res, originCheck.corsOrigin);

  if (!originCheck.allowed) {
    sendJson(res, 403, { error: 'Upload origin is not allowed.' });
    return;
  }

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER || 'shaozixiang';
  const repo = process.env.GITHUB_REPO || 'couple-images';
  const branch = process.env.GITHUB_BRANCH || 'main';

  if (!token) {
    sendJson(res, 500, { error: 'GITHUB_TOKEN is not configured on the server.' });
    return;
  }

  try {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(?:(?:"([^"]+)")|([^;]+))/i);
    if (!boundaryMatch) {
      sendJson(res, 400, { error: 'Expected multipart/form-data upload.' });
      return;
    }

    const body = await readBody(req, MAX_UPLOAD_BYTES);
    const multipart = parseMultipart(body, boundaryMatch[1] || boundaryMatch[2]);
    const file = multipart.files.file || multipart.files.media;
    if (!file || !file.data || file.data.length === 0) {
      sendJson(res, 400, { error: 'No media file received.' });
      return;
    }

    const folder = sanitizeFolder(multipart.fields.folder || 'common');
    const extension = getExtension(file.filename, file.contentType);
    const datedFolder = new Date().toISOString().slice(0, 7);
    const objectName = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${extension}`;
    const githubPath = `${folder}/${datedFolder}/${objectName}`;
    const encodedPath = githubPath.split('/').map(encodeURIComponent).join('/');

    const githubResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'couple-love-site-uploader',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: JSON.stringify({
        message: `Upload ${folder} media ${objectName}`,
        branch,
        content: file.data.toString('base64')
      })
    });

    const githubJson = await githubResponse.json().catch(() => ({}));
    if (!githubResponse.ok) {
      sendJson(res, githubResponse.status, {
        error: githubJson.message || 'GitHub upload failed.'
      });
      return;
    }

    const cdnUrl = `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${encodedPath}`;
    sendJson(res, 200, {
      url: cdnUrl,
      cdnUrl,
      path: githubPath,
      size: file.data.length,
      contentType: file.contentType || 'application/octet-stream'
    });
  } catch (error) {
    const status = error && error.code === 'PAYLOAD_TOO_LARGE' ? 413 : 500;
    sendJson(res, status, { error: error.message || 'Upload failed.' });
  }
};

function setCorsHeaders(res, origin) {
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}

function checkAllowedOrigin(origin, allowedOriginsConfig) {
  const allowedOrigins = parseAllowedOrigins(allowedOriginsConfig);
  if (allowedOrigins.length === 0) return { allowed: true, corsOrigin: '*' };
  if (!origin) return { allowed: true, corsOrigin: allowedOrigins[0] };
  const allowed = allowedOrigins.includes(origin);
  return { allowed, corsOrigin: allowed ? origin : '' };
}

function parseAllowedOrigins(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on('data', chunk => {
      total += chunk.length;
      if (total > limitBytes) {
        const error = new Error('The selected media is too large for this upload endpoint.');
        error.code = 'PAYLOAD_TOO_LARGE';
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipart(buffer, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const fields = {};
  const files = {};
  let cursor = buffer.indexOf(delimiter);

  while (cursor !== -1) {
    cursor += delimiter.length;
    if (buffer.slice(cursor, cursor + 2).toString() === '--') break;
    if (buffer.slice(cursor, cursor + 2).toString() === '\r\n') cursor += 2;

    const next = buffer.indexOf(delimiter, cursor);
    if (next === -1) break;

    let part = buffer.slice(cursor, next);
    if (part.slice(-2).toString() === '\r\n') part = part.slice(0, -2);

    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd !== -1) {
      const headerText = part.slice(0, headerEnd).toString('utf8');
      const data = part.slice(headerEnd + 4);
      const disposition = parseHeader(headerText, 'content-disposition');
      const name = getHeaderParam(disposition, 'name');
      const filename = getHeaderParam(disposition, 'filename');
      const partContentType = parseHeader(headerText, 'content-type');

      if (name && filename !== null) {
        files[name] = { filename, contentType: partContentType, data };
      } else if (name) {
        fields[name] = data.toString('utf8');
      }
    }

    cursor = next;
  }

  return { fields, files };
}

function parseHeader(headerText, headerName) {
  const line = headerText.split('\r\n').find(item => item.toLowerCase().startsWith(`${headerName}:`));
  return line ? line.slice(line.indexOf(':') + 1).trim() : '';
}

function getHeaderParam(headerValue, paramName) {
  const match = headerValue.match(new RegExp(`${paramName}="([^"]*)"`, 'i'));
  return match ? match[1] : null;
}

function sanitizeFolder(folder) {
  const normalized = String(folder || 'common').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return ALLOWED_FOLDERS.has(normalized) ? normalized : 'common';
}

function getExtension(filename, contentType) {
  const mimeExtension = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov'
  }[String(contentType || '').toLowerCase()];

  if (mimeExtension) return mimeExtension;

  const nameMatch = String(filename || '').toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return nameMatch ? nameMatch[1] : 'bin';
}
