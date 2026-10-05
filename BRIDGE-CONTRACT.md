# External sessions bridge v1 (experimental, fork release v0.10.0-home.1)

Same-process only: `globalThis[Symbol.for('@agegr/pi-web/external-sessions/v1')]` is installed when rpc-manager loads, before Web starts loading plugins. Feature-detect it; outside Pi Web it may be absent. This replaces the unpublished callback contract; no compatibility layer is provided.

```ts
interface BridgeV1 {
  version: 1;
  register(options: {
    session: AgentSession; // existing SDK instance; stable sessionId while registered
  }): { release(): Promise<void> };
}
```

Web and the registering plugin wrap the **same SDK instance**. There are no owner `isRunning`, `send` or `stop` callbacks, SDK proxies/monkeypatches, or stage-reporting protocol. UI prompt/steer/follow_up, abort/abort_compaction/abort_bash, compact and model controls use Web's normal SDK command paths. UI operations do **not** pass through the plugin's dispatch-tool concurrency limits or foreground notification policy; the plugin must observe SDK events if it needs to account for these operations. Web's normal completion behavior remains in place.

Registration is synchronous, rejects duplicate ids / Web starts in progress, subscribes immediately and reuses Web registry/SSE/history/state. It does not bind extensions, load MCP, arm idle eviction, or dispose the SDK. Existing SDK extensions remain the registrant's responsibility; their UI context is not rebound. To protect owner-managed files/loadouts, Web rejects tools/reload, rename/auto-name/delete (including cascade), fork/clone and branch navigation while registered. `shutdown()` refuses and generic `destroy()` does not detach. Standalone UI `bash` / SDK `executeBash` is unsupported while registered: SDK idle/waitForIdle/abort does not cover that shell lifecycle. Agent tool calls to bash are unaffected; this bridge does not add a separate shell lifecycle protocol.

Running state comes from SDK streaming/compacting/bash flags and Web's own pending prompts. SDK events, including `agent_settled` and compaction events, are forwarded without consulting manager activity. Existing sidebar snapshots and state reconciliation recover missed events; no new polling is added. **This does not solve the SDK preparation boundary**: work started outside Web before SDK activity flags/events, and manager-only preparation/final bookkeeping, may appear idle. Web's pending count covers only prompts submitted through Web. Stop has native SDK cancellation limitations during preparation; it does not cancel the manager's queue or promise completion.

Register before beginning a run. Keep registered across idle periods while the plugin owns the session. `release()` is idempotent and returns a Promise. It immediately refuses new Web execution commands, then drains Web-admitted pending prompts and mutating commands before unsubscribing/removing this registration and closing its SSE. Reads, explicit cancellation commands and extension UI responses remain available; the wrapper stays alive in the registry throughout drain so Web cannot reopen a second instance. There is no timer or deadline: a stuck operation can keep release pending. **Release is not cancellation** and NEVER stops/disposes the SDK object; accepted preflight may continue into model execution. The owner must stop admitting its own work, finish/stop externally started work, and `await release()` before disposing. Web cannot drain external preparation it does not know about. After release Web may reopen the persisted session normally: do not release while external ownership remains.

Persist registered sessions in the normal pi session directory for sidebar/history discovery. Register/release advance the existing list version; the first message event after persistence advances it once again. No force-refresh userscript is required. No remote transport, profile integration, or guarantee of manager-level notification timing is provided. Cross-repository adapter and browser validation are separate from the fork's unit checks.
