const test = require('node:test');
const assert = require('node:assert/strict');
const {createBrowserContext, loadFunctions} = require('./helpers/browser-functions');

function setup() {
  const context = createBrowserContext();
  context.localService = {
    routeAssetBase: (item) => `https://app/route/${item.safeName}/${item.fileBase || item.safeName}`,
    routePreviewImageUrl: (id, version) => `https://app/api/v1/routes/${encodeURIComponent(id)}/preview.png${version ? `?v=${encodeURIComponent(version)}` : ''}`
  };
  loadFunctions(context, ['routePreviewAssets']);
  return context.routePreviewAssets;
}

test('云端路线的总览图走服务端预览接口，不再拼本地 /route/ 地址', () => {
  const build = setup();
  const assets = build({
    id: 'route-abc',
    safeName: 'route-abc',
    cloud: true,
    mapImage: true,
    updatedAt: '2026-11-09T06:11:00.247Z',
    assetUrls: {mp4: 'https://cdn/x.mp4?token=1', mapImage: 'https://cdn/x.png?token=1'}
  }, 'route-abc');
  assert.equal(assets.mapImage, 'https://app/api/v1/routes/route-abc/preview.png?v=2026-11-09T06%3A11%3A00.247Z');
  assert.equal(assets.mp4, 'https://cdn/x.mp4?token=1');
});

test('云端路线没有总览图时不产出地址，避免破图', () => {
  const build = setup();
  const assets = build({id: 'route-abc', cloud: true, mapImage: false}, 'route-abc');
  assert.equal(assets.mapImage, '');
  assert.equal(assets.mp4, '');
});

test('本机归档路线仍用原来的 /route/ 直出地址', () => {
  const build = setup();
  const assets = build({
    safeName: 'route-local',
    fileBase: 'route-local',
    mapImage: true,
    mp4: true,
    updatedAt: '2026-11-01T00:00:00.000Z'
  }, 'route-local');
  assert.equal(assets.mapImage, 'https://app/route/route-local/route-local.route-map.png?preview=1&v=2026-11-01T00%3A00%3A00.000Z');
  assert.equal(assets.mp4, 'https://app/route/route-local/route-local.mp4?v=2026-11-01T00%3A00%3A00.000Z');
});

test('没有对应记录时不给地址', () => {
  const build = setup();
  const assets = build(null, 'route-x');
  assert.equal(assets.mapImage, '');
  assert.equal(assets.mp4, '');
});
