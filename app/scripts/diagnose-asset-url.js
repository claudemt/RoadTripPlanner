const {performance} = require('perf_hooks');

const targetUrl = process.argv[2];

if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
  console.error('Usage: node scripts/diagnose-asset-url.js <https-url>');
  process.exit(2);
}

const pickHeaders = (headers) => ({
  status: headers.status,
  contentType: headers.headers.get('content-type') || '',
  contentLength: headers.headers.get('content-length') || '',
  contentRange: headers.headers.get('content-range') || '',
  cacheControl: headers.headers.get('cache-control') || '',
  cfCacheStatus: headers.headers.get('cf-cache-status') || '',
  acceptRanges: headers.headers.get('accept-ranges') || '',
});

async function timedFetch(url, options = {}) {
  const started = performance.now();
  const response = await fetch(url, options);
  const firstByteAt = performance.now();
  const buffer = Buffer.from(await response.arrayBuffer());
  const ended = performance.now();
  return {
    response,
    buffer,
    firstByteMs: Math.round(firstByteAt - started),
    totalMs: Math.round(ended - started),
    mbps: buffer.length && ended > started
      ? Number(((buffer.length * 8) / ((ended - started) / 1000) / 1_000_000).toFixed(2))
      : 0,
  };
}

async function main() {
  const head = await fetch(targetUrl, {method: 'HEAD'});
  console.log('HEAD', pickHeaders(head));

  const range = await timedFetch(targetUrl, {
    headers: {Range: 'bytes=0-1048575'},
  });
  console.log('RANGE', {
    ...pickHeaders(range.response),
    bytes: range.buffer.length,
    firstByteMs: range.firstByteMs,
    totalMs: range.totalMs,
    mbps: range.mbps,
  });

  const secondHead = await fetch(targetUrl, {method: 'HEAD'});
  console.log('HEAD_AGAIN', pickHeaders(secondHead));

  const ok = range.response.status === 206 &&
    /^bytes 0-1048575\//i.test(range.response.headers.get('content-range') || '') &&
    /^video\/mp4/i.test(range.response.headers.get('content-type') || '');
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
