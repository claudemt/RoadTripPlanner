(function () {
  const AMAP_PLUGINS = [
    'AMap.Driving',
    'AMap.Riding',
    'AMap.Walking',
    'AMap.PlaceSearch',
    'AMap.AutoComplete',
    'AMap.Geocoder',
    'AMap.Scale',
    'AMap.ToolBar'
  ].join(',');

  class AmapProvider extends window.MapProvider {
    constructor({config}) {
      super();
      this.config = config || {};
      this.map = null;
      this.autoComplete = null;
      this.placeSearch = null;
      this.geocoder = null;
      this.satelliteLayer = null;
      this.roadNetLayer = null;
      this.overlays = [];
    }

    hasConfig() {
      return Boolean((this.config.key || '').trim() && (this.config.securityJsCode || '').trim());
    }

    async load() {
      if (window.AMap) return;
      if (!this.hasConfig()) throw new Error('尚未配置高德 Key');
      window._AMapSecurityConfig = { securityJsCode: this.config.securityJsCode };
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://webapi.amap.com/maps?v=2.0&key=' + encodeURIComponent(this.config.key) + '&plugin=' + encodeURIComponent(AMAP_PLUGINS);
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error('高德 JS API 加载超时'));
        }, 15000);
        script.onload = () => {
          if (settled) return;
          const wait = () => {
            if (window.AMap) {
              settled = true;
              clearTimeout(timer);
              resolve();
              return;
            }
            setTimeout(wait, 50);
          };
          wait();
          setTimeout(() => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              reject(new Error('高德 JS API 脚本已加载但 AMap 不可用，请检查 Key / 安全密钥 / 域名白名单'));
            }
          }, 3000);
        };
        script.onerror = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error('高德 JS API 加载失败'));
        };
        document.head.appendChild(script);
      });
    }

    async createMap(containerId, options = {}) {
      await this.load();
      this.map = new AMap.Map(containerId, {
        zoom: options.zoom || 5,
        center: options.center || [104.2, 35.8],
        viewMode: '2D',
        resizeEnable: true,
        mapStyle: 'amap://styles/normal'
      });
      setTimeout(() => { try { this.map.resize(); } catch (_) {} }, 80);
      setTimeout(() => { try { this.map.resize(); } catch (_) {} }, 400);
      this.map.addControl(new AMap.Scale());
      this.map.addControl(new AMap.ToolBar({ position: { top: '12px', right: '12px' } }));
      this.satelliteLayer = new AMap.TileLayer.Satellite({ zIndex: 1, opacity: 1 });
      this.roadNetLayer = new AMap.TileLayer.RoadNet({ zIndex: 2, opacity: 0.65 });
      this.autoComplete = new AMap.AutoComplete({ city: '全国', citylimit: false });
      this.placeSearch = new AMap.PlaceSearch({ pageSize: 8, pageIndex: 1, city: '全国', extensions: 'all' });
      this.geocoder = new AMap.Geocoder({ city: '全国' });
      return this.map;
    }

    setLayer(layer) {
      if (!this.map || !this.satelliteLayer || !this.roadNetLayer) return;
      this.map.remove([this.satelliteLayer, this.roadNetLayer]);
      if (layer === 'satellite') this.map.add(this.satelliteLayer);
      if (layer === 'hybrid') this.map.add([this.satelliteLayer, this.roadNetLayer]);
    }

    onClick(handler) {
      if (!this.map) return;
      this.map.on('click', (event) => handler({
        lng: event.lnglat.lng,
        lat: event.lnglat.lat,
        raw: event
      }));
    }

    clearOverlays() {
      if (!this.map || !this.overlays.length) return;
      this.map.remove(this.overlays);
      this.overlays = [];
    }

    addMarker({point, label, color, text, onClick}) {
      const marker = new AMap.Marker({
        position: [point.lng, point.lat],
        title: point.name,
        label: { content: label, direction: 'top' },
        icon: this.makeIcon(color, text)
      });
      if (onClick) marker.on('click', onClick);
      this.map.add(marker);
      this.overlays.push(marker);
      return marker;
    }

    addPolyline({path, color, error}) {
      const line = new AMap.Polyline({
        path,
        strokeColor: error ? '#ef4444' : color,
        strokeWeight: error ? 4 : 6,
        strokeOpacity: error ? 0.55 : 0.8,
        strokeStyle: error ? 'dashed' : 'solid',
        showDir: !error
      });
      this.map.add(line);
      this.overlays.push(line);
      return line;
    }

    fitView(overlays) {
      if (this.map && overlays?.length) this.map.setFitView(overlays, false, [60, 60, 60, 60]);
    }

    setZoomAndCenter(zoom, center) {
      if (this.map) this.map.setZoomAndCenter(zoom, center);
    }

    searchTips(keyword) {
      return new Promise((resolve) => {
        if (!this.autoComplete) return resolve([]);
        this.autoComplete.search(keyword, (status, result) => {
          if (status !== 'complete' || !result || !Array.isArray(result.tips)) return resolve([]);
          resolve(result.tips.filter((tip) => tip && tip.name && tip.name !== '[]').slice(0, 10));
        });
      });
    }

    resolveTip(tip) {
      if (tip.location && Number.isFinite(Number(tip.location.lng)) && Number.isFinite(Number(tip.location.lat))) {
        return Promise.resolve({ name: tip.name, lng: Number(tip.location.lng), lat: Number(tip.location.lat) });
      }
      return this.resolvePlace([tip.district, tip.name].filter(Boolean).join(' '));
    }

    resolvePlace(keyword) {
      return new Promise((resolve, reject) => {
        this.placeSearch.search(keyword, (status, result) => {
          const poi = status === 'complete' && result.poiList && result.poiList.pois && result.poiList.pois[0];
          if (poi && poi.location) {
            resolve({ name: poi.name || keyword, lng: Number(poi.location.lng), lat: Number(poi.location.lat) });
            return;
          }
          this.geocoder.getLocation(keyword, (gStatus, gResult) => {
            const geo = gStatus === 'complete' && gResult.geocodes && gResult.geocodes[0];
            if (geo && geo.location) resolve({ name: keyword, lng: Number(geo.location.lng), lat: Number(geo.location.lat) });
            else reject(new Error('请换更具体的名称，或用地图点选'));
          });
        });
      });
    }

    reverseGeocode(lng, lat) {
      return new Promise((resolve) => {
        this.geocoder.getAddress([lng, lat], (status, result) => {
          if (status === 'complete' && result.regeocode) resolve(result.regeocode.formattedAddress || '地图点选位置');
          else resolve('地图点选位置');
        });
      });
    }

    route(from, to, mode = 'drive') {
      const normalized = window.RouteModel?.normalizeTransportMode?.(mode) || 'drive';
      if (normalized === 'ride') return this.ridingRoute(from, to);
      if (normalized === 'walk') return this.walkingRoute(from, to);
      return this.drivingRoute(from, to);
    }

    queryRoute(RouteClass, from, to, options = {}) {
      return new Promise((resolve, reject) => {
        const route = new RouteClass({
          ...options,
          hideMarkers: true,
          autoFitView: false
        });
        route.search([from.lng, from.lat], [to.lng, to.lat], (status, result) => {
          if (status !== 'complete' || !result || !result.routes || !result.routes[0]) {
            const message = typeof result === 'string'
              ? result
              : result && result.info
                ? result.info
                : '没有可用路线';
            reject(new Error(message === 'CUQPS_HAS_EXCEEDED_THE_LIMIT' ? '高德请求过快，触发 QPS 限制，请稍后重试' : message));
            return;
          }
          const route0 = result.routes[0];
          const path = [];
          const steps = route0.steps || route0.rides || route0.walks || [];
          steps.forEach((step) => {
            (step.path || []).forEach((lnglat) => {
              if (Array.isArray(lnglat)) path.push([Number(lnglat[0]), Number(lnglat[1])]);
              else path.push([Number(lnglat.lng), Number(lnglat.lat)]);
            });
          });
          resolve({ distance: Number(route0.distance) || 0, duration: Number(route0.time) || 0, path });
        });
      });
    }

    drivingRoute(from, to) {
      return this.queryRoute(AMap.Driving, from, to, {policy: AMap.DrivingPolicy.LEAST_TIME});
    }

    ridingRoute(from, to) {
      return this.queryRoute(AMap.Riding, from, to);
    }

    walkingRoute(from, to) {
      return this.queryRoute(AMap.Walking, from, to);
    }

    testSearch(keyword = '天安门') {
      return new Promise((resolve) => {
        if (!this.placeSearch) return resolve(false);
        this.placeSearch.search(keyword, (status, result) => {
          resolve(Boolean(status === 'complete' && result?.poiList?.pois?.length));
        });
      });
    }

    makeIcon(color, text) {
      const svg = encodeURIComponent(`
        <svg xmlns="http://www.w3.org/2000/svg" width="34" height="42" viewBox="0 0 34 42">
          <path d="M17 1C8.2 1 1 8.2 1 17c0 11.7 16 24 16 24s16-12.3 16-24C33 8.2 25.8 1 17 1z" fill="${color}" stroke="white" stroke-width="2"/>
          <circle cx="17" cy="17" r="10" fill="white" opacity=".95"/>
          <text x="17" y="21" text-anchor="middle" font-size="12" font-weight="800" font-family="Arial" fill="${color}">${text}</text>
        </svg>`);
      return new AMap.Icon({ image: `data:image/svg+xml;charset=utf-8,${svg}`, size: new AMap.Size(34, 42), imageSize: new AMap.Size(34, 42) });
    }
  }

  window.AmapProvider = AmapProvider;
})();
