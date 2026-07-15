import React, {useEffect, useRef, useState} from 'react';
import {AbsoluteFill, Img, continueRender, delayRender, staticFile} from 'remotion';
import AMapLoader from '@amap/amap-jsapi-loader';
import {LngLat, MapLayer} from '../types';

type Props = {
  center: LngLat;
  zoom: number;
  mapLayer: MapLayer;
  amapKey?: string;
  amapSecurityCode?: string;
  staticMapImage?: string;
};

const safeAsset = (src: string) => staticFile(String(src || '').replace(/\\/g, '/').replace(/^\.\//, ''));

const MapOverlay = () => (
  <AbsoluteFill
    style={{
      background:
        'linear-gradient(180deg, rgba(3,8,18,.20), transparent 23%, transparent 74%, rgba(3,8,18,.38)), radial-gradient(circle at 50% 48%, transparent 0 45%, rgba(2,6,14,.32) 100%)',
      pointerEvents: 'none',
    }}
  />
);

const fallbackBackground = (mapLayer: MapLayer) => {
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

export const AMapFixedBackdrop: React.FC<Props> = ({center, zoom, mapLayer, amapKey, amapSecurityCode, staticMapImage}) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const [handle] = useState(() => delayRender('Loading AMap fixed video backdrop'));
  const continued = useRef(false);
  const [failed, setFailed] = useState(false);

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
    if (!amapKey || amapKey.trim().length < 8) {
      setFailed(true);
      done();
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
        const layers = mapLayer === 'standard' ? [standard] : mapLayer === 'satellite' ? [satellite] : [satellite, roadNet];
        const map = new AMap.Map(ref.current, {
          zoom,
          center,
          viewMode: '2D',
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
        map.on('complete', () => window.setTimeout(done, 1200));
        window.setTimeout(done, 6500);
      })
      .catch((e: Error) => {
        console.error(e);
        setFailed(true);
        done();
      });
    return () => {
      cancelled = true;
      mapRef.current?.destroy?.();
      mapRef.current = null;
    };
  }, [amapKey, amapSecurityCode, center, mapLayer, staticMapImage, zoom]);

  return (
    <AbsoluteFill style={{background: fallbackBackground(mapLayer)}}>
      {staticMapImage ? (
        <Img
          src={safeAsset(staticMapImage)}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            filter: mapLayer === 'standard' ? 'saturate(.9) contrast(1.04) brightness(.92)' : 'saturate(.88) contrast(1.12) brightness(.76)',
            transform: 'scale(1.012)',
            transformOrigin: 'center center',
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
            filter: mapLayer === 'standard' ? 'saturate(.9) contrast(1.04) brightness(.92)' : 'saturate(.88) contrast(1.12) brightness(.76)',
            transform: 'scale(1.012)',
            transformOrigin: 'center center',
          }}
        />
      )}
      <MapOverlay />
      {failed ? (
        <AbsoluteFill
          style={{
            background: fallbackBackground(mapLayer),
          }}
        />
      ) : null}
    </AbsoluteFill>
  );
};
