(function() {
  const MAX_GAP_METERS = 600;
  const HIGHWAY_SPEED_KMH = {
    motorway: 110,
    motorway_link: 80,
    trunk: 80,
    trunk_link: 60,
    primary: 70,
    primary_link: 50,
    secondary: 60,
    secondary_link: 45,
    tertiary: 45,
    tertiary_link: 35,
    unclassified: 30,
    residential: 25,
    living_street: 15,
    service: 20,
    track: 15,
    road: 30
  };
  function isRoadName(text) {
    const value = String(text || "").trim();
    if (/^[GS]\d{1,4}$/i.test(value)) return true;
    return /公路|国道|省道|高速/.test(value);
  }
  function haversine(a, b) {
    const R = 6371e3;
    const dLat = (b[0] - a[0]) * Math.PI / 180;
    const dLng = (b[1] - a[1]) * Math.PI / 180;
    const la1 = a[0] * Math.PI / 180;
    const la2 = b[0] * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function outOfChina(lat, lng) {
    return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
  }
  function transformLat(x, y) {
    let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
    ret += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
    ret += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
    return ret;
  }
  function transformLng(x, y) {
    let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
    ret += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
    ret += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
    return ret;
  }
  function wgs84ToGcj02(lat, lng) {
    if (outOfChina(lat, lng)) return [lat, lng];
    const a = 6378245;
    const ee = 0.006693421622965943;
    let dLat = transformLat(lng - 105, lat - 35);
    let dLng = transformLng(lng - 105, lat - 35);
    const radLat = lat / 180 * Math.PI;
    let magic = Math.sin(radLat);
    magic = 1 - ee * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    dLat = dLat * 180 / (a * (1 - ee) / (magic * sqrtMagic) * Math.PI);
    dLng = dLng * 180 / (a / sqrtMagic * Math.cos(radLat) * Math.PI);
    return [lat + dLat, lng + dLng];
  }
  function gcj02ToWgs84(lat, lng) {
    if (outOfChina(lat, lng)) return [lat, lng];
    const [mLat, mLng] = wgs84ToGcj02(lat, lng);
    return [lat * 2 - mLat, lng * 2 - mLng];
  }
  function parseMaxspeed(value) {
    const text = String(value || "").trim().toLowerCase();
    const match = text.match(/(\d+(?:\.\d+)?)/);
    if (!match) return null;
    const speed = Number(match[1]);
    if (!Number.isFinite(speed) || speed <= 0 || speed > 130) return null;
    if (text.includes("mph")) return Math.round(speed * 1.609);
    return Math.round(speed);
  }
  function speedForWay(tags, mode) {
    const normalized = mode === "ride" ? "ride" : mode === "walk" ? "walk" : "drive";
    if (normalized === "walk") return 5;
    if (normalized === "ride") return 15;
    const tagsObj = tags || {};
    const explicit = parseMaxspeed(tagsObj.maxspeed);
    if (explicit) return explicit;
    const highway = String(tagsObj.highway || "").toLowerCase();
    if (HIGHWAY_SPEED_KMH[highway]) return HIGHWAY_SPEED_KMH[highway];
    return 40;
  }
  function osrmProfile(mode) {
    if (mode === "ride") return "cycling";
    if (mode === "walk") return "walking";
    return "driving";
  }
  async function fetchRoadGeometry(ref, bbox) {
    const params = new URLSearchParams({ ref, ...bbox });
    const response = await fetch(`/api/v1/roads/geometry?${params.toString()}`);
    if (!response.ok) {
      let message = `\u516C\u8DEF\u6570\u636E\u8BF7\u6C42\u5931\u8D25 (${response.status})`;
      try {
        const body2 = await response.json();
        if (body2 && body2.message) message = body2.message;
      } catch (_) {
      }
      throw new Error(message);
    }
    const body = await response.json();
    if (!body || !body.ok || !Array.isArray(body.ways) || !body.ways.length) {
      throw new Error(body && body.message ? body.message : "\u672A\u627E\u5230\u516C\u8DEF\u6570\u636E");
    }
    return body;
  }
  function buildRoadChain(ways, mode = "drive") {
    const segments = (Array.isArray(ways) ? ways : []).filter((w) => w && Array.isArray(w.geometry) && w.geometry.length >= 2).map((w) => ({ id: w.id, pts: w.geometry.map((g) => ({ lat: Number(g[0]), lng: Number(g[1]) })), speed: speedForWay(w.tags, mode) }));
    if (!segments.length) return [];
    function extendFrom(seedIndex, reversed) {
      const used = new Set([segments[seedIndex].id]);
      const chain = [{ id: segments[seedIndex].id, pts: reversed ? segments[seedIndex].pts.slice().reverse() : segments[seedIndex].pts, speed: segments[seedIndex].speed }];
      let guard = 0;
      while (used.size < segments.length && guard < 2e4) {
        guard += 1;
        const tail = chain[chain.length - 1].pts[chain[chain.length - 1].pts.length - 1];
        let best2 = null;
        let bestDist = MAX_GAP_METERS;
        let bestReversed = false;
        for (const s of segments) {
          if (used.has(s.id)) continue;
          const dHead = haversine([tail.lat, tail.lng], [s.pts[0].lat, s.pts[0].lng]);
          const dEnd = haversine([tail.lat, tail.lng], [s.pts[s.pts.length - 1].lat, s.pts[s.pts.length - 1].lng]);
          if (dHead < bestDist) {
            bestDist = dHead;
            best2 = s;
            bestReversed = false;
          }
          if (dEnd < bestDist) {
            bestDist = dEnd;
            best2 = s;
            bestReversed = true;
          }
        }
        if (!best2) break;
        used.add(best2.id);
        chain.push({ id: best2.id, pts: bestReversed ? best2.pts.slice().reverse() : best2.pts, speed: best2.speed });
      }
      const all = [];
      for (const s of chain) {
        if (all.length && s.pts.length) {
          const last = all[all.length - 1];
          let start = 0;
          while (start < s.pts.length && haversine([last.lat, last.lng], [s.pts[start].lat, s.pts[start].lng]) < 80) start += 1;
          if (start < s.pts.length) all.push(...s.pts.slice(start));
        } else {
          all.push(...s.pts);
        }
      }
      return all;
    }
    let best = [];
    let bestScore = -1;
    for (let i = 0; i < segments.length; i += 1) {
      for (const reversed of [false, true]) {
        const all = extendFrom(i, reversed);
        if (all.length < 2) continue;
        let minLat = 90, maxLat = -90;
        for (const p of all) {
          minLat = Math.min(minLat, p.lat);
          maxLat = Math.max(maxLat, p.lat);
        }
        const score = maxLat - minLat;
        if (score > bestScore) {
          bestScore = score;
          best = all;
        }
      }
    }
    return best;
  }
  function cropRoadChain(chain, from, to, mode) {
    if (chain.length < 2) return { path: [], distance: 0, duration: 0 };
    const fallbackSpeed = mode === "walk" ? 5 : mode === "ride" ? 15 : 45;
    const fromPt = [Number(from.lat), Number(from.lng)];
    const toPt = [Number(to.lat), Number(to.lng)];
    let a = 0;
    let aDist = Infinity;
    let b = 0;
    let bDist = Infinity;
    for (let i = 0; i < chain.length; i += 1) {
      const dFrom = haversine(fromPt, [chain[i].lat, chain[i].lng]);
      const dTo = haversine(toPt, [chain[i].lat, chain[i].lng]);
      if (dFrom < aDist) {
        aDist = dFrom;
        a = i;
      }
      if (dTo < bDist) {
        bDist = dTo;
        b = i;
      }
    }
    let start = a;
    let end = b;
    let reversed = false;
    if (b < a) {
      start = b;
      end = a;
      reversed = true;
    }
    let path = chain.slice(start, end + 1);
    if (reversed) path = path.slice().reverse();
    if (path.length < 2) return { path: [], distance: 0, duration: 0 };
    let distance = 0;
    let duration = 0;
    for (let i = 0; i < path.length - 1; i += 1) {
      const leg = haversine([path[i].lat, path[i].lng], [path[i + 1].lat, path[i + 1].lng]);
      distance += leg;
      const speed = path[i].speed && path[i].speed > 0 ? path[i].speed : fallbackSpeed;
      duration += leg / 1e3 / speed * 3600;
    }
    return { path, distance: Math.round(distance), duration: Math.round(duration) };
  }
  function toGcjPath({ path, distance, duration }) {
    const converted = path.map((point) => {
      const [lat, lng] = wgs84ToGcj02(point.lat, point.lng);
      return [Number(lng.toFixed(6)), Number(lat.toFixed(6))];
    });
    return { path: converted, distance, duration };
  }
  async function resolveRoadRoute(ref, from, to, mode = "drive") {
    const pad = 0.7;
    const bbox = {
      south: (Math.min(from.lat, to.lat) - pad).toFixed(4),
      west: (Math.min(from.lng, to.lng) - pad).toFixed(4),
      north: (Math.max(from.lat, to.lat) + pad).toFixed(4),
      east: (Math.max(from.lng, to.lng) + pad).toFixed(4)
    };
    const data = await fetchRoadGeometry(ref, bbox);
    const chain = buildRoadChain(data.ways, mode);
    if (chain.length < 2) throw new Error(`${ref} \u5728\u8D77\u70B9\u4E0E\u7EC8\u70B9\u4E4B\u95F4\u6CA1\u6709\u53EF\u7528\u8DEF\u6BB5`);
    const [fromLat, fromLng] = gcj02ToWgs84(Number(from.lat), Number(from.lng));
    const [toLat, toLng] = gcj02ToWgs84(Number(to.lat), Number(to.lng));
    const cropped = cropRoadChain(chain, { lat: fromLat, lng: fromLng }, { lat: toLat, lng: toLng }, mode);
    if (cropped.path.length < 2) throw new Error(`${ref} \u5728\u8D77\u70B9\u4E0E\u7EC8\u70B9\u4E4B\u95F4\u6CA1\u6709\u53EF\u7528\u8DEF\u6BB5`);
    return { name: data.name || ref, ref: data.ref || ref, ...toGcjPath(cropped) };
  }
  async function autoPlanRoute(from, to, mode = "drive") {
    const routes = await autoPlanRoutes(from, to, mode);
    return routes[0] || null;
  }
  async function autoPlanRoutes(from, to, mode = "drive") {
    const [fromLat, fromLng] = gcj02ToWgs84(Number(from.lat), Number(from.lng));
    const [toLat, toLng] = gcj02ToWgs84(Number(to.lat), Number(to.lng));
    const url = `/api/v1/roads/osrm?fromLng=${fromLng.toFixed(6)}&fromLat=${fromLat.toFixed(6)}&toLng=${toLng.toFixed(6)}&toLat=${toLat.toFixed(6)}&profile=${osrmProfile(mode)}&alternatives=true`;
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) {
      let message = `\u81EA\u52A8\u89C4\u5212\u5931\u8D25 (${response.status})`;
      try {
        const body2 = await response.json();
        if (body2 && body2.message) message = body2.message;
      } catch (_) {
      }
      throw new Error(message);
    }
    const body = await response.json();
    const raw = body && body.ok && Array.isArray(body.alternatives) ? body.alternatives : [];
    const routes = raw.filter((item) => item && Array.isArray(item.coordinates) && item.coordinates.length >= 2).map((item) => ({
      name: "\u81EA\u52A8\u89C4\u5212",
      ref: "auto",
      path: item.coordinates.map((point) => {
        const [lat, lng] = wgs84ToGcj02(Number(point[1]), Number(point[0]));
        return [Number(lng.toFixed(6)), Number(lat.toFixed(6))];
      }),
      distance: Number(item.distance) || 0,
      duration: Number(item.duration) || 0
    }));
    if (!routes.length) throw new Error(body && body.message ? body.message : "\u81EA\u52A8\u89C4\u5212\u672A\u8FD4\u56DE\u53EF\u7528\u8DEF\u7EBF");
    return routes;
  }
  function pointToSegmentDistance(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = 0;
    if (len2 > 0) t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    return Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
  }
  function overlapRatio(pathA, pathB) {
    if (!Array.isArray(pathA) || !Array.isArray(pathB) || pathA.length < 2 || pathB.length < 2) return 0;
    const segsB = [];
    for (let index = 1; index < pathB.length; index += 1) {
      segsB.push([pathB[index - 1], pathB[index]]);
    }
    const threshold = 0.003;
    const step = Math.max(1, Math.floor(pathA.length / 40));
    let near = 0;
    let total = 0;
    for (let index = 0; index < pathA.length; index += step) {
      total += 1;
      const [lng, lat] = pathA[index];
      let minDist = Infinity;
      for (const [a, b] of segsB) {
        const d = pointToSegmentDistance(lng, lat, a[0], a[1], b[0], b[1]);
        if (d < minDist) minDist = d;
        if (minDist < threshold) break;
      }
      if (minDist < threshold) near += 1;
    }
    return total ? near / total : 0;
  }
  window.RoadProvider = {
    isRoadName,
    resolveRoadRoute,
    autoPlanRoutes,
    overlapRatio,
    wgs84ToGcj02,
    gcj02ToWgs84
  };
})();
