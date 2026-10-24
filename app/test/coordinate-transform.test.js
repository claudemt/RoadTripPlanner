const test = require('node:test');
const assert = require('node:assert/strict');
const {
  gcj02ToWgs84, wgs84ToGcj02, lngLatToWebMercator, webMercatorToLngLat, xyzToBounds,
} = require('../server/geo/coordinate-transform');

test('GCJ-02 inverse converges back to the original WGS84 coordinate', () => {
  const wgs = [116.397, 39.908];
  const gcj = wgs84ToGcj02(...wgs);
  const restored = gcj02ToWgs84(...gcj);
  assert.ok(Math.abs(restored[0] - wgs[0]) < 1e-6);
  assert.ok(Math.abs(restored[1] - wgs[1]) < 1e-6);
});

test('Web Mercator conversions and XYZ bounds are stable', () => {
  const coordinate = [102.9, 31.1];
  const restored = webMercatorToLngLat(...lngLatToWebMercator(...coordinate));
  assert.ok(Math.abs(restored[0] - coordinate[0]) < 1e-8);
  assert.ok(Math.abs(restored[1] - coordinate[1]) < 1e-8);
  const bounds = xyzToBounds(5, 25, 13);
  assert.ok(bounds.west < bounds.east);
  assert.ok(bounds.south < bounds.north);
});
