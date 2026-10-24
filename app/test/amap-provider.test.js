const test = require('node:test');
const assert = require('node:assert/strict');

global.window = {MapProvider: class {}};
global.AMap = {
  Driving: class {},
  DrivingPolicy: {
    LEAST_TIME: 'time',
    LEAST_DISTANCE: 'distance',
    REAL_TRAFFIC: 'traffic',
    LEAST_FEE: 'fee',
  },
};
require('../web/src/map/amapProvider.js');

test('a failed traffic policy does not discard other driving routes', async () => {
  const provider = new window.AmapProvider({config: {}});
  provider.queryRoute = async (_routeClass, _from, _to, {policy}) => {
    if (policy === 'traffic') throw new Error('road closed');
    if (policy === 'fee') return {distance: 1000, duration: 100, policy: '费用最低', path: [[1, 1], [2, 2]]};
    if (policy === 'distance') return {distance: 900, duration: 130, policy: '距离最短', path: [[1, 1], [1.5, 1.7], [2, 2]]};
    return {distance: 1000, duration: 100, policy: '时间最短', path: [[1, 1], [2, 2]]};
  };

  const result = await provider.drivingRoute({}, {});
  assert.equal(result.alternatives.length, 2, '重复路线应合并，失败方案不应中断其它方案');
  assert.equal(result.alternatives[0].policy, '时间最短', '策略名应来自高德返回的 strategy');
  assert.equal(result.alternatives[1].policy, '距离最短');
  assert.deepEqual(result.path, result.alternatives[0].path);
});

test('driving routes keep an empty policy label when gaode returns no strategy', async () => {
  const provider = new window.AmapProvider({config: {}});
  provider.queryRoute = async () => ({distance: 1000, duration: 100, path: [[1, 1], [2, 2]]});
  const result = await provider.drivingRoute({}, {});
  assert.equal(result.alternatives.length, 1);
  assert.equal(result.alternatives[0].policy, '', '没有返回 strategy 时不应自行添加标签');
});
