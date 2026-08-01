const runtime = window.APP_RUNTIME || {mode: 'local', user: null};
    const STORAGE_KEY = `tour-driving-route-planner:v4:${runtime.user?.id || runtime.mode || 'local'}`;
    const ROUTE_COLORS = ['#1677ff', '#16a34a', '#f59e0b', '#a855f7', '#ef4444', '#06b6d4', '#64748b'];
    const localService = window.AppServiceClient.create();
    const el = (id) => document.getElementById(id);
    const dialogs = window.DialogController.create();

    const defaultRoute = {
      id: 'blank-route',
      name: '我的自驾线路',
      days: [
        {
          title: '第一天',
          from: { name: '', lng: null, lat: null, transportMode: 'drive' },
          waypoints: [],
          to: { name: '', lng: null, lat: null, transportMode: 'drive' }
        }
      ]
    };
    const {
      cleanDayTitle,
      cleanRouteName,
      dayLabel,
      createBlankRoute,
      isPointReady,
      getDayPoints,
      daySignature,
      normalizeLabelOffset
    } = window.RouteModel;
    const {normalizeTransportMode} = window.RouteModel;
    const normalizeRoute = (input) => window.RouteModel.normalizeRoute(input, defaultRoute.days);
    const {
      formatTripMetric,
      fixed,
      normalizeSpotName
    } = window.FormatUtils;
    const {escapeHtml, escapeAttr, escapeJsAttr} = window.HtmlUtils;
    const routeRenderer = window.RouteRenderer.create({
      el,
      cleanRouteName,
      cleanDayTitle,
      dayLabel,
      getDayPoints,
      formatTripMetric,
      fixed,
      escapeHtml,
      escapeAttr,
      escapeJsAttr
    });
    const routeStore = window.RouteBookStore.create({
      storageKey: STORAGE_KEY,
      defaultRoute,
      normalizeRoute
    });
    const feedback = window.FeedbackUi.create({el, localService});
    const {
      toast,
      setLoading,
      hideLoading,
      startExportProgressPolling
    } = feedback;
    const scenicController = window.ScenicController.create({
      el,
      localService,
      normalizeSpotName,
      escapeHtml,
      escapeAttr,
      escapeJsAttr,
      toast
    });
    const updateScenicImageList = scenicController.updateImageList;
    const ensureScenicInfo = scenicController.ensureInfo;
    const showSpotInfo = scenicController.showSpotInfo;
    window.showSpotInfo = showSpotInfo;
    window.openLightbox = scenicController.openLightbox;
    const communityController = window.CommunityController.create({
      el,
      localService,
      runtime,
      openAccountCenter,
      setAccountView,
      dialogs,
      escapeHtml,
      escapeAttr,
      toast,
      openLightbox: scenicController.openLightbox
    });
    window.accountOpenProfile = (email) => communityController.openProfile(email)
      .catch((error) => toast('读取个人介绍失败：' + error.message));
    const exportTasks = window.ExportTaskController.create({el, localService, toast});
    const isExportActive = exportTasks.isActive;
    const fetchExportTaskState = exportTasks.fetchState;
    const renderExportTaskPanel = exportTasks.renderPanel;
    const startExportModalPolling = exportTasks.startModalPolling;
    const stopExportModalPolling = exportTasks.stopModalPolling;
    const waitForExportIdle = exportTasks.waitForIdle;
    const cancelCurrentExportTask = exportTasks.cancel;
    const routeMap = window.RouteMapController.create({
      routeColors: ROUTE_COLORS,
      getDayPoints,
      isPointReady,
      escapeHtml
    });
    const placeSearch = window.PlaceSearchController.create({
      el,
      routeMap,
      escapeHtml,
      fixed,
      toast,
      onResolved: (name) => pointEditor?.autoFillScenic(name)
    });
    const onSearchInput = placeSearch.onInput;
    const onSearchKeydown = placeSearch.onKeydown;
    const closeSuggestions = placeSearch.closeSuggestions;
    const searchPlace = placeSearch.searchPlace;
    const setPointForm = placeSearch.setPointForm;
    const resolveByKeyword = placeSearch.resolveByKeyword;

    let routeBook = routeStore.load();
    let route = routeStore.getActive(routeBook);
    let currentMapLayer = localStorage.getItem('amap-planner-map-layer') || 'standard';
    let segmentResults = [];
    let currentRouteView = 'all';
    let cloudSaveTimer = null;
    let accountView = 'profile';
    let accountRouteMode = 'mine';
    let accountSceneMode = 'mine';
    let accountSceneEditMode = 'private';
    let accountPublicSceneOriginalName = '';
    let accountUserScenes = [];
    let accountPublicScenes = [];
    let eventsBound = false;
    const busyActions = new Set();

    function setButtonBusy(id, busy, busyText = '处理中…') {
      const button = el(id);
      if (!button) return () => {};
      const previousText = button.textContent;
      const previousDisabled = button.disabled;
      button.disabled = busy;
      if (busyText) button.textContent = busyText;
      return () => {
        button.disabled = previousDisabled;
        button.textContent = previousText;
      };
    }

    async function runExclusive(key, task, {buttonId = '', busyText = '处理中…', message = '正在处理，请稍候。'} = {}) {
      if (busyActions.has(key)) {
        if (message) toast(message);
        return null;
      }
      busyActions.add(key);
      const restore = buttonId ? setButtonBusy(buttonId, true, busyText) : () => {};
      try {
        return await task();
      } finally {
        restore();
        busyActions.delete(key);
      }
    }

    function hasReadyRoutePoints(targetRoute = route) {
      return Boolean(targetRoute?.days?.some((day) => getDayPoints(day)
        .map((item) => item.point)
        .filter(isPointReady)
        .length >= 2));
    }

    function segmentResultsFromCache(targetRoute = route) {
      return (targetRoute?.days || []).map((day, dayIndex) => {
        const cached = targetRoute?.segmentCache?.[dayIndex];
        const expectedSegments = Math.max(0, getDayPoints(day).filter((item) => isPointReady(item.point)).length - 1);
        const signatureMatches = cached?.signature && cached.signature === daySignature(day);
        const legacyShapeMatches = !cached?.signature && Array.isArray(cached?.segments) && cached.segments.length >= expectedSegments;
        return cached && Array.isArray(cached.segments) && (signatureMatches || legacyShapeMatches)
          ? {segments: cached.segments}
          : {segments: []};
      });
    }

    function hasCachedRouteSegments(targetRoute = route) {
      return segmentResultsFromCache(targetRoute).some((result) => result.segments.length > 0);
    }

    function applyCachedSegmentResults(targetRoute = route) {
      segmentResults = segmentResultsFromCache(targetRoute);
      return segmentResults;
    }

    const archiveController = window.ArchiveController.create({
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
      getState: () => ({routeBook, route, currentRouteView, segmentResults, currentMapLayer}),
      setState: (patch) => {
        if ('route' in patch) route = patch.route;
        if ('currentRouteView' in patch) currentRouteView = patch.currentRouteView;
        if ('segmentResults' in patch) segmentResults = patch.segmentResults;
      },
      saveRoute,
      renderRouteSelect,
      renderDays,
      renderAll,
      calculateRoute,
      isMapReady: routeMap.isReady,
      getEditableRoute,
      buildPublishVideoData: async (targetRoute) => {
        const target = targetRoute || route;
        return videoDataBuilder.build({
          route: target,
          segmentResults: segmentResultsFromCache(target),
          currentMapLayer,
          ensureScenicInfo
        });
      },
      onAssetsReady: () => {
        if (accountView === 'routes') renderAccountRoutes();
      },
      onImported: () => {
        closeRouteLibrary();
        closeAccountCenter();
      }
    });
    const refreshArchivedRoutes = archiveController.refresh;
    window.loadArchivedRoute = archiveController.load;
    window.publishArchivedRoute = archiveController.publishRouteById;
    window.importPublishedRoute = archiveController.importPublished;
    const pointEditor = window.PointEditorController.create({
      el,
      fixed,
      toast,
      scenicController,
      placeSearch,
      getRoute: () => route,
      setView: (view) => { currentRouteView = view; },
      clearSegments: () => { segmentResults = []; },
      renderAll,
      renderDaySelect,
      onChanged: () => saveRoute(false)
    });
    const closePointEditor = pointEditor.close;
    const confirmPointEdit = pointEditor.confirm;
    window.openPointEditor = pointEditor.open;
    const videoDataBuilder = window.VideoDataBuilder.create({
      routeColors: ROUTE_COLORS,
      getDayPoints,
      cleanDayTitle,
      summarizeVideoDays
    });

    function loadAmap() {
      return routeMap.load(window.AMAP_PLANNER_CONFIG);
    }

    async function initMap() {
      el('mapPlaceholder')?.classList.remove('show');
      closeSetupOverlay();
      const mapEl = el('map');
      if (mapEl) {
        mapEl.style.display = 'block';
        mapEl.style.height = '100%';
        mapEl.style.width = '100%';
      }
      await routeMap.createMap('map', {
        zoom: 5,
        center: [104.2, 35.8],
      });
      setMapLayer(currentMapLayer);

      el('mapPlaceholder')?.classList.remove('show');
      closeSetupOverlay();
      bindEvents();
      renderAll(false);
      toast(localService.capabilities?.cloudRoutes ? '地图已就绪，正在同步你的路线…' : '地图已就绪，正在读取路线…');
      applyCachedSegmentResults(route);
      const readyPoints = hasReadyRoutePoints(route);
      if (readyPoints) {
        try {
          renderAll(true);
          toast('已显示路线缓存。');
          scheduleBackgroundRouteCalculation();
        } catch (error) {
          toast(`路线“${route.name || ''}”存在无法绘制的坐标：${error.message}`);
        }
      } else {
        renderAll(false);
        toast('地图已就绪。请从下拉框选择路线，或添加起点终点后点“刷新”。');
      }
    }

    function bindRippleFeedback() {
      document.addEventListener('pointerdown', (event) => {
        const button = event.target.closest('button');
        if (!button || button.disabled) return;
        const rect = button.getBoundingClientRect();
        const span = document.createElement('span');
        span.className = 'ripple';
        span.style.left = `${event.clientX - rect.left}px`;
        span.style.top = `${event.clientY - rect.top}px`;
        button.appendChild(span);
        setTimeout(() => span.remove(), 620);
      });
    }

    function bindEvents() {
      if (eventsBound) return;
      eventsBound = true;
      bindRippleFeedback();
      if (el('setupSaveBtn')) el('setupSaveBtn').onclick = () => saveAmapConfigFromInputs('setupKeyInput', 'setupSecurityInput', 'setupStatus');
      if (el('setupTestBtn')) el('setupTestBtn').onclick = () => testAmapConfigFromInputs('setupKeyInput', 'setupSecurityInput', 'setupStatus');
      el('newRouteBtn').onclick = openNewRouteModal;
      el('calcBtn').onclick = () => calculateRoute();
      el('exportBtn').onclick = openExportModal;
      bindNewRouteModal();
      bindRouteLibraryControls();
      bindAccountControls();
      el('mapLayerSelect').value = currentMapLayer;
      el('mapLayerSelect').onchange = () => setMapLayer(el('mapLayerSelect').value);
      el('mapLayerBtn').onclick = () => {
        const order = ['standard', 'satellite', 'hybrid'];
        const next = order[(order.indexOf(currentMapLayer) + 1) % order.length];
        el('mapLayerSelect').value = next;
        setMapLayer(next);
        toast(`地图类型：${next === 'standard' ? '标准' : next === 'satellite' ? '卫星' : '卫星+道路'}`);
      };
      bindExportModal();
      el('spotCloseBtn').onclick = scenicController.closeSpotPanel;
      el('imageLightbox').onclick = scenicController.closeLightbox;
      el('routeSelect').onchange = selectRouteFromDropdown;
      el('routeViewSelect').onchange = () => {
        currentRouteView = el('routeViewSelect').value;
        renderDays();
        renderMarkersAndSegments(true);
      };
      el('daysList').onclick = (event) => {
        const button = event.target.closest('[data-add-day-after]');
        if (!button) return;
        addDayAfter(Number(button.dataset.addDayAfter));
      };
      el('pointSearchBtn').onclick = searchPlace;
      el('pointSearchInput').addEventListener('input', onSearchInput);
      el('pointSearchInput').addEventListener('keydown', onSearchKeydown);
      el('pointScenicImages').onchange = updateScenicImageList;
      if (el('pointUseScenic')) el('pointUseScenic').onchange = () => pointEditor.onUseScenicChange();
      el('pointConfirmBtn').onclick = confirmPointEdit;
      el('pointCancelBtn').onclick = () => dialogs.close('pointModal');
      el('pointModalClose').onclick = () => dialogs.close('pointModal');
      bindPointTransportControls();
      dialogs.register('pointModal', closePointEditor);
      dialogs.register('newRouteModal', closeNewRouteModal);
      dialogs.register('routeLibraryModal', closeRouteLibrary);
      dialogs.register('exportModal', closeExportModal);
      dialogs.register('setupOverlay', closeSetupOverlay);
      dialogs.bind();
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.search-wrap')) closeSuggestions();
        scenicController.handleOutsideClick(e.target);
      });
    }

    function bindAccountControls() {
      communityController.bind();
      if (el('communityHelpBtn')) el('communityHelpBtn').onclick = () => dialogs.open('helpModal');
      if (el('userMenuBtn')) el('userMenuBtn').onclick = openAccountCenter;
      if (el('accountCenterCloseBtn')) el('accountCenterCloseBtn').onclick = closeAccountCenter;
      document.querySelectorAll('[data-account-view]').forEach((button) => {
        button.onclick = () => setAccountView(button.dataset.accountView);
      });
      document.querySelectorAll('[data-route-content]').forEach((button) => {
        button.onclick = () => setAccountRouteMode(button.dataset.routeContent);
      });
      document.querySelectorAll('[data-scene-content]').forEach((button) => {
        button.onclick = () => setAccountSceneMode(button.dataset.sceneContent);
      });
      if (el('accountSaveSceneBtn')) el('accountSaveSceneBtn').onclick = saveSceneFromAccount;
      if (el('accountCancelSceneBtn')) el('accountCancelSceneBtn').onclick = resetAccountSceneEditor;
      if (el('adminSaveConfigBtn')) {
        el('adminSaveConfigBtn').onclick = () => saveAmapConfigFromInputs('adminAmapKeyInput', 'adminAmapSecurityInput', 'adminConfigStatus');
      }
      if (el('adminRefreshBtn')) el('adminRefreshBtn').onclick = refreshAdminDashboard;
      if (el('accountLogoutBtn')) el('accountLogoutBtn').onclick = () => { location.href = '/logout'; };
      if (el('sceneDiffCloseBtn')) el('sceneDiffCloseBtn').onclick = () => dialogs.close('sceneDiffModal');
    }

    function openAccountCenter() {
      const email = runtime.user?.email || '未识别用户';
      el('accountCenterEmail').textContent = email;
      el('accountIdentityEmail').textContent = email;
      el('accountIdentityRole').textContent = runtime.isAdmin ? '管理员' : '用户';
      if (el('accountAdminNav')) el('accountAdminNav').hidden = !runtime.isAdmin;
      el('accountCenter').classList.add('open');
      setAccountView(accountView);
      refreshAccountCenter();
    }

    function closeAccountCenter() {
      el('accountCenter').classList.remove('open');
      communityController.stopPolling();
    }

    function setAccountView(view) {
      accountView = view === 'admin' && !runtime.isAdmin ? 'profile' : (view || 'profile');
      document.querySelectorAll('[data-account-view]').forEach((button) => {
        button.classList.toggle('active', button.dataset.accountView === accountView);
      });
      document.querySelectorAll('.account-view').forEach((panel) => {
        panel.classList.toggle('active', panel.id === `accountView${accountView[0].toUpperCase()}${accountView.slice(1)}`);
      });
      communityController.activate(accountView);
      refreshAccountCenter();
    }

    function setAccountRouteMode(mode) {
      accountRouteMode = mode === 'public' ? 'public' : 'mine';
      document.querySelectorAll('[data-route-content]').forEach((button) => {
        button.classList.toggle('active', button.dataset.routeContent === accountRouteMode);
      });
      el('accountRouteMinePane')?.classList.toggle('active', accountRouteMode === 'mine');
      el('accountRoutePublicPane')?.classList.toggle('active', accountRouteMode === 'public');
      renderAccountRoutes();
    }

    function setAccountSceneMode(mode) {
      accountSceneMode = mode === 'public' ? 'public' : 'mine';
      document.querySelectorAll('[data-scene-content]').forEach((button) => {
        button.classList.toggle('active', button.dataset.sceneContent === accountSceneMode);
      });
      el('accountSceneMinePane')?.classList.toggle('active', accountSceneMode === 'mine');
      el('accountScenePublicPane')?.classList.toggle('active', accountSceneMode === 'public');
      renderAccountScenes();
    }

    async function refreshAccountCenter() {
      if (!el('accountCenter')?.classList.contains('open')) return;
      if (accountView === 'routes') {
        await refreshArchivedRoutes();
        renderAccountRoutes();
      } else if (accountView === 'scenic') {
        await renderAccountScenes();
      } else if (accountView === 'admin') {
        await refreshAdminDashboard();
      }
    }

    function routeTime(value) {
      if (!value) return '';
      try { return new Date(value).toLocaleString(); } catch (_) { return ''; }
    }

    function routeDayPoints(day) {
      if (Array.isArray(day?.points)) return day.points.filter((point) => point?.name);
      return [day?.from, ...(day?.waypoints || []), day?.to].filter((point) => point?.name);
    }

    function showRoutePreview(routeData) {
      if (!routeData?.days) return toast('这条路线没有可预览的行程。');
      el('routePreviewTitle').textContent = cleanRouteName(routeData.name) || '路线预览';
      el('routePreviewBody').innerHTML = routeData.days.map((day, dayIndex) => {
        const points = routeDayPoints(day);
        const pointList = points.length
          ? points.map((point, pointIndex) => `
              <span class="route-preview-point">
                <b>${pointIndex + 1}</b>${escapeHtml(point.name)}
              </span>
            `).join('<span class="route-preview-arrow">→</span>')
          : '<span class="route-preview-empty">当天还没有地点。</span>';
        return `
          <section class="route-preview-day">
            <div class="route-preview-day-head">
              <strong>D${dayIndex + 1}</strong>
              <span>${escapeHtml(cleanDayTitle(day.title) || `第 ${dayIndex + 1} 天`)}</span>
            </div>
            <div class="route-preview-points">${pointList}</div>
          </section>
        `;
      }).join('');
      dialogs.open('routePreviewModal');
    }

    window.accountPreviewRoute = function(scope, routeId) {
      const routeData = scope === 'public'
        ? archiveController.getPublishedRoutes?.().find((item) => item.id === routeId)?.routeData
        : routeBook.routes.find((item) => item.id === routeId || item.name === routeId);
      showRoutePreview(routeData);
    };

    function renderAccountRoutes() {
      const box = el('accountRouteList');
      const publicBox = el('accountPublicRouteList');
      if (!box || !publicBox) return;
      const archivedRoutes = archiveController.getRoutes() || [];
      const publishedRoutes = archiveController.getPublishedRoutes() || [];
      el('accountRouteCount').textContent = String(archivedRoutes.length);
      box.innerHTML = archivedRoutes.length
        ? archivedRoutes.map((item, index) => archiveController.renderMyRouteItem(item, {editable: true, index})).join('')
        : '<div class="account-empty">还没有路线。</div>';
      publicBox.innerHTML = publishedRoutes.length
        ? publishedRoutes.map((item, index) => archiveController.renderPublishedRouteItem(item, index)).join('')
        : '<div class="account-empty">公共路线库暂时为空。</div>';
    }

    async function renderAccountScenes() {
      const mineBox = el('accountSceneList');
      const publicBox = el('accountPublicSceneList');
      if (!mineBox || !publicBox) return;
      try {
        const [mineResult, publicResult] = await Promise.all([
          localService.listUserScenes(),
          localService.listScenes(),
        ]);
        if (!mineResult.response.ok || !mineResult.data?.ok) throw new Error(mineResult.data?.message || '无法读取我的景点介绍');
        if (!publicResult.response.ok || !publicResult.data?.ok) throw new Error(publicResult.data?.message || '无法读取公共景点介绍');
        accountUserScenes = mineResult.data.scenes || [];
        accountPublicScenes = publicResult.data.scenes || [];
        el('accountSceneCount').textContent = String(accountUserScenes.length);
        mineBox.innerHTML = accountUserScenes.length ? accountUserScenes.map((item) => `
          <div class="account-item admin-content-item">
            <div class="account-item-main">
              <strong>${escapeHtml(item.title || item.name || '未命名景点')}</strong>
              <span>${item.sourceVersion ? `源自公共 v${escapeHtml(item.sourceVersion)} · ` : ''}图片 ${escapeHtml(item.imageCount || 0)}</span>
            </div>
            <span class="account-item-time">${escapeHtml(routeTime(item.updatedAt))}</span>
            <div class="account-item-actions">
              <button class="small primary" onclick="accountPreviewUserScene('${escapeJsAttr(item.id)}')">查看</button>
              <button class="small" onclick="accountEditUserScene('${escapeJsAttr(item.id)}')">编辑</button>
              <button class="small danger" onclick="accountDeleteUserScene('${escapeJsAttr(item.id)}')">删除</button>
            </div>
          </div>
        `).join('') : '<div class="account-empty">还没有个人景点介绍。</div>';
        publicBox.innerHTML = accountPublicScenes.length ? accountPublicScenes.map((item) => `
          <div class="account-item admin-content-item">
            <div class="account-item-main">
              <strong>${escapeHtml(item.title || item.name || '未命名景点')}</strong>
              <span>v${escapeHtml(item.version || 1)} · ${item.contributor?.email ? `<button class="contributor-link" type="button" onclick="accountOpenProfile('${escapeJsAttr(item.contributor.email)}')">${escapeHtml(item.contributor.nickname || '未知用户')}</button>` : '未知用户'}</span>
            </div>
              <span class="account-item-time">${escapeHtml(routeTime(item.updatedAt))}</span>
            <div class="account-item-actions">
              <button class="small primary" onclick="showSpotInfo('${escapeJsAttr(item.name || item.title)}')">查看</button>
              <button class="small" onclick="accountEditPublicScene('${escapeJsAttr(item.name || item.title)}')">编辑</button>
              <button class="small" onclick="accountImportScene('${escapeJsAttr(item.name || item.title)}')">复制到我的景点</button>
              <button class="small" onclick="accountShowSceneDiff('${escapeJsAttr(item.name || item.title)}')">版本</button>
            </div>
          </div>
        `).join('') : '<div class="account-empty">公共景点库暂时为空。</div>';
      } catch (error) {
        mineBox.innerHTML = `<div class="account-empty">读取景点介绍失败：${escapeHtml(error.message)}</div>`;
        publicBox.innerHTML = mineBox.innerHTML;
      }
    }

    function resetAccountSceneEditor() {
      accountSceneEditMode = 'private';
      accountPublicSceneOriginalName = '';
      el('accountSceneId').value = '';
      el('accountSceneName').value = '';
      el('accountSceneDescription').value = '';
      el('accountSceneImages').value = '';
      el('accountCancelSceneBtn').hidden = true;
      el('accountSaveSceneBtn').textContent = '保存';
      el('accountSceneStatus').textContent = '';
    }

    async function resolveAmapSceneName(name) {
      const cleanName = String(name || '').trim();
      if (!cleanName) throw new Error('请填写景点名称。');
      const resolved = await resolveByKeyword(cleanName);
      if (!resolved?.name) throw new Error('高德地图无法匹配这个景点名称。');
      return resolved.name;
    }

    async function saveSceneFromAccount() {
      if (busyActions.has('account-save-scene')) return toast('正在保存景点介绍，请稍候。');
      const id = el('accountSceneId').value.trim();
      const name = el('accountSceneName').value.trim();
      const description = el('accountSceneDescription').value.trim();
      const files = [...(el('accountSceneImages').files || [])];
      if (!name) return toast('请填写景点名称。');
      busyActions.add('account-save-scene');
      const restoreButton = setButtonBusy('accountSaveSceneBtn', true, '保存中…');
      try {
        const amapName = await resolveAmapSceneName(name);
        if (amapName !== name) el('accountSceneName').value = amapName;
        if (accountSceneEditMode === 'public') {
          const defaultNote = accountPublicSceneOriginalName && accountPublicSceneOriginalName !== amapName
            ? `调整名称：${accountPublicSceneOriginalName} -> ${amapName}`
            : '修正公共景点介绍';
          const changeNote = prompt('公共景点修改说明', defaultNote);
          if (changeNote === null) return;
          const result = await scenicController.savePublicScenicInfo({name: amapName, title: amapName, description, files, changeNote});
          resetAccountSceneEditor();
          el('accountSceneStatus').textContent = `公共景点已更新为 v${result.version || result.spot?.version || ''}：${amapName}`;
          await renderAccountScenes();
          toast(result.unchanged ? '公共库已是相同内容。' : `公共景点已更新为 v${result.version}。`);
          return;
        }
        await scenicController.saveUserScenicInfo({id, name: amapName, title: amapName, description, files});
        resetAccountSceneEditor();
        el('accountSceneStatus').textContent = `已保存到我的景点：${amapName}`;
        await renderAccountScenes();
        toast('景点介绍已保存到我的景点。');
      } catch (error) {
        toast('保存景点失败：' + error.message);
      } finally {
        restoreButton();
        busyActions.delete('account-save-scene');
      }
    }

    async function refreshAdminDashboard() {
      if (!runtime.isAdmin) return;
      const usersBox = el('adminUserList');
      const routesBox = el('adminPublishedRouteList');
      const scenesBox = el('adminPublishedSceneList');
      try {
        const config = await loadConfigFromServer();
        if (config?.configured) {
          el('adminAmapKeyInput').value = config.key || '';
          el('adminAmapSecurityInput').value = config.securityJsCode || '';
          el('adminConfigStatus').textContent = '地图 Key 已配置。';
        }
        const {response, data} = await localService.adminSummary();
        if (!response.ok || !data?.ok) throw new Error(data?.message || '无法读取管理数据');
        usersBox.innerHTML = (data.users || []).length
          ? data.users.map((item) => `
            <div class="account-item">
              <div class="account-item-main"><strong>${escapeHtml(item.email)}</strong><span>路线 ${escapeHtml(item.routeCount || 0)} · 景点 ${escapeHtml(item.sceneCount || 0)}</span></div>
              <span class="account-item-time">${escapeHtml(routeTime(item.lastRouteAt || item.lastSceneAt))}</span>
            </div>
          `).join('')
          : '<div class="account-empty">还没有用户路线数据。</div>';
        const routes = (data.publishedRoutes || []).map((item) => `
          <div class="account-item admin-content-item">
            <div class="account-item-main"><strong>路线：${escapeHtml(item.name)}</strong><span>${item.contributor?.email ? `<button class="contributor-link" type="button" onclick="accountOpenProfile('${escapeJsAttr(item.contributor.email)}')">${escapeHtml(item.contributor.nickname || '未知用户')}</button>` : '未知用户'}</span></div>
            <div class="account-item-actions"><button class="small danger" onclick="accountDeletePublished('${escapeJsAttr(item.id)}')">删除</button></div>
          </div>
        `).join('');
        const scenes = (data.scenes || []).map((item) => `
          <div class="account-item admin-content-item">
            <div class="account-item-main"><strong>景点：${escapeHtml(item.title || item.name)}</strong><span>${item.contributor?.email ? `<button class="contributor-link" type="button" onclick="accountOpenProfile('${escapeJsAttr(item.contributor.email)}')">${escapeHtml(item.contributor.nickname || '未知用户')}</button>` : '未知用户'}</span></div>
            <div class="account-item-actions">
              <button class="small" onclick="accountEditPublicScene('${escapeJsAttr(item.name || item.title)}')">编辑</button>
              <button class="small" onclick="accountShowSceneDiff('${escapeJsAttr(item.name || item.title)}')">版本</button>
              <button class="small danger" onclick="accountDeleteScene('${escapeJsAttr(item.name || item.title)}')">删除</button>
            </div>
          </div>
        `).join('');
        routesBox.innerHTML = routes || '<div class="account-empty">还没有公共路线。</div>';
        scenesBox.innerHTML = scenes || '<div class="account-empty">还没有公共景点。</div>';
      } catch (error) {
        if (usersBox) usersBox.innerHTML = `<div class="account-empty">读取管理数据失败：${escapeHtml(error.message)}</div>`;
      }
    }

    function bindRouteLibraryControls() {
      if (el('routeLibraryCloseBtn')) el('routeLibraryCloseBtn').onclick = () => dialogs.close('routeLibraryModal');
      if (el('publishCurrentRouteBtn')) el('publishCurrentRouteBtn').onclick = archiveController.publishCurrent;
      if (el('refreshRouteLibraryBtn')) el('refreshRouteLibraryBtn').onclick = () => refreshArchivedRoutes({force: true});
      if (el('publishCurrentRouteBtn')) el('publishCurrentRouteBtn').hidden = !localService.capabilities?.publishedRoutes;
    }

    function bindPointTransportControls() {
      document.querySelectorAll('[data-point-transport]').forEach((button) => {
        button.onclick = () => pointEditor.setTransportMode(button.dataset.pointTransport);
      });
    }

    function openDialog(id) {
      const dialog = el(id);
      if (!dialog) return;
      dialog.classList.remove('closing');
      dialog.classList.add('open');
    }

    function openRouteLibrary() {
      openDialog('routeLibraryModal');
      refreshArchivedRoutes();
    }

    function closeRouteLibrary() {
      el('routeLibraryModal')?.classList.remove('open');
    }

    function openNewRouteModal() {
      if (el('newRouteNameInput')) el('newRouteNameInput').value = '';
      if (el('newRouteDayCountInput')) el('newRouteDayCountInput').value = '1';
      openDialog('newRouteModal');
      setTimeout(() => el('newRouteNameInput')?.focus(), 50);
    }

    function closeNewRouteModal() {
      el('newRouteModal')?.classList.remove('open');
    }

    function bindNewRouteModal() {
      if (el('newRouteCloseBtn')) el('newRouteCloseBtn').onclick = () => dialogs.close('newRouteModal');
      if (el('newRouteCancelBtn')) el('newRouteCancelBtn').onclick = () => dialogs.close('newRouteModal');
      if (el('newRouteImportBtn')) {
        el('newRouteImportBtn').onclick = () => {
          closeNewRouteModal();
          openRouteLibrary();
        };
      }
      if (el('newRouteConfirmBtn')) el('newRouteConfirmBtn').onclick = createRouteFromModal;
      el('newRouteNameInput')?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') createRouteFromModal();
      });
      el('newRouteDayCountInput')?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') createRouteFromModal();
      });
    }

    function selectRouteFromDropdown() {
      const value = el('routeSelect').value;
      if (value === '__new_route__') {
        openNewRouteModal();
        renderRouteSelect();
        return;
      }
      if (value === '__public_routes__') {
        openRouteLibrary();
        renderRouteSelect();
        return;
      }
      if (value.startsWith('archive:')) return loadArchivedRoute(value.slice(8));
      routeBook.activeRouteId = value;
      route = routeStore.getActive(routeBook);
      currentRouteView = 'all';
      applyCachedSegmentResults(route);
      renderAll(true);
      toast('已切换路线。');
    }

    async function loadRouteFromAccount(routeId) {
      const localRoute = routeBook.routes.find((item) => item.id === routeId);
      if (!localRoute) return archiveController.load(routeId);
      routeBook.activeRouteId = localRoute.id;
      route = routeStore.getActive(routeBook);
      currentRouteView = 'all';
      applyCachedSegmentResults(route);
      renderAll(true);
      toast('已打开路线：' + (route.name || '未命名路线') + '。');
    }

    function setMapLayer(layer) {
      currentMapLayer = layer || 'standard';
      localStorage.setItem('amap-planner-map-layer', currentMapLayer);
      routeMap.setLayer(currentMapLayer);
    }

    function hasAmapConfig() {
      return Boolean((window.AMAP_PLANNER_CONFIG?.key || '').trim() && (window.AMAP_PLANNER_CONFIG?.securityJsCode || '').trim());
    }

    function openSetupOverlay(message) {
      if (localService.capabilities?.editableMapConfig === false && !runtime.isAdmin) {
        showMapLoadFailure(message || '请联系管理员检查地图配置。');
        return;
      }
      el('setupKeyInput').value = window.AMAP_PLANNER_CONFIG?.key || '';
      el('setupSecurityInput').value = window.AMAP_PLANNER_CONFIG?.securityJsCode || '';
      const cloudManaged = localService.capabilities?.editableMapConfig === false;
      const setupTitle = document.querySelector('#setupOverlay h2');
      const setupIntro = document.querySelector('#setupOverlay header p');
      if (setupTitle) setupTitle.textContent = cloudManaged ? '地图服务未就绪' : '配置高德地图';
      if (setupIntro) setupIntro.textContent = cloudManaged
        ? '网站地图由管理员统一配置，普通用户无需填写 Key。'
        : '填写高德 Web JS API Key 和安全密钥后加载地图。';
      el('setupOverlay').classList.toggle('cloud-managed', cloudManaged);
      el('setupKeyInput').disabled = cloudManaged;
      el('setupSecurityInput').disabled = cloudManaged;
      el('setupSaveBtn').hidden = cloudManaged;
      el('setupTestBtn').hidden = cloudManaged;
      el('setupStatus').textContent = message || (cloudManaged
        ? '地图配置由站点管理员统一维护。'
        : localService.capabilities?.mode === 'cloud'
          ? '配置会写入站点设置，保存后所有用户刷新即可使用。'
          : '配置会写入浏览器，并同步到 config/local.env。');
      openDialog('setupOverlay');
      el('mapPlaceholder')?.classList.add('show');
    }

    function closeSetupOverlay() {
      el('setupOverlay').classList.remove('open');
    }

    function showMapLoadFailure(message) {
      closeSetupOverlay();
      const placeholder = el('mapPlaceholder');
      if (!placeholder) return;
      placeholder.classList.add('show');
      placeholder.innerHTML = `
        <strong>地图加载失败</strong>
        <p>${escapeHtml(message || '请检查网络后刷新页面。')}</p>
        ${runtime.isAdmin ? '<button class="primary" id="mapFailureConfigBtn" type="button">配置高德 Key</button>' : ''}
      `;
      const configButton = el('mapFailureConfigBtn');
      if (configButton) configButton.onclick = () => openSetupOverlay('请检查 Key、安全密钥和域名白名单。');
    }

    function bindExportModal() {
      if (!el('exportModal')) return;
      el('exportCancelBtn').onclick = () => dialogs.close('exportModal');
      el('exportCancelBtn2').onclick = () => dialogs.close('exportModal');
      el('exportStopBtn').onclick = () => cancelCurrentExportTask();
      el('exportConfirmBtn').onclick = async () => {
        const renderVideo = Boolean(el('exportRenderVideo').checked);
        try {
          const state = await fetchExportTaskState();
          if (isExportActive(state)) {
            if (!confirm('已有导出任务正在进行。要终止它并开始新的导出吗？')) return;
            await cancelCurrentExportTask({silent: true});
            await waitForExportIdle();
          }
        } catch (error) {
          toast('读取导出任务失败：' + error.message);
          return;
        }
        closeExportModal();
        exportCurrentRoute({renderVideo});
      };
    }

    function openExportModal() {
      if (!localService.capabilities?.serverExport) {
        downloadCurrentRoute();
        return;
      }
      el('exportRenderVideo').checked = Boolean(localService.capabilities?.cloudExports);
      openDialog('exportModal');
      startExportModalPolling();
    }

    function closeExportModal() {
      el('exportModal').classList.remove('open');
      stopExportModalPolling();
    }

    async function saveAmapConfigFromInputs(keyId, securityId, statusId) {
      if (localService.capabilities?.editableMapConfig === false) {
        return toast('网站地图配置由管理员统一维护。');
      }
      const key = el(keyId).value.trim();
      const securityJsCode = el(securityId).value.trim();
      if (!key || !securityJsCode) {
        if (statusId) el(statusId).textContent = '请填写 Key 和安全密钥。';
        return toast('请填写 Key 和安全密钥。');
      }
      localStorage.setItem('amap-planner-config', JSON.stringify({ key, securityJsCode }));
      window.AMAP_PLANNER_CONFIG = { key, securityJsCode };
      window._AMapSecurityConfig = { securityJsCode };
      if (statusId) el(statusId).textContent = '已保存，正在同步并加载地图…';
      try {
        const {response, data} = await localService.saveConfig({ key, securityJsCode });
        if (!response.ok || !data?.ok) throw new Error(data?.message || '保存失败');
      } catch (error) {
        if (statusId) el(statusId).textContent = '保存失败：' + error.message;
        return toast('保存地图配置失败：' + error.message);
      }
      toast('配置已保存，正在刷新…');
      if (location.protocol === 'file:') {
        location.href = 'http://127.0.0.1:6137/';
        return;
      }
      location.reload();
    }

    function testAmapConfigFromInputs(keyId, securityId, statusId) {
      const statusEl = statusId ? el(statusId) : null;
      const key = el(keyId).value.trim();
      const securityJsCode = el(securityId).value.trim();
      if (!key || !securityJsCode) {
        if (statusEl) statusEl.textContent = '请先填写 Key 和安全密钥。';
        return;
      }
      if (statusEl) statusEl.textContent = '正在测试 Key…';
      // 测试需在已加载当前 Key 的地图上进行
      if (!routeMap.isReady() || window.AMAP_PLANNER_CONFIG?.key !== key) {
        if (statusEl) statusEl.textContent = '请先点“保存并加载地图”，加载成功后再测试搜索。也可直接保存。';
        return;
      }
      routeMap.testSearch('天安门').then((ok) => {
        if (statusEl) {
          statusEl.textContent = ok
            ? '连接成功：可以搜索地点和获取坐标。'
            : '连接失败：高德没有返回 POI，请检查 Key、服务权限和安全密钥。';
        }
      });
    }

    function saveRoute(showToast = true) {
      if (!route) return;
      try {
        routeBook.activeRouteId = route.id;
        routeStore.save(routeBook);
        if (localService.capabilities?.cloudRoutes) {
          if (cloudSaveTimer) clearTimeout(cloudSaveTimer);
          if (showToast) toast('正在保存路线…');
          const snapshot = getEditableRoute(route);
          cloudSaveTimer = setTimeout(async () => {
            cloudSaveTimer = null;
            const {response, data} = await localService.saveRoute(snapshot, currentMapLayer);
            if (!response.ok || !data?.ok) {
              toast('云端保存失败：' + (data?.message || '请检查网络'));
              return;
            }
            if (showToast) toast('路线已保存到云端。');
          }, 280);
        } else if (showToast) {
          toast(runtime.mode === 'preview' ? '已保存为当前浏览器草稿。' : '已保存到浏览器，导出后写入 data/routes/。');
        }
      } catch (err) {
        toast('保存失败：' + err.message);
      }
    }

    async function saveRouteNow(targetRoute = route) {
      if (cloudSaveTimer) {
        clearTimeout(cloudSaveTimer);
        cloudSaveTimer = null;
      }
      routeStore.save(routeBook);
      if (!localService.capabilities?.cloudRoutes) {
        return {response: {ok: true, status: 200}, data: {ok: true}};
      }
      return localService.saveRoute(getEditableRoute(targetRoute), currentMapLayer);
    }

    async function createRouteFromAccount({name, dayCount}) {
      const cleanName = cleanRouteName(name) || '未命名路线';
      const next = normalizeRoute(createBlankRoute(cleanName, dayCount));
      const previousRoute = route;
      const previousActiveId = routeBook.activeRouteId;
      routeBook.routes.push(next);
      routeBook.activeRouteId = next.id;
      route = next;
      currentRouteView = 'all';
      segmentResults = [];
      renderAll(false);
      try {
        const {response, data} = await saveRouteNow(next);
        if (!response.ok || !data?.ok) throw new Error(data?.message || '保存失败');
        toast(localService.capabilities?.cloudRoutes ? '已新建路线并同步到你的账户。' : '已新建空白路线。');
        return true;
      } catch (error) {
        routeBook.routes = routeBook.routes.filter((item) => item.id !== next.id);
        routeBook.activeRouteId = previousActiveId;
        route = previousRoute;
        renderAll(false);
        toast('新建路线失败：' + error.message);
        return false;
      }
    }

    async function createRouteFromModal() {
      if (busyActions.has('create-route')) return toast('正在新建路线，请稍候。');
      const name = el('newRouteNameInput')?.value || '未命名路线';
      const daysText = el('newRouteDayCountInput')?.value || '1';
      const dayCount = Math.max(1, Math.min(30, Number(daysText || 1)));
      await runExclusive('create-route', () => createRouteFromAccount({name, dayCount}), {
        buttonId: 'newRouteConfirmBtn',
        busyText: '创建中…',
        message: '正在新建路线，请稍候。'
      }).then((created) => {
        if (created) closeNewRouteModal();
      });
    }

    async function renameRouteById(routeId, name) {
      const target = routeBook.routes.find((item) => item.id === routeId);
      if (!target) return false;
      const nextName = cleanRouteName(name);
      if (!nextName) return toast('路线名称不能为空。'), false;
      const previousName = target.name;
      target.name = nextName;
      if (route?.id === routeId) route.name = nextName;
      try {
        const {response, data} = await saveRouteNow(target);
        if (!response.ok || !data?.ok) throw new Error(data?.message || '保存失败');
        renderRouteSelect();
        toast('路线名称已更新。');
        return true;
      } catch (error) {
        target.name = previousName;
        if (route?.id === routeId) route.name = previousName;
        renderRouteSelect();
        toast('修改路线名称失败：' + error.message);
        return false;
      }
    }

    async function deleteRouteById(routeId) {
      const index = routeBook.routes.findIndex((item) => item.id === routeId);
      if (index < 0) return false;
      const removed = routeBook.routes[index];
      if (localService.capabilities?.cloudRoutes) {
        const {response, data} = await localService.deleteRoute(routeId);
        if (!response.ok || !data?.ok) {
          toast('云端删除失败：' + (data?.message || '请重试'));
          return false;
        }
      }
      routeBook.routes.splice(index, 1);
      if (route?.id === routeId) {
        routeBook.activeRouteId = routeBook.routes[0]?.id || '';
        route = routeStore.getActive(routeBook) || null;
        currentRouteView = 'all';
        segmentResults = [];
        routeStore.save(routeBook);
        renderAll(true);
      } else {
        routeStore.save(routeBook);
        renderRouteSelect();
      }
      toast(`已删除路线“${removed.name || '未命名路线'}”。`);
      return true;
    }

    function getEditableRoute(input) {
      if (!input && !route) return null;
      const next = normalizeRoute(structuredClone(input || route));
      return {
        id: next.id,
        name: next.name,
        segmentCache: next.segmentCache || {},
        days: next.days.map((day) => ({
          title: cleanDayTitle(day.title),
          from: day.from,
          waypoints: day.waypoints,
          to: day.to
        }))
      };
    }

    function renderAll(fit = true) {
      route = route ? normalizeRoute(route) : routeStore.getActive(routeBook) || null;
      renderRouteSelect();
      renderDaySelect();
      renderDays();
      renderMarkersAndSegments(fit);
    }

    function renderRouteSelect() {
      routeRenderer.renderRouteSelect({
        routeBook,
        route,
        archivedRoutes: archiveController.getRoutes()
      });
    }

    function renderDaySelect() {
      currentRouteView = routeRenderer.renderDaySelect({route, currentRouteView});
    }

    function renderDays() {
      routeRenderer.renderDays({route, segmentResults, currentRouteView});
    }

    function renderMarkersAndSegments(fit = true) {
      if (!route) {
        routeMap.clear();
        return;
      }
      routeMap.render({
        route,
        segmentResults,
        currentRouteView,
        fit,
        onMarkerClick: ({item, dayIndex}) => {
          el('daySelect').value = String(dayIndex);
          setPointForm(item.point.name, item.point.lng, item.point.lat);
          if (item.point.useScenic === false) toast('这个点位已设置为不采用景点说明。');
          else showSpotInfo(item.point.name);
        },
        onLabelDrag: ({item, labelOffset}) => {
          item.point.labelOffset = normalizeLabelOffset(labelOffset);
          saveRoute(false);
        }
      });
    }

    function resetLabelOffsets(dayIndexes = null) {
      if (!route?.days?.length) return;
      const targets = Array.isArray(dayIndexes)
        ? dayIndexes.filter((dayIndex) => route.days[dayIndex])
        : route.days.map((_, dayIndex) => dayIndex);
      targets.forEach((dayIndex) => {
        getDayPoints(route.days[dayIndex]).forEach((item) => {
          if (item.point) item.point.labelOffset = {x: 0, y: 0};
        });
      });
    }

    async function calculateRoute({background = false, resetLabels = true} = {}) {
      if (busyActions.has('calculate-route')) {
        if (!background) toast('正在刷新路线，请稍候。');
        return;
      }
      if (!route) return toast('请先新建路线，或从公共路线导入。');
      if (!routeMap.isReady()) {
        if (!background) {
          openSetupOverlay('请先配置并加载高德地图，再计算路线。');
          toast('请先完成高德配置。');
        }
        return;
      }
      route = normalizeRoute(route);
      if (!route.days.length) return;
      busyActions.add('calculate-route');
      const restoreButton = background ? () => {} : setButtonBusy('calcBtn', true, '刷新中…');
      if (!background) setLoading('正在计算路线…', {percent: 12, detail: '准备路线请求'});
      try {
        route.segmentCache = route.segmentCache || {};
        if (!Array.isArray(segmentResults) || segmentResults.length !== route.days.length) {
          segmentResults = route.days.map((_, dayIndex) => ({ segments: route.segmentCache[dayIndex]?.segments || [] }));
        }
        const targetDays = currentRouteView === 'all'
          ? route.days.map((_, i) => i)
          : [Number(currentRouteView)];
        if (resetLabels) resetLabelOffsets(targetDays);
        for (let targetIndex = 0; targetIndex < targetDays.length; targetIndex += 1) {
          const dayIndex = targetDays[targetIndex];
          if (!route.days[dayIndex]) continue;
          if (!background) {
            setLoading('正在计算路线…', {
              percent: 12 + Math.round((targetIndex / Math.max(1, targetDays.length)) * 72),
              detail: `D${dayIndex + 1} / ${targetDays.length} 天`
            });
          }
          const signature = daySignature(route.days[dayIndex]);
          const cached = route.segmentCache[dayIndex];
          const expectedSegments = Math.max(0, getDayPoints(route.days[dayIndex]).filter((item) => isPointReady(item.point)).length - 1);
          const cacheMatches = cached
            && Array.isArray(cached.segments)
            && (cached.signature === signature || (!cached.signature && cached.segments.length >= expectedSegments));
          if (cacheMatches) {
            segmentResults[dayIndex] = { segments: cached.segments };
            continue;
          }
          const segments = await routeMap.calculateDaySegments(route.days[dayIndex]);
          segmentResults[dayIndex] = { segments };
          route.segmentCache[dayIndex] = { signature, segments, updatedAt: new Date().toISOString() };
        }
        renderAll(true);
        saveRoute(false);
        if (!background) toast(currentRouteView === 'all' ? '全程路线计算完成。' : '当天路线计算完成。');
      } finally {
        restoreButton();
        busyActions.delete('calculate-route');
        if (!background) hideLoading();
      }
    }

    function scheduleBackgroundRouteCalculation() {
      if (!routeMap.isReady() || !hasReadyRoutePoints(route) || hasCachedRouteSegments(route)) return;
      setTimeout(() => {
        calculateRoute({background: true, resetLabels: false}).catch((error) => {
          console.warn('Background route calculation failed:', error);
        });
      }, 350);
    }

    function isGeneratedDayTitle(value) {
      return /^(?:第\s*\d+\s*天|第[一二三四五六七八九十百千万]+\s*天)$/.test(cleanDayTitle(value));
    }

    function renumberGeneratedDayTitles(days) {
      days.forEach((day, index) => {
        if (isGeneratedDayTitle(day.title)) day.title = `第 ${index + 1} 天`;
      });
    }

    function addDayAfter(dayIndex) {
      if (currentRouteView !== 'all') {
        currentRouteView = 'all';
        renderDaySelect();
      }
      const anchor = route.days[dayIndex];
      if (!anchor) return;
      const nextDay = {
        title: `第 ${dayIndex + 2} 天`,
        from: structuredClone(anchor.to || {name: '', lng: null, lat: null}),
        waypoints: [],
        to: {name: '', lng: null, lat: null}
      };
      route.days.splice(dayIndex + 1, 0, nextDay);
      renumberGeneratedDayTitles(route.days);
      route.segmentCache = {};
      segmentResults = [];
      renderAll(true);
      saveRoute(false);
      toast(`已在 D${dayIndex + 1} 后新增一天。`);
    }

    window.renameDay = function(dayIndex, value) {
      if (route.days[dayIndex]) route.days[dayIndex].title = cleanDayTitle(value) || `第 ${dayIndex + 1} 天`;
      renderDaySelect();
      saveRoute(false);
    };

    window.moveWaypoint = function(dayIndex, waypointIndex, delta) {
      const list = route.days[dayIndex]?.waypoints;
      if (!list) return;
      const nextIndex = waypointIndex + delta;
      if (nextIndex < 0 || nextIndex >= list.length) return;
      [list[waypointIndex], list[nextIndex]] = [list[nextIndex], list[waypointIndex]];
      segmentResults = [];
      renderAll(true);
      saveRoute(false);
    };

    const TRANSPORT_LABELS = {drive: '车', ride: '骑', walk: '步'};
    const TRANSPORT_ORDER = ['drive', 'ride', 'walk'];

    window.cyclePointMode = function(dayIndex, kind, waypointIndex) {
      const day = route.days[Number(dayIndex)];
      if (!day) return;
      const point = kind === 'to' ? day.to : day.waypoints[Number(waypointIndex)];
      if (!point) return;
      const current = window.RouteModel.normalizeTransportMode(point.transportMode);
      const next = TRANSPORT_ORDER[(TRANSPORT_ORDER.indexOf(current) + 1) % TRANSPORT_ORDER.length];
      point.transportMode = next;
      route.segmentCache = route.segmentCache || {};
      delete route.segmentCache[Number(dayIndex)];
      segmentResults[Number(dayIndex)] = {segments: []};
      renderAll(false);
      saveRoute(false);
      calculateRoute({background: true, resetLabels: false}).catch((error) => {
        console.warn('重算路线失败:', error?.message || error);
      });
      toast(`已切换为${TRANSPORT_LABELS[next]}，正在重算…`);
    };

    window.deleteWaypoint = function(dayIndex, waypointIndex) {
      const list = route.days[dayIndex]?.waypoints;
      if (!list) return;
      list.splice(waypointIndex, 1);
      segmentResults = [];
      renderAll(true);
      saveRoute(false);
    };

    window.deleteDay = function(dayIndex) {
      if (route.days.length <= 1) return toast('至少保留一天行程。');
      route.days.splice(dayIndex, 1);
      renumberGeneratedDayTitles(route.days);
      route.segmentCache = {};
      segmentResults = [];
      renderAll(true);
      saveRoute(false);
    };

    window.accountOpenRoute = async function(routeId) {
      await runExclusive(`account-open-route:${routeId}`, async () => {
        await loadRouteFromAccount(routeId);
        closeAccountCenter();
      }, {message: '正在打开路线，请稍候。'});
    };

    function findRouteBookItemByIdentifier(identifier) {
      const archived = archiveController.getRoutes().find((item) => item.safeName === identifier || item.id === identifier);
      const matchKey = archived?.routeData?.id || archived?.name || identifier;
      return routeBook.routes.find((item) => item.id === matchKey || item.name === matchKey) || null;
    }

    window.accountRenameRoute = async function(routeId) {
      const archived = archiveController.getRoutes().find((item) => item.safeName === routeId || item.id === routeId);
      const target = findRouteBookItemByIdentifier(routeId);
      if (!target) return toast('未找到这条路线。');
      const next = prompt('路线名称', target.name || '');
      if (next === null) return;
      await runExclusive(`account-rename-route:${routeId}`, async () => {
        if (await renameRouteById(target.id, next)) {
          await refreshArchivedRoutes({force: true});
          renderAccountRoutes();
        }
      }, {message: '正在改名，请稍候。'});
    };

    window.accountDeleteRoute = async function(routeId) {
      const archived = archiveController.getRoutes().find((item) => item.safeName === routeId || item.id === routeId);
      const target = findRouteBookItemByIdentifier(routeId);
      if (!target && !archived) return toast('未找到这条路线。');
      if (!confirm(`删除路线“${target?.name || archived?.name || '未命名路线'}”？`)) return;
      await runExclusive(`account-delete-route:${routeId}`, async () => {
        if (target) {
          if (await deleteRouteById(target.id)) {
            await refreshArchivedRoutes({force: true});
            renderAccountRoutes();
          }
        } else {
          const {response, data} = await localService.deleteRoute(archived.routeData?.id || routeId);
          if (!response.ok || !data?.ok) return toast('云端删除失败：' + (data?.message || '请重试'));
          await refreshArchivedRoutes({force: true});
          renderAccountRoutes();
        }
      }, {message: '正在删除路线，请稍候。'});
    };

    window.accountPublishRoute = async function(routeId) {
      await runExclusive(`account-publish-route:${routeId}`, async () => {
        await archiveController.publishRouteById(routeId);
        renderAccountRoutes();
      }, {message: '正在发布路线，请稍候。'});
    };

    window.accountImportPublished = async function(routeId) {
      await runExclusive(`account-import-published:${routeId}`, () => archiveController.importPublished(routeId), {
        message: '正在导入路线，请稍候。'
      });
    };

    window.accountPreviewUserScene = function(sceneId) {
      const scene = accountUserScenes.find((item) => item.id === sceneId);
      if (!scene) return;
      showSpotInfo(scene.name || scene.title);
    };

    window.accountEditUserScene = function(sceneId) {
      const scene = accountUserScenes.find((item) => item.id === sceneId);
      if (!scene) return;
      accountSceneEditMode = 'private';
      accountPublicSceneOriginalName = '';
      setAccountSceneMode('mine');
      el('accountSceneId').value = scene.id;
      el('accountSceneName').value = scene.name || scene.title || '';
      el('accountSceneDescription').value = scene.description || '';
      el('accountSceneImages').value = '';
      el('accountCancelSceneBtn').hidden = false;
      el('accountSaveSceneBtn').textContent = '保存修改';
      el('accountSceneStatus').textContent = `正在编辑：${scene.name || scene.title}`;
      el('accountSceneName').focus();
    };

    window.accountEditPublicScene = async function(name) {
      await runExclusive(`account-edit-public-scene:${name}`, async () => {
        const {response, data} = await localService.getScenic(name, {force: true});
        if (!response.ok || !data?.ok || !data.spot) {
          toast('未找到这个公共景点。');
          return;
        }
        const spot = data.spot;
        accountSceneEditMode = 'public';
        accountPublicSceneOriginalName = spot.name || name;
        setAccountSceneMode('mine');
        el('accountSceneId').value = '';
        el('accountSceneName').value = spot.name || spot.title || name;
        el('accountSceneDescription').value = spot.description || '';
        el('accountSceneImages').value = '';
        el('accountCancelSceneBtn').hidden = false;
        el('accountSaveSceneBtn').textContent = `保存公共 v${Number(spot.version || 0) + 1}`;
        el('accountSceneStatus').textContent = `正在编辑公共景点：${spot.name || spot.title || name}。保存会更新公共库并保留历史版本。`;
        el('accountSceneName').focus();
      }, {message: '正在读取公共景点，请稍候。'});
    };

    window.accountDeleteUserScene = async function(sceneId) {
      const scene = accountUserScenes.find((item) => item.id === sceneId);
      if (!scene || !confirm(`删除个人景点介绍“${scene.name || scene.title}”？`)) return;
      const {response, data} = await localService.deleteUserScene(sceneId);
      if (!response.ok || !data?.ok) return toast('删除失败：' + (data?.message || '请重试'));
      if (el('accountSceneId').value === sceneId) resetAccountSceneEditor();
      await renderAccountScenes();
      toast('个人景点介绍已删除。');
    };

    window.accountImportScene = async function(name) {
      if (!confirm(`将公共景点“${name}”复制到我的景点？同名个人介绍会优先用于你的路线。`)) return;
      const {response, data} = await localService.importScene(name);
      if (!response.ok || !data?.ok) return toast('导入失败：' + (data?.message || '请重试'));
      setAccountSceneMode('mine');
      await renderAccountScenes();
      toast('已复制到我的景点。');
    };

    window.accountDeletePublished = async function(routeId) {
      if (!runtime.isAdmin || !confirm('删除这条公共路线？')) return;
      const {response, data} = await localService.deletePublishedRoute(routeId);
      if (!response.ok || !data?.ok) return toast('删除公共路线失败：' + (data?.message || '请重试'));
      toast('公共路线已删除。');
      await refreshAdminDashboard();
    };

    window.accountDeleteScene = async function(name) {
      if (!runtime.isAdmin || !confirm(`删除景点介绍“${name}”？`)) return;
      const {response, data} = await localService.deleteScenic(name);
      if (!response.ok || !data?.ok) return toast('删除景点失败：' + (data?.message || '请重试'));
      toast('景点介绍已删除。');
      await renderAccountScenes();
      await refreshAdminDashboard();
    };

    window.accountShowSceneDiff = async function(name) {
      try {
        const {response, data} = await localService.listScenicRevisions(name);
        if (!response.ok || !data?.ok) throw new Error(data?.message || '无法读取编辑记录');
        el('sceneDiffTitle').textContent = `${name} · 编辑记录`;
        const revisions = data.revisions || [];
        el('sceneDiffList').innerHTML = revisions.length
          ? revisions.map((item) => `
            <div class="archive-item">
              <div class="archive-item-head">
                <span>v${escapeHtml(item.version || 1)} · ${escapeHtml(routeTime(item.createdAt))}</span>
                <span class="cloud-save-state">${escapeHtml(item.editedByEmail || '未知')}</span>
              </div>
              ${item.changeNote ? `<div class="archive-item-sub">${escapeHtml(item.changeNote)}</div>` : ''}
              <div class="diff-list">
                ${(item.diff || []).map((line) => `<div class="diff-line ${escapeAttr(line.type === 'add' ? 'add' : line.type === 'remove' ? 'remove' : '')}">${escapeHtml(line.type === 'add' ? '+ ' : line.type === 'remove' ? '- ' : '  ')}${escapeHtml(line.text || '')}</div>`).join('')}
              </div>
            </div>
          `).join('')
          : '<div class="account-empty">还没有编辑记录。</div>';
        dialogs.open('sceneDiffModal');
      } catch (error) {
        toast('读取编辑记录失败：' + error.message);
      }
    };

    async function loadConfigFromServer() {
      try {
        const { response, data } = await localService.getConfig();
        if (!response.ok || !data?.ok) return null;
        return data;
      } catch (_) {
        return null;
      }
    }

    async function ensureServiceOrExplain() {
      try {
        const { response, data } = await localService.health();
        return Boolean(response.ok && data?.ok);
      } catch (_) {
        return false;
      }
    }

    async function buildVideoData() {
      const missing = route.days.some((day, i) => {
        const expected = getDayPoints(day).length - 1;
        return !segmentResults[i] || !segmentResults[i].segments || segmentResults[i].segments.length < expected;
      });
      if (missing) {
        if (!confirm('还有天数没有计算路线。是否先计算全程再导出 MP4 数据？')) return;
        const oldView = currentRouteView;
        currentRouteView = 'all';
        await calculateRoute();
        currentRouteView = oldView;
        renderDaySelect();
      }
      return videoDataBuilder.build({
        route,
        segmentResults,
        currentMapLayer,
        ensureScenicInfo
      });
    }

    async function exportCurrentRoute({renderVideo = false} = {}) {
      if (busyActions.has('export-route')) return toast('正在导出，请稍候。');
      busyActions.add('export-route');
      const restoreButton = setButtonBusy('exportConfirmBtn', true, '导出中…');
      startExportProgressPolling();
      try {
        saveRoute(false);
        const videoData = await buildVideoData();
        setLoading('正在上传导出数据…', {percent: 8, detail: '准备'});
        const { response, data: result } = await localService.exportRoute({
          routeData: route,
          videoData,
          renderVideo,
          mapLayer: currentMapLayer,
          config: {
            key: window.AMAP_PLANNER_CONFIG?.key || '',
            securityJsCode: window.AMAP_PLANNER_CONFIG?.securityJsCode || ''
          }
        });
        if (response.status === 409 && result?.code === 'EXPORT_RUNNING') {
          renderExportTaskPanel({rendering: true, progress: result.progress || {}});
          openExportModal();
          toast('已有导出任务，可终止后重新导出。');
          return;
        }
        if (response.status === 409 && result?.code === 'EXPORT_CANCELLED') {
          toast('导出已终止。');
          return;
        }
        if (!response.ok || !result.ok) throw new Error(result.message || '导出失败');
        if (result.queued) {
          toast(result.job?.render_video ? '全量导出已进入队列，视频会在后台生成。' : '导出任务已进入队列。');
          return;
        }
        setLoading('导出完成', {percent: 100, detail: '完成'});
        const parts = ['JSON', 'MD', result.routeMapImage ? 'PNG' : null, result.manualPdf ? 'PDF' : null, result.output ? 'MP4' : null].filter(Boolean).join(' + ');
        const routeManageStatus = el('routeManageStatus');
        if (routeManageStatus) {
          routeManageStatus.textContent = `已导出到：${result.dir}${result.routeMapImage ? '；PNG：' + result.routeMapImage : ''}${result.manualPdf ? '；PDF：' + result.manualPdf : ''}${result.routeMapError ? '；PNG 警告：' + result.routeMapError : ''}${result.pdfError ? '；PDF 警告：' + result.pdfError : ''}`;
        }
        toast(result.pdfError ? `已导出 ${parts}（PDF 失败：${result.pdfError}）` : `已导出：${parts}`);
        await refreshArchivedRoutes();
      } catch (error) {
        toast('导出失败：' + error.message);
      } finally {
        restoreButton();
        busyActions.delete('export-route');
        setTimeout(hideLoading, 500);
      }
    }

    function downloadCurrentRoute() {
      saveRoute(false);
      const content = JSON.stringify(getEditableRoute(route), null, 2);
      const blob = new Blob([content], {type: 'application/json;charset=utf-8'});
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      const safeName = (cleanRouteName(route.name) || 'road-trip-route').replace(/[\\/:*?"<>|]+/g, '-');
      anchor.href = url;
      anchor.download = `${safeName}.route.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      toast('路线 JSON 已下载。PDF 和视频可在本地高级版生成。');
    }

    function isMostlyBlankRoute(r) {
      return routeStore.isMostlyBlank(r);
    }

    function summarizeVideoDays(days) {
      let totalDistance = 0;
      let totalDuration = 0;
      const lngs = [];
      const lats = [];
      days.forEach((day) => {
        day.segments.forEach((seg) => {
          totalDistance += seg.distance || 0;
          totalDuration += seg.duration || 0;
          (seg.path || []).forEach(([lng, lat]) => { lngs.push(lng); lats.push(lat); });
        });
        day.points.forEach((p) => { lngs.push(p.lng); lats.push(p.lat); });
      });
      return {
        dayCount: days.length,
        totalDistance,
        totalDuration,
        bounds: [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)]
      };
    }

    function bootstrapUiWithoutMap() {
      bindEvents();
      if (!localService.capabilities?.serverExport) {
        el('exportBtn').textContent = '下载';
        el('exportBtn').title = '下载当前路线 JSON';
      } else if (localService.capabilities?.cloudExports) {
        el('exportBtn').title = '后台生成路线文件、手册、PDF 和 MP4';
      }
      if (localService.capabilities?.editableMapConfig === false) {
        if (el('mapPlaceholder')) {
          const title = el('mapPlaceholder').querySelector('strong');
          const copy = el('mapPlaceholder').querySelector('p');
          if (title) title.textContent = '地图服务未就绪';
          if (copy) copy.textContent = '地图由站点统一配置，刷新后仍不可用时请联系站点管理员。';
        }
      }
      if (localService.capabilities?.cloudRoutes) el('routeSelect').title = '选择当前账户下的路线';
      renderAll(false);
    }

    async function startApp() {
      bootstrapUiWithoutMap();
      communityController.refreshSelfProfile().catch(() => {});
      setLoading('地图加载中', {percent: 10});

      if (location.protocol === 'file:') {
        const up = await ensureServiceOrExplain();
        if (up) {
          location.href = 'http://127.0.0.1:6137/';
          return;
        }
        openSetupOverlay('请先双击根目录 start.bat 启动本地服务。仅直接打开 app/web/index.html 时无法读取 data/routes/ 与本地密钥。');
        el('mapPlaceholder').classList.add('show');
        el('mapPlaceholder').innerHTML = '<strong>需要本地服务</strong><p>请先运行根目录 <code>start.bat</code>，浏览器会打开 http://127.0.0.1:6137 。启动后自动加载地图并扫描 data/routes/。</p><button class="primary" id="retryServerBtn">我已启动，重试</button>';
        const retry = el('retryServerBtn');
        if (retry) retry.onclick = () => location.reload();
        return;
      }

      const remote = await loadConfigFromServer();
      setLoading('地图加载中', {percent: 30});
      if (remote?.configured && remote.key && remote.securityJsCode) {
        localStorage.setItem('amap-planner-config', JSON.stringify({ key: remote.key, securityJsCode: remote.securityJsCode }));
        window.AMAP_PLANNER_CONFIG = { key: remote.key, securityJsCode: remote.securityJsCode };
        window._AMapSecurityConfig = { securityJsCode: remote.securityJsCode };
      }

      if (!hasAmapConfig()) {
        hideLoading();
        if (runtime.isAdmin) {
          openSetupOverlay('首次使用，请配置高德 Web JS API Key 与安全密钥。');
        } else {
          showMapLoadFailure('管理员尚未完成地图配置。');
        }
        return;
      }

      try {
        el('mapPlaceholder')?.classList.remove('show');
        setLoading('地图加载中', {percent: 68});
        await loadAmap();
        setLoading('地图加载中', {percent: 88});
        await initMap();
        setLoading('地图加载中', {percent: 100});
        setTimeout(hideLoading, 180);
        toast('地图加载成功');
        refreshArchivedRoutes({autoSelectFirst: isMostlyBlankRoute(route)})
          .then(() => {
            applyCachedSegmentResults(route);
            renderAll(false);
            scheduleBackgroundRouteCalculation();
          })
          .catch((error) => toast('路线库同步失败：' + error.message));
      } catch (error) {
        hideLoading();
        const targetDomain = localService.capabilities?.mode === 'cloud' ? location.hostname : '127.0.0.1 / localhost';
        showMapLoadFailure((error && error.message ? error.message + '。' : '') + `请检查网络${runtime.isAdmin ? `、Key、安全密钥和域名白名单（${targetDomain}）` : '，或联系管理员'}。`);
        toast('地图加载失败');
      }
    }

    startApp();
