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
      const scenicMap = {};
      for (const day of route.days) {
        for (const item of getDayPoints(day)) {
          const spot = await ensureScenicInfo(item.point.name);
          if (spot) scenicMap[item.point.name] = spot;
        }
      }
      const days = route.days.map((day, dayIndex) => {
        const points = getDayPoints(day).map((item) => ({
          name: item.point.name,
          lng: item.point.lng,
          lat: item.point.lat,
          role: item.role,
          kind: item.kind,
          scenic: scenicMap[item.point.name] || null
        }));
        const segments = (segmentResults[dayIndex]?.segments || []).map((segment) => ({
          from: segment.from,
          to: segment.to,
          distance: segment.distance || 0,
          duration: segment.duration || 0,
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
