(function () {
  function getServiceBase() {
    if (location.protocol === 'file:' || !location.origin || location.origin === 'null') {
      return 'http://127.0.0.1:6137';
    }
    if (location.hostname === '127.0.0.1' || location.hostname === 'localhost') {
      return location.origin;
    }
    return 'http://127.0.0.1:6137';
  }

  async function fetchJson(url, options) {
    const response = await fetch(url, options);
    let data = null;
    try { data = await response.json(); } catch (_) {}
    return { response, data };
  }

  function create() {
    const apiUrl = (path) => `${getServiceBase()}${path}`;
    const postJson = (path, payload) => fetchJson(apiUrl(path), {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload || {})
    });

    return {
      capabilities: {
        mode: 'local',
        cloudRoutes: false,
        sharedScenes: false,
        serverExport: true,
        editableMapConfig: true
      },
      getServiceBase,
      fetchJson,
      apiUrl,
      routeAssetBase(item) {
        const fileBase = item.fileBase || item.safeName;
        return `${getServiceBase()}/route/${encodeURIComponent(item.safeName)}/${encodeURIComponent(fileBase)}`;
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
      saveScenic(payload) {
        return postJson('/api/scenic', payload);
      },
      listRoutes() {
        return fetchJson(apiUrl('/api/routes'));
      },
      exportRoute(payload) {
        return postJson('/api/export-route', payload);
      },
      getExportProgress() {
        return fetchJson(apiUrl(`/api/export-progress?t=${Date.now()}`));
      },
      cancelExport() {
        return fetchJson(apiUrl('/api/export-cancel'), {method: 'POST'});
      }
    };
  }

  window.LocalServiceClient = { create, getServiceBase, fetchJson };
})();
