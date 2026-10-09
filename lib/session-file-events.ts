import type { AgentEventStreamSession } from "./agent-event-stream";
import type { AgentEventLike } from "./agent-event-wire";

/** A file observer is not an AgentSession. Switch to runtime events only when
 * an explicit command (possibly from another tab) registers a local instance. */
export function createSessionFileObserver(options: {
  subscribeFile(listener: () => void): () => void;
  subscribeRuntime(listener: (session: AgentEventStreamSession) => void): () => void;
}): AgentEventStreamSession {
  let runtime: AgentEventStreamSession | undefined;
  return {
    get fileWatching() { return !runtime; },
    get isStreaming() { return runtime?.isStreaming ?? false; },
    get streamingMessage() { return runtime?.streamingMessage; },
    onEvent(listener) {
      let disposed = false;
      let stopRuntime: (() => void) | undefined;
      const stopFile = options.subscribeFile(() => {
        if (!disposed && !runtime) listener({ type: "session_file_changed" });
      });
      const stopRegistration = options.subscribeRuntime((session) => {
        if (disposed || runtime) return;
        runtime = session;
        stopFile();
        // Subscribe before announcing readiness, as the regular SSE path does.
        const buffered: AgentEventLike[] = [];
        let ready = false;
        stopRuntime = session.onEvent(event => {
          if (ready) listener(event);
          else buffered.push(event);
        });
        listener({
          type: "connected",
          fileWatching: false,
          isStreaming: session.isStreaming,
          pendingExtensionUiIds: buffered
            .filter(event => event.type === "extension_ui_request" && typeof event.id === "string")
            .map(event => event.id),
        });
        for (const event of buffered) listener(event);
        if (session.streamingMessage != null) listener({ type: "message_start", message: session.streamingMessage });
        ready = true;
      });
      // Reconnects also refresh: writes may have happened while disconnected.
      if (!runtime) listener({ type: "session_file_changed" });
      return () => {
        disposed = true;
        stopFile();
        stopRegistration();
        stopRuntime?.();
      };
    },
  };
}
