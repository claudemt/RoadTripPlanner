const https = require('https');
const {createClient} = require('@supabase/supabase-js');

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const AMAP_KEY = String(process.env.AMAP_KEY || '').trim();
const PUBLISHED_BY_EMAIL = String(process.env.ROADTRIP_ROUTE_SEED_EMAIL || 'opponewsroom@gmail.com').trim().toLowerCase();

const ROUTES = [
  {
    id: 'seed-gannan-rock-road-loop',
    name: '甘南洛克之路经典环线',
    days: [
      ['兰州水墨丹霞旅游景区(暂停开放)', '甘加秘境', '拉卜楞寺'],
      ['拉卜楞寺', '桑科草原', '美仁大草原', '郎木寺院'],
      ['郎木寺院', '花湖生态旅游区', '若尔盖大草原', '黄河九曲第一湾'],
      ['黄河九曲第一湾', '扎尕那', '腊子口景区'],
      ['腊子口景区', '官鹅沟大景区', '天水古城'],
    ],
  },
  {
    id: 'seed-longnan-tianshui-ancient-road',
    name: '陇南天水古城石窟线',
    days: [
      ['阆中古城', '恩阳古镇', '青木川古镇'],
      ['青木川古镇', '官鹅沟大景区', '李家龙宫'],
      ['李家龙宫', '大地湾遗址', '伏羲庙', '天水古城'],
      ['天水古城', '麦积山石窟'],
    ],
  },
  {
    id: 'seed-aba-gannan-wetland-grassland',
    name: '阿坝甘南湿地草原线',
    days: [
      ['莲宝叶则景区', '各莫寺', '娘玛寺'],
      ['娘玛寺', '阿万仓湿地', '郭莽湿地'],
      ['郭莽湿地', '桑科草原', '拉卜楞寺'],
      ['拉卜楞寺', '安多合作米拉日巴佛阁', '美仁大草原'],
    ],
  },
];

const FALLBACK_POINTS = {
  兰州水墨丹霞旅游景区暂停开放: [103.625, 36.29],
  甘加秘境: [102.414, 35.337],
  拉卜楞寺: [102.506, 35.204],
  桑科草原: [102.43, 35.116],
  美仁大草原: [102.863, 34.913],
  郎木寺院: [102.636, 34.087],
  花湖生态旅游区: [102.806, 33.926],
  若尔盖大草原: [102.963, 33.575],
  黄河九曲第一湾: [102.482, 33.388],
  扎尕那: [103.226, 34.207],
  腊子口景区: [103.861, 34.094],
  官鹅沟大景区: [104.277, 33.973],
  天水古城: [105.724, 34.581],
  阆中古城: [105.973, 31.575],
  恩阳古镇: [106.631, 31.789],
  青木川古镇: [105.579, 32.831],
  李家龙宫: [104.632, 34.988],
  大地湾遗址: [105.991, 35.005],
  伏羲庙: [105.724, 34.587],
  麦积山石窟: [106.007, 34.35],
  莲宝叶则景区: [101.814, 33.422],
  各莫寺: [101.828, 32.957],
  娘玛寺: [101.984, 33.241],
  阿万仓湿地: [101.95, 33.77],
  郭莽湿地: [102.475, 34.509],
  安多合作米拉日巴佛阁: [102.911, 35.0],
};

const normalizeSceneName = (value) =>
  String(value || '')
    .replace(/[\s·•（）()【】\[\]《》<>“”"'：:，,。.\-—_/\\]/g, '')
    .trim();

const normalizeNameKey = (value) =>
  String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const getJson = (url) => new Promise((resolve, reject) => {
  https.get(url, (response) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => { body += chunk; });
    response.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
  }).on('error', reject);
});

async function geocode(name) {
  const normalized = normalizeSceneName(name);
  if (AMAP_KEY) {
    const url = new URL('https://restapi.amap.com/v3/geocode/geo');
    url.searchParams.set('key', AMAP_KEY);
    url.searchParams.set('address', name);
    url.searchParams.set('city', '全国');
    try {
      const data = await getJson(url.toString());
      const location = data?.geocodes?.[0]?.location;
      if (location) {
        const [lng, lat] = String(location).split(',').map(Number);
        if (Number.isFinite(lng) && Number.isFinite(lat)) return {name, lng, lat, transportMode: 'drive'};
      }
    } catch (_) {}
  }
  const fallback = FALLBACK_POINTS[normalized];
  if (!fallback) throw new Error(`Missing coordinate for ${name}`);
  return {name, lng: fallback[0], lat: fallback[1], transportMode: 'drive'};
}

async function buildRoute(definition) {
  const pointCache = new Map();
  const resolvePoint = async (name) => {
    if (!pointCache.has(name)) pointCache.set(name, await geocode(name));
    return {...pointCache.get(name)};
  };
  const days = [];
  for (const [dayIndex, names] of definition.days.entries()) {
    const points = [];
    for (const name of names) points.push(await resolvePoint(name));
    days.push({
      title: `第 ${dayIndex + 1} 天`,
      from: points[0],
      waypoints: points.slice(1, -1),
      to: points[points.length - 1],
    });
  }
  return {
    id: definition.id,
    name: definition.name,
    days,
  };
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {persistSession: false, autoRefreshToken: false},
  });

  let inserted = 0;
  let skipped = 0;
  for (const definition of ROUTES) {
    const routeData = await buildRoute(definition);
    const nameKey = normalizeNameKey(routeData.name);
    const {data: existing, error: readError} = await supabase
      .from('roadtrip_published_routes')
      .select('id')
      .eq('name_key', nameKey)
      .maybeSingle();
    if (readError) throw readError;
    if (existing) {
      skipped += 1;
      console.log(`Skipped existing route: ${routeData.name}`);
      continue;
    }
    const {error} = await supabase
      .from('roadtrip_published_routes')
      .insert({
        name: routeData.name,
        name_key: nameKey,
        published_by_email: PUBLISHED_BY_EMAIL,
        source_route_id: routeData.id,
        source_owner_email: PUBLISHED_BY_EMAIL,
        route_data: routeData,
        map_layer: 'standard',
        published_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    if (error) throw error;
    inserted += 1;
    console.log(`Inserted public route: ${routeData.name}`);
  }
  console.log(`Done. Inserted ${inserted}, skipped ${skipped}.`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
