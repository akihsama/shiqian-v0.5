/**
 * 今日食签 · v0.5 平台面板（Pane）
 * ---------------------------------------------------------------
 * 只负责「渲染 + 交互」，不关心数据从哪来：
 *   - 数据来自 ShiqianApi.nearby()（后端聚合美团 / 闪购）
 *   - 结构由 ShiqianNormalizer 统一
 * 每次 Draw 之后，签筒摇出的菜名会作为 keyword 重新查一次附近，
 * 让"签"从一句话变成"能下单的具体商品"。
 */
(function (global) {
  'use strict';

  var state = {
    keyword: '',
    city: null,
    products: [],
    shops: [],
    sources: {},
    loading: false,
    located: false,
    tab: 'products',
    lastQueryAt: 0
  };

  var els = {};
  var RENDER_LIMIT = 6;

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function srcLabel(src) {
    var meta = (global.ShiqianNormalizer && global.ShiqianNormalizer.SOURCE_META[src]) || {};
    return meta.label || src;
  }

  function srcBadge(src, statusText) {
    if (statusText === 'ok') return '';
    var text = statusText === 'not_configured' ? '待配置'
      : statusText === 'empty' ? '无结果'
      : statusText === 'error' ? '不可用'
      : srcLabel(src);
    return '<span class="src-badge" data-state="' + esc(statusText || 'ok') + '">' + esc(srcLabel(src)) +
      (text === srcLabel(src) ? '' : ' · ' + esc(text)) + '</span>';
  }

  function empty(msg, hint) {
    return '<div class="pane-empty"><p>' + esc(msg) + '</p>' +
      (hint ? '<p class="pane-empty-hint">' + esc(hint) + '</p>' : '') + '</div>';
  }

  function cardProduct(p) {
    var priceHtml = p.price ? '<span class="p-price">' + esc(global.ShiqianNormalizer.money(p.price)) + '</span>' : '';
    var originHtml = p.originPrice && p.price && p.originPrice > p.price
      ? '<span class="p-origin">' + esc(global.ShiqianNormalizer.money(p.originPrice)) + '</span>' : '';
    var cover = p.cover
      ? '<img class="p-cover" src="' + esc(p.cover) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display=\'none\'">'
      : '<div class="p-cover p-cover-fallback">' + esc(srcLabel(p.source)) + '</div>';
    var meta = [p.shopName, p.distanceText, p.soldText].filter(Boolean).map(esc).join(' · ');
    return '' +
      '<article class="p-card" data-src="' + esc(p.source) + '">' +
      cover +
      '<div class="p-body">' +
      '<div class="p-title">' + esc(p.title) + '</div>' +
      (meta ? '<div class="p-meta">' + meta + '</div>' : '') +
      '<div class="p-foot">' +
      '<span class="p-price-wrap">' + priceHtml + originHtml + '</span>' +
      (p.url ? '<a class="p-go" href="' + esc(p.url) + '" target="_blank" rel="noopener nofollow">去下单 →</a>'
        : '<span class="p-go p-go-disabled">去平台查看</span>') +
      '</div>' +
      '<div class="p-tags">' + srcTag(p.source) + '</div>' +
      '</div>' +
      '</article>';
  }

  function srcTag(src) {
    return '<span class="src-tag" data-src="' + esc(src) + '">' + esc(srcLabel(src)) + '</span>';
  }

  function cardShop(s) {
    var meta = [s.category, s.rating ? s.rating.toFixed(1) + '分' : '', s.avgPrice ? '人均' + s.avgPrice : '', s.distanceText]
      .filter(Boolean).map(esc).join(' · ');
    return '' +
      '<article class="p-card p-card-shop" data-src="' + esc(s.source) + '">' +
      '<div class="p-body">' +
      '<div class="p-title">' + esc(s.name) + '</div>' +
      (meta ? '<div class="p-meta">' + meta + '</div>' : '') +
      (s.address ? '<div class="p-addr">' + esc(s.address) + '</div>' : '') +
      '<div class="p-foot">' +
      (s.url ? '<a class="p-go" href="' + esc(s.url) + '" target="_blank" rel="noopener nofollow">查看 →</a>' : '') +
      srcTag(s.source) +
      '</div>' +
      '</div>' +
      '</article>';
  }

  function renderStatus() {
    var box = els.status;
    if (!box) return;
    var bits = [];
    if (state.city) bits.push('<button class="chip" id="chipCity" type="button">📍 ' + esc(state.city.name) +
      (state.located ? '（已定位）' : '') + '</button>');
    ['meituan', 'shangou'].forEach(function (s) {
      var st = state.sources[s];
      if (st) bits.push(srcBadge(s, st));
    });
    box.innerHTML = bits.join('');
    var chip = $('chipCity');
    if (chip) chip.addEventListener('click', openCityPicker);
  }

  function render() {
    if (!els.list) return;
    renderStatus();

    if (state.loading) {
      els.list.innerHTML = Array.apply(null, Array(3)).map(function () {
        return '<div class="p-skel"></div>';
      }).join('');
      return;
    }

    var list = state.tab === 'products' ? state.products : state.shops;
    if (!list.length) {
      var hint = state.sources.meituan === 'not_configured' || state.sources.shangou === 'not_configured'
        ? '平台还没接上（后端缺 MEITUAN_TOKEN / SHANGOU_* 配置），现在先摇本地的签。'
        : '换个关键词，或稍后再试。';
      els.list.innerHTML = empty(state.keyword ? '「' + state.keyword + '」附近暂时没有结果' : '还没有附近数据', hint);
      return;
    }

    var html = list.slice(0, RENDER_LIMIT).map(state.tab === 'products' ? cardProduct : cardShop).join('');
    if (list.length > RENDER_LIMIT) {
      html += '<button class="pane-more" type="button" id="paneMore">查看更多（共 ' + list.length + ' 条）</button>';
    }
    els.list.innerHTML = html;

    var more = $('paneMore');
    if (more) {
      more.addEventListener('click', function () {
        els.list.innerHTML = list.map(state.tab === 'products' ? cardProduct : cardShop).join('');
      });
    }
  }

  function setTab(tab) {
    state.tab = tab;
    Array.prototype.forEach.call(document.querySelectorAll('[data-pane-tab]'), function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-pane-tab') === tab);
    });
    render();
  }

  /* ---------------------------- 城市选择 ---------------------------- */

  function closeCityPicker() {
    var old = $('cityPicker');
    if (old) old.remove();
    var mask = $('cityMask');
    if (mask) mask.remove();
  }

  function openCityPicker() {
    if ($('cityPicker')) { closeCityPicker(); return; }
    var cities = global.ShiqianPrefs.list();

    var mask = document.createElement('div');
    mask.id = 'cityMask';
    mask.className = 'city-mask';
    mask.addEventListener('click', closeCityPicker);

    var box = document.createElement('div');
    box.id = 'cityPicker';
    box.className = 'city-picker';
    box.innerHTML = '<div class="city-picker-head">选城市</div><div class="city-grid">' +
      cities.map(function (c) {
        return '<button type="button" class="city-item" data-city="' + esc(c.name) + '">' + esc(c.name) + '</button>';
      }).join('') + '</div>';
    document.body.appendChild(mask);
    document.body.appendChild(box);

    box.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-city]');
      if (!btn) return;
      var city = global.ShiqianPrefs.setCity(btn.getAttribute('data-city'));
      state.city = city;
      state.located = false;
      closeCityPicker();
      refresh('', { quiet: false });
    });
  }

  /* ------------------------------ 主流程 ------------------------------ */

  function refresh(keyword, opts) {
    opts = opts || {};
    if (typeof keyword === 'string') state.keyword = keyword;

    var pos = global.ShiqianPrefs.current();
    state.city = pos.city;
    state.located = !!pos.precise;

    // 本地演示模式或后端未配置时，不空转请求
    if (global.ShiqianApi.config.mock) {
      var mock = global.SHIQIAN_MOCK ? global.SHIQIAN_MOCK.nearby({ keyword: state.keyword, city: state.city.name }) : { products: [], shops: [], sources: {} };
      state.products = mock.products;
      state.shops = mock.shops;
      state.sources = mock.sources || {};
      render();
      return Promise.resolve(mock);
    }

    state.loading = true;
    render();

    return global.ShiqianApi.nearby({
      city: pos.city.name,
      cityId: pos.city.id,
      lat: pos.lat,
      lng: pos.lng,
      keyword: state.keyword
    }).then(function (res) {
      state.products = res.products || [];
      state.shops = res.shops || [];
      state.sources = res.sources || {};
      state.loading = false;
      state.lastQueryAt = Date.now();
      render();
      if (opts.onDone) opts.onDone(res);
      return res;
    });
  }

  /** 抽签后调用：用签上的菜名去查真实商品 */
  function searchByFood(foodName) {
    return refresh(foodName, { quiet: true });
  }

  function bind() {
    els.list = $('paneList');
    els.status = $('paneStatus');
    Array.prototype.forEach.call(document.querySelectorAll('[data-pane-tab]'), function (btn) {
      btn.addEventListener('click', function () { setTab(btn.getAttribute('data-pane-tab')); });
    });
    var re = $('paneRefresh');
    if (re) re.addEventListener('click', function () { refresh(state.keyword); });
    var geoBtn = $('paneLocate');
    if (geoBtn) {
      geoBtn.addEventListener('click', function () {
        geoBtn.disabled = true;
        global.ShiqianLocate().then(function (r) {
          geoBtn.disabled = false;
          if (!r.ok) {
            geoBtn.textContent = r.reason === 'denied' ? '定位被拒绝' : '定位不可用';
            setTimeout(function () { geoBtn.textContent = '精确定位'; }, 2500);
          }
          refresh(state.keyword);
        });
      });
    }
  }

  function init() {
    bind();
    state.city = global.ShiqianPrefs.city();
    render();
    // 静默尝试一次定位；失败也无所谓，用城市中心坐标
    global.ShiqianLocate({ timeout: 5000 }).then(function (r) {
      if (r.ok) {
        state.located = true;
        refresh(state.keyword);
      } else {
        refresh(state.keyword);
      }
    });
  }

  global.ShiqianPane = {
    init: init,
    refresh: refresh,
    searchByFood: searchByFood,
    setTab: setTab,
    state: state
  };
})(window);
