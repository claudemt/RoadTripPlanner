const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {spawn} = require('child_process');

const SERVER_ROOT = __dirname;
const APPLICATION_ROOT = path.dirname(SERVER_ROOT);
const AMAP_ROOT = path.dirname(APPLICATION_ROOT);
const DATA_ROOT = path.join(AMAP_ROOT, 'data');
const CONFIG_ROOT = path.join(DATA_ROOT, 'config');
const REMOTION_ROOT = path.join(APPLICATION_ROOT, 'video');
const REMOTION_DATA = path.join(REMOTION_ROOT, 'src', 'projects', 'amap-route-video', 'data', 'route-video-data.json');
const ROUTE_ROOT = path.join(DATA_ROOT, 'routes');
const PUBLIC_ROOT = path.join(APPLICATION_ROOT, 'web');
const SCENE_ROOT = path.join(DATA_ROOT, 'scenes');
const PORT = Number(process.env.AMAP_ROUTE_PORT || 6137);
const MAX_BODY = 220 * 1024 * 1024;
const REMOTION_CONCURRENCY = String(process.env.ROUTE_RENDER_CONCURRENCY || 4);
const REMOTION_CRF = String(process.env.ROUTE_RENDER_CRF || 20);
const KEY_CANDIDATES = [
  path.join(CONFIG_ROOT, 'local.env'),
  path.join(AMAP_ROOT, '.env.local'),
  path.join(AMAP_ROOT, '.env'),
];
const NODE_MODULE_ROOTS = [
  path.join(APPLICATION_ROOT, 'node_modules'),
  path.join(AMAP_ROOT, 'node_modules'),
];

const resolveNodeModuleFile = (...parts) => {
  const found = NODE_MODULE_ROOTS
    .map((root) => path.join(root, ...parts))
    .find((candidate) => fs.existsSync(candidate));
  return found || path.join(NODE_MODULE_ROOTS[0], ...parts);
};

let rendering = false;
let activeExport = null;
let exportProgress = {
  active: false,
  done: false,
  error: null,
  phase: 'idle',
  message: '',
  percent: 0,
  startedAt: null,
  updatedAt: null,
};

const writeFileAtomic = (target, text) => {
  ensureDir(path.dirname(target));
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, text, 'utf8');
  fs.renameSync(temp, target);
};

const normalizeAssetPath = (value) =>
  String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');

const isPathInside = (root, target) => {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
};

const toPublicAssetPath = (value) => {
  const absolute = path.resolve(value);
  if (isPathInside(SCENE_ROOT, absolute)) {
    return `scene/${path.relative(SCENE_ROOT, absolute).replace(/\\/g, '/')}`;
  }
  if (isPathInside(ROUTE_ROOT, absolute)) {
    return `route/${path.relative(ROUTE_ROOT, absolute).replace(/\\/g, '/')}`;
  }
  if (isPathInside(PUBLIC_ROOT, absolute)) {
    return path.relative(PUBLIC_ROOT, absolute).replace(/\\/g, '/');
  }
  return path.relative(AMAP_ROOT, absolute).replace(/\\/g, '/');
};

const resolvePublicAssetFile = (value) => {
  const relative = normalizeAssetPath(value);
  if (relative === 'scene' || relative.startsWith('scene/')) {
    return path.resolve(SCENE_ROOT, relative.slice('scene'.length).replace(/^\/+/, ''));
  }
  if (relative === 'route' || relative.startsWith('route/')) {
    return path.resolve(ROUTE_ROOT, relative.slice('route'.length).replace(/^\/+/, ''));
  }
  return path.resolve(AMAP_ROOT, relative);
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

const prepareRemotionPublicDir = (videoData) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadtrip-remotion-public-'));
  collectRemotionAssets(videoData).forEach((relative) => {
    const source = resolvePublicAssetFile(relative);
    if (!isPathInside(AMAP_ROOT, source) || !fs.existsSync(source) || fs.statSync(source).isDirectory()) return;
    const target = path.join(tempDir, relative);
    ensureDir(path.dirname(target));
    fs.copyFileSync(source, target);
  });
  return tempDir;
};

const cleanupTempDir = (tempDir) => {
  try {
    fs.rmSync(tempDir, {recursive: true, force: true});
  } catch (_) {}
};

class ExportCancelledError extends Error {
  constructor(message = '导出已终止') {
    super(message);
    this.name = 'ExportCancelledError';
    this.code = 'EXPORT_CANCELLED';
  }
}

const createExportTask = () => ({
  id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  cancelled: false,
  children: new Set(),
});

const killProcessTree = (pid) => {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {windowsHide: true, stdio: 'ignore'}).on('error', () => {});
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (_) {}
};

const trackChildProcess = (child) => {
  const task = activeExport;
  if (!task || !child) return;
  task.children.add(child);
  const untrack = () => task.children.delete(child);
  child.once('close', untrack);
  child.once('exit', untrack);
  if (task.cancelled) killProcessTree(child.pid);
};

const assertExportNotCancelled = () => {
  if (activeExport?.cancelled) throw new ExportCancelledError();
};

const cancelActiveExport = (message = '正在终止导出任务…') => {
  if (!rendering || !activeExport) return false;
  activeExport.cancelled = true;
  setExportProgress({active: true, done: false, phase: 'cancel', message, percent: exportProgress.percent});
  for (const child of [...activeExport.children]) killProcessTree(child.pid);
  return true;
};

const setExportProgress = (next = {}) => {
  const now = new Date().toISOString();
  const percent = Number.isFinite(Number(next.percent)) ? Math.max(0, Math.min(100, Number(next.percent))) : exportProgress.percent;
  exportProgress = {
    ...exportProgress,
    ...next,
    percent: next.allowDecrease ? percent : Math.max(exportProgress.percent || 0, percent),
    updatedAt: now,
  };
  return exportProgress;
};

