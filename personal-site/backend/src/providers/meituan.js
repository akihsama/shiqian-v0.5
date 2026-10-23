/**
 * 美团适配器
 * =============================================================================
 * 两条线路，都是官方渠道，代码里都做了「未配置就老实说未配置」的处理：
 *
 * A. 到店团购（主线路）
 *    走美团为 AI Agent 提供的团购搜索通道：
 *      POST https://click.meituan.com/cps/ai/product/searchProductByAgent
 *    必须带用户授权 token（放在 body 的 userParamDTO.token 和 header 里）。
 *    拿到商品后按距离过滤、排序，标签标记来源为「美团」。
 *
 * B. 酒旅（可选）
 *    走美团开放平台个人开发者 OpenAPI：
 *      POST https://mcp-open-cater.meituan.com/v1/api/voyage/openapi/query
 *    Token 从 developer.meituan.com 个人开发者控制台创建，Authorization 直传。
 *
 * 为什么不用商家 OpenAPI（developer.waimai.meituan.com）？
 *    那套需要企业资质 + 应用审核 + 商家授权，属于「帮商家管店」，不是「帮用户选饭」，
 *    跟本站场景不匹配。团购 + 酒旅 才是用户侧能力。
 *
 * ⚠️ 字段映射说明：美团 C 端接口字段名没有公开文档，normalize() 里做了多别名兜底。
 *    接上真实 token 后，请把一次真实响应脱敏后放进 test/fixtures/meituan-search.json，
 *    再跑 `npm test` 就能确认映射没跑偏。
 */

const SEARCH_URL = 'https://click.meituan.com/cps/ai/product/searchProductByAgent';
const LOCATION_URL = 'https://click.meituan.com/cps/ai/product/getLocationByAddress';
const TRAVEL_URL = 'https://mcp-open-cater.meituan.com/v1/api/voyage/openapi/query';

const CLIENT_SOURCE = 'shiqian-v0.5';
const TIMEOUT = 9000;

export function meituanConfigured(env) {
  return !!(env && env.MEITUAN_TOKEN);
}

function tokenOf(env) {
  return (env && (env.MEITUAN_TOKEN || '')) || '';
}

async function postJSON(url, body, headers, timeoutMs) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs || TIMEOUT) : null;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Shiqian/0.5)' }, headers || {}),
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined,
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { throw new Error('美团返回了非 JSON 内容'); }
    return { status: res.status, data };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ------------------------------ 字段归一 ------------------------------ */

function yuan(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(String(v).replace(/[^\d.]/g, ''));
  return isNaN(n) ? 0 : n;
}

function distText(v) {
  if (v === null || v === undefined || v === '') return '';
  const s = String(v);
  if (/^\d+(\.\d+)?$/.test(s)) {
    const m = Number(s);
    return m >= 1000 ? (Math.round(m / 100) / 10) + 'km' : Math.round(m) + 'm';
  }
  return s;
}

function normalizeProduct(item) {
  if (!item || typeof item !== 'object') return null;
  const shop = item.poi || item.shop || item.shopInfo || {};
  const title = String(item.productName || item.title || item.name || item.dealTitle || '').trim();
  if (!title) return null;
  const tags = []
    .concat(item.tagList || [], item.tags || [], item.labels || [])
    .map(t => (typeof t === 'string' ? t : (t && (t.name || t.text || t.tagName)) || ''))
    .filter(Boolean)
    .slice(0, 4);

  return {
    id: String(item.productId || item.dealId || item.id || ''),
    source: 'meituan',
    shopId: String(item.poiId || shop.id || shop.poiId || ''),
    shopName: String(item.poiName || shop.name || item.shopName || ''),
    title,
    price: yuan(item.currentPrice || item.price || item.salePrice || item.priceText),
    originPrice: yuan(item.originPrice || item.marketPrice || item.originalPrice),
    soldText: String(item.soldText || item.saleVolumeText || item.salesText || ''),
    distanceText: distText(item.distanceText || item.distance),
    cover: String(item.imageUrl || item.picture || item.cover || item.image || ''),
    // 只透出美团自己的落地页；没有就不给链接，避免前端拼出假地址
    url: String(item.dealUrl || item.jumpUrl || item.url || ''),
    tags,
  };
}

