const test = require('node:test');
const assert = require('node:assert/strict');
const {validateRouteData} = require('../server/validation/route-validation');
const {createBrowserContext, loadBrowserFile, loadFunctions} = require('./helpers/browser-functions');

const point = (name, lng = 100) => ({name, lng, lat: 30, transportMode: 'drive'});
const day = (name = 'A') => ({title: name, from: point(`${name}-from`), waypoints: [], to: point(`${name}-to`, 101)});
const segment = (to = 'A-to') => ({from: 'A-from', to, mode: 'drive', path: [[100, 30], [101, 30]], distance: 1000, duration: 60, alternatives: []});

function setup() {
  const requests = [];
  const saved = [];
  const context = createBrowserContext({
    route: {id: 'A', name: 'A', days: [day()], segmentCache: {}}, segmentResults: [{segments: []}],
    routeCalculationTask: null, pendingRouteCalculation: null, foregroundCalcWaiting: false,
    busyActions: new Set(), SEGMENT_CACHE_VERSION: 3, currentRouteView: 'all',
    feedback: {appConfirm: async () => true},
    setButtonBusy: () => () => {}, toast: () => {},
    setLoading: () => {context.loading = true;}, hideLoading: () => {context.loading = false;},
    saveRoute: () => saved.push(context.route.id),
    routeMap: {isReady: () => true, calculateDaySegments: (daySnapshot) => new Promise((resolve) => requests.push({day: daySnapshot, resolve}))},
    renderAll: () => {context.route = context.normalizeRoute(context.route);},
    applyCachedSegmentResults: () => {}, renderDaySelect: () => {}, renumberGeneratedDayTitles: () => {},
  });
  loadBrowserFile(context, 'web/src/domain/routeModel.js');
  Object.assign(context, context.window.RouteModel);
  loadFunctions(context, ['hasCompleteRouteSegments', 'calculateRoute', 'performRouteCalculation', 'syncSegmentCache', 'resetLabelOffsets', 'remapPointInfoDays', 'addDayAfter', 'deleteDay', 'ensureAutoAlternatives', 'STALE_DAY_SIGNATURE', 'invalidateDay', 'sameCoordValue', 'syncDayPointNames']);
  return {context, requests, saved};
}

test('switching routes discards a previous calculation without saving the new route', async () => {
  const {context, requests, saved} = setup();
  const task = context.calculateRoute({background: true});
  const routeB = {id: 'B', name: 'B', days: [day('B')], segmentCache: {}};
  context.route = routeB;
  context.segmentResults = [{segments: []}];
  requests[0].resolve([segment()]);
  await task;
  assert.equal(routeB.segmentCache[0], undefined);
  assert.equal(context.segmentResults[0].segments.length, 0);
  assert.deepEqual(saved, []);
});

test('a cached failed segment is recalculated on refresh', async () => {
  const {context, requests} = setup();
  context.route.segmentCache[0] = {
    cacheVersion: 3,
    signature: context.daySignature(context.route.days[0]),
    segments: [{...segment(), error: '旧路线失败'}]
  };
  assert.equal(context.hasCompleteRouteSegments(context.route), false);
  const task = context.calculateRoute({background: true});
  assert.equal(requests.length, 1);
  requests[0].resolve([segment()]);
  await task;
  assert.equal(context.route.segmentCache[0].segments[0].error, '');
});

test('editing a day during calculation queues a fresh request and ignores old geometry', async () => {
  const {context, requests} = setup();
  const task = context.calculateRoute({background: true});
  context.route.days[0].to = point('new destination', 102);
  const queued = context.calculateRoute({background: true});
  assert.equal(requests[0].day.to.name, 'A-to', 'in-flight request owns a snapshot');
  requests[0].resolve([segment()]);
  for (let turn = 0; turn < 10 && requests.length < 2; turn++) await Promise.resolve();
  assert.equal(requests.length, 2);
  assert.equal(context.route.segmentCache[0], undefined, 'old route geometry is never cached');
  assert.equal(requests[1].day.to.name, 'new destination');
  requests[1].resolve([segment('new destination')]);
  await Promise.all([task, queued]);
  assert.equal(context.route.segmentCache[0].segments[0].to, 'new destination');
  assert.equal(context.route.segmentCache[0].signature, context.daySignature(context.route.days[0]));
});

