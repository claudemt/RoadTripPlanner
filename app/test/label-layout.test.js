const test = require('node:test');
const assert = require('node:assert/strict');
const {layoutLabels} = require('../shared/label-layout');

const image = (x, y, width = 100, height = 30) => ({x, y, width, height});

const layout = (items, extra = {}) => layoutLabels({
  width: 800,
  height: 600,
  scale: 1,
  items,
  ...extra
});

test('未拖动过的标签在冲突时会被推开，且互不重叠', () => {
  const boxes = layout([
    {key: 'a', x: 100, y: 200, width: 100, height: 30},
    {key: 'b', x: 104, y: 204, width: 100, height: 30}
  ]);
  const a = boxes.get('a');
  const b = boxes.get('b');
  const overlapW = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const overlapH = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  assert.ok(overlapW <= 0.5 || overlapH <= 0.5, '两个标签不应重叠');
  assert.equal(a.shiftX, 0, '先排的标签保持原位');
  assert.equal(a.shiftY, 0);
});

test('手拖过的标签锁死，不会被后到的标签挤走', () => {
  const boxes = layout([
    {key: 'pinned', x: 300, y: 300, width: 120, height: 30, userOffset: {x: 0.05, y: -0.02}},
    {key: 'late', x: 304, y: 300, width: 120, height: 30}
  ]);
  const pinned = boxes.get('pinned');
  assert.equal(pinned.locked, true);
  assert.equal(pinned.shiftX, 0);
  assert.equal(pinned.shiftY, 0);
  const late = boxes.get('late');
  assert.ok(late.shiftX !== 0 || late.shiftY !== 0, '后到的标签要让开');
});

test('手拖位置始终落在地图内', () => {
  const boxes = layout([
    {key: 'far', x: 780, y: 20, width: 200, height: 60, userOffset: {x: 1.5, y: -0.5}}
  ]);
  const box = boxes.get('far');
  assert.ok(box.x >= 0 && box.x + box.width <= 800);
  assert.ok(box.y >= 0 && box.y + box.height <= 600);
});

test('默认位置不压路线；压线时会被推离', () => {
  const path = [{x: 0, y: 330}, {x: 800, y: 330}];
  const boxes = layout([
    {key: 'onLine', x: 300, y: 386, width: 120, height: 30}
  ], {paths: [path], routeClearance: 16});
  const box = boxes.get('onLine');
  const centerY = box.y + box.height / 2;
  assert.ok(Math.abs(centerY - 330) > 16, '标签中心要离开路线一个净空');
});

test('点位图标作为障碍时标签会避开，且不会因为自己的图标乱跳', () => {
  const marker = image(300, 300, 34, 42);
  const boxes = layout([
    {key: 'own', x: 300, y: 342, width: 90, height: 30, obstacles: []},
    {key: 'other', x: 300, y: 342, width: 90, height: 30, obstacles: [marker]}
  ]);
  assert.equal(boxes.get('own').shiftX, 0, '自己的图标不算障碍');
  assert.equal(boxes.get('own').shiftY, 0);
  const other = boxes.get('other');
  assert.ok(other.shiftX !== 0 || other.shiftY !== 0, '别人的图标要避开');
});

test('视频单日段用 lockPositions 时全部锁死', () => {
  const boxes = layout([
    {key: 'a', x: 100, y: 200, width: 100, height: 30},
    {key: 'b', x: 104, y: 204, width: 100, height: 30}
  ], {lockPositions: true});
  assert.equal(boxes.get('a').locked, true);
  assert.equal(boxes.get('b').locked, true);
  assert.equal(boxes.get('b').shiftX, 0);
  assert.equal(boxes.get('b').shiftY, 0);
});

test('scale 影响默认偏移与步长，但用户偏移仍按画布比例', () => {
  const small = layoutLabels({
    width: 1280, height: 720, scale: 1,
    items: [{key: 'a', x: 600, y: 400, width: 100, height: 30}]
  });
  const big = layoutLabels({
    width: 1280, height: 720, scale: 2,
    items: [{key: 'a', x: 600, y: 400, width: 100, height: 30}]
  });
  assert.equal(small.get('a').x, 600 + 15);
  assert.equal(small.get('a').y, 400 - 56);
  assert.equal(big.get('a').x, 600 + 30);
  assert.equal(big.get('a').y, 400 - 112);
});
