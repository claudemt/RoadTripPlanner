(function () {
  const MAX_STORAGE_CHARS = 3.6 * 1024 * 1024;
  const MAX_PERSISTED_ROUTES = 8;
  const FLUSH_DELAY_MS = 150;

  function create({storageKey, defaultRoute, normalizeRoute}) {
    let pending = null;
    let flushTimer = null;
    let lastJson = '';

    function dropSegmentCache(route) {
      if (!route || typeof route !== 'object') return route;
      const {segmentCache, ...rest} = route;
      return rest;
    }

    function slimSegmentCache(cache) {
      if (!cache || typeof cache !== 'object') return cache;
      return Object.entries(cache).reduce((result, [dayIndex, day]) => {
        if (!day || typeof day !== 'object') return result;
        result[dayIndex] = {
          ...day,
          options: [],
          segments: (Array.isArray(day.segments) ? day.segments : []).map((segment) => {
            if (!segment || typeof segment !== 'object') return segment;
            const {alternatives, autoAlternative, fetchingAuto, autoError, ...rest} = segment;
            return rest;
          })
        };
        return result;
      }, {});
    }

    function normalizeBook(input) {
      if (input && Array.isArray(input.routes)) {
        const routes = input.routes.map(normalizeRoute).filter(Boolean);
        return {
          activeRouteId: routes.some((route) => route.id === input.activeRouteId) ? input.activeRouteId : routes[0]?.id,
          routes
        };
      }
      if (input && input.days) {
        const route = normalizeRoute(input);
        return {activeRouteId: route.id, routes: [route]};
      }
      return {activeRouteId: '', routes: []};
    }

    function load() {
      try {
        const stored = localStorage.getItem(storageKey);
        if (stored) {
          lastJson = stored;
          return normalizeBook(JSON.parse(stored));
        }
      } catch (_) {}
      return normalizeBook({activeRouteId: '', routes: []});
    }

    function pickRoutes(book, cacheMode) {
      const activeId = book.activeRouteId;
      const active = book.routes.find((route) => route.id === activeId) || null;
      const budget = MAX_PERSISTED_ROUTES - (active ? 1 : 0);
      const others = book.routes.filter((route) => route !== active).slice(0, Math.max(0, budget));
      const kept = new Set(others);
      if (active) kept.add(active);
      return book.routes.filter((route) => kept.has(route)).map((route) => {
        if (route !== active) return dropSegmentCache(route);
        if (cacheMode === 'full') return route;
        if (cacheMode === 'slim') return {...route, segmentCache: slimSegmentCache(route.segmentCache)};
        return dropSegmentCache(route);
      });
    }

    function reclaimSpace() {
      try {
        Object.keys(localStorage)
          .filter((key) => key.startsWith('roadtrip-api-cache:'))
          .forEach((key) => localStorage.removeItem(key));
      } catch (_) {}
    }

    function tryWrite(book, cacheMode) {
      let json = '';
      try {
        json = JSON.stringify({
          activeRouteId: book.activeRouteId,
          routes: pickRoutes(book, cacheMode)
        });
      } catch (_) {
        return false;
      }
      if (json.length > MAX_STORAGE_CHARS) return false;
      if (json === lastJson) return true;
      try {
        localStorage.setItem(storageKey, json);
        lastJson = json;
        return true;
      } catch (_) {
        return false;
      }
    }

    function write(book) {
      if (tryWrite(book, 'full')) return true;
      if (tryWrite(book, 'slim')) return true;
      if (tryWrite(book, 'none')) return true;
      reclaimSpace();
      if (tryWrite(book, 'slim')) return true;
      return tryWrite(book, 'none');
    }

    function flush() {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      const book = pending;
      pending = null;
      if (!book) return;
      try {
        write(book);
      } catch (_) {}
    }

    function save(book) {
      if (!book) return;
      pending = book;
      if (flushTimer) return;
      flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
    }

    function getActive(book) {
      return book.routes.find((route) => route.id === book.activeRouteId) || book.routes[0];
    }

    function upsert(book, routeData) {
      const previous = routeData?.id
        ? book.routes.find((item) => item.id === routeData.id)
        : null;
      const route = normalizeRoute(routeData);
      if (!route?.days) return null;
      const routeModel = window.RouteModel;
      route.labelOffsets = routeModel?.normalizeLabelOffsets
        ? routeModel.normalizeLabelOffsets({...(previous?.labelOffsets || {}), ...(route.labelOffsets || {})})
        : {...(previous?.labelOffsets || {}), ...(route.labelOffsets || {})};
      routeModel?.applyLabelOffsets?.(route);
      route.segmentCache = routeData?.segmentCache && typeof routeData.segmentCache === 'object'
        ? routeData.segmentCache
        : {};
      const index = book.routes.findIndex((item) => item.id === route.id || item.name === route.name);
      if (index >= 0) book.routes[index] = route;
      else book.routes.push(route);
      return route;
    }

    function isMostlyBlank(route) {
      if (!route) return true;
      const days = route.days || [];
      return !days.some((day) => {
        const points = [day.from, ...(day.waypoints || []), day.to];
        return points.some((point) => point && point.name && Number.isFinite(Number(point.lng)) && Number.isFinite(Number(point.lat)));
      });
    }

    return {load, save, flush, getActive, upsert, isMostlyBlank};
  }

  window.RouteBookStore = {create};
})();
