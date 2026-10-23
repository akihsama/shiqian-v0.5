/**
 * 今日食签 v0.5 · 统一后端（Cloudflare Workers / ES Module 格式）
 * =============================================================================
 * 一个 Worker 同时负责三件事：
 *
 *   1. /api/v1/chat          问食神：DeepSeek Search 联网 → 当前对话模型出签
 *   2. /api/v1/platform/*    聚合美团 / 淘宝闪购的附近团购商品（Key 全在服务端）
 *   3. /api/v1/health        自检：哪些平台配好了、今日还剩多少额度
 *
 * 设计约束（都是踩过坑才这么写的）：
 *   - **任何外部依赖挂掉都不能让页面白屏**：chat 失败前端降级本地食神，
 *     平台失败只影响那一个平台的区块，各自独立 allSettled。
 *   - **Key 永不进仓库**：全部走 wrangler secret。
 *   - **花钱的事必须可观测**：每次调用都按 token / 调用次数记账，
 *     超预算直接 429，并在 health 里可见。
 *   - **CORS 白名单**：只允许站点域名，避免被别人拿去白嫖额度。
 */

import {
  aiChat, aiSearch, aiConfigured, aiProviderName, aiModelName, aiMissingHint, aiSearchSupported,
  DeepSeekError, ZhipuError,
} from './src/ai.js';
import { meituanNearby, meituanTravel, meituanConfigured } from './src/providers/meituan.js';
import { shangouNearby, shangouConfigured } from './src/providers/shangou.js';
import { buildSystemPrompt, buildUserPrompt, parseRecommendation, fallbackRecommendation } from './src/prompt.js';

/* ============================== 配置 ============================== */

const DEFAULT_CONFIG = {
  // —— AI 提供商：zhipu（智谱 GLM，免费）| deepseek（按 token 计费）——
  AI_PROVIDER: 'zhipu',
  MODEL: 'glm-4.7-flash',             // 智谱默认；切 deepseek 时下面的 aiModelName 会自动改写
  // —— 预算（元）。价格按官方牌价取高峰价，宁可提前截断也不超支 ——
  INPUT_RATE_YUAN_PER_M: 2,           // 输入 2 元/百万 token（DeepSeek 缓存未命中·高峰）
  OUTPUT_RATE_YUAN_PER_M: 8,          // 输出 8 元/百万 token（高峰）
  SEARCH_RATE_YUAN_PER_CALL: 0.005,   // Search 5 元/千次
  DAILY_BUDGET_YUAN: 1.0,             // 每日总预算
  DAILY_MAX_CALLS: 300,               // 每日最多问答次数
  DAILY_MAX_SEARCH: 150,              // 每日最多联网搜索次数（0 = 关闭联网）
  // —— 交互 ——
  MAX_INPUT_CHARS: 300,
  MAX_HISTORY: 6,
  MAX_OUTPUT_TOKENS: 320,
  ALLOWED_ORIGINS: '*',
  TIMEOUT_MS: 25000,
};

/* ============================== 工具 ============================== */

const MICRO = 1e6; // 微元，避免浮点误差

function cfg(env) {
  const out = Object.assign({}, DEFAULT_CONFIG);
  for (const k of Object.keys(DEFAULT_CONFIG)) {
    if (env && env[k] !== undefined && env[k] !== '') {
      out[k] = typeof DEFAULT_CONFIG[k] === 'number' ? Number(env[k]) : env[k];
    }
  }
  if (typeof out.ALLOWED_ORIGINS === 'string' && out.ALLOWED_ORIGINS !== '*') {
    out.ALLOWED_ORIGINS = out.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
  }
  return out;
}

function corsHeaders(request, config) {
  const origin = request.headers.get('Origin') || '';
  let allow = '';
  if (config.ALLOWED_ORIGINS === '*') allow = '*';
  else if (matchOrigin(origin, config.ALLOWED_ORIGINS)) allow = origin;

  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
  if (allow) h['Access-Control-Allow-Origin'] = allow;
  return h;
}

