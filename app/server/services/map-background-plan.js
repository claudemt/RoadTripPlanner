const {createHash} = require('node:crypto');
const fs = require('node:fs');

const positiveInt = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const createMapBackgroundPlan = (videoData, width, height) => {

  const viewportWidth = positiveInt(width, 1280);
  const viewportHeight = positiveInt(height, 720);
  const scale = Math.max(1, Math.ceil(2560 / Math.max(viewportWidth, viewportHeight)));
  const geometry = (videoData.days || []).map((day) => ({
    points: (day.points || []).map((point) => [point.lng, point.lat]),
    paths: (day.segments || []).map((segment) => segment.path || []),
  }));
  const signature = createHash('sha256').update(JSON.stringify({
    renderVersion: 5,
    width: viewportWidth,
    height: viewportHeight,
    scale,
    mapLayer: videoData.mapLayer || 'standard',
    hillshade: videoData.presentation?.hillshade === true,
    geometry,
    bounds: videoData.summary?.bounds,
  })).digest('hex');

  return {
    width: viewportWidth,
    height: viewportHeight,
    scale,
    signature,
    videoData: {...videoData, staticMapImage: undefined, renderMode: 'mapOnly'},
  };
};

const assertMapBackgroundSize = (file, plan) => {
  const header = Buffer.alloc(24);
  const fd = fs.openSync(file, 'r');
  try {
    const length = fs.fstatSync(fd).size;
    const trailer = Buffer.alloc(12);
    if (length < 45 || fs.readSync(fd, header, 0, 24, 0) !== 24 || header.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
      || header.toString('ascii', 12, 16) !== 'IHDR' || fs.readSync(fd, trailer, 0, 12, length - 12) !== 12
      || trailer.toString('hex') !== '0000000049454e44ae426082') {
      throw new Error('地图底图不是完整的 PNG。');
    }
    if (header.readUInt32BE(16) !== plan.width * plan.scale || header.readUInt32BE(20) !== plan.height * plan.scale) {
      throw new Error('地图底图尺寸与视频视野不一致，请重新生成。');
    }
  } finally { fs.closeSync(fd); }
};

const canReuseMapBackground = (file, metadata, plan) => {
  if (metadata?.signature !== plan.signature) return false;
  try { assertMapBackgroundSize(file, plan); return true; } catch (_) { return false; }
};

module.exports = {createMapBackgroundPlan, assertMapBackgroundSize, canReuseMapBackground};
