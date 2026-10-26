const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const os = require('node:os');
const {createHash} = require('node:crypto');
const {createMapBackgroundPlan, assertMapBackgroundSize, canReuseMapBackground} = require('../server/services/map-background-plan');

// Exercise the same projection used by the actual Remotion composition.
const geoFile = path.resolve(__dirname, '../video/src/projects/amap-route-video/lib/geo.ts');
const geoModule = new Module(geoFile, module);
geoModule._compile(ts.transpileModule(fs.readFileSync(geoFile, 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS},
}).outputText, geoFile);
const {computeCamera, collectAllPoints, layoutPointLabels} = geoModule.exports;

const route = {
  mapLayer: 'standard',
  presentation: {hillshade: true},
  renderMode: 'video',
  summary: {bounds: [101.15, 30.57, 104.06, 36.06]},
  days: [{
    points: [
      {lng: 104.0668, lat: 30.5728},
      {lng: 101.15, lat: 33.33},
      {lng: 103.83, lat: 36.06},
    ],
    segments: [{path: [[104.0668, 30.5728], [103.915, 33.263], [101.15, 33.33], [103.83, 36.06]]}],
  }],
};

test('cached map and video use identical camera pixels at every export size', () => {
  for (const [width, height] of [[1280, 720], [1920, 1080], [2560, 1440], [1080, 1920]]) {
    const plan = createMapBackgroundPlan(route, String(width), String(height));
    const backdrop = computeCamera(plan.videoData, plan.width, plan.height);
    const video = computeCamera(route, width, height);
    assert.deepEqual(backdrop.center, video.center);
    assert.equal(backdrop.zoom, video.zoom);
    for (const point of collectAllPoints(route)) {
      // The still's density scales both axes before the image is placed back
      // into the video viewport. No crop or camera refit may happen here.
      const pixel = backdrop.project(point);
      const actual = {x: pixel.x * plan.scale / plan.scale, y: pixel.y * plan.scale / plan.scale};
      assert.ok(Math.abs(actual.x - video.project(point).x) < 1e-9);
      assert.ok(Math.abs(actual.y - video.project(point).y) < 1e-9);
    }
  }

  const legacyCamera = computeCamera({...route, renderMode: 'mapOnly'}, 2560, 1440);
  const videoCamera = computeCamera(route, 1920, 1080);
  const deviations = collectAllPoints(route).map((point) => {
    const old = legacyCamera.project(point);
    const expected = videoCamera.project(point);
    return Math.hypot(old.x * 0.75 - expected.x, old.y * 0.75 - expected.y);
  });
  assert.ok(Math.max(...deviations) > 40, 'fixture must reproduce the original visible misalignment');
});

test('map cache changes for viewport, geometry, point-only routes and map layers', () => {
  const signature = (data, width = 1920, height = 1080) => createMapBackgroundPlan(data, width, height).signature;
  const baseline = signature(route);
  assert.notEqual(signature(route, 1280, 720), baseline);
  assert.notEqual(signature({...route, mapLayer: 'satellite'}), baseline);
  assert.notEqual(signature({...route, presentation: {hillshade: false}}), baseline);
  assert.notEqual(signature({...route, days: [{...route.days[0], points: [{lng: 100, lat: 30}]}]}), baseline);
  assert.notEqual(signature({...route, days: [{...route.days[0], segments: [{path: [[100, 30], [101, 31]]}]}]}), baseline);
  assert.notEqual(signature({...route, summary: {bounds: [100, 30, 106, 39]}}), baseline);
  assert.equal(signature({...route, exportedAt: 'a later export'}), baseline);

  const legacySignature = createHash('sha256').update(JSON.stringify({
    renderVersion: 3, width: 2560, height: 1440,
    mapLayer: 'standard', hillshade: true,
    routeGeometryHash: createHash('sha256').update(JSON.stringify(route.days.flatMap((day) => day.segments.map((segment) => segment.path)))).digest('hex'),
  })).digest('hex');
  assert.notEqual(baseline, legacySignature, 'previous misaligned backgrounds must not be reused');
});

test('background capture cannot recursively include a previous static map', () => {
  const plan = createMapBackgroundPlan({...route, staticMapImage: 'old-map.png'}, 1920, 1080);
  assert.equal(plan.videoData.renderMode, 'mapOnly');
  assert.equal(plan.videoData.staticMapImage, undefined);
  assert.equal(plan.width, 1920);
  assert.equal(plan.height, 1080);
  assert.equal(plan.scale, 2);
});

test('wrong-sized, truncated and mismatched cached maps are rejected', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'map-size-test-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const file = path.join(directory, 'map.png');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWF8AAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(file, png);
  const plan = {width: 1, height: 1, scale: 1, signature: 'current'};
  assert.equal(canReuseMapBackground(file, {signature: 'current'}, plan), true);
  assert.equal(canReuseMapBackground(file, {signature: 'old'}, plan), false);
  assert.throws(() => assertMapBackgroundSize(file, {...plan, width: 2}), /尺寸/);
  fs.writeFileSync(file, png.subarray(0, 30));
  assert.equal(canReuseMapBackground(file, {signature: 'current'}, plan), false);
});

test('large route geometry fits without argument limits or clipped bounds', () => {
  const data = {...route, days: [{points: [], segments: [{path: Array.from({length: 150000}, (_, i) => [100 + i / 150000, 30 + i / 150000])}]}]};
  const camera = computeCamera(data, 1920, 1080);
  for (const point of [[100, 30], [101, 31]]) {
    const projected = camera.project(point);
    assert.ok(projected.x >= 0 && projected.x <= 1920);
    assert.ok(projected.y >= 0 && projected.y <= 1080);
  }
});

