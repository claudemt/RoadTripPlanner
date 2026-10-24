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

test('renaming one occurrence of the same POI updates the other occurrences', () => {
  const samePoi = point('赛里木湖国家级风景名胜区', 81.168, 44.601);
  const route = {
    days: [
      {from: point('伊宁', 81.27, 43.9), waypoints: [], to: samePoi},
      {from: {...samePoi}, waypoints: [point('点将台', 81.2, 44.55)], to: point('那拉提', 84.1, 43.4)},
    ],
  };
  const renamed = route.days[0].to;
  renamed.name = '赛湖日落点';

  const changed = window.RouteModel.syncSamePoiName(route, renamed, renamed);

  assert.deepEqual(changed, [1]);
  assert.equal(route.days[1].from.name, '赛湖日落点');
  assert.equal(route.days[1].waypoints[0].name, '点将台');
  assert.equal(route.days[0].from.name, '伊宁');
  // 名称同步后，第二天的起点重新被识别为重复点位（地图上不重复画标签）。
  assert.equal(window.RouteModel.isDuplicateDayStart(route, 1), true);
});

test('same-name points at different coordinates are separate POIs', () => {
  const route = {days: [{from: point('观景台', 100, 30), waypoints: [], to: point('观景台', 101, 30)}]};
  assert.equal(window.RouteModel.isSamePoiCoords(route.days[0].from, route.days[0].to), false);
  const renamed = route.days[0].from;
  renamed.name = '一号观景台';
  assert.deepEqual(window.RouteModel.syncSamePoiName(route, renamed, renamed), []);
  assert.equal(route.days[0].to.name, '观景台');
});

test('weather/elevation signature ignores nickname changes but follows coordinates', () => {
  const dayA = {from: point('赛里木湖', 81.1, 43.9), waypoints: [], to: point('那拉提', 82, 44.4)};
  const renamed = {from: point('赛湖', 81.1, 43.9), waypoints: [], to: point('那拉提', 82, 44.4)};
  const moved = {from: point('赛里木湖', 81.2, 43.9), waypoints: [], to: point('那拉提', 82, 44.4)};
  assert.equal(window.RouteModel.geoSignature(dayA), window.RouteModel.geoSignature(renamed));
  assert.notEqual(window.RouteModel.geoSignature(dayA), window.RouteModel.geoSignature(moved));
});

test('segment cache normalization keeps alternatives and clamps selection index', () => {
  const normalized = window.RouteModel.normalizeRoute({
    name: '孟克特到那拉提',
    days: [
      {title: '第一天', to: point('那拉提景区', 84.1, 43.4)},
    ],
    segmentCache: {
      0: {
        signature: 'sig-1',
        updatedAt: '2026-10-17T00:00:00.000Z',
        segments: [
          {
            from: '孟克特景区',
            to: '那拉提景区',
            mode: 'drive',
            distance: 92000,
            duration: 5400,
            path: [[84.1, 43.4], [84.2, 43.5], [84.3, 43.6]],
            selectedAlternative: 2,
            alternatives: [
              {policy: '时间最短', distance: 92000, duration: 5400, path: [[84.1, 43.4], [84.2, 43.5], [84.3, 43.6]]},
              {policy: '距离最短', distance: 88000, duration: 5100, path: [[84.1, 43.4], [84.15, 43.45], [84.3, 43.6]]},
              {policy: '躲避拥堵', distance: 95000, duration: 6000, path: []},
            ],
          },
        ],
      },
    },
  });

  const segments = normalized.segmentCache['0'].segments;
  assert.equal(segments.length, 1);
  const segment = segments[0];
  assert.equal(segment.alternatives.length, 2, '空路径备选应被过滤');
  assert.equal(segment.alternatives[0].policy, '时间最短');
  assert.equal(segment.alternatives[1].distance, 88000);
  assert.equal(segment.selectedAlternative, 1, '越界选择索引应被钳制到最后一个可用方案');
  assert.equal(segment.path.length, 3);

  const selected = window.RouteModel.selectSegmentAlternative(segment, 0);
  assert.deepEqual(selected, {index: 0, policy: '时间最短'});
  assert.equal(segment.selectedAlternative, 0);
  assert.equal(segment.distance, 92000);
  assert.deepEqual(segment.path, [[84.1, 43.4], [84.2, 43.5], [84.3, 43.6]]);
});

