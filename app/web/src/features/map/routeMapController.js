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

    function render({route, segmentResults, currentRouteView, fit = true, onMarkerClick}) {
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
            label: `<div class="marker-label">D${dayIndex + 1}-${item.role} ${escapeHtml(item.point.name)}</div>`,
            color,
            text: item.role,
            onClick: () => onMarkerClick?.({item, dayIndex})
          });
          overlays.push(marker);
          pointCount += 1;
        });
      });

      segmentResults.forEach((dayResult, dayIndex) => {
        if (currentRouteView !== 'all' && Number(currentRouteView) !== dayIndex) return;
        (dayResult.segments || []).forEach((segment) => {
          if (!segment.path?.length) return;
          const path = segment.path.filter(([lng, lat]) => Number.isFinite(Number(lng)) && Number.isFinite(Number(lat)));
          if (path.length < 2) return;
          overlays.push(provider.addPolyline({
            path,
            color: routeColors[dayIndex % routeColors.length],
            error: Boolean(segment.error)
          }));
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

    async function drivingRoute(from, to) {
      return provider.drivingRoute(from, to);
    }

    async function calculateDaySegments(day) {
      const points = getDayPoints(day).map((item) => item.point).filter(isPointReady);
      const segments = [];
      if (points.length < 2) return segments;
      for (let index = 0; index < points.length - 1; index++) {
        const from = points[index];
        const to = points[index + 1];
        try {
          await sleep(700);
          let result;
          try {
            result = await drivingRoute(from, to);
          } catch (error) {
            if (String(error.message || '').includes('QPS')) {
              await sleep(1800);
              result = await drivingRoute(from, to);
            } else {
              throw error;
            }
          }
          segments.push({from: from.name, to: to.name, ...result});
        } catch (error) {
          segments.push({
            from: from.name,
            to: to.name,
            distance: 0,
            duration: 0,
            path: [[from.lng, from.lat], [to.lng, to.lat]],
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
      drivingRoute,
      searchTips: (keyword) => provider.searchTips(keyword),
      resolveTip: (tip) => provider.resolveTip(tip),
      resolvePlace: (keyword) => provider.resolvePlace(keyword),
      reverseGeocode: (lng, lat) => provider.reverseGeocode(lng, lat),
      setZoomAndCenter: (zoom, center) => provider.setZoomAndCenter(zoom, center),
      testSearch: (keyword) => provider.testSearch(keyword)
    };
  }

  window.RouteMapController = {create};
})();
