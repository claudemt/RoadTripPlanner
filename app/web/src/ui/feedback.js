(function () {
  function create({el, localService}) {
    let toastTimer = null;

    function toast(message) {
      clearTimeout(toastTimer);
      const node = el('toast');
      node.textContent = message;
      node.classList.remove('hide');
      node.classList.add('show');
      toastTimer = setTimeout(() => {
        node.classList.add('hide');
        setTimeout(() => node.classList.remove('show', 'hide'), 300);
      }, 2650);
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

    function hideLoading() {
      const loading = el('loading');
      if (!loading) return;
      loading.classList.remove('show');
      el('loadingText').textContent = '正在计算路线…';
      el('loadingProgress').classList.remove('show');
      el('loadingProgressBar').style.width = '0%';
      el('loadingDetail').classList.remove('show');
      el('loadingDetail').textContent = '';
    }

    return {
      toast,
      setLoading,
      hideLoading
    };
  }

  window.FeedbackUi = {create};
})();