const startExportProgress = (message = '准备导出…') => {
  const now = new Date().toISOString();
  exportProgress = {
    active: true,
    done: false,
    error: null,
    phase: 'start',
    message,
    percent: 1,
    startedAt: now,
    updatedAt: now,
  };
};

const finishExportProgress = (message = '导出完成') => setExportProgress({active: false, done: true, error: null, phase: 'done', message, percent: 100});
const failExportProgress = (error) => setExportProgress({active: false, done: true, error: error?.message || String(error || '导出失败'), phase: 'error', message: '导出失败', percent: 100});
const cancelExportProgress = (message = '导出已终止') => setExportProgress({active: false, done: true, error: null, phase: 'cancelled', message, percent: exportProgress.percent});

const updateProgressFromLog = (text, start, end, phase, fallbackMessage) => {
  const matches = String(text || '').match(/(\d{1,3}(?:\.\d+)?)\s*%/g);
  if (!matches?.length) return;
  const raw = Number(matches[matches.length - 1].replace('%', '').trim());
  if (!Number.isFinite(raw)) return;
  const percent = start + (Math.max(0, Math.min(100, raw)) / 100) * (end - start);
  setExportProgress({phase, message: fallbackMessage, percent});
};

const send = (res, status, data, contentType = 'application/json;charset=utf-8') => {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  if (contentType.startsWith('application/json')) res.end(JSON.stringify(data, null, 2));
  else res.end(data);
};

const safeName = (value) =>
  String(value || 'untitled-route')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90) || 'untitled-route';

const toBasicPoint = (point) => ({
  name: point?.name || '',
  lng: Number(point?.lng || 0),
  lat: Number(point?.lat || 0),
});

const toBasicRouteData = (routeData) => {
  if (!routeData) return null;
  return {
    id: routeData.id || routeData.name || 'untitled-route',
    name: routeData.name || '未命名线路',
    days: (routeData.days || []).map((day, dayIndex) => {
      const points = day.points || [day.from, ...(day.waypoints || []), day.to].filter(Boolean);
      return {
        title: stripDayPrefix(day.title) || `第 ${dayIndex + 1} 天`,
        from: toBasicPoint(day.from || points[0]),
        waypoints: points.slice(1, -1).map(toBasicPoint),
        to: toBasicPoint(day.to || points[points.length - 1]),
      };
    }),
  };
};

const safeExt = (name, mimeType = '') => {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) return ext;
  if (/png/i.test(mimeType)) return '.png';
  if (/webp/i.test(mimeType)) return '.webp';
  return '.jpg';
};

const ensureDir = (dir) => fs.mkdirSync(dir, {recursive: true});

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求数据太大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8') || '{}';
        resolve(JSON.parse(text));
      } catch (error) {
        reject(new Error('JSON 格式无效：' + error.message));
      }
    });
    req.on('error', reject);
  });

const getRouteName = (payload) => stripDayPrefix(payload?.route?.name || payload?.videoData?.route?.name || payload?.routeData?.name) || '未命名线路';

const stripDayPrefix = (value) => String(value || '').replace(/^\s*D\s*\d+\s*[：:、.．-]?\s*/i, '').trim();

const formatDistance = (meters) => {
  const km = Number(meters || 0) / 1000;
  if (!km) return '0 km';
  return `${km >= 100 ? km.toFixed(0) : km.toFixed(1)} km`;
};

const formatDuration = (seconds) => {
  const minutes = Math.round(Number(seconds || 0) / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h} h ${m} min` : `${m} min`;
};

const mdEscape = (value) => String(value || '').replace(/\r?\n+/g, ' ').trim();

const normalizeSceneName = (value) => String(value || '').replace(/[\s·•（）()【】\[\]《》<>“”"'：:，,。.\-—_/\\]/g, '').trim();

const toProjectImagePath = (src) => {
  const value = String(src || '').trim().replace(/\\/g, '/');
  if (!value || /^(https?:|data:|file:)/i.test(value)) return value;
  if (path.isAbsolute(value)) return value;
  return resolvePublicAssetFile(value);
};

const toMarkdownImagePath = (src, outputDir) => {
  const value = String(src || '').trim().replace(/\\/g, '/');
  if (!value || /^(https?:|data:|file:)/i.test(value)) return value;
  const absolute = path.isAbsolute(value) ? value : resolvePublicAssetFile(value);
  return path.relative(outputDir || AMAP_ROOT, absolute).replace(/\\/g, '/');
};

const markdownImage = (alt, src) => {
  const cleanAlt = String(alt || '图片').replace(/[\]\r\n]/g, ' ').trim();
  const cleanSrc = String(src || '').replace(/\r?\n/g, '').trim();
  if (!cleanSrc) return null;
  return `![${cleanAlt}](<${cleanSrc}>)`;
};

const markdownImageGrid = (spotName, sources) => {
  const images = (sources || []).filter(Boolean);
  if (!images.length) return null;
  const rows = ['<table class="manual-image-grid">'];
  for (let index = 0; index < images.length; index += 2) {
    const pair = images.slice(index, index + 2);
    const cells = pair.map((src, pairIndex) => {
      const imageNumber = index + pairIndex + 1;
      const alt = `${spotName || '景点'}照片${imageNumber}`;
      return `<td><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" /><br /><sub>${escapeHtml(alt)}</sub></td>`;
    });
    if (cells.length === 1) cells.push('<td></td>');
    rows.push(`<tr>${cells.join('')}</tr>`);
  }
  rows.push('</table>');
  return rows.join('\n');
};

const findSceneSpot = (name) => {
  const target = normalizeSceneName(name);
  if (!target || !fs.existsSync(SCENE_ROOT)) return null;
  const folders = fs.readdirSync(SCENE_ROOT, {withFileTypes: true}).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const spots = folders
    .map((folder) => parseSceneFile(path.join(SCENE_ROOT, folder, `${folder}.js`)))
    .filter(Boolean);
  return spots.find((spot) => normalizeSceneName(spot.name) === target) || null;
};

