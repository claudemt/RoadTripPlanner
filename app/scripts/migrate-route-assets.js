const crypto = require('crypto');
const path = require('path');
const {createClient} = require('@supabase/supabase-js');

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const PRIVATE_BUCKET = String(process.env.ROADTRIP_PRIVATE_ROUTE_ASSET_BUCKET || 'roadtrip-route-private').trim();
const PUBLIC_BUCKET = String(process.env.ROADTRIP_PUBLIC_ROUTE_ASSET_BUCKET || 'roadtrip-route-public').trim();
const LEGACY_BUCKET = String(process.env.ROADTRIP_ROUTE_ASSET_BUCKET || 'roadtrip-route-assets').trim();
const DRY_RUN = /^(1|true|yes|on)$/i.test(String(process.env.DRY_RUN || 'false'));

const ASSET_KEYS = ['routeJson', 'videoData', 'mp4', 'manualMd', 'manualPdf', 'mapImage', 'productZip'];
const ASSET_ALIASES = {videoJson: 'videoData'};

const canonicalAssetKey = (key) => ASSET_ALIASES[key] || key;
const safeSegment = (value) =>
  String(value || '')
    .normalize('NFKC')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 90) || `item-${Date.now().toString(36)}`;
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

const contentTypeForName = (name = '') => {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.md') return 'text/markdown; charset=utf-8';
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.zip') return 'application/zip';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  return 'application/octet-stream';
};

const extensionForType = (contentType, fallback = '') => {
  if (/json/i.test(contentType)) return '.json';
  if (/markdown|text\/plain/i.test(contentType)) return '.md';
  if (/pdf/i.test(contentType)) return '.pdf';
  if (/mp4|video/i.test(contentType)) return '.mp4';
  if (/zip/i.test(contentType)) return '.zip';
  if (/png/i.test(contentType)) return '.png';
  if (/jpe?g/i.test(contentType)) return '.jpg';
  return fallback || '';
};

function descriptorFor(routeData, key) {
  const assets = routeData?._assets || routeData?.assets || {};
  const canonical = canonicalAssetKey(key);
  const value = assets[canonical] || assets[key] || assets[`${canonical}Url`] || assets[`${key}Url`];
  if (!value) return null;
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) return {url: value};
  if (typeof value === 'object') return value;
  return null;
}

function descriptorsFor(routeData) {
  return ASSET_KEYS.reduce((result, key) => {
    const descriptor = descriptorFor(routeData, key);
    if (descriptor) result[key] = descriptor;
    return result;
  }, {});
}

function pickAssetMap(assets = {}) {
  return ASSET_KEYS.reduce((result, key) => {
    const canonical = canonicalAssetKey(key);
    const value = assets[canonical] || assets[key];
    if (value) result[canonical] = value;
    return result;
  }, {});
}

function isMigrated(descriptor, bucket) {
  return descriptor?.storageBucket === bucket &&
    descriptor?.storagePath &&
    descriptor?.sha256 &&
    Number(descriptor?.size) > 0;
}

async function getStorageUserId(supabase, ownerEmail) {
  const email = normalizeEmail(ownerEmail);
  const {data: existing, error: readError} = await supabase
    .from('roadtrip_users')
    .select('storage_user_id')
    .eq('owner_email', email)
    .maybeSingle();
  if (readError) throw readError;
  if (existing?.storage_user_id) return existing.storage_user_id;
  if (DRY_RUN) return '00000000-0000-0000-0000-000000000000';
  const {data, error} = await supabase
    .from('roadtrip_users')
    .insert({owner_email: email})
    .select('storage_user_id')
    .single();
  if (error) throw error;
  return data.storage_user_id;
}

async function downloadDescriptor(supabase, descriptor) {
  if (descriptor?.storageBucket && descriptor?.storagePath) {
    const {data, error} = await supabase.storage.from(descriptor.storageBucket).download(descriptor.storagePath);
    if (error) throw error;
    return Buffer.from(await data.arrayBuffer());
  }
  if (descriptor?.url) {
    const response = await fetch(descriptor.url);
    if (!response.ok) throw new Error(`Download failed: ${response.status} ${descriptor.url}`);
    return Buffer.from(await response.arrayBuffer());
  }
  return null;
}

async function uploadDescriptor(supabase, {bucket, prefix, key, descriptor, routeName}) {
  const buffer = await downloadDescriptor(supabase, descriptor);
  if (!buffer) return null;
  const contentType = descriptor.contentType || contentTypeForName(descriptor.fileName || key);
  const hash = sha256(buffer);
  const ext = path.extname(descriptor.fileName || '').toLowerCase() || extensionForType(contentType);
  const storagePath = `${prefix}/${canonicalAssetKey(key)}/${hash}${ext}`;
  const fileName = descriptor.fileName || `${routeName || 'route'}-${canonicalAssetKey(key)}${ext}`;
  if (!DRY_RUN) {
    const {error} = await supabase.storage.from(bucket).upload(storagePath, buffer, {
      contentType,
      cacheControl: '31536000',
      upsert: false,
    });
    if (error && !/exist|duplicate|already/i.test(error.message || '')) throw error;
  }
  return {storageBucket: bucket, storagePath, sha256: hash, size: buffer.length, contentType, fileName};
}

