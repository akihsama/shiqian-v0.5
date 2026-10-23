/**
 * 平台适配器（Client）：统一调用后端 /v1/*
 * ---------------------------------------------------------------
 * 前端永远只打自己的 Worker，不打美团 / 闪购的域名：
 *   - 跨域与鉴权统一在服务端处理，Key 不进浏览器
 *   - 单个平台挂了不影响另一个（Promise.allSettled 逐个降级）
 *   - 所有响应都过 Normalizer，前端拿到的永远是同一套结构
 */
(function (global) {
  'use strict';

  var DEFAULT_TIMEOUT = 15000;

  var config = {
    baseUrl: '',        // 默认同源 /api；跨域部署时在 index.html 里改成 Worker 地址
    timeoutMs: DEFAULT_TIMEOUT,
    mock: false         // mock=true 时完全走本地示例数据，方便离线预览
  };

  function configure(opts) {
    if (!opts) return config;
    Object.keys(opts).forEach(function (k) {
      if (opts[k] !== undefined && opts[k] !== null && opts[k] !== '') config[k] = opts[k];
    });
    return config;
  }

  function url(path) {
    var base = (config.baseUrl || '').replace(/\/+$/, '');
    return base + path;
  }

  function request(path, body, timeoutMs) {
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

    return fetch(url(path), init)
      .then(function (res) {
        return res.text().then(function (raw) {
          var data = {};
          try { data = raw ? JSON.parse(raw) : {}; } catch (e) { data = { error: raw.slice(0, 200) }; }
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
