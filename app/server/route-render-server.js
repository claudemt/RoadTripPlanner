const {parseVideoByteRange} = require('./services/video-byte-range');
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { createCommunityService } = require("./community-service");
const { createRuntimeConfig } = require("./config/runtime-config");
const { validateRouteData, assertMapLayer, hasPointCoordinates } = require("./validation/route-validation");
const { createPointInfoService } = require("./services/point-info-service");
const { createHillshadeService } = require("./services/hillshade-service");
const { lngLatToTilePixel, wgs84ToGcj02 } = require("./geo/coordinate-transform");
const { createMapEnhancementRoutes } = require("./routes/map-enhancement-routes");
const { createMapBackgroundPlan, assertMapBackgroundSize, canReuseMapBackground } = require("./services/map-background-plan");
const weatherCodeMap = require("../shared/weather-codes.json");
let createSupabaseClient = null;
try {
  ({ createClient: createSupabaseClient } = require("@supabase/supabase-js"));
} catch (_) {
}
let ensureRemotionBrowser = null;
try {
  ({ ensureBrowser: ensureRemotionBrowser } = require("@remotion/renderer"));
} catch (_) {
}
let sharpLib = null;
try {
  sharpLib = require("sharp");
} catch (_) {
}
const runtimeConfig = createRuntimeConfig(path.dirname(__dirname));
const {
  amapRoot: AMAP_ROOT,
  dataRoot: DATA_ROOT,
  configRoot: CONFIG_ROOT,
  remotionRoot: REMOTION_ROOT,
  remotionData: REMOTION_DATA,
  routeRoot: ROUTE_ROOT,
  publicRoot: PUBLIC_ROOT,
  port: PORT,
  host: HOST,
  userEmailHeader: USER_EMAIL_HEADER,
  requireUserEmail: REQUIRE_USER_EMAIL,
  fallbackUserEmail: FALLBACK_USER_EMAIL,
  adminEmailsRaw: ADMIN_EMAILS_RAW,
  supabaseUrl: SUPABASE_URL,
  supabaseServiceRoleKey: SUPABASE_SERVICE_ROLE_KEY,
  requireSupabase: REQUIRE_SUPABASE,
  sceneImageBucket: SCENE_IMAGE_BUCKET,
  privateSceneImageBucket: PRIVATE_SCENE_IMAGE_BUCKET,
  privateRouteAssetBucket: PRIVATE_ROUTE_ASSET_BUCKET,
  publicRouteAssetBucket: PUBLIC_ROUTE_ASSET_BUCKET,
  communityAssetBucket: COMMUNITY_ASSET_BUCKET,
  supabaseTables: SUPABASE_TABLES,
  userEmailHeaderCandidates: USER_EMAIL_HEADER_CANDIDATES,
  maxBody: MAX_BODY,
  remotionConcurrency: REMOTION_CONCURRENCY,
  remotionCrf: REMOTION_CRF,
  remotionWidth: REMOTION_WIDTH,
  remotionHeight: REMOTION_HEIGHT,
  overviewLongEdge: OVERVIEW_LONG_EDGE,
  overviewScale: OVERVIEW_SCALE,
  remotionFps: REMOTION_FPS,
  routeAssetSignedUrlSeconds: ROUTE_ASSET_SIGNED_URL_SECONDS,
  keyCandidates: KEY_CANDIDATES,
  nodeModuleRoots: NODE_MODULE_ROOTS,
  hillshade: HILLSHADE_CONFIG,
  pointInfo: POINT_INFO_CONFIG
} = runtimeConfig;
const pointInfoService = createPointInfoService({
  dataRoot: DATA_ROOT,
  weatherProvider: POINT_INFO_CONFIG.weatherProvider,
  elevationProvider: POINT_INFO_CONFIG.elevationProvider,
  weatherTtlMinutes: POINT_INFO_CONFIG.weatherTtlMinutes
});
const hillshadeService = createHillshadeService({ dataRoot: DATA_ROOT, ...HILLSHADE_CONFIG });
const firstHeaderValue = (value) => {
  if (Array.isArray(value)) return value[0] || "";
  return String(value || "").split(",")[0].trim();
};
const normalizeEmail = (value) => {
  const text = firstHeaderValue(value).replace(/^"|"$/g, "").trim();
  const angleMatch = text.match(/<([^<>]+@[^<>]+)>/);
  const candidate = (angleMatch?.[1] || text).trim().toLowerCase();
  if (!candidate || candidate.length > 254 || /[\r\n]/.test(candidate)) return "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : "";
};
const ADMIN_EMAILS = ADMIN_EMAILS_RAW.split(",").map((item) => normalizeEmail(item)).filter(Boolean);
const isAdminIdentity = (identity) => Boolean(identity?.email && ADMIN_EMAILS.includes(identity.email));
const assertAdminIdentity = (identity) => {
  if (isAdminIdentity(identity)) return;
  const error = new Error("\u53EA\u6709\u7BA1\u7406\u5458\u53EF\u4EE5\u6267\u884C\u8FD9\u4E2A\u64CD\u4F5C\u3002");
  error.status = 403;
  throw error;
};
const getRequestIdentity = (req) => {
  for (const headerName of USER_EMAIL_HEADER_CANDIDATES) {
    const email = normalizeEmail(req.headers[headerName]);
    if (email) return { email, id: email, source: headerName };
  }
  if (!REQUIRE_USER_EMAIL) {
    const email = normalizeEmail(FALLBACK_USER_EMAIL);
    if (email) return { email, id: email, source: "fallback-env" };
  }
  return { email: "", id: "", source: "" };
};
const userRouteSegment = (email) => String(email || "_anonymous").normalize("NFKC").toLowerCase().replace(/[^a-z0-9@._+-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120) || "_anonymous";
const getUserRouteRoot = (identity) => path.join(ROUTE_ROOT, "users", userRouteSegment(identity?.email));
const resolveNodeModuleFile = (...parts) => {
  const found = NODE_MODULE_ROOTS.map((root) => path.join(root, ...parts)).find((candidate) => fs.existsSync(candidate));
  return found || path.join(NODE_MODULE_ROOTS[0], ...parts);
};
let rendering = false;
let activeExport = null;
const latestExportsByOwner = new Map();
const publishedRouteJobs = [];
let exportProgress = {
  active: false,
  done: false,
  error: null,
  phase: "idle",
  message: "",
  percent: 0,
  frames: 0,
  totalFrames: 0,
  etaSeconds: null,
  startedAt: null,
  updatedAt: null
};
const writeFileAtomic = (target, text) => {
  ensureDir(path.dirname(target));
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, text, "utf8");
  fs.renameSync(temp, target);
};
const normalizeAssetPath = (value) => String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
const isPathInside = (root, target) => {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
};
const toPublicAssetPath = (value) => {
  const absolute = path.resolve(value);
  if (isPathInside(ROUTE_ROOT, absolute)) {
    return `route/${path.relative(ROUTE_ROOT, absolute).replace(/\\/g, "/")}`;
  }
  if (isPathInside(PUBLIC_ROOT, absolute)) {
    return path.relative(PUBLIC_ROOT, absolute).replace(/\\/g, "/");
  }
  return path.relative(AMAP_ROOT, absolute).replace(/\\/g, "/");
};
const resolvePublicAssetFile = (value) => {
  const relative = normalizeAssetPath(value);
  if (relative === "route" || relative.startsWith("route/")) {
    return path.resolve(ROUTE_ROOT, relative.slice("route".length).replace(/^\/+/, ""));
  }
  return path.resolve(AMAP_ROOT, relative);
};
const RENDER_ASSET_DIR = "render-assets";
const REMOTE_ASSET_ATTEMPTS = 3;
const REMOTE_ASSET_TIMEOUT_MS = 45000;
const REMOTE_ASSET_PARALLEL = 4;
const isRemoteAsset = (value) => /^https?:\/\//i.test(String(value || ""));
const assetExtension = (url, contentType) => {
  const type = String(contentType || "").toLowerCase();
  if (type.includes("png")) return ".png";
  if (type.includes("webp")) return ".webp";
  if (type.includes("gif")) return ".gif";
  if (type.includes("svg")) return ".svg";
  if (type.includes("jpe")) return ".jpg";
  const match = /\.(png|jpe?g|webp|gif|svg)(?:$|[?#])/i.exec(String(url || ""));
  return match ? `.${match[1].toLowerCase().replace("jpeg", "jpg")}` : ".jpg";
};
const RENDER_ASSET_MAX_WIDTH = 1600;
const RENDER_ASSET_QUALITY = 82;
const shrinkRenderAssetFile = async (target) => {
  if (!sharpLib) return;
  try {
    const meta = await sharpLib(target).metadata();
    if (!meta.width || meta.width <= RENDER_ASSET_MAX_WIDTH) return;
    const image = sharpLib(target).rotate().resize({ width: RENDER_ASSET_MAX_WIDTH, withoutEnlargement: true });
    const format = String(meta.format || "").toLowerCase();
    const buffer = format === "png"
      ? await image.png({ compressionLevel: 9 }).toBuffer()
      : format === "webp"
        ? await image.webp({ quality: RENDER_ASSET_QUALITY }).toBuffer()
        : format === "jpeg"
          ? await image.jpeg({ quality: RENDER_ASSET_QUALITY, mozjpeg: true }).toBuffer()
          : null;
    if (buffer && buffer.length) fs.writeFileSync(target, buffer);
  } catch (_) {
  }
};
const downloadRenderAsset = async (url, target) => {
  let lastError = null;
  for (let attempt = 1; attempt <= REMOTE_ASSET_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(REMOTE_ASSET_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length) throw new Error("\u7A7A\u6587\u4EF6");
      ensureDir(path.dirname(target));
      fs.writeFileSync(target, buffer);
      await shrinkRenderAssetFile(target);
      return true;
    } catch (error) {
      lastError = error;
      if (attempt < REMOTE_ASSET_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }
  return { error: lastError };
};
const collectRemotionAssets = (videoData) => {
  const assets = new Set();
  const addAsset = (value) => {
    const relative = normalizeAssetPath(value);
    if (relative) assets.add(relative);
  };
  addAsset(videoData?.staticMapImage);
  (videoData?.days || []).forEach((day) => {
    (day.points || []).forEach((point) => {
      (point.scenic?.images || []).forEach(addAsset);
    });
  });
  return [...assets];
};
const collectRemoteSceneImages = (videoData) => {
  const urls = new Set();
  (videoData?.days || []).forEach((day) => {
    (day.points || []).forEach((point) => {
      (point.scenic?.images || []).forEach((value) => {
        if (isRemoteAsset(value)) urls.add(String(value));
      });
    });
  });
  return [...urls];
};
const remapSceneImages = (videoData, mapping) => ({
  ...videoData,
  days: (videoData?.days || []).map((day) => ({
    ...day,
    points: (day.points || []).map((point) => {
      const images = point.scenic?.images;
      if (!Array.isArray(images) || !images.length) return point;
      const next = images.map((value) => (mapping.has(String(value)) ? mapping.get(String(value)) : value)).filter(Boolean);
      return next.length ? { ...point, scenic: { ...point.scenic, images: next } } : { ...point, scenic: { ...point.scenic, images: [] } };
    })
  }))
});
const prepareRemotionPublicDir = async (videoData) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "roadtrip-remotion-public-"));
  const remoteUrls = collectRemoteSceneImages(videoData);
  const mapping = new Map();
  const failures = [];
  for (let index = 0; index < remoteUrls.length; index += REMOTE_ASSET_PARALLEL) {
    const batch = remoteUrls.slice(index, index + REMOTE_ASSET_PARALLEL);
    const results = await Promise.all(batch.map(async (url) => {
      const name = `${RENDER_ASSET_DIR}/scene-${crypto.createHash("sha1").update(url).digest("hex").slice(0, 20)}${assetExtension(url)}`;
      const result = await downloadRenderAsset(url, path.join(tempDir, name));
      return { url, name, result };
    }));
    results.forEach(({ url, name, result }) => {
      if (result === true) mapping.set(url, name);
      else {
        mapping.set(url, null);
        failures.push(`${url} (${result.error?.message || "\u672A\u77E5\u9519\u8BEF"})`);
      }
    });
  }
  const nextVideoData = mapping.size ? remapSceneImages(videoData, mapping) : videoData;
  collectRemotionAssets(nextVideoData).filter((relative) => !isRemoteAsset(relative)).forEach((relative) => {
    const source = resolvePublicAssetFile(relative);
    const isAllowedSource = isPathInside(AMAP_ROOT, source) || isPathInside(ROUTE_ROOT, source);
    if (!isAllowedSource || !fs.existsSync(source) || fs.statSync(source).isDirectory()) return;
    const target = path.join(tempDir, relative);
    ensureDir(path.dirname(target));
    fs.copyFileSync(source, target);
  });
  if (videoData?.presentation?.weather) {
    const weatherDir = path.join(REMOTION_ROOT, "public", "weather");
    if (fs.existsSync(weatherDir)) {
      ensureDir(path.join(tempDir, "weather"));
      fs.readdirSync(weatherDir).filter((name) => name.toLowerCase().endsWith(".svg")).forEach((name) => fs.copyFileSync(path.join(weatherDir, name), path.join(tempDir, "weather", name)));
    }
  }
  const fontDir = path.join(REMOTION_ROOT, "public", "fonts");
  if (fs.existsSync(fontDir)) {
    ensureDir(path.join(tempDir, "fonts"));
    fs.readdirSync(fontDir).filter((name) => /\.(otf|ttf|woff2?)$/i.test(name)).forEach((name) => fs.copyFileSync(path.join(fontDir, name), path.join(tempDir, "fonts", name)));
  }
  return { publicDir: tempDir, videoData: nextVideoData, failures, localized: mapping.size - failures.length };
};
const cleanupTempDir = (tempDir) => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (_) {
  }
};
class ExportCancelledError extends Error {
  constructor(message = "\u5BFC\u51FA\u5DF2\u7EC8\u6B62") {
    super(message);
    this.name = "ExportCancelledError";
    this.code = "EXPORT_CANCELLED";
  }
}
const createExportTask = (ownerEmail, options = {}) => ({
  id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  ownerEmail,
  cancelled: false,
  children: new Set(),
  progress: null,
  result: null,
  publishJob: options.publishJob === true
});
const killProcessTree = (pid) => {
  if (!pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" }).on("error", () => {
    });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (_) {
  }
};
const trackChildProcess = (child) => {
  const task = activeExport;
  if (!task || !child) return;
  task.children.add(child);
  const untrack = () => task.children.delete(child);
  child.once("close", untrack);
  child.once("exit", untrack);
  if (task.cancelled) killProcessTree(child.pid);
};
const assertExportNotCancelled = () => {
  if (activeExport?.cancelled) throw new ExportCancelledError();
};
const cancelActiveExport = (ownerEmail, message = "\u6B63\u5728\u7EC8\u6B62\u5BFC\u51FA\u4EFB\u52A1\u2026") => {
  if (!rendering || !activeExport || activeExport.ownerEmail !== ownerEmail || activeExport.publishJob) return false;
  activeExport.cancelled = true;
  setExportProgress({ active: true, done: false, phase: "cancel", message, percent: exportProgress.percent });
  for (const child of [...activeExport.children]) killProcessTree(child.pid);
  return true;
};
const setExportProgress = (next = {}) => {
  const now = (new Date()).toISOString();
  const percent = Number.isFinite(Number(next.percent)) ? Math.max(0, Math.min(100, Number(next.percent))) : exportProgress.percent;
  exportProgress = {
    ...exportProgress,
    ...next,
    percent: next.allowDecrease ? percent : Math.max(exportProgress.percent || 0, percent),
    updatedAt: now
  };
  if (activeExport) activeExport.progress = { ...exportProgress };
  return exportProgress;
};
const startExportProgress = (message = "\u51C6\u5907\u5BFC\u51FA\u2026") => {
  const now = (new Date()).toISOString();
  exportProgress = {
    active: true,
    done: false,
    error: null,
    phase: "start",
    message,
    percent: 1,
    frames: 0,
    totalFrames: 0,
    etaSeconds: null,
    startedAt: now,
    updatedAt: now
  };
  if (activeExport) activeExport.progress = { ...exportProgress };
};
const finishExportProgress = (message = "\u5BFC\u51FA\u5B8C\u6210") => setExportProgress({ active: false, done: true, error: null, phase: "done", message, percent: 100 });
const failExportProgress = (error) => setExportProgress({ active: false, done: true, error: error?.message || String(error || "\u5BFC\u51FA\u5931\u8D25"), phase: "error", message: "\u5BFC\u51FA\u5931\u8D25", percent: 100 });
const cancelExportProgress = (message = "\u5BFC\u51FA\u5DF2\u7EC8\u6B62") => setExportProgress({ active: false, done: true, error: null, phase: "cancelled", message, percent: exportProgress.percent });
const idleExportProgress = () => ({
  active: false,
  done: false,
  error: null,
  phase: "idle",
  message: "",
  percent: 0,
  frames: 0,
  totalFrames: 0,
  etaSeconds: null,
  startedAt: null,
  updatedAt: null
});
const getExportProgressForOwner = (ownerEmail) => {
  const task = latestExportsByOwner.get(ownerEmail);
  return {
    ok: true,
    rendering: Boolean(activeExport?.ownerEmail === ownerEmail),
    exportTaskId: task?.id || null,
    result: task?.result || null,
    progress: task?.progress || idleExportProgress()
  };
};
const updateProgressFromLog = (text, start, end, phase, fallbackMessage) => {
  const matches = String(text || "").match(/(\d{1,3}(?:\.\d+)?)\s*%/g);
  if (!matches?.length) return;
  const raw = Number(matches[matches.length - 1].replace("%", "").trim());
  if (!Number.isFinite(raw)) return;
  const percent = start + Math.max(0, Math.min(100, raw)) / 100 * (end - start);
  setExportProgress({ phase, message: fallbackMessage, percent });
};
const parseRemotionEtaSeconds = (text) => {
  const match = String(text || "").match(/time remaining:\s*((?:\d+h\s*)?(?:\d+m\s*)?(?:\d+s))/i);
  if (!match) return null;
  let total = 0;
  const hours = match[1].match(/(\d+)h/i);
  const minutes = match[1].match(/(\d+)m/i);
  const seconds = match[1].match(/(\d+)s/i);
  if (hours) total += Number(hours[1]) * 3600;
  if (minutes) total += Number(minutes[1]) * 60;
  if (seconds) total += Number(seconds[1]);
  return total > 0 ? total : null;
};

