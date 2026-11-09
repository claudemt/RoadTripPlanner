const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const {createHillshadeService, templateUrl} = require('../server/services/hillshade-service');

test('hillshade URL templates and disabled transparent fallback work', async () => {
  assert.equal(templateUrl('https://tiles/{z}/{x}/{y}.png', 8, 3, 4), 'https://tiles/8/3/4.png');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roadtrip-hillshade-'));
  const service = createHillshadeService({dataRoot: root, enabled: false});
  const tile = await service.getTile(8, 3, 4);
  assert.ok(Buffer.isBuffer(tile));
  assert.ok(tile.length > 20);
  fs.rmSync(root, {recursive: true, force: true});
});

test('hillshade tiles are shifted, alpha processed, cached, and deduplicated', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roadtrip-hillshade-render-'));
  const source = await sharp({create: {width: 256, height: 256, channels: 3, background: {r: 120, g: 130, b: 140}}}).jpeg().toBuffer();
  let fetchCount = 0;
  const service = createHillshadeService({
    dataRoot: root,
    sourceUrl: 'https://tiles/{z}/{x}/{y}.jpg',
    fetchImpl: async () => {
      fetchCount += 1;
      return {ok: true, arrayBuffer: async () => source};
    },
  });
  const [first, second] = await Promise.all([service.getTile(8, 200, 100), service.getTile(8, 200, 100)]);
  const metadata = await sharp(first).metadata();
  assert.equal(metadata.width, 256);
  assert.equal(metadata.height, 256);
  assert.equal(metadata.hasAlpha, true);
  assert.deepEqual(first, second);
  assert.equal(fetchCount, 9);
  await service.getTile(8, 200, 100);
  assert.equal(fetchCount, 9);
  fs.rmSync(root, {recursive: true, force: true});
});
