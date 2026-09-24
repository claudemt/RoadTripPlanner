(function () {
  function create({
    localService,
    getDayPoints,
    isPointReady,
    geoSignature,
    addDays,
    weatherTtlMinutes = 30,
    onUpdated = () => {},
    onError = () => {}
  }) {
    const weatherTtlMs = Math.max(1, Number(weatherTtlMinutes) || 30) * 60 * 1000;
    const pending = new WeakMap();
    let scheduledTimer = null;

    function readyPoints(day) {
      return getDayPoints(day).filter((item) => isPointReady(item.point));
    }

    function buildPayload(route) {
      return {
        startDate: route.presentation.startDate,
        weather: route.presentation.weather,
        elevation: route.presentation.elevation,
        days: route.days.map((day) => ({
          points: readyPoints(day).map(({point}) => ({
            name: point.name,
            lng: Number(point.lng),
            lat: Number(point.lat)
          }))
        }))
      };
    }

    function merge(route, responseDays) {
      route.pointInfoCache = route.pointInfoCache || {version: 1, days: {}};
      route.pointInfoCache.days = route.pointInfoCache.days || {};
      (responseDays || []).forEach((dayInfo, dayIndex) => {
        const previous = route.pointInfoCache.days[dayIndex] || {points: []};
        const signature = geoSignature(route.days[dayIndex]);
        const preservePrevious = previous.geoSignature === signature;
        const points = (dayInfo.points || []).map((info, pointIndex) => {
          const old = preservePrevious ? (previous.points?.[pointIndex] || {}) : {};
          return {
            ...(Number.isFinite(Number(old.elevationM)) ? {elevationM: Number(old.elevationM)} : {}),
            ...(previous.date === dayInfo.date && old.weather ? {weather: old.weather} : {}),
            ...(Number.isFinite(Number(info?.elevationM)) ? {elevationM: Number(info.elevationM)} : {}),
            ...(info?.weather ? {weather: info.weather} : {})
          };
        });
        route.pointInfoCache.days[dayIndex] = {
          geoSignature: signature,
          date: dayInfo.date || null,
          weatherFetchedAt: route.presentation.weather ? new Date().toISOString() : previous.weatherFetchedAt || null,
          points
        };
      });
    }

    function needsRefresh(route) {
      const presentation = route?.presentation;
      if (!presentation?.weather && !presentation?.elevation) return false;
      return route.days.some((day, dayIndex) => {
        const count = readyPoints(day).length;
        if (!count) return false;
        const cachedDay = route.pointInfoCache?.days?.[dayIndex];
        if (cachedDay?.geoSignature !== geoSignature(day)) return true;
        const points = cachedDay?.points || [];
        if (points.length < count) return true;
        if (presentation.elevation && points.slice(0, count).some((item) => !Number.isFinite(Number(item?.elevationM)))) return true;
        if (!presentation.weather) return false;
        const expectedDate = addDays(presentation.startDate, dayIndex);
        if (cachedDay.date !== expectedDate) return true;
        if (points.slice(0, count).some((item) => !item?.weather || item.weather.date !== expectedDate)) return true;
        return !cachedDay.weatherFetchedAt || Date.now() - Date.parse(cachedDay.weatherFetchedAt) > weatherTtlMs;
      });
    }

    async function refresh(route, {silent = true} = {}) {
      if (!route?.presentation?.weather && !route?.presentation?.elevation) return true;
      if (pending.has(route)) return pending.get(route);
      const task = localService.pointInfo(buildPayload(route))
        .then(({response, data}) => {
          if (!response.ok || !data?.ok) throw new Error(data?.message || '点位信息暂时不可用');
          merge(route, data.days);
          onUpdated(route);
          return true;
        })
        .catch((error) => {
          onError(error, silent);
          return false;
        })
        .finally(() => pending.delete(route));
      pending.set(route, task);
      return task;
    }

    function schedule(route, immediate = false) {
      clearTimeout(scheduledTimer);
      if (!needsRefresh(route)) return;
      scheduledTimer = setTimeout(() => refresh(route), immediate ? 0 : 350);
    }

    function dispose() {
      clearTimeout(scheduledTimer);
      scheduledTimer = null;
    }

    return {refresh, schedule, needsRefresh, dispose};
  }

  window.PointInfoController = {create};
})();
