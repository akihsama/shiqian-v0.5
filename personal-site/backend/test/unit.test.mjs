/**
 * 单元测试（node --test，无需安装依赖、无需网络）
 * ---------------------------------------------------------------
 * 覆盖三类最容易悄悄坏掉的地方：
 *   1. 闪购签名（跟官方 SDK 的算法要逐字节一致）
 *   2. AI 出签的解析与兜底（模型不听话时前端不能白屏）
 *   3. 平台归一化（美团/闪购两种字段结构 → 同一套）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { sign } from '../src/providers/shangou.js';
import { parseRecommendation, fallbackRecommendation, buildSystemPrompt } from '../src/prompt.js';
import { meituanConfigured } from '../src/providers/meituan.js';
import {
  aiProviderName, aiConfigured, aiMissingHint, aiModelName, aiSearchSupported,
} from '../src/ai.js';
import { isFreeModel, zhipuChat } from '../src/zhipu.js';
import { matchOrigin } from '../worker.js';

const norm = (await import('../../app/js/normalizer.js')).default;

/* ---------------------------- 1. 闪购签名 ---------------------------- */

test('闪购签名与 node:crypto 的 md5 完全一致', () => {
  const action = 'eleme.product.item.listItemsByCategoryId';
  const token = 'token-abc';
  const params = { categoryId: 1, page: 1, size: 20 };
  const secret = 'secret-xyz';

  const arr = Object.keys(params).map(k => k + '=' + JSON.stringify(params[k])).sort();
  const raw = action + token + arr.join('') + secret;
  const expect = crypto.createHash('md5').update(raw).digest('hex').toUpperCase();

  assert.equal(sign({ action, token, params, secret }), expect);
});

test('签名对参数顺序不敏感（内部会排序）', () => {
  const a = sign({ action: 'x.y', token: 't', params: { b: 2, a: 1 }, secret: 's' });
  const b = sign({ action: 'x.y', token: 't', params: { a: 1, b: 2 }, secret: 's' });
  assert.equal(a, b);
});

/* ---------------------------- 2. 出签解析 ---------------------------- */

test('能解析标准格式的出签', () => {
  const r = parseRecommendation('【红烧牛肉面】汤浓面弹，加班后来一碗正好。\n热汤下肚，万事可说。');
  assert.equal(r.foodName, '红烧牛肉面');
  assert.ok(r.reason.includes('汤浓面弹'));
  assert.ok(r.blessing.includes('热汤下肚'));
  assert.ok(['大吉', '中吉', '吉', '小吉'].includes(r.fortune));
});

test('模型不按格式输出时不抛错，返回 null', () => {
  assert.equal(parseRecommendation('我觉得都可以，你看着办'), null);
});

test('空回复也能兜底', () => {
  const r = fallbackRecommendation('', []);
  assert.ok(r.foodName && r.blessing);
});

test('有附近商品时兜底优先用第一件', () => {
  const r = fallbackRecommendation('', [{ name: '老街牛肉面（招牌）', price: 19.9, shop: '老街', source: 'meituan' }]);
  assert.equal(r.foodName, '老街牛肉面');
});

test('提示词里带上了附近商品和联网资料，并强调优先附近', () => {
  const p = buildSystemPrompt(
    { city: '北京', currentFood: { name: '寿司' }, foods: [{ name: '寿司' }] },
    [{ name: '双人火锅套餐', price: 159, shop: '闪电火锅', source: 'shangou' }],
    '[1] 某店 双人餐 158 元'
  );
  assert.ok(p.includes('北京'));
  assert.ok(p.includes('双人火锅套餐'));
  assert.ok(p.includes('优先从「附近真实商品」里选'));
  assert.ok(p.includes('闪购'));
});

/* ---------------------------- 3. 平台归一化 ---------------------------- */

test('美团商品归一：价格、距离、来源', () => {
  const p = norm.normalizeMeituanProduct({
    productId: 12345,
    productName: '酸菜鱼双人份',
    currentPrice: 58,
    originPrice: '88',
    poiName: '川味小馆',
    distanceText: '2.1km',
    imageUrl: 'https://img/x.jpg',
    tagList: [{ name: '免预约' }],
  });
  assert.equal(p.source, 'meituan');
  assert.equal(p.id, '12345');
  assert.equal(p.price, 58);
  assert.equal(p.originPrice, 88);
  assert.equal(p.shopName, '川味小馆');
  assert.deepEqual(p.tags, ['免预约']);
});

test('美团字段缺名字时返回 null，不产生空卡片', () => {
  assert.equal(norm.normalizeMeituanProduct({ productId: 1, price: 10 }), null);
  assert.equal(norm.normalizeMeituanProduct(null), null);
});

