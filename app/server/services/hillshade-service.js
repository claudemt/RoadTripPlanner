'use strict';

const fs = require('fs');
const path = require('path');
const {gcj02ToWgs84, lngLatToTilePixel, xyzToBounds} = require('../geo/coordinate-transform');

let sharp = null;
try { sharp = require('sharp'); } catch (_) {}

const pending = new Map();
const normalizeX = (x, z) => ((Number(x) % (2 ** z)) + (2 ** z)) % (2 ** z);
const templateUrl = (template, z, x, y) => String(template || '')
  .replace(/\{z\}/g, String(z))
  .replace(/\{x\}/g, String(x))
  .replace(/\{y\}/g, String(y));

const createHillshadeService = ({dataRoot, enabled = true, sourceUrl = '', cacheVersion = 'v1', minZoom = 5, maxZoom = 12, fetchImpl = global.fetch} = {}) => {
  const cacheRoot = path.join(dataRoot, 'cache', 'hillshade', cacheVersion);
  let transparentPromise = null;
  const transparent = () => {
    if (!transparentPromise) {
      transparentPromise = sharp
        ? sharp({create: {width: 256, height: 256, channels: 4, background: {r: 0, g: 0, b: 0, alpha: 0}}}).webp().toBuffer()
        : Promise.resolve(Buffer.from('UklGRtYAAABXRUJQVlA4WAoAAAAQAAAA/wAA/wAAQUxQSBEAAAABBxAREQBQpP//KaL/qf/9BwBWUDggngAAAPAQAJ0BKgABAAE+bTaZSaQjIqEgKACADYlpbuF2sRtACewD32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2TkPfbJyHvtk5D32ych77ZOQ99snIe+2ThQAD+/9YAAAAAAAAAAAAA', 'base64'));
    }
    return transparentPromise;
  };
  const fetchTile = async (z, x, y) => {
    const max = 2 ** z;
    if (y < 0 || y >= max) return transparent();
    const response = await fetchImpl(templateUrl(sourceUrl, z, normalizeX(x, z), y), {headers: {'User-Agent': 'RoadTripPlanner/2 hillshade'}});
    if (!response.ok) throw new Error(`Hillshade source HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };
  const render = async (z, x, y) => {
    if (!enabled || !sourceUrl || !sharp || z < minZoom || z > maxZoom + 3) return transparent();
    if (z > maxZoom) {
      const divisor = 2 ** (z - maxZoom);
      const parentX = Math.floor(x / divisor);
      const parentY = Math.floor(y / divisor);
      const parent = await getTile(maxZoom, parentX, parentY);
      const cropSize = 256 / divisor;
      return sharp(parent)
        .extract({left: Math.round((x % divisor) * cropSize), top: Math.round((y % divisor) * cropSize), width: Math.round(cropSize), height: Math.round(cropSize)})
        .resize(256, 256)
        .webp({quality: 82})
        .toBuffer();
    }
    const bounds = xyzToBounds(z, x, y);
    const gcjCenter = [(bounds.west + bounds.east) / 2, (bounds.north + bounds.south) / 2];
    const wgsCenter = gcj02ToWgs84(gcjCenter[0], gcjCenter[1]);
    const [sourcePx, sourcePy] = lngLatToTilePixel(wgsCenter[0], wgsCenter[1], z);
    const sourceTileX = Math.floor(sourcePx / 256);
    const sourceTileY = Math.floor(sourcePy / 256);
    const left = Math.round(sourcePx - sourceTileX * 256 + 256 - 128);
    const top = Math.round(sourcePy - sourceTileY * 256 + 256 - 128);
    const tiles = [];
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        tiles.push(fetchTile(z, sourceTileX + dx, sourceTileY + dy).then((input) => ({input, left: (dx + 1) * 256, top: (dy + 1) * 256})));
      }
    }
    const alphaMask = await sharp({create: {width: 256, height: 256, channels: 4, background: {r: 255, g: 255, b: 255, alpha: 0.58}}}).png().toBuffer();
    const mosaicBuffer = await sharp({create: {width: 768, height: 768, channels: 4, background: {r: 0, g: 0, b: 0, alpha: 0}}})
      .composite(await Promise.all(tiles))
      .png()
      .toBuffer();
    const mosaic = await sharp(mosaicBuffer)
      .extract({left: Math.max(0, Math.min(512, left)), top: Math.max(0, Math.min(512, top)), width: 256, height: 256})
      .composite([{input: alphaMask, blend: 'dest-in'}])
      .webp({quality: 82})
      .toBuffer();
    return mosaic;
  };
  const getTile = async (zValue, xValue, yValue) => {
    const z = Number(zValue);
    const x = Number(xValue);
    const y = Number(yValue);
    if (![z, x, y].every(Number.isInteger)) return transparent();
    const file = path.join(cacheRoot, String(z), String(x), `${y}.webp`);
    if (fs.existsSync(file)) return fs.readFileSync(file);
    const key = `${z}/${x}/${y}`;
    if (pending.has(key)) return pending.get(key);
    const task = render(z, x, y)
      .catch(() => transparent())
      .then((buffer) => {
        if (buffer?.length) {
          fs.mkdirSync(path.dirname(file), {recursive: true});
          try { fs.writeFileSync(file, buffer); } catch (_) {}
        }
        return buffer;
      })
      .finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  };
  return {getTile, cacheRoot};
};

module.exports = {createHillshadeService, templateUrl};
