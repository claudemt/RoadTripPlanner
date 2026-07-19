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

  function normalizePoint(point, fallbackName, allowIncomplete = false) {
    if (!point) {
      return allowIncomplete ? { name: fallbackName || '', lng: null, lat: null, transportMode: 'drive' } : null;
    }
    const lng = point.lng == null || point.lng === '' ? null : Number(point.lng);
    const lat = point.lat == null || point.lat === '' ? null : Number(point.lat);
    const hasCoord = Number.isFinite(lng) && Number.isFinite(lat);
    if (!hasCoord && !allowIncomplete) return null;
    return {
      name: point.name || fallbackName || '',
      lng: hasCoord ? lng : null,
      lat: hasCoord ? lat : null,
      transportMode: normalizeTransportMode(point.transportMode)
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
    next.segmentCache = next.segmentCache && typeof next.segmentCache === 'object' ? next.segmentCache : {};
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

  window.RouteModel = {
    cleanDayTitle,
    cleanRouteName,
    dayLabel,
    normalizeTransportMode,
    normalizePoint,
    normalizeRoute,
    createBlankRoute,
    isPointReady,
    getDayPoints,
    daySignature
  };
})();
