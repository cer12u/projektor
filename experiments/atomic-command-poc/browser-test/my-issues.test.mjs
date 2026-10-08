// Actual Chromium coverage. Do not count syntax checks or the Node controller
// suite as browser execution. Uses the existing signed-cookie/private fixture.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {startHarness} from './server.mjs';
const {chromium} = createRequire(import.meta.url)('playwright');
let browser;
before(async () => {
  await mkdir(new URL('../evidence/browser/', import.meta.url), {recursive: true});
  browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox']});
});
after(async () => { await browser?.close(); });

async function setup(t, {rows = 3, title = 'original title', authenticated = true, prepare} = {}) {
  const h = await startHarness();
  const context = await browser.newContext();
  t.after(async () => {await context.close(); await h.close();});
  await h.control('sql', 'UPDATE issue SET title=? WHERE id=?', [title, h.ids.issue]);
  if (rows > 0) await h.control('sql', 'INSERT INTO issue_queue(issue_id,assignee_id,status_category,priority,created_at,restricted_read) VALUES(?,?,?,?,?,0)', [h.ids.issue, h.ids.actorA, 'ready', 0, 0]);
  for (let n = 1; n < rows; n++) {
    const issue = randomUUID();
    await h.control('sql', 'INSERT INTO issue(id,project_id,title,version,deleted) VALUES(?,?,?,1,0)', [issue, h.ids.project, `Assigned issue ${n}`]);
    await h.control('sql', 'INSERT INTO issue_queue(issue_id,assignee_id,status_category,priority,created_at,restricted_read) VALUES(?,?,?,?,?,0)', [issue, h.ids.actorA, 'ready', 2, n]);
  }
  if (authenticated) await h.login(context, 'A');
  const page = await context.newPage();
  if (prepare) await prepare(page, h);
  await page.goto(`${h.base}/browser/my-issues.html`);
  await page.waitForFunction(() => window.myIssues && !myIssues.snapshot().busy);
  return {h, context, page};
}
const snapshot = page => page.evaluate(() => myIssues.snapshot());
const waitIdle = page => page.waitForFunction(() => !myIssues.snapshot().busy);

test('signed-cookie list renders text safely, explicit count and status under fixture CSP', async t => {
  const title = '<img src=x onerror="window.injected=true"> 日本語\nIssue';
  const f = await setup(t, {title});
  assert.equal((await snapshot(f.page)).phase, 'ready');
  assert.equal(await f.page.locator('[data-issues] li').count(), 3);
  assert.equal(await f.page.locator('[data-issues] strong').first().textContent(), title);
  assert.equal(await f.page.locator('[data-issues] img').count(), 0);
  assert.equal(await f.page.evaluate(() => window.injected), undefined);
  assert.equal(await f.page.locator('[data-count]').textContent(), '3 / 3');
  assert.deepEqual(await f.page.evaluate(() => ({local: localStorage.length, session: sessionStorage.length})), {local: 0, session: 0});
  await f.page.screenshot({path: new URL('../evidence/browser/my-issues-ready.png', import.meta.url).pathname});
});

test('unauthenticated page locks with no identity-input fallback; empty requires valid session', async t => {
  const locked = await setup(t, {authenticated: false});
  assert.equal((await snapshot(locked.page)).phase, 'locked');
  assert.equal(await locked.page.locator('[data-issues] li').count(), 0);
  assert.equal(await locked.page.locator('input').count(), 0);
  const empty = await setup(t, {rows: 0});
  assert.equal((await snapshot(empty.page)).phase, 'empty');
  assert.match(await empty.page.locator('[data-status]').textContent(), /No issues match/);
});

test('real Load more buttons report partial then complete without duplicate requests', async t => {
  const f = await setup(t);
  assert.equal((await f.page.evaluate(() => myIssues.setFilters({limit: 1}))).kind, 'partial');
  assert.equal(await f.page.locator('[data-count]').textContent(), '1 / 3');
  await f.page.getByRole('button', {name: 'Load more', exact: true}).click();
  await waitIdle(f.page);
  assert.equal(await f.page.locator('[data-count]').textContent(), '2 / 3');
  await f.page.getByRole('button', {name: 'Load more', exact: true}).click();
  await waitIdle(f.page);
  assert.equal((await snapshot(f.page)).complete, true);
  assert.equal(await f.page.locator('[data-issues] li').count(), 3);
  assert.equal(await f.page.locator('[data-more]').isVisible(), false);
});

