import {LngLat, RouteVideoData, VideoDay} from '../types';

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
};

const TILE_SIZE = 256;
const MIN_ZOOM = 3;
const MAX_ZOOM = 14.8;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const overlapArea = (a: LabelBox, b: LabelBox) => {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return width * height;
};

const estimateLabelWidth = (text: string, fontSize: number) => {
  const characters = Array.from(String(text || ''));
  const measured = characters.reduce((total, character) => {
    return total + (/[\u0000-\u00ff]/.test(character) ? fontSize * 0.58 : fontSize);
  }, 0);
  return clamp(Math.ceil(measured + fontSize * 1.45), fontSize * 8.5, fontSize * 22);
};

const labelCandidates = (primary: LabelBox, gap: number) => {
  const candidates: LabelBox[] = [primary];
  const directions = [
    [0, -1], [1, -1], [1, 0], [1, 1],
    [0, 1], [-1, 1], [-1, 0], [-1, -1],
  ];
  for (let ring = 1; ring <= 5; ring += 1) {
    directions.forEach(([x, y]) => {
      candidates.push({
        ...primary,
        x: primary.x + x * ring * (primary.width + gap),
        y: primary.y + y * ring * (primary.height + gap),
      });
    });
  }
  return candidates;
};

export const layoutPointLabels = (items: LabelLayoutItem[], width: number, height: number): Map<string, LabelBox> => {
  const scale = clamp(Math.min(width / 1280, height / 720), 0.9, 1.35);
  const fontSize = 14 * scale;
  const labelHeight = 27 * scale;
  const gap = 8 * scale;
  const placed: LabelBox[] = [];
  const result = new Map<string, LabelBox>();

  items.forEach((item) => {
    const labelWidth = estimateLabelWidth(item.text, fontSize);
    const offset = item.labelOffset || {x: 0, y: 0};
    const primary: LabelBox = {
      x: item.x + 15 * scale + Number(offset.x || 0) * width,
      y: item.y - 56 * scale + Number(offset.y || 0) * height,
      width: labelWidth,
      height: labelHeight,
    };
    const candidates = labelCandidates(primary, gap);
    let best = primary;
    let bestScore = Number.POSITIVE_INFINITY;
    candidates.forEach((candidate, index) => {
      const overlap = placed.reduce((total, previous) => total + overlapArea(candidate, previous), 0);
      const outside = Math.max(0, -candidate.x)
        + Math.max(0, -candidate.y)
        + Math.max(0, candidate.x + candidate.width - width)
        + Math.max(0, candidate.y + candidate.height - height);
      const distance = Math.hypot(candidate.x - primary.x, candidate.y - primary.y);
      const score = overlap * 100 + outside * 30 + distance * 0.04 + index * 0.001;
      if (score < bestScore) {
        best = candidate;
        bestScore = score;
      }
    });
    placed.push(best);
    result.set(item.key, best);
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
  const points = collectAllPoints(data);
  const lngs = points.map((p) => p[0]).filter(Number.isFinite);
  const lats = points.map((p) => p[1]).filter(Number.isFinite);
  const minLng = lngs.length ? Math.min(...lngs) : 100;
  const maxLng = lngs.length ? Math.max(...lngs) : 105;
  const minLat = lats.length ? Math.min(...lats) : 32;
  const maxLat = lats.length ? Math.max(...lats) : 37;

  const minX0 = mercatorX(minLng, 0);
  const maxX0 = mercatorX(maxLng, 0);
  const minY0 = mercatorY(maxLat, 0);
  const maxY0 = mercatorY(minLat, 0);
  const worldW0 = Math.max(0.0001, maxX0 - minX0);
  const worldH0 = Math.max(0.0001, maxY0 - minY0);

  const overviewMode = data.renderMode === 'overview';
  const paddingX = overviewMode ? Math.max(140, width * 0.075) : 230;
  // 视频顶部有一条信息横幅。这里给地图取景区额外留出上边距，
  // 并把地图中心同步下移，避免路线、点位和光点被横幅遮住。
  const paddingTop = overviewMode ? Math.max(120, height * 0.08) : 270;
  const paddingBottom = overviewMode ? Math.max(120, height * 0.08) : 128;
  const zoomX = Math.log2((width - paddingX * 2) / worldW0);
  const zoomY = Math.log2((height - paddingTop - paddingBottom) / worldH0);
  const zoom = Math.round(clamp(Math.min(zoomX, zoomY), MIN_ZOOM, MAX_ZOOM) * 10) / 10;

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
    project: ([lng, lat]) => ({
      x: width / 2 + mercatorX(lng, zoom) - mercatorX(center[0], zoom),
      y: height / 2 + mercatorY(lat, zoom) - mercatorY(center[1], zoom),
    }),
  };
};

export const dayPath = (day: VideoDay): LngLat[] => {
  const result: LngLat[] = [];
  day.segments.forEach((seg, index) => {
    const path = seg.path && seg.path.length >= 2 ? seg.path : [];
    path.forEach((point, pointIndex) => {
      if (index > 0 && pointIndex === 0) return;
      result.push(point);
    });
  });
  if (result.length) return result;
  return day.points.map((p) => [p.lng, p.lat] as LngLat);
};

export const distance2d = (a: {x: number; y: number}, b: {x: number; y: number}) => Math.hypot(a.x - b.x, a.y - b.y);

export const projectedPathLength = (path: LngLat[], project: Camera['project']): number => {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += distance2d(project(path[i - 1]), project(path[i]));
  return total;
};

export const cumulativePointProgress = (day: VideoDay, _project: Camera['project']): number[] => {
  const segmentCount = Math.max(1, day.points.length - 1, day.segments.length);
  return day.points.map((_, index) => Math.min(1, index / segmentCount));
};

export const samplePath = (path: LngLat[], progress: number, project: Camera['project']): LngLat => {
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
  const segmentCount = Math.max(1, day.points.length - 1);
  const scaled = clamp(progress, 0, 1) * segmentCount;
  const segmentIndex = Math.min(segmentCount - 1, Math.floor(scaled));
  const localProgress = scaled - segmentIndex;
  const segment = day.segments[segmentIndex];
  const fallbackPath: LngLat[] = [
    [day.points[segmentIndex].lng, day.points[segmentIndex].lat],
    [day.points[segmentIndex + 1].lng, day.points[segmentIndex + 1].lat],
  ];
  return samplePath(segment?.path?.length >= 2 ? segment.path : fallbackPath, localProgress, project);
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
