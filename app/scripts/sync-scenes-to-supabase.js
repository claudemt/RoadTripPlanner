const fs = require('fs');
const path = require('path');
const {createClient} = require('@supabase/supabase-js');

const ROOT = path.resolve(__dirname, '..');
const DATA_ROOT = path.join(ROOT, '..', 'data');
const SCENE_ROOT = path.join(DATA_ROOT, 'scenes');
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const SCENE_IMAGE_BUCKET = String(process.env.ROADTRIP_SCENE_IMAGE_BUCKET || 'roadtrip-scene-images').trim();
const UPDATED_BY_EMAIL = String(process.env.ROADTRIP_SCENE_SEED_EMAIL || 'admin@map.bestapi.best').trim().toLowerCase();

const normalizeSceneName = (value) =>
  String(value || '')
    .replace(/[\s·•（）()【】\[\]《》<>“”"'：:，,。.\-—_/\\]/g, '')
    .trim();

const stripQuote = (value) => String(value || '').trim().replace(/^['"]|['"]$/g, '');

const safeExt = (name, mimeType = '') => {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) return ext;
  if (/png/i.test(mimeType)) return '.png';
  if (/webp/i.test(mimeType)) return '.webp';
  return '.jpg';
};

const parseSceneFile = (file) => {
  const text = fs.readFileSync(file, 'utf8');
  const match = text.match(/window\.SCENIC_SPOTS\.push\(([\s\S]*?)\);\s*$/);
  if (!match) return null;
  return JSON.parse(match[1]);
};

const scanScenes = () => {
  if (!fs.existsSync(SCENE_ROOT)) return [];
  return fs
    .readdirSync(SCENE_ROOT, {withFileTypes: true})
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const folder = path.join(SCENE_ROOT, entry.name);
      const file = path.join(folder, `${entry.name}.js`);
      if (!fs.existsSync(file)) return null;
      const scene = parseSceneFile(file);
      if (!scene?.name) return null;
      return {folder, file, scene, folderName: entry.name};
    })
    .filter(Boolean);
};

const buildImageFile = (src) => {
  const value = String(src || '').replace(/\\/g, '/').trim();
  if (!value || /^(https?:|data:|file:)/i.test(value)) return null;
  const absolute = path.isAbsolute(value) ? value : path.join(DATA_ROOT, value);
  return fs.existsSync(absolute) ? absolute : null;
};

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {persistSession: false, autoRefreshToken: false},
  });
  const scenes = scanScenes();
  if (!scenes.length) {
    console.log('No scenes found under data/scenes');
    return;
  }
  let imported = 0;
  for (const item of scenes) {
    const normalizedName = normalizeSceneName(item.scene.name);
    if (!normalizedName) continue;
    const {data: existing, error: readError} = await supabase
      .from('roadtrip_scenes')
      .select('id,images')
      .eq('normalized_name', normalizedName)
      .maybeSingle();
    if (readError) throw readError;
    const images = [];
    for (const [index, src] of (Array.isArray(item.scene.images) ? item.scene.images : []).entries()) {
      const localFile = buildImageFile(src);
      if (!localFile) continue;
      const ext = safeExt(localFile);
      const fileName = `${index + 1}-${path.basename(localFile, path.extname(localFile))}${ext}`;
      const objectName = `scenes/${normalizedName}/${fileName}`;
      const {error: uploadError} = await supabase.storage
        .from(SCENE_IMAGE_BUCKET)
        .upload(objectName, fs.readFileSync(localFile), {
          contentType: ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg',
          upsert: true,
        });
      if (uploadError) throw uploadError;
      const {data: publicUrlData} = supabase.storage.from(SCENE_IMAGE_BUCKET).getPublicUrl(objectName);
      if (publicUrlData?.publicUrl) images.push(publicUrlData.publicUrl);
    }
    const mergedImages = [...new Set([...(existing?.images || []), ...images])];
    const row = {
      ...(existing?.id ? {id: existing.id} : {}),
      normalized_name: normalizedName,
      name: String(item.scene.name || '').trim(),
      title: String(item.scene.title || item.scene.name || '').trim(),
      description: String(item.scene.description || '').trim(),
      images: mergedImages,
      updated_by_email: UPDATED_BY_EMAIL,
      updated_at: new Date().toISOString(),
    };
    const {error: writeError} = await supabase
      .from('roadtrip_scenes')
      .upsert(row, {onConflict: 'normalized_name'});
    if (writeError) throw writeError;
    imported += 1;
    console.log(`Synced: ${item.scene.name}`);
  }
  console.log(`Done. Imported ${imported} scenes.`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
