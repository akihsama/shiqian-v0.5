/**
 * 平台适配器（Client）：统一调用后端 /v1/*
 * ---------------------------------------------------------------
 * 前端永远只打自己的 Worker，不打美团 / 闪购的域名：
 *   - 跳域与鉴权统一在服务端处理，Key 不进浏览器
 *   - 单个平台挂了不影响另一个（Promise.allSettled 逐个降级）
 *   - 所有响应都过 Normalizer，前端拿到的永远是同一套结构
 *
 * v0.5.1：多地址自动回退。Worker 地址失效（404 / 连不上 / 返回非 JSON）时
 * 依次改试备用地址与同源 /api，全部不可达才抛错让上层降级本地食神。
 * 成功过的地址记进 sessionStorage，同一会话内不再重复试错。
 */
(function (global) {
  'use strict';

  var DEFAULT_TIMEOUT = 15000;

  var config = {
    baseUrl: '',        // 默认同源 /api；跳域部署时在 index.html 里改成 Worker 地址
    altBaseUrls: [],    // 备用地址列表，按顺序尝试，全部失败才降级本地
    timeoutMs: DEFAULT_TIMEOUT,
    mock: false         // mock=true 时完全走本地示例数据，方便离线预览
  };

  var STICKY_KEY = 'shiqian.apiBase';   // 记住哪个地址最后一次成功，避免每次先撞超时

  function configure(opts) {
    if (!opts) return config;
    Object.keys(opts).forEach(function (k) {
      if (opts[k] !== undefined && opts[k] !== null && opts[k] !== '') config[k] = opts[k];
    });
    return config;
  }

  function normalizeBase(base) {
    return (base || '').replace(/\/+$/, '');
  }

  /** 候选地址：优先上次成功的，其次 baseUrl，然后备用列表，最后同源。 */
  function candidateBases() {
    var list = [];
    var sticky = null;
    try { sticky = sessionStorage.getItem(STICKY_KEY); } catch (e) {}
    if (sticky === '.') sticky = '';            // 哨兵值：上次用同源成功
    if (sticky !== null) list.push(normalizeBase(sticky));
    list.push(normalizeBase(config.baseUrl));
    (config.altBaseUrls || []).forEach(function (b) { list.push(normalizeBase(b)); });
    list.push('');   // 同源 /api 兜底

    var seen = {};
    return list.filter(function (b) {
      if (Object.prototype.hasOwnProperty.call(seen, b)) return false;
      seen[b] = true;
      return true;
    });
  }

  function rememberBase(base) {
    // 同源（空串）也值得记住：用哨兵值区分「没记过」和「记住用同源」
    try { sessionStorage.setItem(STICKY_KEY, base || '.'); } catch (e) {}
  }

  function requestOnce(base, path, body, timeoutMs) {
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = controller
      ? setTimeout(function () { controller.abort(); }, timeoutMs || config.timeoutMs)
      : null;

    var init = {
      method: body ? 'POST' : 'GET',
      headers: { Accept: 'application/json' },
      signal: controller ? controller.signal : undefined
    };
    if (body) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    return fetch(base + path, init)
      .then(function (res) {
        return res.text().then(function (raw) {
          var data = {};
          try { data = raw ? JSON.parse(raw) : {}; } catch (e) {
            // 返回的不是 JSON（常见于 Pages 把未命中路径回落到 index.html）
            var err0 = new Error('返回内容不是 JSON');
            err0.status = res.status;
            err0.code = 'NOT_JSON';
            throw err0;
          }
          if (!res.ok) {
            var err = new Error(data.error || data.msg || ('请求失败 ' + res.status));
            err.status = res.status;
            err.code = data.code || data.reason;
            err.payload = data;
            throw err;
          }
          return data;
        });
      })
      .finally(function () { if (timer) clearTimeout(timer); });
  }

  /** 哪些错误值得换个地址重试：地址根本连不上、或路径不存在。 */
  function isAddressError(e) {
    if (!e) return false;
    if (e.code === 'NOT_JSON') return true;
    var s = e.status;
    return s === 404 || s === 0 || s === undefined;   // undefined = fetch 直接 reject
  }

  function request(path, body, timeoutMs) {
    var bases = candidateBases();
    var i = 0;
    var lastErr = null;

    function next() {
      if (i >= bases.length) throw lastErr || new Error('后端不可用');
      var base = bases[i++];
      return requestOnce(base, path, body, timeoutMs).then(
        function (data) {
          rememberBase(base);
          return data;
        },
        function (err) {
          lastErr = err;
          if (!isAddressError(err)) throw err;   // 业务错误（403/429/503）不再换地址
          return next();
        }
      );
    }

    return Promise.resolve().then(next);
  }

  /* ---------------------------- 健康检查 ---------------------------- */
  function health() {
    return request('/v1/health').catch(function (e) {
      return { ok: false, error: e.message, platforms: {} };
    });
  }

  /* ---------------------------- 平台数据 ---------------------------- */
  /**
   * 附近团购 / 商品。两平台并发，任一失败只影响自己那一块。
   * @returns {Promise<{products:Product[], shops:Shop[], sources:{meituan:string, shangou:string}}>}
   */
  function nearby(params) {
    params = params || {};
    if (config.mock) return Promise.resolve(global.SHIQIAN_MOCK ? global.SHIQIAN_MOCK.nearby(params) : emptyResult());

    var body = {
      city: params.city,
      cityId: params.cityId,
      lat: params.lat,
      lng: params.lng,
      keyword: params.keyword || '',
      sources: params.sources || ['meituan', 'shangou'],
      limit: params.limit || 12
    };

    return request('/v1/platform/nearby', body, params.timeoutMs || 20000)
      .catch(function (e) {
        var r = emptyResult();
        r.sources = { meituan: 'error', shangou: 'error' };
        r.error = e.message;
        return r;
      })
      .then(function (payload) {
        var N = global.ShiqianNormalizer;
        return {
          products: N.dedupe(N.sortByDistance(payload.products || [])),
          shops: N.dedupe(N.sortByDistance(payload.shops || [])),
          sources: payload.sources || {},
          errors: payload.errors || {},
          city: payload.city || params.city,
          located: !!payload.located
        };
      });
  }

  function emptyResult() {
    return { products: [], shops: [], sources: {}, errors: {} };
  }

  /* ------------------------------ AI ------------------------------ */
  /**
   * 问食神。后端默认用智谱 glm-4.7-flash 出签（免费），
   * 若配了 DeepSeek Key 并可联网，会先搜实时信息再出签。
   * @returns {Promise<{reply:string, foodName?:string, recommend?:Object, sources?:Array, model?:string, usage?:Object}>}
   */
  function chat(payload) {
    if (config.mock) {
      return new Promise(function (resolve) {
        setTimeout(function () {
          resolve({
            reply: '（示例模式）今天就吃【牛肉面】吧，热汤下肚，一切好说。',
            foodName: '牛肉面',
            model: 'mock',
            provider: 'local',
            sources: []
          });
        }, 600);
      });
    }
    return request('/v1/chat', payload, payload && payload.timeoutMs ? payload.timeoutMs : 40000);
  }

  global.ShiqianApi = {
    configure: configure,
    config: config,
    health: health,
    nearby: nearby,
    chat: chat
  };
})(window);
