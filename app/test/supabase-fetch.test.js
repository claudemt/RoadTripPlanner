const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {createBrowserContext, loadFunctions} = require('./helpers/browser-functions');

test('Supabase 网关 HTML 错误会变成可读的 JSON 消息', async () => {
  const context = createBrowserContext({
    Response,
    fetch: async () => ({
      ok: false,
      status: 522,
      statusText: 'Unknown',
      headers: {get: () => 'text/html'}
    })
  });
  loadFunctions(context, ['SUPABASE_UNAVAILABLE_MESSAGE', 'supabaseFetch'], 'server/route-render-server.js');
  const supabaseFetch = vm.runInContext('supabaseFetch', context);
  const response = await supabaseFetch('https://example.test/rest/v1/routes', {});
  assert.equal(response.status, 522);
  const body = await response.json();
  assert.equal(body.message, '云端服务暂时不可用，请稍后重试。');
  assert.equal(body.retryable, true);
});

test('Supabase 正常响应和 JSON 错误保持原样', async () => {
  const original = new Response('{}', {status: 200, headers: {'Content-Type': 'application/json'}});
  const jsonError = new Response('{"message":"详情"}', {status: 400, headers: {'Content-Type': 'application/json'}});
  const responses = [original, jsonError];
  const context = createBrowserContext({
    Response,
    fetch: async () => responses.shift()
  });
  loadFunctions(context, ['SUPABASE_UNAVAILABLE_MESSAGE', 'supabaseFetch'], 'server/route-render-server.js');
  const supabaseFetch = vm.runInContext('supabaseFetch', context);
  assert.equal(await supabaseFetch('https://example.test/a', {}), original);
  assert.equal(await supabaseFetch('https://example.test/b', {}), jsonError);
});

test('Supabase 数据库技术错误会变成简短的中文提示', async () => {
  const context = createBrowserContext({
    Response,
    fetch: async () => new Response(
      JSON.stringify({message: 'Could not query the database for the schema cache. Retrying.'}),
      {status: 503, headers: {'Content-Type': 'application/json'}}
    )
  });
  loadFunctions(context, ['SUPABASE_UNAVAILABLE_MESSAGE', 'supabaseFetch'], 'server/route-render-server.js');
  const supabaseFetch = vm.runInContext('supabaseFetch', context);
  const response = await supabaseFetch('https://example.test/rest/v1/routes', {});
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.message, '云端服务暂时不可用，请稍后重试。');
  assert.equal(body.retryable, true);
});
