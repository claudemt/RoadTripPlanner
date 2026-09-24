const test = require('node:test');
const assert = require('node:assert/strict');

global.window = {};
require('../web/src/domain/routeModel.js');

const point = (name, lng, lat) => ({name, lng, lat});

test('a repeated next-day start is hidden only when name and coordinates match', () => {
  const shared = point('赛里木湖国家级风景名胜区', 81.168, 44.601);
  const route = {
    days: [
      {to: shared},
      {from: {...shared}, to: point('下一站', 82, 44)},
      {from: point('同名但不同坐标', 82, 44)},
    ],
  };

  assert.equal(window.RouteModel.isDuplicateDayStart(route, 0), false);
  assert.equal(window.RouteModel.isDuplicateDayStart(route, 1), true);
  assert.equal(window.RouteModel.isDuplicateDayStart(route, 2), false);
  assert.equal(window.RouteModel.isSamePoint(shared, {...shared, name: '另一个地点'}), false);
});
