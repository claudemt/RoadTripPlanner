import {LabelBox} from './geo';

export type PinEntry = {
  key: string;
  x: number;
  y: number;
  name: string;
  role: string;
  dayIndex: number;
  showLabel: boolean;
};

export type PinGroup = {
  survivor: string;
  labelOwner: string | null;
  labelPrefixes: string[];
  members: string[];
};

export type PinAnchor = {group: number; x: number; y: number};

export type PinLabelKind = 'endpoint' | 'waypoint';

export type PinLabelItem = {
  key: string;
  /** 图钉尖端的画面坐标 */
  x: number;
  y: number;
  width: number;
  height: number;
  kind: PinLabelKind;
  /** 自己的图钉在 options.pins 里的下标，用来把自己的钉子从障碍里排除 */
  pinIndex?: number;
  /** 越小的越先占位；起点/终点应排在前面 */
  order?: number;
};

export type PinLabelOptions = {
  width: number;
  height: number;
  /** 图钉缩放 */
  pinScale: number;
  /** 标签间距等长度的缩放基准 */
  labelScale: number;
  /** 全部图钉锚点（自己的钉子会被自动排除） */
  pins?: {x: number; y: number}[];
  /** HUD、景点卡片等固定障碍 */
  rects?: LabelBox[];
  /** 已经画在地图上的路线（用来尽量不压线） */
  paths?: {x: number; y: number}[][];
  /** 画面安全边距 */
  margin?: number;
};

const MARKER_WIDTH = 38;
const MARKER_HEIGHT = 52;
const DEFAULT_GRID = 1;

// 打分权重：重叠必须绝对避免，其次是别压路线，最后才是贴得近不近。
const COLLISION_WEIGHT = 1e6;
const ROUTE_WEIGHT = 40;
const TIER_WEIGHT = 600;
const GAP_WEIGHT = 8;
const CLAMP_WEIGHT = 30;

export const pinPrefix = (entry: {dayIndex: number; role: string}) =>
  entry.role === '起' || entry.role === '终' ? `D${entry.dayIndex + 1}${entry.role}` : '';

// 同一天的首尾点、以及相邻两天共用的过夜点会落在同一个像素上：合并成一根针，
// 标签前缀拼成「D1终&D2起」，避免两根针和一个标签重复叠在同一处。
// 三天以上共用一个点（比如连着几天的驻地）只留首尾，避免标签过长。
export const groupPins = (entries: PinEntry[], grid = DEFAULT_GRID): PinGroup[] => {
  const order: string[] = [];
  const buckets = new Map<string, PinGroup>();
  entries.forEach((entry) => {
    const key = [
      Math.round(entry.x / grid),
      Math.round(entry.y / grid),
      String(entry.name || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase()
    ].join(':');
    let group = buckets.get(key);
    if (!group) {
      group = {survivor: entry.key, labelOwner: null, labelPrefixes: [], members: []};
      buckets.set(key, group);
      order.push(key);
    }
    group.members.push(entry.key);
    if (!entry.showLabel) return;
    if (!group.labelOwner) group.labelOwner = entry.key;
    const prefix = pinPrefix(entry);
    if (prefix && !group.labelPrefixes.includes(prefix)) group.labelPrefixes.push(prefix);
  });
  return order.map((key) => {
    const group = buckets.get(key)!;
    if (group.labelPrefixes.length > 2) {
      group.labelPrefixes = [group.labelPrefixes[0], group.labelPrefixes[group.labelPrefixes.length - 1]];
    }
    return group;
  });
};

export const pinRect = (x: number, y: number, scale: number): LabelBox => ({
  x: x - (MARKER_WIDTH * scale) / 2,
  y: y - MARKER_HEIGHT * scale,
  width: MARKER_WIDTH * scale,
  height: MARKER_HEIGHT * scale
});

// 标签要绕开别人的图钉（自己的钉子允许压在标签下），只取附近的钉子，避免大图时全量比对。
export const nearbyPinObstacles = (
  anchor: {x: number; y: number},
  pins: PinAnchor[],
  scale: number,
  radius: number
): LabelBox[] => {
  const rects: LabelBox[] = [];
  pins.forEach((pin) => {
    if (Math.hypot(pin.x - anchor.x, pin.y - anchor.y) > radius) return;
    rects.push(pinRect(pin.x, pin.y, scale));
  });
  return rects;
};

// 与 geo.ts 里画标签时使用的字号保持一致，保证算出来的框和真实文字对得上
export const labelFontSize = (scale: number) => 17 * scale;

export const measureLabel = (text: string, scale: number) => {
  const fontSize = labelFontSize(scale);
  const lines = String(text || '').split('\n');
  const width = Math.max(...lines.map((line) => {
    const measured = Array.from(line).reduce(
      (total, character) => total + (/[\u0000-\u00ff]/.test(character) ? fontSize * 0.58 : fontSize),
      0
    );
    return Math.ceil(measured + fontSize * 1.5);
  }));
  const lineCount = lines.length;
  return {
    width: Math.max(width, fontSize * 3.8),
    height: (33 + (lineCount - 1) * 21) * scale
  };
};

const overlapArea = (a: LabelBox, b: LabelBox) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

const boxGap = (a: LabelBox, b: LabelBox) => {
  const dx = Math.max(0, Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width)));
  const dy = Math.max(0, Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height)));
  return Math.hypot(dx, dy);
};

