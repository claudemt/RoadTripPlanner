const test = require('node:test');
const assert = require('node:assert/strict');
const colors = require('../shared/route-colors.js');

const rgb = (hex) => {
  const value = hex.replace('#', '');
  return [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16));
};
const channel = (value) => {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const luminance = (hex) => {
  const [r, g, b] = rgb(hex).map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (left, right) => {
  const a = luminance(left);
  const b = luminance(right);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};
const lab = (hex) => {
  const [r, g, b] = rgb(hex).map(channel);
  const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  const z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
};
const deltaE = (left, right) => {
  const a = lab(left);
  const b = lab(right);
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
};

test('行程配色至少覆盖 10 天且都是合法十六进制色值', () => {
  assert.ok(Array.isArray(colors), '配色应以数组形式导出');
  assert.ok(colors.length >= 10, `至少要 10 种颜色，实际 ${colors.length} 种`);
  colors.forEach((color) => assert.match(color, /^#[0-9a-f]{6}$/i, `${color} 不是合法色值`));
  assert.equal(new Set(colors.map((color) => color.toLowerCase())).size, colors.length, '配色不能重复');
});

test('每种颜色在自己的用法下都看得清：白底画线、深底当文字', () => {
  colors.forEach((color) => {
    assert.ok(contrast(color, '#ffffff') >= 2.8, `${color} 在浅色地图上对比度不足`);
    assert.ok(contrast(color, '#0b1220') >= 2.9, `${color} 在深色画面上作为文字对比度不足`);
  });
});

test('颜色两两之间色差足够大，不会看混', () => {
  for (let i = 0; i < colors.length; i += 1) {
    for (let j = i + 1; j < colors.length; j += 1) {
      const distance = deltaE(colors[i], colors[j]);
      assert.ok(distance >= 26, `${colors[i]} 与 ${colors[j]} 色差只有 ${distance.toFixed(1)}`);
    }
  }
});
