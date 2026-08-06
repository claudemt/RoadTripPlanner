#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const parseArgs = (argv) => {
  const options = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      positionals.push(value);
      continue;
    }
    const equal = value.indexOf('=');
    if (equal >= 0) {
      options[value.slice(2, equal)] = value.slice(equal + 1);
      continue;
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return {options, positionals};
};

const {options, positionals} = parseArgs(process.argv.slice(2));
const baseUrl = String(options.base || process.env.ROADTRIP_BASE_URL || 'http://127.0.0.1:6137').replace(/\/+$/, '');
const email = String(options.email || process.env.ROADTRIP_EMAIL || '').trim();
const headers = {
  Accept: 'application/json',
  ...(email ? {'X-Auth-Request-Email': email} : {}),
};

const fail = (message, status = 1) => {
  console.error(`roadtrip-cli: ${message}`);
  process.exitCode = status;
};

const jsonFile = (file) => JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));

const contentTypeForFile = (file) => {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
};

const expandImages = (payload) => {
  if (!Array.isArray(payload?.images)) return payload;
  return {
    ...payload,
    images: payload.images.map((image) => {
      if (typeof image !== 'string' || /^data:|^https?:\/\//i.test(image)) return image;
      const file = path.resolve(image);
      if (!fs.existsSync(file)) return image;
      return `data:${contentTypeForFile(file)};base64,${fs.readFileSync(file).toString('base64')}`;
    }),
  };
};

const request = async (route, {method = 'GET', body, raw = false} = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(options.timeout || 120000));
  try {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: body == null ? headers : {...headers, 'Content-Type': 'application/json'},
      body: body == null ? undefined : JSON.stringify(body),
      redirect: 'follow',
      signal: controller.signal,
    });
    if (raw) {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!response.ok) throw new Error(`${response.status} ${buffer.toString('utf8')}`);
      return {response, buffer};
    }
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = {raw: text}; }
    if (!response.ok || data?.ok === false) {
      throw new Error(data?.message || `${response.status} ${response.statusText}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
};

const print = (value) => console.log(JSON.stringify(value, null, 2));
const numberOption = (name) => options[name] == null ? undefined : Number(options[name]);
const booleanOption = (name) => {
  if (options[name] == null) return undefined;
  return !['false', '0', 'no', 'off'].includes(String(options[name]).toLowerCase());
};

const waitForExport = async (taskId) => {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const state = await request(`/api/v1/exports/${encodeURIComponent(taskId)}`);
    const progress = state.progress || {};
    console.error(`[${progress.percent ?? 0}%] ${progress.message || progress.phase || '处理中'}`);
    if (progress.done) return state;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('等待导出超过 6 分钟。');
};

const routeCommand = async (action, args) => {
  const id = args[0];
  if (action === 'list') return print(await request('/api/v1/routes'));
  if (action === 'get') return print(await request(`/api/v1/routes/${encodeURIComponent(id)}`));
  if (action === 'create' || action === 'replace') {
    const file = options.file;
    if (!file) throw new Error('请使用 --file route.json');
    const routeData = jsonFile(file);
    if (action === 'replace') routeData.id = id;
    return print(await request(action === 'create' ? '/api/v1/routes' : `/api/v1/routes/${encodeURIComponent(id)}`, {
      method: action === 'create' ? 'POST' : 'PUT',
      body: {routeData, mapLayer: options['map-layer'] || 'standard'},
    }));
  }
  if (action === 'point-set') {
    const point = {};
    ['name', 'lng', 'lat', 'transportMode', 'labelOffset'].forEach((key) => {
      if (options[key] != null) point[key] = options[key];
    });
    if (point.lng != null) point.lng = Number(point.lng);
    if (point.lat != null) point.lat = Number(point.lat);
    if (point.transportMode == null && options.mode != null) point.transportMode = options.mode;
    if (options['label-x'] != null || options['label-y'] != null) {
      point.labelOffset = {x: Number(options['label-x'] || 0), y: Number(options['label-y'] || 0)};
    }
    const useScenic = booleanOption('use-scenic');
    if (useScenic !== undefined) point.useScenic = useScenic;
    return print(await request(`/api/v1/routes/${encodeURIComponent(id)}/points`, {
      method: 'PATCH',
      body: {day: Number(options.day), position: options.position, point},
    }));
  }
  if (action === 'export') {
    const body = {
      renderVideo: booleanOption('video') !== false,
      mapLayer: options['map-layer'] || 'standard',
    };
    if (options['video-data']) body.videoData = jsonFile(options['video-data']);
    const result = await request(`/api/v1/routes/${encodeURIComponent(id)}/export`, {method: 'POST', body});
    if (options.wait) return print(await waitForExport(result.taskId));
    return print(result);
  }
  if (action === 'status') return print(await request(`/api/v1/exports/${encodeURIComponent(id)}`));
  if (action === 'download') {
    const output = path.resolve(options.out || `${id}.product.zip`);
    const {buffer} = await request(`/api/v1/routes/${encodeURIComponent(id)}/product.zip`, {raw: true});
    fs.writeFileSync(output, buffer);
    return print({ok: true, file: output, bytes: buffer.length});
  }
  throw new Error(`未知 route 操作：${action}`);
};

const spotCommand = async (action, args) => {
  if (action === 'public-get') {
    const name = args.join(' ') || options.name || '';
    return print(await request(`/api/v1/spots/public?name=${encodeURIComponent(name)}`));
  }
  if (action === 'public-list') return print(await request('/api/v1/spots/public'));
  if (action === 'public-save') {
    if (!options.file) throw new Error('请使用 --file spot.json');
    return print(await request('/api/v1/spots/public', {method: 'PUT', body: expandImages(jsonFile(options.file))}));
  }
  if (action === 'public-revisions') {
    const name = args.join(' ') || options.name || '';
    return print(await request(`/api/v1/spots/public/revisions?name=${encodeURIComponent(name)}`));
  }
  if (action === 'private-list') return print(await request('/api/v1/spots/private'));
  if (action === 'private-save') {
    if (!options.file) throw new Error('请使用 --file spot.json');
    return print(await request('/api/v1/spots/private', {method: 'PUT', body: expandImages(jsonFile(options.file))}));
  }
  if (action === 'private-import') {
    const name = args.join(' ') || options.name;
    return print(await request('/api/v1/spots/private/import', {method: 'POST', body: {name}}));
  }
  if (action === 'private-delete') {
    return print(await request(`/api/v1/spots/private/${encodeURIComponent(args[0] || options.id)}`, {method: 'DELETE'}));
  }
  throw new Error(`未知 spot 操作：${action}`);
};

const main = async () => {
  if (positionals[0] === 'account') return print(await request('/api/v1/account'));
  if (positionals[0] === 'api') return print(await request('/api/v1'));
  if (positionals[0] === 'route') return routeCommand(positionals[1], positionals.slice(2));
  if (positionals[0] === 'spot') return spotCommand(positionals[1], positionals.slice(2));
  throw new Error('用法：account | api | route list|get|create|replace|point-set|export|status|download | spot ...');
};

main().catch((error) => fail(error.message));
