(function () {
  function create({
    routeColors,
    getDayPoints,
    cleanDayTitle,
    summarizeVideoDays
  }) {
    async function build({
      route,
      segmentResults,
      currentMapLayer,
      ensureScenicInfo
    }) {
      const names = [...new Set(route.days
        .flatMap((day) => getDayPoints(day)
          .filter((item) => item.point.useScenic !== false)
          .map((item) => item.point.name))
        .filter(Boolean))];
      const scenicEntries = await Promise.all(names.map(async (name) => [name, await ensureScenicInfo(name)]));
      const scenicMap = Object.fromEntries(scenicEntries.filter(([, spot]) => spot));
      const days = route.days.map((day, dayIndex) => {
        const points = getDayPoints(day).map((item) => ({
          name: item.point.name,
          lng: item.point.lng,
          lat: item.point.lat,
          role: item.role,
          kind: item.kind,
          transportMode: item.point.transportMode || 'drive',
          labelOffset: item.point.labelOffset || {x: 0, y: 0},
          useScenic: item.point.useScenic !== false,
          scenic: item.point.useScenic === false ? null : (scenicMap[item.point.name] || null)
        }));
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
        version: 1,
        exportedAt: new Date().toISOString(),
        mapLayer: currentMapLayer,
        renderSpeed: 1,
        route: {id: route.id, name: route.name || '自驾路线'},
        days,
        summary: summarizeVideoDays(days)
      };
    }

    return {build};
  }

  window.VideoDataBuilder = {create};
})();
