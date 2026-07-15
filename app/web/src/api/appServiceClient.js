(function () {
  const response = (status = 200) => ({ok: status >= 200 && status < 300, status});

  function createPreviewService(runtime) {
    return {
      capabilities: {
        mode: 'preview',
        cloudRoutes: false,
        sharedScenes: false,
        serverExport: false,
        editableMapConfig: true,
      },
      routeAssetBase() {
        return '';
      },
      async health() {
        return {response: response(), data: {ok: true, mode: 'preview'}};
      },
      async getConfig() {
        const key = runtime.config?.amapKey || window.AMAP_PLANNER_CONFIG?.key || '';
        const securityJsCode = runtime.config?.amapSecurityJsCode || window.AMAP_PLANNER_CONFIG?.securityJsCode || '';
        return {
          response: response(),
          data: {ok: true, key, securityJsCode, configured: Boolean(key && securityJsCode), source: 'browser'},
        };
      },
      async saveConfig() {
        return {response: response(), data: {ok: true}};
      },
      async listRoutes() {
        return {response: response(), data: {ok: true, routes: []}};
      },
      async getScenic() {
        return {response: response(404), data: {ok: true, spot: null}};
      },
      async saveScenic(payload) {
        const images = (payload.images || []).map((image) => image.dataUrl).filter(Boolean);
        return {
          response: response(),
          data: {
            ok: true,
            folderName: payload.name,
            spot: {
              name: payload.name,
              title: payload.title || payload.name,
              description: payload.description || '',
              images,
            },
          },
        };
      },
      async getExportProgress() {
        return {response: response(), data: {ok: true, rendering: false}};
      },
      async cancelExport() {
        return {response: response(), data: {ok: true, cancelled: false}};
      },
    };
  }

  function create() {
    const runtime = window.APP_RUNTIME || {};
    if (runtime.mode === 'cloud') {
      return window.CloudServiceClient.create(runtime);
    }
    if (runtime.mode === 'preview') {
      return createPreviewService(runtime);
    }
    return window.LocalServiceClient.create();
  }

  window.AppServiceClient = {create};
})();
