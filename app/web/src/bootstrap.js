const clean = (value) => String(value || '').trim();
const env = import.meta.env;
const config = {
  siteName: clean(env.VITE_SITE_NAME) || '山河路书',
  amapKey: clean(env.VITE_AMAP_KEY),
  amapSecurityJsCode: clean(env.VITE_AMAP_SECURITY_JS_CODE),
};

async function loadProxyIdentity() {
  try {
    const response = await fetch('/api/v1/session', {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {'Accept': 'application/json'},
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok || (!data.email && !data.local)) {
      return {
        user: null,
        error: data?.message || `身份信息不可用（HTTP ${response.status}）`,
      };
    }
    const email = clean(data.email).toLowerCase();
    const displayName = clean(data.displayName) || email || '本地使用';
    return {
      user: {id: email || 'local', email, displayName, local: Boolean(data.local)},
      error: null,
      source: data.source || '',
      isAdmin: Boolean(data.isAdmin),
      capabilities: data.capabilities || null,
    };
  } catch (error) {
    return {user: null, error: error?.message || '无法读取代理身份'};
  }
}

const identity = await loadProxyIdentity();
window.APP_RUNTIME = {
  config,
  user: identity.user,
  isAdmin: Boolean(identity.isAdmin),
  capabilities: identity.capabilities || null,
};

document.body.classList.add('app-ready');
const accountEmail = document.getElementById('accountEmail');
if (accountEmail) {
  accountEmail.textContent = identity.user?.displayName || identity.user?.email || '未识别用户';
  accountEmail.title = identity.error || identity.user?.email || '';
  accountEmail.dataset.state = identity.user ? 'ready' : 'error';
}
await import('./config/amapConfig.js');
await import('./api/localServiceClient.js');
await import('./api/routeSaveQueue.js');
await import('./map/mapProvider.js');
await import('./map/amapProvider.js');
await import('./map/roadProvider.js');
await import('./features/map/mapPresentation.js');
await import('./features/map/pointInfoController.js');
await import('./domain/routeModel.js');
await import('./utils/format.js');
await import('./utils/html.js');
await import('./utils/sort.js');
await import('./state/routeBookStore.js');
await import('./ui/feedback.js');
await import('./ui/dialogController.js');
await import('./ui/routeRenderer.js');
await import('./features/scenic/scenicController.js');
await import('./features/community/communityController.js');
await import('./features/export/exportTaskController.js');
await import('./features/export/musicController.js');
await import('./features/map/routeMapController.js');
await import('./features/search/placeSearchController.js');
await import('./features/archive/archiveController.js');
await import('./features/point/poiAliasStore.js');
await import('./features/point/pointEditorController.js');
await import('./features/export/videoDataBuilder.js');
await import('./main.js');
