const clean = (value) => String(value || '').trim();
const env = import.meta.env;
const config = {
  siteName: clean(env.VITE_SITE_NAME) || '山河路书',
  amapKey: clean(env.VITE_AMAP_KEY),
  amapSecurityJsCode: clean(env.VITE_AMAP_SECURITY_JS_CODE),
};

async function loadProxyIdentity() {
  try {
    const response = await fetch('/api/session', {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {'Accept': 'application/json'},
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok || !data.email) {
      return {
        user: null,
        error: data?.message || `身份信息不可用（HTTP ${response.status}）`,
      };
    }
    const email = clean(data.email).toLowerCase();
    return {
      user: {id: email, email},
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
  mode: 'proxy',
  config,
  user: identity.user,
  identityError: identity.error,
  identitySource: identity.source || '',
  isAdmin: Boolean(identity.isAdmin),
  capabilities: identity.capabilities || null,
};

document.body.classList.add('app-ready');
const accountEmail = document.getElementById('accountEmail');
if (accountEmail) {
  accountEmail.textContent = identity.user?.email || '未识别用户';
  accountEmail.title = identity.error || identity.user?.email || '';
  accountEmail.dataset.state = identity.user ? 'ready' : 'error';
}
const accountMode = document.getElementById('accountMode');
if (accountMode) accountMode.textContent = identity.user ? 'Caddy 身份代理' : '身份头缺失';

await import('./config/amapConfig.js');
await import('./api/localServiceClient.js');
await import('./api/appServiceClient.js');
await import('./map/mapProvider.js');
await import('./map/amapProvider.js');
await import('./domain/routeModel.js');
await import('./utils/format.js');
await import('./utils/html.js');
await import('./state/routeBookStore.js');
await import('./ui/feedback.js');
await import('./ui/routeRenderer.js');
await import('./features/scenic/scenicController.js');
await import('./features/export/exportTaskController.js');
await import('./features/map/routeMapController.js');
await import('./features/search/placeSearchController.js');
await import('./features/archive/archiveController.js');
await import('./features/point/pointEditorController.js');
await import('./features/export/videoDataBuilder.js');
await import('./main.js');
