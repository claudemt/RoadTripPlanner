const test = require('node:test');
const assert = require('node:assert/strict');
const {createBrowserContext, loadFunctions} = require('./helpers/browser-functions');
const vm = require('node:vm');

const sandbox = {percent: 0, frames: 0, totalFrames: 0, etaSeconds: null};
const context = createBrowserContext({
  exportProgress: sandbox,
  setExportProgress: (next) => {
    sandbox.percent = Number.isFinite(Number(next.percent)) ? Math.max(sandbox.percent, Number(next.percent)) : sandbox.percent;
    if (next.frames != null) sandbox.frames = next.frames;
    if (next.totalFrames != null) sandbox.totalFrames = next.totalFrames;
    if (next.etaSeconds != null) sandbox.etaSeconds = next.etaSeconds;
  }
});
loadFunctions(context, ['updateProgressFromRemotionLog', 'parseRemotionEtaSeconds', 'toLabelOffsets'], 'server/route-render-server.js');

const reset = () => {
  sandbox.percent = 0;
  sandbox.frames = 0;
  sandbox.totalFrames = 0;
  sandbox.etaSeconds = null;
};
const render = (text) => vm.runInContext('updateProgressFromRemotionLog', context)(text, 24, 78, 'mp4', '正在渲染 MP4…');
const toLabelOffsets = vm.runInContext('toLabelOffsets', context);

test('按帧数比例推进渲染进度，并带上帧数与剩余时间', () => {
  reset();
  render('Rendered 500/1000, time remaining: 3m 20s');
  assert.equal(sandbox.frames, 500);
  assert.equal(sandbox.totalFrames, 1000);
  assert.equal(sandbox.etaSeconds, 200);
  assert.ok(sandbox.percent > 24 && sandbox.percent < 78, `percent=${sandbox.percent}`);
  const half = sandbox.percent;
  render('Rendered 950/1000, time remaining: 12s');
  assert.ok(sandbox.percent > half, '后续帧应该继续推进');
  assert.ok(sandbox.percent < 78, '未渲染完不应到达区间顶端');
});

test('打包阶段的百分比只占一点预热区间，不会吃掉整段渲染进度', () => {
  reset();
  render('Bundling 100%');
  assert.ok(sandbox.percent > 24, '预热应该有反馈');
  assert.ok(sandbox.percent <= 26, `打包阶段不该冲到高处，实际 ${sandbox.percent}`);
});

test('被切断的帧号不会把进度算飞', () => {
  reset();
  render('Rendered 12/16');
  assert.equal(sandbox.frames, 0, '不完整的帧号应当忽略');
  assert.equal(sandbox.percent, 0);
  render('Rendered 12/1665, time remaining: 4m 38s');
  assert.equal(sandbox.totalFrames, 1665);
  assert.ok(sandbox.percent < 30, `刚开渲染不该跳太高，实际 ${sandbox.percent}`);
});

test('标签位置表只保留有效且非零的偏移', () => {
  const map = toLabelOffsets({
    'n:赛里木湖': {x: 0.2, y: -0.1},
    'n:零偏移': {x: 0, y: 0},
    'n:越界': {x: 9, y: 0},
    'n:坏数据': {x: 'abc', y: 1},
    '': {x: 1, y: 1}
  });
  assert.deepEqual(Object.keys(map).sort(), ['n:赛里木湖', 'n:越界']);
  assert.deepEqual({...map['n:越界']}, {x: 2, y: 0});
});
