(function () {
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem('amap-planner-config') || '{}'); } catch (_) {}
      window.AMAP_PLANNER_CONFIG = {
        key: (saved.key || '').trim(),
        securityJsCode: (saved.securityJsCode || '').trim()
      };
      if (window.AMAP_PLANNER_CONFIG.securityJsCode) {
        window._AMapSecurityConfig = { securityJsCode: window.AMAP_PLANNER_CONFIG.securityJsCode };
      }
    })();
