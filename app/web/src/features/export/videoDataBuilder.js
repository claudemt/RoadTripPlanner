(function () {
  function create({
    routeColors,
    getDayPoints,
    cleanDayTitle,
    summarizeVideoDays
  }) {
    const readyPoints = (day) => getDayPoints(day)
      .filter((item) => window.RouteModel.isPointReady(item.point));

    async function loadScenicMap(route, ensureScenicInfo) {
      const names = [...new Set(route.days
        .flatMap((day) => readyPoints(day)
          .filter((item) => item.point.useScenic !== false)
          .map((item) => item.point.name))
        .filter(Boolean))];
      const entries = await Promise.all(names.map(async (name) => [name, await ensureScenicInfo(name)]));
      return Object.fromEntries(entries.filter(([, spot]) => spot));
    }

    function pointScenic(point, scenicMap) {
      return point.useScenic === false ? null : (scenicMap[point.name] || null);
    }

    async function buildSelection({route, ensureScenicInfo}) {
      const scenicMap = await loadScenicMap(route, ensureScenicInfo);
      return {
        days: route.days.map((day, dayIndex) => ({
          title: cleanDayTitle(day.title) || `第 ${dayIndex + 1} 天`,
          points: readyPoints(day).map((item) => ({
            name: item.point.name,
            lng: item.point.lng,
            lat: item.point.lat,
            role: item.role === '起' || item.role === '终' ? item.role : '',
            kind: item.kind,
            useScenic: item.point.useScenic !== false,
            scenic: pointScenic(item.point, scenicMap)
          }))
        }))
      };
    }

    async function build({
      route,
      segmentResults,
      currentMapLayer,
      presentation,
      pointInfo,
      ensureScenicInfo
    }) {
      const scenicMap = await loadScenicMap(route, ensureScenicInfo);
      const days = route.days.map((day, dayIndex) => {
        const points = readyPoints(day)
          .map((item, pointIndex) => {
            const info = pointInfo?.days?.[dayIndex]?.points?.[pointIndex] || {};
            return {
              name: item.point.name,
              lng: item.point.lng,
              lat: item.point.lat,
              role: item.role === '起' || item.role === '终' ? item.role : '',
              kind: item.kind,
              transportMode: item.point.transportMode || 'drive',
              labelOffset: item.point.labelOffset || {x: 0, y: 0},
              useScenic: item.point.useScenic !== false,
              scenic: pointScenic(item.point, scenicMap),
              ...(Number.isFinite(Number(info.elevationM)) ? {elevationM: Number(info.elevationM)} : {}),
              ...(info.weather ? {weather: info.weather} : {})
            };
          });
        const segments = (segmentResults[dayIndex]?.segments || []).map((segment) => ({
          from: segment.from,
          to: segment.to,
          distance: segment.distance || 0,
          duration: segment.duration || 0,
          mode: segment.mode || 'drive',
          path: segment.path || [],
          error: segment.error || ''
        }));
        return {
          title: cleanDayTitle(day.title) || `第 ${dayIndex + 1} 天`,
          points,
          segments,
          color: routeColors[dayIndex % routeColors.length]
        };
      });
      return {
        version: 2,
        exportedAt: new Date().toISOString(),
        mapLayer: presentation?.mapLayer || currentMapLayer,
        presentation: window.MapPresentation.normalize(presentation || {mapLayer: currentMapLayer}),
        route: {id: route.id, name: route.name || '自驾路线', description: route.description || ''},
        days,
        summary: summarizeVideoDays(days)
      };
    }

    return {build, buildSelection};
  }

  window.VideoDataBuilder = {create};
})();
