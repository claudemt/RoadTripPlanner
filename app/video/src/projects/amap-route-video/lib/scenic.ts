import {RouteVideoData, ScenicInfo, VideoDay} from '../types';

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export type RevealedScenic = {spot: ScenicInfo; local: number; key: string};

export const scenicDedup = (data: RouteVideoData): {suppress: Set<string>; showAtStart: Set<string>} => {
  const keysByName = new Map<string, Set<string>>();
  data.days.forEach((day, dayIndex) => day.points.forEach((point, pointIndex) => {
    if (!point.scenic || !point.name) return;
    if (!keysByName.has(point.name)) keysByName.set(point.name, new Set());
    keysByName.get(point.name)?.add(`${dayIndex}-${pointIndex}`);
  }));

  const suppress = new Set<string>();
  const showAtStart = new Set<string>();

  const chosen = new Map<string, Set<string>>();
  const hidden = new Set<string>();
  (data.scenicPlacements || []).forEach((placement) => {
    const name = String(placement?.name || '').trim();
    if (!name) return;
    const dayIndex = Number(placement.dayIndex);
    const pointIndex = Number(placement.pointIndex);
    if (Number.isInteger(dayIndex) && Number.isInteger(pointIndex) && dayIndex >= 0 && pointIndex >= 0) {
      if (!chosen.has(name)) chosen.set(name, new Set());
      chosen.get(name)?.add(`${dayIndex}-${pointIndex}`);
    } else {
      hidden.add(name);
    }
  });

  const pinned = new Map<string, Set<string>>();
  chosen.forEach((keys, name) => {
    const known = keysByName.get(name);
    if (!known) return;
    const valid = new Set<string>();
    keys.forEach((key) => {
      if (known.has(key)) valid.add(key);
    });
    if (valid.size) pinned.set(name, valid);
  });
  pinned.forEach((_, name) => hidden.delete(name));
  pinned.forEach((_, name) => suppress.add(name));
  hidden.forEach((name) => {
    if (keysByName.has(name)) suppress.add(name);
  });

  for (let i = 0; i < data.days.length - 1; i++) {
    const toPoint = data.days[i].points[data.days[i].points.length - 1];
    const fromPoint = data.days[i + 1].points[0];
    const name = toPoint?.name;
    if (!name || !toPoint?.scenic || !fromPoint?.scenic || fromPoint.name !== name) continue;
    if ((keysByName.get(name)?.size || 0) < 2 || suppress.has(name)) continue;
    suppress.add(name);
    showAtStart.add(`${i + 1}-0-${name}`);
  }
  return {suppress, showAtStart};
};

export const scenicStartKeys = (data: RouteVideoData): Set<string> => {
  const keys = new Set<string>();
  (data.scenicPlacements || []).forEach((placement) => {
    const name = String(placement?.name || '').trim();
    const dayIndex = Number(placement?.dayIndex);
    const pointIndex = Number(placement?.pointIndex);
    if (!name || !Number.isInteger(dayIndex) || !Number.isInteger(pointIndex) || dayIndex < 0 || pointIndex < 0) return;
    const point = data.days[dayIndex]?.points?.[pointIndex];
    if (!point?.scenic || point.name !== name) return;
    keys.add(`${dayIndex}-${pointIndex}-${name}`);
  });
  return keys;
};

export const scenicVisible = (data: RouteVideoData, dayIndex: number, pointIndex: number, name: string): boolean => {
  const {suppress, showAtStart} = scenicDedup(data);
  const startKeys = scenicStartKeys(data);
  const key = `${dayIndex}-${pointIndex}-${name}`;
  return !suppress.has(name) || showAtStart.has(key) || startKeys.has(key);
};

export const activeScenics = (day: VideoDay, dayIndex: number, progress: number, thresholds: number[], suppress: Set<string>, showAtStart: Set<string>, startKeys: Set<string>): RevealedScenic[] => {
  const revealed: RevealedScenic[] = [];
  for (let index = 0; index < day.points.length; index++) {
    const point = day.points[index];
    if (!point.scenic) continue;
    const key = `${dayIndex}-${index}-${point.name}`;
    const atShowStart = showAtStart.has(key) || startKeys.has(key);
    if (suppress.has(point.name) && !atShowStart) continue;
    const t = thresholds[index] ?? 0;
    const isLastPoint = index === day.points.length - 1;
    const revealAt = isLastPoint ? Math.max(0, t - 0.08) : t;
    if (progress < revealAt) continue;
    const local = clamp((progress - revealAt) / 0.08, 0, 1);
    revealed.push({spot: point.scenic, local, key: `${index}-${point.name}`});
  }
  return revealed.slice(-4);
};
