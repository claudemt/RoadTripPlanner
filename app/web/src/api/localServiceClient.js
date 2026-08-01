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
    const cachePrefix = `roadtrip-api-cache:${runtime.user?.id || runtime.user?.email || runtime.mode || 'anonymous'}:`;
    const pending = new Map();
    const cacheKey = (path) => cachePrefix + path;
    const readCache = (path, maxAgeMs) => {
      try {
        const cached = JSON.parse(localStorage.getItem(cacheKey(path)) || 'null');
        if (!cached || !cached.savedAt) return null;
        if (maxAgeMs && Date.now() - Number(cached.savedAt) > maxAgeMs) return null;
        return cached.payload || null;
      } catch (_) {
        return null;
      }
    };
    const writeCache = (path, payload) => {
      try {
        localStorage.setItem(cacheKey(path), JSON.stringify({
          savedAt: Date.now(),
          payload: {
            response: {
              ok: Boolean(payload?.response?.ok),
              status: Number(payload?.response?.status || 0)
            },
            data: payload?.data || null
          }
        }));
      } catch (_) {}
    };
    const clearCache = (patterns = []) => {
      try {
        Object.keys(localStorage)
          .filter((key) => key.startsWith(cachePrefix))
          .filter((key) => !patterns.length || patterns.some((pattern) => key.includes(pattern)))
          .forEach((key) => localStorage.removeItem(key));
      } catch (_) {}
    };
    const cachedGet = async (path, {ttl = 60000, force = false, staleOnError = true} = {}) => {
      const cached = !force ? readCache(path, ttl) : null;
      if (cached) return cached;
      const key = `${path}:${force ? 'force' : 'normal'}`;
      if (pending.has(key)) return pending.get(key);
      const request = fetchJson(apiUrl(path))
        .then((result) => {
          if (result.response.ok && result.data) writeCache(path, result);
          return result;
        })
        .catch((error) => {
          const stale = staleOnError ? readCache(path, 0) : null;
          if (stale) return {...stale, stale: true, error};
          throw error;
        })
        .finally(() => pending.delete(key));
      pending.set(key, request);
      return request;
    };
    const postJson = (path, payload) => fetchJson(apiUrl(path), {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload || {}),
    }).then((result) => {
      if (result.response.ok) clearCache(['/api/routes', '/api/published-routes', '/api/scenic', '/api/scenes', '/api/user-scenes']);
      return result;
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
      routeAssetBase(item) {
        const fileBase = item.fileBase || item.safeName;
        const assetPath = String(item.assetPath || item.safeName || '')
          .split('/')
          .filter(Boolean)
          .map(encodeURIComponent)
          .join('/');
        return `${getServiceBase()}/route/${assetPath}/${encodeURIComponent(fileBase)}`;
      },
      health() {
        return cachedGet('/api/health', {ttl: 15000});
      },
      getConfig() {
        return cachedGet('/api/config', {ttl: 60 * 60 * 1000});
      },
      saveConfig(config) {
        return postJson('/api/config', config);
      },
      getProfile(email = '', options = {}) {
        return cachedGet(email
          ? `/api/profiles/${encodeURIComponent(email)}`
          : '/api/profile', {ttl: 5 * 60 * 1000, ...options});
      },
      saveProfile(profile) {
        return fetchJson(apiUrl('/api/profile'), {
          method: 'PUT',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(profile || {}),
        });
      },
      listCommunityMessages(limit = 100) {
        return fetchJson(apiUrl(`/api/community/messages?limit=${encodeURIComponent(limit)}`));
      },
      listDirectMessages(email, limit = 100) {
        return fetchJson(apiUrl(`/api/community/direct/${encodeURIComponent(email || '')}/messages?limit=${encodeURIComponent(limit)}`));
      },
      postCommunityMessage(message) {
        return postJson('/api/community/messages', message);
      },
      withdrawCommunityMessage(messageId) {
        return fetchJson(apiUrl(`/api/community/messages/${encodeURIComponent(messageId)}`), {method: 'DELETE'});
      },
      saveRoute(routeData, mapLayer) {
        return postJson('/api/routes', {routeData, mapLayer});
      },
      deleteRoute(routeId) {
        return fetchJson(apiUrl(`/api/routes/${encodeURIComponent(routeId)}`), {method: 'DELETE'}).then((result) => {
          if (result.response.ok) clearCache(['/api/routes']);
          return result;
        });
      },
      routeProductZipUrl(routeId) {
        return apiUrl(`/api/routes/${encodeURIComponent(routeId)}/product.zip`);
      },
      publishedRouteProductZipUrl(routeId) {
        return apiUrl(`/api/published-routes/${encodeURIComponent(routeId)}/product.zip`);
      },
      getScenic(name, options = {}) {
        return cachedGet(`/api/scenic?name=${encodeURIComponent(name || '')}`, {ttl: 10 * 60 * 1000, ...options});
      },
      saveScenic(payload) {
        return postJson('/api/scenic', payload);
      },
      listScenes() {
        return cachedGet('/api/scenes', {ttl: 10 * 60 * 1000});
      },
      listUserScenes(options = {}) {
        return cachedGet('/api/user-scenes', {ttl: 5 * 60 * 1000, ...options});
      },
      saveUserScene(payload) {
        return postJson('/api/user-scenes', payload);
      },
      importScene(name) {
        return postJson('/api/user-scenes/import', {name});
      },
      deleteUserScene(sceneId) {
        return fetchJson(apiUrl(`/api/user-scenes/${encodeURIComponent(sceneId)}`), {method: 'DELETE'}).then((result) => {
          if (result.response.ok) clearCache(['/api/scenic', '/api/scenes', '/api/user-scenes']);
          return result;
        });
      },
      listScenicRevisions(name) {
        return fetchJson(apiUrl(`/api/scenic-revisions?name=${encodeURIComponent(name || '')}`));
      },
      deleteScenic(name) {
        return fetchJson(apiUrl(`/api/scenic?name=${encodeURIComponent(name || '')}`), {method: 'DELETE'}).then((result) => {
          if (result.response.ok) clearCache(['/api/scenic', '/api/scenes']);
          return result;
        });
      },
      listRoutes(options = {}) {
        return cachedGet('/api/routes', {ttl: 5 * 60 * 1000, ...options});
      },
      listPublishedRoutes(options = {}) {
        return cachedGet('/api/published-routes', {ttl: 15 * 60 * 1000, ...options});
      },
      publishRoute(routeData, mapLayer, extra = {}) {
        return postJson('/api/published-routes', {routeData, mapLayer, ...extra});
      },
      importPublishedRoute(routeId) {
        return fetchJson(apiUrl(`/api/published-routes/${encodeURIComponent(routeId)}/import`), {method: 'POST'});
      },
      deletePublishedRoute(routeId) {
        return fetchJson(apiUrl(`/api/published-routes/${encodeURIComponent(routeId)}`), {method: 'DELETE'}).then((result) => {
          if (result.response.ok) clearCache(['/api/published-routes']);
          return result;
        });
      },
      adminSummary() {
        return fetchJson(apiUrl('/api/admin/summary'));
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

  window.LocalServiceClient = {create};
})();
