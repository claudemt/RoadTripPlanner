(function () {
  function create() {
    const closeHandlers = new Map();
    let bound = false;

    function register(id, handler) {
      if (id && typeof handler === 'function') closeHandlers.set(id, handler);
    }

    function open(id) {
      document.getElementById(id)?.classList.add('open');
    }

    function close(id) {
      const dialog = document.getElementById(id);
      if (!dialog) return;
      const handler = closeHandlers.get(id);
      if (handler) handler();
      else dialog.classList.remove('open');
    }

    function topmostOpenDialog() {
      return [...document.querySelectorAll('.modal.open, .setup-overlay.open')].at(-1) || null;
    }

    function bind() {
      if (bound) return;
      bound = true;
      document.addEventListener('click', (event) => {
        const backdrop = event.target.closest('.modal, .setup-overlay');
        if (!backdrop || event.target !== backdrop) return;
        close(backdrop.id);
      });
      document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        const dialog = topmostOpenDialog();
        if (dialog) close(dialog.id);
      });
      document.querySelectorAll('[data-dialog-close]').forEach((button) => {
        button.addEventListener('click', () => close(button.dataset.dialogClose));
      });
    }

    return {register, open, close, bind};
  }

  window.DialogController = {create};
})();
