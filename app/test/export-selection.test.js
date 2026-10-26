const test = require('node:test');
const assert = require('node:assert/strict');
const {createBrowserContext, loadBrowserFile, loadFunctions} = require('./helpers/browser-functions');

test('export selection only loads scenic data for ready points', async () => {
  const context = createBrowserContext();
  loadBrowserFile(context, 'web/src/domain/routeModel.js');
  loadBrowserFile(context, 'web/src/features/export/videoDataBuilder.js');
  const requested = [];
  const route = {id: 'demo', name: 'demo', days: [{
    title: '第1天',
    from: {name: '起', lng: 100, lat: 30},
    waypoints: [{name: '景点', lng: 101, lat: 31}, {name: '未定位', lng: null, lat: null}, {name: '不启用', lng: 102, lat: 32, useScenic: false}],
    to: {name: '终', lng: 103, lat: 33}
  }]};
  const builder = context.window.VideoDataBuilder.create({
    routeColors: ['blue'],
    getDayPoints: context.window.RouteModel.getDayPoints,
    cleanDayTitle: (value) => value.replace(/^第\d+天/, ''),
    summarizeVideoDays: () => ({})
  });
  const result = await builder.buildSelection({
    route,
    ensureScenicInfo: async (name) => { requested.push(name); return {name, intro: `${name}介绍`}; }
  });
  const points = result.days[0].points;
  assert.deepEqual(Array.from(points, (point) => point.name), ['起', '景点', '不启用', '终']);
  assert.deepEqual(requested.sort(), ['景点', '起', '终'].sort());
  assert.equal(points[1].scenic.intro, '景点介绍');
  assert.equal(points[2].useScenic, false);
  assert.equal(points[2].scenic, null);
  assert.equal(result.days[0].title, '第 1 天');
});

test('skipping a repeated scenic hides every occurrence', () => {
  const context = createBrowserContext();
  loadBrowserFile(context, 'web/src/domain/routeModel.js');
  context.isPointReady = context.window.RouteModel.isPointReady;
  loadFunctions(context, ['applyScenicPlacements', 'applyScenicPlacementsToRoute']);
  const skip = {name: '同名景点', dayIndex: -1, pointIndex: -1};
  const route = {days: [{
    from: {name: '同名景点', lng: 100, lat: 30, useScenic: true},
    waypoints: [],
    to: {name: '终点', lng: 101, lat: 31, useScenic: true}
  }]};
  context.applyScenicPlacementsToRoute(route, [skip]);
  assert.equal(route.days[0].from.useScenic, false);
  assert.equal(route.days[0].to.useScenic, true);
  const videoData = {days: [{points: [
    {name: '同名景点', scenic: {title: '介绍'}},
    {name: '终点', scenic: {title: '终点介绍'}}
  ]}]};
  context.applyScenicPlacements(videoData, [skip]);
  assert.equal(videoData.days[0].points[0].scenic, null);
  assert.equal(videoData.days[0].points[1].scenic.title, '终点介绍');
});
