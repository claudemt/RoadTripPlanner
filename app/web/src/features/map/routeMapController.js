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

    function normalizePathPoint(point) {
      const lng = Array.isArray(point) ? Number(point[0]) : Number(point?.lng);
      const lat = Array.isArray(point) ? Number(point[1]) : Number(point?.lat);
      return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
    }

    function normalizePath(path) {
      if (!Array.isArray(path)) return [];
      return path.map(normalizePathPoint).filter(Boolean);
    }

    function render({route, segmentResults, currentRouteView, fit = true, onMarkerClick, onLabelDrag}) {
      if (!provider) return;
      provider.clearOverlays();
      const overlays = [];
      let pointCount = 0;

      route.days.forEach((day, dayIndex) => {
        if (currentRouteView !== 'all' && Number(currentRouteView) !== dayIndex) return;
        const points = getDayPoints(day).filter((item) => isPointReady(item.point));
        points.forEach((item) => {
          const color = item.role === '起'
            ? '#16a34a'
            : item.role === '终'
              ? '#ef4444'
              : routeColors[dayIndex % routeColors.length];
          const marker = provider.addMarker({
            point: item.point,
            label: `<div class="marker-label route-marker-label" data-route-label-key="${dayIndex}:${item.kind}:${item.waypointIndex ?? ''}">D${dayIndex + 1}-${item.role} ${escapeHtml(item.point.name)}</div>`,
            color,
            text: item.role,
            labelOffset: item.point.labelOffset,
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
        (dayResult.segments || []).forEach((segment) => {
          const path = normalizePath(segment.path);
          if (path.length < 2) return;
          const polyline = provider.addPolyline({
            path,
            color: routeColors[dayIndex % routeColors.length],
            error: Boolean(segment.error)
          });
          if (polyline) overlays.push(polyline);
        });
      });

      if (fit && pointCount) provider.fitView(overlays);
    }

    function clear() {
      if (provider) provider.clearOverlays();
    }

    function sleep(milliseconds) {
      return new Promise((resolve) => setTimeout(resolve, milliseconds));
    }

    async function route(from, to, mode = 'drive') {
      return provider.route(from, to, mode);
    }

    async function calculateDaySegments(day) {
      const points = getDayPoints(day).map((item) => item.point).filter(isPointReady);
      const segments = [];
      if (points.length < 2) return segments;
      for (let index = 0; index < points.length - 1; index++) {
        const from = points[index];
        const to = points[index + 1];
        const mode = window.RouteModel?.normalizeTransportMode?.(to.transportMode) || 'drive';
        try {
          await sleep(700);
          let result;
          try {
            result = await route(from, to, mode);
          } catch (error) {
            if (String(error.message || '').includes('QPS')) {
              await sleep(1800);
              result = await route(from, to, mode);
            } else {
              throw error;
            }
          }
          segments.push({
            from: from.name,
            to: to.name,
            mode,
            distance: Number(result?.distance) || 0,
            duration: Number(result?.duration) || 0,
            path: normalizePath(result?.path),
            error: String(result?.error || ''),
            fallback: Boolean(result?.fallback)
          });
        } catch (error) {
          segments.push({
            from: from.name,
            to: to.name,
            mode,
            distance: 0,
            duration: 0,
            path: normalizePath([[from.lng, from.lat], [to.lng, to.lat]]),
            error: error.message || '路线计算失败',
            fallback: true
          });
        }
      }
      return segments;
    }

    return {
      load,
      createMap,
      isReady,
      setLayer,
      render,
      clear,
      calculateDaySegments,
      searchTips: (keyword) => provider.searchTips(keyword),
      resolveTip: (tip) => provider.resolveTip(tip),
      resolvePlace: (keyword) => provider.resolvePlace(keyword),
      setZoomAndCenter: (zoom, center) => provider.setZoomAndCenter(zoom, center),
      testSearch: (keyword) => provider.testSearch(keyword)
    };
  }

  window.RouteMapController = {create};
})();
