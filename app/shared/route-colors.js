(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RouteColors = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 行程配色：每天取一个，超过 10 天按顺序循环。
  // 全部颜色同时满足两个约束——白底（地图）对比度 ≥ 2.8，深底（视频片头/行程页）≥ 2.9；
  // 两两之间 CIE76 色差 ≥ 26，顺序按“相邻两天差异最大”交错排列。
  // 相邻两天的色相也刻意拉开：第 4 天玫红（h≈0）与第 10 天橙（h≈52）不再撞色。
  return [
    '#2563eb', // 1  蓝
    '#ca8a04', // 2  琥珀
    '#0d9488', // 3  青绿
    '#db2777', // 4  玫红
    '#15803d', // 5  深绿
    '#b45309', // 6  赭橙
    '#9333ea', // 7  紫
    '#65a30d', // 8  橄榄
    '#0e7490', // 9  深青
    '#ff6b1a'  // 10 亮橙
  ];
});
