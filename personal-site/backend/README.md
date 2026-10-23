# 今日食签 v0.5 后端

一个 Cloudflare Worker，同时干三件事：**问食神（智谱 GLM / 可选 DeepSeek）**、**附近可下单（美团 / 淘宝闪购）**、**自检**。
所有密钥留在服务端，浏览器只打自己的 `/api/*`。

```
浏览器 app/index.html
  │  /api/v1/chat            ──► [DeepSeek Search 联网] ──► glm-4.7-flash / deepseek-flash（出签）
  │  /api/v1/platform/nearby ──► 美团到店团购  ┐
  │                          └─► 淘宝闪购      ┘  并发、各自降级
  │  /api/v1/health          ──► 平台配置状态 + 今日预算余量
  ▼
Cloudflare Worker（Key 全在这里，KV 记账 / 限流）
```

---

## 一、为什么是这套模型和接口

对话模型做成了一层薄抽象（`src/ai.js`），换家只改 `wrangler.toml` 的 `[vars]`，**代码不用动**：

| 项目 | 选择 | 理由 |
|---|---|---|
| 默认出签模型 | `glm-4.7-flash`（智谱） | 输入输出**全免费、不限量**，中文稳，国内直连快。免费层的代价是并发限制（约 1 路），失败就降级本地食神 |
| 备选出签模型 | `deepseek-flash` | 按 token 计费，质量略高；旧的 `deepseek-chat` / `deepseek-reasoner` 已公告废弃，别再写死 |
| 联网 | `POST https://api.deepseek.com/v1/tools/search` | 只有 DeepSeek 有自研搜索 API，5 元 / 千次成功请求；智谱免费模型不开放检索，所以 `AI_PROVIDER=zhipu` 时**自动关闭**联网，不产生无意义调用 |
| 记账单价 | DeepSeek 输入 2 元、输出 8 元（每百万 token） | 取**高峰价**，空闲时段官方半价，所以只会高估不会超支；智谱 `*-flash` 记 0 元 |
| 平台 | 美团到店团购 + 淘宝闪购开放平台 | 都是官方通道；商家 OpenAPI 需要企业资质且面向"管店"，不适合本场景 |

切换方式（改完重新 `wrangler deploy` 即可）：

```toml
[vars]
AI_PROVIDER = "zhipu"        # zhipu | deepseek
MODEL = "glm-4.7-flash"      # 若与 AI_PROVIDER 不匹配，会自动纠正到该家的默认模型，不会 400
```

> 联网搜索可开关：`DAILY_MAX_SEARCH = 0` 即完全关闭，出签仍能工作，只是少了实时门店信息。

---

## 二、部署（约 10 分钟）

```bash
cd personal-site/backend
npm i -g wrangler            # 或 npx wrangler
wrangler login

# 1) 建 KV（记账 + 限流）。已有则跳过，把 id 填进 wrangler.toml 的 USAGE
wrangler kv namespace create USAGE

# 2) 填密钥（交互输入，不落盘、不进 Git）
wrangler secret put ZHIPU_API_KEY           # 必填（AI_PROVIDER=zhipu），否则 /v1/chat 返回 503 由前端降级
wrangler secret put DEEPSEEK_API_KEY        # 选填，改用 DeepSeek 或想开联网搜索时才需要
wrangler secret put MEITUAN_TOKEN           # 选填，美团团购搜索
wrangler secret put SHANGOU_APP_KEY         # 选填，淘宝闪购
wrangler secret put SHANGOU_APP_SECRET
wrangler secret put SHANGOU_TOKEN
wrangler secret put SHANGOU_SHOP_ID
wrangler secret put MEITUAN_TRAVEL_TOKEN    # 选填，酒旅

# 3) 部署
wrangler deploy
```

拿到 `https://shiqian-agent.<子域>.workers.dev` 后，填到
`personal-site/app/index.html`：

```js
const API_BASE = 'https://shiqian-agent.<子域>.workers.dev';
```

打开 `API_BASE + /api/v1/health` 应该看到：

```json
{ "ok": true, "aiProvider": "zhipu", "model": "glm-4.7-flash",
  "platforms": { "meituan": "configured", "shangou": "missing_shangou_keys",
                 "ai": "configured", "deepseek": "missing_deepseek_key" },
  "searchEnabled": false,
  "budget": { "usedYuan": 0, "leftYuan": 1, "callsLeft": 300 } }
```

**`configured` / `missing_xxx` 就是这套代码的工作方式**：没配就说没配，前端显示「待配置」，绝不编造商品。

---

## 三、平台凭证怎么拿

### 1. 美团到店团购（`MEITUAN_TOKEN`）

代码调用美团面向 AI Agent 的团购搜索通道：

```
POST https://click.meituan.com/cps/ai/product/searchProductByAgent
body:   { keyword, page, pageSize, clientSource, userParamDTO: { lat, lng, token, cityId, app, platform, partner } }
header: token: <用户授权 token>
```

- token 是**用户维度**授权凭证（美团 App 扫码授权后下发，约 30 天有效），不是开发者 Key
- 拿不到 token 时，`/v1/platform/nearby` 返回 `sources.meituan = "error"`，
  前端只标红美团那一块，闪购和签筒照常工作
- 该接口字段名没有公开文档，`src/providers/meituan.js` 做了多别名兜底。
  **接上真实 token 后，把一次真实响应脱敏存成 `test/fixtures/meituan-search.json` 再跑测试**，
  确认字段映射没跑偏

