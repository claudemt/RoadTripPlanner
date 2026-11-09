'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {spawn} = require('child_process');

const MAX_TRACK_BYTES = 30 * 1024 * 1024;
const DEFAULT_ID_PREFIX = 'default:';
const USER_ID_PREFIX = 'user:';
const DEFAULT_VOLUME = 0.6;

const isPathInside = (root, target) => {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
};

const prettyTitle = (fileName) => {
  const base = String(fileName || '').replace(/\.mp3$/i, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!base) return '未命名音乐';
  if (base !== base.toLowerCase()) return base;
  return base.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
};

const looksLikeMp3 = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
  if (buffer.slice(0, 3).toString('latin1') === 'ID3') return true;
  return buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0;
};

const clampVolume = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_VOLUME;
  return Math.max(0, Math.min(1, number));
};

const readJson = (file, fallback) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
};

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temp, file);
};

const createMusicService = ({dataRoot, defaultRoot, userSegment, ffprobeCommand = 'ffprobe', flat = false} = {}) => {
  const musicRoot = path.join(dataRoot, 'music');
  const durationCache = new Map();
  const defaultTrackCache = {at: 0, signature: '', tracks: []};

  // flat=true（本机自用）：上传的音乐直接放 output/music/，不再按账号分子目录。
  const userRoot = (email) => (flat ? musicRoot : path.join(musicRoot, 'users', userSegment(email)));
  const userTrackFile = (email) => path.join(userRoot(email), 'tracks.json');
  const userSelectionFile = (email) => path.join(userRoot(email), 'selections.json');

  const probeDuration = (file) => new Promise((resolve) => {
    let stat = null;
    try {
      stat = fs.statSync(file);
    } catch (_) {
      return resolve(null);
    }
    const cacheKey = `${file}:${stat.size}:${stat.mtimeMs}`;
    if (durationCache.has(cacheKey)) return resolve(durationCache.get(cacheKey));
    const child = spawn(ffprobeCommand, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file], {windowsHide: true});
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const seconds = Number(stdout.trim());
      const value = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 10) / 10 : null;
      if (value !== null) durationCache.set(cacheKey, value);
      resolve(value);
    });
  });

  const readUserTracks = (email) => {
    const data = readJson(userTrackFile(email), {});
    const list = Array.isArray(data.tracks) ? data.tracks : [];
    return list.filter((item) => item && typeof item.id === 'string' && typeof item.file === 'string');
  };

  const writeUserTracks = (email, tracks) => {
    writeJson(userTrackFile(email), {tracks});
  };

  const scanDefaults = async () => {
    if (!defaultRoot || !fs.existsSync(defaultRoot)) return [];
    let names = [];
    try {
      names = fs.readdirSync(defaultRoot).filter((name) => /\.mp3$/i.test(name));
    } catch (_) {
      return [];
    }
    const signature = names.join('|');
    if (defaultTrackCache.at && defaultTrackCache.signature === signature) return defaultTrackCache.tracks;
    const tracks = [];
    for (const name of names.sort((left, right) => left.localeCompare(right, 'en'))) {
      const file = path.join(defaultRoot, name);
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch (_) {
        continue;
      }
      tracks.push({
        id: `${DEFAULT_ID_PREFIX}${name}`,
        source: 'default',
        title: prettyTitle(name),
        fileName: name,
        size,
        durationSec: await probeDuration(file)
      });
    }
    defaultTrackCache.at = Date.now();
    defaultTrackCache.signature = signature;
    defaultTrackCache.tracks = tracks;
    return tracks;
  };

  const listTracks = async (identity) => {
    const defaults = await scanDefaults();
    const email = identity?.email;
    const own = email
      ? readUserTracks(email).map((item) => {
        const file = path.join(userRoot(email), path.basename(item.file));
        let size = Number(item.size) || 0;
        try {
          size = fs.statSync(file).size;
        } catch (_) {
          size = 0;
        }
        return {
          id: item.id,
          source: 'user',
          title: String(item.title || prettyTitle(item.file)),
          fileName: item.file,
          size,
          durationSec: Number(item.durationSec) || null,
          addedAt: item.addedAt || null
        };
      }).filter((item) => item.size > 0)
      : [];
    return [...defaults, ...own];
  };

  const resolveTrackFile = (identity, trackId) => {
    const id = String(trackId || '');
    if (!id) return null;
    if (id.startsWith(DEFAULT_ID_PREFIX)) {
      if (!defaultRoot) return null;
      const name = path.basename(id.slice(DEFAULT_ID_PREFIX.length));
      if (!/\.mp3$/i.test(name)) return null;
      const file = path.join(defaultRoot, name);
      if (!isPathInside(defaultRoot, file) || !fs.existsSync(file)) return null;
      return file;
    }
    if (!identity?.email) return null;
    const entry = readUserTracks(identity.email).find((item) => item.id === id);
    if (!entry) return null;
    const root = userRoot(identity.email);
    const file = path.join(root, path.basename(entry.file));
    if (!isPathInside(root, file) || !fs.existsSync(file)) return null;
    return file;
  };

  const addTrack = async (identity, {buffer, fileName}) => {
    if (!identity?.email) {
      const error = new Error('未识别用户');
      error.status = 401;
      throw error;
    }
    if (!Buffer.isBuffer(buffer) || !buffer.length) {
      const error = new Error('文件为空');
      error.status = 400;
      throw error;
    }
    if (buffer.length > MAX_TRACK_BYTES) {
      const error = new Error(`超过 ${Math.round(MAX_TRACK_BYTES / 1024 / 1024)}MB`);
      error.status = 413;
      throw error;
    }
    if (!looksLikeMp3(buffer)) {
      const error = new Error('仅支持 MP3');
      error.status = 400;
      throw error;
    }
    const root = userRoot(identity.email);
    fs.mkdirSync(root, {recursive: true});
    const id = `${USER_ID_PREFIX}${crypto.randomBytes(8).toString('hex')}`;
    const safeName = `${id.slice(USER_ID_PREFIX.length)}.mp3`;
    const target = path.join(root, safeName);
    fs.writeFileSync(target, buffer);
    const title = prettyTitle(fileName || safeName);
    const durationSec = await probeDuration(target);
    const tracks = readUserTracks(identity.email);
    tracks.push({
      id,
      title,
      file: safeName,
      size: buffer.length,
      durationSec,
      addedAt: new Date().toISOString()
    });
    writeUserTracks(identity.email, tracks);
    return {id, source: 'user', title, fileName: safeName, size: buffer.length, durationSec};
  };

  const removeTrack = (identity, trackId) => {
    if (!identity?.email) {
      const error = new Error('未识别用户');
      error.status = 401;
      throw error;
    }
    const id = String(trackId || '');
    if (!id.startsWith(USER_ID_PREFIX)) {
      const error = new Error('内置音乐不能删除');
      error.status = 403;
      throw error;
    }
    const tracks = readUserTracks(identity.email);
    const index = tracks.findIndex((item) => item.id === id);
    if (index < 0) {
      const error = new Error('音乐不存在');
      error.status = 404;
      throw error;
    }
    const [removed] = tracks.splice(index, 1);
    const root = userRoot(identity.email);
    const file = path.join(root, path.basename(removed.file));
    if (isPathInside(root, file)) {
      try {
        fs.rmSync(file, {force: true});
      } catch (_) {
      }
    }
    writeUserTracks(identity.email, tracks);
    return {id};
  };

  const readSelections = (email) => {
    const data = readJson(userSelectionFile(email), {});
    return data && typeof data.selections === 'object' && data.selections ? data.selections : {};
  };

  const getSelection = (identity, routeId) => {
    if (!identity?.email || !routeId) return null;
    const entry = readSelections(identity.email)[String(routeId)];
    if (!entry || typeof entry !== 'object') return null;
    const trackId = String(entry.trackId || '');
    if (!trackId || !resolveTrackFile(identity, trackId)) return null;
    return {
      enabled: entry.enabled !== false,
      trackId,
      volume: clampVolume(entry.volume),
      updatedAt: entry.updatedAt || null
    };
  };

  const saveSelection = (identity, routeId, selection) => {
    if (!identity?.email) {
      const error = new Error('未识别用户');
      error.status = 401;
      throw error;
    }
    if (!routeId) {
      const error = new Error('缺少路线 ID');
      error.status = 400;
      throw error;
    }
    const selections = readSelections(identity.email);
    const key = String(routeId);
    const trackId = String(selection?.trackId || '');
    if (!trackId) {
      delete selections[key];
      writeJson(userSelectionFile(identity.email), {selections});
      return null;
    }
    if (!resolveTrackFile(identity, trackId)) {
      const error = new Error('音乐不存在');
      error.status = 404;
      throw error;
    }
    const entry = {
      enabled: selection.enabled !== false,
      trackId,
      volume: clampVolume(selection.volume),
      updatedAt: new Date().toISOString()
    };
    selections[key] = entry;
    writeJson(userSelectionFile(identity.email), {selections});
    return entry;
  };

  const resolveExportMusic = (identity, music) => {
    if (!music || music.enabled === false) return null;
    const trackId = String(music.trackId || '');
    if (!trackId) return null;
    const file = resolveTrackFile(identity, trackId);
    if (!file) {
      const error = new Error('背景音乐不存在，请重新选择');
      error.status = 400;
      error.code = 'MUSIC_NOT_FOUND';
      throw error;
    }
    return {
      file,
      trackId,
      volume: clampVolume(music.volume)
    };
  };

  return {
    maxTrackBytes: MAX_TRACK_BYTES,
    listTracks,
    addTrack,
    removeTrack,
    resolveTrackFile,
    getSelection,
    saveSelection,
    resolveExportMusic
  };
};

module.exports = {createMusicService};