const updateProgressFromRemotionLog = (text, start, end, phase = "mp4", message = "\u6B63\u5728\u6E32\u67D3 MP4\u2026") => {
  const chunk = String(text || "");
  const frames = [...chunk.matchAll(/Rendered\s+(\d+)\s*\/\s*(\d+)/g)]
    .map((match) => ({done: Number(match[1]), total: Number(match[2])}))
    .filter((item) => Number.isFinite(item.done) && Number.isFinite(item.total) && item.total >= 30 && item.done <= item.total);
  if (!frames.length) {

    const bundling = chunk.match(/Bundling\s+(\d{1,3})%/);
    if (!bundling) return;
    const warmSpan = Math.max(1, (end - start) * 0.03);
    const ratio = Math.max(0, Math.min(100, Number(bundling[1]))) / 100;
    setExportProgress({phase, message, percent: start + ratio * warmSpan});
    return;
  }
  const last = frames[frames.length - 1];
  const warmSpan = Math.max(1, (end - start) * 0.03);
  const ratio = Math.max(0, Math.min(1, last.done / last.total));
  const percent = start + warmSpan + ratio * Math.max(0, end - start - warmSpan);
  const etaSeconds = parseRemotionEtaSeconds(chunk);
  setExportProgress({
    phase,
    message,
    percent,
    frames: last.done,
    totalFrames: last.total,
    etaSeconds: etaSeconds == null ? exportProgress.etaSeconds ?? null : etaSeconds
  });
};
const send = (res, status, data, contentType = "application/json;charset=utf-8") => {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });
  if (contentType.startsWith("application/json")) res.end(JSON.stringify(data, null, 2));
  else res.end(data);
};
const safeName = (value) => String(value || "untitled-route").replace(/[\\/:*?"<>|]/g, "_").replace(/[\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim().slice(0, 90) || "untitled-route";
const toBasicPoint = (point) => ({
  name: point?.name || "",
  lng: point?.lng == null || point.lng === "" ? null : Number(point.lng),
  lat: point?.lat == null || point.lat === "" ? null : Number(point.lat),
  transportMode: ["drive", "ride", "walk"].includes(String(point?.transportMode || "").trim()) ? String(point.transportMode).trim() : "drive",
  useScenic: point?.useScenic === false ? false : true,
  labelOffset: {
    x: Number.isFinite(Number(point?.labelOffset?.x)) ? Math.max(-2, Math.min(2, Number(point.labelOffset.x))) : 0,
    y: Number.isFinite(Number(point?.labelOffset?.y)) ? Math.max(-2, Math.min(2, Number(point.labelOffset.y))) : 0
  }
});
const toBasicSegmentCache = (segmentCache) => {
  if (!segmentCache || typeof segmentCache !== "object" || Array.isArray(segmentCache)) return {};
  const copy = structuredClone(segmentCache);
  for (const day of Object.values(copy)) {
    if (!day || !Array.isArray(day.segments)) continue;
    for (const segment of day.segments) {
      delete segment.fetchingAuto;
      delete segment.autoError;
      delete segment.autoAlternativesLoaded;
    }
  }
  return copy;
};
const toLabelOffsets = (value) => {
  const map = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return map;
  for (const [rawKey, rawOffset] of Object.entries(value).slice(0, 400)) {
    const key = String(rawKey || "").trim().slice(0, 160);
    if (!key) continue;
    const x = Number(rawOffset?.x);
    const y = Number(rawOffset?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const offset = {
      x: Math.max(-2, Math.min(2, x)),
      y: Math.max(-2, Math.min(2, y))
    };
    if (!offset.x && !offset.y) continue;
    map[key] = offset;
  }
  return map;
};
const toBasicRouteData = (routeData) => {
  if (!routeData) return null;
  return {
    id: routeData.id || routeData.name || "untitled-route",
    name: routeData.name || "\u672A\u547D\u540D\u7EBF\u8DEF",
    description: String(routeData.description || "").slice(0, 300),
    segmentCache: toBasicSegmentCache(routeData.segmentCache),
    presentation: routeData.presentation || { mapLayer: "standard", hillshade: false, weather: false, elevation: false, startDate: null },
    pointInfoCache: routeData.pointInfoCache || { version: 1, days: {} },

    labelOffsets: toLabelOffsets(routeData.labelOffsets),
    days: (routeData.days || []).map((day, dayIndex) => {
      const points = day.points || [day.from, ...day.waypoints || [], day.to].filter(Boolean);
      return {
        title: stripDayPrefix(day.title) || `\u7B2C ${dayIndex + 1} \u5929`,
        from: toBasicPoint(day.from || points[0]),
        waypoints: points.slice(1, -1).map(toBasicPoint),
        to: toBasicPoint(day.to || points[points.length - 1])
      };
    })
  };
};
const storageSafeSegment = (value) => {
  const text = String(value || "").normalize("NFKC").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 90);
  if (text) return text;
  return `route-${Buffer.from(String(value || Date.now())).toString("hex").slice(0, 18)}`;
};
const safeExt = (name, mimeType = "") => {
  const ext = path.extname(String(name || "")).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".webp"].includes(ext)) return ext;
  if (/png/i.test(mimeType)) return ".png";
  if (/webp/i.test(mimeType)) return ".webp";
  return ".jpg";
};
const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true });
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
const crc32 = (buffer) => {
  let crc = 4294967295;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8;
  return (crc ^ 4294967295) >>> 0;
};
const zipDateTime = (date = new Date()) => {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = date.getHours() << 11 | date.getMinutes() << 5 | Math.floor(date.getSeconds() / 2);
  const dosDate = year - 1980 << 9 | date.getMonth() + 1 << 5 | date.getDate();
  return { dosTime, dosDate };
};
const createZipBuffer = (entries) => {
  const zipEntries = entries.filter((item) => item?.name && item.data != null);
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const now = zipDateTime();
  for (const entry of zipEntries) {
    const name = Buffer.from(String(entry.name).replace(/^\/+/, ""), "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data));
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(67324752, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(2048, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(now.dosTime, 10);
    local.writeUInt16LE(now.dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(33639248, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(2048, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(now.dosTime, 12);
    central.writeUInt16LE(now.dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(101010256, 0);
  end.writeUInt16LE(zipEntries.length, 8);
  end.writeUInt16LE(zipEntries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
};
const readBody = (req, maxBytes = MAX_BODY) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("\u8BF7\u6C42\u6570\u636E\u592A\u5927");
      error.status = 413;
      reject(error);
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    try {
      const text = Buffer.concat(chunks).toString("utf8") || "{}";
      resolve(JSON.parse(text));
    } catch (error) {
      reject(new Error("JSON \u683C\u5F0F\u65E0\u6548\uFF1A" + error.message));
    }
  });
  req.on("error", reject);
});
const getRouteName = (payload) => stripDayPrefix(payload?.routeData?.name || payload?.videoData?.route?.name) || "\u672A\u547D\u540D\u7EBF\u8DEF";
const stripDayPrefix = (value) => String(value || "").replace(/^\s*D\s*\d+\s*[：:、.．-]?\s*/i, "").trim();
const formatDistance = (meters) => {
  const km = Number(meters || 0) / 1e3;
  if (!km) return "0 km";
  return `${km >= 100 ? km.toFixed(0) : km.toFixed(1)} km`;
};
const formatDuration = (seconds) => {
  const minutes = Math.round(Number(seconds || 0) / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h} h ${m} min` : `${m} min`;
};
const mdEscape = (value) => String(value || "").replace(/\r?\n+/g, " ").trim();
const normalizeSceneName = (value) => String(value || "").replace(/[\s·•（）()【】\[\]《》<>“”"'：:，,。.\-—_/\\]/g, "").trim();
const toProjectImagePath = (src) => {
  const value = String(src || "").trim().replace(/\\/g, "/");
  if (!value || /^(https?:|data:|file:)/i.test(value)) return value;
  if (path.isAbsolute(value)) return value;
  return resolvePublicAssetFile(value);
};
const toMarkdownImagePath = (src, outputDir) => {
  const value = String(src || "").trim().replace(/\\/g, "/");
  if (!value || /^(https?:|data:|file:)/i.test(value)) return value;
  const absolute = path.isAbsolute(value) ? value : resolvePublicAssetFile(value);
  return path.relative(outputDir || AMAP_ROOT, absolute).replace(/\\/g, "/");
};
const markdownImage = (alt, src) => {
  const cleanAlt = String(alt || "\u56FE\u7247").replace(/[\]\r\n]/g, " ").trim();
  const cleanSrc = String(src || "").replace(/\r?\n/g, "").trim();
  if (!cleanSrc) return null;
  return `![${cleanAlt}](<${cleanSrc}>)`;
};
const ROUTE_MAP_ALT_SUFFIX = "\u5168\u7A0B\u5730\u56FE";
const isRouteMapAlt = (alt) => String(alt || "").trim().endsWith(ROUTE_MAP_ALT_SUFFIX);
const markdownImageGrid = (spotName, sources) => {
  const images = (sources || []).filter(Boolean);
  if (!images.length) return null;
  const rows = ['<table class="manual-image-grid">'];
  for (let index = 0; index < images.length; index += 2) {
    const pair = images.slice(index, index + 2);
    const cells = pair.map((src, pairIndex) => {
      const imageNumber = index + pairIndex + 1;
      const alt = `${spotName || "\u666F\u70B9"}\u7167\u7247${imageNumber}`;
      return `<td><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" /><br /><sub>${escapeHtml(alt)}</sub></td>`;
    });
    if (cells.length === 1) cells.push("<td></td>");
    rows.push(`<tr>${cells.join("")}</tr>`);
  }
  rows.push("</table>");
  return rows.join("\n");
};
const scenicImagesForManual = (spot, outputDir, limit = 4) => (spot?.images || []).filter((src) => {
  const imagePath = toProjectImagePath(src);
  return /^(https?:|data:|file:)/i.test(imagePath) || fs.existsSync(imagePath);
}).slice(0, limit).map((src) => toMarkdownImagePath(src, outputDir));
const weatherLabel = (code) => {
  return weatherCodeMap[String(Number(code))]?.label || "\u672A\u77E5\u5929\u6C14";
};
const weatherIconName = (code) => {
  return weatherCodeMap[String(Number(code))]?.icon || "cloudy";
};
const weatherIconForManual = (code, outputDir) => {
  const name = `${weatherIconName(code)}.svg`;
  const built = path.join(PUBLIC_ROOT, "weather", name);
  const source = path.join(path.dirname(__dirname), "web", "assets", "weather", name);
  return toMarkdownImagePath(fs.existsSync(built) ? built : source, outputDir);
};
const pointFactsForManual = (point, presentation) => {
  const values = [];
  if (presentation?.weather && point?.weather) {
    values.push(`${weatherLabel(point.weather.code)} \xB7 ${Math.round(Number(point.weather.minC))}\u2013${Math.round(Number(point.weather.maxC))} \xB0C`);
  }
  if (presentation?.elevation && Number.isFinite(Number(point?.elevationM))) values.push(`${Math.round(Number(point.elevationM) / 10) * 10} m`);
  return values.join(" \xB7 ");
};
const buildTravelManual = (videoData, routeData, options = {}) => {
  const routeName = videoData?.route?.name || routeData?.name || "\u81EA\u9A7E\u8DEF\u7EBF";
  const days = videoData?.days || [];
  const lines = [];
  lines.push(`# ${mdEscape(routeName)}\u8DEF\u7EBF\u624B\u518C`);
  lines.push("");
  const routeDescription = routeData?.description || videoData?.route?.description || "";
  if (routeDescription) {
    lines.push(mdEscape(String(routeDescription).slice(0, 300)));
    lines.push("");
  }
  if (videoData?.summary) {
    lines.push(`- \u5929\u6570\uFF1A${videoData.summary.dayCount || days.length} \u5929`);
    lines.push(`- \u5168\u7A0B\uFF1A${formatDistance(videoData.summary.totalDistance)} / ${formatDuration(videoData.summary.totalDuration)}`);
    lines.push("");
  }
  if (options.routeMapImage) {
    lines.push("## \u5168\u7A0B\u5730\u56FE");
    lines.push("");
    lines.push(markdownImage(`${routeName}${ROUTE_MAP_ALT_SUFFIX}`, options.routeMapImage));
    lines.push("");
  }
  const scenicSeen = new Set();
  days.forEach((day, dayIndex) => {
    const title = stripDayPrefix(day.title) || `\u7B2C ${dayIndex + 1} \u5929`;
    const dayDistance = (day.segments || []).reduce((sum, seg) => sum + Number(seg.distance || 0), 0);
    const dayDuration = (day.segments || []).reduce((sum, seg) => sum + Number(seg.duration || 0), 0);
    lines.push(`## D${dayIndex + 1} ${mdEscape(title)}`);
    lines.push("");
    lines.push(`- \u5F53\u5929\u5408\u8BA1\uFF1A${formatDistance(dayDistance)} / ${formatDuration(dayDuration)}`);
    lines.push(`- \u8DEF\u7EBF\uFF1A${(day.points || []).map((p) => mdEscape(p.name)).join(" \u2192 ")}`);
    lines.push("");
    lines.push("### \u5206\u6BB5\u95F4\u9694");
    (day.segments || []).forEach((seg, segIndex) => {
      const from = mdEscape(seg.from || day.points?.[segIndex]?.name || "\u4E0A\u4E00\u70B9");
      const to = mdEscape(seg.to || day.points?.[segIndex + 1]?.name || "\u4E0B\u4E00\u70B9");
      const suffix = seg.error ? `\uFF08\u8DEF\u7EBF\u5F02\u5E38\uFF1A${mdEscape(seg.error)}\uFF09` : "";
      lines.push(`- ${from} \u2192 ${to}\uFF1A${formatDistance(seg.distance)} / ${formatDuration(seg.duration)}${suffix}`);
    });
    lines.push("");
    lines.push("### \u70B9\u4F4D\u8BF4\u660E");
    (day.points || []).forEach((point) => {
      const role = point.kind === "from" ? "\u8D77\u70B9" : point.kind === "to" ? "\u7EC8\u70B9" : "\u9014\u5F84\u70B9";
      const scenic = point.scenic || null;
      lines.push(`- **${role}\uFF5C${mdEscape(point.name)}**`);
      const facts = pointFactsForManual(point, videoData?.presentation);
      if (facts) {
        const icon = videoData?.presentation?.weather && point.weather ? `![${weatherLabel(point.weather.code)}](<${weatherIconForManual(point.weather.code, options.outputDir)}>) ` : "";
        lines.push(`  - ${icon}${facts}`);
      }
      if (point.kind !== "from" && scenic) {
        const scenicKey = scenic.title || point.name || "";
        if (!scenicSeen.has(scenicKey)) {
          scenicSeen.add(scenicKey);
          if (scenic.description) lines.push(`  - ${mdEscape(scenic.description)}`);
          const images = scenicImagesForManual(scenic, options.outputDir);
          if (images.length) {
            lines.push("");
            lines.push(markdownImageGrid(point.name, images));
            lines.push("");
          }
        }
      }
    });
    lines.push("");
  });
  return lines.join("\n");
};
const escapeHtml = (value) => String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const inlineMd = (value, baseDir) => {
  const images = [];
  let source = String(value || "").replace(/!\[([^\]]*)\]\((?:<([^>]+)>|([^)]+))\)/g, (_, alt, angled, plain) => {
    const token = `@@INLINE_IMAGE_${images.length}@@`;
    images.push(`<img class="inline-weather-icon" src="${escapeHtml(resolveMarkdownImageSrc(angled || plain, baseDir))}" alt="${escapeHtml(alt || "\u5929\u6C14")}" />`);
    return token;
  });
  let text = escapeHtml(source);
  text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/`(.+?)`/g, "<code>$1</code>");
  images.forEach((image, index) => {
    text = text.replace(`@@INLINE_IMAGE_${index}@@`, image);
  });
  return text;
};
const toFileUrl = (file) => encodeURI("file:///" + path.resolve(file).replace(/\\/g, "/"));
const resolveMarkdownImageSrc = (src, baseDir) => {
  const value = String(src || "").trim();
  if (/^(https?:|data:|file:)/i.test(value)) return value;
  const absolute = path.isAbsolute(value) ? value : path.join(baseDir || AMAP_ROOT, value);
  return toFileUrl(absolute);
};
const isManualImageGridHtml = (line) => /^<\/?(table|tr)\b/i.test(line.trim()) || /^<td\b/i.test(line.trim()) || /^<\/td>/i.test(line.trim());
const normalizeManualImageGridHtml = (line, baseDir) => line.replace(/(<img\b[^>]*\bsrc=")([^"]*)(")/gi, (_, before, src, after) => `${before}${escapeHtml(resolveMarkdownImageSrc(src, baseDir))}${after}`);
const markdownToHtmlDocument = (markdown, title, baseDir = AMAP_ROOT) => {
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  const parts = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      parts.push("</ul>");
      inList = false;
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      closeList();
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      closeList();
      parts.push("<hr />");
      continue;
    }
    if (isManualImageGridHtml(line)) {
      closeList();
      parts.push(normalizeManualImageGridHtml(line, baseDir));
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      parts.push(`<h${level}>${inlineMd(heading[2], baseDir)}</h${level}>`);
      continue;
    }
    const image = line.match(/^!\[([^\]]*)\]\((?:<([^>]+)>|([^)]+))\)\s*$/);
    if (image) {
      closeList();
      const alt = image[1] || "\u56FE\u7247";
      const src = resolveMarkdownImageSrc(image[2] || image[3], baseDir);
      const figureClass = isRouteMapAlt(alt) ? ' class="route-map-figure"' : "";
      parts.push(`<figure${figureClass}><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" /><figcaption>${escapeHtml(alt)}</figcaption></figure>`);
      continue;
    }
    const bullet = line.match(/^\s*-\s+(.*)$/);
    if (bullet) {
      if (!inList) {
        parts.push("<ul>");
        inList = true;
      }
      parts.push(`<li>${inlineMd(bullet[1], baseDir)}</li>`);
      continue;
    }
    closeList();
    parts.push(`<p>${inlineMd(line, baseDir)}</p>`);
  }
  closeList();
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title || "\u8DEF\u7EBF\u624B\u518C")}</title>
  <style>
    @font-face {
      font-family: 'Noto Sans SC';
      src: url('${toFileUrl(path.join(REMOTION_ROOT, "public", "fonts", "NotoSansSC-Regular.otf"))}') format('opentype');
      font-weight: 400;
      font-style: normal;
      font-display: swap;
    }
    @page { size: A4; margin: 18mm 16mm; }
    body {
      font-family: "Noto Sans SC", "Noto Sans CJK SC", "Microsoft YaHei", "PingFang SC", sans-serif;
      color: #1f2937;
      line-height: 1.65;
      font-size: 13px;
      margin: 0;
      padding: 0;
    }
    h1 { font-size: 24px; margin: 0 0 14px; color: #0f172a; }
    h2 { font-size: 18px; margin: 22px 0 10px; color: #0f172a; border-bottom: 1px solid #e5e7eb; padding-bottom: 6px; }
    h3 { font-size: 15px; margin: 14px 0 8px; color: #111827; }
    p, li { margin: 0 0 6px; }
    ul { margin: 0 0 10px 1.2em; padding: 0; }
    figure { margin: 10px 0 16px; page-break-inside: avoid; break-inside: avoid; }
    img { display: block; max-width: 100%; max-height: 138mm; object-fit: contain; border-radius: 10px; border: 1px solid #e5e7eb; }
    figure.route-map-figure img { max-height: 200mm; }
    img.inline-weather-icon { display: inline-block; width: 16px; height: 16px; margin-left: 4px; vertical-align: -3px; border: 0; border-radius: 0; }
    figcaption { margin-top: 4px; color: #64748b; font-size: 11px; text-align: center; }
    .manual-image-grid { width: 100%; border-collapse: collapse; margin: 8px 0 14px; page-break-inside: avoid; break-inside: avoid; }
    .manual-image-grid td { width: 50%; padding: 0 5px 8px; vertical-align: top; border: 0; }
    .manual-image-grid td:empty { padding: 0; }
    .manual-image-grid img { width: 100%; height: 52mm; max-height: 52mm; object-fit: cover; }
    .manual-image-grid sub { display: block; margin-top: 3px; color: #64748b; font-size: 10px; text-align: center; }
    hr { border: 0; border-top: 1px solid #e5e7eb; margin: 18px 0; }
    code { font-family: Consolas, monospace; background: #f3f4f6; padding: 1px 4px; border-radius: 4px; }
  </style>
</head>
<body>
${parts.join("\n")}
</body>
</html>`;
};
const loadJson = (file, fallback = null) => {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
};
let supabaseClient = null;
const getSupabaseClient = () => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  if (!createSupabaseClient) throw new Error("\u7F3A\u5C11 @supabase/supabase-js \u4F9D\u8D56\uFF0C\u8BF7\u5148\u6267\u884C npm install\u3002");
  if (!supabaseClient) {
    supabaseClient = createSupabaseClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }
  return supabaseClient;
};
const isSupabaseConfigured = () => Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY && createSupabaseClient);
const requireSupabaseClient = () => {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase \u6570\u636E\u5E93\u672A\u914D\u7F6E\u3002");
  return supabase;
};
const storageUserCache = new Map();
const getStorageUserId = async (email) => {
  const ownerEmail = normalizeEmail(email);
  if (!ownerEmail) throw new Error("\u7F3A\u5C11\u7528\u6237\u90AE\u7BB1\uFF0C\u65E0\u6CD5\u5B9A\u4F4D\u5B58\u50A8\u7A7A\u95F4\u3002");
  if (storageUserCache.has(ownerEmail)) return storageUserCache.get(ownerEmail);
  const supabase = requireSupabaseClient();
  const { data: existing, error: readError } = await supabase.from("roadtrip_users").select("storage_user_id").eq("owner_email", ownerEmail).maybeSingle();
  if (readError) throw readError;
  if (existing?.storage_user_id) {
    storageUserCache.set(ownerEmail, existing.storage_user_id);
    return existing.storage_user_id;
  }
  const { data, error } = await supabase.from("roadtrip_users").insert({ owner_email: ownerEmail }).select("storage_user_id").single();
  if (error) {
    const { data: raced, error: retryError } = await supabase.from("roadtrip_users").select("storage_user_id").eq("owner_email", ownerEmail).single();
    if (retryError) throw error;
    storageUserCache.set(ownerEmail, raced.storage_user_id);
    return raced.storage_user_id;
  }
  storageUserCache.set(ownerEmail, data.storage_user_id);
  return data.storage_user_id;
};
const communityService = createCommunityService({
  getSupabase: requireSupabaseClient,
  getStorageUserId,
  normalizeEmail,
  isAdmin: isAdminIdentity,
  bucket: COMMUNITY_ASSET_BUCKET,
  signedUrlSeconds: ROUTE_ASSET_SIGNED_URL_SECONDS
});
const postCommunityMessageQuietly = async (body, identity) => {
  try {
    await communityService.postMessage({ body }, identity);
  } catch (error) {
    console.warn("\u81EA\u52A8\u793E\u533A\u6D88\u606F\u53D1\u9001\u5931\u8D25:", error?.message || error);
  }
};
const normalizeCloudRouteId = (routeData) => {
  const id = String(routeData?.id || "").trim();
  if (id) return id.slice(0, 120);
  const name = safeName(routeData?.name || "route").toLowerCase();
  return `${name}-${Date.now().toString(36)}`.slice(0, 120);
};
const ASSET_KEYS = ["routeJson", "videoData", "mp4", "manualMd", "manualPdf", "mapImage", "productZip"];
const ASSET_ALIASES = { videoJson: "videoData" };
const canonicalAssetKey = (key) => ASSET_ALIASES[key] || key;
const isRouteAssetDescriptor = (value) => value && typeof value === "object" && typeof value.storageBucket === "string" && typeof value.storagePath === "string";
const getRouteAssetDescriptor = (routeData, key) => {
  const assets = routeData?._assets || {};
  const canonical = canonicalAssetKey(key);
  const value = assets[canonical] || assets[key];
  return isRouteAssetDescriptor(value) ? { ...value } : null;
};
const getRouteAssetDescriptors = (routeData) => ASSET_KEYS.reduce((result, key) => {
  const descriptor = getRouteAssetDescriptor(routeData, key);
  if (descriptor) result[key] = descriptor;
  return result;
}, {});
const routeAssetUrlFromDescriptor = async (supabase, descriptor) => {
  if (!descriptor) return null;
  if (!descriptor.storageBucket || !descriptor.storagePath || !supabase) return null;
  if (descriptor.storageBucket === PUBLIC_ROUTE_ASSET_BUCKET) {
    const { data: data2 } = supabase.storage.from(descriptor.storageBucket).getPublicUrl(descriptor.storagePath);
    return data2?.publicUrl || null;
  }
  const { data, error } = await supabase.storage.from(descriptor.storageBucket).createSignedUrl(descriptor.storagePath, ROUTE_ASSET_SIGNED_URL_SECONDS);
  if (error) throw error;
  return data?.signedUrl || null;
};
const resolveRouteAssetUrls = async (routeData) => {
  const supabase = getSupabaseClient();
  const descriptors = getRouteAssetDescriptors(routeData);
  const result = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    result[key] = await routeAssetUrlFromDescriptor(supabase, descriptor);
  }
  result.videoJson = result.videoData || result.videoJson || null;
  return result;
};
const buildSimpleRouteMarkdown = (routeData) => {
  const basic = toBasicRouteData(routeData);
  const lines = [`# ${mdEscape(basic?.name || "\u8DEF\u7EBF")}\u8DEF\u7EBF\u624B\u518C`, ""];
  if (basic?.description) {
    lines.push(mdEscape(basic.description), "");
  }
  (basic?.days || []).forEach((day, dayIndex) => {
    const points = [day.from, ...day.waypoints || [], day.to].filter((point) => point?.name);
    lines.push(`## D${dayIndex + 1} ${mdEscape(day.title || `\u7B2C ${dayIndex + 1} \u5929`)}`);
    lines.push("");
    lines.push(`- \u8DEF\u7EBF\uFF1A${points.map((point) => mdEscape(point.name)).join(" \u2192 ") || "\u672A\u586B\u5199"}`);
    lines.push("");
  });
  return lines.join("\n");
};
const fetchAssetBuffer = async (url, maxBytes = MAX_BODY) => {
  if (!/^https?:\/\//i.test(String(url || ""))) return null;
  const response = await fetch(url);
  if (!response.ok) return null;
  const length = Number(response.headers.get("content-length") || 0);
  if (length > maxBytes) throw new Error("\u4EA7\u54C1\u8D44\u4EA7\u8FC7\u5927\uFF0C\u65E0\u6CD5\u6253\u5305\u3002");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error("\u4EA7\u54C1\u8D44\u4EA7\u8FC7\u5927\uFF0C\u65E0\u6CD5\u6253\u5305\u3002");
  return buffer;
};
const routeAssetEntryName = (routeName, suffix) => `${safeName(routeName || "route")}.${suffix}`.replace(/[/\\]+/g, "_");
const buildRouteProductZip = async (routeData, options = {}) => {
  const name = String(options.name || routeData?.name || "\u8DEF\u7EBF").trim() || "\u8DEF\u7EBF";
  const assetUrls = await resolveRouteAssetUrls(routeData);
  const entries = [
    { name: routeAssetEntryName(name, "route.json"), data: JSON.stringify(toBasicRouteData(routeData), null, 2) }
  ];
  let addedMd = false;
  const remoteAssets = [
    ["manualMd", "travel.md"],
    ["manualPdf", "travel.pdf"],
    ["videoJson", "mp4-data.json"],
    ["mp4", "mp4"],
    ["mapImage", "route-map.png"]
  ];
  for (const [key, suffix] of remoteAssets) {
    const url = assetUrls[key];
    if (!url || key === "productZip") continue;
    const data = await fetchAssetBuffer(url);
    if (!data) continue;
    entries.push({ name: routeAssetEntryName(name, suffix), data });
    if (key === "manualMd") addedMd = true;
  }
  if (!addedMd) entries.splice(1, 0, { name: routeAssetEntryName(name, "travel.md"), data: buildSimpleRouteMarkdown(routeData) });
  return createZipBuffer(entries);
};
const sha256Buffer = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const extensionForContentType = (contentType, fallback = "") => {
  if (/json/i.test(contentType)) return ".json";
  if (/markdown|text\/plain/i.test(contentType)) return ".md";
  if (/pdf/i.test(contentType)) return ".pdf";
  if (/mp4|video/i.test(contentType)) return ".mp4";
  if (/png/i.test(contentType)) return ".png";
  if (/jpe?g/i.test(contentType)) return ".jpg";
  return fallback || "";
};
const uploadBufferToRouteAssets = async (supabase, { bucket, prefix, key, buffer, contentType, fileName }) => {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const sha256 = sha256Buffer(data);
  const ext = path.extname(String(fileName || "")).toLowerCase() || extensionForContentType(contentType);
  const storagePath = `${prefix.replace(/^\/+|\/+$/g, "")}/${canonicalAssetKey(key)}/${sha256}${ext}`;
  const { error } = await supabase.storage.from(bucket).upload(storagePath, data, {
    contentType,
    cacheControl: "31536000",
    upsert: false
  });
  if (error && !/exist|duplicate|already/i.test(error.message || "")) throw error;
  return {
    storageBucket: bucket,
    storagePath,
    sha256,
    size: data.length,
    contentType,
    fileName: fileName || `${canonicalAssetKey(key)}${ext}`
  };
};
const contentTypeForPath = (file) => {
  const ext = path.extname(String(file || "")).toLowerCase();
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".md") return "text/markdown; charset=utf-8";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".zip") return "application/zip";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
};
const pickRouteAssetMap = (assets = {}) => ASSET_KEYS.reduce((result, key) => {
  const canonical = canonicalAssetKey(key);
  const value = assets[canonical] || assets[key];
  if (value) result[canonical] = value;
  return result;
}, {});
const withRouteAsset = (routeData, key, asset) => ({
  ...routeData || {},
  _assets: {
    ...pickRouteAssetMap(routeData && routeData._assets || {}),
    [canonicalAssetKey(key)]: asset
  }
});
const withRouteAssets = (routeData, assets) => ({
  ...routeData || {},
  _assets: {
    ...pickRouteAssetMap(routeData && routeData._assets || {}),
    ...pickRouteAssetMap(assets)
  }
});
const uploadRouteProductZip = async (supabase, routeData, options = {}) => {
  const name = String(options.name || routeData?.name || "\u8DEF\u7EBF").trim() || "\u8DEF\u7EBF";
  const buffer = await buildRouteProductZip(routeData, { name });
  const descriptor = await uploadBufferToRouteAssets(supabase, {
    bucket: options.bucket || PUBLIC_ROUTE_ASSET_BUCKET,
    prefix: options.prefix || `routes/${storageSafeSegment(options.id || routeData?.id || name)}`,
    key: "productZip",
    buffer,
    contentType: "application/zip",
    fileName: `${safeName(name)}.product.zip`
  });
  return {
    routeData: withRouteAsset(routeData, "productZip", descriptor),
    descriptor,
    size: buffer.length
  };
};
const toCloudRouteItem = async (item) => {
  const assetUrls = await resolveRouteAssetUrls(item.route_data);
  return {
    name: item.name,
    safeName: item.id,
    fileBase: item.id,
    archivedAt: item.created_at,
    updatedAt: item.updated_at,
    mapLayer: item.map_layer,
    routeJson: true,
    videoJson: Boolean(assetUrls.videoJson),
    mp4: Boolean(assetUrls.mp4),
    manualMd: Boolean(assetUrls.manualMd),
    manualPdf: Boolean(assetUrls.manualPdf),
    mapImage: Boolean(assetUrls.mapImage),
    productZip: Boolean(assetUrls.productZip),
    assetUrls,
    cloud: true,
    routeData: item.route_data
  };
};
const toCloudRouteSummary = (item) => ({
  id: item.id,
  name: item.name,
  safeName: item.id,
  fileBase: item.id,
  archivedAt: item.created_at,
  updatedAt: item.updated_at,
  mapLayer: item.map_layer,
  routeJson: true,
  cloud: true,
  summarized: true
});
const listCloudRoutes = async (identity, {summary = false} = {}) => {
  const supabase = getSupabaseClient();
  if (!supabase || !identity?.email) return null;
  const columns = summary
    ? "id,name,map_layer,created_at,updated_at"
    : "id,name,route_data,map_layer,created_at,updated_at";
  const { data, error } = await supabase.from(SUPABASE_TABLES.routes).select(columns).eq("owner_email", identity.email).order("updated_at", { ascending: false });
  if (error) throw error;
  if (summary) return (data || []).map(toCloudRouteSummary);
  return Promise.all((data || []).map(toCloudRouteItem));
};
const saveCloudRoute = async (payload, identity) => {
  const supabase = requireSupabaseClient();
  if (!identity?.email) throw new Error("\u7F3A\u5C11\u7528\u6237\u90AE\u7BB1\uFF0C\u65E0\u6CD5\u4FDD\u5B58\u8DEF\u7EBF\u3002");
  const routeData = validateRouteData(payload?.routeData);
  const id = normalizeCloudRouteId(routeData);
  const normalizedRoute = { ...routeData, id };
  const row = {
    owner_email: identity.email,
    id,
    name: String(normalizedRoute.name || "\u672A\u547D\u540D\u8DEF\u7EBF").trim() || "\u672A\u547D\u540D\u8DEF\u7EBF",
    route_data: normalizedRoute,
    map_layer: assertMapLayer(payload.mapLayer),
    updated_at: (new Date()).toISOString()
  };
  const { data, error } = await supabase.from(SUPABASE_TABLES.routes).upsert(row, { onConflict: "owner_email,id" }).select("id,updated_at").single();
  if (error) throw error;
  return { ok: true, route: data };
};
const deleteCloudRoute = async (routeId, identity) => {
  const supabase = requireSupabaseClient();
  if (!identity?.email) throw new Error("\u7F3A\u5C11\u7528\u6237\u90AE\u7BB1\uFF0C\u65E0\u6CD5\u5220\u9664\u8DEF\u7EBF\u3002");
  const id = String(routeId || "").trim();
  if (!id) throw new Error("\u7F3A\u5C11\u8DEF\u7EBF ID\u3002");
  const { error } = await supabase.from(SUPABASE_TABLES.routes).delete().eq("owner_email", identity.email).eq("id", id);
  if (error) throw error;
  return { ok: true };
};
const toCloudScene = (item) => item ? {
  id: item.id,
  name: item.name,
  title: item.title,
  description: item.description || "",
  images: item.images || [],
  version: Number(item.version || 1),
  updatedByEmail: item.updated_by_email || null,
  contributor: item.contributor || null,
  updatedAt: item.updated_at
} : null;
const getCloudSceneVersion = async (supabase, normalizedName) => {
  const { data, error } = await supabase.from(SUPABASE_TABLES.sceneRevisions).select("version").eq("normalized_name", normalizedName).order("version", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return Math.max(0, Number(data?.version || 0));
};
const getCloudScenic = async (name) => {
  const supabase = getSupabaseClient();
  if (!supabase) return null;
  const normalized = normalizeSceneName(name);
  if (!normalized) throw new Error("\u666F\u70B9\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A\u3002");
  const { data, error } = await supabase.from(SUPABASE_TABLES.scenes).select("id,name,title,description,images,updated_by_email,updated_at").eq("normalized_name", normalized).maybeSingle();
  if (error) throw error;
  if (!data) return { ok: true, spot: null, version: 0 };
  const version = await getCloudSceneVersion(supabase, normalized);
  const profiles = await communityService.getProfileSummaries([data.updated_by_email]);
  return { ok: true, spot: toCloudScene({ ...data, version, contributor: profiles[data.updated_by_email] || null }), version };
};
const dataUrlToImage = (image) => {
  const dataUrl = String(image?.dataUrl || "");
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return {
    contentType: match[1],
    buffer: Buffer.from(match[2], "base64"),
    ext: safeExt(image?.name, match[1]),
    name: safeName(image?.name || "image")
  };
};
const uploadCloudSceneImages = async (supabase, normalizedName, images) => {
  const urls = [];
  for (const image of images || []) {
    const parsed = dataUrlToImage(image);
    if (!parsed) continue;
    const objectName = `scenes/${normalizedName}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${parsed.name}${parsed.ext}`;
    const { error } = await supabase.storage.from(SCENE_IMAGE_BUCKET).upload(objectName, parsed.buffer, {
      contentType: parsed.contentType || "image/jpeg",
      upsert: false
    });
    if (error) throw error;
    const { data } = supabase.storage.from(SCENE_IMAGE_BUCKET).getPublicUrl(objectName);
    if (data?.publicUrl) urls.push(data.publicUrl);
  }
  return urls;
};
const buildTextDiff = (before, after) => {
  const oldLines = String(before || "").split(/\r?\n/);
  const newLines = String(after || "").split(/\r?\n/);
  const max = Math.max(oldLines.length, newLines.length);
  const diff = [];
  for (let index = 0; index < max; index += 1) {
    const oldLine = oldLines[index] ?? "";
    const newLine = newLines[index] ?? "";
    if (oldLine === newLine) {
      if (oldLine) diff.push({ type: "same", text: oldLine });
      continue;
    }
    if (oldLine) diff.push({ type: "remove", text: oldLine });
    if (newLine) diff.push({ type: "add", text: newLine });
  }
  return diff;
};
const saveSceneRevision = async (supabase, existing, next, identity, version, changeNote = "") => {
  const beforeDescription = String(existing?.description || "");
  const afterDescription = String(next.description || "");
  const beforeImages = Array.isArray(existing?.images) ? existing.images : [];
  const afterImages = Array.isArray(next.images) ? next.images : [];
  const { error } = await supabase.from(SUPABASE_TABLES.sceneRevisions).insert({
    scene_id: existing?.id || next.id || null,
    normalized_name: next.normalized_name,
    name: next.name,
    title: next.title,
    edited_by_email: identity.email,
    description_before: beforeDescription,
    description_after: afterDescription,
    images_before: beforeImages,
    images_after: afterImages,
    diff: buildTextDiff(beforeDescription, afterDescription),
    version,
    change_note: String(changeNote || "").trim()
  });
  if (error) throw error;
};
const saveCloudScenic = async (payload, identity) => {
  const supabase = requireSupabaseClient();
  if (!identity?.email) throw new Error("\u7F3A\u5C11\u7528\u6237\u90AE\u7BB1\uFF0C\u65E0\u6CD5\u4FDD\u5B58\u666F\u70B9\u3002");
  const name = String(payload?.name || payload?.title || "").trim();
  const normalized = normalizeSceneName(name);
  if (!normalized) throw new Error("\u666F\u70B9\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A\u3002");
  const { data: existing, error: readError } = await supabase.from(SUPABASE_TABLES.scenes).select("id,name,title,description,images").eq("normalized_name", normalized).maybeSingle();
  if (readError) throw readError;
  const uploaded = await uploadCloudSceneImages(supabase, normalized, payload?.images || []);
  const removedUrls = new Set((Array.isArray(payload?.removeImages) ? payload.removeImages : []).map((url) => String(url || "")).filter(Boolean));
  const images = [...new Set([...existing?.images || [], ...uploaded])]
    .filter((url) => !removedUrls.has(String(url)));
  const row = {
    ...existing?.id ? { id: existing.id } : {},
    normalized_name: normalized,
    name,
    title: String(payload?.title || existing?.title || name).trim() || name,
    description: String(payload?.description || existing?.description || "").trim(),
    images,
    updated_by_email: identity.email,
    updated_at: (new Date()).toISOString()
  };
  const unchanged = existing && String(existing.title || "") === row.title && String(existing.description || "") === row.description && JSON.stringify(existing.images || []) === JSON.stringify(row.images || []);
  if (unchanged) {
    const version2 = await getCloudSceneVersion(supabase, normalized);
    return { ok: true, unchanged: true, folderName: normalized, spot: toCloudScene({ ...existing, version: version2 }), version: version2 };
  }
  const version = await getCloudSceneVersion(supabase, normalized) + 1;
  const { data, error } = await supabase.from(SUPABASE_TABLES.scenes).upsert(row, { onConflict: "normalized_name" }).select("id,name,title,description,images,updated_at").single();
  if (error) throw error;
  await saveSceneRevision(supabase, existing, { ...row, id: data.id }, identity, version, payload?.changeNote);
  if (existing) {
    await postCommunityMessageQuietly(`\u6211\u7F16\u8F91\u4E86\u666F\u70B9\u300C${name}\u300D`, identity);
  }
  return { ok: true, folderName: normalized, spot: toCloudScene({ ...data, version }), version };
};
const listCloudSceneRevisions = async (name) => {
  const supabase = getSupabaseClient();
  if (!supabase) return null;
  const normalized = normalizeSceneName(name);
  if (!normalized) throw new Error("\u666F\u70B9\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A\u3002");
  const { data, error } = await supabase.from(SUPABASE_TABLES.sceneRevisions).select("id,name,title,edited_by_email,description_before,description_after,images_before,images_after,diff,version,change_note,created_at").eq("normalized_name", normalized).order("created_at", { ascending: false }).limit(30);
  if (error) throw error;
  return (data || []).map((item) => ({
    id: item.id,
    name: item.name,
    title: item.title,
    editedByEmail: item.edited_by_email,
    descriptionBefore: item.description_before || "",
    descriptionAfter: item.description_after || "",
    imagesBefore: item.images_before || [],
    imagesAfter: item.images_after || [],
    diff: item.diff || [],
    version: Number(item.version || 1),
    changeNote: item.change_note || "",
    createdAt: item.created_at
  }));
};
const listCloudScenes = async () => {
  const supabase = getSupabaseClient();
  if (!supabase) return null;
  const { data, error } = await supabase.from(SUPABASE_TABLES.scenes).select("id,name,title,description,images,updated_by_email,updated_at").order("updated_at", { ascending: false }).limit(300);
  if (error) throw error;
  const contributors = await communityService.getProfileSummaries((data || []).map((item) => item.updated_by_email));
  return Promise.all((data || []).map(async (item) => ({
    id: item.id,
    name: item.name,
    title: item.title,
    description: item.description || "",
    imageCount: Array.isArray(item.images) ? item.images.length : 0,
    version: await getCloudSceneVersion(supabase, normalizeSceneName(item.name)),
    updatedByEmail: item.updated_by_email,
    contributor: contributors[item.updated_by_email] || null,
    updatedAt: item.updated_at
  })));
};
const isStoredSceneImage = (value) => value && typeof value === "object" && value.storageBucket && value.storagePath;
const resolveSceneImages = async (images) => {
  const supabase = getSupabaseClient();
  const resolved = [];
  for (const image of images || []) {
    if (typeof image === "string" && /^https?:\/\//i.test(image)) {
      resolved.push(image);
      continue;
    }
    if (!isStoredSceneImage(image)) continue;
    try {
      const url = await routeAssetUrlFromDescriptor(supabase, image);
      if (url) resolved.push(url);
    } catch (error) {

      console.warn("跳过无法解析的景点图片:", image?.storagePath || "", error?.message || error);
    }
  }
  return resolved;
};
const toUserScene = async (item) => {
  const images = await resolveSceneImages(item.images || []);
  return {
    id: item.id,
    name: item.name,
    title: item.title,
    description: item.description || "",
    images,

    imageCount: images.length,
    sourceSceneId: item.source_scene_id || null,
    sourceVersion: Number(item.source_version || 0),
    createdAt: item.created_at,
    updatedAt: item.updated_at
  };
};
const listUserScenes = async (identity) => {
  const supabase = requireSupabaseClient();
  if (!identity?.email) throw new Error("\u7F3A\u5C11\u7528\u6237\u90AE\u7BB1\uFF0C\u65E0\u6CD5\u8BFB\u53D6\u4E2A\u4EBA\u666F\u70B9\u4ECB\u7ECD\u3002");
  const { data, error } = await supabase.from(SUPABASE_TABLES.userScenes).select("id,name,title,description,images,source_scene_id,source_version,created_at,updated_at").eq("owner_email", identity.email).order("updated_at", { ascending: false });
  if (error) throw error;
  return Promise.all((data || []).map(toUserScene));
};
const getUserSceneRow = async (supabase, sceneId, identity) => {
  if (!identity?.email) throw new Error("\u7F3A\u5C11\u7528\u6237\u90AE\u7BB1\uFF0C\u65E0\u6CD5\u8BFB\u53D6\u4E2A\u4EBA\u666F\u70B9\u4ECB\u7ECD\u3002");
  const id = String(sceneId || "").trim();
  if (!id) throw new Error("\u7F3A\u5C11\u4E2A\u4EBA\u666F\u70B9 ID\u3002");
  const { data, error } = await supabase.from(SUPABASE_TABLES.userScenes).select("owner_email,id,normalized_name,name,title,description,images,source_scene_id,source_version,created_at,updated_at").eq("owner_email", identity.email).eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) {
    const notFound = new Error("\u672A\u627E\u5230\u8FD9\u4EFD\u4E2A\u4EBA\u666F\u70B9\u4ECB\u7ECD\u3002");
    notFound.status = 404;
    throw notFound;
  }
  return data;
};
const uploadPrivateSceneImage = async (supabase, identity, normalizedName, buffer, options = {}) => {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const sha256 = sha256Buffer(data);
  const contentType = options.contentType || "image/jpeg";
  const ext = safeExt(options.fileName || "", contentType);
  const storageUserId = await getStorageUserId(identity.email);
  const storagePath = `users/${storageUserId}/scenes/${storageSafeSegment(normalizedName)}/${sha256}${ext}`;
  const { error } = await supabase.storage.from(PRIVATE_SCENE_IMAGE_BUCKET).upload(storagePath, data, { contentType, cacheControl: "31536000", upsert: false });
  if (error && !/exist|duplicate|already/i.test(error.message || "")) throw error;
  return {
    storageBucket: PRIVATE_SCENE_IMAGE_BUCKET,
    storagePath,
    sha256,
    size: data.length,
    contentType,
    fileName: options.fileName || `scene${ext}`
  };
};
const uploadPrivateSceneImages = async (supabase, identity, normalizedName, images) => {
  const parsed = (Array.isArray(images) ? images : [])
    .map((image) => dataUrlToImage(image))
    .filter(Boolean);
  return Promise.all(parsed.map((item) => uploadPrivateSceneImage(supabase, identity, normalizedName, item.buffer, {
    contentType: item.contentType,
    fileName: `${item.name}${item.ext}`
  })));
};

const sceneImageStorageKey = (value) => {
  if (!value) return "";
  if (isStoredSceneImage(value)) return `${value.storageBucket}/${value.storagePath}`;
  const text = String(value);
  const match = text.match(/\/storage\/v1\/object\/(?:sign|public|authenticated)\/([^?#]+)/i);
  if (match) return decodeURIComponent(match[1]).replace(/^\/+/, "");
  return text.split("?")[0];
};
const dedupeSceneImages = (images) => {
  const seen = new Set();
  const result = [];
  for (const image of images || []) {
    const key = sceneImageStorageKey(image);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(image);
  }
  return result;
};

const keepResolvableSceneImages = async (supabase, images) => {
  const result = [];
  for (const image of images || []) {
    if (!isStoredSceneImage(image)) {
      result.push(image);
      continue;
    }
    try {
      const url = await routeAssetUrlFromDescriptor(supabase, image);
      if (url) result.push(image);
    } catch (_) {}
  }
  return result;
};
const saveUserScene = async (payload, identity, options = {}) => {
  const supabase = requireSupabaseClient();
  if (!identity?.email) throw new Error("\u7F3A\u5C11\u7528\u6237\u90AE\u7BB1\uFF0C\u65E0\u6CD5\u4FDD\u5B58\u4E2A\u4EBA\u666F\u70B9\u4ECB\u7ECD\u3002");
  const name = String(payload?.name || payload?.title || "").trim();
  const normalized = normalizeSceneName(name);
  if (!normalized) throw new Error("\u666F\u70B9\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A\u3002");
  let query = supabase.from(SUPABASE_TABLES.userScenes).select("id,name,title,description,images,source_scene_id,source_version");
  if (payload?.id) query = query.eq("owner_email", identity.email).eq("id", String(payload.id));
  else query = query.eq("owner_email", identity.email).eq("normalized_name", normalized);
  const { data: existing, error: readError } = await query.maybeSingle();
  if (readError) throw readError;
  const existingImages = Array.isArray(existing?.images) ? existing.images : [];
  const existingKeys = new Set(existingImages.map(sceneImageStorageKey).filter(Boolean));
  const payloadImages = Array.isArray(payload?.images) ? payload.images : [];

  const urlImages = payloadImages.filter((image) => {
    if (typeof image !== "string" || !/^https?:\/\//i.test(image)) return false;
    return !existingKeys.has(sceneImageStorageKey(image));
  });
  const [uploaded, copiedPublic] = await Promise.all([
    uploadPrivateSceneImages(supabase, identity, normalized, payloadImages),
    urlImages.length ? copyPublicSceneImagesToPrivate(supabase, identity, normalized, urlImages) : Promise.resolve([])
  ]);
  const removedKeys = new Set((Array.isArray(payload?.removeImages) ? payload.removeImages : []).map(sceneImageStorageKey).filter(Boolean));
  const baseImages = Array.isArray(options.replaceImages) ? options.replaceImages : [...existingImages, ...copiedPublic, ...uploaded];
  const cleanedImages = await keepResolvableSceneImages(supabase, baseImages);
  const images = dedupeSceneImages(removedKeys.size
    ? cleanedImages.filter((image) => !removedKeys.has(sceneImageStorageKey(image)))
    : cleanedImages);
  const row = {
    owner_email: identity.email,
    ...existing?.id ? { id: existing.id } : {},
    normalized_name: normalized,
    name,
    title: String(payload?.title || name).trim() || name,
    description: String(payload?.description || "").trim(),
    images,
    source_scene_id: options.sourceSceneId ?? existing?.source_scene_id ?? null,
    source_version: options.sourceVersion ?? existing?.source_version ?? null,
    updated_at: (new Date()).toISOString()
  };
  const mutation = existing?.id ? supabase.from(SUPABASE_TABLES.userScenes).update(row).eq("owner_email", identity.email).eq("id", existing.id) : supabase.from(SUPABASE_TABLES.userScenes).upsert(row, { onConflict: "owner_email,normalized_name" });
  const { data, error } = await mutation.select("id,name,title,description,images,source_scene_id,source_version,created_at,updated_at").single();
  if (error) throw error;
  return { ok: true, scene: await toUserScene(data) };
};
const copyPublicSceneImagesToPrivate = async (supabase, identity, normalizedName, images) => {
  const copied = await Promise.all((images || []).map(async (source) => {
    if (!/^https?:\/\//i.test(String(source || ""))) return null;
    const buffer = await fetchAssetBuffer(source, 16 * 1024 * 1024);
    if (!buffer) return null;
    return uploadPrivateSceneImage(supabase, identity, normalizedName, buffer, {
      contentType: contentTypeForPath(new URL(source).pathname),
      fileName: path.basename(new URL(source).pathname) || "scene.jpg"
    });
  }));
  return copied.filter(Boolean);
};
const importCloudScene = async (name, identity) => {
  const supabase = requireSupabaseClient();
  const normalized = normalizeSceneName(name);
  if (!normalized) throw new Error("\u666F\u70B9\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A\u3002");
  const { data: scene, error } = await supabase.from(SUPABASE_TABLES.scenes).select("id,name,title,description,images").eq("normalized_name", normalized).maybeSingle();
  if (error) throw error;
  if (!scene) {
    const notFound = new Error("\u672A\u627E\u5230\u8FD9\u4EFD\u516C\u5171\u666F\u70B9\u4ECB\u7ECD\u3002");
    notFound.status = 404;
    throw notFound;
  }
  const version = await getCloudSceneVersion(supabase, normalized);
  const images = await copyPublicSceneImagesToPrivate(supabase, identity, normalized, scene.images || []);
  return saveUserScene({
    name: scene.name,
    title: scene.title,
    description: scene.description
  }, identity, { replaceImages: images, sourceSceneId: scene.id, sourceVersion: version });
};
const deleteUserScene = async (sceneId, identity) => {
  const supabase = requireSupabaseClient();
  const scene = await getUserSceneRow(supabase, sceneId, identity);
  const { error } = await supabase.from(SUPABASE_TABLES.userScenes).delete().eq("owner_email", identity.email).eq("id", scene.id);
  if (error) throw error;
  await removeRouteAssetDescriptors(supabase, (scene.images || []).filter(isStoredSceneImage));
  return { ok: true };
};
const deleteCloudScenic = async (name, identity) => {
  assertAdminIdentity(identity);
  const supabase = requireSupabaseClient();
  const normalized = normalizeSceneName(name);
  if (!normalized) throw new Error("\u666F\u70B9\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A\u3002");
  const { error } = await supabase.from(SUPABASE_TABLES.scenes).delete().eq("normalized_name", normalized);
  if (error) throw error;
  return { ok: true };
};
const readCloudConfig = async () => {
  const supabase = getSupabaseClient();
  if (!supabase) return null;
  const { data, error } = await supabase.from(SUPABASE_TABLES.settings).select("value").eq("key", "amap").maybeSingle();
  if (error) throw error;
  const saved = data?.value || {};
  return {
    key: String(saved.key || "").trim(),
    securityJsCode: String(saved.securityJsCode || "").trim(),
    source: data?.value ? "Supabase app settings" : null
  };
};
const writeCloudConfig = async ({ key, securityJsCode }, identity) => {
  const supabase = requireSupabaseClient();
  if (!isAdminIdentity(identity)) throw new Error("\u53EA\u6709\u7BA1\u7406\u5458\u53EF\u4EE5\u4FEE\u6539\u5730\u56FE\u914D\u7F6E\u3002");
  const { error } = await supabase.from(SUPABASE_TABLES.settings).upsert({
    key: "amap",
    value: { key, securityJsCode },
    updated_by_email: identity.email,
    updated_at: (new Date()).toISOString()
  }, { onConflict: "key" });
  if (error) throw error;
  return { ok: true, source: "Supabase app settings" };
};
const normalizeRouteNameKey = (value) => String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
const getPublishedRouteName = (name, existingNames = new Set()) => {
  const base = safeName(String(name || "").trim() || "\u672A\u547D\u540D\u8DEF\u7EBF");
  let candidate = `${base}-web`;
  let index = 2;
  while (existingNames.has(candidate.toLowerCase())) {
    candidate = `${base}-web-${index}`;
    index += 1;
  }
  return candidate;
};
const downloadRouteAssetDescriptor = async (supabase, descriptor) => {
  if (!descriptor) return null;
  if (descriptor.storageBucket && descriptor.storagePath) {
    const { data, error } = await supabase.storage.from(descriptor.storageBucket).download(descriptor.storagePath);
    if (error) throw error;
    return Buffer.from(await data.arrayBuffer());
  }
  return null;
};
const copyRouteAssetToBucket = async (supabase, descriptor, { bucket, prefix, key, fallbackFileName }) => {
  const buffer = await downloadRouteAssetDescriptor(supabase, descriptor);
  if (!buffer) return null;
  return uploadBufferToRouteAssets(supabase, {
    bucket,
    prefix,
    key,
    buffer,
    contentType: descriptor.contentType || contentTypeForPath(descriptor.fileName || fallbackFileName || key),
    fileName: descriptor.fileName || fallbackFileName || key
  });
};
const copyRouteAssetsToBucket = async (supabase, routeData, { bucket, prefix, routeName }) => {
  const descriptors = getRouteAssetDescriptors(routeData);
  const assets = {};
  try {
    for (const key of ["manualMd", "manualPdf", "videoData", "mp4", "mapImage"]) {
      const descriptor = descriptors[key];
      if (!descriptor) continue;
      const copied = await copyRouteAssetToBucket(supabase, descriptor, {
        bucket,
        prefix,
        key,
        fallbackFileName: routeAssetEntryName(routeName, key === "videoData" ? "mp4-data.json" : key)
      });
      if (copied) assets[key] = copied;
    }
    assets.routeJson = await uploadBufferToRouteAssets(supabase, {
      bucket,
      prefix,
      key: "routeJson",
      buffer: Buffer.from(JSON.stringify(toBasicRouteData(routeData), null, 2)),
      contentType: "application/json; charset=utf-8",
      fileName: routeAssetEntryName(routeName, "route.json")
    });
  } catch (error) {
    await removeRouteAssetDescriptors(supabase, Object.values(assets));
    throw error;
  }
  return withRouteAssets(routeData, assets);
};
const routeAssetStorageDescriptors = (routeData) => Object.values(getRouteAssetDescriptors(routeData)).filter((item) => item?.storageBucket && item?.storagePath);
const removeRouteAssetDescriptors = async (supabase, descriptors) => {
  const byBucket = new Map();
  for (const descriptor of descriptors || []) {
    if (!descriptor?.storageBucket || !descriptor?.storagePath) continue;
    if (!byBucket.has(descriptor.storageBucket)) byBucket.set(descriptor.storageBucket, []);
    byBucket.get(descriptor.storageBucket).push(descriptor.storagePath);
  }
  for (const [bucket, paths] of byBucket.entries()) {
    if (!paths.length) continue;
    await supabase.storage.from(bucket).remove([...new Set(paths)]).catch(() => {
    });
  }
};
const listPublishedRoutes = async () => {
  const supabase = getSupabaseClient();
  if (!supabase) return null;
  const { data, error } = await supabase.from(SUPABASE_TABLES.publishedRoutes).select("id,name,route_data,map_layer,published_by_email,source_route_id,source_owner_email,published_at,updated_at").order("published_at", { ascending: false });
  if (error) throw error;
  const contributors = await communityService.getProfileSummaries((data || []).map((item) => item.published_by_email));
  return Promise.all((data || []).map(async (item) => {
    const assetUrls = await resolveRouteAssetUrls(item.route_data);
    return {
      id: item.id,
      name: item.name,
      safeName: item.id,
      fileBase: item.id,
      archivedAt: item.published_at,
      updatedAt: item.updated_at,
      mapLayer: item.map_layer,
      routeJson: true,
      videoJson: Boolean(assetUrls.videoJson),
      mp4: Boolean(assetUrls.mp4),
      manualMd: Boolean(assetUrls.manualMd),
      manualPdf: Boolean(assetUrls.manualPdf),
      mapImage: Boolean(assetUrls.mapImage),
      productZip: Boolean(assetUrls.productZip),
      assetUrls,
      cloud: true,
      published: true,
      publishedByEmail: item.published_by_email,
      contributor: contributors[item.published_by_email] || null,
      sourceRouteId: item.source_route_id,
      sourceOwnerEmail: item.source_owner_email,
      routeData: item.route_data
    };
  }));
};
const publishCloudRoute = async (payload, identity) => {
  const supabase = requireSupabaseClient();
  if (!identity?.email) throw new Error("\u7F3A\u5C11\u7528\u6237\u90AE\u7BB1\uFF0C\u65E0\u6CD5\u53D1\u5E03\u8DEF\u7EBF\u3002");
  const routeData = validateRouteData(payload?.routeData || payload?.route);
  const name = String(routeData.name || "").trim();
  if (!name) throw new Error("\u8DEF\u7EBF\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A\u3002");
  const nameKey = normalizeRouteNameKey(name);
  const { data: existing, error: readError } = await supabase.from(SUPABASE_TABLES.publishedRoutes).select("id").eq("name_key", nameKey).maybeSingle();
  if (readError) throw readError;
  if (existing) {
    const error2 = new Error("\u8BE5\u540D\u79F0\u5DF2\u88AB\u5176\u4ED6\u4EBA\u53D1\u5E03\uFF0C\u8BF7\u6362\u4E00\u4E2A\u540D\u5B57\u3002");
    error2.status = 409;
    throw error2;
  }
  const publishedId = crypto.randomUUID();
  const prefix = `routes/${publishedId}`;
  let routeDataForPublish = routeData;
  try {
    const sourceId = normalizeCloudRouteId(routeData);
    const { data: ownRow } = await supabase.from(SUPABASE_TABLES.routes).select("route_data").eq("owner_email", identity.email).eq("id", sourceId).maybeSingle();
    if (ownRow?.route_data?._assets) {
      routeDataForPublish = withRouteAssets(routeData, ownRow.route_data._assets);
    }
  } catch (_) {
  }
  let publicRouteData = null;
  try {
    publicRouteData = await copyRouteAssetsToBucket(supabase, routeDataForPublish, {
      bucket: PUBLIC_ROUTE_ASSET_BUCKET,
      prefix,
      routeName: name
    });
    const zip = await uploadRouteProductZip(supabase, publicRouteData, {
      bucket: PUBLIC_ROUTE_ASSET_BUCKET,
      prefix,
      id: publishedId,
      name
    });
    publicRouteData = zip.routeData;
  } catch (error2) {
    await removeRouteAssetDescriptors(supabase, routeAssetStorageDescriptors(publicRouteData));
    throw error2;
  }
  const row = {
    id: publishedId,
    name,
    name_key: nameKey,
    published_by_email: identity.email,
    source_route_id: String(routeData.id || "").trim() || null,
    source_owner_email: identity.email,
    route_data: publicRouteData,
    map_layer: assertMapLayer(payload.mapLayer),
    published_at: (new Date()).toISOString(),
    updated_at: (new Date()).toISOString()
  };
  const { data, error } = await supabase.from(SUPABASE_TABLES.publishedRoutes).insert(row).select("id,name,published_at").single();
  if (error) {
    if (String(error.code || "") === "23505" || /duplicate/i.test(error.message || "")) {
      const conflict = new Error("\u8BE5\u540D\u79F0\u5DF2\u88AB\u5176\u4ED6\u4EBA\u53D1\u5E03\uFF0C\u8BF7\u6362\u4E00\u4E2A\u540D\u5B57\u3002");
      conflict.status = 409;
      throw conflict;
    }
    await removeRouteAssetDescriptors(supabase, routeAssetStorageDescriptors(publicRouteData));
    throw error;
  }
  await postCommunityMessageQuietly(`\u6211\u53D1\u5E03\u4E86\u8DEF\u7EBF\u300C${name}\u300D`, identity);
  const queued = Boolean(payload?.videoData);
  if (queued) {
    publishedRouteJobs.push({
      payload: {
        routeData,
        videoData: payload.videoData,
        mapLayer: payload.mapLayer,
        config: payload.config || {}
      },
      identity,
      publishedId,
      publishedName: name
    });
    setTimeout(pumpPublishedRouteJobs, 0);
  }
  return { ok: true, published: data, queued };
};
const importPublishedRoute = async (publishedId, identity) => {
  const supabase = requireSupabaseClient();
  if (!identity?.email) throw new Error("\u7F3A\u5C11\u7528\u6237\u90AE\u7BB1\uFF0C\u65E0\u6CD5\u5BFC\u5165\u8DEF\u7EBF\u3002");
  const id = String(publishedId || "").trim();
  if (!id) throw new Error("\u7F3A\u5C11\u516C\u5F00\u8DEF\u7EBF ID\u3002");
  const { data: published, error: readError } = await supabase.from(SUPABASE_TABLES.publishedRoutes).select("id,name,route_data,map_layer,published_by_email,source_route_id").eq("id", id).maybeSingle();
  if (readError) throw readError;
  if (!published) throw new Error("\u672A\u627E\u5230\u516C\u5F00\u8DEF\u7EBF\u3002");
  const routes = await listCloudRoutes(identity) || [];
  const existingNames = new Set(routes.map((item) => normalizeRouteNameKey(item?.name)));
  const importName = getPublishedRouteName(published.name, existingNames);
  const importId = `web-${published.id.slice(0, 8)}-${Date.now().toString(36)}`;
  let importedRoute = {
    ...published.route_data || {},
    id: importId,
    name: importName
  };
  const storageUserId = await getStorageUserId(identity.email);
  const prefix = `users/${storageUserId}/routes/${storageSafeSegment(importId)}`;
  try {
    importedRoute = await copyRouteAssetsToBucket(supabase, importedRoute, {
      bucket: PRIVATE_ROUTE_ASSET_BUCKET,
      prefix,
      routeName: importName
    });
    const zip = await uploadRouteProductZip(supabase, importedRoute, {
      bucket: PRIVATE_ROUTE_ASSET_BUCKET,
      prefix,
      id: `${identity.email}-${importId}`,
      name: importName
    });
    importedRoute = zip.routeData;
    const { data, error } = await supabase.from(SUPABASE_TABLES.routes).upsert({
      owner_email: identity.email,
      id: importId,
      name: importName,
      route_data: importedRoute,
      map_layer: published.map_layer || "standard",
      updated_at: (new Date()).toISOString()
    }, { onConflict: "owner_email,id" }).select("id,updated_at").single();
    if (error) throw error;
    return {
      ok: true,
      route: data,
      importedRoute,
      routeName: importName
    };
  } catch (error) {
    await removeRouteAssetDescriptors(supabase, routeAssetStorageDescriptors(importedRoute));
    throw error;
  }
};
const getCloudRouteForDownload = async (routeId, identity) => {
  const supabase = requireSupabaseClient();
  if (!identity?.email) throw new Error("\u7F3A\u5C11\u7528\u6237\u90AE\u7BB1\uFF0C\u65E0\u6CD5\u4E0B\u8F7D\u8DEF\u7EBF\u3002");
  const { data, error } = await supabase.from(SUPABASE_TABLES.routes).select("id,name,route_data").eq("owner_email", identity.email).eq("id", String(routeId || "").trim()).maybeSingle();
  if (error) throw error;
  if (!data) {
    const notFound = new Error("\u672A\u627E\u5230\u8FD9\u6761\u8DEF\u7EBF\u3002");
    notFound.status = 404;
    throw notFound;
  }
  return data;
};
const getAccountRoute = async (routeId, identity) => {
  const id = String(routeId || "").trim();
  if (!id) {
    const error = new Error("\u7F3A\u5C11\u8DEF\u7EBF ID\u3002");
    error.status = 400;
    throw error;
  }
  const supabase = getSupabaseClient();
  if (supabase && identity?.email) return getCloudRouteForDownload(id, identity);
  const item = listArchivedRoutes(getUserRouteRoot(identity)).find((candidate) => candidate.routeData?.id === id || candidate.safeName === id);
  if (!item?.routeData) {
    const error = new Error("\u672A\u627E\u5230\u8FD9\u6761\u8DEF\u7EBF\u3002");
    error.status = 404;
    throw error;
  }
  return {
    id: item.routeData.id || id,
    name: item.name,
    route_data: item.routeData,
    map_layer: item.mapLayer || "standard"
  };
};

const readAccountRoute = async (routeId, identity) => {
  const id = String(routeId || "").trim();
  if (!id) {
    const error = new Error("\u7F3A\u5C11\u8DEF\u7EBF ID\u3002");
    error.status = 400;
    throw error;
  }
  const supabase = getSupabaseClient();
  if (supabase && identity?.email) {
    const row = await getCloudRouteForDownload(id, identity);
    return {id: row.id || id, name: row.name || "", mapLayer: row.map_layer || "standard", routeData: row.route_data};
  }
  const root = getUserRouteRoot(identity);
  const safeDir = path.basename(id);
  const dir = path.join(root, safeDir);
  const routeJsonPath = fs.existsSync(dir) ? findRouteJson(dir, safeDir) : null;
  const routeData = routeJsonPath ? loadJson(routeJsonPath, null) : null;
  if (!routeData) {
    const error = new Error("\u672A\u627E\u5230\u8FD9\u6761\u8DEF\u7EBF\u3002");
    error.status = 404;
    throw error;
  }
  const metadata = loadJson(path.join(dir, "metadata.json"), {});
  return {
    id: routeData.id || id,
    name: routeData.name || "",
    mapLayer: metadata.mapLayer || routeData.presentation?.mapLayer || "standard",
    routeData
  };
};
const buildScriptVideoData = (routeData, mapLayer = "standard", override = null) => {
  if (override && typeof override === "object") return override;
  const colors = ["#1677ff", "#16a34a", "#f59e0b", "#a855f7", "#ef4444", "#06b6d4", "#64748b"];
  const days = (routeData?.days || []).map((day, dayIndex) => {
    const points = [day.from, ...day.waypoints || [], day.to].filter(hasPointCoordinates).map((point, pointIndex, all) => {
      const coord = point.coordSystem === "wgs84" ? wgs84ToGcj02(Number(point.lng), Number(point.lat)) : [Number(point.lng), Number(point.lat)];
      return {
      name: String(point.name || ""),
      lng: Number(coord[0]),
      lat: Number(coord[1]),
      role: pointIndex === 0 ? "\u8D77" : pointIndex === all.length - 1 ? "\u7EC8" : "",
      kind: pointIndex === 0 ? "from" : pointIndex === all.length - 1 ? "to" : "waypoint",
      transportMode: point.transportMode || "drive",
      labelOffset: point.labelOffset || { x: 0, y: 0 },
      scenic: point.useScenic === false ? null : point.scenic || null,
      ...Number.isFinite(Number(routeData.pointInfoCache?.days?.[dayIndex]?.points?.[pointIndex]?.elevationM)) ? { elevationM: Number(routeData.pointInfoCache.days[dayIndex].points[pointIndex].elevationM) } : {},
      ...routeData.pointInfoCache?.days?.[dayIndex]?.points?.[pointIndex]?.weather ? { weather: routeData.pointInfoCache.days[dayIndex].points[pointIndex].weather } : {}
      };
    });
    const cached = routeData.segmentCache?.[dayIndex]?.segments || [];
    const segments = points.slice(0, -1).map((from, index) => {
      const to = points[index + 1];
      const saved = cached[index] || {};
      const path2 = Array.isArray(saved.path) && saved.path.length >= 2 ? saved.path : [[from.lng, from.lat], [to.lng, to.lat]];
      return {
        from: from.name,
        to: to.name,
        mode: saved.mode || to.transportMode || "drive",
        distance: Number(saved.distance) || 0,
        duration: Number(saved.duration) || 0,
        path: path2,
        error: saved.error || ""
      };
    });
    return {
      title: day.title || `\u7B2C ${dayIndex + 1} \u5929`,
      color: colors[dayIndex % colors.length],
      points,
      segments
    };
  });
  const allPoints = days.flatMap((day) => day.points);
  const lngs = allPoints.map((point) => point.lng);
  const lats = allPoints.map((point) => point.lat);
  return {
    version: 2,
    exportedAt: (new Date()).toISOString(),
    mapLayer: routeData.presentation?.mapLayer || mapLayer,
    presentation: routeData.presentation || { mapLayer, hillshade: false, weather: false, elevation: false, startDate: null },
    renderSpeed: 1,
    route: { id: routeData.id, name: routeData.name || "\u81EA\u9A7E\u8DEF\u7EBF", description: String(routeData.description || "") },
    days,
    summary: {
      dayCount: days.length,
      totalDistance: days.reduce((sum, day) => sum + day.segments.reduce((value, segment) => value + segment.distance, 0), 0),
      totalDuration: days.reduce((sum, day) => sum + day.segments.reduce((value, segment) => value + segment.duration, 0), 0),
      bounds: lngs.length ? [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)] : [0, 0, 0, 0]
    }
  };
};
const routeGeoSignature = (day) => JSON.stringify(
  [day?.from, ...day?.waypoints || [], day?.to].map((point) => [
    String(point?.name || ""),
    Number(point?.lng).toFixed(6),
    Number(point?.lat).toFixed(6)
  ])
);
const prepareScriptPointInfo = async (routeData) => {
  const presentation = routeData?.presentation;
  if (!presentation?.weather && !presentation?.elevation) return routeData;
  try {
    const result = await pointInfoService.getPointInfo({
      startDate: presentation.startDate,
      weather: presentation.weather === true,
      elevation: presentation.elevation === true,
      days: (routeData.days || []).map((day) => ({
        points: [day.from, ...day.waypoints || [], day.to].filter(hasPointCoordinates).map((point) => ({ name: point.name, lng: Number(point.lng), lat: Number(point.lat) }))
      }))
    });
    routeData.pointInfoCache = routeData.pointInfoCache || { version: 1, days: {} };
    routeData.pointInfoCache.days = routeData.pointInfoCache.days || {};
    (result.days || []).forEach((dayInfo, dayIndex) => {
      routeData.pointInfoCache.days[dayIndex] = {
        geoSignature: routeGeoSignature(routeData.days[dayIndex]),
        date: dayInfo.date || null,
        weatherFetchedAt: presentation.weather ? (new Date()).toISOString() : null,
        points: dayInfo.points || []
      };
    });
    if (presentation.weather) {
      const complete = (result.days || []).every((dayInfo, dayIndex) => {
        const expected = [routeData.days[dayIndex]?.from, ...routeData.days[dayIndex]?.waypoints || [], routeData.days[dayIndex]?.to].filter(hasPointCoordinates).length;
        return expected === 0 || (dayInfo.points || []).slice(0, expected).every((info) => info?.weather);
      });
      if (!complete) presentation.weather = false;
    }
  } catch (_) {
    if (presentation.weather) presentation.weather = false;
  }
  return routeData;
};
const getRoutePointByPosition = (routeData, dayNumber, position) => {
  const dayIndex = Number(dayNumber) - 1;
  const day = routeData?.days?.[dayIndex];
  if (!day) {
    const error2 = new Error(`\u7B2C ${dayNumber} \u5929\u4E0D\u5B58\u5728\u3002`);
    error2.status = 400;
    throw error2;
  }
  const value = String(position || "").trim().toLowerCase();
  if (value === "from") return day.from;
  if (value === "to") return day.to;
  const match = value.match(/^waypoint:(\d+)$/);
  if (match) {
    const point = day.waypoints?.[Number(match[1]) - 1];
    if (point) return point;
  }
  const error = new Error("\u70B9\u4F4D\u4F4D\u7F6E\u65E0\u6548\uFF0C\u8BF7\u4F7F\u7528 from\u3001to \u6216 waypoint:1 \u8FD9\u6837\u7684\u683C\u5F0F\u3002");
  error.status = 400;
  throw error;
};
const patchRoutePoint = (routeData, payload = {}) => {
  const next = structuredClone(routeData);
  const point = getRoutePointByPosition(next, payload.day, payload.position);
  const source = payload.point && typeof payload.point === "object" ? payload.point : payload;
  ["name", "lng", "lat", "transportMode", "useScenic", "labelOffset"].forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(source, key)) point[key] = source[key];
  });
  return validateRouteData(next);
};
const getPublishedRouteForDownload = async (publishedId) => {
  const supabase = requireSupabaseClient();
  const { data, error } = await supabase.from(SUPABASE_TABLES.publishedRoutes).select("id,name,route_data").eq("id", String(publishedId || "").trim()).maybeSingle();
  if (error) throw error;
  if (!data) {
    const notFound = new Error("\u672A\u627E\u5230\u516C\u5F00\u8DEF\u7EBF\u3002");
    notFound.status = 404;
    throw notFound;
  }
  return data;
};
const sendZipDownload = async (res, row) => {
  const productZip = (await resolveRouteAssetUrls(row.route_data)).productZip;
  if (productZip) {
    res.writeHead(302, {
      Location: productZip,
      "Cache-Control": "no-store"
    });
    res.end();
    return;
  }
  const buffer = await buildRouteProductZip(row.route_data, { name: row.name });
  const fileName = encodeURIComponent(`${safeName(row.name || "route")}.product.zip`);
  res.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Length": buffer.length,
    "Content-Disposition": `attachment; filename*=UTF-8''${fileName}`,
    "Cache-Control": "no-store"
  });
  res.end(buffer);
};
const deletePublishedRoute = async (publishedId, identity) => {
  assertAdminIdentity(identity);
  const supabase = requireSupabaseClient();
  const id = String(publishedId || "").trim();
  if (!id) throw new Error("\u7F3A\u5C11\u516C\u5F00\u8DEF\u7EBF ID\u3002");
  const { data: existing, error: readError } = await supabase.from(SUPABASE_TABLES.publishedRoutes).select("route_data").eq("id", id).maybeSingle();
  if (readError) throw readError;
  const { error } = await supabase.from(SUPABASE_TABLES.publishedRoutes).delete().eq("id", id);
  if (error) throw error;
  await removeRouteAssetDescriptors(supabase, routeAssetStorageDescriptors(existing?.route_data).filter((descriptor) => descriptor.storageBucket === PUBLIC_ROUTE_ASSET_BUCKET));
  return { ok: true };
};
const getAdminSummary = async (identity) => {
  assertAdminIdentity(identity);
  const supabase = requireSupabaseClient();
  const [routesResult, userScenesResult, publishedResult, scenesResult] = await Promise.all([
    supabase.from(SUPABASE_TABLES.routes).select("owner_email,id,name,updated_at").order("updated_at", { ascending: false }).limit(1e3),
    supabase.from(SUPABASE_TABLES.userScenes).select("owner_email,id,name,updated_at").order("updated_at", { ascending: false }).limit(1e3),
    supabase.from(SUPABASE_TABLES.publishedRoutes).select("id,name,published_by_email,published_at,updated_at").order("published_at", { ascending: false }).limit(300),
    supabase.from(SUPABASE_TABLES.scenes).select("id,name,title,updated_by_email,updated_at").order("updated_at", { ascending: false }).limit(300)
  ]);
  for (const result of [routesResult, userScenesResult, publishedResult, scenesResult]) {
    if (result.error) throw result.error;
  }
  const contributorEmails = [
    ...(publishedResult.data || []).map((item) => item.published_by_email),
    ...(scenesResult.data || []).map((item) => item.updated_by_email),
    ...(routesResult.data || []).map((item) => item.owner_email),
    ...(userScenesResult.data || []).map((item) => item.owner_email)
  ];
  const contributors = await communityService.getProfileSummaries(contributorEmails);
  const users = new Map();
  (routesResult.data || []).forEach((item) => {
    const email = item.owner_email || "";
    if (!email) return;
    const current = users.get(email) || { email, routeCount: 0, sceneCount: 0, lastRouteAt: null, lastSceneAt: null };
    current.routeCount += 1;
    if (!current.lastRouteAt || String(item.updated_at || "") > current.lastRouteAt) current.lastRouteAt = item.updated_at;
    users.set(email, current);
  });
  (userScenesResult.data || []).forEach((item) => {
    const email = item.owner_email || "";
    if (!email) return;
    const current = users.get(email) || { email, routeCount: 0, sceneCount: 0, lastRouteAt: null, lastSceneAt: null };
    current.sceneCount += 1;
    if (!current.lastSceneAt || String(item.updated_at || "") > current.lastSceneAt) current.lastSceneAt = item.updated_at;
    users.set(email, current);
  });
  return {
    ok: true,
    users: [...users.values()].sort((a, b) => String(b.lastRouteAt || b.lastSceneAt || "").localeCompare(String(a.lastRouteAt || a.lastSceneAt || ""))),
    publishedRoutes: (publishedResult.data || []).map((item) => ({
      ...item,
      contributor: contributors[item.published_by_email] || null
    })),
    scenes: (scenesResult.data || []).map((item) => ({
      ...item,
      contributor: contributors[item.updated_by_email] || null
    }))
  };
};
const stripQuote = (value) => String(value || "").trim().replace(/^['"]|['"]$/g, "");
const readKeyFile = () => {
  const result = {};
  for (const file of KEY_CANDIDATES) {
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const m = line.match(/^([A-Za-z0-9_\u4e00-\u9fff]+)\s*=\s*(.*)$/);
      if (!m) continue;
      const k = m[1].trim();
      const v = stripQuote(m[2]);
      if (!v) continue;
      if ((/^AMAP_KEY$/i.test(k) || /^Key$/i.test(k) || k === "REMOTION_AMAP_KEY") && !result.key) result.key = v;
      if ((/^AMAP_SECURITY_JS_CODE$/i.test(k) || /^securityJsCode$/i.test(k) || /^SECURITY_JS_CODE$/i.test(k) || k === "\u5B89\u5168\u5BC6\u94A5" || k === "REMOTION_AMAP_SECURITY_CODE") && !result.securityJsCode) result.securityJsCode = v;
    }
  }
  return result;
};
const readAmapConfig = () => {
  const file = readKeyFile();
  return {
    key: file.key || String(process.env.AMAP_KEY || "").trim(),
    securityJsCode: file.securityJsCode || String(process.env.AMAP_SECURITY_JS_CODE || "").trim()
  };
};
const writeKeyFile = ({ key, securityJsCode }) => {
  ensureDir(CONFIG_ROOT);
  const target = path.join(CONFIG_ROOT, "local.env");
  const content = [
    "# Local private config (gitignored)",
    `# updated: ${(new Date()).toISOString()}`,
    `AMAP_KEY=${key || ""}`,
    `AMAP_SECURITY_JS_CODE=${securityJsCode || ""}`,
    `REMOTION_AMAP_KEY=${key || ""}`,
    `REMOTION_AMAP_SECURITY_CODE=${securityJsCode || ""}`,
    "AMAP_ROUTE_PORT=6137",
    ""
  ].join("\n");
  fs.writeFileSync(target, content, "utf8");
  return target;
};
const resolveBrowserPath = () => {
  if (process.env.AMAP_BROWSER_PATH && fs.existsSync(process.env.AMAP_BROWSER_PATH)) return process.env.AMAP_BROWSER_PATH;
  const remotionHome = path.join(os.homedir(), ".remotion", "chrome-headless-shell", "linux64", "chrome-headless-shell-linux64", "chrome-headless-shell");
  const candidates = [
    path.join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.PROGRAMFILES || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    remotionHome
  ];
  return candidates.find((item) => item && fs.existsSync(item)) || null;
};
let exportBrowserPromise = null;
const ensureExportBrowser = async () => {
  const existing = resolveBrowserPath();
  if (existing) return existing;
  if (!ensureRemotionBrowser) return null;
  if (!exportBrowserPromise) {
    exportBrowserPromise = ensureRemotionBrowser({
      browserExecutable: null,
      chromeMode: "headless-shell",
      logLevel: "error"
    }).then((status) => status?.path || null).catch((error) => {
      exportBrowserPromise = null;
      throw new Error(`\u65E0\u6CD5\u51C6\u5907 Remotion \u6D4F\u89C8\u5668\uFF1A${error.message}`);
    });
  }
  return exportBrowserPromise;
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SNAPSHOT_DIR = path.join(DATA_ROOT, "snapshots");
const writeRouteSnapshot = (token, payload) => {
  ensureDir(SNAPSHOT_DIR);
  const days = payload?.videoData?.days || [];
  const segmentResults = days.map((day) => ({
    from: day.from,
    to: day.to,
    waypoints: day.waypoints || [],
    segments: (day.segments || []).map((seg) => ({
      from: seg.from,
      to: seg.to,
      distance: Number(seg.distance) || 0,
      duration: Number(seg.duration) || 0,
      path: Array.isArray(seg.path) ? seg.path : []
    }))
  }));
  const file = path.join(SNAPSHOT_DIR, `${token}.json`);
  const route = {
    ...payload.routeData,
    presentation: {
      ...(payload.routeData?.presentation || {}),
      ...(payload.videoData?.presentation || {})
    }
  };
  writeFileAtomic(file, JSON.stringify({ route, segmentResults, updatedAt: Date.now() }));
  return file;
};
const readRouteSnapshot = (token) => {
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(token)) return null;
  const file = path.join(SNAPSHOT_DIR, `${token}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return null; }
};
const cleanupRouteSnapshot = (token) => {
  if (!token) return;
  try { fs.rmSync(path.join(SNAPSHOT_DIR, `${token}.json`), { force: true }); } catch (_) {}
};
const cdpJson = async (port, endpoint, method = "GET") => {
  const res = await fetch(`http://127.0.0.1:${port}${endpoint}`, { method });
  if (!res.ok) throw new Error(`CDP ${endpoint} ${res.status}`);
  return res.json();
};
const captureMapSnapshot = async ({ url, output, headers = {} }) => {
  const browserExecutable = await ensureExportBrowser();
  if (!browserExecutable) throw new Error("\u6CA1\u6709\u53EF\u7528\u7684\u6D4F\u89C8\u5668");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rtp-snap-"));
  const port = 9400 + Math.floor(Math.random() * 800);
  const chrome = spawn(browserExecutable, [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${tmpDir}`,
    "--window-size=1920,1080",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "about:blank"
  ], { stdio: "ignore" });
  let ws = null;
  try {
    let ready = false;
    for (let i = 0; i < 80 && !ready; i++) {
      try { await cdpJson(port, "/json/version"); ready = true; } catch (_) { await delay(500); }
    }
    if (!ready) throw new Error("Chrome \u672A\u5C31\u7EEA");
    const target = await cdpJson(port, `/json/new?about:blank`, "PUT");
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let msgId = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === "Fetch.requestPaused") {
        const original = msg.params.request.headers;
        const extra = Object.keys(headers).map((name) => ({name, value: String(headers[name])}));
        send("Fetch.continueRequest", {requestId: msg.params.requestId,
          headers: [...Object.entries(original).map(([name, value]) => ({name, value: String(value)})), ...extra]
        }).catch(() => {});
        return;
      }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++msgId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Network.enable");
    await send("Fetch.enable", {patterns: [{urlPattern: `${new URL(url).origin}/*`}]});
    await send("Page.navigate", {url});
    let snapshotReady = false;
    for (let i = 0; i < 120 && !snapshotReady; i++) {
      const r = await send("Runtime.evaluate", { expression: "window.__snapshotReady === true", returnByValue: true });
      if (r?.result?.value) snapshotReady = true;
      else await delay(500);
    }
    if (!snapshotReady) throw new Error("\u5FEB\u7167\u9875\u9762\u672A\u5C31\u7EEA\uFF08\u8D85\u65F6 60s\uFF09");
    await delay(1600);
    const rect = await send("Runtime.evaluate", {
      expression: "(()=>{const el=document.querySelector('#map');if(!el)return null;const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};})()",
      returnByValue: true
    });
    const box = rect?.result?.value;
    if (!box || !box.width || !box.height) throw new Error("\u672A\u627E\u5230\u5730\u56FE\u5BB9\u5668");
    const shot = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
      clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 2 }
    });
    if (!shot?.data) throw new Error("\u622A\u56FE\u5931\u8D25");
    writeFileAtomic(output, Buffer.from(shot.data, "base64"));
    return true;
  } finally {
    try { ws?.close(); } catch (_) {}
    try { chrome.kill(); } catch (_) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
};
const requestJson = (method, url, body = null) => new Promise((resolve, reject) => {
  const target = new URL(url);
  const req = http.request(
    {
      method,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`
    },
    (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        text += chunk;
      });
      res.on("end", () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} ${text}`.trim()));
          return;
        }
        try {
          resolve(text ? JSON.parse(text) : {});
        } catch (error) {
          reject(error);
        }
      });
    }
  );
  req.on("error", reject);
  if (body) req.write(JSON.stringify(body));
  req.end();
});
const getFreePort = () => new Promise((resolve, reject) => {
  const server2 = http.createServer();
  server2.on("error", reject);
  server2.listen(0, "127.0.0.1", () => {
    const address = server2.address();
    const port = typeof address === "object" && address ? address.port : null;
    server2.close(() => {
      if (!port) reject(new Error("\u65E0\u6CD5\u5206\u914D\u4E34\u65F6\u7AEF\u53E3"));
      else resolve(port);
    });
  });
});
const openCdpSession = async (wsUrl) => {
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("\u6D4F\u89C8\u5668 CDP \u8FDE\u63A5\u8D85\u65F6")), 1e4);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener("error", (event) => {
      clearTimeout(timer);
      reject(event.error || new Error("\u6D4F\u89C8\u5668 CDP \u8FDE\u63A5\u5931\u8D25"));
    });
  });
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener("message", (event) => {
    const data = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8");
    let message = null;
    try {
      message = JSON.parse(data);
    } catch (_) {
      return;
    }
    if (message.id) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message || "CDP \u8C03\u7528\u5931\u8D25"));
      else entry.resolve(message.result);
      return;
    }
    const handlers = listeners.get(message.method);
    if (handlers) {
      handlers.forEach((handler) => handler(message.params || {}));
    }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const waitFor = (method, timeout = 15e3) => new Promise((resolve, reject) => {
    const handler = (params) => {
      cleanup();
      resolve(params);
    };
    const cleanup = () => {
      clearTimeout(timer);
      const list2 = listeners.get(method) || [];
      listeners.set(method, list2.filter((item) => item !== handler));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`\u7B49\u5F85 ${method} \u8D85\u65F6`));
    }, timeout);
    const list = listeners.get(method) || [];
    list.push(handler);
    listeners.set(method, list);
  });
  return {
    call,
    waitFor,
    close: () => socket.close()
  };
};
const MANUAL_PDF_MAX_BYTES = 8 * 1024 * 1024;
const MANUAL_PHOTO_PROFILES = {
  normal: {width: 1280, quality: 70},
  aggressive: {width: 980, quality: 58}
};
const MANUAL_MAP_MAX_WIDTH = 1600;
const readLocalAssetBuffer = (src) => {
  try {
    const pathname = decodeURIComponent(new URL(src).pathname).replace(/^\/([A-Za-z]:)/, "$1");
    return fs.readFileSync(pathname);
  } catch (_) {
    return null;
  }
};
const readRemoteAssetBuffer = async (src) => {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(src, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (attempt === 3) return null;
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    }
  }
  return null;
};
const compressManualImage = async (buffer, options = {}) => {
  if (!sharpLib) return null;
  try {
    const image = sharpLib(buffer);
    const meta = await image.metadata();
    if (!meta.width) return null;
    const resized = options.keepPng
      ? await image.resize({ width: options.width, withoutEnlargement: true }).png({ compressionLevel: 9, palette: true, quality: 88 }).toBuffer()
      : await image.resize({ width: options.width, withoutEnlargement: true }).jpeg({ quality: options.quality, mozjpeg: true }).toBuffer();
    return { buffer: resized, mime: options.keepPng ? "image/png" : "image/jpeg" };
  } catch (_) {
    return null;
  }
};
const inlineManualImages = async (html, options = {}) => {
  const keepNames = (options.keep || []).filter(Boolean);
  const sources = [...new Set([...String(html).matchAll(/src="([^"]+)"/g)].map((match) => match[1]))].filter((src) => /^(file:|https?:)/i.test(src));
  if (!sources.length) return html;
  const photoProfile = MANUAL_PHOTO_PROFILES[options.profile] || MANUAL_PHOTO_PROFILES.normal;
  const replacements = new Map();
  for (const src of sources) {
    const name = (src.split("?")[0].split("/").pop() || "").trim();
    const isMap = keepNames.some((keep) => name === keep);
    const raw = /^https?:/i.test(src) ? await readRemoteAssetBuffer(src) : readLocalAssetBuffer(src);
    if (!raw || !raw.length) continue;
    const compressed = await compressManualImage(raw, {
      keepPng: isMap,
      width: isMap ? MANUAL_MAP_MAX_WIDTH : photoProfile.width,
      quality: photoProfile.quality
    });
    if (!compressed || compressed.buffer.length >= raw.length * 0.92) continue;
    replacements.set(src, `data:${compressed.mime};base64,${compressed.buffer.toString("base64")}`);
  }
  let next = html;
  for (const [from, to] of replacements) next = next.split(from).join(to);
  return next;
};
const renderMarkdownPdf = async (markdown, pdfPath, title, baseDir = AMAP_ROOT, options = {}) => {
  const browserPath = await ensureExportBrowser();
  if (!browserPath) throw new Error("\u672A\u627E\u5230 Chrome/Edge\uFF0C\u65E0\u6CD5\u5C06 Markdown \u6E32\u67D3\u4E3A PDF");
  ensureDir(path.dirname(pdfPath));
  const profile = options.profile === "aggressive" ? "aggressive" : "normal";
  const html = await inlineManualImages(markdownToHtmlDocument(markdown, title, baseDir), { keep: options.keep, profile });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "amap-travel-pdf-"));
  const htmlPath = path.join(tempDir, "manual.html");
  const profileDir = path.join(tempDir, "profile");
  ensureDir(profileDir);
  fs.writeFileSync(htmlPath, html, "utf8");
  const fileUrl = "file:///" + htmlPath.replace(/\\/g, "/");
  const debugPort = await getFreePort();
  const linuxArgs = process.platform === "linux" ? ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] : [];
  const args = [...linuxArgs, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profileDir}`, `--remote-debugging-port=${debugPort}`, "about:blank"];
  let child = null;
  try {
    await new Promise((resolve, reject) => {
      child = spawn(browserPath, args, { windowsHide: true });
      trackChildProcess(child);
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.once("error", reject);
      (async () => {
        try {
          const versionUrl = `http://127.0.0.1:${debugPort}/json/version`;
          let version = null;
          for (let attempt = 0; attempt < 60; attempt++) {
            try {
              version = await requestJson("GET", versionUrl);
              break;
            } catch (_) {
              await delay(250);
            }
          }
          if (!version?.webSocketDebuggerUrl) throw new Error("\u65E0\u6CD5\u8FDE\u63A5\u6D4F\u89C8\u5668\u8C03\u8BD5\u7AEF\u53E3");
          const page = await requestJson("PUT", `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent("about:blank")}`);
          if (!page?.webSocketDebuggerUrl) throw new Error("\u65E0\u6CD5\u521B\u5EFA PDF \u9875\u9762");
          const cdp = await openCdpSession(page.webSocketDebuggerUrl);
          await cdp.call("Page.enable");
          const loadEvent = cdp.waitFor("Page.loadEventFired");
          await cdp.call("Page.navigate", { url: fileUrl });
          await loadEvent;
          await delay(300);
          const pdf = await cdp.call("Page.printToPDF", {
            printBackground: true,
            preferCSSPageSize: true,
            displayHeaderFooter: true,
            headerTemplate: "<span></span>",
            footerTemplate: '<div style="width:100%; font-size:12px; color:#4b5563; padding:0 16mm; text-align:center;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
            marginTop: 0.2,
            marginBottom: 0.45,
            marginLeft: 0,
            marginRight: 0
          });
          fs.writeFileSync(pdfPath, Buffer.from(pdf.data, "base64"));
          cdp.close();
          await requestJson("GET", `http://127.0.0.1:${debugPort}/json/close/${page.id}`).catch(() => {
          });
          child?.kill();
          resolve();
        } catch (error) {
          child?.kill();
          reject(error);
        }
      })();
      child.on("close", (code) => {
        if (activeExport?.cancelled) {
          reject(new ExportCancelledError());
          return;
        }
        if (code !== 0 && !fs.existsSync(pdfPath)) {
          reject(new Error(`\u6D4F\u89C8\u5668\u6253\u5370 PDF \u5931\u8D25\uFF08\u9000\u51FA\u7801 ${code}\uFF09${stderr ? "\uFF1A" + stderr.trim() : ""}`));
        }
      });
    });
    const produced = fs.existsSync(pdfPath) ? fs.statSync(pdfPath).size : 0;
    if (produced > MANUAL_PDF_MAX_BYTES && profile !== "aggressive") {
      if (child && !child.killed) {
        try {
          child.kill();
        } catch (_) {
        }
      }
      return await renderMarkdownPdf(markdown, pdfPath, title, baseDir, { ...options, keep: options.keep, profile: "aggressive" });
    }
    return pdfPath;
  } finally {
    if (child && !child.killed) {
      try {
        child.kill();
      } catch (_) {
      }
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {
    }
  }
};
const archivePayload = (payload, routeRoot, identity) => {
  const routeName = getRouteName(payload);
  const name = safeName(routeName);
  const dir = path.join(routeRoot, name);
  ensureDir(dir);
  const routeData = payload.routeData || null;
  const videoData = payload.videoData || null;
  const routeMapImage = path.join(dir, `${name}.route-map.png`);
  const mapBgImage = path.join(dir, `${name}.map-bg.png`);
  const mapBgMeta = path.join(dir, `${name}.map-bg.json`);
  const now = (new Date()).toISOString();
  let manualMd = null;
  let manualText = "";
  for (const file of [
    path.join(dir, `${name}.mp4`),
    path.join(dir, `${name}.render.mp4`),
    path.join(dir, `${name}.route-map.png`),
    path.join(dir, `${name}.travel.md`),
    path.join(dir, `${name}.travel.pdf`),
    path.join(dir, `${name}.mp4-data.json`),
    path.join(dir, `${name}.route.json`)
  ]) {
    try {
      fs.rmSync(file, { force: true });
    } catch (_) {
    }
  }
  if (routeData) writeFileAtomic(path.join(dir, `${name}.route.json`), JSON.stringify(toBasicRouteData(routeData), null, 2));
  if (videoData) {
    writeFileAtomic(path.join(dir, `${name}.mp4-data.json`), JSON.stringify(videoData, null, 2));
    manualText = buildTravelManual(videoData, routeData, { outputDir: dir, routeMapImage: path.basename(routeMapImage) });
    manualMd = path.join(dir, `${name}.travel.md`);
    writeFileAtomic(manualMd, manualText);
  }
  writeFileAtomic(
    path.join(dir, "metadata.json"),
    JSON.stringify(
      {
        routeName,
        safeName: name,
        archivedAt: now,
        mapLayer: videoData?.mapLayer || payload.mapLayer || null,
        ownerEmail: identity?.email || null
      },
      null,
      2
    )
  );
  return {
    routeName,
    safeName: name,
    dir,
    routeJson: path.join(dir, `${name}.route.json`),
    videoJson: path.join(dir, `${name}.mp4-data.json`),
    routeMapImage,
    mapBgImage,
    mapBgMeta,
    manualMd,
    manualText
  };
};
const REMOTION_RENDER_ATTEMPTS = 2;
const REMOTION_RETRY_DELAY_MS = 20000;
const TRANSIENT_RENDER_PATTERN = /delayRender|Timed out|timeout|net::|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|HTTP \d{3}/i;
const runRemotionOnce = async ({ videoData, output, config, logFile, progressStart = 24, progressEnd = 78, attempt }) => {
  assertExportNotCancelled();
  ensureDir(path.dirname(output));
  const keys = readKeyFile();
  const prepared = await prepareRemotionPublicDir(videoData);
  const publicDir = prepared.publicDir;
  ensureDir(path.dirname(REMOTION_DATA));
  fs.writeFileSync(REMOTION_DATA, JSON.stringify(prepared.videoData, null, 2), "utf8");
  const env = {
    ...process.env,
    REMOTION_PUBLIC_DIR: publicDir,
    REMOTION_AMAP_KEY: config?.key || keys.key || process.env.REMOTION_AMAP_KEY || "",
    REMOTION_AMAP_SECURITY_CODE: config?.securityJsCode || keys.securityJsCode || process.env.REMOTION_AMAP_SECURITY_CODE || "",
    REMOTION_ROUTE_WIDTH: REMOTION_WIDTH,
    REMOTION_ROUTE_HEIGHT: REMOTION_HEIGHT,
    REMOTION_ROUTE_FPS: REMOTION_FPS
  };
  const browserExecutable = resolveBrowserPath();
  const remotionCli = resolveNodeModuleFile("@remotion", "cli", "remotion-cli.js");
  const remotionArgs = fs.existsSync(remotionCli) ? [remotionCli, "render", "src/index.ts", "AmapRouteVideo", output, "--codec=h264", "--pixel-format=yuv420p", `--crf=${REMOTION_CRF}`, "--timeout=300000", `--concurrency=${REMOTION_CONCURRENCY}`, "--gl=angle"] : ["remotion", "render", "src/index.ts", "AmapRouteVideo", output, "--codec=h264", "--pixel-format=yuv420p", `--crf=${REMOTION_CRF}`, "--timeout=300000", `--concurrency=${REMOTION_CONCURRENCY}`, "--gl=angle"];
  if (browserExecutable) remotionArgs.push(`--browser-executable=${browserExecutable}`);
  const command = fs.existsSync(remotionCli) ? process.execPath : process.platform === "win32" ? "cmd.exe" : "npx";
  const args = fs.existsSync(remotionCli) ? remotionArgs : process.platform === "win32" ? ["/d", "/s", "/c", "npx", ...remotionArgs] : remotionArgs;
  const logs = [];
  let progressTail = "";
  const header = `\u5F00\u59CB\u6E32\u67D3\uFF08\u7B2C ${attempt} \u6B21\uFF09\uFF1A${(new Date()).toLocaleString()}
\u8F93\u51FA\uFF1A${output}
\u6D4F\u89C8\u5668\uFF1A${browserExecutable || "Remotion \u9ED8\u8BA4"}
Public\uFF1A${publicDir}
\u672C\u5730\u5316\u7D20\u6750\uFF1A${prepared.localized}\uFF0C\u4E0B\u8F7D\u5931\u8D25\uFF1A${prepared.failures.length}${prepared.failures.length ? `\n${prepared.failures.join("\n")}` : ""}

`;
  fs.writeFileSync(logFile, header, "utf8");
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { cwd: REMOTION_ROOT, env, windowsHide: true });
    } catch (error) {
      cleanupTempDir(publicDir);
      reject(error);
      return;
    }
    trackChildProcess(child);
    const pushLog = (chunk) => {
      const text = chunk.toString();
      logs.push(text);
      fs.appendFileSync(logFile, text, "utf8");
      progressTail = (progressTail + text).slice(-600);
      updateProgressFromRemotionLog(progressTail, progressStart, progressEnd, "mp4", "\u6B63\u5728\u6E32\u67D3 MP4\u2026");
    };
    child.stdout.on("data", pushLog);
    child.stderr.on("data", pushLog);
    child.on("error", (error) => {
      cleanupTempDir(publicDir);
      reject(error);
    });
    child.on("close", (code) => {
      cleanupTempDir(publicDir);
      if (activeExport?.cancelled) {
        reject(new ExportCancelledError());
        return;
      }
      if (code === 0) {
        resolve({ output, log: logs.join("") });
        return;
      }
      const error = new Error(`Remotion \u6E32\u67D3\u5931\u8D25\uFF0C\u9000\u51FA\u7801 ${code}\u3002\u8BF7\u67E5\u770B\u65E5\u5FD7\uFF1A${logFile}`);
      error.transient = TRANSIENT_RENDER_PATTERN.test(logs.join("").slice(-4000));
      reject(error);
    });
  });
};
const runRemotion = async (options) => {
  let lastError = null;
  for (let attempt = 1; attempt <= REMOTION_RENDER_ATTEMPTS; attempt += 1) {
    try {
      return await runRemotionOnce({ ...options, attempt });
    } catch (error) {
      if (error instanceof ExportCancelledError) throw error;
      lastError = error;
      const canRetry = attempt < REMOTION_RENDER_ATTEMPTS && error.transient !== false;
      if (!canRetry) break;
      fs.appendFileSync(options.logFile, `\n\u6E32\u67D3\u4E2D\u65AD\uFF0C${Math.round(REMOTION_RETRY_DELAY_MS / 1000)} \u79D2\u540E\u81EA\u52A8\u91CD\u8BD5\uFF08${attempt + 1}/${REMOTION_RENDER_ATTEMPTS}\uFF09\u2026\n`, "utf8");
      await new Promise((resolve) => setTimeout(resolve, REMOTION_RETRY_DELAY_MS));
      assertExportNotCancelled();
    }
  }
  throw lastError;
};
const runFfmpegFaststart = ({ input, output, logFile }) => new Promise((resolve, reject) => {
  const args = ["-y", "-i", input, "-map", "0", "-c", "copy", "-movflags", "+faststart", output];
  fs.appendFileSync(logFile, `
\u5F00\u59CB MP4 faststart\uFF1A${(new Date()).toLocaleString()}
ffmpeg ${args.join(" ")}

`, "utf8");
  const child = spawn("ffmpeg", args, { windowsHide: true });
  trackChildProcess(child);
  const logs = [];
  const pushLog = (chunk) => {
    const text = chunk.toString();
    logs.push(text);
    fs.appendFileSync(logFile, text, "utf8");
  };
  child.stdout.on("data", pushLog);
  child.stderr.on("data", pushLog);
  child.on("error", (error) => reject(new Error(`FFmpeg faststart \u5931\u8D25\uFF1A${error.message}`)));
  child.on("close", (code) => {
    if (code === 0 && fs.existsSync(output)) resolve({ output, log: logs.join("") });
    else reject(new Error(`FFmpeg faststart \u5931\u8D25\uFF0C\u4FDD\u7559 Remotion \u539F\u59CB\u6587\u4EF6\uFF1A${input}`));
  });
});
const probeVideoBitrate = (file) => new Promise((resolve) => {
  if (!file || !fs.existsSync(file)) return resolve(null);
  const child = spawn("ffprobe", ["-v", "error", "-show_entries", "format=bit_rate", "-of", "default=noprint_wrappers=1:nokey=1", file], { windowsHide: true });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.on("error", () => resolve(null));
  child.on("close", () => {
    const bitRate = Number(stdout.trim());
    resolve(Number.isFinite(bitRate) && bitRate > 0 ? bitRate : null);
  });
});
const overviewCanvasPlan = (videoData, longEdge = OVERVIEW_LONG_EDGE, scale = OVERVIEW_SCALE) => {
  const width = longEdge;
  const height = Math.round((longEdge * 9) / 16);
  return { width: Math.max(2, Math.round(width)), height: Math.max(2, Math.round(height)), scale };
};
const runRemotionStill = async ({ videoData, output, config, logFile, frame = 12, progressStart = 82, progressEnd = 90, width = REMOTION_WIDTH, height = REMOTION_HEIGHT, scale = 1 }) => {
  assertExportNotCancelled();
  ensureDir(path.dirname(output));
  const keys = readKeyFile();
  const prepared = await prepareRemotionPublicDir(videoData);
  const publicDir = prepared.publicDir;
  ensureDir(path.dirname(REMOTION_DATA));
  fs.writeFileSync(REMOTION_DATA, JSON.stringify(prepared.videoData, null, 2), "utf8");
  const env = {
    ...process.env,
    REMOTION_PUBLIC_DIR: publicDir,
    REMOTION_AMAP_KEY: config?.key || keys.key || process.env.REMOTION_AMAP_KEY || "",
    REMOTION_AMAP_SECURITY_CODE: config?.securityJsCode || keys.securityJsCode || process.env.REMOTION_AMAP_SECURITY_CODE || "",
    REMOTION_ROUTE_WIDTH: width,
    REMOTION_ROUTE_HEIGHT: height,
    REMOTION_ROUTE_FPS: REMOTION_FPS
  };
  const browserExecutable = resolveBrowserPath();
  const remotionCli = resolveNodeModuleFile("@remotion", "cli", "remotion-cli.js");
  const remotionArgs = fs.existsSync(remotionCli) ? [remotionCli, "still", "src/index.ts", "AmapRouteVideo", output, `--frame=${frame}`, "--timeout=300000"] : ["remotion", "still", "src/index.ts", "AmapRouteVideo", output, `--frame=${frame}`, "--timeout=300000"];
  if (browserExecutable) remotionArgs.push(`--browser-executable=${browserExecutable}`);
  if (Number(scale) > 1) remotionArgs.push(`--scale=${Number(scale)}`);
  const command = fs.existsSync(remotionCli) ? process.execPath : process.platform === "win32" ? "cmd.exe" : "npx";
  const args = fs.existsSync(remotionCli) ? remotionArgs : process.platform === "win32" ? ["/d", "/s", "/c", "npx", ...remotionArgs] : remotionArgs;
  const child = spawn(command, args, { cwd: REMOTION_ROOT, env, windowsHide: true });
  trackChildProcess(child);
  const logs = [];
  const pushLog = (chunk) => {
    const text = chunk.toString();
    logs.push(text);
    fs.appendFileSync(logFile, text, "utf8");
    updateProgressFromLog(text, progressStart, progressEnd, "map", "\u6B63\u5728\u751F\u6210\u8DEF\u7EBF\u56FE\u7247\u2026");
  };
  fs.appendFileSync(logFile, `
\u5F00\u59CB\u6E32\u67D3\u8DEF\u7EBF\u603B\u89C8\u56FE\uFF1A${(new Date()).toLocaleString()}
\u8F93\u51FA\uFF1A${output}
\u6D4F\u89C8\u5668\uFF1A${browserExecutable || "Remotion \u9ED8\u8BA4"}
Public\uFF1A${publicDir}

`, "utf8");
  child.stdout.on("data", pushLog);
  child.stderr.on("data", pushLog);
  return new Promise((resolve, reject) => {
    child.on("error", (error) => {
      cleanupTempDir(publicDir);
      reject(error);
    });
    child.on("close", (code) => {
      cleanupTempDir(publicDir);
      if (activeExport?.cancelled) {
        reject(new ExportCancelledError());
        return;
      }
      if (code === 0 && fs.existsSync(output)) resolve({ output, log: logs.join("") });
      else reject(new Error(`Remotion \u603B\u89C8\u56FE\u6E32\u67D3\u5931\u8D25\uFF0C\u9000\u51FA\u7801 ${code}\u3002\u8BF7\u67E5\u770B\u65E5\u5FD7\uFF1A${logFile}`));
    });
  });
};
const findRouteJson = (dir, entryName) => {
  const preferred = path.join(dir, `${entryName}.route.json`);
  if (fs.existsSync(preferred)) return preferred;
  const hit = fs.readdirSync(dir).find((name) => name.toLowerCase().endsWith(".route.json"));
  return hit ? path.join(dir, hit) : null;
};
const existingFile = (...files) => files.find((file) => fs.existsSync(file)) || null;
const latestMtimeIso = (files, fallback) => files.filter(Boolean).filter((file) => fs.existsSync(file)).map((file) => fs.statSync(file).mtime).reduce((latest, mtime) => mtime > latest ? mtime : latest, fallback).toISOString();
const summarizeRouteData = (routeData) => {
  const days = Array.isArray(routeData?.days) ? routeData.days : [];
  const pointCount = days.reduce((sum, day) => {
    const points = [day?.from, ...(Array.isArray(day?.waypoints) ? day.waypoints : []), day?.to].filter(Boolean);
    return sum + points.length;
  }, 0);
  return {
    id: String(routeData?.id || ""),
    name: String(routeData?.name || ""),
    description: String(routeData?.description || "").slice(0, 300),
    dayCount: days.length,
    pointCount
  };
};

const readRouteSummary = (dir, routeJsonPath) => {
  const cachePath = path.join(dir, ".route-summary.json");
  try {
    const routeStat = fs.statSync(routeJsonPath);
    if (fs.existsSync(cachePath) && fs.statSync(cachePath).mtimeMs >= routeStat.mtimeMs) {
      const cached = loadJson(cachePath, null);
      if (cached && cached.dayCount != null) return cached;
    }
    const routeData = loadJson(routeJsonPath, null);
    if (!routeData) return null;
    const summary = summarizeRouteData(routeData);
    try {
      writeFileAtomic(cachePath, JSON.stringify(summary));
    } catch (_) {
    }
    return summary;
  } catch (_) {
    return null;
  }
};
const listArchivedRoutes = (routeRoot, { withData = true } = {}) => {
  if (!fs.existsSync(routeRoot)) return [];
  return fs.readdirSync(routeRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => {
    const dir = path.join(routeRoot, entry.name);
    const metadata = loadJson(path.join(dir, "metadata.json"), {});
    const routeJsonPath = findRouteJson(dir, entry.name);
    const routeData = routeJsonPath && withData ? loadJson(routeJsonPath, null) : null;
    const summary = routeJsonPath && !withData ? readRouteSummary(dir, routeJsonPath) : null;
    const stat = fs.statSync(dir);
    const baseName = routeJsonPath ? path.basename(routeJsonPath, ".route.json") : entry.name;
    const videoJsonPath = existingFile(path.join(dir, `${baseName}.mp4-data.json`), path.join(dir, `${entry.name}.mp4-data.json`));
    const mp4Path = existingFile(path.join(dir, `${baseName}.mp4`), path.join(dir, `${entry.name}.mp4`));
    const manualMdPath = existingFile(path.join(dir, `${baseName}.travel.md`), path.join(dir, `${entry.name}.travel.md`));
    const manualPdfPath = existingFile(path.join(dir, `${baseName}.travel.pdf`), path.join(dir, `${entry.name}.travel.pdf`));
    const routeMapImagePath = existingFile(path.join(dir, `${baseName}.route-map.png`), path.join(dir, `${entry.name}.route-map.png`));
    const updatedAt = latestMtimeIso([routeJsonPath, videoJsonPath, mp4Path, manualMdPath, manualPdfPath, routeMapImagePath], stat.mtime);
    return {
      name: metadata.routeName || summary?.name || routeData?.name || entry.name,
      safeName: entry.name,
      fileBase: baseName,
      assetPath: path.relative(ROUTE_ROOT, dir).replace(/\\/g, "/"),
      dir,
      archivedAt: metadata.archivedAt || stat.mtime.toISOString(),
      updatedAt,
      mapLayer: metadata.mapLayer || null,
      routeJson: Boolean(routeJsonPath),
      videoJson: Boolean(videoJsonPath),
      mp4: Boolean(mp4Path),
      manualMd: Boolean(manualMdPath),
      manualPdf: Boolean(manualPdfPath),
      mapImage: Boolean(routeMapImagePath),
      summary,
      routeData
    };
  }).filter((item) => item.routeJson && (withData ? item.routeData : item.summary)).sort((a, b) => String(b.archivedAt).localeCompare(String(a.archivedAt)));
};
const serveStatic = (req, res, identity) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  let root = PUBLIC_ROOT;
  let relativePath = pathname;
  if (pathname.startsWith("/route/")) {
    root = ROUTE_ROOT;
    relativePath = pathname.slice("/route".length);
  }
  const target = path.resolve(root, `.${relativePath}`);
  if (pathname.startsWith("/route/")) {
    const userRoot = path.resolve(getUserRouteRoot(identity));
    if (!identity?.email && REQUIRE_USER_EMAIL) return send(res, 401, "Missing user email", "text/plain;charset=utf-8");
    if (!isPathInside(userRoot, target)) return send(res, 403, "Forbidden", "text/plain;charset=utf-8");
  }
  const rootPrefix = `${path.resolve(root)}${path.sep}`;
  if (target !== path.resolve(root) && !target.startsWith(rootPrefix)) {
    return send(res, 403, "Forbidden", "text/plain;charset=utf-8");
  }
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) return send(res, 404, "Not found", "text/plain;charset=utf-8");
  const ext = path.extname(target).toLowerCase();
  const mime = ext === ".html" ? "text/html;charset=utf-8" : ext === ".js" ? "text/javascript;charset=utf-8" : ext === ".css" ? "text/css;charset=utf-8" : ext === ".json" ? "application/json;charset=utf-8" : ext === ".md" ? "text/markdown;charset=utf-8" : ext === ".pdf" ? "application/pdf" : ext === ".mp4" ? "video/mp4" : ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : ext === ".svg" ? "image/svg+xml" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "application/octet-stream";
  const stat = fs.statSync(target);
  const range = ext === ".mp4" && req.headers.range ? parseVideoByteRange(req.headers.range, stat.size) : null;
  if (ext === ".mp4" && req.headers.range && !range) {
    res.writeHead(416, {"Content-Range": `bytes */${stat.size}`});
    return res.end();
  }
  res.writeHead(range ? 206 : 200, {
    "Content-Length": range ? range.end - range.start + 1 : stat.size,
    ...(ext === ".mp4" ? {"Accept-Ranges": "bytes"} : {}),
    ...(range ? {"Content-Range": `bytes ${range.start}-${range.end}/${stat.size}`} : {}),
    "Content-Type": mime,
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0",
    "Last-Modified": stat.mtime.toUTCString()
  });
  if (req.method === "HEAD") return res.end();
  const stream = fs.createReadStream(target, range || undefined);
  stream.on("error", (error) => res.destroy(error));
  res.on("close", () => stream.destroy());
  stream.pipe(res);
};
const uploadExportedRouteAssets = async (payload, exported, identity) => {
  const supabase = getSupabaseClient();
  const routeData = payload.routeData || null;
  if (!supabase || !identity?.email || !routeData?.days) return null;
  const routeId = normalizeCloudRouteId(routeData);
  const routeName = String(routeData.name || exported.routeName || "\u8DEF\u7EBF").trim() || "\u8DEF\u7EBF";
  const storageUserId = await getStorageUserId(identity.email);
  const prefix = `users/${storageUserId}/routes/${storageSafeSegment(routeId)}`;
  const { data: previousRoute, error: previousError } = await supabase.from(SUPABASE_TABLES.routes).select("route_data").eq("owner_email", identity.email).eq("id", routeId).maybeSingle();
  if (previousError) throw previousError;
  let nextRouteData = { ...routeData, id: routeId, name: routeName };
  const files = [
    ["routeJson", exported.routeJson, "route.json"],
    ["videoData", exported.videoJson, "mp4-data.json"],
    ["manualMd", exported.manualMd, "travel.md"],
    ["manualPdf", exported.manualPdf, "travel.pdf"],
    ["mp4", exported.output, "mp4"],
    ["mapImage", exported.routeMapImage, "route-map.png"]
  ];
  for (const [key, file, suffix] of files) {
    if (!file || !fs.existsSync(file)) continue;
    const descriptor = await uploadBufferToRouteAssets(supabase, {
      bucket: PRIVATE_ROUTE_ASSET_BUCKET,
      prefix,
      key,
      buffer: fs.readFileSync(file),
      contentType: contentTypeForPath(file),
      fileName: path.basename(file) || `${key}.${suffix.split(".").pop()}`
    });
    nextRouteData = withRouteAsset(nextRouteData, key, {
      ...descriptor
    });
  }
  const zip = await uploadRouteProductZip(supabase, nextRouteData, {
    bucket: PRIVATE_ROUTE_ASSET_BUCKET,
    prefix,
    id: `${identity.email}-${routeId}`,
    name: routeName
  });
  nextRouteData = zip.routeData;
  const { error } = await supabase.from(SUPABASE_TABLES.routes).upsert({
    owner_email: identity.email,
    id: routeId,
    name: routeName,
    route_data: nextRouteData,
    map_layer: String(payload.mapLayer || "standard").trim() || "standard",
    updated_at: (new Date()).toISOString()
  }, { onConflict: "owner_email,id" });
  if (error) throw error;
  const nextPaths = new Set(routeAssetStorageDescriptors(nextRouteData).map((descriptor) => `${descriptor.storageBucket}/${descriptor.storagePath}`));
  const oldDescriptors = routeAssetStorageDescriptors(previousRoute?.route_data).filter((descriptor) => descriptor.storageBucket === PRIVATE_ROUTE_ASSET_BUCKET).filter((descriptor) => !nextPaths.has(`${descriptor.storageBucket}/${descriptor.storagePath}`));
  if (oldDescriptors.length) {
    setTimeout(() => {
      removeRouteAssetDescriptors(supabase, oldDescriptors).catch((cleanupError) => {
        console.warn("Failed to cleanup old route assets:", cleanupError.message || cleanupError);
      });
    }, 0);
  }
  return resolveRouteAssetUrls(nextRouteData);
};
const renderOverviewAndPdf = async ({ baseVideoData, archived, payload, logFile, snapshotUrl = null, snapshotToken = null, snapshotHeaders = {}, progressStart = 82, onImage, onImageError, onPdf, onPdfError }) => {
  assertExportNotCancelled();
  setExportProgress({ phase: "map", message: "\u6B63\u5728\u751F\u6210\u8DEF\u7EBF\u56FE\u7247\u2026", percent: progressStart });
  const renderOverviewStill = async () => {
    const overviewPlan = overviewCanvasPlan(baseVideoData);
    await runRemotionStill({
      videoData: {
        ...baseVideoData,
        renderMode: "overview"
      },
      output: archived.routeMapImage,
      config: payload.config,
      logFile,
      frame: 0,
      progressStart: progressStart,
      progressEnd: 90,
      width: overviewPlan.width,
      height: overviewPlan.height,
      scale: overviewPlan.scale
    });
  };
  let imageReady = false;
  let imageError = null;
  try {
    if (snapshotUrl) await captureMapSnapshot({url: snapshotUrl, output: archived.routeMapImage, headers: snapshotHeaders});
    else await renderOverviewStill();
    imageReady = true;
  } catch (error) {
    if (error?.code === "EXPORT_CANCELLED") throw error;
    imageError = error;
    if (snapshotUrl) {
      try { await renderOverviewStill(); imageReady = true; }
      catch (fallbackError) { imageError = fallbackError; }
    }
  } finally { cleanupRouteSnapshot(snapshotToken); }
  if (imageReady) onImage(archived.routeMapImage);
  else {
    onImageError(imageError?.message || "路线图片生成失败。");
    onImage(null);
    archived.manualText = buildTravelManual(payload.videoData, payload.routeData, {outputDir: archived.dir});
    if (archived.manualMd) writeFileAtomic(archived.manualMd, archived.manualText);
  }
  if (archived.manualText) {
    try {
      assertExportNotCancelled();
      setExportProgress({ phase: "pdf", message: "\u6B63\u5728\u751F\u6210 PDF\u2026", percent: 92 });
      const manualPdf = path.join(archived.dir, `${archived.safeName}.travel.pdf`);
      await renderMarkdownPdf(archived.manualText, manualPdf, `${archived.routeName}\u8DEF\u7EBF\u624B\u518C`, archived.dir, { keep: [path.basename(archived.routeMapImage || "")] });
      onPdf(manualPdf);
    } catch (error) {
      onPdfError(error.message);
      onPdf(null);
    }
  }
};
const exportRouteBundle = async (payload, routeRoot, identity, exportTaskId = null) => {
  const renderVideo = payload.renderVideo === true;
  assertExportNotCancelled();
  setExportProgress({ phase: "files", message: "\u6B63\u5728\u4FDD\u5B58\u8DEF\u7EBF\u6570\u636E\u2026", percent: 5 });
  const archived = archivePayload(payload, routeRoot, identity);
  assertExportNotCancelled();
  const snapshotToken = exportTaskId || `snap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const snapshotUrl = `http://127.0.0.1:${PORT}/?snapshot=${snapshotToken}`;
  const snapshotHeaders = identity?.email ? {[USER_EMAIL_HEADER]: identity.email} : {};
  writeRouteSnapshot(snapshotToken, payload);
  const browserExecutable = await ensureExportBrowser();
  if (!browserExecutable) throw new Error("\u670D\u52A1\u5668\u6CA1\u6709\u53EF\u7528\u7684 Chromium\uFF0C\u65E0\u6CD5\u751F\u6210 MP4\u3001PNG \u548C PDF\u3002");
  setExportProgress({ phase: "manual", message: "\u6B63\u5728\u751F\u6210 MD \u624B\u518C\u2026", percent: 14 });
  const output = path.join(archived.dir, `${archived.safeName}.mp4`);
  const renderOutput = path.join(archived.dir, `${archived.safeName}.render.mp4`);
  const logFile = path.join(archived.dir, "latest-render.log");
  let result = { output: null };
  let videoBitrate = null;
  let routeMapImage = archived.routeMapImage;
  let routeMapError = null;
  let mapBgImage = null;
  let mapBgError = null;
  let videoError = null;
  let pdfError = null;
  let manualPdf = null;
  const baseVideoData = {
    ...payload.videoData || {},
    staticMapImage: undefined,
    hillshadeEndpoint: `http://127.0.0.1:${PORT}/api/v1/map/hillshade`
  };
  if (renderVideo) {
    try {
      assertExportNotCancelled();
      setExportProgress({ phase: "map", message: "\u6B63\u5728\u7F13\u5B58\u5730\u56FE\u5E95\u56FE\u2026", percent: 18 });
      const mapPlan = createMapBackgroundPlan(baseVideoData, REMOTION_WIDTH, REMOTION_HEIGHT);
      const savedMeta = loadJson(archived.mapBgMeta, {});
      if (canReuseMapBackground(archived.mapBgImage, savedMeta, mapPlan)) {
        mapBgImage = archived.mapBgImage;
      } else {
        await runRemotionStill({
          videoData: mapPlan.videoData,
          output: archived.mapBgImage,
          config: payload.config,
          logFile,
          frame: 0,
          progressStart: 18,
          progressEnd: 24,
          width: mapPlan.width,
          height: mapPlan.height,
          scale: mapPlan.scale
        });
        assertMapBackgroundSize(archived.mapBgImage, mapPlan);
        writeFileAtomic(archived.mapBgMeta, JSON.stringify({
          signature: mapPlan.signature,
          width: mapPlan.width,
          height: mapPlan.height,
          scale: mapPlan.scale,
          updatedAt: (new Date()).toISOString()
        }, null, 2));
        mapBgImage = archived.mapBgImage;
      }
    } catch (error) {
      mapBgError = error.message;

      mapBgImage = null;
    }
    assertExportNotCancelled();
    try {
      setExportProgress({ phase: "mp4", message: "\u6B63\u5728\u6E32\u67D3 MP4\u2026", percent: 24 });
      result = await runRemotion({
        videoData: {
          ...baseVideoData,
          renderMode: "video",
          ...mapBgImage ? { staticMapImage: toPublicAssetPath(mapBgImage) } : {}
        },
        output: renderOutput,
        config: payload.config,
        logFile,
        progressStart: 24,
        progressEnd: 78
      });
      assertExportNotCancelled();
      setExportProgress({ phase: "faststart", message: "\u6B63\u5728\u4F18\u5316 MP4 \u64AD\u653E\u2026", percent: 80 });
      const [faststartOut, overviewOut] = await Promise.allSettled([
        (async () => {
          await runFfmpegFaststart({ input: renderOutput, output, logFile });
          videoBitrate = await probeVideoBitrate(output);
          fs.rmSync(renderOutput, { force: true });
          result = { output };
        })(),
        renderOverviewAndPdf({
          baseVideoData,
          archived,
          payload,
          logFile,
          snapshotUrl,
          snapshotToken,
          snapshotHeaders,
          progressStart: 82,
          onImage: (value) => { routeMapImage = value; },
          onImageError: (value) => { routeMapError = value; },
          onPdf: (value) => { manualPdf = value; },
          onPdfError: (value) => { pdfError = value; }
        })
      ]);
      if (faststartOut.status === "rejected") {
        if (!fs.existsSync(renderOutput)) throw faststartOut.reason;
        fs.copyFileSync(renderOutput, output);
        videoBitrate = await probeVideoBitrate(output);
        videoError = `MP4 \u4F18\u5316\u5931\u8D25\uFF0C\u5DF2\u4FDD\u7559\u539F\u59CB\u89C6\u9891\uFF1A${faststartOut.reason.message}`;
        result = { output };
      }
    } catch (error) {
      if (error?.code === "EXPORT_CANCELLED") throw error;
      videoError = error.message;
      result = { output: null };
      try {
        fs.rmSync(renderOutput, { force: true });
      } catch (_) {
      }
      setExportProgress({ phase: "map", message: "MP4 \u6E32\u67D3\u5931\u8D25\uFF0C\u7EE7\u7EED\u751F\u6210\u8DEF\u7EBF\u56FE\u7247\u2026", percent: 42 });
      await renderOverviewAndPdf({
        baseVideoData,
        archived,
        payload,
        logFile,
        snapshotUrl,
        snapshotToken,
        snapshotHeaders,
        progressStart: 42,
        onImage: (value) => { routeMapImage = value; },
        onImageError: (value) => { routeMapError = value; },
        onPdf: (value) => { manualPdf = value; },
        onPdfError: (value) => { pdfError = value; }
      });
    }
  } else {
    setExportProgress({ phase: "map", message: "\u6B63\u5728\u751F\u6210\u8DEF\u7EBF\u56FE\u7247\u2026", percent: 42 });
    await renderOverviewAndPdf({
      baseVideoData,
      archived,
      payload,
      logFile,
      snapshotUrl,
      snapshotToken,
      snapshotHeaders,
      progressStart: 42,
      onImage: (value) => { routeMapImage = value; },
      onImageError: (value) => { routeMapError = value; },
      onPdf: (value) => { manualPdf = value; },
      onPdfError: (value) => { pdfError = value; }
    });
  }
  const exported = {
    ...archived,
    manualText: void 0,
    output: result.output,
    logFile,
    routeMapImage,
    routeMapError,
    mapBgImage,
    mapBgError,
    videoError,
    manualPdf,
    pdfError,
    videoBitrate
  };
  try {
    assertExportNotCancelled();
    setExportProgress({ phase: "assets", message: "\u6B63\u5728\u4E0A\u4F20\u4EA7\u54C1\u8D44\u4EA7\u2026", percent: 96 });
    exported.assetUrls = await uploadExportedRouteAssets(payload, exported, identity);
  } catch (error) {
    exported.assetUploadError = error.message;
  }
  return exported;
};
const releaseExportTask = () => {
  rendering = false;
  activeExport = null;
  setTimeout(pumpPublishedRouteJobs, 0);
};
const runManualExportJob = async (task, payload, identity) => {
  try {
    startExportProgress("\u6B63\u5728\u51C6\u5907\u5BFC\u51FA\u2026");
    const exported = await exportRouteBundle(payload, getUserRouteRoot(identity), identity, task.id);
    task.result = {
      routeName: exported.routeName,
      safeName: exported.safeName,
      routeMapImage: Boolean(exported.routeMapImage),
      manualPdf: Boolean(exported.manualPdf),
      output: Boolean(exported.output),
      videoError: exported.videoError || null,
      routeMapError: exported.routeMapError || null,
      pdfError: exported.pdfError || null,
      assetUploadError: exported.assetUploadError || null
    };
    const missing = [
      payload.renderVideo === true && !exported.output ? "MP4" : null,
      exported.routeMapImage ? null : "\u8DEF\u7EBF\u603B\u89C8 PNG",
      exported.manualPdf ? null : "PDF",
      exported.assetUploadError ? "\u4E91\u7AEF\u4EA7\u54C1\u8D44\u4EA7" : null
    ].filter(Boolean);
    if (missing.length) {
      failExportProgress(new Error(`\u5BFC\u51FA\u672A\u5B8C\u6574\u5B8C\u6210\uFF1A\u7F3A\u5C11 ${missing.join("\u3001")}\u3002${exported.videoError || exported.routeMapError || exported.pdfError || exported.assetUploadError || ""}`));
    } else {
      finishExportProgress("\u5BFC\u51FA\u5B8C\u6210");
    }
  } catch (error) {
    if (error?.code === "EXPORT_CANCELLED") cancelExportProgress(error.message);
    else failExportProgress(error);
    console.error("\u624B\u52A8\u5BFC\u51FA\u5931\u8D25:", error?.message || error);
  } finally {
    releaseExportTask();
  }
};
const queueManualExportTask = (payload, identity) => {
  if (rendering) {
    const error = new Error("\u5DF2\u6709\u5BFC\u51FA\u4EFB\u52A1\u8FDB\u884C\u4E2D\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5");
    error.status = 409;
    error.code = "EXPORT_RUNNING";
    throw error;
  }
  if (!payload?.routeData) throw new Error("\u7F3A\u5C11 routeData");
  if (!payload?.videoData) throw new Error("\u7F3A\u5C11 videoData");
  validateRouteData(payload.routeData);
  const task = createExportTask(identity.email);
  latestExportsByOwner.set(identity.email, task);
  activeExport = task;
  rendering = true;
  void runManualExportJob(task, payload, identity);
  return {
    ok: true,
    queued: true,
    taskId: task.id,
    message: "\u5BFC\u51FA\u4EFB\u52A1\u5DF2\u5728\u670D\u52A1\u5668\u540E\u53F0\u542F\u52A8\u3002"
  };
};
const pumpPublishedRouteJobs = async () => {
  if (rendering || !publishedRouteJobs.length) return;
  const job = publishedRouteJobs.shift();
  const identity = job.identity;
  activeExport = createExportTask(identity.email, { publishJob: true });
  latestExportsByOwner.set(identity.email, activeExport);
  rendering = true;
  try {
    startExportProgress("\u6B63\u5728\u4E3A\u516C\u5171\u8DEF\u7EBF\u751F\u6210\u5B8C\u6574\u4EA7\u54C1\u2026");
    const config = { ...job.payload.config || {} };
    if (!config.key || !config.securityJsCode) {
      const cloud = await readCloudConfig();
      if (cloud?.key && cloud?.securityJsCode) {
        config.key = cloud.key;
        config.securityJsCode = cloud.securityJsCode;
      }
    }
    const routeRoot = getUserRouteRoot(identity);
    let exported = null;
    try {
      exported = await exportRouteBundle({ ...job.payload, config, renderVideo: true }, routeRoot, identity, activeExport.id);
    } catch (error) {
      if (error?.code === "EXPORT_CANCELLED") throw error;
      console.warn("\u516C\u5171\u8DEF\u7EBF\u89C6\u9891\u6E32\u67D3\u5931\u8D25\uFF0C\u91CD\u8BD5\uFF08\u4E0D\u542B\u89C6\u9891\uFF09:", error?.message || error);
      exported = await exportRouteBundle({ ...job.payload, config, renderVideo: false }, routeRoot, identity, activeExport.id);
    }
    if (exported?.assetUploadError) {
      console.warn("\u516C\u5171\u8DEF\u7EBF\u8D44\u4EA7\u4E0A\u4F20\u5931\u8D25\uFF0C\u4FDD\u7559\u5DF2\u53D1\u5E03\u57FA\u7840\u5185\u5BB9:", exported.assetUploadError);
    } else {
      const supabase = requireSupabaseClient();
      const routeId = normalizeCloudRouteId(job.payload.routeData || {});
      const { data: userRoute, error: readError } = await supabase.from(SUPABASE_TABLES.routes).select("route_data").eq("owner_email", identity.email).eq("id", routeId).maybeSingle();
      if (readError) throw readError;
      if (userRoute?.route_data) {
        const prefix = `routes/${job.publishedId}`;
        const copied = await copyRouteAssetsToBucket(supabase, userRoute.route_data, {
          bucket: PUBLIC_ROUTE_ASSET_BUCKET,
          prefix,
          routeName: job.publishedName
        });
        const zip = await uploadRouteProductZip(supabase, copied, {
          bucket: PUBLIC_ROUTE_ASSET_BUCKET,
          prefix,
          id: job.publishedId,
          name: job.publishedName
        });
        const { error: updateError } = await supabase.from(SUPABASE_TABLES.publishedRoutes).update({ route_data: zip.routeData, updated_at: (new Date()).toISOString() }).eq("id", job.publishedId);
        if (updateError) throw updateError;
      }
    }
    finishExportProgress("\u516C\u5171\u8DEF\u7EBF\u5B8C\u6574\u4EA7\u54C1\u5DF2\u751F\u6210");
  } catch (error) {
    if (error?.code === "EXPORT_CANCELLED") cancelExportProgress(error.message);
    else failExportProgress(error);
    console.error("\u516C\u5171\u8DEF\u7EBF\u4EA7\u54C1\u751F\u6210\u5931\u8D25:", error?.message || error);
  } finally {
    releaseExportTask();
  }
};
const handleMapEnhancementRoute = createMapEnhancementRoutes({
  pointInfoService,
  hillshadeService,
  readBody,
  send
});
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];
const OVERPASS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const roadRelationCache = new Map();
async function fetchOverpass(query, retries = 4) {
  let lastError = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        const url = `${endpoint}?data=${encodeURIComponent(query)}`;
        const response = await fetch(url, {
          headers: {
            "User-Agent": OVERPASS_UA,
            "Referer": "https://overpass-turbo.eu/",
            "Accept": "application/json"
          },
          signal: AbortSignal.timeout(45e3)
        });
        if (!response.ok) {
          lastError = new Error(`Overpass ${response.status}`);
          continue;
        }
        const text = await response.text();
        if (!text.includes('"elements"')) {
          lastError = new Error("Overpass \u65E0\u6570\u636E");
          continue;
        }
        return JSON.parse(text);
      } catch (error) {
        lastError = error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 3e3 * (attempt + 1)));
  }
  throw lastError || new Error("Overpass \u8BF7\u6C42\u5931\u8D25");
}
async function queryRoadGeometry(ref, bbox) {
  let relationId = roadRelationCache.get(ref);
  let relationName = "";
  if (!relationId) {
    const relQuery = `[out:json];relation["ref"="${ref}"]["route"="road"];out tags;`;
    const relData = await fetchOverpass(relQuery);
    const rel = (relData.elements || []).find((e) => e.type === "relation");
    if (!rel) throw new Error(`\u672A\u627E\u5230\u516C\u8DEF ${ref} \u7684\u8DEF\u7F51\u6570\u636E`);
    relationId = rel.id;
    relationName = rel.tags && (rel.tags.name || rel.tags.official_name) || "";
    roadRelationCache.set(ref, relationId);
  }
  const wayQuery = `[out:json];rel(${relationId});way(r)(${bbox.south},${bbox.west},${bbox.north},${bbox.east});out tags geom;`;
  const wayData = await fetchOverpass(wayQuery);
  const ways = (wayData.elements || []).filter((e) => e.type === "way" && Array.isArray(e.geometry) && e.geometry.length >= 2).map((e) => ({ id: e.id, tags: e.tags || {}, geometry: e.geometry.map((g) => [g.lat, g.lon]) }));
  if (!ways.length) throw new Error("\u8BE5\u533A\u57DF\u5185\u6CA1\u6709\u516C\u8DEF\u51E0\u4F55");
  return { ref, name: relationName, relationId, ways };
}
const OSRM_ENDPOINTS = {
  driving: "https://router.project-osrm.org/route/v1/driving",
  cycling: "https://routing.openstreetmap.de/routed-bike/route/v1/driving",
  walking: "https://routing.openstreetmap.de/routed-foot/route/v1/driving"
};
async function queryOsrmRoute(fromLng, fromLat, toLng, toLat, profile = "driving", alternatives = false) {
  const endpoint = OSRM_ENDPOINTS[profile] || OSRM_ENDPOINTS.driving;
  const url = `${endpoint}/${fromLng},${fromLat};${toLng},${toLat}?overview=full&geometries=geojson&steps=false${alternatives ? "&alternatives=true" : ""}`;
  const response = await fetch(url, {
    headers: { "User-Agent": OVERPASS_UA, "Accept": "application/json" },
    signal: AbortSignal.timeout(3e4)
  });
  if (!response.ok) throw new Error(`OSRM ${response.status}`);
  const body = await response.json();
  if (body.code !== "Ok" || !body.routes || !body.routes.length) {
    throw new Error(`OSRM \u65E0\u6CD5\u89C4\u5212\u8BE5\u8DEF\u7EBF\uFF1A${body.code || "unknown"}`);
  }
  if (alternatives) {
    const list = (body.routes || []).slice(0, 3).map((route) => {
      const coordinates = route.geometry && route.geometry.coordinates || [];
      return {
        coordinates,
        distance: Math.round(route.distance || 0),
        duration: Math.round(route.duration || 0)
      };
    }).filter((item) => item.coordinates.length >= 2);
    return { alternatives: list };
  }
  const route = body.routes[0];
  const coordinates = route.geometry && route.geometry.coordinates || [];
  if (coordinates.length < 2) throw new Error("OSRM \u672A\u8FD4\u56DE\u53EF\u7528\u51E0\u4F55");
  return {
    coordinates,
    distance: Math.round(route.distance || 0),
    duration: Math.round(route.duration || 0)
  };
}
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return send(res, 204, {});
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const identity = getRequestIdentity(req);
    if (req.method === "GET" && url.pathname === "/api/v1/session") {
      if (!identity.email && REQUIRE_USER_EMAIL) {
        return send(res, 401, {
          ok: false,
          email: "",
          message: `Caddy \u672A\u4F20\u5165\u6709\u6548\u90AE\u7BB1\uFF0C\u8BF7\u8BBE\u7F6E\u8BF7\u6C42\u5934 ${USER_EMAIL_HEADER}.`
        });
      }
      return send(res, 200, {
        ok: true,
        authenticated: Boolean(identity.email),
        email: identity.email,
        id: identity.id,
        source: identity.source,
        isAdmin: isAdminIdentity(identity),
        capabilities: {
          cloudRoutes: isSupabaseConfigured(),
          publishedRoutes: isSupabaseConfigured(),
          sharedScenes: true,
          serverExport: true,
          editableMapConfig: !isSupabaseConfigured() || isAdminIdentity(identity),
          supabase: isSupabaseConfigured(),
          pointInfoWeatherTtlMinutes: POINT_INFO_CONFIG.weatherTtlMinutes
        }
      });
    }
    if (url.pathname.startsWith("/api/") && url.pathname !== "/api/v1/health" && !url.pathname.startsWith("/api/v1/map/hillshade/") && REQUIRE_USER_EMAIL && !identity.email) {
      return send(res, 401, { ok: false, message: `\u7F3A\u5C11 Caddy \u7528\u6237\u90AE\u7BB1\u8BF7\u6C42\u5934\uFF1A${USER_EMAIL_HEADER}` });
    }
    if (req.method === "GET" && url.pathname === "/api/v1/health") {
      const amap = readAmapConfig();
      return send(res, 200, {
        ok: true,
        rendering,
        hasKeyFile: Boolean(amap.key && amap.securityJsCode),
        supabaseConfigured: isSupabaseConfigured()
      });
    }
    if (await handleMapEnhancementRoute(req, res, url)) return;
    if (req.method === "GET" && url.pathname === "/api/v1/config") {
      const keys = readKeyFile();
      const cloud = await readCloudConfig();
      const key = cloud?.key || keys.key || process.env.AMAP_KEY || "";
      const securityJsCode = cloud?.securityJsCode || keys.securityJsCode || process.env.AMAP_SECURITY_JS_CODE || "";
      return send(res, 200, {
        ok: true,
        key,
        securityJsCode,
        configured: Boolean(key && securityJsCode),
        editable: !isSupabaseConfigured() || isAdminIdentity(identity),
        source: cloud?.source || (keys.key ? "config/local.env" : process.env.AMAP_KEY ? "process env" : null)
      });
    }
    if (req.method === "POST" && url.pathname === "/api/v1/config") {
      const payload = await readBody(req, 64 * 1024);
      const key = String(payload.key || "").trim();
      const securityJsCode = String(payload.securityJsCode || "").trim();
      if (!key || !securityJsCode) return send(res, 400, { ok: false, message: "Key \u548C\u5B89\u5168\u5BC6\u94A5\u90FD\u5FC5\u586B" });
      if (isSupabaseConfigured()) {
        try {
          const result = await writeCloudConfig({ key, securityJsCode }, identity);
          return send(res, 200, result);
        } catch (error) {
          const status = /管理员/.test(error.message) ? 403 : 500;
          return send(res, status, { ok: false, message: error.message });
        }
      }
      const file = writeKeyFile({ key, securityJsCode });
      return send(res, 200, { ok: true, file, key, securityJsCode });
    }
    if (req.method === "GET" && url.pathname === "/api/v1/profile") {
      try {
        return send(res, 200, await communityService.getProfile(identity.email, identity));
      } catch (error) {
        return send(res, Number(error.status) || 500, { ok: false, message: error.message });
      }
    }
    if (req.method === "PUT" && url.pathname === "/api/v1/profile") {
      try {
        return send(res, 200, await communityService.saveProfile(await readBody(req, 8 * 1024 * 1024), identity));
      } catch (error) {
        return send(res, Number(error.status) || 400, { ok: false, message: error.message });
      }
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/v1/profiles/")) {
      try {
        const email = decodeURIComponent(url.pathname.slice("/api/v1/profiles/".length));
        return send(res, 200, await communityService.getProfile(email, identity));
      } catch (error) {
        return send(res, Number(error.status) || 500, { ok: false, message: error.message });
      }
    }
    if (req.method === "GET" && url.pathname === "/api/v1/community/messages") {
      try {
        return send(res, 200, await communityService.listMessages({
          limit: url.searchParams.get("limit")
        }, identity));
      } catch (error) {
        return send(res, Number(error.status) || 500, { ok: false, message: error.message });
      }
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/v1/community/direct/")) {
      try {
        const email = decodeURIComponent(url.pathname.slice("/api/v1/community/direct/".length, -"/messages".length));
        if (!url.pathname.endsWith("/messages")) return send(res, 404, { ok: false, message: "\u79C1\u804A\u63A5\u53E3\u4E0D\u5B58\u5728\u3002" });
        return send(res, 200, await communityService.listDirectMessages({
          email,
          limit: url.searchParams.get("limit")
        }, identity));
      } catch (error) {
        return send(res, Number(error.status) || 500, { ok: false, message: error.message });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/v1/community/messages") {
      try {
        return send(res, 200, await communityService.postMessage(await readBody(req, 70 * 1024 * 1024), identity));
      } catch (error) {
        return send(res, Number(error.status) || 400, { ok: false, message: error.message });
      }
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/api/v1/community/messages/")) {
      try {
        const messageId = decodeURIComponent(url.pathname.slice("/api/v1/community/messages/".length));
        return send(res, 200, await communityService.withdrawMessage(messageId, identity));
      } catch (error) {
        return send(res, Number(error.status) || 500, { ok: false, message: error.message });
      }
    }
    if (req.method === "GET" && url.pathname === "/api/v1/admin/summary") {
      try {
        const result = await getAdminSummary(identity);
        return send(res, 200, result);
      } catch (error) {
        return send(res, Number(error.status) || 500, { ok: false, message: error.message });
      }
    }
    if (req.method === "GET" && url.pathname === "/api/v1/routes") {
      const summaryMode = url.searchParams.get("summary") === "1";
      const cloudRoutes = await listCloudRoutes(identity, {summary: summaryMode});
      if (cloudRoutes) return send(res, 200, { ok: true, summarized: summaryMode, routes: cloudRoutes });
      const routes = listArchivedRoutes(getUserRouteRoot(identity), { withData: !summaryMode }).map((item) => ({
        id: item.routeData?.id || item.summary?.id || item.safeName,
        name: item.name,
        safeName: item.safeName,
        fileBase: item.fileBase,
        assetPath: item.assetPath,
        updatedAt: item.updatedAt,
        mapLayer: item.mapLayer,
        routeJson: item.routeJson,
        dayCount: item.summary?.dayCount ?? (item.routeData?.days?.length || 0),
        description: item.summary?.description || item.routeData?.description || "",
        routeData: item.routeData,
        assets: {
          mp4: item.mp4,
          manualPdf: item.manualPdf,
          mapImage: item.mapImage,
          productZip: false
        }
      }));
      return send(res, 200, { ok: true, summarized: summaryMode, routes });
    }
    if (req.method === "POST" && url.pathname === "/api/v1/routes") {
      try {
        const result = await saveCloudRoute(await readBody(req, 8 * 1024 * 1024), identity);
        return send(res, 200, result);
      } catch (error) {
        return send(res, Number(error.status) || 400, { ok: false, message: error.message });
      }
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/v1/routes/") && url.pathname.endsWith("/product.zip")) {
      try {
        const routeId = decodeURIComponent(url.pathname.slice("/api/v1/routes/".length, -"/product.zip".length));
        return sendZipDownload(res, await getAccountRoute(routeId, identity));
      } catch (error) {
        return send(res, Number(error.status) || 500, { ok: false, message: error.message });
      }
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/v1/routes/") && url.pathname.endsWith("/export")) {
      try {
        const routeId = decodeURIComponent(url.pathname.slice("/api/v1/routes/".length, -"/export".length));
        const payload = await readBody(req, 220 * 1024 * 1024);
        const suppliedRoute = payload.routeData;
        const row = suppliedRoute ? {
          id: routeId || suppliedRoute.id,
          name: suppliedRoute.name,
          route_data: suppliedRoute,
          map_layer: payload.mapLayer || "standard"
        } : await getAccountRoute(routeId, identity);
        const routeData = structuredClone(row.route_data);
        if (routeId && !routeData.id) routeData.id = routeId;
        validateRouteData(routeData);
        if (!payload.videoData) await prepareScriptPointInfo(routeData);
        const mapLayer = String(payload.mapLayer || row.map_layer || "standard").trim() || "standard";
        const exportPayload = {
          routeData,
          videoData: buildScriptVideoData(routeData, mapLayer, payload.videoData),
          mapLayer,
          renderVideo: payload.renderVideo !== false,
          config: payload.config || {},
          host: String(req.headers.host || `127.0.0.1:${PORT}`)
        };
        return send(res, 202, queueManualExportTask(exportPayload, identity));
      } catch (error) {
        return send(res, Number(error.status) || (error.code === "EXPORT_RUNNING" ? 409 : 400), {
          ok: false,
          code: error.code || void 0,
          message: error.message
        });
      }
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/v1/routes/snapshot/")) {
      const token = decodeURIComponent(url.pathname.split("/").pop());
      const data = readRouteSnapshot(token);
      if (!data?.route) return send(res, 404, { ok: false, message: "\u5FEB\u7167\u4E0D\u5B58\u5728\u6216\u5DF2\u8FC7\u671F" });
      return send(res, 200, { ok: true, route: data.route, segmentResults: data.segmentResults || [] });
    }
    if (req.method === "GET" && url.pathname === "/api/v1/roads/geometry") {
      try {
        const params = new URLSearchParams(url.search);
        const ref = String(params.get("ref") || "").trim();
        const south = Number(params.get("south"));
        const west = Number(params.get("west"));
        const north = Number(params.get("north"));
        const east = Number(params.get("east"));
        if (!/^[A-Za-z0-9]{1,12}$/.test(ref)) return send(res, 400, { ok: false, message: "ref \u65E0\u6548" });
        if (![south, west, north, east].every(Number.isFinite) || south >= north || west >= east) {
          return send(res, 400, { ok: false, message: "bbox \u65E0\u6548" });
        }
        const result = await queryRoadGeometry(ref.toUpperCase(), { south, west, north, east });
        return send(res, 200, { ok: true, ...result });
      } catch (error) {
        return send(res, Number(error.status) || 502, { ok: false, message: error.message });
      }
    }
    if (req.method === "GET" && url.pathname === "/api/v1/roads/osrm") {
      try {
        const params = new URLSearchParams(url.search);
        const fromLng = Number(params.get("fromLng"));
        const fromLat = Number(params.get("fromLat"));
        const toLng = Number(params.get("toLng"));
        const toLat = Number(params.get("toLat"));
        const profile = String(params.get("profile") || "driving");
        const alternatives = params.get("alternatives") === "true";
        if (![fromLng, fromLat, toLng, toLat].every(Number.isFinite)) {
          return send(res, 400, { ok: false, message: "\u8D77\u7EC8\u70B9\u5750\u6807\u65E0\u6548" });
        }
        const result = await queryOsrmRoute(fromLng, fromLat, toLng, toLat, profile, alternatives);
        return send(res, 200, { ok: true, ...result });
      } catch (error) {
        return send(res, Number(error.status) || 502, { ok: false, message: error.message });
      }
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/v1/routes/") && !url.pathname.endsWith("/product.zip")) {
      try {
        const routeId = decodeURIComponent(url.pathname.slice("/api/v1/routes/".length));
        if (!routeId || url.pathname.endsWith("/") || routeId.includes("/")) return send(res, 404, { ok: false, message: "\u8DEF\u7EBF\u4E0D\u5B58\u5728\u3002" });
        const found = await readAccountRoute(routeId, identity);
        return send(res, 200, {
          ok: true,
          route: {
            id: found.id,
            name: found.name,
            mapLayer: found.mapLayer || "standard",
            routeData: found.routeData,
            assetUrls: await resolveRouteAssetUrls(found.routeData)
          }
        });
      } catch (error) {
        return send(res, Number(error.status) || 500, { ok: false, message: error.message });
      }
    }
    if (req.method === "PUT" && url.pathname.startsWith("/api/v1/routes/")) {
      try {
        const routeId = decodeURIComponent(url.pathname.slice("/api/v1/routes/".length));
        const payload = await readBody(req, 8 * 1024 * 1024);
        if (!payload.routeData) throw new Error("\u7F3A\u5C11 routeData");
        const routeData = structuredClone(payload.routeData);
        routeData.id = routeId;
        const result = await saveCloudRoute({ routeData, mapLayer: payload.mapLayer }, identity);
        return send(res, 200, result);
      } catch (error) {
        return send(res, Number(error.status) || 400, { ok: false, message: error.message });
      }
    }
    if (req.method === "PATCH" && url.pathname.startsWith("/api/v1/routes/") && url.pathname.endsWith("/points")) {
      try {
        const routeId = decodeURIComponent(url.pathname.slice("/api/v1/routes/".length, -"/points".length));
        const row = await getAccountRoute(routeId, identity);
        const payload = await readBody(req, 256 * 1024);
        const routeData = patchRoutePoint(row.route_data, payload);
        const result = await saveCloudRoute({ routeData, mapLayer: payload.mapLayer || row.map_layer }, identity);
        return send(res, 200, result);
      } catch (error) {
        return send(res, Number(error.status) || 400, { ok: false, message: error.message });
      }
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/api/v1/routes/")) {
      try {
        const routeId = decodeURIComponent(url.pathname.slice("/api/v1/routes/".length));
        return send(res, 200, await deleteCloudRoute(routeId, identity));
      } catch (error) {
        return send(res, Number(error.status) || 500, { ok: false, message: error.message });
      }
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/v1/exports/") && url.pathname.endsWith("/cancel")) {
      const taskId = decodeURIComponent(url.pathname.slice("/api/v1/exports/".length, -"/cancel".length));
      const task = latestExportsByOwner.get(identity.email);
      if (!task || task.id !== taskId) return send(res, 404, { ok: false, message: "\u5BFC\u51FA\u4EFB\u52A1\u4E0D\u5B58\u5728\u6216\u4E0D\u5C5E\u4E8E\u5F53\u524D\u8D26\u53F7\u3002" });
      if (task.publishJob) {
        return send(res, 409, { ...getExportProgressForOwner(identity.email), cancelled: false, message: "\u516C\u5171\u8DEF\u7EBF\u4EA7\u54C1\u6B63\u5728\u540E\u53F0\u751F\u6210\uFF0C\u6682\u4E0D\u53EF\u53D6\u6D88" });
      }
      const cancelled = cancelActiveExport(identity.email);
      return send(res, 200, {
        ...getExportProgressForOwner(identity.email),
        cancelled,
        message: cancelled ? void 0 : "\u5F53\u524D\u6CA1\u6709\u53EF\u7EC8\u6B62\u7684\u5BFC\u51FA\u4EFB\u52A1"
      });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/v1/exports/")) {
      const taskId = decodeURIComponent(url.pathname.slice("/api/v1/exports/".length));
      const state = getExportProgressForOwner(identity.email);
      if (state.exportTaskId !== taskId) return send(res, 404, { ok: false, message: "\u5BFC\u51FA\u4EFB\u52A1\u4E0D\u5B58\u5728\u6216\u4E0D\u5C5E\u4E8E\u5F53\u524D\u8D26\u53F7\u3002" });
      return send(res, 200, state);
    }
    if (req.method === "GET" && url.pathname === "/api/v1/published-routes") {
      try {
        return send(res, 200, { ok: true, routes: await listPublishedRoutes() || [] });
      } catch (error) {
        return send(res, Number(error.status) || 500, { ok: false, message: error.message });
      }
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/v1/published-routes/") && url.pathname.endsWith("/product.zip")) {
      try {
        const publishedId = decodeURIComponent(url.pathname.slice("/api/v1/published-routes/".length, -"/product.zip".length));
        return sendZipDownload(res, await getPublishedRouteForDownload(publishedId));
      } catch (error) {
        return send(res, Number(error.status) || 500, { ok: false, message: error.message });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/v1/published-routes") {
      try {
        return send(res, 200, await publishCloudRoute(await readBody(req), identity));
      } catch (error) {
        return send(res, Number(error.status) || 500, { ok: false, message: error.message });
      }
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/v1/published-routes/") && url.pathname.endsWith("/import")) {
      try {
        const publishedId = decodeURIComponent(url.pathname.slice("/api/v1/published-routes/".length, -"/import".length));
        return send(res, 200, await importPublishedRoute(publishedId, identity));
      } catch (error) {
        return send(res, Number(error.status) || 500, { ok: false, message: error.message });
      }
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/api/v1/published-routes/")) {
      try {
        const publishedId = decodeURIComponent(url.pathname.slice("/api/v1/published-routes/".length));
        return send(res, 200, await deletePublishedRoute(publishedId, identity));
      } catch (error) {
        return send(res, Number(error.status) || 500, { ok: false, message: error.message });
      }
    }
    if (req.method === "GET" && url.pathname === "/api/v1/spots/public") {
      try {
        const name = url.searchParams.get("name") || "";
        if (name) return send(res, 200, await getCloudScenic(name) || { ok: true, spot: null });
        const spots = await listCloudScenes() || [];
        return send(res, 200, { ok: true, spots, scenes: spots });
      } catch (error) {
        return send(res, Number(error.status) || 500, { ok: false, message: error.message });
      }
    }
    if (req.method === "PUT" && url.pathname === "/api/v1/spots/public") {
      try {
        return send(res, 200, await saveCloudScenic(await readBody(req, 70 * 1024 * 1024), identity));
      } catch (error) {
        return send(res, Number(error.status) || 400, { ok: false, message: error.message });
      }
    }
    if (req.method === "DELETE" && url.pathname === "/api/v1/spots/public") {
      try {
        return send(res, 200, await deleteCloudScenic(url.searchParams.get("name") || "", identity));
      } catch (error) {
        return send(res, Number(error.status) || 400, { ok: false, message: error.message });
      }
    }
    if (req.method === "GET" && url.pathname === "/api/v1/spots/public/revisions") {
      try {
        return send(res, 200, { ok: true, revisions: await listCloudSceneRevisions(url.searchParams.get("name") || "") });
      } catch (error) {
        return send(res, Number(error.status) || 400, { ok: false, message: error.message });
      }
    }
    if (req.method === "GET" && url.pathname === "/api/v1/spots/private") {
      try {
        const scenes = await listUserScenes(identity);
        return send(res, 200, { ok: true, spots: scenes, scenes });
      } catch (error) {
        return send(res, Number(error.status) || 500, { ok: false, message: error.message });
      }
    }
    if (req.method === "PUT" && url.pathname === "/api/v1/spots/private") {
      try {
        return send(res, 200, await saveUserScene(await readBody(req, 70 * 1024 * 1024), identity));
      } catch (error) {
        return send(res, Number(error.status) || 400, { ok: false, message: error.message });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/v1/spots/private/import") {
      try {
        const payload = await readBody(req);
        return send(res, 200, await importCloudScene(payload.name, identity));
      } catch (error) {
        return send(res, Number(error.status) || 400, { ok: false, message: error.message });
      }
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/api/v1/spots/private/")) {
      try {
        const sceneId = decodeURIComponent(url.pathname.slice("/api/v1/spots/private/".length));
        return send(res, 200, await deleteUserScene(sceneId, identity));
      } catch (error) {
        return send(res, Number(error.status) || 500, { ok: false, message: error.message });
      }
    }
    if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res, identity);
    return send(res, 404, { ok: false, message: "\u63A5\u53E3\u4E0D\u5B58\u5728" });
  } catch (error) {
    return send(res, 500, { ok: false, message: error.message });
  }
});
if (REQUIRE_SUPABASE && !isSupabaseConfigured()) {
  console.error("Supabase is required but not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
server.listen(PORT, HOST, () => {
  console.log(`Route planner server: http://${HOST}:${PORT}`);
  console.log(`Caddy email header: ${USER_EMAIL_HEADER} (required: ${REQUIRE_USER_EMAIL})`);
  console.log(`Export folder: ${ROUTE_ROOT}`);
  console.log(`Config file candidates: ${KEY_CANDIDATES.join(" | ")}`);
  console.log(`Supabase configured: ${isSupabaseConfigured()}`);
  const amap = readAmapConfig();
  console.log(`Amap key configured: ${Boolean(amap.key && amap.securityJsCode)}`);
});
