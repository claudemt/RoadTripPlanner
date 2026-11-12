const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const loadTs = (relative) => {
  const file = path.resolve(__dirname, '..', relative);
  const loaded = new Module(file, module);
  loaded.filename = file;
  loaded.paths = Module._nodeModulePaths(path.dirname(file));
  loaded._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS}}).outputText, file);
  return loaded.exports;
};

const geo = loadTs('video/src/projects/amap-route-video/lib/geo.ts');
const labels = loadTs('video/src/projects/amap-route-video/lib/labels.ts');

const WIDTH = 1920;
const HEIGHT = 1080;

const point = (name, lng, lat, role, kind) => ({name, lng, lat, role, kind});
const day = (points) => ({title: '', color: '#1677ff', points, segments: points.slice(1).map((to, index) => ({path: [[points[index].lng, points[index].lat], [to.lng, to.lat]]}))});

// 一条 3 天的密集环线：院校/景点挤在几公里内，且每天收车点就是次日出发点。
const route = {
  mapLayer: 'standard',
  renderMode: 'video',
  summary: {bounds: [116.3, 39.94, 116.38, 40.0]},
  days: [
    day([
      point('北京大学', 116.3105, 39.9925, '起', 'from'),
      point('清华大学', 116.3266, 39.9994, '1', 'waypoint'),
      point('北京林业大学', 116.3435, 40.0021, '2', 'waypoint'),
      point('中国农业大学', 116.3661, 40.0022, '3', 'waypoint'),
      point('中国矿业大学', 116.3510, 39.9961, '4', 'waypoint'),
      point('北京语言大学', 116.3396, 39.9933, '终', 'to')
    ]),
    day([
      point('北京语言大学', 116.3396, 39.9933, '起', 'from'),
      point('中国地质大学', 116.3497, 39.9899, '1', 'waypoint'),
      point('北京科技大学', 116.3571, 39.9902, '2', 'waypoint'),
      point('北京大学医学部', 116.3612, 39.9858, '3', 'waypoint'),
      point('北京航空航天大学', 116.3468, 39.9808, '4', 'waypoint'),
      point('北京电影学院', 116.3705, 39.9756, '终', 'to')
    ]),
    day([
      point('北京电影学院', 116.3705, 39.9756, '起', 'from'),
      point('北京邮电大学', 116.3596, 39.9622, '1', 'waypoint'),
      point('北京师范大学', 116.3659, 39.9619, '2', 'waypoint'),
      point('北京交通大学', 116.3357, 39.9515, '3', 'waypoint'),
      point('中央民族大学', 116.3235, 39.9482, '4', 'waypoint'),
      point('北京理工大学', 116.3182, 39.9591, '5', 'waypoint'),
      point('北京外国语大学', 116.3099, 39.9536, '6', 'waypoint'),
      point('中国人民大学', 116.3162, 39.9701, '终', 'to')
    ])
  ]
};

// 稀疏行程：三个点，标签应当紧贴钉子
const sparseRoute = {
  mapLayer: 'standard',
  renderMode: 'video',
  days: [day([
    point('起点', 116.30, 39.90, '起', 'from'),
    point('途经', 116.34, 39.95, '1', 'waypoint'),
    point('终点', 116.40, 39.99, '终', 'to')
  ])]
};

const buildPlan = (data, width = WIDTH, height = HEIGHT, rects = []) => {
  const camera = geo.computeCamera(data, width, height);
  const scale = geo.pointScale(data, width, height);
  const pin = geo.markerScale(data, width, height);
  const entries = data.days.flatMap((item, dayIndex) => item.points.map((item2, pointIndex) => {
    const {x, y} = camera.project([item2.lng, item2.lat]);
    return {key: `${dayIndex}-${pointIndex}-${item2.name}`, x, y, name: item2.name, role: item2.role, dayIndex, pointIndex, point: item2, showLabel: true};
  }));
  const groups = labels.groupPins(entries);
  const entryByKey = new Map(entries.map((entry) => [entry.key, entry]));
  const groupOf = new Map();
  groups.forEach((group, index) => group.members.forEach((key) => groupOf.set(key, index)));
  const pinAnchors = groups.map((group) => {
    const entry = entryByKey.get(group.survivor);
    return {x: entry.x, y: entry.y};
  });
  const pinPositions = labels.spreadPins(pinAnchors, 26, 26);
  const items = entries
    .filter((entry) => groups[groupOf.get(entry.key)].labelOwner === entry.key)
    .map((entry) => {
      const groupIndex = groupOf.get(entry.key);
      const prefixes = groups[groupIndex].labelPrefixes;
      const text = prefixes.length ? `${prefixes.join('&')} ${entry.point.name}` : entry.point.name;
      const measured = labels.measureLabel(text, scale);
      const kind = entry.point.kind === 'from' || entry.point.kind === 'to' ? 'endpoint' : 'waypoint';
      const position = pinPositions[groupIndex];
      return {
        key: entry.key,
        x: position.x,
        y: position.y,
        width: measured.width,
        height: measured.height,
        kind,
        pinIndex: groupIndex,
        order: (kind === 'endpoint' ? 0 : 400000) + entry.dayIndex * 2000 + entry.pointIndex * 10
      };
    });
  const paths = data.days.map((item) => geo.dayPath(item).map((coord) => camera.project(coord)));
  const boxes = labels.layoutPinLabels(items, {
    width,
    height,
    pinScale: pin,
    labelScale: scale,
    pins: pinPositions,
    rects,
    paths,
    margin: 10
  });
  return {
    groups,
    items,
    boxes,
    paths,
    pinScale: pin,
    pins: groups.map((group, index) => ({group: index, rect: labels.pinRect(pinPositions[index].x, pinPositions[index].y, pin)}))
  };
};

