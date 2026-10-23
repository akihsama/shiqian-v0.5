/**
 * 离线示例数据（仅 ShiqianApi.config.mock === true 时使用）
 * ---------------------------------------------------------------
 * 作用：没有后端、没有平台凭证时，也能看到完整 UI 形态。
 * 生产部署请把 client.js 里的 mock 设为 false。
 * 这里的文案是示例，不是真实商品，不会产生任何下单行为。
 */
(function (global) {
  'use strict';

  var SHOPS = [
    { id: 'm1', source: 'meituan', name: '老街牛肉面', category: '面馆', rating: 4.7, reviewCount: 2314, avgPrice: 26, distanceText: '480m', address: '示例路 18 号', tags: ['人气'] },
    { id: 'm2', source: 'meituan', name: '巷口小笼', category: '本帮小吃', rating: 4.6, reviewCount: 1180, avgPrice: 22, distanceText: '820m', tags: [] },
    { id: 's1', source: 'shangou', name: '闪电火锅（示例店）', category: '火锅', rating: 4.5, reviewCount: 0, avgPrice: 88, distanceText: '1.4km', tags: ['闪购'] }
  ];

  var PRODUCTS = [
    { id: 'p1', source: 'meituan', shopName: '老街牛肉面', title: '招牌红烧牛肉面 单人餐', price: 19.9, originPrice: 32, distanceText: '480m', soldText: '月售 3200+', tags: ['免预约'] },
    { id: 'p2', source: 'meituan', shopName: '巷口小笼', title: '鲜肉小笼 12 只 + 豆浆', price: 25, originPrice: 36, distanceText: '820m', soldText: '月售 1800+' },
    { id: 'p3', source: 'shangou', shopName: '闪电火锅（示例店）', title: '双人堂食套餐（含锅底）', price: 159, originPrice: 238, soldText: '', distanceText: '1.4km' },
    { id: 'p4', source: 'meituan', shopName: '川味小馆', title: '酸菜鱼双人份', price: 58, originPrice: 88, distanceText: '2.1km', soldText: '月售 640' },
    { id: 'p5', source: 'shangou', shopName: '深夜食堂（示例店）', title: '日式咖喱猪排饭', price: 32, soldText: '', distanceText: '2.6km' }
  ];

  function filterByKeyword(list, kw) {
    if (!kw) return list.slice();
    var name = String(kw).replace(/[（(].*?[)）]/g, '').trim();
    var hit = list.filter(function (x) {
      var t = (x.title || '') + (x.name || '') + (x.shopName || '');
      return name && (t.indexOf(name) >= 0 || name.indexOf(x.name || x.title || '') >= 0);
    });
    return hit.length ? hit : list.slice();
  }

  global.SHIQIAN_MOCK = {
    nearby: function (params) {
      params = params || {};
      return {
        products: filterByKeyword(PRODUCTS, params.keyword),
        shops: filterByKeyword(SHOPS, params.keyword),
        sources: { meituan: 'ok', shangou: 'ok' },
        city: params.city,
        located: false,
        mock: true
      };
    },
    PRODUCTS: PRODUCTS,
    SHOPS: SHOPS
  };
})(window);
