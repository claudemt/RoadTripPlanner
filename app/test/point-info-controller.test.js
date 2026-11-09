const test = require('node:test');
const assert = require('node:assert/strict');
const {createBrowserContext, loadBrowserFile} = require('./helpers/browser-functions');

test('point info controller deduplicates requests and merges a fresh route cache', async () => {
  const previousWindow = global.window;
  global.window = {};
  const modulePath = require.resolve('../web/src/features/map/pointInfoController.js');
  delete require.cache[modulePath];
  require(modulePath);

  let requestCount = 0;
  let updatedCount = 0;
  const route = {
    presentation: {weather: true, elevation: true, startDate: '2026-09-24'},
    days: [{from: {name: '成都', lng: 104.066, lat: 30.572}, waypoints: [], to: {name: '', lng: null, lat: null}}],
    pointInfoCache: {version: 1, days: {}},
  };
  const controller = global.window.PointInfoController.create({
    localService: {
      pointInfo: async () => {
        requestCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          response: {ok: true},
          data: {ok: true, days: [{date: '2026-09-24', points: [{elevationM: 500, weather: {date: '2026-09-24', minC: 8, maxC: 18, code: 2}}]}]},
        };
      },
    },
    getDayPoints: (day) => [{point: day.from}, {point: day.to}],
    isPointReady: (point) => Boolean(point?.name && Number.isFinite(Number(point.lng)) && Number.isFinite(Number(point.lat))),
    geoSignature: () => 'geo-v1',
    addDays: (date) => date,
    onUpdated: () => { updatedCount += 1; },
  });

  assert.equal(controller.needsRefresh(route), true);
  const [first, second] = await Promise.all([controller.refresh(route), controller.refresh(route)]);
  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(requestCount, 1);
  assert.equal(updatedCount, 1);
  assert.equal(route.pointInfoCache.days[0].points[0].elevationM, 500);
  assert.equal(route.pointInfoCache.days[0].points[0].weather.code, 2);
  assert.equal(controller.needsRefresh(route), false);

  controller.dispose();
  global.window = previousWindow;
});

test('weather responses for edited or deleted days are discarded and retried', async () => {
  for (const edit of ['coordinate', 'date', 'delete-day']) {
    let complete;
    let updates = 0;
    const scheduled = [];
    const context = createBrowserContext({setTimeout: (callback) => {scheduled.push(callback); return scheduled.length;}, clearTimeout: () => {}});
    loadBrowserFile(context, 'web/src/domain/routeModel.js');
    loadBrowserFile(context, 'web/src/features/map/pointInfoController.js');
    const model = context.window.RouteModel;
    const makeDay = () => ({from: {name: 'A', lng: 100, lat: 30}, waypoints: [], to: {name: 'B', lng: 101, lat: 31}});
    const route = {presentation: {weather: true, elevation: true, startDate: '2026-10-22'},
      days: [makeDay(), makeDay()], pointInfoCache: {version: 1, days: {}}};
    const controller = context.window.PointInfoController.create({
      localService: {pointInfo: () => new Promise((resolve) => {complete = resolve;})},
      getDayPoints: model.getDayPoints, isPointReady: model.isPointReady, geoSignature: model.geoSignature,
      addDays: (date) => date, onUpdated: () => updates++,
    });
    const task = controller.refresh(route);
    if (edit === 'coordinate') route.days[0].from.lng = 110;
    else if (edit === 'date') route.presentation.startDate = '2026-10-23';
    else route.days.pop();
    complete({response: {ok: true}, data: {ok: true, days: [
      {date: '2026-10-22', points: [{elevationM: 500}]}, {date: '2026-10-23', points: [{elevationM: 800}]},
    ]}});
    assert.equal(await task, false, edit);
    assert.deepEqual(route.pointInfoCache.days, {}, edit);
    assert.equal(updates, 0, edit);
    assert.equal(scheduled.length, 1, 'changed route gets a fresh request');
    controller.dispose();
  }
});
