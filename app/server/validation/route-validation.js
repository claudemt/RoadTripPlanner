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

const validatePresentation = (value) => {
  if (value == null) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('地图表现设置无效。');
  assertMapLayer(value.mapLayer);
  for (const key of ['hillshade', 'weather', 'elevation']) {
    if (value[key] != null && typeof value[key] !== 'boolean') throw invalid(`地图表现设置 ${key} 无效。`);
  }
  if (value.startDate != null && value.startDate !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(String(value.startDate))) {
    throw invalid('出发日期无效。');
  }
};

const validatePointInfoCache = (value, routeData) => {
  if (value == null) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('点位信息缓存无效。');
  if (Number(value.version || 1) !== 1) throw invalid('点位信息缓存版本无效。');
  const days = value.days || {};
  if (!days || typeof days !== 'object' || Array.isArray(days) || Object.keys(days).length > routeData.days.length) {
    throw invalid('点位信息缓存天数无效。');
  }
  Object.entries(days).forEach(([dayIndex, day]) => {
    const index = Number(dayIndex);
    if (!Number.isInteger(index) || index < 0 || index >= routeData.days.length || !day || !Array.isArray(day.points)) throw invalid('点位信息缓存日期无效。');
    if (day.points.length > MAX_POINTS_PER_DAY + 2) throw invalid('点位信息缓存点位过多。');
    assertText(String(day.geoSignature || ''), '点位信息签名', 50000);
    if (day.date != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(day.date))) throw invalid('点位信息日期无效。');
    if (day.weatherFetchedAt != null && !Number.isFinite(Date.parse(String(day.weatherFetchedAt)))) throw invalid('天气缓存时间无效。');
    day.points.forEach((info) => {
      if (!info || typeof info !== 'object' || Array.isArray(info)) throw invalid('点位信息无效。');
      if (info.elevationM != null && !Number.isFinite(Number(info.elevationM))) throw invalid('海拔缓存无效。');
      if (info.weather != null) {
        const weather = info.weather;
        if (!weather || typeof weather !== 'object' || !/^\d{4}-\d{2}-\d{2}$/.test(String(weather.date || ''))
          || ![weather.minC, weather.maxC, weather.code].every((item) => Number.isFinite(Number(item)))) throw invalid('天气缓存无效。');
      }
    });
  });
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
  validatePresentation(routeData.presentation);
  validatePointInfoCache(routeData.pointInfoCache, routeData);
  return routeData;
};

const assertMapLayer = (value) => {
  const layer = String(value || 'standard').trim();
  if (!['standard', 'satellite', 'hybrid'].includes(layer)) throw invalid('地图图层无效。');
  return layer;
};

module.exports = {validateRouteData, assertMapLayer};
