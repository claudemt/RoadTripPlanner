const test = require('node:test');
const assert = require('node:assert/strict');
const {parseVideoByteRange} = require('../server/services/video-byte-range');
test('video ranges support seeking, open ends and suffixes', () => {
  assert.deepEqual(parseVideoByteRange('bytes=0-99', 1000), {start: 0, end: 99});
  assert.deepEqual(parseVideoByteRange('bytes=500-', 1000), {start: 500, end: 999});
  assert.deepEqual(parseVideoByteRange('bytes=-100', 1000), {start: 900, end: 999});
  assert.deepEqual(parseVideoByteRange('bytes=0-9999', 1000), {start: 0, end: 999});
});
test('invalid video ranges are rejected', () => {
  for (const value of ['bytes=1000-', 'bytes=90-20', 'bytes=-0', 'bytes=-', 'bytes=0-1,4-5', 'bytes=9007199254740993-']) assert.equal(parseVideoByteRange(value, 1000), null);
});
