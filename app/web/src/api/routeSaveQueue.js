(function () {
  const DEFAULT_RETRY_DELAYS = [500, 1500, 3500];
  const FAILURE_TOAST_GAP_MS = 5000;

  function create({localService, toast, retryDelays = DEFAULT_RETRY_DELAYS}) {
    const lanes = new Map();
    const lastSaved = new Map();
    let lastFailureAt = 0;
    const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

    function retryable(result) {
      const status = Number(result?.response?.status || 0);
      if (!status) return true;
      if (status === 408 || status === 429 || status >= 500) return true;
      return /timeout|timed out|network|fetch|ECONN|EAI_AGAIN|ENOTFOUND|socket|稍后|暂时/i
        .test(String(result?.data?.message || ''));
    }

    function notifyFailure(entry, result) {
      const eligible = entry.waiters.filter((waiter) => !waiter.silent);
      if (!eligible.length) return;
      const now = Date.now();
      if (now - lastFailureAt < FAILURE_TOAST_GAP_MS) return;
      lastFailureAt = now;
      const label = eligible[eligible.length - 1].label || '路线';
      const message = String(result?.data?.message || '请检查网络');
      toast(`${label}保存失败：${message}`);
    }

    function fingerprintOf(entry) {
      return entry.kind === 'view'
        ? JSON.stringify(entry.view)
        : JSON.stringify([entry.mapLayer, entry.snapshot]);
    }

    function requestOf(entry) {
      return entry.kind === 'view'
        ? localService.saveRouteView(entry.id, entry.view)
        : localService.saveRoute(entry.snapshot, entry.mapLayer);
    }

    async function start(id, lane, entry) {
      lane.running = true;
      const savedKey = `${entry.kind}:${id}`;
      const fingerprint = fingerprintOf(entry);
      let result = null;
      if (lastSaved.get(savedKey) === fingerprint) {
        result = {response: {ok: true, status: 200}, data: {ok: true}};
      } else {
        for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
          try {
            result = await requestOf(entry);
          } catch (error) {
            result = {
              response: {ok: false, status: 0},
              data: {ok: false, message: error?.message || '网络连接失败'}
            };
          }
          if (result?.response?.ok && result?.data?.ok) break;
          if (attempt >= retryDelays.length || !retryable(result)) break;
          await wait(retryDelays[attempt]);
        }
        if (result?.response?.ok && result?.data?.ok) lastSaved.set(savedKey, fingerprint);
        else lastSaved.delete(savedKey);
      }
      lane.running = false;
      entry.waiters.forEach((waiter) => waiter.resolve(result));
      if (!result?.response?.ok || !result?.data?.ok) notifyFailure(entry, result);
      const pending = lane.pending.shift();
      if (pending) {
        await start(id, lane, pending);
      } else {
        lanes.delete(id);
      }
    }

    function enqueue(id, entry) {
      let lane = lanes.get(id);
      if (!lane) {
        lane = {running: false, pending: []};
        lanes.set(id, lane);
      }
      if (!lane.running) {
        void start(id, lane, entry);
        return;
      }
      const last = lane.pending[lane.pending.length - 1];
      if (last && last.kind === entry.kind) {
        if (entry.kind === 'view') last.view = {...last.view, ...entry.view};
        else {
          last.snapshot = entry.snapshot;
          last.mapLayer = entry.mapLayer;
        }
        last.waiters.push(...entry.waiters);
        return;
      }
      lane.pending.push(entry);
    }

    function save(snapshot, mapLayer, {silent = false, label = '路线'} = {}) {
      return new Promise((resolve) => {
        const id = String(snapshot?.id || snapshot?.name || 'route');
        enqueue(id, {
          kind: 'full',
          id,
          snapshot,
          mapLayer,
          waiters: [{resolve, silent, label}]
        });
      });
    }

    function saveView(routeId, view, {silent = false, label = '路线'} = {}) {
      return new Promise((resolve) => {
        const id = String(routeId || '').trim();
        if (!id) {
          resolve({response: {ok: false, status: 400}, data: {ok: false, message: '缺少路线 ID'}});
          return;
        }
        enqueue(id, {
          kind: 'view',
          id,
          view: view || {},
          waiters: [{resolve, silent, label}]
        });
      });
    }

    return {save, saveView};
  }

  window.RouteSaveQueue = {create};
})();
