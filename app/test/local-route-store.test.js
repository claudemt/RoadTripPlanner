const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createLocalRouteStore} = require('../server/services/local-route-store');

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'roadtrip-local-'));
const baseRoute = (overrides = {}) => ({
  id: 'r1',
  name: '川西环线',
  description: '测试路线',
  days: [
    {
      from: {name: '成都', lng: 104.06, lat: 30.67},
      to: {name: '康定', lng: 101.96, lat: 30.05},
      waypoints: [{name: '雅安', lng: 103.0, lat: 29.98}]
    }
  ],
  ...overrides
});

// 本机自用：flat=true，路线直接放在 routes/<路线名>/，没有账号目录。
const storeFor = () => {
  const routeRoot = path.join(tempRoot(), 'routes');
  const store = createLocalRouteStore({routeRoot, userSegment: (email) => String(email || 'local').toLowerCase(), flat: true});
  return {routeRoot, store, email: 'local'};
};

test('本地仓库：保存后可以按账号列出并读回路线', () => {
  const {store, routeRoot, email} = storeFor();
  const result = store.save(email, {routeData: baseRoute(), mapLayer: 'satellite'});
  assert.equal(result.ok, true);
  assert.equal(result.route.id, 'r1');
  assert.equal(result.route.map_layer, 'satellite');
  const list = store.list(email);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, '川西环线');
  assert.equal(list[0].dayCount, 1);
  assert.equal(list[0].cloud, false);
  assert.equal(list[0].routeData.name, '川西环线');
  assert.ok(fs.existsSync(path.join(routeRoot, '川西环线', 'route.json')));
  const metadata = JSON.parse(fs.readFileSync(path.join(routeRoot, '川西环线', 'metadata.json'), 'utf8'));
  assert.equal(metadata.ownerEmail, null);
  const read = store.read(email, 'r1');
  assert.equal(read.route_data.days.length, 1);
  assert.equal(read.name, '川西环线');
});

test('本地仓库：同名路线换 ID 保存等同刷新，不会新建一条', () => {
  const {store, email} = storeFor();
  store.save(email, {routeData: baseRoute()});
  const second = store.save(email, {routeData: baseRoute({id: 'another-id', description: '更新后'})});
  assert.equal(second.route.id, 'r1');
  const list = store.list(email);
  assert.equal(list.length, 1);
  assert.equal(list[0].routeData.description, '更新后');
});

test('本地仓库：视图单独保存并在下次保存路线时保留', () => {
  const {store, email} = storeFor();
  store.save(email, {routeData: baseRoute()});
  const view = {
    presentation: {mapLayer: 'satellite', hillshade: true},
    labelOffsets: {成都: {x: 0.2, y: -0.1}},
    mapView: {zoom: 8, center: [103, 30]}
  };
  assert.deepEqual(store.saveView(email, 'r1', view).ok, true);
  store.save(email, {routeData: baseRoute({description: '再次保存'})});
  const read = store.read(email, 'r1');
  assert.deepEqual(read.route_data.presentation, view.presentation);
  assert.deepEqual(read.route_data.labelOffsets, view.labelOffsets);
  assert.deepEqual(read.route_data.mapView, view.mapView);
});

test('本地仓库：改名会同步移动目录并保留已有产物', () => {
  const {store, routeRoot, email} = storeFor();
  store.save(email, {routeData: baseRoute()});
  const oldDir = path.join(routeRoot, '川西环线');
  fs.writeFileSync(path.join(oldDir, '川西环线.travel.md'), '# old', 'utf8');
  store.save(email, {routeData: baseRoute({name: '川西大环线'})});
  const newDir = path.join(routeRoot, '川西大环线');
  assert.equal(fs.existsSync(oldDir), false);
  assert.ok(fs.existsSync(path.join(newDir, 'route.json')));
  assert.ok(fs.existsSync(path.join(newDir, '川西环线.travel.md')));
  assert.equal(store.list(email).length, 1);
  assert.equal(store.list(email)[0].name, '川西大环线');
});

test('本地仓库：删除路线会移除整个目录', () => {
  const {store, routeRoot, email} = storeFor();
  store.save(email, {routeData: baseRoute()});
  assert.deepEqual(store.remove(email, 'r1').ok, true);
  assert.equal(store.list(email).length, 0);
  assert.equal(fs.existsSync(path.join(routeRoot, '川西环线')), false);
  assert.throws(() => store.read(email, 'r1'), /未找到/);
});

test('本地仓库：摘要列表不返回完整路线数据', () => {
  const {store, email} = storeFor();
  store.save(email, {routeData: baseRoute()});
  const [item] = store.list(email, {summary: true});
  assert.equal(item.routeData, undefined);
  assert.equal(item.dayCount, 1);
});

test('本地仓库：产物存在时给出可直接访问的本地地址', () => {
  const {store, routeRoot, email} = storeFor();
  store.save(email, {routeData: baseRoute()});
  const dir = path.join(routeRoot, '川西环线');
  fs.writeFileSync(path.join(dir, '川西环线.mp4'), Buffer.from([0, 0, 0, 0]));
  fs.writeFileSync(path.join(dir, '川西环线.route-map.png'), Buffer.from([137, 80, 78, 71]));
  const read = store.read(email, 'r1');
  assert.match(read.assetUrls.mp4, /^\/route\/%E5%B7%9D/);
  assert.match(read.assetUrls.mapImage, /route-map\.png\?v=/);
  assert.equal(read.assetStatus.mp4, 'ok');
  assert.equal(read.assetStatus.manualPdf, 'missing');
});

test('本地仓库：只有导出产物的目录也能被列出', () => {
  const {store, routeRoot, email} = storeFor();
  const dir = path.join(routeRoot, '只有产物');
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, '只有产物.route.json'), JSON.stringify(baseRoute({id: 'artifact-only', name: '只有产物'})), 'utf8');
  fs.writeFileSync(path.join(dir, '只有产物.mp4'), Buffer.from([0]));
  const list = store.list(email);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'artifact-only');
  assert.equal(list[0].mp4, true);
});
