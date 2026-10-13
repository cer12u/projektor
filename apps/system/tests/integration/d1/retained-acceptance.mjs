// @module verification
// @role retained-acceptance
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

const temp = await mkdtemp(join(tmpdir(), 'projektor-retained-'));
const report = { environment: 'codexvm actual local workerd; fresh synthetic DO/D1',
  startedAt: new Date().toISOString(), productionActions: 0, issueWrites: 0, results: [] };
let mf;
async function check(name, fn) {
  await fn();
  report.results.push({ name, passed: true });
  console.log('PASS ' + name);
}
try {
  const productConfig = JSON.parse(await readFile('wrangler.production.example.json', 'utf8'));
  assert.deepEqual(productConfig.d1_databases.map(d => d.binding), ['DB']);
  assert.equal(productConfig.d1_databases[0].database_id, '00000000-0000-4000-8000-000000000001');
  assert.deepEqual(productConfig.migrations, [{ tag: 'v2' }]);
  assert.equal(productConfig.exports, undefined);
  await check('candidate retains migration tag and new DB only; no delete/rename/transfer', async () => {});
  await build({entryPoints: ['tests/support/retained-fixture.ts'], outfile: temp + '/worker.mjs', bundle: true,
    format: 'esm', platform: 'neutral', mainFields: ['module', 'main'], conditions: ['workerd', 'worker', 'browser'],
    external: ['node:*', 'cloudflare:*'], plugins: [{name: 'wasm', setup(b) {
      b.onResolve({filter: /\.wasm$/}, a => ({path: './' + basename(a.path), external: true}));
    }}]});
  const modules = [{type: 'ESModule', path: temp + '/worker.mjs', contents: await readFile(temp + '/worker.mjs', 'utf8')}];
  for (const name of ['argon2.wasm', 'blake2b.wasm']) modules.push({type: 'CompiledWasm', path: temp + '/' + name,
    contents: await readFile('src/adapters/crypto/generated/' + name)});
  mf = new Miniflare(convertV4MiniflareOptions({name: 'retained-local', modules, modulesRoot: temp,
    compatibilityDate: productConfig.compatibility_date, compatibilityFlags: productConfig.compatibility_flags,
    durableObjects: {R: {className: 'RateLimiterFixture', useSQLite: true}, W: {className: 'WorkspaceHubFixture', useSQLite: true}},
    d1Databases: {DB: 'fresh-synthetic-new-db'}, bindings: {AUTH_ORIGIN: 'https://retained.invalid'},
    host: '127.0.0.1', port: 0, cf: false, logRequests: false}));
  await mf.ready;
  await check('new API entrypoint health reaches local D1 without old DB binding', async () => {
    const r = await mf.dispatchFetch('https://retained.invalid/api/health');
    assert.equal(r.status, 200); assert.equal((await r.json()).database, 'ok');
  });
  const bindings = await mf.getBindings();
  for (const name of ['R', 'W']) {
    const stub = bindings[name].get(bindings[name].idFromName('synthetic-only'));
    await stub.seedFixture();
    const readState = async () => JSON.parse(await stub.readFixture());
    const before = await readState();
    await check(name + ' returns 410 for GET/POST without changing KV or SQL history', async () => {
      for (const method of ['GET', 'POST']) {
        const r = await stub.fetch('https://retained.invalid/retired-route', {method});
        assert.equal(r.status, 410); assert.equal(r.headers.get('Cache-Control'), 'no-store');
        assert.deepEqual(await r.json(), {error: 'retired_namespace'});
      }
      assert.deepEqual(await readState(), before);
    });
    await check(name + ' real alarm delivery consumes schedule and preserves application data', async () => {
      await stub.scheduleFixtureAlarm(Date.now() + 80);
      const deadline = Date.now() + 5000;
      let after;
      do { await new Promise(r => setTimeout(r, 50)); after = await readState(); }
      while (after.alarm !== null && Date.now() < deadline);
      assert.equal(after.alarm, null);
      assert.deepEqual(after.sentinel, before.sentinel); assert.deepEqual(after.history, before.history);
    });
    await check(name + ' hibernating WebSocket message closes 1001 without changing saved data', async () => {
      const response = await stub.fetch('https://retained.invalid/__fixture/socket', {headers: {Upgrade: 'websocket'}});
      assert.equal(response.status, 101);
      const ws = response.webSocket;
      assert.ok(ws); ws.accept();
      const closed = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WebSocket did not close')), 5000);
        ws.addEventListener('close', e => {clearTimeout(timer); resolve(e.code);}, {once: true});
        ws.addEventListener('message', () => {clearTimeout(timer); reject(new Error('retired handler emitted data'));}, {once: true});
      });
      ws.send('synthetic ignored payload');
      assert.equal(await closed, 1001);
      assert.deepEqual(await readState(), before);
    });
  }
  report.passed = true;
} catch (e) {
  report.passed = false; report.error = e.message; throw e;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile('.local/evidence/retained-workerd-results.json', JSON.stringify(report, null, 2) + '\n');
  if (mf) await mf.dispose();
  await rm(temp, {recursive: true, force: true});
}