function normalizeShop(item) {
  if (!item || typeof item !== 'object') return null;
  const name = String(item.poiName || item.shopName || item.name || '').trim();
  if (!name) return null;
  return {
    id: String(item.poiId || item.shopId || item.id || ''),
    source: 'meituan',
    name,
    category: String(item.categoryName || item.category || item.cateName || ''),
    rating: Number(item.avgScore || item.score || item.rating || 0),
    reviewCount: Number(item.commentNum || item.reviewCount || 0),
    avgPrice: yuan(item.avgPrice || item.perCapita || item.price),
    distanceText: distText(item.distanceText || item.distance),
    address: String(item.address || item.poiAddress || ''),
    cover: String(item.imageUrl || item.frontImg || item.cover || ''),
    url: String(item.shopUrl || item.jumpUrl || item.url || ''),
    tags: (item.tagList || []).map(t => (typeof t === 'string' ? t : (t && (t.name || t.text)) || '')).filter(Boolean).slice(0, 4),
  };
}

/* ------------------------------ 主流程 ------------------------------ */

export async function meituanNearby({ env, keyword, city, cityId, lat, lng, limit }) {
  if (!meituanConfigured(env)) {
    return { status: 'not_configured', products: [], shops: [], error: '缺少 MEITUAN_TOKEN' };
  }

  let useCityId = cityId;
  let useLat = lat;
  let useLng = lng;

  // 没有坐标时，先按城市名换一次经纬度（美团自己的地理接口）
  if ((!useLat || !useLng) && city) {
    try {
      const loc = await postJSON(LOCATION_URL, { address: city }, {}, 6000);
      const d = (loc.data && loc.data.data) || {};
      if (loc.data && loc.data.code === 200 && d.lat) {
        useLat = Number(d.lat);
        useLng = Number(d.lng);
        if (d.cityId) useCityId = String(d.cityId);
      }
    } catch { /* 定位失败就用城市名字继续，不阻断 */ }
  }

  const body = {
    keyword: keyword || (city ? city + '美食' : '美食'),
    page: 1,
    pageSize: String(Math.min(Math.max(limit || 12, 1), 20)),
    clientSource: CLIENT_SOURCE,
    userParamDTO: {
      lat: useLat ? String(useLat) : '',
      lng: useLng ? String(useLng) : '',
      token: tokenOf(env),
      cityId: useCityId || '',
      app: 216,
      platform: 1,
      partner: 1018,
    },
  };

  const { status, data } = await postJSON(SEARCH_URL, body, { token: tokenOf(env) });

  if (!data || data.code !== 200 || data.success === false) {
    const msg = (data && (data.message || data.msg)) || 'HTTP ' + status;
    // 403 多半是 token 失效或出口被风控，如实上报，让前端显示「不可用」
    return { status: 'error', products: [], shops: [], error: '美团：' + msg };
  }

  const block = data.data || {};
  const rawList = block.productList || block.list || [];
  const products = [];
  const shopMap = new Map();

  for (const item of rawList) {
    const p = normalizeProduct(item);
    if (!p) continue;
    // 距离过滤：走太远的团购没有意义（默认 8km）
    const d = parseDist(p.distanceText);
    if (d !== null && d > 8000) continue;
    products.push(p);
    const sid = p.shopId || p.shopName;
    if (sid && !shopMap.has(sid)) {
      const s = normalizeShop(item.poi || item.shop || item) || {
        id: sid, source: 'meituan', name: p.shopName || '美团门店',
        category: '', rating: 0, reviewCount: 0, avgPrice: 0,
        distanceText: p.distanceText, address: '', cover: '', url: '', tags: [],
      };
      shopMap.set(sid, s);
    }
  }

  return {
    status: products.length ? 'ok' : 'empty',
    products,
    shops: Array.from(shopMap.values()),
    queryId: block.queryId ? String(block.queryId) : undefined,
  };
}

function parseDist(text) {
  const s = String(text || '').toLowerCase();
  let m = s.match(/([\d.]+)\s*km/);
  if (m) return parseFloat(m[1]) * 1000;
  m = s.match(/([\d.]+)\s*m/);
  if (m) return parseFloat(m[1]);
  return null;
}

/* ------------------------------ 酒旅 ------------------------------ */

export async function meituanTravel({ env, city, query }) {
  const token = env && (env.MEITUAN_TRAVEL_TOKEN || env.MEITUAN_TOKEN);
  if (!token) throw new Error('缺少 MEITUAN_TRAVEL_TOKEN');

  const { status, data } = await postJSON(
    TRAVEL_URL,
    { city: city || '', query, channel: 'default' },
    { Authorization: token },
    30000
  );

  if (data && data.code !== 0 && data.code !== 200) {
    throw new Error('美团酒旅：' + (data.msg || data.errorInfo?.reason || 'HTTP ' + status));
  }
  return { ok: true, text: String(data.result || data.data || ''), raw: data };
}
