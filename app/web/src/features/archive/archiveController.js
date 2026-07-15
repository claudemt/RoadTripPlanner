(function () {
  function create({
    el,
    localService,
    routeStore,
    normalizeRoute,
    getDayPoints,
    isPointReady,
    daySignature,
    cleanRouteName,
    escapeHtml,
    escapeJsAttr,
    toast,
    getState,
    setState,
    saveRoute,
    renderRouteSelect,
    renderDays,
    renderSummary,
    syncEditor,
    renderAll,
    calculateRoute,
    isMapReady
  }) {
    let archivedRoutes = [];

    function getRoutes() {
      return archivedRoutes;
    }

    function renderArchiveList(routes) {
      const box = el('archiveList');
      if (!routes.length) {
        box.innerHTML = '';
        return;
      }
      box.innerHTML = routes.map((item) => {
        const version = encodeURIComponent(item.updatedAt || item.archivedAt || Date.now());
        const base = localService.routeAssetBase(item);
        return `
          <div class="archive-item">
            <div class="archive-item-head">
              <span>${escapeHtml(cleanRouteName(item.name) || item.safeName)}</span>
            </div>
            <div class="asset-tags">
              <span class="asset-tag ${item.routeJson ? 'ok' : 'wait'}">线路JSON ${item.routeJson ? '✓' : '待生成'}</span>
              <span class="asset-tag ${item.manualPdf ? 'ok' : 'wait'}">产品文档 ${item.manualPdf ? '✓' : '待生成'}</span>
            </div>
            <div class="archive-item-actions">
              ${item.routeJson ? `<button class="small primary" onclick="loadArchivedRoute('${escapeJsAttr(item.safeName)}')">载入</button>` : ''}
              ${item.mp4 ? `<button class="small" onclick="window.open('${escapeJsAttr(`${base}.mp4?v=${version}`)}', '_blank')">播放MP4</button>` : ''}
              ${item.manualPdf ? `<button class="small" onclick="window.open('${escapeJsAttr(`${base}.travel.pdf?v=${version}`)}', '_blank')">查看PDF</button>` : ''}
            </div>
          </div>
        `;
      }).join('');
    }

    async function refresh({autoSelectFirst = false} = {}) {
      const box = el('archiveList');
      try {
        const {response, data: result} = await localService.listRoutes();
        if (!response.ok || !result?.ok) throw new Error(result?.message || '无法读取导出列表');
        archivedRoutes = result.routes || [];
        const state = getState();
        const routeBook = state.routeBook;
        let route = state.route;
        let imported = 0;

        for (const item of archivedRoutes) {
          if (!item.routeData) continue;
          routeStore.upsert(routeBook, item.routeData);
          imported += 1;
        }

        if (imported > 0) {
          const diskRouteKeys = new Set(archivedRoutes
            .filter((item) => item.routeData)
            .flatMap((item) => [item.routeData.id, item.routeData.name].filter(Boolean)));
          routeBook.routes = routeBook.routes.filter((item) => {
            return diskRouteKeys.has(item.id) || diskRouteKeys.has(item.name) || !routeStore.isMostlyBlank(item);
          });
          const firstDiskRoute = routeBook.routes.find((item) => diskRouteKeys.has(item.id) || diskRouteKeys.has(item.name));
          if (firstDiskRoute && (autoSelectFirst || routeStore.isMostlyBlank(route) || routeBook.activeRouteId === 'blank-route')) {
            routeBook.activeRouteId = firstDiskRoute.id;
          }
          if (!routeBook.routes.find((item) => item.id === routeBook.activeRouteId)) {
            routeBook.activeRouteId = routeBook.routes[0]?.id;
          }
          if (autoSelectFirst) {
            const firstReadyRoute = routeBook.routes.find((item) => !routeStore.isMostlyBlank(item));
            if (firstReadyRoute) routeBook.activeRouteId = firstReadyRoute.id;
          }
          route = routeStore.getActive(routeBook);
          setState({route});
          saveRoute(false);
        }

        renderRouteSelect();
        renderDays();
        renderSummary();
        syncEditor();
        renderArchiveList(archivedRoutes);
      } catch (error) {
        box.innerHTML = `<div class="hint">读取导出失败：${escapeHtml(error.message)}。请先运行 start.bat 启动本地服务。</div>`;
      }
    }

    async function load(safeName) {
      try {
        const cached = archivedRoutes.find((item) => item.safeName === safeName);
        let data = cached?.routeData || null;
        const fileBase = cached?.fileBase || safeName;
        if (!data) {
          const base = localService.routeAssetBase({safeName, fileBase});
          const version = encodeURIComponent(cached?.updatedAt || cached?.archivedAt || Date.now());
          const response = await fetch(`${base}.route.json?v=${version}`);
          data = await response.json();
          if (!response.ok) throw new Error('无法读取导出线路');
        }

        const state = getState();
        const routeBook = state.routeBook;
        const route = normalizeRoute(data);
        route.segmentCache = {};
        const index = routeBook.routes.findIndex((item) => item.id === route.id || item.name === route.name);
        if (index >= 0) routeBook.routes[index] = route;
        else routeBook.routes.push(route);
        routeBook.activeRouteId = route.id;
        let segmentResults = [];

        try {
          const base = localService.routeAssetBase({safeName, fileBase});
          const version = encodeURIComponent(cached?.updatedAt || cached?.archivedAt || Date.now());
          const response = await fetch(`${base}.mp4-data.json?v=${version}`);
          if (response.ok) {
            const video = await response.json();
            segmentResults = (video.days || []).map((day) => ({segments: day.segments || []}));
            route.days.forEach((day, dayIndex) => {
              if (segmentResults[dayIndex]) {
                route.segmentCache[dayIndex] = {
                  signature: daySignature(day),
                  segments: segmentResults[dayIndex].segments
                };
              }
            });
          }
        } catch (_) {}

        setState({route, currentRouteView: 'all', segmentResults});
        saveRoute(false);
        renderAll(true);
        if (isMapReady() && route.days.some((day) => getDayPoints(day).map((item) => item.point).filter(isPointReady).length >= 2)) {
          calculateRoute();
        }
        toast('已载入路线：' + (route.name || safeName));
      } catch (error) {
        toast('载入导出失败：' + error.message);
      }
    }

    return {getRoutes, refresh, load};
  }

  window.ArchiveController = {create};
})();
