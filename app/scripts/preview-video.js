const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {bundle} = require('@remotion/bundler');
const {selectComposition, renderStill, renderMedia} = require('@remotion/renderer');
const {createMapBackgroundPlan, assertMapBackgroundSize} = require('../server/services/map-background-plan');

const app = path.resolve(__dirname, '..');
const project = path.dirname(app);
const args = process.argv.slice(2);
const option = (name, fallback) => {const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1];};
const input = args[0];

async function main() {
  if (!input || input.startsWith('--')) throw new Error('用法：npm run preview:video -- <mp4-data.json> [--out <目录>] [--width 1920] [--height 1080] [--compare-map]');
  const data = JSON.parse(fs.readFileSync(path.resolve(input), 'utf8'));
  if (!data.route || !data.days?.every((day) => Array.isArray(day.points))) throw new Error('请输入导出产品中的 mp4-data.json。');
  const output = path.resolve(option('--out', path.join(app, 'out/video-preview')));
  const routeFrame = Number(option('--frame', '225'));
  if (!Number.isInteger(routeFrame) || routeFrame < 0) throw new Error('预览帧必须为非负整数。');
  const width = Number(option('--width', '1920'));
  const height = Number(option('--height', '1080'));
  if (![width, height].every((value) => Number.isInteger(value) && value >= 480 && value <= 7680)) throw new Error('预览尺寸应在 480 到 7680 像素之间。');
  fs.mkdirSync(output, {recursive: true});
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'roadtrip-preview-'));
  const publicDir = path.join(work, 'public');
  fs.mkdirSync(publicDir);
  const config = {...process.env};
  const configFile = path.join(process.env.ROADTRIP_CONFIG_ROOT || path.join(project, 'config'), 'local.env');
  if (fs.existsSync(configFile)) for (const line of fs.readFileSync(configFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)\s*=\s*(.*)$/);
    if (match && !config[match[1]]) config[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
  const browserExecutable = process.env.AMAP_BROWSER_PATH || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/google-chrome',
  ].find((file) => fs.existsSync(file));
  if (!browserExecutable) throw new Error('请设置 AMAP_BROWSER_PATH 指向 Chromium。');
  const copyAsset = (relative) => {
    if (!relative || /^(https?:|data:)/i.test(relative)) return;
    const normalized = relative.replace(/\\/g, '/');
    const source = normalized.startsWith('route/') ? path.resolve(process.env.ROADTRIP_DATA_ROOT || path.join(project, 'data'), 'routes', normalized.slice(6)) : path.resolve(project, normalized);
    const target = path.resolve(publicDir, normalized);
    if (!target.startsWith(publicDir + path.sep)) throw new Error('预览资产路径超出目录。');
    if (!fs.existsSync(source)) throw new Error(`缺少预览资产：${normalized}`);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.copyFileSync(source, target);
  };
  try {
    for (const day of data.days) for (const point of day.points) for (const image of point.scenic?.images || []) copyAsset(image);
    fs.cpSync(path.join(app, 'video/public/weather'), path.join(publicDir, 'weather'), {recursive: true});
    fs.cpSync(path.join(app, 'video/public/fonts'), path.join(publicDir, 'fonts'), {recursive: true});
    const serveUrl = await bundle({entryPoint: path.join(app, 'video/src/index.ts'), publicDir, outDir: path.join(work, 'bundle')});
    const cleanData = {...data, renderMode: 'video', staticMapImage: undefined,
      hillshadeEndpoint: process.env.ROADTRIP_PREVIEW_HILLSHADE_URL || `http://127.0.0.1:${process.env.AMAP_ROUTE_PORT || 6137}/api/v1/map/hillshade`};
    const props = (renderData) => ({data: renderData, amapKey: config.AMAP_KEY || config.REMOTION_AMAP_KEY,
      amapSecurityCode: config.AMAP_SECURITY_JS_CODE || config.REMOTION_AMAP_SECURITY_CODE});
    const base = {...await selectComposition({serveUrl, id: 'AmapRouteVideo', inputProps: props(cleanData), browserExecutable}), width, height};
    const still = (renderData, name, frame, scale = 1) => renderStill({serveUrl, browserExecutable,
      composition: {...base, props: props(renderData)}, inputProps: props(renderData), frame, scale,
      imageFormat: 'png', output: path.join(output, name), logLevel: 'error', timeoutInMilliseconds: 90000});
    const plan = createMapBackgroundPlan(cleanData, width, height);
    console.log('检查底图与路线投影…');
    await still(plan.videoData, 'map.png', 0, plan.scale);
    assertMapBackgroundSize(path.join(output, 'map.png'), plan);
    fs.copyFileSync(path.join(output, 'map.png'), path.join(serveUrl, 'public/map.png'));
    const cached = {...cleanData, staticMapImage: 'map.png'};
    for (const [name, frame] of [['cover.png', 45], ['route.png', routeFrame], ['outro.png', base.durationInFrames - 30]]) {
      console.log(`预览 ${name}`);
      await still(cached, name, Math.min(base.durationInFrames - 1, frame));
    }
    if (args.includes('--check-video')) {
      const {spawnSync} = require('node:child_process');
      const end = base.durationInFrames - 1;
      const ranges = [[0, 12], [170, 190], [305, 325], [Math.max(0, end - 110), Math.max(0, end - 90)], [Math.max(0, end - 12), end]];
      const checks = [];
      for (const [index, range] of ranges.entries()) {
        const frameRange = range.map((frame) => Math.min(end, frame));
        const file = path.join(output, 'check-' + index + '.mp4');
        console.log('渲染视频检查片段 ' + frameRange.join('-'));
        await renderMedia({serveUrl, browserExecutable, composition: {...base, props: props(cached)}, inputProps: props(cached), outputLocation: file,
          codec: 'h264', pixelFormat: 'yuv420p', frameRange, concurrency: 1,
          ffmpegOverride: ({args}) => [...args.slice(0, -1), '-threads', '2', args[args.length - 1]], logLevel: 'error', timeoutInMilliseconds: 90000});
        const check = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-vf', 'blackdetect=d=0:pix_th=0.10:pic_th=0.98', '-an', '-f', 'null', '-'], {encoding: 'utf8', windowsHide: true});
        if (check.error || check.status !== 0) throw new Error('无法完成视频解码检查：' + (check.error?.message || check.stderr));
        const black = (check.stderr || '').split(/\r?\n/).filter((line) => line.includes('black_start:'));
        checks.push({file: path.basename(file), frameRange, black});
      }
      fs.writeFileSync(path.join(output, 'video-check.json'), JSON.stringify(checks, null, 2));
      if (checks.some((check) => check.black.length)) throw new Error('检测到黑帧，请查看 video-check.json。');
      console.log('检查片段均可解码，未检出黑帧。');
    }
    if (args.includes('--compare-map')) await still(cleanData, 'route-live.png', Math.min(base.durationInFrames - 1, routeFrame));
    console.log(`预览已写入 ${output}`);
  } finally {fs.rmSync(work, {recursive: true, force: true});}
}
main().catch((error) => {console.error(error.message); process.exitCode = 1;});
