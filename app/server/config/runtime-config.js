const fs = require('fs');
const os = require('os');
const path = require('path');

const envText = (name, fallback = '') => String(process.env[name] ?? fallback).trim();
const envFlag = (name, fallback = false) => /^(1|true|yes|on)$/i.test(envText(name, fallback ? 'true' : 'false'));
const parseEnvFile = (file) => {
  const result = {};
  if (!fs.existsSync(file)) return result;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    result[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2').trim();
  }
  return result;
};
const loadEnvFile = (file) => {
  const values = parseEnvFile(file);
  for (const [name, value] of Object.entries(values)) {
    if (process.env[name] === undefined) process.env[name] = value;
  }
  return Object.keys(values).length;
};
const renderConcurrency = () => {
  const requested = Math.max(1, Number(envText('ROUTE_RENDER_CONCURRENCY', '4')) || 1);
  const cpuCount = Math.max(1, os.cpus().length || 1);
  const totalMemMb = Math.round(os.totalmem() / 1024 / 1024);
  const memoryBudget = Math.max(1, Math.floor(totalMemMb / 2048));
  return String(Math.max(1, Math.min(requested, Math.max(1, cpuCount - 1), memoryBudget)));
};

const createRuntimeConfig = (applicationRoot) => {
  const appRoot = path.resolve(applicationRoot);
  const projectRoot = path.dirname(appRoot);
  loadEnvFile(path.join(projectRoot, 'config', 'local.env'));
  const dataRoot = process.env.ROADTRIP_DATA_ROOT
    ? path.resolve(process.env.ROADTRIP_DATA_ROOT)
    : path.join(projectRoot, 'data');
  const configRoot = process.env.ROADTRIP_CONFIG_ROOT
    ? path.resolve(process.env.ROADTRIP_CONFIG_ROOT)
    : path.join(projectRoot, 'config');
  loadEnvFile(path.join(configRoot, 'local.env'));
  const remotionRoot = path.join(appRoot, 'video');
  const buildRoot = path.join(appRoot, 'dist');
  const sourceWebRoot = path.join(appRoot, 'web');

  return {
    amapRoot: projectRoot,
    dataRoot,
    configRoot,
    remotionRoot,
    remotionData: path.join(remotionRoot, 'src', 'projects', 'amap-route-video', 'data', 'route-video-data.json'),
    routeRoot: path.join(dataRoot, 'routes'),
    port: Number(envText('AMAP_ROUTE_PORT', '6137')),
    host: envText('AMAP_ROUTE_HOST', '0.0.0.0') || '0.0.0.0',
    userEmailHeader: envText('ROADTRIP_USER_EMAIL_HEADER', 'X-Auth-Request-Email').toLowerCase(),
    requireUserEmail: !/^(0|false|no|off)$/i.test(envText('ROADTRIP_REQUIRE_USER_EMAIL', 'true')),
    fallbackUserEmail: envText('ROADTRIP_FALLBACK_USER_EMAIL'),
    fallbackLocalOnly: envFlag('ROADTRIP_FALLBACK_LOCAL_ONLY', true),
    localUserEmail: envText('ROADTRIP_LOCAL_USER_EMAIL', 'local@roadtrip.local'),
    trustProxyAny: envFlag('ROADTRIP_TRUST_PROXY_ANY'),
    trustedProxyIps: envText('ROADTRIP_TRUSTED_PROXY_IPS').split(',').map((item) => item.trim()).filter(Boolean),
    proxySecret: envText('ROADTRIP_PROXY_SECRET'),
    adminEmailsRaw: envText('ROADTRIP_ADMIN_EMAILS'),
    supabaseUrl: envText('SUPABASE_URL').replace(/\/+$/, ''),
    supabaseServiceRoleKey: envText('SUPABASE_SERVICE_ROLE_KEY'),
    requireSupabase: envFlag('ROADTRIP_REQUIRE_SUPABASE'),
    sceneImageBucket: envText('ROADTRIP_SCENE_IMAGE_BUCKET', 'roadtrip-scene-images'),
    privateSceneImageBucket: envText('ROADTRIP_PRIVATE_SCENE_IMAGE_BUCKET', 'roadtrip-scene-private'),
    privateRouteAssetBucket: envText('ROADTRIP_PRIVATE_ROUTE_ASSET_BUCKET', 'roadtrip-route-private'),
    publicRouteAssetBucket: envText('ROADTRIP_PUBLIC_ROUTE_ASSET_BUCKET', 'roadtrip-route-public'),
    communityAssetBucket: envText('ROADTRIP_COMMUNITY_ASSET_BUCKET', 'roadtrip-community-private'),
    supabaseTables: {
      routes: envText('ROADTRIP_ROUTES_TABLE', 'roadtrip_routes'),
      scenes: envText('ROADTRIP_SCENES_TABLE', 'roadtrip_scenes'),
      settings: envText('ROADTRIP_SETTINGS_TABLE', 'roadtrip_app_settings'),
      publishedRoutes: envText('ROADTRIP_PUBLISHED_ROUTES_TABLE', 'roadtrip_published_routes'),
      sceneRevisions: envText('ROADTRIP_SCENE_REVISIONS_TABLE', 'roadtrip_scene_revisions'),
      userScenes: envText('ROADTRIP_USER_SCENES_TABLE', 'roadtrip_user_scenes'),
    },
    userEmailHeaderCandidates: [envText('ROADTRIP_USER_EMAIL_HEADER', 'X-Auth-Request-Email').toLowerCase()],
    maxBody: 220 * 1024 * 1024,
    remotionConcurrency: renderConcurrency(),
    remotionCrf: envText('ROUTE_RENDER_CRF', '16'),
    remotionWidth: envText('ROUTE_RENDER_WIDTH', '1920'),
    remotionHeight: envText('ROUTE_RENDER_HEIGHT', '1080'),
    overviewLongEdge: Math.max(320, Number(envText('ROUTE_OVERVIEW_LONG_EDGE', '1280')) || 1280),
    overviewScale: Math.max(1, Number(envText('ROUTE_OVERVIEW_SCALE', '3')) || 3),
    remotionFps: envText('ROUTE_RENDER_FPS', '30'),
    routeAssetSignedUrlSeconds: Math.max(60, Number(envText('ROADTRIP_ROUTE_ASSET_SIGNED_URL_SECONDS', '7200'))),
    keyCandidates: [path.join(configRoot, 'local.env')],
    nodeModuleRoots: [path.join(appRoot, 'node_modules'), path.join(projectRoot, 'node_modules')],
    publicRoot: fs.existsSync(path.join(buildRoot, 'index.html')) ? buildRoot : sourceWebRoot,
    hillshade: {
      enabled: envFlag('HILLSHADE_ENABLED', true),
      sourceUrl: envText('HILLSHADE_SOURCE_URL', 'https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}'),
      cacheVersion: envText('HILLSHADE_CACHE_VERSION', 'v2') || 'v2',
      minZoom: Math.max(0, Number(envText('HILLSHADE_MIN_ZOOM', '5')) || 5),
      maxZoom: Math.max(0, Number(envText('HILLSHADE_MAX_ZOOM', '12')) || 12),
    },
    pointInfo: {
      weatherProvider: envText('POINT_INFO_WEATHER_PROVIDER', 'openmeteo'),
      elevationProvider: envText('POINT_INFO_ELEVATION_PROVIDER', 'openmeteo'),
      weatherTtlMinutes: Math.max(1, Number(envText('POINT_INFO_WEATHER_TTL_MINUTES', '30')) || 30),
    },
  };
};

module.exports = {createRuntimeConfig};
