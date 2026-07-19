import React from 'react';
import {Composition} from 'remotion';
import {AmapRouteVideo} from './compositions/AmapRouteVideo';
import routeVideoData from './data/route-video-data.json';
import {getTotalDuration} from './lib/timeline';
import {RouteVideoData} from './types';

const data = routeVideoData as unknown as RouteVideoData;

const positiveInt = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

export const AmapRouteVideoRoot: React.FC = () => {
  const amapKey = process.env.REMOTION_AMAP_KEY ?? '';
  const amapSecurityCode = process.env.REMOTION_AMAP_SECURITY_CODE ?? '';
  const width = positiveInt(process.env.ROUTE_RENDER_WIDTH, 1280);
  const height = positiveInt(process.env.ROUTE_RENDER_HEIGHT, 720);
  const fps = positiveInt(process.env.ROUTE_RENDER_FPS, 30);

  return (
    <Composition
      id="AmapRouteVideo"
      component={AmapRouteVideo}
      durationInFrames={getTotalDuration(data)}
      fps={fps}
      width={width}
      height={height}
      defaultProps={{
        data,
        amapKey,
        amapSecurityCode,
      }}
    />
  );
};
