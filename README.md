# Cheems Worker — 免费翻译后端

使用 **Cloudflare Workers AI** 的 Meta M2M100 多语言翻译模型，不再依赖腾讯云翻译或腾讯云密钥。项目部署目标是现有 Worker `silent-flower-7f86`。

## 免费额度（以 Cloudflare 当前政策为准）

- Workers AI：**每天 10,000 Neurons 免费额度**，不是无限次翻译。免费方案超出后请求会失败，不会自动按量扣费。
- Workers Free：通常每天可处理 100,000 次 Worker 请求；AI Neurons 限额通常更先达到。
- 无需为本后端购买腾讯云翻译服务，也无需配置 `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY`。
- 需要 Cloudflare Workers AI 服务在账号上可用。

官方资料：[Workers AI 价格](https://developers.cloudflare.com/workers-ai/platform/pricing/)、[M2M100 模型](https://developers.cloudflare.com/workers-ai/models/m2m100-1.2b/)。

## 从 GitHub 部署到已有 Worker

1. Cloudflare → **Workers & Pages** → `silent-flower-7f86` → **Settings** → **Builds** → **Connect**。
2. 连接 GitHub 仓库 `Cheems-gta/Cheems-Worker2`，生产分支 `main`，仓库根目录为项目根目录。
3. Build command：`npm run check`；Deploy command：`npx wrangler@4 deploy`。
4. 保存并部署。仓库中的 `wrangler.jsonc` 已配置 `"ai": {"binding":"AI"}`，部署后可由代码直接通过 `env.AI` 调用模型。

如果已经连接过 GitHub，可在 Cloudflare **Deployments** 检查最近提交是否已自动部署；仓库更新 **不等于** 线上部署成功。

## 安全访问

当前后端默认仅供私人使用。为避免其他人耗尽每日免费额度，需要在 Cloudflare Worker **Settings → Variables and Secrets** 添加：

| 名称 | 类型 | 作用 |
| --- | --- | --- |
| `ACCESS_TOKEN` | **Secret** | 自己生成的至少 32 位随机访问口令 |
| `ALLOWED_ORIGINS` | Text，可选 | 允许的网页来源（域名和协议），逗号分隔 |

**不要**把 `ACCESS_TOKEN` 写入公开仓库、公开 HTML 或发送到聊天中。如果 Cheems 网站未来对所有人开放翻译，需要先接入更适合公开访问的防滥用方案（例如 Turnstile + 服务端验证及限流），再移除私人访问口令。CORS 不能单独作为鉴权。

旧的腾讯云 Secrets 如不再使用，可到 Cloudflare 控制台删除，避免混淆。

## 接口

- `GET /`、`GET /health` 或 `GET /api/health` 返回 Worker 状态，以及 `translationConfigured`（仅表示 AI Binding 和 ACCESS_TOKEN 已配置）。
- `POST /api/translate`：`Content-Type: application/json`，并发送 `Authorization: Bearer <ACCESS_TOKEN>`。
- 示例请求体：

```json
{"text":"Hello","source":"en","target":"zh"}
```

- 成功时返回 `translatedText`、`source`、`target`、`requestId` 和 `provider`。
- 文本最多 5,000 个 Unicode 字符。可使用 `en`、`zh`、`ja`、`ko` 等语言代码；`zh-TW` 暂不支持。
- `source:"auto"` 只针对常见英文（ASCII）、中文、日文、韩文做简单检测，其他情况可能识别错误或要求明确填写语言。为了准确翻译，推荐显式传入源语言。
- 模型是否支持特定语言组合、翻译质量、并发和免费资源的可用性需以 Cloudflare 实际运行结果为准。

## 前端接入状态

这次只修改了 GitHub 中的 **后端源码和配置**。目前没有改动或发布原来的 Cheems HTML 网页。公开网页不能直接内嵌私人口令，需完成安全接入设计后再切换翻译入口。

## 本地检查

需要 Node.js 环境。运行 `npm run check` 检查 JavaScript 语法；可用 `npm run dev` 调试（Workers AI 请求仍通过 Cloudflare 账号的资源配额处理）。
