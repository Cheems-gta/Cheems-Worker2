const encoder = new TextEncoder();
const endpoint = 'https://tmt.tencentcloudapi.com/';
const maxBodyBytes = 40000;

function json(data, status = 200, headers = {}) {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', ...headers },
  });
}

function hex(buffer) {
  return Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function hash(text) {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

async function hmac(key, text) {
  const bytes = typeof key === 'string' ? encoder.encode(key) : key;
  const imported = await crypto.subtle.importKey(
    'raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return crypto.subtle.sign('HMAC', imported, encoder.encode(text));
}

async function authorization(payload, env, timestamp) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const scope = `${date}/tmt/tc3_request`;
  const canonical = [
    'POST', '/', '',
    'content-type:application/json; charset=utf-8\nhost:tmt.tencentcloudapi.com\n',
    'content-type;host', await hash(payload),
  ].join('\n');
  const stringToSign = ['TC3-HMAC-SHA256', timestamp, scope, await hash(canonical)].join('\n');
  const dateKey = await hmac(`TC3${env.TENCENT_SECRET_KEY}`, date);
  const serviceKey = await hmac(dateKey, 'tmt');
  const signingKey = await hmac(serviceKey, 'tc3_request');
  const signature = hex(await hmac(signingKey, stringToSign));
  return `TC3-HMAC-SHA256 Credential=${env.TENCENT_SECRET_ID}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`;
}

async function readBody(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('INVALID_JSON');
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBodyBytes) {
      await reader.cancel();
      throw new Error('BODY_TOO_LARGE');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

async function translate(request, env, headers) {
  if (!env.ACCESS_TOKEN || !env.TENCENT_SECRET_ID || !env.TENCENT_SECRET_KEY) {
    return json({ error: 'NOT_CONFIGURED', message: '请先在 Cloudflare Secrets 中配置 ACCESS_TOKEN、TENCENT_SECRET_ID、TENCENT_SECRET_KEY。' }, 503, headers);
  }
  // The deployment starts as a private API so an exposed URL cannot spend translation credits.
  const received = request.headers.get('Authorization') || '';
  const [actual, expected] = await Promise.all([
    hash(received), hash(`Bearer ${env.ACCESS_TOKEN}`),
  ]);
  if (actual !== expected) return json({ error: 'UNAUTHORIZED' }, 401, headers);
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return json({ error: 'JSON_REQUIRED' }, 415, headers);
  }
  let body;
  try {
    body = await readBody(request);
  } catch (error) {
    const tooLarge = error.message === 'BODY_TOO_LARGE';
    return json({ error: tooLarge ? 'BODY_TOO_LARGE' : 'INVALID_JSON' }, tooLarge ? 413 : 400, headers);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'INVALID_REQUEST' }, 400, headers);
  }
  const { text, source = 'auto', target = 'zh' } = body;
  if (typeof text !== 'string' || !text.trim() || [...text].length > 5000) {
    return json({ error: 'INVALID_TEXT', message: '请输入 1–5000 个字符。' }, 400, headers);
  }
  const languages = new Set(['zh', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'es', 'it', 'de', 'tr', 'ru', 'pt', 'vi', 'id', 'th', 'ms', 'ar', 'hi']);
  if ((source !== 'auto' && !languages.has(source)) || !languages.has(target)) {
    return json({ error: 'INVALID_LANGUAGE' }, 400, headers);
  }
  const payload = JSON.stringify({ SourceText: text, Source: source, Target: target, ProjectId: 0 });
  const timestamp = Math.floor(Date.now() / 1000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: await authorization(payload, env, timestamp),
        'X-TC-Action': 'TextTranslate',
        'X-TC-Version': '2018-03-21',
        'X-TC-Timestamp': String(timestamp),
        'X-TC-Region': env.TENCENT_REGION || 'ap-guangzhou',
      },
      body: payload,
      signal: controller.signal,
    });
    const result = (await response.json()).Response;
    if (!response.ok || result?.Error || typeof result?.TargetText !== 'string') {
      return json({
        error: 'TRANSLATION_FAILED',
        providerCode: result?.Error?.Code || 'UPSTREAM_ERROR',
        requestId: result?.RequestId,
        message: '腾讯翻译调用失败，请检查账号的服务权限、额度和接口退市状态。',
      }, 502, headers);
    }
    return json({ translatedText: result.TargetText, source: result.Source, target: result.Target, requestId: result.RequestId }, 200, headers);
  } catch {
    return json({ error: controller.signal.aborted ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE' }, 502, headers);
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
    const headers = { Vary: 'Origin' };
    if (origin && origin !== url.origin && !allowed.includes(origin)) {
      return json({ error: 'ORIGIN_NOT_ALLOWED' }, 403, headers);
    }
    if (origin) headers['Access-Control-Allow-Origin'] = origin;
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return json({
        ok: true,
        service: 'Cheems Worker',
        translationConfigured: Boolean(env.ACCESS_TOKEN && env.TENCENT_SECRET_ID && env.TENCENT_SECRET_KEY),
      }, 200, headers);
    }
    if (url.pathname !== '/api/translate') return json({ error: 'NOT_FOUND' }, 404, headers);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: {
        ...headers,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '600',
      } });
    }
    if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405, { ...headers, Allow: 'POST, OPTIONS' });
    return translate(request, env, headers);
  },
};
