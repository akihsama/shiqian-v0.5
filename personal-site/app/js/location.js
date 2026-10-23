/**
 * 定位与偏好（Location & Prefs）
 * ---------------------------------------------------------------
 * 只做三件事：
 *   1. 拿大致位置（优先 GPS，失败退回城市级近似坐标，绝不阻塞抽签）
 *   2. 记住用户选的城市
 *   3. 记住口味偏好，交给 AI 后端做推荐约束
 *
 * 坐标只用于"附近有什么"，不落任何服务端，隐私友好。
 */
(function (global) {
  'use strict';

  var CITY_DB = [
    { id: '1', name: '北京', lat: 39.9042, lng: 116.4074 },
    { id: '10', name: '上海', lat: 31.2304, lng: 121.4737 },
    { id: '20', name: '广州', lat: 23.1291, lng: 113.2644 },
    { id: '30', name: '深圳', lat: 22.5431, lng: 114.0579 },
    { id: '50', name: '杭州', lat: 30.2741, lng: 120.1551 },
    { id: '55', name: '南京', lat: 32.0603, lng: 118.7969 },
    { id: '60', name: '苏州', lat: 31.2989, lng: 120.5853 },
    { id: '90', name: '成都', lat: 30.5728, lng: 104.0668 },
    { id: '100', name: '重庆', lat: 29.5630, lng: 106.5516 },
    { id: '110', name: '武汉', lat: 30.5928, lng: 114.3055 },
    { id: '120', name: '西安', lat: 34.3416, lng: 108.9398 },
    { id: '140', name: '长沙', lat: 28.2282, lng: 112.9388 },
    { id: '150', name: '天津', lat: 39.3434, lng: 117.3616 },
    { id: '160', name: '青岛', lat: 36.0671, lng: 120.3826 },
    { id: '170', name: '厦门', lat: 24.4798, lng: 118.0894 },
    { id: '180', name: '哈尔滨', lat: 45.8038, lng: 126.5349 },
    { id: '190', name: '郑州', lat: 34.7466, lng: 113.6254 },
    { id: '210', name: '昆明', lat: 25.0389, lng: 102.7183 },
    { id: '230', name: '福州', lat: 26.0745, lng: 119.2965 }
  ];

  var LS_CITY = 'shiqian.city';
  var LS_GEO = 'shiqian.geo';
  var GEO_TTL = 30 * 60 * 1000; // 30 分钟内复用，避免反复弹授权

  function safeGet(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
  }
  function safeSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* 隐私模式忽略 */ }
  }

  function findCity(name) {
    if (!name) return null;
    var key = String(name).replace(/市$/, '');
    for (var i = 0; i < CITY_DB.length; i++) {
      if (CITY_DB[i].name === key) return CITY_DB[i];
    }
    return null;
  }

  function cityById(id) {
    for (var i = 0; i < CITY_DB.length; i++) {
      if (CITY_DB[i].id === String(id)) return CITY_DB[i];
    }
    return null;
  }

  var Prefs = {
    city: function () {
      var saved = safeGet(LS_CITY);
      if (saved && findCity(saved.name)) return findCity(saved.name);
      return CITY_DB[0];
    },
    setCity: function (name) {
      var c = findCity(name);
      if (!c) return null;
      // 换城市后缓存的 GPS 坐标失效
      try { localStorage.removeItem(LS_GEO); } catch (e) {}
      safeSet(LS_CITY, { name: c.name });
      return c;
    },
    list: function () { return CITY_DB.slice(); },

    geo: function () {
      var g = safeGet(LS_GEO);
      if (!g || !g.lat || !g.lng) return null;
      if (Date.now() - (g.at || 0) > GEO_TTL) return null;
      return g;
    },
    saveGeo: function (g) {
      if (!g || !g.lat || !g.lng) return;
      safeSet(LS_GEO, { lat: g.lat, lng: g.lng, at: Date.now(), precise: !!g.precise });
    },

    /** 当前用于查附近的位置：GPS 优先，否则城市中心 */
    current: function () {
      var g = this.geo();
      if (g) return { lat: g.lat, lng: g.lng, city: this.city(), precise: true };
      var c = this.city();
      return { lat: c.lat, lng: c.lng, city: c, precise: false };
    }
  };

  /**
   * 请求浏览器定位。resolve 的结果：
   *   { ok:true, lat, lng }  或  { ok:false, reason }
   * 注意：非 HTTPS 或用户拒绝都会走到 ok:false，此时调用方应继续用城市坐标。
   */
  function locate(options) {
    options = options || {};
    var timeout = options.timeout || 6000;
    return new Promise(function (resolve) {
      if (!navigator.geolocation) {
        resolve({ ok: false, reason: 'unsupported' });
        return;
      }
      var done = false;
      var timer = setTimeout(function () {
        if (!done) { done = true; resolve({ ok: false, reason: 'timeout' }); }
      }, timeout);

      navigator.geolocation.getCurrentPosition(
        function (pos) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          var g = { lat: pos.coords.latitude, lng: pos.coords.longitude, precise: true };
          Prefs.saveGeo(g);
          resolve({ ok: true, lat: g.lat, lng: g.lng });
        },
        function (err) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve({ ok: false, reason: { 1: 'denied', 2: 'unavailable', 3: 'timeout' }[err.code] || 'error' });
        },
        { enableHighAccuracy: false, timeout: timeout, maximumAge: GEO_TTL }
      );
    });
  }

  global.ShiqianPrefs = Prefs;
  global.ShiqianLocate = locate;
  global.SHIQIAN_CITIES = CITY_DB;
})(window);
