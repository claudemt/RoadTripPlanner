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
    renderAll,
    calculateRoute,
    isMapReady,
    getEditableRoute,
    buildPublishVideoData,
    onAssetsReady,
    onImported
  }) {
    let archivedRoutes = [];
    let publishedRoutes = [];
    let refreshPromise = null;
    const busy = new Set();

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

    function renderMyRouteItem(item, {editable = false, index = 0} = {}) {
      const version = encodeURIComponent(item.updatedAt || item.archivedAt || Date.now());
      const base = localService.routeAssetBase(item);
      const canLoad = item.cloud || item.routeJson || item.routeData;
      const mp4Url = item.assetUrls?.mp4 || `${base}.mp4?v=${version}`;
      const manualPdfUrl = item.assetUrls?.manualPdf || `${base}.travel.pdf?v=${version}`;
      const mapImageUrl = item.assetUrls?.mapImage || `${base}.route-map.png?v=${version}`;
      const productZipUrl = item.assetUrls?.productZip || localService.routeProductZipUrl?.(item.safeName);
      const targetId = escapeJsAttr(item.routeData?.id || item.safeName);
      const publishButton = localService.capabilities?.publishedRoutes
        ? `<button class="small" onclick="publishArchivedRoute('${escapeJsAttr(item.safeName)}')">发布</button>`
        : '';
      const editButtons = editable
        ? `<button class="small" onclick="accountRenameRoute('${escapeJsAttr(item.safeName)}')">改名</button>
           <button class="small danger" onclick="accountDeleteRoute('${escapeJsAttr(item.safeName)}')">删除</button>`
        : '';
      const assetButtons = [
        productZipUrl ? `<button class="small" onclick="window.open('${escapeJsAttr(productZipUrl)}', '_blank')">下载ZIP</button>` : '',
        (item.mapImage || item.assetUrls?.mapImage) ? `<button class="small" onclick="window.open('${escapeJsAttr(mapImageUrl)}', '_blank')">查看PNG</button>` : '',
        (item.mp4 || item.assetUrls?.mp4) ? `<button class="small" onclick="window.open('${escapeJsAttr(mp4Url)}', '_blank')">播放MP4</button>` : '',
        (item.manualPdf || item.assetUrls?.manualPdf) ? `<button class="small" onclick="window.open('${escapeJsAttr(manualPdfUrl)}', '_blank')">查看PDF</button>` : '',
      ].join('');
      return `
        <div class="archive-item ${item.cloud ? 'cloud-route-item' : ''}" style="--i:${index}">
          <div class="archive-item-head">
            <span>${escapeHtml(routeTitle(item))}</span>
            ${item.cloud ? '<span class="cloud-save-state">私有</span>' : ''}
          </div>
          ${item.cloud ? '' : `<div class="asset-tags">
            <span class="asset-tag ${item.routeJson ? 'ok' : 'wait'}">线路JSON ${item.routeJson ? '✓' : '待生成'}</span>
            <span class="asset-tag ${item.mapImage ? 'ok' : 'wait'}">总览PNG ${item.mapImage ? '✓' : '待生成'}</span>
            <span class="asset-tag ${item.manualPdf ? 'ok' : 'wait'}">产品文档 ${item.manualPdf ? '✓' : '待生成'}</span>
          </div>`}
          <div class="archive-item-actions">
            <button class="small" onclick="accountPreviewRoute('mine','${targetId}')">查看</button>
            ${canLoad ? `<button class="small primary" onclick="loadArchivedRoute('${escapeJsAttr(item.safeName)}')">打开</button>` : ''}
            ${publishButton}
            ${editButtons}
            ${assetButtons}
          </div>
        </div>
      `;
    }

    function renderPublishedRouteItem(item, index = 0) {
      const time = item.archivedAt ? new Date(item.archivedAt).toLocaleString() : '';
      const zipUrl = item.assetUrls?.productZip || localService.publishedRouteProductZipUrl?.(item.id);
      return `
        <div class="archive-item" style="--i:${index}">
          <div class="archive-item-head">
            <span>${escapeHtml(routeTitle(item))}</span>
            <span class="cloud-save-state">公共</span>
          </div>
          <div class="archive-item-sub">发布者：${item.contributor?.email ? `<button class="contributor-link" type="button" onclick="accountOpenProfile('${escapeJsAttr(item.contributor.email)}')">${escapeHtml(item.contributor.nickname || '未知用户')}</button>` : '未知用户'}${time ? ` · ${escapeHtml(time)}` : ''}</div>
          <div class="archive-item-actions">
            <button class="small primary" onclick="accountPreviewRoute('public','${escapeJsAttr(item.id)}')">查看</button>
            <button class="small" onclick="importPublishedRoute('${escapeJsAttr(item.id)}')">导入</button>
            ${zipUrl ? `<button class="small" onclick="window.open('${escapeJsAttr(zipUrl)}', '_blank')">下载ZIP</button>` : ''}
          </div>
        </div>
      `;
    }

    function renderArchiveList() {
      const box = el('archiveList');
      if (!box) return;
      const myHtml = archivedRoutes.length
        ? archivedRoutes.map((item, index) => renderMyRouteItem(item, {editable: true, index})).join('')
        : '<div class="hint">你还没有保存过路线。</div>';
      const publishedHtml = publishedRoutes.length
        ? publishedRoutes.map(renderPublishedRouteItem).join('')
        : '<div class="hint">还没有公共路线。</div>';
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

    async function refresh({autoSelectFirst = false, force = false} = {}) {
      if (refreshPromise) return refreshPromise;
      const box = el('archiveList');
      const refreshButton = el('refreshRouteLibraryBtn');
      const previousRefreshText = refreshButton?.textContent;
      if (refreshButton) {
        refreshButton.disabled = true;
        refreshButton.textContent = '同步中…';
      }
      refreshPromise = (async () => {
        try {
        setStatus(force ? '正在刷新路线库…' : '正在同步路线库…');
        const [{response, data: result}, publishedResultPair] = await Promise.all([
          localService.listRoutes({force}),
          localService.capabilities?.publishedRoutes
            ? localService.listPublishedRoutes({force})
            : Promise.resolve(null)
        ]);
        if (!response.ok || !result?.ok) throw new Error(result?.message || '无法读取导出列表');
        archivedRoutes = result.routes || [];
        if (publishedResultPair) {
          const {response: publishResponse, data: publishResult} = publishedResultPair;
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
          routeStore.save(routeBook);
        }

        renderRouteSelect();
        renderDays();
        renderArchiveList();
        setStatus(result.stale || publishedResultPair?.stale ? '已使用本机缓存路线库，稍后可重试同步。' : '路线库已同步。');
      } catch (error) {
        const suffix = '。请确认已登录，并且本机服务正在运行。';
        if (box) box.innerHTML = `<div class="hint">读取路线失败：${escapeHtml(error.message)}${suffix}</div>`;
        throw error;
      } finally {
        if (refreshButton) {
          refreshButton.disabled = false;
          refreshButton.textContent = previousRefreshText || '刷新';
        }
        refreshPromise = null;
      }
      })();
      return refreshPromise;
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
      if (busy.has(`load:${safeName}`)) return toast('正在载入路线，请稍候。');
      busy.add(`load:${safeName}`);
      try {
        const cached = archivedRoutes.find((item) => item.safeName === safeName);
        if (!cached) throw new Error('未找到这条路线');
        const data = await getArchiveRouteData(cached);
        const fileBase = cached.fileBase || safeName;

        const state = getState();
        const routeBook = state.routeBook;
        const route = normalizeRoute(data);
        route.segmentCache = route.segmentCache || {};
        const index = routeBook.routes.findIndex((item) => item.id === route.id || item.name === route.name);
        if (index >= 0) routeBook.routes[index] = route;
        else routeBook.routes.push(route);
        routeBook.activeRouteId = route.id;
        let segmentResults = (route.days || []).map((day, dayIndex) => {
          const cached = route.segmentCache?.[dayIndex];
          const expectedSegments = Math.max(0, getDayPoints(day).filter((item) => isPointReady(item.point)).length - 1);
          const signatureMatches = cached?.signature && cached.signature === daySignature(day);
          const legacyShapeMatches = !cached?.signature && Array.isArray(cached?.segments) && cached.segments.length >= expectedSegments;
          return cached && Array.isArray(cached.segments) && (signatureMatches || legacyShapeMatches)
            ? {segments: cached.segments}
            : {segments: []};
        });

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
        routeStore.save(routeBook);
        renderAll(true);
        toast('已载入路线：' + (route.name || safeName) + '。');
      } catch (error) {
        toast('载入导出失败：' + error.message);
      } finally {
        busy.delete(`load:${safeName}`);
      }
    }

    function pollForPublishedAssets(publishedId, name) {
      let attempts = 0;
      const timer = setInterval(async () => {
        attempts += 1;
        if (attempts > 36) {
          clearInterval(timer);
          return;
        }
        try {
          const {response, data} = await localService.listPublishedRoutes({force: true});
          if (!response.ok || !data?.ok) return;
          publishedRoutes = data.routes || [];
          const item = publishedRoutes.find((routeItem) => routeItem.id === publishedId);
          const urls = item?.assetUrls || {};
          if (urls.mp4 && urls.mapImage && urls.manualPdf && urls.productZip) {
            clearInterval(timer);
            renderArchiveList();
            toast(`「${name}」的完整产品已生成。`);
            setStatus(`完整产品已生成：${name}`);
            onAssetsReady?.();
          }
        } catch (_) {}
      }, 10000);
    }

    async function publishRouteData(routeData, mapLayer) {
      if (busy.has('publish')) return toast('正在发布路线，请稍候。');
      busy.add('publish');
      try {
        const videoData = await buildPublishVideoData?.(routeData);
        const config = {
          key: window.AMAP_PLANNER_CONFIG?.key || '',
          securityJsCode: window.AMAP_PLANNER_CONFIG?.securityJsCode || '',
        };
        const {response, data} = await localService.publishRoute(routeData, mapLayer, {videoData, config});
        if (!response.ok || !data?.ok) throw new Error(data?.message || '发布失败');
        await refresh({force: true});
        if (data?.queued) {
          toast('已发布，正在后台生成完整产品…');
          pollForPublishedAssets(data.published?.id, routeData.name || '未命名路线');
        } else {
          toast('路线已发布到公共路线库。');
        }
        setStatus(`已发布：${routeData.name || '未命名路线'}`);
      } finally {
        busy.delete('publish');
      }
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
      if (busy.has(`import:${routeId}`)) return toast('正在导入路线，请稍候。');
      busy.add(`import:${routeId}`);
      try {
        const {response, data} = await localService.importPublishedRoute(routeId);
        if (!response.ok || !data?.ok) throw new Error(data?.message || '导入失败');
        const state = getState();
        const routeBook = state.routeBook;
        const route = normalizeRoute(data.importedRoute);
        route.segmentCache = route.segmentCache || {};
        routeBook.routes.push(route);
        routeBook.activeRouteId = route.id;
        const segmentResults = (route.days || []).map((day, dayIndex) => {
          const cached = route.segmentCache?.[dayIndex];
          const expectedSegments = Math.max(0, getDayPoints(day).filter((item) => isPointReady(item.point)).length - 1);
          const signatureMatches = cached?.signature && cached.signature === daySignature(day);
          const legacyShapeMatches = !cached?.signature && Array.isArray(cached?.segments) && cached.segments.length >= expectedSegments;
          return cached && Array.isArray(cached.segments) && (signatureMatches || legacyShapeMatches)
            ? {segments: cached.segments}
            : {segments: []};
        });
        setState({route, currentRouteView: 'all', segmentResults});
        routeStore.save(routeBook);
        renderAll(true);
        onImported?.(route);
        await refresh({force: true});
        toast('已导入公共路线：' + (route.name || data.routeName || '未命名路线') + '。');
      } catch (error) {
        toast('导入失败：' + error.message);
      } finally {
        busy.delete(`import:${routeId}`);
      }
    }

    return {
      getRoutes,
      getPublishedRoutes,
      renderMyRouteItem,
      renderPublishedRouteItem,
      refresh,
      load,
      publishCurrent,
      publishRouteById,
      importPublished
    };
  }

  window.ArchiveController = {create};
})();
