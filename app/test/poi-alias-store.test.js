const test = require('node:test');
const assert = require('node:assert/strict');

const storage = new Map();
global.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};
global.window = {};
require('../web/src/features/point/poiAliasStore.js');
const aliasStore = global.window.PoiAliasStore;

const reset = () => storage.clear();

test('改过昵称的 POI，按名称和坐标都能查回昵称', () => {
  reset();
  aliasStore.remember({name: '赛里木湖', alias: '松鼠头', lng: 81.123456, lat: 43.987654});
  assert.equal(aliasStore.aliasFor({name: '赛里木湖'}), '松鼠头');
  assert.equal(aliasStore.aliasFor({name: ' 赛里木湖 '}), '松鼠头');
  assert.equal(aliasStore.aliasFor({lng: 81.123456, lat: 43.987654}), '松鼠头');
  assert.equal(aliasStore.aliasFor({name: '松鼠头'}), '松鼠头');
  assert.equal(aliasStore.aliasFor({name: '那拉提'}), '');
});

test('连续改名时始终能追到最初的名称，景点介绍不会另起一份', () => {
  reset();
  aliasStore.remember({name: '赛里木湖', alias: '松鼠头', lng: 81.1, lat: 43.9});
  aliasStore.remember({name: '松鼠头', alias: '尖顶松林', lng: 81.1, lat: 43.9});
  assert.equal(aliasStore.aliasFor({name: '赛里木湖'}), '尖顶松林');
  assert.equal(aliasStore.aliasFor({name: '松鼠头'}), '尖顶松林');
  assert.equal(aliasStore.canonicalFor({name: '尖顶松林'}), '赛里木湖');
  assert.equal(aliasStore.canonicalFor({name: '松鼠头'}), '赛里木湖');
  assert.equal(aliasStore.canonicalFor({name: '赛里木湖'}), '');
});

test('没改过昵称的点位保持原名', () => {
  reset();
  assert.equal(aliasStore.resolveName({name: '那拉提', lng: 82, lat: 44}), '那拉提');
  assert.equal(aliasStore.resolveName({name: ''}), '');
});
