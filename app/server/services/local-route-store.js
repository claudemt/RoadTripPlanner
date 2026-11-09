'use strict';

// 本地路线仓库：用 output/routes/ 下的目录承载路线、视图和导出产物。
// 同名保存复用已有目录与 ID，视图可以单独保存。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROUTE_DATA_FILE = 'route.json';
const METADATA_FILE = 'metadata.json';
const SUMMARY_FILE = '.route-summary.json';
const VIEW_KEYS = ['presentation', 'labelOffsets', 'mapView'];

const safeSegment = (value) => String(value || 'untitled-route')
  .replace(/[\\/:*?"<>|]/g, '_')
  .replace(/[\u0000-\u001f]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 90) || 'untitled-route';
const routeNameKey = (value) => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
const ensureDir = (dir) => fs.mkdirSync(dir, {recursive: true});
const isPathInside = (root, target) => {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
};
const readJson = (file, fallback = null) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
};
const writeJsonAtomic = (file, value) => {
  ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temp, file);
};
const removeFileQuietly = (file) => {
  try {
    fs.rmSync(file, {force: true});
  } catch (_) {
  }
};
const removeDirQuietly = (dir) => {
  try {
    fs.rmSync(dir, {recursive: true, force: true});
  } catch (_) {
  }
};
const mtimeMs = (file) => {
  try {
    return fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
  } catch (_) {
    return 0;
  }
};
const toIso = (ms, fallback) => new Date(ms || fallback || Date.now()).toISOString();
const encodePath = (value) => String(value || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');

const buildRouteId = (name) => {
  const base = safeSegment(name || 'route').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'route';
  return `${base}-${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
};

const summarizeRouteData = (routeData) => {
  const days = Array.isArray(routeData?.days) ? routeData.days : [];
  const pointCount = days.reduce((sum, day) => {
    const points = [day?.from, ...(Array.isArray(day?.waypoints) ? day.waypoints : []), day?.to].filter(Boolean);
    return sum + points.length;
  }, 0);
  return {
    id: String(routeData?.id || ''),
    name: String(routeData?.name || ''),
    description: String(routeData?.description || '').slice(0, 300),
    dayCount: days.length,
    pointCount
  };
};

const createLocalRouteStore = ({routeRoot, userSegment, defaultUserSegment, flat = false}) => {
  const segFor = userSegment || defaultUserSegment || ((email) => safeSegment(String(email || 'local').replace(/[^a-zA-Z0-9@._+-]+/g, '_')).toLowerCase());
  // flat=true（本机自用）：路线直接放 output/routes/<路线名>/；云端模式按账号隔离。
  const rootFor = (email) => (flat ? routeRoot : path.join(routeRoot, 'users', segFor(email || 'local')));
  const assetBaseFor = (email) => (flat ? '' : `users/${segFor(email || 'local')}`);

  const listDirs = (root) => {
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root, {withFileTypes: true})
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => path.join(root, entry.name));
  };

  const findRouteFile = (dir) => {
    const canonical = path.join(dir, ROUTE_DATA_FILE);
    if (fs.existsSync(canonical)) return canonical;
    const hit = fs.readdirSync(dir).find((name) => name.toLowerCase().endsWith('.route.json') && !name.startsWith('.'));
    return hit ? path.join(dir, hit) : null;
  };

  const detectFiles = (dir, slug) => {
    const names = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    const has = (suffix) => names.includes(`${slug}${suffix}`);
    const pick = (suffix, pattern) => {
      if (has(suffix)) return path.join(dir, `${slug}${suffix}`);
      const hit = names.find((name) => pattern.test(name) && !name.startsWith('.'));
      return hit ? path.join(dir, hit) : null;
    };
    return {
      routeJson: findRouteFile(dir),
      videoJson: pick('.mp4-data.json', /\.mp4-data\.json$/i),
      mp4: pick('.mp4', /\.mp4$/i),
      manualMd: pick('.travel.md', /\.travel\.md$/i),
      manualPdf: pick('.travel.pdf', /\.travel\.pdf$/i),
      mapImage: pick('.route-map.png', /\.route-map\.png$/i)
    };
  };

  const readSummary = (dir, routeFile) => {
    const cacheFile = path.join(dir, SUMMARY_FILE);
    try {
      const routeMtime = mtimeMs(routeFile);
      if (fs.existsSync(cacheFile) && mtimeMs(cacheFile) >= routeMtime) {
        const cached = readJson(cacheFile, null);
        if (cached && cached.dayCount != null) return cached;
      }
      const routeData = readJson(routeFile, null);
      if (!routeData) return null;
      const summary = summarizeRouteData(routeData);
      writeJsonAtomic(cacheFile, summary);
      return summary;
    } catch (_) {
      return null;
    }
  };

  const buildAssetUrls = (assetPath, fileBase, files, version) => {
    const suffix = version ? `?v=${encodeURIComponent(version)}` : '';
    const base = ['/route', encodePath(assetPath), encodeURIComponent(fileBase)].filter(Boolean).join('/');
    const urls = {};
    if (files.mp4) urls.mp4 = `${base}.mp4${suffix}`;
    if (files.videoJson) urls.videoJson = `${base}.mp4-data.json${suffix}`;
    if (files.manualMd) urls.manualMd = `${base}.travel.md${suffix}`;
    if (files.manualPdf) urls.manualPdf = `${base}.travel.pdf${suffix}`;
    if (files.mapImage) urls.mapImage = `${base}.route-map.png${suffix}`;
    return urls;
  };

  const fileBaseFor = (routeFile, slug) => {
    const base = routeFile ? path.basename(routeFile) : '';
    if (!base || base === ROUTE_DATA_FILE) return slug;
    return base.toLowerCase().endsWith('.route.json') ? base.slice(0, -'.route.json'.length) : slug;
  };

  const statusFromFiles = (routeFile, files) => {
    const routeMtime = mtimeMs(routeFile);
    const fileStatus = (file) => {
      if (!file) return 'missing';
      const ms = mtimeMs(file);
      return ms && routeMtime && ms < routeMtime - 1000 ? 'stale' : 'ok';
    };
    return {
      routeJson: 'ok',
      videoData: fileStatus(files.videoJson),
      manualMd: fileStatus(files.manualMd),
      manualPdf: fileStatus(files.manualPdf),
      mp4: fileStatus(files.mp4),
      mapImage: fileStatus(files.mapImage)
    };
  };

  const itemFromDir = (dir, email, {withData = true} = {}) => {
    const slug = path.basename(dir);
    const metadata = readJson(path.join(dir, METADATA_FILE), {});
    const routeFile = findRouteFile(dir);
    if (!routeFile) return null;
    const files = detectFiles(dir, slug);
    const routeData = withData ? readJson(routeFile, null) : null;
    const summary = withData ? summarizeRouteData(routeData || {}) : readSummary(dir, routeFile);
    if (withData && !routeData) return null;
    if (!withData && !summary) return null;
    const stat = fs.statSync(dir);
    const assetPath = [assetBaseFor(email), slug].filter(Boolean).join('/');
    const fileBase = fileBaseFor(routeFile, slug);
    const routeMtime = mtimeMs(routeFile);
    const updatedMs = Math.max(
      Date.parse(metadata.updatedAt || '') || 0,
      routeMtime,
      ...Object.values(files).filter(Boolean).map(mtimeMs),
      stat.mtimeMs
    );
    const version = String(updatedMs || Date.now());
    const item = {
      id: String(metadata.routeId || routeData?.id || summary?.id || slug),
      name: String(metadata.routeName || routeData?.name || summary?.name || slug),
      safeName: slug,
      fileBase,
      assetPath,
      archivedAt: metadata.archivedAt || toIso(stat.mtimeMs, Date.now()),
      updatedAt: toIso(updatedMs, stat.mtimeMs),
      mapLayer: metadata.mapLayer || routeData?.presentation?.mapLayer || null,
      routeJson: true,
      videoJson: Boolean(files.videoJson),
      mp4: Boolean(files.mp4),
      manualMd: Boolean(files.manualMd),
      manualPdf: Boolean(files.manualPdf),
      mapImage: Boolean(files.mapImage),
      productZip: false,
      cloud: false,
      local: true,
      assetUrls: buildAssetUrls(assetPath, fileBase, files, version),
      assetStatus: statusFromFiles(routeFile, files),
      description: summary?.description || '',
      dayCount: summary?.dayCount || 0,
      routeData: withData ? routeData : undefined
    };
    return item;
  };

  const list = (email, {summary = false} = {}) => {
    const root = rootFor(email);
    return listDirs(root)
      .map((dir) => {
        try {
          return itemFromDir(dir, email, {withData: !summary});
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean)
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
  };

  const findById = (email, routeId) => {
    const target = String(routeId || '').trim();
    if (!target) return null;
    const root = rootFor(email);
    for (const dir of listDirs(root)) {
      if (path.basename(dir) === target) return {dir, metadata: readJson(path.join(dir, METADATA_FILE), {})};
      const metadata = readJson(path.join(dir, METADATA_FILE), {});
      if (metadata.routeId && String(metadata.routeId) === target) return {dir, metadata};
      const routeFile = findRouteFile(dir);
      const routeData = routeFile ? readJson(routeFile, null) : null;
      if (routeData && String(routeData.id || '') === target) return {dir, metadata, routeData};
    }
    return null;
  };

  const findByName = (email, name, excludeDir = '') => {
    const target = routeNameKey(name);
    if (!target) return null;
    const root = rootFor(email);
    for (const dir of listDirs(root)) {
      if (excludeDir && path.resolve(dir) === path.resolve(excludeDir)) continue;
      const metadata = readJson(path.join(dir, METADATA_FILE), {});
      if (metadata.routeName && routeNameKey(metadata.routeName) === target) return {dir, metadata};
      const routeFile = findRouteFile(dir);
      const routeData = routeFile ? readJson(routeFile, null) : null;
      if (routeData && routeNameKey(routeData.name) === target) return {dir, metadata, routeData};
    }
    return null;
  };

  const loadRoute = (dir) => {
    const routeFile = findRouteFile(dir);
    return routeFile ? readJson(routeFile, null) : null;
  };

  const idOfEntry = (entry) => {
    if (!entry) return '';
    const routeData = entry.routeData || loadRoute(entry.dir) || {};
    return String(entry.metadata?.routeId || routeData.id || path.basename(entry.dir) || '');
  };

  // 只解析 ID，不落盘：同名路线沿用已有 ID（导出等同刷新），新路线生成稳定 ID。
  const resolveId = (email, routeData = {}) => {
    const requested = String(routeData.id || '').trim().slice(0, 120);
    if (requested) {
      const hit = findById(email, requested);
      if (hit) return idOfEntry(hit);
    }
    const byName = findByName(email, routeData.name);
    if (byName) return idOfEntry(byName);
    return requested || buildRouteId(routeData.name);
  };

  const save = (email, payload = {}) => {
    const source = payload?.routeData;
    if (!source || typeof source !== 'object') {
      const error = new Error('缺少路线数据。');
      error.status = 400;
      throw error;
    }
    const routeData = JSON.parse(JSON.stringify(source));
    const name = String(routeData.name || '未命名路线').trim() || '未命名路线';
    const requestedId = String(routeData.id || '').trim().slice(0, 120);
    let entry = requestedId ? findById(email, requestedId) : null;
    if (!entry) entry = findByName(email, name);
    const id = String(entry ? idOfEntry(entry) : (requestedId || buildRouteId(name))).slice(0, 120);
    const root = rootFor(email);
    ensureDir(root);
    const base = safeSegment(name);
    let dir = entry?.dir || path.join(root, base);
    if (entry?.dir && path.basename(dir) !== base) {
      const target = path.join(root, base);
      if (!fs.existsSync(target)) {
        try {
          fs.renameSync(dir, target);
          dir = target;
        } catch (_) {
        }
      }
    }
    ensureDir(dir);
    const existingMeta = readJson(path.join(dir, METADATA_FILE), {});
    const previousRoute = loadRoute(dir);
    const now = new Date().toISOString();
    const nextRoute = {...routeData, id};
    // 保存路线本体时保留上一次单独保存过的视图（地图表现、文字位置、视野），避免被覆盖。
    if (previousRoute) {
      for (const key of VIEW_KEYS) {
        if (nextRoute[key] === undefined && previousRoute[key] !== undefined) nextRoute[key] = previousRoute[key];
      }
    }
    // 保存后只保留 route.json，避免同一目录出现两份路线数据。
    const previousRouteFile = findRouteFile(dir);
    writeJsonAtomic(path.join(dir, ROUTE_DATA_FILE), nextRoute);
    if (previousRouteFile && path.basename(previousRouteFile) !== ROUTE_DATA_FILE) removeFileQuietly(previousRouteFile);
    removeFileQuietly(path.join(dir, SUMMARY_FILE));
    writeJsonAtomic(path.join(dir, METADATA_FILE), {
      ...existingMeta,
      routeId: id,
      routeName: name,
      safeName: path.basename(dir),
      mapLayer: payload.mapLayer || existingMeta.mapLayer || routeData.presentation?.mapLayer || 'standard',
      ownerEmail: flat ? null : (email || null),
      archivedAt: existingMeta.archivedAt || null,
      createdAt: existingMeta.createdAt || now,
      updatedAt: now
    });
    return {
      ok: true,
      route: {
        id,
        name,
        updated_at: now,
        map_layer: payload.mapLayer || existingMeta.mapLayer || routeData.presentation?.mapLayer || 'standard'
      }
    };
  };

  const saveView = (email, routeId, view) => {
    const entry = findById(email, routeId);
    if (!entry) {
      const error = new Error('未找到这条路线。');
      error.status = 404;
      throw error;
    }
    const current = loadRoute(entry.dir);
    if (!current) {
      const error = new Error('未找到这条路线。');
      error.status = 404;
      throw error;
    }
    const patch = {};
    for (const key of VIEW_KEYS) {
      if (view && view[key] !== undefined) patch[key] = view[key];
    }
    if (!Object.keys(patch).length) {
      const error = new Error('缺少可保存的视图数据。');
      error.status = 400;
      throw error;
    }
    const now = new Date().toISOString();
    writeJsonAtomic(path.join(entry.dir, ROUTE_DATA_FILE), {...current, ...patch});
    removeFileQuietly(path.join(entry.dir, SUMMARY_FILE));
    writeJsonAtomic(path.join(entry.dir, METADATA_FILE), {...entry.metadata, updatedAt: now, routeId: entry.metadata?.routeId || current.id || routeId});
    return {ok: true, route: {id: String(entry.metadata?.routeId || current.id || routeId), updated_at: now}};
  };

  const read = (email, routeId) => {
    const entry = findById(email, routeId);
    if (!entry) {
      const error = new Error('未找到这条路线。');
      error.status = 404;
      throw error;
    }
    const routeData = loadRoute(entry.dir) || {};
    const routeFile = findRouteFile(entry.dir);
    const files = detectFiles(entry.dir, path.basename(entry.dir));
    const assetPath = [assetBaseFor(email), path.basename(entry.dir)].filter(Boolean).join('/');
    const fileBase = fileBaseFor(routeFile, path.basename(entry.dir));
    const versionMs = Math.max(mtimeMs(routeFile), ...Object.values(files).filter(Boolean).map(mtimeMs));
    return {
      id: String(entry.metadata?.routeId || routeData.id || routeId),
      name: String(entry.metadata?.routeName || routeData.name || ''),
      mapLayer: entry.metadata?.mapLayer || routeData.presentation?.mapLayer || 'standard',
      route_data: routeData,
      dir: entry.dir,
      assetPath,
      assetStatus: statusFromFiles(routeFile, files),
      assetUrls: buildAssetUrls(assetPath, fileBase, files, String(Number.isFinite(versionMs) ? versionMs : Date.now()))
    };
  };

  const remove = (email, routeId) => {
    const entry = findById(email, routeId);
    if (!entry) {
      const error = new Error('未找到这条路线。');
      error.status = 404;
      throw error;
    }
    if (!isPathInside(rootFor(email), entry.dir)) {
      const error = new Error('路线路径不合法。');
      error.status = 400;
      throw error;
    }
    removeDirQuietly(entry.dir);
    return {ok: true};
  };

  const names = (email) => listDirs(rootFor(email)).map((dir) => {
    const metadata = readJson(path.join(dir, METADATA_FILE), {});
    const routeData = loadRoute(dir) || {};
    return {id: String(metadata.routeId || routeData.id || path.basename(dir)), name: String(metadata.routeName || routeData.name || path.basename(dir))};
  });

  const filesForDir = (dir) => detectFiles(dir, path.basename(dir));

  return {list, save, saveView, read, remove, names, findById, resolveId, filesForDir};
};

module.exports = {createLocalRouteStore, safeSegment, routeNameKey, summarizeRouteData};
