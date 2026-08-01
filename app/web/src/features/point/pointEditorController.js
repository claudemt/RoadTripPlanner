(function () {
  function create({
    el,
    fixed,
    toast,
    scenicController,
    placeSearch,
    getRoute,
    setView,
    clearSegments,
    renderAll,
    renderDaySelect,
    onChanged
  }) {
    let context = null;
    let lastFilledName = null;
    let prefilledDescription = '';
    let prefilledImages = [];

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

    function autoFillScenic(name) {
      const cleanName = String(name || '').trim();
      if (!cleanName || !context) return;
      if (el('pointUseScenic') && !el('pointUseScenic').checked) return;
      if (cleanName === lastFilledName) return;
      lastFilledName = cleanName;
      scenicController.ensureInfo(cleanName).then((spot) => {
        if (!context) return;
        scenicController.setPreviewImages(spot?.images || []);
        el('pointScenicDescription').value = spot?.description || '';
        prefilledDescription = spot?.description || '';
        prefilledImages = spot?.images || [];
        scenicController.updateImageList();
      }).catch(() => {});
    }

    function onUseScenicChange() {
      if (el('pointUseScenic')?.checked) return;
      el('pointScenicDescription').value = '';
      scenicController.setPreviewImages([]);
      scenicController.updateImageList();
      lastFilledName = null;
      prefilledDescription = '';
      prefilledImages = [];
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
      }
      el('pointModalTitle').textContent = title;
      el('pointSearchInput').value = '';
      el('pointName').value = point?.name || '';
      el('pointLngLat').value = point ? `${fixed(point.lng)},${fixed(point.lat)}` : '';
      el('pointTransportSection')?.toggleAttribute('hidden', !shouldShowTransport(nextContext));
      setTransportMode(point?.transportMode || 'drive');
      el('pointScenicDescription').value = '';
      el('pointScenicImages').value = '';
      if (el('pointUseScenic')) el('pointUseScenic').checked = point?.useScenic !== false;
      lastFilledName = null;
      prefilledDescription = '';
      prefilledImages = [];
      scenicController.setPreviewImages([]);
      scenicController.updateImageList();
      if (point?.name && point.useScenic !== false) {
        autoFillScenic(point.name);
      }
      placeSearch.closeSuggestions();
      renderDaySelect();
      el('pointModal').classList.remove('closing');
      el('pointModal').classList.add('open');
      setTimeout(() => el('pointSearchInput').focus(), 50);
    }

    function close() {
      el('pointModal').classList.remove('open');
      context = null;
      lastFilledName = null;
      prefilledDescription = '';
      prefilledImages = [];
      scenicController.setPreviewImages([]);
      scenicController.updateImageList();
    }

    async function confirm() {
      if (!context) return;
      let lnglat = parseLngLat(el('pointLngLat').value);
      if (!lnglat) {
        const keyword = el('pointName').value.trim() || el('pointSearchInput').value.trim();
        if (!keyword) return toast('请先输入地点，或从地图匹配项中选择。');
        try {
          const resolved = await placeSearch.resolveByKeyword(keyword);
          placeSearch.setPointForm(resolved.name, resolved.lng, resolved.lat);
          lnglat = {lng: resolved.lng, lat: resolved.lat};
        } catch (error) {
          return toast('地点识别失败：' + error.message);
        }
      }
      const point = {
        name: el('pointName').value.trim() || el('pointSearchInput').value.trim() || '未命名点位',
        lng: lnglat.lng,
        lat: lnglat.lat,
        transportMode: shouldShowTransport(context) ? readTransportMode() : 'drive',
        useScenic: el('pointUseScenic')?.checked !== false
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
        return toast('无法识别这个点位编辑操作。');
      }
      try {
        const scenic = point.useScenic
          ? await scenicController.saveFromEditor(point, {
            prefilledDescription,
            prefilledImages
          })
          : null;
        if (scenic) {
          toast('景点介绍已保存到我的景点。');
        }
      } catch (error) {
        return toast('景点介绍保存失败：' + error.message);
      }
      clearSegments();
      setView(String(currentContext.dayIndex));
      close();
      renderAll(true);
      if (onChanged) onChanged();
      toast('已更新点位。点“刷新”更新时间和距离。');
    }

    return {
      setTransportMode,
      open,
      close,
      confirm,
      autoFillScenic,
      onUseScenicChange
    };
  }

  window.PointEditorController = {create};
})();
