const test = require('node:test');
const assert = require('node:assert/strict');
const {createBrowserContext, loadBrowserFile, loadFunctions} = require('./helpers/browser-functions');

const videoData = () => ({
  days: [{
    points: [
      {name: '塔尔寺', scenic: {name: '塔尔寺', title: '塔尔寺', images: ['a.jpg']}},
      {name: '青海湖', scenic: {name: '青海湖', title: '青海湖', images: ['b.jpg']}}
    ]
  }]
});

function setup() {
  const context = createBrowserContext({route: {id: 'route-1', name: '青甘大环线'}, toast: () => {}});
  const saves = [];
  context.saveRoute = (showToast) => saves.push(showToast);
  loadFunctions(context, ['coverSpotsOf', 'collectCoverCandidates', 'resolveCoverSpots', 'rememberCoverSpots']);
  return {context, saves};
}

test('没有选择过封面时返回 null，弹窗默认勾选前四个', () => {
  const {context} = setup();
  assert.equal(context.resolveCoverSpots(videoData(), {id: 'route-1'}), null);
});

test('选过一次之后作为弹窗默认值返回', () => {
  const {context} = setup();
  assert.equal(context.resolveCoverSpots(videoData(), {coverSpots: ['青海湖']}).join(','), '青海湖');
});

test('选过「不使用封面」时默认一个都不勾', () => {
  const {context} = setup();
  assert.equal(context.resolveCoverSpots(videoData(), {coverSpots: []}).length, 0);
});

test('记录过的景点没有图片了就回退为默认，其余候选照旧过滤', () => {
  const {context} = setup();
  assert.equal(context.resolveCoverSpots(videoData(), {coverSpots: ['青海湖', '已删除的景点']}).join(','), '青海湖');
  assert.equal(context.resolveCoverSpots(videoData(), {coverSpots: ['已删除的景点']}), null);
});

test('封面选择写回路线并静默保存，重复保存不会触发', () => {
  const {context, saves} = setup();
  context.rememberCoverSpots(context.route, ['塔尔寺']);
  assert.equal(context.route.coverSpots.join(','), '塔尔寺');
  assert.equal(saves.length, 1);
  context.rememberCoverSpots(context.route, ['塔尔寺']);
  assert.equal(saves.length, 1, '同样的选择不重复保存');
});

test('导出时的路线快照保存封面，同时写回正在编辑的路线', () => {
  const {context, saves} = setup();
  const snapshot = {id: 'route-1'};
  context.rememberCoverSpots(snapshot, ['塔尔寺', '塔尔寺', '青海湖']);
  assert.equal(snapshot.coverSpots.join(','), '塔尔寺,青海湖', '去重');
  assert.equal(context.route.coverSpots.join(','), '塔尔寺,青海湖', '同步到正在编辑的路线');
  assert.equal(saves.length, 1);
});

test('封面最多保留 4 个景点', () => {
  const {context} = setup();
  context.rememberCoverSpots(context.route, ['a', 'b', 'c', 'd', 'e']);
  assert.equal(context.route.coverSpots.join(','), 'a,b,c,d');
});
