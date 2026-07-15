(function () {
  class MapProvider {
    async load() { throw new Error('MapProvider.load is not implemented'); }
    async createMap() { throw new Error('MapProvider.createMap is not implemented'); }
    setLayer() {}
    onClick() {}
    clearOverlays() {}
    addMarker() {}
    addPolyline() {}
    fitView() {}
    setZoomAndCenter() {}
    async searchTips() { return []; }
    async resolveTip(tip) { return tip; }
    async resolvePlace() { throw new Error('MapProvider.resolvePlace is not implemented'); }
    async reverseGeocode() { return '地图点选位置'; }
    async drivingRoute() { throw new Error('MapProvider.drivingRoute is not implemented'); }
    async testSearch() { return false; }
  }

  window.MapProvider = MapProvider;
})();
