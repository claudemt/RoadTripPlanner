'use strict';

const PI = Math.PI;
const A = 6378245.0;
const EE = 0.00669342162296594323;
const WEB_MERCATOR_MAX_LAT = 85.0511287798066;

const outsideChina = (lng, lat) => lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
const transformLat = (lng, lat) => {
  let value = -100 + 2 * lng + 3 * lat + 0.2 * lat * lat + 0.1 * lng * lat + 0.2 * Math.sqrt(Math.abs(lng));
  value += (20 * Math.sin(6 * lng * PI) + 20 * Math.sin(2 * lng * PI)) * 2 / 3;
  value += (20 * Math.sin(lat * PI) + 40 * Math.sin(lat / 3 * PI)) * 2 / 3;
  value += (160 * Math.sin(lat / 12 * PI) + 320 * Math.sin(lat * PI / 30)) * 2 / 3;
  return value;
};
const transformLng = (lng, lat) => {
  let value = 300 + lng + 2 * lat + 0.1 * lng * lng + 0.1 * lng * lat + 0.1 * Math.sqrt(Math.abs(lng));
  value += (20 * Math.sin(6 * lng * PI) + 20 * Math.sin(2 * lng * PI)) * 2 / 3;
  value += (20 * Math.sin(lng * PI) + 40 * Math.sin(lng / 3 * PI)) * 2 / 3;
  value += (150 * Math.sin(lng / 12 * PI) + 300 * Math.sin(lng / 30 * PI)) * 2 / 3;
  return value;
};

const wgs84ToGcj02 = (lng, lat) => {
  const x = Number(lng);
  const y = Number(lat);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new TypeError('Invalid longitude/latitude');
  if (outsideChina(x, y)) return [x, y];
  let dLat = transformLat(x - 105, y - 35);
  let dLng = transformLng(x - 105, y - 35);
  const radLat = y / 180 * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = dLat * 180 / ((A * (1 - EE)) / (magic * sqrtMagic) * PI);
  dLng = dLng * 180 / (A / sqrtMagic * Math.cos(radLat) * PI);
  return [x + dLng, y + dLat];
};

const gcj02ToWgs84 = (lng, lat, iterations = 6) => {
  const targetLng = Number(lng);
  const targetLat = Number(lat);
  if (!Number.isFinite(targetLng) || !Number.isFinite(targetLat)) throw new TypeError('Invalid longitude/latitude');
  if (outsideChina(targetLng, targetLat)) return [targetLng, targetLat];
  let wLng = targetLng;
  let wLat = targetLat;
  for (let index = 0; index < Math.max(2, Number(iterations) || 6); index += 1) {
    const [gLng, gLat] = wgs84ToGcj02(wLng, wLat);
    const dLng = gLng - targetLng;
    const dLat = gLat - targetLat;
    wLng -= dLng;
    wLat -= dLat;
    if (Math.abs(dLng) < 1e-8 && Math.abs(dLat) < 1e-8) break;
  }
  return [wLng, wLat];
};

const lngLatToWebMercator = (lng, lat) => {
  const x = Number(lng);
  const y = Math.max(-WEB_MERCATOR_MAX_LAT, Math.min(WEB_MERCATOR_MAX_LAT, Number(lat)));
  return [
    6378137 * x * PI / 180,
    6378137 * Math.log(Math.tan(PI / 4 + y * PI / 360)),
  ];
};

const webMercatorToLngLat = (x, y) => [
  Number(x) / 6378137 * 180 / PI,
  (2 * Math.atan(Math.exp(Number(y) / 6378137)) - PI / 2) * 180 / PI,
];

const tileXToLng = (x, z) => Number(x) / (2 ** Number(z)) * 360 - 180;
const tileYToLat = (y, z) => {
  const n = PI - 2 * PI * Number(y) / (2 ** Number(z));
  return 180 / PI * Math.atan(Math.sinh(n));
};
const lngLatToTilePixel = (lng, lat, z, tileSize = 256) => {
  const scale = (2 ** Number(z)) * tileSize;
  const clippedLat = Math.max(-WEB_MERCATOR_MAX_LAT, Math.min(WEB_MERCATOR_MAX_LAT, Number(lat)));
  const x = (Number(lng) + 180) / 360 * scale;
  const sin = Math.sin(clippedLat * PI / 180);
  const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * PI)) * scale;
  return [x, y];
};
const xyzToBounds = (z, x, y) => ({
  west: tileXToLng(x, z),
  north: tileYToLat(y, z),
  east: tileXToLng(Number(x) + 1, z),
  south: tileYToLat(Number(y) + 1, z),
});

module.exports = {
  gcj02ToWgs84,
  wgs84ToGcj02,
  lngLatToWebMercator,
  webMercatorToLngLat,
  lngLatToTilePixel,
  xyzToBounds,
  outsideChina,
};
