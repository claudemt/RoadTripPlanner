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

  function poiLabelKey(point) {
    const name = String(point?.name || '').trim();
    if (name) {
      const store = window.PoiAliasStore;
      let canon = '';
      let normalized = name;
      try {
        normalized = store?.normalize?.(name) || name;
        canon = store?.canonicalFor?.({name}) || '';
      } catch (_) {
        canon = '';
      }

      return `n:${canon ? (store?.normalize?.(canon) || canon) : normalized}`;
    }
    if (point?.lng == null || point?.lng === '' || point?.lat == null || point?.lat === '') return '';
    const lng = Number(point.lng);
    const lat = Number(point.lat);
    if (Number.isFinite(lng) && Number.isFinite(lat)) return `g:${lng.toFixed(5)},${lat.toFixed(5)}`;
    return '';
  }

  function normalizeLabelOffsets(value) {
    const map = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return map;
    Object.entries(value).slice(0, 400).forEach(([rawKey, rawOffset]) => {
      const key = String(rawKey || '').trim().slice(0, 160);
      if (!key) return;
      const x = Number(rawOffset?.x);
      const y = Number(rawOffset?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const offset = normalizeLabelOffset({x, y});
      if (!offset.x && !offset.y) return;
      map[key] = offset;
    });
    return map;
  }

  function applyLabelOffsets(route) {
    if (!route || !Array.isArray(route.days)) return route;
    const map = route.labelOffsets && typeof route.labelOffsets === 'object' ? route.labelOffsets : {};
    route.days.forEach((day) => {
      if (!day) return;
      const points = [day.from, ...(Array.isArray(day.waypoints) ? day.waypoints : []), day.to];
      points.forEach((point) => {
        if (!point) return;
        const key = poiLabelKey(point);
        if (key && map[key]) point.labelOffset = {...map[key]};
      });
    });
    return route;
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

  function normalizeCustomRoutes(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 3).map((route, index) => ({
      key: String(route?.key || `custom-${index}`),
      label: String(route?.label || '自定义路线'),
      distance: Number(route?.distance) || 0,
      duration: Number(route?.duration) || 0,
      path: normalizeSegmentPath(route?.path)
    })).filter((route) => route.path.length >= 2);
  }

  const POLICY_LABEL_MAP = {
    '时间最短': '最快',
    '速度最快': '最快',
    '最快': '最快',
    '距离最短': '最近',
    '路程最短': '最近',
    '最短': '最近',
    '最近': '最近',
    '躲避拥堵': '避堵',
    '避免拥堵': '避堵',
    '少拥堵': '避堵',
    '费用最低': '最便宜',
    '费用最少': '最便宜',
    '最少费用': '最便宜',
    '最便宜': '最便宜'
  };

  function simplifyPolicyLabel(value) {
    const key = String(value || '').trim();
    return POLICY_LABEL_MAP[key] || key;
  }

  function synthesizeDayOptions(segments, customRoutes = [], maxOptions = 3) {
    const usedPolicies = [];
    (segments || []).forEach((segment) => {
      (segment?.alternatives || []).forEach((alt) => {
        const policy = String(alt?.policy || '');
        if (!usedPolicies.includes(policy)) usedPolicies.push(policy);
      });
    });
    const amapOptions = usedPolicies.map((policy, index) => {
      let distance = 0;
      let duration = 0;
      const path = [];
      (segments || []).forEach((segment) => {
        const alt = (segment?.alternatives || []).find((candidate) => candidate.policy === policy);
        distance += alt ? (Number(alt.distance) || 0) : (Number(segment?.distance) || 0);
        duration += alt ? (Number(alt.duration) || 0) : (Number(segment?.duration) || 0);
        const segmentPath = alt ? normalizeSegmentPath(alt.path) : normalizeSegmentPath(segment?.path);
        segmentPath.forEach((point) => path.push(point));
      });
      return {key: `amap-${index}`, label: simplifyPolicyLabel(policy), distance, duration, custom: false, path};
    }).filter((option) => option.path.length >= 2);
    amapOptions.sort((left, right) => (left.duration || 0) - (right.duration || 0));
    const customOptions = (Array.isArray(customRoutes) ? customRoutes : [])
      .map((route, index) => ({
        key: String(route?.key || `custom-${index}`),
        label: String(route?.label || '自定义路线'),
        distance: Number(route?.distance) || 0,
        duration: Number(route?.duration) || 0,
        custom: true,
        path: normalizeSegmentPath(route?.path)
      }))
      .filter((option) => option.path.length >= 2);
    const maxAmap = Math.max(0, Math.floor(Number(maxOptions) || 3) - customOptions.length);
    return [...amapOptions.slice(0, maxAmap), ...customOptions].slice(0, Math.floor(Number(maxOptions) || 3));
  }

  function normalizeSegmentCache(segmentCache) {
    if (!segmentCache || typeof segmentCache !== 'object' || Array.isArray(segmentCache)) return {};
    return Object.entries(segmentCache).reduce((result, [dayIndex, cached]) => {
      if (!cached || typeof cached !== 'object' || !Array.isArray(cached.segments)) return result;
      const customRoutes = normalizeCustomRoutes(cached.customRoutes);
      const options = synthesizeDayOptions(cached.segments, customRoutes);
      const selectedOptionKey = options.some((option) => option.key === cached.selectedOptionKey)
        ? String(cached.selectedOptionKey)
        : null;
      result[dayIndex] = {
        cacheVersion: Number(cached.cacheVersion) || 0,
        signature: String(cached.signature || ''),
        updatedAt: cached.updatedAt || null,
        segments: cached.segments.map((segment) => {
          const alternatives = Array.isArray(segment?.alternatives)
            ? segment.alternatives.slice(0, 5).map((alt) => ({
                policy: String(alt?.policy || ''),
                distance: Number(alt?.distance) || 0,
                duration: Number(alt?.duration) || 0,
                path: normalizeSegmentPath(alt?.path)
              })).filter((alt) => alt.path.length >= 2)
            : [];
          const selectedAlternative = Number.isFinite(Number(segment?.selectedAlternative))
            ? Math.max(0, Math.min(Math.floor(Number(segment.selectedAlternative)), Math.max(0, alternatives.length - 1)))
            : 0;
          const rawCustom = segment?.customAlternative || null;
          const customAlternative = rawCustom && normalizeSegmentPath(rawCustom.path).length >= 2
            ? {
                label: String(rawCustom.label || '自定义轨迹'),
                distance: Number(rawCustom.distance) || 0,
                duration: Number(rawCustom.duration) || 0,
                path: normalizeSegmentPath(rawCustom.path)
              }
            : null;
          const rawAuto = segment?.autoAlternative || null;
          const autoAlternative = rawAuto && normalizeSegmentPath(rawAuto.path).length >= 2
            ? {
                label: String(rawAuto.label || '自动规划'),
                distance: Number(rawAuto.distance) || 0,
                duration: Number(rawAuto.duration) || 0,
                path: normalizeSegmentPath(rawAuto.path)
              }
            : null;
          return {
            from: String(segment?.from || ''),
            to: String(segment?.to || ''),
            fromLng: Number.isFinite(Number(segment?.fromLng)) ? Number(segment.fromLng) : null,
            fromLat: Number.isFinite(Number(segment?.fromLat)) ? Number(segment.fromLat) : null,
            toLng: Number.isFinite(Number(segment?.toLng)) ? Number(segment.toLng) : null,
            toLat: Number.isFinite(Number(segment?.toLat)) ? Number(segment.toLat) : null,
            mode: normalizeTransportMode(segment?.mode),
            distance: Number(segment?.distance) || 0,
            duration: Number(segment?.duration) || 0,
            error: String(segment?.error || ''),
            fallback: Boolean(segment?.fallback),
            path: normalizeSegmentPath(segment?.path),
            selectedAlternative,
            alternatives,
            customAlternative,
            useCustom: Boolean(segment?.useCustom && customAlternative),
            autoAlternative,
            useAuto: Boolean(segment?.useAuto && autoAlternative),
            note: String(segment?.note || '').trim()
          };
        }),
        options,
        customRoutes,
        selectedOptionKey,
        confirmed: Boolean(cached.confirmed && selectedOptionKey)
      };
      return result;
    }, {});
  }

  function selectSegmentAlternative(segment, alternativeIndex) {
    if (!segment || typeof segment !== 'object') return null;
    segment.useCustom = false;
    segment.useAuto = false;
    const alternatives = Array.isArray(segment.alternatives) ? segment.alternatives : [];
    if (!alternatives.length) {
      segment.selectedAlternative = 0;
      return {index: 0, policy: ''};
    }
    const index = Math.max(0, Math.min(Math.floor(Number(alternativeIndex) || 0), alternatives.length - 1));
    const selected = alternatives[index];
    segment.selectedAlternative = index;
    segment.path = normalizeSegmentPath(selected.path);
    segment.distance = Number(selected.distance) || 0;
    segment.duration = Number(selected.duration) || 0;
    return {index, policy: String(selected.policy || '')};
  }

  function selectCustomAlternative(segment) {
    if (!segment || typeof segment !== 'object' || !segment.customAlternative) return null;
    const custom = segment.customAlternative;
    segment.useCustom = true;
    segment.useAuto = false;
    segment.selectedAlternative = 0;
    segment.path = normalizeSegmentPath(custom.path);
    segment.distance = Number(custom.distance) || 0;
    segment.duration = Number(custom.duration) || 0;
    return {label: String(custom.label || '自定义轨迹')};
  }

  function normalizePresentation(value) {
    return window.MapPresentation?.normalize(value) || {
      mapLayer: 'standard', hillshade: false, weather: false, elevation: false, routeFacts: false, startDate: null
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

  function cleanRouteDescription(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  }

  function normalizeRoute(input, defaultDays) {
    const next = input && typeof input === 'object' ? input : {};
    next.id = next.id || ('route-' + Date.now() + '-' + Math.random().toString(16).slice(2));
    next.name = cleanRouteName(next.name) || '未命名线路';
    next.description = cleanRouteDescription(next.description);
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
    next.labelOffsets = normalizeLabelOffsets(next.labelOffsets);
    applyLabelOffsets(next);
    return next;
  }

  function createBlankRoute(name = '我的自驾线路', dayCount = 1) {
    const count = Math.floor(Math.max(1, Math.min(365, Number(dayCount) || 1)));
    return {
      id: 'route-' + Date.now().toString(36),
      name,
      description: '',
      days: Array.from({length: count}, (_, index) => ({
        title: `第 ${index + 1} 天`,
        from: { name: '', lng: null, lat: null, transportMode: 'drive' },
        waypoints: [],
        to: { name: '', lng: null, lat: null, transportMode: 'drive' }
      }))
    };
  }

  function isPointReady(point) {
    return Boolean(point && point.name && point.lng != null && point.lng !== '' && point.lat != null && point.lat !== ''
      && Number.isFinite(Number(point.lng)) && Number.isFinite(Number(point.lat)));
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

  const POI_COORD_EPSILON = 0.000001;

  function isSamePoiCoords(left, right) {
    if (!left || !right) return false;
    const leftLng = Number(left.lng);
    const leftLat = Number(left.lat);
    const rightLng = Number(right.lng);
    const rightLat = Number(right.lat);
    if (!Number.isFinite(leftLng) || !Number.isFinite(leftLat)) return false;
    if (!Number.isFinite(rightLng) || !Number.isFinite(rightLat)) return false;
    return Math.abs(leftLng - rightLng) <= POI_COORD_EPSILON
      && Math.abs(leftLat - rightLat) <= POI_COORD_EPSILON;
  }

  function syncSamePoiName(targetRoute, point, skipPoint = null) {
    if (!targetRoute?.days || !point?.name) return [];
    const touchedDays = new Set();
    targetRoute.days.forEach((day, dayIndex) => {
      if (!day) return;
      [day.from, ...(day.waypoints || []), day.to].forEach((item) => {
        if (!item || item === skipPoint || item === point) return;
        if (!isSamePoiCoords(item, point)) return;
        if (item.name === point.name) return;
        item.name = point.name;
        touchedDays.add(dayIndex);
      });
    });
    return [...touchedDays];
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
      Number(point?.lng).toFixed(6), Number(point?.lat).toFixed(6)
    ]));
  }

  window.RouteModel = {
    cleanDayTitle,
    cleanRouteName,
    dayLabel,
    normalizeTransportMode,
    selectSegmentAlternative,
    selectCustomAlternative,
    simplifyPolicyLabel,
    normalizeLabelOffset,
    poiLabelKey,
    normalizeLabelOffsets,
    applyLabelOffsets,
    normalizeRoute,
    createBlankRoute,
    cleanRouteDescription,
    isPointReady,
    isSamePoint,
    isSamePoiCoords,
    syncSamePoiName,
    isDuplicateDayStart,
    getDayPoints,
    daySignature,
    geoSignature,
    synthesizeDayOptions
  };
})();
