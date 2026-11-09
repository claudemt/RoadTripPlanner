const test = require('node:test');
const assert = require('node:assert/strict');
const {createBrowserContext, loadBrowserFile, loadFunctions} = require('./helpers/browser-functions');

const point = (name, extra = {}) => ({name, lng: 100, lat: 30, transportMode: 'drive', ...extra});
const scenicPoint = (name, extra = {}) => point(name, {scenic: {title: name, images: ['x.jpg']}, ...extra});

function setup() {
  const context = createBrowserContext();
  loadBrowserFile(context, 'web/src/domain/routeModel.js');
  Object.assign(context, context.window.RouteModel);
  loadFunctions(context, [
    'applyScenicPlacementsToRoute',
    'scenicDecisionKey',
    'rememberScenicPlacements',
    'collectScenicConflicts',
    'savedScenicPlacement',
    'defaultScenicChoice'
  ]);
  const saves = [];
  context.saveRoute = (showToast) => saves.push(showToast);
  return {context, saves};
}

// 同一个景点在两天各出现一次，两次都有景点介绍——需要询问出现时间
const duplicatedRoute = () => ({
  days: [
    {title: 'D1', from: point('乌鲁木齐'), waypoints: [scenicPoint('赛里木湖')], to: point('伊宁')},
    {title: 'D2', from: point('伊宁'), waypoints: [], to: scenicPoint('赛里木湖')}
  ]
});

const isReady = (item) => Boolean(item && item.name);

// 与 VideoDataBuilder.buildSelection 同构：scenicAvailable 只看景点有没有介绍，不受 useScenic 影响
const selectionOf = (route) => ({
  days: route.days.map((day) => {
    const rows = [
      {role: '起', point: day.from},
      ...(day.waypoints || []).map((item) => ({role: '', point: item})),
      {role: '终', point: day.to}
    ].filter((row) => isReady(row.point));
    return {
      points: rows.map((row) => ({
        name: row.point.name,
        role: row.role,
        scenicAvailable: Boolean(row.point.scenic),
        scenic: row.point.useScenic === false ? null : row.point.scenic
      }))
    };
  })
});

test('默认选中第一次出现', () => {
  const {context} = setup();
  const [conflict] = context.collectScenicConflicts(selectionOf(duplicatedRoute()));
  assert.equal(conflict.name, '赛里木湖');
  const choice = context.defaultScenicChoice(conflict, {});
  assert.equal(choice.dayIndex, 0);
  assert.equal(choice.pointIndex, 1);
});

test('上一次选过之后仍然会弹窗，但默认保留上次的选择', () => {
  const {context} = setup();
  context.route = duplicatedRoute();
  context.rememberScenicPlacements([{name: '赛里木湖', dayIndex: 1, pointIndex: 1}]);
  const conflicts = context.collectScenicConflicts(selectionOf(context.route));
  assert.equal(conflicts.length, 1, '已决定的重复景点依旧出现在弹窗里');
  const choice = context.defaultScenicChoice(conflicts[0], context.route);
  assert.equal(choice.dayIndex, 1, '默认沿用上次选中的那天');
  assert.equal(choice.pointIndex, 1);
});

test('上次选了「不显示」，这次默认仍是「不显示」', () => {
  const {context} = setup();
  context.route = duplicatedRoute();
  context.rememberScenicPlacements([{name: '赛里木湖', dayIndex: -1, pointIndex: -1}]);
  const conflicts = context.collectScenicConflicts(selectionOf(context.route));
  assert.equal(conflicts.length, 1);
  assert.equal(context.defaultScenicChoice(conflicts[0], context.route), null);
});

test('记忆的位置在行程改动后失效，则回退到第一次出现', () => {
  const {context} = setup();
  const [conflict] = context.collectScenicConflicts(selectionOf(duplicatedRoute()));
  const choice = context.defaultScenicChoice(conflict, {
    scenicPlacements: [{name: '赛里木湖', dayIndex: 5, pointIndex: 0}]
  });
  assert.equal(choice.dayIndex, 0);
});

test('选定之后，其它出现位置被取消勾选，且只静默保存一次', () => {
  const {context, saves} = setup();
  context.route = duplicatedRoute();
  context.rememberScenicPlacements([{name: '赛里木湖', dayIndex: 0, pointIndex: 1}]);
  assert.equal(context.route.days[0].waypoints[0].useScenic, true, '被选中的那次恢复勾选');
  assert.equal(context.route.days[1].to.useScenic, false, '没选中的那次取消勾选');
  assert.deepEqual(saves, [false]);
  context.rememberScenicPlacements([{name: '赛里木湖', dayIndex: 0, pointIndex: 1}]);
  assert.deepEqual(saves, [false], '同样的选择不重复保存');
});

test('选「不显示」时，多次出现都被取消勾选', () => {
  const {context} = setup();
  context.route = duplicatedRoute();
  context.rememberScenicPlacements([{name: '赛里木湖', dayIndex: -1, pointIndex: -1}]);
  assert.equal(context.route.days[0].waypoints[0].useScenic, false);
  assert.equal(context.route.days[1].to.useScenic, false);
});

test('只出现一次的景点不会进入冲突列表，也不触发保存', () => {
  const {context, saves} = setup();
  context.route = {
    days: [
      {title: 'D1', from: point('乌鲁木齐'), waypoints: [scenicPoint('赛里木湖')], to: point('伊宁')},
      {title: 'D2', from: point('伊宁'), waypoints: [], to: point('喀纳斯')}
    ]
  };
  assert.equal(context.collectScenicConflicts(selectionOf(context.route)).length, 0);
  context.rememberScenicPlacements([{name: '赛里木湖', dayIndex: 0, pointIndex: 1}]);
  assert.deepEqual(saves, []);
  assert.notEqual(context.route.days[0].waypoints[0].useScenic, false);
});

test('没有景点介绍的重复地名不会出现在冲突列表', () => {
  const {context} = setup();
  const route = {
    days: [
      {title: 'D1', from: point('乌鲁木齐'), waypoints: [point('服务区')], to: point('伊宁')},
      {title: 'D2', from: point('伊宁'), waypoints: [point('服务区')], to: point('喀纳斯')}
    ]
  };
  assert.equal(context.collectScenicConflicts(selectionOf(route)).length, 0);
});
