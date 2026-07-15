(function () {
  function create({el, localService}) {
    let toastTimer = null;
    let exportProgressTimer = null;
    let fallbackExportPercent = 0;

    function toast(message) {
      clearTimeout(toastTimer);
      const node = el('toast');
      node.textContent = message;
      node.classList.add('show');
      toastTimer = setTimeout(() => node.classList.remove('show'), 2800);
    }

    function setLoading(message = '正在处理…', {percent = null, detail = ''} = {}) {
      const loading = el('loading');
      if (!loading) return;
      loading.classList.add('show');
      el('loadingText').textContent = message;
      const progress = el('loadingProgress');
      const bar = el('loadingProgressBar');
      const detailNode = el('loadingDetail');
      if (Number.isFinite(Number(percent))) {
        const value = Math.max(0, Math.min(100, Math.round(Number(percent))));
        progress.classList.add('show');
        bar.style.width = `${value}%`;
        detailNode.textContent = detail ? `${detail} · ${value}%` : `${value}%`;
        detailNode.classList.add('show');
      } else {
        progress.classList.remove('show');
        bar.style.width = '0%';
        detailNode.textContent = detail || '';
        detailNode.classList.toggle('show', Boolean(detail));
      }
    }

    function stopExportProgressPolling() {
      if (exportProgressTimer) clearInterval(exportProgressTimer);
      exportProgressTimer = null;
    }

    function hideLoading() {
      stopExportProgressPolling();
      const loading = el('loading');
      if (!loading) return;
      loading.classList.remove('show');
      el('loadingText').textContent = '正在计算路线…';
      el('loadingProgress').classList.remove('show');
      el('loadingProgressBar').style.width = '0%';
      el('loadingDetail').classList.remove('show');
      el('loadingDetail').textContent = '';
    }

    function startExportProgressPolling() {
      stopExportProgressPolling();
      fallbackExportPercent = 2;
      setLoading('正在准备导出…', {percent: fallbackExportPercent, detail: '准备'});
      exportProgressTimer = setInterval(async () => {
        fallbackExportPercent = Math.min(94, fallbackExportPercent + (fallbackExportPercent < 28 ? 2 : fallbackExportPercent < 80 ? 0.7 : 0.18));
        try {
          const {data} = await localService.getExportProgress();
          const progress = data?.progress || {};
          const serverPercent = Number(progress.percent);
          if (Number.isFinite(serverPercent)) fallbackExportPercent = Math.max(fallbackExportPercent, serverPercent);
          setLoading(progress.message || '正在导出…', {
            percent: progress.done ? 100 : fallbackExportPercent,
            detail: progress.phase || '导出中'
          });
        } catch (_) {
          setLoading('正在导出…', {percent: fallbackExportPercent, detail: '本地服务处理中'});
        }
      }, 900);
    }

    return {
      toast,
      setLoading,
      hideLoading,
      startExportProgressPolling,
      stopExportProgressPolling
    };
  }

  window.FeedbackUi = {create};
})();
