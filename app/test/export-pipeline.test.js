const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const {createBrowserContext, loadFunctions} = require('./helpers/browser-functions');

test('PDF results survive export and MP4 optimization can fall back without losing the video', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'export-pipeline-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const calls = [];
  const context = createBrowserContext({fs, path, PORT: 6137, USER_EMAIL_HEADER: 'x-auth-request-email',
    REMOTION_WIDTH: 1920, REMOTION_HEIGHT: 1080,
    archivePayload: () => ({dir: directory, safeName: 'route', mapBgImage: path.join(directory, 'bg.png'), mapBgMeta: path.join(directory, 'bg.json')}),
    assertExportNotCancelled: () => {}, setExportProgress: () => {}, writeRouteSnapshot: () => {},
    ensureExportBrowser: async () => 'chromium', loadJson: () => ({}),
    createMapBackgroundPlan: () => ({width: 1920, height: 1080}), canReuseMapBackground: () => false,
    runRemotionStill: async () => {throw new Error('map cache unavailable');},
    runRemotion: async ({output}) => {fs.writeFileSync(output, 'original-video'); return {output};},
    runFfmpegFaststart: async () => {throw new Error('optimization unavailable');},
    probeVideoBitrate: async () => 1000000,
    renderOverviewAndPdf: async (options) => {calls.push(options); options.onPdf('/generated/manual.pdf'); options.onImage('/generated/map.png');},
    uploadExportedRouteAssets: async () => ({}),
  });
  loadFunctions(context, ['exportRouteBundle'], 'server/route-render-server.js');
  const result = await vm.runInContext('exportRouteBundle', context)({renderVideo: true, host: 'untrusted.example', videoData: {days: []}}, directory, {email: 'user@example.com'}, 'test_snapshot');
  assert.equal(result.manualPdf, '/generated/manual.pdf');
  assert.equal(result.routeMapImage, '/generated/map.png');
  assert.equal(fs.readFileSync(result.output, 'utf8'), 'original-video');
  assert.match(result.videoError, /MP4/);
  assert.equal(calls[0].snapshotUrl, 'http://127.0.0.1:6137/?snapshot=test_snapshot');
  assert.equal(calls[0].snapshotHeaders['x-auth-request-email'], 'user@example.com');
});

test('overview snapshot fallback reports success and still creates a PDF', async () => {
  const images = [];
  const errors = [];
  const context = createBrowserContext({path,
    assertExportNotCancelled: () => {}, setExportProgress: () => {}, cleanupRouteSnapshot: () => {},
    overviewCanvasPlan: () => ({width: 1280, height: 720, scale: 3}),
    captureMapSnapshot: async () => {throw new Error('snapshot failed');},
    runRemotionStill: async () => {}, renderMarkdownPdf: async () => {},
  });
  loadFunctions(context, ['renderOverviewAndPdf'], 'server/route-render-server.js');
  let pdf;
  await vm.runInContext('renderOverviewAndPdf', context)({baseVideoData: {}, payload: {}, archived: {dir: '/exports', safeName: 'route', routeMapImage: '/exports/map.png', manualText: 'manual'},
    snapshotUrl: 'http://127.0.0.1/', onImage: (value) => images.push(value), onImageError: (value) => errors.push(value),
    onPdf: (value) => {pdf = value;}, onPdfError: (value) => errors.push(value)});
  assert.deepEqual(images, ['/exports/map.png']);
  assert.deepEqual(errors, []);
  assert.equal(pdf, path.join('/exports', 'route.travel.pdf'));
});
