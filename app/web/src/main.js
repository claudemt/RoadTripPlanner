const runtime = window.APP_RUNTIME || { mode: "local", user: null };
const STORAGE_KEY = `tour-driving-route-planner:v4:${runtime.user?.id || runtime.mode || "local"}`;
const ROUTE_COLORS = ["#1677ff", "#16a34a", "#f59e0b", "#a855f7", "#ef4444", "#06b6d4", "#64748b"];
const SEGMENT_CACHE_VERSION = 3;
const localService = window.LocalServiceClient.create(runtime);
const el = (id) => document.getElementById(id);
const dialogs = window.DialogController.create();
window.__segmentExpanded = window.__segmentExpanded instanceof Set ? window.__segmentExpanded : new Set();
const defaultRoute = {
  id: "blank-route",
  name: "\u6211\u7684\u81EA\u9A7E\u7EBF\u8DEF",
  days: [
    {
      title: "\u7B2C\u4E00\u5929",
      from: { name: "", lng: null, lat: null, transportMode: "drive" },
      waypoints: [],
      to: { name: "", lng: null, lat: null, transportMode: "drive" }
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
  geoSignature,
  normalizeLabelOffset
} = window.RouteModel;
const { normalizeTransportMode } = window.RouteModel;
const normalizeRoute = (input) => window.RouteModel.normalizeRoute(input, defaultRoute.days);
const {
  formatTripMetric,
  fixed,
  normalizeSpotName
} = window.FormatUtils;
const { escapeHtml, escapeAttr, escapeJsAttr } = window.HtmlUtils;
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
const feedback = window.FeedbackUi.create({ el, localService, dialogs });
const {
  toast,
  setLoading,
  hideLoading
} = feedback;
const scenicController = window.ScenicController.create({
  el,
  localService,
  normalizeSpotName,
  escapeHtml,
  escapeAttr,
  escapeJsAttr,
  toast,
  confirmDialog: feedback.appConfirm
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
  openLightbox: scenicController.openLightbox,
  confirmDialog: feedback.appConfirm
});
window.accountOpenProfile = (email) => communityController.openProfile(email).catch((error) => toast("\u8BFB\u53D6\u4E2A\u4EBA\u4ECB\u7ECD\u5931\u8D25\uFF1A" + error.message));
const exportTasks = window.ExportTaskController.create({ el, localService, toast });
const renderExportTaskDock = exportTasks.renderDock;
const startExportTaskPolling = exportTasks.startPolling;
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
route = route ? normalizeRoute(route) : route;
let currentMapLayer = route?.presentation?.mapLayer || localStorage.getItem("amap-planner-map-layer") || "standard";
let segmentResults = [];
let mapPickActive = false;
let currentRouteView = "all";
let cloudSaveTimer = null;
let accountView = "profile";
let accountRouteMode = "mine";
let accountSceneMode = "mine";
let accountUserScenes = [];
let accountPublicScenes = [];
let eventsBound = false;
const busyActions = new Set();
let foregroundCalcWaiting = false;
let routeCalculationTask = null;
let pendingRouteCalculation = null;
const pointInfo = window.PointInfoController.create({
  localService,
  getDayPoints,
  isPointReady,
  geoSignature,
  addDays: window.MapPresentation.addDays,
  weatherTtlMinutes: runtime.capabilities?.pointInfoWeatherTtlMinutes,
  onUpdated: (targetRoute) => {
    if (targetRoute !== route) return;
    routeStore.save(routeBook);
    setStartDateConfirmBusy(false);
    renderMarkersAndSegments(false);
  },
  onError: (error, silent) => {
    setStartDateConfirmBusy(false);
    if (!silent) toast(error.message || "\u70B9\u4F4D\u4FE1\u606F\u6682\u65F6\u4E0D\u53EF\u7528\u3002");
  }
});
function setButtonBusy(id, busy, busyText = "\u5904\u7406\u4E2D\u2026") {
  const button = el(id);
  if (!button) return () => {
  };
  const previousText = button.textContent;
  const previousDisabled = button.disabled;
  button.disabled = busy;
  if (busyText) button.textContent = busyText;
  return () => {
    button.disabled = previousDisabled;
    button.textContent = previousText;
  };
}
function persistRouteBook() {
  if (!routeBook) return;
  routeStore.save(routeBook);
  routeStore.flush();
}
async function runExclusive(key, task, { buttonId = "", busyText = "\u5904\u7406\u4E2D\u2026", message = "\u6B63\u5728\u5904\u7406\uFF0C\u8BF7\u7A0D\u5019\u3002" } = {}) {
  if (busyActions.has(key)) {
    if (message) toast(message);
    return null;
  }
  busyActions.add(key);
  const restore = buttonId ? setButtonBusy(buttonId, true, busyText) : () => {
  };
  try {
    return await task();
  } finally {
    restore();
    busyActions.delete(key);
  }
}
window.addEventListener("pagehide", persistRouteBook);
window.addEventListener("beforeunload", persistRouteBook);
function hasReadyRoutePoints(targetRoute = route) {
  return Boolean(targetRoute?.days?.some((day) => getDayPoints(day).map((item) => item.point).filter(isPointReady).length >= 2));
}
function segmentResultsFromCache(targetRoute = route) {
  return (targetRoute?.days || []).map((day, dayIndex) => {
    const cached = targetRoute?.segmentCache?.[dayIndex];
    const expectedSegments = Math.max(0, getDayPoints(day).filter((item) => isPointReady(item.point)).length - 1);
    const signatureMatches = cached?.signature === daySignature(day);
    return cached && Array.isArray(cached.segments) && cached.segments.length >= expectedSegments && signatureMatches ? { segments: cached.segments } : { segments: [] };
  });
}
function hasCompleteRouteSegments(targetRoute = route) {
  return Boolean(targetRoute?.days?.every((day, dayIndex) => {
    const readyPoints = getDayPoints(day).map((item) => item.point).filter(isPointReady);
    if (readyPoints.length < 2) return true;
    const cached = targetRoute.segmentCache?.[dayIndex];
    const expected = readyPoints.length - 1;
    return Boolean(cached && Array.isArray(cached.segments) && cached.segments.length >= expected && cached.segments.every((segment) => !segment?.error) && cached.signature === daySignature(day));
  }));
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
  getState: () => ({ routeBook, route, currentRouteView, segmentResults, currentMapLayer }),
  setState: (patch) => {
    if ("route" in patch) route = patch.route;
    if ("currentRouteView" in patch) currentRouteView = patch.currentRouteView;
    if ("segmentResults" in patch) segmentResults = patch.segmentResults;
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
    return buildVideoData({
      routeData: target,
      segmentData: segmentResultsFromCache(target),
      mapLayer: target.presentation?.mapLayer || currentMapLayer
    });
  },
  onAssetsReady: () => {
    if (accountView === "routes") renderAccountRoutes();
  },
  onImported: () => {
    closeRouteLibrary();
    closeAccountCenter();
  }
});
const refreshArchivedRoutes = archiveController.refresh;
window.loadArchivedRoute = async function(safeName) {
  try {
    await archiveController.load(safeName);
    closeAccountCenter();
  } catch (_) {
  }
};
window.publishArchivedRoute = archiveController.publishRouteById;
window.importPublishedRoute = archiveController.importPublished;
const pointEditor = window.PointEditorController.create({
  el,
  fixed,
  toast,
  scenicController,
  placeSearch,
  getRoute: () => route,
  setView: (view) => {
    currentRouteView = view;
  },
  clearSegments: (dayIndex) => {
    invalidateDay(dayIndex);
  },
  renderAll,
  renderDaySelect,
  refreshPointNames: (dayIndexes) => {
    (dayIndexes || []).forEach((index) => syncDayPointNames(index));
  },
  onNamesChanged: () => {
    saveRoute(false);
  },
  onChanged: () => {
    saveRoute(false);
    return calculateRoute({ background: true, resetLabels: false }).catch((error) => {
      console.warn("\u91CD\u7B97\u8DEF\u7EBF\u5931\u8D25:", error?.message || error);
    });
  },
  requestChangeNote: (defaultNote) => feedback.appPrompt({
    title: "\u4FEE\u6539\u8BF4\u660E",
    defaultValue: defaultNote || "\u4FEE\u6B63\u516C\u5171\u666F\u70B9\u4ECB\u7ECD",
    placeholder: "\u8BF4\u660E\u8FD9\u6B21\u6539\u4E86\u4EC0\u4E48"
  }),
  onSpotSaved: (result, context) => onSpotSaved(result, context)
});
const closePointEditor = () => {
  if (pointEditor.isBusy && pointEditor.isBusy()) {
    el("pointModal")?.classList.remove("closing");
    toast("\u6B63\u5728\u4FDD\u5B58\u666F\u70B9\u4ECB\u7ECD\uFF0C\u8BF7\u7A0D\u5019\u2026");
    return;
  }
  pointEditor.close();
};
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
  el("mapPlaceholder")?.classList.remove("show");
  closeSetupOverlay();
  const mapEl = el("map");
  if (mapEl) {
    mapEl.style.display = "block";
    mapEl.style.height = "100%";
    mapEl.style.width = "100%";
  }
  await routeMap.createMap("map", {
    zoom: 5,
    center: [104.2, 35.8]
  }, (lnglat) => {
    if (!mapPickActive) return;
    const modal = el("customRouteModal");
    if (!modal || !modal.classList.contains("show")) {
      mapPickActive = false;
      const pickBtn = document.querySelector("[data-map-pick-btn]");
      if (pickBtn) pickBtn.classList.remove("active");
      return;
    }
    const input = el("customRouteNames");
    const current = String(input?.value || "").trim();
    const point = `${Number(lnglat.lng).toFixed(6)},${Number(lnglat.lat).toFixed(6)}`;
    if (input) input.value = `${current ? current + "\uFF1B" : ""}${point}`;
    toast(`\u5DF2\u6DFB\u52A0\u9014\u7ECF\u70B9 (${point})\uFF0C\u53EF\u7EE7\u7EED\u70B9\u51FB\u5730\u56FE\u3002`);
  });
  setMapLayer(currentMapLayer);
  el("mapPlaceholder")?.classList.remove("show");
  closeSetupOverlay();
  bindEvents();
  renderAll(false);
  applyCachedSegmentResults(route);
  const readyPoints = hasReadyRoutePoints(route);
  if (readyPoints) {
    try {
      renderAll(true);
      scheduleBackgroundRouteCalculation();
    } catch (error) {
      toast(`\u8DEF\u7EBF\u201C${route.name || ""}\u201D\u5B58\u5728\u65E0\u6CD5\u7ED8\u5236\u7684\u5750\u6807\uFF1A${error.message}`);
    }
  } else {
    renderAll(false);
  }
}
function bindRippleFeedback() {
  document.addEventListener("pointerdown", (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;
    const rect = button.getBoundingClientRect();
    const span = document.createElement("span");
    span.className = "ripple";
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
  if (el("setupSaveBtn")) el("setupSaveBtn").onclick = () => saveAmapConfigFromInputs("setupKeyInput", "setupSecurityInput", "setupStatus");
  if (el("setupTestBtn")) el("setupTestBtn").onclick = () => testAmapConfigFromInputs("setupKeyInput", "setupSecurityInput", "setupStatus");
  el("newRouteBtn").onclick = openNewRouteModal;
  el("calcBtn").onclick = () => calculateRoute();
  el("exportBtn").onclick = openExportConfigModal;
  bindExportConfigControls();
  bindNewRouteModal();
  bindRouteLibraryControls();
  bindAccountControls();
  el("mapLayerSelect").value = currentMapLayer;
  el("mapLayerSelect").onchange = () => setMapLayer(el("mapLayerSelect").value);
  el("mapLayerBtn").onclick = () => {
    const order = ["standard", "satellite", "hybrid"];
    const next = order[(order.indexOf(currentMapLayer) + 1) % order.length];
    el("mapLayerSelect").value = next;
    setMapLayer(next);
  };
  el("hillshadeToggle").onchange = () => updatePresentationFromControls("hillshade");
  el("weatherToggle").onchange = () => updatePresentationFromControls("weather");
  el("elevationToggle").onchange = () => updatePresentationFromControls("elevation");
  el("routeFactsToggle").onchange = () => updatePresentationFromControls("routeFacts");
  el("startDateInput").onchange = () => {
  };
  el("startDateConfirmBtn").onclick = () => updatePresentationFromControls("startDate");
  exportTasks.bind();
  el("spotCloseBtn").onclick = scenicController.closeSpotPanel;
  el("imageLightbox").onclick = scenicController.closeLightbox;
  el("routeSelect").onchange = selectRouteFromDropdown;
  el("routeViewSelect").onchange = () => {
    currentRouteView = el("routeViewSelect").value;
    renderDays();
    renderMarkersAndSegments(true);
  };
  el("daysList").onclick = (event) => {
    const button = event.target.closest("[data-add-day-after]");
    if (!button) return;
    addDayAfter(Number(button.dataset.addDayAfter));
  };
  el("pointSearchBtn").onclick = searchPlace;
  el("pointSearchInput").addEventListener("input", onSearchInput);
  el("pointSearchInput").addEventListener("keydown", onSearchKeydown);
  el("pointScenicImages").onchange = () => scenicController.addSelectedFiles(el("pointScenicImages").files);
  if (el("pointUseScenic")) el("pointUseScenic").onchange = () => pointEditor.onUseScenicChange();
  el("pointConfirmBtn").onclick = confirmPointEdit;
  el("pointCancelBtn").onclick = () => dialogs.close("pointModal");
  el("pointModalClose").onclick = () => dialogs.close("pointModal");
  bindPointTransportControls();
  dialogs.register("pointModal", closePointEditor);
  dialogs.register("newRouteModal", closeNewRouteModal);
  dialogs.register("routeLibraryModal", closeRouteLibrary);
  dialogs.register("setupOverlay", closeSetupOverlay);
  dialogs.bind();
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-wrap")) closeSuggestions();
    scenicController.handleOutsideClick(e.target);
  });
}
const HELP_MD = `# 山河路书 使用帮助

## 快速上手

把一条自驾路线整理成可交付的路书产品。左栏管理行程，右上角「用户中心」管理个人介绍、景点、路线和社区。

## 新建路线

点左上角「新建」，填写路线名称和天数即可创建。天数可以随时在每一天的「+」/「删除」按钮上调整，点路线名称可直接改名。也可以「从公共路线导入」，导入的是独立副本，不影响公共版本。

## 添加与编辑地点

每天有起点和终点，中间可以添加任意多个途径点。点「编辑」可以修改某个地点：

- 在「输入地点」搜索并选中高德匹配项，坐标会自动填入；
- 「地点昵称」可以改成你习惯的称呼（如“老李家的客栈”）；
- 「交通方式」选择车/骑/步，用于计算时间和距离；
- 点「+」在当前点之后插入新地点，拖动地点块可调整顺序（可拖到任意位置插入，含最末尾）。

地点填好后点「刷新」计算全程时间和距离；地图上的标签可以拖动调整位置。

## 选择路线

每一段行程（上一个地点到下一个地点）都有一行「路线」按钮：

- 默认显示高德推荐的最快路线；
- 点「路线」展开该段的所有备选：高德返回的备选、以及开源路网自动规划补全的路线，最多 5 条；
- 自动规划补全只有当与高德推荐差距在 100km / 2 小时以内才显示，且只保留走不同道路的路线；
- 点击某一行的「✓」把它置为第一选择，该段起终点不变时选择会一直保留；
- 路线行上的「✎」可以修改备注，默认备注（最快/最便宜等）由高德或算法自动给出；
- 高德和自动规划都不满意时，点「+ 自定义轨迹」手动画线或输入公路名，只要公路已开通就能显示，封路不影响测距。

## 景点介绍

编辑地点时，「景点介绍」默认勾选。搜索出的地名如果公共库里有介绍，会**自动补全**介绍文字和图片（可预览）；你可以在里面修改，修改会保存到你自己的景点介绍中，只有自己可见，路线优先使用你的介绍。取消勾选表示这个点位不采用景点说明。在「用户中心 → 景点介绍」里可以统一维护你的景点，或编辑公共景点为公共库做贡献。

## 个人介绍

「用户中心 → 个人介绍」可以设置昵称、自我介绍和头像。昵称会显示在社区消息和公共内容贡献者名单里。

## 我的路线

「用户中心 → 我的路线」列出你保存的路线：可以查看、打开、改名、发布或删除。「发布」会把路线放进公共路线库，服务器会**自动生成完整产品**（路线数据、手册、地图、PDF、视频、ZIP），生成期间公聊会有通知。发布后所有人都能导入独立副本。

## 社区论坛

社区论坛分「公聊」和「私聊」。公聊所有旅行者可见：公共路线发布、公共景点发布或编辑时，系统会自动发出通知消息。每条消息都可以「引用」，自己的消息可以「撤回」；管理员可删除不当言论。可以上传图片和文件（单条最多 4 个、单个不超过 20MB）。点消息作者的头像或名字可以查看对方的个人介绍并发起私聊。

## 为公共库做贡献

「用户中心 → 景点介绍 → 公共景点」可以查看所有公共景点，点「编辑」更新内容，保存时需填写修改说明，系统保留历史版本可对比。公共路线数量、景点贡献数会显示在个人介绍里。

## 导出产物

点「导出」把当前路线生成完整产品：路线 JSON、总览 PNG、Markdown 手册、PDF 路书，勾选后还会渲染 MP4 视频，最终打包成 ZIP。导出在后台进行，完成后在你的路线列表里会出现 ZIP/PNG/PDF/MP4 按钮。

## 技术说明

### 多路线来源

- **高德地图**：提供默认推荐路线与备选路线（策略如最快、最便宜）；
- **开源路网（OSRM / OpenStreetMap）**：当高德备选不足 5 条时，自动向开源路网请求最多 3 条本质不同的路线补全，覆盖封路、施工等高德导航不提供的场景；
- **自定义轨迹**：手绘折线或按公路名从 OSM 路网提取路线，仅作为最后手段。

### 路线筛选与去重

自动规划补全的路线必须满足与高德推荐路线的差距（距离不超过高德 100km、时间不超过 2 小时），并且与已有路线重叠度低于 60%，确保是走不同道路的路线，而不是城区内的小幅改道。

### 距离与时间估算

- 高德路线直接采用高德返回的里程与耗时；
- OSRM 路线采用路由引擎按道路限速计算的时长；
- 自定义轨迹按 OSM 道路限速（maxspeed）计算，无限速路段按公路等级速度表估算，直线兜底加 1.25 蜿蜒系数。

### 坐标偏移（加偏）

高德底图使用 GCJ-02（火星坐标），OpenStreetMap / OSRM 路网使用 WGS-84。系统在两类坐标之间自动双向转换，保证开源路网轨迹与高德底图、山影完全对齐。

## 常见问题

- **地图不显示？** 地图由站点管理员统一配置高德 Key，请联系管理员。
- **刷新后路线丢了？** 路线保存在服务器上你的账户下，换个浏览器登录同一账户即可看到。
- **计算不出来路线？** 确认起点和终点都已从地图匹配项选中，个别地点无可用路线时换一个更准确的地点。
- **自动规划不显示？** 只有不超过高德推荐 100km / 2 小时、且道路不同的路线才会补全；个别山区路段开源路网数据不足时会提示暂不可用。
- **导出提示已有任务？** 服务器同一时间只渲染一个任务，可以终止当前任务后重新导出。`;
function inlineFormat(text) {
  return String(text).replace(/\*{2,4}([^*]+)\*{2,4}/g, "<strong>$1</strong>");
}
function renderMarkdown(md) {
  const escaped = String(md || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = escaped.split("\n");
  const out = [];
  let listOpen = false;
  let codeOpen = false;
  const closeList = () => {
    if (listOpen) {
      out.push("</ul>");
      listOpen = false;
    }
  };
  for (let line of lines) {
    if (line.trim().startsWith("```")) {
      closeList();
      if (codeOpen) out.push("</code></pre>");
      else out.push("<pre><code>");
      codeOpen = !codeOpen;
      continue;
    }
    if (codeOpen) {
      out.push(line);
      continue;
    }
    const head = line.match(/^(#{1,6})\s+(.*)$/);
    if (head) {
      closeList();
      const level = Math.min(head[1].length, 4);
      out.push(`<h${level}>${inlineFormat(head[2])}</h${level}>`);
      continue;
    }
    if (line.trim() === "") {
      closeList();
      continue;
    }
    const listItem = line.match(/^[-*]\s+(.*)$/);
    if (listItem) {
      if (!listOpen) {
        out.push("<ul>");
        listOpen = true;
      }
      out.push(`<li>${inlineFormat(listItem[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inlineFormat(line)}</p>`);
  }
  closeList();
  if (codeOpen) out.push("</code></pre>");
  return out.join("\n");
}
function bindAccountControls() {
  communityController.bind();
  if (el("helpDocBody") && !el("helpDocBody").dataset.rendered) {
    el("helpDocBody").innerHTML = renderMarkdown(HELP_MD);
    el("helpDocBody").dataset.rendered = "1";
  }
  if (el("communityHelpBtn")) el("communityHelpBtn").onclick = () => dialogs.open("helpModal");
  if (el("userMenuBtn")) el("userMenuBtn").onclick = openAccountCenter;
  if (el("accountCenterCloseBtn")) el("accountCenterCloseBtn").onclick = closeAccountCenter;
  document.querySelectorAll("[data-account-view]").forEach((button) => {
    button.onclick = () => setAccountView(button.dataset.accountView);
  });
  document.querySelectorAll("[data-route-content]").forEach((button) => {
    button.onclick = () => setAccountRouteMode(button.dataset.routeContent);
  });
  document.querySelectorAll("[data-scene-content]").forEach((button) => {
    button.onclick = () => setAccountSceneMode(button.dataset.sceneContent);
  });
  if (el("pointScenicAddBtn")) {
    el("pointScenicAddBtn").onclick = () => el("pointScenicImages")?.click();
  }
  if (el("pointScenicPreviewBtn")) {
    el("pointScenicPreviewBtn").onclick = () => scenicController.openPreview({
      name: el("pointName").value.trim() || "景点介绍",
      description: el("pointScenicDescription").value
    });
  }
  if (el("spotPreviewCloseBtn")) el("spotPreviewCloseBtn").onclick = () => dialogs.close("spotPreviewModal");
  if (el("accountNewSceneBtn")) el("accountNewSceneBtn").onclick = () => openSceneEditorFromAccount("");
  if (el("adminSaveConfigBtn")) {
    el("adminSaveConfigBtn").onclick = () => saveAmapConfigFromInputs("adminAmapKeyInput", "adminAmapSecurityInput", "adminConfigStatus");
  }
  if (el("adminRefreshBtn")) el("adminRefreshBtn").onclick = refreshAdminDashboard;
  if (el("accountLogoutBtn")) el("accountLogoutBtn").onclick = () => {
    location.href = "/logout";
  };
  if (el("profileLogoutBtn")) el("profileLogoutBtn").onclick = () => {
    location.href = "/logout";
  };
  if (el("sceneDiffCloseBtn")) el("sceneDiffCloseBtn").onclick = () => dialogs.close("sceneDiffModal");
}
function openAccountCenter() {
  const email = runtime.user?.email || "\u672A\u8BC6\u522B\u7528\u6237";
  el("accountCenterEmail").textContent = email;
  el("accountIdentityEmail").textContent = email;
  el("accountIdentityRole").textContent = runtime.isAdmin ? "\u7BA1\u7406\u5458" : "\u7528\u6237";
  if (el("accountAdminNav")) el("accountAdminNav").hidden = !runtime.isAdmin;
  el("accountCenter").classList.add("open");
  setAccountView(accountView);
  refreshAccountCenter();
}
function closeAccountCenter() {
  el("accountCenter").classList.remove("open");
  communityController.stopPolling();
}
function setAccountView(view) {
  accountView = view === "admin" && !runtime.isAdmin ? "profile" : view || "profile";
  document.querySelectorAll("[data-account-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.accountView === accountView);
  });
  document.querySelectorAll(".account-view").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `accountView${accountView[0].toUpperCase()}${accountView.slice(1)}`);
  });
  communityController.activate(accountView);
  refreshAccountCenter();
}
function setAccountRouteMode(mode) {
  accountRouteMode = mode === "public" ? "public" : "mine";
  document.querySelectorAll("[data-route-content]").forEach((button) => {
    button.classList.toggle("active", button.dataset.routeContent === accountRouteMode);
  });
  el("accountRouteMinePane")?.classList.toggle("active", accountRouteMode === "mine");
  el("accountRoutePublicPane")?.classList.toggle("active", accountRouteMode === "public");
  renderAccountRoutes();
}
function setAccountSceneMode(mode) {
  accountSceneMode = mode === "public" ? "public" : "mine";
  document.querySelectorAll("[data-scene-content]").forEach((button) => {
    button.classList.toggle("active", button.dataset.sceneContent === accountSceneMode);
  });
  el("accountSceneMinePane")?.classList.toggle("active", accountSceneMode === "mine");
  el("accountScenePublicPane")?.classList.toggle("active", accountSceneMode === "public");
  renderAccountScenes();
}
async function refreshAccountCenter() {
  if (!el("accountCenter")?.classList.contains("open")) return;
  if (accountView === "routes") {
    const box = el("accountRouteList");
    const publicBox = el("accountPublicRouteList");
    if (box) box.innerHTML = '<div class="hint">\u52A0\u8F7D\u4E2D\u2026</div>';
    if (publicBox) publicBox.innerHTML = '<div class="hint">\u52A0\u8F7D\u4E2D\u2026</div>';
    await refreshArchivedRoutes();
    renderAccountRoutes();
  } else if (accountView === "scenic") {
    const sceneBox = el("accountSceneList");
    const scenePublicBox = el("accountPublicSceneList");
    if (sceneBox) sceneBox.innerHTML = '<div class="hint">加载中…</div>';
    if (scenePublicBox) scenePublicBox.innerHTML = '<div class="hint">加载中…</div>';
    await renderAccountScenes();
  } else if (accountView === "admin") {
    await refreshAdminDashboard();
  }
}
function routeTime(value) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString();
  } catch (_) {
    return "";
  }
}
function routeDayPoints(day) {
  if (Array.isArray(day?.points)) return day.points.filter((point) => point?.name);
  return [day?.from, ...day?.waypoints || [], day?.to].filter((point) => point?.name);
}
function showRoutePreview(routeData, assets = {}) {
  if (!routeData?.days) return toast("\u8FD9\u6761\u8DEF\u7EBF\u6CA1\u6709\u53EF\u9884\u89C8\u7684\u884C\u7A0B\u3002");
  el("routePreviewTitle").textContent = cleanRouteName(routeData.name) || "\u8DEF\u7EBF\u9884\u89C8";
  const descriptionHtml = routeData.description ? `<div class="route-preview-desc">${escapeHtml(routeData.description)}</div>` : "";
  const mediaHtml = [
    descriptionHtml,
    assets.mapImage ? `<div class="route-preview-media"><img src="${escapeAttr(assets.mapImage)}" alt="\u8DEF\u7EBF\u603B\u89C8" /></div>` : "",
    assets.mp4 ? `<div class="route-preview-media"><video src="${escapeAttr(assets.mp4)}" controls preload="metadata"></video></div>` : ""
  ].join("");
  const dayHtml = routeData.days.map((day, dayIndex) => {
    const points = routeDayPoints(day);
    const pointList = points.length ? points.map((point, pointIndex) => `
              <span class="route-preview-point">
                <b>${pointIndex + 1}</b>${escapeHtml(point.name)}
              </span>
            `).join('<span class="route-preview-arrow">\u2192</span>') : '<span class="route-preview-empty">\u5F53\u5929\u8FD8\u6CA1\u6709\u5730\u70B9\u3002</span>';
    return `
          <section class="route-preview-day">
            <div class="route-preview-day-head">
              <strong>D${dayIndex + 1}</strong>
              <span>${escapeHtml(cleanDayTitle(day.title) || `\u7B2C ${dayIndex + 1} \u5929`)}</span>
            </div>
            <div class="route-preview-points">${pointList}</div>
          </section>
        `;
  }).join("");
  el("routePreviewBody").innerHTML = mediaHtml + dayHtml;
  dialogs.open("routePreviewModal");
}
window.accountPreviewRoute = async function(scope, routeId) {
  let routeData = null;
  const assets = {};
  if (scope === "public") {
    const published = archiveController.getPublishedRoutes?.().find((item) => item.id === routeId);
    routeData = published?.routeData;
    assets.mapImage = published?.assetUrls?.mapImage;
    assets.mp4 = published?.assetUrls?.mp4;
  } else {
    const mine = archiveController.getRoutes().find((item) => item.routeData?.id === routeId || item.safeName === routeId || item.id === routeId);
    routeData = mine?.routeData || routeBook.routes.find((item) => item.id === routeId || item.name === routeId);
    const version = encodeURIComponent(mine?.updatedAt || mine?.archivedAt || Date.now());
    const base = localService.routeAssetBase(mine);
    assets.mapImage = mine?.assetUrls?.mapImage || (mine?.mapImage ? `${base}.route-map.png?v=${version}` : "");
    assets.mp4 = mine?.assetUrls?.mp4 || (mine?.mp4 ? `${base}.mp4?v=${version}` : "");
    if (!routeData && mine) {

      routeData = await archiveController.getRouteData(mine).catch(() => null);
    }
  }
  showRoutePreview(routeData, assets);
};
function renderAccountRoutes() {
  const box = el("accountRouteList");
  const publicBox = el("accountPublicRouteList");
  if (!box || !publicBox) return;
  const archivedRoutes = archiveController.getRoutes() || [];
  const publishedRoutes = archiveController.getPublishedRoutes() || [];
  el("accountRouteCount").textContent = String(archivedRoutes.length);
  box.innerHTML = archivedRoutes.length ? archivedRoutes.map((item, index) => archiveController.renderMyRouteItem(item, { editable: true, index })).join("") : '<div class="account-empty">\u8FD8\u6CA1\u6709\u8DEF\u7EBF\u3002</div>';
  publicBox.innerHTML = publishedRoutes.length ? publishedRoutes.map((item, index) => archiveController.renderPublishedRouteItem(item, index)).join("") : '<div class="account-empty">\u516C\u5171\u8DEF\u7EBF\u5E93\u6682\u65F6\u4E3A\u7A7A\u3002</div>';
}
async function renderAccountScenes() {
  const mineBox = el("accountSceneList");
  const publicBox = el("accountPublicSceneList");
  if (!mineBox || !publicBox) return;
  const loadingHtml = '<div class="account-empty">加载中…</div>';
  if (!mineBox.childElementCount) mineBox.innerHTML = loadingHtml;
  if (!publicBox.childElementCount) publicBox.innerHTML = loadingHtml;
  try {
    const [mineResult, publicResult] = await Promise.all([
      localService.listUserScenes(),
      localService.listScenes()
    ]);
    if (!mineResult.response.ok || !mineResult.data?.ok) throw new Error(mineResult.data?.message || "\u65E0\u6CD5\u8BFB\u53D6\u6211\u7684\u666F\u70B9\u4ECB\u7ECD");
    if (!publicResult.response.ok || !publicResult.data?.ok) throw new Error(publicResult.data?.message || "\u65E0\u6CD5\u8BFB\u53D6\u516C\u5171\u666F\u70B9\u4ECB\u7ECD");
    accountUserScenes = mineResult.data.scenes || [];
    accountPublicScenes = publicResult.data.scenes || [];
    el("accountSceneCount").textContent = String(accountUserScenes.length);
    mineBox.innerHTML = accountUserScenes.length ? accountUserScenes.map((item) => `
          <div class="account-item admin-content-item">
            <div class="account-item-main">
              <strong>${escapeHtml(item.title || item.name || "\u672A\u547D\u540D\u666F\u70B9")}</strong>
              <span>${item.sourceVersion ? `\u6E90\u81EA\u516C\u5171 v${escapeHtml(item.sourceVersion)} \xB7 ` : ""}\u56FE\u7247 ${escapeHtml(item.imageCount || 0)}</span>
            </div>
            <span class="account-item-time">${escapeHtml(routeTime(item.updatedAt))}</span>
            <div class="account-item-actions">
              <button class="small primary" onclick="accountPreviewUserScene('${escapeJsAttr(item.id)}')">\u67E5\u770B</button>
              <button class="small" onclick="accountEditUserScene('${escapeJsAttr(item.id)}')">\u7F16\u8F91</button>
              <button class="small danger" title="\u5220\u9664" onclick="accountDeleteUserScene('${escapeJsAttr(item.id)}')">\u2715</button>
            </div>
          </div>
        `).join("") : '<div class="account-empty">\u8FD8\u6CA1\u6709\u4E2A\u4EBA\u666F\u70B9\u4ECB\u7ECD\u3002</div>';
    publicBox.innerHTML = accountPublicScenes.length ? accountPublicScenes.map((item) => `
          <div class="account-item admin-content-item">
            <div class="account-item-main">
              <strong>${escapeHtml(item.title || item.name || "\u672A\u547D\u540D\u666F\u70B9")}</strong>
              <span>v${escapeHtml(item.version || 1)} \xB7 ${item.contributor?.email ? `<button class="contributor-link" type="button" onclick="accountOpenProfile('${escapeJsAttr(item.contributor.email)}')">${escapeHtml(item.contributor.nickname || "\u672A\u77E5\u7528\u6237")}</button>` : "\u672A\u77E5\u7528\u6237"}</span>
            </div>
              <span class="account-item-time">${escapeHtml(routeTime(item.updatedAt))}</span>
            <div class="account-item-actions">
              <button class="small primary" onclick="showSpotInfo('${escapeJsAttr(item.name || item.title)}')">\u67E5\u770B</button>
              <button class="small" onclick="accountEditPublicScene('${escapeJsAttr(item.name || item.title)}')">\u7F16\u8F91</button>
              <button class="small" onclick="accountImportScene('${escapeJsAttr(item.name || item.title)}')">\u5BFC\u5165</button>
              <button class="small" onclick="accountShowSceneDiff('${escapeJsAttr(item.name || item.title)}')">\u7248\u672C</button>
              ${runtime.isAdmin ? `<button class="small danger" title="\u5220\u9664" onclick="accountDeleteScene('${escapeJsAttr(item.name || item.title)}')">\u2715</button>` : ''}
            </div>
          </div>
        `).join("") : '<div class="account-empty">\u516C\u5171\u666F\u70B9\u5E93\u6682\u65F6\u4E3A\u7A7A\u3002</div>';
  } catch (error) {
    mineBox.innerHTML = `<div class="account-empty">\u8BFB\u53D6\u666F\u70B9\u4ECB\u7ECD\u5931\u8D25\uFF1A${escapeHtml(error.message)}</div>`;
    publicBox.innerHTML = mineBox.innerHTML;
  }
}
function openSceneEditorFromAccount(sceneId) {
  const scene = sceneId ? accountUserScenes.find((item) => item.id === sceneId) : null;
  if (sceneId && !scene) return toast("未找到这份景点介绍。");
  setAccountSceneMode("mine");
  pointEditor.openSpot({
    sceneId: scene?.id || "",

    name: scene?.title || scene?.name || "",
    originalName: scene?.name || scene?.title || "",
    description: scene?.description || "",
    images: scene?.images || [],
    sceneMode: "private"
  });
  if (el("accountSceneStatus")) {
    el("accountSceneStatus").textContent = scene ? `正在编辑：${scene.title || scene.name || ""}` : "";
  }
}
async function openPublicSceneEditorFromAccount(name) {
  const { response, data } = await localService.getScenic(name, { force: true });
  if (!response.ok || !data?.ok || !data.spot) {
    toast("未找到这个公共景点。");
    return;
  }
  const spot = data.spot;
  setAccountSceneMode("mine");
  pointEditor.openSpot({
    name: spot.title || spot.name || name,
    originalName: spot.name || spot.title || name,
    description: spot.description || "",
    images: spot.images || [],
    sceneMode: "public"
  });
  if (el("accountSceneStatus")) {
    el("accountSceneStatus").textContent = `正在编辑公共景点：${spot.title || spot.name || name}`;
  }
}
async function onSpotSaved(result, context) {
  const label = result?.spot?.title || result?.spot?.name || context?.originalName || "";
  const isPublic = context?.sceneMode === "public";
  if (el("accountSceneStatus")) {
    el("accountSceneStatus").textContent = isPublic
      ? `已更新 v${result?.version || result?.spot?.version || ""}`
      : (label ? `已保存：${label}` : "");
  }
  await renderAccountScenes();
  toast(isPublic
    ? (result?.unchanged ? "内容没有变化。" : `已更新 v${result?.version}`)
    : "已保存");
}
async function refreshAdminDashboard() {
  if (!runtime.isAdmin) return;
  const usersBox = el("adminUserList");
  const routesBox = el("adminPublishedRouteList");
  const scenesBox = el("adminPublishedSceneList");
  try {
    const config = await loadConfigFromServer();
    if (config?.configured) {
      el("adminAmapKeyInput").value = config.key || "";
      el("adminAmapSecurityInput").value = config.securityJsCode || "";
      el("adminConfigStatus").textContent = "\u5730\u56FE Key \u5DF2\u914D\u7F6E\u3002";
    }
    const { response, data } = await localService.adminSummary();
    if (!response.ok || !data?.ok) throw new Error(data?.message || "\u65E0\u6CD5\u8BFB\u53D6\u7BA1\u7406\u6570\u636E");
    usersBox.innerHTML = (data.users || []).length ? data.users.map((item) => `
            <div class="account-item">
              <div class="account-item-main"><strong>${escapeHtml(item.email)}</strong><span>\u8DEF\u7EBF ${escapeHtml(item.routeCount || 0)} \xB7 \u666F\u70B9 ${escapeHtml(item.sceneCount || 0)}</span></div>
              <span class="account-item-time">${escapeHtml(routeTime(item.lastRouteAt || item.lastSceneAt))}</span>
            </div>
          `).join("") : '<div class="account-empty">\u8FD8\u6CA1\u6709\u7528\u6237\u8DEF\u7EBF\u6570\u636E\u3002</div>';
    const routes = (data.publishedRoutes || []).map((item) => `
          <div class="account-item admin-content-item">
            <div class="account-item-main"><strong>\u8DEF\u7EBF\uFF1A${escapeHtml(item.name)}</strong><span>${item.contributor?.email ? `<button class="contributor-link" type="button" onclick="accountOpenProfile('${escapeJsAttr(item.contributor.email)}')">${escapeHtml(item.contributor.nickname || "\u672A\u77E5\u7528\u6237")}</button>` : "\u672A\u77E5\u7528\u6237"}</span></div>
            <div class="account-item-actions"><button class="small danger" title="\u5220\u9664" onclick="accountDeletePublished('${escapeJsAttr(item.id)}')">\u2715</button></div>
          </div>
        `).join("");
    const scenes = (data.scenes || []).map((item) => `
          <div class="account-item admin-content-item">
            <div class="account-item-main"><strong>\u666F\u70B9\uFF1A${escapeHtml(item.title || item.name)}</strong><span>${item.contributor?.email ? `<button class="contributor-link" type="button" onclick="accountOpenProfile('${escapeJsAttr(item.contributor.email)}')">${escapeHtml(item.contributor.nickname || "\u672A\u77E5\u7528\u6237")}</button>` : "\u672A\u77E5\u7528\u6237"}</span></div>
            <div class="account-item-actions">
              <button class="small" onclick="accountEditPublicScene('${escapeJsAttr(item.name || item.title)}')">\u7F16\u8F91</button>
              <button class="small" onclick="accountShowSceneDiff('${escapeJsAttr(item.name || item.title)}')">\u7248\u672C</button>
              <button class="small danger" title="\u5220\u9664" onclick="accountDeleteScene('${escapeJsAttr(item.name || item.title)}')">\u2715</button>
            </div>
          </div>
        `).join("");
    routesBox.innerHTML = routes || '<div class="account-empty">\u8FD8\u6CA1\u6709\u516C\u5171\u8DEF\u7EBF\u3002</div>';
    scenesBox.innerHTML = scenes || '<div class="account-empty">\u8FD8\u6CA1\u6709\u516C\u5171\u666F\u70B9\u3002</div>';
  } catch (error) {
    if (usersBox) usersBox.innerHTML = `<div class="account-empty">\u8BFB\u53D6\u7BA1\u7406\u6570\u636E\u5931\u8D25\uFF1A${escapeHtml(error.message)}</div>`;
  }
}
function bindRouteLibraryControls() {
  if (el("routeLibraryCloseBtn")) el("routeLibraryCloseBtn").onclick = () => dialogs.close("routeLibraryModal");
  if (el("publishCurrentRouteBtn")) el("publishCurrentRouteBtn").onclick = archiveController.publishCurrent;
  if (el("refreshRouteLibraryBtn")) el("refreshRouteLibraryBtn").onclick = () => refreshArchivedRoutes({ force: true });
  if (el("publishCurrentRouteBtn")) el("publishCurrentRouteBtn").hidden = !localService.capabilities?.publishedRoutes;
}
function bindPointTransportControls() {
  document.querySelectorAll("[data-point-transport]").forEach((button) => {
    button.onclick = () => pointEditor.setTransportMode(button.dataset.pointTransport);
  });
}
function openDialog(id) {
  const dialog = el(id);
  if (!dialog) return;
  dialog.classList.remove("closing");
  dialog.classList.add("open");
}
function openRouteLibrary() {
  openDialog("routeLibraryModal");
  refreshArchivedRoutes();
}
function closeRouteLibrary() {
  el("routeLibraryModal")?.classList.remove("open");
}
function openNewRouteModal() {
  if (el("newRouteNameInput")) el("newRouteNameInput").value = "";
  if (el("newRouteDescInput")) el("newRouteDescInput").value = "";
  if (el("newRouteDayCountInput")) el("newRouteDayCountInput").value = "1";
  openDialog("newRouteModal");
  setTimeout(() => el("newRouteNameInput")?.focus(), 50);
}
function closeNewRouteModal() {
  el("newRouteModal")?.classList.remove("open");
}
function bindNewRouteModal() {
  if (el("newRouteCloseBtn")) el("newRouteCloseBtn").onclick = () => dialogs.close("newRouteModal");
  if (el("newRouteCancelBtn")) el("newRouteCancelBtn").onclick = () => dialogs.close("newRouteModal");
  if (el("newRouteImportBtn")) {
    el("newRouteImportBtn").onclick = () => {
      closeNewRouteModal();
      openRouteLibrary();
    };
  }
  if (el("newRouteConfirmBtn")) el("newRouteConfirmBtn").onclick = createRouteFromModal;
  el("newRouteNameInput")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") createRouteFromModal();
  });
  el("newRouteDayCountInput")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") createRouteFromModal();
  });
}
function selectRouteFromDropdown() {
  const value = el("routeSelect").value;
  if (value === "__new_route__") {
    openNewRouteModal();
    renderRouteSelect();
    return;
  }
  if (value === "__public_routes__") {
    openRouteLibrary();
    renderRouteSelect();
    return;
  }
  if (value.startsWith("archive:")) return loadArchivedRoute(value.slice(8));
  routeBook.activeRouteId = value;
  route = routeStore.getActive(routeBook);
  currentRouteView = "all";
  applyCachedSegmentResults(route);
  renderAll(true);
  scheduleBackgroundRouteCalculation();
}
async function loadRouteFromAccount(routeId) {
  const localRoute = routeBook.routes.find((item) => item.id === routeId);
  if (!localRoute) return archiveController.load(routeId);
  routeBook.activeRouteId = localRoute.id;
  route = routeStore.getActive(routeBook);
  currentRouteView = "all";
  applyCachedSegmentResults(route);
  renderAll(true);
  scheduleBackgroundRouteCalculation();
}
function setMapLayer(layer) {
  currentMapLayer = layer || "standard";
  localStorage.setItem("amap-planner-map-layer", currentMapLayer);
  if (route) {
    route.presentation = window.MapPresentation.normalize({ ...route.presentation, mapLayer: currentMapLayer });
    persistPresentationPreference();
    saveRoute(false);
  }
  routeMap.setLayer(currentMapLayer);
}
function persistPresentationPreference() {
  if (!route?.presentation) return;
  localStorage.setItem("roadtrip-map-presentation", JSON.stringify(route.presentation));
}
function presentationDefaults() {
  try {
    return window.MapPresentation.normalize(JSON.parse(localStorage.getItem("roadtrip-map-presentation") || "null"));
  } catch (_) {
    return window.MapPresentation.normalize(null);
  }
}
function syncPresentationControls() {
  if (!route) {
    ["hillshadeToggle", "weatherToggle", "elevationToggle", "routeFactsToggle"].forEach((id) => {
      el(id).checked = false;
      el(id).disabled = true;
    });
    el("startDateControl").hidden = true;
    el("weatherRangeHint").hidden = true;
    routeMap.setHillshade(false);
    return;
  }
  route.presentation = window.MapPresentation.normalize(route.presentation || presentationDefaults());
  currentMapLayer = route.presentation.mapLayer;
  el("mapLayerSelect").value = currentMapLayer;
  el("hillshadeToggle").disabled = false;
  el("elevationToggle").disabled = false;
  el("routeFactsToggle").disabled = false;
  el("hillshadeToggle").checked = route.presentation.hillshade;
  el("elevationToggle").checked = route.presentation.elevation;
  el("routeFactsToggle").checked = route.presentation.routeFacts;
  const bounds = window.MapPresentation.dateBounds(route.days.length);
  if (route.presentation.weather && bounds.enabled && (!route.presentation.startDate || route.presentation.startDate < bounds.min || route.presentation.startDate > bounds.max)) {
    route.presentation.startDate = bounds.min;
  }
  el("weatherToggle").disabled = !bounds.enabled;
  el("startDateInput").min = bounds.min;
  el("startDateInput").max = bounds.max || bounds.min;
  el("startDateInput").value = route.presentation.startDate || bounds.min;
  el("weatherRangeHint").hidden = bounds.enabled;
  el("weatherRangeHint").textContent = bounds.enabled ? "" : "\u5F53\u524D\u8DEF\u7EBF\u8D85\u8FC7\u5929\u6C14\u9884\u62A5\u53EF\u8986\u76D6\u8303\u56F4\u3002";
  if (!bounds.enabled && route.presentation.weather) route.presentation.weather = false;
  el("weatherToggle").checked = route.presentation.weather;
  el("startDateControl").hidden = !route.presentation.weather;
  routeMap.setLayer(currentMapLayer);
  routeMap.setHillshade(route.presentation.hillshade);
}
function updatePresentationFromControls(source) {
  if (!route) return;
  const bounds = window.MapPresentation.dateBounds(route.days.length);
  const startDate = el("startDateInput").value || bounds.min;
  route.presentation = window.MapPresentation.normalize({
    ...route.presentation,
    mapLayer: currentMapLayer,
    hillshade: el("hillshadeToggle").checked,
    weather: bounds.enabled && el("weatherToggle").checked,
    elevation: el("elevationToggle").checked,
    routeFacts: el("routeFactsToggle").checked,
    startDate
  });
  syncPresentationControls();
  persistPresentationPreference();
  saveRoute(false);
  renderMarkersAndSegments(false);
  if (source === "hillshade" || source === "routeFacts") return;
  if (source === "startDate") {
    if (pointInfo.needsRefresh(route)) {
      setStartDateConfirmBusy(true);
      pointInfo.refresh(route).finally(() => setStartDateConfirmBusy(false));
    }
  } else {
    pointInfo.schedule(route, true);
  }
}
function setStartDateConfirmBusy(busy) {
  const button = el("startDateConfirmBtn");
  if (!button) return;
  button.disabled = busy;
  button.textContent = busy ? "\u8BA1\u7B97\u4E2D" : "\u2713";
}
function hasAmapConfig() {
  return Boolean((window.AMAP_PLANNER_CONFIG?.key || "").trim() && (window.AMAP_PLANNER_CONFIG?.securityJsCode || "").trim());
}
function openSetupOverlay(message) {
  if (localService.capabilities?.editableMapConfig === false && !runtime.isAdmin) {
    showMapLoadFailure(message || "\u8BF7\u8054\u7CFB\u7BA1\u7406\u5458\u68C0\u67E5\u5730\u56FE\u914D\u7F6E\u3002");
    return;
  }
  el("setupKeyInput").value = window.AMAP_PLANNER_CONFIG?.key || "";
  el("setupSecurityInput").value = window.AMAP_PLANNER_CONFIG?.securityJsCode || "";
  const cloudManaged = localService.capabilities?.editableMapConfig === false;
  const setupTitle = document.querySelector("#setupOverlay h2");
  const setupIntro = document.querySelector("#setupOverlay header p");
  if (setupTitle) setupTitle.textContent = cloudManaged ? "\u5730\u56FE\u670D\u52A1\u672A\u5C31\u7EEA" : "\u914D\u7F6E\u9AD8\u5FB7\u5730\u56FE";
  if (setupIntro) setupIntro.textContent = cloudManaged ? "\u7F51\u7AD9\u5730\u56FE\u7531\u7BA1\u7406\u5458\u7EDF\u4E00\u914D\u7F6E\uFF0C\u666E\u901A\u7528\u6237\u65E0\u9700\u586B\u5199 Key\u3002" : "\u586B\u5199\u9AD8\u5FB7 Web JS API Key \u548C\u5B89\u5168\u5BC6\u94A5\u540E\u52A0\u8F7D\u5730\u56FE\u3002";
  el("setupOverlay").classList.toggle("cloud-managed", cloudManaged);
  el("setupKeyInput").disabled = cloudManaged;
  el("setupSecurityInput").disabled = cloudManaged;
  el("setupSaveBtn").hidden = cloudManaged;
  el("setupTestBtn").hidden = cloudManaged;
  el("setupStatus").textContent = message || (cloudManaged ? "\u5730\u56FE\u914D\u7F6E\u7531\u7AD9\u70B9\u7BA1\u7406\u5458\u7EDF\u4E00\u7EF4\u62A4\u3002" : localService.capabilities?.mode === "cloud" ? "\u914D\u7F6E\u4F1A\u5199\u5165\u7AD9\u70B9\u8BBE\u7F6E\uFF0C\u4FDD\u5B58\u540E\u6240\u6709\u7528\u6237\u5237\u65B0\u5373\u53EF\u4F7F\u7528\u3002" : "\u914D\u7F6E\u4F1A\u5199\u5165\u6D4F\u89C8\u5668\uFF0C\u5E76\u540C\u6B65\u5230 config/local.env\u3002");
  openDialog("setupOverlay");
  el("mapPlaceholder")?.classList.add("show");
}
function closeSetupOverlay() {
  el("setupOverlay").classList.remove("open");
}
function showMapLoadFailure(message) {
  closeSetupOverlay();
  const placeholder = el("mapPlaceholder");
  if (!placeholder) return;
  placeholder.classList.add("show");
  placeholder.innerHTML = `
        <strong>\u5730\u56FE\u52A0\u8F7D\u5931\u8D25</strong>
        <p>${escapeHtml(message || "\u8BF7\u68C0\u67E5\u7F51\u7EDC\u540E\u5237\u65B0\u9875\u9762\u3002")}</p>
        ${runtime.isAdmin ? '<button class="primary" id="mapFailureConfigBtn" type="button">\u914D\u7F6E\u9AD8\u5FB7 Key</button>' : ""}
      `;
  const configButton = el("mapFailureConfigBtn");
  if (configButton) configButton.onclick = () => openSetupOverlay("\u8BF7\u68C0\u67E5 Key\u3001\u5B89\u5168\u5BC6\u94A5\u548C\u57DF\u540D\u767D\u540D\u5355\u3002");
}
async function saveAmapConfigFromInputs(keyId, securityId, statusId) {
  if (localService.capabilities?.editableMapConfig === false) {
    return toast("\u7F51\u7AD9\u5730\u56FE\u914D\u7F6E\u7531\u7BA1\u7406\u5458\u7EDF\u4E00\u7EF4\u62A4\u3002");
  }
  const key = el(keyId).value.trim();
  const securityJsCode = el(securityId).value.trim();
  if (!key || !securityJsCode) {
    if (statusId) el(statusId).textContent = "\u8BF7\u586B\u5199 Key \u548C\u5B89\u5168\u5BC6\u94A5\u3002";
    return toast("\u8BF7\u586B\u5199 Key \u548C\u5B89\u5168\u5BC6\u94A5\u3002");
  }
  localStorage.setItem("amap-planner-config", JSON.stringify({ key, securityJsCode }));
  window.AMAP_PLANNER_CONFIG = { key, securityJsCode };
  window._AMapSecurityConfig = { securityJsCode };
  if (statusId) el(statusId).textContent = "\u5DF2\u4FDD\u5B58\uFF0C\u6B63\u5728\u540C\u6B65\u5E76\u52A0\u8F7D\u5730\u56FE\u2026";
  try {
    const { response, data } = await localService.saveConfig({ key, securityJsCode });
    if (!response.ok || !data?.ok) throw new Error(data?.message || "\u4FDD\u5B58\u5931\u8D25");
  } catch (error) {
    if (statusId) el(statusId).textContent = "\u4FDD\u5B58\u5931\u8D25\uFF1A" + error.message;
    return toast("\u4FDD\u5B58\u5730\u56FE\u914D\u7F6E\u5931\u8D25\uFF1A" + error.message);
  }
  toast("\u914D\u7F6E\u5DF2\u4FDD\u5B58\uFF0C\u6B63\u5728\u5237\u65B0\u2026");
  if (location.protocol === "file:") {
    location.href = "http://127.0.0.1:6137/";
    return;
  }
  location.reload();
}
function testAmapConfigFromInputs(keyId, securityId, statusId) {
  const statusEl = statusId ? el(statusId) : null;
  const key = el(keyId).value.trim();
  const securityJsCode = el(securityId).value.trim();
  if (!key || !securityJsCode) {
    if (statusEl) statusEl.textContent = "\u8BF7\u5148\u586B\u5199 Key \u548C\u5B89\u5168\u5BC6\u94A5\u3002";
    return;
  }
  if (statusEl) statusEl.textContent = "\u6B63\u5728\u6D4B\u8BD5 Key\u2026";
  if (!routeMap.isReady() || window.AMAP_PLANNER_CONFIG?.key !== key) {
    if (statusEl) statusEl.textContent = "\u8BF7\u5148\u70B9\u201C\u4FDD\u5B58\u5E76\u52A0\u8F7D\u5730\u56FE\u201D\uFF0C\u52A0\u8F7D\u6210\u529F\u540E\u518D\u6D4B\u8BD5\u641C\u7D22\u3002\u4E5F\u53EF\u76F4\u63A5\u4FDD\u5B58\u3002";
    return;
  }
  routeMap.testSearch("\u5929\u5B89\u95E8").then((ok) => {
    if (statusEl) {
      statusEl.textContent = ok ? "\u8FDE\u63A5\u6210\u529F\uFF1A\u53EF\u4EE5\u641C\u7D22\u5730\u70B9\u548C\u83B7\u53D6\u5750\u6807\u3002" : "\u8FDE\u63A5\u5931\u8D25\uFF1A\u9AD8\u5FB7\u6CA1\u6709\u8FD4\u56DE POI\uFF0C\u8BF7\u68C0\u67E5 Key\u3001\u670D\u52A1\u6743\u9650\u548C\u5B89\u5168\u5BC6\u94A5\u3002";
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
      if (showToast) toast("\u6B63\u5728\u4FDD\u5B58\u8DEF\u7EBF\u2026");
      const snapshot = getEditableRoute(route);
      cloudSaveTimer = setTimeout(async () => {
        cloudSaveTimer = null;
        const { response, data } = await localService.saveRoute(snapshot, currentMapLayer);
        if (!response.ok || !data?.ok) {
          toast("\u4E91\u7AEF\u4FDD\u5B58\u5931\u8D25\uFF1A" + (data?.message || "\u8BF7\u68C0\u67E5\u7F51\u7EDC"));
          return;
        }
        if (showToast) toast("\u8DEF\u7EBF\u5DF2\u4FDD\u5B58\u5230\u4E91\u7AEF\u3002");
      }, 280);
    } else if (showToast) {
      toast(runtime.mode === "preview" ? "\u5DF2\u4FDD\u5B58\u4E3A\u5F53\u524D\u6D4F\u89C8\u5668\u8349\u7A3F\u3002" : "\u5DF2\u4FDD\u5B58\u5230\u6D4F\u89C8\u5668\uFF0C\u5BFC\u51FA\u540E\u5199\u5165 data/routes/\u3002");
    }
  } catch (err) {
    toast("\u4FDD\u5B58\u5931\u8D25\uFF1A" + err.message);
  }
}
let labelOffsetSaveTimer = null;

function scheduleLabelOffsetSave() {
  if (labelOffsetSaveTimer) clearTimeout(labelOffsetSaveTimer);
  labelOffsetSaveTimer = setTimeout(() => {
    labelOffsetSaveTimer = null;
    if (!route || !localService.capabilities?.cloudRoutes) return;
    saveRouteNow(route).then(({response, data}) => {
      if (!response.ok || !data?.ok) toast("\u6587\u5B57\u4F4D\u7F6E\u4FDD\u5B58\u5931\u8D25\uFF1A" + (data?.message || "\u8BF7\u7A0D\u540E\u91CD\u8BD5"));
    }).catch((error) => {
      toast("\u6587\u5B57\u4F4D\u7F6E\u4FDD\u5B58\u5931\u8D25\uFF1A" + error.message);
    });
  }, 700);
}
async function saveRouteNow(targetRoute = route) {
  if (cloudSaveTimer) {
    clearTimeout(cloudSaveTimer);
    cloudSaveTimer = null;
  }
  routeStore.save(routeBook);
  if (!localService.capabilities?.cloudRoutes) {
    return { response: { ok: true, status: 200 }, data: { ok: true } };
  }
  return localService.saveRoute(getEditableRoute(targetRoute), currentMapLayer);
}
async function createRouteFromAccount({ name, dayCount, description }) {
  const cleanName = cleanRouteName(name) || "\u672A\u547D\u540D\u8DEF\u7EBF";
  const next = normalizeRoute({ ...createBlankRoute(cleanName, dayCount), description: window.RouteModel.cleanRouteDescription(description), presentation: presentationDefaults() });
  const previousRoute = route;
  const previousActiveId = routeBook.activeRouteId;
  routeBook.routes.push(next);
  routeBook.activeRouteId = next.id;
  route = next;
  currentRouteView = "all";
  segmentResults = [];
  renderAll(false);
  try {
    const { response, data } = await saveRouteNow(next);
    if (!response.ok || !data?.ok) throw new Error(data?.message || "\u4FDD\u5B58\u5931\u8D25");
    toast(localService.capabilities?.cloudRoutes ? "\u5DF2\u65B0\u5EFA\u8DEF\u7EBF\u5E76\u540C\u6B65\u5230\u4F60\u7684\u8D26\u6237\u3002" : "\u5DF2\u65B0\u5EFA\u7A7A\u767D\u8DEF\u7EBF\u3002");
    return true;
  } catch (error) {
    routeBook.routes = routeBook.routes.filter((item) => item.id !== next.id);
    routeBook.activeRouteId = previousActiveId;
    route = previousRoute;
    renderAll(false);
    toast("\u65B0\u5EFA\u8DEF\u7EBF\u5931\u8D25\uFF1A" + error.message);
    return false;
  }
}
async function createRouteFromModal() {
  if (busyActions.has("create-route")) return toast("\u6B63\u5728\u65B0\u5EFA\u8DEF\u7EBF\uFF0C\u8BF7\u7A0D\u5019\u3002");
  const name = el("newRouteNameInput")?.value || "\u672A\u547D\u540D\u8DEF\u7EBF";
  const description = el("newRouteDescInput")?.value || "";
  const daysText = el("newRouteDayCountInput")?.value || "1";
  const dayCount = Math.max(1, Math.min(30, Number(daysText || 1)));
  await runExclusive("create-route", () => createRouteFromAccount({ name, dayCount, description }), {
    buttonId: "newRouteConfirmBtn",
    busyText: "\u521B\u5EFA\u4E2D\u2026",
    message: "\u6B63\u5728\u65B0\u5EFA\u8DEF\u7EBF\uFF0C\u8BF7\u7A0D\u5019\u3002"
  }).then((created) => {
    if (created) closeNewRouteModal();
  });
}
async function renameRouteById(routeId, name) {
  const target = routeBook.routes.find((item) => item.id === routeId);
  if (!target) return false;
  const nextName = cleanRouteName(name);
  if (!nextName) return toast("\u8DEF\u7EBF\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A\u3002"), false;
  const previousName = target.name;
  target.name = nextName;
  if (route?.id === routeId) route.name = nextName;
  try {
    const { response, data } = await saveRouteNow(target);
    if (!response.ok || !data?.ok) throw new Error(data?.message || "\u4FDD\u5B58\u5931\u8D25");
    renderRouteSelect();
    toast("\u8DEF\u7EBF\u540D\u79F0\u5DF2\u66F4\u65B0\u3002");
    return true;
  } catch (error) {
    target.name = previousName;
    if (route?.id === routeId) route.name = previousName;
    renderRouteSelect();
    toast("\u4FEE\u6539\u8DEF\u7EBF\u540D\u79F0\u5931\u8D25\uFF1A" + error.message);
    return false;
  }
}
async function updateRouteDescription(routeId, description) {
  const target = routeBook.routes.find((item) => item.id === routeId);
  if (!target) return false;
  const nextDescription = window.RouteModel.cleanRouteDescription(description);
  const previousDescription = target.description;
  target.description = nextDescription;
  if (route?.id === routeId) route.description = nextDescription;
  try {
    const { response, data } = await saveRouteNow(target);
    if (!response.ok || !data?.ok) throw new Error(data?.message || "\u4FDD\u5B58\u5931\u8D25");
    toast("\u8DEF\u7EBF\u4ECB\u7ECD\u5DF2\u66F4\u65B0\u3002");
    return true;
  } catch (error) {
    target.description = previousDescription;
    if (route?.id === routeId) route.description = previousDescription;
    toast("\u4FEE\u6539\u8DEF\u7EBF\u4ECB\u7ECD\u5931\u8D25\uFF1A" + error.message);
    return false;
  }
}
async function deleteRouteById(routeId) {
  const index = routeBook.routes.findIndex((item) => item.id === routeId);
  if (index < 0) return false;
  const removed = routeBook.routes[index];
  if (localService.capabilities?.cloudRoutes) {
    const { response, data } = await localService.deleteRoute(routeId);
    if (!response.ok || !data?.ok) {
      toast("\u4E91\u7AEF\u5220\u9664\u5931\u8D25\uFF1A" + (data?.message || "\u8BF7\u91CD\u8BD5"));
      return false;
    }
  }
  routeBook.routes.splice(index, 1);
  if (route?.id === routeId) {
    routeBook.activeRouteId = routeBook.routes[0]?.id || "";
    route = routeStore.getActive(routeBook) || null;
    currentRouteView = "all";
    segmentResults = [];
    routeStore.save(routeBook);
    renderAll(true);
  } else {
    routeStore.save(routeBook);
    renderRouteSelect();
  }
  toast(`\u5DF2\u5220\u9664\u8DEF\u7EBF\u201C${removed.name || "\u672A\u547D\u540D\u8DEF\u7EBF"}\u201D\u3002`);
  return true;
}
function getEditableRoute(input) {
  const source = input || route;
  if (!source) return null;
  const next = structuredClone(source);
  return {
    id: next.id,
    name: next.name,
    description: next.description,
    segmentCache: next.segmentCache || {},
    presentation: next.presentation,
    pointInfoCache: next.pointInfoCache,
    labelOffsets: next.labelOffsets || {},
    days: (next.days || []).map((day) => ({
      title: cleanDayTitle(day.title),
      from: day.from,
      waypoints: day.waypoints,
      to: day.to
    }))
  };
}
function renderAll(fit = false) {
  if (!route) route = routeStore.getActive(routeBook) || null;
  if (route) {
    if (!route.presentation) route.presentation = presentationDefaults();
  }
  syncPresentationControls();
  renderRouteSelect();
  renderDaySelect();
  renderDays();
  renderMarkersAndSegments(fit);
  pointInfo.schedule(route, false);
  if (window.__segmentExpanded) {
    [...window.__segmentExpanded].forEach((key) => {
      const [dIndex, sIndex] = key.split(":");
      const seg = segmentResults[Number(dIndex)]?.segments?.[Number(sIndex)];
      if (seg && !seg.autoError) ensureAutoAlternatives(Number(dIndex), Number(sIndex));
    });
  }
}
function renderRouteSelect() {
  routeRenderer.renderRouteSelect({
    routeBook,
    route,
    archivedRoutes: archiveController.getRoutes()
  });
}
function renderDaySelect() {
  currentRouteView = routeRenderer.renderDaySelect({ route, currentRouteView });
}
function renderDays() {
  routeRenderer.renderDays({ route, segmentResults, currentRouteView });
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
    pointInfo: route.pointInfoCache,
    presentation: route.presentation,
    fit,
    expandedSegments: window.__segmentExpanded,
    onMarkerClick: ({ item, dayIndex }) => {
      el("daySelect").value = String(dayIndex);
      setPointForm(item.point.name, item.point.lng, item.point.lat);
      if (item.point.useScenic === false) toast("\u8FD9\u4E2A\u70B9\u4F4D\u5DF2\u8BBE\u7F6E\u4E3A\u4E0D\u91C7\u7528\u666F\u70B9\u8BF4\u660E\u3002");
      else showSpotInfo(item.point.name);
    },
    onLabelDrag: ({ item, labelOffset }) => {
      const next = normalizeLabelOffset(labelOffset);
      item.point.labelOffset = next;

      if (route) {
        const map = route.labelOffsets && typeof route.labelOffsets === "object"
          ? route.labelOffsets
          : (route.labelOffsets = {});
        const key = window.RouteModel?.poiLabelKey?.(item.point);
        if (key) {
          if (next.x || next.y) map[key] = next;
          else delete map[key];
        }
      }
      routeStore.save(routeBook);
      scheduleLabelOffsetSave();
    }
  });
}
function resetLabelOffsets(dayIndexes = null) {
  if (!route?.days?.length) return;
  const targets = Array.isArray(dayIndexes) ? dayIndexes.filter((dayIndex) => route.days[dayIndex]) : route.days.map((_, dayIndex) => dayIndex);
  targets.forEach((dayIndex) => {
    getDayPoints(route.days[dayIndex]).forEach((item) => {
      if (item.point) item.point.labelOffset = { x: 0, y: 0 };
    });
  });
}
async function calculateRoute({ background = false, resetLabels = false } = {}) {
  if (routeCalculationTask) {
    pendingRouteCalculation = {
      route,
      background: background && (pendingRouteCalculation?.background ?? true),
      resetLabels: resetLabels || Boolean(pendingRouteCalculation?.resetLabels)
    };
    if (!background) {
      foregroundCalcWaiting = true;
      setLoading("\u6B63\u5728\u5237\u65B0\u8DEF\u7EBF\u2026", { detail: "\u8DEF\u7EBF\u8BA1\u7B97\u4E2D\uFF0C\u8BF7\u7A0D\u5019" });
    }
    return routeCalculationTask;
  }
  const task = (async () => {
    let next = {background, resetLabels};
    do {
      pendingRouteCalculation = null;
      await performRouteCalculation(next);
      next = pendingRouteCalculation?.route === route ? pendingRouteCalculation : null;
    } while (next);
  })();
  routeCalculationTask = task;
  try {
    return await task;
  } finally {
    routeCalculationTask = null;
    pendingRouteCalculation = null;
  }
}
async function performRouteCalculation({ background = false, resetLabels = false } = {}) {
  if (!route) return toast("\u8BF7\u5148\u65B0\u5EFA\u8DEF\u7EBF\uFF0C\u6216\u4ECE\u516C\u5171\u8DEF\u7EBF\u5BFC\u5165\u3002");
  if (!routeMap.isReady()) {
    if (!background) {
      openSetupOverlay("\u8BF7\u5148\u914D\u7F6E\u5E76\u52A0\u8F7D\u9AD8\u5FB7\u5730\u56FE\uFF0C\u518D\u8BA1\u7B97\u8DEF\u7EBF\u3002");
      toast("\u8BF7\u5148\u5B8C\u6210\u9AD8\u5FB7\u914D\u7F6E\u3002");
    }
    return;
  }
  route = normalizeRoute(route);
  if (!route.days.length) return;
  const activeRoute = route;
  const dayCount = activeRoute.days.length;
  busyActions.add("calculate-route");
  const restoreButton = background ? () => {
  } : setButtonBusy("calcBtn", true, "\u5237\u65B0\u4E2D\u2026");
  if (!background) setLoading("\u5730\u56FE\u52A0\u8F7D\u4E2D", { percent: 12, detail: "\u51C6\u5907\u8DEF\u7EBF\u8BF7\u6C42" });
  try {
    activeRoute.segmentCache = activeRoute.segmentCache || {};
    if (!Array.isArray(segmentResults) || segmentResults.length !== activeRoute.days.length) {
      segmentResults = activeRoute.days.map((_, dayIndex) => ({
        segments: activeRoute.segmentCache[dayIndex]?.segments || [],
        options: activeRoute.segmentCache[dayIndex]?.options || [],
        customRoutes: activeRoute.segmentCache[dayIndex]?.customRoutes || [],
        selectedOptionKey: activeRoute.segmentCache[dayIndex]?.selectedOptionKey || null,
        confirmed: Boolean(activeRoute.segmentCache[dayIndex]?.confirmed)
      }));
    }
    const targetDays = currentRouteView === "all" ? activeRoute.days.map((_, i) => i) : [Number(currentRouteView)];
    const choiceSnapshot = new Map();
    const recordChoices = () => {
      targetDays.forEach((dayIndex) => {
        const day = activeRoute.days[dayIndex];
        if (!day) return;
        const pts = getDayPoints(day).map((item) => item.point).filter(isPointReady);
        const dayResult = segmentResults[dayIndex];
        (dayResult?.segments || []).forEach((seg, index) => {
          if (!pts[index] || !pts[index + 1]) return;
          const key = `${dayIndex}:${pts[index].lng},${pts[index].lat}\u2192${pts[index + 1].lng},${pts[index + 1].lat}`;
          choiceSnapshot.set(key, {
            selectedAlternative: seg.selectedAlternative,
            useCustom: Boolean(seg.useCustom),
            customAlternative: seg.customAlternative || null,
            useAuto: Boolean(seg.useAuto),
            autoAlternative: seg.autoAlternative || null,
            note: String(seg.note || "")
          });
        });
      });
    };
    const restoreChoices = (dayIndex) => {
      const day = activeRoute.days[dayIndex];
      if (!day) return;
      const pts = getDayPoints(day).map((item) => item.point).filter(isPointReady);
      const dayResult = segmentResults[dayIndex];
      (dayResult?.segments || []).forEach((seg, index) => {
        if (!pts[index] || !pts[index + 1]) return;
        const key = `${dayIndex}:${pts[index].lng},${pts[index].lat}\u2192${pts[index + 1].lng},${pts[index + 1].lat}`;
        const saved = choiceSnapshot.get(key);
        if (!saved) return;
        seg.note = saved.note;
        if (saved.useCustom && saved.customAlternative && Array.isArray(saved.customAlternative.path) && saved.customAlternative.path.length >= 2) {
          seg.useCustom = true;
          seg.useAuto = false;
          seg.customAlternative = saved.customAlternative;
          seg.path = saved.customAlternative.path;
          seg.distance = saved.customAlternative.distance || 0;
          seg.duration = saved.customAlternative.duration || 0;
        } else if (saved.useAuto) {
          seg.useAuto = false;
          seg.useCustom = false;
          seg.autoAlternative = null;
        } else if (Number.isFinite(Number(saved.selectedAlternative)) && Array.isArray(seg.alternatives) && seg.alternatives.length) {
          seg.useCustom = false;
          seg.useAuto = false;
          const indexAlt = Math.min(Math.floor(Number(saved.selectedAlternative)), seg.alternatives.length - 1);
          seg.selectedAlternative = indexAlt;
          const alt = seg.alternatives[indexAlt];
          if (alt) {
            seg.path = alt.path;
            seg.distance = alt.distance || 0;
            seg.duration = alt.duration || 0;
          }
        }
      });
    };
    recordChoices();
    if (resetLabels) resetLabelOffsets(targetDays);
    await Promise.all(targetDays.map(async (dayIndex) => {
      if (!activeRoute.days[dayIndex]) return;
      const signature = daySignature(activeRoute.days[dayIndex]);
      const cached = activeRoute.segmentCache[dayIndex];
      const expectedSegments = Math.max(0, getDayPoints(activeRoute.days[dayIndex]).filter((item) => isPointReady(item.point)).length - 1);
      const cacheMatches = cached && cached.cacheVersion === SEGMENT_CACHE_VERSION && Array.isArray(cached.segments) && cached.segments.length >= expectedSegments && cached.segments.every((segment) => !segment?.error) && (cached.signature === signature || !cached.signature);
      if (cacheMatches) {
        const cachedOptions = Array.isArray(cached.options) && cached.options.length ? cached.options : window.RouteModel.synthesizeDayOptions(cached.segments, Array.isArray(cached.customRoutes) ? cached.customRoutes : []);
        segmentResults[dayIndex] = {
          segments: cached.segments,
          options: cachedOptions,
          customRoutes: Array.isArray(cached.customRoutes) ? cached.customRoutes : [],
          selectedOptionKey: cached.selectedOptionKey || null,
          confirmed: Boolean(cached.confirmed && cached.selectedOptionKey)
        };
        return;
      }
      const segments = await routeMap.calculateDaySegments(structuredClone(activeRoute.days[dayIndex]), structuredClone(Array.isArray(cached?.segments) ? cached.segments : []));
      if (route !== activeRoute) return;
      if (activeRoute.days.length !== dayCount || !activeRoute.days[dayIndex] || daySignature(activeRoute.days[dayIndex]) !== signature) {

        pendingRouteCalculation = pendingRouteCalculation || {route: activeRoute, background: true, resetLabels: false};
        return;
      }
      recordChoices();
      const customRoutes = Array.isArray(cached?.customRoutes) ? cached.customRoutes : [];
      const options = window.RouteModel.synthesizeDayOptions(segments, customRoutes);
      segmentResults[dayIndex] = { segments, options, customRoutes, selectedOptionKey: null, confirmed: false };
      restoreChoices(dayIndex);
      activeRoute.segmentCache[dayIndex] = {
        cacheVersion: SEGMENT_CACHE_VERSION,
        signature,
        segments,
        options,
        customRoutes,
        selectedOptionKey: null,
        confirmed: false,
        updatedAt: (new Date()).toISOString()
      };
      syncSegmentCache(dayIndex);
    }));
    if (route !== activeRoute) return;
    const hasAnySegments = Object.values(activeRoute.segmentCache || {}).some((entry) => Array.isArray(entry?.segments) && entry.segments.length);
    renderAll(hasAnySegments ? false : true);
    saveRoute(false);
  } finally {
    const shouldHideLoading = !background || foregroundCalcWaiting;
    foregroundCalcWaiting = false;
    restoreButton();
    busyActions.delete("calculate-route");
    if (shouldHideLoading) hideLoading();
  }
}
function scheduleBackgroundRouteCalculation() {
  if (!routeMap.isReady() || !hasReadyRoutePoints(route) || hasCompleteRouteSegments(route)) return;
  setTimeout(() => {
    calculateRoute({ background: true, resetLabels: false }).catch((error) => {
      console.warn("Background route calculation failed:", error);
    });
  }, 350);
}
function isGeneratedDayTitle(value) {
  return /^(?:第\s*\d+\s*天|第[一二三四五六七八九十百千万]+\s*天)$/.test(cleanDayTitle(value));
}
function renumberGeneratedDayTitles(days) {
  days.forEach((day, index) => {
    if (isGeneratedDayTitle(day.title)) day.title = `\u7B2C ${index + 1} \u5929`;
  });
}
function addDayAfter(dayIndex) {
  if (currentRouteView !== "all") {
    currentRouteView = "all";
    renderDaySelect();
  }
  const anchor = route.days[dayIndex];
  if (!anchor) return;
  const nextDay = {
    title: `\u7B2C ${dayIndex + 2} \u5929`,
    from: structuredClone(anchor.to || { name: "", lng: null, lat: null }),
    waypoints: [],
    to: { name: "", lng: null, lat: null }
  };
  const insertedAt = dayIndex + 1;
  const wasLast = insertedAt === route.days.length;
  route.days.splice(insertedAt, 0, nextDay);
  remapPointInfoDays(insertedAt, 1);
  renumberGeneratedDayTitles(route.days);
  if (wasLast) {
    if (!Array.isArray(segmentResults)) segmentResults = [];
    if (segmentResults.length < insertedAt) segmentResults.length = insertedAt;
    segmentResults.splice(insertedAt, 0, { segments: [] });
  } else {
    const cache = route.segmentCache || {};
    const remapped = {};
    Object.keys(cache).forEach((key) => {
      const idx = Number(key);
      if (!Number.isInteger(idx)) return;
      remapped[idx >= insertedAt ? idx + 1 : idx] = cache[key];
    });
    route.segmentCache = remapped;
    applyCachedSegmentResults(route);
  }
  renderAll(false);
  saveRoute(false);
  toast(`\u5DF2\u5728 D${dayIndex + 1} \u540E\u65B0\u589E\u4E00\u5929\u3002`);
}
window.renameDay = function(dayIndex, value) {
  if (route.days[dayIndex]) route.days[dayIndex].title = cleanDayTitle(value) || `\u7B2C ${dayIndex + 1} \u5929`;
  renderDaySelect();
  saveRoute(false);
};
function parseCoordsText(raw) {
  const text = String(raw || "").replace(/\s+/g, "");
  if (!text) return [];
  const path = [];
  if (text.startsWith("[") && text.endsWith("]")) {
    try {
      const parsed = JSON.parse(text);
      (Array.isArray(parsed) ? parsed : []).forEach((item) => {
        if (Array.isArray(item) && item.length >= 2) {
          const lng = Number(item[0]);
          const lat = Number(item[1]);
          if (Number.isFinite(lng) && Number.isFinite(lat)) path.push([lng, lat]);
        } else if (item && Number.isFinite(Number(item.lng)) && Number.isFinite(Number(item.lat))) {
          path.push([Number(item.lng), Number(item.lat)]);
        }
      });
    } catch (_) {
    }
    return path;
  }
  String(text).split(/[;,]/).filter(Boolean).forEach((pair) => {
    const parts = pair.split(",").filter(Boolean);
    if (parts.length >= 2) {
      const lng = Number(parts[0]);
      const lat = Number(parts[1]);
      if (Number.isFinite(lng) && Number.isFinite(lat)) path.push([lng, lat]);
    }
  });
  return path;
}
function haversineMeters(lng1, lat1, lng2, lat2) {
  const toRad = (value) => Number(value) * Math.PI / 180;
  const dLng = toRad(lng2 - lng1);
  const dLat = toRad(lat2 - lat1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371e3 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function parseCoordToken(item) {
  const match = String(item).match(/^\s*\[?\s*(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)\s*\]?\s*$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2])];
}
function estimatePathMetric(path, mode) {
  let distance = 0;
  for (let index = 1; index < path.length; index += 1) {
    const a = path[index - 1];
    const b = path[index];
    if (a && b) distance += haversineMeters(a[0], a[1], b[0], b[1]);
  }
  if (path.length <= 2) distance *= 1.25;
  const speedByMode = { drive: 12.5, ride: 4.17, walk: 1.39 };
  const speed = speedByMode[mode] || 12.5;
  const duration = Math.round(distance / speed);
  return { distance: Math.round(distance), duration };
}
function syncSegmentCache(dayIndex) {
  const dayResult = segmentResults[Number(dayIndex)];
  if (!dayResult) return;
  if (!route.segmentCache[dayIndex]) return;
  route.segmentCache[dayIndex].segments = (dayResult.segments || []).map((seg) => {
    const copy = {...seg};
    delete copy.autoAlternative;
    delete copy.fetchingAuto;
    delete copy.autoError;
    delete copy.autoAlternativesLoaded;
    return copy;
  });
  route.segmentCache[dayIndex].customRoutes = Array.isArray(dayResult.customRoutes) ? dayResult.customRoutes : [];
  route.segmentCache[dayIndex].cacheVersion = SEGMENT_CACHE_VERSION;
  route.segmentCache[dayIndex].options = window.RouteModel.synthesizeDayOptions(dayResult.segments, route.segmentCache[dayIndex].customRoutes);
  route.segmentCache[dayIndex].selectedOptionKey = null;
  route.segmentCache[dayIndex].confirmed = false;
}
window.toggleSegmentAlternatives = function(dayIndex, segmentIndex) {
  if (!window.__segmentExpanded) window.__segmentExpanded = new Set();
  const key = `${dayIndex}:${segmentIndex}`;
  if (window.__segmentExpanded.has(key)) window.__segmentExpanded.delete(key);
  else {
    window.__segmentExpanded.add(key);
    const seg = segmentResults[Number(dayIndex)]?.segments?.[Number(segmentIndex)];
    if (seg) seg.autoError = null;
    ensureAutoAlternatives(dayIndex, segmentIndex);
  }
  renderAll(false);
};
async function ensureAutoAlternatives(dayIndex, segmentIndex) {
  const activeRoute = route;
  const dayResult = segmentResults[Number(dayIndex)];
  const segment = dayResult?.segments?.[Number(segmentIndex)];
  if (!segment) return;
  if (segment.fetchingAuto || segment.autoAlternativesLoaded) return;
  const alternatives = Array.isArray(segment.alternatives) ? segment.alternatives : [];
  if (alternatives.length >= 5) return;
  const day = route.days[Number(dayIndex)];
  const dayPoints = getDayPoints(day).map((item) => item.point).filter(isPointReady);
  const fromPt = dayPoints[Number(segmentIndex)];
  const toPt = dayPoints[Number(segmentIndex) + 1];
  if (!fromPt || !toPt) {
    segment.autoError = "\u8D77\u70B9\u6216\u7EC8\u70B9\u5750\u6807\u672A\u51C6\u5907";
    renderAll(false);
    return;
  }
  segment.fetchingAuto = true;
  renderAll(false);
  try {
    const autoRoutes = await window.RoadProvider.autoPlanRoutes(fromPt, toPt, segment.mode || "drive");
    if (route !== activeRoute || segmentResults[Number(dayIndex)]?.segments?.[Number(segmentIndex)] !== segment) return;
    const baseDistance = Number(segment.distance) || 0;
    const baseDuration = Number(segment.duration) || 0;
    const accepted = [];
    for (const auto of autoRoutes) {
      if (baseDistance && Number(auto.distance) > baseDistance + 100000) continue;
      if (baseDuration && Number(auto.duration) > baseDuration + 7200) continue;
      const dup = [...alternatives, ...accepted].some((alt) => window.RoadProvider.overlapRatio(alt.path, auto.path) > 0.6);
      if (dup) continue;
      accepted.push({ policy: "\u81EA\u52A8\u89C4\u5212", distance: Number(auto.distance) || 0, duration: Number(auto.duration) || 0, path: auto.path });
    }
    segment.autoAlternativesLoaded = true;
    segment.autoError = null;
    if (accepted.length) {
      const room = Math.max(0, 5 - alternatives.length);
      segment.alternatives = [...alternatives, ...accepted.slice(0, room)];
      if (!segment.useCustom && !segment.useAuto) {
        if (!Number.isFinite(Number(segment.selectedAlternative))) segment.selectedAlternative = 0;
        window.RouteModel.selectSegmentAlternative(segment, Number.isFinite(Number(segment.selectedAlternative)) ? Number(segment.selectedAlternative) : 0);
      }
    }
  } catch (error) {
    segment.autoError = error.message || "\u81EA\u52A8\u89C4\u5212\u5931\u8D25";
  } finally {
    segment.fetchingAuto = false;
    if (route === activeRoute && segmentResults[Number(dayIndex)]?.segments?.[Number(segmentIndex)] === segment) renderAll(false);
  }
}
window.pinSegmentAlternative = function(dayIndex, segmentIndex, alternativeIndex) {
  const dayResult = segmentResults[Number(dayIndex)];
  const segment = dayResult?.segments?.[Number(segmentIndex)];
  if (!segment) return;
  const alternatives = Array.isArray(segment.alternatives) ? segment.alternatives : [];
  const index = Math.min(Math.floor(Number(alternativeIndex) || 0), Math.max(0, alternatives.length - 1));
  if (!alternatives.length || index < 0) return;
  const [chosen] = alternatives.splice(index, 1);
  alternatives.unshift(chosen);
  segment.alternatives = alternatives;
  window.RouteModel.selectSegmentAlternative(segment, 0);
  syncSegmentCache(dayIndex);
  renderAll(false);
  saveRoute(false);
  toast("\u5DF2\u5C06\u8BE5\u8DEF\u7EBF\u7F6E\u4E3A\u7B2C\u4E00\u9009\u62E9\u3002");
};
window.selectSegmentAlternative = function(dayIndex, segmentIndex, alternativeIndex) {
  const dayResult = segmentResults[Number(dayIndex)];
  const segment = dayResult?.segments?.[Number(segmentIndex)];
  if (!segment) return;
  window.RouteModel.selectSegmentAlternative(segment, alternativeIndex);
  syncSegmentCache(dayIndex);
  renderAll(false);
  saveRoute(false);
};
window.selectCustomAlternative = function(dayIndex, segmentIndex) {
  const dayResult = segmentResults[Number(dayIndex)];
  const segment = dayResult?.segments?.[Number(segmentIndex)];
  if (!segment) return;
  window.RouteModel.selectCustomAlternative(segment);
  syncSegmentCache(dayIndex);
  renderAll(false);
  saveRoute(false);
};
window.editSegmentNote = async function(dayIndex, segmentIndex) {
  const dayResult = segmentResults[Number(dayIndex)];
  const segment = dayResult?.segments?.[Number(segmentIndex)];
  if (!segment) return;
  const alternatives = Array.isArray(segment.alternatives) ? segment.alternatives : [];
  const selectedAlt = Number.isFinite(Number(segment.selectedAlternative)) ? Math.max(0, Math.min(Math.floor(Number(segment.selectedAlternative)), Math.max(0, alternatives.length - 1))) : 0;
  const custom = segment.customAlternative || null;
  const usingCustom = Boolean(segment.useCustom && custom);
  const currentPolicy = usingCustom ? custom.label ? `${custom.label}\uFF08\u81EA\u5B9A\u4E49\uFF09` : "\u81EA\u5B9A\u4E49" : alternatives[selectedAlt]?.policy ? window.RouteModel.simplifyPolicyLabel(alternatives[selectedAlt].policy) : "";
  const next = await feedback.appPrompt({
    title: "\u8DEF\u7EBF\u5907\u6CE8",
    defaultValue: String(segment.note || "").trim() || currentPolicy,
    placeholder: "\u5982\uFF1A\u8D70\u72EC\u5E93\u516C\u8DEF"
  });
  if (next === null) return;
  segment.note = String(next).trim();
  syncSegmentCache(dayIndex);
  renderAll(false);
  saveRoute(false);
};
window.deleteSegmentCustomRoute = async function(dayIndex, segmentIndex) {
  const dayResult = segmentResults[Number(dayIndex)];
  const segment = dayResult?.segments?.[Number(segmentIndex)];
  if (!segment) return;
  const ok = await feedback.appConfirm({title: "确认删除", compact: true});
  if (!ok) return;
  segment.customAlternative = null;
  segment.useCustom = false;
  segment.selectedAlternative = 0;
  const alternatives = Array.isArray(segment.alternatives) ? segment.alternatives : [];
  const fallback = alternatives[0];
  if (fallback) {
    segment.path = fallback.path;
    segment.distance = fallback.distance;
    segment.duration = fallback.duration;
  }
  syncSegmentCache(dayIndex);
  renderAll(false);
  saveRoute(false);
  toast("\u5DF2\u5220\u9664\u81EA\u5B9A\u4E49\u8F68\u8FF9\u3002");
};
function openSegmentCustomModal(dayIndex, segmentIndex) {
  el("customRouteDayIndex").value = String(dayIndex);
  el("customRouteSegmentIndex").value = String(segmentIndex);
  el("customRouteName").value = "";
  el("customRouteNames").value = "";
  el("customRouteCoords").value = "";
  mapPickActive = false;
  const pickBtn = document.querySelector("[data-map-pick-btn]");
  if (pickBtn) pickBtn.classList.remove("active");
  dialogs.open("customRouteModal");
}
window.beginMapPick = function() {
  mapPickActive = !mapPickActive;
  const pickBtn = document.querySelector("[data-map-pick-btn]");
  if (pickBtn) pickBtn.classList.toggle("active", mapPickActive);
  toast(mapPickActive ? "\u8BF7\u5728\u5730\u56FE\u4E0A\u4F9D\u6B21\u70B9\u51FB\u9014\u7ECF\u70B9\u4F4D\u7F6E\u3002" : "\u5DF2\u7ED3\u675F\u5730\u56FE\u9009\u70B9\u3002");
};
function closeCustomRouteModal() {
  mapPickActive = false;
  const pickBtn = document.querySelector("[data-map-pick-btn]");
  if (pickBtn) pickBtn.classList.remove("active");
  dialogs.close("customRouteModal");
}
window.openSegmentCustomInput = function(dayIndex, segmentIndex) {
  openSegmentCustomModal(dayIndex, segmentIndex);
};
window.addSegmentCustomRoute = async function() {
  const dayIndex = Number(el("customRouteDayIndex").value);
  const segmentIndex = Number(el("customRouteSegmentIndex").value);
  const dayResult = segmentResults[dayIndex];
  const segment = dayResult?.segments?.[segmentIndex];
  if (!segment) return toast("\u8BE5\u6BB5\u5C1A\u672A\u51C6\u5907\u8DEF\u7EBF\u3002");
  const labelInput = String(el("customRouteName").value || "").trim();
  const namesText = String(el("customRouteNames").value || "").trim();
  const names = namesText ? namesText.split(/[;；\n,，]+/).map((item) => item.trim()).filter(Boolean) : [];
  let path = [];
  let distance = 0;
  let duration = 0;
  if (names.length > 0) {
    if (!routeMap.isReady()) return toast("\u8BF7\u5148\u52A0\u8F7D\u5730\u56FE\u540E\u518D\u89E3\u6790\u9014\u7ECF\u70B9\u3002");
    const coordTokens = names.map(parseCoordToken).filter(Boolean);
    if (coordTokens.length === names.length && coordTokens.length > 0) {
      if (coordTokens.length < 2) return toast("\u81F3\u5C11\u9700\u8981 2 \u4E2A\u9014\u7ECF\u70B9\uFF0C\u8BF7\u7EE7\u7EED\u5730\u56FE\u9009\u70B9\u6216\u8F93\u5165\u5750\u6807\u3002");
      path = coordTokens;
      const metric = estimatePathMetric(path, segment.mode || "drive");
      distance = metric.distance;
      duration = metric.duration;
    } else {
      const roadName = names.find((item) => window.RoadProvider?.isRoadName?.(item));
      if (roadName) {
        if (names.length > 1 && names.some((item) => !window.RoadProvider?.isRoadName?.(item))) {
          return toast("\u516C\u8DEF\u540D\u8BF7\u5355\u72EC\u586B\u5199\uFF0C\u6216\u53EA\u586B\u5730\u540D\u5E8F\u5217\u3002");
        }
        const day = route.days[dayIndex];
        const dayPoints = getDayPoints(day).map((item) => item.point).filter(isPointReady);
        const fromPt = dayPoints[segmentIndex];
        const toPt = dayPoints[segmentIndex + 1];
        if (!fromPt || !toPt) return toast("\u8BE5\u6BB5\u8D77\u7EC8\u70B9\u672A\u786E\u5B9A\u3002");
        toast(`\u6B63\u5728\u83B7\u53D6 ${roadName} \u8DEF\u7F51\u6570\u636E\u2026`);
        let road;
        try {
          road = await window.RoadProvider.resolveRoadRoute(roadName, fromPt, toPt, segment.mode || "drive");
        } catch (error) {
          return toast(`\u65E0\u6CD5\u83B7\u53D6\u516C\u8DEF\u8DEF\u7EBF\uFF1A${error.message}`);
        }
        if (!Array.isArray(road.path) || road.path.length < 2) return toast("\u672A\u80FD\u751F\u6210\u516C\u8DEF\u8DEF\u7EBF\u3002");
        const full = [];
        const pushUnique = (list) => {
          (list || []).forEach((point) => {
            const last = full[full.length - 1];
            if (!last || Math.abs(last[0] - point[0]) > 1e-6 || Math.abs(last[1] - point[1]) > 1e-6) full.push(point);
          });
        };
        const roadStart = road.path[0];
        const roadEnd = road.path[road.path.length - 1];
        let totalDistance2 = road.distance || 0;
        let totalDuration2 = road.duration || 0;
        try {
          const head = await routeMap.route(fromPt, { name: roadName, lng: roadStart[1], lat: roadStart[0] }, "drive");
          pushUnique(head?.path || []);
          if (head) {
            totalDistance2 += head.distance || 0;
            totalDuration2 += head.duration || 0;
          }
        } catch (_) {
          pushUnique([[fromPt.lng, fromPt.lat], roadStart]);
          const headMetric = estimatePathMetric([[fromPt.lng, fromPt.lat], roadStart], segment.mode || "drive");
          totalDistance2 += headMetric.distance;
          totalDuration2 += headMetric.duration;
        }
        pushUnique(road.path);
        try {
          const tail = await routeMap.route({ name: roadName, lng: roadEnd[1], lat: roadEnd[0] }, toPt, "drive");
          pushUnique(tail?.path || []);
          if (tail) {
            totalDistance2 += tail.distance || 0;
            totalDuration2 += tail.duration || 0;
          }
        } catch (_) {
          pushUnique([roadEnd, [toPt.lng, toPt.lat]]);
          const tailMetric = estimatePathMetric([roadEnd, [toPt.lng, toPt.lat]], segment.mode || "drive");
          totalDistance2 += tailMetric.distance;
          totalDuration2 += tailMetric.duration;
        }
        if (full.length < 2) return toast("\u672A\u80FD\u751F\u6210\u516C\u8DEF\u8DEF\u7EBF\u3002");
        const roadLabel = labelInput || (road.name ? `${road.name}\uFF08${roadName}\uFF09` : roadName);
        segment.customAlternative = { label: roadLabel, distance: totalDistance2, duration: totalDuration2, path: full };
        segment.useCustom = true;
        segment.selectedAlternative = 0;
        segment.path = full;
        segment.distance = totalDistance2;
        segment.duration = totalDuration2;
        syncSegmentCache(dayIndex);
        closeCustomRouteModal();
        renderAll(false);
        saveRoute(false);
        toast("\u5DF2\u6DFB\u52A0\u6CBF\u516C\u8DEF\u7684\u81EA\u5B9A\u4E49\u8DEF\u7EBF\u3002");
        return;
      }
      if (names.length < 2) return toast("\u9014\u7ECF\u70B9\u81F3\u5C11 2 \u4E2A\uFF0C\u7528\u5206\u53F7\u5206\u9694\u3002");
      const points = [];
      for (const name of names) {
        try {
          points.push(await routeMap.resolvePlace(name));
        } catch (error) {
          return toast(`\u65E0\u6CD5\u89E3\u6790\u201C${name}\u201D\uFF1A${error.message}`);
        }
      }
      const merged = [];
      let totalDistance = 0;
      let totalDuration = 0;
      for (let index = 0; index < points.length - 1; index += 1) {
        try {
          const result = await routeMap.route(points[index], points[index + 1], "drive");
          if (result?.path?.length) {
            merged.push(...result.path);
            totalDistance += result.distance || 0;
            totalDuration += result.duration || 0;
            continue;
          }
        } catch (_) {
        }
        const legPath = [[points[index].lng, points[index].lat], [points[index + 1].lng, points[index + 1].lat]];
        merged.push(...legPath);
        const legMetric = estimatePathMetric(legPath, segment.mode || "drive");
        totalDistance += legMetric.distance;
        totalDuration += legMetric.duration;
      }
      if (merged.length < 2) return toast("\u672A\u80FD\u751F\u6210\u8DEF\u7EBF\u8F68\u8FF9\u3002");
      path = merged;
      distance = totalDistance;
      duration = totalDuration;
    }
  } else {
    const coordsText = String(el("customRouteCoords").value || "").trim();
    if (!coordsText) return toast("\u8BF7\u586B\u5199\u9014\u7ECF\u70B9\uFF08\u5730\u540D/\u516C\u8DEF\u540D\uFF09\u6216\u8F68\u8FF9\u5750\u6807\u3002");
    path = parseCoordsText(coordsText);
    if (path.length < 2) return toast("\u5750\u6807\u65E0\u6548\uFF1A\u81F3\u5C11\u9700\u8981 2 \u4E2A\u70B9\u3002");
    const metric = estimatePathMetric(path, segment.mode || "drive");
    distance = metric.distance;
    duration = metric.duration;
  }
  const label = labelInput || (names.length > 0 ? names.join(" \u2192 ") : "\u81EA\u5B9A\u4E49\u8F68\u8FF9");
  segment.customAlternative = { label, distance, duration, path };
  segment.useCustom = true;
  segment.selectedAlternative = 0;
  segment.path = path;
  segment.distance = distance;
  segment.duration = duration;
  syncSegmentCache(dayIndex);
  closeCustomRouteModal();
  renderAll(false);
  saveRoute(false);
  toast("\u5DF2\u6DFB\u52A0\u81EA\u5B9A\u4E49\u8F68\u8FF9\u3002");
};
window.movePoint = function(dayIndex, fromIndex, toIndex) {
  const day = route.days[Number(dayIndex)];
  if (!day) return;
  const items = window.RouteModel.getDayPoints(day).map((item) => item.point);
  if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex) || fromIndex < 0 || fromIndex >= items.length || toIndex < 0 || toIndex > items.length || fromIndex === toIndex) return;
  const [moved] = items.splice(fromIndex, 1);
  const target = fromIndex < toIndex ? toIndex - 1 : toIndex;
  items.splice(target, 0, moved);
  day.from = items[0];
  day.waypoints = items.slice(1, -1);
  day.to = items[items.length - 1];
  invalidateDay(dayIndex);
  renderAll(false);
  saveRoute(false);
  calculateRoute({ background: true, resetLabels: false }).catch((error) => {
    console.warn("\u91CD\u7B97\u8DEF\u7EBF\u5931\u8D25:", error?.message || error);
  });
  toast("\u5DF2\u8C03\u6574\u5730\u70B9\u987A\u5E8F\uFF0C\u6B63\u5728\u91CD\u7B97\u2026");
};
window.pointDragStart = function(event) {
  const target = event.currentTarget;
  event.dataTransfer.setData("text/plain", JSON.stringify({
    day: Number(target.dataset.dayIndex),
    index: Number(target.dataset.pointIndex)
  }));
  event.dataTransfer.effectAllowed = "move";
  target.classList.add("point-dragging");
};
window.pointDragOver = function(event) {
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  event.currentTarget.classList.add("point-drag-over");
};
window.pointDragLeave = function(event) {
  event.currentTarget.classList.remove("point-drag-over");
};
window.pointDrop = function(event) {
  event.preventDefault();
  event.currentTarget.classList.remove("point-drag-over");
  let data = null;
  try {
    data = JSON.parse(event.dataTransfer.getData("text/plain") || "{}");
  } catch (_) {
  }
  if (!data || !Number.isInteger(data.day) || !Number.isInteger(data.index)) return;
  const toDay = Number(event.currentTarget.dataset.dayIndex);
  const toIndex = Number(event.currentTarget.dataset.pointIndex);
  if (data.day !== toDay) return;
  window.movePoint(data.day, data.index, toIndex);
};
window.pointDragEnd = function(event) {
  event.currentTarget.classList.remove("point-dragging");
  document.querySelectorAll(".point-drag-over, .point-slot-over").forEach((node) => node.classList.remove("point-drag-over", "point-slot-over"));
};
window.pointDragEnterSlot = function(event) {
  event.preventDefault();
};
window.pointDragOverSlot = function(event) {
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  event.currentTarget.classList.add("point-slot-over");
};
window.pointDragLeaveSlot = function(event) {
  event.currentTarget.classList.remove("point-slot-over");
};
window.pointDropSlot = function(event) {
  event.preventDefault();
  event.currentTarget.classList.remove("point-slot-over");
  let data = null;
  try {
    data = JSON.parse(event.dataTransfer.getData("text/plain") || "{}");
  } catch (_) {
  }
  if (!data || !Number.isInteger(data.day) || !Number.isInteger(data.index)) return;
  const toDay = Number(event.currentTarget.dataset.dayIndex);
  const slotIndex = Number(event.currentTarget.dataset.slotIndex);
  if (data.day !== toDay) return;
  window.movePoint(data.day, data.index, slotIndex);
};
const TRANSPORT_LABELS = { drive: "\u8F66", ride: "\u9A91", walk: "\u6B65" };
const TRANSPORT_ORDER = ["drive", "ride", "walk"];
const sameCoordValue = (left, right) => Math.abs(Number(left) - Number(right)) <= 0.000001;