### 2. 美团酒旅（`MEITUAN_TRAVEL_TOKEN`，选填）

```
POST https://mcp-open-cater.meituan.com/v1/api/voyage/openapi/query
header: Authorization: <token>
```

Token 在 [developer.meituan.com](https://developer.meituan.com) 个人开发者后台创建（实名即可，免费接入）。

### 3. 淘宝闪购（`SHANGOU_*`）

品牌 2025-12 升级，原"饿了么零售开放平台"现为[淘宝闪购零售开放平台](https://open-retail.ele.me/)：

```
POST https://open-retail.ele.me/api/v1/
body: { token, nop, metas:{ app_key, timestamp }, params, action, id, signature }
signature = UPPER( md5( action + token + sortedKeyValuePairs.join('') + app_secret ) )
```

签名算法见 `src/providers/shangou.js`，单测与 `node:crypto` 逐字节比对通过。

> **能力边界（务必知道）**：开放平台接口是**商家维度**的 —— 能查你绑定门店的商品与订单，
> 但"附近有哪些闪购商品"需要平台侧选品/营销接口权限，个人应用通常拿不到。
> 因此缺少 `SHANGOU_SHOP_ID` 时明确返回 `not_configured`，而不是伪造"附近闪购"结果。

---

## 四、接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/health` | 平台配置状态、今日预算/次数余量 |
| POST | `/api/v1/chat` | `{ messages, context: { city, lat, lng, currentFood, nearby[], foods[] } }` |
| POST/GET | `/api/v1/platform/nearby` | `{ city, cityId, lat, lng, keyword, sources[], limit }` |
| POST | `/api/v1/travel` | `{ city, query }`，需 `MEITUAN_TRAVEL_TOKEN` |

`/v1/chat` 返回：

```json
{
  "reply": "【牛肉面】汤浓面弹，加班后正好。\n热汤下肚，万事可说。",
  "foodName": "牛肉面",
  "recommend": { "foodName": "牛肉面", "reason": "...", "blessing": "...", "fortune": "中吉", "emoji": "🍜" },
  "sources": [{ "title": "...", "url": "...", "site": "大众点评" }],
  "searchUsed": true,
  "provider": "zhipu",
  "model": "glm-4.7-flash",
  "usage": { "usedYuan": 0.004, "leftYuan": 0.996, "callsLeft": 299 }
}
```

---

## 五、省钱与防刷（默认值）

| 配置 | 默认 | 作用 |
|---|---|---|
| `DAILY_BUDGET_YUAN` | 1 | 每日总预算（元），按高峰价折算，超出 429 |
| `DAILY_MAX_CALLS` | 300 | 每日问答次数上限 |
| `DAILY_MAX_SEARCH` | 150 | 每日联网次数，设 `0` 关闭联网 |
| 单 IP 限流 | 12 次/分钟 | 防止单人吃光当日预算 |
| `MAX_OUTPUT_TOKENS` | 320 | 签文短，省输出费（输出比输入贵 4 倍） |
| `ALLOWED_ORIGINS` | 站点域名 | CORS 白名单，别人无法白嫖额度 |

成本参考：一问 ≈ 1.5k 输入 + 250 输出 ≈ 0.005 元，另加一次搜索 0.005 元。
**1 元约撑 100~150 次问答**，够个人站点一天用。

---

## 六、本地开发

```bash
cd personal-site/backend
npm test                     # 单测，无需网络
npx wrangler dev             # 本地起 Worker（密钥放 .dev.vars）
```

`.dev.vars`（**不要提交**，已在 .gitignore）：

```
DEEPSEEK_API_KEY=sk-xxx
MEITUAN_TOKEN=xxx
```

前端联调：`cd ../app && python3 -m http.server 8000`，把 `API_BASE` 指向 `http://127.0.0.1:8787`，
并把 `http://localhost:8000` 加进 `ALLOWED_ORIGINS`。

只想看 UI、完全不联网：把 `index.html` 里的 `USE_MOCK` 改成 `true`。

---

## 七、排错表

| 现象 | 原因 | 处理 |
|---|---|---|
| 面板「美团 · 不可用」 | token 过期（约 30 天） | 重新授权后 `wrangler secret put MEITUAN_TOKEN` |
| 面板「闪购 · 待配置」 | 缺 `SHANGOU_APP_KEY/SECRET` 或 `SHANGOU_SHOP_ID` | 补齐 secret；属权限边界，不是 bug |
| 问食神一直走本地降级 | `API_BASE` 没填 / CORS 不含站点域名 / 缺 `DEEPSEEK_API_KEY` | 看 `/api/v1/health` 的 `platforms.deepseek` |
| 429「今日额度用完」 | 预算或次数到顶 | 改 `[vars]` 后重新 deploy |
| 签卡上没有「去下单」 | 附近没搜到，或该商品无落地页 URL | 正常降级：不给假链接 |
| `wrangler deploy` 报 KV 错误 | `USAGE` 的 id 是占位 | `wrangler kv namespace create USAGE` 后替换 |

---

## 八、合规与隐私

- 坐标只用于查附近，**不存服务端**；后端不记录用户问题原文
- 价格与库存以平台实时页面为准，下单与支付都在平台 App 内完成，本站不代收款
- 商品图片直接引用平台 CDN（`referrerpolicy="no-referrer"`），不中转缓存
- 页面固定展示「价格以平台为准 / 不代收款」，避免误导
