import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const source = readFileSync(new URL('./useAgentSession.ts', import.meta.url), 'utf8');
test('owner snapshots reconcile externally started idle sessions and final bookkeeping', () => {
  const reconcile = source.slice(source.indexOf('const reconcileAgentState ='), source.indexOf('// Recovery net for missed SSE'));
  assert.doesNotMatch(reconcile, /if \(!agentRunningRef.current \|\|/);
  assert.match(reconcile, /if \(busy\)[\s\S]*setAgentRunning\(true\)/);
  assert.match(source, /if \(!agentRunning && !opts.sessionRunning\) return/);
  assert.match(source, /opts.sessionRunning !== undefined\) void reconcileAgentState\(sid\)/);
  assert.match(source, /\[opts.sessionRunning, reconcileAgentState\]/);
});