/**
 * 白名单匹配，支持一条前缀通配 `https://*.pages.dev`。
 * 用来一次放行 Cloudflare Pages 的「项目名.pages.dev」以及每个部署的
 * 「哈希.项目名.pages.dev」，省得地址一变就得重新部署 Worker。
 * 只允许出现在最左一段，且必须跟一个点，避免写成 https://* 把全网放行。
 */
function matchOrigin(origin, list) {
  if (!origin) return false;
  if (!Array.isArray(list)) return false;
  return list.some((rule) => {
    if (rule === origin) return true;
    const star = rule.indexOf('*');
    if (star < 0) return false;
    if (!rule.startsWith('https://*.') || star !== 8) return false; // 只认 https://*.xxx 形式
    const suffix = rule.slice(star + 1); // ".pages.dev"
    if (!origin.startsWith('https://')) return false;
    const host = origin.slice(8);
    if (!host.endsWith(suffix)) return false;
    const label = host.slice(0, host.length - suffix.length);
    // 前缀必须是合法的单段主机名（允许 a.b 这种多段，但不得含协议/斜杠）
    return label.length > 0 && !/[/\s]/.test(label);
  });
}

function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extra || {}),
  });
}

function originAllowed(request, config) {
  if (config.ALLOWED_ORIGINS === '*') return true;
  const origin = request.headers.get('Origin') || '';
  // 无 Origin（curl / 服务端调用）放行；带 Origin 必须命中白名单
  return !origin || matchOrigin(origin, config.ALLOWED_ORIGINS);
}

/* ============================== 记账 ============================== */

/**
 * KV 是最终一致存储，并发下会少记。这里用「读-加-写」+ 1/20 概率补写，
 * 对个人站点足够；真要严格可换 Durable Object。
 */
function dayKey() {
  // 按北京时间分桶，跟用户作息一致（避免 UTC 0 点额度突然重置）
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  return now.toISOString().slice(0, 10);
}

async function readUsage(env, day) {
  const raw = env.USAGE ? await env.USAGE.get('u:' + day) : null;
  if (!raw) return { spentMicro: 0, calls: 0, searches: 0 };
  try { return Object.assign({ spentMicro: 0, calls: 0, searches: 0 }, JSON.parse(raw)); }
  catch { return { spentMicro: 0, calls: 0, searches: 0 }; }
}

async function writeUsage(env, day, usage) {
  if (!env.USAGE) return;
  await env.USAGE.put('u:' + day, JSON.stringify(usage), { expirationTtl: 60 * 60 * 24 * 7 });
}

function budgetLeft(usage, config) {
  const yuan = usage.spentMicro / MICRO;
  return {
    usedYuan: Number(yuan.toFixed(4)),
    budgetYuan: config.DAILY_BUDGET_YUAN,
    leftYuan: Number(Math.max(0, config.DAILY_BUDGET_YUAN - yuan).toFixed(4)),
    callsLeft: Math.max(0, config.DAILY_MAX_CALLS - usage.calls),
    searchesLeft: Math.max(0, config.DAILY_MAX_SEARCH - usage.searches),
  };
}

/* ============================== 简易限流 ============================== */

/**
 * 前端限流：同一 IP 每分钟最多 12 次问答。防止单个用户把每日预算吃光。
 * KV 的读放大对个人站点可接受；站点流量大时应换成 Durable Object。
 */
async function rateLimited(env, request, bucket, limit, windowSec) {
  if (!env.USAGE) return false;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const slot = Math.floor(Date.now() / (windowSec * 1000));
  const key = `rl:${bucket}:${ip}:${slot}`;
  const n = Number((await env.USAGE.get(key)) || 0);
  if (n >= limit) return true;
  await env.USAGE.put(key, String(n + 1), { expirationTtl: windowSec * 2 });
  return false;
}

/* ============================== AI：问食神 ============================== */

