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
    isMapReady,
    getEditableRoute
  }) {
    let archivedRoutes = [];
    let publishedRoutes = [];

    function getRoutes() {
      return archivedRoutes;
    }

    function getPublishedRoutes() {
      return publishedRoutes;
    }

    function setStatus(message) {
      const status = el('routeManageStatus');
      if (status) status.textContent = message || '';
    }

    function routeTitle(item) {
      return cleanRouteName(item?.name) || item?.safeName || item?.id || '未命名路线';
    }

    function renderMyRoute(item) {
      const version = encodeURIComponent(item.updatedAt || item.archivedAt || Date.now());
      const base = localService.routeAssetBase(item);
      const canLoad = item.cloud || item.routeJson || item.routeData;
      const mp4Url = item.assetUrls?.mp4 || `${base}.mp4?v=${version}`;
      const manualPdfUrl = item.assetUrls?.manualPdf || `${base}.travel.pdf?v=${version}`;
      const productZipUrl = item.assetUrls?.productZip || localService.routeProductZipUrl?.(item.safeName);
      const publishButton = localService.capabilities?.publishedRoutes
        ? `<button class="small" onclick="publishArchivedRoute('${escapeJsAttr(item.safeName)}')">发布</button>`
        : '';
      if (item.cloud) {
        return `
          <div class="archive-item cloud-route-item">
            <div class="archive-item-head">
              <span>${escapeHtml(routeTitle(item))}</span>
              <span class="cloud-save-state">私有</span>
            </div>
            <div class="archive-item-actions">
              <button class="small primary" onclick="loadArchivedRoute('${escapeJsAttr(item.safeName)}')">载入</button>
              ${publishButton}
              ${productZipUrl ? `<button class="small" onclick="window.open('${escapeJsAttr(productZipUrl)}', '_blank')">下载ZIP</button>` : ''}
              ${item.mp4 ? `<button class="small" onclick="window.open('${escapeJsAttr(mp4Url)}', '_blank')">播放MP4</button>` : ''}
              ${item.manualPdf ? `<button class="small" onclick="window.open('${escapeJsAttr(manualPdfUrl)}', '_blank')">查看PDF</button>` : ''}
            </div>
          </div>
        `;
      }
      return `
        <div class="archive-item">
          <div class="archive-item-head">
            <span>${escapeHtml(routeTitle(item))}</span>
          </div>
          <div class="asset-tags">
            <span class="asset-tag ${item.routeJson ? 'ok' : 'wait'}">线路JSON ${item.routeJson ? '✓' : '待生成'}</span>
            <span class="asset-tag ${item.manualPdf ? 'ok' : 'wait'}">产品文档 ${item.manualPdf ? '✓' : '待生成'}</span>
          </div>
          <div class="archive-item-actions">
            ${canLoad ? `<button class="small primary" onclick="loadArchivedRoute('${escapeJsAttr(item.safeName)}')">载入</button>` : ''}
            ${publishButton}
            ${productZipUrl ? `<button class="small" onclick="window.open('${escapeJsAttr(productZipUrl)}', '_blank')">下载ZIP</button>` : ''}
            ${item.mp4 ? `<button class="small" onclick="window.open('${escapeJsAttr(mp4Url)}', '_blank')">播放MP4</button>` : ''}
            ${item.manualPdf ? `<button class="small" onclick="window.open('${escapeJsAttr(manualPdfUrl)}', '_blank')">查看PDF</button>` : ''}
          </div>
        </div>
      `;
    }

    function renderPublishedRoute(item) {
      const time = item.archivedAt ? new Date(item.archivedAt).toLocaleString() : '';
      const zipUrl = item.assetUrls?.productZip || localService.publishedRouteProductZipUrl?.(item.id);
      return `
        <div class="archive-item">
          <div class="archive-item-head">
            <span>${escapeHtml(routeTitle(item))}</span>
            <span class="cloud-save-state">公共</span>
          </div>
          <div class="archive-item-sub">发布者：${escapeHtml(item.publishedByEmail || '未知')}${time ? ` · ${escapeHtml(time)}` : ''}</div>
          <div class="archive-item-actions">
            <button class="small primary" onclick="importPublishedRoute('${escapeJsAttr(item.id)}')">导入</button>
            ${zipUrl ? `<button class="small" onclick="window.open('${escapeJsAttr(zipUrl)}', '_blank')">下载ZIP</button>` : ''}
          </div>
        </div>
      `;
    }

    function renderArchiveList() {
      const box = el('archiveList');
      if (!box) return;
      const myHtml = archivedRoutes.length
        ? archivedRoutes.map(renderMyRoute).join('')
        : '<div class="hint">你还没有保存过路线。</div>';
      const publishedHtml = publishedRoutes.length
        ? publishedRoutes.map(renderPublishedRoute).join('')
        : '<div class="hint">还没有公共路线。发布当前路线后，所有用户都可以导入。</div>';
      box.innerHTML = `
        <section class="archive-section">
          <div class="archive-section-title"><span>我的路线</span><span>${archivedRoutes.length}</span></div>
          ${myHtml}
        </section>
        <section class="archive-section">
          <div class="archive-section-title"><span>公共路线</span><span>${publishedRoutes.length}</span></div>
          ${publishedHtml}
        </section>
      `;
    }

    async function refresh({autoSelectFirst = false} = {}) {
      const box = el('archiveList');
      try {
        const {response, data: result} = await localService.listRoutes();
        if (!response.ok || !result?.ok) throw new Error(result?.message || '无法读取导出列表');
        archivedRoutes = result.routes || [];
        if (localService.capabilities?.publishedRoutes) {
          const {response: publishResponse, data: publishResult} = await localService.listPublishedRoutes();
          if (!publishResponse.ok || !publishResult?.ok) throw new Error(publishResult?.message || '无法读取公共路线');
          publishedRoutes = publishResult.routes || [];
        }
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
        renderArchiveList();
        setStatus('路线库已同步。');
      } catch (error) {
        const suffix = '。请确认已登录，并且本机服务正在运行。';
        if (box) box.innerHTML = `<div class="hint">读取路线失败：${escapeHtml(error.message)}${suffix}</div>`;
      }
    }

    async function getArchiveRouteData(item) {
      if (item?.routeData) return item.routeData;
      const base = localService.routeAssetBase(item);
      const version = encodeURIComponent(item?.updatedAt || item?.archivedAt || Date.now());
      const response = await fetch(`${base}.route.json?v=${version}`);
      const data = await response.json();
      if (!response.ok) throw new Error('无法读取导出线路');
      return data;
    }

    async function load(safeName) {
      try {
        const cached = archivedRoutes.find((item) => item.safeName === safeName);
        if (!cached) throw new Error('未找到这条路线');
        const data = await getArchiveRouteData(cached);
        const fileBase = cached.fileBase || safeName;

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
          const version = encodeURIComponent(cached.updatedAt || cached.archivedAt || Date.now());
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

    async function publishRouteData(routeData, mapLayer) {
      const {response, data} = await localService.publishRoute(routeData, mapLayer);
      if (!response.ok || !data?.ok) throw new Error(data?.message || '发布失败');
      await refresh();
      toast('路线已发布到公共路线库。');
      setStatus(`已发布：${routeData.name || '未命名路线'}`);
    }

    async function publishCurrent() {
      try {
        const state = getState();
        const routeData = getEditableRoute ? getEditableRoute(state.route) : state.route;
        await publishRouteData(routeData, state.currentMapLayer || 'standard');
      } catch (error) {
        toast('发布失败：' + error.message);
      }
    }

    async function publishRouteById(safeName) {
      try {
        const state = getState();
        const localRoute = state.routeBook.routes.find((item) => item.id === safeName);
        const cached = archivedRoutes.find((item) => item.safeName === safeName);
        const routeData = localRoute || await getArchiveRouteData(cached);
        await publishRouteData(getEditableRoute ? getEditableRoute(routeData) : routeData, cached?.mapLayer || state.currentMapLayer || 'standard');
      } catch (error) {
        toast('发布失败：' + error.message);
      }
    }

    async function importPublished(routeId) {
      try {
        const {response, data} = await localService.importPublishedRoute(routeId);
        if (!response.ok || !data?.ok) throw new Error(data?.message || '导入失败');
        const state = getState();
        const routeBook = state.routeBook;
        const route = normalizeRoute(data.importedRoute);
        route.segmentCache = {};
        routeBook.routes.push(route);
        routeBook.activeRouteId = route.id;
        setState({route, currentRouteView: 'all', segmentResults: []});
        saveRoute(false);
        renderAll(true);
        if (isMapReady() && route.days.some((day) => getDayPoints(day).map((item) => item.point).filter(isPointReady).length >= 2)) {
          calculateRoute();
        }
        await refresh();
        toast('已导入公共路线：' + (route.name || data.routeName || '未命名路线'));
      } catch (error) {
        toast('导入失败：' + error.message);
      }
    }

    return {getRoutes, getPublishedRoutes, refresh, load, publishCurrent, publishRouteById, importPublished};
  }

  window.ArchiveController = {create};
})();
