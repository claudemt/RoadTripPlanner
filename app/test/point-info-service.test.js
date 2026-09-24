const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createPointInfoService, dateAtDay} = require('../server/services/point-info-service');

test('dates advance once per route day', () => {
  assert.equal(dateAtDay('2026-09-24', 0), '2026-09-24');
  assert.equal(dateAtDay('2026-09-24', 3), '2026-09-27');
});

test('rejects unsupported point info providers at startup', () => {
  assert.throws(() => createPointInfoService({dataRoot: os.tmpdir(), weatherProvider: 'unknown'}), /仅支持 openmeteo/);
});

test('point info batches elevation and daily weather and persists compact cache', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roadtrip-point-info-'));
  const calls = [];
  const fetchImpl = async (urlValue) => {
    const url = new URL(urlValue);
    calls.push(url.pathname);
    if (url.pathname.endsWith('/elevation')) return {ok: true, json: async () => ({elevation: [3243]})};
    return {ok: true, json: async () => ({daily: {time: ['2026-09-24'], temperature_2m_min: [-4.2], temperature_2m_max: [7.4], weather_code: [71]}})};
  };
  const service = createPointInfoService({dataRoot: root, fetchImpl});
  const result = await service.getPointInfo({
    startDate: '2026-09-24', weather: true, elevation: true,
    days: [{points: [{name: '四姑娘山', lng: 102.9, lat: 31.1}]}],
  });
  assert.equal(result.days[0].points[0].elevationM, 3240);
  assert.deepEqual(result.days[0].points[0].weather, {date: '2026-09-24', minC: -4, maxC: 7, code: 71});
  assert.equal(calls.length, 2);
  fs.rmSync(root, {recursive: true, force: true});
});