test('闪购金额按「分」换算成元', () => {
  const p = norm.normalizeShangouProduct({ id: 's1', name: '日式咖喱猪排饭', price: 3200, originalPrice: 4500 }, { shopId: '9', shopName: '深夜食堂' });
  assert.equal(p.price, 32);
  assert.equal(p.originPrice, 45);
  assert.equal(p.shopName, '深夜食堂');
});

test('按距离排序：m 与 km 混排正确', () => {
  const list = [
    { title: '远', distanceText: '3km' },
    { title: '无距离', distanceText: '' },
    { title: '近', distanceText: '480m' },
  ];
  const sorted = norm.sortByDistance(list).map(x => x.title);
  assert.deepEqual(sorted, ['近', '远', '无距离']);
});

test('去重：同来源同 id 只留一条', () => {
  const list = [
    { source: 'meituan', id: '1', title: 'A' },
    { source: 'meituan', id: '1', title: 'A' },
    { source: 'shangou', id: '1', title: 'A' },
  ];
  assert.equal(norm.dedupe(list).length, 2);
});

test('金额格式化', () => {
  assert.equal(norm.money(19.94), '¥19.9');
  assert.equal(norm.money(0), '');
});

/* ---------------------------- 4. 配置探测 ---------------------------- */

test('没配美团 token 时如实报告未配置', () => {
  assert.equal(meituanConfigured({}), false);
  assert.equal(meituanConfigured({ MEITUAN_TOKEN: 'x' }), true);
});

/* ---------------------- 5. AI 提供商抽象层 ---------------------- */

test('默认走智谱，且只有显式写 deepseek 才切换', () => {
  assert.equal(aiProviderName({}), 'zhipu');
  assert.equal(aiProviderName({ AI_PROVIDER: '' }), 'zhipu');
  assert.equal(aiProviderName({ AI_PROVIDER: 'zhipu' }), 'zhipu');
  assert.equal(aiProviderName({ AI_PROVIDER: 'DeepSeek' }), 'deepseek');
  assert.equal(aiProviderName({ AI_PROVIDER: 'openai' }), 'zhipu', '未知值必须回落到默认，而不是崩');
});

test('配置探测按提供商各认各的 Key', () => {
  assert.equal(aiConfigured({ ZHIPU_API_KEY: 'z' }), true);
  assert.equal(aiConfigured({ DEEPSEEK_API_KEY: 'd' }), false, '没切 provider 时 DeepSeek Key 不该放行');
  assert.equal(aiConfigured({ AI_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'd' }), true);
  assert.equal(aiConfigured({ AI_PROVIDER: 'deepseek', ZHIPU_API_KEY: 'z' }), false);
  assert.equal(aiMissingHint({}), 'missing_zhipu_key');
  assert.equal(aiMissingHint({ AI_PROVIDER: 'deepseek' }), 'missing_deepseek_key');
});

test('模型名跟着提供商走，防止「切了家忘改模型名」拿到 400', () => {
  // wrangler.toml 默认写 glm-4.7-flash
  assert.equal(aiModelName({}, { MODEL: 'glm-4.7-flash' }), 'glm-4.7-flash');
  // 切到 deepseek 但忘了改 MODEL：自动改成 deepseek-flash
  assert.equal(aiModelName({ AI_PROVIDER: 'deepseek' }, { MODEL: 'glm-4.7-flash' }), 'deepseek-flash');
  // 反过来也一样
  assert.equal(aiModelName({}, { MODEL: 'deepseek-flash' }), 'glm-4.7-flash');
  // 同家族的自定义模型名要保留
  assert.equal(aiModelName({}, { MODEL: 'glm-4.5-air' }), 'glm-4.5-air');
  assert.equal(aiModelName({ AI_PROVIDER: 'deepseek' }, { MODEL: 'deepseek-v4-pro' }), 'deepseek-v4-pro');
  assert.equal(aiModelName({}, {}), 'glm-4.7-flash');
});

test('联网搜索只挂在 DeepSeek 名下', () => {
  assert.equal(aiSearchSupported({}), false, '智谱免费模型不该触发付费搜索');
  assert.equal(aiSearchSupported({ AI_PROVIDER: 'deepseek' }), true);
});

test('免费模型不记钱，付费型号按保守估价记', () => {
  assert.equal(isFreeModel('glm-4.7-flash'), true);
  assert.equal(isFreeModel('glm-4-flash'), true);
  assert.equal(isFreeModel('glm-4.5-air'), true);
  assert.equal(isFreeModel('glm-4.7'), false, '常规型号是付费的');
  assert.equal(isFreeModel(''), false);
});

/* ------------------- 6. 智谱请求体：必须关思考 ------------------- */

