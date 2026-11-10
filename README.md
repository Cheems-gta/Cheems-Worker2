# Cheems V11.6 · Cloudflare 免费 AI 翻译

**现有 Worker：** `silent-flower-7f86`（保留原来的部署和私人 ACCESS_TOKEN）。

## 已完成

- 将 **Cheems V11.6** 静态网站上传到仓库 `public/cheems.html`，由 Workers 静态资源托管。
- 网址：`https://silent-flower-7f86.roggranny.workers.dev/cheems.html`（需确认最新 GitHub 构建已完成）。
- 用 Cloudflare Workers AI 的 `@cf/meta/m2m100-1.2b` 模型翻译，不再调用旧版 MyMemory / 腾讯云。
- 站长可在网站翻译弹窗的「站长模式」**临时输入**私人 ACCESS_TOKEN；网站不会保存它。
- 访客翻译要先通过 **Cloudflare Turnstile**，后端调用 Siteverify 校验每一个一次性 token，然后按 IP 使用 Workers Rate Limiting binding 限制 6 次/分钟（是近似、按机房生效的限制，并非全局严格配额）。
- 访客每次最多 500 字符，站长最多 5000 字符；每日免费 AI 计算额度有限。
- 保留离线中英词句翻译和其他网页工具、液态玻璃设计。

## 第一步：确认部署

Workers & Pages → `silent-flower-7f86` → 部署。最新仓库提交构建成功后：

- `/health` 或 `/api/health`：检查 `ok: true`。
- `/api/config`：检查 `publicEnabled`；未配置 Turnstile 之前应当为 `false`。
- `/cheems.html`：打开 V11.6 网站，点击「AI 翻译」。

仅打开页面和私人站长模式不需要 Turnstile。**不要把 ACCESS_TOKEN 写入网页或分享给访客。**

## 第二步：免费启用所有访客翻译（需要站长在 Cloudflare 控制台操作）

1. Cloudflare 控制台 → **Turnstile** → **Add widget**。
2. 名称可填 `Cheems AI Translation`，类型选 **Managed**，允许的 hostname 填 `silent-flower-7f86.roggranny.workers.dev`（不带 https:// 和路径）。创建后获得 **Site Key** 和 **Secret Key**。
3. Workers & Pages → `silent-flower-7f86` → **Settings → Variables and Secrets**（运行时，非 Builds 构建变量），在生产环境添加：
   - `TURNSTILE_SITE_KEY`：**Text**，填写 Site Key（公开标识，允许出现在前端）。
   - `TURNSTILE_SECRET`：**Secret**，填写 Secret Key（必须保密）。
4. 按页面提示部署设置，再检查 `/api/config` 是否变为 `publicEnabled: true`。
5. 访问 `/cheems.html` → 工具箱 → AI 翻译 → 完成安全验证 → 开始翻译。普通访客不需要站长访问口令。

站长原有 `ACCESS_TOKEN` 不需要删除，旧腾讯云密钥若存在则已不使用。

## 如需将 HTML 放在另外的域名

可直接下载 `public/cheems.html` 上传到自己的域名，但必须在 Worker 运行时设置：
- `ALLOWED_ORIGINS`：**Text**，完整网站源，如 `https://example.com`（不能用星号）。
- `TURNSTILE_HOSTNAMES`：**Text**，网站 hostname，如 `example.com`。
- 在 Turnstile Widget 的允许 hostname 中也添加 `example.com`。

页面按预设 Worker 地址调用跨源 API。使用 `file://` 本地打开时浏览器可能禁止跨域请求。优先使用同域的 `/cheems.html`。

## 接口

- `GET /health`、`GET /api/health`：服务状态。
- `GET /api/config`：publicEnabled 和公开的 sitekey；不返回 Secret。
- `POST /api/translate`：JSON `{"text":"Hello","source":"en","target":"zh","turnstileToken":"<per-request token>"}`。
  - 普通访客必须带 Turnstile token。
  - 站长可改用 `Authorization: Bearer <ACCESS_TOKEN>`，无需 Turnstile。
  - 返回 `translatedText` / 语言 / `provider`。
- `GET /test`：独立的私人翻译测试页。

## 免费额度与安全边界

Workers Free 约 100,000 次请求/天；Workers AI Free 10,000 Neurons/天。达到免费额度时调用会失败，**不会自动切换到付费服务**。这不是无限免费翻译。Rate Limiting 只作基础防滥用，属于近似、按机房生效的限流；Turnstile 也无法保证完全阻止人工滥用。不要依赖 CORS 作为鉴权。

- Cloudflare [Workers AI 免费价格](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- Cloudflare [Turnstile 免费套餐](https://developers.cloudflare.com/turnstile/plans/)
- Cloudflare [Turnstile 服务端验证](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
- Cloudflare [Workers 速率限制绑定](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- Cloudflare [Workers 静态资源配置](https://developers.cloudflare.com/workers/static-assets/binding/)

## 本地检查

运行 `npm run check` 检查 Worker 语法；`npm run dev` 进入本地开发。
