/**
 * 淘宝闪购适配器（原饿了么，2025-12 品牌升级为「淘宝闪购」）
 * =============================================================================
 * 走的通道：
 *   A. 零售开放平台（开放货架，推荐）
 *        POST https://open-retail.ele.me/api/v1/
 *        RPC 风格：{ token, nop, metas: {app_key, timestamp}, params, action, id, signature }
 *   B. 服务商平台（餐饮连锁）
 *        POST https://open-api.shop.ele.me/api/v1/   —— 同一套签名
 *
 * 签名算法（官方 SDK 一致）：
 *   arr = Object.keys(params).map(k => k + '=' + JSON.stringify(params[k])).sort()
 *   sign = upper(md5(action + token + arr.join('') + secret))
 *
 * 凭证一律走 wrangler secret：
 *   SHANGOU_APP_KEY / SHANGOU_APP_SECRET / SHANGOU_TOKEN
 * （token 用 client_credentials 模式换，详见 README）
 *
 * 能力边界（重要，别让用户误以为能"代下单"）：
 *   开放平台的接口是**商家维度**的，能查自己门店的商品与订单；
 *   面向 C 端的"附近有什么闪购商品"需要平台侧的选品/营销接口权限。
 *   所以本适配器默认只做两件事：查已绑定门店的商品，给不出就近结果时返回 empty，
 *   由前端显示「闪购 · 无结果」，绝不编数据。
 */

const ENDPOINTS = {
  retail: 'https://open-retail.ele.me/api/v1/',
  shop: 'https://open-api.shop.ele.me/api/v1/',
  sandbox: 'https://open-api-sandbox.shop.ele.me/api/v1/',
};

const TIMEOUT = 9000;

export function shangouConfigured(env) {
  return !!(env && env.SHANGOU_APP_KEY && env.SHANGOU_APP_SECRET);
}

/* ------------------------------ 签名 ------------------------------ */

function stableStringify(v) {
  // 官方 SDK 用 JSON.stringify；这里保持一致，保证签名逐字节相同
  return JSON.stringify(v === undefined ? null : v);
}

export function sign({ action, token, params, secret }) {
  const arr = Object.keys(params || {})
    .map(k => k + '=' + stableStringify(params[k]))
    .sort();
  return md5Hex(action + (token || '') + arr.join('') + secret).toUpperCase();
}

/** 纯 JS MD5（Workers 里没有 node:crypto 的同步接口，自带一份更稳） */
function md5Hex(str) {
  const s = unescape(encodeURIComponent(String(str)));
  return hex(md5core(s));
}

function hex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += ('0' + (bytes[i] & 0xff).toString(16)).slice(-2);
  return out;
}

