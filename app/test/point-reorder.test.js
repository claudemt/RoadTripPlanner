const test = require('node:test');
const assert = require('node:assert/strict');
const {createBrowserContext, loadBrowserFile, loadFunctions} = require('./helpers/browser-functions');

const point = (name, lng, lat) => ({name, lng, lat, transportMode: 'drive'});

const buildDay = () => ({
  title: '第 1 天',
  from: point('起点', 100.0, 30.0),
  waypoints: [point('点A', 101.0, 30.0), point('点B', 102.0, 30.0), point('点C', 103.0, 30.0)],
  to: point('终点', 104.0, 30.0)
});

const buildRoute = () => ({
  id: 'R1',
  name: '换位测试',
  days: [buildDay()],
  segmentCache: {},
  labelOffsets: {
    'o:0:from': {x: 0.1, y: 0.1},
    'o:0:w:0': {x: 0.2, y: 0},
    'o:0:w:1': {x: 0, y: 0.3},
    'o:0:w:2': {x: 0.4, y: 0},
    'o:0:to': {x: 0, y: 0.5}
  },
  pointInfoCache: {
    version: 1,
    days: {
      0: {
        geoSignature: 'old',
        date: '2026-10-01',
        weatherFetchedAt: '2026-10-01T00:00:00.000Z',
        points: [
          {elevationM: 100},
          {elevationM: 101},
          {elevationM: 102},
          {elevationM: 103},
          {elevationM: 104}
        ]
      }
    }
  }
});

function setup(route = buildRoute()) {
  const context = createBrowserContext({
    route,
    segmentResults: [{segments: []}],
    busyActions: new Set(),
    feedback: {appConfirm: async () => true},
    toast: () => {},
    saveRoute: () => {},
    renderAll: () => {},
    calculateRoute: async () => {}
  });
  loadBrowserFile(context, 'web/src/domain/routeModel.js');
  Object.assign(context, context.window.RouteModel);
  loadFunctions(context, ['remapDayPositions', 'invalidateDay', 'STALE_DAY_SIGNATURE', 'movePoint', 'deleteWaypoint']);
  context.movePoint = context.window.movePoint;
  context.deleteWaypoint = context.window.deleteWaypoint;
  return context;
}

const names = (day) => [day.from, ...day.waypoints, day.to].map((item) => item.name);
const plain = (value) => JSON.parse(JSON.stringify(value));
const offsetsOf = (context) => plain(context.route.labelOffsets);
const elevations = (context) => plain(context.route.pointInfoCache.days[0].points.map((item) => item.elevationM));

test('拖到目标点上时，被拖的点真的落到目标点的位置', () => {
  const context = setup();
  context.movePoint(0, 3, 4, 'point');
  assert.deepEqual(names(context.route.days[0]), ['起点', '点A', '点B', '终点', '点C']);
});

test('相邻点位互换不再是空操作', () => {
  const context = setup();
  const before = names(context.route.days[0]);
  context.movePoint(0, 1, 2, 'point');
  const after = names(context.route.days[0]);
  assert.notDeepEqual(after, before, '拖到紧邻的下一个点必须真的换位');
  assert.deepEqual(after, ['起点', '点B', '点A', '点C', '终点']);
});

test('槽位拖放仍然按“插入到缝隙前”的语义执行', () => {
  const context = setup();
  context.movePoint(0, 1, 3, 'slot');
  assert.deepEqual(names(context.route.days[0]), ['起点', '点B', '点A', '点C', '终点']);
});

