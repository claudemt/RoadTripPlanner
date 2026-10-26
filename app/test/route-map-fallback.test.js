const test = require('node:test');
const assert = require('node:assert/strict');
const {createBrowserContext, loadBrowserFile} = require('./helpers/browser-functions');

const path = [[100, 30], [100.5, 30.2], [101, 30]];
const day = {from: {name: '起点', lng: 100, lat: 30}, to: {name: '终点', lng: 101, lat: 30, transportMode: 'ride'}};

async function setup(amapRoute, openRoutes) {
  const calls = {amap: 0, open: 0};
  const context = createBrowserContext({setTimeout: (callback) => setImmediate(callback)});
  context.window.RouteModel = {normalizeTransportMode: (value) => value || 'drive'};
  context.window.AmapProvider = class {
    async load() {}
    async route(from, to, mode) {
      calls.amap += 1;
      return amapRoute(from, to, mode);
    }
  };
  context.window.RoadProvider = {
    async autoPlanRoutes(from, to, mode) {
      calls.open += 1;
      return openRoutes(from, to, mode);
    }
  };
  loadBrowserFile(context, 'web/src/features/map/routeMapController.js');
  const controller = context.window.RouteMapController.create({
    routeColors: ['#000'],
    getDayPoints: (value) => [{point: value.from}, {point: value.to}],
    isPointReady: () => true,
    escapeHtml: (value) => value
  });
  await controller.load({});
  return {controller, calls};
}

test('Gaode failure uses an OSRM route for the selected transport mode and replaces a cached error', async () => {
  const {controller, calls} = await setup(
    async () => { throw new Error('高德未返回路线'); },
    async (_from, _to, mode) => {
      assert.equal(mode, 'ride');
      return [{path, distance: 2000, duration: 600}];
    }
  );
  const stale = {from: '起点', to: '终点', mode: 'ride', path: [[100, 30], [101, 30]], error: '旧错误'};
  const [segment] = await controller.calculateDaySegments(day, [stale]);
  assert.equal(calls.amap, 1);
  assert.equal(calls.open, 1);
  assert.equal(segment.error, '');
  assert.equal(segment.fallback, true);
  assert.equal(segment.alternatives[0].policy, '开源路网');
  assert.deepEqual(JSON.parse(JSON.stringify(segment.path)), path);
  assert.equal(segment.distance, 2000);
});

test('Gaode success does not call OSRM', async () => {
  const {controller, calls} = await setup(
    async () => ({path, distance: 2000, duration: 600, alternatives: [{policy: '最快', path, distance: 2000, duration: 600}]}),
    async () => { throw new Error('unexpected OSRM call'); }
  );
  const [segment] = await controller.calculateDaySegments(day);
  assert.equal(calls.open, 0);
  assert.equal(segment.fallback, false);
  assert.equal(segment.alternatives[0].policy, '最快');
});

test('both providers failing keeps the segment in an error state', async () => {
  const {controller, calls} = await setup(
    async () => { throw new Error('无可用路线'); },
    async () => { throw new Error('路网不可用'); }
  );
  const [segment] = await controller.calculateDaySegments(day);
  assert.equal(calls.open, 1);
  assert.match(segment.error, /高德：无可用路线；开源路网：路网不可用/);
  assert.equal(segment.distance, 0);
  assert.equal(segment.path.length, 2);
});
