const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const {createBrowserContext, loadFunctions} = require('./helpers/browser-functions');

const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'roadtrip-render-asset-test-'));
const payloads = new Map();

const context = createBrowserContext({
  fs,
  os,
  path,
  crypto,
  Buffer,
  setTimeout,
  clearTimeout,
  AbortSignal: {timeout: () => null},
  AMAP_ROOT: sandboxRoot,
  ROUTE_ROOT: path.join(sandboxRoot, 'routes'),
  REMOTION_ROOT: path.join(sandboxRoot, 'video'),
  ensureDir: (dir) => fs.mkdirSync(dir, {recursive: true}),
  sharpLib: null,
  fetch: async (url) => {
    const buffer = payloads.get(url);
    if (!buffer) return {ok: false, status: 404, headers: {get: () => ''}, arrayBuffer: async () => new ArrayBuffer(0)};
    return {
      ok: true,
      status: 200,
      headers: {get: (name) => (String(name).toLowerCase() === 'content-type' ? 'image/jpeg' : '')},
      arrayBuffer: async () => buffer
    };
  }
});

loadFunctions(context, [
  'RENDER_ASSET_DIR',
  'RENDER_ASSET_MAX_WIDTH',
  'RENDER_ASSET_QUALITY',
  'REMOTE_ASSET_ATTEMPTS',
  'REMOTE_ASSET_TIMEOUT_MS',
  'REMOTE_ASSET_PARALLEL',
  'isRemoteAsset',
  'assetExtension',
  'shrinkRenderAssetFile',
  'ExportCancelledError',
  'activeExport',
  'assertExportNotCancelled',
  'cleanupTempDir',
  'downloadRenderAsset',
  'normalizeAssetPath',
  'isPathInside',
  'resolvePublicAssetFile',
  'collectRemotionAssets',
  'collectRemoteSceneImages',
  'remapSceneImages',
  'prepareRemotionPublicDir'
], 'server/route-render-server.js');

const prepare = vm.runInContext('prepareRemotionPublicDir', context);
const assetExtension = vm.runInContext('assetExtension', context);

const createdDirs = [];
const runPrepare = async (videoData) => {
  const prepared = await prepare(videoData);
  createdDirs.push(prepared.publicDir);
  return prepared;
};

test.after(() => {
  createdDirs.forEach((dir) => fs.rmSync(dir, {recursive: true, force: true}));
  fs.rmSync(sandboxRoot, {recursive: true, force: true});
});

const buildVideoData = (images) => ({
  staticMapImage: null,
  presentation: {},
  days: [{points: [{name: 'A', scenic: {images}}, {name: 'B', scenic: {images: []}}]}]
});

test('景点私图先下载到本地再替换成相对路径，渲染不再依赖外网', async () => {
  const remote = 'https://example.supabase.co/storage/v1/object/sign/roadtrip-scene-private/a.jpg?token=abc';
  payloads.set(remote, Buffer.from('fake-jpeg-bytes'));
  const prepared = await runPrepare(buildVideoData([remote]));
  const images = prepared.videoData.days[0].points[0].scenic.images;
  assert.equal(prepared.failures.length, 0);
  assert.equal(prepared.localized, 1);
  assert.equal(images.length, 1);
  assert.match(images[0], /^render-assets\/scene-[0-9a-f]{20}\.jpg$/);
  assert.ok(fs.existsSync(path.join(prepared.publicDir, images[0])), '下载的文件应该落在临时 public 目录里');
  assert.equal(prepared.videoData.days[0].points[1].scenic.images.length, 0);
});

test('下载失败就丢掉这张图，不把外网地址留给渲染进程', async () => {
  const broken = 'https://example.supabase.co/storage/v1/object/sign/roadtrip-scene-private/missing.jpg';
  const prepared = await runPrepare(buildVideoData([broken]));
  assert.equal(prepared.localized, 0);
  assert.equal(prepared.failures.length, 1);
  assert.equal(prepared.videoData.days[0].points[0].scenic.images.length, 0);
});

test('本地相对路径保持原样，只复制不下载', async () => {
  const source = path.join(sandboxRoot, 'assets', 'cover.png');
  fs.mkdirSync(path.dirname(source), {recursive: true});
  fs.writeFileSync(source, Buffer.from('local-cover'));
  const prepared = await runPrepare(buildVideoData(['assets/cover.png']));
  const images = prepared.videoData.days[0].points[0].scenic.images;
  assert.equal(images.length, 1);
  assert.equal(images[0], 'assets/cover.png');
  assert.equal(prepared.localized, 0);
  assert.ok(fs.existsSync(path.join(prepared.publicDir, 'assets', 'cover.png')), '本地图片应该被复制进 public 目录');
});

test('签名 URL 带查询参数时按 content-type 推断扩展名', async () => {
  assert.equal(assetExtension('https://x/y?token=1', 'image/jpeg'), '.jpg');
  assert.equal(assetExtension('https://x/y.png?token=1'), '.png');
  assert.equal(assetExtension('https://x/y', ''), '.jpg');
});
