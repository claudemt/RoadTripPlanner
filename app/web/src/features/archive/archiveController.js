(function () {
  function shouldRetryEmptyRouteLists({mineRoutes, publishedRoutes, publishedEnabled, elapsedMs, limitMs}) {
    const mineEmpty = !Array.isArray(mineRoutes) || mineRoutes.length === 0;
    const publishedEmpty = !publishedEnabled || !Array.isArray(publishedRoutes) || publishedRoutes.length === 0;
    return mineEmpty && publishedEmpty && Number(elapsedMs) < Number(limitMs);
  }

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
    const RETRY_INTERVAL_MS = 3000;
    const RETRY_LIMIT_MS = 15000;

    function sleep(milliseconds) {
      return new Promise((resolve) => setTimeout(resolve, milliseconds));
    }

    function renderArchiveLoading() {
      const box = el('archiveList');
      if (!box) return;
      box.innerHTML = `
        <div class="hint" role="status">加载中…</div>
      `;
    }

    async function fetchRouteLists(force) {
      const [minePair, publishedPair] = await Promise.all([
        localService.listRoutes({force}),
        localService.capabilities?.publishedRoutes
          ? localService.listPublishedRoutes({force})
          : Promise.resolve(null)
      ]);
      if (!minePair.response.ok || !minePair.data?.ok) throw new Error(minePair.data?.message || '无法读取导出列表');
      const mineRoutes = minePair.data.routes || [];
      let publishedRouteList = [];
      if (publishedPair) {
        const {response: publishResponse, data: publishResult} = publishedPair;
        if (!publishResponse.ok || !publishResult?.ok) throw new Error(publishResult?.message || '无法读取公共路线');
        publishedRouteList = publishResult.routes || [];
      }
      return {
        mineRoutes,
        publishedRouteList,
        stale: Boolean(minePair.stale || minePair.data.stale || publishedPair?.stale || publishedPair?.data?.stale)
      };
    }

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
      const canLoad = item.cloud || item.routeJson || item.routeData;
      const productZipUrl = localService.routeProductZipUrl?.(item.safeName) || item.assetUrls?.productZip;
      const targetId = escapeJsAttr(item.routeData?.id || item.safeName);
      const publishButton = localService.capabilities?.publishedRoutes
        ? `<button class="small" onclick="publishArchivedRoute('${escapeJsAttr(item.safeName)}')">发布</button>`
        : '';
      const editButtons = editable
        ? `<button class="small" onclick="accountRenameRoute('${escapeJsAttr(item.safeName)}')">改名</button>
           <button class="small" onclick="accountEditRouteDescription('${escapeJsAttr(item.safeName)}')">介绍</button>
           <button class="small danger" title="删除" onclick="accountDeleteRoute('${escapeJsAttr(item.safeName)}')">✕</button>`
        : '';
      const assetStates = [
        ['routeJson', 'JSON', Boolean(item.routeJson)],
        ['manualPdf', 'PDF', Boolean(item.manualPdf || item.assetUrls?.manualPdf)],
        ['mp4', '视频', Boolean(item.mp4 || item.assetUrls?.mp4)],
        ['mapImage', '总览图', Boolean(item.mapImage || item.assetUrls?.mapImage)]
      ];
      const assetMarks = {ok: '✓', stale: '?', missing: '✕', unknown: '?'};
      const assetHints = {ok: '已是最新版', stale: '路线已改动，需重新渲染', missing: '尚未渲染', unknown: '版本未知，建议更新'};
      const assetChips = assetStates.map(([key, label, present]) => {
        const state = item.assetStatus?.[key] || (present ? 'unknown' : 'missing');
        const mark = assetMarks[state] || '?';
        return `<span class="asset-state ${state}" title="${label}：${assetHints[state] || ''}">${label}<span class="asset-state-mark">${mark}</span></span>`;
      }).join('');
      const assetButtons = [
        canLoad ? `<button class="small primary" onclick="exportArchivedRoute('${escapeJsAttr(item.safeName)}')">更新</button>` : '',
        productZipUrl ? `<button class="small" onclick="window.open('${escapeJsAttr(productZipUrl)}', '_blank')">下载</button>` : '',
      ].join('');
      return `
        <div class="archive-item ${item.cloud ? 'cloud-route-item' : ''}" style="--i:${index}">
          <div class="archive-item-head">
            <span>${escapeHtml(routeTitle(item))}</span>
            ${item.cloud ? '<span class="cloud-save-state">私有</span>' : ''}
          </div>
          <div class="asset-tags">${assetChips}</div>
          <div class="archive-item-actions">
            <button class="small" onclick="accountPreviewRoute('mine','${targetId}')">查看</button>
            ${canLoad ? `<button class="small primary" onclick="loadArchivedRoute('${escapeJsAttr(item.safeName)}')">打开</button>` : ''}
            ${publishButton}
            ${assetButtons}
            ${editButtons}
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
            ${zipUrl ? `<button class="small" onclick="window.open('${escapeJsAttr(zipUrl)}', '_blank')">导出</button>` : ''}
            ${window.APP_RUNTIME?.isAdmin ? `<button class="small danger" title="删除" onclick="accountDeletePublished('${escapeJsAttr(item.id)}')">✕</button>` : ''}
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
        if (!archivedRoutes.length && !publishedRoutes.length) renderArchiveLoading();
        const isCloudMode = Boolean(localService.capabilities?.cloudRoutes || localService.capabilities?.publishedRoutes);
        const startedAt = Date.now();
        let outcome = null;
        let attempt = 0;
        while (true) {
          outcome = await fetchRouteLists(force || attempt > 0);
          attempt += 1;
          const elapsedMs = Date.now() - startedAt;
          if (isCloudMode && shouldRetryEmptyRouteLists({
            mineRoutes: outcome.mineRoutes,
            publishedRoutes: outcome.publishedRouteList,
            publishedEnabled: Boolean(localService.capabilities?.publishedRoutes),
            elapsedMs,
            limitMs: RETRY_LIMIT_MS
          })) {
            renderArchiveLoading();
            await sleep(Math.min(RETRY_INTERVAL_MS, RETRY_LIMIT_MS - elapsedMs));
            continue;
          }
          break;
        }
        archivedRoutes = outcome.mineRoutes;
        publishedRoutes = outcome.publishedRouteList;
        const routeBook = getState().routeBook;

        if (autoSelectFirst && archivedRoutes.length) {
          const hasReadyRoute = routeBook.routes.some((item) => !routeStore.isMostlyBlank(item));
          if (!hasReadyRoute) {
            const newest = archivedRoutes.find((item) => item.safeName || item.id);
            if (newest) await load(newest.safeName || newest.id, {silent: true}).catch(() => {});
          }
        }

        renderRouteSelect();
        renderDays();
        renderArchiveList();
        setStatus(outcome.stale ? '当前显示本机缓存。' : '');
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
      if (item?.published) {
        const {response, data} = await localService.getPublishedRoute(item.id);
        if (!response.ok || !data?.ok || !data.route?.routeData) {
          throw new Error(data?.message || '无法读取这条路线');
        }
        item.routeData = data.route.routeData;
        if (data.route.assetUrls) item.assetUrls = data.route.assetUrls;
        return item.routeData;
      }
      if (item?.cloud) {
        const {response, data} = await localService.getRoute(item.id || item.safeName);
        if (!response.ok || !data?.ok || !data.route?.routeData) {
          throw new Error(data?.message || '无法读取这条路线');
        }
        item.routeData = data.route.routeData;
        if (data.route.assetUrls) item.assetUrls = data.route.assetUrls;
        return item.routeData;
      }
      const base = localService.routeAssetBase(item);
      const version = encodeURIComponent(item?.updatedAt || item?.archivedAt || Date.now());
      const response = await fetch(`${base}.route.json?v=${version}`);
      const data = await response.json();
      if (!response.ok) throw new Error('无法读取导出线路');
      return data;
    }

    async function load(safeName, {silent = false} = {}) {
      if (busy.has(`load:${safeName}`)) return toast('正在载入路线，请稍候。');
      busy.add(`load:${safeName}`);
      try {
        const cached = archivedRoutes.find((item) => item.safeName === safeName);
        if (!cached) throw new Error('未找到这条路线');
        const data = await getArchiveRouteData(cached);
        const fileBase = cached.fileBase || safeName;

        const state = getState();
        const routeBook = state.routeBook;
        const route = routeStore.upsert(routeBook, data);
        if (!route) throw new Error('导入的路线数据无效');
        routeBook.activeRouteId = route.id;
        let segmentResults = (route.days || []).map((day, dayIndex) => {
          const cached = route.segmentCache?.[dayIndex];
          const expectedSegments = Math.max(0, getDayPoints(day).filter((item) => isPointReady(item.point)).length - 1);
          const signatureMatches = cached?.signature === daySignature(day);
          return cached && Array.isArray(cached.segments) && cached.segments.length >= expectedSegments && signatureMatches
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
        if (!silent) toast('已载入路线：' + (route.name || safeName) + '。');
        return true;
      } catch (error) {
        if (!silent) toast('载入导出失败：' + error.message);
        return false;
      } finally {
        busy.delete(`load:${safeName}`);
      }
    }

    function pollForPublishedAssets(publishedId, name) {
      let attempts = 0;
      const timer = setInterval(async () => {
        attempts += 1;
        if (attempts > 30) {
          clearInterval(timer);
          return;
        }
        try {
          const {response, data} = await localService.getPublishedRouteAssets(publishedId, {force: true});
          if (!response.ok || !data?.ok) return;
          const urls = data.assetUrls || {};
          if (urls.mp4 && urls.mapImage && urls.manualPdf && urls.productZip) {
            clearInterval(timer);
            await refresh({force: true});
            toast(`「${name}」的完整产品已生成。`);
            setStatus(`完整产品已生成：${name}`);
            onAssetsReady?.();
          }
        } catch (_) {}
      }, 20000);
    }

    async function publishRouteData(routeData, mapLayer) {
      if (busy.has('publish')) return toast('正在发布路线，请稍候。');
      busy.add('publish');
      try {
        const videoData = await buildPublishVideoData?.(routeData);
        if (!videoData) return;
        if (videoData.presentation) routeData.presentation = structuredClone(videoData.presentation);
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
          const signatureMatches = cached?.signature === daySignature(day);
          return cached && Array.isArray(cached.segments) && cached.segments.length >= expectedSegments && signatureMatches
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
      getRouteData: getArchiveRouteData,
      renderMyRouteItem,
      renderPublishedRouteItem,
      refresh,
      load,
      publishCurrent,
      publishRouteById,
      importPublished
    };
  }

  window.ArchiveController = {create, shouldRetryEmptyRouteLists};
})();
