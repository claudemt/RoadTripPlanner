const test = require('node:test');
const assert = require('node:assert/strict');
const {createBrowserContext, loadBrowserFile} = require('./helpers/browser-functions');

global.window = {};
require('../web/src/features/archive/archiveController.js');

const shouldRetry = window.ArchiveController.shouldRetryEmptyRouteLists;

test('empty route libraries stay in loading state only during the retry window', () => {
  assert.equal(shouldRetry({
    mineRoutes: [], publishedRoutes: [], publishedEnabled: true, elapsedMs: 0, limitMs: 15000,
  }), true);
  assert.equal(shouldRetry({
    mineRoutes: [], publishedRoutes: [], publishedEnabled: true, elapsedMs: 15000, limitMs: 15000,
  }), false);
});

test('empty library retry fetches fresh data rather than reusing the empty API cache', async () => {
  const memory = {};
  let requests = 0;
  let now = 1000;
  const elements = {archiveList: {innerHTML: ''}, routeManageStatus: {textContent: ''}};
  const context = createBrowserContext({location: {protocol: 'http:', origin: 'http://local'},
    localStorage: {getItem: (key) => memory[key] || null, setItem: (key, value) => {memory[key] = value;}},
    Date: {now: () => now}, setTimeout: (callback, delay) => {now += delay; Promise.resolve().then(callback);},
    fetch: async () => {requests++; return {ok: true, status: 200, json: async () => ({ok: true, routes: requests === 1 ? [] : [{name: 'ready route', safeName: 'ready'}]})};}});
  loadBrowserFile(context, 'web/src/api/localServiceClient.js');
  loadBrowserFile(context, 'web/src/features/archive/archiveController.js');
  const controller = context.window.ArchiveController.create({
    localService: context.window.LocalServiceClient.create({capabilities: {cloudRoutes: true}}),
    el: (id) => elements[id], getState: () => ({routeBook: {routes: []}, route: null}),
    renderRouteSelect: () => {}, renderDays: () => {}, cleanRouteName: (name) => name,
    escapeHtml: (value) => value, escapeJsAttr: (value) => value,
  });
  await controller.refresh();
  assert.equal(requests, 2);
  assert.equal(controller.getRoutes().length, 1);
  assert.equal(now - 1000, 3000);
});

test('offline route library identifies stale API data as local cache', async () => {
  const elements = {archiveList: {innerHTML: ''}, routeManageStatus: {textContent: ''}};
  const context = createBrowserContext();
  loadBrowserFile(context, 'web/src/features/archive/archiveController.js');
  const controller = context.window.ArchiveController.create({
    localService: {capabilities: {cloudRoutes: true},
      listRoutes: async () => ({response: {ok: true}, data: {ok: true, routes: [{name: 'cached', safeName: 'cached'}]}, stale: true}),
      routeAssetBase: () => '',
    },
    el: (id) => elements[id], getState: () => ({routeBook: {routes: []}, route: null}),
    renderRouteSelect: () => {}, renderDays: () => {}, cleanRouteName: (name) => name,
    escapeHtml: (value) => value, escapeJsAttr: (value) => value,
  });
  await controller.refresh();
  assert.equal(elements.routeManageStatus.textContent, '当前显示本机缓存。');
});

test('one populated route library renders immediately', () => {
  assert.equal(shouldRetry({
    mineRoutes: [{id: 'mine'}], publishedRoutes: [], publishedEnabled: true, elapsedMs: 0, limitMs: 15000,
  }), false);
  assert.equal(shouldRetry({
    mineRoutes: [], publishedRoutes: [{id: 'public'}], publishedEnabled: true, elapsedMs: 0, limitMs: 15000,
  }), false);
});

const cloudService = (routes) => ({
  capabilities: {cloudRoutes: true, publishedRoutes: true},
  listRoutes: async () => ({response: {ok: true}, data: {ok: true, routes}}),
  listPublishedRoutes: async () => ({response: {ok: true}, data: {ok: true, routes: []}}),
  routeAssetBase: () => ''
});

test('my routes are listed by pinyin instead of modified time', async () => {
  const elements = {archiveList: {innerHTML: ''}, routeManageStatus: {textContent: ''}};
  const context = createBrowserContext();
  loadBrowserFile(context, 'web/src/utils/sort.js');
  loadBrowserFile(context, 'web/src/features/archive/archiveController.js');
  const controller = context.window.ArchiveController.create({
    localService: cloudService([
      {name: '重庆小环线', safeName: 'cq', cloud: true, updatedAt: '2026-11-01T00:00:00Z'},
      {name: '阿坝环线', safeName: 'ab', cloud: true, updatedAt: '2026-01-01T00:00:00Z'},
      {name: '北京周边', safeName: 'bj', cloud: true, updatedAt: '2026-06-01T00:00:00Z'}
    ]),
    el: (id) => elements[id], getState: () => ({routeBook: {routes: []}, route: null}),
    renderRouteSelect: () => {}, renderDays: () => {}, cleanRouteName: (name) => name,
    escapeHtml: (value) => value, escapeJsAttr: (value) => value
  });
  await controller.refresh();
  assert.equal(controller.getRoutes().map((item) => item.name).join(','), '阿坝环线,北京周边,重庆小环线');
});

test('my route actions are merged into look, open, edit, download, update, publish, delete', async () => {
  const elements = {archiveList: {innerHTML: ''}, routeManageStatus: {textContent: ''}};
  const context = createBrowserContext();
  loadBrowserFile(context, 'web/src/utils/sort.js');
  loadBrowserFile(context, 'web/src/features/archive/archiveController.js');
  const controller = context.window.ArchiveController.create({
    localService: cloudService([{name: '青甘大环线', safeName: 'qg', cloud: true}]),
    el: (id) => elements[id], getState: () => ({routeBook: {routes: []}, route: null}),
    renderRouteSelect: () => {}, renderDays: () => {}, cleanRouteName: (name) => name,
    escapeHtml: (value) => value, escapeJsAttr: (value) => value
  });
  await controller.refresh();
  const html = controller.renderMyRouteItem(controller.getRoutes()[0], {editable: true});
  const labels = [...html.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((match) => match[1]);
  assert.deepEqual(labels, ['查看', '打开', '编辑', '下载', '更新', '发布', '✕']);
  assert.match(html, /class="small primary" onclick="accountPreviewRoute\('mine','qg'\)">查看</, '查看是橙色主按钮');
  assert.match(html, /class="small primary" onclick="exportArchivedRoute\('qg'\)">更新</, '更新是橙色主按钮');
  assert.doesNotMatch(html, /改名|介绍/, '改名与介绍已合并进编辑弹窗');
});