function toBasicRouteData(routeData) {
  return {
    id: routeData?.id || routeData?.name || 'route',
    name: routeData?.name || '未命名路线',
    days: (routeData?.days || []).map((day, index) => ({
      title: day.title || `第 ${index + 1} 天`,
      from: day.from,
      waypoints: day.waypoints || [],
      to: day.to,
    })),
  };
}

async function migrateRouteData(supabase, routeData, {bucket, prefix, routeName}) {
  const current = descriptorsFor(routeData);
  const nextAssets = pickAssetMap(routeData?._assets || {});
  let changed = false;
  for (const key of ASSET_KEYS) {
    const descriptor = current[key];
    if (!descriptor) continue;
    if (isMigrated(descriptor, bucket)) {
      nextAssets[key] = descriptor;
      continue;
    }
    const migrated = await uploadDescriptor(supabase, {bucket, prefix, key, descriptor, routeName});
    if (migrated) {
      nextAssets[key] = migrated;
      changed = true;
    }
  }
  if (!current.routeJson || !isMigrated(current.routeJson, bucket)) {
    const buffer = Buffer.from(JSON.stringify(toBasicRouteData(routeData), null, 2));
    const hash = sha256(buffer);
    const storagePath = `${prefix}/routeJson/${hash}.json`;
    if (!DRY_RUN) {
      const {error} = await supabase.storage.from(bucket).upload(storagePath, buffer, {
        contentType: 'application/json; charset=utf-8',
        cacheControl: '31536000',
        upsert: false,
      });
      if (error && !/exist|duplicate|already/i.test(error.message || '')) throw error;
    }
    nextAssets.routeJson = {
      storageBucket: bucket,
      storagePath,
      sha256: hash,
      size: buffer.length,
      contentType: 'application/json; charset=utf-8',
      fileName: `${routeName || 'route'}.route.json`,
    };
    changed = true;
  }
  if (JSON.stringify(pickAssetMap(routeData?._assets || {})) !== JSON.stringify(routeData?._assets || {})) changed = true;
  return changed ? {...routeData, _assets: nextAssets} : routeData;
}

async function migratePrivateRoutes(supabase) {
  const {data, error} = await supabase.from('roadtrip_routes').select('owner_email,id,name,route_data');
  if (error) throw error;
  let changed = 0;
  for (const row of data || []) {
    const storageUserId = await getStorageUserId(supabase, row.owner_email);
    const prefix = `users/${storageUserId}/routes/${safeSegment(row.id)}`;
    const next = await migrateRouteData(supabase, row.route_data, {bucket: PRIVATE_BUCKET, prefix, routeName: row.name});
    if (next === row.route_data) continue;
    changed += 1;
    console.log(`private ${DRY_RUN ? 'would update' : 'update'}: ${row.owner_email} / ${row.name}`);
    if (!DRY_RUN) {
      const {error: updateError} = await supabase
        .from('roadtrip_routes')
        .update({route_data: next})
        .eq('owner_email', row.owner_email)
        .eq('id', row.id);
      if (updateError) throw updateError;
    }
  }
  return changed;
}

async function migratePublishedRoutes(supabase) {
  const {data, error} = await supabase.from('roadtrip_published_routes').select('id,name,route_data');
  if (error) throw error;
  let changed = 0;
  for (const row of data || []) {
    const prefix = `routes/${row.id}`;
    const next = await migrateRouteData(supabase, row.route_data, {bucket: PUBLIC_BUCKET, prefix, routeName: row.name});
    if (next === row.route_data) continue;
    changed += 1;
    console.log(`public ${DRY_RUN ? 'would update' : 'update'}: ${row.name}`);
    if (!DRY_RUN) {
      const {error: updateError} = await supabase
        .from('roadtrip_published_routes')
        .update({route_data: next})
        .eq('id', row.id);
      if (updateError) throw updateError;
    }
  }
  return changed;
}

async function countLegacyReferences(supabase) {
  const checks = await Promise.all([
    supabase.from('roadtrip_routes').select('id,route_data'),
    supabase.from('roadtrip_published_routes').select('id,route_data'),
  ]);
  for (const result of checks) if (result.error) throw result.error;
  return checks.reduce((sum, result) => sum + (result.data || []).filter((row) =>
    JSON.stringify(row.route_data || {}).includes(LEGACY_BUCKET) ||
    JSON.stringify(row.route_data || {}).includes('/storage/v1/object/public/' + LEGACY_BUCKET)
  ).length, 0);
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {persistSession: false, autoRefreshToken: false},
  });
  const privateChanged = await migratePrivateRoutes(supabase);
  const publicChanged = await migratePublishedRoutes(supabase);
  const legacyReferences = await countLegacyReferences(supabase);
  console.log(JSON.stringify({ok: true, dryRun: DRY_RUN, privateChanged, publicChanged, legacyReferences}, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
