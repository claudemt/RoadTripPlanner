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
