import React from 'react';
import {Composition} from 'remotion';
import {AmapRouteVideo} from './compositions/AmapRouteVideo';
import routeVideoData from './data/route-video-data.json';
import {getTotalDuration} from './lib/timeline';
import {RouteVideoData} from './types';

const data = routeVideoData as unknown as RouteVideoData;

export const AmapRouteVideoRoot: React.FC = () => {
  const amapKey = process.env.REMOTION_AMAP_KEY ?? '';
  const amapSecurityCode = process.env.REMOTION_AMAP_SECURITY_CODE ?? '';

  return (
    <Composition
      id="AmapRouteVideo"
      component={AmapRouteVideo}
      durationInFrames={getTotalDuration(data)}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={{
        data,
        amapKey,
        amapSecurityCode,
      }}
    />
  );
};