type Segment = {ax: number; ay: number; bx: number; by: number; minX: number; minY: number; maxX: number; maxY: number};

// Liang–Barsky：线段落在矩形内的长度，用来衡量“标签压住了多少路线”
const clippedLength = (segment: Segment, box: LabelBox) => {
  const dx = segment.bx - segment.ax;
  const dy = segment.by - segment.ay;
  let enter = 0;
  let exit = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [
    segment.ax - box.x,
    box.x + box.width - segment.ax,
    segment.ay - box.y,
    box.y + box.height - segment.ay
  ];
  for (let index = 0; index < 4; index += 1) {
    if (Math.abs(p[index]) < 1e-9) {
      if (q[index] < 0) return 0;
      continue;
    }
    const ratio = q[index] / p[index];
    if (p[index] < 0) {
      if (ratio > exit) return 0;
      if (ratio > enter) enter = ratio;
    } else {
      if (ratio < enter) return 0;
      if (ratio < exit) exit = ratio;
    }
  }
  return Math.hypot(dx, dy) * Math.max(0, exit - enter);
};

// 路线按网格分桶，查询一个框覆盖了多少路线时只看附近的桶。
const buildRouteCoverage = (paths: {x: number; y: number}[][], cell = 140) => {
  const segments: Segment[] = [];
  paths.forEach((path) => {
    for (let index = 1; index < path.length; index += 1) {
      const a = path[index - 1];
      const b = path[index];
      if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) continue;
      segments.push({
        ax: a.x,
        ay: a.y,
        bx: b.x,
        by: b.y,
        minX: Math.min(a.x, b.x),
        minY: Math.min(a.y, b.y),
        maxX: Math.max(a.x, b.x),
        maxY: Math.max(a.y, b.y)
      });
    }
  });
  const buckets = new Map<string, number[]>();
  segments.forEach((segment, index) => {
    const x0 = Math.floor(segment.minX / cell);
    const x1 = Math.floor(segment.maxX / cell);
    const y0 = Math.floor(segment.minY / cell);
    const y1 = Math.floor(segment.maxY / cell);
    for (let x = x0; x <= x1; x += 1) {
      for (let y = y0; y <= y1; y += 1) {
        const key = `${x}:${y}`;
        const bucket = buckets.get(key);
        if (bucket) bucket.push(index);
        else buckets.set(key, [index]);
      }
    }
  });
  const stamp = new Int32Array(segments.length);
  let query = 0;
  return (box: LabelBox) => {
    if (!segments.length) return 0;
    query += 1;
    let total = 0;
    const x0 = Math.floor(box.x / cell);
    const x1 = Math.floor((box.x + box.width) / cell);
    const y0 = Math.floor(box.y / cell);
    const y1 = Math.floor((box.y + box.height) / cell);
    for (let x = x0; x <= x1; x += 1) {
      for (let y = y0; y <= y1; y += 1) {
        const bucket = buckets.get(`${x}:${y}`);
        if (!bucket) continue;
        for (const index of bucket) {
          if (stamp[index] === query) continue;
          stamp[index] = query;
          const segment = segments[index];
          if (segment.maxX < box.x || segment.minX > box.x + box.width) continue;
          if (segment.maxY < box.y || segment.minY > box.y + box.height) continue;
          total += clippedLength(segment, box);
        }
      }
    }
    return total;
  };
};