async function handleChat(request, env, config, cors) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: '请求体不是合法 JSON' }, 400, cors); }

  const messages = Array.isArray(body && body.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find(m => m && m.role === 'user');
  const question = String((lastUser && lastUser.content) || '').trim().slice(0, config.MAX_INPUT_CHARS);
  if (!question) return json({ error: '说点什么吧，食神还没听到你的诉求' }, 400, cors);

  if (await rateLimited(env, request, 'chat', 12, 60)) {
    return json({ error: '问得太急了，歇一分钟再来', code: 'RATE_LIMITED' }, 429, cors);
  }

  const day = dayKey();
  const usage = await readUsage(env, day);
  if (usage.calls >= config.DAILY_MAX_CALLS || usage.spentMicro >= config.DAILY_BUDGET_YUAN * MICRO) {
    return json({ error: '今日食神额度用完了，明天再来摇签吧 🍜', code: 'BUDGET_EXHAUSTED' }, 429, cors);
  }

  const ctx = (body && body.context) || {};
  const provider = aiProviderName(env);

  if (!aiConfigured(env)) {
    // 没配 Key：返回明确信号，前端自动降级本地食神（而不是报错弹窗）
    return json({
      error: '后端未配置 ' + (provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'ZHIPU_API_KEY'),
      code: 'NOT_CONFIGURED',
      provider,
      degraded: true,
    }, 503, cors);
  }

  /* ---------- 第 1 步：联网搜索（只有 DeepSeek 支持）---------- */
  let searchUsed = false;
  let sources = [];
  let webDigest = '';
  const searchApiKey = env.DEEPSEEK_API_KEY;

  const searchBudgetOk = aiSearchSupported(env)
    && !!searchApiKey
    && config.DAILY_MAX_SEARCH > 0
    && usage.searches < config.DAILY_MAX_SEARCH;
  if (searchBudgetOk) {
    try {
      const sr = await aiSearch({
        env,
        query: buildSearchQuery(question, ctx),
        count: 5,
        oriQuestion: question,
        timeoutMs: Math.min(12000, config.TIMEOUT_MS),
      });
      searchUsed = true;
      usage.searches += 1;
      usage.spentMicro += Math.round(config.SEARCH_RATE_YUAN_PER_CALL * MICRO);
      sources = (sr.results || []).slice(0, 5).map(r => ({
        title: r.title, url: r.url, site: r.site_name, summary: r.summary,
      }));
      webDigest = (sr.results || []).slice(0, 4).map((r, i) =>
        `[${i + 1}] ${r.title}（${r.site_name || '网络'}）：${(r.summary || r.snippet || '').slice(0, 240)}`
      ).join('\n');
    } catch (e) {
      // 搜索失败绝不影响出签，只记录原因
      console.warn('search failed', e && e.message);
      webDigest = '';
      searchUsed = false;
    }
  }

  /* ---------- 第 2 步：出签 ---------- */
  const nearby = Array.isArray(ctx.nearby) ? ctx.nearby.slice(0, 20) : [];
  const system = buildSystemPrompt(ctx, nearby, webDigest);
  const user = buildUserPrompt(question);

  let reply = '';
  let model = aiModelName(env, config);
  let recommend = null;

  try {
    const res = await aiChat({
      env,
      config,
      messages: [
        { role: 'system', content: system },
        ...messages.slice(-config.MAX_HISTORY)
          .filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.content)
          .map(m => ({ role: m.role, content: String(m.content).slice(0, config.MAX_INPUT_CHARS) })),
      ],
      maxTokens: config.MAX_OUTPUT_TOKENS,
      temperature: 0.85,
      json: false,
      timeoutMs: config.TIMEOUT_MS,
    });
    reply = res.content;
    model = res.model || model;
    usage.spentMicro += res.costMicro;
    recommend = parseRecommendation(reply);
  } catch (e) {
    const status = (e instanceof DeepSeekError || e instanceof ZhipuError) ? e.status : 502;
    await writeUsage(env, day, usage);
    // 免费档并发约 1 路，高峰期上游会回 429（智谱 code 1305）。这不是本站故障，
    // 给前端一个明确的「稍后再试」信号，让它降级本地食神而不是弹错误框。
    const busy = status === 429 || /访问量过大|rate limit|too many/i.test(e.message || '');
    return json({
      error: busy
        ? '食神这会儿忙不过来（免费通道排队中），先给你本地签，稍后再问一次'
        : '食神暂时连不上：' + (e.message || '未知错误'),
      code: busy ? 'UPSTREAM_BUSY' : 'UPSTREAM_ERROR',
      provider,
      status,
      degraded: true,
      retryAfter: busy ? 8 : undefined,
    }, 502, cors);
  }

  usage.calls += 1;
  await writeUsage(env, day, usage);

  if (!recommend) recommend = fallbackRecommendation(reply, nearby);

  return json({
    reply: reply,
    foodName: recommend && recommend.foodName,
    recommend: recommend,
    sources: sources,
    searchUsed: searchUsed,
    provider: provider,
    model: model,
    usage: Object.assign({}, budgetLeft(usage, config), { costThisCallYuan: Number((usage.spentMicro / MICRO).toFixed(5)) }),
  }, 200, cors);
}

