# External sessions bridge v1 (stable contract)

Same-process only: `globalThis[Symbol.for('@agegr/pi-web/external-sessions/v1')]` is installed when rpc-manager loads, before Web starts loading plugins. Feature-detect it; outside Pi Web it may be absent.

```ts
interface BridgeV1 {
  version: 1;
  register(options: {
    session: AgentSession; // existing SDK session; stable sessionId for registration lifetime
    isRunning: () => boolean; // manager-owned logical run, including preparation/gaps
    send?: (command: {
      type: 'prompt' | 'steer' | 'follow_up';
      message: string;
      images?: Array<{ type: 'image'; data: string; mimeType: string }>;
      streamingBehavior?: 'steer' | 'followUp';
    }) => Promise<unknown> | unknown;
    stop?: () => Promise<unknown> | unknown;
  }): { release(): void };
}
```

`send` must validate/admit through the external manager; resolve after acceptance (not necessarily completion), reject if not accepted. Preserve images or explicitly reject them; never silently drop content. `stop` is used for abort, abort_compaction and abort_bash and must stop through the manager. Callbacks are optional: missing callback means rejection, never a fallback to SDK commands.

Registration is synchronous, rejects duplicate ids / Web starts in progress, subscribes immediately and reuses Web registry/SSE/history/state. No bindExtensions, MCP loading, idle eviction, SDK disposal or SDK abort. Read-only Web queries are allowed; all other mutations (model/tools/branch/compact/bash/etc.) are rejected.

Register before beginning a run. Keep registered across idle periods while the manager owns the session. `isRunning` must be safe, synchronous and accurate; SDK streaming/compacting flags are additionally observed. UI polling reconciles manager-only state transitions. SDK compaction events retain their existing names.

`release()` is synchronous/idempotent: unsubscribe/remove only this registration and close its SSE; NEVER stop/dispose the SDK object. Owner must finish/stop outstanding work before release and dispose itself afterward. After release Web may reopen the persisted session as an ordinary session: do not release while external ownership remains. Registered sessions should be persisted in the normal pi session directory for sidebar/history discovery.

No remote transport, profile integration, extension UI rebinding, or guarantee of notification timing across manager-only transitions in v1.

Web lifecycle requests cannot relinquish external ownership: `shutdown()` refuses, generic `destroy()` does not detach. Session deletion (including cascade), rename and auto-name refuse while registered. Only owner `release()` detaches. Registration and release advance the existing sidebar list version; first message event after persistence advances it once again, so newly saved children are discovered without a force-refresh userscript.