test('换位后文字偏移跟着点位走，不会留在旧槽位上', () => {
  const context = setup();
  context.movePoint(0, 3, 4, 'point');
  const offsets = offsetsOf(context);
  assert.deepEqual(offsets['o:0:from'], {x: 0.1, y: 0.1}, '起点没动，偏移保持');
  assert.deepEqual(offsets['o:0:w:0'], {x: 0.2, y: 0}, '点A没动，偏移保持');
  assert.deepEqual(offsets['o:0:w:1'], {x: 0, y: 0.3}, '点B留在 w:1，偏移还是自己的');
  assert.deepEqual(offsets['o:0:w:2'], {x: 0, y: 0.5}, '原终点变成途经点 w:2，偏移跟着走');
  assert.deepEqual(offsets['o:0:to'], {x: 0.4, y: 0}, '点C成为终点，带走自己的偏移');
  assert.equal(Object.keys(offsets).filter((key) => key.startsWith('o:0:')).length, 5, '不留下多余的槽位键');
});

test('换位后海拔和天气跟着点位走', () => {
  const context = setup();
  context.movePoint(0, 3, 4, 'point');
  assert.deepEqual(elevations(context), [100, 101, 102, 104, 103]);
});

test('删除途经点时后面的点位状态整体前移', async () => {
  const context = setup();
  await context.deleteWaypoint(0, 1);
  assert.deepEqual(names(context.route.days[0]), ['起点', '点A', '点C', '终点']);
  assert.deepEqual(elevations(context), [100, 101, 103, 104]);
  assert.deepEqual(offsetsOf(context)['o:0:w:1'], {x: 0.4, y: 0}, '点C顶上来接住 w:1');
  assert.deepEqual(offsetsOf(context)['o:0:to'], {x: 0, y: 0.5});
  assert.equal(offsetsOf(context)['o:0:w:2'], undefined);
});

test('换位只影响本天，别的天不受牵连', () => {
  const context = setup();
  context.route.days.push({...buildDay(), title: '第 2 天'});
  context.route.labelOffsets['o:1:w:0'] = {x: 0.6, y: 0.6};
  context.movePoint(0, 3, 4, 'point');
  assert.deepEqual(offsetsOf(context)['o:1:w:0'], {x: 0.6, y: 0.6});
});

test('增删整天时，后面几天的时间键整体平移', () => {
  const context = setup();
  context.route.days.push({...buildDay(), title: '第 2 天'});
  context.route.labelOffsets['o:1:from'] = {x: 0.7, y: -0.2};
  context.route.days.splice(1, 0, {...buildDay(), title: '插入的一天'});
  assert.equal(context.shiftDayLabelOffsets(context.route, 1, 1), true);
  assert.deepEqual(offsetsOf(context)['o:2:from'], {x: 0.7, y: -0.2});
  assert.equal(offsetsOf(context)['o:1:from'], undefined);
  context.route.days.splice(1, 1);
  assert.equal(context.shiftDayLabelOffsets(context.route, 1, -1), true);
  assert.deepEqual(offsetsOf(context)['o:1:from'], {x: 0.7, y: -0.2});
});

test('同一天出现两次同一个点时，各自的偏移不会互相顶替', () => {
  const shared = point('茶卡盐湖', 99.0, 36.0);
  const route = {
    id: 'R2',
    name: '重复点位',
    days: [{
      title: '第 1 天',
      from: point('起点', 100.0, 30.0),
      waypoints: [shared, point('中间', 101.0, 30.0), shared],
      to: point('终点', 102.0, 30.0)
    }],
    labelOffsets: {
      'o:0:w:0': {x: 0.1, y: 0},
      'o:0:w:1': {x: 0.2, y: 0},
      'o:0:w:2': {x: 0.3, y: 0}
    },
    segmentCache: {}
  };
  const context = setup(route);
  context.movePoint(0, 3, 0, 'slot');
  assert.deepEqual(names(context.route.days[0]), ['茶卡盐湖', '起点', '茶卡盐湖', '中间', '终点']);
  const offsets = offsetsOf(context);
  assert.deepEqual(offsets['o:0:from'], {x: 0.3, y: 0}, '被拖动的那个重复点带走自己的偏移');
  assert.deepEqual(offsets['o:0:w:1'], {x: 0.1, y: 0}, '留在原位的重复点保持自己的偏移');
  assert.deepEqual(offsets['o:0:w:2'], {x: 0.2, y: 0});
});
