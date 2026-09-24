const test = require('node:test');
const assert = require('node:assert/strict');
const {createMapEnhancementRoutes} = require('../server/routes/map-enhancement-routes');

test('map enhancement routes handle point facts and hillshade tiles', async () => {
  const responses = [];
  const handler = createMapEnhancementRoutes({
    pointInfoService: {
      getPointInfo: async (payload) => ({ok: true, echoed: payload}),
    },
    hillshadeService: {
      getTile: async (z, x, y) => Buffer.from(`${z}/${x}/${y}`),
    },
    readBody: async () => ({weather: true}),
    send: (_res, status, data) => responses.push({status, data}),
  });

  assert.equal(await handler({method: 'POST'}, {}, new URL('http://localhost/api/point-info')), true);
  assert.deepEqual(responses[0], {status: 200, data: {ok: true, echoed: {weather: true}}});

  const headers = [];
  const chunks = [];
  const res = {
    writeHead: (status, value) => headers.push({status, value}),
    end: (value) => chunks.push(value),
  };
  assert.equal(await handler({method: 'GET'}, res, new URL('http://localhost/api/map/hillshade/8/201/99.webp')), true);
  assert.equal(headers[0].status, 200);
  assert.equal(headers[0].value['Content-Type'], 'image/webp');
  assert.equal(chunks[0].toString(), '8/201/99');
  assert.equal(await handler({method: 'GET'}, {}, new URL('http://localhost/api/unknown')), false);
});

test('point info errors are returned as service responses', async () => {
  const responses = [];
  const handler = createMapEnhancementRoutes({
    pointInfoService: {getPointInfo: async () => { const error = new Error('天气上游不可用'); error.status = 503; throw error; }},
    hillshadeService: {getTile: async () => Buffer.alloc(0)},
    readBody: async () => ({}),
    send: (_res, status, data) => responses.push({status, data}),
  });
  assert.equal(await handler({method: 'POST'}, {}, new URL('http://localhost/api/point-info')), true);
  assert.deepEqual(responses[0], {status: 503, data: {ok: false, message: '天气上游不可用'}});
});