// 图钉四周的八个贴边位置：右三、左三、正上、正下。
// 这些位置标签边沿离钉子只有几像素，起点终点用它就能稳稳“贴在点位旁边”。
const anchorSlots = (item: PinLabelItem, pinScale: number, scale: number) => {
  const pw = MARKER_WIDTH * pinScale;
  const ph = MARKER_HEIGHT * pinScale;
  const gapX = 5 * scale;
  const gapY = 3 * scale;
  const right = item.x + pw / 2 + gapX;
  const left = item.x - pw / 2 - gapX - item.width;
  const top = item.y - ph;
  const middle = item.y - ph / 2 - item.height / 2;
  const bottom = item.y - item.height;
  return [
    {x: right, y: top},
    {x: right, y: middle},
    {x: right, y: bottom},
    {x: left, y: top},
    {x: left, y: middle},
    {x: left, y: bottom},
    {x: item.x - item.width / 2, y: item.y - ph - gapY - item.height},
    {x: item.x - item.width / 2, y: item.y + gapY}
  ];
};

const ringSlots = (item: PinLabelItem, base: {x: number; y: number}[], radius: number) => base.map((slot) => {
  const cx = slot.x + item.width / 2;
  const cy = slot.y + item.height / 2;
  const dx = cx - item.x;
  const dy = cy - item.y;
  const length = Math.hypot(dx, dy) || 1;
  return {x: slot.x + (dx / length) * radius, y: slot.y + (dy / length) * radius};
});

// 兜底的螺旋搜索：在钉子四周按固定角度均匀撒点，保证再挤的市中心也能找到空位。
// 角度用固定步长（不是随机），同一次渲染里前后帧的结果完全一致，不会跳。
const spiralSlots = (item: PinLabelItem, radius: number, step: number) => {
  const slots: {x: number; y: number}[] = [];
  const count = Math.max(12, Math.round((Math.PI * 2 * radius) / step));
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2;
    slots.push({
      x: item.x + Math.cos(angle) * radius - item.width / 2,
      y: item.y + Math.sin(angle) * radius - item.height / 2
    });
  }
  return slots;
};

// 途径点允许“沿路线挪一挪”：道路横着走就把标签放在上下两侧并左右滑动，
// 道路竖着走就放在左右两侧并上下滑动，既贴着路线又不压线。
const slideSlots = (item: PinLabelItem, pinScale: number, scale: number, tangent: {x: number; y: number} | null) => {
  if (!tangent) return [];
  const pw = MARKER_WIDTH * pinScale;
  const ph = MARKER_HEIGHT * pinScale;
  const gapX = 5 * scale;
  const gapY = 3 * scale;
  const slots: {x: number; y: number}[] = [];
  if (Math.abs(tangent.x) >= Math.abs(tangent.y)) {
    const rows = [item.y - ph - gapY - item.height, item.y + gapY];
    const offsets = [-item.width * 0.62, -item.width * 0.3, 0, item.width * 0.3, item.width * 0.62];
    rows.forEach((rowY) => {
      offsets.forEach((offset) => slots.push({x: item.x + offset - item.width / 2, y: rowY}));
    });
  } else {
    const columns = [item.x + pw / 2 + gapX, item.x - pw / 2 - gapX - item.width];
    const offsets = [-item.height * 1.5, -item.height * 0.7, 0, item.height * 0.7, item.height * 1.5];
    columns.forEach((columnX) => {
      offsets.forEach((offset) => slots.push({x: columnX, y: item.y + offset - item.height / 2}));
    });
  }
  return slots;
};

// 途径点沿“横向平移”找位置：和钉子保持同一高度、往左右挪开，
// 比被挤到正上方一列更容易看出属于哪个点。
const rowSlots = (item: PinLabelItem, pinScale: number, scale: number) => {
  const pw = MARKER_WIDTH * pinScale;
  const gapX = 6 * scale;
  const stepX = Math.max(item.width * 0.6, 96 * scale);
  const rows = [
    {y: item.y - item.height / 2 - (MARKER_HEIGHT * pinScale) / 2, tier: 1.2},
    {y: item.y - item.height - 6 * scale, tier: 2.6}
  ];
  const slots: Candidate[] = [];
  rows.forEach((row) => {
    for (let step = 0; step < 3; step += 1) {
      const push = step * stepX;
      slots.push({x: item.x + pw / 2 + gapX + push, y: row.y, tier: row.tier + step * 0.6});
      slots.push({x: item.x - pw / 2 - gapX - item.width - push, y: row.y, tier: row.tier + step * 0.6});
    }
  });
  return slots;
};

