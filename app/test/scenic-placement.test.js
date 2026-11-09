const test = require('node:test');
const assert = require('node:assert/strict');
const {buildScenicPlacementPlan} = require('../server/services/scenic-placement');

const spot = (name) => ({name, title: name, description: `${name}介绍`, images: []});

const overnightDays = () => [
  {points: [
    {name: '出发点', kind: 'from'},
    {name: '老姆登村', kind: 'to', scenic: spot('老姆登村')},
  ]},
  {points: [
    {name: '老姆登村', kind: 'from', scenic: spot('老姆登村')},
    {name: '贡山县', kind: 'to'},
  ]},
];

test('没有选择记录时，终点即次日起点的介绍顺延到次日起点', () => {
  const plan = buildScenicPlacementPlan(overnightDays(), undefined);
  assert.equal(plan.allows(0, 1, '老姆登村'), false);
  assert.equal(plan.allows(1, 0, '老姆登村'), true);
});

test('用户选择“前一天终点”时，介绍就显示在前一天终点', () => {
  const plan = buildScenicPlacementPlan(overnightDays(), [{name: '老姆登村', dayIndex: 0, pointIndex: 1}]);
  assert.equal(plan.allows(0, 1, '老姆登村'), true);
  assert.equal(plan.allows(1, 0, '老姆登村'), false);
});

test('用户选择“次日起点”时，介绍显示在次日起点', () => {
  const plan = buildScenicPlacementPlan(overnightDays(), [{name: '老姆登村', dayIndex: 1, pointIndex: 0}]);
  assert.equal(plan.allows(0, 1, '老姆登村'), false);
  assert.equal(plan.allows(1, 0, '老姆登村'), true);
});

test('用户选择“不显示”时，任何一处都不显示', () => {
  const plan = buildScenicPlacementPlan(overnightDays(), [{name: '老姆登村', dayIndex: -1, pointIndex: -1}]);
  assert.equal(plan.allows(0, 1, '老姆登村'), false);
  assert.equal(plan.allows(1, 0, '老姆登村'), false);
});

test('有选择记录时，只出现一次的景点不受影响', () => {
  const days = overnightDays();
  days[1].points[1] = {name: '丙中洛镇', kind: 'to', scenic: spot('丙中洛镇')};
  const plan = buildScenicPlacementPlan(days, [{name: '老姆登村', dayIndex: 0, pointIndex: 1}]);
  assert.equal(plan.allows(1, 1, '丙中洛镇'), true);
});

test('选择记录和当前行程对不上时，退回默认规则而不是把介绍吞掉', () => {
  const plan = buildScenicPlacementPlan(overnightDays(), [{name: '老姆登村', dayIndex: 5, pointIndex: 3}]);
  const shown = [plan.allows(0, 1, '老姆登村'), plan.allows(1, 0, '老姆登村')];
  assert.ok(shown.some(Boolean), '介绍至少要在某一天显示');
});
