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
    refreshPointNames,
    onChanged,
    onNamesChanged,
    requestChangeNote,
    onSpotSaved
  }) {
    let context = null;
    let lastFilledName = null;
    let prefilledDescription = '';
    let prefilledImages = [];
    let busy = false;

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

    function setBusy(nextBusy, label = '处理中…') {
      busy = Boolean(nextBusy);
      const confirmBtn = el('pointConfirmBtn');
      if (confirmBtn) {
        confirmBtn.disabled = busy;
        confirmBtn.textContent = busy ? label : '确定';
      }
      const cancelBtn = el('pointCancelBtn');
      if (cancelBtn) cancelBtn.disabled = busy;
      const closeBtn = el('pointModalClose');
      if (closeBtn) closeBtn.disabled = busy;
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
      scenicController.resetEditorImages();
      scenicController.updateImageList();
      lastFilledName = null;
      prefilledDescription = '';
      prefilledImages = [];
    }

    function open(nextContext) {
      context = nextContext;
      const day = getRoute().days[nextContext.dayIndex];
      if (!day) return;
      setBusy(false);
      setStatus('');
      setView(String(nextContext.dayIndex));
      let title = '选择地点';
      let point = null;
      if (nextContext.mode === 'replace') {
        point = nextContext.kind === 'from'
          ? day.from
          : nextContext.kind === 'to'
            ? day.to
            : day.waypoints[nextContext.waypointIndex];
        nextContext.previousName = point?.name || '';
        nextContext.previousPoint = point
          ? { lng: Number(point.lng), lat: Number(point.lat), transportMode: normalizeTransportMode(point.transportMode), name: point.name }
          : null;
        title = nextContext.kind === 'from'
          ? '修改当天起点'
          : nextContext.kind === 'to'
            ? '修改当天终点'
            : '修改途径点';
      } else if (nextContext.mode === 'insertAfter') {
        title = '在当前点后添加途径点';
      }
      el('pointModalTitle').textContent = title;
      el('pointSearchRow').hidden = false;
      el('pointNameLabel').textContent = '地点昵称';
      el('pointName').placeholder = '可选，如：老李家的客栈';
      el('pointUseScenicRow').hidden = false;
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
      scenicController.resetEditorImages();
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

    function openSpot({sceneId = '', name = '', originalName = '', description = '', images = [], sceneMode = 'private'} = {}) {
      const mode = sceneMode === 'public' ? 'public' : 'private';
      context = {
        mode: 'spot',
        sceneMode: mode,
        sceneId: sceneId || '',
        originalName: originalName || name || ''
      };
      setBusy(false);
      setStatus('');
      el('pointModalTitle').textContent = mode === 'public'
        ? '编辑公共景点介绍'
        : (sceneId || name ? '编辑景点介绍' : '新建景点介绍');
      el('pointSearchRow').hidden = true;
      el('pointSearchInput').value = '';
      el('pointNameLabel').textContent = '景点名称';
      el('pointName').placeholder = '例如：天水古城';
      el('pointName').value = name || '';
      el('pointLngLat').value = '';
      el('pointTransportSection')?.setAttribute('hidden', '');
      el('pointUseScenicRow').hidden = true;
      if (el('pointUseScenic')) el('pointUseScenic').checked = true;
      el('pointScenicDescription').value = description || '';
      el('pointScenicImages').value = '';
      lastFilledName = null;
      prefilledDescription = description || '';
      prefilledImages = images || [];
      scenicController.setPreviewImages(images || []);
      scenicController.updateImageList();
      placeSearch.closeSuggestions();
      el('pointModal').classList.remove('closing');
      el('pointModal').classList.add('open');
      setTimeout(() => el('pointName').focus(), 60);
    }

    async function confirmSpot() {
      const currentContext = context;
      const rawName = el('pointName').value.trim();
      if (!rawName) return toast('请先填写景点名称。');
      const description = el('pointScenicDescription').value.trim();
      setBusy(true, '识别名称…');
      let resolvedName = rawName;
      try {
        const resolved = await placeSearch.resolveByKeyword(rawName);
        if (resolved?.name) resolvedName = resolved.name;
      } catch (_) {
        resolvedName = rawName;
      }
      let changeNote = '';
      if (currentContext.sceneMode === 'public' && typeof requestChangeNote === 'function') {
        setBusy(false);
        const defaultNote = currentContext.originalName && currentContext.originalName !== resolvedName
          ? `调整名称：${currentContext.originalName} -> ${resolvedName}`
          : '修正公共景点介绍';
        const note = await requestChangeNote(defaultNote);
        if (note === null || note === undefined) return;
        changeNote = String(note || '');
      }
      setBusy(true, '保存中…');
      setStatus('正在保存…');
      let result;
      try {
        result = await scenicController.saveSpotFromEditor({
          sceneMode: currentContext.sceneMode,
          sceneId: currentContext.sceneId,
          originalName: currentContext.originalName,
          name: resolvedName,
          description,
          changeNote
        });
      } catch (error) {
        setBusy(false);
        setStatus('保存失败：' + error.message, {error: true});
        return;
      }
      close();
      if (onSpotSaved) {
        try {
          await onSpotSaved(result, currentContext);
        } catch (error) {
          toast('保存成功，但刷新列表失败：' + error.message);
        }
      }
    }

    function setStatus(message = '', {error = false} = {}) {
      const node = el('pointModalStatus');
      if (!node) return;
      const text = String(message || '');
      node.textContent = text;
      node.hidden = !text;
      node.classList.toggle('is-error', Boolean(text) && error);
    }

    function close() {
      el('pointModal').classList.remove('open');
      context = null;
      lastFilledName = null;
      prefilledDescription = '';
      prefilledImages = [];
      scenicController.resetEditorImages();
      scenicController.updateImageList();
      setBusy(false);
      setStatus('');
    }

    async function confirm() {
      if (!context || busy) return;
      if (context.mode === 'spot') return confirmSpot();
      let lnglat = parseLngLat(el('pointLngLat').value);
      if (!lnglat) {
        const keyword = el('pointName').value.trim() || el('pointSearchInput').value.trim();
        if (!keyword) return toast('请先输入地点，或从地图匹配项中选择。');
        setBusy(true, '识别地点…');
        try {
          const resolved = await placeSearch.resolveByKeyword(keyword);
          placeSearch.setPointForm(resolved.name, resolved.lng, resolved.lat);
          lnglat = {lng: resolved.lng, lat: resolved.lat};
        } catch (error) {
          setBusy(false);
          return toast('地点识别失败：' + error.message);
        }
      }
      const currentContext = context;
      const day = getRoute().days[currentContext.dayIndex];
      if (!day) {
        setBusy(false);
        return;
      }
      const point = {
        name: el('pointName').value.trim() || el('pointSearchInput').value.trim() || '未命名点位',
        lng: lnglat.lng,
        lat: lnglat.lat,
        transportMode: shouldShowTransport(currentContext) ? readTransportMode() : 'drive',
        useScenic: el('pointUseScenic')?.checked !== false
      };
      setBusy(true, '保存中…');
      setStatus('正在保存…');
      let savedScenic = false;
      let geometryChanged = true;
      let touchedDays = [currentContext.dayIndex];
      try {
        if (currentContext.mode === 'replace') {
          if (currentContext.kind === 'from') day.from = point;
          else if (currentContext.kind === 'to') day.to = point;
          else day.waypoints[currentContext.waypointIndex] = point;
        } else if (currentContext.mode === 'insertAfter') {
          const insertAt = currentContext.afterKind === 'from' ? 0 : currentContext.waypointIndex + 1;
          day.waypoints.splice(insertAt, 0, point);
        } else {
          setBusy(false);
          return toast('无法识别这个点位编辑操作。');
        }

        const previousName = String(currentContext.previousName || '').trim();
        if (previousName && previousName !== point.name) {

          window.PoiAliasStore?.remember?.({name: previousName, alias: point.name, lng: point.lng, lat: point.lat});
          const synced = window.RouteModel?.syncSamePoiName?.(getRoute(), point, point) || [];
          touchedDays = [...new Set([currentContext.dayIndex, ...synced])];
        }

        const previousPoint = currentContext.previousPoint;
        geometryChanged = !previousPoint
          || Math.abs(previousPoint.lng - point.lng) > 1e-9
          || Math.abs(previousPoint.lat - point.lat) > 1e-9
          || normalizeTransportMode(previousPoint.transportMode) !== point.transportMode;
        const scenic = point.useScenic
          ? await scenicController.saveFromEditor(point, {
            prefilledDescription,
            prefilledImages,
            originalName: previousName
          })
          : null;
        savedScenic = Boolean(scenic);
        if (geometryChanged) {
          setBusy(true, '刷新中…');
          setStatus('正在重新规划路线…');
          clearSegments(currentContext.dayIndex);
          setView(String(currentContext.dayIndex));
          renderAll(true);
          if (onChanged) await onChanged();
        } else {
          setBusy(true, '更新中…');
          setStatus('正在同步…');
          if (refreshPointNames) refreshPointNames(touchedDays);
          renderAll(true);
          if (onNamesChanged) await onNamesChanged();
        }
      } catch (error) {
        setBusy(false);
        setStatus('保存失败：' + error.message, {error: true});
        return;
      }
      close();
      if (!geometryChanged) {
        toast(savedScenic ? '景点介绍已保存' : '点位已更新');
        return;
      }
      toast(savedScenic ? '已保存，路线已刷新' : '点位已更新，路线已刷新');
    }

    return {
      setTransportMode,
      open,
      openSpot,
      close,
      confirm,
      isBusy: () => busy,
      autoFillScenic,
      onUseScenicChange
    };
  }

  window.PointEditorController = {create};
})();