function md5core(str) {
  // 这是标准的 RFC 1321 实现，紧凑写法
  const K = new Int32Array([
    -680876936, -389564586, 606105819, -1044525330, -176418897, 1200080426, -1473231341, -45705983,
    1770035416, -1958414417, -42063, -1990404162, 1804603682, -40341101, -1502002290, 1236535329,
    -165796510, -1069501632, 643717713, -373897302, -701558691, 38016083, -660478335, -405537848,
    568446438, -1019803690, -187363961, 1163531501, -1444681467, -51403784, 1735328473, -1926607734,
    -378558, -2022574463, 1839030562, -35309556, -1530992060, 1272893353, -155497632, -1094730640,
    681279174, -358537222, -722521979, 76029189, -640364487, -421815835, 530742520, -995338651,
    -198630844, 1126891415, -1416354905, -57434055, 1700485571, -1894986606, -1051523, -2054922799,
    1873313359, -30611744, -1560198380, 1309151649, -145523070, -1120210379, 718787259, -343485551,
  ]);

  function rl(n, c) { return (n << c) | (n >>> (32 - c)); }
  function ad(a, b) {
    const l = (a & 0xffff) + (b & 0xffff);
    return (((a >> 16) + (b >> 16) + (l >> 16)) << 16) | (l & 0xffff);
  }
  function cmn(q, a, b, x, s, t) { return ad(rl(ad(ad(a, q), ad(x, t)), s), b); }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }

  const len = str.length;
  const wordsCount = (((len + 8) >> 6) + 1) * 16;
  const x = new Int32Array(wordsCount);
  for (let i = 0; i < len; i++) x[i >> 2] |= str.charCodeAt(i) << ((i % 4) * 8);
  x[len >> 2] |= 0x80 << ((len % 4) * 8);
  x[wordsCount - 2] = len * 8;

  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;

  for (let i = 0; i < wordsCount; i += 16) {
    const oa = a, ob = b, oc = c, od = d;
    a = ff(a, b, c, d, x[i], 7, K[0]);       d = ff(d, a, b, c, x[i + 1], 12, K[1]);
    c = ff(c, d, a, b, x[i + 2], 17, K[2]);  b = ff(b, c, d, a, x[i + 3], 22, K[3]);
    a = ff(a, b, c, d, x[i + 4], 7, K[4]);   d = ff(d, a, b, c, x[i + 5], 12, K[5]);
    c = ff(c, d, a, b, x[i + 6], 17, K[6]);  b = ff(b, c, d, a, x[i + 7], 22, K[7]);
    a = ff(a, b, c, d, x[i + 8], 7, K[8]);   d = ff(d, a, b, c, x[i + 9], 12, K[9]);
    c = ff(c, d, a, b, x[i + 10], 17, K[10]); b = ff(b, c, d, a, x[i + 11], 22, K[11]);
    a = ff(a, b, c, d, x[i + 12], 7, K[12]);  d = ff(d, a, b, c, x[i + 13], 12, K[13]);
    c = ff(c, d, a, b, x[i + 14], 17, K[14]); b = ff(b, c, d, a, x[i + 15], 22, K[15]);

    a = gg(a, b, c, d, x[i + 1], 5, K[16]);  d = gg(d, a, b, c, x[i + 6], 9, K[17]);
    c = gg(c, d, a, b, x[i + 11], 14, K[18]); b = gg(b, c, d, a, x[i], 20, K[19]);
    a = gg(a, b, c, d, x[i + 5], 5, K[20]);  d = gg(d, a, b, c, x[i + 10], 9, K[21]);
    c = gg(c, d, a, b, x[i + 15], 14, K[22]); b = gg(b, c, d, a, x[i + 4], 20, K[23]);
    a = gg(a, b, c, d, x[i + 9], 5, K[24]);  d = gg(d, a, b, c, x[i + 14], 9, K[25]);
    c = gg(c, d, a, b, x[i + 3], 14, K[26]); b = gg(b, c, d, a, x[i + 8], 20, K[27]);
    a = gg(a, b, c, d, x[i + 13], 5, K[28]); d = gg(d, a, b, c, x[i + 2], 9, K[29]);
    c = gg(c, d, a, b, x[i + 7], 14, K[30]); b = gg(b, c, d, a, x[i + 12], 20, K[31]);

    a = hh(a, b, c, d, x[i + 5], 4, K[32]);  d = hh(d, a, b, c, x[i + 8], 11, K[33]);
    c = hh(c, d, a, b, x[i + 11], 16, K[34]); b = hh(b, c, d, a, x[i + 14], 23, K[35]);
    a = hh(a, b, c, d, x[i + 1], 4, K[36]);  d = hh(d, a, b, c, x[i + 4], 11, K[37]);
    c = hh(c, d, a, b, x[i + 7], 16, K[38]); b = hh(b, c, d, a, x[i + 10], 23, K[39]);
    a = hh(a, b, c, d, x[i + 13], 4, K[40]); d = hh(d, a, b, c, x[i], 11, K[41]);
    c = hh(c, d, a, b, x[i + 3], 16, K[42]); b = hh(b, c, d, a, x[i + 6], 23, K[43]);
    a = hh(a, b, c, d, x[i + 9], 4, K[44]);  d = hh(d, a, b, c, x[i + 12], 11, K[45]);
    c = hh(c, d, a, b, x[i + 15], 16, K[46]); b = hh(b, c, d, a, x[i + 2], 23, K[47]);

    a = ii(a, b, c, d, x[i], 6, K[48]);      d = ii(d, a, b, c, x[i + 7], 10, K[49]);
    c = ii(c, d, a, b, x[i + 14], 15, K[50]); b = ii(b, c, d, a, x[i + 5], 21, K[51]);
    a = ii(a, b, c, d, x[i + 12], 6, K[52]);  d = ii(d, a, b, c, x[i + 3], 10, K[53]);
    c = ii(c, d, a, b, x[i + 10], 15, K[54]); b = ii(b, c, d, a, x[i + 1], 21, K[55]);
    a = ii(a, b, c, d, x[i + 8], 6, K[56]);   d = ii(d, a, b, c, x[i + 15], 10, K[57]);
    c = ii(c, d, a, b, x[i + 6], 15, K[58]);  b = ii(b, c, d, a, x[i + 13], 21, K[59]);
    a = ii(a, b, c, d, x[i + 4], 6, K[60]);   d = ii(d, a, b, c, x[i + 11], 10, K[61]);
    c = ii(c, d, a, b, x[i + 2], 15, K[62]);  b = ii(b, c, d, a, x[i + 9], 21, K[63]);

    a = ad(a, oa); b = ad(b, ob); c = ad(c, oc); d = ad(d, od);
  }
  const out = new Uint8Array(16);
  [a, b, c, d].forEach((v, idx) => {
    out[idx * 4] = v & 0xff;
    out[idx * 4 + 1] = (v >>> 8) & 0xff;
    out[idx * 4 + 2] = (v >>> 16) & 0xff;
    out[idx * 4 + 3] = (v >>> 24) & 0xff;
  });
  return out;
}

