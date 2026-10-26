import {LngLat, RouteVideoData, VideoDay, VideoPoint} from '../types';

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
  return clamp(Math.ceil(measured + fontSize * 1.45), fontSize * 3.6, fontSize * 22);
};

const labelCandidates = (primary: LabelBox, gap: number, avoidRects: LabelBox[] = []) => {
  const candidates: LabelBox[] = [primary];
  const directions = [
    [0, -1], [1, -1], [1, 0], [1, 1],
    [0, 1], [-1, 1], [-1, 0], [-1, -1],
  ];
  for (let ring = 1; ring <= 3; ring += 1) {
    directions.forEach(([x, y]) => {
      candidates.push({
        ...primary,
        x: primary.x + x * ring * (primary.width + gap),
        y: primary.y + y * ring * (primary.height + gap),
      });
    });
  }
  avoidRects.forEach((rect) => {
    candidates.push(
      {...primary, x: rect.x - primary.width - gap},
      {...primary, x: rect.x + rect.width + gap},
      {...primary, y: rect.y - primary.height - gap},
      {...primary, y: rect.y + rect.height + gap},
    );
  });
  return candidates;
};

const distanceToSegment = (box: LabelBox, a: {x: number; y: number}, b: {x: number; y: number}) => {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((cx - a.x) * dx + (cy - a.y) * dy) / len2));
  const px = a.x + t * dx;
  const py = a.y + t * dy;
  return Math.hypot(cx - px, cy - py);
};

export const layoutPointLabels = (items: LabelLayoutItem[], width: number, height: number, avoidRects: LabelBox[] = [], scale = clamp(Math.min(width / 1280, height / 720), 0.9, 1.35), avoidPaths: {x: number; y: number}[][] = [], lockPositions = false): Map<string, LabelBox> => {
  const fontSize = 17 * scale;
  const gap = 8 * scale;
  const placed: LabelBox[] = [];
  const result = new Map<string, LabelBox>();
  const routeClearance = 16 * scale;
  const routePaths = avoidPaths
    .filter((path) => path.length >= 2)
    .map((path) => path.map(({x, y}) => ({x, y})));

  const measured = items.map((item) => {
    const labelWidth = Math.max(...item.text.split('\n').map((line) => estimateLabelWidth(line, fontSize)));
    const offset = item.labelOffset || {x: 0, y: 0};
    const lineCount = item.text.split('\n').length;
    const labelHeight = (lineCount > 1 ? 33 + (lineCount - 1) * 21 : 33) * scale;
    const primary: LabelBox = {
      x: item.x + 15 * scale + Number(offset.x || 0) * width,
      y: item.y - 56 * scale + Number(offset.y || 0) * height,
      width: labelWidth,
      height: labelHeight,
    };
    const itemAvoidRects = item.avoidRects?.length ? [...avoidRects, ...item.avoidRects] : avoidRects;
    const manual = (lockPositions && !item.avoidRects?.length) || Math.abs(Number(offset.x || 0)) > 1e-4 || Math.abs(Number(offset.y || 0)) > 1e-4;
    return {item, primary, manual, avoidRects: itemAvoidRects};
  });

  [...measured.filter((entry) => entry.manual), ...measured.filter((entry) => !entry.manual)].forEach(({item, primary, manual, avoidRects: itemAvoidRects}) => {
    if (manual) {
      const fixed = {
        ...primary,
        x: clamp(primary.x, 0, Math.max(0, width - primary.width)),
        y: clamp(primary.y, 0, Math.max(0, height - primary.height)),
      };
      placed.push(fixed);
      result.set(item.key, fixed);
      return;
    }
    const candidates = labelCandidates(primary, gap, itemAvoidRects);
    let best = primary;
    let bestScore = Number.POSITIVE_INFINITY;
    candidates.forEach((candidate, index) => {
      const overlap = placed.reduce((total, previous) => total + overlapArea(candidate, previous), 0);
      const avoided = itemAvoidRects.reduce((total, rect) => total + overlapArea(candidate, rect), 0);
      const outside = Math.max(0, -candidate.x)
        + Math.max(0, -candidate.y)
        + Math.max(0, candidate.x + candidate.width - width)
        + Math.max(0, candidate.y + candidate.height - height);
      const routePenalty = routePaths.reduce((total, path) => {
        let nearest = Number.POSITIVE_INFINITY;
        for (let i = 0; i < path.length - 1; i += 1) {
          const d = distanceToSegment(candidate, path[i], path[i + 1]);
          if (d < nearest) nearest = d;
          if (nearest < routeClearance) break;
        }
        if (nearest >= routeClearance) return total;
        const ratio = 1 - nearest / routeClearance;
        const base = nearest < routeClearance * 0.35 ? 500 : nearest < routeClearance * 0.6 ? 240 : 90;
        return total + base * (0.4 + 0.6 * ratio);
      }, 0);
      const distance = Math.hypot(candidate.x - primary.x, candidate.y - primary.y);
      const score = overlap * 120 + avoided * 120 + outside * 240 + routePenalty + distance * 0.3 + index * 0.002;
      if (score < bestScore) {
        best = candidate;
        bestScore = score;
      }
    });
    const clamped = {
      ...best,
      x: clamp(best.x, 0, Math.max(0, width - best.width)),
      y: clamp(best.y, 0, Math.max(0, height - best.height)),
    };
    let finalBox = clamped;
    let guard = 0;
    while (placed.some((previous) => overlapArea(finalBox, previous) > 0.01) && guard < 6) {
      const right = {x: finalBox.x + finalBox.width + gap, y: finalBox.y, width: finalBox.width, height: finalBox.height};
      if (right.x + right.width <= width && !placed.some((previous) => overlapArea(right, previous) > 0.01)) {
        finalBox = right;
        break;
      }
      const left = {x: finalBox.x - finalBox.width - gap, y: finalBox.y, width: finalBox.width, height: finalBox.height};
      if (left.x >= 0 && !placed.some((previous) => overlapArea(left, previous) > 0.01)) {
        finalBox = left;
        break;
      }
      const down = {x: finalBox.x, y: Math.min(height - finalBox.height, finalBox.y + finalBox.height + gap), width: finalBox.width, height: finalBox.height};
      if (down.y !== finalBox.y && !placed.some((previous) => overlapArea(down, previous) > 0.01)) {
        finalBox = down;
        break;
      }
      const up = {x: finalBox.x, y: Math.max(0, finalBox.y - finalBox.height - gap), width: finalBox.width, height: finalBox.height};
      if (up.y !== finalBox.y && !placed.some((previous) => overlapArea(up, previous) > 0.01)) {
        finalBox = up;
        break;
      }
      finalBox = {x: finalBox.x + finalBox.width + gap, y: finalBox.y, width: finalBox.width, height: finalBox.height};
      guard += 1;
    }
    placed.push(finalBox);
    result.set(item.key, finalBox);
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
