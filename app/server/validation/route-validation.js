const MAX_ROUTE_JSON_BYTES = 5 * 1024 * 1024;
const MAX_DAYS = 365;
const MAX_POINTS_PER_DAY = 200;
const MAX_NAME_LENGTH = 120;
const ALLOWED_TRANSPORT_MODES = new Set(['drive', 'ride', 'walk']);

const invalid = (message) => {
  const error = new Error(message);
  error.status = 400;
  return error;
};

const assertText = (value, name, maxLength) => {
  if (typeof value !== 'string' || value.length > maxLength) throw invalid(`${name}过长。`);
};

const validateLabelOffset = (offset) => {
  if (offset == null) return;
  if (!offset || !Number.isFinite(Number(offset.x)) || !Number.isFinite(Number(offset.y))) {
    throw invalid('文字标签位置无效。');
  }
  if (Math.abs(Number(offset.x)) > 2 || Math.abs(Number(offset.y)) > 2) {
    throw invalid('文字标签位置超出范围。');
  }
};

const validatePoint = (point, name) => {
  if (!point || typeof point !== 'object') throw invalid(`${name}无效。`);
  assertText(String(point.name || ''), `${name}名称`, MAX_NAME_LENGTH);
  if (point.lng != null && point.lng !== '' && (!Number.isFinite(Number(point.lng)) || Number(point.lng) < -180 || Number(point.lng) > 180)) {
    throw invalid(`${name}经度无效。`);
  }
  if (point.lat != null && point.lat !== '' && (!Number.isFinite(Number(point.lat)) || Number(point.lat) < -90 || Number(point.lat) > 90)) {
    throw invalid(`${name}纬度无效。`);
  }
  if (point.transportMode != null && !ALLOWED_TRANSPORT_MODES.has(String(point.transportMode))) {
    throw invalid(`${name}交通方式无效。`);
  }
  validateLabelOffset(point.labelOffset);
};

const validateRouteData = (routeData) => {
  if (!routeData || typeof routeData !== 'object' || Array.isArray(routeData)) throw invalid('路线数据无效。');
  assertText(String(routeData.name || ''), '路线名称', MAX_NAME_LENGTH);
  if (!String(routeData.name || '').trim()) throw invalid('路线名称不能为空。');
  if (!Array.isArray(routeData.days) || routeData.days.length < 1 || routeData.days.length > MAX_DAYS) {
    throw invalid(`路线天数必须在 1 到 ${MAX_DAYS} 天之间。`);
  }
  let serializedSize = 0;
  try {
    serializedSize = Buffer.byteLength(JSON.stringify(routeData), 'utf8');
  } catch (_) {
    throw invalid('路线数据无法序列化。');
  }
  if (serializedSize > MAX_ROUTE_JSON_BYTES) throw invalid('路线数据过大。');
  routeData.days.forEach((day, dayIndex) => {
    if (!day || typeof day !== 'object') throw invalid(`第 ${dayIndex + 1} 天数据无效。`);
    assertText(String(day.title || ''), `第 ${dayIndex + 1} 天标题`, MAX_NAME_LENGTH);
    validatePoint(day.from, `第 ${dayIndex + 1} 天起点`);
    if (!Array.isArray(day.waypoints) || day.waypoints.length > MAX_POINTS_PER_DAY) {
      throw invalid(`第 ${dayIndex + 1} 天途径点过多。`);
    }
    day.waypoints.forEach((point, pointIndex) => validatePoint(point, `第 ${dayIndex + 1} 天途径点 ${pointIndex + 1}`));
    validatePoint(day.to, `第 ${dayIndex + 1} 天终点`);
  });
  return routeData;
};

const assertMapLayer = (value) => {
  const layer = String(value || 'standard').trim();
  if (!['standard', 'satellite', 'hybrid'].includes(layer)) throw invalid('地图图层无效。');
  return layer;
};

module.exports = {validateRouteData, assertMapLayer};
