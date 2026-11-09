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

const exportProvider = ({width = 800, height = 600} = {}) => {
  const provider = new window.AmapProvider({config: {}});
  const container = {
    clientWidth: width,
    clientHeight: height,
    getBoundingClientRect: () => ({left: 0, top: 0, width, height}),
  };
  provider.map = {
    getContainer: () => container,
    lngLatToContainer: ([lng, lat]) => ({x: lng * 10, y: lat * 10}),
  };
  provider.overlays = [];
  provider.labelBindings = [];
  return provider;
};

const near = (actual, expected, message) => {
  assert.ok(Math.abs(actual - expected) < 0.01, `${message}: ${actual} != ${expected}`);
};

test('the export frame matches the crop the server takes', () => {
  const provider = exportProvider();
  provider.overlays = [{
    getPosition: () => ({lng: 50, lat: 30}),
    __routeMarkerSize: {width: 34, height: 42},
  }];
  provider.labelBindings = [{
    active: true,
    element: {getBoundingClientRect: () => ({left: 5, top: 90, right: 88, bottom: 130, width: 83, height: 40})},
  }];
  const frame = provider.exportFrameRect();
  assert.equal(provider.getContentBounds().width, 512, '外包框含图标与标签');
  near(frame.left, 0, '内容贴左边时裁切框从 0 开始');
  near(frame.top, 49.04, '上边距 = 8% 内容长边');
  near(frame.width, 557.96, '宽度 = 外包框宽度 + 两边 8%');
  near(frame.height, 291.92, '高度 = 外包框高度 + 两边 8%');
});

test('a tiny route still exports at least 160px on each side', () => {
  const provider = exportProvider();
  provider.overlays = [{
    getPosition: () => ({lng: 40, lat: 30}),
    __routeMarkerSize: {width: 34, height: 42},
  }];
  const frame = provider.exportFrameRect();
  near(frame.width, 160, '最小宽度');
  near(frame.height, 160, '最小高度');
});

test('labels stay exactly where they are dropped', () => {
  const provider = exportProvider();
  provider.labelBindings = [
    {point: {lng: 50, lat: 30}, labelOffset: {x: 0, y: 0}, dragDelta: {x: 0, y: 0}, active: true, element: {style: {}}},
    {point: {lng: 50, lat: 30}, labelOffset: {x: 0, y: 0}, dragDelta: {x: 0, y: 0}, active: true, element: {style: {}}},
  ];
  provider.refreshLabels();
  const [first, second] = provider.labelBindings.map((binding) => binding.element.style.transform);
  assert.equal(first, second, '两个标签叠在一起也不会被挪开');
  assert.equal(first, 'translate3d(515px, 244px, 0)', '位置只由点位和手拖偏移决定');
  assert.equal(provider.layoutLabels, undefined, '地图不再自带自动排版');
});
