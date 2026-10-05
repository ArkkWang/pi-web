// Isolated real home-scripts extension + SDK + Web browser test. Never uses real agent configuration.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, createWriteStream, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
assert(!existsSync(join(root, '.next/dev/lock')), 'An existing dev lock must not be disturbed');
const extension = resolve(process.env.HOME_SCRIPTS_SUBAGENT || join(root, '../home-scripts/home-scripts/pi/custom-tools/subagent/index.js'));
assert(existsSync(extension), extension);
const artifacts = join(root, 'test-results/external-sessions'); mkdirSync(artifacts, { recursive: true });
const log = text => { console.log(text); appendFileSync(join(artifacts, 'result.log'), text + '\n'); };
writeFileSync(join(artifacts, 'result.log'), '');
const dir = mkdtempSync(join(tmpdir(), 'pi-external-e2e-')); const cwd = join(dir, 'project'); mkdirSync(cwd);
let server, browser, page; const pending = []; let requests = 0; let holdCompaction = false;
const serverLog = createWriteStream(join(artifacts, 'server.log'));
function reply(res, content, tool) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'e2e', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
  chunk({ role: 'assistant', ...(tool ? { tool_calls: [{ index: 0, id: 'start-child', type: 'function', function: { name: 'subagent_start', arguments: JSON.stringify({ task: 'EXTERNAL_CHILD_HOLD', name: 'External browser child', notify: false }) } }] } : { content }) });
  chunk({}, tool ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n');
}
const mock = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  try {
    const body = JSON.parse(raw); requests++;
    appendFileSync(join(artifacts, 'model.log'), JSON.stringify(body) + '\n');
    const last = body.messages.at(-1); const text = JSON.stringify(last?.content);
    if (holdCompaction || last?.role === 'user' && /EXTERNAL_CHILD_HOLD|SECOND_HOLD/.test(text)) { pending.push(res); return; }
    reply(res, 'E2E model completed', last?.role === 'user' && text.includes('START_EXTERNAL_CHILD'));
  } catch (e) { res.writeHead(500); res.end(String(e)); }
});
async function until(fn, label, timeout = 60000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn()) return; await delay(200); } throw Error('Timeout: ' + label); }
try {
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  writeFileSync(join(dir, 'models.json'), JSON.stringify({ providers: { 'external-e2e': { baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, api: 'openai-completions', apiKey: 'isolated-fake-key', models: [{ id: 'mock', name: 'E2E mock', reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ defaultProvider: 'external-e2e', defaultModel: 'mock', extensions: [extension], compaction: { enabled: false, keepRecentTokens: 32 }, retry: { enabled: false }, cacheWarming: 'off' }));
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = probe.address().port; await new Promise(r => probe.close(r));
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [join(root, 'node_modules/next/dist/bin/next'), 'dev', '-H', '127.0.0.1', '-p', String(port)], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: dir, PI_WEB_PASSWORD: '', NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'development' }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.pipe(serverLog, { end: false }); server.stderr.pipe(serverLog, { end: false });
  log(`Isolated dev PID=${server.pid} port=${port}; mock port=${mock.address().port}`);
  async function api(path, body) { const r = await fetch(base + path, { ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) }); const data = await r.json(); assert(r.ok, JSON.stringify(data)); return data; }
  await until(async () => { try { return (await fetch(base + '/api/sessions')).ok; } catch { return false; } }, 'dev readiness', 120000);
  const parent = await api('/api/agent/new', { type: 'prompt', cwd, message: 'SEED_PARENT', provider: 'external-e2e', modelId: 'mock' });
  log('Parent ' + parent.sessionId);
  await until(async () => !(await api('/api/agent/running')).runningSessionIds?.includes(parent.sessionId), 'parent seed');
  browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM_PATH }); page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' }); page.setDefaultTimeout(45000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/?session=' + parent.sessionId, { waitUntil: 'domcontentloaded' });
  await page.getByText('E2E model completed', { exact: true }).last().waitFor();
  let navigations = 0; page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
  await api('/api/agent/' + parent.sessionId, { type: 'prompt', message: 'START_EXTERNAL_CHILD' });
  await until(() => pending.length === 1, 'real child model request');
  const row = page.getByText('External browser child', { exact: true });
  await row.waitFor(); assert.equal(navigations, 0, 'child discovery must not reload or navigate');
  log('PASS: real home-scripts child appears in sidebar without refresh');
  const sessions = await api('/api/sessions'); const child = sessions.sessions.find(s => s.name === 'External browser child'); assert(child);
  writeFileSync(join(artifacts, 'child-running.json'), JSON.stringify(await api('/api/sessions/' + child.id + '/state'), null, 2));
  await row.click();
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor();
  log('PASS: selecting active external child shows Stop agent');
  await api('/api/agent/' + child.id, { type: 'follow_up', message: 'UI_FOLLOWUP' });
  assert.equal((await api('/api/sessions/' + child.id + '/state')).state.pendingMessageCount, 1);
  log('PASS: WebUI follow-up is accepted directly by SDK');
  reply(pending.shift(), 'EXTERNAL_CHILD_FINISHED');
  await page.getByText('EXTERNAL_CHILD_FINISHED', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'hidden' });
  log('PASS: external child completion updates transcript and returns composer to idle');
  await page.locator('textarea').last().fill('SECOND_HOLD');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await until(() => pending.length === 1, 'resumed child model request');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'hidden' });
  log('PASS: idle child resumes directly through SDK; browser Stop returns to idle');
  for (const response of pending.splice(0)) response.destroy();
  // Keep a genuine older turn beyond keepRecentTokens; an aborted tiny session
  // is legitimately refused by SDK compaction and cannot verify the UI state.
  await api('/api/agent/' + child.id, { type: 'prompt', message: 'Compaction fixture history: ' + 'context-details '.repeat(256) });
  await until(async () => !(await api('/api/agent/running')).runningSessionIds.includes(child.id), 'context preparation');
  await api('/api/agent/' + child.id, { type: 'prompt', message: 'Keep a recent checkpoint.' });
  await until(async () => !(await api('/api/agent/running')).runningSessionIds.includes(child.id), 'context checkpoint');
  holdCompaction = true;
  const compacting = api('/api/agent/' + child.id, { type: 'compact' });
  // Observe rejection immediately if SDK refuses before reaching the model.
  await Promise.race([until(() => pending.length === 1, 'compaction model request'), compacting.then(() => { throw Error('Compaction ended before observation'); })]);
  assert.equal((await api('/api/sessions/' + child.id + '/state')).state.isCompacting, true);
  await page.getByRole('button', { name: 'Stop compaction', exact: true }).waitFor();
  holdCompaction = false;
  reply(pending.shift(), 'E2E compacted context summary.');
  await compacting;
  await page.getByRole('button', { name: 'Stop compaction', exact: true }).waitFor({ state: 'hidden' });
  assert.equal((await api('/api/sessions/' + child.id + '/state')).state.isCompacting, false);
  log('PASS: live SDK compaction shows and clears the composer compaction state');
  assert.deepEqual(errors, [], 'browser runtime errors'); log('PASS: no browser runtime errors; mock requests=' + requests);
} catch (e) {
  log(e.stack || String(e)); process.exitCode = 1;
  if (page) writeFileSync(join(artifacts, 'failure-dom.txt'), await page.locator('body').innerText().catch(() => 'Unavailable'));
} finally {
  await browser?.close().catch(() => {});
  for (const res of pending) res.destroy(); mock.closeAllConnections(); await new Promise(r => mock.close(r));
  if (server && server.exitCode === null) {
    // Next dev spawns a worker; terminate only our tree on Windows, never the production PID.
    if (process.platform === 'win32') { const kill = spawn('taskkill', ['/PID', String(server.pid), '/T', '/F']); await once(kill, 'exit'); }
    else { server.kill('SIGTERM'); await once(server, 'exit'); }
  }
  serverLog.end(); rmSync(dir, { recursive: true, force: true }); log('CLEANUP: isolated browser, mock, dev tree and temporary agent directory removed');
}
