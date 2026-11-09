const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const {buildScenicPlacementPlan} = require('../server/services/scenic-placement');

const scenicFile = path.resolve(__dirname, '../video/src/projects/amap-route-video/lib/scenic.ts');
const scenicModule = new Module(scenicFile, module);
scenicModule.filename = scenicFile;
scenicModule.paths = Module._nodeModulePaths(path.dirname(scenicFile));
scenicModule._compile(ts.transpileModule(fs.readFileSync(scenicFile, 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS},
}).outputText, scenicFile);
const {scenicVisible} = scenicModule.exports;

const spot = (name) => ({name, title: name, description: `${name}介绍`, images: []});

const mismatches = (days, placements) => {
  const plan = buildScenicPlacementPlan(days, placements);
  const data = {days, scenicPlacements: placements};
  const out = [];
  days.forEach((day, dayIndex) => {
    day.points.forEach((point, pointIndex) => {
      if (!point.scenic || !point.name) return;
      const manual = plan.allows(dayIndex, pointIndex, point.name);
      const video = scenicVisible(data, dayIndex, pointIndex, point.name);
      if (manual !== video) out.push({key: `${dayIndex}-${pointIndex}`, name: point.name, manual, video});
    });
  });
  return out;
};

const overnight = () => [
  {points: [
    {name: '出发点', kind: 'from'},
    {name: '老姆登村', kind: 'to', scenic: spot('老姆登村')},
  ]},
  {points: [
    {name: '老姆登村', kind: 'from', scenic: spot('老姆登村')},
    {name: '贡山县', kind: 'to', scenic: spot('贡山县')},
  ]},
];

const cases = [
  ['没有选择记录', undefined],
  ['选前一天终点', [{name: '老姆登村', dayIndex: 0, pointIndex: 1}]],
  ['选次日起点', [{name: '老姆登村', dayIndex: 1, pointIndex: 0}]],
  ['选不显示', [{name: '老姆登村', dayIndex: -1, pointIndex: -1}]],
  ['记录对不上行程', [{name: '老姆登村', dayIndex: 5, pointIndex: 3}]],
  ['空数组', []],
];

cases.forEach(([label, placements]) => {
  test(`手册与视频一致：${label}`, () => {
    const days = overnight();
    assert.deepEqual(mismatches(days, placements), []);
  });
});

test('手册与视频一致：同一天内往返（同名两处，无跨天）', () => {
  const days = [{points: [
    {name: '出发点', kind: 'from'},
    {name: '才村码头', kind: 'waypoint', scenic: spot('才村码头')},
    {name: '洱海公园', kind: 'waypoint', scenic: spot('洱海公园')},
    {name: '才村码头', kind: 'to', scenic: spot('才村码头')},
  ]}];
  assert.deepEqual(mismatches(days, undefined), []);
  assert.deepEqual(mismatches(days, [{name: '才村码头', dayIndex: 0, pointIndex: 1}]), []);
  assert.deepEqual(mismatches(days, [{name: '才村码头', dayIndex: -1, pointIndex: -1}]), []);
});

test('手册与视频一致：同一景点出现三次', () => {
  const days = [
    {points: [
      {name: '出发点', kind: 'from'},
      {name: '丙中洛镇', kind: 'to', scenic: spot('丙中洛镇')},
    ]},
    {points: [
      {name: '丙中洛镇', kind: 'from', scenic: spot('丙中洛镇')},
      {name: '察瓦龙', kind: 'to'},
    ]},
    {points: [
      {name: '察瓦龙', kind: 'from'},
      {name: '丙中洛镇', kind: 'to', scenic: spot('丙中洛镇')},
    ]},
  ];
  [undefined, [{name: '丙中洛镇', dayIndex: 2, pointIndex: 1}], [{name: '丙中洛镇', dayIndex: -1, pointIndex: -1}]]
    .forEach((placements) => assert.deepEqual(mismatches(days, placements), []));
});

test('手册与视频一致：只给一个景点做选择时，其他重复景点走默认规则', () => {
  const days = [
    {points: [
      {name: '出发点', kind: 'from'},
      {name: '甲镇', kind: 'to', scenic: spot('甲镇')},
    ]},
    {points: [
      {name: '甲镇', kind: 'from', scenic: spot('甲镇')},
      {name: '乙镇', kind: 'to', scenic: spot('乙镇')},
    ]},
    {points: [
      {name: '乙镇', kind: 'from', scenic: spot('乙镇')},
      {name: '终点', kind: 'to'},
    ]},
  ];
  assert.deepEqual(mismatches(days, [{name: '甲镇', dayIndex: 0, pointIndex: 1}]), []);
});

test('手册与视频一致：随机行程 + 随机选择（200 组）', () => {
  const names = ['甲', '乙', '丙', '丁'];
  let seed = 20261107;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let round = 0; round < 200; round += 1) {
    const dayCount = 1 + Math.floor(rand() * 4);
    const days = [];
    for (let d = 0; d < dayCount; d += 1) {
      const pointCount = 1 + Math.floor(rand() * 3);
      const points = [];
      for (let p = 0; p < pointCount; p += 1) {
        const name = names[Math.floor(rand() * names.length)];
        points.push({name, kind: p === 0 ? 'from' : 'to', ...(rand() > 0.35 ? {scenic: spot(name)} : {})});
      }
      days.push({points});
    }
    for (let d = 0; d < days.length - 1; d += 1) {
      if (rand() > 0.5) {
        const last = days[d].points[days[d].points.length - 1];
        days[d + 1].points[0] = {name: last.name, kind: 'from', ...(last.scenic ? {scenic: spot(last.name)} : {})};
      }
    }
    const placements = [];
    names.forEach((name) => {
      const roll = rand();
      if (roll < 0.55) return;
      if (roll < 0.7) {
        placements.push({name, dayIndex: -1, pointIndex: -1});
        return;
      }
      if (roll < 0.85) {
        placements.push({name, dayIndex: Math.floor(rand() * dayCount), pointIndex: Math.floor(rand() * 3)});
        return;
      }
      placements.push({name, dayIndex: 9, pointIndex: 9});
    });
    assert.deepEqual(mismatches(days, placements.length ? placements : undefined), [], `第 ${round} 组`);
  }
});
