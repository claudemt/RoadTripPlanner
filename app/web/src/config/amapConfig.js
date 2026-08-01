(function () {
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem('amap-planner-config') || '{}'); } catch (_) {}
      const runtime = window.APP_RUNTIME?.config || {};
      window.AMAP_PLANNER_CONFIG = {
        key: (runtime.amapKey || saved.key || '').trim(),
        securityJsCode: (runtime.amapSecurityJsCode || saved.securityJsCode || '').trim()
      };
      if (window.AMAP_PLANNER_CONFIG.securityJsCode) {
        window._AMapSecurityConfig = { securityJsCode: window.AMAP_PLANNER_CONFIG.securityJsCode };
      }
    })();
