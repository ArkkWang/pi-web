import { createAgentEventStream } from "@/lib/agent-event-stream";
import { getAgentDir, invalidateSessionListCache, invalidateSessionManagerCache, resolveSessionPath } from "@/lib/session-reader";
import { getRpcSession, onRpcSessionRegistered, startRpcSession } from "@/lib/rpc-manager";
import { createSessionFileObserver } from "@/lib/session-file-events";
import { ensureSessionListWatcher, subscribeSessionFile } from "@/lib/session-list-watch";
import { join } from "node:path";

export const dynamic = "force-dynamic";

// GET /api/agent/[id]/events - SSE stream of agent events
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (req.signal.aborted) return new Response(null, { status: 204 });

  // Fast path: already-running session
  const session = getRpcSession(id);
  let sessionPromise;
  if (session?.isAlive()) {
    sessionPromise = Promise.resolve(session);
  } else {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return new Response("Session not found", { status: 404 });
    }
    if (req.signal.aborted) return new Response(null, { status: 204 });
    if (new URL(req.url).searchParams.get("observe") === "1") {
      ensureSessionListWatcher(join(getAgentDir(), "sessions"), invalidateSessionListCache);
      sessionPromise = Promise.resolve(createSessionFileObserver({
        subscribeFile: (listener) => subscribeSessionFile(filePath, () => {
          invalidateSessionManagerCache(filePath);
          listener();
        }),
        subscribeRuntime: (listener) => onRpcSessionRegistered(id, listener),
      }));
    } else {
      sessionPromise = startRpcSession(id, filePath, undefined).then((result) => result.session);
    }
  }

  const stream = createAgentEventStream(req, id, sessionPromise);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