const overlapArea = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

test('末段完整地图：标签互不重叠，也不压住其他点位的图钉', () => {
  const plan = buildPlan(route);
  const placed = plan.items.map((item) => ({key: item.key, group: plan.groups.findIndex((group) => group.members.includes(item.key)), box: plan.boxes.get(item.key)}));
  placed.forEach((entry) => assert.ok(entry.box, `${entry.key} 应当有位置`));
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      assert.ok(overlapArea(placed[i].box, placed[j].box) <= 1, `${placed[i].key} 与 ${placed[j].key} 的标签重叠`);
    }
    for (const pin of plan.pins) {
      if (pin.group === placed[i].group) continue;
      assert.ok(overlapArea(placed[i].box, pin.rect) <= 1, `${placed[i].key} 的标签压住了别的图钉`);
    }
    const box = placed[i].box;
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= WIDTH && box.y + box.height <= HEIGHT, `${placed[i].key} 的标签超出画面`);
  }
});

test('起点终点的标签必须贴在真实点位旁边，不能飘到远处', () => {
  const loose = buildPlan(sparseRoute);
  loose.items.filter((item) => item.kind === 'endpoint').forEach((item) => {
    const gap = labels.labelPinGap(loose.boxes.get(item.key), item.x, item.y, loose.pinScale);
    assert.ok(gap <= 8, `${item.key} 的标签离自己的钉子 ${gap.toFixed(1)}px，不够贴身`);
    assert.ok(gap > 0, `${item.key} 的标签应当留出一点空隙，不要压住钉尖`);
  });

  // 密集行程：允许为了不重叠稍微让开，但仍有上限，不会飞出去
  const plan = buildPlan(route);
  const endpoints = plan.items.filter((item) => item.kind === 'endpoint');
  assert.ok(endpoints.length >= 4, '样例里应有多个起点终点');
  endpoints.forEach((item) => {
    const gap = labels.labelPinGap(plan.boxes.get(item.key), item.x, item.y, plan.pinScale);
    assert.ok(gap <= 64, `${item.key} 的标签离自己的钉子 ${gap.toFixed(1)}px，太远了`);
  });
});

test('途径点的标签尽量不压住路线本身', () => {
  // 一条笔直的东西向公路，中间两个途经点：标签应当自动落到路的上下两侧
  const straight = {
    mapLayer: 'standard',
    renderMode: 'video',
    days: [day([
      point('起点', 116.30, 40.00, '起', 'from'),
      point('途经甲', 116.34, 40.00, '1', 'waypoint'),
      point('途经乙', 116.38, 40.00, '2', 'waypoint'),
      point('终点', 116.42, 40.00, '终', 'to')
    ])]
  };
  const plan = buildPlan(straight);
  plan.items.forEach((item) => {
    const box = plan.boxes.get(item.key);
    const covered = labels.coveredRouteLength(box, plan.paths);
    assert.ok(covered < 6, `${item.key} 的标签压住了 ${covered.toFixed(1)}px 路线`);
  });
});

