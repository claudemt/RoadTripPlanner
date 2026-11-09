const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createRuntimeConfig} = require('../server/config/runtime-config');

const ENV_KEYS = [
  'ROADTRIP_STORAGE',
  'ROADTRIP_OUTPUT_ROOT',
  'ROADTRIP_DATA_ROOT',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ROADTRIP_SINGLE_USER'
];

const withEnv = (overrides, run) => {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, overrides);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roadtrip-config-'));
  const appRoot = path.join(root, 'app');
  fs.mkdirSync(appRoot, {recursive: true});
  try {
    return run(appRoot, root);
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
};

test('存储模式：没有任何云端配置时默认本地，资产写入 output/', () => {
  withEnv({}, (appRoot, root) => {
    const config = createRuntimeConfig(appRoot);
    assert.equal(config.storageMode, 'local');
    assert.equal(config.assetRoot, path.join(root, 'output'));
    assert.equal(config.routeRoot, path.join(root, 'output', 'routes'));
  });
});

test('存储模式：本机就算填了 Supabase 也默认本地，不误切云端', () => {
  withEnv({
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-key',
    ROADTRIP_DATA_ROOT: '/var/lib/roadtrip'
  }, (appRoot, root) => {
    const config = createRuntimeConfig(appRoot);
    assert.equal(config.storageMode, 'local');
    assert.equal(config.routeRoot, path.join(root, 'output', 'routes'));
  });
});

test('存储模式：当网站跑时一行开关切到云端，资产留在数据目录', () => {
  withEnv({
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-key',
    ROADTRIP_STORAGE: 'cloud',
    ROADTRIP_DATA_ROOT: '/var/lib/roadtrip'
  }, (appRoot) => {
    const config = createRuntimeConfig(appRoot);
    assert.equal(config.storageMode, 'cloud');
    assert.equal(config.routeRoot, path.join(path.resolve('/var/lib/roadtrip'), 'routes'));
  });
});

test('存储模式：本机自用不需要邮箱，默认也不对外开放', () => {
  withEnv({}, (appRoot) => {
    const config = createRuntimeConfig(appRoot);
    assert.equal(config.storageMode, 'local');
    assert.equal(config.singleUser, false);
  });
  withEnv({ROADTRIP_SINGLE_USER: 'true'}, (appRoot) => {
    assert.equal(createRuntimeConfig(appRoot).singleUser, true);
  });
});

test('存储模式：显式 ROADTRIP_STORAGE 覆盖自动判断', () => {
  withEnv({
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-key',
    ROADTRIP_STORAGE: 'local',
    ROADTRIP_OUTPUT_ROOT: '/tmp/roadtrip-output'
  }, (appRoot) => {
    const config = createRuntimeConfig(appRoot);
    assert.equal(config.storageMode, 'local');
    assert.equal(config.routeRoot, path.join(path.resolve('/tmp/roadtrip-output'), 'routes'));
  });
  withEnv({
    ROADTRIP_STORAGE: 'cloud',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-key'
  }, (appRoot) => {
    const config = createRuntimeConfig(appRoot);
    assert.equal(config.storageMode, 'cloud');
  });
});
