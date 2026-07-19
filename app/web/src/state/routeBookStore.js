(function () {
  function create({storageKey, defaultRoute, normalizeRoute}) {
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
        if (stored) return normalizeBook(JSON.parse(stored));
      } catch (_) {}
      return normalizeBook({activeRouteId: '', routes: []});
    }

    function save(book) {
      localStorage.setItem(storageKey, JSON.stringify(normalizeBook(book)));
    }

    function getActive(book) {
      return book.routes.find((route) => route.id === book.activeRouteId) || book.routes[0];
    }

    function upsert(book, routeData) {
      const route = normalizeRoute(routeData);
      if (!route?.days) return null;
      route.segmentCache = {};
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

    return {normalizeBook, load, save, getActive, upsert, isMostlyBlank};
  }

  window.RouteBookStore = {create};
})();