test('途径点被挤开时也不能离自己的点位太远', () => {
  // 正常情况下途径点应当紧贴钉子
  const sparse = {
    mapLayer: 'standard',
    renderMode: 'video',
    days: [day([
      point('起点', 116.30, 39.90, '起', 'from'),
      point('途经甲', 116.34, 39.95, '1', 'waypoint'),
      point('途经乙', 116.40, 39.99, '2', 'waypoint'),
      point('终点', 116.44, 40.02, '终', 'to')
    ])]
  };
  const loose = buildPlan(sparse);
  loose.items.forEach((item) => {
    const gap = labels.labelPinGap(loose.boxes.get(item.key), item.x, item.y, loose.pinScale);
    assert.ok(gap <= 12, `${item.key} 的标签离自己的钉子 ${gap.toFixed(0)}px，不够贴身`);
  });

  // 极端密集时允许让开，但仍有上限，不会飘到图上别的地方
  const plan = buildPlan(route);
  plan.items.forEach((item) => {
    const gap = labels.labelPinGap(plan.boxes.get(item.key), item.x, item.y, plan.pinScale);
    assert.ok(gap <= 320, `${item.key} 的标签离自己的钉子 ${gap.toFixed(0)}px，已经看不出属于哪个点`);
  });
});

test('标签会避开景点卡片这类固定障碍', () => {
  const card = {x: 260, y: 300, width: 660, height: 300};
  const plan = buildPlan(sparseRoute, WIDTH, HEIGHT, [card]);
  plan.items.forEach((item) => {
    assert.equal(overlapArea(plan.boxes.get(item.key), card), 0, `${item.key} 压住了固定障碍`);
  });
});

test('被挤开的标签有引线，端点分别贴在钉子和标签框上', () => {
  const plan = buildPlan(route);
  const onEdge = (point, rect) => Math.abs(point.x - rect.x) < 0.6
    || Math.abs(point.x - (rect.x + rect.width)) < 0.6
    || Math.abs(point.y - rect.y) < 0.6
    || Math.abs(point.y - (rect.y + rect.height)) < 0.6;
  const far = plan.items.filter((item) => labels.labelPinGap(plan.boxes.get(item.key), item.x, item.y, plan.pinScale) >= 12);
  assert.ok(far.length > 0, '密集样例里应当有需要引线的标签');
  far.forEach((item) => {
    const box = plan.boxes.get(item.key);
    assert.ok(onEdge(labels.pinAttachPoint(box, item.x, item.y, plan.pinScale), labels.pinRect(item.x, item.y, plan.pinScale)), `${item.key} 的引线起点应贴在钉子外框`);
    assert.ok(onEdge(labels.boxAttachPoint(box, item.x, item.y), box), `${item.key} 的引线终点应贴在标签框上`);
  });
});

test('同坐标的首尾点合并成一根针，标签前缀拼成 D1终&D2起', () => {
  const plan = buildPlan(route);
  const shared = plan.groups.find((group) => group.members.some((key) => key.startsWith('0-5-')));
  assert.deepEqual(shared.members, ['0-5-北京语言大学', '1-0-北京语言大学']);
  assert.equal(shared.survivor, '0-5-北京语言大学');
  assert.deepEqual(shared.labelPrefixes, ['D1终', 'D2起']);
  assert.equal(plan.groups.length, 18, '20 个点位里两处过夜点重合，合并成 18 根针');
});

test('连续多天共用驻地时前缀只留首尾，标签不会被撑得过长', () => {
  const hub = (dayIndex) => [
    point('格尔木市', 94.9, 36.4, '起', 'from'),
    point(`景点${dayIndex}`, 95.2 + dayIndex * 0.01, 36.6, '1', 'waypoint'),
    point('格尔木市', 94.9, 36.4, '终', 'to')
  ];
  const loop = {mapLayer: 'standard', renderMode: 'video', days: [day(hub(1)), day(hub(2)), day(hub(3))]};
  const plan = buildPlan(loop);
  const text = plan.items.map((item) => item.key).filter((key) => key.includes('格尔木市'));
  assert.equal(text.length, 1, '同一个驻地只出一根针、一个标签');
  assert.deepEqual(plan.groups[0].labelPrefixes, ['D1起', 'D3终']);
});

test('起点终点重合的闭环只留一个标签', () => {
  const loop = {...route, days: [day([
    point('北京大学', 116.3105, 39.9925, '起', 'from'),
    point('清华大学', 116.3266, 39.9994, '1', 'waypoint'),
    point('北京大学', 116.3105, 39.9925, '终', 'to')
  ])]};
  const plan = buildPlan(loop);
  assert.equal(plan.groups.length, 2);
  const owners = plan.items.map((item) => item.key);
  assert.deepEqual(owners, ['0-0-北京大学', '0-1-清华大学']);
});

test('不同点位即使在附近也不会被误合并', () => {
  const near = {...route, days: [day([
    point('甲', 116.3105, 39.9925, '起', 'from'),
    point('乙', 116.3106, 39.9926, '终', 'to')
  ])]};
  const plan = buildPlan(near);
  assert.equal(plan.groups.length, 2);
});