const scenicImagesForManual = (spot, outputDir, limit = 4) =>
  (spot?.images || [])
    .filter((src) => {
      const imagePath = toProjectImagePath(src);
      return /^(https?:|data:|file:)/i.test(imagePath) || fs.existsSync(imagePath);
    })
    .slice(0, limit)
    .map((src) => toMarkdownImagePath(src, outputDir));

const buildTravelManual = (videoData, routeData, options = {}) => {
  const routeName = videoData?.route?.name || routeData?.name || '自驾路线';
  const days = videoData?.days || [];
  const lines = [];
  lines.push(`# ${mdEscape(routeName)}路线手册`);
  lines.push('');
  if (videoData?.summary) {
    lines.push(`- 天数：${videoData.summary.dayCount || days.length} 天`);
    lines.push(`- 全程：${formatDistance(videoData.summary.totalDistance)} / ${formatDuration(videoData.summary.totalDuration)}`);
    lines.push('');
  }
  if (options.routeMapImage) {
    lines.push('## 全程地图');
    lines.push('');
    lines.push(markdownImage(`${routeName}全程地图`, options.routeMapImage));
    lines.push('');
  }
  days.forEach((day, dayIndex) => {
    const title = stripDayPrefix(day.title) || `第 ${dayIndex + 1} 天`;
    const dayDistance = (day.segments || []).reduce((sum, seg) => sum + Number(seg.distance || 0), 0);
    const dayDuration = (day.segments || []).reduce((sum, seg) => sum + Number(seg.duration || 0), 0);
    lines.push(`## D${dayIndex + 1} ${mdEscape(title)}`);
    lines.push('');
    lines.push(`- 当天合计：${formatDistance(dayDistance)} / ${formatDuration(dayDuration)}`);
    lines.push(`- 路线：${(day.points || []).map((p) => mdEscape(p.name)).join(' → ')}`);
    lines.push('');
    lines.push('### 分段间隔');
    (day.segments || []).forEach((seg, segIndex) => {
      const from = mdEscape(seg.from || day.points?.[segIndex]?.name || '上一点');
      const to = mdEscape(seg.to || day.points?.[segIndex + 1]?.name || '下一点');
      const suffix = seg.error ? `（路线异常：${mdEscape(seg.error)}）` : '';
      lines.push(`- ${from} → ${to}：${formatDistance(seg.distance)} / ${formatDuration(seg.duration)}${suffix}`);
    });
    lines.push('');
    lines.push('### 点位说明');
    (day.points || []).forEach((point) => {
      const role = point.kind === 'from' ? '起点' : point.kind === 'to' ? '终点' : '途径点';
      const scenic = findSceneSpot(point.name);
      lines.push(`- **${role}｜${mdEscape(point.name)}**`);
      if (point.kind !== 'from' && scenic?.description) lines.push(`  - ${mdEscape(scenic.description)}`);
      const images = point.kind === 'from' ? [] : scenicImagesForManual(scenic, options.outputDir);
      if (images.length) {
        lines.push('');
        lines.push(markdownImageGrid(point.name, images));
        lines.push('');
      }
    });
    lines.push('');
  });
  return lines.join('\n');
};

const escapeHtml = (value) =>
  String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const inlineMd = (value) => {
  let text = escapeHtml(value);
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/`(.+?)`/g, '<code>$1</code>');
  return text;
};

const toFileUrl = (file) => encodeURI('file:///' + path.resolve(file).replace(/\\/g, '/'));

const resolveMarkdownImageSrc = (src, baseDir) => {
  const value = String(src || '').trim();
  if (/^(https?:|data:|file:)/i.test(value)) return value;
  const absolute = path.isAbsolute(value) ? value : path.join(baseDir || AMAP_ROOT, value);
  return toFileUrl(absolute);
};

const isManualImageGridHtml = (line) =>
  /^<\/?(table|tr)\b/i.test(line.trim()) ||
  /^<td\b/i.test(line.trim()) ||
  /^<\/td>/i.test(line.trim());

const normalizeManualImageGridHtml = (line, baseDir) =>
  line.replace(/(<img\b[^>]*\bsrc=")([^"]*)(")/gi, (_, before, src, after) =>
    `${before}${escapeHtml(resolveMarkdownImageSrc(src, baseDir))}${after}`);

