const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {hasPointCoordinates} = require('../server/validation/route-validation');
const {createBrowserContext, loadBrowserFile, loadFunctions} = require('./helpers/browser-functions');

test('browser and API exports exclude named points with blank coordinates and keep real zero coordinates', async () => {
  const context = createBrowserContext({hasPointCoordinates});
  loadBrowserFile(context, 'web/src/domain/routeModel.js');
  context.window.MapPresentation = {normalize: (value) => value};
  loadBrowserFile(context, 'web/src/features/export/videoDataBuilder.js');
  loadFunctions(context, ['buildScriptVideoData'], 'server/route-render-server.js');
  const route = {id: 'demo', name: 'demo', description: '穿越草原与雪山的路线介绍', days: [{title: 'first day',
    from: {name: 'unset start', lng: null, lat: null},
    waypoints: [{name: 'origin', lng: 0, lat: 0}, {name: 'unset waypoint', lng: '', lat: ''}],
    to: {name: 'destination', lng: 104, lat: 30}}]};
  const builder = context.window.VideoDataBuilder.create({routeColors: ['blue'],
    getDayPoints: context.window.RouteModel.getDayPoints, cleanDayTitle: (value) => value,
    summarizeVideoDays: () => ({})});
  const browser = await builder.build({route, segmentResults: [], currentMapLayer: 'standard',
    ensureScenicInfo: async () => null});
  const api = vm.runInContext('buildScriptVideoData', context)(route);
  for (const result of [browser, api]) {
    assert.equal(result.route.description, route.description);
    assert.deepEqual(Array.from(result.days[0].points, (point) => point.name), ['origin', 'destination']);
    assert.equal(result.days[0].points[0].lng, 0);
    assert.equal(result.days[0].points[0].lat, 0);
  }
  assert.equal(context.window.RouteModel.isPointReady(route.days[0].from), false);
  assert.equal(context.window.RouteModel.isPointReady(route.days[0].waypoints[1]), false);
});

test('route archive preserves full trajectories, choices and incomplete coordinates', () => {
  const context = createBrowserContext();
  loadFunctions(context, ['stripDayPrefix', 'toBasicPoint', 'toBasicSegmentCache', 'toLabelOffsets', 'toBasicRouteData'], 'server/route-render-server.js');
  const path = Array.from({length: 8000}, (_, i) => [100 + i / 8000, 30]);
  const route = {name: 'full track', description: '归档后保留路线介绍', days: [{title: 'day', from: {name: 'unset', lng: null, lat: null}, waypoints: [], to: {name: 'end', lng: 101, lat: 30}}],
    segmentCache: {0: {cacheVersion: 3, segments: [{path, selectedAlternative: 1, alternatives: [{path}, {path: path.slice().reverse()}], fetchingAuto: true}]}}};
  const serialized = vm.runInContext('toBasicRouteData', context)(route);
  assert.equal(serialized.description, route.description);
  assert.equal(serialized.days[0].from.lng, null);
  assert.equal(serialized.segmentCache[0].segments[0].path.length, 8000);
  assert.equal(serialized.segmentCache[0].segments[0].selectedAlternative, 1);
  assert.equal(serialized.segmentCache[0].segments[0].alternatives.length, 2);
  assert.equal(serialized.segmentCache[0].segments[0].fetchingAuto, undefined);
  assert.equal(serialized.segmentCache[0].cacheVersion, 3);
});
