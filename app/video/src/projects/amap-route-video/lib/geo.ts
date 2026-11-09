import {LngLat, RouteVideoData, VideoDay} from '../types';
import {layoutLabels as sharedLayoutLabels} from '../../../../../shared/label-layout.js';

export type Camera = {
  center: LngLat;
  zoom: number;
  project: (point: LngLat) => {x: number; y: number};
};

export type LabelBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type LabelLayoutItem = {
  key: string;
  x: number;
  y: number;
  text: string;
  labelOffset?: {x: number; y: number};
  avoidRects?: LabelBox[];
};

const TILE_SIZE = 256;
const MIN_ZOOM = 3;
const MAX_ZOOM = 14.8;
const OVERVIEW_PADDING_RATIO = 0.03;
const OVERVIEW_FIT_BOX_MM = {width: 178, height: 200};
const OVERVIEW_LABEL_MM = 4.3;
const OVERVIEW_MIN_LABEL_SCALE = 1.1;
const OVERVIEW_MAX_LABEL_SCALE = 4;
const OVERVIEW_LABEL_AREA_BUDGET = 0.16;
const OVERVIEW_LABEL_AREA_UNIT = 27 * (3 * 14 + 14);

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export const pointScale = (data: RouteVideoData | undefined, width: number, height: number) => {
  if (data?.renderMode === 'overview') {
    const fit = Math.max(width / OVERVIEW_FIT_BOX_MM.width, height / OVERVIEW_FIT_BOX_MM.height);
    const target = (OVERVIEW_LABEL_MM * fit) / 14;
    const labels = (data.days || []).reduce((sum, day) => sum + (day.points ? day.points.length : 0), 0);
    const budget = labels > 0
      ? Math.sqrt((OVERVIEW_LABEL_AREA_BUDGET * width * height) / (OVERVIEW_LABEL_AREA_UNIT * labels))
      : Number.POSITIVE_INFINITY;
    return clamp(Math.min(target, budget), OVERVIEW_MIN_LABEL_SCALE, OVERVIEW_MAX_LABEL_SCALE);
  }
  return clamp(Math.min(width / 1280, height / 720), 0.9, 1.35);
};
export const markerScale = (data: RouteVideoData | undefined, width: number, height: number) => {
  if (data?.renderMode === 'overview') return clamp(Math.min(width, height) / 720, 0.55, 1.9);
  return clamp(pointScale(data, width, height) * 0.62, 0.55, 0.9);
};

const estimateLabelWidth = (text: string, fontSize: number) => {
  const characters = Array.from(String(text || ''));
  const measured = characters.reduce((total, character) => {
    return total + (/[\u0000-\u00ff]/.test(character) ? fontSize * 0.58 : fontSize);
  }, 0);
  return clamp(Math.ceil(measured + fontSize * 1.45), fontSize * 3.6, fontSize * 22);
};