function syncDayPointNames(dayIndex) {
  const index = Number(dayIndex);
  const day = route.days[index];
  if (!day) return;
  const points = getDayPoints(day).map((item) => item.point).filter(isPointReady);
  const nameAt = (lng, lat) => {
    if (lng == null || lat == null) return "";
    const hit = points.find((point) => sameCoordValue(point.lng, lng) && sameCoordValue(point.lat, lat));
    return hit?.name || "";
  };
  const applyNames = (segments) => (segments || []).forEach((segment) => {
    const fromName = nameAt(segment.fromLng, segment.fromLat);
    if (fromName) segment.from = fromName;
    const toName = nameAt(segment.toLng, segment.toLat);
    if (toName) segment.to = toName;
  });
  const cached = route.segmentCache?.[index];
  applyNames(cached?.segments);
  applyNames(segmentResults[index]?.segments);
  if (cached && cached.signature && cached.signature !== STALE_DAY_SIGNATURE) {
    cached.signature = daySignature(day);
  }
}

const STALE_DAY_SIGNATURE = "__stale__";
function invalidateDay(dayIndex) {
  const index = Number(dayIndex);
  route.segmentCache = route.segmentCache || {};
  const cached = route.segmentCache[index];
  if (cached && typeof cached === "object") {
    cached.signature = STALE_DAY_SIGNATURE;
  }
  if (Array.isArray(segmentResults) && Number.isInteger(index) && index >= 0 && index < route.days.length) {
    segmentResults[index] = { segments: [] };
  } else {
    segmentResults = [];
  }
}
window.cyclePointMode = function(dayIndex, kind, waypointIndex) {
  const day = route.days[Number(dayIndex)];
  if (!day) return;
  const point = kind === "to" ? day.to : day.waypoints[Number(waypointIndex)];
  if (!point) return;
  const current = window.RouteModel.normalizeTransportMode(point.transportMode);
  const next = TRANSPORT_ORDER[(TRANSPORT_ORDER.indexOf(current) + 1) % TRANSPORT_ORDER.length];
  point.transportMode = next;
  invalidateDay(dayIndex);
  renderAll(false);
  saveRoute(false);
  calculateRoute({ background: true, resetLabels: false }).catch((error) => {
    console.warn("\u91CD\u7B97\u8DEF\u7EBF\u5931\u8D25:", error?.message || error);
  });
  toast(`\u5DF2\u5207\u6362\u4E3A${TRANSPORT_LABELS[next]}\uFF0C\u6B63\u5728\u91CD\u7B97\u2026`);
};
window.deleteWaypoint = async function(dayIndex, waypointIndex) {
  const list = route.days[dayIndex]?.waypoints;
  if (!list) return;
  const ok = await feedback.appConfirm({title: "确认删除", compact: true});
  if (!ok) return;
  list.splice(waypointIndex, 1);
  invalidateDay(dayIndex);
  renderAll(false);
  saveRoute(false);
  calculateRoute({ background: true, resetLabels: false }).catch((error) => {
    console.warn("\u91CD\u7B97\u8DEF\u7EBF\u5931\u8D25:", error?.message || error);
  });
  toast("\u5DF2\u5220\u9664\u9014\u7ECF\u70B9\uFF0C\u6B63\u5728\u91CD\u7B97\u2026");
};
function remapPointInfoDays(index, shift) {
  const cache = route.pointInfoCache;
  if (!cache?.days || typeof cache.days !== "object") return;
  const remapped = {};
  Object.entries(cache.days).forEach(([key, entry]) => {
    const oldIndex = Number(key);
    if (!Number.isInteger(oldIndex) || !entry || (shift < 0 && oldIndex === index)) return;
    const moved = shift > 0 ? oldIndex >= index : oldIndex > index;
    const nextIndex = moved ? oldIndex + shift : oldIndex;
    if (nextIndex < 0 || nextIndex >= route.days.length) return;
    remapped[nextIndex] = moved ? {
      ...entry,
      date: null,
      weatherFetchedAt: null,
      points: (entry.points || []).map((info) => info?.elevationM != null && Number.isFinite(Number(info.elevationM)) ? {elevationM: Number(info.elevationM)} : {})
    } : entry;
  });
  cache.days = remapped;
}
window.deleteDay = async function(dayIndex) {
  if (route.days.length <= 1) return toast("\u81F3\u5C11\u4FDD\u7559\u4E00\u5929\u884C\u7A0B\u3002");
  const ok = await feedback.appConfirm({title: "确认删除", compact: true});
  if (!ok) return;
  route.days.splice(dayIndex, 1);
  renumberGeneratedDayTitles(route.days);
  const cache = route.segmentCache || {};
  const remapped = {};
  Object.keys(cache).forEach((key) => {
    const idx = Number(key);
    if (!Number.isInteger(idx) || idx === dayIndex) return;
    remapped[idx > dayIndex ? idx - 1 : idx] = cache[key];
  });
  route.segmentCache = remapped;
  remapPointInfoDays(dayIndex, -1);
  applyCachedSegmentResults(route);
  renderAll(false);
  saveRoute(false);
};
window.accountOpenRoute = async function(routeId) {
  await runExclusive(`account-open-route:${routeId}`, async () => {
    await loadRouteFromAccount(routeId);
    closeAccountCenter();
  }, { message: "\u6B63\u5728\u6253\u5F00\u8DEF\u7EBF\uFF0C\u8BF7\u7A0D\u5019\u3002" });
};
function findRouteBookItemByIdentifier(identifier) {
  const archived = archiveController.getRoutes().find((item) => item.safeName === identifier || item.id === identifier);
  const matchKey = archived?.routeData?.id || archived?.id || archived?.name || identifier;
  return routeBook.routes.find((item) => item.id === matchKey || item.name === matchKey) || null;
}

