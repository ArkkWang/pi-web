import { statSync, watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";

type WatchOptions = {
  debounceMs?: number;
  retryMs?: number;
  fallbackMs?: number;
  watchDirectory?: (root: string, listener: (event: string, filename: string | Buffer | null) => void) => FSWatcher;
  warn?: (error: unknown) => void;
};

/** Discover session files only. Never read transcripts or observe message appends. */
export function createSessionListWatcher(root: string, invalidate: () => void, options: WatchOptions = {}) {
  const debounceMs = options.debounceMs ?? 250;
  const fallbackMs = options.fallbackMs ?? 30_000;
  const watchDirectory = options.watchDirectory ?? ((path, listener) =>
    watch(path, { recursive: true, persistent: false }, listener));
  let watcher: FSWatcher | undefined;
  let identity: string | undefined;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let warned = false;
  let lastFallback = Date.now();

  const changed = () => {
    // Coalesce a creation burst without indefinitely postponing discovery.
    if (stopped || pending) return;
    pending = setTimeout(() => {
      pending = undefined;
      invalidate();
    }, debounceMs);
    pending.unref?.();
  };
  const detach = () => {
    const old = watcher;
    watcher = undefined;
    identity = undefined;
    old?.close();
  };
  const failed = (error: unknown) => {
    detach();
    if (!warned && (error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      warned = true;
      if (options.warn) options.warn(error);
      else console.warn("[pi-web] session directory watch unavailable; retrying with periodic list invalidation", error);
    }
  };
  const attach = () => {
    if (stopped) return;
    try {
      const stats = statSync(root);
      if (!stats.isDirectory()) throw new Error("Session path is not a directory");
      const nextIdentity = `${stats.dev}:${stats.ino}`;
      if (watcher && identity === nextIdentity) return;
      detach();
      const next = watchDirectory(root, (event, filename) => {
        // fs.watch reports create/delete/rename as "rename". Existing message
        // appends are "change" and must not keep invalidating catalogue scans.
        if (event !== "rename") return;
        if (filename == null) { changed(); return; }
        // Match the SDK catalogue: sessions/<cwd>/*.jsonl, not arbitrary depths.
        const parts = filename.toString().replaceAll("\\", "/").split("/");
        if (parts.length === 1 || (parts.length === 2 && parts[1].endsWith(".jsonl"))) changed();
      });
      watcher = next;
      identity = nextIdentity;
      next.on("error", (error) => { if (watcher === next) failed(error); });
      next.on("close", () => { if (watcher === next) { watcher = undefined; identity = undefined; } });
      warned = false;
      return true;
    } catch (error) {
      failed(error);
      return false;
    }
  };

  attach();
  // Retry absent/replaced roots and failed watchers without creating directories.
  // Degraded mode still makes the existing client poll rescan at most every 30s.
  const timer = setInterval(() => {
    if (attach()) changed(); // A recovered watch may have missed changes.
    if (!watcher && Date.now() - lastFallback >= fallbackMs) {
      lastFallback = Date.now();
      changed();
    }
  }, options.retryMs ?? 5_000);
  timer.unref?.();
  return {
    kind: "session-discovery" as const,
    root,
    close() {
      stopped = true;
      clearInterval(timer);
      if (pending) clearTimeout(pending);
      detach();
    },
  };
}

declare global {
  var __piSessionListWatcher: ReturnType<typeof createSessionListWatcher> | undefined;
}

/** One watcher per process, shared across route bundles and development reloads. */
export function ensureSessionListWatcher(root: string, invalidate: () => void): void {
  root = resolve(root);
  if (globalThis.__piSessionListWatcher?.root === root
    && globalThis.__piSessionListWatcher.kind === "session-discovery") return;
  globalThis.__piSessionListWatcher?.close();
  globalThis.__piSessionListWatcher = createSessionListWatcher(root, invalidate);
}
