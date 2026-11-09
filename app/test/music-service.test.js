const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createMusicService} = require('../server/services/music-service');

const mp3Bytes = (tag = 0) => {
  const buffer = Buffer.alloc(1024, tag);
  buffer[0] = 0xff;
  buffer[1] = 0xfb;
  return buffer;
};

const setup = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roadtrip-music-'));
  const defaults = path.join(root, 'defaults');
  const dataRoot = path.join(root, 'data');
  fs.mkdirSync(defaults, {recursive: true});
  fs.writeFileSync(path.join(defaults, 'easy-monday.mp3'), mp3Bytes(1));
  fs.writeFileSync(path.join(defaults, 'tears-of-joy.mp3'), mp3Bytes(2));
  const service = createMusicService({
    dataRoot,
    defaultRoot: defaults,
    userSegment: (email) => String(email || '_anonymous').replace(/[^a-z0-9@._+-]+/gi, '_')
  });
  const cleanup = () => fs.rmSync(root, {recursive: true, force: true});
  return {root, dataRoot, defaults, service, cleanup};
};

test('内置曲库按文件名生成可读标题', async () => {
  const {service, cleanup} = setup();
  try {
    const tracks = await service.listTracks({email: 'a@example.com'});
    assert.equal(tracks.length, 2);
    assert.equal(tracks[0].source, 'default');
    assert.equal(tracks[0].title, 'Easy Monday');
    assert.equal(tracks[1].title, 'Tears Of Joy');
  } finally {
    cleanup();
  }
});

test('上传的音乐进自己的目录，别人看不到也读不到', async () => {
  const {service, cleanup} = setup();
  try {
    const track = await service.addTrack({email: 'alice@example.com'}, {buffer: mp3Bytes(9), fileName: '我的山路.mp3'});
    assert.equal(track.source, 'user');
    assert.equal(track.title, '我的山路');

    const aliceTracks = await service.listTracks({email: 'alice@example.com'});
    assert.equal(aliceTracks.filter((item) => item.source === 'user').length, 1);
    assert.ok(service.resolveTrackFile({email: 'alice@example.com'}, track.id));

    const bobTracks = await service.listTracks({email: 'bob@example.com'});
    assert.equal(bobTracks.filter((item) => item.source === 'user').length, 0);
    assert.equal(service.resolveTrackFile({email: 'bob@example.com'}, track.id), null);
  } finally {
    cleanup();
  }
});

test('只接受 MP3，超过大小限制直接拒绝', async () => {
  const {service, cleanup} = setup();
  try {
    await assert.rejects(
      () => service.addTrack({email: 'a@example.com'}, {buffer: Buffer.from('not an mp3 at all'), fileName: 'x.mp3'}),
      /仅支持 MP3/
    );
    const huge = Buffer.alloc(service.maxTrackBytes + 1, 0);
    huge[0] = 0xff;
    huge[1] = 0xfb;
    await assert.rejects(
      () => service.addTrack({email: 'a@example.com'}, {buffer: huge, fileName: 'big.mp3'}),
      /超过 30MB/
    );
  } finally {
    cleanup();
  }
});

test('路线音乐选择按用户隔离并持久化到磁盘', async () => {
  const {service, dataRoot, defaults, cleanup} = setup();
  try {
    const alice = {email: 'alice@example.com'};
    const track = await service.addTrack(alice, {buffer: mp3Bytes(3), fileName: 'day-one.mp3'});
    service.saveSelection(alice, 'route-1', {enabled: true, trackId: track.id, volume: 0.35});

    const reopened = createMusicService({
      dataRoot,
      defaultRoot: defaults,
      userSegment: (email) => String(email || '_anonymous').replace(/[^a-z0-9@._+-]+/gi, '_')
    });
    const saved = reopened.getSelection(alice, 'route-1');
    assert.equal(saved.trackId, track.id);
    assert.equal(saved.volume, 0.35);
    assert.equal(saved.enabled, true);

    assert.equal(reopened.getSelection({email: 'bob@example.com'}, 'route-1'), null);
  } finally {
    cleanup();
  }
});

test('曲目删除后，指向它的路线选择自动失效', async () => {
  const {service, cleanup} = setup();
  try {
    const alice = {email: 'alice@example.com'};
    const track = await service.addTrack(alice, {buffer: mp3Bytes(4), fileName: 'temp.mp3'});
    service.saveSelection(alice, 'route-2', {enabled: true, trackId: track.id, volume: 0.6});
    service.removeTrack(alice, track.id);
    assert.equal(service.getSelection(alice, 'route-2'), null);
  } finally {
    cleanup();
  }
});

test('默认音乐不能删，别人的音乐也不能删', async () => {
  const {service, cleanup} = setup();
  try {
    assert.throws(() => service.removeTrack({email: 'a@example.com'}, 'default:easy-monday.mp3'), /内置音乐不能删除/);
    const track = await service.addTrack({email: 'alice@example.com'}, {buffer: mp3Bytes(5), fileName: 'mine.mp3'});
    assert.throws(() => service.removeTrack({email: 'bob@example.com'}, track.id), /音乐不存在/);
  } finally {
    cleanup();
  }
});

test('导出时解析音乐文件：内置可用，别人的曲目报错', async () => {
  const {service, cleanup} = setup();
  try {
    const alice = {email: 'alice@example.com'};
    const music = service.resolveExportMusic(alice, {enabled: true, trackId: 'default:easy-monday.mp3', volume: 0.5});
    assert.equal(music.volume, 0.5);
    assert.ok(fs.existsSync(music.file));

    const track = await service.addTrack(alice, {buffer: mp3Bytes(6), fileName: 'own.mp3'});
    assert.equal(service.resolveExportMusic(alice, {enabled: true, trackId: track.id}).trackId, track.id);
    assert.throws(
      () => service.resolveExportMusic({email: 'bob@example.com'}, {enabled: true, trackId: track.id}),
      (error) => error.code === 'MUSIC_NOT_FOUND'
    );
    assert.equal(service.resolveExportMusic(alice, null), null);
    assert.equal(service.resolveExportMusic(alice, {enabled: false, trackId: track.id}), null);
  } finally {
    cleanup();
  }
});
