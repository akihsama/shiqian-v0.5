/**
 * 食签规范层（Normalizer）
 * ---------------------------------------------------------------
 * 美团 / 淘宝闪购 两套接口的字段结构完全不同，前端只认这里定义的
 * 一套标准结构。规范层是**纯函数**，不依赖 DOM，可在浏览器和
 * Node 里直接跑（backend 的单测也复用它，避免两边各写一份解析）。
 *
 * 标准结构：
 *   Shop    { id, source, name, category, rating, reviewCount, avgPrice,
 *             distanceText, address, cover, url, tags[] }
 *   Product { id, source, shopId, shopName, title, price, originPrice,
 *             soldText, distanceText, cover, url, tags[] }
 *   Coupon  { id, source, title, subTitle, amount, threshold, validText }
 */
(function (global) {
  'use strict';

  var SOURCE_META = {
    meituan: { label: '美团', color: '#FFD000' },
    shangou: { label: '闪购', color: '#FF6A00' },
    local: { label: '本地签', color: '#00BCD4' }
  };

  function str(v) {
    if (v === null || v === undefined) return '';
    return String(v).trim();
  }

  function num(v) {
    if (v === null || v === undefined || v === '') return 0;
    var n = Number(String(v).replace(/[^\d.\-]/g, ''));
    return isNaN(n) ? 0 : n;
  }

  /** 价格可能是 12 / "12.5" / "¥12.5" / 1250（分）；统一成元 */
  function toYuan(v) {
    if (v === null || v === undefined || v === '') return 0;
    var n = typeof v === 'number' ? v : num(v);
    if (typeof v === 'string' && /[¥￥元]/.test(v)) return n;
    if (Number.isInteger(n) && n >= 1000) return n / 100; // 分 -> 元
    return n;
  }

  function money(v) {
    var n = toYuan(v);
    if (!n) return '';
    return '¥' + (Math.round(n * 10) / 10).toString();
  }

  /** 距离：美团给 "2.7km" / "358m"；闪购给米数 */
  function toMeters(text) {
    var s = str(text).toLowerCase();
    if (!s) return null;
    var m = s.match(/([\d.]+)\s*km/);
    if (m) return parseFloat(m[1]) * 1000;
    m = s.match(/([\d.]+)\s*m/);
    if (m) return parseFloat(m[1]);
    m = s.match(/^([\d.]+)$/);
    if (m) return parseFloat(m[1]);
    return null;
  }

  function distanceText(v) {
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(str(v))) {
      var meters = Number(v);
      if (meters >= 1000) return (Math.round(meters / 100) / 10) + 'km';
      return Math.round(meters) + 'm';
    }
    return str(v);
  }

  function pick() {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (v !== null && v !== undefined && v !== '') return v;
    }
    return '';
  }

  function asArray(v) {
    return Array.isArray(v) ? v : [];
  }

  /* ------------------------------ 美团 ------------------------------ */

  /**
   * 美团到店团购商品（click.meituan.com/cps/ai/product/searchProductByAgent）
   * DEBUG: 字段名以线上返回为准，这里做了多别名兜底；接入真实数据后
   *        建议把第一次的真实响应脱敏存到 backend/test/fixtures/ 做回归。
   */
  function normalizeMeituanProduct(item, ctx) {
    ctx = ctx || {};
    if (!item || typeof item !== 'object') return null;
    var shop = item.poi || item.shop || item.shopInfo || {};
    var title = str(pick(item.productName, item.title, item.name, item.dealTitle));
    if (!title) return null;
    var tags = []
      .concat(asArray(item.tagList), asArray(item.tags), asArray(item.labels))
      .map(function (t) { return typeof t === 'string' ? t : str(t && (t.name || t.text || t.tagName)); })
      .filter(Boolean)
      .slice(0, 4);

    return {
      id: str(pick(item.productId, item.dealId, item.id)),
      source: 'meituan',
      shopId: str(pick(item.poiId, shop.id, shop.poiId)),
      shopName: str(pick(item.poiName, shop.name, item.shopName)),
      title: title,
      price: toYuan(pick(item.currentPrice, item.price, item.salePrice, item.priceText)),
      originPrice: toYuan(pick(item.originPrice, item.marketPrice, item.originalPrice)),
      soldText: str(pick(item.soldText, item.saleVolumeText, item.salesText)),
      distanceText: distanceText(pick(item.distanceText, item.distance)),
      cover: str(pick(item.imageUrl, item.picture, item.cover, item.image)),
      url: str(pick(item.dealUrl, item.jumpUrl, item.url)),
      tags: tags
    };
  }

  function normalizeMeituanShop(item) {
    if (!item || typeof item !== 'object') return null;
    var name = str(pick(item.poiName, item.shopName, item.name));
    if (!name) return null;
    return {
      id: str(pick(item.poiId, item.shopId, item.id)),
      source: 'meituan',
      name: name,
      category: str(pick(item.categoryName, item.category, item.cateName)),
      rating: num(pick(item.avgScore, item.score, item.rating)),
      reviewCount: num(pick(item.commentNum, item.reviewCount, item.commentCount)),
      avgPrice: num(pick(item.avgPrice, item.perCapita, item.price)),
      distanceText: distanceText(pick(item.distanceText, item.distance)),
      address: str(pick(item.address, item.poiAddress)),
      cover: str(pick(item.imageUrl, item.frontImg, item.cover)),
      url: str(pick(item.shopUrl, item.jumpUrl, item.url)),
      tags: asArray(item.tagList || item.tags).map(function (t) {
        return typeof t === 'string' ? t : str(t && (t.name || t.text));
      }).filter(Boolean).slice(0, 4)
    };
  }

  /** 美团酒旅（mcp-open-cater openapi）返回的是自然语言，只能尽量提取卡片 */
  function normalizeMeituanTravel(payload) {
    var text = str(pick(payload && payload.result, payload && payload.data, payload && payload.reply));
    var shops = [];
    var re = /(?:^|\n)\s*(?:\d+[.、)]\s*)?([^\n：:]{2,30}?)(?:[（(]\s*([\d.]+)\s*分?\s*[)）])?\s*(?:[¥￥]\s*([\d.]+))?/g;
    var m;
    var guard = 0;
    while ((m = re.exec(text)) && guard < 8) {
      guard++;
      var name = str(m[1]).replace(/^[-*\s]+/, '');
      if (!name || /^(推荐|结果|总之|综上|酒店|景点)$/.test(name)) continue;
      shops.push({
        id: 'travel-' + guard,
        source: 'meituan',
        name: name,
        category: '酒旅',
        rating: num(m[2]),
        reviewCount: 0,
        avgPrice: num(m[3]),
        distanceText: '',
        address: '',
        cover: '',
        url: '',
        tags: ['酒旅']
      });
    }
    return { text: text, shops: shops.slice(0, 6) };
  }

  /* ------------------------------ 闪购 ------------------------------ */

  /**
   * 淘宝闪购（原饿了么）零售开放平台 RPC 结果
   * 商家侧商品结构：id / name / price(分) / originalPrice / stock / categoryId
   */
  function normalizeShangouProduct(item, ctx) {
    ctx = ctx || {};
    if (!item || typeof item !== 'object') return null;
    var title = str(pick(item.name, item.title, item.productName));
    if (!title) return null;
    return {
      id: str(pick(item.id, item.itemId, item.skuId)),
      source: 'shangou',
      shopId: str(pick(item.shopId, ctx.shopId)),
      shopName: str(pick(item.shopName, ctx.shopName)),
      title: title,
      price: toYuan(pick(item.price, item.salePrice)),
      originPrice: toYuan(pick(item.originalPrice, item.originPrice)),
      soldText: str(pick(item.monthSaled, item.soldText)),
      distanceText: '',
      cover: str(pick(item.imageUrl, item.image, item.picture)),
      url: '',
      tags: asArray(item.labels || item.tags).map(str).filter(Boolean).slice(0, 4)
    };
  }

  function normalizeShangouShop(item) {
    if (!item || typeof item !== 'object') return null;
    var name = str(pick(item.shopName, item.name));
    if (!name) return null;
    return {
      id: str(pick(item.shopId, item.id)),
      source: 'shangou',
      name: name,
      category: str(pick(item.categoryName, item.category)),
      rating: num(item.rating),
      reviewCount: 0,
      avgPrice: 0,
      distanceText: '',
      address: str(item.address),
      cover: str(pick(item.logo, item.image)),
      url: '',
      tags: ['闪购']
    };
  }

  /* ------------------------------ 工具 ------------------------------ */

  function normalizeList(list, fn, ctx) {
    var out = [];
    asArray(list).forEach(function (item) {
      var n = fn(item, ctx);
      if (n) out.push(n);
    });
    return out;
  }

  /** 按距离升序；无距离的排最后 */
  function sortByDistance(list) {
    return list.slice().sort(function (a, b) {
      var ma = toMeters(a.distanceText);
      var mb = toMeters(b.distanceText);
      if (ma === null && mb === null) return 0;
      if (ma === null) return 1;
      if (mb === null) return -1;
      return ma - mb;
    });
  }

  /** 去重（同 source + id 或同标题） */
  function dedupe(list) {
    var seen = {};
    return list.filter(function (x) {
      var key = (x.source || '') + '|' + (x.id || x.title || x.name);
      if (seen[key]) return false;
      seen[key] = 1;
      return true;
    });
  }

  var api = {
    SOURCE_META: SOURCE_META,
    money: money,
    toYuan: toYuan,
    toMeters: toMeters,
    distanceText: distanceText,
    normalizeMeituanProduct: normalizeMeituanProduct,
    normalizeMeituanShop: normalizeMeituanShop,
    normalizeMeituanTravel: normalizeMeituanTravel,
    normalizeShangouProduct: normalizeShangouProduct,
    normalizeShangouShop: normalizeShangouShop,
    normalizeList: normalizeList,
    sortByDistance: sortByDistance,
    dedupe: dedupe
  };

  global.ShiqianNormalizer = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
