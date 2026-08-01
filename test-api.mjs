import assert from 'node:assert/strict';
import handler from './api/zones.js';

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k,v){ this.headers[k]=v; },
    status(code){ this.statusCode=code; return this; },
    json(value){ this.body=value; return this; }
  };
}

const originalFetch = global.fetch;
try {
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      json: async () => ({ type:'FeatureCollection', features:[{ type:'Feature', properties:{zonetype:'Beboerzone',zonekode:'VB'}, geometry:{type:'Polygon',coordinates:[]} }] })
    };
  };
  const res = responseRecorder();
  await handler({ method:'GET' }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.source, 'Københavns Kommune WFS');
  assert.equal(calls, 1);

  const badMethod = responseRecorder();
  await handler({ method:'POST' }, badMethod);
  assert.equal(badMethod.statusCode, 405);

  let attempt = 0;
  global.fetch = async () => {
    attempt += 1;
    if (attempt <= 2) throw new Error('WFS down');
    return { ok:true, json: async () => ({ result:{ records:[{zonekode:'VB'}] } }) };
  };
  const fallback = responseRecorder();
  await handler({ method:'GET' }, fallback);
  assert.equal(fallback.statusCode, 200);
  assert.equal(fallback.body.source, 'Open Data DK datastore fallback');
  assert.equal(attempt, 3);

  console.log('api: primary, method guard og fallback tests bestået');
} finally {
  global.fetch = originalFetch;
}
