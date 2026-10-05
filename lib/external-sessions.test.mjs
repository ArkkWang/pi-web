import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { externalSessionsBridge: bridge, getRpcSession, getRunningRpcSessionIds, setRpcSessionTools } = await jiti.import('./rpc-manager.ts');
const { getSessionListVersion } = await jiti.import('./session-reader.ts');
function fixture(id) {
  let listener;
  let unsubscriptions = 0;
  const forbidden = () => { throw new Error('SDK ownership violated'); };
  const calls = [];
  const session = {
    sessionId: id, agent: { state: {} }, sessionManager: { getCwd: () => process.cwd() },
    isStreaming: false, isCompacting: false, isBashRunning: false,
    subscribe: (fn) => { listener = fn; return () => { unsubscriptions++; }; },
    getContextUsage: () => null, getSteeringMessages: () => [], getFollowUpMessages: () => [],
    bindExtensions: forbidden, dispose: forbidden, executeBash: forbidden,
    prompt: async (...args) => { calls.push(['prompt', ...args]); args[1].preflightResult(); },
    steer: async (...args) => { calls.push(['steer', ...args]); },
    followUp: async (...args) => { calls.push(['follow_up', ...args]); },
    abort: async () => { calls.push(['abort']); },
    abortCompaction: () => { calls.push(['abort_compaction']); },
    abortBash: () => { calls.push(['abort_bash']); },
    compact: async (...args) => { calls.push(['compact', ...args]); return { summary: 'compressed' }; },
  };
  return { session, calls, emit: (event) => listener(event), unsubscriptions: () => unsubscriptions };
}
test('callback-free registration uses SDK state, commands and safe release', async () => {
  assert.equal(globalThis[Symbol.for('@agegr/pi-web/external-sessions/v1')], bridge);
  assert.equal(bridge.version, 1);
  const f = fixture('external-contract');
  const before = getSessionListVersion();
  const registration = bridge.register({ session: f.session });
  const wrapper = getRpcSession(f.session.sessionId);
  const events = []; wrapper.onEvent((event) => events.push(event));
  try {
    assert.ok(getSessionListVersion() > before);
    assert.equal(wrapper.isRunning(), false);
    f.session.isStreaming = true; f.emit({ type: 'agent_start' });
    assert.ok(getRunningRpcSessionIds().includes(f.session.sessionId));
    assert.equal((await wrapper.send({ type: 'get_state' })).isStreaming, true);
    assert.equal((await wrapper.send({ type: 'get_state' })).isPromptRunning, false);
    f.session.isStreaming = false;
    f.session.isCompacting = true; f.emit({ type: 'compaction_start' });
    assert.equal((await wrapper.send({ type: 'get_state' })).isCompacting, true);
    assert.equal(events.at(-1).type, 'compaction_start');
    f.emit({ type: 'agent_settled' });
    assert.equal(events.at(-1).type, 'agent_settled'); // Never suppressed by manager activity.
    f.session.isCompacting = false; f.emit({ type: 'compaction_end' });

    const images = [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }];
    await wrapper.send({ type: 'prompt', message: 'hello', images });
    await wrapper.send({ type: 'steer', message: 'change' });
    await wrapper.send({ type: 'follow_up', message: 'next' });
    for (const type of ['abort', 'abort_compaction', 'abort_bash']) await wrapper.send({ type });
    assert.deepEqual(await wrapper.send({ type: 'compact', customInstructions: 'short' }), { summary: 'compressed' });
    assert.deepEqual(f.calls.map((x) => x[0]), ['prompt', 'steer', 'follow_up', 'abort', 'abort_compaction', 'abort_bash', 'compact']);
    assert.equal(f.calls[0][1], 'hello');
    assert.deepEqual(f.calls[0][2].images, images);
    assert.equal(f.calls.at(-1)[1], 'short');
    for (const type of ['set_tools', 'set_session_name', 'navigate_tree', 'fork', 'reload', 'bash']) {
      await assert.rejects(wrapper.send({ type }), /ownership prevents/);
    }
    await assert.rejects(setRpcSessionTools(f.session.sessionId, undefined, []), /owned by its manager/);
    await assert.rejects(wrapper.shutdown(), /released by its owner/);
    wrapper.destroy();
    assert.equal(wrapper.isAlive(), true);
    assert.equal(wrapper.evictIfDiskAhead(), false);
    assert.throws(() => bridge.register({ session: f.session }), /already registered/);
    assert.equal(wrapper.isRunning(), false);
    assert.equal(wrapper.idleTimer, null);
  } finally { registration.release(); registration.release(); }
  assert.equal(events.at(-1).type, 'session_shutdown');
  assert.equal(f.unsubscriptions(), 1);
  assert.equal(getRpcSession(f.session.sessionId), undefined);
  await assert.rejects(wrapper.send({ type: 'prompt', message: 'closed' }), /closed/);
});
test('Web pending prompt tracks SDK preparation without manager callbacks', async () => {
  const f = fixture('external-preparation');
  let finish;
  f.session.prompt = async (_message, options) => {
    options.preflightResult();
    await new Promise((resolve) => { finish = resolve; });
  };
  const registration = bridge.register({ session: f.session });
  const wrapper = getRpcSession(f.session.sessionId);
  try {
    await wrapper.send({ type: 'prompt', message: 'wait' });
    assert.equal(wrapper.isRunning(), true);
    assert.equal((await wrapper.send({ type: 'get_state' })).isPromptRunning, true);
    finish(); await new Promise((resolve) => setImmediate(resolve));
    assert.equal(wrapper.isRunning(), false);
  } finally { registration.release(); }
});
test('registration failure is visible', () => {
  assert.throws(() => bridge.register({}), /session is required/);
  const broken = fixture('external-broken'); broken.session.subscribe = () => { throw new Error('subscribe failed'); };
  assert.throws(() => bridge.register({ session: broken.session }), /subscribe failed/);
  assert.equal(getRpcSession('external-broken'), undefined);
});
test('registration, first file persistence and release advance existing sidebar cache version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-bridge-'));
  const f = fixture('external-discovery'); f.session.sessionFile = join(dir, 'child.jsonl');
  const registration = bridge.register({ session: f.session });
  try {
    const registered = getSessionListVersion();
    f.emit({ type: 'message_end' });
    assert.equal(getSessionListVersion(), registered);
    writeFileSync(f.session.sessionFile, '{}\n');
    f.emit({ type: 'message_end' });
    assert.equal(getSessionListVersion(), registered + 1);
    f.emit({ type: 'message_end' });
    assert.equal(getSessionListVersion(), registered + 1);
    registration.release();
    assert.equal(getSessionListVersion(), registered + 2);
  } finally { registration.release(); rmSync(dir, { recursive: true, force: true }); }
});