const markdownToHtmlDocument = (markdown, title, baseDir = AMAP_ROOT) => {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const parts = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      parts.push('</ul>');
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
      parts.push('<hr />');
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
      parts.push(`<h${level}>${inlineMd(heading[2])}</h${level}>`);
      continue;
    }
    const image = line.match(/^!\[([^\]]*)\]\((?:<([^>]+)>|([^)]+))\)\s*$/);
    if (image) {
      closeList();
      const alt = image[1] || '图片';
      const src = resolveMarkdownImageSrc(image[2] || image[3], baseDir);
      parts.push(`<figure><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" /><figcaption>${escapeHtml(alt)}</figcaption></figure>`);
      continue;
    }
    const bullet = line.match(/^\s*-\s+(.*)$/);
    if (bullet) {
      if (!inList) {
        parts.push('<ul>');
        inList = true;
      }
      parts.push(`<li>${inlineMd(bullet[1])}</li>`);
      continue;
    }
    closeList();
    parts.push(`<p>${inlineMd(line)}</p>`);
  }
  closeList();
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title || '路线手册')}</title>
  <style>
    @page { margin: 18mm 16mm; }
    body {
      font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif;
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
${parts.join('\n')}
</body>
</html>`;
};

const loadJson = (file, fallback = null) => {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
};

const parseSceneFile = (file) => {
  try {
    if (!fs.existsSync(file)) return null;
    const text = fs.readFileSync(file, 'utf8');
    const match = text.match(/window\.SCENIC_SPOTS\.push\(([\s\S]*?)\);\s*$/);
    if (!match) return null;
    return JSON.parse(match[1]);
  } catch (_) {
    return null;
  }
};

const writeSceneInfo = (payload) => {
  const pointName = String(payload.name || payload.title || '').trim();
  if (!pointName) throw new Error('景点名称不能为空');
  const folderName = safeName(pointName);
  const dir = path.join(SCENE_ROOT, folderName);
  ensureDir(dir);

  const sceneFile = path.join(dir, `${folderName}.js`);
  const existing = parseSceneFile(sceneFile) || {};
  const images = Array.isArray(existing.images) ? [...existing.images] : [];
  const incoming = Array.isArray(payload.images) ? payload.images : [];

  incoming.forEach((image, index) => {
    const dataUrl = String(image.dataUrl || '');
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return;
    const ext = safeExt(image.name, match[1]);
    const filename = `${folderName}-photo-${String(images.length + index + 1).padStart(2, '0')}${ext}`;
    const target = path.join(dir, filename);
    fs.writeFileSync(target, Buffer.from(match[2], 'base64'));
    const publicPath = `scene/${folderName}/${filename}`;
    if (!images.includes(publicPath)) images.push(publicPath);
  });

  const spot = {
    title: String(payload.title || existing.title || pointName).trim(),
    name: pointName,
    images,
    description: String(payload.description || existing.description || '').trim(),
  };
  const js = `window.SCENIC_SPOTS = window.SCENIC_SPOTS || [];\nwindow.SCENIC_SPOTS.push(${JSON.stringify(spot, null, 2)});\n`;
  fs.writeFileSync(sceneFile, js, 'utf8');
  return {folderName, file: sceneFile, spot};
};

const stripQuote = (value) => String(value || '').trim().replace(/^['"]|['"]$/g, '');

const readKeyFile = () => {
  const result = {};
  for (const file of KEY_CANDIDATES) {
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^([A-Za-z0-9_\u4e00-\u9fff]+)\s*=\s*(.*)$/);
      if (!m) continue;
      const k = m[1].trim();
      const v = stripQuote(m[2]);
      if (!v) continue;
      if ((/^AMAP_KEY$/i.test(k) || /^Key$/i.test(k) || k === 'REMOTION_AMAP_KEY') && !result.key) result.key = v;
      if ((/^AMAP_SECURITY_JS_CODE$/i.test(k) || /^securityJsCode$/i.test(k) || /^SECURITY_JS_CODE$/i.test(k) || k === '安全密钥' || k === 'REMOTION_AMAP_SECURITY_CODE') && !result.securityJsCode) result.securityJsCode = v;
    }
  }
  return result;
};

const writeKeyFile = ({key, securityJsCode}) => {
  ensureDir(CONFIG_ROOT);
  const target = path.join(CONFIG_ROOT, 'local.env');
  const content = [
    '# Local private config (gitignored)',
    `# updated: ${new Date().toISOString()}`,
    `AMAP_KEY=${key || ''}`,
    `AMAP_SECURITY_JS_CODE=${securityJsCode || ''}`,
    `REMOTION_AMAP_KEY=${key || ''}`,
    `REMOTION_AMAP_SECURITY_CODE=${securityJsCode || ''}`,
    'AMAP_ROUTE_PORT=6137',
    '',
  ].join('\n');
  fs.writeFileSync(target, content, 'utf8');
  return target;
};

const resolveBrowserPath = () => {
  if (process.env.AMAP_BROWSER_PATH && fs.existsSync(process.env.AMAP_BROWSER_PATH)) return process.env.AMAP_BROWSER_PATH;
  const candidates = [
    path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
  return candidates.find((item) => item && fs.existsSync(item)) || null;
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const requestJson = (method, url, body = null) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request(
      {
        method,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => {
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
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });

const getFreePort = () =>
  new Promise((resolve, reject) => {
    const server = http.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close(() => {
        if (!port) reject(new Error('无法分配临时端口'));
        else resolve(port);
      });
    });
  });

const openCdpSession = async (wsUrl) => {
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('浏览器 CDP 连接超时')), 10000);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener('error', (event) => {
      clearTimeout(timer);
      reject(event.error || new Error('浏览器 CDP 连接失败'));
    });
  });

  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener('message', (event) => {
    const data = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8');
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
      if (message.error) entry.reject(new Error(message.error.message || 'CDP 调用失败'));
      else entry.resolve(message.result);
      return;
    }
    const handlers = listeners.get(message.method);
    if (handlers) {
      handlers.forEach((handler) => handler(message.params || {}));
    }
  });

  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, {resolve, reject});
      socket.send(JSON.stringify({id, method, params}));
    });

  const waitFor = (method, timeout = 15000) =>
    new Promise((resolve, reject) => {
      const handler = (params) => {
        cleanup();
        resolve(params);
      };
      const cleanup = () => {
        clearTimeout(timer);
        const list = listeners.get(method) || [];
        listeners.set(method, list.filter((item) => item !== handler));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`等待 ${method} 超时`));
      }, timeout);
      const list = listeners.get(method) || [];
      list.push(handler);
      listeners.set(method, list);
    });

  return {
    call,
    waitFor,
    close: () => socket.close(),
  };
};