test('manual refresh during background calculation closes the loading window', async () => {
  const {context, requests} = setup();
  const background = context.calculateRoute({background: true});
  const foreground = context.calculateRoute();
  assert.equal(context.loading, true);
  requests[0].resolve([segment()]);
  await Promise.all([background, foreground]);
  assert.equal(context.loading, false);
  assert.equal(context.busyActions.has('calculate-route'), false);
  assert.equal(requests.length, 1, 'the queued refresh reuses the newly completed cache');
});

test('duplicate automatic alternatives finish once and preserve a custom selection', async () => {
  const {context} = setup();
  const custom = {label: 'manual', distance: 1200, duration: 90, path: [[100, 30], [101, 31], [102, 30]]};
  const selected = {...segment(), useCustom: true, customAlternative: custom, path: custom.path,
    alternatives: [{policy: 'fastest', distance: 1000, duration: 60, path: [[100, 30], [101, 30]]}]};
  context.segmentResults = [{segments: [selected]}];
  let requests = 0;
  context.window.RoadProvider = {
    autoPlanRoutes: async () => {requests++; return [{...custom}];}, overlapRatio: () => 1,
  };
  await context.ensureAutoAlternatives(0, 0);
  await context.ensureAutoAlternatives(0, 0);
  assert.equal(requests, 1);
  assert.equal(selected.autoAlternativesLoaded, true);
  assert.equal(selected.useCustom, true);
  assert.deepEqual(selected.path, custom.path);
});

test('new automatic alternatives do not override a custom route', async () => {
  const {context} = setup();
  const custom = {label: 'manual', distance: 1200, duration: 90, path: [[100, 30], [101, 31], [102, 30]]};
  const selected = {...segment(), useCustom: true, customAlternative: custom, path: custom.path,
    alternatives: [{policy: 'fastest', distance: 1000, duration: 60, path: [[100, 30], [101, 30]]}]};
  context.segmentResults = [{segments: [selected]}];
  context.window.RoadProvider = {autoPlanRoutes: async () => [{...custom}], overlapRatio: () => 0};
  await context.ensureAutoAlternatives(0, 0);
  assert.equal(selected.alternatives.length, 2);
  assert.equal(selected.useCustom, true);
  assert.deepEqual(selected.path, custom.path);
});

test('editing one point keeps the other segments reusable, custom route included', async () => {
  const {context} = setup();
  const custom = {label: '沿独库公路', distance: 2000, duration: 120, path: [[100.5, 30], [101, 30.5], [101.5, 30]]};
  const segStart = {from: 'A-from', to: 'W', mode: 'drive', path: [[100, 30], [100.5, 30]], distance: 1000, duration: 60, alternatives: [], selectedAlternative: 0};
  const segCustom = {from: 'W', to: 'A-to', mode: 'drive', path: custom.path, distance: custom.distance, duration: custom.duration,
    alternatives: [], selectedAlternative: 0, customAlternative: custom, useCustom: true};
  context.route.days[0] = {title: 'A', from: point('A-from'), waypoints: [point('W', 100.5)], to: point('A-to', 101)};
  context.route.segmentCache[0] = {
    cacheVersion: 3,
    signature: context.daySignature(context.route.days[0]),
    segments: [segStart, segCustom],
    options: [],
    customRoutes: []
  };
  context.segmentResults = [{segments: [segStart, segCustom]}];
  let handed = null;
  context.routeMap = {
    isReady: () => true,
    calculateDaySegments: (daySnapshot, cachedSegments) => {
      handed = cachedSegments;
      return Promise.resolve([]);
    }
  };

  // 用户只改了当天起点（不是 D 段两端），D 段已选的自定义路线必须还在。
  context.route.days[0].from = point('A-from-renamed', 99.9);
  context.invalidateDay(0);
  assert.equal(context.route.segmentCache[0].segments.length, 2, 'invalidating a day keeps its calculated segments');
  assert.equal(context.route.segmentCache[0].signature, '__stale__');

  await context.calculateRoute({background: true});
  assert.ok(Array.isArray(handed), 'cached segments are handed to the day calculation');
  assert.equal(handed[1].useCustom, true);
  assert.deepEqual(handed[1].customAlternative.path, custom.path);
});

