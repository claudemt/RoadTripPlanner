(function () {
  function create({
    routeColors,
    getDayPoints,
    isPointReady,
    escapeHtml
  }) {
    let provider = null;
    let map = null;

    async function load(config) {
      provider = new window.AmapProvider({config});
      await provider.load();
    }

    async function createMap(containerId, options, onClick) {
      if (!provider) throw new Error('地图 Provider 尚未加载');
      map = await provider.createMap(containerId, options);
      if (onClick) provider.onClick(onClick);
      return map;
    }

    function isReady() {
      return Boolean(provider && map);
    }

    function setLayer(layer) {
      if (provider) provider.setLayer(layer);
    }

    function setHillshade(enabled) {
      if (provider) provider.setHillshade(enabled);
    }

    function buildFactsHtml({pointInfo, presentation, segment}) {
      const icon = presentation?.weather && pointInfo?.weather
        ? `<img class="route-marker-weather-icon" src="${window.MapPresentation.weatherMeta(pointInfo.weather.code).iconUrl}" alt="${escapeHtml(window.MapPresentation.weatherMeta(pointInfo.weather.code).label)}" />`
        : '';
      const primary = [];
      if (presentation?.weather && pointInfo?.weather) {
        const weather = pointInfo.weather;
        primary.push(`${window.MapPresentation.weatherMeta(weather.code).label} · ${Math.round(Number(weather.minC))}–${Math.round(Number(weather.maxC))} °C`);
      }
      if (presentation?.elevation && Number.isFinite(Number(pointInfo?.elevationM))) primary.push(`${Math.round(Number(pointInfo.elevationM) / 10) * 10} m`);
      let routeFact = '';
      if (presentation?.routeFacts && segment && Number(segment.distance) > 0) {
        routeFact = (window.FormatUtils?.formatTripMetric?.(segment.distance, segment.duration)) || '';
      }
      if (primary.length === 0) {
        return routeFact ? `<div class="route-marker-facts">${icon}<span>${escapeHtml(routeFact)}</span></div>` : '';
      }
      if (primary.length === 1) {
        const joined = `${primary[0]}${routeFact ? ` · ${routeFact}` : ''}`;
        return `<div class="route-marker-facts">${icon}<span>${escapeHtml(joined)}</span></div>`;
      }
      return `<div class="route-marker-facts">${icon}<span>${escapeHtml(primary.join(' · '))}</span></div>${routeFact ? `<div class="route-marker-facts route-marker-facts-route"><span>${escapeHtml(routeFact)}</span></div>` : ''}`;
    }

    const dayRoleLabel = (dayIndex, role) => `D${dayIndex + 1}${/^\d/.test(String(role || '')) ? '-' : ''}${role}`;

    function buildCompositeLabel({item, dayIndex, pointInfo, presentation, segment}) {
      const title = `${dayRoleLabel(dayIndex, item.role)} ${escapeHtml(item.point.name)}`;
      const factsHtml = buildFactsHtml({pointInfo, presentation, segment});
      return `<div class="marker-label route-marker-label" data-route-label-key="${dayIndex}:${item.kind}:${item.waypointIndex ?? ''}"><div class="route-marker-title">${title}</div>${factsHtml}</div>`;
    }

    function buildMergedLabel({item, entries, factsHtml = ''}) {
      const title = `${entries.map((entry) => dayRoleLabel(entry.dayIndex, entry.role)).join('/')} ${escapeHtml(item.point.name)}`;
      return `<div class="marker-label route-marker-label"><div class="route-marker-title">${title}</div>${factsHtml}</div>`;
    }

    function normalizePathPoint(point) {
      const lng = Array.isArray(point) ? Number(point[0]) : Number(point?.lng);
      const lat = Array.isArray(point) ? Number(point[1]) : Number(point?.lat);
      return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
    }

    function normalizePath(path) {
      if (!Array.isArray(path)) return [];
      return path.map(normalizePathPoint).filter(Boolean);
    }

    function effectiveLabelOffset(route, dayIndex, item) {
      const point = item?.point;
      const key = window.RouteModel?.occurrenceLabelKey?.(dayIndex, item) || '';
      const stored = key ? route?.labelOffsets?.[key] : null;
      if (stored) return stored;
      const legacyKey = window.RouteModel?.poiLabelKey?.(point) || '';
      const legacy = legacyKey ? route?.labelOffsets?.[legacyKey] : null;
      return legacy || point?.labelOffset || {x: 0, y: 0};
    }

    function render({route, segmentResults, currentRouteView, pointInfo, presentation, fit = true, expandedSegments, onMarkerClick, onLabelDrag}) {
      if (!provider) return;
      provider.clearOverlays();
      const overlays = [];
      let pointCount = 0;
      const isSamePoint = (left, right) => window.RouteModel.isSamePoint(left, right);
      const handoffFromSkip = new Set();
      const handoffLabels = new Map();
      route.days.forEach((day, dayIndex) => {
        if (dayIndex <= 0) return;
        if (!isSamePoint(route.days[dayIndex - 1]?.to, day?.from)) return;
        handoffFromSkip.add(dayIndex);
        handoffLabels.set(dayIndex - 1, {fromDay: dayIndex});
      });

      route.days.forEach((day, dayIndex) => {
        if (currentRouteView !== 'all' && Number(currentRouteView) !== dayIndex) return;
        const points = getDayPoints(day).filter((item) => isPointReady(item.point));
        points.forEach((item, pointIndex) => {
          if (item.kind === 'from' && handoffFromSkip.has(dayIndex)) return;
          const color = item.role === '起'
            ? '#16a34a'
            : item.role === '终'
              ? '#ef4444'
              : routeColors[dayIndex % routeColors.length];
          const cachedDay = pointInfo?.days?.[dayIndex];
          const dateMatches = !presentation?.weather || cachedDay?.date === window.MapPresentation.addDays(presentation.startDate, dayIndex);
          const geoMatches = cachedDay?.geoSignature === window.RouteModel.geoSignature(day);
          const cachedInfo = geoMatches ? (cachedDay?.points?.[pointIndex] || {}) : {};
          const info = dateMatches ? cachedInfo : {...cachedInfo, weather: undefined};
          const inSegIndex = item.kind === 'from' ? -1 : (item.kind === 'to' ? points.length - 2 : pointIndex - 1);
          const inSegment = inSegIndex >= 0 ? (segmentResults[dayIndex]?.segments?.[inSegIndex] || null) : null;
          const handoff = item.kind === 'to' ? handoffLabels.get(dayIndex) : null;
          const label = handoff
            ? buildMergedLabel({
              item,
              entries: [
                {dayIndex, role: '终'},
                {dayIndex: handoff.fromDay, role: '起'}
              ],
              factsHtml: buildFactsHtml({pointInfo: info, presentation, segment: inSegment})
            })
            : buildCompositeLabel({item, dayIndex, pointInfo: info, presentation, segment: inSegment});
          const marker = provider.addMarker({
            point: item.point,
            label,
            color,
            text: item.role,
            labelOffset: effectiveLabelOffset(route, dayIndex, item),
            labelKey: `${dayIndex}:${item.kind}:${item.waypointIndex ?? ''}`,
            onLabelDrag: (labelOffset) => onLabelDrag?.({item, dayIndex, labelOffset}),
            onClick: () => onMarkerClick?.({item, dayIndex})
          });
          if (marker) {
            overlays.push(marker);
            pointCount += 1;
          }
        });
      });

      segmentResults.forEach((dayResult, dayIndex) => {
        if (currentRouteView !== 'all' && Number(currentRouteView) !== dayIndex) return;
        const dayColor = routeColors[dayIndex % routeColors.length];
        (dayResult.segments || []).forEach((segment, segmentIndex) => {
          const path = normalizePath(segment.path);
          if (path.length < 2) return;
          const polyline = provider.addPolyline({
            path,
            color: dayColor,
            error: Boolean(segment.error),
            primary: true
          });
          if (polyline) overlays.push(polyline);

          const expanded = Boolean(expandedSegments?.has(`${dayIndex}:${segmentIndex}`));
          if (!expanded || segment.error) return;
          const alternatives = Array.isArray(segment.alternatives) ? segment.alternatives : [];
          const selectedAlt = Number.isFinite(Number(segment.selectedAlternative))
            ? Math.max(0, Math.min(Math.floor(Number(segment.selectedAlternative)), Math.max(0, alternatives.length - 1)))
            : 0;
          const custom = segment.customAlternative || null;
          const usingCustom = Boolean(segment.useCustom && custom);
          const auto = segment.autoAlternative || null;
          const usingAuto = Boolean(segment.useAuto && auto);
          alternatives.forEach((alt, index) => {
            if (index === selectedAlt && !usingCustom && !usingAuto) return;
            const altPath = normalizePath(alt.path);
            if (altPath.length < 2) return;
            const altLine = provider.addPolyline({
              path: altPath,
              color: dayColor,
              error: false,
              primary: false
            });
            if (altLine) overlays.push(altLine);
          });
          if (auto && !usingAuto) {
            const autoPath = normalizePath(auto.path);
            if (autoPath.length >= 2) {
              const autoLine = provider.addPolyline({
                path: autoPath,
                color: dayColor,
                error: false,
                primary: false
              });
              if (autoLine) overlays.push(autoLine);
            }
          }
          if (custom && !usingCustom) {
            const customPath = normalizePath(custom.path);
            if (customPath.length >= 2) {
              const customLine = provider.addPolyline({
                path: customPath,
                color: dayColor,
                error: false,
                primary: false
              });
              if (customLine) overlays.push(customLine);
            }
          }
        });
      });

      if (fit && pointCount) {
        const view = route?.mapView;
        const center = Array.isArray(view?.center) ? view.center.map(Number) : [];
        const zoom = Number(view?.zoom);
        if (center.length === 2 && center.every(Number.isFinite) && Number.isFinite(zoom)) {
          provider.setZoomAndCenter(zoom, center);
        } else {
          provider.fitView(overlays);
        }
      }
    }

    function clear() {
      if (provider) provider.clearOverlays();
    }

    function sleep(milliseconds) {
      return new Promise((resolve) => setTimeout(resolve, milliseconds));
    }

    const routeQueue = (() => {
      const MAX_CONCURRENCY = 1;
      const MIN_GAP_MS = 700;
      let active = 0;
      let lastAt = 0;
      const pending = [];
      function pump() {
        if (active >= MAX_CONCURRENCY || !pending.length) return;
        active += 1;
        const {fn, resolve, reject} = pending.shift();
        const delay = Math.max(0, MIN_GAP_MS - (Date.now() - lastAt));
        setTimeout(async () => {
          lastAt = Date.now();
          try {
            resolve(await fn());
          } catch (error) {
            reject(error);
          } finally {
            active -= 1;
            pump();
          }
        }, delay);
      }
      return {
        run(fn) {
          return new Promise((resolve, reject) => {
            pending.push({fn, resolve, reject});
            pump();
          });
        }
      };
    })();

    function segCoordsMatch(path, fromPt, toPt) {
      if (!Array.isArray(path) || path.length < 2) return false;
      const first = path[0];
      const last = path[path.length - 1];
      return Math.abs(Number(first[0]) - Number(fromPt.lng)) < 0.005
        && Math.abs(Number(first[1]) - Number(fromPt.lat)) < 0.005
        && Math.abs(Number(last[0]) - Number(toPt.lng)) < 0.005
        && Math.abs(Number(last[1]) - Number(toPt.lat)) < 0.005;
    }

    const PAIR_COORD_EPSILON = 0.000001;
    const sameCoord = (stored, current) => {
      if (!Number.isFinite(Number(stored)) || !Number.isFinite(Number(current))) return false;
      return Math.abs(Number(stored) - Number(current)) <= PAIR_COORD_EPSILON;
    };

    function samePointPair(seg, fromPt, toPt) {
      const recorded = Number.isFinite(Number(seg?.fromLng)) && Number.isFinite(Number(seg?.fromLat))
        && Number.isFinite(Number(seg?.toLng)) && Number.isFinite(Number(seg?.toLat));
      if (recorded) {
        return sameCoord(seg.fromLng, fromPt.lng) && sameCoord(seg.fromLat, fromPt.lat)
          && sameCoord(seg.toLng, toPt.lng) && sameCoord(seg.toLat, toPt.lat);
      }

      return seg?.from === fromPt.name && seg?.to === toPt.name && segCoordsMatch(seg?.path, fromPt, toPt);
    }

    function inheritChoices(fresh, cachedList) {
      const byName = new Map();
      (Array.isArray(cachedList) ? cachedList : []).forEach((seg) => {
        const key = `${String(seg?.from || '')}\u2192${String(seg?.to || '')}::${seg?.mode || 'drive'}`;
        if (!byName.has(key)) byName.set(key, []);
        byName.get(key).push(seg);
      });
      fresh.forEach((seg) => {
        const olds = byName.get(`${String(seg.from || '')}\u2192${String(seg.to || '')}::${seg.mode || 'drive'}`) || [];
        const old = olds.find((candidate) => candidate !== seg);
        if (!old) return;
        if (String(old.note || '').trim()) seg.note = String(old.note || '').trim();
        if (old.useCustom && old.customAlternative && Array.isArray(old.customAlternative.path) && old.customAlternative.path.length >= 2) {
          seg.useCustom = true;
          seg.useAuto = false;
          seg.customAlternative = old.customAlternative;
          seg.path = old.customAlternative.path;
          seg.distance = Number(old.customAlternative.distance) || 0;
          seg.duration = Number(old.customAlternative.duration) || 0;
        } else if (old.useAuto && old.autoAlternative && Array.isArray(old.autoAlternative.path) && old.autoAlternative.path.length >= 2) {
          seg.useAuto = true;
          seg.useCustom = false;
          seg.autoAlternative = old.autoAlternative;
          seg.path = old.autoAlternative.path;
          seg.distance = Number(old.autoAlternative.distance) || 0;
          seg.duration = Number(old.autoAlternative.duration) || 0;
        } else if (Array.isArray(seg.alternatives) && seg.alternatives.length && Number.isFinite(Number(old.selectedAlternative))) {
          seg.selectedAlternative = Math.max(0, Math.min(Math.floor(Number(old.selectedAlternative)), seg.alternatives.length - 1));
          const alt = seg.alternatives[seg.selectedAlternative];
          if (alt) {
            seg.path = alt.path;
            seg.distance = Number(alt.distance) || 0;
            seg.duration = Number(alt.duration) || 0;
          }
        }
      });
    }

    async function route(from, to, mode = 'drive') {
      return provider.route(from, to, mode);
    }

    async function calculateDaySegments(day, cachedSegments = []) {
      const points = getDayPoints(day).map((item) => item.point).filter(isPointReady);
      if (points.length < 2) return [];
      const cachedList = Array.isArray(cachedSegments) ? cachedSegments : [];
      const reused = [];
      const tasks = [];
      const usedCached = new Set();
      for (let index = 0; index < points.length - 1; index += 1) {
        const from = points[index];
        const to = points[index + 1];
        const mode = window.RouteModel?.normalizeTransportMode?.(to.transportMode) || 'drive';

        const matchingCache = cachedList.find((seg) => {
          if (!seg || usedCached.has(seg) || seg.error) return false;
          if (String(seg.mode || 'drive') !== mode) return false;
          return samePointPair(seg, from, to);
        });
        if (matchingCache) {
          usedCached.add(matchingCache);
          if (from.name) matchingCache.from = from.name;
          if (to.name) matchingCache.to = to.name;
          reused.push({slot: index, segment: matchingCache});
          continue;
        }
        tasks.push({slot: index, from, to, mode});
      }
      const freshSegments = [];
      for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
        const {slot, from, to, mode} = tasks[taskIndex];
        const result = await routeQueue.run(async () => {
          try {
            let result;
            try {
              result = await route(from, to, mode);
            } catch (error) {
              try {
              if (!String(error?.message || '').includes('QPS')) throw error;
                await sleep(1800);
                result = await route(from, to, mode);
              } catch (amapError) {
                try {
                  if (typeof window.RoadProvider?.autoPlanRoutes !== 'function') throw new Error('规划服务未加载');
                  const openRoutes = await window.RoadProvider.autoPlanRoutes(from, to, mode);
                  const alternatives = (Array.isArray(openRoutes) ? openRoutes : []).map((item) => ({
                    policy: '开源路网',
                    distance: Number(item?.distance) || 0,
                    duration: Number(item?.duration) || 0,
                    path: normalizePath(item?.path)
                  })).filter((item) => item.path.length >= 2);
                  if (!alternatives.length) throw new Error('未返回可用路线');
                  result = {...alternatives[0], alternatives, fallback: true};
                } catch (openError) {
                  throw new Error(`高德：${amapError?.message || '路线计算失败'}；开源路网：${openError?.message || '路线计算失败'}`);
                }
              }
            }
            return {
              from: from.name,
              to: to.name,
              fromLng: Number(from.lng),
              fromLat: Number(from.lat),
              toLng: Number(to.lng),
              toLat: Number(to.lat),
              mode,
              distance: Number(result?.distance) || 0,
              duration: Number(result?.duration) || 0,
              path: normalizePath(result?.path),
              alternatives: (Array.isArray(result?.alternatives) ? result.alternatives : [])
                .filter((alt) => alt && Array.isArray(alt.path) && alt.path.length >= 2)
                .slice(0, 4)
                .map((alt) => ({
                  policy: String(alt.policy || ''),
                  distance: Number(alt.distance) || 0,
                  duration: Number(alt.duration) || 0,
                  path: normalizePath(alt.path)
                })),
              selectedAlternative: 0,
              error: String(result?.error || ''),
              fallback: Boolean(result?.fallback)
            };
          } catch (error) {
            return {
              from: from.name,
              to: to.name,
              mode,
              distance: 0,
              duration: 0,
              path: normalizePath([[from.lng, from.lat], [to.lng, to.lat]]),
              error: error.message || '路线计算失败',
              fallback: true
            };
          }
        });
        freshSegments.push({slot, segment: result});
      }
      inheritChoices(freshSegments.map((item) => item.segment), cachedList);
      const ordered = new Array(Math.max(0, points.length - 1));
      reused.forEach((item) => {
        ordered[item.slot] = item.segment;
      });
      freshSegments.forEach((item) => {
        ordered[item.slot] = item.segment;
      });
      return ordered.filter(Boolean);
    }

    return {
      load,
      createMap,
      isReady,
      setLayer,
      setHillshade,
      render,
      clear,
      calculateDaySegments,
      searchTips: (keyword) => provider.searchTips(keyword),
      resolveTip: (tip) => provider.resolveTip(tip),
      resolvePlace: (keyword) => provider.resolvePlace(keyword),
      setZoomAndCenter: (zoom, center) => provider.setZoomAndCenter(zoom, center),
      setViewChangeHandler: (handler) => provider.setViewChangeHandler(handler),
      getContentBounds: () => provider.getContentBounds(),
      layoutSnapshotLabels: () => provider.layoutSnapshotLabels?.(),
      testSearch: (keyword) => provider.testSearch(keyword)
    };
  }

  window.RouteMapController = {create};
})();
