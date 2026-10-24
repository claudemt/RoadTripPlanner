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
    const MEMORY_CACHE_LIMIT = 40;
    const DISK_ENTRY_LIMIT_CHARS = 200000;
    const memory = new Map();
    const pending = new Map();
    let lastExportTaskId = null;
    const cacheKey = (path) => cachePrefix + path;
    const remember = (path, entry) => {
      memory.delete(path);
      memory.set(path, entry);
      while (memory.size > MEMORY_CACHE_LIMIT) memory.delete(memory.keys().next().value);
    };
    const readCache = (path, maxAgeMs) => {
      const cached = memory.get(path);
      if (cached && (!maxAgeMs || Date.now() - cached.savedAt <= maxAgeMs)) return cached.payload;
      try {
        const stored = JSON.parse(localStorage.getItem(cacheKey(path)) || 'null');
        if (!stored || !stored.savedAt) return null;
        if (maxAgeMs && Date.now() - Number(stored.savedAt) > maxAgeMs) return null;
        const entry = {savedAt: Number(stored.savedAt), payload: stored.payload || null};
        remember(path, entry);
        return entry.payload;
      } catch (_) {
        return null;
      }
    };
    const writeCache = (path, payload) => {
      const entry = {
        savedAt: Date.now(),
        payload: {
          response: {
            ok: Boolean(payload?.response?.ok),
            status: Number(payload?.response?.status || 0)
          },
          data: payload?.data || null
        }
      };
      remember(path, entry);
      try {
        const json = JSON.stringify(entry);
        if (json.length > DISK_ENTRY_LIMIT_CHARS) return;
        localStorage.setItem(cacheKey(path), json);
      } catch (_) {}
    };
    const clearCache = (patterns = []) => {
      try {
        [...memory.keys()]
          .filter((path) => !patterns.length || patterns.some((pattern) => path.includes(pattern)))
          .forEach((path) => memory.delete(path));
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
      if (result.response.ok) clearCache(['/api/v1/routes', '/api/v1/published-routes', '/api/v1/spots']);
      return result;
    });
    const capabilities = {
      mode: runtime.mode || 'proxy',
      cloudRoutes: Boolean(runtime.capabilities?.cloudRoutes),
      sharedScenes: runtime.capabilities?.sharedScenes !== false,
      serverExport: runtime.capabilities?.serverExport !== false,
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
        return cachedGet('/api/v1/health', {ttl: 15000});
      },
      getConfig() {
        return cachedGet('/api/v1/config', {ttl: 60 * 60 * 1000});
      },
      saveConfig(config) {
        return postJson('/api/v1/config', config);
      },
      pointInfo(payload) {
        return postJson('/api/v1/point-info', payload);
      },
      getProfile(email = '', options = {}) {
        return cachedGet(email
          ? `/api/v1/profiles/${encodeURIComponent(email)}`
          : '/api/v1/profile', {ttl: 5 * 60 * 1000, ...options});
      },
      saveProfile(profile) {
        return fetchJson(apiUrl('/api/v1/profile'), {
          method: 'PUT',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(profile || {}),
        });
      },
      listCommunityMessages(limit = 100) {
        return fetchJson(apiUrl(`/api/v1/community/messages?limit=${encodeURIComponent(limit)}`));
      },
      listDirectMessages(email, limit = 100) {
        return fetchJson(apiUrl(`/api/v1/community/direct/${encodeURIComponent(email || '')}/messages?limit=${encodeURIComponent(limit)}`));
      },
      postCommunityMessage(message) {
        return postJson('/api/v1/community/messages', message);
      },
      withdrawCommunityMessage(messageId) {
        return fetchJson(apiUrl(`/api/v1/community/messages/${encodeURIComponent(messageId)}`), {method: 'DELETE'});
      },
      saveRoute(routeData, mapLayer) {
        return postJson('/api/v1/routes', {routeData, mapLayer});
      },
      deleteRoute(routeId) {
        return fetchJson(apiUrl(`/api/v1/routes/${encodeURIComponent(routeId)}`), {method: 'DELETE'}).then((result) => {
          if (result.response.ok) clearCache(['/api/v1/routes']);
          return result;
        });
      },
      routeProductZipUrl(routeId) {
        return apiUrl(`/api/v1/routes/${encodeURIComponent(routeId)}/product.zip`);
      },
      publishedRouteProductZipUrl(routeId) {
        return apiUrl(`/api/v1/published-routes/${encodeURIComponent(routeId)}/product.zip`);
      },
      getScenic(name, options = {}) {
        return cachedGet(`/api/v1/spots/public?name=${encodeURIComponent(name || '')}`, {ttl: 10 * 60 * 1000, ...options});
      },
      saveScenic(payload) {
        return fetchJson(apiUrl('/api/v1/spots/public'), {
          method: 'PUT',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(payload || {}),
        }).then((result) => {
          if (result.response.ok) clearCache(['/api/v1/spots/public']);
          return result;
        });
      },
      listScenes() {
        return cachedGet('/api/v1/spots/public', {ttl: 10 * 60 * 1000});
      },
      listUserScenes(options = {}) {
        return cachedGet('/api/v1/spots/private', {ttl: 5 * 60 * 1000, ...options});
      },
      saveUserScene(payload) {
        return fetchJson(apiUrl('/api/v1/spots/private'), {
          method: 'PUT',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(payload || {}),
        }).then((result) => {
          if (result.response.ok) clearCache(['/api/v1/spots/private']);
          return result;
        });
      },
      importScene(name) {
        return postJson('/api/v1/spots/private/import', {name});
      },
      deleteUserScene(sceneId) {
        return fetchJson(apiUrl(`/api/v1/spots/private/${encodeURIComponent(sceneId)}`), {method: 'DELETE'}).then((result) => {
          if (result.response.ok) clearCache(['/api/v1/spots']);
          return result;
        });
      },
      listScenicRevisions(name) {
        return fetchJson(apiUrl(`/api/v1/spots/public/revisions?name=${encodeURIComponent(name || '')}`));
      },
      deleteScenic(name) {
        return fetchJson(apiUrl(`/api/v1/spots/public?name=${encodeURIComponent(name || '')}`), {method: 'DELETE'}).then((result) => {
          if (result.response.ok) clearCache(['/api/v1/spots/public']);
          return result;
        });
      },
      listRoutes(options = {}) {

        return cachedGet('/api/v1/routes?summary=1', {ttl: 5 * 60 * 1000, ...options});
      },
      getRoute(routeId) {
        if (!routeId) return Promise.resolve({response: {ok: false, status: 400}, data: {ok: false, message: '缺少路线 ID'}});
        return fetchJson(apiUrl(`/api/v1/routes/${encodeURIComponent(routeId)}`));
      },
      listPublishedRoutes(options = {}) {
        return cachedGet('/api/v1/published-routes', {ttl: 15 * 60 * 1000, ...options});
      },
      publishRoute(routeData, mapLayer, extra = {}) {
        return postJson('/api/v1/published-routes', {routeData, mapLayer, ...extra});
      },
      importPublishedRoute(routeId) {
        return fetchJson(apiUrl(`/api/v1/published-routes/${encodeURIComponent(routeId)}/import`), {method: 'POST'});
      },
      deletePublishedRoute(routeId) {
        return fetchJson(apiUrl(`/api/v1/published-routes/${encodeURIComponent(routeId)}`), {method: 'DELETE'}).then((result) => {
          if (result.response.ok) clearCache(['/api/v1/published-routes']);
          return result;
        });
      },
      adminSummary() {
        return fetchJson(apiUrl('/api/v1/admin/summary'));
      },
      exportRoute(payload) {
        const routeId = payload?.routeData?.id || payload?.route?.id;
        return postJson(`/api/v1/routes/${encodeURIComponent(routeId || '')}/export`, payload).then((result) => {
          if (result.data?.taskId) lastExportTaskId = result.data.taskId;
          return result;
        });
      },
      getExportProgress() {
        if (!lastExportTaskId) return Promise.resolve({response: {ok: false, status: 409}, data: {ok: false, message: '尚未创建导出任务。'}});
        return fetchJson(apiUrl(`/api/v1/exports/${encodeURIComponent(lastExportTaskId)}`));
      },
      cancelExport() {
        if (!lastExportTaskId) return Promise.resolve({response: {ok: false, status: 409}, data: {ok: false, message: '尚未创建导出任务。'}});
        return fetchJson(apiUrl(`/api/v1/exports/${encodeURIComponent(lastExportTaskId)}/cancel`), {method: 'POST'});
      },
    };
  }

  window.LocalServiceClient = {create};
})();
