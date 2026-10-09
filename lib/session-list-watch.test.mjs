import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, appendFile, rename, rm, readdir } from 'node:fs/promises';
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
  await mkdir(join(root, 'cwd'));
  await writeFile(join(root, 'cwd', 'file.jsonl'), '{}\n');
  for (let i = 0; i < 100; i++) listener('rename', 'cwd/file.jsonl');
  listener('rename', 'new-cwd');
  listener('rename', 'cwd\\other.jsonl');
  await sleep(80);
  assert.equal(changes, 1);
  assert.equal(watchCalls, 1, 'one native watcher, not one per file');
  await writeFile(join(root, 'cwd', 'unknown.jsonl'), '{}\n');
  listener('rename', null);
  await sleep(80);
  assert.equal(changes, 2, 'unknown paths reconcile the full inventory');
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

test('macOS-style rename notifications for existing output never invalidate the catalogue', async t => {
  const root = await fixture(t);
  const cwd = join(root, 'cwd');
  await mkdir(cwd);
  const file = join(cwd, 'existing.jsonl');
  await writeFile(file, '{}\n');
  let listener;
  let changes = 0;
  const monitor = createSessionListWatcher(root, () => changes++, {
    debounceMs: 20,
    watchDirectory: (_, callback) => { listener = callback; return fakeWatch(); },
  });
  t.after(() => monitor.close());
  for (let i = 0; i < 12; i++) {
    await appendFile(file, '{}\n');
    listener('rename', 'cwd/existing.jsonl');
    await sleep(10);
  }
  await sleep(100);
  assert.equal(changes, 0, 'rename is not proof of a membership change');
  listener('rename', 'cwd');
  listener('rename', null);
  await sleep(100);
  assert.equal(changes, 0, 'ambiguous append notifications also require reconciliation');
  await writeFile(join(cwd, 'new.jsonl'), '{}\n');
  listener('rename', 'cwd/new.jsonl');
  await until(() => changes === 1);
});

test('append bursts reconcile only the affected directory once per batch', async t => {
  const root = await fixture(t);
  for (const project of ['active', 'idle']) {
    await mkdir(join(root, project));
    await writeFile(join(root, project, 'existing.jsonl'), '{}\n');
  }
  let listener;
  let changes = 0;
  const reads = [];
  const monitor = createSessionListWatcher(root, () => changes++, {
    debounceMs: 20,
    watchDirectory: (_, callback) => { listener = callback; return fakeWatch(); },
    readDirectory: async path => { reads.push(path); return readdir(path); },
  });
  t.after(() => monitor.close());
  for (let i = 0; i < 1000; i++) listener('rename', 'active/existing.jsonl');
  await sleep(100);
  assert.deepEqual(reads, [join(root, 'active')]);
  assert.equal(changes, 0);
  await writeFile(join(root, 'active', 'new.jsonl'), '{}\n');
  listener('change', 'active/new.jsonl');
  await until(() => changes === 1);
});

test('directory-only events discover moved catalogues and ignore unrelated files', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'old'));
  await writeFile(join(root, 'old', 'existing.jsonl'), '{}\n');
  let listener;
  let changes = 0;
  const monitor = createSessionListWatcher(root, () => changes++, {
    debounceMs: 20,
    watchDirectory: (_, callback) => { listener = callback; return fakeWatch(); },
  });
  t.after(() => monitor.close());
  await rename(join(root, 'old'), join(root, 'new'));
  listener('rename', 'old');
  listener('rename', 'new');
  await until(() => changes === 1);
  await writeFile(join(root, 'readme.txt'), 'not a project');
  listener('rename', null);
  await sleep(100);
  assert.equal(changes, 1);
  await rm(join(root, 'new'), { recursive: true });
  listener('rename', 'new');
  await until(() => changes === 2);
});

test('events arriving during async reconciliation get another serial pass; close discards pending IO', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'cwd'));
  let listener;
  let changes = 0;
  let release;
  let hold = true;
  let reads = 0;
  let active = 0;
  let maxActive = 0;
  const monitor = createSessionListWatcher(root, () => changes++, {
    debounceMs: 20,
    watchDirectory: (_, callback) => { listener = callback; return fakeWatch(); },
    readDirectory: async path => {
      active++;
      maxActive = Math.max(active, maxActive);
      reads++;
      const names = await readdir(path);
      if (hold) await new Promise(resolve => { release = resolve; });
      active--;
      return names;
    },
  });
  t.after(() => monitor.close());
  listener('rename', 'cwd');
  await until(() => release !== undefined);
  await writeFile(join(root, 'cwd', 'new.jsonl'), '{}\n');
  listener('rename', 'cwd/new.jsonl');
  hold = false;
  release();
  await until(() => changes === 1);
  assert.equal(reads, 2);
  assert.equal(maxActive, 1);
  hold = true;
  release = undefined;
  await writeFile(join(root, 'cwd', 'cancelled.jsonl'), '{}\n');
  listener('rename', 'cwd/cancelled.jsonl');
  await until(() => release !== undefined);
  monitor.close();
  release();
  await sleep(100);
  assert.equal(changes, 1, 'closed watchers cannot invalidate after awaited IO');
});

