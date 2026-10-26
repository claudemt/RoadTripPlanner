const test = require('node:test');
const assert = require('node:assert/strict');
const {createBrowserContext, loadBrowserFile} = require('./helpers/browser-functions');

const html = '<!DOCTYPE html><html><head><title>522</title></head><body>Connection timed out</body></html>';

function setup(payload, status = 200) {
  const context = createBrowserContext({
    location: {protocol: 'https:', origin: 'https://example.test'},
    fetch: async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload
    })
  });
  loadBrowserFile(context, 'web/src/api/localServiceClient.js');
  return context.window.LocalServiceClient.create({
    mode: 'proxy',
    user: {email: 'user@example.com'},
    capabilities: {cloudRoutes: true}
  });
}

test('云端 HTML 错误会转成简短提示', async () => {
  const service = setup({ok: false, message: html}, 500);
  const {response, data} = await service.listRoutes({force: true});
  assert.equal(response.status, 500);
  assert.equal(data.message, '云端服务暂时不可用，请稍后重试。');
});

test('数据库技术错误也会转成简短提示', async () => {
  const service = setup({ok: false, message: 'Could not query the database for the schema cache. Retrying.'}, 503);
  const {data} = await service.listRoutes({force: true});
  assert.equal(data.message, '云端服务暂时不可用，请稍后重试。');
});

test('导出任务里的错误也会被清理', async () => {
  const service = setup({
    ok: true,
    tasks: [{
      taskId: 'task-1',
      progress: {error: html},
      result: {assetUploadError: html}
    }]
  });
  const {data} = await service.listExports();
  assert.equal(data.tasks[0].progress.error, '云端服务暂时不可用，请稍后重试。');
  assert.equal(data.tasks[0].result.assetUploadError, '云端服务暂时不可用，请稍后重试。');
});

test('过长的非 HTML 错误会被截断', async () => {
  const service = setup({ok: false, message: 'x'.repeat(600)}, 400);
  const {data} = await service.listRoutes({force: true});
  assert.equal(data.message.length, 401);
  assert.match(data.message, /…$/);
});
