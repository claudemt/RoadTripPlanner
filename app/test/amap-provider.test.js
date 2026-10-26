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

test('snapshot bounds include marker icons and dragged labels beyond the route', () => {
  const provider = new window.AmapProvider({config: {}});
  const container = {
    getBoundingClientRect: () => ({left: 100, top: 50, width: 800, height: 600}),
  };
  provider.map = {
    getContainer: () => container,
    lngLatToContainer: ([lng, lat]) => ({x: lng * 10, y: lat * 10}),
  };
  provider.overlays = [{
    getPosition: () => ({lng: 10, lat: 20}),
    __routeMarkerSize: {width: 34, height: 42},
  }];
  provider.labelBindings = [{
    active: true,
    element: {
      getBoundingClientRect: () => ({left: 5, top: 90, right: 88, bottom: 130, width: 83, height: 40}),
    },
  }];
  const bounds = provider.getContentBounds();
  assert.equal(bounds.x, 5, 'label dragged left of the marker must widen the crop');
  assert.equal(bounds.y, 90);
  assert.equal(bounds.width, 212, 'crop reaches the marker right edge');
  assert.equal(bounds.height, 160, 'crop starts at the label and ends at the marker anchor');
});

const snapshotLabelElement = ({width = 80, height = 30} = {}) => ({
  style: {},
  getBoundingClientRect() {
    const match = /translate3d\((-?\d+)px, (-?\d+)px/.exec(this.style.transform || '');
    const left = match ? Number(match[1]) : 0;
    const top = match ? Number(match[2]) : 0;
    return {left, top, right: left + width, bottom: top + height, width, height};
  }
});

test('snapshot labels dodge other markers but may stay beside their own marker', () => {
  const provider = new window.AmapProvider({config: {}});
  const container = {
    clientWidth: 1920,
    clientHeight: 1080,
    getBoundingClientRect: () => ({left: 0, top: 0, width: 1920, height: 1080})
  };
  provider.map = {
    getContainer: () => container,
    lngLatToContainer: ([lng, lat]) => ({x: lng, y: lat}),
  };
  provider.labelLayer = {
    getBoundingClientRect: () => ({left: 0, top: 0, width: 1920, height: 1080})
  };
  provider.overlays = [
    {getPosition: () => ({lng: 500, lat: 500}), __routeMarkerSize: {width: 34, height: 42}},
  ];
  const ownLabel = snapshotLabelElement();
  provider.labelBindings = [{
    point: {lng: 500, lat: 500},
    element: ownLabel,
    labelOffset: {x: 0, y: 0},
    dragDelta: {x: 0, y: 0},
    active: true
  }];

  provider.layoutSnapshotLabels();
  assert.deepEqual(provider.labelBindings[0].snapshotShift, {x: 0, y: 0}, '与自身标记轻微重叠不应触发移动');

  provider.overlays.push({getPosition: () => ({lng: 560, lat: 460}), __routeMarkerSize: {width: 34, height: 42}});
  const shifted = snapshotLabelElement();
  provider.labelBindings[0].element = shifted;
  provider.layoutSnapshotLabels();
  const shift = provider.labelBindings[0].snapshotShift;
  assert.ok(shift.x !== 0 || shift.y !== 0, '压住其它标记时应挪开');
  const box = shifted.getBoundingClientRect();
  const otherMarker = {x: 543, y: 418, width: 34, height: 42};
  const overlapX = Math.min(box.right, otherMarker.x + otherMarker.width) - Math.max(box.left, otherMarker.x);
  const overlapY = Math.min(box.bottom, otherMarker.y + otherMarker.height) - Math.max(box.top, otherMarker.y);
  assert.ok(overlapX <= 0.5 || overlapY <= 0.5, '挪开后不应再压住其它标记');
});
