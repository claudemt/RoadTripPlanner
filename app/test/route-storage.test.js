const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const zlib = require('node:zlib');
const {createBrowserContext, loadFunctions} = require('./helpers/browser-functions');

function loadServerHelpers() {
  const context = createBrowserContext({Buffer, zlib});
  loadFunctions(context, [
    'ASSET_KEYS',
    'ASSET_ALIASES',
    'canonicalAssetKey',
    'pickRouteAssetMap',
    'ROUTE_VIEW_ID_PREFIX',
    'routeViewId',
    'isRouteViewId',
    'routeIdFromViewId',
    'pickRouteViewState',
    'mergeRouteViewState',
    'buildRouteSummaryData',
    'routeRowPair',
    'JSON_GZIP_MIN_BYTES',
    'send'
  ], 'server/route-render-server.js');
  vm.runInContext(
    'globalThis.__serverHelpers = {send, pickRouteViewState, mergeRouteViewState, buildRouteSummaryData, routeRowPair, routeViewId, isRouteViewId, routeIdFromViewId};',
    context
  );
  return context.__serverHelpers;
}

function response(acceptEncoding = '') {
  const state = {};
  const res = {
    req: {headers: {'accept-encoding': acceptEncoding}},
    writeHead(status, headers) {
      state.status = status;
      state.headers = headers;
    },
    end(body) {
      state.body = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''));
    }
  };
  return {res, state};
}

test('JSON 响应使用紧凑格式且小响应不压缩', () => {
  const {send} = loadServerHelpers();
  const {res, state} = response('gzip');
  send(res, 200, {ok: true, route: {id: 'r1'}});
  assert.equal(state.status, 200);
  assert.equal(state.headers['Content-Encoding'], undefined);
  assert.equal(state.body.toString(), '{"ok":true,"route":{"id":"r1"}}');
});

test('大 JSON 响应启用 gzip', () => {
  const {send} = loadServerHelpers();
  const payload = {ok: true, text: 'x'.repeat(300 * 1024)};
  const {res, state} = response('br, gzip');
  send(res, 200, payload);
  assert.equal(state.headers['Content-Encoding'], 'gzip');
  assert.ok(state.body.length < 100 * 1024);
  assert.deepEqual(JSON.parse(zlib.gunzipSync(state.body).toString()), payload);
});

test('非 JSON 响应不压缩', () => {
  const {send} = loadServerHelpers();
  const {res, state} = response('gzip');
  send(res, 200, 'raw', 'text/plain;charset=utf-8');
  assert.equal(state.headers['Content-Encoding'], undefined);
  assert.equal(state.body.toString(), 'raw');
});

test('视图状态只提取展示、标签和地图视野', () => {
  const {pickRouteViewState, mergeRouteViewState} = loadServerHelpers();
  const route = {
    name: '川北甘南线',
    presentation: {mapLayer: 'satellite'},
    labelOffsets: {'o:0:to': {x: 0.1, y: -0.2}},
    mapView: {zoom: 8},
    days: [{from: {name: 'a'}}]
  };
  assert.deepEqual(JSON.parse(JSON.stringify(pickRouteViewState(route))), {
    presentation: {mapLayer: 'satellite'},
    labelOffsets: {'o:0:to': {x: 0.1, y: -0.2}},
    mapView: {zoom: 8}
  });
  const merged = JSON.parse(JSON.stringify(mergeRouteViewState(route, {mapView: {zoom: 11}})));
  assert.equal(merged.name, '川北甘南线');
  assert.equal(merged.days.length, 1);
  assert.deepEqual(merged.mapView, {zoom: 11});
  assert.deepEqual(merged.presentation, {mapLayer: 'satellite'});
});

test('摘要行只保留轻量元数据与资源描述', () => {
  const {buildRouteSummaryData} = loadServerHelpers();
  const summary = buildRouteSummaryData({
    description: '雪山与草原',
    days: [{}, {}],
    _assets: {
      mp4: {storageBucket: 'b', storagePath: 'p.mp4'},
      unknown: {storageBucket: 'b', storagePath: 'u'},
      productZip: {storageBucket: 'b', storagePath: 'p.zip'}
    },
    _assetSignature: {hash: 'abc', updatedAt: '2026-01-01T00:00:00.000Z'},
    _assetStatus: {mp4: 'ok'}
  });
  assert.equal(summary.description, '雪山与草原');
  assert.equal(summary.dayCount, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(Object.keys(summary.assets))), ['mp4', 'productZip']);
  assert.equal(summary.signature.hash, 'abc');
  assert.deepEqual(JSON.parse(JSON.stringify(summary.status)), {mp4: 'ok'});
});

test('保存时主行与视图行使用同一路由 ID 并原子写入', () => {
  const {routeRowPair, routeViewId, isRouteViewId, routeIdFromViewId} = loadServerHelpers();
  const identity = {email: 'user@example.com'};
  const routeData = {id: 'r1', name: '川北甘南线', days: [{}, {}, {}], _assets: {}};
  const rows = routeRowPair(identity, {
    id: 'r1',
    name: '川北甘南线',
    routeData,
    viewData: {mapView: {zoom: 8}, _summary: {dayCount: 3}},
    mapLayer: 'standard'
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, 'r1');
  assert.equal(rows[0].owner_email, identity.email);
  assert.equal(rows[1].id, routeViewId('r1'));
  assert.equal(rows[0].updated_at, rows[1].updated_at);
  assert.equal(rows[0].map_layer, rows[1].map_layer);
  assert.equal(rows[0].name, rows[1].name);
  assert.deepEqual(rows[1].route_data._summary, {dayCount: 3});
  assert.equal(isRouteViewId(rows[1].id), true);
  assert.equal(routeIdFromViewId(rows[1].id), 'r1');
});
