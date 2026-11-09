(function () {
  function create({el, localService, dialogs}) {
    let toastTimer = null;
    let promptResolve = null;
    let confirmResolve = null;
    let promptBound = false;
    let confirmBound = false;

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
      const detailNode = el('loadingDetail');
      progress.classList.add('show');
      detailNode.textContent = detail || '';
      detailNode.classList.toggle('show', Boolean(detail));
    }

    function hideLoading() {
      const loading = el('loading');
      if (!loading) return;
      loading.classList.remove('show');
      el('loadingText').textContent = '正在计算路线…';
      el('loadingProgress').classList.remove('show');
      el('loadingProgressBar').removeAttribute('style');
      el('loadingDetail').classList.remove('show');
      el('loadingDetail').textContent = '';
    }

    function bindPrompt() {
      if (promptBound || !dialogs) return;
      promptBound = true;
      const ok = el('appPromptOkBtn');
      const input = el('appPromptInput');
      const area = el('appPromptAreaInput');
      const visibleValue = () => (area && !area.hidden) ? area.value : (input ? input.value : '');
      if (ok) ok.onclick = () => {
        const value = visibleValue();
        if (dialogs) dialogs.close('appPromptModal');
        if (promptResolve) {
          const resolve = promptResolve;
          promptResolve = null;
          resolve(value);
        }
      };
      if (input) input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          if (ok) ok.click();
        }
      });
      if (dialogs) dialogs.register('appPromptModal', () => {
        const dialog = document.getElementById('appPromptModal');
        if (dialog) dialog.classList.remove('open');
        if (promptResolve) {
          const resolve = promptResolve;
          promptResolve = null;
          resolve(null);
        }
      });
    }

    function appPrompt({title = '输入', defaultValue = '', placeholder = ''} = {}) {
      bindPrompt();
      const area = el('appPromptAreaInput');
      if (area) area.hidden = true;
      return new Promise((resolve) => {
        el('appPromptTitle').textContent = title;
        const input = el('appPromptInput');
        if (input) input.hidden = false;
        input.value = defaultValue || '';
        input.placeholder = placeholder || '';
        promptResolve = resolve;
        if (dialogs) dialogs.open('appPromptModal');
        setTimeout(() => input.focus(), 60);
      });
    }

    function appPromptArea({title = '输入', defaultValue = '', placeholder = '', rows = 4} = {}) {
      bindPrompt();
      const input = el('appPromptInput');
      if (input) input.hidden = true;
      return new Promise((resolve) => {
        el('appPromptTitle').textContent = title;
        const area = el('appPromptAreaInput');
        area.value = defaultValue || '';
        area.placeholder = placeholder || '';
        area.rows = rows;
        area.hidden = false;
        promptResolve = resolve;
        if (dialogs) dialogs.open('appPromptModal');
        setTimeout(() => area.focus(), 60);
      });
    }

    function bindConfirm() {
      if (confirmBound || !dialogs) return;
      confirmBound = true;
      const ok = el('appConfirmOkBtn');
      const cancel = el('appConfirmCancelBtn');
      const finish = (value) => {
        if (dialogs) dialogs.close('appConfirmModal');
        if (confirmResolve) {
          const resolve = confirmResolve;
          confirmResolve = null;
          resolve(value);
        }
      };
      if (ok) ok.onclick = () => finish(true);
      if (cancel) cancel.onclick = () => finish(false);
      if (dialogs) dialogs.register('appConfirmModal', () => {
        const dialog = document.getElementById('appConfirmModal');
        if (dialog) dialog.classList.remove('open');
        if (confirmResolve) {
          const resolve = confirmResolve;
          confirmResolve = null;
          resolve(false);
        }
      });
    }

    function appConfirm({title = '确认', message = '', compact = false, okText = '确定'} = {}) {
      bindConfirm();
      return new Promise((resolve) => {
        const modal = document.getElementById('appConfirmModal');
        const card = modal ? modal.querySelector('.confirm-card') : null;
        if (card) card.classList.toggle('is-compact', Boolean(compact));
        if (modal) modal.classList.toggle('is-compact', Boolean(compact));
        const okBtn = el('appConfirmOkBtn');
        if (okBtn) okBtn.textContent = okText;
        el('appConfirmTitle').textContent = title;
        el('appConfirmText').textContent = message;
        confirmResolve = resolve;
        if (dialogs) dialogs.open('appConfirmModal');
      });
    }

    return {
      toast,
      setLoading,
      hideLoading,
      appPrompt,
      appPromptArea,
      appConfirm
    };
  }

  window.FeedbackUi = {create};
})();