const nearestTangent = (point: {x: number; y: number}, paths: {x: number; y: number}[][]) => {
  let bestX = 0;
  let bestY = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const path of paths) {
    for (let index = 1; index < path.length; index += 1) {
      const a = path[index - 1];
      const b = path[index];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.hypot(dx, dy);
      if (length < 1e-6) continue;
      const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (length * length)));
      const distance = Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
      if (distance < bestDistance) {
        bestDistance = distance;
        bestX = dx / length;
        bestY = dy / length;
      }
    }
  }
  return bestDistance <= 14 ? {x: bestX, y: bestY} : null;
};

type Candidate = {x: number; y: number; tier: number};

const buildCandidates = (
  item: PinLabelItem,
  pinScale: number,
  scale: number,
  tangent: {x: number; y: number} | null
): Candidate[] => {
  const anchored = anchorSlots(item, pinScale, scale);
  const list: Candidate[] = anchored.map((slot) => ({...slot, tier: 0}));
  if (item.kind === 'waypoint') {
    slideSlots(item, pinScale, scale, tangent).forEach((slot) => list.push({...slot, tier: 1}));
    rowSlots(item, pinScale, scale).forEach((slot) => list.push(slot));
    // 由近及远逐渐放宽：先抢紧贴路线的位置，实在没地方才往外让，且越远代价越高。
    [30, 50, 74, 102, 136, 176].forEach((radius, ring) => {
      ringSlots(item, anchored, radius).forEach((slot) => list.push({...slot, tier: 2 + ring * 0.5}));
    });
    [96, 130, 168, 210].forEach((radius, ring) => {
      spiralSlots(item, radius, 26).forEach((slot) => list.push({...slot, tier: 8 + ring}));
    });
  } else {
    [16, 28, 42, 58, 76].forEach((radius, ring) => {
      ringSlots(item, anchored, radius).forEach((slot) => list.push({...slot, tier: 6 + ring}));
    });
    [64, 86, 112].forEach((radius, ring) => {
      spiralSlots(item, radius, 22).forEach((slot) => list.push({...slot, tier: 14 + ring}));
    });
  }
  return list;
};

/**
 * 图钉标签布点。
 *
 * 规则：
 * 1. 起点/终点只允许贴在钉子四周（外加很小的退让），保证标签始终挨着真实点位；
 * 2. 途径点先贴近钉子，再沿路线滑动，最后才允许往外挪一点；
 * 3. 任何位置都要先避开别的标签、别的图钉和固定障碍，再尽量少压路线，最后才看离得多远。
 */
export const layoutPinLabels = (items: PinLabelItem[], options: PinLabelOptions): Map<string, LabelBox> => {
  const width = Math.max(1, Number(options.width) || 1);
  const height = Math.max(1, Number(options.height) || 1);
  const pinScale = Number(options.pinScale) > 0 ? Number(options.pinScale) : 1;
  const scale = Number(options.labelScale) > 0 ? Number(options.labelScale) : 1;
  const margin = Number.isFinite(options.margin as number) ? Number(options.margin) : 12;
  const pins = (options.pins || []).filter((pin) => Number.isFinite(pin.x) && Number.isFinite(pin.y));
  const rects = (options.rects || []).filter((rect) => rect && rect.width > 0 && rect.height > 0);
  const paths = (options.paths || []).filter((path) => Array.isArray(path) && path.length >= 2);
  const routeCovered = buildRouteCoverage(paths);

  const placed: LabelBox[] = [];
  const result = new Map<string, LabelBox>();
  const ordered = items
    .filter((item) => item && item.width > 0 && item.height > 0 && Number.isFinite(item.x) && Number.isFinite(item.y))
    .map((item, index) => ({item, index}))
    .sort((a, b) => (a.item.order ?? 0) - (b.item.order ?? 0) || a.index - b.index);

  ordered.forEach(({item}) => {
    const ownPin = pinRect(item.x, item.y, pinScale);
    const otherPins = pins
      .filter((pin, index) => index !== item.pinIndex)
      .map((pin) => pinRect(pin.x, pin.y, pinScale));
    const tangent = nearestTangent(item, paths);
    const candidates = buildCandidates(item, pinScale, scale, tangent);

    let best = {x: item.x + 20, y: item.y - item.height, score: Number.POSITIVE_INFINITY};
    let bestFree: {x: number; y: number; tier: number; score: number} | null = null;

    candidates.forEach((candidate) => {
      const overflowX = Math.max(0, margin - candidate.x)
        + Math.max(0, candidate.x + item.width - (width - margin));
      const overflowY = Math.max(0, margin - candidate.y)
        + Math.max(0, candidate.y + item.height - (height - margin));
      const box: LabelBox = {
        x: Math.min(Math.max(candidate.x, margin), Math.max(margin, width - margin - item.width)),
        y: Math.min(Math.max(candidate.y, margin), Math.max(margin, height - margin - item.height)),
        width: item.width,
        height: item.height
      };
      const clampShift = Math.abs(box.x - candidate.x) + Math.abs(box.y - candidate.y);
      let collision = 0;
      placed.forEach((previous) => { collision += overlapArea(box, previous); });
      otherPins.forEach((pin) => { collision += overlapArea(box, pin); });
      rects.forEach((rect) => { collision += overlapArea(box, rect); });
      const route = routeCovered({
        x: box.x - 4,
        y: box.y - 4,
        width: box.width + 8,
        height: box.height + 8
      });
      const gap = boxGap(box, ownPin);
      const score = collision * COLLISION_WEIGHT
        + route * ROUTE_WEIGHT
        + candidate.tier * TIER_WEIGHT
        + gap * GAP_WEIGHT
        + clampShift * CLAMP_WEIGHT
        + (overflowX + overflowY) * 2;
      if (score < best.score) best = {x: box.x, y: box.y, score};
      if (collision > 0.01) return;
      if (!bestFree || score < bestFree.score) {
        bestFree = {x: box.x, y: box.y, tier: candidate.tier, score};
      }
    });

    const chosen = bestFree || best;
    const finalBox: LabelBox = {x: chosen.x, y: chosen.y, width: item.width, height: item.height};
    placed.push(finalBox);
    result.set(String(item.key), finalBox);
  });

  return result;
};

