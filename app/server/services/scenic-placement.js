'use strict';

const pointKey = (dayIndex, pointIndex) => `${dayIndex}-${pointIndex}`;

const buildScenicPlacementPlan = (days, placements) => {
  const list = Array.isArray(days) ? days : [];

  const counts = new Map();
  const available = new Map();
  list.forEach((day, dayIndex) => {
    (day?.points || []).forEach((point, pointIndex) => {
      if (!point?.scenic || !point?.name) return;
      counts.set(point.name, (counts.get(point.name) || 0) + 1);
      if (!available.has(point.name)) available.set(point.name, new Set());
      available.get(point.name).add(pointKey(dayIndex, pointIndex));
    });
  });

  const chosen = new Map();
  const hidden = new Set();
  (Array.isArray(placements) ? placements : []).forEach((placement) => {
    const name = String(placement?.name || '').trim();
    if (!name) return;
    const dayIndex = Number(placement.dayIndex);
    const pointIndex = Number(placement.pointIndex);
    if (Number.isInteger(dayIndex) && Number.isInteger(pointIndex) && dayIndex >= 0 && pointIndex >= 0) {
      if (!chosen.has(name)) chosen.set(name, new Set());
      chosen.get(name).add(pointKey(dayIndex, pointIndex));
    } else {
      hidden.add(name);
    }
  });

  const pinned = new Map();
  chosen.forEach((keys, name) => {
    const known = available.get(name);
    if (!known) return;
    const valid = new Set();
    keys.forEach((key) => {
      if (known.has(key)) valid.add(key);
    });
    if (valid.size) pinned.set(name, valid);
  });
  pinned.forEach((_, name) => hidden.delete(name));

  const deferred = new Set();
  const deferredTargets = new Set();
  for (let index = 0; index < list.length - 1; index += 1) {
    const points = list[index]?.points || [];
    const nextPoints = list[index + 1]?.points || [];
    const last = points[points.length - 1];
    const first = nextPoints[0];
    const name = last?.name;
    if (!last?.scenic || !first?.scenic || !name || name !== first.name) continue;
    if ((counts.get(name) || 0) < 2 || deferred.has(name)) continue;
    if (pinned.has(name) || hidden.has(name)) continue;
    deferred.add(name);
    deferredTargets.add(pointKey(index + 1, 0));
  }

  const allows = (dayIndex, pointIndex, name) => {
    if (pinned.has(name)) return pinned.get(name).has(pointKey(dayIndex, pointIndex));
    if (hidden.has(name)) return false;
    return deferredTargets.has(pointKey(dayIndex, pointIndex)) || !deferred.has(name);
  };

  return {allows};
};

module.exports = {buildScenicPlacementPlan};
