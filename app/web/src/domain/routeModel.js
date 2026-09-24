(function () {
  function cleanDayTitle(value) {
    return String(value || '')
      .replace(/^\s*D\s*\d+\s*[：:、.．-]?\s*/i, '')
      .replace(/\s*[;；,，、-]?\s*\d+(?:\.\d+)?\s*h(?:\s*[（(]\s*\d+(?:\.\d+)?\s*h\s*[）)])?\s*$/i, '')
      .trim();
  }

  function cleanRouteName(value) {
    return String(value || '')
      .replace(/^\s*D\s*\d+\s*[：:、.．-]?\s*/i, '')
      .trim();
  }

  function dayLabel(day, index) {
    const title = cleanDayTitle(day?.title) || `第 ${index + 1} 天`;
    return `D${index + 1} ${title}`;
  }

  function normalizeTransportMode(value) {
    const mode = String(value || '').trim().toLowerCase();
    if (['ride', 'bike', 'bicycle', 'cycling'].includes(mode)) return 'ride';
    if (['walk', 'walking', 'foot'].includes(mode)) return 'walk';
    return 'drive';
  }

  function normalizeLabelOffset(value) {
    const x = Number(value?.x);
    const y = Number(value?.y);
    return {
      x: Number.isFinite(x) ? Math.max(-2, Math.min(2, x)) : 0,
      y: Number.isFinite(y) ? Math.max(-2, Math.min(2, y)) : 0
    };
  }

  function normalizeSegmentPoint(point) {
    const lng = Array.isArray(point) ? Number(point[0]) : Number(point?.lng);
    const lat = Array.isArray(point) ? Number(point[1]) : Number(point?.lat);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    return [lng, lat];
  }

  function normalizeSegmentPath(path) {
    if (!Array.isArray(path)) return [];
    return path.map(normalizeSegmentPoint).filter(Boolean);
  }

  function normalizeSegmentCache(segmentCache) {
    if (!segmentCache || typeof segmentCache !== 'object' || Array.isArray(segmentCache)) return {};
    return Object.entries(segmentCache).reduce((result, [dayIndex, cached]) => {
      if (!cached || typeof cached !== 'object' || !Array.isArray(cached.segments)) return result;
      result[dayIndex] = {
        signature: String(cached.signature || ''),
        updatedAt: cached.updatedAt || null,
        segments: cached.segments.map((segment) => ({
          from: String(segment?.from || ''),
          to: String(segment?.to || ''),
          mode: normalizeTransportMode(segment?.mode),
          distance: Number(segment?.distance) || 0,
          duration: Number(segment?.duration) || 0,
          error: String(segment?.error || ''),
          fallback: Boolean(segment?.fallback),
          path: normalizeSegmentPath(segment?.path)
        }))
      };
      return result;
    }, {});
  }

  function normalizePresentation(value) {
    return window.MapPresentation?.normalize(value) || {
      mapLayer: 'standard', hillshade: false, weather: false, elevation: false, startDate: null
    };
  }

  function normalizePointInfoCache(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const days = source.days && typeof source.days === 'object' && !Array.isArray(source.days) ? source.days : {};
    const normalizedDays = {};
    Object.entries(days).slice(0, 365).forEach(([dayIndex, day]) => {
      if (!day || typeof day !== 'object' || !Array.isArray(day.points)) return;
      normalizedDays[dayIndex] = {
        geoSignature: String(day.geoSignature || '').slice(0, 50000),
        date: /^\d{4}-\d{2}-\d{2}$/.test(String(day.date || '')) ? String(day.date) : null,
        weatherFetchedAt: day.weatherFetchedAt || null,
        points: day.points.slice(0, 202).map((info) => {
          const result = {};
          if (Number.isFinite(Number(info?.elevationM))) result.elevationM = Math.round(Number(info.elevationM) / 10) * 10;
          if (info?.weather && [info.weather.minC, info.weather.maxC, info.weather.code].every((item) => Number.isFinite(Number(item)))
            && /^\d{4}-\d{2}-\d{2}$/.test(String(info.weather.date || day.date || ''))) result.weather = {
            date: String(info.weather.date || day.date || '').slice(0, 10),
            minC: Number(info.weather.minC), maxC: Number(info.weather.maxC), code: Number(info.weather.code)
          };
          return result;
        })
      };
    });
    return {version: 1, days: normalizedDays};
  }

  function normalizePoint(point, fallbackName, allowIncomplete = false) {
    if (!point) {
      return allowIncomplete ? { name: fallbackName || '', lng: null, lat: null, transportMode: 'drive', labelOffset: {x: 0, y: 0} } : null;
    }
    const lng = point.lng == null || point.lng === '' ? null : Number(point.lng);
    const lat = point.lat == null || point.lat === '' ? null : Number(point.lat);
    const hasCoord = Number.isFinite(lng) && Number.isFinite(lat);
    if (!hasCoord && !allowIncomplete) return null;
    return {
      name: point.name || fallbackName || '',
      lng: hasCoord ? lng : null,
      lat: hasCoord ? lat : null,
      transportMode: normalizeTransportMode(point.transportMode),
      useScenic: point.useScenic === false ? false : true,
      labelOffset: normalizeLabelOffset(point.labelOffset)
    };
  }

  function normalizeRoute(input, defaultDays) {
    const next = input && typeof input === 'object' ? input : {};
    next.id = next.id || ('route-' + Date.now() + '-' + Math.random().toString(16).slice(2));
    next.name = cleanRouteName(next.name) || '未命名线路';
    if (!Array.isArray(next.days) || next.days.length === 0) next.days = structuredClone(defaultDays);
    next.days = next.days.map((day, index) => ({
      title: cleanDayTitle(day.title) || `第 ${index + 1} 天`,
      from: normalizePoint(day.from, `第 ${index + 1} 天起点`, true),
      waypoints: Array.isArray(day.waypoints)
        ? day.waypoints.map((point, waypointIndex) => normalizePoint(point, `途径点 ${waypointIndex + 1}`, false)).filter(Boolean)
        : [],
      to: normalizePoint(day.to, `第 ${index + 1} 天终点`, true)
    }));
    if (!next.days.length) next.days = structuredClone(defaultDays);
    next.segmentCache = normalizeSegmentCache(next.segmentCache);
    next.presentation = normalizePresentation(next.presentation);
    next.pointInfoCache = normalizePointInfoCache(next.pointInfoCache);
    return next;
  }

  function createBlankRoute(name = '我的自驾线路', dayCount = 1) {
    const count = Math.floor(Math.max(1, Math.min(365, Number(dayCount) || 1)));
    return {
      id: 'route-' + Date.now().toString(36),
      name,
      days: Array.from({length: count}, (_, index) => ({
        title: `第 ${index + 1} 天`,
        from: { name: '', lng: null, lat: null, transportMode: 'drive' },
        waypoints: [],
        to: { name: '', lng: null, lat: null, transportMode: 'drive' }
      }))
    };
  }

  function isPointReady(point) {
    return Boolean(point && point.name && Number.isFinite(Number(point.lng)) && Number.isFinite(Number(point.lat)));
  }

  function isSamePoint(left, right) {
    if (!isPointReady(left) || !isPointReady(right)) return false;
    const leftName = String(left.name).trim().replace(/\s+/g, ' ').toLocaleLowerCase();
    const rightName = String(right.name).trim().replace(/\s+/g, ' ').toLocaleLowerCase();
    return leftName === rightName
      && Math.abs(Number(left.lng) - Number(right.lng)) <= 0.000001
      && Math.abs(Number(left.lat) - Number(right.lat)) <= 0.000001;
  }

  function isDuplicateDayStart(route, dayIndex) {
    if (!route?.days || dayIndex <= 0 || dayIndex >= route.days.length) return false;
    return isSamePoint(route.days[dayIndex - 1]?.to, route.days[dayIndex]?.from);
  }

  function getDayPoints(day) {
    const list = [{ role: '起', kind: 'from', point: day.from }];
    day.waypoints.forEach((point, waypointIndex) => list.push({
      role: String(waypointIndex + 1),
      kind: 'waypoint',
      waypointIndex,
      point
    }));
    list.push({ role: '终', kind: 'to', point: day.to });
    return list;
  }

  function daySignature(day) {
    return JSON.stringify(getDayPoints(day).map(({ point }) => [
      point.name,
      Number(point.lng).toFixed(6),
      Number(point.lat).toFixed(6),
      normalizeTransportMode(point.transportMode)
    ]));
  }

  function geoSignature(day) {
    return JSON.stringify(getDayPoints(day).map(({point}) => [
      String(point?.name || ''), Number(point?.lng).toFixed(6), Number(point?.lat).toFixed(6)
    ]));
  }

  window.RouteModel = {
    cleanDayTitle,
    cleanRouteName,
    dayLabel,
    normalizeTransportMode,
    normalizeLabelOffset,
    normalizeRoute,
    createBlankRoute,
    isPointReady,
    isSamePoint,
    isDuplicateDayStart,
    getDayPoints,
    daySignature,
    geoSignature,
    normalizePresentation,
    normalizePointInfoCache
  };
})();
