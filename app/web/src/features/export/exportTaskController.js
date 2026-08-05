(function () {
  function create({el, localService, toast}) {
    let pollingTimer = null;
    let hideTimer = null;
    let dockOpen = false;
    let pollingStartedAt = 0;

    function isActive(state) {
      return Boolean(state?.rendering || state?.progress?.active);
    }

    async function fetchState() {
      const {response, data} = await localService.getExportProgress();
      if (!response.ok || !data?.ok) throw new Error(data?.message || '无法读取导出任务');
      return data;
    }

    function setDockOpen(open) {
      dockOpen = Boolean(open);
      el('exportTaskDock')?.classList.toggle('open', dockOpen);
    }

    function renderDock(state, {keepVisible = false} = {}) {
      const dock = el('exportTaskDock');
      if (!dock) return;
      const progress = state?.progress || {};
      const active = isActive(state);
      const done = Boolean(progress.done || progress.error);
      const visible = active || done || keepVisible;
      dock.hidden = !visible;
      dock.classList.toggle('active', active);
      dock.classList.toggle('error', Boolean(progress.error));
      dock.classList.toggle('done', done && !progress.error);
      if (!visible) {
        setDockOpen(false);
        return;
      }
      const value = Number.isFinite(Number(progress.percent)) ? Math.max(0, Math.min(100, Math.round(Number(progress.percent)))) : 0;
      const percent = value ? `${value}%` : '';
      const message = progress.message || '导出任务正在进行';
      el('exportTaskStatus').textContent = progress.error
        ? `导出失败：${progress.error}`
        : `${message}${percent ? ` · ${percent}` : ''}`;
      el('exportDockHandleText').textContent = active ? (percent || '导出') : progress.error ? '失败' : '完成';
      el('exportDockProgressBar').style.width = `${value}%`;
      el('exportDockDetail').textContent = progress.phase ? `阶段：${progress.phase}` : '';
      dock.classList.toggle('open', dockOpen);
    }

    async function refreshDock() {
      try {
        const state = await fetchState();
        renderDock(state);
        if (!isActive(state)) {
          const progress = state?.progress || {};
          const starting = !progress.done && Date.now() - pollingStartedAt < 8000;
          if (starting) return;
          stopPolling();
          clearTimeout(hideTimer);
          hideTimer = setTimeout(() => {
            if (!dockOpen) renderDock({progress: {phase: 'idle'}});
          }, 10000);
        }
      } catch (_) {
        if (Date.now() - pollingStartedAt < 8000) return;
        renderDock({progress: {phase: 'idle'}});
      }
    }

    function startPolling({open = false} = {}) {
      stopPolling();
      clearTimeout(hideTimer);
      pollingStartedAt = Date.now();
      setDockOpen(open);
      renderDock({rendering: true, progress: {active: true, phase: 'start', message: '正在准备导出…', percent: 1}}, {keepVisible: true});
      refreshDock();
      pollingTimer = setInterval(refreshDock, 1000);
    }

    function stopPolling() {
      if (pollingTimer) clearInterval(pollingTimer);
      pollingTimer = null;
    }

    async function waitForIdle(timeoutMs = 15000) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const state = await fetchState();
        renderDock(state);
        if (!isActive(state)) return state;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error('终止导出超时，请稍后再试');
    }

    async function cancel({silent = false} = {}) {
      if (!silent) el('exportTaskStatus').textContent = '正在终止当前导出任务…';
      const {response, data: result} = await localService.cancelExport();
      if (!response.ok || !result.ok) throw new Error(result.message || '终止导出失败');
      if (!result.cancelled) {
        const state = await fetchState();
        renderDock(state);
        if (!silent) toast(result.message || '当前没有可终止的导出任务。');
        return state;
      }
      const state = await waitForIdle();
      renderDock(state, {keepVisible: true});
      if (!silent) toast('已终止当前导出任务。');
      return state;
    }

    function bind() {
      el('exportDockToggleBtn')?.addEventListener('click', () => setDockOpen(!dockOpen));
      el('exportDockCollapseBtn')?.addEventListener('click', () => setDockOpen(false));
      el('exportStopBtn')?.addEventListener('click', () => cancel().catch((error) => toast('终止导出失败：' + error.message)));
    }

    return {
      isActive,
      fetchState,
      renderDock,
      startPolling,
      stopPolling,
      waitForIdle,
      cancel,
      bind
    };
  }

  window.ExportTaskController = {create};
})();