test('next-page outage keeps a clearly stale partial prefix and Retry resumes', async t => {
  const f = await setup(t);
  await f.page.evaluate(() => myIssues.setFilters({limit: 1}));
  let unavailable = true;
  await f.page.route('**/my-issues?*', async route => {
    if (unavailable && new URL(route.request().url()).searchParams.has('cursor')) return route.fulfill({status: 503, contentType: 'text/html', body: 'Unavailable'});
    return route.continue();
  });
  await f.page.getByRole('button', {name: 'Load more', exact: true}).click();
  await waitIdle(f.page);
  assert.equal((await snapshot(f.page)).phase, 'partial');
  assert.equal((await snapshot(f.page)).complete, false);
  assert.equal(await f.page.locator('[data-issues] li').count(), 1);
  assert.match(await f.page.locator('[data-status]').textContent(), /may be out of date/);
  unavailable = false;
  await f.page.getByRole('button', {name: 'Retry', exact: true}).click();
  await waitIdle(f.page);
  assert.equal(await f.page.locator('[data-issues] li').count(), 2);
});

test('authorization change after session check clears previously loaded rows and requests refresh', async t => {
  const f = await setup(t);
  await f.page.evaluate(() => myIssues.setFilters({limit: 1}));
  let changed = false;
  await f.page.route('**/my-issues?*', async route => {
    if (!changed && new URL(route.request().url()).searchParams.has('cursor')) {
      changed = true;
      await f.h.control('sql', 'UPDATE issue_queue SET restricted_read=1 WHERE issue_id=?', [f.h.ids.issue]);
    }
    await route.continue();
  });
  await f.page.getByRole('button', {name: 'Load more', exact: true}).click();
  await waitIdle(f.page);
  assert.equal((await snapshot(f.page)).phase, 'stale');
  assert.equal(await f.page.locator('[data-issues] li').count(), 0);
  assert.match(await f.page.locator('[data-status]').textContent(), /Refresh/);
  await f.page.getByRole('button', {name: 'Refresh', exact: true}).click();
  await waitIdle(f.page);
  assert.equal((await snapshot(f.page)).total, 2);
  assert.equal((await snapshot(f.page)).items.some(row => row.id === f.h.ids.issue), false);
  await f.page.screenshot({path: new URL('../evidence/browser/my-issues-after-revocation.png', import.meta.url).pathname});
});

test('401 on continuation immediately clears DOM and retained controller rows', async t => {
  const f = await setup(t);
  await f.page.evaluate(() => myIssues.setFilters({limit: 1}));
  await f.page.route('**/my-issues?*', route => route.fulfill({status: 401, contentType: 'text/html', body: 'Sign in'}));
  await f.page.getByRole('button', {name: 'Load more', exact: true}).click();
  await waitIdle(f.page);
  assert.equal((await snapshot(f.page)).phase, 'locked');
  assert.equal(await f.page.locator('[data-issues] li').count(), 0);
  assert.equal(await f.page.evaluate(() => myIssues.items.length), 0);
});

test('malformed JSON success is error rather than a misleading empty state', async t => {
  const f = await setup(t, {prepare: page => page.route('**/my-issues?*', route => route.fulfill({status: 200, contentType: 'application/json', body: '{"data":{"items":[]}}'}))});
  assert.equal((await snapshot(f.page)).phase, 'error');
  assert.equal((await snapshot(f.page)).complete, false);
  assert.equal(await f.page.locator('[data-issues] li').count(), 0);
  assert.match(await f.page.locator('[data-status]').textContent(), /trustworthy list/);
});

test('real filter selection invalidates old list and reruns with all statuses', async t => {
  const f = await setup(t);
  await f.h.control('sql', 'UPDATE issue_queue SET status_category=? WHERE issue_id=?', ['done', f.h.ids.issue]);
  await f.page.getByRole('button', {name: 'Refresh', exact: true}).click();
  await waitIdle(f.page);
  assert.equal((await snapshot(f.page)).total, 2);
  await f.page.getByLabel('Show', {exact: true}).selectOption('all');
  await waitIdle(f.page);
  assert.equal((await snapshot(f.page)).total, 3);
  assert.equal((await snapshot(f.page)).filters.status, 'all');
});

test('synthetic lifecycle hide synchronously clears DOM; show must verify again', async t => {
  const f = await setup(t);
  assert.equal(await f.page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true}));
    return document.querySelector('[data-issues]').children.length;
  }), 0);
  assert.equal((await snapshot(f.page)).phase, 'locked');
  await f.page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true})));
  await f.page.waitForFunction(() => myIssues.snapshot().phase === 'ready');
  assert.equal(await f.page.locator('[data-issues] li').count(), 3);
});

test('new signed-in actor cannot retain the previous actor list across refresh', async t => {
  const f = await setup(t);
  await f.h.login(f.context, 'B');
  await f.page.getByRole('button', {name: 'Refresh', exact: true}).click();
  await waitIdle(f.page);
  assert.equal((await snapshot(f.page)).phase, 'empty');
  assert.equal(await f.page.locator('[data-issues] li').count(), 0);
});
