(function () {
  function formatDistance(meters) {
    if (!meters) return '0km';
    return `${(meters / 1000).toFixed(meters >= 100000 ? 0 : 1)}km`;
  }

  function formatDuration(seconds) {
    if (!seconds) return '0min';
    const minutes = Math.round(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return hours ? `${hours}h${remainingMinutes ? `${remainingMinutes}min` : ''}` : `${remainingMinutes}min`;
  }

  function formatTripMetric(meters, seconds) {
    return `${formatDistance(meters)}/${formatDuration(seconds)}`;
  }

  function fixed(number) {
    return Number(number).toFixed(6);
  }

  function normalizeSpotName(value) {
    return String(value || '')
      .replace(/（.*?）|\(.*?\)/g, '')
      .replace(/景区|风景区|镇|县|寺院|住宿|国际机场/g, '')
      .replace(/[·\s\-—_]/g, '')
      .trim();
  }

  window.FormatUtils = {
    formatDistance,
    formatDuration,
    formatTripMetric,
    fixed,
    normalizeSpotName
  };
})();
