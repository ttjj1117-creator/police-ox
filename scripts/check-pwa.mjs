// Run after npm run build. Uses an isolated browser, never the user's profile.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

let revision = '';
const root = resolve('dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (!pathname.startsWith('/police-ox/')) { res.writeHead(404).end(); return; }
  const file = resolve(root, pathname.slice('/police-ox/'.length) || 'index.html');
  if (!file.startsWith(root + '/') && !file.startsWith(root + '\\')) { res.writeHead(404).end(); return; }
  try {
    let body = await readFile(file);
    if (pathname.endsWith('/sw.js')) body = Buffer.concat([body, Buffer.from(revision)]);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/police-ox/`;
const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '?mode=real');
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  const manifestUrl = await page.locator('link[rel=manifest]').evaluate(el => el.href);
  const manifest = await (await context.request.get(manifestUrl)).json();
  assert.equal(manifest.display, 'standalone');
  assert.equal(new URL(manifest.scope, manifestUrl).href, base);
  assert.equal(new URL(manifest.start_url, manifestUrl).href, base + '?mode=real');
  for (const icon of manifest.icons) assert.equal((await context.request.get(new URL(icon.src, manifestUrl).href)).status(), 200);
  assert.equal(await page.evaluate(async () => (await navigator.serviceWorker.ready).scope), base);
  const text = await page.locator('body').innerText();
  assert.ok(text.length > 50);
  await context.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => document.body.innerText.length > 50);
  assert.ok(page.url().endsWith('?mode=real'));
  await page.goto(base + '?mode=demo');
  await page.waitForFunction(() => document.body.innerText.includes('기능 확인용 예시 · 실제 기출이 아닙니다.'));
  await context.setOffline(false);
  // New worker activates without reloading the live document.
  await page.evaluate(() => { window.pwaTestSentinel = 'preserved'; });
  revision = '\n// update smoke test\n';
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    const changed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Worker update timed out')), 30000);
      navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    await registration.update();
    await changed;
  });
  assert.equal(await page.evaluate(() => window.pwaTestSentinel), 'preserved');
  const cached = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async key => (await (await caches.open(key)).keys()).map(r => r.url)))).flat());
  assert.ok(cached.length > 0);
  assert.ok(cached.every(url => url.startsWith(base) && !new URL(url).pathname.endsWith('.json')));
  assert.deepEqual(errors, []);
  console.log('PWA PASS: project scope, manifest/icons, offline real/demo, safe update, static-only cache');
} finally {
  await browser.close();
  await new Promise(r => server.close(r));
}