const renderMarkdownPdf = async (markdown, pdfPath, title, baseDir = AMAP_ROOT) => {
  const browserPath = resolveBrowserPath();
  if (!browserPath) throw new Error('未找到 Chrome/Edge，无法将 Markdown 渲染为 PDF');

  ensureDir(path.dirname(pdfPath));
  const html = markdownToHtmlDocument(markdown, title, baseDir);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amap-travel-pdf-'));
  const htmlPath = path.join(tempDir, 'manual.html');
  const profileDir = path.join(tempDir, 'profile');
  ensureDir(profileDir);
  fs.writeFileSync(htmlPath, html, 'utf8');

  const fileUrl = 'file:///' + htmlPath.replace(/\\/g, '/');
  const debugPort = await getFreePort();
  const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profileDir}`, `--remote-debugging-port=${debugPort}`, 'about:blank'];
  let child = null;

  try {
    await new Promise((resolve, reject) => {
      child = spawn(browserPath, args, {windowsHide: true});
      trackChildProcess(child);
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.once('error', reject);
      (async () => {
        try {
          const versionUrl = `http://127.0.0.1:${debugPort}/json/version`;
          let version = null;
          for (let attempt = 0; attempt < 60; attempt++) {
            try {
              version = await requestJson('GET', versionUrl);
              break;
            } catch (_) {
              await delay(250);
            }
          }
          if (!version?.webSocketDebuggerUrl) throw new Error('无法连接浏览器调试端口');
          const page = await requestJson('PUT', `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent('about:blank')}`);
          if (!page?.webSocketDebuggerUrl) throw new Error('无法创建 PDF 页面');
          const cdp = await openCdpSession(page.webSocketDebuggerUrl);
          await cdp.call('Page.enable');
          const loadEvent = cdp.waitFor('Page.loadEventFired');
          await cdp.call('Page.navigate', {url: fileUrl});
          await loadEvent;
          await delay(300);
          const pdf = await cdp.call('Page.printToPDF', {
            printBackground: true,
            preferCSSPageSize: true,
            displayHeaderFooter: true,
            headerTemplate: '<span></span>',
            footerTemplate: '<div style="width:100%; font-size:9px; color:#6b7280; padding:0 16mm; text-align:center;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
            marginTop: 0.2,
            marginBottom: 0.45,
            marginLeft: 0,
            marginRight: 0,
          });
          fs.writeFileSync(pdfPath, Buffer.from(pdf.data, 'base64'));
          cdp.close();
          await requestJson('GET', `http://127.0.0.1:${debugPort}/json/close/${page.id}`).catch(() => {});
          child?.kill();
          resolve();
        } catch (error) {
          child?.kill();
          reject(error);
        }
      })();
      child.on('close', (code) => {
        if (activeExport?.cancelled) {
          reject(new ExportCancelledError());
          return;
        }
        if (code !== 0 && !fs.existsSync(pdfPath)) {
          reject(new Error(`浏览器打印 PDF 失败（退出码 ${code}）${stderr ? '：' + stderr.trim() : ''}`));
        }
      });
    });
    return pdfPath;
  } finally {
    if (child && !child.killed) {
      try {
        child.kill();
      } catch (_) {}
    }
    try {
      fs.rmSync(tempDir, {recursive: true, force: true});
    } catch (_) {}
  }
};

const archivePayload = (payload) => {
  const routeName = getRouteName(payload);
  const name = safeName(routeName);
  const dir = path.join(ROUTE_ROOT, name);
  ensureDir(dir);

  const routeData = payload.routeData || payload.route || null;
  const videoData = payload.videoData || null;
  const routeMapImage = path.join(dir, `${name}.route-map.png`);
  const mapBgImage = path.join(dir, `${name}.map-bg.png`);
  const now = new Date().toISOString();
  let manualMd = null;
  let manualText = '';

  if (routeData) writeFileAtomic(path.join(dir, `${name}.route.json`), JSON.stringify(toBasicRouteData(routeData), null, 2));
  if (videoData) {
    writeFileAtomic(path.join(dir, `${name}.mp4-data.json`), JSON.stringify(videoData, null, 2));
    manualText = buildTravelManual(videoData, routeData, {outputDir: dir, routeMapImage: path.basename(routeMapImage)});
    manualMd = path.join(dir, `${name}.travel.md`);
    writeFileAtomic(manualMd, manualText);
  }
  writeFileAtomic(
    path.join(dir, 'metadata.json'),
    JSON.stringify(
      {
        routeName,
        safeName: name,
        archivedAt: now,
        mapLayer: videoData?.mapLayer || payload.mapLayer || null,
      },
      null,
      2,
    ),
  );

  return {
    routeName,
    safeName: name,
    dir,
    routeJson: path.join(dir, `${name}.route.json`),
    videoJson: path.join(dir, `${name}.mp4-data.json`),
    routeMapImage,
    mapBgImage,
    manualMd,
    manualText,
  };
};

