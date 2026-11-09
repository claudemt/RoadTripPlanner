const test = require('node:test');
const assert = require('node:assert/strict');
const {buildFinalizeArgs, buildMusicFilter} = require('../server/services/music-merge');

const argValue = (args, flag) => args[args.indexOf(flag) + 1];

test('没有选音乐时只做 faststart，不改变视频流', () => {
  const args = buildFinalizeArgs({input: 'in.mp4', output: 'out.mp4'});
  assert.deepEqual(args, ['-y', '-i', 'in.mp4', '-map', '0', '-c', 'copy', '-movflags', '+faststart', 'out.mp4']);
});

test('选了音乐时不再循环、不再淡出，输出长度等于视频长度', () => {
  const args = buildFinalizeArgs({
    input: 'in.mp4',
    output: 'out.mp4',
    music: {file: '/music/a.mp3', volume: 0.5},
    durationSec: 30
  });
  assert.ok(!args.includes('-stream_loop'), '曲子播完就停，不循环');
  assert.equal(argValue(args, '-t'), '30.000', '以视频长度作为输出长度');
  assert.ok(!args.includes('-shortest'), '有确定时长时不用 -shortest');
  assert.equal(argValue(args, '-c:v'), 'copy', '视频流不重新编码');
  assert.equal(argValue(args, '-c:a'), 'aac');
  assert.equal(argValue(args, '-map'), '0:v:0');
  assert.ok(args.includes('1:a:0'));
  assert.equal(argValue(args, '-af'), 'volume=0.500', '不做淡出，视频结束直接截断');
  assert.equal(args.at(-1), 'out.mp4');
});

test('拿不到视频时长时退化为 -shortest', () => {
  const args = buildFinalizeArgs({
    input: 'in.mp4',
    output: 'out.mp4',
    music: {file: '/music/a.mp3', volume: 0.6},
    durationSec: null
  });
  assert.ok(!args.includes('-t'));
  assert.ok(args.includes('-shortest'));
});

test('视频比曲子短时直接截断，不做收尾处理', () => {
  const args = buildFinalizeArgs({
    input: 'in.mp4',
    output: 'out.mp4',
    music: {file: '/music/a.mp3', volume: 0.4},
    durationSec: 8.5
  });
  assert.equal(argValue(args, '-t'), '8.500');
  assert.equal(argValue(args, '-af'), 'volume=0.400');
});

test('音量超出范围会被夹紧，缺省为 0.6', () => {
  assert.equal(buildMusicFilter({volume: 3}), 'volume=1.000');
  assert.equal(buildMusicFilter({volume: -1}), 'volume=0.000');
  assert.equal(buildMusicFilter({}), 'volume=0.600');
  assert.equal(buildMusicFilter(null), 'volume=0.600');
});