test('release drains a Web prompt blocked before SDK preflight and keeps registry ownership', async () => {
  const f = fixture('external-release-preflight');
  let accept, finish, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const preflight = new Promise((resolve) => { accept = resolve; });
  const completion = new Promise((resolve) => { finish = resolve; });
  f.session.prompt = async (_message, options) => {
    entered();
    await preflight;
    options.preflightResult();
    await completion;
  };
  const registration = bridge.register({ session: f.session });
  const wrapper = getRpcSession(f.session.sessionId);
  const sending = wrapper.send({ type: 'prompt', message: 'wait' });
  await started;
  assert.equal(f.session.isStreaming, false); // SDK still appears idle.
  let released = false;
  const release = registration.release();
  assert.equal(registration.release(), release);
  void release.then(() => { released = true; });
  await Promise.resolve();
  assert.equal(released, false);
  assert.equal(getRpcSession(f.session.sessionId), wrapper);
  assert.equal(wrapper.isAlive(), true);
  assert.throws(() => bridge.register({ session: f.session }), /already registered/);
  await assert.rejects(wrapper.send({ type: 'prompt', message: 'new' }), /releasing/);
  await assert.rejects(wrapper.send({ type: 'compact' }), /releasing/);
  assert.equal((await wrapper.send({ type: 'get_state' })).isPromptRunning, true);
  accept();
  await sending; // Admission is not completion: pendingPromptCount still owns it.
  assert.equal(released, false);
  assert.equal(getRpcSession(f.session.sessionId), wrapper);
  assert.equal(f.calls.length, 0, 'release does not cancel by itself');
  await wrapper.send({ type: 'abort' });
  assert.deepEqual(f.calls, [['abort']], 'explicit Stop remains available while release drains');
  finish();
  await release;
  assert.equal(getRpcSession(f.session.sessionId), undefined);
  assert.equal(f.unsubscriptions(), 1);
  assert.deepEqual(f.calls, [['abort']]); // Only the explicit UI stop invoked abort.
});

test('release drains mutating SDK commands even when they reject', async () => {
  const f = fixture('external-release-compact');
  let fail, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  f.session.compact = () => { entered(); return new Promise((_resolve, reject) => { fail = reject; }); };
  const registration = bridge.register({ session: f.session });
  const wrapper = getRpcSession(f.session.sessionId);
  const compact = wrapper.send({ type: 'compact' });
  const rejected = assert.rejects(compact, /compact failed/);
  await started;
  let released = false;
  const release = registration.release().then(() => { released = true; });
  await Promise.resolve();
  assert.equal(released, false);
  assert.equal(getRpcSession(f.session.sessionId), wrapper);
  fail(new Error('compact failed'));
  await rejected;
  await release;
  assert.equal(getRpcSession(f.session.sessionId), undefined);
});