/** 一个标签框压住了多长的路线（像素），用于校验“尽量不挡路”。 */
export const coveredRouteLength = (box: LabelBox, paths: {x: number; y: number}[][]) =>
  buildRouteCoverage((paths || []).filter((path) => Array.isArray(path) && path.length >= 2))(box);

/** 标签框与图钉之间的距离，贴边时为 0。 */
export const labelPinGap = (box: LabelBox, x: number, y: number, pinScale: number) =>
  boxGap(box, pinRect(x, y, pinScale));

/** 图钉到标签框的引线端点：取标签框上离钉子最近的那一点。 */
export const boxAttachPoint = (box: LabelBox, x: number, y: number) => ({
  x: Math.min(Math.max(x, box.x), box.x + box.width),
  y: Math.min(Math.max(y, box.y), box.y + box.height)
});

/** 引线在钉子一侧的起点：钉子外框上朝向标签的那一点，线不会穿过钉子本身。 */
export const pinAttachPoint = (box: LabelBox, x: number, y: number, pinScale: number) => {
  const rect = pinRect(x, y, pinScale);
  return {
    x: Math.min(Math.max(box.x + box.width / 2, rect.x), rect.x + rect.width),
    y: Math.min(Math.max(box.y + box.height / 2, rect.y), rect.y + rect.height)
  };
};

/**
 * 两个点位在屏幕上只差几个像素时（比如市中心的桥和公园），图钉会完全盖住彼此，
 * 让人以为少了一个点。这里把它们在同一位置附近轻轻推开，保证每根针都露出来；
 * 推开距离有上限，配上引线仍然看得出是同一个真实点位。
 */
export const spreadPins = (
  anchors: {x: number; y: number}[],
  minDistance = 26,
  maxShift = 26
) => {
  const result = anchors.map((anchor) => ({x: anchor.x, y: anchor.y}));
  for (let iteration = 0; iteration < 24; iteration += 1) {
    let moved = false;
    for (let i = 0; i < result.length; i += 1) {
      for (let j = i + 1; j < result.length; j += 1) {
        const dx = result[j].x - result[i].x;
        const dy = result[j].y - result[i].y;
        const distance = Math.hypot(dx, dy);
        if (distance >= minDistance) continue;
        const push = (minDistance - distance) / 2 + 0.01;
        const angle = ((i * 47 + j * 83) % 360) * (Math.PI / 180);
        const ux = distance < 0.001 ? Math.cos(angle) : dx / distance;
        const uy = distance < 0.001 ? Math.sin(angle) : dy / distance;
        result[i].x -= ux * push;
        result[i].y -= uy * push;
        result[j].x += ux * push;
        result[j].y += uy * push;
        moved = true;
      }
    }
    result.forEach((point, index) => {
      const dx = point.x - anchors[index].x;
      const dy = point.y - anchors[index].y;
      const distance = Math.hypot(dx, dy);
      if (distance <= maxShift) return;
      point.x = anchors[index].x + (dx / distance) * maxShift;
      point.y = anchors[index].y + (dy / distance) * maxShift;
    });
    if (!moved) break;
  }
  return result;
};