/**
 * 组装搜索词：把"我想吃辣的便宜的"这类口语，变成搜索引擎能用的查询。
 * 关键是带上城市和"团购/大众点评"这种限定词，否则搜出一堆菜谱。
 */
function buildSearchQuery(question, ctx) {
  const city = (ctx && ctx.city) || '';
  const food = ctx && ctx.currentFood && ctx.currentFood.name;
  const parts = [];
  if (city) parts.push(city);
  parts.push(question.replace(/[?？!！。，,]/g, ' ').trim().slice(0, 40));
  if (food && !question.includes(food)) parts.push(food);
  parts.push('团购 探店');
  return parts.join(' ').slice(0, 120);
}

/* ============================== 平台聚合 ============================== */

async function handleNearby(request, env, config, cors) {
  let body = {};
  if (request.method === 'POST') {
    try { body = await request.json(); } catch { body = {}; }
  } else {
    const u = new URL(request.url);
    u.searchParams.forEach((v, k) => { body[k] = v; });
  }

  const keyword = String(body.keyword || '').slice(0, 40);
  const city = String(body.city || '').slice(0, 20);
  const cityId = String(body.cityId || '').slice(0, 12);
  const lat = body.lat !== undefined ? Number(body.lat) : null;
  const lng = body.lng !== undefined ? Number(body.lng) : null;
  const sources = Array.isArray(body.sources) && body.sources.length ? body.sources : ['meituan', 'shangou'];
  const limit = Math.min(Math.max(Number(body.limit) || 12, 1), 30);

  if (await rateLimited(env, request, 'nearby', 30, 60)) {
    return json({ error: '刷得太紧了', code: 'RATE_LIMITED', products: [], shops: [], sources: {} }, 429, cors);
  }

  const tasks = [];
  if (sources.includes('meituan')) {
    tasks.push(meituanNearby({ env, keyword, city, cityId, lat, lng, limit })
      .then(r => ['meituan', r])
      .catch(e => ['meituan', { status: 'error', error: String(e && e.message || e), products: [], shops: [] }]));
  }
  if (sources.includes('shangou')) {
    tasks.push(shangouNearby({ env, keyword, city, cityId, lat, lng, limit })
      .then(r => ['shangou', r])
      .catch(e => ['shangou', { status: 'error', error: String(e && e.message || e), products: [], shops: [] }]));
  }

  const settled = await Promise.all(tasks);
  const out = { products: [], shops: [], sources: {}, errors: {}, city, located: !!(lat && lng) };

  for (const [name, r] of settled) {
    out.sources[name] = r.status;
    if (r.error) out.errors[name] = r.error;
    if (Array.isArray(r.products)) out.products.push(...r.products);
    if (Array.isArray(r.shops)) out.shops.push(...r.shops);
  }

  // 按距离排序 + 截断
  const byDist = (a, b) => {
    const ma = meters(a.distanceText), mb = meters(b.distanceText);
    if (ma === null && mb === null) return 0;
    if (ma === null) return 1;
    if (mb === null) return -1;
    return ma - mb;
  };
  out.products.sort(byDist);
  out.shops.sort(byDist);
  out.products = out.products.slice(0, limit);
  out.shops = out.shops.slice(0, Math.max(4, Math.floor(limit / 2)));

  return json(out, 200, cors);
}

