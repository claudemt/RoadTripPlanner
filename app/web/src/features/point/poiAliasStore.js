(function () {

  const STORAGE_KEY = 'roadtrip:poi-alias:v1';
  const MAX_ENTRIES = 1200;
  let cache = null;

  function normalize(value) {
    return String(value || '').replace(/\s+/g, '').toLowerCase();
  }

  function read() {
    if (cache) return cache;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      cache = parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
      cache = {};
    }
    return cache;
  }

  function write(map) {
    cache = map;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    } catch (_) {

    }
  }

  if (typeof window.addEventListener === 'function') {
    window.addEventListener('storage', (event) => {
      if (!event.key || event.key === STORAGE_KEY) cache = null;
    });
  }

  function geoKey(lng, lat) {
    const x = Number(lng);
    const y = Number(lat);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return '';
    return `geo:${x.toFixed(5)},${y.toFixed(5)}`;
  }

  function nameKey(name) {
    const normalized = normalize(name);
    return normalized ? `name:${normalized}` : '';
  }

  function aliasFor({name, lng, lat} = {}) {
    const map = read();
    const keys = [geoKey(lng, lat), nameKey(name)].filter(Boolean);
    for (const key of keys) {
      const value = map[key];
      if (value) return value;
    }
    return '';
  }

  function remember({name, alias, lng, lat} = {}) {
    const nextAlias = String(alias || '').trim();
    const baseName = String(name || '').trim();
    if (!nextAlias || !baseName) return '';
    const map = read();

    [baseName, nextAlias].forEach((value) => {
      const key = nameKey(value);
      if (key) map[key] = nextAlias;
    });

    const baseCanon = map[`canon:${normalize(baseName)}`] || baseName;
    const canonKey = nameKey(baseCanon);
    if (canonKey) map[canonKey] = nextAlias;
    map[`canon:${normalize(nextAlias)}`] = baseCanon;
    const gk = geoKey(lng, lat);
    if (gk) map[gk] = nextAlias;
    const entries = Object.entries(map);
    if (entries.length > MAX_ENTRIES) {
      write(Object.fromEntries(entries.slice(entries.length - MAX_ENTRIES)));
      return nextAlias;
    }
    write(map);
    return nextAlias;
  }

  function canonicalFor({name} = {}) {
    const normalized = normalize(name);
    if (!normalized) return '';
    return read()[`canon:${normalized}`] || '';
  }

  function resolveName({name, lng, lat} = {}) {
    const cleanName = String(name || '').trim();
    if (!cleanName) return '';
    return aliasFor({name: cleanName, lng, lat}) || cleanName;
  }

  window.PoiAliasStore = {aliasFor, remember, resolveName, canonicalFor, normalize};
})();
