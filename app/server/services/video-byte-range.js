const parseVideoByteRange = (header, size) => {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || ''));
  if (!match || !size || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null;
  return {start, end};
};
module.exports = {parseVideoByteRange};
