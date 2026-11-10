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


async function verifyTurnstile(token, request, env) {
  if (typeof token !== 'string' || token.length < 1 || token.length > 2048) return false;
  const endpoint = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) body.set('remoteip', ip);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return false;
    const check = await response.json();
    if (!check?.success || check.action !== 'cheems_translate') return false;
    const validHosts = new Set([
      new URL(request.url).hostname,
      ...(env.TURNSTILE_HOSTNAMES || '').split(',').map(s => s.trim()).filter(Boolean),
    ]);
    if (!check.hostname || !validHosts.has(check.hostname)) return false;
    const origin = request.headers.get('Origin');
    if (origin && new URL(origin).hostname !== check.hostname) return false;
    return true;
  } catch {
    return false;
  }
}

async function translate(request, env, headers) {
  if (!env.AI) {
    return json({ error: 'AI_NOT_CONFIGURED', message: '请在 wrangler.jsonc 中配置 Workers AI binding 并重新部署。' }, 503, headers);
  }
  // A private bearer token is for the site owner; public visitors use Turnstile.
  const bearer = request.headers.get('Authorization') || '';
  const ownerAllowed = Boolean(env.ACCESS_TOKEN && bearer.startsWith('Bearer ') &&
    (await hash(bearer)) === (await hash(`Bearer ${env.ACCESS_TOKEN}`)));
  if (bearer && !ownerAllowed) return json({ error: 'UNAUTHORIZED' }, 401, headers);
  const publicEnabled = Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET && env.TRANSLATE_RATE_LIMITER);
  if (!ownerAllowed && !publicEnabled) {
    return json({ error: 'PUBLIC_TRANSLATION_DISABLED', message: '公开翻译尚未启用，请使用站长口令或稍后再试。' }, 403, headers);
  }
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
  const { text, source = 'auto', target = 'zh', turnstileToken } = body;
  const maxChars = ownerAllowed ? 5000 : 500;
  if (typeof text !== 'string' || !text.trim() || [...text].length > maxChars) {
    return json({ error: 'INVALID_TEXT', message: `请输入 1–${maxChars} 个字符。` }, 400, headers);
  }
  if (!ownerAllowed) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    try {
      const quota = await env.TRANSLATE_RATE_LIMITER.limit({ key: ip });
      if (!quota.success) return json({ error: 'RATE_LIMITED', message: '请求过于频繁，请稍后重试。' }, 429, headers);
    } catch {
      return json({ error: 'RATE_LIMIT_UNAVAILABLE' }, 503, headers);
    }
    if (!(await verifyTurnstile(turnstileToken, request, env))) {
      return json({ error: 'VERIFY_FAILED', message: '人机验证未通过或已过期，请重试。' }, 403, headers);
    }
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


function testPage() {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Cheems 免费翻译测试</title>
<style>
:root { color-scheme: dark; font-family: system-ui,-apple-system,sans-serif; }
body { max-width:650px; padding:24px 18px; margin:0 auto; background:#101725; color:#f0f5ff; }
h1 {font-size:1.7rem;margin:1rem 0 .5rem}
p {color:#b9c8e0;line-height:1.7}
label {display:block;margin:14px 0 6px;font-weight:650}
input,select,textarea {box-sizing:border-box;width:100%;font:inherit;background:#1c2840;color:#fff;border:1px solid #566984;border-radius:12px;padding:12px}
textarea {min-height:110px;resize:vertical}
.row {display:flex;gap:12px}.row>div {flex:1}
button {background:#6f9fff;color:#091326;border:0;border-radius:12px;font:inherit;font-weight:bold;padding:13px 18px;margin-top:18px;width:100%;cursor:pointer}
button:disabled {opacity:.6}
#result {white-space:pre-wrap;word-break:break-word;border:1px solid #53627e;padding:14px;border-radius:12px;min-height:55px}
.note {font-size:.88rem}
</style>
</head>
<body>
<h1>🐕 Cheems 翻译测试</h1>
<p>使用 Cloudflare 免费 Workers AI。请在<strong>你自己的 Worker 域名</strong>上使用本页面；口令只用于本次请求，不会保存在浏览器存储中。</p>
<form id="form">
<label for="token">私人访问口令 ACCESS_TOKEN</label>
<input type="password" id="token" required autocomplete="off" spellcheck="false" placeholder="输入你在 Cloudflare 设置的口令">
<label for="text">待翻译内容</label>
<textarea id="text" maxlength="5000" required>Good morning! Welcome to Cheems.</textarea>
<div class="row">
<div><label for="source">原语言</label><select id="source"><option value="en">英语</option><option value="zh">简体中文</option><option value="ja">日语</option><option value="ko">韩语</option><option value="fr">法语</option><option value="es">西班牙语</option></select></div>
<div><label for="target">目标语言</label><select id="target"><option value="zh">简体中文</option><option value="en">英语</option><option value="ja">日语</option><option value="ko">韩语</option><option value="fr">法语</option><option value="es">西班牙语</option></select></div>
</div>
<button id="submit" type="submit">开始翻译</button>
</form>
<h2>结果</h2>
<div id="result" role="status" aria-live="polite">尚未测试。</div>
<p class="note">免费额度用完可能会报错。请勿把口令发给任何人或放进公开网站代码。</p>
<script>
const form = document.getElementById('form');
const result = document.getElementById('result');
const button = document.getElementById('submit');
form.addEventListener('submit', async event => {
  event.preventDefault();
  button.disabled = true;
  result.textContent = '翻译中…';
  try {
    const response = await fetch('/api/translate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + document.getElementById('token').value
      },
      body: JSON.stringify({
        text: document.getElementById('text').value,
        source: document.getElementById('source').value,
        target: document.getElementById('target').value
      }),
    });
    const data = await response.json();
    result.textContent = response.ok ? data.translatedText : ('错误 ' + response.status + ': ' + (data.message || data.error || '未知问题'));
  } catch {
    result.textContent = '请求失败，请检查网络后重试。';
  } finally {
    button.disabled = false;
  }
});
</script>
</body>
</html>`;
  return new Response(html, { headers: {
    'Content-Type':'text/html; charset=utf-8',
    'Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff',
    'Referrer-Policy':'no-referrer',
    'Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  }});
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
    if (request.method === 'GET' && url.pathname === '/test') return testPage();
    if (request.method === 'GET' && url.pathname === '/api/config') {
      const publicEnabled = Boolean(env.AI && env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET && env.TRANSLATE_RATE_LIMITER);
      return json({
        ok: true,
        publicEnabled,
        sitekey: publicEnabled ? env.TURNSTILE_SITE_KEY : null,
        publicMaxChars: 500,
        privateEnabled: Boolean(env.AI && env.ACCESS_TOKEN),
        provider: 'cloudflare-workers-ai',
      }, 200, headers);
    }
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health' || url.pathname === '/api/health')) {
      return json({
        ok: true,
        service: 'Cheems Worker',
        provider: 'cloudflare-workers-ai',
        model,
        translationConfigured: Boolean(env.AI && env.ACCESS_TOKEN),
        publicEnabled: Boolean(env.AI && env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET && env.TRANSLATE_RATE_LIMITER),
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
