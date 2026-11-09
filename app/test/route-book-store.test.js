const test = require('node:test');
const assert = require('node:assert/strict');

const storage = new Map();
let quotaChars = Infinity;
global.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => {
    const text = String(value);
    if (text.length > quotaChars) throw new Error('QuotaExceededError');
    storage.set(key, text);
  },
  removeItem: (key) => storage.delete(key),
};

global.window = {};
require('../web/src/domain/routeModel.js');
require('../web/src/state/routeBookStore.js');

const defaultDays = [{title: '第 1 天', from: {name: '', lng: null, lat: null}, waypoints: [], to: {name: '', lng: null, lat: null}}];
const normalizeRoute = (input) => global.window.RouteModel.normalizeRoute(input, defaultDays);
const makeStore = () => global.window.RouteBookStore.create({storageKey: 'test-key', defaultRoute: defaultDays, normalizeRoute});

// 一条带自定义路线的一天：A -> B 自定义轨迹，B -> C 高德规划。
const custom = {label: '沿独库公路', distance: 42000, duration: 3600, path: [[81.1, 43.9], [81.5, 44.2], [82, 44.4]]};
const buildRoute = () => ({
  id: 'route-1',
  name: '伊犁小环线',
  days: [{
    title: '第一天',
    from: {name: '赛里木湖', lng: 81.1, lat: 43.9, transportMode: 'drive'},
    waypoints: [],
    to: {name: '那拉提', lng: 82, lat: 44.4, transportMode: 'drive'}
  }],
  segmentCache: {
    0: {
      cacheVersion: 3,
      signature: 'sig',
      segments: [{
        from: '赛里木湖',
        to: '那拉提',
        fromLng: 81.1,
        fromLat: 43.9,
        toLng: 82,
        toLat: 44.4,
        mode: 'drive',
        distance: 42000,
        duration: 3600,
        path: custom.path,
        selectedAlternative: 0,
        alternatives: [
          {policy: '时间最短', distance: 50000, duration: 4000, path: [[81.1, 43.9], [82, 44.4]]},
          {policy: '距离最短', distance: 46000, duration: 4200, path: [[81.1, 43.9], [81.6, 44.1], [82, 44.4]]}
        ],
        customAlternative: custom,
        useCustom: true
      }]
    }
  }
});

test('custom route survives a page reload without waiting for the server', () => {
  quotaChars = Infinity;
  storage.clear();
  const store = makeStore();
  const route = normalizeRoute(buildRoute());
  store.save({activeRouteId: route.id, routes: [route]});
  store.flush();

  const reloaded = makeStore().load();
  const restoredRoute = reloaded.routes.find((item) => item.id === 'route-1');
  assert.ok(restoredRoute, '路线被保存下来');
  const segment = restoredRoute.segmentCache[0].segments[0];
  assert.equal(segment.useCustom, true);
  assert.deepEqual(segment.customAlternative.path, custom.path);
  assert.deepEqual(segment.path, custom.path);
  assert.equal(segment.fromLng, 81.1, '首尾点位坐标一并保存，刷新后能判断是否还是同一段');
  assert.equal(restoredRoute.segmentCache[0].segments[0].alternatives.length, 2);
});

test('oversized cache degrades to a slim copy instead of dropping the custom route', () => {
  storage.clear();
  quotaChars = 1200;
  const store = makeStore();
  const route = normalizeRoute(buildRoute());
  store.save({activeRouteId: route.id, routes: [route]});
  store.flush();

  const restored = makeStore().load();
  const segment = restored.routes[0].segmentCache[0].segments[0];
  assert.equal(segment.useCustom, true);
  assert.deepEqual(segment.path, custom.path);
  assert.deepEqual(segment.alternatives || [], [], '超出配额时先丢弃备选路线');
  quotaChars = Infinity;
});

test('inactive routes persist as skeletons without segment cache', () => {
  quotaChars = Infinity;
  storage.clear();
  const store = makeStore();
  const active = normalizeRoute(buildRoute());
  const inactive = normalizeRoute({...buildRoute(), id: 'route-2', name: '川北甘南线'});
  store.save({activeRouteId: active.id, routes: [active, inactive]});
  store.flush();

  const raw = JSON.parse(storage.get('test-key'));
  const savedActive = raw.routes.find((item) => item.id === 'route-1');
  const savedInactive = raw.routes.find((item) => item.id === 'route-2');
  assert.ok(savedActive.segmentCache, '活跃路线保留路段缓存，刷新后立刻能画出轨迹');
  assert.equal(savedInactive.segmentCache, undefined, '非活跃路线只留骨架');
  assert.ok(savedInactive.days.length, '骨架仍然保留点位，下拉框和列表可用');
});

test('persisted route count is capped', () => {
  quotaChars = Infinity;
  storage.clear();
  const store = makeStore();
  const routes = Array.from({length: 12}, (_, index) => normalizeRoute({...buildRoute(), id: `route-${index}`, name: `路线 ${index}`}));
  store.save({activeRouteId: 'route-0', routes});
  store.flush();

  const raw = JSON.parse(storage.get('test-key'));
  assert.ok(raw.routes.length <= 8, '存储只保留有限条路线');
  assert.ok(raw.routes.some((item) => item.id === 'route-0'), '活跃路线一定被保留');
});

test('unchanged content is not rewritten', () => {
  quotaChars = Infinity;
  storage.clear();
  const store = makeStore();
  const route = normalizeRoute(buildRoute());
  const book = {activeRouteId: route.id, routes: [route]};
  store.save(book);
  store.flush();
  const first = storage.get('test-key');

  let writes = 0;
  const originalSetItem = global.localStorage.setItem;
  global.localStorage.setItem = (key, value) => {
    writes += 1;
    return originalSetItem(key, value);
  };
  store.save(book);
  store.flush();
  global.localStorage.setItem = originalSetItem;

  assert.equal(writes, 0, '内容没变时跳过写入');
  assert.equal(storage.get('test-key'), first);
});

test('flushing without pending data is a no-op', () => {
  quotaChars = Infinity;
  storage.clear();
  const store = makeStore();
  assert.doesNotThrow(() => store.flush());
  assert.equal(storage.size, 0);
});
