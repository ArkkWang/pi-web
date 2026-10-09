import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url, { alias: { '@': process.cwd() }, moduleCache: false });
const { GET: events } = await jiti.import('../app/api/agent/[id]/events/route.ts');
const { GET: readSession } = await jiti.import('../app/api/sessions/[id]/route.ts');
const { getRpcSession, startRpcSession } = await jiti.import('./rpc-manager.ts');
const { getSessionListVersion } = await jiti.import('./session-reader.ts');
const sdk = pathToFileURL(join(process.cwd(), 'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href;

test('real observation route follows an independent SDK writer without creating a local instance', { timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-file-follow-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const abort = new AbortController();
  let reader;
  let runtime;
  const write = source => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import { SessionManager } from ${JSON.stringify(sdk)}; ${source}`], { encoding: 'utf8', env: process.env });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    const { id, file } = JSON.parse(write(`const sm = SessionManager.create(${JSON.stringify(dir)}); sm.appendMessage({role:'user',content:'first',timestamp:Date.now()}); console.log(JSON.stringify({id:sm.getSessionId(),file:sm.getSessionFile()}));`));
    const params = { params: Promise.resolve({ id }) };
    const snapshot = async () => (await readSession(new Request(`http://test/api/sessions/${id}`), params)).json();
    assert.equal((await snapshot()).context.messages.length, 1);
    const response = await events(new Request(`http://test/api/agent/${id}/events?observe=1`, { signal: abort.signal }), params);
    assert.equal(response.status, 200);
    reader = response.body.getReader();
    let buffer = '';
    const nextEvent = async type => {
      const deadline = AbortSignal.timeout(5000);
      while (true) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (!block.startsWith('data: ')) continue;
          const event = JSON.parse(block.slice(6));
          if (event.type === type) return event;
          continue;
        }
        const result = await Promise.race([
          reader.read(),
          new Promise((_, reject) => deadline.addEventListener('abort', () => reject(new Error('SSE notification timeout')), { once: true })),
        ]);
        assert.equal(result.done, false);
        buffer += new TextDecoder().decode(result.value);
      }
    };
    assert.equal((await nextEvent('connected')).fileWatching, true);
    await nextEvent('session_file_changed');
    assert.equal(getRpcSession(id), undefined, 'opening the observer must not start AgentSession');
    const version = getSessionListVersion();
    write(`SessionManager.open(${JSON.stringify(file)}).appendMessage({role:'user',content:'second',timestamp:Date.now()});`);
    await nextEvent('session_file_changed');
    const updated = await snapshot();
    assert.equal(updated.context.messages.length, 2);
    assert.equal(getRpcSession(id), undefined);
    assert.equal(getSessionListVersion(), version, 'content changes do not invalidate the catalogue');
    // An explicit local start switches the existing browser transport, without
    // a second connection or an external-process ownership claim. No model call.
    runtime = (await startRpcSession(id, file, undefined, { toolNames: [] })).session;
    const connected = await nextEvent('connected');
    assert.equal(connected.fileWatching, false);
    assert.ok(getRpcSession(id) === runtime);
    assert.equal(globalThis.__piSessionFileSubscriptions?.size, 0);
    abort.abort();
    await reader.cancel();
    assert.equal(globalThis.__piSessionFileSubscriptions?.size, 0);
  } finally {
    abort.abort();
    await reader?.cancel();
    runtime?.destroy();
    globalThis.__piSessionListWatcher?.close();
    globalThis.__piSessionListWatcher = undefined;
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