test('segment cache normalization handles legacy single-path segments', () => {
  const normalized = window.RouteModel.normalizeRoute({
    name: '旧数据',
    days: [{to: point('B', 3, 4)}],
    segmentCache: {
      0: {
        segments: [
          {from: 'A', to: 'B', mode: 'drive', distance: 1000, duration: 60, path: [[1, 2], [3, 4]]},
        ],
      },
    },
  });
  const segment = normalized.segmentCache['0'].segments[0];
  assert.deepEqual(segment.alternatives, []);
  assert.equal(segment.selectedAlternative, 0);
  assert.equal(segment.path.length, 2);
});

test('day options synthesize per gaode policy and sort by duration, then append custom routes', () => {
  const segments = [
    {
      distance: 92000,
      duration: 5400,
      path: [[84.1, 43.4], [84.2, 43.5], [84.3, 43.6]],
      alternatives: [
        {policy: '时间最短', distance: 92000, duration: 5400, path: [[84.1, 43.4], [84.2, 43.5], [84.3, 43.6]]},
        {policy: '距离最短', distance: 88000, duration: 6000, path: [[84.1, 43.4], [84.15, 43.45], [84.3, 43.6]]},
      ],
    },
    {
      distance: 5000,
      duration: 300,
      path: [[84.3, 43.6], [84.4, 43.7]],
      alternatives: [
        {policy: '时间最短', distance: 5000, duration: 300, path: [[84.3, 43.6], [84.4, 43.7]]},
        {policy: '距离最短', distance: 5200, duration: 400, path: [[84.3, 43.6], [84.35, 43.65], [84.4, 43.7]]},
      ],
    },
  ];
  const customRoutes = [
    {key: 'custom-1', label: '独库公路', distance: 90000, duration: 10800, path: [[84.1, 43.4], [84.2, 43.3], [84.4, 43.7]]},
  ];

  const options = window.RouteModel.synthesizeDayOptions(segments, customRoutes, 3);
  assert.equal(options.length, 3, '总量不超过 maxOptions');
  assert.equal(options[0].label, '最快', '高德方案按耗时升序排在最前');
  assert.equal(options[0].distance, 97000);
  assert.equal(options[0].duration, 5700);
  assert.equal(options[0].custom, false);
  assert.equal(options[1].label, '最近');
  assert.equal(options[2].label, '独库公路', '自定义路线追加在高德方案之后');
  assert.equal(options[2].custom, true);
  assert.equal(options[2].path.length, 3);
});

test('day options keep an empty label when gaode returns no strategy name', () => {
  const segments = [
    {
      distance: 1000,
      duration: 60,
      path: [[1, 1], [2, 2]],
      alternatives: [
        {policy: '', distance: 1000, duration: 60, path: [[1, 1], [2, 2]]},
        {policy: '时间最短', distance: 1200, duration: 50, path: [[1, 1], [1.5, 1.5], [2, 2]]},
      ],
    },
  ];
  const options = window.RouteModel.synthesizeDayOptions(segments, [], 3);
  assert.equal(options.length, 2, '无 strategy 的备选也保留为方案，但不自行命名');
  assert.equal(options[0].label, '最快');
  assert.ok(options.some((option) => option.label === ''));
});

test('day cache normalization carries options, custom routes, selection and confirmation', () => {
  const normalized = window.RouteModel.normalizeRoute({
    name: '天级缓存',
    days: [{to: point('B', 3, 4)}],
    segmentCache: {
      0: {
        signature: 'sig-2',
        segments: [
          {from: 'A', to: 'B', mode: 'drive', distance: 1000, duration: 60, path: [[1, 2], [3, 4]], alternatives: [{policy: '时间最短', distance: 1000, duration: 60, path: [[1, 2], [3, 4]]}]},
        ],
        options: [
          {key: 'amap-0', label: '时间最短', distance: 1000, duration: 60, custom: false, path: [[1, 2], [3, 4]]},
          {key: 'custom-1', label: '独库公路', distance: 900, duration: 120, custom: true, path: [[1, 2], [2.5, 3], [3, 4]]},
        ],
        customRoutes: [
          {key: 'custom-1', label: '独库公路', distance: 900, duration: 120, path: [[1, 2], [2.5, 3], [3, 4]]},
        ],
        selectedOptionKey: 'custom-1',
        confirmed: true,
      },
    },
  });
  const day = normalized.segmentCache['0'];
  assert.equal(day.options.length, 2);
  assert.equal(day.options[0].label, '最快');
  assert.equal(day.options[1].custom, true);
  assert.equal(day.customRoutes.length, 1);
  assert.equal(day.selectedOptionKey, 'custom-1');
  assert.equal(day.confirmed, true, '确认状态只在选中方案存在时保留');
});

