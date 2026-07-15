import {createClient} from '@supabase/supabase-js';
import {initAuthGate} from './auth/authController.js';

const clean = (value) => String(value || '').trim();
const env = import.meta.env;
const config = {
  siteName: clean(env.VITE_SITE_NAME) || '山河路书',
  supabaseUrl: clean(env.VITE_SUPABASE_URL),
  supabaseKey: clean(env.VITE_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY),
  amapKey: clean(env.VITE_AMAP_KEY),
  amapSecurityJsCode: clean(env.VITE_AMAP_SECURITY_JS_CODE),
};

const cloudConfigured = Boolean(config.supabaseUrl && config.supabaseKey);
const localHost = ['127.0.0.1', 'localhost'].includes(location.hostname);
const localServicePage = localHost && location.port === '6137';
const mode = cloudConfigured ? 'cloud' : localServicePage ? 'local' : 'preview';
const supabase = cloudConfigured
  ? createClient(config.supabaseUrl, config.supabaseKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;

window.APP_RUNTIME = {
  mode,
  config,
  supabase,
  user: null,
  cloudConfigured,
};

await import('./config/amapConfig.js');
await import('./api/localServiceClient.js');
await import('./api/cloudServiceClient.js');
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
await import('./features/account/accountCenterController.js');
await import('./features/point/pointEditorController.js');
await import('./features/export/videoDataBuilder.js');

const identity = await initAuthGate(window.APP_RUNTIME);
window.APP_RUNTIME.user = identity?.user || null;
await import('./main.js');
