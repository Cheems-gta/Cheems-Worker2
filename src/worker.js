const maxBodyBytes = 40000;
const model = '@cf/meta/m2m100-1.2b';

function json(data, status = 200, headers = {}) {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', ...headers },
  });
}

async function hash(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

// Workers AI requires an explicit source language. This is a convenience
// fallback for the most common cases, not general-purpose language detection.
function detectSource(text) {
  if (/[\u3040-\u30ff]/u.test(text)) return 'ja';
  if (/[\uac00-\ud7af]/u.test(text)) return 'ko';
  if (/[\u3400-\u9fff]/u.test(text)) return 'zh';
  if (/^[\x00-\x7f]*$/u.test(text)) return 'en';
  return null;
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
  if (!env.AI) {
    return json({ error: 'AI_NOT_CONFIGURED', message: '请在 wrangler.jsonc 中配置 Workers AI binding 并重新部署。' }, 503, headers);
  }
  // Remain private by default to protect the shared daily free quota.
  if (!env.ACCESS_TOKEN) {
    return json({ error: 'ACCESS_TOKEN_NOT_CONFIGURED', message: '请在 Worker Secrets 中设置随机 ACCESS_TOKEN。' }, 503, headers);
  }
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

  const languages = new Set(['zh', 'en', 'ja', 'ko', 'fr', 'es', 'it', 'de', 'tr', 'ru', 'pt', 'vi', 'id', 'th', 'ms', 'ar', 'hi']);
  const actualSource = source === 'auto' ? detectSource(text) : source;
  if (!actualSource) {
    return json({ error: 'SOURCE_REQUIRED', message: '无法可靠识别源语言，请明确指定 source（例如 en、zh、ja）。' }, 400, headers);
  }
  if (!languages.has(actualSource) || !languages.has(target)) {
    return json({ error: 'INVALID_LANGUAGE', message: '不支持该语言代码，简体中文请使用 zh。' }, 400, headers);
  }
  try {
    const result = await env.AI.run(model, {
      text, source_lang: actualSource, target_lang: target,
    });
    if (!result || typeof result.translated_text !== 'string') {
      return json({ error: 'INVALID_AI_RESPONSE' }, 502, headers);
    }
    return json({
      translatedText: result.translated_text,
      source: actualSource,
      target,
      requestId: result.request_id || null,
      provider: 'cloudflare-workers-ai',
    }, 200, headers);
  } catch (error) {
    // No paid fallback: on the Free plan, quota exhaustion causes requests to fail.
    return json({
      error: 'AI_TRANSLATION_FAILED',
      message: 'Workers AI 暂时不可用，可能达到免费额度或服务限制。',
    }, 503, headers);
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
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health' || url.pathname === '/api/health')) {
      return json({
        ok: true,
        service: 'Cheems Worker',
        provider: 'cloudflare-workers-ai',
        model,
        translationConfigured: Boolean(env.AI && env.ACCESS_TOKEN),
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
