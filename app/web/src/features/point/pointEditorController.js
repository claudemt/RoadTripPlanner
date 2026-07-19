(function () {
  function create({
    el,
    routeMap,
    getDayPoints,
    fixed,
    toast,
    scenicController,
    placeSearch,
    getRoute,
    setView,
    clearSegments,
    renderAll,
    renderDaySelect,
    setTab,
    onChanged
  }) {
    let context = null;
    let importedScenic = false;
    const transportModes = ['drive', 'ride', 'walk'];

    function normalizeTransportMode(value) {
      return window.RouteModel?.normalizeTransportMode?.(value) || 'drive';
    }

    function setTransportMode(value) {
      const mode = normalizeTransportMode(value);
      document.querySelectorAll('[data-point-transport]').forEach((button) => {
        button.classList.toggle('active', button.dataset.pointTransport === mode);
      });
      const input = el('pointTransportMode');
      if (input) input.value = mode;
    }

    function readTransportMode() {
      return normalizeTransportMode(el('pointTransportMode')?.value);
    }

    function shouldShowTransport(nextContext) {
      return !(nextContext?.mode === 'replace' && nextContext?.kind === 'from');
    }

    function parseLngLat(value) {
      const parts = String(value).split(',').map((item) => Number(item.trim()));
      if (parts.length !== 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return null;
      return {lng: parts[0], lat: parts[1]};
    }

    function setScenicVersion(spot) {
      const version = Number(spot?.version || 0);
      if (el('pointScenicVersion')) {
        el('pointScenicVersion').textContent = version
          ? `库中最新版 v${version}，发布后为 v${version + 1}`
          : '库中暂无介绍，发布后为 v1';
      }
      if (el('pointPublishScenicLabel')) {
        el('pointPublishScenicLabel').textContent = version
          ? `发布为 v${version + 1}`
          : '发布为 v1';
      }
    }

    async function importScenicFromLibrary(name) {
      const targetName = String(name || el('pointName')?.value || el('pointSearchInput')?.value || '').trim();
      if (!targetName) return toast('请先选择或输入地点名称。');
      try {
        const spot = await scenicController.getLibraryInfo(targetName);
        setScenicVersion(spot);
        if (!spot) {
          el('pointScenicDescription').value = '';
          toast('库中暂时没有这个景点介绍。');
          return null;
        }
        el('pointScenicDescription').value = spot.description || '';
        importedScenic = true;
        toast(`已导入库中最新版 v${spot.version || 1}。`);
        return spot;
      } catch (error) {
        toast('导入景点介绍失败：' + error.message);
        return null;
      }
    }

    function open(nextContext) {
      context = nextContext;
      const day = getRoute().days[nextContext.dayIndex];
      if (!day) return;
      setView(String(nextContext.dayIndex));
      let title = '选择地点';
      let point = null;
      if (nextContext.mode === 'replace') {
        point = nextContext.kind === 'from'
          ? day.from
          : nextContext.kind === 'to'
            ? day.to
            : day.waypoints[nextContext.waypointIndex];
        title = nextContext.kind === 'from'
          ? '修改当天起点'
          : nextContext.kind === 'to'
            ? '修改当天终点/住宿点'
            : '修改途径点';
      } else if (nextContext.mode === 'insertAfter') {
        title = '在当前点后添加途径点';
      } else {
        title = '添加途径点';
      }
      el('pointModalTitle').textContent = title;
      el('pointSearchInput').value = '';
      el('pointName').value = point?.name || '';
      el('pointLngLat').value = point ? `${fixed(point.lng)},${fixed(point.lat)}` : '';
      el('pointTransportSection')?.toggleAttribute('hidden', !shouldShowTransport(nextContext));
      setTransportMode(point?.transportMode || 'drive');
      el('pointScenicDescription').value = '';
      importedScenic = false;
      el('pointScenicImages').value = '';
      if (el('pointPublishScenic')) el('pointPublishScenic').checked = false;
      setScenicVersion(null);
      scenicController.updateImageList();
      if (point?.name) {
        scenicController.getLibraryInfo(point.name).then((spot) => {
          if (!context) return;
          setScenicVersion(spot);
        }).catch(() => {});
      }
      placeSearch.closeSuggestions();
      renderDaySelect();
      setTab('routePanel');
      el('pointModal').classList.add('open');
      setTimeout(() => el('pointSearchInput').focus(), 50);
    }

    function close() {
      el('pointModal').classList.remove('open');
      context = null;
    }

    async function confirm() {
      if (!context) return;
      const lnglat = parseLngLat(el('pointLngLat').value);
      if (!lnglat) return toast('请先从地图匹配项中选择地点，或手动填入 lng,lat。');
      const point = {
        name: el('pointName').value.trim() || el('pointSearchInput').value.trim() || '未命名点位',
        lng: lnglat.lng,
        lat: lnglat.lat,
        transportMode: shouldShowTransport(context) ? readTransportMode() : 'drive'
      };
      const currentContext = context;
      const day = getRoute().days[currentContext.dayIndex];
      if (!day) return;
      if (currentContext.mode === 'replace') {
        if (currentContext.kind === 'from') day.from = point;
        else if (currentContext.kind === 'to') day.to = point;
        else day.waypoints[currentContext.waypointIndex] = point;
      } else if (currentContext.mode === 'insertAfter') {
        const insertAt = currentContext.afterKind === 'from' ? 0 : currentContext.waypointIndex + 1;
        day.waypoints.splice(insertAt, 0, point);
      } else {
        day.waypoints.push(point);
      }
      try {
        const scenic = await scenicController.saveFromEditor(point, {importFromLibrary: importedScenic});
        if (scenic) {
          toast(scenic.spot
            ? `景点介绍已发布为 v${scenic.spot.version || scenic.version || ''}。`
            : '景点介绍已保存到我的景点。');
        }
      } catch (error) {
        return toast('景点介绍保存失败：' + error.message);
      }
      clearSegments();
      setView(String(currentContext.dayIndex));
      close();
      renderAll(true);
      if (onChanged) onChanged();
      toast('已更新点位。点击“计算路线”刷新时间和距离。');
    }

    async function testPointInContext(testContext, point) {
      const day = getRoute().days[testContext.dayIndex];
      if (!day) return {ok: false, message: '没有找到当天行程'};
      const points = getDayPoints(day).map((item) => ({...item.point}));
      let index = testContext.pointIndex;
      if (testContext.mode === 'replace') {
        index = testContext.kind === 'from'
          ? 0
          : testContext.kind === 'to'
            ? points.length - 1
            : testContext.waypointIndex + 1;
        points[index] = point;
      } else if (testContext.mode === 'insertAfter') {
        index = testContext.afterKind === 'from' ? 1 : testContext.waypointIndex + 2;
        points.splice(index, 0, point);
      } else if (testContext.mode === 'appendWaypoint') {
        index = points.length - 1;
        points.splice(index, 0, point);
      }
      const checks = [];
      if (index > 0) checks.push([points[index - 1], points[index]]);
      if (index < points.length - 1) checks.push([points[index], points[index + 1]]);
      if (!checks.length) return {ok: true};
      for (const [from, to] of checks) {
        try {
          const mode = normalizeTransportMode(to.transportMode);
          await routeMap.route(from, to, mode);
        } catch (_) {
          return {
            ok: false,
            message: `${from.name} → ${to.name} 无可用路线。建议点“改”，从地图匹配项中重新选一个更准确的 POI。`
          };
        }
      }
      return {ok: true};
    }

    async function testModalPoint() {
      if (!context) return toast('请先从某一天的“改/后加/添加途径点”进入。');
      let lnglat = parseLngLat(el('pointLngLat').value);
      if (!lnglat) {
        const keyword = el('pointSearchInput').value.trim() || el('pointName').value.trim();
        if (!keyword) return toast('请先输入地点。');
        try {
          const resolved = await placeSearch.resolveByKeyword(keyword);
          placeSearch.setPointForm(resolved.name, resolved.lng, resolved.lat);
          lnglat = {lng: resolved.lng, lat: resolved.lat};
        } catch (error) {
          return toast('地点识别失败：' + error.message);
        }
      }
      const point = {
        name: el('pointName').value.trim() || el('pointSearchInput').value.trim() || '测试点位',
        lng: lnglat.lng,
        lat: lnglat.lat,
        transportMode: shouldShowTransport(context) ? readTransportMode() : 'drive'
      };
      const result = await testPointInContext(context, point);
      toast(result.ok ? '测试通过：该地点可参与相邻路线规划。' : '测试失败：' + result.message);
    }

    async function testExistingPoint(dayIndex, pointIndex) {
      const points = getDayPoints(getRoute().days[dayIndex]).map((item) => item.point);
      const point = points[pointIndex];
      const result = await testPointInContext({mode: 'existing', dayIndex, pointIndex}, point);
      toast(result.ok ? `测试通过：${point.name}` : `测试失败：${point.name}；${result.message}`);
    }

    return {
      parseLngLat,
      setTransportMode,
      open,
      close,
      confirm,
      importScenicFromLibrary,
      testModalPoint,
      testExistingPoint
    };
  }

  window.PointEditorController = {create};
})();