/* ------------------------------ RPC ------------------------------ */

function reqId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function rpc({ env, action, params, timeoutMs }) {
  const appKey = env.SHANGOU_APP_KEY;
  const secret = env.SHANGOU_APP_SECRET;
  const token = env.SHANGOU_TOKEN || '';
  const endpoint = ENDPOINTS[env.SHANGOU_ENV === 'sandbox' ? 'sandbox' : 'retail'];
  const ts = Math.floor(Date.now() / 1000);

  const payload = {
    token,
    nop: '1.0.0',
    metas: { app_key: appKey, timestamp: ts },
    params: params || {},
    action,
    id: reqId(),
    signature: sign({ action, token, params: params || {}, secret }),
  };

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs || TIMEOUT) : null;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=utf-8', 'User-Agent': 'shiqian-v0.5' },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined,
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { throw new Error('闪购返回了非 JSON 内容'); }
    if (data.error) {
      throw new Error('闪购：' + (data.error.message || data.error.code || '调用失败'));
    }
    return data.result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ------------------------------ 归一 ------------------------------ */

function yuan(v) {
  // 闪购金额单位是「分」
  const n = Number(v);
  if (!isFinite(n) || n === 0) return 0;
  return Math.round(n) / 100;
}

function normalizeProduct(item, shop) {
  if (!item || typeof item !== 'object') return null;
  const title = String(item.name || item.title || '').trim();
  if (!title) return null;
  return {
    id: String(item.id || item.skuId || ''),
    source: 'shangou',
    shopId: String((shop && shop.id) || item.shopId || ''),
    shopName: String((shop && shop.name) || item.shopName || ''),
    title,
    price: yuan(item.price),
    originPrice: yuan(item.originalPrice),
    soldText: item.monthSaled ? '月售 ' + item.monthSaled : '',
    distanceText: '',
    cover: String(item.imageUrl || item.image || ''),
    url: '',
    tags: (item.labels || []).map(String).slice(0, 4),
  };
}

/* ------------------------------ 主流程 ------------------------------ */

export async function shangouNearby({ env, keyword, city, limit }) {
  if (!shangouConfigured(env)) {
    return { status: 'not_configured', products: [], shops: [], error: '缺少 SHANGOU_APP_KEY / SHANGOU_APP_SECRET' };
  }
  if (!env.SHANGOU_SHOP_ID) {
    // 没有绑定门店就无法查商品；这是平台权限决定的，不是 bug
    return { status: 'not_configured', products: [], shops: [], error: '缺少 SHANGOU_SHOP_ID（开放平台按门店维度查商品）' };
  }

  try {
    const shopId = Number(env.SHANGOU_SHOP_ID);
    const shopInfo = await rpc({ env, action: 'eleme.shop.getShop', params: { shopId } }).catch(() => null);
    const shop = shopInfo
      ? { id: String(shopInfo.id || shopId), name: String(shopInfo.name || '闪购门店') }
      : { id: String(shopId), name: '闪购门店' };

    const cats = await rpc({ env, action: 'eleme.product.category.getShopCategories', params: { shopId } });
    const categoryIds = (Array.isArray(cats) ? cats : []).map(c => c.id).filter(Boolean).slice(0, 6);

    const products = [];
    for (const cid of categoryIds) {
      if (products.length >= (limit || 12)) break;
      const list = await rpc({
        env,
        action: 'eleme.product.item.listItemsByCategoryId',
        params: { categoryId: cid, page: 1, size: 20 },
      }).catch(() => null);
      const items = Array.isArray(list) ? list : (list && list.list) || [];
      for (const it of items) {
        // 关键词粗筛，避免把整店商品都返回
        if (keyword && !String(it.name || '').includes(keyword.replace(/[（(].*?[)）]/g, ''))) continue;
        const p = normalizeProduct(it, shop);
        if (p) products.push(p);
      }
    }

    return {
      status: products.length ? 'ok' : 'empty',
      products: products.slice(0, limit || 12),
      shops: [normalizeShop(shop)].filter(Boolean),
    };
  } catch (e) {
    return { status: 'error', products: [], shops: [], error: String(e && e.message || e) };
  }
}

function normalizeShop(s) {
  if (!s || !s.name) return null;
  return {
    id: String(s.id || ''),
    source: 'shangou',
    name: String(s.name),
    category: '闪购',
    rating: 0,
    reviewCount: 0,
    avgPrice: 0,
    distanceText: '',
    address: '',
    cover: '',
    url: '',
    tags: ['闪购'],
  };
}
