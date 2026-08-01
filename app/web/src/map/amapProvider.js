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
      this.labelBindings = [];
      this.labelLayer = null;
      this.labelRefreshFrame = null;
      this.labelTrackFrame = null;
      this.resizeObserver = null;
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
      if (typeof ResizeObserver !== 'undefined') {
        this.resizeObserver?.disconnect();
        this.resizeObserver = new ResizeObserver(() => this.scheduleLabelRefresh());
        this.resizeObserver.observe(this.map.getContainer());
      }
      this.ensureLabelLayer();
      ['mapmove', 'moving', 'zoomchange', 'resize', 'complete'].forEach((eventName) => {
        this.map.on(eventName, () => this.scheduleLabelRefresh());
      });
      ['movestart', 'zoomstart'].forEach((eventName) => {
        this.map.on(eventName, () => this.startLabelTracking(1200));
      });
      ['moveend', 'zoomend'].forEach((eventName) => {
        this.map.on(eventName, () => {
          this.refreshLabels();
          this.startLabelTracking(240);
        });
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
      if (this.map && this.overlays.length) this.map.remove(this.overlays);
      this.labelBindings.forEach((binding) => { binding.active = false; });
      this.labelLayer?.replaceChildren();
      this.overlays = [];
      this.labelBindings = [];
    }

    ensureLabelLayer() {
      const container = this.map?.getContainer?.();
      if (!container) return null;
      if (!this.labelLayer || !container.contains(this.labelLayer)) {
        this.labelLayer = document.createElement('div');
        this.labelLayer.className = 'route-label-layer';
        container.appendChild(this.labelLayer);
      }
      return this.labelLayer;
    }

    getMapPixelSize() {
      const container = this.map?.getContainer?.();
      return {
        width: Math.max(1, Number(container?.clientWidth || 1)),
        height: Math.max(1, Number(container?.clientHeight || 1))
      };
    }

    labelOffsetPixels(labelOffset) {
      const size = this.getMapPixelSize();
      return {
        x: Number(labelOffset?.x || 0) * size.width,
        y: Number(labelOffset?.y || 0) * size.height
      };
    }

    normalizeLabelOffset(labelOffset) {
      const x = Number(labelOffset?.x);
      const y = Number(labelOffset?.y);
      return {
        x: Number.isFinite(x) ? Math.max(-2, Math.min(2, x)) : 0,
        y: Number.isFinite(y) ? Math.max(-2, Math.min(2, y)) : 0
      };
    }

    pointToContainerPixel(point) {
      const pixel = this.map?.lngLatToContainer?.([point.lng, point.lat]);
      const x = Number(pixel?.x ?? pixel?.getX?.() ?? 0);
      const y = Number(pixel?.y ?? pixel?.getY?.() ?? 0);
      return {x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0};
    }

    labelBasePixel(binding) {
      const point = this.pointToContainerPixel(binding.point);
      return {x: point.x + 15, y: point.y - 56};
    }

    positionLabel(binding, dragDelta = binding.dragDelta || {x: 0, y: 0}) {
      if (!binding.active || !binding.element) return;
      const base = this.labelBasePixel(binding);
      const offset = this.labelOffsetPixels(binding.labelOffset);
      const x = base.x + offset.x + dragDelta.x;
      const y = base.y + offset.y + dragDelta.y;
      binding.element.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
    }

    refreshLabels() {
      this.labelBindings.forEach((binding) => this.positionLabel(binding));
    }

    scheduleLabelRefresh() {
      if (this.labelRefreshFrame) return;
      const frame = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (callback) => setTimeout(callback, 16);
      this.labelRefreshFrame = frame(() => {
        this.labelRefreshFrame = null;
        this.refreshLabels();
      });
    }

    startLabelTracking(milliseconds = 900) {
      const frame = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (callback) => setTimeout(callback, 16);
      const now = typeof performance !== 'undefined' && performance.now ? () => performance.now() : () => Date.now();
      const until = now() + milliseconds;
      if (this.labelTrackFrame) return;
      const tick = () => {
        this.refreshLabels();
        if (now() < until && this.map) {
          this.labelTrackFrame = frame(tick);
        } else {
          this.labelTrackFrame = null;
        }
      };
      this.labelTrackFrame = frame(tick);
    }

    bindHtmlLabelDrag(binding) {
      const label = binding.element;
      label.style.pointerEvents = 'auto';
      label.style.touchAction = 'none';
      label.style.cursor = 'grab';
      label.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        try { label.setPointerCapture?.(event.pointerId); } catch (_) {}
        label.style.cursor = 'grabbing';
        label.classList.add('dragging');
        this.map?.setStatus?.({dragEnable: false});
        const size = this.getMapPixelSize();
        const start = this.labelOffsetPixels(binding.labelOffset);
        const origin = {x: event.clientX, y: event.clientY};
        const current = {x: event.clientX, y: event.clientY};
        binding.dragDelta = {x: 0, y: 0};
        let moved = false;
        const move = (moveEvent) => {
          moveEvent.preventDefault();
          moveEvent.stopPropagation();
          current.x = moveEvent.clientX;
          current.y = moveEvent.clientY;
          const delta = {x: current.x - origin.x, y: current.y - origin.y};
          moved = moved || Math.abs(delta.x) > 2 || Math.abs(delta.y) > 2;
          binding.dragDelta = delta;
          this.positionLabel(binding);
        };
        const finish = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', finish);
          window.removeEventListener('pointercancel', finish);
          try { label.releasePointerCapture?.(event.pointerId); } catch (_) {}
          label.style.cursor = 'grab';
          label.classList.remove('dragging');
          this.map?.setStatus?.({dragEnable: true});
          if (!moved) {
            binding.dragDelta = {x: 0, y: 0};
            this.positionLabel(binding);
            return;
          }
          const delta = {x: current.x - origin.x, y: current.y - origin.y};
          const endSize = this.getMapPixelSize();
          const next = {
            x: (start.x + delta.x) / endSize.width,
            y: (start.y + delta.y) / endSize.height
          };
          binding.labelOffset = this.normalizeLabelOffset(next);
          binding.dragDelta = {x: 0, y: 0};
          this.positionLabel(binding);
          binding.onLabelDrag?.(binding.labelOffset);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', finish, {once: true});
        window.addEventListener('pointercancel', finish, {once: true});
      });
    }

    addHtmlLabel({point, label, labelOffset, onLabelDrag, labelKey}) {
      const layer = this.ensureLabelLayer();
      if (!layer || !label) return null;
      const template = document.createElement('template');
      template.innerHTML = String(label).trim();
      const element = template.content.firstElementChild || document.createElement('div');
      if (!element.classList.contains('marker-label')) element.classList.add('marker-label');
      element.dataset.routeLabelKey = labelKey || '';
      layer.appendChild(element);
      const binding = {point, element, labelOffset: this.normalizeLabelOffset(labelOffset), dragDelta: {x: 0, y: 0}, onLabelDrag, labelKey, active: true};
      this.labelBindings.push(binding);
      this.positionLabel(binding);
      if (onLabelDrag) this.bindHtmlLabelDrag(binding);
      return element;
    }

    addMarker({point, label, color, text, onClick, labelOffset, onLabelDrag, labelKey}) {
      const marker = new AMap.Marker({
        position: [point.lng, point.lat],
        title: point.name,
        icon: this.makeIcon(color, text)
      });
      if (onClick) marker.on('click', onClick);
      this.map.add(marker);
      this.overlays.push(marker);
      if (onLabelDrag && labelKey) {
        this.addHtmlLabel({point, label, labelOffset, onLabelDrag, labelKey});
      }
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
      if (this.map && overlays?.length) {
        this.map.setFitView(overlays, false, [60, 60, 60, 60]);
        setTimeout(() => this.refreshLabels(), 80);
        setTimeout(() => this.refreshLabels(), 300);
      }
    }

    setZoomAndCenter(zoom, center) {
      if (this.map) {
        this.map.setZoomAndCenter(zoom, center);
        this.startLabelTracking(500);
      }
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
            else reject(new Error('请换一个更具体的地点名称。'));
          });
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