function meters(text) {
  const s = String(text || '').toLowerCase();
  let m = s.match(/([\d.]+)\s*km/);
  if (m) return parseFloat(m[1]) * 1000;
  m = s.match(/([\d.]+)\s*m/);
  if (m) return parseFloat(m[1]);
  return null;
}

/* ============================== 酒旅（可选） ============================== */

async function handleTravel(request, env, config, cors) {
  let body = {};
  try { body = await request.json(); } catch { /* ignore */ }
  const query = String(body.query || '').slice(0, 100);
  if (!query) return json({ error: '缺少 query' }, 400, cors);

  if (!env.MEITUAN_TRAVEL_TOKEN) {
    return json({ error: '未配置 MEITUAN_TRAVEL_TOKEN', code: 'NOT_CONFIGURED' }, 503, cors);
  }
  try {
    const r = await meituanTravel({ env, city: String(body.city || '').slice(0, 20), query });
    return json(r, 200, cors);
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 502, cors);
  }
}

/* ============================== 健康检查 ============================== */

async function handleHealth(request, env, config, cors) {
  const day = dayKey();
  const usage = await readUsage(env, day);
  const provider = aiProviderName(env);
  return json({
    ok: true,
    version: '0.5.0',
    model: aiModelName(env, config),
    aiProvider: provider,
    platforms: {
      meituan: meituanConfigured(env) ? 'configured' : 'missing_meituan_token',
      shangou: shangouConfigured(env) ? 'configured' : 'missing_shangou_keys',
      ai: aiConfigured(env) ? 'configured' : aiMissingHint(env),
      deepseek: env.DEEPSEEK_API_KEY ? 'configured' : 'missing_deepseek_key',
    },
    searchEnabled: aiSearchSupported(env) && config.DAILY_MAX_SEARCH > 0,
    budget: budgetLeft(usage, config),
    kvBound: !!env.USAGE,
  }, 200, cors);
}

/* ============================== 路由 ============================== */

export { matchOrigin };

export default {
  async fetch(request, env, ctx) {
    const config = cfg(env);
    const cors = corsHeaders(request, config);
    const url = new URL(request.url);
    // 同时兼容 /api/v1/* 与 /v1/*（部分人直接把 Worker 域名当 API 根）
    const path = url.pathname.replace(/^\/api/, '').replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (!originAllowed(request, config)) {
      return json({ error: 'origin not allowed' }, 403, cors);
    }

    try {
      if (path === '/' || path === '/v1') {
        return json({ name: '今日食签 API', version: '0.5.0', endpoints: ['/api/v1/health', '/api/v1/chat', '/api/v1/platform/nearby'] }, 200, cors);
      }
      if (path === '/v1/health') return handleHealth(request, env, config, cors);
      if (path === '/v1/chat' && request.method === 'POST') return handleChat(request, env, config, cors);
      if (path === '/v1/platform/nearby') return handleNearby(request, env, config, cors);
      if (path === '/v1/travel' && request.method === 'POST') return handleTravel(request, env, config, cors);
      return json({ error: 'not found', path: url.pathname }, 404, cors);
    } catch (e) {
      console.error('unhandled', e && e.stack);
      return json({ error: '服务内部错误', detail: String(e && e.message || e) }, 500, cors);
    }
  },
};