test('directory IO failures do not install partial inventory and recover', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'cwd'));
  await writeFile(join(root, 'cwd', 'existing.jsonl'), '{}\n');
  let listener;
  let changes = 0;
  let warnings = 0;
  let broken = true;
  let watchCalls = 0;
  const monitor = createSessionListWatcher(root, () => changes++, {
    debounceMs: 10, retryMs: 30,
    watchDirectory: (_, callback) => { watchCalls++; listener = callback; return fakeWatch(); },
    readDirectory: async path => {
      if (broken) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return readdir(path);
    },
    warn: () => warnings++,
  });
  t.after(() => monitor.close());
  listener('rename', 'cwd/existing.jsonl');
  await until(() => warnings > 0);
  broken = false;
  await until(() => watchCalls >= 2 && changes >= 2);
  await sleep(100);
  const stable = changes;
  listener('rename', 'cwd/existing.jsonl');
  await sleep(100);
  assert.equal(changes, stable);
});

test('watch replacement discards an in-flight old inventory and refreshes the missed interval', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'cwd'));
  await writeFile(join(root, 'cwd', 'existing.jsonl'), '{}\n');
  const watches = [];
  let changes = 0;
  let release;
  let hold = true;
  const monitor = createSessionListWatcher(root, () => changes++, {
    debounceMs: 10, retryMs: 30,
    watchDirectory: (_, listener) => {
      const watch = fakeWatch();
      watches.push({ watch, listener });
      return watch;
    },
    readDirectory: async path => {
      const names = await readdir(path);
      if (hold) await new Promise(resolve => { release = resolve; });
      return names;
    },
  });
  t.after(() => monitor.close());
  watches[0].listener('rename', 'cwd/existing.jsonl');
  await until(() => release !== undefined);
  watches[0].watch.close();
  await writeFile(join(root, 'cwd', 'new.jsonl'), '{}\n');
  await until(() => watches.length === 2);
  hold = false;
  release();
  await until(() => changes === 1);
  watches[0].listener('rename', null); // Late events from detached native handles.
  watches[1].listener('rename', 'cwd/new.jsonl');
  await sleep(100);
  assert.equal(changes, 1);
});

test('content subscriptions share the root watcher, coalesce appends, and do not invalidate the catalogue', async t => {
  const { subscribeSessionFile } = await jiti.import('./session-list-watch.ts');
  const root = await fixture(t);
  await mkdir(join(root, 'cwd'));
  const file = join(root, 'cwd', 'selected.jsonl');
  await writeFile(file, '{}\n');
  let nativeEvent;
  let listChanges = 0;
  let contentChanges = 0;
  const monitor = createSessionListWatcher(root, () => listChanges++, {
    debounceMs: 20,
    watchDirectory: (_root, callback) => { nativeEvent = callback; return fakeWatch(); },
  });
  t.after(() => monitor.close());
  const unsubscribe = subscribeSessionFile(file, () => contentChanges++);
  t.after(unsubscribe);
  for (let i = 0; i < 20; i++) nativeEvent('rename', 'cwd/selected.jsonl');
  await until(() => contentChanges === 1);
  assert.equal(listChanges, 0);
  nativeEvent('change', 'cwd/other.jsonl');
  await sleep(60);
  assert.equal(contentChanges, 1, 'unselected file writes do not refresh the view');
  nativeEvent('change', null);
  await until(() => contentChanges === 2);
  nativeEvent('rename', 'cwd');
  await until(() => contentChanges === 3);
  unsubscribe();
  nativeEvent('change', 'cwd/selected.jsonl');
  await sleep(60);
  assert.equal(contentChanges, 3, 'closed views no longer receive notifications');
  assert.equal(listChanges, 0);
});


test('repeated unsubscribe cannot remove a later subscription to the same file', async t => {
  const { subscribeSessionFile } = await jiti.import('./session-list-watch.ts');
  const root = await fixture(t);
  const file = join(root, 'cwd', 'selected.jsonl');
  const first = subscribeSessionFile(file, () => {});
  first();
  const second = subscribeSessionFile(file, () => {});
  t.after(second);
  first();
  assert.equal(globalThis.__piSessionFileSubscriptions.size, 1);
  second();
  assert.equal(globalThis.__piSessionFileSubscriptions.size, 0);
});
