const runtime = window.APP_RUNTIME || {mode: 'local', user: null};
    const STORAGE_KEY = `tour-driving-route-planner:v4:${runtime.user?.id || runtime.mode || 'local'}`;
    const ROUTE_COLORS = ['#1677ff', '#16a34a', '#f59e0b', '#a855f7', '#ef4444', '#06b6d4', '#64748b'];
    const localService = window.AppServiceClient.create();
    const el = (id) => document.getElementById(id);

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
      daySignature
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
      toast
    });
    const onSearchInput = placeSearch.onInput;
    const onSearchKeydown = placeSearch.onKeydown;
    const closeSuggestions = placeSearch.closeSuggestions;
    const searchPlace = placeSearch.searchPlace;
    const setPointForm = placeSearch.setPointForm;
    const resolveByKeyword = placeSearch.resolveByKeyword;
    const reverseName = placeSearch.reverseName;

    let routeBook = routeStore.load();
    let route = routeStore.getActive(routeBook);
    let currentMapLayer = localStorage.getItem('amap-planner-map-layer') || 'standard';
    let segmentResults = [];
    let currentRouteView = 'all';
    let activeTabId = 'routePanel';
    let jsonEditorDirty = true;
    let jsonSyncTimer = null;
    let cloudSaveTimer = null;
    let accountView = 'routes';
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
      renderSummary,
      syncEditor,
      renderAll,
      calculateRoute,
      isMapReady: routeMap.isReady,
      getEditableRoute
    });
    const refreshArchivedRoutes = archiveController.refresh;
    window.loadArchivedRoute = archiveController.load;
    window.publishArchivedRoute = archiveController.publishRouteById;
    window.importPublishedRoute = archiveController.importPublished;
    const pointEditor = window.PointEditorController.create({
      el,
      routeMap,
      getDayPoints,
      fixed,
      toast,
      scenicController,
      placeSearch,
      getRoute: () => route,
      setView: (view) => { currentRouteView = view; },
      clearSegments: () => { segmentResults = []; },
      renderAll,
      renderDaySelect,
      setTab,
      onChanged: () => saveRoute(false)
    });
    const closePointEditor = pointEditor.close;
    const confirmPointEdit = pointEditor.confirm;
    window.openPointEditor = pointEditor.open;
    window.testExistingPoint = pointEditor.testExistingPoint;
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
      }, (point) => {
        if (!pointEditor.isMapClickEnabled()) return;
        reverseName(point.lng, point.lat).then((name) => {
          setPointForm(name, point.lng, point.lat);
          toast('已从地图点击位置取点。');
        });
      });
      setMapLayer(currentMapLayer);

      el('mapPlaceholder')?.classList.remove('show');
      closeSetupOverlay();
      bindEvents();
      renderAll(false);
      toast(localService.capabilities?.cloudRoutes ? '地图已就绪，正在同步你的路线…' : '地图已就绪，正在读取路线…');
      const readyPoints = route?.days?.some((day) => getDayPoints(day).map((x) => x.point).filter(isPointReady).length >= 2);
      if (readyPoints) {
        try {
          renderAll(true);
          calculateRoute();
        } catch (error) {
          toast(`路线“${route.name || ''}”存在无法绘制的坐标：${error.message}`);
        }
      } else {
        renderAll(false);
        toast('地图已就绪。请从下拉框选择路线，或添加起点终点后点“刷新”。');
      }
    }

    function bindEvents() {
      document.querySelectorAll('.tab-btn').forEach((btn) => {
        btn.onclick = () => setTab(btn.dataset.tab);
      });
      if (el('openSetupFromMapBtn')) el('openSetupFromMapBtn').onclick = () => openSetupOverlay();
      if (el('setupSaveBtn')) el('setupSaveBtn').onclick = () => saveAmapConfigFromInputs('setupKeyInput', 'setupSecurityInput', 'setupStatus');
      if (el('setupTestBtn')) el('setupTestBtn').onclick = () => testAmapConfigFromInputs('setupKeyInput', 'setupSecurityInput', 'setupStatus');
      el('newRouteBtn').onclick = createRouteFromPrompt;
      if (el('emptyRouteCreateBtn')) el('emptyRouteCreateBtn').onclick = createRouteFromPrompt;
      el('calcBtn').onclick = calculateRoute;
      el('exportBtn').onclick = openExportModal;
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
      if (el('configBtn')) el('configBtn').onclick = openConfigModal;
      el('configCloseBtn').onclick = () => el('configModal').classList.remove('open');
      el('saveConfigBtn').onclick = saveAmapConfig;
      el('testConfigBtn').onclick = testAmapConfig;
      bindExportModal();
      el('spotCloseBtn').onclick = scenicController.closeSpotPanel;
      el('imageLightbox').onclick = scenicController.closeLightbox;
      el('applyJsonBtn').onclick = applyJson;
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
      el('pointConfirmBtn').onclick = confirmPointEdit;
      el('pointCancelBtn').onclick = closePointEditor;
      el('pointModalClose').onclick = closePointEditor;
      bindPointTransportControls();
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.search-wrap')) closeSuggestions();
        scenicController.handleOutsideClick(e.target);
      });
      el('useMapClickBtn').onclick = pointEditor.toggleMapClick;
    }

    function bindAccountControls() {
      if (el('userMenuBtn')) el('userMenuBtn').onclick = openAccountCenter;
      if (el('accountCenterCloseBtn')) el('accountCenterCloseBtn').onclick = closeAccountCenter;
      document.querySelectorAll('[data-account-view]').forEach((button) => {
        button.onclick = () => setAccountView(button.dataset.accountView);
      });
      if (el('accountPublishSceneBtn')) el('accountPublishSceneBtn').onclick = publishSceneFromAccount;
      if (el('adminSaveConfigBtn')) {
        el('adminSaveConfigBtn').onclick = () => saveAmapConfigFromInputs('adminAmapKeyInput', 'adminAmapSecurityInput', 'adminConfigStatus');
      }
      if (el('adminRefreshBtn')) el('adminRefreshBtn').onclick = refreshAdminDashboard;
      if (el('accountLogoutBtn')) el('accountLogoutBtn').onclick = () => { location.href = '/logout'; };
      if (el('sceneDiffCloseBtn')) el('sceneDiffCloseBtn').onclick = () => el('sceneDiffModal').classList.remove('open');
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
    }

    function setAccountView(view) {
      accountView = view === 'admin' && !runtime.isAdmin ? 'routes' : (view || 'routes');
      document.querySelectorAll('[data-account-view]').forEach((button) => {
        button.classList.toggle('active', button.dataset.accountView === accountView);
      });
      document.querySelectorAll('.account-view').forEach((panel) => {
        panel.classList.toggle('active', panel.id === `accountView${accountView[0].toUpperCase()}${accountView.slice(1)}`);
      });
      refreshAccountCenter();
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

    function renderAccountRoutes() {
      const box = el('accountRouteList');
      if (!box) return;
      const routes = routeBook.routes || [];
      el('accountRouteCount').textContent = String(routes.length);
      if (!routes.length) {
        box.innerHTML = '<div class="account-empty">还没有路线。</div>';
        return;
      }
      box.innerHTML = routes.map((item) => `
        <div class="account-item route-account-item">
          <div class="account-item-main">
            <strong>${escapeHtml(cleanRouteName(item.name) || '未命名路线')}</strong>
            <span>${escapeHtml(item.days?.length || 0)} 天 · ${escapeHtml(item.id || '')}</span>
          </div>
          <span class="account-item-time">${escapeHtml(routeTime(item.updatedAt || item.archivedAt))}</span>
          <div class="account-item-actions">
            <button class="small primary" onclick="accountOpenRoute('${escapeJsAttr(item.id)}')">打开</button>
            ${renderAccountAssetButtons(item)}
          </div>
        </div>
      `).join('');
    }

    function renderAccountAssetButtons(item) {
      const archived = archiveController.getRoutes().find((routeItem) => routeItem.safeName === item.id || routeItem.name === item.name);
      if (!archived) return '';
      const base = localService.routeAssetBase(archived);
      const version = encodeURIComponent(archived.updatedAt || archived.archivedAt || Date.now());
      const manualPdfUrl = archived.assetUrls?.manualPdf || `${base}.travel.pdf?v=${version}`;
      const mp4Url = archived.assetUrls?.mp4 || `${base}.mp4?v=${version}`;
      return [
        archived.manualPdf ? `<button class="small" onclick="window.open('${escapeJsAttr(manualPdfUrl)}', '_blank')">PDF</button>` : '',
        archived.mp4 ? `<button class="small" onclick="window.open('${escapeJsAttr(mp4Url)}', '_blank')">MP4</button>` : '',
      ].join('');
    }

    async function renderAccountScenes() {
      const box = el('accountSceneList');
      if (!box) return;
      try {
        const {response, data} = await localService.listScenes();
        if (!response.ok || !data?.ok) throw new Error(data?.message || '无法读取景点介绍');
        const scenes = data.scenes || [];
        el('accountSceneCount').textContent = String(scenes.length);
        if (!scenes.length) {
          box.innerHTML = '<div class="account-empty">还没有公共景点介绍。</div>';
          return;
        }
        box.innerHTML = scenes.map((item) => `
          <div class="account-item admin-content-item">
            <div class="account-item-main">
              <strong>${escapeHtml(item.title || item.name || '未命名景点')}</strong>
              <span>${escapeHtml(item.updatedByEmail || '未知')} · 图片 ${escapeHtml(item.imageCount || 0)}</span>
            </div>
            <div class="account-item-actions">
              <button class="small primary" onclick="showSpotInfo('${escapeJsAttr(item.name || item.title)}')">查看</button>
              <button class="small" onclick="accountShowSceneDiff('${escapeJsAttr(item.name || item.title)}')">Diff</button>
              ${runtime.isAdmin ? `<button class="small danger" onclick="accountDeleteScene('${escapeJsAttr(item.name || item.title)}')">删除</button>` : ''}
            </div>
          </div>
        `).join('');
      } catch (error) {
        box.innerHTML = `<div class="account-empty">读取景点介绍失败：${escapeHtml(error.message)}</div>`;
      }
    }

    async function publishSceneFromAccount() {
      const name = el('accountSceneName').value.trim();
      const description = el('accountSceneDescription').value.trim();
      const files = [...(el('accountSceneImages').files || [])];
      if (!name) return toast('请填写景点名称。');
      try {
        const result = await scenicController.saveScenicInfo({name, title: name, description, files});
        if (!result) return toast('请填写介绍或选择图片。');
        el('accountSceneName').value = '';
        el('accountSceneDescription').value = '';
        el('accountSceneImages').value = '';
        el('accountSceneStatus').textContent = `已发布：${name}`;
        await renderAccountScenes();
        toast('景点介绍已发布。');
      } catch (error) {
        toast('发布景点失败：' + error.message);
      }
    }

    async function refreshAdminDashboard() {
      if (!runtime.isAdmin) return;
      const usersBox = el('adminUserList');
      const contentBox = el('adminPublicContentList');
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
              <div class="account-item-main"><strong>${escapeHtml(item.email)}</strong><span>路线 ${escapeHtml(item.routeCount || 0)}</span></div>
              <span class="account-item-time">${escapeHtml(routeTime(item.lastRouteAt))}</span>
            </div>
          `).join('')
          : '<div class="account-empty">还没有用户路线数据。</div>';
        const routes = (data.publishedRoutes || []).map((item) => `
          <div class="account-item admin-content-item">
            <div class="account-item-main"><strong>路线：${escapeHtml(item.name)}</strong><span>${escapeHtml(item.published_by_email || '未知')}</span></div>
            <div class="account-item-actions"><button class="small danger" onclick="accountDeletePublished('${escapeJsAttr(item.id)}')">删除</button></div>
          </div>
        `).join('');
        const scenes = (data.scenes || []).map((item) => `
          <div class="account-item admin-content-item">
            <div class="account-item-main"><strong>景点：${escapeHtml(item.title || item.name)}</strong><span>${escapeHtml(item.updated_by_email || '未知')}</span></div>
            <div class="account-item-actions"><button class="small" onclick="accountShowSceneDiff('${escapeJsAttr(item.name || item.title)}')">Diff</button><button class="small danger" onclick="accountDeleteScene('${escapeJsAttr(item.name || item.title)}')">删除</button></div>
          </div>
        `).join('');
        contentBox.innerHTML = routes + scenes || '<div class="account-empty">还没有公共内容。</div>';
      } catch (error) {
        if (usersBox) usersBox.innerHTML = `<div class="account-empty">读取管理数据失败：${escapeHtml(error.message)}</div>`;
      }
    }

    function bindRouteLibraryControls() {
      if (el('routeLibraryBtn')) el('routeLibraryBtn').onclick = openRouteLibrary;
      if (el('routeLibraryCloseBtn')) el('routeLibraryCloseBtn').onclick = closeRouteLibrary;
      if (el('publishCurrentRouteBtn')) el('publishCurrentRouteBtn').onclick = archiveController.publishCurrent;
      if (el('refreshRouteLibraryBtn')) el('refreshRouteLibraryBtn').onclick = () => refreshArchivedRoutes();
      if (el('publishCurrentRouteBtn')) el('publishCurrentRouteBtn').hidden = !localService.capabilities?.publishedRoutes;
    }

    function bindPointTransportControls() {
      document.querySelectorAll('[data-point-transport]').forEach((button) => {
        button.onclick = () => pointEditor.setTransportMode(button.dataset.pointTransport);
      });
    }

    function openRouteLibrary() {
      el('routeLibraryModal')?.classList.add('open');
      refreshArchivedRoutes();
    }

    function closeRouteLibrary() {
      el('routeLibraryModal')?.classList.remove('open');
    }

    function setTab(tabId) {
      activeTabId = tabId;
      document.querySelectorAll('.tab-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tabId));
      document.querySelectorAll('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.id === tabId));
      if (tabId === 'codePanel') syncEditor(true);
    }

    function selectRouteFromDropdown() {
      const value = el('routeSelect').value;
      if (value === '__public_routes__') {
        openRouteLibrary();
        renderRouteSelect();
        return;
      }
      if (value.startsWith('archive:')) return loadArchivedRoute(value.slice(8));
      routeBook.activeRouteId = value;
      route = routeStore.getActive(routeBook);
      currentRouteView = 'all';
      segmentResults = [];
      renderAll(true);
      if (routeMap.isReady()) calculateRoute();
    }

    async function loadRouteFromAccount(routeId) {
      const localRoute = routeBook.routes.find((item) => item.id === routeId);
      if (!localRoute) return archiveController.load(routeId);
      routeBook.activeRouteId = localRoute.id;
      route = routeStore.getActive(routeBook);
      currentRouteView = 'all';
      segmentResults = [];
      renderAll(true);
      const readyPoints = route.days.some((day) => getDayPoints(day)
        .map((item) => item.point)
        .filter(isPointReady)
        .length >= 2);
      if (routeMap.isReady() && readyPoints) await calculateRoute();
      toast('已打开路线：' + (route.name || '未命名路线'));
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
          : '配置会写入浏览器，并同步到 data/config/local.env。');
      el('setupOverlay').classList.add('open');
      el('mapPlaceholder')?.classList.add('show');
    }

    function closeSetupOverlay() {
      el('setupOverlay').classList.remove('open');
    }

    function openConfigModal() {
      if (localService.capabilities?.editableMapConfig === false || runtime.isAdmin) {
        return toast('网站地图配置由管理员统一维护。');
      }
      el('amapKeyInput').value = window.AMAP_PLANNER_CONFIG?.key || '';
      el('amapSecurityInput').value = window.AMAP_PLANNER_CONFIG?.securityJsCode || '';
      el('configStatus').textContent = localService.capabilities?.mode === 'cloud'
        ? '保存后会写入站点配置，所有用户刷新后使用这组 Key。'
        : '保存后页面会重新加载高德地图。密钥只存在本机浏览器。';
      el('configModal').classList.add('open');
    }

    function bindExportModal() {
      if (!el('exportModal')) return;
      el('exportCancelBtn').onclick = closeExportModal;
      el('exportCancelBtn2').onclick = closeExportModal;
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
      el('exportModal').classList.add('open');
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

    function saveAmapConfig() {
      saveAmapConfigFromInputs('amapKeyInput', 'amapSecurityInput', 'configStatus');
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
      // Temporary apply for test if map already loaded with different key, still reload for full test.
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

    function testAmapConfig() {
      testAmapConfigFromInputs('amapKeyInput', 'amapSecurityInput', 'configStatus');
    }

    function saveRoute(showToast = true) {
      if (!route) return;
      try {
        routeBook.activeRouteId = route.id;
        routeStore.save(routeBook);
        syncEditor();
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

    async function createRouteFromPrompt() {
      const name = prompt('路线名称', '未命名路线');
      if (name === null) return;
      const daysText = prompt('天数', '1');
      if (daysText === null) return;
      const dayCount = Math.max(1, Math.min(30, Number(daysText || 1)));
      await createRouteFromAccount({name, dayCount});
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
        if (route?.id === routeId) syncEditor();
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

    function syncEditor(force = false) {
      jsonEditorDirty = true;
      if (activeTabId !== 'codePanel') return;
      if (jsonSyncTimer) clearTimeout(jsonSyncTimer);
      if (force) {
        jsonSyncTimer = null;
        syncEditorNow(true);
        return;
      }
      jsonSyncTimer = setTimeout(() => {
        jsonSyncTimer = null;
        syncEditorNow(false);
      }, 0);
    }

    function syncEditorNow(force = false) {
      const editor = el('jsonEditor');
      if (!editor || activeTabId !== 'codePanel') return;
      if (!force && !jsonEditorDirty) return;
      if (!force && document.activeElement === editor) return;
      editor.value = route ? JSON.stringify(getEditableRoute(route), null, 2) : '';
      jsonEditorDirty = false;
    }

    function getEditableRoute(input) {
      if (!input && !route) return null;
      const next = normalizeRoute(structuredClone(input || route));
      return {
        id: next.id,
        name: next.name,
        days: next.days.map((day) => ({
          title: cleanDayTitle(day.title),
          from: day.from,
          waypoints: day.waypoints,
          to: day.to
        }))
      };
    }

    function applyJson() {
      try {
        const parsed = JSON.parse(el('jsonEditor').value);
        if (!parsed.segmentCache && route?.segmentCache) parsed.segmentCache = route.segmentCache;
        route = normalizeRoute(parsed);
        const idx = routeBook.routes.findIndex((r) => r.id === route.id);
        if (idx >= 0) routeBook.routes[idx] = route;
        else routeBook.routes.push(route);
        routeBook.activeRouteId = route.id;
        segmentResults = [];
        renderAll(false);
        calculateRoute();
        toast('已应用 JSON 路线。');
      } catch (err) {
        toast('JSON 格式有误：' + err.message);
      }
    }

    function renderAll(fit = true) {
      route = route ? normalizeRoute(route) : routeStore.getActive(routeBook) || null;
      renderRouteSelect();
      renderDaySelect();
      renderSummary();
      renderDays();
      renderMarkersAndSegments(fit);
      syncEditor();
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

    function renderSummary() {
      routeRenderer.renderSummary({route, segmentResults});
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
          showSpotInfo(item.point.name);
        }
      });
    }

    async function calculateRoute() {
      if (!route) return toast('请先新建路线，或从公共路线导入。');
      if (!routeMap.isReady()) {
        openSetupOverlay('请先配置并加载高德地图，再计算路线。');
        return toast('请先完成高德配置。');
      }
      route = normalizeRoute(route);
      if (!route.days.length) return;
      setLoading('正在计算路线…');
      try {
        route.segmentCache = route.segmentCache || {};
        if (!Array.isArray(segmentResults) || segmentResults.length !== route.days.length) {
          segmentResults = route.days.map((_, dayIndex) => ({ segments: route.segmentCache[dayIndex]?.segments || [] }));
        }
        const targetDays = currentRouteView === 'all'
          ? route.days.map((_, i) => i)
          : [Number(currentRouteView)];
        for (const dayIndex of targetDays) {
          if (!route.days[dayIndex]) continue;
          const signature = daySignature(route.days[dayIndex]);
          const cached = route.segmentCache[dayIndex];
          if (cached && cached.signature === signature && Array.isArray(cached.segments)) {
            segmentResults[dayIndex] = { segments: cached.segments };
            continue;
          }
          const segments = await routeMap.calculateDaySegments(route.days[dayIndex]);
          segmentResults[dayIndex] = { segments };
          route.segmentCache[dayIndex] = { signature, segments, updatedAt: new Date().toISOString() };
        }
        renderAll(true);
        saveRoute(false);
        setTab('routePanel');
        toast(currentRouteView === 'all' ? '全程路线计算完成。' : '当天路线计算完成。');
      } finally {
        hideLoading();
      }
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

    async function resolveAllNames() {
      if (!confirm('按名称重新识别所有点位坐标？这会覆盖当前坐标。')) return;
      setLoading('正在用高德识别坐标…');
      try {
        for (const day of route.days) {
          const points = [day.from, ...day.waypoints, day.to];
          for (const point of points) {
            try {
              const next = await resolveByKeyword(point.name.replace(/（.*?）|\(.*?\)/g, ''));
              point.lng = next.lng;
              point.lat = next.lat;
            } catch (_) {
              // 保留原坐标
            }
          }
        }
        segmentResults = [];
        renderAll(true);
        saveRoute(false);
        toast('坐标重识别完成；个别失败点已保留原坐标。');
      } finally {
        hideLoading();
      }
    }

    window.renameDay = function(dayIndex, value) {
      if (route.days[dayIndex]) route.days[dayIndex].title = cleanDayTitle(value) || `第 ${dayIndex + 1} 天`;
      renderDaySelect();
      syncEditor();
      saveRoute(false);
    };

    window.renameDayPrompt = function(dayIndex) {
      const day = route.days[dayIndex];
      if (!day) return;
      const next = prompt(`D${dayIndex + 1} 名称`, cleanDayTitle(day.title) || `第 ${dayIndex + 1} 天`);
      if (next === null) return;
      renameDay(dayIndex, next);
      renderDays();
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
      await loadRouteFromAccount(routeId);
      closeAccountCenter();
    };

    window.accountRenameRoute = async function(routeId) {
      const target = routeBook.routes.find((item) => item.id === routeId);
      if (!target) return;
      const next = prompt('路线名称', target.name || '');
      if (next === null) return;
      if (await renameRouteById(routeId, next)) renderAccountRoutes();
    };

    window.accountDeleteRoute = async function(routeId) {
      const target = routeBook.routes.find((item) => item.id === routeId);
      if (!target) return;
      if (!confirm(`删除路线“${target.name || '未命名路线'}”？`)) return;
      if (await deleteRouteById(routeId)) renderAccountRoutes();
    };

    window.accountPublishRoute = async function(routeId) {
      await archiveController.publishRouteById(routeId);
      await refreshAdminDashboard();
    };

    window.accountImportPublished = async function(routeId) {
      await archiveController.importPublished(routeId);
      await renderAccountRoutes();
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
                <span>${escapeHtml(routeTime(item.createdAt))}</span>
                <span class="cloud-save-state">${escapeHtml(item.editedByEmail || '未知')}</span>
              </div>
              <div class="diff-list">
                ${(item.diff || []).map((line) => `<div class="diff-line ${escapeAttr(line.type === 'add' ? 'add' : line.type === 'remove' ? 'remove' : '')}">${escapeHtml(line.type === 'add' ? '+ ' : line.type === 'remove' ? '- ' : '  ')}${escapeHtml(line.text || '')}</div>`).join('')}
              </div>
            </div>
          `).join('')
          : '<div class="account-empty">还没有编辑记录。</div>';
        el('sceneDiffModal').classList.add('open');
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
        const parts = ['JSON', 'MD', result.manualPdf ? 'PDF' : null, result.output ? 'MP4' : null].filter(Boolean).join(' + ');
        const routeManageStatus = el('routeManageStatus');
        if (routeManageStatus) {
          routeManageStatus.textContent = `已导出到：${result.dir}${result.manualPdf ? '；PDF：' + result.manualPdf : ''}${result.pdfError ? '；PDF 警告：' + result.pdfError : ''}`;
        }
        toast(result.pdfError ? `已导出 ${parts}（PDF 失败：${result.pdfError}）` : `已导出：${parts}`);
        await refreshArchivedRoutes();
      } catch (error) {
        toast('导出失败：' + error.message);
      } finally {
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
      // Allow configuring before map is ready.
      if (el('configBtn')) el('configBtn').onclick = openConfigModal;
      el('configCloseBtn').onclick = () => el('configModal').classList.remove('open');
      el('saveConfigBtn').onclick = saveAmapConfig;
      el('testConfigBtn').onclick = testAmapConfig;
      bindExportModal();
      if (el('openSetupFromMapBtn')) el('openSetupFromMapBtn').onclick = () => openSetupOverlay();
      if (el('setupSaveBtn')) el('setupSaveBtn').onclick = () => saveAmapConfigFromInputs('setupKeyInput', 'setupSecurityInput', 'setupStatus');
      if (el('setupTestBtn')) el('setupTestBtn').onclick = () => testAmapConfigFromInputs('setupKeyInput', 'setupSecurityInput', 'setupStatus');
      if (el('newRouteBtn')) el('newRouteBtn').onclick = createRouteFromPrompt;
      if (el('emptyRouteCreateBtn')) el('emptyRouteCreateBtn').onclick = createRouteFromPrompt;
      el('exportBtn').onclick = openExportModal;
      bindRouteLibraryControls();
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
      if (!localService.capabilities?.serverExport) {
        el('exportBtn').textContent = '下载';
        el('exportBtn').title = '下载当前路线 JSON';
      } else if (localService.capabilities?.cloudExports) {
        el('exportBtn').title = '后台生成路线文件、手册、PDF 和 MP4';
      }
      if (localService.capabilities?.editableMapConfig === false) {
        if (el('configBtn')) el('configBtn').hidden = true;
        if (el('openSetupFromMapBtn')) el('openSetupFromMapBtn').hidden = true;
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
      if (remote?.configured && remote.key && remote.securityJsCode) {
        localStorage.setItem('amap-planner-config', JSON.stringify({ key: remote.key, securityJsCode: remote.securityJsCode }));
        window.AMAP_PLANNER_CONFIG = { key: remote.key, securityJsCode: remote.securityJsCode };
        window._AMapSecurityConfig = { securityJsCode: remote.securityJsCode };
      }

      await refreshArchivedRoutes({autoSelectFirst: isMostlyBlankRoute(route)});

      if (!hasAmapConfig()) {
        openSetupOverlay(localService.capabilities?.editableMapConfig === false
          ? '站点尚未配置高德地图。请联系站点管理员填写 Key。'
          : '第一次使用：请配置高德 Web JS API Key 与安全密钥，然后加载交互地图。');
        return;
      }

      try {
        el('mapPlaceholder')?.classList.remove('show');
        el('setupStatus') && (el('setupStatus').textContent = '正在加载高德地图…');
        await loadAmap();
        await initMap();
        toast('地图加载成功');
      } catch (error) {
        el('mapPlaceholder')?.classList.add('show');
        const targetDomain = localService.capabilities?.mode === 'cloud' ? location.hostname : '127.0.0.1 / localhost';
        openSetupOverlay((error && error.message ? error.message + '。' : '') + `请检查 Key、安全密钥、网络与域名白名单（${targetDomain}）。`);
        toast('高德地图加载失败，请重新配置。');
      }
    }

    startApp();
