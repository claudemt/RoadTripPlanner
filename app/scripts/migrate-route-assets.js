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

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const zipDateTime = (date = new Date()) => {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return {dosTime, dosDate};
};

const createZipBuffer = (entries) => {
  const zipEntries = entries.filter((item) => item?.name && item.data != null);
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const now = zipDateTime();
  for (const entry of zipEntries) {
    const name = Buffer.from(String(entry.name).replace(/^\/+/, ''), 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data));
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(now.dosTime, 10);
    local.writeUInt16LE(now.dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(now.dosTime, 12);
    central.writeUInt16LE(now.dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(zipEntries.length, 8);
  end.writeUInt16LE(zipEntries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
};

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

async function uploadBuffer(supabase, {bucket, prefix, key, buffer, contentType, fileName}) {
  const hash = sha256(buffer);
  const ext = path.extname(fileName || '').toLowerCase() || extensionForType(contentType);
  const storagePath = `${prefix}/${canonicalAssetKey(key)}/${hash}${ext}`;
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

async function buildProductZip(supabase, routeData, assets, routeName) {
  const name = routeName || routeData?.name || '路线';
  const entries = [
    {name: `${safeSegment(name)}.route.json`, data: JSON.stringify(toBasicRouteData(routeData), null, 2)},
  ];
  for (const [key, suffix] of [
    ['videoData', 'mp4-data.json'],
    ['manualMd', 'travel.md'],
    ['manualPdf', 'travel.pdf'],
    ['mp4', 'mp4'],
    ['mapImage', 'route-map.png'],
  ]) {
    const descriptor = assets[key];
    if (!descriptor) continue;
    try {
      const data = await downloadDescriptor(supabase, descriptor);
      if (data) entries.push({name: descriptor.fileName || `${safeSegment(name)}.${suffix}`, data});
    } catch (error) {
      console.warn(`skip product zip asset ${key}: ${error.message || error}`);
    }
  }
  return createZipBuffer(entries);
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
  if (changed || !nextAssets.productZip || !isMigrated(nextAssets.productZip, bucket)) {
    const buffer = await buildProductZip(supabase, routeData, nextAssets, routeName);
    nextAssets.productZip = await uploadBuffer(supabase, {
      bucket,
      prefix,
      key: 'productZip',
      buffer,
      contentType: 'application/zip',
      fileName: `${safeSegment(routeName || routeData?.name || 'route')}.product.zip`,
    });
    changed = true;
  }
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
