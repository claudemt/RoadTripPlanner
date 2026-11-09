(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LabelLayout = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const BASE_OFFSET = {x: 15, y: -56};
  const DEFAULT_GAP = 8;
  const DEFAULT_ROUTE_CLEARANCE = 16;
  const DEFAULT_MAX_RINGS = 3;
  const DIRECTION_ORDER = [
    [0, -1], [1, -1], [1, 0], [1, 1],
    [0, 1], [-1, 1], [-1, 0], [-1, -1]
  ];

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const overlapArea = (a, b) => {
    const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
    const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
    return width * height;
  };
  const clampBox = (box, width, height) => ({
    ...box,
    x: clamp(box.x, 0, Math.max(0, width - box.width)),
    y: clamp(box.y, 0, Math.max(0, height - box.height))
  });
  const distanceToSegment = (box, a, b) => {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((cx - a.x) * dx + (cy - a.y) * dy) / len2));
    return Math.hypot(cx - (a.x + t * dx), cy - (a.y + t * dy));
  };
  const hasVisibleOffset = (offset) => Math.abs(Number(offset && offset.x ? offset.x : 0)) > 1e-4
    || Math.abs(Number(offset && offset.y ? offset.y : 0)) > 1e-4;

  const buildCandidates = (primary, gap, avoidRects, maxRings) => {
    const candidates = [primary];
    for (let ring = 1; ring <= maxRings; ring += 1) {
      DIRECTION_ORDER.forEach(([x, y]) => {
        candidates.push({
          ...primary,
          x: primary.x + x * ring * (primary.width + gap),
          y: primary.y + y * ring * (primary.height + gap)
        });
      });
    }
    avoidRects.forEach((rect) => {
      candidates.push(
        {...primary, x: rect.x - primary.width - gap},
        {...primary, x: rect.x + rect.width + gap},
        {...primary, y: rect.y - primary.height - gap},
        {...primary, y: rect.y + rect.height + gap}
      );
    });
    return candidates;
  };

  const layoutLabels = (options) => {
    const width = Math.max(1, Number(options && options.width) || 1);
    const height = Math.max(1, Number(options && options.height) || 1);
    const scale = Number(options && options.scale) > 0 ? Number(options.scale) : 1;
    const baseOffset = options && options.baseOffset ? options.baseOffset : BASE_OFFSET;
    const gap = (Number.isFinite(options && options.gap) ? Number(options.gap) : DEFAULT_GAP) * scale;
    const routeClearance = (Number.isFinite(options && options.routeClearance) ? Number(options.routeClearance) : DEFAULT_ROUTE_CLEARANCE) * scale;
    const maxRings = Number.isFinite(options && options.maxRings) ? Number(options.maxRings) : DEFAULT_MAX_RINGS;
    const lockPositions = Boolean(options && options.lockPositions);
    const obstacles = (options && options.obstacles) || [];
    const paths = (options && options.paths) || [];
    const items = (options && options.items) || [];

    const routePaths = paths
      .filter((path) => Array.isArray(path) && path.length >= 2)
      .map((path) => path.map(({x, y}) => ({x, y})));

    const measured = items.map((item, index) => {
      const userOffset = item.userOffset || {x: 0, y: 0};
      const primary = {
        x: Number(item.x) + Number(baseOffset.x) * scale + Number(userOffset.x || 0) * width,
        y: Number(item.y) + Number(baseOffset.y) * scale + Number(userOffset.y || 0) * height,
        width: Math.max(1, Number(item.width) || 1),
        height: Math.max(1, Number(item.height) || 1)
      };
      const ownRects = Array.isArray(item.avoidRects) ? item.avoidRects : [];
      const ownObstacles = Array.isArray(item.obstacles) ? item.obstacles : obstacles;
      const manualOffset = hasVisibleOffset(userOffset);
      const locked = Boolean(item.locked) || (!ownRects.length && (manualOffset || lockPositions));
      return {
        item,
        index,
        primary,
        manualOffset,
        locked,
        avoidRects: ownRects.length ? ownObstacles.concat(ownRects) : ownObstacles
      };
    });

    const placed = [];
    const result = new Map();
    const collides = (box, avoidRects) => placed.some((previous) => overlapArea(box, previous) > 0.01)
      || avoidRects.some((rect) => overlapArea(box, rect) > 0.01);

    const ordered = measured.filter((entry) => entry.locked).concat(measured.filter((entry) => !entry.locked));
    ordered.forEach(({item, index, primary, locked, manualOffset, avoidRects}) => {
      const key = String(item.key);
      if (locked) {
        const fixed = clampBox(primary, width, height);
        placed.push(fixed);
        result.set(key, {
          ...fixed,
          shiftX: fixed.x - primary.x,
          shiftY: fixed.y - primary.y,
          locked: true
        });
        return;
      }
      const clampedPrimary = clampBox(primary, width, height);
      if (manualOffset && !collides(clampedPrimary, avoidRects)) {
        placed.push(clampedPrimary);
        result.set(key, {
          ...clampedPrimary,
          shiftX: clampedPrimary.x - primary.x,
          shiftY: clampedPrimary.y - primary.y,
          locked: false
        });
        return;
      }
      const candidates = buildCandidates(primary, gap, avoidRects, maxRings);
      let best = primary;
      let bestScore = Number.POSITIVE_INFINITY;
      candidates.forEach((candidate, candidateIndex) => {
        const overlap = placed.reduce((total, previous) => total + overlapArea(candidate, previous), 0);
        const avoided = avoidRects.reduce((total, rect) => total + overlapArea(candidate, rect), 0);
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
        const score = overlap * 120 + avoided * 240 + outside * 240 + routePenalty + distance * 0.3 + candidateIndex * 0.002;
        if (score < bestScore) {
          best = candidate;
          bestScore = score;
        }
      });
      let finalBox = clampBox(best, width, height);
      let guard = 0;
      while (collides(finalBox, avoidRects) && guard < 8) {
        const right = {x: finalBox.x + finalBox.width + gap, y: finalBox.y, width: finalBox.width, height: finalBox.height};
        if (right.x + right.width <= width && !collides(right, avoidRects)) {
          finalBox = right;
          break;
        }
        const left = {x: finalBox.x - finalBox.width - gap, y: finalBox.y, width: finalBox.width, height: finalBox.height};
        if (left.x >= 0 && !collides(left, avoidRects)) {
          finalBox = left;
          break;
        }
        const down = {x: finalBox.x, y: Math.min(height - finalBox.height, finalBox.y + finalBox.height + gap), width: finalBox.width, height: finalBox.height};
        if (down.y !== finalBox.y && !collides(down, avoidRects)) {
          finalBox = down;
          break;
        }
        const up = {x: finalBox.x, y: Math.max(0, finalBox.y - finalBox.height - gap), width: finalBox.width, height: finalBox.height};
        if (up.y !== finalBox.y && !collides(up, avoidRects)) {
          finalBox = up;
          break;
        }
        finalBox = {x: finalBox.x + finalBox.width + gap, y: finalBox.y, width: finalBox.width, height: finalBox.height};
        guard += 1;
      }
      placed.push(finalBox);
      result.set(key, {
        ...finalBox,
        shiftX: finalBox.x - primary.x,
        shiftY: finalBox.y - primary.y,
        locked: false
      });
    });
    return result;
  };

  return {layoutLabels};
});