test('outro duration includes enough pages for every route day', () => {
  const file = path.resolve(__dirname, '../video/src/projects/amap-route-video/lib/timeline.ts');
  const compiled = new Module(file, module);
  compiled._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS}}).outputText, file);
  const {getTotalDuration, getOutroFrames, buildTimeline, OUTRO_PAGE_SIZE} = compiled.exports;
  const data = {...route, days: Array.from({length: 27}, () => ({points: [], segments: []}))};
  const timeline = buildTimeline(data);
  assert.equal(getTotalDuration(data) - getOutroFrames(data), timeline[timeline.length - 1].end);
  assert.ok(getOutroFrames(data) >= Math.ceil(data.days.length / OUTRO_PAGE_SIZE) * 90);
});

test('video labels keep the web anchor for manually arranged points', () => {
  const width = 1280;
  const height = 720;
  const scale = 1;
  const items = [
    {key: 'manual', x: 500, y: 400, text: '赛里木湖', labelOffset: {x: 0.1, y: -0.05}},
    {key: 'auto', x: 500, y: 400, text: '那拉提', labelOffset: {x: 0, y: 0}},
  ];
  const boxes = layoutPointLabels(items, width, height, [], scale);
  const manual = boxes.get('manual');
  assert.ok(Math.abs(manual.x - (500 + 15 + 0.1 * width)) < 1e-6);
  assert.ok(Math.abs(manual.y - (400 - 56 - 0.05 * height)) < 1e-6);
  const auto = boxes.get('auto');
  const overlap = Math.max(0, Math.min(manual.x + manual.width, auto.x + auto.width) - Math.max(manual.x, auto.x))
    * Math.max(0, Math.min(manual.y + manual.height, auto.y + auto.height) - Math.max(manual.y, auto.y));
  assert.equal(overlap, 0, 'auto labels must not cover a manual placement');

  const withMore = layoutPointLabels([...items, {key: 'later', x: 400, y: 300, text: '新增点', labelOffset: {x: 0, y: 0}}], width, height, [], scale);
  assert.deepEqual(withMore.get('manual'), manual, 'manual placement must not move when more POIs appear');
});

test('day-mode labels stay on the web anchors instead of relocating', () => {
  const items = [
    {key: 'a', x: 500, y: 400, text: '甲', labelOffset: {x: 0.02, y: -0.02}},
    {key: 'b', x: 500, y: 400, text: '乙', labelOffset: {x: 0, y: 0}},
  ];
  const boxes = layoutPointLabels(items, 1280, 720, [], 1, [], true);
  assert.ok(Math.abs(boxes.get('a').x - (500 + 15 + 0.02 * 1280)) < 1e-6);
  assert.ok(Math.abs(boxes.get('a').y - (400 - 56 - 0.02 * 720)) < 1e-6);
  assert.ok(Math.abs(boxes.get('b').x - (500 + 15)) < 1e-6);
  assert.ok(Math.abs(boxes.get('b').y - (400 - 56)) < 1e-6);
});

const rectOverlap = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

test('newly revealed labels yield to cards already on screen, older labels stay put', () => {
  const card = {x: 0, y: 0, width: 700, height: 300};
  const anchor = {x: 200, y: 300};
  const early = {key: 'early', ...anchor, text: '先出现的点', labelOffset: {x: 0, y: 0}, avoidRects: []};
  const late = {key: 'late', ...anchor, text: '新出现的点', labelOffset: {x: 0, y: 0}, avoidRects: [card]};
  const boxes = layoutPointLabels([early, late], 1280, 720, [], 1, [], true);
  assert.ok(Math.abs(boxes.get('early').x - (anchor.x + 15)) < 1e-6);
  assert.ok(Math.abs(boxes.get('early').y - (anchor.y - 56)) < 1e-6);
  assert.equal(rectOverlap(boxes.get('late'), card), 0);

  const nextDay = layoutPointLabels([{...late, avoidRects: undefined}], 1280, 720, [], 1, [], true).get('late');
  assert.ok(Math.abs(nextDay.x - (anchor.x + 15)) < 1e-6);
  assert.ok(Math.abs(nextDay.y - (anchor.y - 56)) < 1e-6);

  const tallCard = {x: 0, y: 0, width: 700, height: 700};
  const tallBox = layoutPointLabels([
    {key: 'tall', x: 200, y: 350, text: '新出现的点', labelOffset: {x: 0, y: 0}, avoidRects: [tallCard]},
  ], 1280, 720, [], 1, [], true).get('tall');
  assert.equal(rectOverlap(tallBox, tallCard), 0, 'cards taller than the offset grid must still be cleared');
});

test('manually arranged labels keep their position beside scenic cards', () => {
  const card = {x: 0, y: 0, width: 700, height: 300};
  const boxes = layoutPointLabels([
    {key: 'pinned', x: 200, y: 300, text: '手动景点', labelOffset: {x: 0.1, y: 0.05}, avoidRects: [card]},
  ], 1280, 720, [], 1, [], true);
  assert.ok(Math.abs(boxes.get('pinned').x - (200 + 15 + 0.1 * 1280)) < 1e-6);
  assert.ok(Math.abs(boxes.get('pinned').y - (300 - 56 + 0.05 * 720)) < 1e-6);
});