export const layoutPointLabels = (items: LabelLayoutItem[], width: number, height: number, avoidRects: LabelBox[] = [], scale = clamp(Math.min(width / 1280, height / 720), 0.9, 1.35), avoidPaths: {x: number; y: number}[][] = [], lockPositions = false): Map<string, LabelBox> => {
  const fontSize = 17 * scale;
  const prepared = items.map((item) => {
    const text = String(item.text || '');
    const lineCount = text.split('\n').length;
    return {
      key: item.key,
      x: item.x,
      y: item.y,
      width: Math.max(...text.split('\n').map((line) => estimateLabelWidth(line, fontSize))),
      height: (lineCount > 1 ? 33 + (lineCount - 1) * 21 : 33) * scale,
      userOffset: item.labelOffset || {x: 0, y: 0},
      avoidRects: item.avoidRects || []
    };
  });
  const boxes = sharedLayoutLabels({
    width,
    height,
    scale,
    items: prepared,
    obstacles: avoidRects,
    paths: avoidPaths,
    lockPositions
  });
  const result = new Map<string, LabelBox>();
  prepared.forEach((item) => {
    const box = boxes.get(String(item.key));
    if (box) result.set(item.key, {x: box.x, y: box.y, width: box.width, height: box.height});
  });
  return result;
};
const mercatorX = (lng: number, zoom = 0) => ((lng + 180) / 360) * TILE_SIZE * Math.pow(2, zoom);
const mercatorY = (lat: number, zoom = 0) => {
  const safeLat = clamp(lat, -85.05112878, 85.05112878);
  const sin = Math.sin((safeLat * Math.PI) / 180);
  return (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * TILE_SIZE * Math.pow(2, zoom);
};
const inverseMercatorLng = (x: number, zoom = 0) => (x / (TILE_SIZE * Math.pow(2, zoom))) * 360 - 180;
const inverseMercatorLat = (y: number, zoom = 0) => {
  const n = Math.PI - (2 * Math.PI * y) / (TILE_SIZE * Math.pow(2, zoom));
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

export const projectMapPoint = ([lng, lat]: LngLat, center: LngLat, zoom: number, width: number, height: number) => ({
  x: width / 2 + mercatorX(lng, zoom) - mercatorX(center[0], zoom),
  y: height / 2 + mercatorY(lat, zoom) - mercatorY(center[1], zoom),
});

export const collectAllPoints = (data: RouteVideoData): LngLat[] => {
  const points: LngLat[] = [];
  data.days.forEach((day) => {
    day.points.forEach((p) => points.push([p.lng, p.lat]));
    day.segments.forEach((s) => (s.path || []).forEach((p) => points.push(p)));
  });
  if (points.length === 0 && data.summary?.bounds) {
    const [minLng, minLat, maxLng, maxLat] = data.summary.bounds;
    points.push([minLng, minLat], [maxLng, maxLat]);
  }
  return points;
};

export const computeCamera = (data: RouteVideoData, width: number, height: number): Camera => {
  const points = collectAllPoints(data).filter((point) => point.every(Number.isFinite));
  const lngs = points.map((p) => p[0]).filter(Number.isFinite);
  const lats = points.map((p) => p[1]).filter(Number.isFinite);
  const minLng = lngs.reduce((min, value) => Math.min(min, value), lngs[0] ?? 100);
  const maxLng = lngs.reduce((max, value) => Math.max(max, value), lngs[0] ?? 105);
  const minLat = lats.reduce((min, value) => Math.min(min, value), lats[0] ?? 32);
  const maxLat = lats.reduce((max, value) => Math.max(max, value), lats[0] ?? 37);

  const minX0 = mercatorX(minLng, 0);
  const maxX0 = mercatorX(maxLng, 0);
  const minY0 = mercatorY(maxLat, 0);
  const maxY0 = mercatorY(minLat, 0);
  const worldW0 = Math.max(0.0001, maxX0 - minX0);
  const worldH0 = Math.max(0.0001, maxY0 - minY0);

  const overviewMode = data.renderMode === 'overview';
  const pinHead = 52 * markerScale(data, width, height);
  const paddingX = overviewMode ? Math.max(24, width * OVERVIEW_PADDING_RATIO) : 230;
  const paddingTop = overviewMode ? Math.max(24, height * OVERVIEW_PADDING_RATIO, pinHead + 6) : 270;
  const paddingBottom = overviewMode ? Math.max(24, height * OVERVIEW_PADDING_RATIO) : 128;
  const zoomX = Math.log2((width - paddingX * 2) / worldW0);
  const zoomY = Math.log2((height - paddingTop - paddingBottom) / worldH0);
  const rawZoom = clamp(Math.min(zoomX, zoomY), MIN_ZOOM, MAX_ZOOM);
  const zoom = Math.floor(rawZoom * 10) / 10;

  const contentCenterX = paddingX + (width - paddingX * 2) / 2;
  const contentCenterY = paddingTop + (height - paddingTop - paddingBottom) / 2;
  const boundsCenterX = (mercatorX(minLng, zoom) + mercatorX(maxLng, zoom)) / 2;
  const boundsCenterY = (mercatorY(maxLat, zoom) + mercatorY(minLat, zoom)) / 2;
  const centerX = boundsCenterX - (contentCenterX - width / 2);
  const centerY = boundsCenterY - (contentCenterY - height / 2);
  const center: LngLat = [inverseMercatorLng(centerX, zoom), inverseMercatorLat(centerY, zoom)];

  return {
    center,
    zoom,
    project: (point) => projectMapPoint(point, center, zoom, width, height),
  };
};

export const distance2d = (a: {x: number; y: number}, b: {x: number; y: number}) => Math.hypot(a.x - b.x, a.y - b.y);

const projectedPathLength = (path: LngLat[], project: Camera['project']): number => {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += distance2d(project(path[i - 1]), project(path[i]));
  return total;
};

const daySegmentCount = (day: VideoDay) => Math.max(0, day.points.length - 1, day.segments.length);

const segmentPath = (day: VideoDay, index: number): LngLat[] => {
  const segment = day.segments[index];
  if (segment?.path && segment.path.length >= 2) return segment.path;
  const from = day.points[index];
  const to = day.points[index + 1];
  return from && to ? [[from.lng, from.lat], [to.lng, to.lat]] : [];
};

export const dayPath = (day: VideoDay): LngLat[] => {
  const result: LngLat[] = [];
  const count = daySegmentCount(day);
  for (let index = 0; index < count; index += 1) {
    segmentPath(day, index).forEach((point, pointIndex) => {
      if (index > 0 && pointIndex === 0) return;
      result.push(point);
    });
  }
  if (result.length) return result;
  return day.points.map((p) => [p.lng, p.lat] as LngLat);
};

export const daySegmentPaths = (day: VideoDay): LngLat[][] => {
  const count = daySegmentCount(day);
  const paths: LngLat[][] = [];
  for (let index = 0; index < count; index += 1) paths.push(segmentPath(day, index));
  return paths;
};

export const segmentRevealFractions = (day: VideoDay, progress: number): number[] => {
  const count = daySegmentCount(day);
  if (!(count > 0)) return [];
  const scaled = clamp(progress, 0, 1) * count;
  return Array.from({length: count}, (_, index) => clamp(scaled - index, 0, 1));
};

export const cumulativePointProgress = (day: VideoDay): number[] => {
  const count = daySegmentCount(day);
  if (!(count > 0)) return day.points.map(() => 0);
  return day.points.map((_, index) => clamp(index / count, 0, 1));
};

const samplePath = (path: LngLat[], progress: number, project: Camera['project']): LngLat => {
  if (!path.length) return [0, 0];
  if (path.length === 1) return path[0];
  const target = clamp(progress, 0, 1) * projectedPathLength(path, project);
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    const a = project(path[i - 1]);
    const b = project(path[i]);
    const len = distance2d(a, b);
    if (acc + len >= target) {
      const t = len <= 0 ? 0 : (target - acc) / len;
      return [path[i - 1][0] + (path[i][0] - path[i - 1][0]) * t, path[i - 1][1] + (path[i][1] - path[i - 1][1]) * t];
    }
    acc += len;
  }
  return path[path.length - 1];
};

export const sampleDayPath = (day: VideoDay, progress: number, project: Camera['project']): LngLat => {
  if (!day.points.length) return [0, 0];
  if (day.points.length === 1) {
    return [day.points[0].lng, day.points[0].lat];
  }
  const count = daySegmentCount(day);
  if (!(count > 0)) return [day.points[0].lng, day.points[0].lat];
  const scaled = clamp(progress, 0, 1) * count;
  const index = Math.min(count - 1, Math.floor(scaled));
  const localProgress = clamp(scaled - index, 0, 1);
  return samplePath(segmentPath(day, index), localProgress, project);
};

export const svgPath = (path: LngLat[], project: Camera['project']) => {
  if (!path.length) return '';
  return path
    .map((point, index) => {
      const {x, y} = project(point);
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
};
