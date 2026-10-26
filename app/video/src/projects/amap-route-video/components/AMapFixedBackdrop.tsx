import React, {useEffect, useRef, useState} from 'react';
import {AbsoluteFill, Img, cancelRender, continueRender, delayRender, staticFile, useVideoConfig} from 'remotion';
import AMapLoader from '@amap/amap-jsapi-loader';
import {LngLat, MapLayer} from '../types';
import {projectMapPoint} from '../lib/geo';

type Props = {
  center: LngLat;
  zoom: number;
  mapLayer: MapLayer;
  amapKey?: string;
  amapSecurityCode?: string;
  staticMapImage?: string;
  hillshade?: boolean;
  hillshadeEndpoint?: string;
};

const safeAsset = (src: string) => staticFile(String(src || '').replace(/\\/g, '/').replace(/^\.\//, ''));

const mapBackground = (mapLayer: MapLayer) => {
  if (mapLayer === 'standard') return '#e6efe3';
  return '#22301c';
};

const MapOverlay = () => (
  <AbsoluteFill
    style={{
      background:
        'linear-gradient(180deg, rgba(3,8,18,.20), transparent 23%, transparent 74%, rgba(3,8,18,.38)), radial-gradient(circle at 50% 48%, transparent 0 45%, rgba(2,6,14,.32) 100%)',
      pointerEvents: 'none',
    }}
  />
);

export const fallbackBackground = (mapLayer: MapLayer) => {
  if (mapLayer === 'standard') {
    return [
      'linear-gradient(90deg, rgba(34,197,94,.18) 0 2px, transparent 2px 120px)',
      'linear-gradient(0deg, rgba(14,165,233,.14) 0 2px, transparent 2px 120px)',
      'radial-gradient(circle at 28% 38%, rgba(74,222,128,.34), transparent 0 18%, transparent 34%)',
      'radial-gradient(circle at 62% 48%, rgba(56,189,248,.24), transparent 0 16%, transparent 36%)',
      'linear-gradient(135deg, #d7eadc, #aac7ad 45%, #7ea28a)',
    ].join(', ');
  }
  const satelliteBase = [
    'radial-gradient(circle at 24% 30%, rgba(52,211,153,.35), transparent 0 19%, transparent 33%)',
    'radial-gradient(circle at 70% 40%, rgba(180,83,9,.28), transparent 0 18%, transparent 34%)',
    'radial-gradient(circle at 48% 76%, rgba(15,118,110,.34), transparent 0 22%, transparent 38%)',
    'linear-gradient(135deg, #26351e, #4e5f2e 38%, #7a6a3f 58%, #223322)',
  ];
  if (mapLayer === 'hybrid') {
    satelliteBase.unshift('linear-gradient(115deg, transparent 0 48%, rgba(255,255,255,.42) 48% 49%, transparent 49% 100%)');
    satelliteBase.unshift('linear-gradient(28deg, transparent 0 54%, rgba(255,255,255,.32) 54% 55%, transparent 55% 100%)');
  }
  return satelliteBase.join(', ');
};

export const AMapFixedBackdrop: React.FC<Props> = ({center, zoom, mapLayer, amapKey, amapSecurityCode, staticMapImage, hillshade = false, hillshadeEndpoint = '/api/v1/map/hillshade'}) => {
  const {width, height} = useVideoConfig();
  const ref = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const [handle] = useState(() => delayRender('Loading AMap fixed video backdrop'));
  const continued = useRef(false);


  const done = () => {
    if (!continued.current) {
      continued.current = true;
      continueRender(handle);
    }
  };

  useEffect(() => {
    if (staticMapImage) {
      done();
      return;
    }
    let cancelled = false;
    let settleTimer: number | undefined;
    const fail = (error: unknown) => {
      if (!cancelled && !continued.current) cancelRender(error instanceof Error ? error : new Error(String(error)));
    };
    const timeout = window.setTimeout(() => fail(new Error('地图底图加载超时，已停止导出以避免空白画面。')), 25000);
    if (!amapKey || amapKey.trim().length < 8) {
      window.clearTimeout(timeout);
      fail(new Error('缺少高德地图配置，无法生成视频底图。'));
      return;
    }
    if (typeof window !== 'undefined' && amapSecurityCode) {
      (window as any)._AMapSecurityConfig = {securityJsCode: amapSecurityCode};
    }
    AMapLoader.load({key: amapKey, version: '2.0', plugins: []})
      .then((AMap: any) => {
        if (cancelled || !ref.current) return;
        const standard = new AMap.TileLayer({zIndex: 1, opacity: 1});
        const satellite = new AMap.TileLayer.Satellite({zIndex: 1, opacity: 1});
        const roadNet = new AMap.TileLayer.RoadNet({zIndex: 2, opacity: mapLayer === 'hybrid' ? 0.86 : 0});
        const hillshadeLayer = new AMap.TileLayer({
          zIndex: 3,
          opacity: 0.82,
          zooms: [5, 15],
          getTileUrl: (x: number, y: number, z: number) => `${hillshadeEndpoint}/${Number(z)}/${Number(x)}/${Number(y)}.webp`,
        });
        const baseLayers = mapLayer === 'standard' ? [standard] : mapLayer === 'satellite' ? [satellite] : [satellite, roadNet];
        const layers = hillshade ? [...baseLayers, hillshadeLayer] : baseLayers;
        const map = new AMap.Map(ref.current, {
          zoom,
          center,
          viewMode: '2D',
          background: mapBackground(mapLayer),
          layers,
          showLabel: mapLayer === 'standard',
          animateEnable: false,
          resizeEnable: false,
          dragEnable: false,
          zoomEnable: false,
          rotateEnable: false,
          pitchEnable: false,
          keyboardEnable: false,
          doubleClickZoom: false,
          jogEnable: false,
          touchZoom: false,
          scrollWheel: false,
        });
        mapRef.current = map;
        map.on('complete', () => {
          window.clearTimeout(settleTimer);
          settleTimer = window.setTimeout(() => {
            if (cancelled) return;
            try {
              const size = map.getSize();
              if (Math.abs(size.width - width) > 1 || Math.abs(size.height - height) > 1) throw new Error('高德底图视野尺寸与视频不一致。');
              const delta = 360 / (256 * Math.pow(2, zoom)) * Math.min(100, width / 8);
              const probes: LngLat[] = [center, [center[0] + delta, center[1]], [center[0], Math.min(80, center[1] + delta / 2)]];
              for (const point of probes) {
                const actual = map.lngLatToContainer(new AMap.LngLat(...point));
                const expected = projectMapPoint(point, center, zoom, width, height);
                if (Math.hypot(actual.x - expected.x, actual.y - expected.y) > 1.25) throw new Error('底图与路线投影不一致，已停止导出。');
              }
              window.clearTimeout(timeout);
              done();
            } catch (error) { fail(error); }
          }, 1200);
        });
      })
      .catch((e: Error) => {
        fail(e);
      });
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      window.clearTimeout(settleTimer);
      mapRef.current?.destroy?.();
      mapRef.current = null;
    };
  }, [amapKey, amapSecurityCode, hillshade, hillshadeEndpoint, mapLayer, staticMapImage, zoom, center[0], center[1], width, height]);

  return (
    <AbsoluteFill style={{background: fallbackBackground(mapLayer)}}>
      {staticMapImage ? (
        <Img
          src={safeAsset(staticMapImage)}
          onLoad={(event) => {
            const image = event.currentTarget;
            if (Math.abs(image.naturalWidth * height - image.naturalHeight * width) > Math.max(width, height)) {
              cancelRender(new Error('缓存底图比例与视频不一致，禁止裁剪地图。'));
            }
          }}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'fill',
          }}
        />
      ) : (
        <div
          ref={ref}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            background: fallbackBackground(mapLayer),
            filter: mapLayer === 'standard' ? 'saturate(.9) contrast(1.04) brightness(.92)' : 'saturate(.88) contrast(1.12) brightness(.76)',
          }}
        />
      )}
      {!staticMapImage ? <MapOverlay /> : null}

    </AbsoluteFill>
  );
};