test('day cache normalization drops confirmation when selection key is missing', () => {
  const normalized = window.RouteModel.normalizeRoute({
    name: '失效选择',
    days: [{to: point('B', 3, 4)}],
    segmentCache: {
      0: {
        segments: [
          {from: 'A', to: 'B', mode: 'drive', distance: 1000, duration: 60, path: [[1, 2], [3, 4]]},
        ],
        options: [
          {key: 'amap-0', label: '时间最短', distance: 1000, duration: 60, custom: false, path: [[1, 2], [3, 4]]},
        ],
        selectedOptionKey: 'amap-9',
        confirmed: true,
      },
    },
  });
  const day = normalized.segmentCache['0'];
  assert.equal(day.selectedOptionKey, null);
  assert.equal(day.confirmed, false);
});

test('segment cache normalization carries custom alternative and useCustom flag', () => {
  const normalized = window.RouteModel.normalizeRoute({
    name: '段级自定义',
    days: [{to: point('B', 3, 4)}],
    segmentCache: {
      0: {
        segments: [
          {
            from: 'A',
            to: 'B',
            mode: 'drive',
            distance: 92000,
            duration: 5400,
            path: [[84.1, 43.4], [84.2, 43.5], [84.3, 43.6]],
            selectedAlternative: 0,
            useCustom: true,
            customAlternative: {label: '独库公路', distance: 90000, duration: 10800, path: [[84.1, 43.4], [84.2, 43.3], [84.4, 43.7]]},
            alternatives: [
              {policy: '时间最短', distance: 92000, duration: 5400, path: [[84.1, 43.4], [84.2, 43.5], [84.3, 43.6]]},
            ],
          },
        ],
      },
    },
  });
  const segment = normalized.segmentCache['0'].segments[0];
  assert.equal(segment.customAlternative.label, '独库公路');
  assert.equal(segment.useCustom, true);
  assert.equal(segment.customAlternative.path.length, 3);
});

test('selectCustomAlternative applies the custom path and clears when selecting gaode', () => {
  const segment = {
    selectedAlternative: 0,
    alternatives: [
      {policy: '时间最短', distance: 92000, duration: 5400, path: [[1, 1], [2, 2]]},
    ],
    customAlternative: {label: '独库公路', distance: 90000, duration: 10800, path: [[1, 1], [1.5, 1.5], [2, 2]]},
    path: [[1, 1], [2, 2]],
    distance: 92000,
    duration: 5400,
  };
  const result = window.RouteModel.selectCustomAlternative(segment);
  assert.equal(result.label, '独库公路');
  assert.equal(segment.useCustom, true);
  assert.equal(segment.distance, 90000);
  assert.equal(segment.duration, 10800);
  assert.equal(segment.path.length, 3);
  window.RouteModel.selectSegmentAlternative(segment, 0);
  assert.equal(segment.useCustom, false);
  assert.equal(segment.distance, 92000);
  assert.equal(segment.path.length, 2);
});

test('normalization keeps the fifth selected alternative and the cache version', () => {
  const alternatives = Array.from({length: 5}, (_, i) => ({policy: `option-${i}`, distance: 1000 + i,
    duration: 60 + i, path: [[100, 30], [100 + i / 10, 31], [101, 32]]}));
  const selected = alternatives[4];
  const route = window.RouteModel.normalizeRoute({name: 'five routes', days: [{from: point('A', 100, 30), to: point('B', 101, 32)}],
    segmentCache: {0: {cacheVersion: 3, signature: 'cached', segments: [{...selected, alternatives, selectedAlternative: 4, fetchingAuto: true}]}}});
  const cached = route.segmentCache[0];
  assert.equal(cached.cacheVersion, 3);
  assert.equal(cached.segments[0].alternatives.length, 5);
  assert.equal(cached.segments[0].selectedAlternative, 4);
  assert.deepEqual(cached.segments[0].path, selected.path);
  assert.equal(Boolean(cached.segments[0].fetchingAuto), false);
});
