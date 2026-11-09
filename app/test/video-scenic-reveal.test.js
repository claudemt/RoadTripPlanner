const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const scenicFile = path.resolve(__dirname, '../video/src/projects/amap-route-video/lib/scenic.ts');
const scenicModule = new Module(scenicFile, module);
scenicModule.filename = scenicFile;
scenicModule.paths = Module._nodeModulePaths(path.dirname(scenicFile));
scenicModule._compile(ts.transpileModule(fs.readFileSync(scenicFile, 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS},
}).outputText, scenicFile);
const {activeScenics, scenicDedup, scenicStartKeys} = scenicModule.exports;

const spot = (name) => ({name, title: name, description: `${name}介绍`, images: []});

test('a unique day-start scenic reveals its card at the start of the day', () => {
  const day = {points: [
    {name: '赛里木湖风景区', kind: 'from', scenic: spot('赛里木湖风景区')},
    {name: '赛里木湖点将台', kind: 'waypoint', scenic: spot('赛里木湖点将台')},
  ]};
  const thresholds = [0, 0.5];
  const atStart = activeScenics(day, 1, 0, thresholds, new Set(), new Set(), new Set());
  assert.deepEqual(atStart.map((item) => item.key), ['0-赛里木湖风景区']);
  const atEnd = activeScenics(day, 1, 1, thresholds, new Set(), new Set(), new Set());
  assert.deepEqual(atEnd.map((item) => item.key), ['0-赛里木湖风景区', '1-赛里木湖点将台']);
});

test('a scenic repeated overnight shows once, at the next day start', () => {
  const data = {days: [
    {points: [
      {name: '出发点', kind: 'from'},
      {name: '特克斯八卦城', kind: 'to', scenic: spot('特克斯八卦城')},
    ]},
    {points: [
      {name: '特克斯八卦城', kind: 'from', scenic: spot('特克斯八卦城')},
      {name: '终点', kind: 'to'},
    ]},
  ]};
  const {suppress, showAtStart} = scenicDedup(data);
  assert.ok(suppress.has('特克斯八卦城'));
  assert.ok(showAtStart.has('1-0-特克斯八卦城'));
  const endOfPrevious = activeScenics(data.days[0], 0, 1, [0, 1], suppress, showAtStart, new Set());
  assert.equal(endOfPrevious.length, 0);
  const startOfNext = activeScenics(data.days[1], 1, 0, [0, 1], suppress, showAtStart, new Set());
  assert.deepEqual(startOfNext.map((item) => item.key), ['0-特克斯八卦城']);
});

test('a user placement pins the intro to the chosen occurrence', () => {
  const data = {days: [
    {points: [
      {name: '出发点', kind: 'from'},
      {name: '八卦城', kind: 'to', scenic: spot('八卦城')},
    ]},
    {points: [
      {name: '八卦城', kind: 'from', scenic: spot('八卦城')},
      {name: '终点', kind: 'to'},
    ]},
  ], scenicPlacements: [{name: '八卦城', dayIndex: 1, pointIndex: 0}]};
  const startKeys = scenicStartKeys(data);
  assert.ok(startKeys.has('1-0-八卦城'));
  const startOfNext = activeScenics(data.days[1], 1, 0, [0, 1], new Set(), new Set(), startKeys);
  assert.deepEqual(startOfNext.map((item) => item.key), ['0-八卦城']);
});
test('a user placement keeps the intro on the chosen day even when both occurrences carry scenic', () => {
  const data = {days: [
    {points: [
      {name: '出发点', kind: 'from'},
      {name: '老姆登村', kind: 'to', scenic: spot('老姆登村')},
    ]},
    {points: [
      {name: '老姆登村', kind: 'from', scenic: spot('老姆登村')},
      {name: '终点', kind: 'to'},
    ]},
  ], scenicPlacements: [{name: '老姆登村', dayIndex: 0, pointIndex: 1}]};
  const {suppress, showAtStart} = scenicDedup(data);
  const startKeys = scenicStartKeys(data);
  assert.ok(suppress.has('老姆登村'));
  assert.ok(!showAtStart.has('1-0-特克斯八卦城'));
  const endOfPrevious = activeScenics(data.days[0], 0, 1, [0, 1], suppress, showAtStart, startKeys);
  assert.deepEqual(endOfPrevious.map((item) => item.key), ['1-老姆登村']);
  const startOfNext = activeScenics(data.days[1], 1, 1, [0, 1], suppress, showAtStart, startKeys);
  assert.equal(startOfNext.length, 0);
});

test('a "do not show" placement hides the intro on every occurrence', () => {
  const data = {days: [
    {points: [
      {name: '出发点', kind: 'from'},
      {name: '老姆登村', kind: 'to', scenic: spot('老姆登村')},
    ]},
    {points: [
      {name: '老姆登村', kind: 'from', scenic: spot('老姆登村')},
      {name: '终点', kind: 'to'},
    ]},
  ], scenicPlacements: [{name: '老姆登村', dayIndex: -1, pointIndex: -1}]};
  const {suppress, showAtStart} = scenicDedup(data);
  const startKeys = scenicStartKeys(data);
  assert.equal(activeScenics(data.days[0], 0, 1, [0, 1], suppress, showAtStart, startKeys).length, 0);
  assert.equal(activeScenics(data.days[1], 1, 1, [0, 1], suppress, showAtStart, startKeys).length, 0);
});

test('a busy day keeps four intros, and only a fifth pushes the earliest one out', () => {
  const four = {points: [1, 2, 3, 4].map((n) => ({name: `景点${n}`, kind: 'waypoint', scenic: spot(`景点${n}`)}))};
  const fourRevealed = activeScenics(four, 0, 1, [0, 0.25, 0.5, 0.75], new Set(), new Set(), new Set());
  assert.deepEqual(fourRevealed.map((item) => item.key), ['0-景点1', '1-景点2', '2-景点3', '3-景点4']);

  const five = {points: [1, 2, 3, 4, 5].map((n) => ({name: `景点${n}`, kind: 'waypoint', scenic: spot(`景点${n}`)}))};
  const fiveRevealed = activeScenics(five, 0, 1, [0, 0.2, 0.4, 0.6, 0.8], new Set(), new Set(), new Set());
  assert.deepEqual(fiveRevealed.map((item) => item.key), ['1-景点2', '2-景点3', '3-景点4', '4-景点5']);
});
