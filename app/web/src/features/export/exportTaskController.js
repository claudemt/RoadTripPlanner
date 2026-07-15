(function () {
  function create({el, localService, toast}) {
    let modalPollingTimer = null;

    function isActive(state) {
      return Boolean(state?.rendering || state?.progress?.active);
    }

    async function fetchState() {
      const {response, data} = await localService.getExportProgress();
      if (!response.ok || !data?.ok) throw new Error(data?.message || '无法读取导出任务');
      return data;
    }

    function renderPanel(state) {
      const panel = el('exportTaskPanel');
      if (!panel) return;
      const progress = state?.progress || {};
      if (!isActive(state)) {
        panel.style.display = 'none';
        el('exportConfirmBtn').textContent = '导出';
        return;
      }
      const percent = Number.isFinite(Number(progress.percent)) ? `${Math.round(Number(progress.percent))}%` : '';
      const phase = progress.phase || '导出中';
      const message = progress.message || '导出任务正在进行';
      el('exportTaskStatus').textContent = `已有导出任务：${message}${percent ? ` · ${percent}` : ''} · ${phase}`;
      el('exportConfirmBtn').textContent = '终止并导出';
      panel.style.display = 'block';
    }

    async function refreshPanel() {
      try {
        renderPanel(await fetchState());
      } catch (_) {
        const panel = el('exportTaskPanel');
        if (panel) panel.style.display = 'none';
      }
    }

    function startModalPolling() {
      stopModalPolling();
      refreshPanel();
      modalPollingTimer = setInterval(refreshPanel, 1000);
    }

    function stopModalPolling() {
      if (modalPollingTimer) clearInterval(modalPollingTimer);
      modalPollingTimer = null;
    }

    async function waitForIdle(timeoutMs = 15000) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const state = await fetchState();
        renderPanel(state);
        if (!isActive(state)) return state;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error('终止导出超时，请稍后再试');
    }

    async function cancel({silent = false} = {}) {
      if (!silent) el('exportTaskStatus').textContent = '正在终止当前导出任务…';
      const {response, data: result} = await localService.cancelExport();
      if (!response.ok || !result.ok) throw new Error(result.message || '终止导出失败');
      const state = await waitForIdle();
      renderPanel(state);
      if (!silent) toast(result.cancelled ? '已终止当前导出任务。' : '当前没有导出任务。');
      return state;
    }

    return {
      isActive,
      fetchState,
      renderPanel,
      refreshPanel,
      startModalPolling,
      stopModalPolling,
      waitForIdle,
      cancel
    };
  }

  window.ExportTaskController = {create};
})();
