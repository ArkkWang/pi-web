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
  const session = {
    sessionId: id, agent: { state: {} }, sessionManager: { getCwd: () => process.cwd() },
    isStreaming: false, isCompacting: false, isBashRunning: false,
    subscribe: (fn) => { listener = fn; return () => { unsubscriptions++; }; },
    getContextUsage: () => null, getSteeringMessages: () => [], getFollowUpMessages: () => [],
    bindExtensions: forbidden, dispose: forbidden, prompt: forbidden, abort: forbidden,
  };
  return { session, emit: (event) => listener(event), unsubscriptions: () => unsubscriptions };
}
test('global contract, owner state, compaction SSE, routed commands, safe release', async () => {
  assert.equal(globalThis[Symbol.for('@agegr/pi-web/external-sessions/v1')], bridge);
  assert.equal(bridge.version, 1);
  const f = fixture('external-contract');
  let running = true;
  const sent = []; let stopped = 0;
  const before = getSessionListVersion();
  const registration = bridge.register({ session: f.session, isRunning: () => running,
    send: (command) => sent.push(command), stop: () => { stopped++; } });
  const wrapper = getRpcSession(f.session.sessionId);
  try {
    assert.ok(getSessionListVersion() > before);
    assert.ok(getRunningRpcSessionIds().includes(f.session.sessionId));
    assert.equal((await wrapper.send({ type: 'get_state' })).isPromptRunning, true);
    const events = []; wrapper.onEvent((event) => events.push(event));
    f.session.isCompacting = true; f.emit({ type: 'compaction_start' });
    assert.equal((await wrapper.send({ type: 'get_state' })).isCompacting, true);
    assert.equal(events.at(-1).type, 'compaction_start');
    f.emit({ type: 'agent_settled' });
    assert.equal(events.at(-1).type, 'compaction_start'); // Owner still busy.

    await wrapper.send({ type: 'prompt', message: 'hello' });
    await wrapper.send({ type: 'steer', message: 'change' });
    assert.deepEqual(sent.map((x) => x.type), ['prompt', 'steer']);
    for (const type of ['abort', 'abort_compaction', 'abort_bash']) await wrapper.send({ type });
    assert.equal(stopped, 3);
    assert.equal(wrapper.isRunning(), true); // Stop acceptance is NOT completion.
    for (const type of ['set_model', 'set_tools', 'compact', 'navigate_tree', 'bash', 'fork', 'reload']) {
      await assert.rejects(wrapper.send({ type }), /managed by its owner/);
    }
    await assert.rejects(setRpcSessionTools(f.session.sessionId, undefined, []), /owned by its manager/);
    await assert.rejects(wrapper.shutdown(), /released by its owner/);
    wrapper.destroy();
    assert.equal(wrapper.isAlive(), true);
    assert.equal(wrapper.evictIfDiskAhead(), false);
    assert.throws(() => bridge.register({ session: f.session, isRunning: () => false }), /already registered/);
    running = false; f.session.isCompacting = false;
    assert.equal(wrapper.isRunning(), false);
    assert.equal(wrapper.idleTimer, null);
  } finally { registration.release(); registration.release(); }
  assert.equal(f.unsubscriptions(), 1);
  assert.equal(getRpcSession(f.session.sessionId), undefined);
});
test('missing callbacks reject rather than invoking SDK; registration failure is visible', async () => {
  const f = fixture('external-observe');
  const registration = bridge.register({ session: f.session, isRunning: () => false });
  try {
    const wrapper = getRpcSession(f.session.sessionId);
    await assert.rejects(wrapper.send({ type: 'prompt', message: 'no' }), /does not support/);
    await assert.rejects(wrapper.send({ type: 'abort' }), /does not support/);
  } finally { registration.release(); }
  const broken = fixture('external-broken'); broken.session.subscribe = () => { throw new Error('subscribe failed'); };
  assert.throws(() => bridge.register({ session: broken.session, isRunning: () => false }), /subscribe failed/);
  assert.equal(getRpcSession('external-broken'), undefined);
});
test('registration, first file persistence and release advance existing sidebar cache version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-bridge-'));
  const f = fixture('external-discovery'); f.session.sessionFile = join(dir, 'child.jsonl');
  const registration = bridge.register({ session: f.session, isRunning: () => true });
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
