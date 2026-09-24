const test = require('node:test');
const assert = require('node:assert/strict');

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
