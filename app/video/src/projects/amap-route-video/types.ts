export type LngLat = [number, number];

export type MapLayer = 'standard' | 'satellite' | 'hybrid';

export type ScenicInfo = {
  title: string;
  name?: string;
  aliases?: string[];
  images?: string[];
  description?: string;
};

export type VideoPoint = {
  name: string;
  lng: number;
  lat: number;
  role: string;
  kind: 'from' | 'waypoint' | 'to' | string;
  transportMode?: 'drive' | 'ride' | 'walk';
  scenic?: ScenicInfo | null;
};

export type VideoSegment = {
  from: string;
  to: string;
  distance: number;
  duration: number;
  mode?: 'drive' | 'ride' | 'walk';
  path: LngLat[];
  error?: string;
};

export type VideoDay = {
  title: string;
  color: string;
  points: VideoPoint[];
  segments: VideoSegment[];
};

export type RouteVideoData = {
  version: number;
  exportedAt: string;
  mapLayer: MapLayer;
  renderSpeed?: number;
  renderMode?: 'video' | 'mapOnly' | 'overview';
  staticMapImage?: string;
  route: {id: string; name: string};
  days: VideoDay[];
  summary: {
    dayCount: number;
    totalDistance: number;
    totalDuration: number;
    bounds: [number, number, number, number];
  };
};