const runRemotion = ({videoData, output, config, logFile, progressStart = 24, progressEnd = 78}) =>
  new Promise((resolve, reject) => {
    try {
      assertExportNotCancelled();
    } catch (error) {
      reject(error);
      return;
    }
    ensureDir(path.dirname(REMOTION_DATA));
    fs.writeFileSync(REMOTION_DATA, JSON.stringify(videoData, null, 2), 'utf8');
    ensureDir(path.dirname(output));

    const keys = readKeyFile();
    const publicDir = prepareRemotionPublicDir(videoData);
    const env = {
      ...process.env,
      REMOTION_PUBLIC_DIR: publicDir,
      REMOTION_AMAP_KEY: config?.key || keys.key || process.env.REMOTION_AMAP_KEY || '',
      REMOTION_AMAP_SECURITY_CODE: config?.securityJsCode || keys.securityJsCode || process.env.REMOTION_AMAP_SECURITY_CODE || '',
    };
    const browserExecutable = resolveBrowserPath();
    const remotionCli = resolveNodeModuleFile('@remotion', 'cli', 'remotion-cli.js');
    const remotionArgs = fs.existsSync(remotionCli)
      ? [remotionCli, 'render', 'src/index.ts', 'AmapRouteVideo', output, '--codec=h264', '--pixel-format=yuv420p', `--crf=${REMOTION_CRF}`, '--timeout=300000', `--concurrency=${REMOTION_CONCURRENCY}`]
      : ['remotion', 'render', 'src/index.ts', 'AmapRouteVideo', output, '--codec=h264', '--pixel-format=yuv420p', `--crf=${REMOTION_CRF}`, '--timeout=300000', `--concurrency=${REMOTION_CONCURRENCY}`];
    if (browserExecutable) remotionArgs.push(`--browser-executable=${browserExecutable}`);
    const command = fs.existsSync(remotionCli) ? process.execPath : process.platform === 'win32' ? 'cmd.exe' : 'npx';
    const args = fs.existsSync(remotionCli) ? remotionArgs : process.platform === 'win32' ? ['/d', '/s', '/c', 'npx', ...remotionArgs] : remotionArgs;
    const child = spawn(command, args, {cwd: REMOTION_ROOT, env, windowsHide: true});
    trackChildProcess(child);
    const logs = [];
    const pushLog = (chunk) => {
      const text = chunk.toString();
      logs.push(text);
      fs.appendFileSync(logFile, text, 'utf8');
      updateProgressFromLog(text, progressStart, progressEnd, 'mp4', '正在渲染 MP4…');
    };
    fs.writeFileSync(logFile, `开始渲染：${new Date().toLocaleString()}\n输出：${output}\n浏览器：${browserExecutable || 'Remotion 默认'}\nPublic：${publicDir}\n\n`, 'utf8');
    child.stdout.on('data', pushLog);
    child.stderr.on('data', pushLog);
    child.on('error', (error) => {
      cleanupTempDir(publicDir);
      reject(error);
    });
    child.on('close', (code) => {
      cleanupTempDir(publicDir);
      if (activeExport?.cancelled) {
        reject(new ExportCancelledError());
        return;
      }
      if (code === 0) resolve({output, log: logs.join('')});
      else reject(new Error(`Remotion 渲染失败，退出码 ${code}。请查看日志：${logFile}`));
    });
  });

const runRemotionStill = ({videoData, output, config, logFile, frame = 12, progressStart = 82, progressEnd = 90}) =>
  new Promise((resolve, reject) => {
    try {
      assertExportNotCancelled();
    } catch (error) {
      reject(error);
      return;
    }
    ensureDir(path.dirname(REMOTION_DATA));
    fs.writeFileSync(REMOTION_DATA, JSON.stringify(videoData, null, 2), 'utf8');
    ensureDir(path.dirname(output));

    const keys = readKeyFile();
    const publicDir = prepareRemotionPublicDir(videoData);
    const env = {
      ...process.env,
      REMOTION_PUBLIC_DIR: publicDir,
      REMOTION_AMAP_KEY: config?.key || keys.key || process.env.REMOTION_AMAP_KEY || '',
      REMOTION_AMAP_SECURITY_CODE: config?.securityJsCode || keys.securityJsCode || process.env.REMOTION_AMAP_SECURITY_CODE || '',
    };
    const browserExecutable = resolveBrowserPath();
    const remotionCli = resolveNodeModuleFile('@remotion', 'cli', 'remotion-cli.js');
    const remotionArgs = fs.existsSync(remotionCli)
      ? [remotionCli, 'still', 'src/index.ts', 'AmapRouteVideo', output, `--frame=${frame}`, '--timeout=300000']
      : ['remotion', 'still', 'src/index.ts', 'AmapRouteVideo', output, `--frame=${frame}`, '--timeout=300000'];
    if (browserExecutable) remotionArgs.push(`--browser-executable=${browserExecutable}`);
    const command = fs.existsSync(remotionCli) ? process.execPath : process.platform === 'win32' ? 'cmd.exe' : 'npx';
    const args = fs.existsSync(remotionCli) ? remotionArgs : process.platform === 'win32' ? ['/d', '/s', '/c', 'npx', ...remotionArgs] : remotionArgs;
    const child = spawn(command, args, {cwd: REMOTION_ROOT, env, windowsHide: true});
    trackChildProcess(child);
    const logs = [];
    const pushLog = (chunk) => {
      const text = chunk.toString();
      logs.push(text);
      fs.appendFileSync(logFile, text, 'utf8');
      updateProgressFromLog(text, progressStart, progressEnd, 'map', '正在生成路线图片…');
    };
    fs.appendFileSync(logFile, `\n开始渲染路线总览图：${new Date().toLocaleString()}\n输出：${output}\n浏览器：${browserExecutable || 'Remotion 默认'}\nPublic：${publicDir}\n\n`, 'utf8');
    child.stdout.on('data', pushLog);
    child.stderr.on('data', pushLog);
    child.on('error', (error) => {
      cleanupTempDir(publicDir);
      reject(error);
    });
    child.on('close', (code) => {
      cleanupTempDir(publicDir);
      if (activeExport?.cancelled) {
        reject(new ExportCancelledError());
        return;
      }
      if (code === 0 && fs.existsSync(output)) resolve({output, log: logs.join('')});
      else reject(new Error(`Remotion 总览图渲染失败，退出码 ${code}。请查看日志：${logFile}`));
    });
  });

const findRouteJson = (dir, entryName) => {
  const preferred = path.join(dir, `${entryName}.route.json`);
  if (fs.existsSync(preferred)) return preferred;
  const hit = fs.readdirSync(dir).find((name) => name.toLowerCase().endsWith('.route.json'));
  return hit ? path.join(dir, hit) : null;
};

const existingFile = (...files) => files.find((file) => fs.existsSync(file)) || null;

const latestMtimeIso = (files, fallback) =>
  files
    .filter(Boolean)
    .filter((file) => fs.existsSync(file))
    .map((file) => fs.statSync(file).mtime)
    .reduce((latest, mtime) => (mtime > latest ? mtime : latest), fallback)
    .toISOString();

