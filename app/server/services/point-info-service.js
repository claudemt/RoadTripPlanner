'use strict';

const fs = require('fs');
const path = require('path');
const {gcj02ToWgs84} = require('../geo/coordinate-transform');

const roundCoord = (value) => Number(value).toFixed(5);
const dateAtDay = (startDate, dayIndex) => {
  const date = new Date(`${startDate}T12:00:00Z`);
  if (!Number.isFinite(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + dayIndex);
  return date.toISOString().slice(0, 10);
};
const safeRead = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
};
const safeWrite = (file, value) => {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value));
  fs.renameSync(temp, file);
};
const cacheFile = (root, type, key) => path.join(root, type, `${key.replace(/[^0-9,.-]/g, '_')}.json`);
const chunks = (items, size) => Array.from({length: Math.ceil(items.length / size)}, (_, index) => items.slice(index * size, (index + 1) * size));

const createPointInfoService = ({
  dataRoot,
  weatherProvider = 'openmeteo',
  elevationProvider = 'openmeteo',
  weatherTtlMinutes = 30,
  fetchImpl = global.fetch
} = {}) => {
  if (weatherProvider !== 'openmeteo' || elevationProvider !== 'openmeteo') {
    throw new Error('点位信息服务目前仅支持 openmeteo provider。');
  }
  const cacheRoot = path.join(dataRoot, 'cache', 'point-info');
  const weatherTtlMs = Math.max(1, Number(weatherTtlMinutes) || 30) * 60 * 1000;

  const fetchJson = async (url) => {
    const response = await fetchImpl(url, {headers: {'User-Agent': 'RoadTripPlanner/2 point-info'}});
    if (!response.ok) throw new Error(`Open-Meteo HTTP ${response.status}`);
    return response.json();
  };

  const fetchElevation = async (entries) => {
    const result = new Map();
    for (const group of chunks(entries, 100)) {
      const url = new URL('https://api.open-meteo.com/v1/elevation');
      url.searchParams.set('latitude', group.map((item) => item.lat).join(','));
      url.searchParams.set('longitude', group.map((item) => item.lng).join(','));
      const json = await fetchJson(url);
      const values = Array.isArray(json.elevation) ? json.elevation : [json.elevation];
      group.forEach((item, index) => {
        const value = Number(values[index]);
        if (Number.isFinite(value)) result.set(item.coordKey, {elevationM: Math.round(value / 10) * 10});
      });
    }
    return result;
  };

  const fetchWeather = async (entries) => {
    const result = new Map();
    for (const group of chunks(entries, 50)) {
      const url = new URL('https://api.open-meteo.com/v1/forecast');
      url.searchParams.set('latitude', group.map((item) => item.lat).join(','));
      url.searchParams.set('longitude', group.map((item) => item.lng).join(','));
      url.searchParams.set('daily', 'temperature_2m_min,temperature_2m_max,weather_code');
      url.searchParams.set('timezone', 'auto');
      url.searchParams.set('forecast_days', '16');
      const json = await fetchJson(url);
      const responses = Array.isArray(json) ? json : [json];
      group.forEach((item, index) => {
        const daily = responses[index]?.daily;
        const dateIndex = Array.isArray(daily?.time) ? daily.time.indexOf(item.date) : -1;
        const minC = Number(daily?.temperature_2m_min?.[dateIndex]);
        const maxC = Number(daily?.temperature_2m_max?.[dateIndex]);
        const code = Number(daily?.weather_code?.[dateIndex]);
        if (dateIndex >= 0 && Number.isFinite(minC) && Number.isFinite(maxC) && Number.isFinite(code)) {
          result.set(item.weatherKey, {date: item.date, minC: Math.round(minC), maxC: Math.round(maxC), code});
        }
      });
    }
    return result;
  };

  const getPointInfo = async (payload) => {
    const days = Array.isArray(payload?.days) ? payload.days.slice(0, 365) : [];
    const wantWeather = payload?.weather === true;
    const wantElevation = payload?.elevation === true;
    const startDate = String(payload?.startDate || '').slice(0, 10);
    if (wantWeather && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      const error = new Error('天气开启时必须提供有效的出发日期。');
      error.status = 400;
      throw error;
    }
    if (wantWeather) {
      const today = new Date().toISOString().slice(0, 10);
      const lastDate = dateAtDay(startDate, days.length - 1);
      const forecastEnd = dateAtDay(today, 15);
      if (days.length > 16 || startDate < today || !lastDate || lastDate > forecastEnd) {
        const error = new Error('整条路线必须位于未来 16 天的天气预报范围内。');
        error.status = 400;
        throw error;
      }
    }
    const flat = [];
    days.forEach((day, dayIndex) => {
      const date = wantWeather ? dateAtDay(startDate, dayIndex) : null;
      (Array.isArray(day?.points) ? day.points.slice(0, 202) : []).forEach((point, pointIndex) => {
        const lng = Number(point?.lng);
        const lat = Number(point?.lat);
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
        const [wLng, wLat] = gcj02ToWgs84(lng, lat);
        const coordKey = `${roundCoord(wLat)},${roundCoord(wLng)}`;
        flat.push({dayIndex, pointIndex, lng: wLng, lat: wLat, coordKey, date, weatherKey: `${coordKey},${date}`});
      });
    });
    const now = Date.now();
    const elevation = new Map();
    const weather = new Map();
    const missingElevation = new Map();
    const missingWeather = new Map();
    flat.forEach((item) => {
      if (wantElevation && !elevation.has(item.coordKey)) {
        const cached = safeRead(cacheFile(cacheRoot, 'elevation', item.coordKey));
        if (Number.isFinite(Number(cached?.elevationM))) elevation.set(item.coordKey, cached);
        else missingElevation.set(item.coordKey, item);
      }
      if (wantWeather && !weather.has(item.weatherKey)) {
        const cached = safeRead(cacheFile(cacheRoot, 'weather', item.weatherKey));
        if (cached?.fetchedAt && now - Date.parse(cached.fetchedAt) <= weatherTtlMs) weather.set(item.weatherKey, cached);
        else {
          if (cached) weather.set(item.weatherKey, cached);
          missingWeather.set(item.weatherKey, item);
        }
      }
    });
    if (missingElevation.size) {
      try {
        const fresh = await fetchElevation([...missingElevation.values()]);
        fresh.forEach((value, key) => {
          const stored = {...value, fetchedAt: new Date().toISOString()};
          elevation.set(key, stored);
          safeWrite(cacheFile(cacheRoot, 'elevation', key), stored);
        });
      } catch (_) {}
    }
    if (missingWeather.size) {
      try {
        const fresh = await fetchWeather([...missingWeather.values()]);
        fresh.forEach((value, key) => {
          const stored = {...value, fetchedAt: new Date().toISOString()};
          weather.set(key, stored);
          safeWrite(cacheFile(cacheRoot, 'weather', key), stored);
        });
      } catch (_) {}
    }
    const flatByPosition = new Map(flat.map((item) => [`${item.dayIndex}:${item.pointIndex}`, item]));
    const outputDays = days.map((day, dayIndex) => ({
      date: wantWeather ? dateAtDay(startDate, dayIndex) : null,
      points: (Array.isArray(day?.points) ? day.points : []).map((_, pointIndex) => {
        const item = flatByPosition.get(`${dayIndex}:${pointIndex}`);
        if (!item) return {};
        const result = {};
        const elevationValue = elevation.get(item.coordKey);
        const weatherValue = weather.get(item.weatherKey);
        if (wantElevation && Number.isFinite(Number(elevationValue?.elevationM))) result.elevationM = Number(elevationValue.elevationM);
        if (wantWeather && weatherValue && Number.isFinite(Number(weatherValue.code))) {
          result.weather = {date: item.date, minC: Number(weatherValue.minC), maxC: Number(weatherValue.maxC), code: Number(weatherValue.code)};
        }
        return result;
      }),
    }));
    return {ok: true, version: 1, days: outputDays};
  };

  return {getPointInfo, cacheRoot};
};

module.exports = {createPointInfoService, dateAtDay};
