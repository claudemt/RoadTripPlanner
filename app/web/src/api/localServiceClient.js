(function () {
  function getServiceBase() {
    if (location.protocol === 'file:' || !location.origin || location.origin === 'null') {
      return 'http://127.0.0.1:6137';
    }
    return location.origin;
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
      cache: 'no-store',
      credentials: 'same-origin',
      ...options,
    });
    let data = null;
    try { data = await response.json(); } catch (_) {}
    return {response, data};
  }

  function create(runtime = {}) {
    const apiUrl = (path) => `${getServiceBase()}${path}`;
    const postJson = (path, payload) => fetchJson(apiUrl(path), {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload || {}),
    });
    const capabilities = {
      mode: runtime.mode || 'proxy',
      cloudRoutes: Boolean(runtime.capabilities?.cloudRoutes),
      sharedScenes: runtime.capabilities?.sharedScenes !== false,
      serverExport: runtime.capabilities?.serverExport !== false,
      cloudExports: Boolean(runtime.capabilities?.cloudExports),
      editableMapConfig: runtime.capabilities?.editableMapConfig !== false,
      publishedRoutes: Boolean(runtime.capabilities?.publishedRoutes),
    };

    return {
      capabilities,
      getServiceBase,
      fetchJson,
      apiUrl,
      routeAssetBase(item) {
        const fileBase = item.fileBase || item.safeName;
        const assetPath = String(item.assetPath || item.safeName || '')
          .split('/')
          .filter(Boolean)
          .map(encodeURIComponent)
          .join('/');
        return `${getServiceBase()}/route/${assetPath}/${encodeURIComponent(fileBase)}`;
      },
      session() {
        return fetchJson(apiUrl('/api/session'));
      },
      health() {
        return fetchJson(apiUrl('/api/health'));
      },
      getConfig() {
        return fetchJson(apiUrl('/api/config'));
      },
      saveConfig(config) {
        return postJson('/api/config', config);
      },
      saveRoute(routeData, mapLayer) {
        return postJson('/api/routes', {routeData, mapLayer});
      },
      deleteRoute(routeId) {
        return fetchJson(apiUrl(`/api/routes/${encodeURIComponent(routeId)}`), {method: 'DELETE'});
      },
      routeProductZipUrl(routeId) {
        return apiUrl(`/api/routes/${encodeURIComponent(routeId)}/product.zip`);
      },
      publishedRouteProductZipUrl(routeId) {
        return apiUrl(`/api/published-routes/${encodeURIComponent(routeId)}/product.zip`);
      },
      getScenic(name) {
        return fetchJson(apiUrl(`/api/scenic?name=${encodeURIComponent(name || '')}`));
      },
      listScenes() {
        return fetchJson(apiUrl('/api/scenes'));
      },
      listScenicRevisions(name) {
        return fetchJson(apiUrl(`/api/scenic-revisions?name=${encodeURIComponent(name || '')}`));
      },
      saveScenic(payload) {
        return postJson('/api/scenic', payload);
      },
      deleteScenic(name) {
        return fetchJson(apiUrl(`/api/scenic?name=${encodeURIComponent(name || '')}`), {method: 'DELETE'});
      },
      listRoutes() {
        return fetchJson(apiUrl('/api/routes'));
      },
      listPublishedRoutes() {
        return fetchJson(apiUrl('/api/published-routes'));
      },
      publishRoute(routeData, mapLayer) {
        return postJson('/api/published-routes', {routeData, mapLayer});
      },
      importPublishedRoute(routeId) {
        return fetchJson(apiUrl(`/api/published-routes/${encodeURIComponent(routeId)}/import`), {method: 'POST'});
      },
      deletePublishedRoute(routeId) {
        return fetchJson(apiUrl(`/api/published-routes/${encodeURIComponent(routeId)}`), {method: 'DELETE'});
      },
      adminSummary() {
        return fetchJson(apiUrl('/api/admin/summary'));
      },
      ensurePublishedRouteZips() {
        return fetchJson(apiUrl('/api/admin/published-route-zips'), {method: 'POST'});
      },
      exportRoute(payload) {
        return postJson('/api/export-route', payload);
      },
      getExportProgress() {
        return fetchJson(apiUrl(`/api/export-progress?t=${Date.now()}`));
      },
      cancelExport() {
        return fetchJson(apiUrl('/api/export-cancel'), {method: 'POST'});
      },
    };
  }

  window.LocalServiceClient = {create, getServiceBase, fetchJson};
})();