const listArchivedRoutes = () => {
  if (!fs.existsSync(ROUTE_ROOT)) return [];
  return fs
    .readdirSync(ROUTE_ROOT, {withFileTypes: true})
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(ROUTE_ROOT, entry.name);
      const metadata = loadJson(path.join(dir, 'metadata.json'), {});
      const routeJsonPath = findRouteJson(dir, entry.name);
      const routeData = routeJsonPath ? loadJson(routeJsonPath, null) : null;
      const stat = fs.statSync(dir);
      const baseName = routeJsonPath ? path.basename(routeJsonPath, '.route.json') : entry.name;
      const videoJsonPath = existingFile(path.join(dir, `${baseName}.mp4-data.json`), path.join(dir, `${entry.name}.mp4-data.json`));
      const mp4Path = existingFile(path.join(dir, `${baseName}.mp4`), path.join(dir, `${entry.name}.mp4`));
      const manualMdPath = existingFile(path.join(dir, `${baseName}.travel.md`), path.join(dir, `${entry.name}.travel.md`));
      const manualPdfPath = existingFile(path.join(dir, `${baseName}.travel.pdf`), path.join(dir, `${entry.name}.travel.pdf`));
      const updatedAt = latestMtimeIso([routeJsonPath, videoJsonPath, mp4Path, manualMdPath, manualPdfPath, path.join(dir, `${baseName}.route-map.png`)], stat.mtime);
      return {
        name: metadata.routeName || routeData?.name || entry.name,
        safeName: entry.name,
        fileBase: baseName,
        dir,
        archivedAt: metadata.archivedAt || stat.mtime.toISOString(),
        updatedAt,
        mapLayer: metadata.mapLayer || null,
        routeJson: Boolean(routeJsonPath),
        videoJson: Boolean(videoJsonPath),
        mp4: Boolean(mp4Path),
        manualMd: Boolean(manualMdPath),
        manualPdf: Boolean(manualPdfPath),
        routeData,
      };
    })
    .filter((item) => item.routeJson && item.routeData)
    .sort((a, b) => String(b.archivedAt).localeCompare(String(a.archivedAt)));
};

const serveStatic = (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  let root = PUBLIC_ROOT;
  let relativePath = pathname;
  if (pathname.startsWith('/scene/')) {
    root = SCENE_ROOT;
    relativePath = pathname.slice('/scene'.length);
  } else if (pathname.startsWith('/route/')) {
    root = ROUTE_ROOT;
    relativePath = pathname.slice('/route'.length);
  }
  const target = path.resolve(root, `.${relativePath}`);
  const rootPrefix = `${path.resolve(root)}${path.sep}`;
  if (target !== path.resolve(root) && !target.startsWith(rootPrefix)) {
    return send(res, 403, 'Forbidden', 'text/plain;charset=utf-8');
  }
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) return send(res, 404, 'Not found', 'text/plain;charset=utf-8');
  const ext = path.extname(target).toLowerCase();
  const mime =
    ext === '.html'
      ? 'text/html;charset=utf-8'
      : ext === '.js'
        ? 'text/javascript;charset=utf-8'
        : ext === '.css'
          ? 'text/css;charset=utf-8'
          : ext === '.json'
            ? 'application/json;charset=utf-8'
            : ext === '.md'
              ? 'text/markdown;charset=utf-8'
              : ext === '.pdf'
                ? 'application/pdf'
                : ext === '.mp4'
                  ? 'video/mp4'
                  : ext === '.png'
                    ? 'image/png'
                    : ext === '.jpg' || ext === '.jpeg'
                      ? 'image/jpeg'
                      : 'application/octet-stream';
  const stat = fs.statSync(target);
  res.writeHead(200, {
    'Content-Type': mime,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
    'Last-Modified': stat.mtime.toUTCString(),
  });
  fs.createReadStream(target).pipe(res);
};

