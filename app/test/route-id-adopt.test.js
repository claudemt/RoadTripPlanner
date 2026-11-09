const test = require('node:test');
const assert = require('node:assert/strict');
const {createBrowserContext, loadFunctions} = require('./helpers/browser-functions');

function setup(routes = [], activeRouteId = '') {
  const context = createBrowserContext();
  context.routeBook = {routes, activeRouteId};
  context.route = routes.find((item) => item.id === activeRouteId) || routes[0] || null;
  context.saved = 0;
  context.rendered = 0;
  context.routeStore = {save: () => { context.saved += 1; }};
  context.renderRouteSelect = () => { context.rendered += 1; };
  loadFunctions(context, ['adoptServerRouteId']);
  return context;
}

test('导出后服务端改用同名路线已有 ID 时，本地路线同步换 ID', () => {
  const context = setup([{id: 'route-local-1', name: '青甘大环线'}], 'route-local-1');
  const changed = context.adoptServerRouteId('route-local-1', 'route-old');
  assert.equal(changed, true);
  assert.equal(context.routeBook.routes[0].id, 'route-old');
  assert.equal(context.routeBook.activeRouteId, 'route-old');
  assert.equal(context.route.id, 'route-old');
  assert.equal(context.saved, 1);
  assert.equal(context.rendered, 1);
});

test('本地已有同 ID 条目时合并，不留下两条同名路线', () => {
  const context = setup([
    {id: 'route-local-1', name: '青甘大环线'},
    {id: 'route-old', name: '青甘大环线'}
  ], 'route-local-1');
  context.adoptServerRouteId('route-local-1', 'route-old');
  assert.equal(context.routeBook.routes.length, 1);
  assert.equal(context.routeBook.routes[0].id, 'route-old');
  assert.equal(context.routeBook.activeRouteId, 'route-old');
});

test('ID 相同或缺少参数时不做任何改动', () => {
  const context = setup([{id: 'route-a', name: 'A'}], 'route-a');
  assert.equal(context.adoptServerRouteId('route-a', 'route-a'), false);
  assert.equal(context.adoptServerRouteId('', 'route-b'), false);
  assert.equal(context.adoptServerRouteId('route-a', ''), false);
  assert.equal(context.routeBook.routes.length, 1);
  assert.equal(context.saved, 0);
});
