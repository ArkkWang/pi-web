import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { createSessionFileObserver } = await jiti.import('./session-file-events.ts');
const { createSessionFileRefresh } = await jiti.import('./session-file-refresh.ts');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('file browsing subscribes without starting a runtime, then attaches before its first event', () => {
  let fileChanged, registered, runtimeEvent;
  let fileClosed = 0, registrationClosed = 0, runtimeClosed = 0;
  const observer = createSessionFileObserver({
    subscribeFile: callback => { fileChanged = callback; return () => fileClosed++; },
    subscribeRuntime: callback => { registered = callback; return () => registrationClosed++; },
  });
  const events = [];
  const stop = observer.onEvent(event => events.push(event));
  assert.equal(observer.fileWatching, true);
  assert.equal(observer.isStreaming, false);
  assert.deepEqual(events.map(e => e.type), ['session_file_changed']);
  fileChanged();
  assert.equal(events.length, 2);
  registered({
    isStreaming: false,
    onEvent(callback) {
      runtimeEvent = callback;
      callback({ type: 'extension_ui_request', id: 'dialog' });
      return () => runtimeClosed++;
    },
  });
  assert.equal(observer.fileWatching, false);
  assert.equal(fileClosed, 1);
  assert.deepEqual(events[2], { type: 'connected', fileWatching: false, isStreaming: false, pendingExtensionUiIds: ['dialog'] });
  runtimeEvent({ type: 'agent_start' });
  assert.equal(events.at(-1).type, 'agent_start');
  const before = events.length;
  fileChanged();
  assert.equal(events.length, before, 'runtime-owned files no longer produce refreshes');
  stop();
  assert.equal(registrationClosed, 1);
  assert.equal(runtimeClosed, 1);
});

test('refresh coalesces notifications, serializes IO, and retains a change arriving during IO', async () => {
  let calls = 0;
  let complete;
  const queue = createSessionFileRefresh({
    enabled: () => true,
    delayMs: 5,
    refresh: async () => { calls++; await new Promise(resolve => { complete = resolve; }); return true; },
  });
  try {
    for (let i = 0; i < 20; i++) queue.invalidate();
    await sleep(30);
    assert.equal(calls, 1);
    queue.invalidate();
    await sleep(30);
    assert.equal(calls, 1);
    complete();
    await sleep(30);
    assert.equal(calls, 2);
    queue.dispose();
    complete();
    await sleep(30);
    assert.equal(calls, 2);
  } finally { queue.dispose(); }
});

test('hidden views do not read; failures retry; disposal cancels retries', async () => {
  let visible = false, calls = 0;
  const queue = createSessionFileRefresh({
    enabled: () => visible,
    delayMs: 5,
    retryMs: 10,
    refresh: async () => { calls++; return calls > 1; },
  });
  try {
    queue.invalidate();
    await sleep(30);
    assert.equal(calls, 0);
    visible = true;
    queue.invalidate();
    await sleep(60);
    assert.equal(calls, 2);
    queue.invalidate();
    queue.dispose();
    await sleep(30);
    assert.equal(calls, 2);
  } finally { queue.dispose(); }
});
