# Cheems Worker

Cheems 的 Cloudflare 翻译后端。部署目标为现有 Worker `silent-flower-7f86`。

## 手机连接部署

1. Cloudflare → Workers & Pages → `silent-flower-7f86` → Settings → Builds → Connect。
2. 选择 GitHub 仓库 `Cheems-gta/Cheems-Worker2`，生产分支选 `main`，根目录为仓库根目录。
3. Build command 填 `npm run check`，Deploy command 填 `npx wrangler@4 deploy`。
4. 保存后启动构建。成功后打开 Worker 地址或 `/health`，应看到 `ok: true`。

## 翻译配置

在 Worker 的 Settings → Variables and Secrets 添加下表配置，然后部署。

| 名称 | 类型 | 内容 |
| --- | --- | --- |
| TENCENT_SECRET_ID | Secret | 腾讯云 SecretId |
| TENCENT_SECRET_KEY | Secret | 腾讯云 SecretKey |
| ACCESS_TOKEN | Secret | 自行生成的至少 32 字符随机访问口令 |
| TENCENT_REGION | Text，可选 | 默认 `ap-guangzhou` |
| ALLOWED_ORIGINS | Text，可选 | 允许调用的网站源，用逗号分隔，例如 `https://example.com`，不带路径或末尾斜杠 |

三项 Secret 都存在时，`/health` 的 `translationConfigured` 为 true。这只表示配置存在，真正的腾讯权限需要请求翻译来验证。

目前按私人接口启用访问口令，前端请求须提供 `Authorization: Bearer <ACCESS_TOKEN>`。口令由使用者输入或由可信服务器提供。公开网站需要先接入访客鉴权和用量控制，再开放给所有访客。CORS 来源校验本身无法阻止其他客户端调用。

密钥与访问口令只保存在 Secrets。公开仓库和公开网页中请勿填写实际值。

## 接口

`GET /health` 返回服务和配置状态。

`POST /api/translate` 使用 JSON 请求体和 Authorization 请求头。

```json
{"text":"Hello","source":"en","target":"zh"}
```

成功响应包含 `translatedText`、`source`、`target` 和 `requestId`。输入限制为 5000 个 Unicode 字符，超时为 15 秒。腾讯自身的语种组合和配额限制仍然适用。参数格式与旧版 MyMemory 接口不同。

## 当前接入状态

本仓库提供后端代码。已检查的 Cheems_V11.5.html 仍使用 MyMemory，尚未修改或发布该网页。网站正式地址和当前使用的 HTML 确认后，再将翻译请求接到这个 Worker。公网域名由 Cloudflare 分配，可在控制台查看。

腾讯官方已公告旧版文本翻译接口退市，且不再支持新用户。本实现保留原计划的 TMT SecretId/SecretKey 接入方式，供已有权限账号验证。若返回服务不可用，需要先确认账号资格，再迁移到新接口。

- [Cloudflare Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)
- [Cloudflare Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [腾讯机器翻译当前接入公告](https://cloud.tencent.com/document/product/551/104415)

## 本地检查

需要 Node.js 22 或更新版本。运行 `npm run check` 检查语法，运行 `npm run dev` 使用 Wrangler 本地调试。真实密钥可放在被 git 忽略的 `.dev.vars` 中。
