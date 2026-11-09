import weatherCodeMap from '../../../../shared/weather-codes.json';

(function () {
  const WEATHER_FORECAST_DAYS = 16;
  const WEATHER_CODE_MAP = weatherCodeMap;
  const localDate = (date = new Date()) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };
  const addDays = (dateText, amount) => {
    const date = new Date(`${dateText}T12:00:00`);
    if (!Number.isFinite(date.getTime())) return null;
    date.setDate(date.getDate() + Number(amount || 0));
    return localDate(date);
  };
  const normalize = (value) => {
    const source = value && typeof value === 'object' ? value : {};
    const mapLayer = ['standard', 'satellite', 'hybrid'].includes(source.mapLayer) ? source.mapLayer : 'standard';
    return {
      mapLayer,
      hillshade: source.hillshade === true,
      weather: source.weather === true,
      elevation: source.elevation === true,
      routeFacts: source.routeFacts === true,
      startDate: /^\d{4}-\d{2}-\d{2}$/.test(String(source.startDate || '')) ? String(source.startDate) : null
    };
  };
  const dateBounds = (dayCount, today = localDate()) => ({
    min: today,
    max: Number(dayCount) <= WEATHER_FORECAST_DAYS ? addDays(today, WEATHER_FORECAST_DAYS - Number(dayCount)) : null,
    enabled: Number(dayCount) > 0 && Number(dayCount) <= WEATHER_FORECAST_DAYS
  });
  const weatherMeta = (code) => {
    const {label, icon} = WEATHER_CODE_MAP[Number(code)] || {label: '未知天气', icon: 'cloudy'};
    return {label, icon, iconUrl: `/weather/${icon}.svg`};
  };
  window.MapPresentation = {normalize, addDays, dateBounds, weatherMeta};
})();
