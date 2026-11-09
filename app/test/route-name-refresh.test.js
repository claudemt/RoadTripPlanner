const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {createBrowserContext, loadFunctions} = require('./helpers/browser-functions');

// 极简 Supabase 查询模拟：只覆盖 select / eq / maybeSingle / await
function fakeSupabase(rows) {
  const table = () => {
    let current = [...rows];
    const api = {
      select() {
        return api;
      },
      eq(column, value) {
        current = current.filter((row) => String(row[column]) === String(value));
        return api;
      },
      maybeSingle() {
        return Promise.resolve({data: current[0] || null, error: null});
      },
      then(resolve) {
        return Promise.resolve(resolve({data: current, error: null}));
      }
    };
    return api;
  };
  return {from: table};
}

function loadHelpers() {
  const context = createBrowserContext();
  context.SUPABASE_TABLES = {routes: 'routes'};
  loadFunctions(context, [
    'ROUTE_VIEW_ID_PREFIX',
    'routeViewId',
    'isRouteViewId',
    'safeName',
    'normalizeCloudRouteId',
    'routeNameKey',
    'findRouteIdByName',
    'resolveCloudRouteId'
  ], 'server/route-render-server.js');
  vm.runInContext(
    'globalThis.__helpers = {routeViewId, isRouteViewId, normalizeCloudRouteId, routeNameKey, findRouteIdByName, resolveCloudRouteId};',
    context
  );
  return context.__helpers;
}

const identity = {email: 'me@example.com'};

test('路线名比较忽略大小写与多余空格', () => {
  const {routeNameKey} = loadHelpers();
  assert.equal(routeNameKey('  \u9752\u7518\u5927\u73AF\u7EBF  '), '\u9752\u7518\u5927\u73af\u7ebf');
  assert.equal(routeNameKey('Route  A'), 'route a');
});

test('同名路线返回已有 ID，跳过视图行', async () => {
  const {findRouteIdByName, routeViewId} = loadHelpers();
  const supabase = fakeSupabase([
    {id: routeViewId('route-old'), name: '\u6ec7\u5317\u73af\u7ebf', owner_email: 'me@example.com'},
    {id: 'route-old', name: '\u6ec7\u5317\u73af\u7ebf', owner_email: 'me@example.com'}
  ]);
  assert.equal(await findRouteIdByName(supabase, 'me@example.com', '\u6ec7\u5317\u73af\u7ebf', 'route-new'), 'route-old');
});

test('请求的 ID 已存在时原样返回', async () => {
  const {resolveCloudRouteId} = loadHelpers();
  const supabase = fakeSupabase([{id: 'route-old', name: '\u6ec7\u5317\u73af\u7ebf', owner_email: 'me@example.com'}]);
  const id = await resolveCloudRouteId(supabase, identity, {id: 'route-old', name: '\u6ec7\u5317\u73af\u7ebf', owner_email: 'me@example.com'});
  assert.equal(id, 'route-old');
});

test('请求 ID 不存在但存在同名路线时沿用已有 ID（导出等于刷新）', async () => {
  const {resolveCloudRouteId} = loadHelpers();
  const supabase = fakeSupabase([{id: 'route-old', name: '\u9752\u7518\u5927\u73AF\u7EBF', owner_email: 'me@example.com'}]);
  const id = await resolveCloudRouteId(supabase, identity, {id: 'route-local-1', name: '\u9752\u7518\u5927\u73AF\u7EBF'});
  assert.equal(id, 'route-old');
});

test('没有同名路线时保留请求 ID，另建新路线', async () => {
  const {resolveCloudRouteId} = loadHelpers();
  const supabase = fakeSupabase([{id: 'route-other', name: '\u4F0A\u7281\u5C0F\u73AF\u7EBF', owner_email: 'me@example.com'}]);
  const id = await resolveCloudRouteId(supabase, identity, {id: 'route-local-2', name: '\u65B0\u8DEF\u7EBF'});
  assert.equal(id, 'route-local-2');
});

test('查询失败时回退到请求 ID，不阻塞导出', async () => {
  const {resolveCloudRouteId} = loadHelpers();
  const broken = {
    from() {
      const api = {
        select: () => api,
        eq: () => api,
        maybeSingle: async () => {
          throw new Error('db down');
        }
      };
      return api;
    }
  };
  const id = await resolveCloudRouteId(broken, identity, {id: 'route-local-3', name: '\u65B0\u8DEF\u7EBF'});
  assert.equal(id, 'route-local-3');
});
