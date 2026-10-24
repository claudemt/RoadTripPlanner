const test = require('node:test');
const assert = require('node:assert/strict');

global.window = {};
require('../web/src/domain/routeModel.js');
const RouteModel = global.window.RouteModel;

const point = (name, lng, lat) => ({name, lng, lat});

test('标签位置按 POI 名称绑定，同一个 POI 在不同天共用一份位置', () => {
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
  assert.deepEqual(route.days[1].from.labelOffset, {x: 0.3, y: -0.2}, '第二天同 POI 也要有同样的位置');
});

test('点位被重新解析（新对象、没有自带偏移）时位置不会丢', () => {
  const key = RouteModel.poiLabelKey(point('那拉提', 84.0, 43.3));
  assert.equal(key, 'n:那拉提');
  const rebuilt = RouteModel.normalizeRoute({
    name: '测试路线',
    labelOffsets: {[key]: {x: -0.4, y: 0.5}},
    days: [{from: point('那拉提', 84.01, 43.31), to: point('巴音布鲁克', 84.1, 43.0)}]
  });
  assert.deepEqual(rebuilt.days[0].from.labelOffset, {x: -0.4, y: 0.5});
});

test('没有名称时退回按坐标生成 key，零偏移不写进表', () => {
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