const exportRouteBundle = async (payload) => {
  const renderVideo = payload.renderVideo === true;
  assertExportNotCancelled();
  setExportProgress({phase: 'files', message: '正在保存路线数据…', percent: 5});
  const archived = archivePayload(payload);
  assertExportNotCancelled();
  setExportProgress({phase: 'manual', message: '正在生成 MD 手册…', percent: 14});
  const output = path.join(archived.dir, `${archived.safeName}.mp4`);
  const logFile = path.join(archived.dir, 'latest-render.log');
  let result = {output: null};
  let routeMapImage = archived.routeMapImage;
  let routeMapError = null;
  let mapBgImage = null;
  let mapBgError = null;
  const baseVideoData = payload.videoData || {};
  if (renderVideo) {
    try {
      assertExportNotCancelled();
      setExportProgress({phase: 'map', message: '正在缓存地图底图…', percent: 18});
      await runRemotionStill({
        videoData: {...baseVideoData, renderMode: 'mapOnly'},
        output: archived.mapBgImage,
        config: payload.config,
        logFile,
        frame: 0,
        progressStart: 18,
        progressEnd: 24,
      });
      mapBgImage = archived.mapBgImage;
    } catch (error) {
      mapBgError = error.message;
      mapBgImage = fs.existsSync(archived.mapBgImage) ? archived.mapBgImage : null;
    }
    assertExportNotCancelled();
    setExportProgress({phase: 'mp4', message: '正在渲染 MP4…', percent: 24});
    result = await runRemotion({
      videoData: {
        ...baseVideoData,
        renderMode: 'video',
        ...(mapBgImage ? {staticMapImage: toPublicAssetPath(mapBgImage)} : {}),
      },
      output,
      config: payload.config,
      logFile,
      progressStart: 24,
      progressEnd: 78,
    });
  } else {
    setExportProgress({phase: 'map', message: '正在生成路线图片…', percent: 42});
  }
  try {
    assertExportNotCancelled();
    const progressStart = renderVideo ? 82 : 42;
    const progressEnd = renderVideo ? 90 : 82;
    setExportProgress({phase: 'map', message: '正在生成路线图片…', percent: progressStart});
    await runRemotionStill({
      videoData: {
        ...baseVideoData,
        renderMode: 'overview',
        ...(mapBgImage ? {staticMapImage: toPublicAssetPath(mapBgImage)} : {}),
      },
      output: archived.routeMapImage,
      config: payload.config,
      logFile,
      frame: 0,
      progressStart,
      progressEnd,
    });
  } catch (error) {
    routeMapError = error.message;
    routeMapImage = null;
    archived.manualText = buildTravelManual(payload.videoData, payload.routeData || payload.route, {outputDir: archived.dir});
    if (archived.manualMd) writeFileAtomic(archived.manualMd, archived.manualText);
  }

  let manualPdf = null;
  let pdfError = null;
  if (archived.manualText) {
    try {
      assertExportNotCancelled();
      setExportProgress({phase: 'pdf', message: '正在生成 PDF…', percent: 92});
      manualPdf = path.join(archived.dir, `${archived.safeName}.travel.pdf`);
      await renderMarkdownPdf(archived.manualText, manualPdf, `${archived.routeName}路线手册`, archived.dir);
    } catch (error) {
      pdfError = error.message;
      manualPdf = null;
    }
  }

  return {
    ...archived,
    manualText: undefined,
    output: result.output,
    logFile,
    routeMapImage,
    routeMapError,
    mapBgImage,
    mapBgError,
    manualPdf,
    pdfError,
  };
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (req.method === 'GET' && url.pathname === '/api/health') {
      const keys = readKeyFile();
      return send(res, 200, {
        ok: true,
        routeRoot: ROUTE_ROOT,
        remotionRoot: REMOTION_ROOT,
        rendering,
        exportTaskId: activeExport?.id || null,
        hasKeyFile: Boolean(keys.key && keys.securityJsCode),
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/config') {
      const keys = readKeyFile();
      return send(res, 200, {
        ok: true,
        key: keys.key || '',
        securityJsCode: keys.securityJsCode || '',
        configured: Boolean(keys.key && keys.securityJsCode),
        source: keys.key ? 'data/config/local.env' : null,
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/config') {
      const payload = await readBody(req);
      const key = String(payload.key || '').trim();
      const securityJsCode = String(payload.securityJsCode || '').trim();
      if (!key || !securityJsCode) return send(res, 400, {ok: false, message: 'Key 和安全密钥都必填'});
      const file = writeKeyFile({key, securityJsCode});
      return send(res, 200, {ok: true, file, key, securityJsCode});
    }
    if (req.method === 'POST' && url.pathname === '/api/scenic') {
      const payload = await readBody(req);
      const result = writeSceneInfo(payload);
      return send(res, 200, {ok: true, ...result});
    }
    if (req.method === 'GET' && url.pathname === '/api/routes') {
      const routes = listArchivedRoutes().map((item) => ({
        name: item.name,
        safeName: item.safeName,
        fileBase: item.fileBase,
        dir: item.dir,
        archivedAt: item.archivedAt,
        updatedAt: item.updatedAt,
        mapLayer: item.mapLayer,
        routeJson: item.routeJson,
        videoJson: item.videoJson,
        mp4: item.mp4,
        manualMd: item.manualMd,
        manualPdf: item.manualPdf,
        routeData: item.routeData,
      }));
      return send(res, 200, {ok: true, routes});
    }
    if (req.method === 'GET' && url.pathname === '/api/export-progress') {
      return send(res, 200, {ok: true, rendering, exportTaskId: activeExport?.id || null, progress: exportProgress});
    }
    if (req.method === 'POST' && url.pathname === '/api/export-cancel') {
      const cancelled = cancelActiveExport();
      if (!cancelled) {
        return send(res, 200, {ok: true, cancelled: false, rendering, progress: exportProgress, message: '当前没有导出任务'});
      }
      return send(res, 200, {ok: true, cancelled: true, rendering: true, exportTaskId: activeExport?.id || null, progress: exportProgress});
    }
    if (req.method === 'POST' && (url.pathname === '/api/export-route' || url.pathname === '/api/render-video' || url.pathname === '/api/archive-route')) {
      if (rendering) return send(res, 409, {ok: false, code: 'EXPORT_RUNNING', message: '已有导出任务进行中', exportTaskId: activeExport?.id || null, progress: exportProgress});
      const task = createExportTask();
      activeExport = task;
      rendering = true;
      try {
        startExportProgress('正在准备导出…');
        const payload = await readBody(req);
        assertExportNotCancelled();
        if (!payload?.videoData) throw new Error('缺少 videoData');
        const exported = await exportRouteBundle(payload);
        rendering = false;
        activeExport = null;
        finishExportProgress('导出完成');
        return send(res, 200, {ok: true, ...exported});
      } catch (error) {
        rendering = false;
        activeExport = null;
        if (error?.code === 'EXPORT_CANCELLED') {
          cancelExportProgress(error.message);
          return send(res, 409, {ok: false, cancelled: true, code: 'EXPORT_CANCELLED', message: error.message});
        }
        failExportProgress(error);
        return send(res, 500, {ok: false, message: error.message});
      }
    }
    if (req.method === 'GET') return serveStatic(req, res);
    return send(res, 404, {ok: false, message: '接口不存在'});
  } catch (error) {
    return send(res, 500, {ok: false, message: error.message});
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Route planner server: http://127.0.0.1:${PORT}`);
  console.log(`Export folder: ${ROUTE_ROOT}`);
  console.log(`Config file candidates: ${KEY_CANDIDATES.join(' | ')}`);
  const keys = readKeyFile();
  console.log(`Amap key configured: ${Boolean(keys.key && keys.securityJsCode)}`);
});
