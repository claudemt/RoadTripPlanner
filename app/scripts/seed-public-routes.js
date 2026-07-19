const fs = require('fs');
const path = require('path');
const {createClient} = require('@supabase/supabase-js');

const ROOT = path.resolve(__dirname, '..');
const DATA_ROOT = path.join(ROOT, '..', 'data');
const ROUTE_ROOT = process.env.ROADTRIP_ROUTE_SEED_ROOT
  ? path.resolve(process.env.ROADTRIP_ROUTE_SEED_ROOT)
  : path.join(DATA_ROOT, 'routes');
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const PUBLISHED_BY_EMAIL = String(process.env.ROADTRIP_ROUTE_SEED_EMAIL || 'opponewsroom@gmail.com').trim().toLowerCase();
const REMOVE_GENERATED_SEEDS = !/^(0|false|no|off)$/i.test(String(process.env.ROADTRIP_REMOVE_GENERATED_ROUTE_SEEDS || 'true').trim());

const GENERATED_SEED_SOURCE_IDS = [
  'seed-gannan-rock-road-loop',
  'seed-longnan-tianshui-ancient-road',
  'seed-aba-gannan-wetland-grassland',
];

const normalizeNameKey = (value) =>
  String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const safeId = (value) =>
  String(value || '')
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 100) || `route-${Date.now().toString(36)}`;

function scanRouteFiles(root) {
  if (!fs.existsSync(root)) return [];
  const result = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.route\.json$/i.test(entry.name)) result.push(full);
    }
  };
  walk(root);
  return result.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function routeAssetsFor(routeFile) {
  const dir = path.dirname(routeFile);
  const base = path.basename(routeFile, '.route.json');
  const pick = (ext) => {
    const file = path.join(dir, `${base}${ext}`);
    return fs.existsSync(file) ? path.relative(ROUTE_ROOT, file).replace(/\\/g, '/') : null;
  };
  return {
    routeJson: path.relative(ROUTE_ROOT, routeFile).replace(/\\/g, '/'),
    mp4: pick('.mp4'),
    manualPdf: pick('.travel.pdf'),
    manualMd: pick('.travel.md'),
    mapImage: pick('.route-map.png'),
    videoData: pick('.mp4-data.json'),
  };
}

function normalizePoint(point) {
  const lng = Number(point?.lng);
  const lat = Number(point?.lat);
  return {
    name: String(point?.name || '').trim(),
    lng: Number.isFinite(lng) ? lng : null,
    lat: Number.isFinite(lat) ? lat : null,
    transportMode: ['drive', 'ride', 'walk'].includes(String(point?.transportMode || '').trim())
      ? String(point.transportMode).trim()
      : 'drive',
  };
}

function normalizeRoute(route, routeFile) {
  const fileBase = path.basename(routeFile, '.route.json');
  const next = {
    ...route,
    id: String(route.id || safeId(fileBase)).trim(),
    name: String(route.name || fileBase).trim() || fileBase,
  };
  next.days = (Array.isArray(route.days) ? route.days : []).map((day, index) => ({
    title: String(day.title || `第 ${index + 1} 天`).trim(),
    from: normalizePoint(day.from),
    waypoints: (day.waypoints || []).map(normalizePoint).filter((point) => point.name),
    to: normalizePoint(day.to),
  }));
  next._assets = routeAssetsFor(routeFile);
  return next;
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {persistSession: false, autoRefreshToken: false},
  });

  if (REMOVE_GENERATED_SEEDS) {
    const {error} = await supabase
      .from('roadtrip_published_routes')
      .delete()
      .in('source_route_id', GENERATED_SEED_SOURCE_IDS);
    if (error) throw error;
  }

  const files = scanRouteFiles(ROUTE_ROOT);
  if (!files.length) {
    console.log(`No .route.json files found under ${ROUTE_ROOT}`);
    return;
  }

  let inserted = 0;
  let updated = 0;
  for (const file of files) {
    const routeData = normalizeRoute(readJson(file), file);
    if (!routeData.days.length) {
      console.log(`Skipped empty route: ${file}`);
      continue;
    }
    const nameKey = normalizeNameKey(routeData.name);
    const row = {
      name: routeData.name,
      name_key: nameKey,
      published_by_email: PUBLISHED_BY_EMAIL,
      source_route_id: routeData.id,
      source_owner_email: PUBLISHED_BY_EMAIL,
      route_data: routeData,
      map_layer: 'standard',
      updated_at: new Date().toISOString(),
    };
    const {data: existing, error: readError} = await supabase
      .from('roadtrip_published_routes')
      .select('id')
      .eq('name_key', nameKey)
      .maybeSingle();
    if (readError) throw readError;
    if (existing) {
      const {error} = await supabase
        .from('roadtrip_published_routes')
        .update(row)
        .eq('id', existing.id);
      if (error) throw error;
      updated += 1;
      console.log(`Updated public route: ${routeData.name}`);
      continue;
    }
    const {error} = await supabase
      .from('roadtrip_published_routes')
      .insert({...row, published_at: new Date().toISOString()});
    if (error) throw error;
    inserted += 1;
    console.log(`Inserted public route: ${routeData.name}`);
  }
  console.log(`Done. Inserted ${inserted}, updated ${updated}.`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
