import { readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

type WatchOptions = {
  debounceMs?: number;
  retryMs?: number;
  fallbackMs?: number;
  watchDirectory?: (root: string, listener: (event: string, filename: string | Buffer | null) => void) => FSWatcher;
  readDirectory?: (path: string) => Promise<string[]>;
  warn?: (error: unknown) => void;
};

function missing(error: unknown): boolean {
  return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException)?.code ?? "");
}
function jsonlNames(names: string[]): Set<string> {
  return new Set(names.filter(name => name.endsWith(".jsonl")));
}
function sameNames(a: Set<string> | undefined, b: Set<string>): boolean {
  return (a?.size ?? 0) === b.size && [...b].every(name => a?.has(name));
}

/** Discover catalogue membership, never read transcript contents. */
export function createSessionListWatcher(root: string, invalidate: () => void, options: WatchOptions = {}) {
  const debounceMs = options.debounceMs ?? 250;
  const fallbackMs = options.fallbackMs ?? 30_000;
  const readDirectory = options.readDirectory ?? (path => readdir(path));
  const watchDirectory = options.watchDirectory ?? ((path, listener) =>
    watch(path, { recursive: true, persistent: false }, listener));
  let watcher: FSWatcher | undefined;
  let identity: string | undefined;
  let inventory = new Map<string, Set<string>>();
  const dirty = new Set<string>();
  let full = false;
  let force = false;
  let scanning = false;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let warned = false;
  let lastFallback = Date.now();

  const readNames = async (path: string) => {
    try { return await readDirectory(path); }
    catch (error) { if (missing(error)) return []; throw error; }
  };
  const schedule = () => {
    // Fixed window, not a trailing debounce: continuous writes cannot starve discovery.
    if (stopped || pending || scanning) return;
    pending = setTimeout(() => { pending = undefined; void reconcile(); }, debounceMs);
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
  const reconcile = async () => {
    scanning = true;
    const current = watcher;
    const checkAll = full;
    const mustInvalidate = force;
    const projects = [...dirty];
    full = force = false;
    dirty.clear();
    try {
      const next = checkAll ? new Map<string, Set<string>>() : new Map(inventory);
      for (const project of checkAll ? await readNames(root) : projects) {
        const names = jsonlNames(await readNames(join(root, project)));
        if (names.size) next.set(project, names);
        else next.delete(project);
      }
      // A closed/replaced watch owns a different baseline. Discard stale IO.
      if (stopped || watcher !== current) return;
      const changed = next.size !== inventory.size
        || [...next].some(([project, names]) => !sameNames(inventory.get(project), names));
      inventory = next;
      if (changed || mustInvalidate) invalidate();
    } catch (error) {
      if (!stopped && watcher === current) {
        // Never install a partial snapshot on permission/IO errors.
        failed(error);
        invalidate();
      }
    } finally {
      scanning = false;
      if (dirty.size || full || force) schedule();
    }
  };
  const changed = () => { force = true; full = true; schedule(); };
  const attach = () => {
    if (stopped) return;
    try {
      const stats = statSync(root);
      if (!stats.isDirectory()) throw new Error("Session path is not a directory");
      const nextIdentity = `${stats.dev}:${stats.ino}`;
      if (watcher && identity === nextIdentity) return;
      detach();
      const next = watchDirectory(root, (_event, filename) => {
        if (stopped || watcher !== next) return;
        // Neither "rename" nor "change" proves membership changed. In particular,
        // macOS recursive watches may report every append as "rename".
        if (filename == null) full = true;
        else {
          const parts = filename.toString().replaceAll("\\", "/").split("/");
          if (parts.some(part => !part || part === "." || part === "..")) full = true;
          else if (parts.length === 1 || (parts.length === 2 && parts[1].endsWith(".jsonl"))) dirty.add(parts[0]);
          else return;
        }
        schedule();
      });
      watcher = next;
      identity = nextIdentity;
      next.on("error", (error) => { if (watcher === next) failed(error); });
      next.on("close", () => { if (watcher === next) { watcher = undefined; identity = undefined; } });
      // Seed names only, once per attachment, before queued native events run.
      // This also means pre-existing sessions' first append is not a creation.
      const baseline = new Map<string, Set<string>>();
      for (const project of readdirSync(root, { withFileTypes: true })) {
        if (!project.isDirectory() && !project.isSymbolicLink()) continue;
        try {
          const names = jsonlNames(readdirSync(join(root, project.name)));
          if (names.size) baseline.set(project.name, names);
        } catch (error) { if (!missing(error)) throw error; }
      }
      inventory = baseline;
      warned = false;
      return true;
    } catch (error) {
      failed(error);
      return false;
    }
  };

  attach();
  // Retry absent/replaced roots and failed watchers without creating directories.
  const timer = setInterval(() => {
    if (attach()) changed(); // A recovered watch may have missed changes.
    if (!watcher && Date.now() - lastFallback >= fallbackMs) {
      lastFallback = Date.now();
      changed();
    }
  }, options.retryMs ?? 5_000);
  timer.unref?.();
  return {
    kind: "session-discovery-membership" as const,
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
    && globalThis.__piSessionListWatcher.kind === "session-discovery-membership") return;
  globalThis.__piSessionListWatcher?.close();
  globalThis.__piSessionListWatcher = createSessionListWatcher(root, invalidate);
}
