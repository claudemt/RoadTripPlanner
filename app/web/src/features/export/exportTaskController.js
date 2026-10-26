(function () {
  const ACTIVE_POLL_MS = 1500;
  const TASK_LOST_TIMEOUT_MS = 20000;

  function create({el, localService, toast}) {
    let pollingTimer = null;
    let dockOpen = false;
    let pollingStartedAt = 0;
    let expectedTaskId = null;
    let completionHandler = null;
    let pollInFlight = false;
    let pollingActive = false;
    let cancelling = false;
    let cancellingTaskId = null;
    let prepareCancelHandler = null;
    let lastQueue = null;
    let lastView = {active: false, cards: []};

    function isActive(state) {
      return Boolean(state?.rendering || state?.progress?.active);
    }

    function isTaskActive(task) {
      return Boolean(task && (task.status === 'queued' || task.status === 'running'));
    }

    async function fetchQueue() {
      const {response, data} = await localService.listExports();
      if (!response.ok || !data?.ok) throw new Error(data?.message || '无法读取导出队列');
      return data;
    }

    async function fetchState() {
      const {response, data} = await localService.getExportProgress();
      if (!response.ok || !data?.ok) throw new Error(data?.message || '无法读取导出任务');
      return data;
    }

    function setDockOpen(open) {
      dockOpen = Boolean(open);
      el('exportTaskDock')?.classList.toggle('open', dockOpen);
      el('exportDockToggleBtn')?.setAttribute('aria-expanded', String(dockOpen));
    }

    function formatEta(seconds) {
      const total = Math.max(0, Math.round(Number(seconds) || 0));
      if (!total) return '';
      const minutes = Math.floor(total / 60);
      const rest = total % 60;
      if (minutes >= 60) {
        const hours = Math.floor(minutes / 60);
        return `${hours} 小时 ${minutes % 60} 分`;
      }
      if (minutes > 0) return `${minutes} 分 ${rest} 秒`;
      return `${rest} 秒`;
    }

    function escapeHtml(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function percentOf(progress) {
      return Number.isFinite(Number(progress?.percent))
        ? Math.max(0, Math.min(100, Math.round(Number(progress.percent))))
        : 0;
    }

    function activeDetail(progress, status) {
      const stage = String(progress?.message || (status === 'queued' ? '排队中，等待前面的任务完成…' : '正在导出…'))
        .replace(/^正在/, '')
        .replace(/…+$/, '')
        .trim();
      const frames = Number(progress?.totalFrames) > 0
        ? `${Math.min(Number(progress.frames) || 0, Number(progress.totalFrames))}/${Number(progress.totalFrames)} 帧`
        : '';
      const eta = formatEta(progress?.etaSeconds);
      return [stage, frames, eta ? `剩 ${eta}` : ''].filter(Boolean).join(' · ');
    }

    function terminalDetail(task) {
      const progress = task?.progress || {};
      if (task?.status === 'failed' || progress.error) return `导出失败：${progress.error || '请稍后重试'}`;
      if (task?.status === 'cancelled' || progress.phase === 'cancelled') return progress.message || '已取消，过程文件已清理。';
      return '导出完成，产品已更新。';
    }

    function handleTextFor(status) {
      if (status === 'failed') return '导出失败';
      if (status === 'cancelled') return '已取消';
      if (status === 'done') return '已完成';
      return '导出中';
    }

    function taskCardHtml(card) {
      const statusClass = card.active ? 'running' : (card.status || 'done');
      const cancel = card.cancelable
        ? `<button class="export-dock-cancel" type="button" data-export-cancel="${escapeHtml(card.taskId || '')}"${cancellingTaskId === card.taskId ? ' disabled' : ''}>${cancellingTaskId === card.taskId ? '取消中…' : '取消'}</button>`
        : '';
      return `<div class="export-dock-task ${escapeHtml(statusClass)}" data-export-task="${escapeHtml(card.taskId || '')}">
        <div class="export-dock-task-head">
          <span class="export-dock-task-name" title="${escapeHtml(card.name || '导出任务')}">${escapeHtml(card.name || '导出任务')}</span>
          ${cancel}
        </div>
        <div class="export-dock-progress"><span style="width:${percentOf(card.progress)}%"></span></div>
        <div class="export-dock-detail">${escapeHtml(card.detail || '')}</div>
      </div>`;
    }

    function renderCards(view, {keepVisible = false} = {}) {
      lastView = view;
      const dock = el('exportTaskDock');
      if (!dock) return;
      const cards = view?.cards || [];
      const active = Boolean(view?.active && cards.length);
      const terminalStatus = view?.terminalStatus || '';
      const visible = active || Boolean(terminalStatus) || keepVisible;
      dock.hidden = !visible;
      dock.classList.toggle('active', active);
      dock.classList.toggle('done', terminalStatus === 'done');
      dock.classList.toggle('error', terminalStatus === 'failed');
      dock.classList.toggle('cancelled', terminalStatus === 'cancelled');
      dock.classList.toggle('no-cancel', active && !cards.some((card) => card.cancelable));
      if (!visible) {
        setDockOpen(false);
        return;
      }
      el('exportDockHandleText').textContent = view?.handleText || handleTextFor(terminalStatus);
      const container = el('exportDockTasks');
      if (container) container.innerHTML = cards.map(taskCardHtml).join('');
      dock.classList.toggle('open', dockOpen);
      el('exportDockToggleBtn')?.setAttribute('aria-expanded', String(dockOpen));
    }

    function buildQueueView(queue) {
      const tasks = queue?.tasks || [];
      const running = queue?.currentTaskId
        ? tasks.find((task) => task.taskId === queue.currentTaskId)
          || {taskId: queue.currentTaskId, routeName: '', status: 'running', progress: {}}
        : tasks.find((task) => task.status === 'running' && !task.publishJob) || null;
      const queued = (queue?.queued || [])
        .slice()
        .sort((left, right) => Number(left.position) - Number(right.position));
      const cards = [];
      if (running) {
        cards.push({
          taskId: running.taskId,
          name: running.routeName,
          status: 'running',
          active: true,
          cancelable: !running.publishJob,
          progress: running.progress || {},
          detail: activeDetail(running.progress, 'running')
        });
      }
      queued.forEach((job) => {
        if (running && job.taskId === running.taskId) return;
        if (cards.some((card) => card.taskId === job.taskId)) return;
        const position = Math.max(0, Number(job.position) || 0);
        cards.push({
          taskId: job.taskId,
          name: job.routeName,
          status: 'queued',
          active: true,
          cancelable: true,
          progress: {percent: 0},
          detail: position > 0 ? `排队中，前面还有 ${position} 个` : '排队中，即将开始'
        });
      });
      if (cards.length) return {active: true, handleText: '导出中', cards};
      const expected = expectedTaskId ? tasks.find((task) => task.taskId === expectedTaskId) : null;
      const terminal = expected || [...tasks].reverse().find((task) => !task.publishJob) || null;
      if (!terminal) return {active: false, cards: []};
      return {
        active: false,
        handleText: handleTextFor(terminal.status),
        terminalStatus: terminal.status || 'done',
        cards: [{
          taskId: terminal.taskId,
          name: terminal.routeName,
          status: terminal.status,
          active: false,
          cancelable: false,
          progress: terminal.progress || {},
          detail: terminalDetail(terminal)
        }]
      };
    }

    function renderQueue(queue, options = {}) {
      lastQueue = queue;
      const view = buildQueueView(queue);
      renderCards(view, {keepVisible: view.active, ...options});
      return view;
    }

    function renderDock(state, {keepVisible = false} = {}) {
      const progress = state?.progress || {};
      const status = state?.status || '';
      const cancelled = status === 'cancelled' || progress.phase === 'cancelled';
      const failed = status === 'failed' || Boolean(progress.error);
      const succeeded = !cancelled && !failed && (status === 'done' || Boolean(progress.done));
      const queuedCount = Math.max(0, Number(state?.queueCount) || 0);
      const queued = status === 'queued' || queuedCount > 0;
      const active = !cancelled && !failed && !succeeded && (isActive(state) || queued);
      const visible = active || succeeded || failed || cancelled || keepVisible;
      if (!visible) {
        renderCards({active: false, cards: []});
        return;
      }
      const terminalStatus = failed ? 'failed' : cancelled ? 'cancelled' : succeeded ? 'done' : '';
      const cancelable = active && Boolean(prepareCancelHandler || pollingActive || expectedTaskId);
      renderCards({
        active,
        handleText: active ? '导出中' : handleTextFor(terminalStatus),
        terminalStatus,
        cards: [{
          taskId: state?.taskId || expectedTaskId || '',
          name: state?.routeName || '',
          status: active ? 'running' : terminalStatus,
          active,
          cancelable,
          progress,
          detail: active
            ? (progress.message ? activeDetail(progress, status) : '正在准备导出…')
            : (failed
              ? `导出失败：${progress.error || '请稍后重试'}`
              : cancelled
                ? (progress.message || '已取消，过程文件已清理。')
                : '导出完成，产品已更新。')
        }]
      }, {keepVisible});
    }

    function queueHasWork(queue) {
      const tasks = queue?.tasks || [];
      return Boolean(
        (queue?.queued || []).length
        || queue?.currentTaskId
        || tasks.some((task) => task.status === 'running' && !task.publishJob)
      );
    }

    function queueTask(queue, taskId) {
      return (queue?.tasks || []).find((task) => task.taskId === taskId) || null;
    }

    function notifyCompletion(task) {
      const handler = completionHandler;
      completionHandler = null;
      expectedTaskId = null;
      if (!handler) return;
      handler({
        status: task?.status || 'done',
        progress: task?.progress || {},
        result: task?.result || {},
        exportTaskId: task?.taskId || null
      });
    }

    async function refreshDock() {
      if (pollInFlight) return;
      pollInFlight = true;
      try {
        const queue = await fetchQueue();
        lastQueue = queue;
        const view = buildQueueView(queue);
        const expected = expectedTaskId ? queueTask(queue, expectedTaskId) : null;
        const taskMissing = Boolean(expectedTaskId && !expected);
        renderCards(view, {keepVisible: view.active});
        if (taskMissing) {
          if (Date.now() - pollingStartedAt < TASK_LOST_TIMEOUT_MS) return;
          renderDock({status: 'failed', progress: {error: '导出任务已失效，请重新导出', phase: 'error'}}, {keepVisible: true});
          notifyCompletion({status: 'failed', progress: {error: '导出任务已失效，请重新导出'}});
          finishPolling();
          return;
        }
        if (expected && !isTaskActive(expected)) {
          notifyCompletion(expected);
        }
        if (queueHasWork(queue)) return;
        finishPolling();
      } catch (_) {
        if (Date.now() - pollingStartedAt < 8000) return;
        renderDock({progress: {phase: 'idle'}});
        finishPolling();
      } finally {
        pollInFlight = false;
      }
    }

    function schedulePolling() {
      if (pollingTimer || !pollingActive) return;
      const tick = async () => {
        pollingTimer = null;
        await refreshDock();
        if (pollingActive && !pollingTimer) pollingTimer = setTimeout(tick, ACTIVE_POLL_MS);
      };
      pollingTimer = setTimeout(tick, ACTIVE_POLL_MS);
    }

    function startPolling({open = false, taskId = null, onDone = null, silent = false} = {}) {
      stopPolling();
      prepareCancelHandler = null;
      pollingActive = true;
      pollingStartedAt = Date.now();
      expectedTaskId = taskId || null;
      completionHandler = onDone;
      setDockOpen(open);
      if (!silent) {
        renderDock({rendering: true, progress: {active: true, phase: 'start', message: '正在准备导出…', percent: 1}}, {keepVisible: true});
      }
      refreshDock();
      schedulePolling();
    }

    function stopPolling() {
      pollingActive = false;
      if (pollingTimer) clearTimeout(pollingTimer);
      pollingTimer = null;
    }

    function finishPolling() {
      stopPolling();
    }

    async function resume({onDone = null} = {}) {
      if (pollingActive || pollingTimer) return;
      try {
        const queue = await fetchQueue();
        lastQueue = queue;
        const running = queue.currentTaskId
          ? queueTask(queue, queue.currentTaskId)
          : (queue.tasks || []).find((task) => task.status === 'running' && !task.publishJob);
        const firstQueued = (queue.queued || []).slice().sort((left, right) => Number(left.position) - Number(right.position))[0];
        const taskId = running?.taskId || firstQueued?.taskId || null;
        if (!taskId) return;
        startPolling({open: false, silent: true, taskId, onDone});
      } catch (_) {
      }
    }

    async function waitForTaskSettled(taskId, timeoutMs = 30000) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const queue = await fetchQueue();
        lastQueue = queue;
        renderQueue(queue, {keepVisible: true});
        const task = queueTask(queue, taskId);
        const stillQueued = (queue.queued || []).some((job) => job.taskId === taskId);
        if (!stillQueued && (!task || !isTaskActive(task))) return {task, queue};
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
      throw new Error('终止导出超时，请稍后再试');
    }

    async function waitForIdle(timeoutMs = 30000) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const queue = await fetchQueue();
        renderQueue(queue, {keepVisible: queueHasWork(queue)});
        if (!queueHasWork(queue)) {
          const task = expectedTaskId ? queueTask(queue, expectedTaskId) : (queue.tasks || []).slice(-1)[0];
          return task || null;
        }
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
      throw new Error('终止导出超时，请稍后再试');
    }

    function setPrepareCancel(handler) {
      prepareCancelHandler = typeof handler === 'function' ? handler : null;
    }

    async function cancel({silent = false, taskId = expectedTaskId} = {}) {
      if (prepareCancelHandler) {
        const handler = prepareCancelHandler;
        prepareCancelHandler = null;
        try {
          handler();
        } catch (_) {
        }
        renderDock({progress: {phase: 'idle'}});
        return null;
      }
      if (cancelling) return null;
      const targetId = taskId || lastQueue?.currentTaskId || (lastQueue?.queued || [])[0]?.taskId || null;
      if (!targetId) {
        if (!silent) toast('当前没有可终止的导出任务。');
        return null;
      }
      cancelling = true;
      cancellingTaskId = targetId;
      renderCards(lastView, {keepVisible: true});
      try {
        const {response, data: result} = await localService.cancelExport(targetId);
        if (!response.ok || !result?.ok) throw new Error(result?.message || '终止导出失败');
        if (!result.cancelled) {
          const queue = await fetchQueue();
          renderQueue(queue, {keepVisible: queueHasWork(queue)});
          if (!silent) toast(result.message || '当前没有可终止的导出任务。');
          return null;
        }
        if (targetId === expectedTaskId) {
          completionHandler = null;
          expectedTaskId = null;
        }
        const {task, queue} = await waitForTaskSettled(targetId);
        if (queueHasWork(queue)) {
          renderQueue(queue, {keepVisible: true});
          if (!silent) toast('已终止导出任务。');
          return task;
        }
        renderDock({
          status: 'cancelled',
          progress: {...(task?.progress || {}), phase: 'cancelled', message: '已取消，过程文件已清理。'}
        }, {keepVisible: true});
        finishPolling();
        if (!silent) toast('已终止导出任务。');
        return task;
      } finally {
        cancelling = false;
        cancellingTaskId = null;
        if (pollingActive) renderCards(lastView, {keepVisible: true});
      }
    }

    function dismiss() {
      stopPolling();
      completionHandler = null;
      expectedTaskId = null;
      prepareCancelHandler = null;
      lastQueue = null;
      renderDock({progress: {phase: 'idle'}});
    }

    function bind() {
      el('exportDockToggleBtn')?.addEventListener('click', () => {
        if (el('exportTaskDock')?.classList.contains('active')) setDockOpen(!dockOpen);
        else dismiss();
      });
      el('exportDockTasks')?.addEventListener('click', (event) => {
        const button = event.target?.closest?.('[data-export-cancel]');
        if (!button || button.disabled) return;
        cancel({taskId: button.getAttribute('data-export-cancel')})
          .catch((error) => toast('终止导出失败：' + error.message));
      });
    }

    return {
      isActive,
      fetchState,
      renderDock,
      renderQueue,
      setPrepareCancel,
      startPolling,
      stopPolling,
      resume,
      waitForIdle,
      cancel,
      bind
    };
  }

  window.ExportTaskController = {create};
})();
