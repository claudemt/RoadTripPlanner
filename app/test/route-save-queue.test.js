const test = require('node:test');
const assert = require('node:assert/strict');
const {createBrowserContext, loadBrowserFile} = require('./helpers/browser-functions');

const ok = () => ({response: {ok: true, status: 200}, data: {ok: true}});
const failure = (status, message = '') => ({response: {ok: false, status}, data: {ok: false, message}});

function setup(localService, {retryDelays = [], toast = () => {}} = {}) {
  const context = createBrowserContext();
  loadBrowserFile(context, 'web/src/api/routeSaveQueue.js');
  const queue = context.window.RouteSaveQueue.create({localService, toast, retryDelays});
  return {queue};
}

test('同一路线的连续保存串行执行并合并为最新快照', async () => {
  const calls = [];
  let releaseFirst;
  const firstPending = new Promise((resolve) => { releaseFirst = resolve; });
  const localService = {
    saveRoute(snapshot) {
      calls.push(snapshot.marker);
      return calls.length === 1 ? firstPending : Promise.resolve(ok());
    }
  };
  const {queue} = setup(localService);
  const first = queue.save({id: 'route-1', marker: 1}, 'standard', {silent: true});
  const second = queue.save({id: 'route-1', marker: 2}, 'standard', {silent: true});
  const third = queue.save({id: 'route-1', marker: 3}, 'standard', {silent: true});
  assert.deepEqual(calls, [1]);
  releaseFirst(ok());
  const results = await Promise.all([first, second, third]);
  assert.deepEqual(calls, [1, 3]);
  assert.ok(results.every((result) => result.response.ok));
});

test('不同路线的保存互不阻塞', async () => {
  const calls = [];
  let releaseFirst;
  const firstPending = new Promise((resolve) => { releaseFirst = resolve; });
  const localService = {
    saveRoute(snapshot) {
      calls.push(snapshot.id);
      return snapshot.id === 'route-a' ? firstPending : Promise.resolve(ok());
    }
  };
  const {queue} = setup(localService);
  const first = queue.save({id: 'route-a'}, 'standard', {silent: true});
  const second = queue.save({id: 'route-b'}, 'standard', {silent: true});
  const secondResult = await second;
  assert.equal(secondResult.response.ok, true);
  assert.deepEqual(calls, ['route-a', 'route-b']);
  releaseFirst(ok());
  assert.equal((await first).response.ok, true);
});

test('瞬时失败会自动重试直至成功', async () => {
  let calls = 0;
  const localService = {
    async saveRoute() {
      calls += 1;
      return calls < 3 ? failure(503, '服务暂不可用') : ok();
    }
  };
  const {queue} = setup(localService, {retryDelays: [0, 0]});
  const result = await queue.save({id: 'route-1'}, 'standard', {silent: true});
  assert.equal(calls, 3);
  assert.equal(result.response.ok, true);
});

test('业务校验失败不会重试', async () => {
  let calls = 0;
  const localService = {
    async saveRoute() {
      calls += 1;
      return failure(400, '路线数据无效');
    }
  };
  const {queue} = setup(localService, {retryDelays: [0, 0]});
  const result = await queue.save({id: 'route-1'}, 'standard', {silent: true});
  assert.equal(calls, 1);
  assert.equal(result.response.ok, false);
});

test('保存失败提示会合并，避免连续拖动时刷屏', async () => {
  const messages = [];
  const localService = {async saveRoute() { return failure(500, '网络错误'); }};
  const {queue} = setup(localService, {toast: (message) => messages.push(message)});
  await queue.save({id: 'route-1'}, 'standard', {label: '地图视图'});
  await queue.save({id: 'route-1'}, 'standard', {label: '文字位置'});
  assert.equal(messages.length, 1);
  assert.match(messages[0], /地图视图保存失败/);
});

test('内容相同的连续保存不会重复写入云端', async () => {
  let calls = 0;
  const localService = {async saveRoute() { calls += 1; return ok(); }};
  const {queue} = setup(localService);
  const first = await queue.save({id: 'route-1', name: '川北甘南线'}, 'standard', {silent: true});
  const second = await queue.save({id: 'route-1', name: '川北甘南线'}, 'standard', {silent: true});
  assert.equal(calls, 1);
  assert.equal(first.response.ok, true);
  assert.equal(second.response.ok, true);
  await queue.save({id: 'route-1', name: '川北甘南线', mapView: {zoom: 8}}, 'standard', {silent: true});
  assert.equal(calls, 2);
});

test('保存失败后相同内容会重新尝试写入', async () => {
  let calls = 0;
  const localService = {
    async saveRoute() {
      calls += 1;
      return calls === 1 ? failure(400) : ok();
    }
  };
  const {queue} = setup(localService);
  await queue.save({id: 'route-1'}, 'standard', {silent: true});
  const result = await queue.save({id: 'route-1'}, 'standard', {silent: true});
  assert.equal(calls, 2);
  assert.equal(result.response.ok, true);
});

test('视图保存只提交视图数据，连续拖动会合并为最后一次', async () => {
  const calls = [];
  let releaseFirst;
  const firstPending = new Promise((resolve) => { releaseFirst = resolve; });
  const localService = {
    saveRouteView(id, view) {
      calls.push({id, view});
      return calls.length === 1 ? firstPending : Promise.resolve(ok());
    }
  };
  const {queue} = setup(localService);
  const first = queue.saveView('route-1', {mapView: {zoom: 5}}, {silent: true});
  const second = queue.saveView('route-1', {mapView: {zoom: 6}}, {silent: true});
  const third = queue.saveView('route-1', {labelOffsets: {'o:0:to': {x: 0.1, y: 0.2}}}, {silent: true});
  assert.deepEqual(calls.map((call) => call.view), [{mapView: {zoom: 5}}]);
  releaseFirst(ok());
  await Promise.all([first, second, third]);
  assert.equal(JSON.stringify(calls.map((call) => call.view)), JSON.stringify([
    {mapView: {zoom: 5}},
    {mapView: {zoom: 6}, labelOffsets: {'o:0:to': {x: 0.1, y: 0.2}}}
  ]));
});

test('完整保存和视图保存按到达顺序执行，互不丢弃', async () => {
  const calls = [];
  let releaseFirst;
  const firstPending = new Promise((resolve) => { releaseFirst = resolve; });
  const localService = {
    saveRoute(snapshot) {
      calls.push(['full', snapshot.marker]);
      return calls.length === 1 ? firstPending : Promise.resolve(ok());
    },
    saveRouteView(id, view) {
      calls.push(['view', view.marker]);
      return Promise.resolve(ok());
    }
  };
  const {queue} = setup(localService);
  const first = queue.save({id: 'route-1', marker: 1}, 'standard', {silent: true});
  const second = queue.saveView('route-1', {marker: 2}, {silent: true});
  const third = queue.save({id: 'route-1', marker: 3}, 'standard', {silent: true});
  releaseFirst(ok());
  await Promise.all([first, second, third]);
  assert.deepEqual(calls, [['full', 1], ['view', 2], ['full', 3]]);
});

test('视图保存缺少路线 ID 时直接返回错误', async () => {
  let calls = 0;
  const localService = {
    async saveRouteView() {
      calls += 1;
      return ok();
    }
  };
  const {queue} = setup(localService);
  const result = await queue.saveView('', {mapView: null}, {silent: true});
  assert.equal(calls, 0);
  assert.equal(result.response.status, 400);
});