test('智谱请求体默认关闭思考模式（否则 320 token 会被 reasoning 吃光）', async () => {
  // 拦截 fetch，检查真正发出去的 body
  const captured = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captured.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      model: 'glm-4.7-flash',
      choices: [{ message: { content: '【牛肉面】\n汤浓面弹' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 154, completion_tokens: 28, total_tokens: 182 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const res = await zhipuChat({
      apiKey: 'k', model: 'glm-4.7-flash',
      messages: [{ role: 'user', content: 'hi' }], maxTokens: 320,
    });
    assert.deepEqual(captured[0].body.thinking, { type: 'disabled' }, '必须显式 disabled');
    assert.equal(res.content, '【牛肉面】\n汤浓面弹');
    assert.equal(res.costMicro, 0, '免费型号记账必须为 0');
    assert.equal(res.usage.promptTokens, 154);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('content 为空但有 reasoning 时自动重试一次，而不是直接报错', async () => {
  let n = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    n += 1;
    const body = n === 1
      ? { choices: [{ message: { content: '', reasoning_content: '思考中...' }, finish_reason: 'length' }] }
      : { model: 'glm-4.7-flash', choices: [{ message: { content: '【小炒肉】\n够辣够下饭' } }], usage: {} };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const res = await zhipuChat({ apiKey: 'k', model: 'glm-4.7-flash', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(n, 2, '应该重试一次');
    assert.equal(res.content, '【小炒肉】\n够辣够下饭');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('429 会退避重试，最终成功时不报错', async () => {
  let n = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    n += 1;
    if (n === 1) {
      return new Response(JSON.stringify({ error: { code: '1305', message: '该模型当前访问量过大' } }), { status: 429 });
    }
    return new Response(JSON.stringify({
      model: 'glm-4.7-flash',
      choices: [{ message: { content: '【砂锅粥】\n热乎养胃' } }],
      usage: {},
    }), { status: 200 });
  };
  try {
    const res = await zhipuChat({ apiKey: 'k', model: 'glm-4.7-flash', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(n, 2, '撞到 429 后应重试');
    assert.equal(res.content, '【砂锅粥】\n热乎养胃');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('504 超时也重试，用尽三次后抛出原始错误', async () => {
  let n = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    n += 1;
    return new Response(JSON.stringify({ error: { message: 'upstream timeout' } }), { status: 504 });
  };
  try {
    await assert.rejects(
      () => zhipuChat({ apiKey: 'k', model: 'glm-4.7-flash', messages: [{ role: 'user', content: 'hi' }] }),
      /upstream timeout/
    );
    assert.equal(n, 3, '504 应走满三次尝试');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('401 不重试，立刻抛出（避免拿错 Key 空转）', async () => {
  let n = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    n += 1;
    return new Response(JSON.stringify({ error: { code: '1000', message: '令牌已过期或验证不正确' } }), { status: 401 });
  };
  try {
    await assert.rejects(
      () => zhipuChat({ apiKey: 'bad', model: 'glm-4.7-flash', messages: [{ role: 'user', content: 'hi' }] }),
      /令牌已过期/
    );
    assert.equal(n, 1, '401 不能重试');
  } finally {
    globalThis.fetch = origFetch;
  }
});

/* ---------------- 7. CORS 白名单（支持 pages.dev 通配）---------------- */

test('精确匹配照旧可用', () => {
  const list = ['https://akihsama.github.io'];
  assert.equal(matchOrigin('https://akihsama.github.io', list), true);
  assert.equal(matchOrigin('https://akihsama.github.io.evil.com', list), false);
  assert.equal(matchOrigin('http://akihsama.github.io', list), false, '协议不同不算同源');
});

test('https://*.pages.dev 放行项目域名与部署哈希域名', () => {
  const list = ['https://*.pages.dev'];
  assert.equal(matchOrigin('https://shiqian.pages.dev', list), true);
  assert.equal(matchOrigin('https://a1b2c3d4.shiqian.pages.dev', list), true);
  assert.equal(matchOrigin('https://a.b.shiqian.pages.dev', list), true);
});

test('通配不会误放行外站', () => {
  const list = ['https://*.pages.dev'];
  assert.equal(matchOrigin('https://pages.dev.evil.com', list), false, '后缀必须在最后');
  assert.equal(matchOrigin('https://evil-pages.dev', list), false, '没有点分隔不算子域');
  assert.equal(matchOrigin('http://x.pages.dev', list), false, '必须 https');
  assert.equal(matchOrigin('https://x.pages.dev/evil', list), false, 'Origin 里不该有路径');
  assert.equal(matchOrigin('', list), false);
});

test('只接受 https://*.xxx 形式，避免写成 https://* 全网放行', () => {
  assert.equal(matchOrigin('https://anything.com', ['https://*']), false);
  assert.equal(matchOrigin('https://anything.com', ['*']), false, '裸 * 在 cfg 层已单独处理，这里不当通配');
});
