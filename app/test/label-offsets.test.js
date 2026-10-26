const test = require('node:test');
const assert = require('node:assert/strict');

global.window = {};
require('../web/src/domain/routeModel.js');
const RouteModel = global.window.RouteModel;

const point = (name, lng, lat) => ({name, lng, lat});

test('旧版共享位置会迁移到每个标记，之后拖动互不影响', () => {
  const poi = point('赛里木湖国家级风景名胜区', 81.168, 44.601);
  const route = RouteModel.normalizeRoute({
    name: '测试路线',
    labelOffsets: {'n:赛里木湖国家级风景名胜区': {x: 0.3, y: -0.2}},
    days: [
      {from: point('乌鲁木齐', 87.6, 43.8), to: {...poi}},
      {from: {...poi}, to: point('伊宁', 81.3, 43.9)}
    ]
  });
  assert.deepEqual(route.days[0].to.labelOffset, {x: 0.3, y: -0.2});
  assert.deepEqual(route.days[1].from.labelOffset, {x: 0.3, y: -0.2});
  assert.deepEqual(route.labelOffsets['o:0:to'], {x: 0.3, y: -0.2});
  assert.deepEqual(route.labelOffsets['o:1:from'], {x: 0.3, y: -0.2});
  assert.equal(route.labelOffsets['n:赛里木湖国家级风景名胜区'], undefined);

  route.labelOffsets['o:0:to'] = {x: -0.1, y: 0.4};
  route.days[0].to.labelOffset = {x: -0.1, y: 0.4};
  const rebuilt = RouteModel.normalizeRoute(route);
  assert.deepEqual(rebuilt.days[0].to.labelOffset, {x: -0.1, y: 0.4});
  assert.deepEqual(rebuilt.days[1].from.labelOffset, {x: 0.3, y: -0.2}, '另一个同名标记保持原位');

  delete rebuilt.labelOffsets['o:0:to'];
  rebuilt.days[0].to.labelOffset = {x: 0, y: 0};
  const reset = RouteModel.normalizeRoute(rebuilt);
  assert.deepEqual(reset.days[0].to.labelOffset, {x: 0, y: 0}, '重置不会被旧位置覆盖');
  assert.deepEqual(reset.days[1].from.labelOffset, {x: 0.3, y: -0.2});
});

test('同一天里同名景点的多个标记分别保存位置', () => {
  const poi = point('赛里木湖', 81.168, 44.601);
  const route = RouteModel.normalizeRoute({
    name: '测试路线',
    labelOffsets: {
      'o:0:w:0': {x: -0.2, y: 0.1},
      'o:0:w:1': {x: 0.4, y: -0.3}
    },
    days: [{
      from: point('乌鲁木齐', 87.6, 43.8),
      waypoints: [{...poi}, {...poi}],
      to: point('伊宁', 81.3, 43.9)
    }]
  });
  assert.deepEqual(route.days[0].waypoints[0].labelOffset, {x: -0.2, y: 0.1});
  assert.deepEqual(route.days[0].waypoints[1].labelOffset, {x: 0.4, y: -0.3});
});

test('点位被重新解析（新对象、没有自带偏移）时位置不会丢', () => {
  const key = RouteModel.occurrenceLabelKey(0, {kind: 'from'});
  assert.equal(key, 'o:0:from');
  assert.equal(RouteModel.occurrenceLabelKey(2, {kind: 'waypoint', waypointIndex: 1}), 'o:2:w:1');
  const rebuilt = RouteModel.normalizeRoute({
    name: '测试路线',
    labelOffsets: {[key]: {x: -0.4, y: 0.5}},
    days: [{from: point('那拉提', 84.01, 43.31), to: point('巴音布鲁克', 84.1, 43.0)}]
  });
  assert.deepEqual(rebuilt.days[0].from.labelOffset, {x: -0.4, y: 0.5});
});

test('旧版名称键仍然生成，零偏移不写进表', () => {
  assert.equal(RouteModel.poiLabelKey(point('', 100.123456, 30.654321)), 'g:100.12346,30.65432');
  assert.equal(RouteModel.poiLabelKey(point('', null, null)), '');
  assert.equal(RouteModel.poiLabelKey(point('有名字没坐标', null, null)), 'n:有名字没坐标');
  const offsets = RouteModel.normalizeLabelOffsets({
    'n:被拖走': {x: 0.2, y: 0.2},
    'n:没动过': {x: 0, y: 0},
    'n:坏值': {x: 'a', y: 1}
  });
  assert.deepEqual(Object.keys(offsets), ['n:被拖走']);
});
