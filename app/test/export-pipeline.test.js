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
  const finalDir = path.join(directory, 'final');
  fs.mkdirSync(finalDir);
  const calls = [];
  const context = createBrowserContext({fs, path, PORT: 6137, USER_EMAIL_HEADER: 'x-auth-request-email',
    REMOTION_WIDTH: 1920, REMOTION_HEIGHT: 1080,
    archivePayload: () => ({
      dir: directory,
      finalDir,
      safeName: 'route',
      routeJson: path.join(directory, 'route.route.json'),
      videoJson: path.join(directory, 'route.mp4-data.json'),
      routeMapImage: path.join(directory, 'route.route-map.png'),
      mapBgImage: path.join(directory, 'bg.png'),
      mapBgMeta: path.join(directory, 'bg.json'),
      manualMd: null,
      manualText: '',
    }),
    commitStagedArchive: (archived) => {
      const committed = new Map();
      for (const name of fs.readdirSync(archived.dir)) {
        const source = path.join(archived.dir, name);
        if (!fs.statSync(source).isFile() || name.endsWith('.render.mp4')) continue;
        const target = path.join(archived.finalDir, name);
        fs.renameSync(source, target);
        committed.set(name, target);
      }
      return {
        dir: archived.finalDir,
        routeJson: committed.get('route.route.json') || null,
        videoJson: committed.get('route.mp4-data.json') || null,
        manualMd: committed.get('route.travel.md') || null,
        routeMapImage: committed.get('route.route-map.png') || null,
        mapBgImage: null,
        mapBgMeta: null,
        logFile: committed.get('latest-render.log') || path.join(archived.finalDir, 'latest-render.log'),
      };
    },
    assertExportNotCancelled: () => {}, setExportProgress: () => {}, writeRouteSnapshot: () => {},
    ensureExportBrowser: async () => 'chromium', loadJson: () => ({}),
    createMapBackgroundPlan: () => ({width: 1920, height: 1080}), canReuseMapBackground: () => false,
    runRemotionStill: async () => {throw new Error('map cache unavailable');},
    runRemotion: async ({output}) => {fs.writeFileSync(output, 'original-video'); return {output};},
    runFfmpegFaststart: async () => {throw new Error('optimization unavailable');},
    probeVideoBitrate: async () => 1000000,
    renderOverviewAndPdf: async (options) => {
      calls.push(options);
      fs.writeFileSync(options.archived.routeMapImage, 'map');
      const pdf = path.join(options.archived.dir, 'route.travel.pdf');
      fs.writeFileSync(pdf, 'pdf');
      options.onPdf(pdf);
      options.onImage(options.archived.routeMapImage);
    },
    uploadExportedRouteAssets: async () => ({}),
  });
  loadFunctions(context, ['exportRouteBundle'], 'server/route-render-server.js');
  const result = await vm.runInContext('exportRouteBundle', context)({renderVideo: true, host: 'untrusted.example', videoData: {days: []}}, directory, {email: 'user@example.com'}, 'test_snapshot');
  assert.equal(result.manualPdf, path.join(finalDir, 'route.travel.pdf'));
  assert.equal(result.routeMapImage, path.join(finalDir, 'route.route-map.png'));
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
