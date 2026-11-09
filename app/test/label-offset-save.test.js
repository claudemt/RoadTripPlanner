const test = require('node:test');
const assert = require('node:assert/strict');
const {createBrowserContext, loadBrowserFile, loadFunctions} = require('./helpers/browser-functions');

function setup() {
  const context = createBrowserContext();
  loadBrowserFile(context, 'web/src/domain/routeModel.js');
  const RouteModel = context.window.RouteModel;
  context.normalizeLabelOffset = RouteModel.normalizeLabelOffset;
  loadFunctions(context, ['saveItemLabelOffset']);
  return {context, save: context.saveItemLabelOffset, RouteModel};
}

const point = (name, lng = 100, lat = 30) => ({name, lng, lat, transportMode: 'drive'});
const day = (name) => ({title: name, from: point(`${name}-from`), waypoints: [], to: point(`${name}-to`)});

test('同名景点的两个独立标记分别保存拖动位置', () => {
  const {save} = setup();
  const poi = point('赛里木湖');
  const route = {
    labelOffsets: {},
    days: [
      {title: 'D1', from: point('乌鲁木齐'), waypoints: [{...poi}], to: point('伊宁')},
      {title: 'D2', from: point('伊宁'), waypoints: [], to: {...poi}}
    ]
  };
  save(route, 0, {kind: 'waypoint', waypointIndex: 0, point: route.days[0].waypoints[0]}, {x: -0.2, y: 0.1});
  save(route, 1, {kind: 'to', point: route.days[1].to}, {x: 0.4, y: -0.3});
  assert.deepEqual({...route.days[0].waypoints[0].labelOffset}, {x: -0.2, y: 0.1});
  assert.deepEqual({...route.days[1].to.labelOffset}, {x: 0.4, y: -0.3});
  assert.deepEqual({...route.labelOffsets['o:0:w:0']}, {x: -0.2, y: 0.1});
  assert.deepEqual({...route.labelOffsets['o:1:to']}, {x: 0.4, y: -0.3});
});

test('跨天合并的标记同时写入相邻两个点，导出位置保持一致', () => {
  const {save} = setup();
  const poi = point('同一家酒店');
  const route = {
    labelOffsets: {},
    days: [
      {title: 'D1', from: point('甲'), waypoints: [], to: {...poi}},
      {title: 'D2', from: {...poi}, waypoints: [], to: point('乙')},
      {title: 'D3', from: point('乙'), waypoints: [], to: point('丙')}
    ]
  };
  save(route, 0, {kind: 'to', point: route.days[0].to}, {x: 0.15, y: -0.25});
  assert.deepEqual({...route.days[0].to.labelOffset}, {x: 0.15, y: -0.25});
  assert.deepEqual({...route.days[1].from.labelOffset}, {x: 0.15, y: -0.25});
  assert.deepEqual({...route.labelOffsets['o:0:to']}, {x: 0.15, y: -0.25});
  assert.deepEqual({...route.labelOffsets['o:1:from']}, {x: 0.15, y: -0.25});
  assert.equal(route.labelOffsets['o:1:to'], undefined);
});

test('地图给同名景点的不同标记分别使用各自位置', async () => {
  const context = createBrowserContext();
  loadBrowserFile(context, 'web/src/domain/routeModel.js');
  const RouteModel = context.window.RouteModel;
  const markers = [];
  context.window.AmapProvider = class {
    async load() {}
    async createMap() { return {}; }
    clearOverlays() {}
    addMarker(args) { markers.push(args); return {}; }
    addPolyline() { return {}; }
    fitView() {}
    setZoomAndCenter() {}
  };
  loadBrowserFile(context, 'web/src/features/map/routeMapController.js');
  const controller = context.window.RouteMapController.create({
    routeColors: ['#000'],
    getDayPoints: RouteModel.getDayPoints,
    isPointReady: RouteModel.isPointReady,
    escapeHtml: (value) => String(value)
  });
  await controller.load({});
  await controller.createMap('map', {});
  const poi = point('同一景点');
  controller.render({
    route: {
      days: [
        {from: point('甲'), waypoints: [], to: {...poi}},
        {from: point('乙'), waypoints: [], to: {...poi}}
      ],
      labelOffsets: {'o:0:to': {x: 0.1, y: 0.2}, 'o:1:to': {x: -0.3, y: 0.4}}
    },
    segmentResults: [{segments: []}, {segments: []}],
    currentRouteView: 'all',
    presentation: {},
    fit: false
  });
  const rendered = markers.filter((marker) => marker.point.name === '同一景点');
  assert.equal(rendered.length, 2);
  assert.deepEqual({...rendered[0].labelOffset}, {x: 0.1, y: 0.2});
  assert.deepEqual({...rendered[1].labelOffset}, {x: -0.3, y: 0.4});
});

test('重置一个标记时不清除其他同名标记', () => {
  const {save} = setup();
  const poi = point('同一家酒店');
  const route = {
    labelOffsets: {},
    days: [
      {title: 'D1', from: point('甲'), waypoints: [], to: {...poi, labelOffset: {x: 0.1, y: 0.1}}},
      {title: 'D2', from: {...poi, labelOffset: {x: 0.2, y: 0.2}}, waypoints: [], to: {...poi, labelOffset: {x: 0.3, y: 0.3}}}
    ]
  };
  route.labelOffsets = {'o:1:to': {x: 0.3, y: 0.3}};
  save(route, 1, {kind: 'to', point: route.days[1].to}, {x: 0, y: 0});
  assert.deepEqual({...route.days[1].to.labelOffset}, {x: 0, y: 0});
  assert.equal(route.labelOffsets['o:1:to'], undefined);
  assert.deepEqual({...route.days[0].to.labelOffset}, {x: 0.1, y: 0.1});
  assert.deepEqual({...route.days[1].from.labelOffset}, {x: 0.2, y: 0.2});
});
