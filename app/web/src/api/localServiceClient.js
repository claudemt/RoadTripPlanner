(function () {
  function getServiceBase() {
    if (location.protocol === 'file:' || !location.origin || location.origin === 'null') {
      return 'http://127.0.0.1:6137';
    }
    return location.origin;
  }

  const ERROR_MESSAGE_LIMIT = 400;
  function cleanServiceMessage(value) {
    const text = String(value || '').trim();
    if (!text) return text;
    if (/<!doctype\s+html|<html[\s>]|<\/html>/i.test(text)) return '云端服务暂时不可用，请稍后重试。';
    if (/could not query the database|schema cache|database timeout|connection to the database|database is unavailable/i.test(text)) {
      return '云端服务暂时不可用，请稍后重试。';
    }
    return text.length > ERROR_MESSAGE_LIMIT ? `${text.slice(0, ERROR_MESSAGE_LIMIT)}…` : text;
  }
  function sanitizeTaskState(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
    let next = data;
    if (typeof data.message === 'string') {
      const message = cleanServiceMessage(data.message);
      if (message !== data.message) next = {...next, message};
    }
    if (typeof data.error === 'string') {
      const error = cleanServiceMessage(data.error);
      if (error !== data.error) next = {...next, error};
    }
    if (next.progress && typeof next.progress === 'object' && typeof next.progress.error === 'string') {
      const error = cleanServiceMessage(next.progress.error);
      if (error !== next.progress.error) next = {...next, progress: {...next.progress, error}};
    }
    if (next.result && typeof next.result === 'object') {
      const keys = ['videoError', 'pdfError', 'routeMapError', 'assetUploadError'];
      const result = {...next.result};
      let changed = false;
      keys.forEach((key) => {
        if (typeof result[key] !== 'string') return;
        const message = cleanServiceMessage(result[key]);
        if (message === result[key]) return;
        result[key] = message;
        changed = true;
      });
      if (changed) next = {...next, result};
    }
    return next;
  }
  function sanitizeServiceData(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
    let next = sanitizeTaskState(data);
    if (Array.isArray(next.tasks)) {
      const tasks = next.tasks.map(sanitizeTaskState);
      if (tasks.some((task, index) => task !== next.tasks[index])) next = {...next, tasks};
    }
    return next;
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
      cache: 'no-store',
      credentials: 'same-origin',
      ...options,
    });
    let data = null;
    try { data = sanitizeServiceData(await response.json()); } catch (_) {}
    return {response, data};
  }

  function uploadJson(url, payload, onProgress, method = 'POST') {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.withCredentials = true;
      xhr.timeout = 10 * 60 * 1000;
      if (typeof onProgress === 'function') {
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) onProgress(event.loaded, event.total);
        };
        xhr.upload.onload = () => onProgress(1, 1);
      }
      xhr.onload = () => {
        let data = null;
        try { data = sanitizeServiceData(JSON.parse(xhr.responseText || 'null')); } catch (_) {}
        resolve({
          response: {ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status},
          data,
        });
      };
      xhr.onerror = () => reject(new Error('网络连接失败，照片上传中断'));
      xhr.ontimeout = () => reject(new Error('照片上传超时，请检查网络'));
      xhr.send(JSON.stringify(payload || {}));
    });
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
    const postJson = (path, payload, invalidatePatterns = [], options = {}) => fetchJson(apiUrl(path), {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload || {}),
      ...options,
    }).then((result) => {
      if (result.response.ok && invalidatePatterns.length) clearCache(invalidatePatterns);
      return result;
    });
    const capabilities = {
      mode: runtime.mode || 'proxy',
      cloudRoutes: Boolean(runtime.capabilities?.cloudRoutes),
      sharedScenes: runtime.capabilities?.sharedScenes !== false,
      community: runtime.capabilities?.community !== false,
      localLibrary: Boolean(runtime.capabilities?.localLibrary),
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
        }).then((result) => {
          if (result.response.ok) clearCache(['/api/v1/profile', '/api/v1/profiles/']);
          return result;
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
        const options = {};
        if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
          options.signal = AbortSignal.timeout(20000);
        }
        return postJson('/api/v1/routes', {routeData, mapLayer}, ['/api/v1/routes'], options);
      },
      saveRouteView(routeId, view) {
        return fetchJson(apiUrl(`/api/v1/routes/${encodeURIComponent(routeId)}/view`), {
          method: 'PATCH',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({view: view || {}}),
        }).then((result) => {
          if (result.response.ok) clearCache([`/api/v1/routes/${encodeURIComponent(routeId)}`]);
          return result;
        });
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
      getRoute(routeId, options = {}) {
        if (!routeId) return Promise.resolve({response: {ok: false, status: 400}, data: {ok: false, message: '缺少路线 ID'}});
        return cachedGet(`/api/v1/routes/${encodeURIComponent(routeId)}`, {ttl: 5000, ...options});
      },
      publishedRouteProductZipUrl(routeId) {
        return apiUrl(`/api/v1/published-routes/${encodeURIComponent(routeId)}/product.zip`);
      },
      getScenic(name, options = {}) {
        return cachedGet(`/api/v1/spots/public?name=${encodeURIComponent(name || '')}`, {ttl: 10 * 60 * 1000, ...options});
      },
      saveScenic(payload, options = {}) {
        const request = typeof options.onProgress === 'function'
          ? uploadJson(apiUrl('/api/v1/spots/public'), payload, options.onProgress, 'PUT')
          : fetchJson(apiUrl('/api/v1/spots/public'), {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload || {}),
          });
        return request.then((result) => {
          if (result.response.ok) clearCache(['/api/v1/spots/public']);
          return result;
        });
      },
      listScenes() {
        return cachedGet('/api/v1/spots/public', {ttl: 30 * 60 * 1000});
      },
      listUserScenes(options = {}) {
        return cachedGet('/api/v1/spots/private', {ttl: 10 * 60 * 1000, ...options});
      },
      saveUserScene(payload, options = {}) {
        const request = typeof options.onProgress === 'function'
          ? uploadJson(apiUrl('/api/v1/spots/private'), payload, options.onProgress, 'PUT')
          : fetchJson(apiUrl('/api/v1/spots/private'), {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload || {}),
          });
        return request.then((result) => {
          if (result.response.ok) clearCache(['/api/v1/spots/private']);
          return result;
        });
      },
      importScene(name) {
        return postJson('/api/v1/spots/private/import', {name}, ['/api/v1/spots/private']);
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
        return cachedGet('/api/v1/routes?summary=1', {ttl: 10 * 60 * 1000, ...options});
      },
      listPublishedRoutes(options = {}) {
        return cachedGet('/api/v1/published-routes', {ttl: 5 * 60 * 1000, ...options});
      },
      getPublishedRoute(routeId, options = {}) {
        return cachedGet(`/api/v1/published-routes/${encodeURIComponent(routeId)}`, {ttl: 15000, ...options});
      },
      getPublishedRouteAssets(routeId, options = {}) {
        return cachedGet(`/api/v1/published-routes/${encodeURIComponent(routeId)}/assets`, {ttl: 15000, ...options});
      },
      publishRoute(routeData, mapLayer, extra = {}) {
        return postJson('/api/v1/published-routes', {routeData, mapLayer, ...extra}, ['/api/v1/published-routes', '/api/v1/routes']);
      },
      importPublishedRoute(routeId) {
        return fetchJson(apiUrl(`/api/v1/published-routes/${encodeURIComponent(routeId)}/import`), {method: 'POST'}).then((result) => {
          if (result.response.ok) clearCache(['/api/v1/routes']);
          return result;
        });
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
        return postJson(`/api/v1/routes/${encodeURIComponent(routeId || '')}/export`, payload, ['/api/v1/routes']).then((result) => {
          if (result.data?.taskId) lastExportTaskId = result.data.taskId;
          return result;
        });
      },
      listExports() {
        return fetchJson(apiUrl('/api/v1/exports'));
      },
      getExportProgress() {
        if (!lastExportTaskId) return Promise.resolve({response: {ok: false, status: 409}, data: {ok: false, message: '尚未创建导出任务。'}});
        return fetchJson(apiUrl(`/api/v1/exports/${encodeURIComponent(lastExportTaskId)}`));
      },
      cancelExport(taskId = lastExportTaskId) {
        if (!taskId) return Promise.resolve({response: {ok: false, status: 409}, data: {ok: false, message: '尚未创建导出任务。'}});
        return fetchJson(apiUrl(`/api/v1/exports/${encodeURIComponent(taskId)}/cancel`), {method: 'POST'});
      },
    };
  }

  window.LocalServiceClient = {create};
})();
