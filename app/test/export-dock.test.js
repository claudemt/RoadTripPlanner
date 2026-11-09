const test = require('node:test');
const assert = require('node:assert/strict');
const {createBrowserContext, loadBrowserFile} = require('./helpers/browser-functions');

const makeElement = () => {
  const classes = new Set();
  return {
    hidden: false,
    textContent: '',
    innerHTML: '',
    disabled: false,
    style: {},
    classList: {
      toggle(name, force) {
        const next = force === undefined ? !classes.has(name) : Boolean(force);
        if (next) classes.add(name);
        else classes.delete(name);
      },
      contains: (name) => classes.has(name)
    },
    setAttribute() {},
    getAttribute() { return null; },
    addEventListener() {}
  };
};

function setup({listExports, cancelExport, toast} = {}) {
  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement());
    return elements.get(id);
  };
  const context = createBrowserContext({el});
  loadBrowserFile(context, 'web/src/features/export/exportTaskController.js');
  const controller = context.window.ExportTaskController.create({
    el,
    localService: {
      listExports: listExports || (async () => ({response: {ok: true}, data: {ok: true, tasks: [], queueLength: 0}})),
      getExportProgress: async () => ({response: {ok: true}, data: {ok: true}}),
      cancelExport: cancelExport || (async () => ({response: {ok: true}, data: {ok: true, cancelled: false}}))
    },
    toast: toast || (() => {})
  });
  return {controller, el};
}

const queueFixture = ({t1Status = 'running', currentTaskId = 't1', includeQueued = true} = {}) => ({
  ok: true,
  rendering: Boolean(currentTaskId),
  currentTaskId,
  queueLength: includeQueued ? 2 : 0,
  queued: includeQueued
    ? [
        {taskId: 't2', routeName: '川西环线', position: 1},
        {taskId: 't3', routeName: '甘南草原', position: 2}
      ]
    : [],
  tasks: [
    {
      taskId: 't1',
      routeName: '伊犁环线',
      status: t1Status,
      progress: t1Status === 'running'
        ? {active: true, percent: 37, frames: 100, totalFrames: 1000, etaSeconds: 427, message: '正在渲染 MP4…'}
        : {active: false, phase: 'cancelled', message: '导出已取消'}
    },
    {taskId: 't2', routeName: '川西环线', status: includeQueued ? 'queued' : 'cancelled'},
    {taskId: 't3', routeName: '甘南草原', status: includeQueued ? 'queued' : 'cancelled'}
  ]
});

test('running and queued exports render as separate cards', () => {
  const {controller, el} = setup();
  controller.renderQueue(queueFixture());

  const html = el('exportDockTasks').innerHTML;
  assert.equal(el('exportDockHandleText').textContent, '导出中');
  assert.equal(el('exportTaskDock').hidden, false);
  assert.equal(el('exportTaskDock').classList.contains('active'), true);
  assert.match(html, /伊犁环线/);
  assert.match(html, /渲染 MP4 · 100\/1000 帧 · 剩 7 分 7 秒/);
  assert.match(html, /width:37%/);
  assert.match(html, /川西环线/);
  assert.match(html, /甘南草原/);
  assert.match(html, /排队中，前面还有 1 个/);
  assert.match(html, /排队中，前面还有 2 个/);
  assert.equal((html.match(/data-export-cancel=/g) || []).length, 3);
});

test('the first queued card says it starts soon', () => {
  const {controller, el} = setup();
  controller.renderQueue({
    ok: true,
    rendering: false,
    currentTaskId: null,
    queueLength: 1,
    queued: [{taskId: 't2', routeName: '川西环线', position: 0}],
    tasks: [{taskId: 't2', routeName: '川西环线', status: 'queued'}]
  });

  assert.equal(el('exportTaskDock').classList.contains('active'), true);
  assert.match(el('exportDockTasks').innerHTML, /排队中，即将开始/);
  assert.match(el('exportDockTasks').innerHTML, /data-export-cancel="t2"/);
});

test('cancelling a queued card keeps the remaining export cards', async () => {
  let cancelled = false;
  const {controller, el} = setup({
    listExports: async () => ({
      response: {ok: true},
      data: cancelled
        ? {
            ok: true,
            rendering: true,
            currentTaskId: 't1',
            queueLength: 1,
            queued: [{taskId: 't3', routeName: '甘南草原', position: 1}],
            tasks: [
              {taskId: 't1', routeName: '伊犁环线', status: 'running', progress: {active: true, percent: 52, message: '正在渲染 MP4…'}},
              {taskId: 't2', routeName: '川西环线', status: 'cancelled'},
              {taskId: 't3', routeName: '甘南草原', status: 'queued'}
            ]
          }
        : queueFixture()
    }),
    cancelExport: async () => {
      cancelled = true;
      return {response: {ok: true}, data: {ok: true, cancelled: true}};
    }
  });

  const task = await controller.cancel({taskId: 't2', silent: true});
  assert.equal(task.status, 'cancelled');
  const html = el('exportDockTasks').innerHTML;
  assert.equal(el('exportTaskDock').classList.contains('active'), true);
  assert.match(html, /伊犁环线/);
  assert.doesNotMatch(html, /川西环线/);
  assert.match(html, /甘南草原/);
  assert.match(html, /排队中，前面还有 1 个/);
});

test('cancelling the last export shows one cancelled card', async () => {
  let cancelled = false;
  const {controller, el} = setup({
    listExports: async () => ({
      response: {ok: true},
      data: cancelled
        ? {
            ok: true,
            rendering: false,
            currentTaskId: null,
            queueLength: 0,
            queued: [],
            tasks: [{taskId: 't1', routeName: '伊犁环线', status: 'cancelled', progress: {phase: 'cancelled'}}]
          }
        : queueFixture({includeQueued: false})
    }),
    cancelExport: async () => {
      cancelled = true;
      return {response: {ok: true}, data: {ok: true, cancelled: true}};
    }
  });

  await controller.cancel({taskId: 't1', silent: true});
  const html = el('exportDockTasks').innerHTML;
  assert.equal(el('exportTaskDock').hidden, false);
  assert.equal(el('exportTaskDock').classList.contains('cancelled'), true);
  assert.equal(el('exportDockHandleText').textContent, '已取消');
  assert.match(html, /已取消，过程文件已清理。/);
  assert.doesNotMatch(html, /data-export-cancel=/);
});

test('preparation prompt keeps the dock active and cancel closes the prompt', async () => {
  const {controller, el} = setup();
  let closed = 0;
  controller.setPrepareCancel(() => { closed += 1; });
  controller.renderDock({
    rendering: true,
    progress: {active: true, phase: 'prepare', message: '请选择封面景点…', percent: 8}
  }, {keepVisible: true});

  assert.equal(el('exportDockHandleText').textContent, '导出中');
  assert.match(el('exportDockTasks').innerHTML, /请选择封面景点/);
  assert.match(el('exportDockTasks').innerHTML, /data-export-cancel=/);
  assert.equal(el('exportTaskDock').classList.contains('no-cancel'), false);

  const result = await controller.cancel();
  assert.equal(result, null);
  assert.equal(closed, 1);
  assert.equal(el('exportTaskDock').hidden, true);
});
