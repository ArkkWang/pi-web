import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, appendFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { createSessionListWatcher, ensureSessionListWatcher } = await jiti.import('./session-list-watch.ts');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 3000;
  while (!check() && Date.now() < deadline) await sleep(20);
  assert.ok(check(), 'expected watch signal within 3s');
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-list-watch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function fakeWatch() {
  const watcher = new EventEmitter();
  watcher.closed = false;
  watcher.close = () => { watcher.closed = true; watcher.emit('close'); };
  return watcher;
}

test('native watcher discovers cwd and direct JSONL create/rename/delete but ignores appends', async t => {
  const root = await fixture(t);
  let changes = 0;
  const monitor = createSessionListWatcher(root, () => changes++, { debounceMs: 30 });
  t.after(() => monitor.close());
  const cwd = join(root, 'new-cwd');
  await mkdir(cwd);
  const file = join(cwd, 'first.jsonl');
  await writeFile(file, '{}\n');
  await until(() => changes > 0);
  await sleep(100);
  const before = changes;
  for (let i = 0; i < 15; i++) {
    await appendFile(file, '{}\n');
    await sleep(10);
  }
  await sleep(100);
  assert.equal(changes, before, 'existing conversation output must not invalidate the list');
  await rename(file, join(cwd, 'second.jsonl'));
  await until(() => changes > before);
  await sleep(80);
  const renamed = changes;
  await rm(cwd, { recursive: true });
  await until(() => changes > renamed);
});

test('single root watch filters the fixed two-level layout and coalesces rename events', async t => {
  const root = await fixture(t);
  let listener;
  let watchCalls = 0;
  let changes = 0;
  const monitor = createSessionListWatcher(root, () => changes++, {
    debounceMs: 30,
    watchDirectory: (path, callback) => {
      assert.equal(path, root); watchCalls++; listener = callback; return fakeWatch();
    },
  });
  t.after(() => monitor.close());
  for (const name of ['cwd/file.jsonl', 'cwd\\file.jsonl', null]) listener('change', name);
  for (const name of ['cwd/readme.txt', 'cwd/deep/file.jsonl', 'cwd\\deep\\file.jsonl']) listener('rename', name);
  await sleep(80);
  assert.equal(changes, 0);
  for (let i = 0; i < 100; i++) listener('rename', 'cwd/file.jsonl');
  listener('rename', 'new-cwd');
  listener('rename', 'cwd\\other.jsonl');
  await sleep(80);
  assert.equal(changes, 1);
  assert.equal(watchCalls, 1, 'no per-directory or per-file registry');
  listener('rename', null);
  await sleep(80);
  assert.equal(changes, 2, 'unknown rename paths are conservatively refreshed');
  listener('rename', 'cwd/cancelled.jsonl');
  monitor.close();
  await sleep(80);
  assert.equal(changes, 2);
});

test('absent and replaced roots recover without creating directories', async t => {
  const base = await fixture(t);
  const root = join(base, 'sessions');
  let changes = 0;
  const monitor = createSessionListWatcher(root, () => changes++, { retryMs: 30, debounceMs: 20 });
  t.after(() => monitor.close());
  await sleep(60);
  assert.equal(changes, 0);
  await mkdir(join(root, 'cwd'), { recursive: true });
  await writeFile(join(root, 'cwd', 'first.jsonl'), '{}\n');
  await until(() => changes > 0);
  await sleep(100);
  const before = changes;
  await rename(root, join(base, 'old'));
  await mkdir(join(root, 'cwd'), { recursive: true });
  await writeFile(join(root, 'cwd', 'second.jsonl'), '{}\n');
  await until(() => changes > before);
  await sleep(100);
  const recovered = changes;
  await writeFile(join(root, 'cwd', 'third.jsonl'), '{}\n');
  await until(() => changes > recovered);
});

test('unavailable watcher warns once and retries with periodic invalidation', async t => {
  const root = await fixture(t);
  let changes = 0;
  let warnings = 0;
  let available = false;
  let current;
  const monitor = createSessionListWatcher(root, () => changes++, {
    retryMs: 30, fallbackMs: 70, debounceMs: 10,
    watchDirectory: () => {
      if (!available) throw Object.assign(new Error('unsupported watch'), { code: 'ENOSYS' });
      current = fakeWatch(); return current;
    },
    warn: () => warnings++,
  });
  t.after(() => monitor.close());
  await until(() => changes >= 2);
  assert.equal(warnings, 1);
  available = true;
  await until(() => current !== undefined);
  await sleep(60);
  const recovered = changes;
  await sleep(150);
  assert.equal(changes, recovered);
  current.emit('error', new Error('lost watch'));
  assert.equal(current.closed, true);
  assert.equal(warnings, 2);
  await until(() => changes > recovered);
});

test('unexpected watch closure reconnects and invalidates the missed interval', async t => {
  const root = await fixture(t);
  const watchers = [];
  let changes = 0;
  const monitor = createSessionListWatcher(root, () => changes++, {
    retryMs: 30, debounceMs: 10,
    watchDirectory: () => { const watch = fakeWatch(); watchers.push(watch); return watch; },
  });
  t.after(() => monitor.close());
  watchers[0].emit('close');
  await until(() => watchers.length === 2 && changes > 0);
});

test('singleton survives module reload and changes roots without leaving old watches', async t => {
  const root = await fixture(t);
  const other = await fixture(t);
  const previous = globalThis.__piSessionListWatcher;
  delete globalThis.__piSessionListWatcher;
  t.after(() => {
    globalThis.__piSessionListWatcher?.close();
    globalThis.__piSessionListWatcher = previous;
  });
  ensureSessionListWatcher(root, () => {});
  const first = globalThis.__piSessionListWatcher;
  const fresh = await createJiti(import.meta.url, { moduleCache: false }).import('./session-list-watch.ts');
  fresh.ensureSessionListWatcher(root, () => {});
  assert.equal(globalThis.__piSessionListWatcher, first);
  let closed = 0;
  const close = first.close;
  first.close = () => { closed++; close(); };
  fresh.ensureSessionListWatcher(other, () => {});
  assert.equal(closed, 1);
  assert.notEqual(globalThis.__piSessionListWatcher, first);
});