test('inserting and deleting a day moves elevation cache and invalidates shifted weather dates', async () => {
  const {context} = setup();
  context.route.days = [day('D1'), day('D2'), day('D3')];
  context.route.pointInfoCache = {version: 1, days: {0: {date: '2026-10-22', points: []},
    1: {geoSignature: 'D2', date: '2026-10-23', weatherFetchedAt: '2026-10-22T00:00:00Z', points: [{elevationM: 2000, weather: {date: '2026-10-23', minC: 0, maxC: 10, code: 1}}]},
    2: {geoSignature: 'D3', date: '2026-10-24', points: [{elevationM: 3000}]}}};
  context.addDayAfter(0);
  let cache = context.route.pointInfoCache.days;
  assert.equal(cache[0].date, '2026-10-22');
  assert.equal(cache[1], undefined);
  assert.equal(cache[2].points[0].elevationM, 2000);
  assert.equal(cache[2].points[0].weather, undefined);
  assert.equal(cache[2].date, null);
  assert.equal(cache[3].points[0].elevationM, 3000);
  validateRouteData(context.route);
  await context.window.deleteDay(1);
  cache = context.route.pointInfoCache.days;
  assert.equal(cache[1].points[0].elevationM, 2000);
  assert.equal(cache[2].points[0].elevationM, 3000);
  assert.equal(cache[3], undefined);
  validateRouteData(context.route);
});

test('renaming a point only refreshes cached segment names and the day signature', () => {
  const {context} = setup();
  const segment = {
    from: 'A-from', to: 'A-to', fromLng: 100, fromLat: 30, toLng: 101, toLat: 30,
    mode: 'drive', path: [[100, 30], [101, 30]], distance: 1000, duration: 60,
    alternatives: [], selectedAlternative: 0,
    customAlternative: {label: '自定义', distance: 1, duration: 1, path: [[100, 30], [101, 30]]},
    useCustom: true
  };
  context.route.segmentCache[0] = {
    cacheVersion: 3,
    signature: context.daySignature(context.route.days[0]),
    segments: [segment],
    options: [],
    customRoutes: []
  };
  context.segmentResults = [{segments: [segment]}];
  const before = context.daySignature(context.route.days[0]);

  context.route.days[0].to = point('改名后的终点', 101);
  context.syncDayPointNames(0);

  assert.equal(segment.to, '改名后的终点');
  assert.equal(segment.useCustom, true, '自定义路线不受改名影响');
  assert.notEqual(context.daySignature(context.route.days[0]), before);
  assert.equal(context.route.segmentCache[0].signature, context.daySignature(context.route.days[0]),
    '签名同步后，刷新页面不会被当成缓存过期');
});

test('deleting a day asks for confirmation and keeps the day when refused', async () => {
  const {context} = setup();
  context.route.days = [day('D1'), day('D2')];
  let asked = 0;
  context.feedback = {appConfirm: async () => {asked += 1; return false;}};
  await context.window.deleteDay(0);
  assert.equal(asked, 1);
  assert.equal(context.route.days.length, 2, 'refusing the dialog keeps the day');
  context.feedback = {appConfirm: async () => {asked += 1; return true;}};
  await context.window.deleteDay(0);
  assert.equal(asked, 2);
  assert.equal(context.route.days.length, 1);
});

test('route description is saved and restored if cloud save fails', async () => {
  const target = {id: 'intro', description: '旧介绍'};
  const context = createBrowserContext({routeBook: {routes: [target]}, route: {...target}, toast: () => {}, saveRouteNow: async () => ({response: {ok: true}, data: {ok: true}})});
  loadBrowserFile(context, 'web/src/domain/routeModel.js');
  loadFunctions(context, ['updateRouteDescription']);
  assert.equal(await context.updateRouteDescription('intro', '  新介绍  '), true);
  assert.equal(target.description, '新介绍');
  assert.equal(context.route.description, '新介绍');
  context.saveRouteNow = async () => {throw new Error('offline');};
  assert.equal(await context.updateRouteDescription('intro', '未保存介绍'), false);
  assert.equal(target.description, '新介绍');
  assert.equal(context.route.description, '新介绍');
});
