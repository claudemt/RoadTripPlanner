const test = require('node:test');
const assert = require('node:assert/strict');
const {createBrowserContext, loadBrowserFile} = require('./helpers/browser-functions');

const TRACKS = [
  {id: 'a', title: '晨光', durationSec: 120, source: 'default'},
  {id: 'b', title: '远山', durationSec: 95, source: 'default'}
];

function createElement() {
  return {
    textContent: '',
    innerHTML: '',
    value: '',
    checked: false,
    hidden: false,
    dataset: {},
    listeners: {},
    classList: {toggle() {}, add() {}, remove() {}},
    querySelectorAll: () => [],
    closest: () => null,
    addEventListener(type, handler) {
      (this.listeners[type] = this.listeners[type] || []).push(handler);
    },
    click() {
      this.onclick?.();
    }
  };
}

function setup() {
  const elements = new Map();
  const saved = [];
  let closeHandler = null;
  const context = createBrowserContext();
  context.window.HtmlUtils = {escapeHtml: (value) => String(value)};
  context.window.FormatUtils = {formatClock: (seconds) => `${seconds}s`};
  loadBrowserFile(context, 'web/src/features/export/musicController.js');
  const ui = context.window.ExportMusicUi.create({
    el: (id) => {
      if (!elements.has(id)) elements.set(id, createElement());
      return elements.get(id);
    },
    localService: {
      musicStreamUrl: (id) => `/stream/${id}`,
      async musicLibrary() {
        return {response: {ok: true}, data: {ok: true, tracks: TRACKS.map((track) => ({...track}))}};
      },
      async getRouteMusic() {
        return {data: {selection: null}};
      },
      async saveRouteMusic(routeId, selection) {
        saved.push({routeId, ...selection});
        return {response: {ok: true}, data: {ok: true}};
      }
    },
    dialogs: {
      open() {},
      register(id, handler) {
        closeHandler = handler;
      }
    },
    toast() {},
    confirmDialog: async () => true
  });
  return {ui, elements, saved, closeDialog: () => closeHandler?.()};
}

const pickRow = (listEl, id) => {
  const row = {dataset: {id}};
  const event = {target: {closest: (selector) => (selector === '.music-row' ? row : null)}};
  listEl.listeners.click.forEach((handler) => handler(event));
};

test('选曲弹窗默认是关闭，点了曲子才变成确定', async () => {
  const {ui, elements} = setup();
  await ui.prepare('route-1');
  const closeBtn = elements.get('exportMusicCloseBtn');
  const listEl = elements.get('exportMusicList');
  assert.equal(closeBtn.textContent, '关闭');
  pickRow(listEl, 'a');
  assert.equal(closeBtn.textContent, '确定');
  assert.equal(elements.get('exportMusicSummary').textContent, '晨光', '摘要只显示曲名');
  assert.equal(elements.get('exportMusicEnabled').checked, true);
});

test('没选曲子就关掉弹窗时，按钮文案回到关闭', async () => {
  const {ui, elements, closeDialog} = setup();
  await ui.prepare('route-2');
  closeDialog();
  assert.equal(elements.get('exportMusicCloseBtn').textContent, '关闭');
});

test('切换曲子后按钮仍是确定，摘要跟着换', async () => {
  const {ui, elements} = setup();
  await ui.prepare('route-3');
  const listEl = elements.get('exportMusicList');
  pickRow(listEl, 'a');
  pickRow(listEl, 'b');
  assert.equal(elements.get('exportMusicCloseBtn').textContent, '确定');
  assert.equal(elements.get('exportMusicSummary').textContent, '远山');
});

test('调音量只改音量，不把百分比写进曲名', async () => {
  const {ui, elements} = setup();
  await ui.prepare('route-4');
  pickRow(elements.get('exportMusicList'), 'a');
  const volumeInput = elements.get('exportMusicVolume');
  volumeInput.value = '35';
  volumeInput.oninput();
  assert.equal(elements.get('exportMusicSummary').textContent, '晨光');
  assert.equal(elements.get('exportMusicVolumeValue').textContent, '35%');
});