async function ensureArchivedRouteLoaded(identifier) {
  const inBook = findRouteBookItemByIdentifier(identifier);
  if (inBook) return inBook;
  const archived = archiveController.getRoutes().find((item) => item.safeName === identifier || item.id === identifier);
  const routeId = archived?.id || archived?.safeName || identifier;
  if (!routeId) return null;
  try {
    const {response, data} = await localService.getRoute(routeId);
    if (!response.ok || !data?.ok || !data.route?.routeData) return null;
    return routeStore.upsert(routeBook, data.route.routeData);
  } catch (_) {
    return null;
  }
}
window.accountRenameRoute = async function(routeId) {
  const archived = archiveController.getRoutes().find((item) => item.safeName === routeId || item.id === routeId);
  const target = findRouteBookItemByIdentifier(routeId) || await ensureArchivedRouteLoaded(routeId);
  if (!target) return toast("\u672A\u627E\u5230\u8FD9\u6761\u8DEF\u7EBF\u3002");
  const next = await feedback.appPrompt({
    title: "\u8DEF\u7EBF\u540D\u79F0",
    defaultValue: target.name || "",
    placeholder: "\u7ED9\u8FD9\u6761\u8DEF\u7EBF\u8D77\u4E2A\u540D\u5B57"
  });
  if (next === null) return;
  await runExclusive(`account-rename-route:${routeId}`, async () => {
    if (await renameRouteById(target.id, next)) {
      await refreshArchivedRoutes({ force: true });
      renderAccountRoutes();
    }
  }, { message: "\u6B63\u5728\u6539\u540D\uFF0C\u8BF7\u7A0D\u5019\u3002" });
};
window.accountEditRouteDescription = async function(routeId) {
  const target = findRouteBookItemByIdentifier(routeId) || await ensureArchivedRouteLoaded(routeId);
  if (!target) return toast("\u672A\u627E\u5230\u8FD9\u6761\u8DEF\u7EBF\u3002");
  const next = await feedback.appPromptArea({
    title: "\u8DEF\u7EBF\u4ECB\u7ECD",
    defaultValue: target.description || "",
    placeholder: "\u4E00\u53E5\u8BDD\u4ECB\u7ECD\u8FD9\u6761\u8DEF\u7EBF",
    rows: 3
  });
  if (next === null) return;
  await runExclusive(`account-edit-route-description:${routeId}`, async () => {
    if (await updateRouteDescription(target.id, next)) {
      await refreshArchivedRoutes({ force: true });
      renderAccountRoutes();
    }
  }, { message: "\u6B63\u5728\u4FDD\u5B58\u4ECB\u7ECD\uFF0C\u8BF7\u7A0D\u5019\u3002" });
};
window.accountDeleteRoute = async function(routeId) {
  const archived = archiveController.getRoutes().find((item) => item.safeName === routeId || item.id === routeId);
  const target = findRouteBookItemByIdentifier(routeId);
  if (!target && !archived) return toast("\u672A\u627E\u5230\u8FD9\u6761\u8DEF\u7EBF\u3002");
  const okDelete = await feedback.appConfirm({
    title: "\u5220\u9664\u8DEF\u7EBF",
    message: `\u5220\u9664\u8DEF\u7EBF\u201C${target?.name || archived?.name || "\u672A\u547D\u540D\u8DEF\u7EBF"}\u201D\uFF1F`
  });
  if (!okDelete) return;
  await runExclusive(`account-delete-route:${routeId}`, async () => {
    if (target) {
      if (await deleteRouteById(target.id)) {
        await refreshArchivedRoutes({ force: true });
        renderAccountRoutes();
      }
    } else {
      const { response, data } = await localService.deleteRoute(archived.id || archived.routeData?.id || routeId);
      if (!response.ok || !data?.ok) return toast("\u4E91\u7AEF\u5220\u9664\u5931\u8D25\uFF1A" + (data?.message || "\u8BF7\u91CD\u8BD5"));
      await refreshArchivedRoutes({ force: true });
      renderAccountRoutes();
    }
  }, { message: "\u6B63\u5728\u5220\u9664\u8DEF\u7EBF\uFF0C\u8BF7\u7A0D\u5019\u3002" });
};
window.accountPublishRoute = async function(routeId) {
  await runExclusive(`account-publish-route:${routeId}`, async () => {
    await archiveController.publishRouteById(routeId);
    renderAccountRoutes();
  }, { message: "\u6B63\u5728\u53D1\u5E03\u8DEF\u7EBF\uFF0C\u8BF7\u7A0D\u5019\u3002" });
};
window.accountImportPublished = async function(routeId) {
  await runExclusive(`account-import-published:${routeId}`, () => archiveController.importPublished(routeId), {
    message: "\u6B63\u5728\u5BFC\u5165\u8DEF\u7EBF\uFF0C\u8BF7\u7A0D\u5019\u3002"
  });
};
window.accountPreviewUserScene = function(sceneId) {
  const scene = accountUserScenes.find((item) => item.id === sceneId);
  if (!scene) return;
  showSpotInfo(scene.name || scene.title);
};
window.accountEditUserScene = function(sceneId) {
  openSceneEditorFromAccount(sceneId);
};
window.accountEditPublicScene = async function(name) {
  await runExclusive(`account-edit-public-scene:${name}`, () => openPublicSceneEditorFromAccount(name), {
    message: "正在读取公共景点，请稍候。"
  });
};
window.accountDeleteUserScene = async function(sceneId) {
  const scene = accountUserScenes.find((item) => item.id === sceneId);
  if (!scene) return;
  const okDeleteScene = await feedback.appConfirm({title: "确认删除", compact: true});
  if (!okDeleteScene) return;
  const { response, data } = await localService.deleteUserScene(sceneId);
  if (!response.ok || !data?.ok) return toast("\u5220\u9664\u5931\u8D25\uFF1A" + (data?.message || "\u8BF7\u91CD\u8BD5"));
  await renderAccountScenes();
  toast("\u4E2A\u4EBA\u666F\u70B9\u4ECB\u7ECD\u5DF2\u5220\u9664\u3002");
};
window.accountImportScene = async function(name) {
  const okImport = await feedback.appConfirm({
    title: "\u590D\u5236\u5230\u6211\u7684\u666F\u70B9",
    message: `\u5C06\u516C\u5171\u666F\u70B9\u201C${name}\u201D\u590D\u5236\u5230\u6211\u7684\u666F\u70B9\uFF1F\u540C\u540D\u4E2A\u4EBA\u4ECB\u7ECD\u4F1A\u4F18\u5148\u7528\u4E8E\u4F60\u7684\u8DEF\u7EBF\u3002`
  });
  if (!okImport) return;
  const { response, data } = await localService.importScene(name);
  if (!response.ok || !data?.ok) return toast("\u5BFC\u5165\u5931\u8D25\uFF1A" + (data?.message || "\u8BF7\u91CD\u8BD5"));
  setAccountSceneMode("mine");
  await renderAccountScenes();
  toast("\u5DF2\u590D\u5236\u5230\u6211\u7684\u666F\u70B9\u3002");
};
window.accountDeletePublished = async function(routeId) {
  const okDeletePub = await feedback.appConfirm({ title: "确认删除", compact: true });
  if (!runtime.isAdmin || !okDeletePub) return;
  const { response, data } = await localService.deletePublishedRoute(routeId);
  if (!response.ok || !data?.ok) return toast("\u5220\u9664\u516C\u5171\u8DEF\u7EBF\u5931\u8D25\uFF1A" + (data?.message || "\u8BF7\u91CD\u8BD5"));
  toast("\u516C\u5171\u8DEF\u7EBF\u5DF2\u5220\u9664\u3002");
  await refreshArchivedRoutes({ force: true });
  renderAccountRoutes();
  await refreshAdminDashboard();
};
window.accountDeleteScene = async function(name) {
  const okDeleteScenic = await feedback.appConfirm({ title: "确认删除", compact: true });
  if (!runtime.isAdmin || !okDeleteScenic) return;
  const { response, data } = await localService.deleteScenic(name);
  if (!response.ok || !data?.ok) return toast("\u5220\u9664\u666F\u70B9\u5931\u8D25\uFF1A" + (data?.message || "\u8BF7\u91CD\u8BD5"));
  toast("\u666F\u70B9\u4ECB\u7ECD\u5DF2\u5220\u9664\u3002");
  await renderAccountScenes();
  await refreshAdminDashboard();
};
window.accountShowSceneDiff = async function(name) {
  try {
    const { response, data } = await localService.listScenicRevisions(name);
    if (!response.ok || !data?.ok) throw new Error(data?.message || "\u65E0\u6CD5\u8BFB\u53D6\u7F16\u8F91\u8BB0\u5F55");
    el("sceneDiffTitle").textContent = `${name} \xB7 \u7F16\u8F91\u8BB0\u5F55`;
    const revisions = data.revisions || [];
    el("sceneDiffList").innerHTML = revisions.length ? revisions.map((item) => `
            <div class="archive-item">
              <div class="archive-item-head">
                <span>v${escapeHtml(item.version || 1)} \xB7 ${escapeHtml(routeTime(item.createdAt))}</span>
                <span class="cloud-save-state">${escapeHtml(item.editedByEmail || "\u672A\u77E5")}</span>
              </div>
              ${item.changeNote ? `<div class="archive-item-sub">${escapeHtml(item.changeNote)}</div>` : ""}
              <div class="diff-list">
                ${(item.diff || []).map((line) => `<div class="diff-line ${escapeAttr(line.type === "add" ? "add" : line.type === "remove" ? "remove" : "")}">${escapeHtml(line.type === "add" ? "+ " : line.type === "remove" ? "- " : "  ")}${escapeHtml(line.text || "")}</div>`).join("")}
              </div>
            </div>
          `).join("") : '<div class="account-empty">\u8FD8\u6CA1\u6709\u7F16\u8F91\u8BB0\u5F55\u3002</div>';
    dialogs.open("sceneDiffModal");
  } catch (error) {
    toast("\u8BFB\u53D6\u7F16\u8F91\u8BB0\u5F55\u5931\u8D25\uFF1A" + error.message);
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
async function buildVideoData({ routeData = route, segmentData = segmentResults, mapLayer = currentMapLayer } = {}) {
  const exportRoute = normalizeRoute(structuredClone(routeData));
  const exportSegments = structuredClone(segmentData || []);
  if (exportRoute.presentation.weather || exportRoute.presentation.elevation) {
    await pointInfo.refresh(exportRoute, { silent: true });
  }
  if (exportRoute.presentation.weather) {
    const missingWeather = exportRoute.days.some((day, dayIndex) => {
      const readyCount = getDayPoints(day).filter((item) => isPointReady(item.point)).length;
      const cachedDay = exportRoute.pointInfoCache?.days?.[dayIndex];
      const info = cachedDay?.points || [];
      const expectedDate = window.MapPresentation.addDays(exportRoute.presentation.startDate, dayIndex);
      return readyCount > 0 && (cachedDay?.geoSignature !== geoSignature(day) || cachedDay?.date !== expectedDate || info.length < readyCount || info.slice(0, readyCount).some((item) => !item?.weather || item.weather.date !== expectedDate));
    });
    if (missingWeather) {
      const continueWithoutWeather = await feedback.appConfirm({
        title: "\u5929\u6C14\u4E0D\u53EF\u7528",
        message: "\u5929\u6C14\u6570\u636E\u6682\u65F6\u4E0D\u53EF\u7528\u3002\u662F\u5426\u4E0D\u542B\u5929\u6C14\u7EE7\u7EED\u5BFC\u51FA\uFF1F"
      });
      if (!continueWithoutWeather) return null;
      exportRoute.presentation.weather = false;
    }
  }
  for (let dayIndex = 0; dayIndex < exportRoute.days.length; dayIndex += 1) {
    const day = exportRoute.days[dayIndex];
    const expected = Math.max(0, getDayPoints(day).filter((item) => isPointReady(item.point)).length - 1);
    if (!exportSegments[dayIndex]) exportSegments[dayIndex] = { segments: [] };
    if (exportSegments[dayIndex].segments?.length >= expected) continue;
    exportSegments[dayIndex] = { segments: routeMap.isReady() ? await routeMap.calculateDaySegments(day) : [] };
  }
  return videoDataBuilder.build({
    route: exportRoute,
    segmentResults: exportSegments,
    currentMapLayer: mapLayer,
    presentation: exportRoute.presentation,
    pointInfo: exportRoute.pointInfoCache,
    ensureScenicInfo
  });
}
function openExportConfigModal() {
  if (!localService.capabilities?.serverExport) {
    exportCurrentRoute();
    return;
  }
  const layer = currentMapLayer;
  document.querySelectorAll('input[name="exportMapLayer"]').forEach((input) => {
    input.checked = input.value === layer;
  });
  el("exportHillshade").checked = true;
  el("exportRouteFacts").checked = true;
  el("exportWeather").checked = route?.presentation?.weather === true;
  el("exportElevation").checked = route?.presentation?.elevation === true;
  if (dialogs) dialogs.open("exportConfigModal");
}
function bindExportConfigControls() {
  const ok = el("exportConfigOkBtn");
  if (ok) ok.onclick = () => {
    const layer = document.querySelector('input[name="exportMapLayer"]:checked')?.value || "standard";
    const override = {
      mapLayer: layer,
      hillshade: el("exportHillshade").checked,
      routeFacts: el("exportRouteFacts").checked,
      weather: el("exportWeather").checked,
      elevation: el("exportElevation").checked
    };
    if (dialogs) dialogs.close("exportConfigModal");
    exportCurrentRoute({ override });
  };
}
async function exportCurrentRoute({ renderVideo = true, override = null } = {}) {
  if (!localService.capabilities?.serverExport) {
    downloadCurrentRoute();
    return;
  }
  if (busyActions.has("export-route")) {
    startExportTaskPolling({ open: true });
    return toast("\u6B63\u5728\u5BFC\u51FA\uFF0C\u8BF7\u70B9\u51FB\u53F3\u4FA7\u4EFB\u52A1\u6761\u67E5\u770B\u8FDB\u5EA6\u3002");
  }
  busyActions.add("export-route");
  const routeSnapshot = getEditableRoute(route);
  if (override) routeSnapshot.presentation = window.MapPresentation.normalize({ ...routeSnapshot.presentation, ...override });
  const segmentSnapshot = structuredClone(segmentResults || []);
  const mapLayerSnapshot = currentMapLayer;
  const configSnapshot = {
    key: window.AMAP_PLANNER_CONFIG?.key || "",
    securityJsCode: window.AMAP_PLANNER_CONFIG?.securityJsCode || ""
  };
  const restoreButton = setButtonBusy("exportBtn", true, "\u5BFC\u51FA\u4E2D");
  let serverRequestStarted = false;
  try {
    saveRoute(false);
    renderExportTaskDock({ rendering: true, progress: { active: true, phase: "prepare", message: "\u6B63\u5728\u6574\u7406\u5BFC\u51FA\u6570\u636E\u2026", percent: 2 } }, { keepVisible: true });
    const videoData = await buildVideoData({
      routeData: routeSnapshot,
      segmentData: segmentSnapshot,
      mapLayer: mapLayerSnapshot
    });
    if (!videoData) return;
    routeSnapshot.presentation = structuredClone(videoData.presentation);
    const exportRequest = localService.exportRoute({
      routeData: routeSnapshot,
      videoData,
      renderVideo,
      mapLayer: mapLayerSnapshot,
      config: configSnapshot
    });
    serverRequestStarted = true;
    startExportTaskPolling({ open: false });
    const { response, data: result } = await exportRequest;
    if (response.status === 409 && result?.code === "EXPORT_RUNNING") {
      renderExportTaskDock({ rendering: true, progress: result.progress || {} }, { keepVisible: true });
      startExportTaskPolling({ open: true });
      toast("\u5DF2\u6709\u5BFC\u51FA\u4EFB\u52A1\u6B63\u5728\u540E\u53F0\u8FDB\u884C\u3002");
      return;
    }
    if (response.status === 409 && result?.code === "EXPORT_CANCELLED") {
      toast("\u5BFC\u51FA\u5DF2\u7EC8\u6B62\u3002");
      return;
    }
    if (!response.ok || !result.ok) throw new Error(result.message || "\u5BFC\u51FA\u5931\u8D25");
    if (result.queued) {
      startExportTaskPolling({
        open: false,
        taskId: result.taskId,
        onDone: async (state) => {
          try {
            await refreshArchivedRoutes({ force: true });
          } catch (error) {
            toast("\u5BFC\u51FA\u5DF2\u5B8C\u6210\uFF0C\u4F46\u8DEF\u7EBF\u5E93\u5237\u65B0\u5931\u8D25\uFF1A" + error.message);
            return;
          }
          const resultSummary = state?.result || {};
          if (state?.progress?.error) {
            toast("\u540E\u53F0\u5BFC\u51FA\u672A\u5B8C\u6574\u5B8C\u6210\uFF1A" + state.progress.error);
            return;
          }
          const parts2 = ["JSON", "MD", resultSummary.routeMapImage ? "PNG" : null, resultSummary.manualPdf ? "PDF" : null, resultSummary.output ? "MP4" : null].filter(Boolean).join(" + ");
          const warnings2 = [
            resultSummary.videoError ? `\u89C6\u9891\u5931\u8D25\uFF1A${resultSummary.videoError}` : null,
            resultSummary.pdfError ? `PDF \u5931\u8D25\uFF1A${resultSummary.pdfError}` : null,
            resultSummary.routeMapError ? `PNG \u5931\u8D25\uFF1A${resultSummary.routeMapError}` : null,
            resultSummary.assetUploadError ? `\u8D44\u4EA7\u4E0A\u4F20\u5931\u8D25\uFF1A${resultSummary.assetUploadError}` : null
          ].filter(Boolean).join("\uFF1B");
          toast(warnings2 ? `\u540E\u53F0\u5BFC\u51FA\u5B8C\u6210\uFF1A${parts2 || "\u57FA\u7840\u6587\u4EF6"}\uFF08${warnings2}\uFF09` : `\u540E\u53F0\u5BFC\u51FA\u5B8C\u6210\uFF1A${parts2 || "\u57FA\u7840\u6587\u4EF6"}`);
        }
      });
      toast("\u5B8C\u6574\u4EA7\u54C1\u5DF2\u4EA4\u7ED9\u670D\u52A1\u5668\u540E\u53F0\u6E32\u67D3\uFF0C\u53EF\u7EE7\u7EED\u7F16\u8F91\u8DEF\u7EBF\u3002");
      return;
    }
    let refreshError = null;
    try {
      await refreshArchivedRoutes();
    } catch (error) {
      refreshError = error;
    }
    const parts = ["JSON", "MD", result.routeMapImage ? "PNG" : null, result.manualPdf ? "PDF" : null, result.output ? "MP4" : null].filter(Boolean).join(" + ");
    const routeManageStatus = el("routeManageStatus");
    if (routeManageStatus) {
      routeManageStatus.textContent = `\u5DF2\u5BFC\u51FA\u5230\uFF1A${result.dir}${result.routeMapImage ? "\uFF1BPNG\uFF1A" + result.routeMapImage : ""}${result.manualPdf ? "\uFF1BPDF\uFF1A" + result.manualPdf : ""}${result.videoError ? "\uFF1B\u89C6\u9891\u8B66\u544A\uFF1A" + result.videoError : ""}${result.routeMapError ? "\uFF1BPNG \u8B66\u544A\uFF1A" + result.routeMapError : ""}${result.pdfError ? "\uFF1BPDF \u8B66\u544A\uFF1A" + result.pdfError : ""}`;
    }
    const warnings = [
      result.videoError ? `\u89C6\u9891\u5931\u8D25\uFF1A${result.videoError}` : null,
      result.pdfError ? `PDF \u5931\u8D25\uFF1A${result.pdfError}` : null,
      result.routeMapError ? `PNG \u5931\u8D25\uFF1A${result.routeMapError}` : null
    ].filter(Boolean).join("\uFF1B");
    toast(warnings ? `\u5DF2\u5BFC\u51FA ${parts}\uFF08${warnings}\uFF09` : `\u5DF2\u5BFC\u51FA\uFF1A${parts}`);
    if (refreshError) toast("\u5BFC\u51FA\u5DF2\u5B8C\u6210\uFF0C\u4F46\u8DEF\u7EBF\u5E93\u540C\u6B65\u5931\u8D25\uFF1A" + refreshError.message);
  } catch (error) {
    if (!serverRequestStarted) {
      renderExportTaskDock({ progress: { phase: "idle" } });
    } else {
      renderExportTaskDock({ rendering: false, progress: { active: false, done: true, error: error.message, phase: "error", message: "\u5BFC\u51FA\u5931\u8D25", percent: 100 } }, { keepVisible: true });
      startExportTaskPolling({ open: true });
    }
    toast("\u5BFC\u51FA\u5931\u8D25\uFF1A" + error.message);
  } finally {
    restoreButton();
    busyActions.delete("export-route");
  }
}
function downloadCurrentRoute() {
  saveRoute(false);
  const content = JSON.stringify(getEditableRoute(route), null, 2);
  const blob = new Blob([content], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const safeName = (cleanRouteName(route.name) || "road-trip-route").replace(/[\\/:*?"<>|]+/g, "-");
  anchor.href = url;
  anchor.download = `${safeName}.route.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  toast("\u8DEF\u7EBF JSON \u5DF2\u4E0B\u8F7D\u3002PDF \u548C\u89C6\u9891\u53EF\u5728\u672C\u5730\u9AD8\u7EA7\u7248\u751F\u6210\u3002");
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
      (seg.path || []).forEach(([lng, lat]) => {
        lngs.push(lng);
        lats.push(lat);
      });
    });
    day.points.forEach((p) => {
      lngs.push(p.lng);
      lats.push(p.lat);
    });
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
    el("exportBtn").textContent = "\u4E0B\u8F7D";
    el("exportBtn").title = "\u4E0B\u8F7D\u5F53\u524D\u8DEF\u7EBF JSON";
  }
  if (localService.capabilities?.editableMapConfig === false) {
    if (el("mapPlaceholder")) {
      const title = el("mapPlaceholder").querySelector("strong");
      const copy = el("mapPlaceholder").querySelector("p");
      if (title) title.textContent = "\u5730\u56FE\u670D\u52A1\u672A\u5C31\u7EEA";
      if (copy) copy.textContent = "\u5730\u56FE\u7531\u7AD9\u70B9\u7EDF\u4E00\u914D\u7F6E\uFF0C\u5237\u65B0\u540E\u4ECD\u4E0D\u53EF\u7528\u65F6\u8BF7\u8054\u7CFB\u7AD9\u70B9\u7BA1\u7406\u5458\u3002";
    }
  }
  if (localService.capabilities?.cloudRoutes) el("routeSelect").title = "\u9009\u62E9\u5F53\u524D\u8D26\u6237\u4E0B\u7684\u8DEF\u7EBF";
  renderAll(false);
}
async function startApp() {
  bootstrapUiWithoutMap();
  communityController.refreshSelfProfile().catch(() => {
  });
  setLoading("\u5730\u56FE\u52A0\u8F7D\u4E2D", { percent: 10 });
  if (location.protocol === "file:") {
    const up = await ensureServiceOrExplain();
    if (up) {
      location.href = "http://127.0.0.1:6137/";
      return;
    }
    openSetupOverlay("\u8BF7\u5148\u53CC\u51FB\u6839\u76EE\u5F55 start.bat \u542F\u52A8\u672C\u5730\u670D\u52A1\u3002\u4EC5\u76F4\u63A5\u6253\u5F00 app/web/index.html \u65F6\u65E0\u6CD5\u8BFB\u53D6 data/routes/ \u4E0E\u672C\u5730\u5BC6\u94A5\u3002");
    el("mapPlaceholder").classList.add("show");
    el("mapPlaceholder").innerHTML = '<strong>\u9700\u8981\u672C\u5730\u670D\u52A1</strong><p>\u8BF7\u5148\u8FD0\u884C\u6839\u76EE\u5F55 <code>start.bat</code>\uFF0C\u6D4F\u89C8\u5668\u4F1A\u6253\u5F00 http://127.0.0.1:6137 \u3002\u542F\u52A8\u540E\u81EA\u52A8\u52A0\u8F7D\u5730\u56FE\u5E76\u626B\u63CF data/routes/\u3002</p><button class="primary" id="retryServerBtn">\u6211\u5DF2\u542F\u52A8\uFF0C\u91CD\u8BD5</button>';
    const retry = el("retryServerBtn");
    if (retry) retry.onclick = () => location.reload();
    return;
  }
  const remote = await loadConfigFromServer();
  setLoading("\u5730\u56FE\u52A0\u8F7D\u4E2D", { percent: 30 });
  if (remote?.configured && remote.key && remote.securityJsCode) {
    localStorage.setItem("amap-planner-config", JSON.stringify({ key: remote.key, securityJsCode: remote.securityJsCode }));
    window.AMAP_PLANNER_CONFIG = { key: remote.key, securityJsCode: remote.securityJsCode };
    window._AMapSecurityConfig = { securityJsCode: remote.securityJsCode };
  }
  if (!hasAmapConfig()) {
    hideLoading();
    if (runtime.isAdmin) {
      openSetupOverlay("\u9996\u6B21\u4F7F\u7528\uFF0C\u8BF7\u914D\u7F6E\u9AD8\u5FB7 Web JS API Key \u4E0E\u5B89\u5168\u5BC6\u94A5\u3002");
    } else {
      showMapLoadFailure("\u7BA1\u7406\u5458\u5C1A\u672A\u5B8C\u6210\u5730\u56FE\u914D\u7F6E\u3002");
    }
    return;
  }
  try {
    el("mapPlaceholder")?.classList.remove("show");
    setLoading("\u5730\u56FE\u52A0\u8F7D\u4E2D", { percent: 68 });
    await loadAmap();
    setLoading("\u5730\u56FE\u52A0\u8F7D\u4E2D", { percent: 88 });
    await initMap();
    setLoading("\u5730\u56FE\u52A0\u8F7D\u4E2D", { percent: 100 });
    setTimeout(hideLoading, 180);
    const snapshotToken = new URLSearchParams(location.search).get("snapshot");
    if (snapshotToken) {
      document.body.classList.add("snapshot-mode");
      try {
        const resp = await fetch(`/api/v1/routes/snapshot/${encodeURIComponent(snapshotToken)}`);
        const data = await resp.json();
        if (resp.ok && data?.ok && data.route) {
          routeBook = routeStore.load();
          route = routeStore.upsert(routeBook, data.route);
          routeBook.activeRouteId = route.id;
          routeStore.save(routeBook);
          if (Array.isArray(data.segmentResults)) segmentResults = data.segmentResults;
          hideLoading();
          renderAll(true);
          setTimeout(() => {
            try { routeMap.isReady() && routeMap.refreshLabels?.(); } catch (_) {}
            window.__snapshotReady = true;
          }, 1200);
        } else {
          window.__snapshotReady = false;
        }
      } catch (_) {
        window.__snapshotReady = false;
      }
      return;
    }
    refreshArchivedRoutes({ autoSelectFirst: isMostlyBlankRoute(route) }).then(() => {
      applyCachedSegmentResults(route);
      renderAll(false);
      scheduleBackgroundRouteCalculation();
    }).catch((error) => toast("\u8DEF\u7EBF\u5E93\u540C\u6B65\u5931\u8D25\uFF1A" + error.message));
  } catch (error) {
    hideLoading();
    const targetDomain = localService.capabilities?.mode === "cloud" ? location.hostname : "127.0.0.1 / localhost";
    showMapLoadFailure((error && error.message ? error.message + "\u3002" : "") + `\u8BF7\u68C0\u67E5\u7F51\u7EDC${runtime.isAdmin ? `\u3001Key\u3001\u5B89\u5168\u5BC6\u94A5\u548C\u57DF\u540D\u767D\u540D\u5355\uFF08${targetDomain}\uFF09` : "\uFF0C\u6216\u8054\u7CFB\u7BA1\u7406\u5458"}\u3002`);
    toast("\u5730\u56FE\u52A0\u8F7D\u5931\u8D25");
  }
}
startApp();
