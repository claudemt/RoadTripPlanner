const test = require('node:test');
const assert = require('node:assert/strict');
const {validateRouteData, assertMapLayer} = require('../server/validation/route-validation');

const validRoute = () => ({
  id: 'route-1',
  name: '川西环线',
  days: [{
    title: '第一天',
    from: {name: '成都', lng: 104.066, lat: 30.572, transportMode: 'drive'},
    waypoints: [{name: '康定', lng: 101.96, lat: 30.05, transportMode: 'ride', labelOffset: {x: 0.2, y: -0.1}}],
    to: {name: '新都桥', lng: 101.5, lat: 30.04, transportMode: 'walk'},
  }],
});

test('accepts a normalized route', () => {
  const route = validRoute();
  route.presentation = {mapLayer: 'hybrid', hillshade: true, weather: true, elevation: true, startDate: '2026-09-24'};
  route.pointInfoCache = {version: 1, days: {0: {
    geoSignature: 'signature', date: '2026-09-24', weatherFetchedAt: '2026-09-23T00:00:00.000Z',
    points: [{elevationM: 500, weather: {date: '2026-09-24', minC: 8, maxC: 18, code: 2}}],
  }}};
  assert.equal(validateRouteData(route).name, '川西环线');
  assert.equal(assertMapLayer('hybrid'), 'hybrid');
});

test('rejects invalid route coordinates and label offsets', () => {
  const route = validRoute();
  route.days[0].to.lng = 181;
  assert.throws(() => validateRouteData(route), /经度无效/);

  const routeWithBadOffset = validRoute();
  routeWithBadOffset.days[0].waypoints[0].labelOffset.x = 3;
  assert.throws(() => validateRouteData(routeWithBadOffset), /文字标签位置超出范围/);

  const routeWithBadWeather = validRoute();
  routeWithBadWeather.pointInfoCache = {version: 1, days: {0: {points: [{weather: {date: 'nope', minC: 1, maxC: 2, code: 3}}]}}};
  assert.throws(() => validateRouteData(routeWithBadWeather), /天气缓存无效/);
});

test('rejects unsupported map layers and oversized routes', () => {
  assert.throws(() => assertMapLayer('terrain'), /地图图层无效/);
  const route = validRoute();
  route.days[0].waypoints[0].description = 'x'.repeat(5 * 1024 * 1024);
  assert.throws(() => validateRouteData(route), /路线数据过大/);
});
